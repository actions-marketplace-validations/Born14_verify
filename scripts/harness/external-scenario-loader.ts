/**
 * External Scenario Loader — Deserialize Fault-Derived Scenarios
 * ===============================================================
 *
 * Converts SerializedScenario (JSON, no functions) into VerifyScenario
 * (with invariant checks). This is the bridge between the external
 * scenario registry and the self-test runner.
 *
 * Invariants are derived from the scenario's intent:
 * - false_positive: verify SHOULD fail (expectedSuccess: false)
 * - false_negative: verify SHOULD pass (expectedSuccess: true)
 * - bad_hint: narrowing should be present and useful
 * - regression_guard: verify should match expectedSuccess
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { VerifyScenario, InvariantCheck, InvariantVerdict } from './types.js';
import type { VerifyResult } from '../../src/types.js';
import { ExternalScenarioStore } from '../../src/store/external-scenarios.js';
import type { SerializedScenario } from '../../src/store/external-scenarios.js';

/**
 * Load external scenarios from a registry file and convert to VerifyScenario[].
 */
export function loadExternalScenarios(registryPath: string, appDir: string): VerifyScenario[] {
  const store = new ExternalScenarioStore(registryPath);
  const serialized = store.all();

  return serialized.map(s => deserialize(s, appDir));
}

/**
 * Load universal scenarios from fixtures/scenarios/universal.json.
 * These are health-checked, portable scenarios that always run against demo-app.
 * They test verify gate logic (CSS spec, shorthand, color normalization) that
 * applies to ANY app — not app-specific selectors or routes.
 */
export function loadUniversalScenarios(fixtureDir: string): VerifyScenario[] {
  const universalPath = join(fixtureDir, '..', 'scenarios', 'universal.json');
  if (!existsSync(universalPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(universalPath, 'utf-8')) as SerializedScenario[];
    return raw.map(s => deserialize(s, fixtureDir));
  } catch {
    return [];
  }
}

/**
 * Convert a SerializedScenario into a VerifyScenario with appropriate invariants.
 */
function deserialize(s: SerializedScenario, appDir: string): VerifyScenario {
  const invariants = buildInvariants(s);

  return {
    id: s.id,
    family: 'G', // External scenarios go in family G (edge cases / misc)
    generator: `fault_${s.intent}`,
    description: s.description,
    edits: s.edits,
    predicates: s.predicates,
    config: {
      appDir,
      gates: s.gates,
    },
    invariants,
    requiresDocker: s.requiresDocker,
    expectedSuccess: s.expectedSuccess,
  };
}

/**
 * Build invariant checks based on the scenario's intent.
 */
function buildInvariants(s: SerializedScenario): InvariantCheck[] {
  const invariants: InvariantCheck[] = [];

  // Universal: should not crash
  invariants.push({
    name: 'should_not_crash',
    category: 'robustness',
    layer: 'harness',
    check: (_scenario, result) => {
      if (result instanceof Error) {
        return { passed: false, violation: `Crashed: ${result.message}`, severity: 'bug' };
      }
      return { passed: true, severity: 'info' };
    },
  });

  // Intent-specific invariants
  switch (s.intent) {
    case 'false_positive':
      // Verify was passing when it should fail → this scenario expects verify to FAIL
      invariants.push({
        name: 'should_detect_problem',
        category: 'pipeline',
        layer: 'product',
        check: (_scenario, result) => {
          if (result instanceof Error) return { passed: true, severity: 'info' };
          const r = result as VerifyResult;
          if (r.success) {
            return {
              passed: false,
              violation: `False positive still present: verify passed but should fail`,
              severity: 'bug',
            };
          }
          return { passed: true, severity: 'info' };
        },
      });
      if (s.expectedFailedGate) {
        invariants.push({
          name: `should_fail_at_${s.expectedFailedGate}`,
          category: 'gate_sequence',
          layer: 'product',
          check: (_scenario, result) => {
            if (result instanceof Error) return { passed: true, severity: 'info' };
            const r = result as VerifyResult;
            const gate = r.gates.find(g => g.gate === s.expectedFailedGate);
            if (!gate) {
              return {
                passed: false,
                violation: `Expected gate ${s.expectedFailedGate} not found in results`,
                severity: 'unexpected',
              };
            }
            if (gate.passed) {
              return {
                passed: false,
                violation: `Gate ${s.expectedFailedGate} should have failed but passed`,
                severity: 'bug',
              };
            }
            return { passed: true, severity: 'info' };
          },
        });
      }
      break;

    case 'false_negative':
      // Verify was failing when it should pass → this scenario expects verify to PASS
      invariants.push({
        name: 'should_accept_valid_edit',
        category: 'pipeline',
        layer: 'product',
        check: (_scenario, result) => {
          if (result instanceof Error) return { passed: true, severity: 'info' };
          const r = result as VerifyResult;
          if (!r.success) {
            const failedGate = r.gates.find(g => !g.passed);
            return {
              passed: false,
              violation: `False negative still present: verify failed at ${failedGate?.gate ?? 'unknown'} but should pass`,
              severity: 'bug',
            };
          }
          return { passed: true, severity: 'info' };
        },
      });
      break;

    case 'bad_hint':
      // Verify's narrowing was misleading → check that narrowing is present and reasonable
      invariants.push({
        name: 'narrowing_should_be_helpful',
        category: 'pipeline',
        layer: 'product',
        check: (_scenario, result) => {
          if (result instanceof Error) return { passed: true, severity: 'info' };
          const r = result as VerifyResult;
          if (!r.success && !r.narrowing?.resolutionHint) {
            return {
              passed: false,
              violation: 'Failed without narrowing hint — agent gets no guidance',
              severity: 'unexpected',
            };
          }
          return { passed: true, severity: 'info' };
        },
      });
      break;

    case 'regression_guard':
      // General regression — just check expectedSuccess matches
      invariants.push({
        name: 'outcome_matches_expected',
        category: 'pipeline',
        layer: 'product',
        check: (_scenario, result) => {
          if (result instanceof Error) return { passed: true, severity: 'info' };
          const r = result as VerifyResult;
          if (r.success !== s.expectedSuccess) {
            return {
              passed: false,
              violation: `Expected ${s.expectedSuccess ? 'pass' : 'fail'} but got ${r.success ? 'pass' : 'fail'}`,
              severity: 'bug',
            };
          }
          return { passed: true, severity: 'info' };
        },
      });
      break;
  }

  return invariants;
}
