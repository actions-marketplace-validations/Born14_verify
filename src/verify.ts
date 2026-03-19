/**
 * verify() — The One Function
 * ============================
 *
 * Submit edits + predicates. Get back a verdict.
 * Every edit gets a fair trial before it touches your users.
 *
 * Gate sequence:
 *   F9 (syntax) → K5 (constraints) → G5 (containment) →
 *   Staging (Docker) → Browser (Playwright) → Vision (screenshot) →
 *   HTTP (fetch) → Invariants (health) → Narrowing (learning)
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
} from './types.js';

import { ConstraintStore, extractSignature, classifyChangeType, classifyActionClass, predicateFingerprint } from './store/constraint-store.js';
import { runSyntaxGate, applyEdits } from './gates/syntax.js';
import { runConstraintGate } from './gates/constraints.js';
import { runContainmentGate } from './gates/containment.js';
import { runStagingGate } from './gates/staging.js';
import { runBrowserGate } from './gates/browser.js';
import { runHttpGate } from './gates/http.js';
import { runVisionGate } from './gates/vision.js';
import { runInvariantsGate } from './gates/invariants.js';
import { groundInReality, validateAgainstGrounding } from './gates/grounding.js';
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
  const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const gateConfig = config.gates ?? {};
  let runner: LocalDockerRunner | undefined;
  let stageDir: string | undefined;

  try {
    // =========================================================================
    // GROUNDING — Read reality before checking anything
    // =========================================================================
    log('[grounding] Scanning app directory...');
    const grounding = groundInReality(config.appDir);
    log(`[grounding] Found ${grounding.routes.length} routes, ${grounding.routeCSSMap.size} route CSS maps`);

    // Validate predicates against grounding
    const groundedPredicates = validateAgainstGrounding(predicates, grounding);
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
    // STAGING: Docker Build + Start
    // =========================================================================
    const dockerAvailable = await isDockerAvailable();
    const hasCompose = hasDockerCompose(stageDir ?? config.appDir, config.docker?.composefile);
    const shouldStage = gateConfig.staging !== false && dockerAvailable && hasCompose;

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
        const browserResult = await runBrowserGate(ctx);
        gates.push(browserResult);

        if (!browserResult.passed) {
          log(`[browser] FAILED: ${browserResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'browser', error: browserResult.detail, edits, predicates: groundedPredicates,
          });
        }
      }

      // =====================================================================
      // VISION: Screenshot + Model Verification
      // =====================================================================
      if (gateConfig.vision === true && config.vision?.apiKey) {
        log('[vision] Running vision model verification...');
        const visionResult = await runVisionGate(ctx);
        gates.push(visionResult);

        if (!visionResult.passed) {
          log(`[vision] FAILED: ${visionResult.detail}`);
          return buildResult({
            gates, config, store, sessionId, totalStart, logs,
            failedGate: 'vision', error: visionResult.detail, edits, predicates: groundedPredicates,
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

    const containmentGate = gates.find(g => g.gate === 'G5') as any;

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
    patternRecall: store.getPatternRecall(error),
  };

  // Add banned fingerprints
  if (seededConstraint?.requires.bannedPredicateFingerprints) {
    narrowing.bannedFingerprints = seededConstraint.requires.bannedPredicateFingerprints;
  }

  const fingerprints = predicates.map(p => predicateFingerprint(p));
  const containmentGate = gates.find(g => g.gate === 'G5') as any;

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
    constraintDelta: {
      before: store.getConstraintCount() - (seededConstraint ? 1 : 0),
      after: store.getConstraintCount(),
      seeded: seededConstraint ? [seededConstraint.signature] : [],
    },
  };
}

function buildAttestation(gates: GateResult[], success: boolean, goal?: string, failedGate?: string): string {
  const gateStr = gates.map(g => `${g.gate}${g.passed ? '✓' : '✗'}`).join(' ');

  if (success) {
    return [
      `VERIFY PASSED${goal ? `: ${goal}` : ''}`,
      `Gates: ${gateStr}`,
      `Duration: ${gates.reduce((sum, g) => sum + g.durationMs, 0)}ms`,
    ].join('\n');
  }

  const failed = gates.find(g => !g.passed);
  return [
    `VERIFY FAILED${goal ? `: ${goal}` : ''}`,
    `Gates: ${gateStr}`,
    `Failed at: ${failedGate ?? failed?.gate ?? 'unknown'}`,
    `Reason: ${failed?.detail ?? 'unknown'}`,
    `Duration: ${gates.reduce((sum, g) => sum + g.durationMs, 0)}ms`,
  ].join('\n');
}

function buildResolutionHint(gate: string, error: string, violation?: any): string {
  if (gate === 'F9') {
    if (error.includes('not found')) return 'The search string does not exist in the file. Read the file first and use an exact match.';
    if (error.includes('ambiguous')) return 'The search string matches multiple locations. Include more surrounding context to make it unique.';
    return 'Fix the syntax errors in your edits.';
  }
  if (gate === 'K5') {
    if (violation?.banType === 'predicate_fingerprint') {
      return 'This predicate combination failed before. Change the expected value or predicate type.';
    }
    if (violation?.banType === 'radius_limit') {
      return `Too many files changed. Reduce to ${violation.reason?.match(/\d+/)?.[0] ?? 'fewer'} files.`;
    }
    return 'This approach was tried before and failed. Try a different strategy.';
  }
  if (gate === 'staging') return 'The container failed to build or start. Check the Docker configuration and dependencies.';
  if (gate === 'browser') return 'The CSS/HTML validation failed against the rendered page. Check computed styles.';
  if (gate === 'http') return 'HTTP endpoint validation failed. Check the API response.';
  if (gate === 'invariants') return 'System health checks failed after applying edits. The change may have broken something.';
  return 'Verification failed. Review the gate details.';
}

function gateToSource(gate: string): 'syntax' | 'staging' | 'evidence' | 'invariant' {
  switch (gate) {
    case 'F9': return 'syntax';
    case 'staging': return 'staging';
    case 'browser':
    case 'http': return 'evidence';
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

function loadInvariantsFile(appDir: string): Invariant[] {
  const candidates = [
    join(appDir, 'invariants.json'),
    join(appDir, '.verify', 'invariants.json'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8'));
      } catch { /* invalid JSON */ }
    }
  }

  return [];
}

