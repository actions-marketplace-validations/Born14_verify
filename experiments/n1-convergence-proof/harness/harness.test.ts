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
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { renderRawRetryContext, formatGateFailures } from './render-raw.js';
import {
  renderGovernedRetryContext,
  formatNarrowing,
  formatConstraints,
  formatFailureShapes,
  formatConvergenceSummary,
} from './render-governed.js';
import { stageRun } from './state-dir.js';
import {
  createCostTracker,
  callLLMWithTracking,
  type CallLLMImpl,
} from './llm-adapter.js';
import type { VerifyResult, Narrowing, GroundingContext } from '../../../src/types.js';
import type { GovernContext } from '../../../src/govern.js';

/** Minimal empty GroundingContext for test fixtures. */
const emptyGrounding: GroundingContext = {
  routeCSSMap: new Map(),
  htmlElements: new Map(),
  routes: [],
};

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
  const demoAppFixture = join(import.meta.dir, '..', '..', '..', 'fixtures', 'demo-app');

  it('stateDir wipe: fresh stageRun produces an empty stateDir', () => {
    const staged = stageRun(demoAppFixture, 'canary:wipe-test', 'governed', 0);
    try {
      expect(existsSync(staged.stateDir)).toBe(true);
      const entries = readdirSync(staged.stateDir);
      expect(entries).toEqual([]);
    } finally {
      staged.cleanup();
    }
  });

  it('stateDir wipe: second stageRun after writing canary file is empty again', () => {
    // Run 1: stage, write a canary file into stateDir, cleanup.
    const run1 = stageRun(demoAppFixture, 'canary:wipe-test', 'governed', 0);
    const canaryPath = join(run1.stateDir, 'canary.txt');
    writeFileSync(canaryPath, 'should-not-survive');
    expect(existsSync(canaryPath)).toBe(true);
    run1.cleanup();

    // Run 2: fresh stage for the SAME case_id. The new stateDir must
    // not contain the canary — it's in a different tmp dir entirely,
    // AND the emptiness check in stageRun() would have thrown if it did.
    const run2 = stageRun(demoAppFixture, 'canary:wipe-test', 'governed', 0);
    try {
      const entries = readdirSync(run2.stateDir);
      expect(entries).toEqual([]);
      // And the run1 canary is definitely not present.
      expect(existsSync(join(run2.stateDir, 'canary.txt'))).toBe(false);
      // And the two stateDirs are different paths (unique suffix).
      expect(run2.stateDir).not.toBe(run1.stateDir);
    } finally {
      run2.cleanup();
    }
  });

  it('fixture isolation: mutating staged appDir does not touch the fixture root', () => {
    // Read the original fixture config.json (a file that definitely exists
    // per fixtures/demo-app/ directory listing).
    const fixtureConfigPath = join(demoAppFixture, 'config.json');
    const originalContent = readFileSync(fixtureConfigPath, 'utf-8');

    const staged = stageRun(demoAppFixture, 'canary:isolation', 'raw', 0);
    try {
      // The copy should exist inside the staged appDir.
      const stagedConfigPath = join(staged.appDir, 'config.json');
      expect(existsSync(stagedConfigPath)).toBe(true);

      // Mutate the copy aggressively.
      writeFileSync(stagedConfigPath, '{"mutated":"by-canary"}');

      // The copy is mutated...
      expect(readFileSync(stagedConfigPath, 'utf-8')).toBe('{"mutated":"by-canary"}');
      // ...but the original fixture is untouched.
      expect(readFileSync(fixtureConfigPath, 'utf-8')).toBe(originalContent);
    } finally {
      staged.cleanup();
    }
  });

  it('stateDir hygiene: throws on missing fixture dir (no silent continuation)', () => {
    expect(() =>
      stageRun('/nonexistent/path/does/not/exist', 'canary:missing', 'raw', 0)
    ).toThrow(/fixture dir does not exist/);
  });

  it('stateDir hygiene: excludes node_modules / .git / .verify from copy', () => {
    const staged = stageRun(demoAppFixture, 'canary:exclude', 'governed', 0);
    try {
      // These directories should NOT be in the staged copy even if they
      // exist in the fixture (they don't in demo-app but the filter runs).
      expect(existsSync(join(staged.appDir, 'node_modules'))).toBe(false);
      expect(existsSync(join(staged.appDir, '.git'))).toBe(false);
      expect(existsSync(join(staged.appDir, '.verify'))).toBe(false);
      // But real fixture files ARE present.
      expect(existsSync(join(staged.appDir, 'server.js'))).toBe(true);
    } finally {
      staged.cleanup();
    }
  });

  it('stateDir hygiene: each run has a unique base path (no collision across runs)', () => {
    const a = stageRun(demoAppFixture, 'canary:collision', 'raw', 0);
    const b = stageRun(demoAppFixture, 'canary:collision', 'raw', 0);
    try {
      expect(a.appDir).not.toBe(b.appDir);
      expect(a.stateDir).not.toBe(b.stateDir);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
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

  it('governed renderer matches DESIGN.md §4 worked example', () => {
    // Verbatim §4 worked example, copy-pasted from DESIGN.md lines 184-210.
    const expected =
      'GOAL: F9 exact match: change port number in server.js\n' +
      '\n' +
      'ATTEMPT 2 of 5.\n' +
      '\n' +
      'Your previous attempt failed. Here are the raw gate failure messages:\n' +
      '\n' +
      '- [F9]: server.js: search string not found; searched for "const PORT = process.env.PORT || 9999;" in server.js\n' +
      '\n' +
      'NARROWING (guidance from the verification system):\n' +
      '\n' +
      'HINT: The search string did not match any content in the file. Check the exact text in the file and match whitespace and punctuation precisely.\n' +
      'EVIDENCE: Expected "const PORT = process.env.PORT || 9999;" but file contains "const PORT = process.env.PORT || 3000;"\n' +
      '\n' +
      'CONSTRAINTS currently active (1 total):\n' +
      '\n' +
      '- [search-string] Edit search field must exactly match existing file content before substitution\n' +
      '\n' +
      'FAILURE SHAPES observed across attempts:\n' +
      '\n' +
      '- F9-001\n' +
      '\n' +
      'CONVERGENCE PROGRESS:\n' +
      '\n' +
      '1 new shape(s)\n' +
      '\n' +
      'Revise your edits and try again.';

    const narrowing: Narrowing = {
      constraints: [],
      resolutionHint:
        'The search string did not match any content in the file. Check the exact text in the file and match whitespace and punctuation precisely.',
      fileEvidence:
        'Expected "const PORT = process.env.PORT || 9999;" but file contains "const PORT = process.env.PORT || 3000;"',
    };

    const priorResult: VerifyResult = {
      success: false,
      gates: [
        {
          gate: 'F9',
          passed: false,
          detail:
            'server.js: search string not found; searched for "const PORT = process.env.PORT || 9999;" in server.js',
          durationMs: 1,
        },
      ],
      narrowing,
      attestation: '',
      timing: { totalMs: 1, perGate: {} },
    };

    const context: GovernContext = {
      grounding: emptyGrounding,
      attempt: 2,
      priorResult,
      narrowing,
      constraints: [
        {
          id: 'c1',
          type: 'search-string',
          reason: 'Edit search field must exactly match existing file content before substitution',
        },
      ],
      failureShapes: ['F9-001'],
      convergence: {
        shapesProgressing: true,
        gatesProgressing: true,
        uniqueShapes: ['F9-001'],
        shapeHistory: [['F9-001']],
        gateFailureHistory: [['F9']],
        emptyPlanCount: 0,
        gateRepeatCount: 0,
        constraintSaturation: false,
        progressSummary: '1 new shape(s)',
      },
    };

    const actual = renderGovernedRetryContext(
      'F9 exact match: change port number in server.js',
      context,
      5
    );

    expect(actual).toBe(expected);
  });

  it('governed renderer attempt 1: no previous-attempt section (parity with raw)', () => {
    const context: GovernContext = {
      grounding: emptyGrounding,
      attempt: 1,
      constraints: [],
    };
    const out = renderGovernedRetryContext('goal string', context, 5);
    expect(out).toBe('GOAL: goal string');
  });

  it('raw/governed parity: attempt-1 output is byte-identical', () => {
    const goal = 'some goal';
    const rawOut = renderRawRetryContext(goal, 1, 5, undefined);
    const governedOut = renderGovernedRetryContext(
      goal,
      { grounding: emptyGrounding, attempt: 1, constraints: [] },
      5
    );
    expect(governedOut).toBe(rawOut);
  });

  it('raw/governed parity: gate-failures block is byte-identical between loops', () => {
    // Both renderers should emit the same gate-failures substring for the
    // same priorResult. This is the adversarial-fairness enforcement: the
    // governed loop cannot gain advantage by reformatting the block both
    // loops share.
    const priorResult: VerifyResult = {
      success: false,
      gates: [
        { gate: 'F9', passed: false, detail: 'F9 failed here', durationMs: 1 },
        { gate: 'content', passed: false, detail: 'content mismatch', durationMs: 1 },
      ],
      attestation: '',
      timing: { totalMs: 1, perGate: {} },
    };

    const rawBlock = formatGateFailures(priorResult);

    const context: GovernContext = {
      grounding: emptyGrounding,
      attempt: 2,
      priorResult,
      constraints: [],
    };
    const governedOut = renderGovernedRetryContext('g', context, 5);

    // The governed output must contain the raw block verbatim.
    expect(governedOut).toContain(rawBlock);
    // And the raw block must appear before any §4-specific header.
    expect(governedOut.indexOf(rawBlock)).toBeLessThan(governedOut.indexOf('NARROWING'));
  });

  it('formatNarrowing: undefined narrowing renders the no-narrowing placeholder', () => {
    expect(formatNarrowing(undefined)).toBe('(no narrowing produced for this failure)');
  });

  it('formatNarrowing: empty narrowing object renders the no-narrowing placeholder', () => {
    const empty: Narrowing = { constraints: [] };
    expect(formatNarrowing(empty)).toBe('(no narrowing produced for this failure)');
  });

  it('formatNarrowing: all five sub-sections render in §4 order', () => {
    const n: Narrowing = {
      constraints: [],
      resolutionHint: 'hint text',
      fileEvidence: 'evidence text',
      patternRecall: ['pattern-a', 'pattern-b'],
      nextMoves: [
        { type: 't', predicate: {}, score: 0.9, rationale: 'rat', kind: 'k1' },
      ],
      bannedFingerprints: ['fp1', 'fp2', 'fp3', 'fp4', 'fp5', 'fp6-not-shown'],
    };
    const out = formatNarrowing(n);
    const lines = out.split('\n');
    expect(lines[0]).toBe('HINT: hint text');
    expect(lines[1]).toBe('EVIDENCE: evidence text');
    expect(lines[2]).toBe('PRIOR SUCCESSFUL PATTERNS: pattern-a; pattern-b');
    expect(lines[3]).toBe('SUGGESTED NEXT MOVES:');
    expect(lines[4]).toBe('  - k1 (score 0.9): rat');
    // Last line: AVOID with first 5 only — fp6 must not appear.
    expect(lines[5]).toBe('AVOID: these predicate patterns have failed before: fp1, fp2, fp3, fp4, fp5');
    expect(out).not.toContain('fp6');
  });

  it('formatConstraints: empty → (none)', () => {
    expect(formatConstraints([])).toBe('(none)');
  });

  it('formatConstraints: one line per constraint with [type] reason', () => {
    const c = [
      { id: 'a', type: 'search-string', reason: 'must match' },
      { id: 'b', type: 'predicate', reason: 'banned pattern' },
    ];
    expect(formatConstraints(c)).toBe('- [search-string] must match\n- [predicate] banned pattern');
  });

  it('formatFailureShapes: empty → (none)', () => {
    expect(formatFailureShapes(undefined)).toBe('(none)');
    expect(formatFailureShapes([])).toBe('(none)');
  });

  it('formatFailureShapes: one line per shape id', () => {
    expect(formatFailureShapes(['F9-001', 'F9-002'])).toBe('- F9-001\n- F9-002');
  });

  it('formatConvergenceSummary: uses convergence.progressSummary when present', () => {
    const convergence = {
      shapesProgressing: true,
      gatesProgressing: true,
      uniqueShapes: [],
      shapeHistory: [],
      gateFailureHistory: [],
      emptyPlanCount: 0,
      gateRepeatCount: 0,
      constraintSaturation: false,
      progressSummary: '2 new shape(s)',
    };
    expect(formatConvergenceSummary(convergence)).toBe('2 new shape(s)');
  });

  it('formatConvergenceSummary: undefined → first-attempt fallback', () => {
    expect(formatConvergenceSummary(undefined)).toBe('first attempt — no convergence history');
  });

  it('governed renderer: missing narrowing/constraints/shapes render placeholders', () => {
    const priorResult: VerifyResult = {
      success: false,
      gates: [{ gate: 'F9', passed: false, detail: 'broken', durationMs: 1 }],
      attestation: '',
      timing: { totalMs: 1, perGate: {} },
    };
    const context: GovernContext = {
      grounding: emptyGrounding,
      attempt: 2,
      priorResult,
      constraints: [],
    };
    const out = renderGovernedRetryContext('g', context, 5);
    expect(out).toContain('(no narrowing produced for this failure)');
    expect(out).toContain('CONSTRAINTS currently active (0 total):\n\n(none)');
    expect(out).toContain('FAILURE SHAPES observed across attempts:\n\n(none)');
    expect(out).toContain('CONVERGENCE PROGRESS:\n\nfirst attempt — no convergence history');
  });
});

describe('N1 harness — cost tracker', () => {
  it('fresh tracker: zero spend, zero calls, not over alert, not over cap', () => {
    const t = createCostTracker(30, 20);
    expect(t.totalSpentUsd).toBe(0);
    expect(t.totalCalls).toBe(0);
    expect(t.overAlert).toBe(false);
    expect(t.overCap).toBe(false);
  });

  it('recordCall: accumulates spend + call count', () => {
    const t = createCostTracker(30, 20);
    t.recordCall({ text: 'x', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 5 });
    t.recordCall({ text: 'y', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 3 });
    expect(t.totalSpentUsd).toBe(8);
    expect(t.totalCalls).toBe(2);
  });

  it('alert threshold: crossing $20 sets overAlert', () => {
    const t = createCostTracker(30, 20);
    t.recordCall({ text: '', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 19.99 });
    expect(t.overAlert).toBe(false);
    t.recordCall({ text: '', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.02 });
    expect(t.overAlert).toBe(true);
    expect(t.overCap).toBe(false);
  });

  it('hard cap: checkBudget throws when cumulative spend reaches $30', () => {
    const t = createCostTracker(30, 20);
    t.recordCall({ text: '', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 30 });
    expect(() => t.checkBudget()).toThrow(/§22 hard cap/);
    expect(t.overCap).toBe(true);
  });

  it('hard cap: checkBudget does NOT throw at $29.99 (one-call headroom)', () => {
    const t = createCostTracker(30, 20);
    t.recordCall({ text: '', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 29.99 });
    expect(() => t.checkBudget()).not.toThrow();
  });

  it('tracker config: alertThreshold > hardCap throws at construction', () => {
    expect(() => createCostTracker(20, 30)).toThrow(/alertThreshold/);
  });

  it('snapshot: returns a frozen view of the tracker state', () => {
    const t = createCostTracker(30, 20);
    t.recordCall({ text: '', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 21 });
    const snap = t.snapshot();
    expect(snap.totalSpentUsd).toBe(21);
    expect(snap.totalCalls).toBe(1);
    expect(snap.overAlert).toBe(true);
    expect(snap.overCap).toBe(false);
  });
});

describe('N1 harness — llm-adapter', () => {
  /** A mock callLLM that never hits the network. Per the kickoff brief:
   *  "No harness tests against production models without the budget
   *   tracker wired first. Mock the LLM in self-tests." */
  const mockCallLLM: CallLLMImpl = async (prompt, apiKey, provider) => {
    // Assert the adapter passes through the args untouched.
    if (typeof prompt !== 'string') throw new Error('mock: prompt not a string');
    if (apiKey !== 'test-key') throw new Error(`mock: wrong apiKey ${apiKey}`);
    if (provider !== 'gemini') throw new Error(`mock: wrong provider ${provider}`);
    return 'mocked-response';
  };

  it('callLLMWithTracking: calls the injected mock and records cost', async () => {
    const tracker = createCostTracker(30, 20);
    const result = await callLLMWithTracking('hello prompt', tracker, {
      callLLMImpl: mockCallLLM,
      apiKey: 'test-key',
      provider: 'gemini',
    });
    expect(result.text).toBe('mocked-response');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(tracker.totalCalls).toBe(1);
    expect(tracker.totalSpentUsd).toBe(result.estimatedCostUsd);
  });

  it('callLLMWithTracking: throws on missing apiKey', async () => {
    const tracker = createCostTracker(30, 20);
    // Clear env override by passing empty string explicitly.
    await expect(
      callLLMWithTracking('prompt', tracker, {
        callLLMImpl: mockCallLLM,
        apiKey: '',
        provider: 'gemini',
      })
    ).rejects.toThrow(/INPUT_API_KEY not set/);
  });

  it('callLLMWithTracking: refuses to call when over cap (§22)', async () => {
    const tracker = createCostTracker(30, 20);
    // Force the tracker over cap.
    tracker.recordCall({ text: '', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 30.01 });
    await expect(
      callLLMWithTracking('prompt', tracker, {
        callLLMImpl: mockCallLLM,
        apiKey: 'test-key',
        provider: 'gemini',
      })
    ).rejects.toThrow(/§22 hard cap/);
  });

  it('callLLMWithTracking: Gemini pricing is ~$0.0000001/input token and ~$0.0000004/output token', async () => {
    // Deterministic cost calculation check. A 1000-char prompt ≈ 250 input
    // tokens; the mock returns 'mocked-response' (15 chars ≈ 4 output
    // tokens). Cost should be tiny but predictable.
    const tracker = createCostTracker(30, 20);
    const longPrompt = 'x'.repeat(1000);
    const result = await callLLMWithTracking(longPrompt, tracker, {
      callLLMImpl: mockCallLLM,
      apiKey: 'test-key',
      provider: 'gemini',
    });
    // inputTokens = ceil(1000 / 4) = 250
    expect(result.inputTokens).toBe(250);
    // outputTokens = ceil(15 / 4) = 4
    expect(result.outputTokens).toBe(4);
    // Cost = 250 * 1e-7 + 4 * 4e-7 = 2.5e-5 + 1.6e-6 = ~2.66e-5
    expect(result.estimatedCostUsd).toBeCloseTo(250 * 0.0000001 + 4 * 0.0000004, 10);
  });

  it('callLLMWithTracking: never reaches the real network in tests (mock injection is mandatory)', async () => {
    // Sanity: if a test forgets to pass callLLMImpl AND env has no key,
    // the adapter throws before calling the real callLLM. This prevents
    // accidental network calls from tests.
    const tracker = createCostTracker(30, 20);
    const originalKey = process.env.INPUT_API_KEY;
    try {
      delete process.env.INPUT_API_KEY;
      await expect(
        callLLMWithTracking('prompt', tracker, {
          callLLMImpl: mockCallLLM,
          provider: 'gemini',
          // deliberately no apiKey override
        })
      ).rejects.toThrow(/INPUT_API_KEY not set/);
    } finally {
      if (originalKey !== undefined) process.env.INPUT_API_KEY = originalKey;
    }
  });
});
