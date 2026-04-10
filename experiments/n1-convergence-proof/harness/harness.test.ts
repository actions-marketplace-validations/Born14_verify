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

import { describe, it, expect } from 'bun:test';
import { renderRawRetryContext, formatGateFailures } from './render-raw.js';
import type { VerifyResult } from '../../../src/types.js';

/** Placeholder body for .todo() tests under bun:test's Test<> signature. */
const pending = (): void => { /* scaffold — implemented in deliverable 8 */ };

/** Build a minimal VerifyResult with a single failed F9 gate, matching §3 worked example. */
const f9WorkedExampleResult: VerifyResult = {
  success: false,
  gates: [
    {
      gate: 'F9',
      passed: false,
      detail: 'server.js: search string not found; searched for "const PORT = process.env.PORT || 9999;" in server.js',
      durationMs: 1,
    },
  ],
  attestation: '',
  timing: { totalMs: 1, perGate: {} },
};

describe('N1 harness — canaries', () => {
  it.todo('stateDir wipe: fresh stageRun produces an empty stateDir', pending);
  it.todo('fixture isolation: mutating staged appDir does not touch the fixture root', pending);
});

describe('N1 harness — renderer byte-exactness', () => {
  it('raw renderer matches DESIGN.md §3 worked example', () => {
    // Verbatim §3 worked example output, copy-paste from DESIGN.md lines 118-128.
    const expected =
      'GOAL: F9 exact match: change port number in server.js\n' +
      '\n' +
      'ATTEMPT 2 of 5.\n' +
      '\n' +
      'Your previous attempt failed. Here are the raw gate failure messages:\n' +
      '\n' +
      '- [F9]: server.js: search string not found; searched for "const PORT = process.env.PORT || 9999;" in server.js\n' +
      '\n' +
      'Revise your edits and try again.';

    const actual = renderRawRetryContext(
      'F9 exact match: change port number in server.js',
      2,
      5,
      f9WorkedExampleResult
    );

    expect(actual).toBe(expected);
  });

  it('raw renderer attempt 1: no previous-attempt section (§3 final paragraph)', () => {
    // §3: "On attempt 1, the raw loop sends the system prompt +
    //      `GOAL: {goal_string}` with no 'previous attempt' section."
    const out = renderRawRetryContext('goal string', 1, 5, undefined);
    expect(out).toBe('GOAL: goal string');
  });

  it('raw renderer: zero failed gates with success=false uses the [unknown] line (§3)', () => {
    const priorResult: VerifyResult = {
      success: false,
      gates: [{ gate: 'F9', passed: true, detail: '', durationMs: 1 }],
      attestation: '',
      timing: { totalMs: 1, perGate: {} },
    };
    const out = renderRawRetryContext('g', 2, 5, priorResult);
    expect(out).toContain('- [unknown]: verify returned success: false with no specific gate failure.');
  });

  it('raw renderer: truncates gate.detail at 300 chars (§3)', () => {
    const longDetail = 'x'.repeat(500);
    const priorResult: VerifyResult = {
      success: false,
      gates: [{ gate: 'F9', passed: false, detail: longDetail, durationMs: 1 }],
      attestation: '',
      timing: { totalMs: 1, perGate: {} },
    };
    const out = renderRawRetryContext('g', 2, 5, priorResult);
    // Line is `- [F9]: {300 x's}`; count the x's in the output.
    const xCount = (out.match(/x/g) ?? []).length;
    expect(xCount).toBe(300);
  });

  it('raw renderer: multiple failed gates preserve verify() ordering (no sort)', () => {
    const priorResult: VerifyResult = {
      success: false,
      gates: [
        { gate: 'state', passed: false, detail: 'state detail', durationMs: 1 },
        { gate: 'F9', passed: false, detail: 'F9 detail', durationMs: 1 },
        { gate: 'access', passed: true, detail: '', durationMs: 1 },
        { gate: 'content', passed: false, detail: 'content detail', durationMs: 1 },
      ],
      attestation: '',
      timing: { totalMs: 1, perGate: {} },
    };
    const out = renderRawRetryContext('g', 3, 5, priorResult);
    const stateIdx = out.indexOf('[state]');
    const f9Idx = out.indexOf('[F9]');
    const contentIdx = out.indexOf('[content]');
    // Order matches priorResult.gates order (filter preserves order).
    expect(stateIdx).toBeGreaterThan(-1);
    expect(f9Idx).toBeGreaterThan(stateIdx);
    expect(contentIdx).toBeGreaterThan(f9Idx);
    // Passed gate is not shown.
    expect(out).not.toContain('[access]');
  });

  it('formatGateFailures: pure function — identical input produces identical bytes', () => {
    const a = formatGateFailures(f9WorkedExampleResult);
    const b = formatGateFailures(f9WorkedExampleResult);
    expect(a).toBe(b);
  });

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
