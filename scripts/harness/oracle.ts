/**
 * Oracle — Property-Based Invariant Checks
 * ==========================================
 *
 * Two layers:
 * - Product invariants: "Is verify correct?"
 * - Harness invariants: "Is the self-test harness correct?"
 *
 * Separating these prevents "verify is wrong" vs "harness is wrong" confusion.
 */

import type { VerifyResult } from '../../src/types.js';
import type { VerifyScenario, InvariantCheck, InvariantVerdict, OracleContext } from './types.js';

// =============================================================================
// UNIVERSAL PRODUCT INVARIANTS — checked on every scenario
// =============================================================================

const PRODUCT_INVARIANTS: InvariantCheck[] = [
  {
    name: 'result_well_formedness',
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: true, severity: 'info' }; // handled by harness invariant
      }
      if (typeof result.success !== 'boolean') {
        return { passed: false, violation: `success is ${typeof result.success}, not boolean`, severity: 'bug' };
      }
      if (!Array.isArray(result.gates) || result.gates.length === 0) {
        return { passed: false, violation: `gates is empty or not an array`, severity: 'bug' };
      }
      if (typeof result.attestation !== 'string' || result.attestation.length === 0) {
        return { passed: false, violation: `attestation is empty`, severity: 'bug' };
      }
      if (!result.timing || result.timing.totalMs <= 0) {
        return { passed: false, violation: `timing.totalMs is ${result.timing?.totalMs}`, severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  },
  {
    name: 'gate_success_consistency',
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };

      if (result.success) {
        const failedGates = result.gates.filter(g => !g.passed);
        if (failedGates.length > 0) {
          return {
            passed: false,
            violation: `success=true but gates failed: ${failedGates.map(g => g.gate).join(', ')}`,
            severity: 'bug',
          };
        }
      } else {
        const failedGates = result.gates.filter(g => !g.passed);
        if (failedGates.length === 0) {
          return {
            passed: false,
            violation: `success=false but no gates failed`,
            severity: 'bug',
          };
        }
      }
      return { passed: true, severity: 'info' };
    },
  },
  {
    name: 'constraint_monotonicity',
    category: 'k5',
    layer: 'product',
    check: (_scenario, result, context) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };

      if (context.constraintsAfter < context.constraintsBefore) {
        return {
          passed: false,
          violation: `Constraints decreased: ${context.constraintsBefore} → ${context.constraintsAfter}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  },
  {
    name: 'first_failing_gate_is_reported',
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (result.success) return { passed: true, severity: 'info' };

      // The attestation should mention the first failed gate
      const firstFailed = result.gates.find(g => !g.passed);
      if (firstFailed && !result.attestation.includes(firstFailed.gate)) {
        return {
          passed: false,
          violation: `First failed gate ${firstFailed.gate} not mentioned in attestation`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  },
  {
    name: 'gate_timing_sanity',
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };

      for (const gate of result.gates) {
        if (gate.durationMs > 300_000) { // 5 min
          return {
            passed: false,
            violation: `Gate ${gate.gate} took ${gate.durationMs}ms (>5min)`,
            severity: 'unexpected',
          };
        }
      }
      return { passed: true, severity: 'info' };
    },
  },
];

// =============================================================================
// UNIVERSAL HARNESS INVARIANTS — checked on every scenario
// =============================================================================

const HARNESS_INVARIANTS: InvariantCheck[] = [
  {
    name: 'no_crash',
    category: 'robustness',
    layer: 'harness',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return {
          passed: false,
          violation: `verify() threw: ${result.message}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  },
];

// =============================================================================
// FINGERPRINT INVARIANTS (Family A)
// =============================================================================

/**
 * Create invariant that checks two predicates produce different fingerprints.
 */
export function fingerprintDistinctness(
  nameA: string,
  nameB: string,
  getA: () => object,
  getB: () => object,
): InvariantCheck {
  return {
    name: `fingerprint_distinct_${nameA}_vs_${nameB}`,
    category: 'fingerprint',
    layer: 'product',
    check: () => {
      // Import dynamically to avoid circular deps
      const { predicateFingerprint } = require('../../src/store/constraint-store.js');
      const fpA = predicateFingerprint(getA());
      const fpB = predicateFingerprint(getB());
      if (fpA === fpB) {
        return {
          passed: false,
          violation: `Fingerprints collide: "${fpA}" for both ${nameA} and ${nameB}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Create invariant that checks fingerprint is deterministic (same input → same output).
 */
export function fingerprintDeterminism(name: string, getPredicate: () => object): InvariantCheck {
  return {
    name: `fingerprint_deterministic_${name}`,
    category: 'fingerprint',
    layer: 'product',
    check: () => {
      const { predicateFingerprint } = require('../../src/store/constraint-store.js');
      const pred = getPredicate();
      const fp1 = predicateFingerprint(pred);
      const fp2 = predicateFingerprint(pred);
      // Also test after JSON round-trip
      const fp3 = predicateFingerprint(JSON.parse(JSON.stringify(pred)));
      if (fp1 !== fp2 || fp1 !== fp3) {
        return {
          passed: false,
          violation: `Fingerprint not deterministic: "${fp1}" vs "${fp2}" vs "${fp3}" (round-trip)`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// K5 INVARIANTS (Family B)
// =============================================================================

export function k5ShouldBlock(description: string): InvariantCheck {
  return {
    name: `k5_should_block: ${description}`,
    category: 'k5',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      // K5 block means success=false and K5 gate failed
      const k5Gate = result.gates.find(g => g.gate === 'K5');
      if (!k5Gate || k5Gate.passed) {
        return {
          passed: false,
          violation: `Expected K5 to block but it passed`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

export function k5ShouldPass(description: string): InvariantCheck {
  return {
    name: `k5_should_pass: ${description}`,
    category: 'k5',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const k5Gate = result.gates.find(g => g.gate === 'K5');
      if (k5Gate && !k5Gate.passed) {
        return {
          passed: false,
          violation: `Expected K5 to pass but it blocked: ${k5Gate.detail}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// GATE SEQUENCING INVARIANTS (Family C)
// =============================================================================

/**
 * Assert gate A appears before gate B in results.
 */
export function gateOrderBefore(gateA: string, gateB: string): InvariantCheck {
  return {
    name: `gate_order_${gateA}_before_${gateB}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const names = result.gates.map(g => g.gate);
      const idxA = names.indexOf(gateA);
      const idxB = names.indexOf(gateB);
      if (idxA === -1 || idxB === -1) {
        return { passed: true, severity: 'info' }; // one or both absent — not this invariant's concern
      }
      if (idxA >= idxB) {
        return {
          passed: false,
          violation: `${gateA} (index ${idxA}) should appear before ${gateB} (index ${idxB})`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert gate X does NOT appear in results.
 */
export function gateAbsent(gate: string, reason: string): InvariantCheck {
  return {
    name: `gate_absent_${gate}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const names = result.gates.map(g => g.gate);
      if (names.includes(gate)) {
        return {
          passed: false,
          violation: `${gate} should be absent (${reason}) but is present`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert exact number of gates in result.
 */
export function gateCount(expected: number): InvariantCheck {
  return {
    name: `gate_count_${expected}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (result.gates.length !== expected) {
        return {
          passed: false,
          violation: `Expected ${expected} gates, got ${result.gates.length}: [${result.gates.map(g => g.gate).join(', ')}]`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert constraint count equals expected value after scenario.
 */
export function constraintCountEquals(expected: number): InvariantCheck {
  return {
    name: `constraint_count_equals_${expected}`,
    category: 'k5',
    layer: 'product',
    check: (_scenario, _result, context) => {
      if (context.constraintsAfter !== expected) {
        return {
          passed: false,
          violation: `Expected ${expected} constraints, got ${context.constraintsAfter}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert constraint count is at least N after scenario.
 */
export function constraintCountAtLeast(expected: number): InvariantCheck {
  return {
    name: `constraint_count_at_least_${expected}`,
    category: 'k5',
    layer: 'product',
    check: (_scenario, _result, context) => {
      if (context.constraintsAfter < expected) {
        return {
          passed: false,
          violation: `Expected at least ${expected} constraints, got ${context.constraintsAfter}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert every gate has durationMs > 0.
 */
export function gateTimingPositive(): InvariantCheck {
  return {
    name: 'gate_timing_positive',
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      for (const gate of result.gates) {
        if (gate.durationMs <= 0) {
          return {
            passed: false,
            violation: `Gate ${gate.gate} has durationMs=${gate.durationMs} (expected > 0)`,
            severity: 'unexpected',
          };
        }
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert every failed gate has a non-empty detail string.
 */
export function failedGateHasDetail(): InvariantCheck {
  return {
    name: 'failed_gate_has_detail',
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      for (const gate of result.gates) {
        if (!gate.passed && (!gate.detail || gate.detail.length === 0)) {
          return {
            passed: false,
            violation: `Failed gate ${gate.gate} has empty detail`,
            severity: 'bug',
          };
        }
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// CONTAINMENT INVARIANTS (Family D)
// =============================================================================

/**
 * Assert exact containment attribution counts.
 */
export function containmentCounts(
  expectedDirect: number,
  expectedScaffolding: number,
  expectedUnexplained: number,
): InvariantCheck {
  return {
    name: `containment_counts_${expectedDirect}d_${expectedScaffolding}s_${expectedUnexplained}u`,
    category: 'containment',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const g5 = result.gates.find(g => g.gate === 'G5') as any;
      if (!g5) return { passed: false, violation: 'G5 gate not found in result', severity: 'bug' };
      const s = g5.summary;
      if (!s) return { passed: false, violation: 'G5 gate has no summary', severity: 'bug' };

      if (s.direct !== expectedDirect || s.scaffolding !== expectedScaffolding || s.unexplained !== expectedUnexplained) {
        return {
          passed: false,
          violation: `Expected ${expectedDirect}d/${expectedScaffolding}s/${expectedUnexplained}u, got ${s.direct}d/${s.scaffolding}s/${s.unexplained}u`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert G5 gate always passes (advisory mode).
 */
export function containmentAlwaysPasses(): InvariantCheck {
  return {
    name: 'containment_advisory_always_passes',
    category: 'containment',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const g5 = result.gates.find(g => g.gate === 'G5');
      if (!g5) return { passed: true, severity: 'info' }; // gate might be disabled
      if (!g5.passed) {
        return {
          passed: false,
          violation: 'G5 gate failed — but it should be advisory (always pass)',
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert a specific edit was attributed as expected.
 */
export function editAttributed(editFile: string, expectedAttribution: 'direct' | 'scaffolding' | 'unexplained'): InvariantCheck {
  return {
    name: `edit_attributed_${editFile}_${expectedAttribution}`,
    category: 'containment',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const g5 = result.gates.find(g => g.gate === 'G5') as any;
      if (!g5?.attributions) return { passed: false, violation: 'G5 gate has no attributions', severity: 'bug' };

      const attr = g5.attributions.find((a: any) => a.file === editFile);
      if (!attr) {
        return { passed: false, violation: `No attribution found for ${editFile}`, severity: 'bug' };
      }
      if (attr.attribution !== expectedAttribution) {
        return {
          passed: false,
          violation: `${editFile} attributed as '${attr.attribution}', expected '${expectedAttribution}'`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert containment total matches edit count.
 */
export function containmentTotalMatchesEdits(): InvariantCheck {
  return {
    name: 'containment_total_matches_edits',
    category: 'containment',
    layer: 'product',
    check: (scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const g5 = result.gates.find(g => g.gate === 'G5') as any;
      if (!g5?.summary) return { passed: true, severity: 'info' };
      if (g5.summary.total !== scenario.edits.length) {
        return {
          passed: false,
          violation: `G5 attributed ${g5.summary.total} edits but scenario has ${scenario.edits.length}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// GROUNDING INVARIANTS (Family E)
// =============================================================================

/**
 * Assert a predicate was marked as grounding miss.
 */
export function predicateIsGroundingMiss(predicateIndex: number, description: string): InvariantCheck {
  return {
    name: `grounding_miss_${description}`,
    category: 'grounding',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const ep = result.effectivePredicates;
      if (!ep || predicateIndex >= ep.length) {
        return { passed: false, violation: `Predicate index ${predicateIndex} out of range (${ep?.length ?? 0})`, severity: 'bug' };
      }
      if (!ep[predicateIndex].groundingMiss) {
        return {
          passed: false,
          violation: `Predicate ${predicateIndex} should be groundingMiss but is not`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert a predicate was NOT marked as grounding miss (real selector found).
 */
export function predicateIsGrounded(predicateIndex: number, description: string): InvariantCheck {
  return {
    name: `grounding_found_${description}`,
    category: 'grounding',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const ep = result.effectivePredicates;
      if (!ep || predicateIndex >= ep.length) {
        return { passed: false, violation: `Predicate index ${predicateIndex} out of range (${ep?.length ?? 0})`, severity: 'bug' };
      }
      if (ep[predicateIndex].groundingMiss) {
        return {
          passed: false,
          violation: `Predicate ${predicateIndex} should be grounded but has groundingMiss=true`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert the grounding context discovered expected routes.
 * (Checks via the effectivePredicates — if they have fingerprints, grounding ran.)
 */
export function groundingRan(): InvariantCheck {
  return {
    name: 'grounding_ran',
    category: 'grounding',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (!result.effectivePredicates || result.effectivePredicates.length === 0) {
        return { passed: true, severity: 'info' }; // no predicates → grounding irrelevant
      }
      // Every effective predicate should have a fingerprint (proof grounding pipeline ran)
      for (const ep of result.effectivePredicates) {
        if (!ep.fingerprint) {
          return {
            passed: false,
            violation: `Predicate ${ep.id} has no fingerprint — grounding may not have run`,
            severity: 'bug',
          };
        }
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// FULL PIPELINE INVARIANTS (Family F)
// =============================================================================

/**
 * Assert verify() succeeded (all gates passed).
 */
export function verifySucceeded(description: string): InvariantCheck {
  return {
    name: `verify_succeeded: ${description}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `verify() threw: ${result.message}`, severity: 'bug' };
      }
      if (!result.success) {
        const failed = result.gates.find(g => !g.passed);
        return {
          passed: false,
          violation: `Expected success but failed at ${failed?.gate}: ${failed?.detail}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert verify() failed at a specific gate.
 */
export function verifyFailedAt(gate: string, description: string): InvariantCheck {
  return {
    name: `verify_failed_at_${gate}: ${description}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (result.success) {
        return { passed: false, violation: `Expected failure at ${gate} but verify succeeded`, severity: 'bug' };
      }
      const failedGate = result.gates.find(g => !g.passed);
      if (!failedGate || failedGate.gate !== gate) {
        return {
          passed: false,
          violation: `Expected failure at ${gate} but failed at ${failedGate?.gate ?? 'unknown'}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert narrowing was returned on failure (learning signal).
 */
export function narrowingPresent(): InvariantCheck {
  return {
    name: 'narrowing_present_on_failure',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (result.success) return { passed: true, severity: 'info' }; // success has no narrowing
      if (!result.narrowing) {
        return { passed: false, violation: 'Failure result has no narrowing injection', severity: 'bug' };
      }
      if (!result.narrowing.resolutionHint) {
        return { passed: false, violation: 'Narrowing has no resolutionHint', severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert constraint was seeded from failure (K5 learning).
 */
export function constraintSeededOnFailure(): InvariantCheck {
  return {
    name: 'constraint_seeded_on_failure',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result, context) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (result.success) return { passed: true, severity: 'info' };
      if (context.constraintsAfter <= context.constraintsBefore) {
        return {
          passed: false,
          violation: `Expected constraint seeding but count unchanged: ${context.constraintsBefore} → ${context.constraintsAfter}`,
          severity: 'unexpected',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// EDGE CASE INVARIANTS (Family G)
// =============================================================================

export function shouldNotCrash(description: string): InvariantCheck {
  return {
    name: `should_not_crash: ${description}`,
    category: 'robustness',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return {
          passed: false,
          violation: `Crashed: ${result.message}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export const UNIVERSAL_INVARIANTS: InvariantCheck[] = [
  ...PRODUCT_INVARIANTS,
  ...HARNESS_INVARIANTS,
];

/**
 * Run all invariants (universal + scenario-specific) against a result.
 */
export function checkInvariants(
  scenario: VerifyScenario,
  result: VerifyResult | Error,
  context: OracleContext,
): Array<{ name: string; category: string; layer: string; passed: boolean; violation?: string; severity: string }> {
  const allInvariants = [...UNIVERSAL_INVARIANTS, ...scenario.invariants];
  return allInvariants.map(inv => {
    try {
      const verdict = inv.check(scenario, result, context);
      return {
        name: inv.name,
        category: inv.category,
        layer: inv.layer,
        passed: verdict.passed,
        violation: verdict.violation,
        severity: verdict.passed ? 'info' : verdict.severity,
      };
    } catch (err: any) {
      return {
        name: inv.name,
        category: inv.category,
        layer: inv.layer,
        passed: false,
        violation: `Invariant check itself crashed: ${err.message}`,
        severity: 'bug',
      };
    }
  });
}
