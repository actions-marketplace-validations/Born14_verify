/**
 * verify() — The One Function
 * ============================
 *
 * Submit edits + predicates. Get back a verdict.
 * Every edit gets a fair trial before it touches your users.
 *
 * Gate sequence (25 gates):
 *   Grounding → F9 (syntax) → K5 (constraints) → G5 (containment) → Hallucination →
 *   Access → Temporal → Propagation → State → Capacity → Contention →
 *   Filesystem → Infrastructure → Serialization → Config → Security → A11y → Performance →
 *   [Staging (Docker) → Browser (Playwright) → HTTP (fetch) →
 *   Invariants (health)] → Vision (screenshot) → Triangulation → Narrowing (learning)
 *
 * On failure: returns what went wrong + what to try next.
 * On success: returns proof that the edits work.
 */

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type {
  Edit, Predicate, Invariant, VerifyConfig, VerifyResult,
  GateResult, GateContext, Narrowing, PredicateResult,
  AgentSubmission, BatchResult,
} from './types.js';

import { ConstraintStore, extractSignature, classifyChangeType, classifyActionClass, predicateFingerprint } from './store/constraint-store.js';
import { runSyntaxGate, applyEdits } from './gates/syntax.js';
import { runConstraintGate } from './gates/constraints.js';
import { runContainmentGate } from './gates/containment.js';
import { runHallucinationGate } from './gates/hallucination.js';
import { runStagingGate } from './gates/staging.js';
import { runBrowserGate, type BrowserGateResult } from './gates/browser.js';
import { runHttpGate } from './gates/http.js';
import { runVisionGate } from './gates/vision.js';
import { runTriangulationGate } from './gates/triangulation.js';
import { runInvariantsGate } from './gates/invariants.js';
import { groundInReality, validateAgainstGrounding } from './gates/grounding.js';
import { runFilesystemGate } from './gates/filesystem.js';
import { runInfrastructureGate } from './gates/infrastructure.js';
import { runSerializationGate } from './gates/serialization.js';
import { runConfigGate } from './gates/config.js';
import { runSecurityGate } from './gates/security.js';
import { runA11yGate } from './gates/a11y.js';
import { runPerformanceGate } from './gates/performance.js';
import { runAccessGate } from './gates/access.js';
import { runTemporalGate } from './gates/temporal.js';
import { runPropagationGate } from './gates/propagation.js';
import { runStateGate } from './gates/state.js';
import { runCapacityGate } from './gates/capacity.js';
import { runContentionGate } from './gates/contention.js';
import { runObservationGate, isObservationRelevant } from './gates/observation.js';
import { LocalDockerRunner, isDockerAvailable, hasDockerCompose } from './runners/docker-runner.js';

/**
 * Verify edits against predicates. The one function.
 *
 * @param edits - Code changes to verify
 * @param predicates - Claims about what should be true after the edits
 * @param config - Configuration (app directory, Docker options, etc.)
 * @returns Verdict with per-gate pass/fail, narrowing on failure
 */
export async function verify(
  edits: Edit[],
  predicates: Predicate[],
  config: VerifyConfig,
): Promise<VerifyResult> {
  const totalStart = Date.now();
  const gates: GateResult[] = [];
  const logs: string[] = [];
  const log = (msg: string) => { logs.push(`[${new Date().toISOString()}] ${msg}`); };

  // Resolve config defaults
  const stateDir = config.stateDir ?? join(config.appDir, '.verify');
  mkdirSync(stateDir, { recursive: true });

  const store = new ConstraintStore(stateDir);
  // Pre-seed constraints from config (harness use — e.g., K5 test scenarios)
  if (config.constraints && config.constraints.length > 0) {
    for (const c of config.constraints) {
      // Ensure required fields have defaults to prevent crashes
      const safe = {
        appliesTo: [],
        surface: { files: [], intents: [] },
        requires: {},
        ...c,
      };
      (store as any).data.constraints.push(safe);
    }
    log(`[K5] Pre-seeded ${config.constraints.length} constraint(s) from config`);
  }
  const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const gateConfig = config.gates ?? {};
  let runner: LocalDockerRunner | undefined;
  let stageDir: string | undefined;
  let browserScreenshots: Record<string, Buffer> | undefined;

  try {
    // =========================================================================
    // GROUNDING — Read reality before checking anything
    // =========================================================================
    // Skip the expensive filesystem scan when grounding gate is disabled
    // (e.g., in the GitHub Action's diff-only mode)
    // =========================================================================
    // GROUNDING — Read reality before checking anything
    // =========================================================================
    log('[grounding] Scanning app directory...');
    const grounding = groundInReality(config.appDir);
    log(`[grounding] Found ${grounding.routes.length} routes, ${grounding.routeCSSMap.size} route CSS maps`);

    // Validate predicates against grounding
    // Check if Docker staging is plausible (compose file exists + not disabled)
    const hasCompose = hasDockerCompose(config.appDir, config.docker?.composefile);
    const dockerPlausible = gateConfig.staging !== false && hasCompose;
    const groundedPredicates = validateAgainstGrounding(predicates, grounding, {
      appDir: config.appDir,
      dockerAvailable: dockerPlausible,
      edits,
      appUrl: config.appUrl,
    });
    const fingerprints = groundedPredicates.map(p => predicateFingerprint(p));

    // Build gate context
    const ctx: GateContext = {
      config,
      edits,
      predicates: groundedPredicates,
      grounding,
      log,
    };

    // =========================================================================
    // GROUNDING GATE: Reject fabricated selectors
    // =========================================================================
    if (gateConfig.grounding !== false) {
      const groundingStart = Date.now();
      const missed = groundedPredicates.filter((p: any) => p.groundingMiss === true);

      if (missed.length > 0) {
        const detail = missed.map((p: any) =>
          p.groundingReason ?? `${p.type} predicate references "${p.selector}" which does not exist in the app`
        ).join('; ');

        log(`[grounding] FAILED: ${detail}`);
        const groundingGate: GateResult = {
          gate: 'grounding',
          passed: false,
          detail,
          durationMs: Date.now() - groundingStart,
        };
        gates.push(groundingGate);

        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'grounding', error: detail, edits, predicates: groundedPredicates,
        });
      }

      gates.push({
        gate: 'grounding',
        passed: true,
        detail: `All ${groundedPredicates.length} predicates grounded in reality`,
        durationMs: Date.now() - groundingStart,
      });
      log('[grounding] All predicates grounded');
    }

    // =========================================================================
    // F9: SYNTAX VALIDATION
    // =========================================================================
    if (gateConfig.syntax !== false) {
      log('[F9] Running syntax validation...');

      // Create staging workspace (copy of app dir)
      stageDir = join(tmpdir(), `verify-stage-${sessionId}`);
      mkdirSync(stageDir, { recursive: true });
      copyAppDir(config.appDir, stageDir);

      ctx.stageDir = stageDir;

      const syntaxResult = runSyntaxGate(ctx);
      gates.push(syntaxResult);

      if (!syntaxResult.passed) {
        log(`[F9] FAILED: ${syntaxResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'F9', error: syntaxResult.detail, edits, predicates: groundedPredicates,
        });
      }

      // Apply edits to staging workspace
      log('[F9] Applying edits to staging workspace...');
      const editResults = applyEdits(edits, stageDir);
      const failed = editResults.filter(r => !r.applied);
      if (failed.length > 0) {
        const detail = `Edit application failed: ${failed.map(f => `${f.file}: ${f.reason}`).join('; ')}`;
        log(`[F9] ${detail}`);
        // Push a failing gate so gate_success_consistency holds (success=false ↔ some gate failed)
        gates.push({ gate: 'F9_apply' as any, passed: false, detail, durationMs: Date.now() - totalStart });
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'F9', error: detail, edits, predicates: groundedPredicates,
        });
      }
    }

    // =========================================================================
    // K5: CONSTRAINT ENFORCEMENT
    // =========================================================================
    if (gateConfig.constraints !== false) {
      log('[K5] Checking learned constraints...');
      const constraintResult = runConstraintGate(ctx, store, config.overrideConstraints);
      gates.push(constraintResult);

      if (!constraintResult.passed) {
        log(`[K5] BLOCKED: ${constraintResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'K5', error: constraintResult.detail, edits, predicates: groundedPredicates,
          violation: constraintResult.violation,
        });
      }
    }

    // =========================================================================
    // G5: CONTAINMENT ATTRIBUTION
    // =========================================================================
    if (gateConfig.containment !== false) {
      log('[G5] Checking edit containment...');
      const containmentResult = runContainmentGate(ctx);
      gates.push(containmentResult);
      // Advisory — always passes, but result is included
    }

    // =========================================================================
    // HALLUCINATION: Deterministic Claim Verification
    // =========================================================================
    {
      const hasHalPreds = groundedPredicates.some(p => p.type === 'hallucination');
      if (hasHalPreds) {
        log('[hallucination] Checking agent claims against ground truth...');
        const halResult = runHallucinationGate(ctx);
        gates.push(halResult);

        if (!halResult.passed) {
          log(`[hallucination] FAILED: ${halResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'hallucination' as any, error: halResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // ACCESS: Privilege Boundary Analysis
    // =========================================================================
    if ((gateConfig as any).access !== false) {
      log('[access] Checking privilege boundaries...');
      const accessResult = runAccessGate(ctx);
      gates.push(accessResult);

      if (!accessResult.passed) {
        log(`[access] FAILED: ${accessResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'access' as any, error: accessResult.detail, edits, predicates: groundedPredicates,
        });
      }
    }

    // =========================================================================
    // TEMPORAL: Cross-Surface Staleness Detection
    // =========================================================================
    if ((gateConfig as any).temporal !== false) {
      log('[temporal] Checking for temporal drift...');
      const temporalResult = runTemporalGate(ctx);
      gates.push(temporalResult);

      if (!temporalResult.passed) {
        log(`[temporal] FAILED: ${temporalResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'temporal' as any, error: temporalResult.detail, edits, predicates: groundedPredicates,
        });
      }
    }

    // =========================================================================
    // PROPAGATION: Cross-Surface Cascade Analysis
    // =========================================================================
    if ((gateConfig as any).propagation !== false) {
      log('[propagation] Checking for propagation breaks...');
      const propagationResult = runPropagationGate(ctx);
      gates.push(propagationResult);

      if (!propagationResult.passed) {
        log(`[propagation] FAILED: ${propagationResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'propagation' as any, error: propagationResult.detail, edits, predicates: groundedPredicates,
        });
      }
    }

    // =========================================================================
    // STATE: State Assumption Verification
    // =========================================================================
    if ((gateConfig as any).state !== false) {
      log('[state] Checking state assumptions...');
      const stateResult = runStateGate(ctx);
      gates.push(stateResult);

      if (!stateResult.passed) {
        log(`[state] FAILED: ${stateResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'state' as any, error: stateResult.detail, edits, predicates: groundedPredicates,
        });
      }
    }

    // =========================================================================
    // CAPACITY: Resource Exhaustion Detection
    // =========================================================================
    if ((gateConfig as any).capacity !== false) {
      log('[capacity] Checking for capacity issues...');
      const capacityResult = runCapacityGate(ctx);
      gates.push(capacityResult);

      if (!capacityResult.passed) {
        log(`[capacity] FAILED: ${capacityResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'capacity' as any, error: capacityResult.detail, edits, predicates: groundedPredicates,
        });
      }
    }

    // =========================================================================
    // CONTENTION: Race Condition & Resource Conflict Detection
    // =========================================================================
    if ((gateConfig as any).contention !== false) {
      log('[contention] Checking for contention issues...');
      const contentionResult = runContentionGate(ctx);
      gates.push(contentionResult);

      if (!contentionResult.passed) {
        log(`[contention] FAILED: ${contentionResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'contention' as any, error: contentionResult.detail, edits, predicates: groundedPredicates,
        });
      }
    }

    // =========================================================================
    // OBSERVATION: Observer Effect Detection
    // =========================================================================
    if (isObservationRelevant(edits)) {
      log('[observation] Checking for observer effects...');
      const observationResult = runObservationGate(ctx);
      gates.push(observationResult);
      // Advisory gate — always passes, reports effects for transparency
      if (observationResult.effects?.length > 0) {
        log(`[observation] ${observationResult.effects.length} observer effect(s) detected (advisory)`);
      }
    }

    // =========================================================================
    // FILESYSTEM: Post-Edit Filesystem State Verification
    // =========================================================================
    {
      const hasFilesystemPreds = groundedPredicates.some(p =>
        p.type === 'filesystem_exists' || p.type === 'filesystem_absent' ||
        p.type === 'filesystem_unchanged' || p.type === 'filesystem_count'
      );
      if (hasFilesystemPreds) {
        log('[filesystem] Running filesystem predicate validation...');
        const fsResult = runFilesystemGate(ctx);
        gates.push(fsResult);

        if (!fsResult.passed) {
          log(`[filesystem] FAILED: ${fsResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'filesystem', error: fsResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // INFRASTRUCTURE: State File Verification (The Alexei Gate)
    // =========================================================================
    {
      const hasInfraPreds = groundedPredicates.some(p =>
        p.type === 'infra_resource' || p.type === 'infra_attribute' || p.type === 'infra_manifest'
      );
      if (hasInfraPreds) {
        log('[infrastructure] Running infrastructure predicate validation...');
        const infraResult = runInfrastructureGate(ctx);
        gates.push(infraResult);

        if (!infraResult.passed) {
          log(`[infrastructure] FAILED: ${infraResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'infrastructure', error: infraResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // SERIALIZATION: JSON Schema + Structure Validation
    // =========================================================================
    {
      const hasSerPreds = groundedPredicates.some(p => p.type === 'serialization');
      if (hasSerPreds) {
        log('[serialization] Running serialization validation...');
        const serResult = runSerializationGate(ctx);
        gates.push(serResult);

        if (!serResult.passed) {
          log(`[serialization] FAILED: ${serResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'serialization', error: serResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // CONFIG: Configuration File Validation
    // =========================================================================
    {
      const hasConfigPreds = groundedPredicates.some(p => p.type === 'config');
      if (hasConfigPreds) {
        log('[config] Running configuration validation...');
        const configResult = runConfigGate(ctx);
        gates.push(configResult);

        if (!configResult.passed) {
          log(`[config] FAILED: ${configResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'config', error: configResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // SECURITY: Static Security Analysis
    // =========================================================================
    {
      const hasSecPreds = groundedPredicates.some(p => p.type === 'security');
      if (hasSecPreds) {
        log('[security] Running security scan...');
        const secResult = runSecurityGate(ctx);
        gates.push(secResult);

        if (!secResult.passed) {
          log(`[security] FAILED: ${secResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'security', error: secResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // A11Y: Accessibility Validation
    // =========================================================================
    {
      const hasA11yPreds = groundedPredicates.some(p => p.type === 'a11y');
      if (hasA11yPreds) {
        log('[a11y] Running accessibility checks...');
        const a11yResult = runA11yGate(ctx);
        gates.push(a11yResult);

        if (!a11yResult.passed) {
          log(`[a11y] FAILED: ${a11yResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'a11y', error: a11yResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // PERFORMANCE: Static Performance Analysis
    // =========================================================================
    {
      const hasPerfPreds = groundedPredicates.some(p => p.type === 'performance');
      if (hasPerfPreds) {
        log('[performance] Running performance analysis...');
        const perfResult = runPerformanceGate(ctx);
        gates.push(perfResult);

        if (!perfResult.passed) {
          log(`[performance] FAILED: ${perfResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'performance', error: perfResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    }

    // =========================================================================
    // STAGING: Docker Build + Start
    // =========================================================================
    const dockerAvailable = await isDockerAvailable();
    const hasStagingCompose = hasDockerCompose(stageDir ?? config.appDir, config.docker?.composefile);
    const shouldStage = gateConfig.staging !== false && dockerAvailable && hasStagingCompose && !config.appUrl;

    if (shouldStage) {
      log('[staging] Starting Docker staging...');

      // If we have a stage dir, we need to adjust the compose context
      const stagingConfig = stageDir
        ? { ...config, appDir: stageDir }
        : config;

      runner = new LocalDockerRunner(stagingConfig);
      ctx.runner = runner;

      const stagingResult = await runStagingGate(ctx, runner);
      gates.push(stagingResult);

      if (!stagingResult.passed) {
        log(`[staging] FAILED: ${stagingResult.detail}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'staging', error: stagingResult.detail, edits, predicates: groundedPredicates,
        });
      }

      ctx.appUrl = runner.getAppUrl();

      // =====================================================================
      // BROWSER: Playwright CSS/HTML Validation
      // =====================================================================
      if (gateConfig.browser !== false) {
        log('[browser] Running Playwright validation...');
        const browserResult = await runBrowserGate(ctx) as BrowserGateResult;
        gates.push(browserResult);

        // Capture screenshots for vision gate threading
        if (browserResult.screenshots) {
          browserScreenshots = browserResult.screenshots;
          log(`[browser] ${Object.keys(browserScreenshots).length} screenshot(s) captured for vision gate`);
        }

        if (!browserResult.passed) {
          log(`[browser] FAILED: ${browserResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'browser', error: browserResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }

      // =====================================================================
      // HTTP: Endpoint Validation
      // =====================================================================
      if (gateConfig.http !== false) {
        const httpPredicates = groundedPredicates.filter(
          p => p.type === 'http' || p.type === 'http_sequence'
        );
        if (httpPredicates.length > 0) {
          log('[http] Running HTTP predicate validation...');
          const httpResult = await runHttpGate(ctx);
          gates.push(httpResult);

          if (!httpResult.passed) {
            log(`[http] FAILED: ${httpResult.detail}`);
            return buildResult({
              gates, config, store, sessionId, totalStart, logs,
              failedGate: 'http', error: httpResult.detail, edits, predicates: groundedPredicates,
            });
          }
        }
      }

      // =====================================================================
      // INVARIANTS: System Health Checks
      // =====================================================================
      const invariants = config.invariants ?? loadInvariantsFile(config.appDir);
      if (gateConfig.invariants !== false && invariants.length > 0) {
        log('[invariants] Running system health checks...');
        const invResult = await runInvariantsGate(ctx, invariants, runner);
        gates.push(invResult);

        if (!invResult.passed) {
          log(`[invariants] FAILED: ${invResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'invariants', error: invResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    } else if (config.appUrl) {
      // Staging skipped but appUrl provided — run HTTP/browser/invariant gates directly
      ctx.appUrl = config.appUrl;
      log(`[staging] Skipped (appUrl provided: ${config.appUrl})`);
      gates.push({
        gate: 'staging',
        passed: true,
        detail: `Skipped: using provided appUrl ${config.appUrl}`,
        durationMs: 0,
      });

      // Browser gate (Playwright CSS/HTML validation)
      if (gateConfig.browser !== false) {
        log('[browser] Running Playwright validation...');
        const browserResult = await runBrowserGate(ctx) as BrowserGateResult;
        gates.push(browserResult);

        if (browserResult.screenshots) {
          browserScreenshots = browserResult.screenshots;
          log(`[browser] ${Object.keys(browserScreenshots).length} screenshot(s) captured for vision gate`);
        }

        if (!browserResult.passed) {
          log(`[browser] FAILED: ${browserResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'browser', error: browserResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }

      // HTTP gate
      if (gateConfig.http !== false) {
        const httpPredicates = groundedPredicates.filter(
          p => p.type === 'http' || p.type === 'http_sequence'
        );
        if (httpPredicates.length > 0) {
          log('[http] Running HTTP predicate validation...');
          const httpResult = await runHttpGate(ctx);
          gates.push(httpResult);

          if (!httpResult.passed) {
            log(`[http] FAILED: ${httpResult.detail}`);
            return buildResult({
              gates, config, store, sessionId, totalStart, logs,
              failedGate: 'http', error: httpResult.detail, edits, predicates: groundedPredicates,
            });
          }
        }
      }

      // Invariants gate
      const invariants2 = config.invariants ?? loadInvariantsFile(config.appDir);
      if (gateConfig.invariants !== false && invariants2.length > 0) {
        log('[invariants] Running system health checks...');
        const invResult = await runInvariantsGate(ctx, invariants2, runner);
        gates.push(invResult);

        if (!invResult.passed) {
          log(`[invariants] FAILED: ${invResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'invariants', error: invResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }
    } else if (gateConfig.staging !== false) {
      // Docker not available — note it
      const reason = !dockerAvailable ? 'Docker not available' : 'No docker-compose file found';
      log(`[staging] Skipped: ${reason}`);
      gates.push({
        gate: 'staging',
        passed: true,
        detail: `Skipped: ${reason}`,
        durationMs: 0,
      });
    }

    // =========================================================================
    // VISION: Screenshot + Model Verification (runs with or without staging)
    // =========================================================================
    if (gateConfig.vision === true && config.vision?.call) {
      // Thread browser-captured screenshots into vision config
      // Browser screenshots are authoritative (from the actual rendered page)
      // Caller-provided screenshots serve as fallback for routes not captured
      if (browserScreenshots && Object.keys(browserScreenshots).length > 0) {
        // Browser screenshots take priority over caller-provided (they're from the actual rendered page)
        const mergedScreenshots = { ...(config.vision.screenshots ?? {}), ...browserScreenshots };
        ctx.config = {
          ...ctx.config,
          vision: {
            ...ctx.config.vision!,
            screenshots: mergedScreenshots,
          },
        };
        log(`[vision] Threading ${Object.keys(browserScreenshots).length} browser screenshot(s) to vision gate`);
      }

      log('[vision] Running vision model verification...');
      const visionResult = await runVisionGate(ctx);
      gates.push(visionResult);
      // Vision does NOT independently block — triangulation decides
      if (!visionResult.passed) {
        log(`[vision] FAILED: ${visionResult.detail} (triangulation will synthesize)`);
      }
    }

    // =========================================================================
    // TRIANGULATION: Cross-Authority Verdict Synthesis
    // =========================================================================
    // Runs when 2+ authorities contributed. Synthesizes deterministic + browser + vision.
    {
      const triangulationResult = runTriangulationGate(gates, log);
      gates.push(triangulationResult);

      if (triangulationResult.triangulation.action === 'rollback') {
        log(`[triangulation] ROLLBACK: ${triangulationResult.triangulation.reasoning}`);
        return buildResult({
          gates, config, store, sessionId, totalStart, logs,
          failedGate: 'triangulation', error: triangulationResult.triangulation.reasoning,
          edits, predicates: groundedPredicates,
          triangulation: triangulationResult.triangulation,
        });
      }

      if (triangulationResult.triangulation.action === 'escalate') {
        log(`[triangulation] ESCALATE: ${triangulationResult.triangulation.reasoning}`);
        // Escalation is not a hard failure — surface the disagreement but continue
        // The caller can inspect result.triangulation to decide
      }
    }

    // =========================================================================
    // SUCCESS — All gates passed
    // =========================================================================
    log('[verify] All gates passed');

    // Record successful outcome
    store.recordOutcome({
      timestamp: Date.now(),
      sessionId,
      goal: config.goal,
      success: true,
      changeType: classifyChangeType(edits.map(e => e.file)),
      filesTouched: edits.map(e => e.file),
      gatesFailed: [],
    });

    // Session isolation: clean up constraints seeded during this call
    if (config.learning !== 'persistent') {
      store.cleanupSession(sessionId);
    }

    const containmentGate = gates.find(g => g.gate === 'G5') as any;
    const triangulationGate = gates.find(g => g.gate === 'triangulation') as any;

    return {
      success: true,
      gates,
      attestation: buildAttestation(gates, true, config.goal),
      timing: {
        totalMs: Date.now() - totalStart,
        perGate: Object.fromEntries(gates.map(g => [g.gate, g.durationMs])),
      },
      effectivePredicates: groundedPredicates.map((p, i) => ({
        id: `p${i}`,
        type: p.type,
        fingerprint: fingerprints[i],
        description: p.description,
        groundingMiss: (p as any).groundingMiss,
      })),
      containment: containmentGate?.summary,
      constraintDelta: {
        before: store.getConstraintCount(),
        after: store.getConstraintCount(),
        seeded: [],
      },
      triangulation: triangulationGate?.triangulation,
    };
  } finally {
    // Cleanup: stop container and remove staging directory
    if (runner) {
      log('[cleanup] Stopping staging container...');
      await runner.stop();
    }
    if (stageDir && existsSync(stageDir)) {
      try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}


// =============================================================================
// INTERNAL HELPERS
// =============================================================================

interface BuildResultOpts {
  gates: GateResult[];
  config: VerifyConfig;
  store: ConstraintStore;
  sessionId: string;
  totalStart: number;
  logs: string[];
  failedGate: string;
  error: string;
  edits: Edit[];
  predicates: Predicate[];
  violation?: any;
  triangulation?: any;
}

function buildResult(opts: BuildResultOpts): VerifyResult {
  const { gates, config, store, sessionId, totalStart, failedGate, error, edits, predicates } = opts;

  const filesTouched = [...new Set(edits.map(e => e.file))];
  const changeType = classifyChangeType(filesTouched);
  const signature = extractSignature(error);

  // Record failure outcome
  const failedFingerprints = predicates
    .filter((p: any) => p.groundingMiss)
    .map(p => predicateFingerprint(p));

  store.recordOutcome({
    timestamp: Date.now(),
    sessionId,
    goal: config.goal,
    success: false,
    changeType,
    filesTouched,
    gatesFailed: [failedGate],
    signature,
    failureKind: 'app_failure',
    failedPredicateFingerprints: failedFingerprints.length > 0 ? failedFingerprints : undefined,
  });

  // Seed constraint from failure (K5 learning)
  const actionClass = classifyActionClass(edits);
  const seededConstraint = store.seedFromFailure({
    sessionId,
    source: gateToSource(failedGate),
    error,
    filesTouched,
    attempt: 1,
    changeType,
    signature,
    actionClass,
    failedPredicates: predicates.map(p => ({
      type: p.type,
      selector: p.selector,
      property: p.property,
      expected: p.expected,
      path: p.path,
      method: p.method,
      table: (p as any).table,
      pattern: p.pattern,
      expect: p.expect,
      steps: p.steps,
    })),
  });

  // Build narrowing injection
  const narrowing: Narrowing = {
    constraints: seededConstraint
      ? [{ id: seededConstraint.id, signature: seededConstraint.signature, type: seededConstraint.type, reason: seededConstraint.reason }]
      : [],
    resolutionHint: buildResolutionHint(failedGate, error, opts.violation),
    patternRecall: (() => { const r = store.getPatternRecall(error); return r ? [r] : undefined; })(),
  };

  // Add banned fingerprints
  if (seededConstraint?.requires.bannedPredicateFingerprints) {
    narrowing.bannedFingerprints = seededConstraint.requires.bannedPredicateFingerprints;
  }

  const fingerprints = predicates.map(p => predicateFingerprint(p));
  const containmentGate = gates.find(g => g.gate === 'G5') as any;

  // Capture delta before cleanup
  const constraintDelta = {
    before: store.getConstraintCount() - (seededConstraint ? 1 : 0),
    after: store.getConstraintCount(),
    seeded: seededConstraint ? [seededConstraint.signature] : [],
  };

  // Session isolation: clean up constraints seeded during this call
  if (config.learning !== 'persistent') {
    store.cleanupSession(sessionId);
  }

  return {
    success: false,
    gates,
    narrowing,
    attestation: buildAttestation(gates, false, config.goal, failedGate),
    timing: {
      totalMs: Date.now() - totalStart,
      perGate: Object.fromEntries(gates.map(g => [g.gate, g.durationMs])),
    },
    effectivePredicates: predicates.map((p, i) => ({
      id: `p${i}`,
      type: p.type,
      fingerprint: fingerprints[i],
      description: p.description,
      groundingMiss: (p as any).groundingMiss,
    })),
    containment: containmentGate?.summary,
    constraintDelta,
    triangulation: opts.triangulation,
  };
}

/** Human-friendly gate names for attestation strings */
const GATE_LABELS: Record<string, string> = {
  grounding: 'grounding', F9: 'syntax', K5: 'constraints', G5: 'containment',
  staging: 'staging', browser: 'browser', http: 'http', invariants: 'health-checks',
  vision: 'vision', triangulation: 'cross-check', infrastructure: 'infrastructure',
  serialization: 'data', config: 'config', security: 'security', a11y: 'accessibility',
  performance: 'performance', filesystem: 'filesystem', access: 'access', capacity: 'capacity',
  contention: 'concurrency', state: 'state', temporal: 'timing', propagation: 'propagation',
  observation: 'observation', goal: 'goal', content: 'content', hallucination: 'hallucination',
};

function buildAttestation(gates: GateResult[], success: boolean, goal?: string, failedGate?: string): string {
  const gateStr = gates.map(g => `${GATE_LABELS[g.gate] ?? g.gate}${g.passed ? '✓' : '✗'}`).join(' ');
  const durationMs = gates.reduce((sum, g) => sum + g.durationMs, 0);

  if (success) {
    return [
      `VERIFIED${goal ? `: ${goal}` : ''}`,
      `Checks: ${gateStr}`,
      `Duration: ${durationMs}ms`,
    ].join('\n');
  }

  const failed = gates.find(g => !g.passed);
  const gateName = GATE_LABELS[failedGate ?? failed?.gate ?? ''] ?? failedGate ?? failed?.gate ?? 'unknown';
  return [
    `NOT VERIFIED${goal ? `: ${goal}` : ''}`,
    `Checks: ${gateStr}`,
    `Stopped at: ${gateName}`,
    `Problem: ${failed?.detail ?? 'unknown'}`,
    `Duration: ${durationMs}ms`,
  ].join('\n');
}

function buildResolutionHint(gate: string, error: string, violation?: any): string {
  if (gate === 'F9') {
    if (error.includes('not found')) return 'The search string doesn\'t exist in the file. Read the file first and copy an exact substring.';
    if (error.includes('ambiguous')) return 'The search string matches multiple places. Add more surrounding lines to make it unique.';
    return 'The edits have syntax errors. Check brackets, quotes, and semicolons.';
  }
  if (gate === 'K5') {
    if (violation?.banType === 'predicate_fingerprint') {
      return 'This exact approach already failed. Try a different CSS selector, expected value, or predicate type.';
    }
    if (violation?.banType === 'radius_limit') {
      return `Too many files changed. Keep the edit to ${violation.reason?.match(/\d+/)?.[0] ?? 'fewer'} files or less.`;
    }
    return 'This strategy was tried before and failed. Try a fundamentally different approach.';
  }
  if (gate === 'staging') return 'The app failed to build or start. Check Dockerfile, dependencies, and startup code.';
  if (gate === 'browser') return 'The page doesn\'t look right after the edit. Check CSS computed styles in a browser.';
  if (gate === 'http') return 'The API endpoint returned an unexpected response. Check status codes and response body.';
  if (gate === 'invariants') return 'The edit broke something else. Health checks failed after applying the change.';
  if (gate === 'filesystem') return 'A file is missing, has wrong content, or wasn\'t created. Check paths and filenames.';
  if (gate === 'infrastructure') return 'Infrastructure doesn\'t match expectations. Check that resources exist and have the right attributes.';
  if (gate === 'serialization') return 'The JSON data doesn\'t match the expected shape. Check keys, types, and values.';
  if (gate === 'config') return 'A config value is wrong or missing. Check .env files, JSON configs, and key names.';
  if (gate === 'security') return 'Security issue detected. Check for XSS, SQL injection, hardcoded secrets, or missing auth.';
  if (gate === 'a11y') return 'Accessibility issue found. Check alt text, form labels, heading order, and ARIA attributes.';
  if (gate === 'performance') return 'Performance is below threshold. Check bundle size, image sizes, and connection count.';
  if (gate === 'hallucination') return 'That claim isn\'t true. Check the actual database schema, routes, CSS, or file contents.';
  return 'Verification failed. Check the details above for what went wrong.';
}

function gateToSource(gate: string): 'syntax' | 'staging' | 'evidence' | 'invariant' {
  switch (gate) {
    case 'F9': return 'syntax';
    case 'staging': return 'staging';
    case 'browser':
    case 'http':
    case 'filesystem':
    case 'infrastructure':
    case 'serialization':
    case 'config':
    case 'security':
    case 'a11y':
    case 'performance':
    case 'hallucination': return 'evidence';
    case 'invariants': return 'invariant';
    default: return 'staging';
  }
}

function copyAppDir(src: string, dest: string): void {
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify', '.verify-tmp']);

  cpSync(src, dest, {
    recursive: true,
    filter: (source: string) => {
      const name = source.split(/[/\\]/).pop() ?? '';
      return !SKIP.has(name);
    },
  });
}

const _invariantsCache = new Map<string, { result: Invariant[]; cachedAt: number }>();

function loadInvariantsFile(appDir: string): Invariant[] {
  const cached = _invariantsCache.get(appDir);
  if (cached && Date.now() - cached.cachedAt < 5_000) return cached.result;

  const candidates = [
    join(appDir, 'invariants.json'),
    join(appDir, '.verify', 'invariants.json'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const result = JSON.parse(readFileSync(path, 'utf-8'));
        _invariantsCache.set(appDir, { result, cachedAt: Date.now() });
        return result;
      } catch { /* invalid JSON */ }
    }
  }

  const empty: Invariant[] = [];
  _invariantsCache.set(appDir, { result: empty, cachedAt: Date.now() });
  return empty;
}

// =============================================================================
// verifyBatch() — Sequential Multi-Agent Verification
// =============================================================================

/**
 * Verify multiple agents' edits in sequence. Each agent's edits are verified
 * against the filesystem the previous agent left behind. If agent A changes
 * a file and agent B's search string references the old content, B fails at
 * the syntax gate — exactly like a merge conflict.
 *
 * Usage:
 *   const result = await verifyBatch([
 *     { agent: 'planner', edits: [...], predicates: [...] },
 *     { agent: 'coder', edits: [...], predicates: [...] },
 *   ], { appDir: './my-app', stopOnFailure: true });
 */
export async function verifyBatch(
  submissions: AgentSubmission[],
  config: VerifyConfig & { stopOnFailure?: boolean },
): Promise<BatchResult> {
  const agentResults: BatchResult['agentResults'] = [];

  for (const sub of submissions) {
    const result = await verify(sub.edits, sub.predicates, {
      ...config,
      goal: config.goal ? `[${sub.agent}] ${config.goal}` : `[${sub.agent}]`,
    });
    agentResults.push({ agent: sub.agent, result });
    if (!result.success && config.stopOnFailure) break;
  }

  return {
    success: agentResults.every(r => r.result.success),
    agentResults,
  };
}

