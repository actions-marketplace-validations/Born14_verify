/**
 * N1 Phase 2 — Raw loop context renderer.
 *
 * Implements DESIGN.md §3 (verbatim template).
 *
 * This is the FAIR CONTROL condition. The raw loop receives only the prior
 * VerifyResult on retry — no narrowing, no predicate hints, no constraint
 * state, no convergence summary. Just the goal, attempt number, and raw
 * gate failure messages.
 *
 * Fair means "what a reasonable agent developer would build", NOT
 * "deliberately weakened to make governed look better". The §24 hostile
 * reviewer check is specifically watching for formatting tricks or
 * ordering biases that would unfairly disadvantage the raw control.
 *
 * Invariant (§3): this renderer is a pure function. Identical inputs
 * must produce identical bytes. No Date.now(), no Math.random(),
 * no environment reads.
 *
 * Invariant (Phase 2 adversarial fairness): the `formatGateFailures`
 * helper below is also used by render-governed.ts. Both loops share
 * the exact same formatting for the raw-gate-failures block. The
 * governed renderer adds sections AFTER this block without modifying
 * its bytes. This enforces "if the hint stinks, it's not narrowing
 * crap" — any convergence lift governed earns must come from the
 * extra sections, not from reformatting the block both loops share.
 */

import type { VerifyResult, GateResult } from '../../../src/types.js';

/**
 * Format the "raw gate failure messages" block per §3.
 *
 * SHARED between raw and governed renderers. Must produce byte-identical
 * output for identical input. Do not localize, reorder, or alter this
 * function without updating BOTH renderers and the byte-exactness tests.
 *
 * Per §3:
 *   - One line per failed gate (passed === false)
 *   - Format: `- [gate_name]: {gate.detail truncated to 300 chars}`
 *   - Preserves the order of GateResult entries in priorResult.gates
 *     (no sorting — ordering bias would be a confound; §3 does not
 *      prescribe ordering, and the reasonable-agent-developer default
 *      is "whatever order verify() returned them").
 *   - If zero gates failed but success === false, renders one line:
 *     `- [unknown]: verify returned success: false with no specific gate failure.`
 */
export function formatGateFailures(priorResult: VerifyResult): string {
  const failed: GateResult[] = priorResult.gates.filter((g) => g.passed === false);

  if (failed.length === 0) {
    return '- [unknown]: verify returned success: false with no specific gate failure.';
  }

  const lines = failed.map((g) => {
    const detail = (g.detail ?? '').slice(0, 300);
    return `- [${g.gate}]: ${detail}`;
  });
  return lines.join('\n');
}

/**
 * Render the raw-loop retry context per DESIGN.md §3.
 *
 * On attempt 1, priorResult is undefined and the output is just
 * `GOAL: {goal}` (with no trailing newline — §3 says "system prompt +
 * `GOAL: {goal_string}` with no 'previous attempt' section").
 *
 * On attempt N ≥ 2, the output includes the "previous attempt" section
 * with one line per failed gate from priorResult, per the §3 template.
 *
 * Byte-exactness: the output of this function for the §3 worked example
 * input must equal the §3 worked example output exactly. See the
 * byte-exactness test in harness.test.ts.
 */
export function renderRawRetryContext(
  goal: string,
  attempt: number,
  maxAttempts: number,
  priorResult: VerifyResult | undefined
): string {
  // Attempt 1: no previous attempt section per §3 final paragraph.
  if (attempt === 1 || priorResult === undefined) {
    return `GOAL: ${goal}`;
  }

  // Attempt N ≥ 2: render the §3 verbatim template.
  const gateFailures = formatGateFailures(priorResult);

  return [
    `GOAL: ${goal}`,
    '',
    `ATTEMPT ${attempt} of ${maxAttempts}.`,
    '',
    'Your previous attempt failed. Here are the raw gate failure messages:',
    '',
    gateFailures,
    '',
    'Revise your edits and try again.',
  ].join('\n');
}
