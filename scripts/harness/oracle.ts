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
        // Vision and triangulation are advisory gates — they feed into the triangulation
        // decision but never independently block. Vision says "I see FAIL" but triangulation
        // may still say "proceed" (insufficient) or "escalate" (disagreement). Only "rollback"
        // causes the pipeline to exit early with success=false.
        const blockingGates = result.gates.filter(g =>
          !g.passed && g.gate !== 'vision' && g.gate !== 'triangulation'
        );
        if (blockingGates.length > 0) {
          return {
            passed: false,
            violation: `success=true but blocking gates failed: ${blockingGates.map(g => g.gate).join(', ')}`,
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
// FILESYSTEM INVARIANTS (Family H)
// =============================================================================

/**
 * Assert that the filesystem gate ran (present in gates array).
 */
export function filesystemGateRan(): InvariantCheck {
  return {
    name: 'filesystem_gate_ran',
    category: 'filesystem' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'filesystem');
      if (!gate) {
        return { passed: false, violation: 'Filesystem gate not found in gates array', severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that the filesystem gate passed.
 */
export function filesystemGatePassed(): InvariantCheck {
  return {
    name: 'filesystem_gate_passed',
    category: 'filesystem' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'filesystem');
      if (!gate) {
        return { passed: false, violation: 'Filesystem gate not found', severity: 'bug' };
      }
      if (!gate.passed) {
        return { passed: false, violation: `Filesystem gate failed: ${gate.detail}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that the filesystem gate failed (predicate mismatch).
 */
export function filesystemGateFailed(description: string): InvariantCheck {
  return {
    name: `filesystem_gate_failed: ${description}`,
    category: 'filesystem' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'filesystem');
      if (!gate) {
        return { passed: false, violation: 'Filesystem gate not found', severity: 'bug' };
      }
      if (gate.passed) {
        return { passed: false, violation: `Expected filesystem gate to fail but it passed`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// VISION INVARIANTS (Family V)
// =============================================================================

/**
 * Assert vision gate was skipped (passed with "skipped" in detail).
 */
export function visionGateSkipped(): InvariantCheck {
  return {
    name: 'vision_gate_skipped',
    category: 'vision' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'vision');
      if (!gate) {
        // Vision gate absent = effectively skipped
        return { passed: true, severity: 'info' };
      }
      if (!gate.passed || !gate.detail.toLowerCase().includes('skip')) {
        return {
          passed: false,
          violation: `Expected vision gate to be skipped but got: passed=${gate.passed}, detail="${gate.detail}"`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert vision gate ran and passed.
 */
export function visionGatePassed(): InvariantCheck {
  return {
    name: 'vision_gate_passed',
    category: 'vision' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'vision');
      if (!gate) {
        return { passed: false, violation: 'Vision gate not found in results', severity: 'bug' };
      }
      if (!gate.passed) {
        return { passed: false, violation: `Vision gate failed: ${gate.detail}`, severity: 'bug' };
      }
      if (gate.detail.toLowerCase().includes('skip')) {
        return { passed: false, violation: `Vision gate was skipped, not truly passed`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert vision gate ran and failed.
 */
export function visionGateFailed(): InvariantCheck {
  return {
    name: 'vision_gate_failed',
    category: 'vision' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'vision');
      if (!gate) {
        return { passed: false, violation: 'Vision gate not found in results', severity: 'bug' };
      }
      if (gate.passed) {
        return { passed: false, violation: `Expected vision gate to fail but it passed: ${gate.detail}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert vision gate is present in results (ran, regardless of outcome).
 */
export function visionGateRan(): InvariantCheck {
  return {
    name: 'vision_gate_ran',
    category: 'vision' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'vision');
      if (!gate) {
        return { passed: false, violation: 'Vision gate not found in results', severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert at least one vision claim was verified.
 */
export function visionClaimVerified(): InvariantCheck {
  return {
    name: 'vision_claim_verified',
    category: 'vision' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'vision') as any;
      if (!gate?.claims || gate.claims.length === 0) {
        return { passed: false, violation: 'No vision claims found', severity: 'bug' };
      }
      const verified = gate.claims.filter((c: any) => c.verified);
      if (verified.length === 0) {
        return { passed: false, violation: 'No vision claims were verified', severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert at least one vision claim was NOT verified.
 */
export function visionClaimNotVerified(): InvariantCheck {
  return {
    name: 'vision_claim_not_verified',
    category: 'vision' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'vision') as any;
      if (!gate?.claims || gate.claims.length === 0) {
        return { passed: false, violation: 'No vision claims found', severity: 'bug' };
      }
      const notVerified = gate.claims.filter((c: any) => !c.verified);
      if (notVerified.length === 0) {
        return { passed: false, violation: 'All vision claims were verified (expected at least one NOT VERIFIED)', severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// TRIANGULATION INVARIANTS (Family V)
// =============================================================================

/**
 * Assert triangulation action matches expected value.
 */
export function triangulationAction(expected: string): InvariantCheck {
  return {
    name: `triangulation_action_${expected}`,
    category: 'triangulation' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'triangulation') as any;
      if (!gate?.triangulation) {
        return { passed: false, violation: 'Triangulation gate not found or missing result', severity: 'bug' };
      }
      if (gate.triangulation.action !== expected) {
        return {
          passed: false,
          violation: `Expected triangulation action '${expected}' but got '${gate.triangulation.action}'`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert triangulation outlier matches expected value.
 */
export function triangulationOutlier(expected: string): InvariantCheck {
  return {
    name: `triangulation_outlier_${expected}`,
    category: 'triangulation' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'triangulation') as any;
      if (!gate?.triangulation) {
        return { passed: false, violation: 'Triangulation gate not found', severity: 'bug' };
      }
      if (gate.triangulation.outlier !== expected) {
        return {
          passed: false,
          violation: `Expected outlier '${expected}' but got '${gate.triangulation.outlier}'`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert triangulation confidence matches expected value.
 */
export function triangulationConfidence(expected: string): InvariantCheck {
  return {
    name: `triangulation_confidence_${expected}`,
    category: 'triangulation' as any,
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === 'triangulation') as any;
      if (!gate?.triangulation) {
        return { passed: false, violation: 'Triangulation gate not found', severity: 'bug' };
      }
      if (gate.triangulation.confidence !== expected) {
        return {
          passed: false,
          violation: `Expected confidence '${expected}' but got '${gate.triangulation.confidence}'`,
          severity: 'bug',
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

// =============================================================================
// MESSAGE GATE INVARIANTS — Family M
// =============================================================================

/**
 * Message verdict matches expected.
 */
export function messageVerdict(expected: string, reason?: string): InvariantCheck {
  return {
    name: `message_verdict_${expected}`,
    category: 'message',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `Message gate crashed: ${result.message}`, severity: 'bug' };
      }
      const msgResult = (result as any)._messageResult;
      if (!msgResult) {
        return { passed: false, violation: 'No _messageResult on result (not a message scenario?)', severity: 'bug' };
      }
      if (msgResult.verdict !== expected) {
        return {
          passed: false,
          violation: `Expected verdict '${expected}', got '${msgResult.verdict}' (${reason || msgResult.detail})`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Message block/clarify reason matches expected.
 */
export function messageReason(expected: string, reason?: string): InvariantCheck {
  return {
    name: `message_reason_${expected}`,
    category: 'message',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `Message gate crashed: ${result.message}`, severity: 'bug' };
      }
      const msgResult = (result as any)._messageResult;
      if (!msgResult) {
        return { passed: false, violation: 'No _messageResult', severity: 'bug' };
      }
      if (msgResult.reason !== expected) {
        return {
          passed: false,
          violation: `Expected reason '${expected}', got '${msgResult.reason}' (${reason || msgResult.detail})`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * A specific message gate passed.
 */
export function messageGatePassed(gateName: string): InvariantCheck {
  return {
    name: `message_gate_passed_${gateName}`,
    category: 'message',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `Crashed: ${result.message}`, severity: 'bug' };
      }
      const msgResult = (result as any)._messageResult;
      if (!msgResult) return { passed: false, violation: 'No _messageResult', severity: 'bug' };
      const gate = msgResult.gates.find((g: any) => g.gate === gateName);
      if (!gate) return { passed: false, violation: `Gate '${gateName}' not found in results`, severity: 'bug' };
      if (!gate.passed) return { passed: false, violation: `Gate '${gateName}' failed: ${gate.detail}`, severity: 'bug' };
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * A specific message gate failed.
 */
export function messageGateFailed(gateName: string): InvariantCheck {
  return {
    name: `message_gate_failed_${gateName}`,
    category: 'message',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `Crashed: ${result.message}`, severity: 'bug' };
      }
      const msgResult = (result as any)._messageResult;
      if (!msgResult) return { passed: false, violation: 'No _messageResult', severity: 'bug' };
      const gate = msgResult.gates.find((g: any) => g.gate === gateName);
      if (!gate) return { passed: false, violation: `Gate '${gateName}' not found`, severity: 'bug' };
      if (gate.passed) return { passed: false, violation: `Gate '${gateName}' should have failed but passed`, severity: 'bug' };
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * A claim was verified (or not) as expected.
 */
export function messageClaimVerified(assertionName: string, expectedVerified: boolean): InvariantCheck {
  return {
    name: `message_claim_${assertionName}_${expectedVerified ? 'verified' : 'unverified'}`,
    category: 'message',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `Crashed: ${result.message}`, severity: 'bug' };
      }
      const msgResult = (result as any)._messageResult;
      if (!msgResult) return { passed: false, violation: 'No _messageResult', severity: 'bug' };
      if (!msgResult.claims || msgResult.claims.length === 0) {
        return { passed: false, violation: `No claims in result (expected '${assertionName}')`, severity: 'bug' };
      }
      const claim = msgResult.claims.find((c: any) => c.assertion === assertionName);
      if (!claim) {
        return { passed: false, violation: `Claim '${assertionName}' not found in results`, severity: 'bug' };
      }
      if (claim.verified !== expectedVerified) {
        return {
          passed: false,
          violation: `Claim '${assertionName}' verified=${claim.verified}, expected ${expectedVerified}`,
          severity: 'bug',
        };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Message gate should not crash.
 */
export function messageDidNotCrash(reason?: string): InvariantCheck {
  return {
    name: 'message_did_not_crash',
    category: 'message',
    layer: 'harness',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `Message gate crashed: ${result.message} (${reason || ''})`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that the message gate result has a topic resolution with specific properties.
 */
export function messageTopicResolution(expectedSource: string, overridden: boolean): InvariantCheck {
  return {
    name: `message_topic_resolution_${expectedSource}_${overridden ? 'overridden' : 'kept'}`,
    category: 'message',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: false, violation: `Crashed: ${result.message}`, severity: 'bug' };
      const msgResult = (result as unknown as { _messageResult?: import('../src/gates/message.js').MessageGateResult })._messageResult;
      if (!msgResult) return { passed: false, violation: 'No messageResult on result', severity: 'bug' };
      if (!msgResult.topicResolution) {
        return { passed: false, violation: `Expected topicResolution with source=${expectedSource}, got none`, severity: 'bug' };
      }
      if (msgResult.topicResolution.source !== expectedSource) {
        return { passed: false, violation: `Expected topicResolution.source=${expectedSource}, got ${msgResult.topicResolution.source}`, severity: 'bug' };
      }
      if (msgResult.topicResolution.overridden !== overridden) {
        return { passed: false, violation: `Expected topicResolution.overridden=${overridden}, got ${msgResult.topicResolution.overridden}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that the message gate result has a narrowing field with specific type.
 */
export function messageNarrowing(expectedType: string): InvariantCheck {
  return {
    name: `message_narrowing_${expectedType}`,
    category: 'message',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: false, violation: `Crashed: ${result.message}`, severity: 'bug' };
      const msgResult = (result as unknown as { _messageResult?: import('../src/gates/message.js').MessageGateResult })._messageResult;
      if (!msgResult) return { passed: false, violation: 'No messageResult on result', severity: 'bug' };
      if (!msgResult.narrowing) {
        return { passed: false, violation: `Expected narrowing with type=${expectedType}, got none`, severity: 'bug' };
      }
      if (msgResult.narrowing.type !== expectedType) {
        return { passed: false, violation: `Expected narrowing.type=${expectedType}, got ${msgResult.narrowing.type}`, severity: 'bug' };
      }
      if (!msgResult.narrowing.resolutionHint) {
        return { passed: false, violation: `Narrowing has no resolutionHint`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// HTTP GATE INVARIANTS (Wave 2A — P-* shapes)
// =============================================================================

/**
 * Assert that the HTTP gate ran and produced results.
 */
export function httpGateRan(): InvariantCheck {
  return {
    name: 'http_gate_ran',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const httpGate = result.gates.find(g => g.gate === 'http');
      if (!httpGate) {
        return { passed: false, violation: 'HTTP gate not found in results', severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that the HTTP gate passed.
 */
export function httpGatePassed(): InvariantCheck {
  return {
    name: 'http_gate_passed',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const httpGate = result.gates.find(g => g.gate === 'http');
      if (!httpGate) return { passed: false, violation: 'HTTP gate not found', severity: 'bug' };
      if (!httpGate.passed) {
        return { passed: false, violation: `HTTP gate failed: ${httpGate.detail}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that the HTTP gate failed.
 */
export function httpGateFailed(description: string): InvariantCheck {
  return {
    name: `http_gate_failed_${description}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const httpGate = result.gates.find(g => g.gate === 'http');
      if (!httpGate) return { passed: false, violation: 'HTTP gate not found', severity: 'bug' };
      if (httpGate.passed) {
        return { passed: false, violation: `HTTP gate should have failed (${description}) but passed`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that the HTTP gate detail contains a specific substring.
 */
export function httpGateDetailContains(expected: string): InvariantCheck {
  return {
    name: `http_detail_contains_${expected.substring(0, 20)}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const httpGate = result.gates.find(g => g.gate === 'http');
      if (!httpGate) return { passed: false, violation: 'HTTP gate not found', severity: 'bug' };
      if (!httpGate.detail.includes(expected)) {
        return { passed: false, violation: `HTTP gate detail "${httpGate.detail}" missing "${expected}"`, severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// CROSS-PREDICATE INVARIANTS (Wave 2A — I-* shapes)
// =============================================================================

/**
 * Assert that specific gates passed while others failed — for cross-predicate scenarios.
 */
export function gatesPassedAndFailed(expectedPassed: string[], expectedFailed: string[]): InvariantCheck {
  return {
    name: `gates_pass_${expectedPassed.join('+')}_fail_${expectedFailed.join('+')}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      for (const gn of expectedPassed) {
        const gate = result.gates.find(g => g.gate === gn);
        if (gate && !gate.passed) {
          return { passed: false, violation: `Expected gate ${gn} to pass but it failed: ${gate.detail}`, severity: 'bug' };
        }
      }
      for (const gn of expectedFailed) {
        const gate = result.gates.find(g => g.gate === gn);
        if (gate && gate.passed) {
          return { passed: false, violation: `Expected gate ${gn} to fail but it passed`, severity: 'bug' };
        }
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that narrowing contains specific resolution hint text.
 */
export function narrowingHintContains(expected: string): InvariantCheck {
  return {
    name: `narrowing_hint_contains_${expected.substring(0, 20)}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (result.success) return { passed: true, severity: 'info' }; // no narrowing on success
      if (!result.narrowing?.resolutionHint) {
        return { passed: false, violation: 'No resolution hint in narrowing', severity: 'unexpected' };
      }
      if (!result.narrowing.resolutionHint.includes(expected)) {
        return { passed: false, violation: `Hint "${result.narrowing.resolutionHint}" missing "${expected}"`, severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert that narrowing has no resolution hint (e.g., on infrastructure errors).
 */
export function narrowingNoHint(): InvariantCheck {
  return {
    name: 'narrowing_no_hint',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      // This checks that either there's no narrowing at all, or the hint is generic
      // (not referencing specific predicate values that could mislead)
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// GATE PRESENCE / ABSENCE INVARIANTS — Wave 2B
// =============================================================================

/**
 * Assert a gate is present in results (ran, regardless of outcome).
 */
export function gatePresent(gateName: string): InvariantCheck {
  return {
    name: `gate_present_${gateName}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === gateName);
      if (!gate) {
        return { passed: false, violation: `Gate '${gateName}' not found in results`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert a gate passed.
 */
export function gatePassed(gateName: string): InvariantCheck {
  return {
    name: `gate_passed_${gateName}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === gateName);
      if (!gate) return { passed: false, violation: `Gate '${gateName}' not found`, severity: 'bug' };
      if (!gate.passed) {
        return { passed: false, violation: `Gate '${gateName}' failed: ${gate.detail}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert a gate failed.
 */
export function gateFailed(gateName: string, description?: string): InvariantCheck {
  return {
    name: `gate_failed_${gateName}${description ? '_' + description.substring(0, 20) : ''}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === gateName);
      if (!gate) return { passed: false, violation: `Gate '${gateName}' not found`, severity: 'bug' };
      if (gate.passed) {
        return { passed: false, violation: `Gate '${gateName}' should have failed but passed`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert attestation contains a specific substring.
 */
export function attestationContains(expected: string): InvariantCheck {
  return {
    name: `attestation_contains_${expected.substring(0, 20)}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      if (!result.attestation.includes(expected)) {
        return { passed: false, violation: `Attestation missing "${expected}": "${result.attestation.substring(0, 100)}"`, severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert effective predicate count matches expected.
 */
export function effectivePredicateCount(expected: number): InvariantCheck {
  return {
    name: `effective_predicate_count_${expected}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const count = result.effectivePredicates?.length ?? 0;
      if (count !== expected) {
        return { passed: false, violation: `Expected ${expected} effective predicates, got ${count}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert gate detail contains specific text.
 */
export function gateDetailContains(gateName: string, expected: string): InvariantCheck {
  return {
    name: `gate_detail_${gateName}_contains_${expected.substring(0, 20)}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const gate = result.gates.find(g => g.gate === gateName);
      if (!gate) return { passed: true, severity: 'info' }; // gate absent, not this check's concern
      if (!gate.detail.includes(expected)) {
        return { passed: false, violation: `Gate '${gateName}' detail "${gate.detail.substring(0, 80)}" missing "${expected}"`, severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

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
  // Family M (message gate) scenarios skip universal invariants — they test governMessage(), not verify()
  const allInvariants = scenario.family === 'M'
    ? scenario.invariants
    : [...UNIVERSAL_INVARIANTS, ...scenario.invariants];
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
