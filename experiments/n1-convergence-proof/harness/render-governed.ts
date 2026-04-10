/**
 * N1 Phase 2 — Governed loop context renderer.
 *
 * Implements DESIGN.md §4 (verbatim template).
 *
 * The governed loop receives a full GovernContext from govern() on retry
 * and renders a "previous attempt" section that includes everything the
 * raw loop shows PLUS narrowing, constraints, failure shapes, and a
 * convergence summary.
 *
 * CRITICAL (§4 + Phase 2 constraint): this renderer MUST NOT reimplement
 * narrowing logic. It reads fields off GovernContext that govern()
 * populated. The narrowing pipeline lives in src/govern.ts + src/verify.ts;
 * the harness's job is to translate GovernContext → prompt string, nothing
 * more. If this renderer ever reaches into predicate extraction or
 * constraint inference directly, that's a reimplementation and it's wrong.
 *
 * Invariant (§4 "only difference between loops"): the raw and governed
 * renderers share identical formatting for the gate-failures block. The
 * governed renderer adds sections AFTER the gate-failures block. It does
 * not reorder, reformat, or enrich the raw-shared sections in any way.
 * Adversarial fairness is enforced by deliberately sharing the
 * `formatGateFailures` helper between both renderers (see implementation
 * in deliverable 3).
 *
 * Invariant: pure function. No Date.now, no Math.random, no env reads.
 *
 * Scaffold status: skeleton. Body implemented in deliverable 3.
 */

import type { GovernContext } from '../../../src/govern.js';

/**
 * Render the governed-loop retry context per DESIGN.md §4.
 *
 * On attempt 1, the output is just `GOAL: {goal}` (same as raw).
 *
 * On attempt N ≥ 2, reads from context.priorResult, context.narrowing,
 * context.constraints, context.failureShapes, context.convergence.
 */
export function renderGovernedRetryContext(
  goal: string,
  context: GovernContext,
  maxAttempts: number
): string {
  void goal; void context; void maxAttempts;
  throw new Error('NOT_IMPLEMENTED: render-governed deliverable 3');
}
