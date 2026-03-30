/**
 * K5 Gate — Constraint Enforcement
 * =================================
 *
 * Checks the plan against learned constraints from prior failures.
 * The constraint store remembers what failed before and blocks repetition.
 *
 * This is what makes the second attempt smarter than the first.
 */

import type { GateResult, GateContext, Edit, Predicate } from '../types.js';
import { ConstraintStore, classifyChangeType, predicateFingerprint } from '../store/constraint-store.js';

export interface ConstraintGateResult extends GateResult {
  violation?: {
    constraintId: string;
    signature: string;
    type: string;
    reason: string;
    banType: string;
  };
  constraintCount: number;
}

export function runConstraintGate(
  ctx: GateContext,
  store: ConstraintStore,
  overrideConstraints?: string[],
): ConstraintGateResult {
  const start = Date.now();

  const filesTouched = [...new Set(ctx.edits.map(e => e.file))];
  const changeType = classifyChangeType(filesTouched);
  const fingerprints = ctx.predicates.map(p => predicateFingerprint(p));

  const violation = store.checkConstraints(filesTouched, changeType, fingerprints);

  // Check if constraint is overridden
  if (violation && overrideConstraints?.includes(violation.constraintId)) {
    return {
      gate: 'K5',
      passed: true,
      detail: `Constraint ${violation.signature} overridden by caller`,
      durationMs: Date.now() - start,
      constraintCount: store.getConstraintCount(),
    };
  }

  if (violation) {
    return {
      gate: 'K5',
      passed: false,
      detail: `This approach already failed: ${violation.reason}`,
      durationMs: Date.now() - start,
      violation,
      constraintCount: store.getConstraintCount(),
    };
  }

  return {
    gate: 'K5',
    passed: true,
    detail: `${store.getConstraintCount()} active constraint(s), none violated`,
    durationMs: Date.now() - start,
    constraintCount: store.getConstraintCount(),
  };
}
