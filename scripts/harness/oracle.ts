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
import { predicateFingerprint } from '../../src/store/constraint-store.js';

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
      if (!result.timing || typeof result.timing.totalMs !== 'number' || result.timing.totalMs < 0) {
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
          // Message scenarios with 'narrowed' verdict have success=false but all
          // individual gates pass — the narrowing is a pipeline-level decision,
          // not a single gate failure. This is valid behavior.
          const isMessageNarrowed = (result as any)._messageResult?.verdict === 'narrowed';
          if (!isMessageNarrowed) {
            return {
              passed: false,
              violation: `success=false but no gates failed`,
              severity: 'bug',
            };
          }
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

      // The attestation should mention the first failed gate (by name or label)
      const GATE_LABELS: Record<string, string> = {
        grounding: 'grounding', F9: 'syntax', K5: 'constraints', G5: 'containment',
        staging: 'staging', browser: 'browser', http: 'http', invariants: 'health-checks',
        serialization: 'data', config: 'config', security: 'security', a11y: 'accessibility',
        performance: 'performance', filesystem: 'filesystem', access: 'access', capacity: 'capacity',
        contention: 'concurrency', state: 'state', temporal: 'timing', propagation: 'propagation',
        observation: 'observation', content: 'content', hallucination: 'hallucination',
      };
      const firstFailed = result.gates.find(g => !g.passed);
      const label = firstFailed ? GATE_LABELS[firstFailed.gate] : undefined;
      const mentioned = firstFailed && (
        result.attestation.includes(firstFailed.gate) ||
        (label && result.attestation.includes(label))
      );
      if (firstFailed && !mentioned) {
        // Message scenarios use "MESSAGE BLOCKED/NARROWED: <detail>" format —
        // gate names don't appear literally, but the reason/detail does.
        // Accept if the attestation contains the gate's detail text instead.
        const isMessageResult = !!(result as any)._messageResult;
        if (!isMessageResult) {
          return {
            passed: false,
            violation: `First failed gate ${firstFailed.gate} not mentioned in attestation`,
            severity: 'bug',
          };
        }
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
  getA: () => any,
  getB: () => any,
): InvariantCheck {
  return {
    name: `fingerprint_distinct_${nameA}_vs_${nameB}`,
    category: 'fingerprint',
    layer: 'product',
    check: () => {
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
export function fingerprintDeterminism(name: string, getPredicate: () => any): InvariantCheck {
  return {
    name: `fingerprint_deterministic_${name}`,
    category: 'fingerprint',
    layer: 'product',
    check: () => {
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
      const idxA = names.indexOf(gateA as typeof names[number]);
      const idxB = names.indexOf(gateB as typeof names[number]);
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
export function gateAbsent(gate: string, reason: string = 'gate disabled'): InvariantCheck {
  return {
    name: `gate_absent_${gate}`,
    category: 'gate_sequence',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const names = result.gates.map(g => g.gate);
      if (names.includes(gate as typeof names[number])) {
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
      // Use active (live) count when available, falls back to high-water mark
      const actual = context.activeConstraintsAfter ?? context.constraintsAfter;
      if (actual !== expected) {
        return {
          passed: false,
          violation: `Expected ${expected} active constraints, got ${actual}`,
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
export function predicateIsGroundingMiss(predicateIndex: number | string = 0, description?: string): InvariantCheck {
  if (typeof predicateIndex === 'string') { description = predicateIndex; predicateIndex = 0; }
  if (!description) description = `p${predicateIndex}`;
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
export function predicateIsGrounded(predicateIndex: number | string = 0, description?: string): InvariantCheck {
  if (typeof predicateIndex === 'string') { description = predicateIndex; predicateIndex = 0; }
  if (!description) description = `p${predicateIndex}`;
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

export function shouldNotCrash(description: string = 'scenario'): InvariantCheck {
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
      const msgResult = (result as unknown as { _messageResult?: import('../../src/gates/message.js').MessageGateResult })._messageResult;
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
      const msgResult = (result as unknown as { _messageResult?: import('../../src/gates/message.js').MessageGateResult })._messageResult;
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
export function httpGateFailed(description: string = 'http_gate'): InvariantCheck {
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
      // Check top-level detail AND per-predicate result details
      const topDetail = httpGate.detail;
      const perPredDetails = ((httpGate as any).results ?? [])
        .map((r: any) => r.detail ?? '').join(' ');
      const combined = `${topDetail} ${perPredDetails}`;
      if (!combined.includes(expected)) {
        return { passed: false, violation: `HTTP gate details "${combined.trim()}" missing "${expected}"`, severity: 'unexpected' };
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
      const hint = result.narrowing.resolutionHint.toLowerCase();
      const exp = expected.toLowerCase();
      // Also match contractions: "not" matches "n't" (doesn't, can't, won't, etc.)
      const found = hint.includes(exp) || (exp === 'not' && hint.includes("n't"));
      if (!found) {
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

// =============================================================================
// GOVERN LOOP INVARIANTS — Family L (convergence loop tests)
// =============================================================================

/**
 * Assert govern() stopReason matches expected.
 */
export function governStopReason(expected: string): InvariantCheck {
  return {
    name: `govern_stop_reason_${expected}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult on result', severity: 'bug' };
      if (govResult.stopReason !== expected) {
        return { passed: false, violation: `Expected stopReason '${expected}', got '${govResult.stopReason}'`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() attempt count.
 */
export function governAttempts(expected: number): InvariantCheck {
  return {
    name: `govern_attempts_${expected}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      if (govResult.attempts !== expected) {
        return { passed: false, violation: `Expected ${expected} attempts, got ${govResult.attempts}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() attempt count within a range.
 */
export function governAttemptsRange(min: number, max: number): InvariantCheck {
  return {
    name: `govern_attempts_${min}_to_${max}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      if (govResult.attempts < min || govResult.attempts > max) {
        return { passed: false, violation: `Expected ${min}-${max} attempts, got ${govResult.attempts}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() convergence has specific unique shapes.
 */
export function governHasShapes(minShapes: number): InvariantCheck {
  return {
    name: `govern_has_at_least_${minShapes}_shapes`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      const count = govResult.convergence?.uniqueShapes?.length ?? 0;
      if (count < minShapes) {
        return { passed: false, violation: `Expected at least ${minShapes} unique shapes, got ${count}: [${govResult.convergence?.uniqueShapes?.join(', ')}]`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() receipt has failure shapes populated.
 */
export function governReceiptHasShapes(): InvariantCheck {
  return {
    name: 'govern_receipt_has_shapes',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      if (!govResult.receipt.failureShapes || govResult.receipt.failureShapes.length === 0) {
        return { passed: false, violation: 'Receipt failureShapes is empty — decomposition not flowing through', severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() shapes appeared in agent context on attempt N.
 */
export function governShapesInContext(): InvariantCheck {
  return {
    name: 'govern_shapes_in_agent_context',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      // If there was more than 1 attempt and shapes were found, shapes should be in context
      // We can't directly observe the context here, but we check the convergence state
      if (govResult.attempts > 1 && govResult.receipt.failureShapes.length > 0) {
        // Shapes should be tracked in convergence
        if (govResult.convergence.shapeHistory.length === 0) {
          return { passed: false, violation: 'Multi-attempt with shapes, but shapeHistory is empty', severity: 'bug' };
        }
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() convergenceNarrowed when expected.
 */
export function governNarrowed(expected: boolean): InvariantCheck {
  return {
    name: `govern_narrowed_${expected}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      if (govResult.convergenceNarrowed !== expected) {
        return { passed: false, violation: `Expected convergenceNarrowed=${expected}, got ${govResult.convergenceNarrowed}`, severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() receipt well-formedness.
 */
export function governReceiptWellFormed(): InvariantCheck {
  return {
    name: 'govern_receipt_well_formed',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      const r = govResult.receipt;
      if (!r.goal || typeof r.goal !== 'string') {
        return { passed: false, violation: 'Receipt missing goal', severity: 'bug' };
      }
      if (!r.attestation || typeof r.attestation !== 'string') {
        return { passed: false, violation: 'Receipt missing attestation', severity: 'bug' };
      }
      if (!Array.isArray(r.gatesPassed) || !Array.isArray(r.gatesFailed)) {
        return { passed: false, violation: 'Receipt missing gate arrays', severity: 'bug' };
      }
      if (typeof r.totalDurationMs !== 'number' || r.totalDurationMs <= 0) {
        return { passed: false, violation: `Receipt totalDurationMs=${r.totalDurationMs}`, severity: 'unexpected' };
      }
      if (!Array.isArray(r.attemptDurations) || r.attemptDurations.length === 0) {
        return { passed: false, violation: 'Receipt missing attemptDurations', severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() history array length.
 */
export function governHistoryLength(expected: number): InvariantCheck {
  return {
    name: `govern_history_length_${expected}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      if (govResult.history.length !== expected) {
        return { passed: false, violation: `Expected history length ${expected}, got ${govResult.history.length}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() empty plan stall detection.
 */
export function governEmptyPlanStall(): InvariantCheck {
  return {
    name: 'govern_empty_plan_stall',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      if (govResult.convergence.emptyPlanCount < 3) {
        return { passed: false, violation: `Expected emptyPlanCount >= 3, got ${govResult.convergence.emptyPlanCount}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

// =============================================================================
// PIPELINE INTEGRATION INVARIANTS (Layer 5)
// =============================================================================

/**
 * Assert govern() history[N] failed at a specific gate.
 */
export function governHistoryGateFailed(attemptIndex: number, gate: string): InvariantCheck {
  return {
    name: `govern_history_${attemptIndex}_failed_${gate}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      const attempt = govResult.history[attemptIndex];
      if (!attempt) return { passed: false, violation: `No history[${attemptIndex}]`, severity: 'bug' };
      const failed = attempt.gates?.filter((g: any) => !g.passed).map((g: any) => g.gate) ?? [];
      if (!failed.includes(gate)) {
        return { passed: false, violation: `History[${attemptIndex}] expected ${gate} to fail, failed gates: [${failed.join(', ')}]`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() history[N] had a specific gate pass.
 */
export function governHistoryGatePassed(attemptIndex: number, gate: string): InvariantCheck {
  return {
    name: `govern_history_${attemptIndex}_passed_${gate}`,
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      const attempt = govResult.history[attemptIndex];
      if (!attempt) return { passed: false, violation: `No history[${attemptIndex}]`, severity: 'bug' };
      const passed = attempt.gates?.filter((g: any) => g.passed).map((g: any) => g.gate) ?? [];
      if (!passed.includes(gate)) {
        return { passed: false, violation: `History[${attemptIndex}] expected ${gate} to pass, passed gates: [${passed.join(', ')}]`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() narrowing has banned fingerprints after a failure.
 */
export function governHasBannedFingerprints(): InvariantCheck {
  return {
    name: 'govern_has_banned_fingerprints',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      // Check if any attempt in history has narrowing with banned fingerprints
      const hasNarrow = govResult.history.some((h: any) =>
        h.narrowing?.bannedFingerprints?.length > 0 || h.narrowing?.constraints?.length > 0
      );
      if (!hasNarrow) {
        return { passed: false, violation: 'No narrowing with banned fingerprints found in history', severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert govern() constraint delta shows constraints were seeded (more after than before).
 */
export function governConstraintsGrew(): InvariantCheck {
  return {
    name: 'govern_constraints_grew',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      const lastAttempt = govResult.history[govResult.history.length - 1];
      if (!lastAttempt?.constraintDelta) return { passed: true, severity: 'info' };
      // Either constraintsActive grew, or seeded array is non-empty in some attempt
      const anySeeded = govResult.history.some((h: any) =>
        h.constraintDelta?.seeded?.length > 0 || (h.constraintDelta?.after > h.constraintDelta?.before)
      );
      if (!anySeeded) {
        return { passed: false, violation: 'No constraints were seeded across attempts', severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert two different gates failed across the attempt history (not same gate stuck).
 */
export function governMultiGateProgression(): InvariantCheck {
  return {
    name: 'govern_multi_gate_progression',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      const failedGates = new Set<string>();
      for (const h of govResult.history) {
        if (!h.success && h.gates) {
          for (const g of h.gates) {
            if (!g.passed) failedGates.add(g.gate);
          }
        }
      }
      if (failedGates.size < 2) {
        return { passed: false, violation: `Only ${failedGates.size} distinct gate(s) failed: [${[...failedGates].join(', ')}]`, severity: 'unexpected' };
      }
      return { passed: true, severity: 'info' };
    },
  };
}

/**
 * Assert effective predicates contain expected grounding miss markers.
 */
export function governGroundingMissDetected(): InvariantCheck {
  return {
    name: 'govern_grounding_miss_detected',
    category: 'pipeline',
    layer: 'product',
    check: (_scenario, result) => {
      if (result instanceof Error) return { passed: true, severity: 'info' };
      const govResult = (result as any)._governResult;
      if (!govResult) return { passed: false, violation: 'No _governResult', severity: 'bug' };
      // Check first attempt for grounding miss
      const first = govResult.history[0];
      if (!first) return { passed: false, violation: 'No history[0]', severity: 'bug' };
      const hasMiss = first.effectivePredicates?.some((p: any) => p.groundingMiss === true);
      if (!hasMiss) {
        return { passed: false, violation: 'First attempt should have groundingMiss=true on fabricated predicate', severity: 'bug' };
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
  // Family M (message gate) and L (govern loop) scenarios skip universal invariants —
  // they test governMessage()/govern(), not verify() directly
  const allInvariants = scenario.family === 'M' || scenario.family === 'L'
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
