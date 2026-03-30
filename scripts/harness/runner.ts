/**
 * Runner — Orchestrates Scenario Execution
 * ==========================================
 *
 * Phase 1:   Pure scenarios (Families A, B, C, G) — no Docker
 * Phase 1.5: HTTP mock scenarios (Family P) — local mock server
 * Phase 2:   Multi-step scenarios (Family B) — constraint store state
 * Phase 3:   Docker scenarios (Family F) — sequential, pattern-simulated
 * Phase 4:   Live Docker scenarios (--live) — real Postgres + app container
 * Phase 5:   Playwright scenarios (--full) — real browser rendering
 *
 * Tiers:
 *   pure (default) — Phases 1-3 only (~753 scenarios, ~20s)
 *   live (--live)  — Phases 1-4 (~800+ scenarios, ~5min)
 *   full (--full)  — Phases 1-5 (~900+ scenarios, ~10min)
 */

import { mkdirSync, rmSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { inflateSync } from 'zlib';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import type { VerifyScenario, RunConfig, LedgerEntry, OracleContext, Severity, LiveTier } from './types.js';
import type { VerifyResult } from '../../src/types.js';
import { verify } from '../../src/verify.js';
import { ConstraintStore, predicateFingerprint } from '../../src/store/constraint-store.js';
import { checkInvariants } from './oracle.js';
import { Ledger, collectRunIdentity } from './ledger.js';
import { printProgress, printSummary, saveSummary } from './report.js';
import { generateAllScenarios, generateFamily } from './scenario-generator.js';
import { loadExternalScenarios, loadUniversalScenarios, loadStagedScenarios, loadRealWorldScenarios, loadWPTScenarios } from './external-scenario-loader.js';
import { startMockServer, stopMockServer, type MockServer } from '../../fixtures/http-server.js';

const MAX_SCENARIO_TIMEOUT = 10 * 60 * 1000; // 10 min
const MAX_LIVE_SCENARIO_TIMEOUT = 60 * 1000; // 60s for live scenarios
const MAX_TOTAL_TIMEOUT = 4 * 60 * 60 * 1000; // 4 hours
const BATCH_WATCHDOG_MS = process.env.CI ? 5 * 60 * 1000 : 10 * 60 * 1000; // CI: 5 min, local: 10 min per batch
const MEMORY_LOG_INTERVAL = 500; // Log memory every 500 scenarios

// ---------------------------------------------------------------------------
// AVAILABILITY DETECTION
// ---------------------------------------------------------------------------

interface InfraStatus {
  docker: boolean;
  dockerVersion?: string;
  playwright: boolean;
  playwrightVersion?: string;
}

async function detectInfrastructure(): Promise<InfraStatus> {
  const [docker, playwright] = await Promise.all([
    detectDocker(),
    detectPlaywright(),
  ]);
  return { ...docker, ...playwright };
}

async function detectDocker(): Promise<{ docker: boolean; dockerVersion?: string }> {
  try {
    const result = await runCommand('docker', ['info', '--format', '{{.ServerVersion}}']);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { docker: true, dockerVersion: result.stdout.trim() };
    }
    return { docker: false };
  } catch {
    return { docker: false };
  }
}

async function detectPlaywright(): Promise<{ playwright: boolean; playwrightVersion?: string }> {
  try {
    // Check for the verify-playwright Docker image (same check as src/gates/browser.ts)
    const result = await runCommand('docker', ['image', 'inspect', 'verify-playwright:latest']);
    if (result.exitCode === 0) {
      return { playwright: true, playwrightVersion: 'docker' };
    }
    return { playwright: false };
  } catch {
    return { playwright: false };
  }
}

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 15_000);
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

function printInfraStatus(infra: InfraStatus, tier: LiveTier): void {
  console.log('  Infrastructure:');
  if (tier === 'pure') {
    console.log('    Docker:     — (not needed for pure tier)');
    console.log('    Playwright: — (not needed for pure tier)');
  } else {
    console.log(`    Docker:     ${infra.docker ? `✓ ${infra.dockerVersion ?? 'available'}` : '✗ not available'}`);
    if (tier === 'full') {
      console.log(`    Playwright: ${infra.playwright ? `✓ ${infra.playwrightVersion ?? 'available'}` : '✗ not available'}`);
    } else {
      console.log('    Playwright: — (not needed for live tier)');
    }
  }
  console.log('');
}

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

  const tier: LiveTier = config.liveTier ?? 'pure';
  const ledgerPath = config.ledgerPath ?? join(dataDir, 'self-test-ledger.jsonl');
  const ledger = new Ledger(ledgerPath);

  const tierLabel = tier === 'pure' ? 'pure' : tier === 'live' ? 'live (Docker)' : 'full (Docker + Playwright)';
  console.log(`\n  Verify Self-Test — ${identity.packageVersion} (${identity.gitCommit ?? 'no git'})`);
  console.log(`  Tier: ${tierLabel}`);
  if (isCustomApp) {
    console.log(`  Target app: ${config.appDir}`);
    console.log(`  Built-in scenarios run against: ${fixtureDir}`);
  } else {
    console.log(`  App dir: ${config.appDir}`);
  }
  console.log('');

  // Detect infrastructure availability for live/full tiers
  let infra: InfraStatus = { docker: false, playwright: false };
  if (tier !== 'pure') {
    infra = await detectInfrastructure();
    printInfraStatus(infra, tier);
  }

  // Source filtering: synthetic (default), real-world, or all
  const sourceMode = config.source ?? 'synthetic';
  const includeSynthetic = sourceMode === 'synthetic' || sourceMode === 'all';
  const includeRealWorld = sourceMode === 'real-world' || sourceMode === 'all';

  let scenarios: VerifyScenario[] = [];

  // Synthetic scenarios: built-in generators + staged fixtures
  if (includeSynthetic) {
    // Built-in scenarios always run against the fixture (demo-app)
    // They hardcode demo-app selectors/strings and would produce false failures on other apps
    if (config.families && config.families.length > 0) {
      scenarios = config.families.flatMap(f => generateFamily(f, fixtureDir));
    } else {
      scenarios = generateAllScenarios(fixtureDir);
    }

    // Universal scenarios: health-checked, portable, always run against demo-app
    const universals = loadUniversalScenarios(fixtureDir);
    if (universals.length > 0) {
      scenarios = [...scenarios, ...universals];
      console.log(`  + ${universals.length} universal scenarios from fixtures/scenarios/universal.json`);
    }

    // Per-gate staged scenarios from fixtures/scenarios/*-staged.json
    const staged = loadStagedScenarios(fixtureDir);
    if (staged.length > 0) {
      scenarios = [...scenarios, ...staged];
      console.log(`  + ${staged.length} per-gate staged scenarios (synthetic)`);
    }

    // WPT harvested scenarios (opt-in via --wpt)
    if (config.includeWPT) {
      const wpt = loadWPTScenarios(fixtureDir);
      if (wpt.length > 0) {
        scenarios = [...scenarios, ...wpt];
        console.log(`  + ${wpt.length} WPT scenarios`);
      }
    }
  }

  // Real-world scenarios: from fixtures/scenarios/real-world/*-staged.json
  if (includeRealWorld) {
    const realWorld = loadRealWorldScenarios(fixtureDir);
    if (realWorld.length > 0) {
      scenarios = [...scenarios, ...realWorld];
      console.log(`  + ${realWorld.length} real-world scenarios`);
    } else {
      console.log(`  ⊘ No real-world scenarios found (run: bun scripts/supply/harvest-real.ts)`);
    }
  }

  // External (fault-derived) scenarios run against the TARGET app
  const stateDir = join(config.appDir, '.verify');
  const external = loadExternalScenarios(join(stateDir, 'custom-scenarios.json'), config.appDir);
  if (external.length > 0) {
    scenarios = [...scenarios, ...external];
    console.log(`  + ${external.length} fault-derived scenarios from ${isCustomApp ? config.appDir : 'custom-scenarios.json'}`);
  }

  // Skip scenarios with extremely large edits (>500KB total) that hang the runner
  const MAX_EDIT_BYTES = 500 * 1024;
  const beforeLargeFilter = scenarios.length;
  scenarios = scenarios.filter(s => {
    const editSize = s.edits.reduce((sum: number, e: any) => sum + (e.search?.length || 0) + (e.replace?.length || 0), 0);
    return editSize < MAX_EDIT_BYTES;
  });
  const skippedLarge = beforeLargeFilter - scenarios.length;
  if (skippedLarge > 0) {
    console.log(`  Skipped ${skippedLarge} scenarios with >500KB edits`);
  }

  // Scenario ID filtering — for subprocess validation (run only specific scenarios)
  if (config.scenarioIds && config.scenarioIds.length > 0) {
    const idSet = new Set(config.scenarioIds);
    scenarios = scenarios.filter(s => idSet.has(s.id));
    console.log(`  Filtered to ${scenarios.length} scenarios by ID (${config.scenarioIds.length} requested)`);
  }

  // Filter by Docker availability (legacy flag — overridden by tier system)
  if (config.dockerEnabled === false && tier === 'pure') {
    scenarios = scenarios.filter(s => !s.requiresDocker);
  }

  // Tier-based filtering + skip counting
  let skippedDocker = 0;
  let skippedPlaywright = 0;
  let skippedLiveHttp = 0;

  if (tier === 'pure') {
    // Pure: skip all Docker, Playwright, and live HTTP scenarios
    const before = scenarios.length;
    scenarios = scenarios.filter(s => !s.requiresDocker && !s.requiresPlaywright && !s.requiresLiveHttp);
    skippedDocker = before - scenarios.length; // approximate — counts all non-pure
  } else if (tier === 'live') {
    // Live: include Docker scenarios, skip Playwright
    if (!infra.docker) {
      const dockerScenarios = scenarios.filter(s => s.requiresDocker);
      skippedDocker = dockerScenarios.length;
      scenarios = scenarios.filter(s => !s.requiresDocker);
    }
    const pwScenarios = scenarios.filter(s => s.requiresPlaywright);
    skippedPlaywright = pwScenarios.length;
    scenarios = scenarios.filter(s => !s.requiresPlaywright);
  } else {
    // Full: include everything available
    if (!infra.docker) {
      const dockerScenarios = scenarios.filter(s => s.requiresDocker || s.requiresPlaywright);
      skippedDocker = dockerScenarios.filter(s => s.requiresDocker && !s.requiresPlaywright).length;
      skippedPlaywright = dockerScenarios.filter(s => s.requiresPlaywright).length;
      scenarios = scenarios.filter(s => !s.requiresDocker && !s.requiresPlaywright);
    } else if (!infra.playwright) {
      const pwScenarios = scenarios.filter(s => s.requiresPlaywright);
      skippedPlaywright = pwScenarios.length;
      scenarios = scenarios.filter(s => !s.requiresPlaywright);
    }
  }

  // Report skipped scenarios
  if (skippedDocker > 0) console.log(`  Skipped ${skippedDocker} Docker scenarios (Docker not available)`);
  if (skippedPlaywright > 0) console.log(`  Skipped ${skippedPlaywright} Playwright scenarios (${tier === 'live' ? 'use --full' : 'Playwright not available'})`);
  if (skippedLiveHttp > 0) console.log(`  Skipped ${skippedLiveHttp} live HTTP scenarios`);

  console.log(`  Running ${scenarios.length} scenarios...\n`);

  // Log initial memory state for CI diagnostics
  const initMem = process.memoryUsage();
  console.log(`  [MEM] Initial — heap: ${(initMem.heapUsed / 1024 / 1024).toFixed(0)}MB, rss: ${(initMem.rss / 1024 / 1024).toFixed(0)}MB`);

  const totalStart = Date.now();
  // Reduce batch size for large scenario counts to limit peak memory on CI runners
  const defaultBatch = scenarios.length > 2000 ? 5 : 10;
  const batchSize = config.parallelBatch ?? defaultBatch;

  // Progress tracker for live CI visibility
  let completed = 0;
  let passed = 0;
  let failed = 0;
  const total = scenarios.length;

  function logBatchProgress(phaseName: string) {
    const pct = Math.round((completed / total) * 100);
    const elapsed = ((Date.now() - totalStart) / 1000).toFixed(0);
    console.log(`  ── Progress: ${completed}/${total} [${pct}%] | ✓${passed} ✗${failed} | ${elapsed}s elapsed (${phaseName}) ──`);
  }

  function trackEntry(entry: any) {
    completed++;
    if (entry.clean) passed++; else failed++;
  }

  // Separate into phases
  const pure = scenarios.filter(s => !s.requiresDocker && !s.requiresHttpMock && !s.requiresPlaywright && !s.requiresLiveHttp && !s.steps);
  const httpMock = scenarios.filter(s => s.requiresHttpMock && !s.requiresDocker);
  const multiStep = scenarios.filter(s => s.steps && s.steps.length > 0);
  const docker = scenarios.filter(s => s.requiresDocker && !s.requiresPlaywright && !s.requiresLiveHttp);
  const liveDocker = scenarios.filter(s => s.requiresDocker && s.requiresLiveHttp);
  const playwright = scenarios.filter(s => s.requiresPlaywright);

  // Phase 1: Pure scenarios in parallel batches
  if (pure.length > 0) {
    console.log(`  Phase 1: ${pure.length} pure scenarios (batches of ${batchSize})\n`);
    for (let i = 0; i < pure.length; i += batchSize) {
      if (Date.now() - totalStart > MAX_TOTAL_TIMEOUT) break;
      const batch = pure.slice(i, i + batchSize);

      // Memory diagnostics every N scenarios
      if (completed > 0 && completed % MEMORY_LOG_INTERVAL === 0) {
        const mem = process.memoryUsage();
        console.log(`  [MEM] ${completed}/${total} — heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB / ${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB, rss: ${(mem.rss / 1024 / 1024).toFixed(0)}MB`);
      }

      // Batch watchdog: if a batch takes longer than BATCH_WATCHDOG_MS, log and abort
      const batchStart = Date.now();
      let watchdogFired = false;
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        const mem = process.memoryUsage();
        const batchIds = batch.map(s => s.id).join(', ');
        console.error(`\n  *** BATCH WATCHDOG TRIGGERED ***`);
        console.error(`  Batch ${i / batchSize} hung after ${(BATCH_WATCHDOG_MS / 1000).toFixed(0)}s`);
        console.error(`  Scenarios: ${batchIds}`);
        console.error(`  Memory: heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB`);
        console.error(`  Completed: ${completed}/${total}`);
        console.error(`  Forcing process exit to prevent CI timeout waste\n`);
        process.exit(99);
      }, BATCH_WATCHDOG_MS);

      const results = await Promise.all(batch.map(s => runScenario(s, config)));
      clearTimeout(watchdog);

      for (const entry of results) {
        ledger.append(entry);
        trackEntry(entry);
        printProgress(entry);
      }
      logBatchProgress('Phase 1: pure');

      // Hint GC between batches to reduce peak memory on CI runners
      if (typeof globalThis.Bun !== 'undefined' && typeof (globalThis.Bun as any).gc === 'function') {
        (globalThis.Bun as any).gc(true);
      }
    }
  }

  // Phase 1.5: HTTP mock scenarios (local server, parallel batches)
  if (httpMock.length > 0) {
    console.log(`\n  Phase 1.5: ${httpMock.length} HTTP mock scenarios\n`);
    let mockServer: MockServer | null = null;
    try {
      mockServer = await startMockServer();
      console.log(`  Mock server started on ${mockServer.url}\n`);
      // Run sequentially — stateful routes (POST/DELETE) need isolation
      for (const s of httpMock) {
        if (Date.now() - totalStart > MAX_TOTAL_TIMEOUT) break;
        const entry = await runScenario(s, config, mockServer!.url);
        ledger.append(entry);
        trackEntry(entry);
        printProgress(entry);
      }
      logBatchProgress('Phase 1.5: httpMock');
    } finally {
      if (mockServer) {
        await stopMockServer(mockServer);
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
      trackEntry(entry);
      printProgress(entry);
    }
    logBatchProgress('Phase 2: K5');
  }

  // Phase 3: Docker scenarios — pattern-simulated (sequential)
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
        trackEntry(entry);
        printProgress(entry);
      }
      logBatchProgress('Phase 3: docker');
    }
  }

  // Phase 4+5 share a DBHarness — the demo-app container serves both
  // live DB/HTTP scenarios (Phase 4) and Playwright browser scenarios (Phase 5).
  const needsLiveContainers = (liveDocker.length > 0 && tier !== 'pure') ||
    (playwright.length > 0 && tier === 'full');

  if (needsLiveContainers) {
    if (!infra.docker) {
      if (liveDocker.length > 0 && (tier as string) !== 'pure') {
        console.log(`\n  Phase 4: ${liveDocker.length} live Docker scenarios — SKIPPED (Docker not available)\n`);
      }
      if (playwright.length > 0 && tier === 'full') {
        console.log(`\n  Phase 5: ${playwright.length} Playwright scenarios — SKIPPED (Docker not available)\n`);
      }
    } else {
      const { DBHarness } = await import('./db-harness.js');
      const dbHarness = new DBHarness(fixtureDir);
      try {
        console.log('\n    Starting containers...');
        await dbHarness.start();
        console.log(`    App running at ${dbHarness.getAppUrl()}\n`);

        // Phase 4: Live Docker scenarios (--live tier) — real Postgres + app container
        if (liveDocker.length > 0 && (tier as string) !== 'pure') {
          console.log(`  Phase 4: ${liveDocker.length} live Docker scenarios (sequential, real containers)\n`);
          for (const scenario of liveDocker) {
            if (Date.now() - totalStart > MAX_TOTAL_TIMEOUT) break;
            const entry = await runScenario(scenario, config, undefined, dbHarness);
            ledger.append(entry);
            trackEntry(entry);
            printProgress(entry);
          }
          logBatchProgress('Phase 4: liveDocker');
        }

        // Phase 5: Playwright scenarios (--full tier) — real browser rendering
        if (playwright.length > 0 && tier === 'full') {
          if (!infra.playwright) {
            console.log(`\n  Phase 5: ${playwright.length} Playwright scenarios — SKIPPED (verify-playwright:latest image not found)`);
            console.log(`    Build with: docker build -t verify-playwright:latest -f fixtures/Dockerfile.playwright .\n`);
          } else {
            console.log(`\n  Phase 5: ${playwright.length} Playwright scenarios (sequential, real browser)\n`);
            for (const scenario of playwright) {
              if (Date.now() - totalStart > MAX_TOTAL_TIMEOUT) break;
              const entry = await runScenario(scenario, config, undefined, dbHarness);
              ledger.append(entry);
              trackEntry(entry);
              printProgress(entry);
            }
            logBatchProgress('Phase 5: playwright');
          }
        }
      } catch (err: any) {
        console.log(`    Live infrastructure failure: ${err.message}\n`);
      } finally {
        await dbHarness.stop();
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

async function runScenario(scenario: VerifyScenario, config: RunConfig, mockServerUrl?: string, dbHarness?: import('./db-harness.js').DBHarness): Promise<LedgerEntry> {
  const stateDir = join(tmpdir(), `verify-selftest-${scenario.id}`);
  const scenarioStart = Date.now();

  // CI hang diagnosis: log scenario start so we can identify which scenario freezes
  if (process.env.CI) {
    const editSizes = (scenario.edits || []).map(e => (e.search?.length ?? 0) + (e.replace?.length ?? 0));
    const maxEdit = Math.max(0, ...editSizes);
    if (maxEdit > 100_000) {
      console.log(`    [DIAG] Starting ${scenario.id} (max edit: ${(maxEdit / 1024).toFixed(0)}KB)`);
    }
  }

  let result: VerifyResult | Error;
  let constraintsBefore = 0;
  let constraintsAfter = 0;
  let activeConstraintsAfter = 0;

  try {
    mkdirSync(stateDir, { recursive: true });

    // If scenario pre-seeded a stateDir with constraints, copy data into tmpdir
    const scenarioStateDir = scenario.config.stateDir;
    if (scenarioStateDir && existsSync(scenarioStateDir) && scenarioStateDir !== stateDir) {
      try {
        for (const f of readdirSync(scenarioStateDir)) {
          copyFileSync(join(scenarioStateDir, f), join(stateDir, f));
        }
      } catch { /* best-effort copy */ }
    }

    const store = new ConstraintStore(stateDir);
    constraintsBefore = store.getConstraintCount();

    // Reset mock server state before each HTTP mock scenario (isolation)
    if (mockServerUrl && scenario.requiresHttpMock) {
      try { await fetch(`${mockServerUrl}/api/reset`, { method: 'POST' }); } catch { /* best effort */ }
    }

    // Determine appUrl: mock server for mock scenarios, dbHarness for live Docker scenarios
    let resolvedAppUrl: string | undefined;
    if (mockServerUrl && scenario.requiresHttpMock) {
      resolvedAppUrl = mockServerUrl;
    } else if (dbHarness && dbHarness.isRunning()) {
      resolvedAppUrl = dbHarness.getAppUrl();
    }

    const mergedConfig = {
      ...scenario.config,
      appDir: scenario.config.appDir ?? config.appDir,
      stateDir,
      ...(resolvedAppUrl ? { appUrl: resolvedAppUrl } : {}),
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
    } else if (scenario.governTest) {
      // Family L: govern loop scenarios call govern() instead of verify()
      const { govern } = await import('../../src/govern.js');
      const govResult = await Promise.race([
        govern({
          appDir: mergedConfig.appDir!,
          goal: scenario.governTest.goal,
          agent: scenario.governTest.agent,
          maxAttempts: scenario.governTest.maxAttempts,
          stateDir,
          gates: mergedConfig.gates,
          onApproval: scenario.governTest.onApproval,
          onStuck: scenario.governTest.onStuck,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Govern scenario timeout (10 min)')), MAX_SCENARIO_TIMEOUT)
        ),
      ]);
      // Convert GovernResult to VerifyResult shape for invariant checking
      result = {
        success: govResult.success,
        gates: govResult.finalResult.gates,
        attestation: govResult.receipt.attestation,
        timing: { totalMs: govResult.receipt.totalDurationMs, perGate: {} },
        narrowing: govResult.finalResult.narrowing,
        // Stash the full govern result for invariant checks
        _governResult: govResult,
      } as any;
      // Update constraint count from govern's state
      const storePostGovern = new ConstraintStore(stateDir);
      constraintsAfter = storePostGovern.getConstraintCount();
    } else {
      // Log scenario start for CI hang diagnosis (helps identify which scenario freezes)
      const isPure = !scenario.requiresDocker && !scenario.requiresHttpMock && !scenario.requiresPlaywright && !scenario.requiresLiveHttp && !scenario.steps;
      // Skip extremely large edits in CI — 1MB .env scenario takes 18min on GitHub Actions
      const maxEditSize = Math.max(0, ...(scenario.edits || []).map((e: any) => (e.search?.length ?? 0) + (e.replace?.length ?? 0)));
      if (process.env.CI && maxEditSize > 500_000) {
        result = new Error(`Skipped in CI: edit size ${(maxEditSize / 1024).toFixed(0)}KB exceeds 500KB limit`);
      } else {
        const pureTimeout = maxEditSize > 100_000 ? 300_000 : 120_000; // 5min for large edits, 2min otherwise

        result = await Promise.race([
          verify(scenario.edits, scenario.predicates, mergedConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Scenario timeout (${isPure ? `${pureTimeout/1000}s pure` : '10 min'})`)), isPure ? pureTimeout : MAX_SCENARIO_TIMEOUT)
          ),
        ]);
      }
    }

    const storeAfter = new ConstraintStore(stateDir);
    constraintsAfter = storeAfter.getConstraintCount();
    activeConstraintsAfter = storeAfter.getActiveConstraintCount();
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
    activeConstraintsAfter,
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
      predicateCount: scenario.predicates?.length ?? 0,
      editCount: scenario.edits?.length ?? 0,
      requiresDocker: scenario.requiresDocker,
      failureClass: scenario.failureClass,
    },
    result: {
      success: result instanceof Error ? null : result.success,
      gatesPassed: result instanceof Error ? [] : result.gates.filter((g: { passed: boolean; gate: string }) => g.passed).map((g: { gate: string }) => g.gate),
      gatesFailed: result instanceof Error ? [] : result.gates.filter((g: { passed: boolean }) => !g.passed).map((g: { gate: string }) => g.gate),
      totalMs: durationMs,
      constraintsBefore,
      constraintsAfter,
      error: result instanceof Error ? result.message : undefined,
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
          activeConstraintsAfter: storeAfter.getActiveConstraintCount(),
        };

        // For skipVerify steps, only check scenario-specific invariants (not universal ones)
        // Universal invariants expect valid verify() output (gates, attestation, etc.)
        for (const inv of step.invariants) {
          try {
            const syntheticResult: VerifyResult = {
              success: true,
              gates: [],
              attestation: 'skipVerify step',
              timing: { totalMs: 0, perGate: {} },
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
