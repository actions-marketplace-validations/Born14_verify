/**
 * Scenario Generator — 7 Families of Adversarial Test Scenarios
 * ==============================================================
 *
 * Phase 1: Families A (fingerprint collision) + G (edge cases)
 * Phase 2: Families B (K5 learning) + C (gate sequencing)
 * Phase 3+: Families D, E, F (Docker)
 */

import type { VerifyScenario, ScenarioFamily } from './types.js';
import type { Predicate, Edit } from '../../src/types.js';
import {
  fingerprintDistinctness,
  fingerprintDeterminism,
  shouldNotCrash,
  k5ShouldBlock,
  k5ShouldPass,
  gateOrderBefore,
  gateAbsent,
  gateTimingPositive,
  failedGateHasDetail,
  constraintCountAtLeast,
  constraintCountEquals,
  containmentCounts,
  containmentAlwaysPasses,
  editAttributed,
  containmentTotalMatchesEdits,
  predicateIsGroundingMiss,
  predicateIsGrounded,
  groundingRan,
  verifySucceeded,
  verifyFailedAt,
  narrowingPresent,
  constraintSeededOnFailure,
} from './oracle.js';
import { ConstraintStore, predicateFingerprint } from '../../src/store/constraint-store.js';

let scenarioCounter = 0;
function nextId(family: ScenarioFamily, generator: string): string {
  return `${family}_${generator}_${++scenarioCounter}`;
}

// =============================================================================
// FAMILY A: FINGERPRINT COLLISION DETECTION
// =============================================================================

function generateFamilyA(): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  const dummyEdit: Edit = { file: 'server.js', search: 'placeholder', replace: 'placeholder' };

  // A1: HTTP predicates differing in expect.status
  scenarios.push({
    id: nextId('A', 'A1_httpStatus'),
    family: 'A',
    generator: 'A1_httpExpectStatus',
    description: 'HTTP predicates with different expect.status must have different fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('status_200', 'status_404',
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200 } }),
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 404 } }),
      ),
      fingerprintDeterminism('http_status', () => ({
        type: 'http', path: '/api/items', method: 'GET', expect: { status: 200 },
      })),
    ],
    requiresDocker: false,
  });

  // A2: HTTP predicates differing in expect.bodyContains
  scenarios.push({
    id: nextId('A', 'A2_httpBody'),
    family: 'A',
    generator: 'A2_httpExpectBodyContains',
    description: 'HTTP predicates with different bodyContains must have different fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('body_Alpha', 'body_Beta',
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'Alpha' } }),
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'Beta' } }),
      ),
      // Array vs string bodyContains
      fingerprintDistinctness('body_string', 'body_array',
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { bodyContains: 'Alpha' } }),
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { bodyContains: ['Alpha', 'Beta'] } }),
      ),
    ],
    requiresDocker: false,
  });

  // A3: HTTP sequence predicates with different step orderings
  scenarios.push({
    id: nextId('A', 'A3_httpSeqSteps'),
    family: 'A',
    generator: 'A3_httpSequenceStepVariation',
    description: 'http_sequence predicates with different step orders must differ',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('steps_POST_GET', 'steps_GET_POST',
        () => ({
          type: 'http_sequence',
          steps: [
            { method: 'POST', path: '/api/items' },
            { method: 'GET', path: '/api/items' },
          ],
        }),
        () => ({
          type: 'http_sequence',
          steps: [
            { method: 'GET', path: '/api/items' },
            { method: 'POST', path: '/api/items' },
          ],
        }),
      ),
      // Different step count
      fingerprintDistinctness('one_step', 'two_steps',
        () => ({
          type: 'http_sequence',
          steps: [{ method: 'GET', path: '/api/items' }],
        }),
        () => ({
          type: 'http_sequence',
          steps: [
            { method: 'GET', path: '/api/items' },
            { method: 'DELETE', path: '/api/items/1' },
          ],
        }),
      ),
    ],
    requiresDocker: false,
  });

  // A4: CSS predicates differing in expected value
  scenarios.push({
    id: nextId('A', 'A4_cssExpected'),
    family: 'A',
    generator: 'A4_cssPropertyVariation',
    description: 'CSS predicates with different expected values must have different fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('red', 'blue',
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'red' }),
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'blue' }),
      ),
      fingerprintDistinctness('diff_property', 'diff_property2',
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'red' }),
        () => ({ type: 'css', selector: 'h1', property: 'font-size', expected: 'red' }),
      ),
    ],
    requiresDocker: false,
  });

  // A5: Same type/selector, different path
  scenarios.push({
    id: nextId('A', 'A5_pathVariation'),
    family: 'A',
    generator: 'A5_pathVariation',
    description: 'Same predicate type with different path must have different fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('root_path', 'about_path',
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'red', path: '/' }),
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'red', path: '/about' }),
      ),
      fingerprintDistinctness('http_root', 'http_roster',
        () => ({ type: 'http', path: '/', method: 'GET', expect: { status: 200 } }),
        () => ({ type: 'http', path: '/roster', method: 'GET', expect: { status: 200 } }),
      ),
    ],
    requiresDocker: false,
  });

  // A6: Optional field present vs absent
  scenarios.push({
    id: nextId('A', 'A6_optionalFields'),
    family: 'A',
    generator: 'A6_optionalFieldPresence',
    description: 'Predicate with optional field vs without must have different fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('with_property', 'without_property',
        () => ({ type: 'css', selector: 'h1', property: 'color' }),
        () => ({ type: 'css', selector: 'h1' }),
      ),
      fingerprintDistinctness('with_method', 'without_method',
        () => ({ type: 'http', path: '/api', method: 'POST', expect: { status: 200 } }),
        () => ({ type: 'http', path: '/api', expect: { status: 200 } }),
      ),
    ],
    requiresDocker: false,
  });

  // A7: DB predicates differing in table/assertion
  scenarios.push({
    id: nextId('A', 'A7_dbFields'),
    family: 'A',
    generator: 'A7_dbFieldVariation',
    description: 'DB predicates with different table/assertion must have different fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('table_users', 'table_items',
        () => ({ type: 'db', table: 'users' }),
        () => ({ type: 'db', table: 'items' }),
      ),
      fingerprintDistinctness('with_pattern', 'without_pattern',
        () => ({ type: 'db', table: 'users', pattern: 'id' }),
        () => ({ type: 'db', table: 'users' }),
      ),
    ],
    requiresDocker: false,
  });

  // A8: Canonicalization traps
  scenarios.push({
    id: nextId('A', 'A8_canonTraps'),
    family: 'A',
    generator: 'A8_canonicalizationTraps',
    description: 'Absent vs undefined vs null fields; type coercion traps',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      // Absent field vs explicit undefined should produce same fingerprint (both absent)
      fingerprintDeterminism('absent_vs_undefined', () => {
        const p: any = { type: 'css', selector: 'h1' };
        p.property = undefined;
        return p;
      }),
      // HTTP expect with bodyRegex vs without
      fingerprintDistinctness('with_regex', 'without_regex',
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { status: 200, bodyRegex: '\\d+' } }),
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { status: 200 } }),
      ),
      // Empty string expected vs no expected
      fingerprintDistinctness('empty_expected', 'no_expected',
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: '' }),
        () => ({ type: 'css', selector: 'h1', property: 'color' }),
      ),
    ],
    requiresDocker: false,
  });

  // A9: Triplets — 3 predicates where any pair differs
  scenarios.push({
    id: nextId('A', 'A9_triplets'),
    family: 'A',
    generator: 'A9_tripletsAndPermutations',
    description: 'Three HTTP predicates with different body content all produce distinct fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('triplet_A_B', 'triplet_A_C',
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'Alpha' } }),
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'Beta' } }),
      ),
      fingerprintDistinctness('triplet_B_C', 'triplet_B_C2',
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'Beta' } }),
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'Gamma' } }),
      ),
      fingerprintDistinctness('triplet_A_C', 'triplet_A_C2',
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'Alpha' } }),
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'Gamma' } }),
      ),
    ],
    requiresDocker: false,
  });

  // A10: Regression guard — confirms the v0.1.1 bug class is caught
  scenarios.push({
    id: nextId('A', 'A10_regressionGuard'),
    family: 'A',
    generator: 'A10_regressionGuard',
    description: 'HTTP predicates with ONLY different bodyContains must NOT collide (v0.1.1 bug class)',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('NONEXISTENT_body', 'BetaV2_body',
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'NONEXISTENT' } }),
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'Beta V2' } }),
      ),
      // The exact scenario from the v0.1.1 bug
      fingerprintDistinctness('original_bug_pred1', 'original_bug_pred2',
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'NONEXISTENT' } }),
        () => ({ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'Beta V2' } }),
      ),
    ],
    requiresDocker: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY G: EDGE CASES AND ADVERSARIAL INPUTS
// =============================================================================

function generateFamilyG(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // G1: Empty edits
  scenarios.push({
    id: nextId('G', 'G1_emptyEdits'),
    family: 'G',
    generator: 'G1_emptyEdits',
    description: 'Empty edit array should not crash',
    edits: [],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('empty edits')],
    requiresDocker: false,
  });

  // G2: Empty predicates
  scenarios.push({
    id: nextId('G', 'G2_emptyPredicates'),
    family: 'G',
    generator: 'G2_emptyPredicates',
    description: 'Empty predicate array should not crash',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('empty predicates')],
    requiresDocker: false,
  });

  // G3: Very long search string
  scenarios.push({
    id: nextId('G', 'G3_longSearch'),
    family: 'G',
    generator: 'G3_veryLongSearchString',
    description: 'Search string >10KB should not OOM or hang',
    edits: [{ file: 'server.js', search: 'x'.repeat(10240), replace: 'y' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'y' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('very long search string')],
    requiresDocker: false,
  });

  // G4: Unicode characters in predicates
  scenarios.push({
    id: nextId('G', 'G4_unicode'),
    family: 'G',
    generator: 'G4_unicodePredicates',
    description: 'Unicode in selector/expected values should not crash',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [
      { type: 'css', selector: '.日本語', property: 'color', expected: 'красный' },
      { type: 'html', selector: 'h1', expected: '🎯 目標' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('unicode in predicates')],
    requiresDocker: false,
  });

  // G5: Duplicate edits
  scenarios.push({
    id: nextId('G', 'G5_dupeEdits'),
    family: 'G',
    generator: 'G5_duplicateEdits',
    description: 'Same edit twice should handle deterministically',
    edits: [
      { file: 'server.js', search: 'placeholder', replace: 'changed' },
      { file: 'server.js', search: 'placeholder', replace: 'changed' },
    ],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('duplicate edits')],
    requiresDocker: false,
  });

  // G6: No-op edit (search == replace)
  scenarios.push({
    id: nextId('G', 'G6_noopEdit'),
    family: 'G',
    generator: 'G6_noopEdit',
    description: 'search == replace (no-op) should pass F9',
    edits: [{ file: 'server.js', search: 'const', replace: 'const' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('no-op edit')],
    requiresDocker: false,
  });

  // G7: Edit targeting non-existent file
  scenarios.push({
    id: nextId('G', 'G7_missingFile'),
    family: 'G',
    generator: 'G7_missingFile',
    description: 'Edit targeting non-existent file should fail F9 gracefully',
    edits: [{ file: 'nonexistent.js', search: 'foo', replace: 'bar' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('non-existent file')],
    requiresDocker: false,
  });

  // G8: Predicate with all fields set
  scenarios.push({
    id: nextId('G', 'G8_maxFields'),
    family: 'G',
    generator: 'G8_maximalPredicate',
    description: 'Predicate with every possible field should not crash fingerprinting',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{
      type: 'http',
      selector: '.test',
      property: 'color',
      expected: 'red',
      path: '/api/items',
      method: 'GET',
      pattern: 'test',
      expect: { status: 200, bodyContains: ['a', 'b'], bodyRegex: '\\d+', contentType: 'application/json' },
    } as any],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('maximal predicate fields')],
    requiresDocker: false,
  });

  // G9: Special characters in strings
  scenarios.push({
    id: nextId('G', 'G9_specialChars'),
    family: 'G',
    generator: 'G9_specialCharacters',
    description: 'Pipe, equals, newline in values should not break fingerprinting',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [],
    config: { appDir, gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDeterminism('pipe_in_selector', () => ({
        type: 'css', selector: 'a|b', property: 'color', expected: 'red',
      })),
      fingerprintDeterminism('equals_in_expected', () => ({
        type: 'css', selector: 'h1', property: 'color', expected: 'a=b',
      })),
      fingerprintDeterminism('newline_in_body', () => ({
        type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'line1\nline2' },
      })),
    ],
    requiresDocker: false,
  });

  // G10: Null/undefined explicit values
  scenarios.push({
    id: nextId('G', 'G10_nullish'),
    family: 'G',
    generator: 'G10_nullishValues',
    description: 'Explicit null/undefined in predicate fields should not crash',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [],
    config: { appDir, gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDeterminism('null_selector', () => ({
        type: 'css', selector: null as any, property: 'color',
      })),
      fingerprintDeterminism('undefined_expected', () => ({
        type: 'css', selector: 'h1', property: 'color', expected: undefined,
      })),
      fingerprintDeterminism('null_expect', () => ({
        type: 'http', path: '/api', method: 'GET', expect: null as any,
      })),
    ],
    requiresDocker: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY B: K5 CONSTRAINT LEARNING (multi-step)
// =============================================================================

function generateFamilyB(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  // No-op edit that matches real content in the demo app (search === replace)
  const noopEdit: Edit = { file: 'server.js', search: 'const http', replace: 'const http' };
  const SESSION_ID = 'selftest-B';

  // B1: 3 sequential failures → constraint count monotonically non-decreasing
  scenarios.push({
    id: nextId('B', 'B1_monotonicity'),
    family: 'B',
    generator: 'B1_constraintMonotonicity',
    description: '3 sequential evidence failures → constraint count increases monotonically',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed failure with predicate A
      {
        id: nextId('B', 'B1_step1'),
        family: 'B',
        generator: 'B1_step1_seed',
        description: 'Seed constraint from evidence failure (predicate A)',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [constraintCountAtLeast(1)],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: bodyContains NONEXISTENT',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'NONEXISTENT' } }],
          });
        },
      },
      // Step 2: Seed failure with predicate B
      {
        id: nextId('B', 'B1_step2'),
        family: 'B',
        generator: 'B1_step2_seed',
        description: 'Seed second constraint (predicate B)',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [constraintCountAtLeast(2)],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: bodyContains WRONG',
            filesTouched: ['server.js'], attempt: 2,
            failedPredicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'WRONG' } }],
          });
        },
      },
      // Step 3: Seed failure with predicate C — count should be ≥ 3
      {
        id: nextId('B', 'B1_step3'),
        family: 'B',
        generator: 'B1_step3_seed',
        description: 'Seed third constraint (predicate C) — count must be ≥ 3',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [constraintCountAtLeast(3)],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: bodyContains MISSING',
            filesTouched: ['server.js'], attempt: 3,
            failedPredicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'MISSING' } }],
          });
        },
      },
    ],
  });

  // B2: Fail with predicate A, retry with predicate B (different fingerprint) → K5 must NOT block B
  scenarios.push({
    id: nextId('B', 'B2_correctedPredicate'),
    family: 'B',
    generator: 'B2_correctedPredicatePassesK5',
    description: 'Corrected predicate (different fingerprint) should pass K5 after prior failure',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed a predicate fingerprint ban
      {
        id: nextId('B', 'B2_step1_seed'),
        family: 'B',
        generator: 'B2_step1',
        description: 'Seed evidence failure banning predicate A fingerprint',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'NONEXISTENT' } }],
          });
        },
      },
      // Step 2: Verify with DIFFERENT predicate → K5 should pass
      {
        id: nextId('B', 'B2_step2_pass'),
        family: 'B',
        generator: 'B2_step2',
        description: 'Second attempt with different predicate → K5 should NOT block',
        edits: [noopEdit],
        predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'DIFFERENT_VALUE' } }],
        config: { appDir, gates: { staging: false, browser: false, http: false } },
        invariants: [k5ShouldPass('corrected predicate with different fingerprint')],
        requiresDocker: false,
      },
    ],
  });

  // B3: Same predicate blocked after failure
  scenarios.push({
    id: nextId('B', 'B3_samePredBlocked'),
    family: 'B',
    generator: 'B3_samePredicateBlockedK5',
    description: 'Same predicate fingerprint must be blocked by K5 after evidence failure',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed a predicate fingerprint ban for specific predicate
      {
        id: nextId('B', 'B3_step1_seed'),
        family: 'B',
        generator: 'B3_step1',
        description: 'Seed evidence failure banning predicate fingerprint',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: color should be green',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.link', property: 'color', expected: 'green' }],
          });
        },
      },
      // Step 2: Retry with the SAME predicate → K5 MUST block
      {
        id: nextId('B', 'B3_step2_blocked'),
        family: 'B',
        generator: 'B3_step2',
        description: 'Retry with identical predicate → K5 MUST block',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.link', property: 'color', expected: 'green' }],
        config: { appDir, gates: { staging: false, browser: false, http: false } },
        invariants: [k5ShouldBlock('same predicate fingerprint should be blocked')],
        requiresDocker: false,
      },
    ],
  });

  // B4: TTL expiry — expired constraints don't fire
  scenarios.push({
    id: nextId('B', 'B4_ttlExpiry'),
    family: 'B',
    generator: 'B4_expiredConstraintIgnored',
    description: 'Constraint with expiresAt in the past should not fire',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed constraint then manipulate its expiresAt to the past
      {
        id: nextId('B', 'B4_step1_seed'),
        family: 'B',
        generator: 'B4_step1',
        description: 'Seed constraint then expire it',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: color should be blue',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.btn', property: 'color', expected: 'blue' }],
          });
          // Now manipulate the constraint to be expired
          const { readFileSync, writeFileSync } = require('fs');
          const { join } = require('path');
          const dataPath = join(stateDir, 'memory.json');
          const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
          for (const c of data.constraints) {
            c.expiresAt = Date.now() - 1000; // 1 second in the past
          }
          writeFileSync(dataPath, JSON.stringify(data, null, 2));
        },
      },
      // Step 2: Verify with the same predicate → should NOT be blocked (constraint expired)
      {
        id: nextId('B', 'B4_step2_pass'),
        family: 'B',
        generator: 'B4_step2',
        description: 'Verify with same pred after expiry → K5 should pass',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.btn', property: 'color', expected: 'blue' }],
        config: { appDir, gates: { staging: false, browser: false, http: false } },
        invariants: [k5ShouldPass('expired constraint should not fire')],
        requiresDocker: false,
      },
    ],
  });

  // B5: Cross-session persistence — constraints survive store reload
  scenarios.push({
    id: nextId('B', 'B5_crossSession'),
    family: 'B',
    generator: 'B5_crossSessionPersistence',
    description: 'Constraint seeded in one store instance persists when reloaded',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed a constraint
      {
        id: nextId('B', 'B5_step1_seed'),
        family: 'B',
        generator: 'B5_step1',
        description: 'Seed constraint in first store instance',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [constraintCountAtLeast(1)],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: should be red',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.header', property: 'color', expected: 'red' }],
          });
        },
      },
      // Step 2: Reload store (happens naturally in runner — new ConstraintStore(stateDir))
      // Verify with matching predicate → K5 should block (constraint persisted)
      {
        id: nextId('B', 'B5_step2_check'),
        family: 'B',
        generator: 'B5_step2',
        description: 'New store instance → K5 should still block (persisted)',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.header', property: 'color', expected: 'red' }],
        config: { appDir, gates: { staging: false, browser: false, http: false } },
        invariants: [k5ShouldBlock('constraint must persist across store reload')],
        requiresDocker: false,
      },
    ],
  });

  // B6: Max depth enforcement — cap at 5 constraints per session
  scenarios.push({
    id: nextId('B', 'B6_maxDepth'),
    family: 'B',
    generator: 'B6_maxConstraintDepth',
    description: 'After 5 session-scoped constraints, no more should be added',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed 6 constraints (only 5 should survive)
      {
        id: nextId('B', 'B6_step1_seed'),
        family: 'B',
        generator: 'B6_step1',
        description: 'Seed 6 evidence failures — only 5 constraints should be stored',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [constraintCountEquals(5)],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          // Seed 6 unique evidence failures — MAX_CONSTRAINT_DEPTH = 5
          // Each must have a distinct signature to avoid dedup
          // (buildEvidenceConstraint uses event.signature ?? 'evidence_failure')
          const signatures = [
            'css_value_mismatch',
            'predicate_mismatch',
            'selector_not_found',
            'health_check_failure',
            'build_failure',
            'missing_module',
          ];
          for (let i = 0; i < 6; i++) {
            store.seedFromFailure({
              sessionId: SESSION_ID, source: 'evidence',
              error: `predicate failed: value_${i}`,
              signature: signatures[i],
              filesTouched: ['server.js'], attempt: 1,
              failedPredicates: [{ type: 'css', selector: `.cls${i}`, property: 'color', expected: `val${i}` }],
            });
          }
        },
      },
    ],
  });

  // B7: Override bypass — overrideConstraints config skips matching constraint
  scenarios.push({
    id: nextId('B', 'B7_override'),
    family: 'B',
    generator: 'B7_overrideBypass',
    description: 'overrideConstraints config should bypass a matching K5 constraint',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed a constraint and capture its ID
      {
        id: nextId('B', 'B7_step1_seed'),
        family: 'B',
        generator: 'B7_step1',
        description: 'Seed constraint to be overridden',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: should be orange',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.nav', property: 'color', expected: 'orange' }],
          });
        },
      },
      // Step 2: Verify with same predicate BUT with overrideConstraints containing the constraint ID
      // We'll dynamically read the constraint ID in beforeStep and set it on the config
      {
        id: nextId('B', 'B7_step2_override'),
        family: 'B',
        generator: 'B7_step2',
        description: 'Verify with override → K5 should pass despite matching constraint',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.nav', property: 'color', expected: 'orange' }],
        config: { appDir, gates: { staging: false, browser: false, http: false } },
        invariants: [k5ShouldPass('constraint overridden by overrideConstraints')],
        requiresDocker: false,
        // Runner will call beforeStep before verify — we'll set overrideConstraints dynamically
        beforeStep: (stateDir: string) => {
          // Read constraint IDs and inject them into the step's config
          const store = new ConstraintStore(stateDir);
          const constraints = store.getConstraints();
          // Stash override IDs in a well-known file for runner to pick up
          const { writeFileSync } = require('fs');
          const { join } = require('path');
          writeFileSync(
            join(stateDir, '_override_ids.json'),
            JSON.stringify(constraints.map(c => c.id)),
          );
        },
      },
    ],
  });

  // B8: Harness fault → no constraint seeded
  scenarios.push({
    id: nextId('B', 'B8_harnessFault'),
    family: 'B',
    generator: 'B8_harnessFaultNoSeed',
    description: 'Harness-classified failure (DNS error) must NOT seed constraints',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      {
        id: nextId('B', 'B8_step1'),
        family: 'B',
        generator: 'B8_step1',
        description: 'Seed DNS harness fault → constraint count should stay 0',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [constraintCountEquals(0)],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          // DNS errors are classified as harness_fault → should be rejected
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'staging',
            error: 'getaddrinfo EAI_AGAIN db',
            filesTouched: ['server.js'], attempt: 1,
            failureKind: 'harness_fault',
          });
        },
      },
    ],
  });

  // B9: Scope isolation — same fingerprint on different paths shouldn't cross-pollinate
  scenarios.push({
    id: nextId('B', 'B9_scopeIsolation'),
    family: 'B',
    generator: 'B9_pathScopeIsolation',
    description: 'Constraint seeded for path /a should not block same predicate on path /b',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed a constraint for path /a
      {
        id: nextId('B', 'B9_step1_seed'),
        family: 'B',
        generator: 'B9_step1',
        description: 'Seed constraint for predicate on path /a',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red', path: '/a' }],
          });
        },
      },
      // Step 2: Verify with same type/selector/property/expected but different path
      {
        id: nextId('B', 'B9_step2_diffpath'),
        family: 'B',
        generator: 'B9_step2',
        description: 'Same predicate but path /b → K5 should NOT block',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red', path: '/b' } as Predicate],
        config: { appDir, gates: { staging: false, browser: false, http: false } },
        invariants: [k5ShouldPass('different path should not be blocked')],
        requiresDocker: false,
      },
    ],
  });

  return scenarios;
}

// =============================================================================
// FAMILY C: GATE SEQUENCING
// =============================================================================

function generateFamilyC(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  // No-op edit that matches real content in the demo app (search === replace)
  // Using 'placeholder' doesn't match anything in server.js → F9 fails before other gates run
  const noopEdit: Edit = { file: 'server.js', search: 'const http', replace: 'const http' };
  // Deliberately bad edit for scenarios that need F9 to fail
  const badEdit: Edit = { file: 'nonexistent_file_xyz.js', search: 'foo', replace: 'bar' };

  // C1: F9 fails before K5 — K5 never runs on bad syntax
  scenarios.push({
    id: nextId('C', 'C1_f9BeforeK5'),
    family: 'C',
    generator: 'C1_f9FailsBeforeK5',
    description: 'F9 syntax failure should prevent K5 from running',
    edits: [{ file: 'nonexistent_file_xyz.js', search: 'foo', replace: 'bar' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      // K5 should be absent or not reached when F9 fails
      {
        name: 'k5_absent_on_f9_failure',
        category: 'gate_sequence',
        layer: 'product',
        check: (_scenario, result) => {
          if (result instanceof Error) return { passed: true, severity: 'info' as const };
          const f9 = result.gates.find(g => g.gate === 'F9');
          const k5 = result.gates.find(g => g.gate === 'K5');
          // If F9 failed, K5 should either be absent or also failed (early termination)
          if (f9 && !f9.passed && k5 && k5.passed) {
            return {
              passed: false,
              violation: 'K5 passed despite F9 failure — gate sequence violated',
              severity: 'bug' as const,
            };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // C2: K5 fails before staging — staging never runs
  scenarios.push({
    id: nextId('C', 'C2_k5BeforeStaging'),
    family: 'C',
    generator: 'C2_k5FailsBeforeStaging',
    description: 'K5 constraint failure should prevent staging from running',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed a constraint
      {
        id: nextId('C', 'C2_step1_seed'),
        family: 'C',
        generator: 'C2_step1',
        description: 'Seed constraint for K5 to block',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: 'selftest-C', source: 'evidence', error: 'predicate failed',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.target', property: 'color', expected: 'green' }],
          });
        },
      },
      // Step 2: Verify with matching predicate — K5 should block, staging should not run
      {
        id: nextId('C', 'C2_step2_blocked'),
        family: 'C',
        generator: 'C2_step2',
        description: 'K5 blocks → staging gate should be absent',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.target', property: 'color', expected: 'green' }],
        config: { appDir, gates: { staging: true, browser: false, http: false } },
        invariants: [
          k5ShouldBlock('K5 should block matching fingerprint'),
          gateAbsent('Staging', 'staging should not run when K5 blocks'),
        ],
        requiresDocker: false,
      },
    ],
  });

  // C3: Gate order determinism — same input run twice produces same gates
  scenarios.push({
    id: nextId('C', 'C3_determinism'),
    family: 'C',
    generator: 'C3_gateOrderDeterminism',
    description: 'Same input run twice must produce identical gate names and order',
    edits: [noopEdit],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [{
      name: 'gate_order_determinism',
      category: 'gate_sequence',
      layer: 'product',
      check: (_scenario, result, context) => {
        if (result instanceof Error) return { passed: true, severity: 'info' as const };
        // Compare with prior results
        if (context.priorResults.length > 0) {
          const prior = context.priorResults[context.priorResults.length - 1];
          const priorGates = prior.gates.map(g => g.gate).join(',');
          const currentGates = result.gates.map(g => g.gate).join(',');
          if (priorGates !== currentGates) {
            return {
              passed: false,
              violation: `Gate order changed: "${priorGates}" → "${currentGates}"`,
              severity: 'bug' as const,
            };
          }
        }
        return { passed: true, severity: 'info' as const };
      },
    }],
    requiresDocker: false,
  });

  // C4: Disabled gate should be skipped
  scenarios.push({
    id: nextId('C', 'C4_disabledGate'),
    family: 'C',
    generator: 'C4_disabledGateSkipped',
    description: 'Gates disabled via config should not appear in results',
    edits: [noopEdit],
    predicates: [],
    config: { appDir, gates: { syntax: true, constraints: false, containment: false, staging: false } },
    invariants: [{
      name: 'disabled_gates_absent',
      category: 'gate_sequence',
      layer: 'product',
      check: (_scenario, result) => {
        if (result instanceof Error) return { passed: true, severity: 'info' as const };
        const gateNames = result.gates.map(g => g.gate);
        if (gateNames.includes('K5')) {
          return { passed: false, violation: 'K5 gate present despite constraints: false', severity: 'bug' as const };
        }
        if (gateNames.includes('G5')) {
          return { passed: false, violation: 'G5 gate present despite containment: false', severity: 'bug' as const };
        }
        return { passed: true, severity: 'info' as const };
      },
    }],
    requiresDocker: false,
  });

  // C5: Most gates disabled → only F9 remains (minimal viable gate set)
  // Keep syntax: true so at least one gate result exists (satisfies universal well-formedness)
  scenarios.push({
    id: nextId('C', 'C5_mostDisabled'),
    family: 'C',
    generator: 'C5_mostGatesDisabled',
    description: 'Most gates disabled → only F9 gate should run',
    edits: [noopEdit],
    predicates: [],
    config: {
      appDir,
      gates: {
        syntax: true, constraints: false, containment: false,
        staging: false, browser: false, http: false,
      },
    },
    invariants: [
      gateAbsent('K5', 'constraints disabled'),
      gateAbsent('G5', 'containment disabled'),
      gateAbsent('Staging', 'staging disabled'),
    ],
    requiresDocker: false,
  });

  // C6: Gate timing is non-negative (>= 0)
  // K5 is a pure in-memory check that can complete in <1ms (durationMs=0 is valid)
  // F9 does file I/O so should always have positive timing
  scenarios.push({
    id: nextId('C', 'C6_timingNonNegative'),
    family: 'C',
    generator: 'C6_gateTimingNonNegative',
    description: 'Every gate in result should have durationMs >= 0',
    edits: [noopEdit],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [{
      name: 'gate_timing_non_negative',
      category: 'gate_sequence',
      layer: 'product',
      check: (_scenario, result) => {
        if (result instanceof Error) return { passed: true, severity: 'info' as const };
        for (const gate of result.gates) {
          if (gate.durationMs < 0) {
            return {
              passed: false,
              violation: `Gate ${gate.gate} has durationMs=${gate.durationMs} (expected >= 0)`,
              severity: 'bug' as const,
            };
          }
        }
        return { passed: true, severity: 'info' as const };
      },
    }],
    requiresDocker: false,
  });

  // C7: Failed gate detail is non-empty
  scenarios.push({
    id: nextId('C', 'C7_failedDetail'),
    family: 'C',
    generator: 'C7_failedGateHasDetail',
    description: 'Every failed gate should have a non-empty detail string',
    edits: [{ file: 'nonexistent_C7.js', search: 'foo', replace: 'bar' }], // Will fail F9
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [failedGateHasDetail()],
    requiresDocker: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY D: CONTAINMENT (G5) ATTRIBUTION
// =============================================================================

function generateFamilyD(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // D1: CSS edit with matching CSS predicate → direct attribution
  scenarios.push({
    id: nextId('D', 'D1_directCSS'),
    family: 'D',
    generator: 'D1_directCSS',
    description: 'CSS color edit with CSS predicate should be attributed as direct',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      containmentTotalMatchesEdits(),
      editAttributed('server.js', 'direct'),
      containmentCounts(1, 0, 0),
    ],
    requiresDocker: false,
  });

  // D2: Content edit with matching content predicate → direct attribution
  scenarios.push({
    id: nextId('D', 'D2_directContent'),
    family: 'D',
    generator: 'D2_directContent',
    description: 'File content edit with content predicate should be attributed as direct',
    edits: [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Test App</title>' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Test App' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      editAttributed('server.js', 'direct'),
      containmentCounts(1, 0, 0),
    ],
    requiresDocker: false,
  });

  // D3: Scaffolding file edit (Dockerfile) → scaffolding attribution
  scenarios.push({
    id: nextId('D', 'D3_scaffolding'),
    family: 'D',
    generator: 'D3_scaffolding',
    description: 'Dockerfile edit should be attributed as scaffolding',
    edits: [{ file: 'Dockerfile', search: 'FROM node', replace: 'FROM node' }], // no-op edit but file is scaffolding
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      editAttributed('Dockerfile', 'scaffolding'),
    ],
    requiresDocker: false,
  });

  // D4: Unrelated edit with no matching predicate → unexplained attribution
  scenarios.push({
    id: nextId('D', 'D4_unexplained'),
    family: 'D',
    generator: 'D4_unexplained',
    description: 'Edit to unrelated file with no matching predicate should be unexplained',
    edits: [{ file: 'utils/helper.js', search: 'old', replace: 'new' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      editAttributed('utils/helper.js', 'unexplained'),
      containmentCounts(0, 0, 1),
    ],
    requiresDocker: false,
  });

  // D5: Mixed edits — one direct, one scaffolding, one unexplained
  scenarios.push({
    id: nextId('D', 'D5_mixed'),
    family: 'D',
    generator: 'D5_mixed',
    description: 'Mixed edits produce correct attribution split',
    edits: [
      { file: 'server.js', search: 'color: #1a1a2e', replace: 'color: green' },  // direct (CSS match)
      { file: 'docker-compose.yml', search: 'old', replace: 'new' },              // scaffolding
      { file: 'random-file.txt', search: 'old', replace: 'new' },                 // unexplained
    ],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'green' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      containmentTotalMatchesEdits(),
      containmentCounts(1, 1, 1),
    ],
    requiresDocker: false,
  });

  // D6: HTTP route edit with HTTP predicate → direct
  scenarios.push({
    id: nextId('D', 'D6_httpDirect'),
    family: 'D',
    generator: 'D6_httpDirect',
    description: 'Route handler edit with HTTP predicate should be attributed as direct',
    edits: [{ file: 'server.js', search: "'/api/items'", replace: "'/api/items'" }], // no-op in route file
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200 } }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      editAttributed('server.js', 'direct'),
    ],
    requiresDocker: false,
  });

  // D7: DB migration edit with DB predicate → direct
  scenarios.push({
    id: nextId('D', 'D7_dbDirect'),
    family: 'D',
    generator: 'D7_dbDirect',
    description: 'Migration file edit with DB predicate should be attributed as direct',
    edits: [{ file: 'migrations/001.sql', search: 'CREATE', replace: 'CREATE' }],
    predicates: [{ type: 'db', table: 'users', assertion: 'table_exists' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      editAttributed('migrations/001.sql', 'direct'),
    ],
    requiresDocker: false,
  });

  // D8: No predicates at all → everything unexplained
  scenarios.push({
    id: nextId('D', 'D8_noPredicates'),
    family: 'D',
    generator: 'D8_noPredicates',
    description: 'Edits with zero predicates should all be unexplained',
    edits: [
      { file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' },
      { file: 'server.js', search: 'background: #ffffff', replace: 'background: #000000' },
    ],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      containmentTotalMatchesEdits(),
      containmentCounts(0, 0, 2),
    ],
    requiresDocker: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY E: GROUNDING (reality extraction + predicate validation)
// =============================================================================

function generateFamilyE(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // E1: Real CSS selector found in demo app → grounded
  scenarios.push({
    id: nextId('E', 'E1_realSelector'),
    family: 'E',
    generator: 'E1_realSelector',
    description: 'CSS predicate with real selector (h1) should be grounded',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'h1_exists_in_demo_app'),
    ],
    requiresDocker: false,
  });

  // E2: Fabricated CSS selector → groundingMiss
  scenarios.push({
    id: nextId('E', 'E2_fabricatedSelector'),
    family: 'E',
    generator: 'E2_fabricatedSelector',
    description: 'CSS predicate with fabricated selector should have groundingMiss=true',
    edits: [{ file: 'server.js', search: 'Demo App', replace: 'Test App' }],
    predicates: [{ type: 'css', selector: '.nonexistent-widget', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'nonexistent_widget'),
    ],
    requiresDocker: false,
  });

  // E3: Multiple predicates — one real, one fabricated
  scenarios.push({
    id: nextId('E', 'E3_mixedGrounding'),
    family: 'E',
    generator: 'E3_mixedGrounding',
    description: 'Mix of real and fabricated selectors — only fabricated gets groundingMiss',
    edits: [{ file: 'server.js', search: 'Demo App', replace: 'Test App' }],
    predicates: [
      { type: 'css', selector: 'h1', property: 'color', expected: 'red' },
      { type: 'css', selector: '.totally-fake', property: 'font-size', expected: '3rem' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'h1_is_real'),
      predicateIsGroundingMiss(1, 'totally_fake'),
    ],
    requiresDocker: false,
  });

  // E4: HTML predicate — not checked by grounding (creation goals)
  scenarios.push({
    id: nextId('E', 'E4_htmlExempt'),
    family: 'E',
    generator: 'E4_htmlExempt',
    description: 'HTML predicates should not get groundingMiss (creation-exempt)',
    edits: [{ file: 'server.js', search: 'Demo App', replace: 'Test App' }],
    predicates: [{ type: 'html', selector: '.brand-new-element', expected: 'exists' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'html_exempt_from_grounding'),
    ],
    requiresDocker: false,
  });

  // E5: Real class selector (.subtitle exists in demo app)
  scenarios.push({
    id: nextId('E', 'E5_classSelector'),
    family: 'E',
    generator: 'E5_classSelector',
    description: 'CSS predicate with real class selector (.subtitle) should be grounded',
    edits: [{ file: 'server.js', search: 'color: #666', replace: 'color: blue' }],
    predicates: [{ type: 'css', selector: '.subtitle', property: 'color', expected: 'blue' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'subtitle_class_exists'),
    ],
    requiresDocker: false,
  });

  // E6: Content/HTTP/DB predicates are not grounding-checked
  scenarios.push({
    id: nextId('E', 'E6_nonCSSExempt'),
    family: 'E',
    generator: 'E6_nonCSSExempt',
    description: 'Content, HTTP, DB predicates should not get groundingMiss',
    edits: [{ file: 'server.js', search: 'Demo App', replace: 'Test App' }],
    predicates: [
      { type: 'content', file: 'server.js', pattern: 'Test App' },
      { type: 'http', path: '/nonexistent', method: 'GET', expect: { status: 404 } },
      { type: 'db', table: 'nonexistent_table', assertion: 'table_exists' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'content_exempt'),
      predicateIsGrounded(1, 'http_exempt'),
      predicateIsGrounded(2, 'db_exempt'),
    ],
    requiresDocker: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY F: FULL PIPELINE (Docker required)
// =============================================================================

function generateFamilyF(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // F1: Valid CSS edit passes full pipeline
  scenarios.push({
    id: nextId('F', 'F1_validCSS'),
    family: 'F',
    generator: 'F1_validCSS',
    description: 'Valid CSS color change should pass all gates including staging',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'rgb(255, 0, 0)' }],
    config: { appDir },
    invariants: [
      verifySucceeded('CSS color change passes all gates'),
      containmentAlwaysPasses(),
      groundingRan(),
    ],
    requiresDocker: true,
  });

  // F2: Edit that breaks syntax fails at F9
  scenarios.push({
    id: nextId('F', 'F2_brokenSyntax'),
    family: 'F',
    generator: 'F2_brokenSyntax',
    description: 'Edit to nonexistent file should fail at F9',
    edits: [{ file: 'nonexistent.js', search: 'foo', replace: 'bar' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir },
    invariants: [
      verifyFailedAt('F9', 'nonexistent file fails syntax'),
      narrowingPresent(),
    ],
    requiresDocker: true,
  });

  // F3: Valid HTTP predicate — API endpoint returns expected data
  scenarios.push({
    id: nextId('F', 'F3_httpEndpoint'),
    family: 'F',
    generator: 'F3_httpEndpoint',
    description: 'HTTP predicate against /api/items should pass after staging',
    edits: [{ file: 'server.js', search: "'Alpha'", replace: "'Alpha'" }], // no-op so F9 passes
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'Alpha' } }],
    config: { appDir },
    invariants: [
      verifySucceeded('HTTP endpoint validates correctly'),
      groundingRan(),
    ],
    requiresDocker: true,
  });

  // F4: HTTP predicate with wrong expectation fails
  scenarios.push({
    id: nextId('F', 'F4_httpWrongExpect'),
    family: 'F',
    generator: 'F4_httpWrongExpect',
    description: 'HTTP predicate expecting wrong body content should fail at http gate',
    edits: [{ file: 'server.js', search: "'Alpha'", replace: "'Alpha'" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'NonexistentItem' } }],
    config: { appDir },
    invariants: [
      verifyFailedAt('http', 'wrong body content expectation'),
      narrowingPresent(),
      constraintSeededOnFailure(),
    ],
    requiresDocker: true,
  });

  // F5: Health invariant passes after valid edit
  scenarios.push({
    id: nextId('F', 'F5_invariantPass'),
    family: 'F',
    generator: 'F5_invariantPass',
    description: 'Health invariant should pass after valid CSS edit',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: green' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'rgb(0, 128, 0)' }],
    config: {
      appDir,
      invariants: [{ name: 'Health OK', type: 'http', path: '/health', expect: { status: 200 } }],
    },
    invariants: [
      verifySucceeded('health invariant passes with valid edit'),
    ],
    requiresDocker: true,
  });

  // F6: Full pipeline with containment + grounding checks
  scenarios.push({
    id: nextId('F', 'F6_fullPipelineAudit'),
    family: 'F',
    generator: 'F6_fullPipelineAudit',
    description: 'Full pipeline run produces containment and grounding data',
    edits: [{ file: 'server.js', search: 'background: #ffffff', replace: 'background: #222222' }],
    predicates: [{ type: 'css', selector: 'body', property: 'background-color', expected: 'rgb(34, 34, 34)' }],
    config: { appDir },
    invariants: [
      verifySucceeded('full pipeline with all metadata'),
      containmentAlwaysPasses(),
      containmentTotalMatchesEdits(),
      groundingRan(),
    ],
    requiresDocker: true,
  });

  return scenarios;
}

// =============================================================================
// GENERATOR DISPATCH
// =============================================================================

export function generateAllScenarios(appDir: string): VerifyScenario[] {
  return [
    ...generateFamilyA(),
    ...generateFamilyB(appDir),
    ...generateFamilyC(appDir),
    ...generateFamilyD(appDir),
    ...generateFamilyE(appDir),
    ...generateFamilyF(appDir),
    ...generateFamilyG(appDir),
  ];
}

export function generateFamily(family: ScenarioFamily, appDir: string): VerifyScenario[] {
  switch (family) {
    case 'A': return generateFamilyA();
    case 'B': return generateFamilyB(appDir);
    case 'C': return generateFamilyC(appDir);
    case 'D': return generateFamilyD(appDir);
    case 'E': return generateFamilyE(appDir);
    case 'F': return generateFamilyF(appDir);
    case 'G': return generateFamilyG(appDir);
  }
}
