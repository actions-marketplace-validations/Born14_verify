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
 * Invariant (§4 "only difference between loops is the context renderer"):
 * the raw and governed renderers SHARE the formatGateFailures() helper
 * from render-raw.ts for the gate-failures block. The governed renderer
 * adds sections AFTER that block without modifying its bytes.
 *
 * This enforces "if the hint stinks, it's not narrowing crap": any
 * convergence lift the governed loop earns must come from the
 * NARROWING / CONSTRAINTS / FAILURE SHAPES / CONVERGENCE sections,
 * not from reformatting the block both loops share.
 *
 * Invariant: pure function. No Date.now, no Math.random, no env reads.
 */

import type { GovernContext } from '../../../src/govern.js';
import type { Narrowing, VerifyResult } from '../../../src/types.js';
import { formatGateFailures } from './render-raw.js';

/**
 * Render the NARROWING block per §4 line 170-176.
 *
 * Fields (presence-conditional — each rendered on its own line):
 *   - narrowing.resolutionHint → `HINT: {resolutionHint}`
 *   - narrowing.fileEvidence   → `EVIDENCE: {fileEvidence}`
 *   - narrowing.patternRecall (non-empty) → `PRIOR SUCCESSFUL PATTERNS: a; b; c`
 *   - narrowing.nextMoves (non-empty) → `SUGGESTED NEXT MOVES:` + indented lines
 *   - narrowing.bannedFingerprints (non-empty) → `AVOID: these predicate patterns have failed before: x, y, z`
 *     (first 5 only per §4)
 *
 * If narrowing is undefined OR all fields are empty/absent:
 *   → `(no narrowing produced for this failure)`
 *
 * Exported so the byte-exactness tests can exercise it directly.
 */
export function formatNarrowing(narrowing: Narrowing | undefined): string {
  if (!narrowing) {
    return '(no narrowing produced for this failure)';
  }

  const lines: string[] = [];

  if (narrowing.resolutionHint) {
    lines.push(`HINT: ${narrowing.resolutionHint}`);
  }

  if (narrowing.fileEvidence) {
    lines.push(`EVIDENCE: ${narrowing.fileEvidence}`);
  }

  if (narrowing.patternRecall && narrowing.patternRecall.length > 0) {
    lines.push(`PRIOR SUCCESSFUL PATTERNS: ${narrowing.patternRecall.join('; ')}`);
  }

  if (narrowing.nextMoves && narrowing.nextMoves.length > 0) {
    lines.push('SUGGESTED NEXT MOVES:');
    for (const move of narrowing.nextMoves) {
      lines.push(`  - ${move.kind} (score ${move.score}): ${move.rationale}`);
    }
  }

  if (narrowing.bannedFingerprints && narrowing.bannedFingerprints.length > 0) {
    const first5 = narrowing.bannedFingerprints.slice(0, 5);
    lines.push(`AVOID: these predicate patterns have failed before: ${first5.join(', ')}`);
  }

  if (lines.length === 0) {
    return '(no narrowing produced for this failure)';
  }

  return lines.join('\n');
}

/**
 * Render the CONSTRAINTS block per §4 line 177-178.
 *
 * One line per constraint: `- [{constraint.type}] {constraint.reason}`
 * Empty → `(none)`.
 */
export function formatConstraints(
  constraints: GovernContext['constraints']
): string {
  if (!constraints || constraints.length === 0) {
    return '(none)';
  }
  return constraints.map((c) => `- [${c.type}] ${c.reason}`).join('\n');
}

/**
 * Render the FAILURE SHAPES block per §4 line 179.
 *
 * One line per shape: `- {shape_id}`. Empty → `(none)`.
 */
export function formatFailureShapes(shapes: string[] | undefined): string {
  if (!shapes || shapes.length === 0) {
    return '(none)';
  }
  return shapes.map((s) => `- ${s}`).join('\n');
}

/**
 * Render the CONVERGENCE PROGRESS block per §4 line 180.
 *
 * `context.convergence?.progressSummary ?? 'first attempt — no convergence history'`
 */
export function formatConvergenceSummary(
  convergence: GovernContext['convergence']
): string {
  return convergence?.progressSummary ?? 'first attempt — no convergence history';
}

/**
 * Render the governed-loop retry context per DESIGN.md §4 (as amended
 * by Amendment 6).
 *
 * On attempt 1 OR when context.priorResult is undefined, the output is
 * `{appManifest}GOAL: {goal}` — byte-identical to the raw renderer's
 * attempt-1 output per the §4 "Attempt-1 shape (explicit under
 * Amendment 6)" specification.
 *
 * On attempt N ≥ 2, the manifest is prepended to the full §4 template
 * with all five content blocks (gate failures, narrowing, constraints,
 * failure shapes, convergence summary).
 *
 * Amendment 6: the appManifest parameter is required and is the same
 * pre-formatted string passed to renderRawRetryContext. This is the
 * byte-identity guarantee from Change 4 — both renderers receive the
 * same manifest string and prepend it identically.
 */
export function renderGovernedRetryContext(
  goal: string,
  context: GovernContext,
  maxAttempts: number,
  appManifest: string
): string {
  // First-attempt shape: identical bytes to the raw renderer's attempt-1
  // output so both loops share a fair starting point.
  if (context.attempt === 1 || context.priorResult === undefined) {
    return `${appManifest}GOAL: ${goal}`;
  }

  // Attempt N ≥ 2: manifest + §4 verbatim template.
  const priorResult: VerifyResult = context.priorResult;
  const gateFailures = formatGateFailures(priorResult);
  const narrowing = formatNarrowing(context.narrowing);
  const constraintCount = context.constraints?.length ?? 0;
  const constraints = formatConstraints(context.constraints ?? []);
  const failureShapes = formatFailureShapes(context.failureShapes);
  const convergenceSummary = formatConvergenceSummary(context.convergence);

  const body = [
    `GOAL: ${goal}`,
    '',
    `ATTEMPT ${context.attempt} of ${maxAttempts}.`,
    '',
    'Your previous attempt failed. Here are the raw gate failure messages:',
    '',
    gateFailures,
    '',
    'NARROWING (guidance from the verification system):',
    '',
    narrowing,
    '',
    `CONSTRAINTS currently active (${constraintCount} total):`,
    '',
    constraints,
    '',
    'FAILURE SHAPES observed across attempts:',
    '',
    failureShapes,
    '',
    'CONVERGENCE PROGRESS:',
    '',
    convergenceSummary,
    '',
    'Revise your edits and try again.',
  ].join('\n');

  return `${appManifest}${body}`;
}
