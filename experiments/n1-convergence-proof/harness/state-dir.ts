/**
 * N1 Phase 2 — stateDir hygiene + fixture isolation.
 *
 * Implements DESIGN.md §21 (first-class harness requirement).
 *
 * TWO concerns:
 *
 *   1. stateDir wipe. Each governed run gets a fresh temp stateDir.
 *      govern() persists constraints in ConstraintStore and faults in
 *      FaultLedger. Without wipe, run 2 sees run 1's constraints,
 *      contaminating the 3-runs-per-case protocol. The raw loop is
 *      clean-by-construction but wipes for uniformity.
 *
 *   2. Fixture isolation. Each run gets its own copy of fixtures/demo-app
 *      (or the relevant fixture root) in a temp directory. The agent's
 *      edits mutate this copy; the real fixture is never touched. Pattern
 *      mirrors preflight.ts stageDemoApp() — same filter (skip node_modules,
 *      .git, .verify), same tmpdir() placement, same cp recursive.
 *
 * Failure mode (§21): if stateDir creation fails (permission error, etc.)
 * the run aborts with an error. If wipe of a staged dir fails during
 * cleanup, it's logged but does NOT abort — the staged dir is in a
 * per-run temp location and the OS will clean it up eventually. Only
 * the *start-of-run* staging is allowed to throw; cleanup is best-effort.
 *
 * This is the "silent corruption bug class" defense from the Phase 1
 * emergences: any error in staging is surfaced loudly; any error in
 * cleanup is logged but doesn't corrupt a downstream run because each
 * run gets its own fresh dir.
 *
 * Determinism note: paths include Date.now() and a short random suffix so
 * concurrent runs do not collide. This is the ONE place Date.now() is
 * allowed per the Phase 2 constraints — filename/path only, never in
 * anything the agent sees.
 */

import {
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface StagedRun {
  /** Fresh copy of the fixture appDir (agent edits go here) */
  appDir: string;
  /** Fresh stateDir for govern()'s ConstraintStore / FaultLedger */
  stateDir: string;
  /** Call to clean up both directories. Best-effort, never throws. */
  cleanup: () => void;
}

/** Sanitize a case_id for use as a path component. */
function safePathComponent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Build a unique run suffix using Date.now() + short random (§21-allowed use). */
function runSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stage a fresh run: copy the fixture, create a clean stateDir, return
 * paths + a cleanup handle. The caller is responsible for calling
 * cleanup() in a finally block.
 *
 * Throws on staging failure (mkdirSync, cpSync). Never throws on cleanup.
 */
export function stageRun(
  fixtureAppDir: string,
  caseId: string,
  loopType: 'raw' | 'governed',
  runIdx: number
): StagedRun {
  if (!existsSync(fixtureAppDir)) {
    throw new Error(`stateDir hygiene: fixture dir does not exist: ${fixtureAppDir}`);
  }

  const safe = safePathComponent(caseId);
  const suffix = runSuffix();
  const base = join(tmpdir(), `n1-${safe}-${loopType}-r${runIdx}-${suffix}`);

  const appDir = join(base, 'app');
  const stateDir = join(base, 'state');

  // Create both directories. Failures here are staging failures and
  // must abort the run (§21 — no silent continuation).
  mkdirSync(base, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // Copy the fixture into appDir. Skip the three dirs that would
  // contaminate cross-run state (node_modules bloats, .git has history,
  // .verify holds constraint state from a prior run).
  cpSync(fixtureAppDir, appDir, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[/\\]/).pop() ?? '';
      return !['node_modules', '.git', '.verify'].includes(name);
    },
  });

  // §21 sanity check: stateDir must be empty at the start of the run.
  // If it's not, that's a silent-corruption bug class and we refuse to
  // proceed — this is the defense against the Phase 1 emergence pattern.
  const stateEntries = readdirSync(stateDir);
  if (stateEntries.length > 0) {
    throw new Error(
      `stateDir hygiene: stateDir not empty at run start: ${stateDir} contains ${stateEntries.join(', ')}`
    );
  }

  const cleanup = (): void => {
    // Best-effort. Never throws. A failure here does NOT corrupt the
    // next run because the next run gets its own freshly-staged base
    // directory with its own unique suffix.
    if (existsSync(base)) {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch (err) {
        // Log to stderr so the operator sees cleanup issues without
        // letting them abort the pilot.
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[stateDir cleanup warning] ${base}: ${msg}`);
      }
    }
  };

  return { appDir, stateDir, cleanup };
}
