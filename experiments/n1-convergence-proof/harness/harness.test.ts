/**
 * N1 Phase 2 — Harness self-tests.
 *
 * Two canary tests per the kickoff brief (step 7 of deliverables):
 *
 *   1. stateDir wipe canary: write a canary file into a stateDir, run a
 *      second stageRun() for the same case, assert the canary is NOT
 *      present in the new stateDir. Catches any regression that
 *      accidentally reuses a stateDir across runs.
 *
 *   2. Fixture isolation canary: mutate the staged appDir copy, confirm
 *      the original fixtureAppDir is unchanged. Catches any regression
 *      that accidentally writes to the shared fixture root instead of
 *      the temp copy.
 *
 * Additional coverage built during the later deliverables:
 *
 *   3. Raw renderer byte-exactness against the DESIGN.md §3 worked example.
 *   4. Governed renderer byte-exactness against the DESIGN.md §4 worked example.
 *   5. Raw/governed parity: the gate-failures block is byte-identical
 *      between the two renderers for the same priorResult. This enforces
 *      the "only difference between loops is the context renderer's
 *      governed-specific sections" invariant.
 *   6. Cost tracker budget cap: recording calls above $30 throws.
 *   7. Cost tracker alert threshold: crossing $20 sets overAlert.
 *   8. llm-adapter mock mode: tests NEVER call the real LLM. A mock
 *      callLLM is injected for all self-tests.
 *
 * Per the Phase 2 constraints: "No harness tests against production models
 * without the budget tracker wired first. Mock the LLM in self-tests."
 *
 * Scaffold status: skeleton. Tests fleshed out in deliverable 8 as the
 * underlying modules are implemented.
 */

import { describe, it } from 'bun:test';

/** Placeholder body for .todo() tests under bun:test's Test<> signature. */
const pending = (): void => { /* scaffold — implemented in deliverable 8 */ };

describe('N1 harness — canaries', () => {
  it.todo('stateDir wipe: fresh stageRun produces an empty stateDir', pending);
  it.todo('fixture isolation: mutating staged appDir does not touch the fixture root', pending);
});

describe('N1 harness — renderer byte-exactness', () => {
  it.todo('raw renderer matches DESIGN.md §3 worked example', pending);
  it.todo('governed renderer matches DESIGN.md §4 worked example', pending);
  it.todo('raw/governed parity: gate-failures block is byte-identical', pending);
});

describe('N1 harness — cost tracker', () => {
  it.todo('budget cap: recordCall above $30 throws', pending);
  it.todo('alert threshold: crossing $20 sets overAlert', pending);
});

describe('N1 harness — llm-adapter', () => {
  it.todo('all self-tests use a mocked callLLM — no network', pending);
});
