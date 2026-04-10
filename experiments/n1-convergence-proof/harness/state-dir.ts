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
 *      mirrors preflight.ts stageDemoApp() — do not reinvent.
 *
 * Failure mode (§21): if wipe fails (permission error, file lock, etc.)
 * the run aborts with an error. The harness does NOT silently proceed on
 * unwiped state. Silent continuation would corrupt the audit trail in
 * exactly the silent-corruption class flagged in the Phase 1 emergences
 * (SI-003 class, Amendment 3 determinism bug class).
 *
 * Determinism note: paths include Date.now() and a short random suffix so
 * concurrent runs do not collide. This is the ONE place Date.now() is
 * allowed per the Phase 2 constraints — filename/path only, never in
 * anything the agent sees.
 *
 * Scaffold status: skeleton. Body implemented in deliverable 4.
 */

export interface StagedRun {
  /** Fresh copy of the fixture appDir (agent edits go here) */
  appDir: string;
  /** Fresh stateDir for govern()'s ConstraintStore / FaultLedger */
  stateDir: string;
  /** Call to clean up both directories. Best-effort, never throws. */
  cleanup: () => void;
}

/**
 * Stage a fresh run: copy the fixture, create a clean stateDir, return
 * paths + a cleanup handle. The caller is responsible for calling
 * cleanup() in a finally block.
 */
export function stageRun(
  fixtureAppDir: string,
  caseId: string,
  loopType: 'raw' | 'governed',
  runIdx: number
): StagedRun {
  void fixtureAppDir; void caseId; void loopType; void runIdx;
  throw new Error('NOT_IMPLEMENTED: state-dir deliverable 4');
}
