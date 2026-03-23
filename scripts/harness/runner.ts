/**
 * Runner — Orchestrates Scenario Execution
 * ==========================================
 *
 * Phase 1: Pure scenarios (Families A, B, C, G) — no Docker
 * Phase 2: Docker scenarios (Family F) — sequential
 * Phase 3: Multi-step scenarios (Family B) — constraint store state
 */

import { mkdirSync, rmSync, existsSync } from 'fs';
import { inflateSync } from 'zlib';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import type { VerifyScenario, RunConfig, LedgerEntry, OracleContext, Severity } from './types.js';
import type { VerifyResult } from '../../src/types.js';
import { verify } from '../../src/verify.js';
import { ConstraintStore, predicateFingerprint } from '../../src/store/constraint-store.js';
import { checkInvariants } from './oracle.js';
import { Ledger, collectRunIdentity } from './ledger.js';
import { printProgress, printSummary, saveSummary } from './report.js';
import { generateAllScenarios, generateFamily } from './scenario-generator.js';
import { loadExternalScenarios, loadUniversalScenarios } from './external-scenario-loader.js';

const MAX_SCENARIO_TIMEOUT = 10 * 60 * 1000; // 10 min
const MAX_TOTAL_TIMEOUT = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// Deterministic vision mock — analyzes solid-color PNG screenshots locally.
// No API key needed. Works with the 8×8 PNGs produced by makeSolidPNG().
// ---------------------------------------------------------------------------
const COLOR_NAMES: Record<string, [number, number, number]> = {
  red:   [255, 0, 0],   green: [0, 128, 0],   blue:  [0, 0, 255],
  white: [255, 255, 255], black: [0, 0, 0],    gray:  [128, 128, 128],
  grey:  [128, 128, 128], orange:[255, 165, 0], yellow:[255, 255, 0],
};

function extractDominantRGB(pngBuf: Buffer): [number, number, number] | null {
  try {
    // Walk PNG chunks to find IDAT
    let offset = 8; // skip signature
    const idatChunks: Buffer[] = [];
    while (offset < pngBuf.length) {
      const len = pngBuf.readUInt32BE(offset);
      const type = pngBuf.subarray(offset + 4, offset + 8).toString('ascii');
      if (type === 'IDAT') idatChunks.push(pngBuf.subarray(offset + 8, offset + 8 + len));
      offset += 12 + len; // 4 len + 4 type + data + 4 crc
    }
    if (idatChunks.length === 0) return null;
    const raw = inflateSync(Buffer.concat(idatChunks));
    // First scanline: filter byte (1) + RGB pixels. First pixel at bytes 1,2,3.
    return [raw[1], raw[2], raw[3]];
  } catch { return null; }
}

function rgbToName(r: number, g: number, b: number): string {
  for (const [name, [cr, cg, cb]] of Object.entries(COLOR_NAMES)) {
    if (cr === r && cg === g && cb === b) return name;
  }
  return `rgb(${r},${g},${b})`;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

async function deterministicVisionMock(image: Buffer, prompt: string): Promise<string> {
  const rgb = extractDominantRGB(image);
  if (!rgb) return 'CLAIM 1: NOT VERIFIED — could not parse screenshot';

  const [r, g, b] = rgb;
  const colorName = rgbToName(r, g, b);
  const hex = rgbToHex(r, g, b);

  // Parse claims from prompt (numbered lines after "CLAIMS:")
  const claimsSection = prompt.split('CLAIMS:')[1] || '';
  const claimLines = claimsSection.trim().split('\n').filter(l => /^\d+\./.test(l.trim()));

  const responses: string[] = [];
  for (let i = 0; i < claimLines.length; i++) {
    const claim = claimLines[i].toLowerCase();
    const n = i + 1;

    // Check if the claim mentions a color and whether the screenshot matches
    let claimColor: string | null = null;
    for (const name of Object.keys(COLOR_NAMES)) {
      if (claim.includes(`"${name}"`)) { claimColor = name; break; }
    }
    // Also check for hex references
    if (!claimColor && claim.includes(hex.toLowerCase())) claimColor = colorName;

    if (claimColor) {
      const matches = claimColor === colorName || claimColor === 'grey' && colorName === 'gray';
      responses.push(matches
        ? `CLAIM ${n}: VERIFIED`
        : `CLAIM ${n}: NOT VERIFIED — screenshot shows ${colorName} (${hex}), not ${claimColor}`);
    } else if (claim.includes('exist') || claim.includes('visible')) {
      // Element existence claims — we can't verify DOM from a solid-color image,
      // but the vision gate spec says "should exist and be visible". Mark verified
      // (the screenshot exists, something is rendered).
      responses.push(`CLAIM ${n}: VERIFIED`);
    } else {
      // Unknown claim type — mark verified (conservative, matches real LLM behavior)
      responses.push(`CLAIM ${n}: VERIFIED`);
    }
  }

  return responses.join('\n');
}

// Built-in scenarios are authored against demo-app and hardcode its selectors/strings.
// They always run against demo-app regardless of --appDir. External (fault-derived)
// scenarios run against the target app. This prevents users from being blocked by
// built-in scenario failures when testing their own app.
function resolveFixtureDir(): string {
  // import.meta.dir (Bun) or dirname(fileURLToPath(import.meta.url)) (Node/tsx)
  const dir = (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));
  return join(dir, '..', '..', 'fixtures', 'demo-app');
}

export async function runSelfTest(config: RunConfig): Promise<{ exitCode: number }> {
  const startedAt = new Date().toISOString();
  const identity = collectRunIdentity();
  const fixtureDir = resolveFixtureDir();
  const isCustomApp = config.appDir !== fixtureDir;
  const dataDir = join(config.appDir, '..', '..', 'data');
  mkdirSync(dataDir, { recursive: true });

  const ledgerPath = config.ledgerPath ?? join(dataDir, 'self-test-ledger.jsonl');
  const ledger = new Ledger(ledgerPath);

  console.log(`\n  Verify Self-Test — ${identity.packageVersion} (${identity.gitCommit ?? 'no git'})`);
  if (isCustomApp) {
    console.log(`  Target app: ${config.appDir}`);
    console.log(`  Built-in scenarios run against: ${fixtureDir}`);
  } else {
    console.log(`  App dir: ${config.appDir}`);
  }
  console.log('');

  // Built-in scenarios always run against the fixture (demo-app)
  // They hardcode demo-app selectors/strings and would produce false failures on other apps
  let scenarios: VerifyScenario[];
  if (config.families && config.families.length > 0) {
    scenarios = config.families.flatMap(f => generateFamily(f, fixtureDir));
  } else {
    scenarios = generateAllScenarios(fixtureDir);
  }

  // Universal scenarios: health-checked, portable, always run against demo-app
  // These test verify gate logic (CSS spec, shorthand, color normalization) not app-specific content
  const universals = loadUniversalScenarios(fixtureDir);
  if (universals.length > 0) {
    scenarios = [...scenarios, ...universals];
    console.log(`  + ${universals.length} universal scenarios from fixtures/scenarios/universal.json`);
  }

  // External (fault-derived) scenarios run against the TARGET app
  const stateDir = join(config.appDir, '.verify');
  const external = loadExternalScenarios(join(stateDir, 'custom-scenarios.json'), config.appDir);
  if (external.length > 0) {
    scenarios = [...scenarios, ...external];
    console.log(`  + ${external.length} fault-derived scenarios from ${isCustomApp ? config.appDir : 'custom-scenarios.json'}`);
  }

  // Filter by Docker availability
  if (config.dockerEnabled === false) {
    scenarios = scenarios.filter(s => !s.requiresDocker);
  }

  console.log(`  Running ${scenarios.length} scenarios...\n`);

  const totalStart = Date.now();
  const batchSize = config.parallelBatch ?? 10;

  // Separate pure vs multi-step vs docker
  const pure = scenarios.filter(s => !s.requiresDocker && !s.steps);
  const multiStep = scenarios.filter(s => s.steps && s.steps.length > 0);
  const docker = scenarios.filter(s => s.requiresDocker);

  // Phase 1: Pure scenarios in parallel batches
  if (pure.length > 0) {
    console.log(`  Phase 1: ${pure.length} pure scenarios (batches of ${batchSize})\n`);
    for (let i = 0; i < pure.length; i += batchSize) {
      if (Date.now() - totalStart > MAX_TOTAL_TIMEOUT) break;
      const batch = pure.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(s => runScenario(s, config)));
      for (const entry of results) {
        ledger.append(entry);
        printProgress(entry);
      }
    }
  }

  // Phase 2: Multi-step scenarios (sequential)
  if (multiStep.length > 0) {
    console.log(`\n  Phase 2: ${multiStep.length} multi-step K5 scenarios\n`);
    for (const scenario of multiStep) {
      if (Date.now() - totalStart > MAX_TOTAL_TIMEOUT) break;
      const entry = await runMultiStepScenario(scenario, config);
      ledger.append(entry);
      printProgress(entry);
    }
  }

  // Phase 3: Docker scenarios (sequential — share Docker daemon)
  if (docker.length > 0) {
    const { isDockerAvailable } = await import('../../src/runners/docker-runner.js');
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      console.log(`\n  Phase 3: ${docker.length} Docker scenarios — SKIPPED (Docker not available)\n`);
    } else {
      console.log(`\n  Phase 3: ${docker.length} Docker scenarios (sequential)\n`);
      for (const scenario of docker) {
        if (Date.now() - totalStart > MAX_TOTAL_TIMEOUT) break;
        const entry = await runScenario(scenario, config);
        ledger.append(entry);
        printProgress(entry);
      }
    }
  }

  // Summary
  const completedAt = new Date().toISOString();
  const summary = ledger.summarize(identity, startedAt, completedAt);
  const summaryPath = saveSummary(summary, dataDir);
  printSummary(summary);
  console.log(`  Ledger: ${ledgerPath}`);
  console.log(`  Summary: ${summaryPath}\n`);

  const exitCode = config.failOnBug && summary.bugs > 0 ? 1 : 0;
  return { exitCode };
}

// =============================================================================
// SINGLE SCENARIO EXECUTION
// =============================================================================

async function runScenario(scenario: VerifyScenario, config: RunConfig): Promise<LedgerEntry> {
  const stateDir = join(tmpdir(), `verify-selftest-${scenario.id}`);
  const scenarioStart = Date.now();

  let result: VerifyResult | Error;
  let constraintsBefore = 0;
  let constraintsAfter = 0;

  try {
    mkdirSync(stateDir, { recursive: true });
    const store = new ConstraintStore(stateDir);
    constraintsBefore = store.getConstraintCount();

    const mergedConfig = {
      ...scenario.config,
      appDir: scenario.config.appDir ?? config.appDir,
      stateDir,
    };

    // Substitute vision callback from environment when scenario uses placeholder
    if (mergedConfig.vision && !mergedConfig.vision.call) {
      const envKey = process.env.GEMINI_API_KEY;
      if (envKey) {
        const { geminiVision } = await import('../../src/vision-helpers.js');
        mergedConfig.vision = { ...mergedConfig.vision, call: geminiVision(envKey) };
      } else {
        // Deterministic mock: analyze solid-color PNG screenshots without an API key
        mergedConfig.vision = { ...mergedConfig.vision, call: deterministicVisionMock };
      }
    }

    // Family M: message gate scenarios call governMessage() instead of verify()
    if (scenario.messageTest) {
      const { governMessage } = await import('../../src/gates/message.js');
      const msgResult = await governMessage(
        scenario.messageTest.envelope,
        scenario.messageTest.policy,
        scenario.messageTest.evidenceProviders,
        scenario.messageTest.deniedPatterns,
      );
      // Convert MessageGateResult to VerifyResult shape for invariant checking
      result = {
        success: msgResult.verdict === 'approved',
        gates: msgResult.gates.map(g => ({
          gate: g.gate as any,
          passed: g.passed,
          detail: g.detail,
          durationMs: g.durationMs,
        })),
        attestation: `MESSAGE ${msgResult.verdict.toUpperCase()}: ${msgResult.detail}`,
        timing: { totalMs: msgResult.durationMs, perGate: {} },
        // Store message-specific data in narrowing for invariant access
        narrowing: msgResult.verdict !== 'approved' ? {
          constraints: [],
          resolutionHint: msgResult.reason,
          fileEvidence: msgResult.detail,
        } : undefined,
        // Stash the full message result for invariant checks
        _messageResult: msgResult,
      } as any;
    } else {
      result = await Promise.race([
        verify(scenario.edits, scenario.predicates, mergedConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Scenario timeout (10 min)')), MAX_SCENARIO_TIMEOUT)
        ),
      ]);
    }

    const storeAfter = new ConstraintStore(stateDir);
    constraintsAfter = storeAfter.getConstraintCount();
  } catch (err: any) {
    result = err instanceof Error ? err : new Error(String(err));
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* */ }
  }

  const durationMs = Date.now() - scenarioStart;
  const context: OracleContext = {
    constraintsBefore,
    constraintsAfter,
    priorResults: [],
    durationMs,
  };

  const invariantResults = checkInvariants(scenario, result, context);
  const clean = invariantResults.every(r => r.passed);
  const worstSeverity = invariantResults
    .filter(r => !r.passed)
    .reduce<Severity | undefined>((worst, r) => {
      const sev = r.severity as Severity;
      if (!worst) return sev;
      if (sev === 'bug') return 'bug';
      if (sev === 'unexpected' && worst !== 'bug') return 'unexpected';
      return worst;
    }, undefined);

  const isError = result instanceof Error;
  return {
    id: scenario.id,
    timestamp: new Date().toISOString(),
    scenario: {
      family: scenario.family,
      generator: scenario.generator,
      description: scenario.description,
      predicateCount: scenario.predicates.length,
      editCount: scenario.edits.length,
      requiresDocker: scenario.requiresDocker,
      failureClass: scenario.failureClass,
    },
    result: {
      success: isError ? null : result.success,
      gatesPassed: isError ? [] : result.gates.filter(g => g.passed).map(g => g.gate),
      gatesFailed: isError ? [] : result.gates.filter(g => !g.passed).map(g => g.gate),
      totalMs: durationMs,
      constraintsBefore,
      constraintsAfter,
      error: isError ? result.message : undefined,
    },
    invariants: invariantResults.map(r => ({
      name: r.name,
      category: r.category as any,
      layer: r.layer as any,
      passed: r.passed,
      violation: r.violation,
      severity: r.severity as any,
    })),
    clean,
    worstSeverity,
  };
}

// =============================================================================
// MULTI-STEP SCENARIO (Family B)
// =============================================================================

async function runMultiStepScenario(scenario: VerifyScenario, config: RunConfig): Promise<LedgerEntry> {
  if (!scenario.steps || scenario.steps.length === 0) {
    return {
      id: scenario.id,
      timestamp: new Date().toISOString(),
      scenario: {
        family: scenario.family,
        generator: scenario.generator,
        description: scenario.description,
        predicateCount: 0,
        editCount: 0,
        requiresDocker: false,
      },
      result: {
        success: null,
        gatesPassed: [],
        gatesFailed: [],
        totalMs: 0,
        constraintsBefore: 0,
        constraintsAfter: 0,
        error: 'No steps defined',
      },
      invariants: [],
      clean: true,
      worstSeverity: undefined,
    };
  }

  // All steps share the same state dir (constraint store persists between steps)
  const stateDir = join(tmpdir(), `verify-selftest-${scenario.id}`);
  const scenarioStart = Date.now();
  const priorResults: VerifyResult[] = [];
  let allInvariantResults: Array<{ name: string; category: string; layer: string; passed: boolean; violation?: string; severity: string }> = [];
  let constraintsBefore = 0;
  let constraintsAfter = 0;
  let lastError: string | undefined;

  try {
    mkdirSync(stateDir, { recursive: true });
    const storeBefore = new ConstraintStore(stateDir);
    constraintsBefore = storeBefore.getConstraintCount();

    for (const step of scenario.steps) {
      // Run beforeStep hook (direct constraint manipulation for B scenarios)
      if (step.beforeStep) {
        try {
          step.beforeStep(stateDir);
        } catch (err: any) {
          lastError = `beforeStep failed: ${err.message}`;
        }
      }

      // Skip verify() for pure constraint-manipulation steps
      if (step.skipVerify) {
        const storeAfter = new ConstraintStore(stateDir);
        constraintsAfter = storeAfter.getConstraintCount();

        const context: OracleContext = {
          constraintsBefore,
          constraintsAfter,
          priorResults: [...priorResults],
          durationMs: Date.now() - scenarioStart,
        };

        // For skipVerify steps, only check scenario-specific invariants (not universal ones)
        // Universal invariants expect valid verify() output (gates, attestation, etc.)
        for (const inv of step.invariants) {
          try {
            const syntheticResult: VerifyResult = {
              success: true,
              gates: [],
              attestation: 'skipVerify step',
              timing: { totalMs: 0 },
            };
            const verdict = inv.check(step, syntheticResult, context);
            allInvariantResults.push({
              name: inv.name,
              category: inv.category,
              layer: inv.layer,
              passed: verdict.passed,
              violation: verdict.violation,
              severity: verdict.passed ? 'info' : verdict.severity,
            });
          } catch (err: any) {
            allInvariantResults.push({
              name: inv.name,
              category: inv.category,
              layer: inv.layer,
              passed: false,
              violation: `Invariant check crashed: ${err.message}`,
              severity: 'bug',
            });
          }
        }
        constraintsBefore = constraintsAfter; // Update for next step
        continue;
      }

      // Check for B7-style override injection
      let overrideConstraints: string[] | undefined;
      const overridePath = join(stateDir, '_override_ids.json');
      if (existsSync(overridePath)) {
        try {
          overrideConstraints = JSON.parse(require('fs').readFileSync(overridePath, 'utf-8'));
          require('fs').unlinkSync(overridePath); // Clean up
        } catch { /* ignore */ }
      }

      const mergedConfig = {
        ...step.config,
        appDir: step.config.appDir ?? config.appDir,
        stateDir,
        ...(overrideConstraints ? { overrideConstraints } : {}),
      };

      let result: VerifyResult | Error;
      try {
        result = await verify(step.edits, step.predicates, mergedConfig);
      } catch (err: any) {
        result = err instanceof Error ? err : new Error(String(err));
      }

      const storeAfter = new ConstraintStore(stateDir);
      constraintsAfter = storeAfter.getConstraintCount();

      const context: OracleContext = {
        constraintsBefore,
        constraintsAfter,
        priorResults: [...priorResults],
        durationMs: Date.now() - scenarioStart,
      };

      if (!(result instanceof Error)) {
        priorResults.push(result);
      } else {
        lastError = result.message;
      }

      // Check step-specific invariants
      const stepInvariants = checkInvariants(step, result, context);
      allInvariantResults.push(...stepInvariants);
      constraintsBefore = constraintsAfter; // Update for next step
    }
  } catch (err: any) {
    lastError = err.message;
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* */ }
  }

  const clean = allInvariantResults.every(r => r.passed);
  const worstSeverity = allInvariantResults
    .filter(r => !r.passed)
    .reduce<Severity | undefined>((worst, r) => {
      const sev = r.severity as Severity;
      if (!worst) return sev;
      if (sev === 'bug') return 'bug';
      if (sev === 'unexpected' && worst !== 'bug') return 'unexpected';
      return worst;
    }, undefined);

  return {
    id: scenario.id,
    timestamp: new Date().toISOString(),
    scenario: {
      family: scenario.family,
      generator: scenario.generator,
      description: scenario.description,
      predicateCount: scenario.steps.reduce((s, step) => s + step.predicates.length, 0),
      editCount: scenario.steps.reduce((s, step) => s + step.edits.length, 0),
      requiresDocker: scenario.requiresDocker,
      failureClass: scenario.failureClass,
    },
    result: {
      success: priorResults.length > 0 ? priorResults[priorResults.length - 1].success : null,
      gatesPassed: [],
      gatesFailed: [],
      totalMs: Date.now() - scenarioStart,
      constraintsBefore,
      constraintsAfter,
      error: lastError,
    },
    invariants: allInvariantResults.map(r => ({
      name: r.name,
      category: r.category as any,
      layer: r.layer as any,
      passed: r.passed,
      violation: r.violation,
      severity: r.severity as any,
    })),
    clean,
    worstSeverity,
  };
}
