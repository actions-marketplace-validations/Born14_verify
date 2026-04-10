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
 * Scaffold status: skeleton. Body implemented in deliverable 2.
 */

import type { VerifyResult } from '../../../src/types.js';

/**
 * Render the raw-loop retry context per DESIGN.md §3.
 *
 * On attempt 1, priorResult is undefined and the output is just
 * `GOAL: {goal}`.
 *
 * On attempt N ≥ 2, the output includes the "previous attempt" section
 * with one line per failed gate from priorResult.
 */
export function renderRawRetryContext(
  goal: string,
  attempt: number,
  maxAttempts: number,
  priorResult: VerifyResult | undefined
): string {
  void goal; void attempt; void maxAttempts; void priorResult;
  throw new Error('NOT_IMPLEMENTED: render-raw deliverable 2');
}
