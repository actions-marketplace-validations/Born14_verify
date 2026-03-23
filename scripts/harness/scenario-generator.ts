/**
 * Scenario Generator — 8 Families of Adversarial Test Scenarios
 * ==============================================================
 *
 * Phase 1: Families A (fingerprint collision) + G (edge cases)
 * Phase 2: Families B (K5 learning) + C (gate sequencing)
 * Phase 3+: Families D, E, F (Docker), H (filesystem)
 * Phase 4: Family V (vision + triangulation)
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
  filesystemGateRan,
  filesystemGatePassed,
  filesystemGateFailed,
  visionGateSkipped,
  visionGatePassed,
  visionGateFailed,
  visionGateRan,
  visionClaimVerified,
  visionClaimNotVerified,
  triangulationAction,
  triangulationOutlier,
  triangulationConfidence,
  messageDidNotCrash,
  messageVerdict,
  messageReason,
  messageGatePassed,
  messageGateFailed,
  messageClaimVerified,
  messageTopicResolution,
  messageNarrowing,
  httpGateRan,
  httpGatePassed,
  httpGateFailed,
  httpGateDetailContains,
  gatesPassedAndFailed,
  narrowingHintContains,
  narrowingNoHint,
} from './oracle.js';
import { makeSolidPNG } from './test-png.js';
import { ConstraintStore, predicateFingerprint, extractSignature } from '../../src/store/constraint-store.js';
import { hashFile } from '../../src/gates/filesystem.js';
import type { MessageEnvelope, MessagePolicy, EvidenceProvider } from '../../src/gates/message.js';
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

let scenarioCounter = 0;
function nextId(family: ScenarioFamily, generator: string): string {
  return `${family}_${generator}_${++scenarioCounter}`;
}

/**
 * Mirror of buildResolutionHint from verify.ts for AT-10 scenarios.
 * Tests the narrowing hint logic without importing private functions.
 */
function buildResolutionHintDirect(gate: string, _error: string, violation?: any): string {
  if (gate === 'F9') {
    if (_error.includes('not found')) return 'The search string does not exist in the file. Read the file first and use an exact match.';
    if (_error.includes('ambiguous')) return 'The search string matches multiple locations. Include more surrounding context to make it unique.';
    return 'Fix the syntax errors in your edits.';
  }
  if (gate === 'K5') {
    if (violation?.banType === 'predicate_fingerprint') return 'This predicate combination failed before. Change the expected value or predicate type.';
    if (violation?.banType === 'radius_limit') return `Too many files changed. Reduce to ${violation.reason?.match(/\d+/)?.[0] ?? 'fewer'} files.`;
    return 'This approach was tried before and failed. Try a different strategy.';
  }
  return 'Verification failed. Review the gate details.';
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

  // ===========================================================================
  // X-51: Object key ordering affects fingerprint
  // predicateFingerprint() reads fields by name, not by iteration order,
  // so key order should NOT affect the result. Verify this invariant.
  // ===========================================================================
  scenarios.push({
    id: nextId('A', 'X51a_keyOrderCSS'),
    family: 'A',
    generator: 'X51a_keyOrderCSS',
    failureClass: 'X-51',
    description: 'X-51: CSS predicate with different key ordering produces same fingerprint',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDeterminism('css_key_order_1', () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'red' })),
      fingerprintDeterminism('css_key_order_2', () => ({ property: 'color', expected: 'red', type: 'css', selector: 'h1' })),
      // Both orderings must produce identical fingerprints
      {
        name: 'key_order_invariant_css',
        category: 'fingerprint' as const,
        layer: 'product' as const,
        check: () => {
          const fp1 = predicateFingerprint({ type: 'css', selector: 'h1', property: 'color', expected: 'red' });
          const fp2 = predicateFingerprint({ property: 'color', expected: 'red', type: 'css', selector: 'h1' } as any);
          if (fp1 !== fp2) {
            return { passed: false, violation: `Key ordering changed fingerprint: "${fp1}" vs "${fp2}"`, severity: 'bug' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('A', 'X51b_keyOrderHTTP'),
    family: 'A',
    generator: 'X51b_keyOrderHTTP',
    failureClass: 'X-51',
    description: 'X-51: HTTP predicate with different key ordering produces same fingerprint',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      {
        name: 'key_order_invariant_http',
        category: 'fingerprint' as const,
        layer: 'product' as const,
        check: () => {
          const fp1 = predicateFingerprint({ type: 'http', path: '/api', method: 'GET', expect: { status: 200, bodyContains: 'test' } });
          const fp2 = predicateFingerprint({ expect: { bodyContains: 'test', status: 200 }, method: 'GET', type: 'http', path: '/api' } as any);
          if (fp1 !== fp2) {
            return { passed: false, violation: `Key ordering changed fingerprint: "${fp1}" vs "${fp2}"`, severity: 'bug' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('A', 'X51c_keyOrderDB'),
    family: 'A',
    generator: 'X51c_keyOrderDB',
    failureClass: 'X-51',
    description: 'X-51: DB predicate with different key ordering produces same fingerprint',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      {
        name: 'key_order_invariant_db',
        category: 'fingerprint' as const,
        layer: 'product' as const,
        check: () => {
          const fp1 = predicateFingerprint({ type: 'db', table: 'users', expected: 'exists' });
          const fp2 = predicateFingerprint({ expected: 'exists', type: 'db', table: 'users' } as any);
          if (fp1 !== fp2) {
            return { passed: false, violation: `Key ordering changed fingerprint: "${fp1}" vs "${fp2}"`, severity: 'bug' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // ===========================================================================
  // X-52: Array ordering matters for some predicates not others
  // bodyContains: ['Alpha','Beta'] vs ['Beta','Alpha'] — does order matter?
  // steps: [{POST:/a},{GET:/b}] vs [{GET:/b},{POST:/a}] — order SHOULD matter
  // ===========================================================================
  scenarios.push({
    id: nextId('A', 'X52a_bodyContainsArrayOrder'),
    family: 'A',
    generator: 'X52a_bodyContainsArrayOrder',
    failureClass: 'X-52',
    description: 'X-52: bodyContains array ordering — documents whether order affects fingerprint',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      // bodyContains array order: join(',') is order-sensitive, so ['A','B'] ≠ ['B','A']
      // This is the CURRENT behavior. Document it — false dedupe if agent reorders array.
      {
        name: 'bodyContains_array_order_sensitivity',
        category: 'fingerprint' as const,
        layer: 'product' as const,
        check: () => {
          const fp1 = predicateFingerprint({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: ['Alpha', 'Beta'] } });
          const fp2 = predicateFingerprint({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: ['Beta', 'Alpha'] } });
          // Current behavior: these are DIFFERENT (order-sensitive join)
          // This is a known weakness — documenting, not fixing
          if (fp1 === fp2) {
            return { passed: false, violation: `bodyContains array order does NOT affect fingerprint — false dedupe risk`, severity: 'unexpected' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('A', 'X52b_stepsOrderMatters'),
    family: 'A',
    generator: 'X52b_stepsOrderMatters',
    failureClass: 'X-52',
    description: 'X-52: HTTP sequence step ordering — order SHOULD produce different fingerprints',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      // Step order is semantically meaningful (POST then GET ≠ GET then POST)
      fingerprintDistinctness('steps_POST_GET', 'steps_GET_POST',
        () => ({ type: 'http_sequence', steps: [{ method: 'POST', path: '/api' }, { method: 'GET', path: '/api' }] }),
        () => ({ type: 'http_sequence', steps: [{ method: 'GET', path: '/api' }, { method: 'POST', path: '/api' }] }),
      ),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('A', 'X52c_bodyContainsStringVsArray'),
    family: 'A',
    generator: 'X52c_bodyContainsStringVsArray',
    failureClass: 'X-52',
    description: 'X-52: bodyContains string vs single-element array — documents collision behavior',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      // bodyContains: 'Alpha' vs ['Alpha'] — join of single array = same string
      // This IS a collision in current code. Document the false dedupe.
      {
        name: 'bodyContains_string_vs_singleton_array',
        category: 'fingerprint' as const,
        layer: 'product' as const,
        check: () => {
          const fp1 = predicateFingerprint({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: 'Alpha' } });
          const fp2 = predicateFingerprint({ type: 'http', path: '/api', method: 'GET', expect: { bodyContains: ['Alpha'] } });
          // Current behavior: these collide (join of ['Alpha'] = 'Alpha')
          // Documenting known collision — semantically these ARE equivalent
          if (fp1 !== fp2) {
            return { passed: false, violation: `String 'Alpha' and array ['Alpha'] produce different fingerprints — false split`, severity: 'unexpected' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // ===========================================================================
  // X-53: Fingerprint collision across predicate classes
  // Same field values but different types must always be distinct
  // ===========================================================================
  scenarios.push({
    id: nextId('A', 'X53a_crossTypeCollision'),
    family: 'A',
    generator: 'X53a_crossTypeCollision',
    failureClass: 'X-53',
    description: 'X-53: CSS vs content predicates with overlapping field names never collide',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      // type= is always first in parts array, so different types always produce different fingerprints
      fingerprintDistinctness('css_with_pattern_field', 'content_with_pattern_field',
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'red' }),
        () => ({ type: 'content', pattern: 'red', file: 'server.js' } as any),
      ),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('A', 'X53b_httpVsContent'),
    family: 'A',
    generator: 'X53b_httpVsContent',
    failureClass: 'X-53',
    description: 'X-53: HTTP vs content predicates with same path field never collide',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      // Both have path=/api but different types → must be distinct
      fingerprintDistinctness('http_path_api', 'content_path_api',
        () => ({ type: 'http', path: '/api', method: 'GET', expect: { status: 200 } }),
        () => ({ type: 'content', path: '/api', pattern: 'test' } as any),
      ),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('A', 'X53c_cssVsHTML'),
    family: 'A',
    generator: 'X53c_cssVsHTML',
    failureClass: 'X-53',
    description: 'X-53: CSS vs HTML predicates with same selector field never collide',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('css_selector_h1', 'html_selector_h1',
        () => ({ type: 'css', selector: 'h1', property: 'color', expected: 'red' }),
        () => ({ type: 'html', selector: 'h1' }),
      ),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('A', 'X53d_dbVsFilesystem'),
    family: 'A',
    generator: 'X53d_dbVsFilesystem',
    failureClass: 'X-53',
    description: 'X-53: DB vs filesystem predicates never collide even with shared fields',
    edits: [dummyEdit],
    predicates: [],
    config: { gates: { syntax: false, constraints: false, staging: false } },
    invariants: [
      fingerprintDistinctness('db_table_users', 'fs_exists_users',
        () => ({ type: 'db', table: 'users', expected: 'exists' }),
        () => ({ type: 'filesystem_exists', path: 'users' } as any),
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

  // =========================================================================
  // F9 Syntax Gate Scenarios (X-37 through X-41)
  // =========================================================================

  // X-37: Search string not found → F9 fails
  scenarios.push({
    id: nextId('G', 'X37_searchNotFound'),
    family: 'G',
    generator: 'X37_searchStringNotFound',
    failureClass: 'X-37',
    description: 'X-37: Search string not in file — F9 should fail with not_found',
    edits: [{ file: 'server.js', search: 'THIS_STRING_DOES_NOT_EXIST_ANYWHERE', replace: 'replacement' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'replacement' }],
    config: { appDir, gates: { staging: false, browser: false, http: false, grounding: false } },
    invariants: [
      shouldNotCrash('search not found'),
      verifyFailedAt('F9', 'search string not found fails F9'),
    ],
    requiresDocker: false,
  });

  // X-37b: Search string not found with narrowing hint
  scenarios.push({
    id: nextId('G', 'X37b_notFoundNarrowing'),
    family: 'G',
    generator: 'X37b_notFoundNarrowing',
    failureClass: 'X-37',
    description: 'X-37: F9 failure should produce narrowing with resolution hint',
    edits: [{ file: 'server.js', search: 'NONEXISTENT_TOKEN_42', replace: 'bar' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false, grounding: false } },
    invariants: [
      shouldNotCrash('F9 narrowing'),
      verifyFailedAt('F9', 'F9 fail produces narrowing'),
      narrowingPresent(),
    ],
    requiresDocker: false,
  });

  // X-38: Search string found multiple times → F9 fails (ambiguous)
  scenarios.push({
    id: nextId('G', 'X38_ambiguousMatch'),
    family: 'G',
    generator: 'X38_ambiguousMatch',
    failureClass: 'X-38',
    description: 'X-38: Search string matches >1 location — F9 should fail as ambiguous',
    edits: [{ file: 'server.js', search: 'res.end', replace: 'res.end' }], // 'res.end' appears in multiple route handlers
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false, grounding: false } },
    invariants: [
      shouldNotCrash('ambiguous match'),
      verifyFailedAt('F9', 'ambiguous match fails F9'),
    ],
    requiresDocker: false,
  });

  // X-39: Search string with regex special characters — treated as literal
  scenarios.push({
    id: nextId('G', 'X39_regexChars'),
    family: 'G',
    generator: 'X39_regexSpecialChars',
    failureClass: 'X-39',
    description: 'X-39: Search string with regex chars (.*[) treated as literal, not regex',
    edits: [{ file: 'server.js', search: 'res.end(.*[test]', replace: 'replacement' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false, grounding: false } },
    invariants: [
      shouldNotCrash('regex special chars in search'),
      // The literal string "res.end(.*[test]" doesn't exist → F9 fails
      verifyFailedAt('F9', 'regex chars treated as literal'),
    ],
    requiresDocker: false,
  });

  // X-40a: Empty search string
  scenarios.push({
    id: nextId('G', 'X40a_emptySearch'),
    family: 'G',
    generator: 'X40a_emptySearch',
    failureClass: 'X-40',
    description: 'X-40: Empty search string should fail F9 (ambiguous), not crash',
    edits: [{ file: 'server.js', search: '', replace: 'something' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false, grounding: false } },
    invariants: [shouldNotCrash('empty search string'), verifyFailedAt('F9', 'empty search fails F9')],
    requiresDocker: false,
  });

  // X-40b: Empty replace string (deletion)
  scenarios.push({
    id: nextId('G', 'X40b_emptyReplace'),
    family: 'G',
    generator: 'X40b_emptyReplace',
    failureClass: 'X-40',
    description: 'X-40: Empty replace string (deletion) should fail F9 gracefully, not crash',
    edits: [{ file: 'server.js', search: 'placeholder_not_in_file', replace: '' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false, grounding: false } },
    invariants: [shouldNotCrash('empty replace string'), verifyFailedAt('F9', 'empty replace fails F9')],
    requiresDocker: false,
  });

  // X-41: Line ending mismatch — search has \n but file has \r\n (or vice versa)
  scenarios.push({
    id: nextId('G', 'X41_lineEndingMismatch'),
    family: 'G',
    generator: 'X41_lineEndingMismatch',
    failureClass: 'X-41',
    description: 'X-41: Search with \\n in \\r\\n file — F9 should fail (exact match)',
    edits: [{ file: 'server.js', search: 'const http\r\n', replace: 'const http\n' }],
    predicates: [],
    config: { appDir, gates: { staging: false, browser: false, http: false, grounding: false } },
    invariants: [
      shouldNotCrash('line ending mismatch'),
      // server.js uses \n not \r\n, so \r\n search won't match
      verifyFailedAt('F9', 'line ending mismatch fails F9'),
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
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
          // Now manipulate the constraint to be expired by rewriting the JSONL
          const { readFileSync, writeFileSync } = require('fs');
          const { join } = require('path');
          const dataPath = join(stateDir, 'memory.jsonl');
          const raw = readFileSync(dataPath, 'utf-8');
          const lines = raw.split('\n').filter((l: string) => l.trim());
          const rewritten = lines.map((line: string) => {
            try {
              const entry = JSON.parse(line);
              if (entry._op === 'constraint' && entry.data?.expiresAt) {
                entry.data.expiresAt = Date.now() - 1000; // 1 second in the past
              }
              if (entry._op === 'compact' && entry.data?.constraints) {
                for (const c of entry.data.constraints) {
                  if (c.expiresAt) c.expiresAt = Date.now() - 1000;
                }
              }
              return JSON.stringify(entry);
            } catch { return line; }
          }).join('\n') + '\n';
          writeFileSync(dataPath, rewritten);
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
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
        invariants: [k5ShouldPass('different path should not be blocked')],
        requiresDocker: false,
      },
    ],
  });

  // ===========================================================================
  // X-54: Constraint store corruption / partial write
  // If memory.jsonl has a truncated last line, the store should still load
  // all valid entries and not crash. JSONL replay is line-by-line.
  // ===========================================================================
  scenarios.push({
    id: nextId('B', 'X54a_truncatedLine'),
    family: 'B',
    generator: 'X54a_truncatedJSONL',
    failureClass: 'X-54',
    description: 'X-54: Truncated last line in memory.jsonl — store loads valid entries, ignores partial',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      // Step 1: Seed a valid constraint, then corrupt the file by appending a truncated line
      {
        id: nextId('B', 'X54a_step1_corrupt'),
        family: 'B',
        generator: 'X54a_step1',
        description: 'Seed constraint then append truncated JSON line',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: corrupt test',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.x54', property: 'color', expected: 'red' }],
          });
          // Append a truncated (invalid JSON) line to simulate partial write
          const { appendFileSync } = require('fs');
          const { join } = require('path');
          appendFileSync(join(stateDir, 'memory.jsonl'), '{"_op":"constraint","_ts":999,"dat\n');
        },
      },
      // Step 2: Reload store — should not crash, and the valid constraint should still block
      {
        id: nextId('B', 'X54a_step2_verify'),
        family: 'B',
        generator: 'X54a_step2',
        description: 'Reload store after corruption — valid constraint still blocks',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.x54', property: 'color', expected: 'red' }],
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
        invariants: [k5ShouldBlock('valid constraint survives truncated line')],
        requiresDocker: false,
      },
    ],
  });

  scenarios.push({
    id: nextId('B', 'X54b_emptyFile'),
    family: 'B',
    generator: 'X54b_emptyFile',
    failureClass: 'X-54',
    description: 'X-54: Empty memory.jsonl — store loads without crash, zero constraints',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      {
        id: nextId('B', 'X54b_step1_empty'),
        family: 'B',
        generator: 'X54b_step1',
        description: 'Create empty memory.jsonl',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const { writeFileSync, mkdirSync } = require('fs');
          const { join } = require('path');
          mkdirSync(stateDir, { recursive: true });
          writeFileSync(join(stateDir, 'memory.jsonl'), '');
        },
      },
      {
        id: nextId('B', 'X54b_step2_pass'),
        family: 'B',
        generator: 'X54b_step2',
        description: 'K5 with empty store → should pass (zero constraints)',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'blue' }],
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
        invariants: [k5ShouldPass('empty store has no constraints')],
        requiresDocker: false,
      },
    ],
  });

  // ===========================================================================
  // X-55: Concurrent readers observe half-written state
  // Two ConstraintStore instances reading the same file — the second should
  // see what the first wrote (since it's append-only JSONL).
  // ===========================================================================
  scenarios.push({
    id: nextId('B', 'X55a_concurrentReaders'),
    family: 'B',
    generator: 'X55a_concurrentReadWrite',
    failureClass: 'X-55',
    description: 'X-55: Second store instance sees constraint seeded by first instance',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      {
        id: nextId('B', 'X55a_step1_seed'),
        family: 'B',
        generator: 'X55a_step1',
        description: 'Seed constraint with store instance 1',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          // Instance 1 seeds a constraint
          const store1 = new ConstraintStore(stateDir);
          store1.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: x55 test',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.x55', property: 'color', expected: 'green' }],
          });
          // Instance 2 reads the same directory — should see the constraint
          const store2 = new ConstraintStore(stateDir);
          const result = store2.checkConstraints(
            ['server.js'], 'ui',
            [predicateFingerprint({ type: 'css', selector: '.x55', property: 'color', expected: 'green' })],
          );
          if (!result) {
            throw new Error('X-55: Second store instance did NOT see constraint from first instance');
          }
        },
      },
      // Step 2: Verify via normal pipeline — the constraint should still block
      {
        id: nextId('B', 'X55a_step2_verify'),
        family: 'B',
        generator: 'X55a_step2',
        description: 'K5 via pipeline also sees the constraint',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.x55', property: 'color', expected: 'green' }],
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
        invariants: [k5ShouldBlock('constraint visible to all readers')],
        requiresDocker: false,
      },
    ],
  });

  // ===========================================================================
  // X-56: Expired constraint retained inconsistently
  // The store filters expired constraints at check time (lazy expiry).
  // Verify that an expired constraint does NOT fire even when the in-memory
  // array still contains it (it's only filtered at checkConstraints time).
  // Also verify that cleanupSession removes expired constraints from the array.
  // ===========================================================================
  scenarios.push({
    id: nextId('B', 'X56a_lazyExpiry'),
    family: 'B',
    generator: 'X56a_lazyExpiry',
    failureClass: 'X-56',
    description: 'X-56: Expired constraint in-memory but filtered at check time (lazy expiry)',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      {
        id: nextId('B', 'X56a_step1'),
        family: 'B',
        generator: 'X56a_step1',
        description: 'Seed constraint, set expiresAt to past, verify lazy expiry works',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: SESSION_ID, source: 'evidence', error: 'predicate failed: x56 test',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.x56', property: 'color', expected: 'purple' }],
          });
          // Manipulate expiresAt to the past via JSONL rewrite
          const { readFileSync, writeFileSync } = require('fs');
          const { join } = require('path');
          const dataPath = join(stateDir, 'memory.jsonl');
          const raw = readFileSync(dataPath, 'utf-8');
          const lines = raw.split('\n').filter((l: string) => l.trim());
          const rewritten = lines.map((line: string) => {
            try {
              const entry = JSON.parse(line);
              if (entry._op === 'constraint' && entry.data?.expiresAt) {
                entry.data.expiresAt = Date.now() - 60000; // 1 minute in the past
              }
              return JSON.stringify(entry);
            } catch { return line; }
          }).join('\n') + '\n';
          writeFileSync(dataPath, rewritten);
        },
      },
      {
        id: nextId('B', 'X56a_step2_pass'),
        family: 'B',
        generator: 'X56a_step2',
        description: 'Expired constraint does not fire at check time',
        edits: [noopEdit],
        predicates: [{ type: 'css', selector: '.x56', property: 'color', expected: 'purple' }],
        config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
        invariants: [k5ShouldPass('expired constraint should not fire')],
        requiresDocker: false,
      },
    ],
  });

  scenarios.push({
    id: nextId('B', 'X56b_cleanupRemovesExpired'),
    family: 'B',
    generator: 'X56b_cleanupRemovesExpired',
    failureClass: 'X-56',
    description: 'X-56: cleanupSession removes expired constraints from in-memory array',
    edits: [],
    predicates: [],
    config: { appDir },
    invariants: [],
    requiresDocker: false,
    steps: [
      {
        id: nextId('B', 'X56b_step1'),
        family: 'B',
        generator: 'X56b_step1',
        description: 'Seed, expire, cleanup, verify constraint count = 0',
        edits: [],
        predicates: [],
        config: { appDir },
        invariants: [constraintCountEquals(0)],
        requiresDocker: false,
        skipVerify: true,
        beforeStep: (stateDir: string) => {
          const store = new ConstraintStore(stateDir);
          store.seedFromFailure({
            sessionId: 'cleanup-test', source: 'evidence', error: 'predicate failed: x56b test',
            filesTouched: ['server.js'], attempt: 1,
            failedPredicates: [{ type: 'css', selector: '.x56b', property: 'color', expected: 'orange' }],
          });
          // Expire the constraint via JSONL rewrite
          const { readFileSync, writeFileSync } = require('fs');
          const { join } = require('path');
          const dataPath = join(stateDir, 'memory.jsonl');
          const raw = readFileSync(dataPath, 'utf-8');
          const lines = raw.split('\n').filter((l: string) => l.trim());
          const rewritten = lines.map((line: string) => {
            try {
              const entry = JSON.parse(line);
              if (entry._op === 'constraint' && entry.data?.expiresAt) {
                entry.data.expiresAt = Date.now() - 60000;
              }
              return JSON.stringify(entry);
            } catch { return line; }
          }).join('\n') + '\n';
          writeFileSync(dataPath, rewritten);
          // Now call cleanupSession — it should remove expired constraints
          const store2 = new ConstraintStore(stateDir);
          store2.cleanupSession('cleanup-test');
        },
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
        config: { appDir, gates: { grounding: false, staging: true, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
  const dummyEdit: Edit = { file: 'server.js', search: 'placeholder', replace: 'placeholder' };

  // D1: CSS edit with matching CSS predicate → direct attribution
  scenarios.push({
    id: nextId('D', 'D1_directCSS'),
    family: 'D',
    generator: 'D1_directCSS',
    description: 'CSS color edit with CSS predicate should be attributed as direct',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, syntax: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, syntax: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, syntax: false, staging: false, browser: false, http: false } },
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
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      containmentTotalMatchesEdits(),
      containmentCounts(0, 0, 2),
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-01: Correct failure, wrong cause identified
  // CSS edit fails → G5 attributes as "direct" because file matches, but the
  // predicate checks a DIFFERENT property than what was edited. G5's file-level
  // heuristic cannot distinguish property-level causation.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT01a_wrongCauseCSS'),
    family: 'D',
    generator: 'AT01a_wrongCauseCSS',
    failureClass: 'AT-01',
    description: 'AT-01: Edit changes color but predicate checks font-size — G5 still says "direct" (file-level attribution)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'font-size', expected: '2rem' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      // This documents the limitation: G5 attributes as "direct" because the edit
      // file (server.js) is a source file and edit.replace contains "red" — but the
      // predicate checks font-size, not color. G5 matches on expected value presence.
      // The edit replace "color: red" contains "2rem"? No. It matches on property presence.
      // Actually: G5 checks if edit.replace contains p.property ("font-size") or p.expected ("2rem").
      // Since "color: red" contains neither "font-size" nor "2rem", this should be unexplained.
      editAttributed('server.js', 'unexplained'),
      containmentCounts(0, 0, 1),
    ],
    requiresDocker: false,
  });

  // AT-01b: Edit changes color, predicate checks color but different selector.
  // G5 still says "direct" because it matches on p.expected value in edit.replace.
  scenarios.push({
    id: nextId('D', 'AT01b_wrongSelectorMatch'),
    family: 'D',
    generator: 'AT01b_wrongSelectorMatch',
    failureClass: 'AT-01',
    description: 'AT-01: Edit sets color=green, predicate on different selector also expects green — false direct attribution',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: green' }],
    predicates: [{ type: 'css', selector: '.nonexistent', property: 'color', expected: 'green' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      // G5 matches because edit.replace ("color: green") contains p.expected ("green").
      // This is a false "direct" — the predicate targets .nonexistent, not h1.
      editAttributed('server.js', 'direct'),
      containmentCounts(1, 0, 0),
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-02: Multiple causes, single attribution
  // Two edits both match the same predicate. G5 attributes both as "direct"
  // individually — it doesn't distinguish which edit is the actual cause.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT02a_dualDirectAttribution'),
    family: 'D',
    generator: 'AT02a_dualDirectAttribution',
    failureClass: 'AT-02',
    description: 'AT-02: Two edits both match one predicate — both attributed as direct (cannot isolate root cause)',
    edits: [
      { file: 'server.js', search: 'color: #1a1a2e', replace: 'color: orange' },
      { file: 'server.js', search: 'color: #666', replace: 'color: orange' },
    ],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'orange' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      containmentTotalMatchesEdits(),
      // Both edits contain "orange" in replace → both match p.expected → both "direct"
      // G5 can't tell which edit actually satisfies the predicate
      containmentCounts(2, 0, 0),
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-03: Downstream effect mistaken for root cause
  // Error message contains "health check fail" + "SyntaxError". extractSignature
  // uses priority ordering — first match wins. Depending on error string composition,
  // the wrong cause may be identified.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT03a_priorityOverride'),
    family: 'D',
    generator: 'AT03a_priorityOverride',
    failureClass: 'AT-03',
    description: 'AT-03: Error with both "SyntaxError" and "health check fail" — extractSignature picks syntax (first match)',
    edits: [dummyEdit],
    predicates: [],
    config: { appDir, gates: { syntax: false, constraints: false, containment: false, staging: false } },
    invariants: [
      {
        name: 'extractSignature_priority_syntax_over_health',
        category: 'attribution' as const,
        layer: 'product' as const,
        check: () => {
          // Error with both signals: SyntaxError appears first → syntax_error wins
          const sig1 = extractSignature('SyntaxError: Unexpected token at line 5; health check failed');
          if (sig1 !== 'syntax_error') {
            return { passed: false, violation: `Expected 'syntax_error', got '${sig1}'`, severity: 'bug' as const };
          }
          // Reversed order: "health check failed" appears first in text BUT
          // extractSignature uses regex priority ordering, not text position.
          // "syntaxerror" regex (priority 6) comes BEFORE "health check fail" (priority 9).
          // So SyntaxError still wins even when health check text appears first.
          const sig2 = extractSignature('health check failed after SyntaxError');
          if (sig2 !== 'syntax_error') {
            return { passed: false, violation: `Expected 'syntax_error' (regex priority), got '${sig2}'`, severity: 'bug' as const };
          }
          // Document: extractSignature uses regex list priority, NOT text position.
          // This means downstream failure signals (health check) can never mask
          // upstream ones (syntax error) — but the reverse is also true.
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // AT-03b: DNS error (infra) masks a real syntax error (code)
  scenarios.push({
    id: nextId('D', 'AT03b_infraMasksSyntax'),
    family: 'D',
    generator: 'AT03b_infraMasksSyntax',
    failureClass: 'AT-03',
    description: 'AT-03: DNS error appears first in message, masking the real syntax error — wrong signature extracted',
    edits: [dummyEdit],
    predicates: [],
    config: { appDir, gates: { syntax: false, constraints: false, containment: false, staging: false } },
    invariants: [
      {
        name: 'extractSignature_dns_masks_syntax',
        category: 'attribution' as const,
        layer: 'product' as const,
        check: () => {
          const sig = extractSignature('getaddrinfo EAI_AGAIN db:5432 — caused by SyntaxError in server.js');
          if (sig !== 'dns_resolution_failed') {
            return { passed: false, violation: `Expected 'dns_resolution_failed' (first match), got '${sig}'`, severity: 'bug' as const };
          }
          // The real cause (SyntaxError) is lost — this documents the limitation
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-04: Masking failure — real cause hidden
  // Pipeline stops at first failed gate. If F9 fails, K5/G5/staging never run.
  // The first error in narrowing may not be the most useful one.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT04a_firstGateMasksOthers'),
    family: 'D',
    generator: 'AT04a_firstGateMasksOthers',
    failureClass: 'AT-04',
    description: 'AT-04: F9 failure stops pipeline — downstream gate issues never discovered',
    // server.js search string doesn't exist → F9 fails before K5/G5 run
    edits: [{ file: 'server.js', search: 'this_string_does_not_exist_anywhere', replace: 'replacement' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      verifyFailedAt('F9', 'search string not found'),
      // G5 and K5 never run — their potential failures are masked
      gateAbsent('G5', 'F9 failed first — pipeline stopped'),
      narrowingPresent(),
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-05: Accidental correctness
  // Predicate passes by coincidence — the predicate checks something that was
  // already true before the edit, so the edit is irrelevant to the passing check.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT05a_alreadyTrue'),
    family: 'D',
    generator: 'AT05a_alreadyTrue',
    failureClass: 'AT-05',
    description: 'AT-05: Content predicate already passes before edit — edit is irrelevant to predicate satisfaction',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: blue' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Demo App' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      // The predicate matches "Demo App" which already exists in server.js.
      // The edit changes a color — totally unrelated. But G5 attributes as "direct"
      // because predicate.file matches edit.file via content path matching.
      containmentAlwaysPasses(),
      editAttributed('server.js', 'direct'),
      // This documents the limitation: attribution is file-level, not causation-level
    ],
    requiresDocker: false,
  });

  // AT-05b: CSS predicate passes coincidentally because the value already matches.
  // G5 matches on p.property ("color") found in edit.replace ("color: #777"),
  // so it says "direct" even though the predicate's EXPECTED VALUE (#1a1a2e) is
  // unrelated to the edit's change (#666→#777).
  scenarios.push({
    id: nextId('D', 'AT05b_alreadyMatchingCSS'),
    family: 'D',
    generator: 'AT05b_alreadyMatchingCSS',
    failureClass: 'AT-05',
    description: 'AT-05: CSS predicate expects existing value — edit changes something else but G5 matches on property name',
    edits: [{ file: 'server.js', search: 'color: #666', replace: 'color: #777' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#1a1a2e' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      // G5 checks if edit.replace contains p.property ("color"). "color: #777" does contain "color".
      // So G5 attributes as "direct" — false positive (edit is unrelated to this predicate).
      // This documents the limitation: G5 matches on property NAME, not value.
      editAttributed('server.js', 'direct'),
      containmentCounts(1, 0, 0),
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-06: Proxy success — right outcome, wrong reason
  // CSS value matches in source but that's because it's on a different selector.
  // G5 says "direct" because the expected value appears in the replace string.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT06a_valuePresentWrongSelector'),
    family: 'D',
    generator: 'AT06a_valuePresentWrongSelector',
    failureClass: 'AT-06',
    description: 'AT-06: Edit puts value "sans-serif" in replace, predicate expects "sans-serif" on different selector',
    edits: [{ file: 'server.js', search: 'font-family: sans-serif', replace: 'font-family: sans-serif; font-weight: bold' }],
    predicates: [{ type: 'css', selector: '.subtitle', property: 'font-family', expected: 'sans-serif' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      // G5 matches because edit.replace contains "sans-serif" (the expected value).
      // But the edit is on body's font-family, not .subtitle's. The attribution
      // is technically "correct" at file level but misleading at property level.
      editAttributed('server.js', 'direct'),
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-07: Structural validity masks semantic incorrectness
  // The edit is structurally valid (F9 passes) and the containment is clean,
  // but the semantic meaning is wrong. G5 can only check structural attribution.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT07a_structurallyValidSemanticWrong'),
    family: 'D',
    generator: 'AT07a_structurallyValidSemanticWrong',
    failureClass: 'AT-07',
    description: 'AT-07: Edit changes title to "Test" — structurally valid, G5 says direct, but semantic incorrectness undetectable',
    edits: [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Test</title>' }],
    // Predicate asserts title exists (structural) — it will pass.
    // But "Test" is semantically wrong (should be something meaningful).
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Test' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      editAttributed('server.js', 'direct'),
      // G5 says: edit matches predicate ✓. But the semantic intent may be wrong.
      // This documents that containment cannot catch semantic errors.
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-08: Semantic correctness masks structural breakage
  // The edit adds correct business logic but breaks CSS layout.
  // G5 attributes the edit as "direct" for the logic predicate, but the
  // structural CSS damage is invisible to containment.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT08a_logicCorrectCSSBroken'),
    family: 'D',
    generator: 'AT08a_logicCorrectCSSBroken',
    failureClass: 'AT-08',
    description: 'AT-08: Edit correctly adds API response but also breaks CSS — G5 only sees the content match',
    edits: [{ file: 'server.js', search: "{ id: 2, name: 'Beta' },", replace: "{ id: 2, name: 'Beta' },\n      { id: 3, name: 'Gamma' }," }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Gamma' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      containmentAlwaysPasses(),
      editAttributed('server.js', 'direct'),
      // The edit might collaterally break formatting or other structures.
      // G5 only sees "edit file matches predicate file + content" → "direct".
      // CSS or layout damage is invisible at this gate.
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-09: Constraint seeded from wrong failure class
  // extractSignature maps to the first matching regex. When the error string
  // contains multiple failure signals, K5 learns the wrong lesson.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT09a_wrongSignatureSeeded'),
    family: 'D',
    generator: 'AT09a_wrongSignatureSeeded',
    failureClass: 'AT-09',
    description: 'AT-09: extractSignature maps compound error to first regex match — K5 seeds wrong failure class',
    edits: [dummyEdit],
    predicates: [],
    config: { appDir, gates: { syntax: false, constraints: false, containment: false, staging: false } },
    invariants: [
      {
        name: 'wrong_failure_class_seeded',
        category: 'attribution' as const,
        layer: 'product' as const,
        check: () => {
          // "build failure" contains both "build fail" → build_failure AND
          // "exit code 1" → also build_failure. But a compound error like
          // "timeout during build, exit code 1" → "migration_timeout" (first match)
          // even though the real cause is a build failure.
          const sig = extractSignature('timeout during build, exit code 1');
          if (sig !== 'migration_timeout') {
            return { passed: false, violation: `Expected 'migration_timeout' (first match), got '${sig}'`, severity: 'bug' as const };
          }
          // The "real" cause was build failure, but K5 would seed a migration_timeout
          // constraint — wrong lesson learned
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // AT-09b: ECONNREFUSED during staging classified as harness_fault — never seeds K5.
  // But the real cause might be the agent's code crashing on startup.
  scenarios.push({
    id: nextId('D', 'AT09b_harnessFaultMasksAppBug'),
    family: 'D',
    generator: 'AT09b_harnessFaultMasksAppBug',
    failureClass: 'AT-09',
    description: 'AT-09: ECONNREFUSED in staging classified as harness_fault — K5 never learns even if app code caused it',
    edits: [dummyEdit],
    predicates: [],
    config: { appDir, gates: { syntax: false, constraints: false, containment: false, staging: false } },
    invariants: [
      {
        name: 'harness_fault_blocks_learning',
        category: 'attribution' as const,
        layer: 'product' as const,
        check: () => {
          const { classifyFailureKind } = require('../../src/store/constraint-store.js');
          // ECONNREFUSED during staging → harness_fault (container not ready)
          const kind = classifyFailureKind('ECONNREFUSED: connection refused', 'staging');
          if (kind !== 'harness_fault') {
            return { passed: false, violation: `Expected 'harness_fault', got '${kind}'`, severity: 'bug' as const };
          }
          // Same error from post-deploy (evidence source) → 'unknown' because
          // classifyFailureKind only checks ECONNREFUSED for source==='staging'.
          // This is a classification gap: ECONNREFUSED from evidence likely means
          // the app crashed, but it falls through to 'unknown' → no K5 learning.
          const kind2 = classifyFailureKind('ECONNREFUSED: connection refused', 'evidence');
          if (kind2 !== 'unknown') {
            return { passed: false, violation: `Expected 'unknown' (classification gap), got '${kind2}'`, severity: 'bug' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // AT-10: Narrowing hint leads to correct fix for wrong reason
  // Generic resolution hint ("Fix the syntax errors") happens to guide the agent
  // correctly, but the actual problem may be more nuanced.
  // =========================================================================
  scenarios.push({
    id: nextId('D', 'AT10a_genericHintAccidentallyCorrect'),
    family: 'D',
    generator: 'AT10a_genericHintAccidentallyCorrect',
    failureClass: 'AT-10',
    description: 'AT-10: Resolution hint is generic but accidentally guides to correct fix — documents limitation',
    // F9 fails because search string not found
    edits: [{ file: 'server.js', search: 'nonexistent_string_xyz', replace: 'replacement' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      verifyFailedAt('F9', 'search string not found'),
      narrowingPresent(),
      {
        name: 'resolution_hint_is_generic',
        category: 'attribution' as const,
        layer: 'product' as const,
        check: (_scenario, result) => {
          if (result instanceof Error) return { passed: true, severity: 'info' as const };
          if (!result.narrowing?.resolutionHint) {
            return { passed: false, violation: 'No resolution hint on F9 failure', severity: 'bug' as const };
          }
          // The hint should say "search string does not exist" — this is correct
          // but generic. It doesn't say WHICH search string or suggest alternatives.
          const hint = result.narrowing.resolutionHint;
          if (!hint.includes('not exist') && !hint.includes('exact match')) {
            return { passed: false, violation: `Expected F9 hint about search string, got: "${hint}"`, severity: 'bug' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // AT-10b: K5 resolution hint says "try different strategy" — accurate but unhelpful
  scenarios.push({
    id: nextId('D', 'AT10b_k5GenericHint'),
    family: 'D',
    generator: 'AT10b_k5GenericHint',
    failureClass: 'AT-10',
    description: 'AT-10: K5 narrowing says "try different strategy" — correct but gives no specific guidance',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { grounding: false, staging: false, browser: false, http: false } },
    invariants: [
      {
        name: 'k5_hint_generic_but_correct',
        category: 'attribution' as const,
        layer: 'product' as const,
        check: () => {
          // The K5 resolution hint for a generic constraint violation is:
          // "This approach was tried before and failed. Try a different strategy."
          // This is true but not actionable — documents the limitation.
          const hint = buildResolutionHintDirect('K5', 'constraint violation');
          if (!hint.includes('different strategy') && !hint.includes('tried before')) {
            return { passed: false, violation: `Expected generic K5 hint, got: "${hint}"`, severity: 'unexpected' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
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
      { type: 'css', selector: 'h1', property: 'color', expected: '#1a1a2e' },
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

  // ===========================================================================
  // CSS VALUE NORMALIZATION — Taxonomy C-01 through C-08
  // ===========================================================================
  // Each group targets one failure shape from FAILURE-TAXONOMY.md.
  // Tests whether grounding validation correctly handles CSS value equivalences.
  // Demo app has: h1 { color: #1a1a2e }, body { background: #ffffff; color: #333 },
  //              .subtitle { color: #666 }, a.nav-link { color: #0066cc },
  //              footer { color: #999 }, .items li { border-bottom: 1px solid #eee }

  // ── C-01: Named color ↔ hex equivalence ──
  // The grounding gate has _nC() with 26 named colors. Test that:
  // 1. A named color in source matches its hex equivalent in predicate
  // 2. A hex value in source matches its named color equivalent in predicate

  // C-01a: Edit changes h1 color to a named color, predicate uses hex — should be grounded
  scenarios.push({
    id: nextId('E', 'C01a_namedToHex'),
    family: 'E',
    generator: 'C01a_namedToHex',
    failureClass: 'C-01',
    description: 'C-01: Named color "red" in edit matches hex "#ff0000" in predicate',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'named_color_matches_hex'),
    ],
    requiresDocker: false,
  });

  // C-01b: Edit changes h1 color to hex, predicate uses named color — should be grounded
  scenarios.push({
    id: nextId('E', 'C01b_hexToNamed'),
    family: 'E',
    generator: 'C01b_hexToNamed',
    failureClass: 'C-01',
    description: 'C-01: Hex "#ff0000" in edit matches named color "red" in predicate',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'hex_matches_named_color'),
    ],
    requiresDocker: false,
  });

  // C-01c: Named color "navy" already in _NC map — test equivalence with #000080
  scenarios.push({
    id: nextId('E', 'C01c_navyHex'),
    family: 'E',
    generator: 'C01c_navyHex',
    failureClass: 'C-01',
    description: 'C-01: Named color "navy" matches hex "#000080"',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: navy' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#000080' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'navy_matches_hex'),
    ],
    requiresDocker: false,
  });

  // C-01d: Named color NOT in the _NC map — should fail grounding (value mismatch)
  // "rebeccapurple" (#663399) is a valid CSS color but NOT in the 26-entry _NC map
  scenarios.push({
    id: nextId('E', 'C01d_unknownNamed'),
    family: 'E',
    generator: 'C01d_unknownNamedColor',
    failureClass: 'C-01',
    description: 'C-01: Named color "rebeccapurple" NOT in normalizer — should be groundingMiss',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: rebeccapurple' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#663399' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // rebeccapurple is not in _NC, so _nC('rebeccapurple') !== _nC('#663399')
      // grounding will see source value 'rebeccapurple' !== '#663399' → groundingMiss
      predicateIsGroundingMiss(0, 'rebeccapurple_not_in_normalizer'),
    ],
    requiresDocker: false,
  });

  // ── C-02: RGB ↔ hex equivalence ──
  // _nC() normalizes rgb(r,g,b) → hex. Both directions should be grounded.

  // C-02a: Edit uses hex, predicate uses rgb — normalizer converts rgb→hex, match
  scenarios.push({
    id: nextId('E', 'C02a_hexVsRgb'),
    family: 'E',
    generator: 'C02a_hexVsRgb',
    failureClass: 'C-02',
    description: 'C-02: Hex "#ff0000" in edit vs rgb "rgb(255,0,0)" in predicate — normalizer converts rgb→hex (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'rgb(255,0,0)' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'rgb_hex_normalized'),
    ],
    requiresDocker: false,
  });

  // C-02b: Edit uses rgb, predicate uses hex — normalizer converts both to hex, match
  scenarios.push({
    id: nextId('E', 'C02b_rgbVsHex'),
    family: 'E',
    generator: 'C02b_rgbVsHex',
    failureClass: 'C-02',
    description: 'C-02: rgb "rgb(255,0,0)" in edit vs hex "#ff0000" in predicate — normalizer converts rgb→hex (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: rgb(255,0,0)' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'hex_rgb_normalized'),
    ],
    requiresDocker: false,
  });

  // ── C-03: HSL ↔ hex/rgb equivalence ──
  // _nC() normalizes hsl(h,s%,l%) → hex.

  scenarios.push({
    id: nextId('E', 'C03_hslVsHex'),
    family: 'E',
    generator: 'C03_hslVsHex',
    failureClass: 'C-03',
    description: 'C-03: HSL "hsl(0,100%,50%)" vs hex "#ff0000" — normalizer converts hsl→hex (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: hsl(0,100%,50%)' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'hsl_hex_normalized'),
    ],
    requiresDocker: false,
  });

  // ── C-04: RGBA with alpha=1 ↔ RGB ──
  // _nC() normalizes rgba(r,g,b,1) → hex (same as rgb).

  scenarios.push({
    id: nextId('E', 'C04_rgbaVsRgb'),
    family: 'E',
    generator: 'C04_rgbaVsRgb',
    failureClass: 'C-04',
    description: 'C-04: rgba(255,0,0,1) vs rgb(255,0,0) — normalizer strips alpha=1, both→hex (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: rgba(255,0,0,1)' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'rgb(255,0,0)' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'rgba_alpha1_normalized_to_hex'),
    ],
    requiresDocker: false,
  });

  // ── C-05: HSLA with alpha=1 ↔ HSL ──
  // _nC() normalizes hsla(h,s%,l%,1) → hex (same as hsl).

  scenarios.push({
    id: nextId('E', 'C05_hslaVsHsl'),
    family: 'E',
    generator: 'C05_hslaVsHsl',
    failureClass: 'C-05',
    description: 'C-05: hsla(0,100%,50%,1) vs hsl(0,100%,50%) — normalizer strips alpha=1, both→hex (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: hsla(0,100%,50%,1)' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'hsl(0,100%,50%)' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'hsla_alpha1_normalized_to_hex'),
    ],
    requiresDocker: false,
  });

  // ── C-06: Whitespace in CSS values ──
  // _nC() normalizes internal whitespace in rgb/hsl functional notation.

  // C-06a: Whitespace mismatch in value — normalizer strips spaces in rgb()
  scenarios.push({
    id: nextId('E', 'C06a_wsInValue'),
    family: 'E',
    generator: 'C06a_whitespaceInValue',
    failureClass: 'C-06',
    description: 'C-06: "rgb( 255, 0, 0 )" vs "rgb(255,0,0)" — normalizer strips internal whitespace (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: rgb( 255, 0, 0 )' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'rgb(255,0,0)' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'internal_whitespace_normalized'),
    ],
    requiresDocker: false,
  });

  // C-06b: Leading/trailing whitespace — _nC() trims, should match
  scenarios.push({
    id: nextId('E', 'C06b_outerWs'),
    family: 'E',
    generator: 'C06b_outerWhitespace',
    failureClass: 'C-06',
    description: 'C-06: Leading/trailing whitespace in value — _nC() trims, should match',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color:  red ' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'outer_whitespace_trimmed_by_nC'),
    ],
    requiresDocker: false,
  });

  // ── C-07: Casing in CSS values ──
  // _nC() lowercases before lookup. Test that case differences are handled.

  // C-07a: Uppercase hex in edit, lowercase in predicate — _nC lowercases, should match
  scenarios.push({
    id: nextId('E', 'C07a_hexCasing'),
    family: 'E',
    generator: 'C07a_hexCaseNormalize',
    failureClass: 'C-07',
    description: 'C-07: "#FF0000" in edit vs "#ff0000" in predicate — _nC lowercases (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #FF0000' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'hex_case_normalized'),
    ],
    requiresDocker: false,
  });

  // C-07b: Mixed case named color — "Red" vs "red"
  scenarios.push({
    id: nextId('E', 'C07b_namedCasing'),
    family: 'E',
    generator: 'C07b_namedColorCase',
    failureClass: 'C-07',
    description: 'C-07: "Red" (capitalized) vs "red" (lowercase) — _nC lowercases (grounded)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: Red' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'named_color_case_normalized'),
    ],
    requiresDocker: false,
  });

  // C-07c: Mixed case named color to hex — "RED" → #ff0000
  scenarios.push({
    id: nextId('E', 'C07c_upperNamedToHex'),
    family: 'E',
    generator: 'C07c_upperNamedToHex',
    failureClass: 'C-07',
    description: 'C-07: "RED" (all caps) matches hex "#ff0000" via _nC lowercase + lookup',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: RED' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'upper_named_to_hex'),
    ],
    requiresDocker: false,
  });

  // ── C-08: Zero equivalences ──
  // _nC() normalizes 0px, 0em, 0rem, 0%, etc. → "0". All zeros are equivalent.

  // C-08a: 0 vs 0px — normalizer converts 0px → 0, match
  scenarios.push({
    id: nextId('E', 'C08a_zeroVsZeroPx'),
    family: 'E',
    generator: 'C08a_zeroVsZeroPx',
    failureClass: 'C-08',
    description: 'C-08: "0" in edit vs "0px" in predicate — normalizer converts 0px→0 (grounded)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 0' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '0px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'zero_unit_normalized'),
    ],
    requiresDocker: false,
  });

  // C-08b: 0px vs 0 — normalizer converts both to "0", match
  scenarios.push({
    id: nextId('E', 'C08b_zeroPxVsZero'),
    family: 'E',
    generator: 'C08b_zeroPxVsZero',
    failureClass: 'C-08',
    description: 'C-08: "0px" in edit vs "0" in predicate — normalizer converts 0px→0 (grounded)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 0px' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '0' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'zero_px_normalized_to_zero'),
    ],
    requiresDocker: false,
  });

  // C-08c: 0em vs 0rem — normalizer converts both to "0", match
  scenarios.push({
    id: nextId('E', 'C08c_zeroEmVsRem'),
    family: 'E',
    generator: 'C08c_zeroEmVsRem',
    failureClass: 'C-08',
    description: 'C-08: "0em" vs "0rem" — normalizer converts both→0 (grounded)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 0em' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '0rem' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'zero_em_rem_normalized'),
    ],
    requiresDocker: false,
  });

  // ─── C-09: calc() expressions ───
  // calc() can't be resolved statically — grounding gate can't know the computed value
  scenarios.push({
    id: nextId('E', 'C09a_calcExpression'),
    family: 'E',
    generator: 'C09a_calcExpression',
    failureClass: 'C-09',
    description: 'C-09: Edit uses calc() — predicate expects computed result (groundingMiss)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: calc(2rem - 4px)' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '28px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'calc_not_resolvable_statically'),
    ],
    requiresDocker: false,
  });

  // C-09b: Edit uses calc() and predicate also uses calc() — substring match works
  scenarios.push({
    id: nextId('E', 'C09b_calcMatchesCalc'),
    family: 'E',
    generator: 'C09b_calcMatchesCalc',
    failureClass: 'C-09',
    description: 'C-09: Edit calc() matches predicate calc() via substring (grounded)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: calc(100% - 20px)' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: 'calc(100% - 20px)' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'calc_literal_substring_match'),
    ],
    requiresDocker: false,
  });

  // ─── C-10: CSS custom properties (var()) ───
  // The predicate expects #1a1a2e, and the source currently HAS #1a1a2e on h1.
  // The edit changes it to var(--primary), but grounding checks the SOURCE value
  // against expected — they match, so grounding considers it grounded.
  // This is a false positive: the edit will change the value to something the gate can't resolve.
  scenarios.push({
    id: nextId('E', 'C10a_varFunctionGap'),
    family: 'E',
    generator: 'C10a_varFunctionGap',
    failureClass: 'C-10',
    description: 'C-10: Edit uses var(--x) — source value matches predicate so grounding passes (false confidence)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: var(--primary)' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#1a1a2e' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'var_source_value_matches_false_confidence'),
    ],
    requiresDocker: false,
  });

  // ─── C-11: auto/inherit/initial/unset keywords ───
  scenarios.push({
    id: nextId('E', 'C11a_autoKeyword'),
    family: 'E',
    generator: 'C11a_autoKeyword',
    failureClass: 'C-11',
    description: 'C-11: Edit uses "auto" — predicate expects computed value (groundingMiss)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: auto' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '0px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'auto_keyword_not_resolvable'),
    ],
    requiresDocker: false,
  });

  // C-11b: Edit uses "inherit" — predicate expects parent value
  scenarios.push({
    id: nextId('E', 'C11b_inheritKeyword'),
    family: 'E',
    generator: 'C11b_inheritKeyword',
    failureClass: 'C-11',
    description: 'C-11: Edit uses "inherit" — predicate expects parent value (groundingMiss)',
    edits: [{ file: 'server.js', search: 'color: #666', replace: 'color: inherit' }],
    predicates: [{ type: 'css', selector: '.subtitle', property: 'color', expected: '#333' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'inherit_not_resolvable'),
    ],
    requiresDocker: false,
  });

  // ─── C-12: !important override ───
  scenarios.push({
    id: nextId('E', 'C12a_importantOverride'),
    family: 'E',
    generator: 'C12a_importantOverride',
    failureClass: 'C-12',
    description: 'C-12: Edit adds !important — value substring match works despite !important',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000 !important' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // !important is part of the value string — substring match should work
      predicateIsGrounded(0, 'important_value_substring_match'),
    ],
    requiresDocker: false,
  });

  // ─── C-13: Relative unit equivalence ───
  scenarios.push({
    id: nextId('E', 'C13a_emVsPx'),
    family: 'E',
    generator: 'C13a_emVsPx',
    failureClass: 'C-13',
    description: 'C-13: Edit uses "2em" — predicate expects "32px" (groundingMiss, context-dependent)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 2em' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '32px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'em_to_px_context_dependent'),
    ],
    requiresDocker: false,
  });

  // ─── C-14: Percentage values ───
  scenarios.push({
    id: nextId('E', 'C14a_percentVsPx'),
    family: 'E',
    generator: 'C14a_percentVsPx',
    failureClass: 'C-14',
    description: 'C-14: Edit uses "50%" — predicate expects pixel value (groundingMiss)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 50%' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '500px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'percent_to_px_context_dependent'),
    ],
    requiresDocker: false,
  });

  // ─── C-15: Multiple values on one property ───
  // Edit adds transition property to a.nav-link, but grounding checks source CSS first.
  // a.nav-link only has "color" in source — "transition" property not found → groundingMiss.
  // This is correct: grounding doesn't see that the edit introduces a new property.
  scenarios.push({
    id: nextId('E', 'C15a_multiValueTransition'),
    family: 'E',
    generator: 'C15a_multiValueTransition',
    failureClass: 'C-15',
    description: 'C-15: Edit adds new property — grounding rejects because property not in source (groundingMiss)',
    edits: [{ file: 'server.js', search: 'color: #0066cc', replace: 'color: #0066cc; transition: color 0.3s, opacity 0.5s' }],
    predicates: [{ type: 'css', selector: 'a.nav-link', property: 'transition', expected: 'color 0.3s' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'new_property_not_in_source'),
    ],
    requiresDocker: false,
  });

  // ─── C-16: Browser-specific prefixes ───
  scenarios.push({
    id: nextId('E', 'C16a_webkitPrefix'),
    family: 'E',
    generator: 'C16a_webkitPrefix',
    failureClass: 'C-16',
    description: 'C-16: Edit uses -webkit-transform — predicate checks transform (groundingMiss)',
    edits: [{ file: 'server.js', search: 'font-size: 2rem', replace: 'font-size: 2rem; -webkit-transform: rotate(5deg)' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'transform', expected: 'rotate(5deg)' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // -webkit-transform is a different property than transform — grounding won't find it
      predicateIsGroundingMiss(0, 'vendor_prefix_not_mapped'),
    ],
    requiresDocker: false,
  });

  // ─── C-44: Fractional rounding differences ───
  scenarios.push({
    id: nextId('E', 'C44a_fractionalRounding'),
    family: 'E',
    generator: 'C44a_fractionalRounding',
    failureClass: 'C-44',
    description: 'C-44: Edit uses 33.3333% — predicate expects rounded 33.33% (groundingMiss)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 33.3333%' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '33.33%' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'fractional_rounding_mismatch'),
    ],
    requiresDocker: false,
  });

  // ─── C-45: normal keyword resolution ───
  scenarios.push({
    id: nextId('E', 'C45a_normalKeyword'),
    family: 'E',
    generator: 'C45a_normalKeyword',
    failureClass: 'C-45',
    description: 'C-45: Edit sets font-weight: normal — predicate expects "400" (groundingMiss)',
    edits: [{ file: 'server.js', search: 'font-size: 2rem', replace: 'font-size: 2rem; font-weight: normal' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'font-weight', expected: '400' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'normal_not_mapped_to_400'),
    ],
    requiresDocker: false,
  });

  // ─── C-46: Font family normalization ───
  scenarios.push({
    id: nextId('E', 'C46a_fontFamilyQuoting'),
    family: 'E',
    generator: 'C46a_fontFamilyQuoting',
    failureClass: 'C-46',
    description: 'C-46: Edit uses quoted font — predicate uses unquoted (groundingMiss)',
    edits: [{ file: 'server.js', search: 'font-family: sans-serif', replace: 'font-family: "Helvetica Neue", sans-serif' }],
    predicates: [{ type: 'css', selector: 'body', property: 'font-family', expected: 'Helvetica Neue, sans-serif' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // Quoted vs unquoted — substring match won't work because quotes are part of value
      predicateIsGroundingMiss(0, 'font_family_quoting_mismatch'),
    ],
    requiresDocker: false,
  });

  // ─── C-49: Modern color syntax (space-separated) ───
  scenarios.push({
    id: nextId('E', 'C49a_modernColorSyntax'),
    family: 'E',
    generator: 'C49a_modernColorSyntax',
    failureClass: 'C-49',
    description: 'C-49: Edit uses modern rgb(255 0 0 / 1) — predicate expects legacy rgb(255,0,0) (groundingMiss)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: rgb(255 0 0 / 1)' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'rgb(255, 0, 0)' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'modern_vs_legacy_color_syntax'),
    ],
    requiresDocker: false,
  });

  // ─── C-51: Invalid value silently dropped ───
  scenarios.push({
    id: nextId('E', 'C51a_invalidValueDropped'),
    family: 'E',
    generator: 'C51a_invalidValueDropped',
    failureClass: 'C-51',
    description: 'C-51: Edit sets invalid color value — browser drops it, predicate expects inherited (groundingMiss)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: notacolor' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'color', expected: '#333' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // grounding sees "notacolor" in the source, predicate expects "#333" — no match
      predicateIsGroundingMiss(0, 'invalid_value_drops_to_inherited'),
    ],
    requiresDocker: false,
  });

  // ─── C-52: rem depends on root font-size ───
  scenarios.push({
    id: nextId('E', 'C52a_remContextDependent'),
    family: 'E',
    generator: 'C52a_remContextDependent',
    failureClass: 'C-52',
    description: 'C-52: Edit uses 3rem — predicate expects 48px (groundingMiss, root-relative)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 3rem' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin', expected: '48px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'rem_to_px_root_dependent'),
    ],
    requiresDocker: false,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CSS SHORTHAND RESOLUTION (C-17 through C-30)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── C-17: border → border-width/style/color ───
  // Demo-app has: `.items li { border-bottom: 1px solid #eee }`
  // Grounding _SH maps border → [border-width, border-style, border-color]
  // but border-bottom is NOT in _SH — it's a directional variant

  // C-17a: Edit shorthand border, predicate checks border-width — uses _SH resolution
  scenarios.push({
    id: nextId('E', 'C17a_borderToWidth'),
    family: 'E',
    generator: 'C17a_borderToWidth',
    failureClass: 'C-17',
    description: 'C-17: Edit "border: 2px dashed red" — predicate checks border-width (shorthand resolved)',
    edits: [{ file: 'server.js', search: 'border-bottom: 1px solid #eee', replace: 'border: 2px dashed red' }],
    predicates: [{ type: 'css', selector: '.items li', property: 'border-width', expected: '2px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // _SH maps border → [border-width, border-style, border-color]
      // editWouldChange: rep has 'border-width' via shorthand resolution
      // But wait — source has border-bottom, not border. Selector .items li exists,
      // border-width is not directly on it. Shorthand check: _SH['border'] includes 'border-width',
      // but source has 'border-bottom' not 'border'. So propertyFound will be false.
      predicateIsGroundingMiss(0, 'border_bottom_not_in_shorthand_map'),
    ],
    requiresDocker: false,
  });

  // C-17b: Edit changes border-bottom, predicate checks border-bottom (direct property)
  scenarios.push({
    id: nextId('E', 'C17b_borderBottomDirect'),
    family: 'E',
    generator: 'C17b_borderBottomDirect',
    failureClass: 'C-17',
    description: 'C-17: Edit border-bottom value — predicate checks border-bottom directly (grounded)',
    edits: [{ file: 'server.js', search: 'border-bottom: 1px solid #eee', replace: 'border-bottom: 2px dashed #ccc' }],
    predicates: [{ type: 'css', selector: '.items li', property: 'border-bottom', expected: '2px dashed #ccc' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'border_bottom_direct_property_match'),
    ],
    requiresDocker: false,
  });

  // ─── C-18: margin → directional components ───
  // Demo-app has: `body { margin: 2rem }` — single-value shorthand (all sides same)
  // _SH maps margin → [margin-top, margin-right, margin-bottom, margin-left]

  // C-18a: Edit changes margin shorthand, predicate checks margin-top
  scenarios.push({
    id: nextId('E', 'C18a_marginToTop'),
    family: 'E',
    generator: 'C18a_marginToTop',
    failureClass: 'C-18',
    description: 'C-18: Edit "margin: 10px 20px" — predicate checks margin-top via shorthand (grounded)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 10px 20px' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin-top', expected: '10px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // _SH resolves margin → margin-top at index 0 → first token "10px" ✓
      predicateIsGrounded(0, 'margin_shorthand_to_top_resolved'),
    ],
    requiresDocker: false,
  });

  // C-18b: Edit changes margin shorthand, predicate checks margin-right (2nd token)
  scenarios.push({
    id: nextId('E', 'C18b_marginToRight'),
    family: 'E',
    generator: 'C18b_marginToRight',
    failureClass: 'C-18',
    description: 'C-18: Edit "margin: 10px 20px" — predicate checks margin-right (2nd token, grounded)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 10px 20px' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin-right', expected: '20px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // _SH resolves margin → margin-right at index 1 → second token "20px" ✓
      predicateIsGrounded(0, 'margin_shorthand_to_right_resolved'),
    ],
    requiresDocker: false,
  });

  // C-18c: 4-value margin — predicate checks margin-bottom (3rd token)
  scenarios.push({
    id: nextId('E', 'C18c_marginToBottom'),
    family: 'E',
    generator: 'C18c_marginToBottom',
    failureClass: 'C-18',
    description: 'C-18: Edit "margin: 5px 10px 15px 20px" — predicate checks margin-bottom (3rd token)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 5px 10px 15px 20px' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin-bottom', expected: '15px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // _rS splits "5px 10px 15px 20px" → token at index 2 (margin-bottom) = "15px"
      predicateIsGrounded(0, 'margin_4value_bottom_resolved'),
    ],
    requiresDocker: false,
  });

  // C-18d: 2-value margin — predicate checks margin-bottom (browser wraps to 3rd position but _rS uses token index)
  // CSS spec: "margin: 10px 20px" → top=10px right=20px bottom=10px left=20px
  // _rS tokenizes "10px 20px" → tokens[2] = undefined
  // Grounding result: propertyFound via _SH → true, _shVal = undefined,
  // editWouldChange shorthand check → undefined, no direct property 'margin-bottom' in source.
  // Gate can't prove a mismatch → passes through as grounded (false confidence).
  scenarios.push({
    id: nextId('E', 'C18d_margin2valuBottomGap'),
    family: 'E',
    generator: 'C18d_margin2valuBottomGap',
    failureClass: 'C-18',
    description: 'C-18: Edit "margin: 10px 20px" — predicate checks margin-bottom (index OOB → false confidence)',
    edits: [{ file: 'server.js', search: 'margin: 2rem', replace: 'margin: 10px 20px' }],
    predicates: [{ type: 'css', selector: 'body', property: 'margin-bottom', expected: '10px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // _rS returns undefined for index 2 with only 2 tokens
      // Gate can't detect mismatch when shorthand resolve returns undefined → grounded
      predicateIsGrounded(0, 'margin_2value_bottom_false_confidence'),
    ],
    requiresDocker: false,
  });

  // ─── C-19: padding → directional components ───
  // Demo-app has: `.items li { padding: 0.5rem 0 }` — 2-value shorthand
  scenarios.push({
    id: nextId('E', 'C19a_paddingToTop'),
    family: 'E',
    generator: 'C19a_paddingToTop',
    failureClass: 'C-19',
    description: 'C-19: Edit "padding: 1rem 2rem" — predicate checks padding-top (grounded)',
    edits: [{ file: 'server.js', search: 'padding: 0.5rem 0', replace: 'padding: 1rem 2rem' }],
    predicates: [{ type: 'css', selector: '.items li', property: 'padding-top', expected: '1rem' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'padding_shorthand_to_top_resolved'),
    ],
    requiresDocker: false,
  });

  // ─── C-20: background → longhand components ───
  // Demo-app has: `body { background: #ffffff }` — simple background shorthand
  // _SH maps background → [background-color]
  scenarios.push({
    id: nextId('E', 'C20a_backgroundToColor'),
    family: 'E',
    generator: 'C20a_backgroundToColor',
    failureClass: 'C-20',
    description: 'C-20: Edit "background: #ff0000" — predicate checks background-color (grounded)',
    edits: [{ file: 'server.js', search: 'background: #ffffff', replace: 'background: #ff0000' }],
    predicates: [{ type: 'css', selector: 'body', property: 'background-color', expected: '#ff0000' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // _SH maps background → [background-color], index 0 → first token "#ff0000"
      predicateIsGrounded(0, 'background_to_color_resolved'),
    ],
    requiresDocker: false,
  });

  // C-20b: Complex background shorthand — more tokens than _SH expects
  scenarios.push({
    id: nextId('E', 'C20b_complexBackground'),
    family: 'E',
    generator: 'C20b_complexBackground',
    failureClass: 'C-20',
    description: 'C-20: Edit "background: url(bg.png) center/cover #333" — predicate checks background-color (gap)',
    edits: [{ file: 'server.js', search: 'background: #ffffff', replace: 'background: url(bg.png) center/cover #333' }],
    predicates: [{ type: 'css', selector: 'body', property: 'background-color', expected: '#333' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // _SH maps background → [background-color] at index 0
      // _rS tokenizes "url(bg.png) center/cover #333" → tokens[0] = "url(bg.png)"
      // That doesn't match "#333" — the color is at the end, not positional
      predicateIsGroundingMiss(0, 'complex_background_positional_mismatch'),
    ],
    requiresDocker: false,
  });

  // ─── C-21: font → size/weight/family/style ───
  // _SH maps font → [font-style, font-variant, font-weight, font-size, line-height, font-family]
  // Demo-app doesn't have a font shorthand, so we test with an edit that adds one
  scenarios.push({
    id: nextId('E', 'C21a_fontToSize'),
    family: 'E',
    generator: 'C21a_fontToSize',
    failureClass: 'C-21',
    description: 'C-21: Edit uses font shorthand — predicate checks font-size (grounded if token matches)',
    edits: [{ file: 'server.js', search: 'font-family: sans-serif', replace: 'font: normal normal bold 16px/1.5 sans-serif' }],
    predicates: [{ type: 'css', selector: 'body', property: 'font-size', expected: '16px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // Source has font-family, not font. Property font-size is NOT in source.
      // _SH check: font includes font-size, and source has... font-family, not font.
      // So propertyFound = false (font-family is in source, but that's a different property)
      // Wait — _SH['font'] includes 'font-size'. Source has 'font-family' property.
      // 'font' shorthand is NOT a key in source CSS for body. So propertyFound via _SH
      // requires 'font' to be in source. It's not — 'font-family' is in source.
      predicateIsGroundingMiss(0, 'font_shorthand_not_in_source'),
    ],
    requiresDocker: false,
  });

  // ─── C-24: animation shorthand ───
  // Not in _SH, not in demo-app. Test that adding animation → checking animation-name fails.
  scenarios.push({
    id: nextId('E', 'C24a_animationNotInMap'),
    family: 'E',
    generator: 'C24a_animationNotInMap',
    failureClass: 'C-24',
    description: 'C-24: Edit adds animation shorthand — predicate checks animation-name (not in _SH map)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #1a1a2e; animation: spin 2s linear infinite' }],
    predicates: [{ type: 'css', selector: 'h1', property: 'animation-name', expected: 'spin' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // animation-name not found on h1 (only color, font-size), not in _SH longhands
      predicateIsGroundingMiss(0, 'animation_name_not_in_shorthand_map'),
    ],
    requiresDocker: false,
  });

  // ─── C-25: transition shorthand ───
  // Not in _SH. Same pattern as animation.
  scenarios.push({
    id: nextId('E', 'C25a_transitionNotInMap'),
    family: 'E',
    generator: 'C25a_transitionNotInMap',
    failureClass: 'C-25',
    description: 'C-25: Edit adds transition — predicate checks transition-duration (not in _SH map)',
    edits: [{ file: 'server.js', search: 'color: #0066cc', replace: 'color: #0066cc; transition: color 0.3s ease' }],
    predicates: [{ type: 'css', selector: 'a.nav-link', property: 'transition-duration', expected: '0.3s' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'transition_duration_not_in_shorthand_map'),
    ],
    requiresDocker: false,
  });

  // ─── C-28: outline shorthand → width/style/color ───
  // _SH maps outline → [outline-width, outline-style, outline-color]
  scenarios.push({
    id: nextId('E', 'C28a_outlineToWidth'),
    family: 'E',
    generator: 'C28a_outlineToWidth',
    failureClass: 'C-28',
    description: 'C-28: Edit adds outline shorthand — predicate checks outline-width (not in source = miss)',
    edits: [{ file: 'server.js', search: 'color: #0066cc', replace: 'color: #0066cc; outline: 2px solid blue' }],
    predicates: [{ type: 'css', selector: 'a.nav-link', property: 'outline-width', expected: '2px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // outline-width: _SH['outline'] includes 'outline-width'
      // but source has no 'outline' property on a.nav-link → propertyFound = false
      predicateIsGroundingMiss(0, 'outline_not_in_source'),
    ],
    requiresDocker: false,
  });

  // ─── C-30: Shorthand component ordering ambiguity ───
  // border: "1px solid red" — which token maps to which longhand?
  // _rS does positional: index 0 = border-width, 1 = border-style, 2 = border-color
  scenarios.push({
    id: nextId('E', 'C30a_borderOrderAmbiguity'),
    family: 'E',
    generator: 'C30a_borderOrderAmbiguity',
    failureClass: 'C-30',
    description: 'C-30: border "solid 1px red" — CSS is order-independent but _rS is positional (gap)',
    edits: [{ file: 'server.js', search: 'border-bottom: 1px solid #eee', replace: 'border: solid 1px red' }],
    predicates: [{ type: 'css', selector: '.items li', property: 'border-width', expected: '1px' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // Source has border-bottom, not border. _SH['border'] includes border-width,
      // but source doesn't have 'border'. propertyFound = false → groundingMiss
      // (This also documents the ordering issue — if border WERE in source,
      // _rS would give "solid" at index 0 for border-width, which is wrong)
      predicateIsGroundingMiss(0, 'border_bottom_not_mapped_plus_ordering'),
    ],
    requiresDocker: false,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTENT PATTERN MATCHING (N-04 through N-08)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── N-04: Regex vs literal matching ───
  // Content gate uses includes() — pure literal substring, no regex.
  // A dot in the pattern matches literal dot, not "any character".

  // N-04a: Pattern with dot — matches literally (correct for includes())
  scenarios.push({
    id: nextId('E', 'N04a_dotLiteral'),
    family: 'E',
    generator: 'N04a_dotLiteral',
    failureClass: 'N-04',
    description: 'N-04: Pattern "process.env" matches literally via includes() (grounded)',
    edits: [{ file: 'server.js', search: 'const PORT = process.env.PORT || 3000', replace: 'const PORT = process.env.PORT || 4000' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'process.env' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // "process.env" is in server.js source → grounded
      predicateIsGrounded(0, 'dot_is_literal_in_includes'),
    ],
    requiresDocker: false,
  });

  // N-04b: Pattern with regex-special chars — includes() treats literally
  scenarios.push({
    id: nextId('E', 'N04b_regexSpecialChars'),
    family: 'E',
    generator: 'N04b_regexSpecialChars',
    failureClass: 'N-04',
    description: 'N-04: Pattern with regex chars "res.end(" matches literally (grounded)',
    edits: [{ file: 'server.js', search: "res.end('Not Found')", replace: "res.end('Not Here')" }],
    predicates: [{ type: 'content', file: 'server.js', pattern: "res.end('Not Here')" }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // Pattern not in source, but edit.replace includes it → grounded
      predicateIsGrounded(0, 'regex_chars_literal_edit_creates'),
    ],
    requiresDocker: false,
  });

  // ─── N-05: Multi-line pattern matching ───
  // includes() works across lines since the file is read as a single string

  // N-05a: Pattern spans line boundary — still matches with includes()
  scenarios.push({
    id: nextId('E', 'N05a_multiLineMatch'),
    family: 'E',
    generator: 'N05a_multiLineMatch',
    failureClass: 'N-05',
    description: 'N-05: Pattern spans line boundary — includes() matches across lines (grounded)',
    edits: [{ file: 'server.js', search: "res.end('Not Found')", replace: "res.end('Not Found')" }],
    predicates: [{ type: 'content', file: 'server.js', pattern: "Content-Type': 'application/json' });\n    res.end" }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // server.js has this exact cross-line pattern → grounded
      predicateIsGrounded(0, 'multiline_includes_works'),
    ],
    requiresDocker: false,
  });

  // ─── N-06: Pattern in comment vs code ───
  // includes() can't distinguish comment from code

  // N-06a: Pattern exists in source but edit replaces it — grounded via edit
  scenarios.push({
    id: nextId('E', 'N06a_patternInComment'),
    family: 'E',
    generator: 'N06a_patternInComment',
    failureClass: 'N-06',
    description: 'N-06: Edit adds comment with pattern — includes() matches comment text (grounded)',
    edits: [{ file: 'server.js', search: "const PORT = process.env.PORT || 3000", replace: "// PORT: use environment variable\nconst PORT = process.env.PORT || 3000" }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'PORT: use environment variable' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // Pattern not in source, but edit.replace includes it → grounded
      predicateIsGrounded(0, 'comment_pattern_edit_creates'),
    ],
    requiresDocker: false,
  });

  // ─── N-07: Case sensitivity ───
  // includes() is case-sensitive

  // N-07a: Correct case — matches
  scenarios.push({
    id: nextId('E', 'N07a_correctCase'),
    family: 'E',
    generator: 'N07a_correctCase',
    failureClass: 'N-07',
    description: 'N-07: Pattern with correct case "Demo App" matches (grounded)',
    edits: [{ file: 'server.js', search: "res.end('Not Found')", replace: "res.end('Not Found')" }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Demo App' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGrounded(0, 'case_sensitive_match'),
    ],
    requiresDocker: false,
  });

  // N-07b: Wrong case — doesn't match
  scenarios.push({
    id: nextId('E', 'N07b_wrongCase'),
    family: 'E',
    generator: 'N07b_wrongCase',
    failureClass: 'N-07',
    description: 'N-07: Pattern "demo app" (lowercase) fails case-sensitive includes() (groundingMiss)',
    edits: [{ file: 'server.js', search: "res.end('Not Found')", replace: "res.end('Not Found')" }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'demo app' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // "Demo App" in source, but includes("demo app") is false
      predicateIsGroundingMiss(0, 'case_sensitive_mismatch'),
    ],
    requiresDocker: false,
  });

  // ─── N-08: Partial match vs full match ───
  // includes() is a substring match — "color" matches "background-color"

  // N-08a: Short pattern matches as substring of longer token
  scenarios.push({
    id: nextId('E', 'N08a_substringMatch'),
    family: 'E',
    generator: 'N08a_substringMatch',
    failureClass: 'N-08',
    description: 'N-08: Pattern "color" matches "background-color" via substring (grounded — false positive)',
    edits: [{ file: 'server.js', search: "res.end('Not Found')", replace: "res.end('Not Found')" }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'color' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      // "color" is a substring of many things in server.js (background-color, color, etc.)
      predicateIsGrounded(0, 'substring_false_positive'),
    ],
    requiresDocker: false,
  });

  // N-08b: Pattern that doesn't match anything
  scenarios.push({
    id: nextId('E', 'N08b_noMatch'),
    family: 'E',
    generator: 'N08b_noMatch',
    failureClass: 'N-08',
    description: 'N-08: Pattern "xyzzy_unique_token" not in file and no edit creates it (groundingMiss)',
    edits: [{ file: 'server.js', search: "res.end('Not Found')", replace: "res.end('Not Found')" }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'xyzzy_unique_token' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      groundingRan(),
      predicateIsGroundingMiss(0, 'pattern_not_found_no_edit'),
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
// FAMILY H: FILESYSTEM GATE — Beyond-Code Verification
// =============================================================================
// Tests the 4 filesystem predicate types:
//   filesystem_exists, filesystem_absent, filesystem_unchanged, filesystem_count
// Proves verify works for file system agents, not just code agents.
// No Docker required. Pure filesystem reads.

function generateFamilyH(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // Ensure fixture files exist for filesystem tests
  const fsFixtureDir = join(appDir, 'test-data');
  if (!existsSync(fsFixtureDir)) {
    mkdirSync(fsFixtureDir, { recursive: true });
  }
  const fixtureFile = join(fsFixtureDir, 'sample.txt');
  if (!existsSync(fixtureFile)) {
    writeFileSync(fixtureFile, 'hello world\n');
  }
  const fixtureFileHash = hashFile(fixtureFile);

  // H1: filesystem_exists — passes for a file that exists
  scenarios.push({
    id: nextId('H', 'fs_exists_pass'),
    family: 'H',
    generator: 'fs_exists_pass',
    description: 'filesystem_exists passes when target file exists',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" }, // no-op edit
    ],
    predicates: [
      { type: 'filesystem_exists', file: 'test-data/sample.txt', description: 'Sample file exists' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifySucceeded('filesystem_exists should pass for existing file'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // H2: filesystem_exists — fails for a non-existent file
  scenarios.push({
    id: nextId('H', 'fs_exists_fail'),
    family: 'H',
    generator: 'fs_exists_fail',
    description: 'filesystem_exists fails when target file does not exist',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_exists', file: 'nonexistent/phantom.txt', description: 'File should not exist' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifyFailedAt('filesystem', 'should fail when file missing'),
      filesystemGateRan(),
      filesystemGateFailed('nonexistent file triggers failure'),
      narrowingPresent(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // H3: filesystem_absent — passes when file does not exist
  // Grounding disabled: grounding marks trivially-absent paths as groundingMiss,
  // but here we're testing the filesystem gate itself, not the grounding gate.
  scenarios.push({
    id: nextId('H', 'fs_absent_pass'),
    family: 'H',
    generator: 'fs_absent_pass',
    description: 'filesystem_absent passes when target file does not exist',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_absent', file: 'nonexistent/phantom.txt', description: 'File should not exist' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { grounding: false, staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifySucceeded('filesystem_absent should pass for missing file'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // H4: filesystem_absent — fails when file exists
  scenarios.push({
    id: nextId('H', 'fs_absent_fail'),
    family: 'H',
    generator: 'fs_absent_fail',
    description: 'filesystem_absent fails when target file exists',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_absent', file: 'test-data/sample.txt', description: 'File exists but should be absent' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifyFailedAt('filesystem', 'should fail when file unexpectedly exists'),
      filesystemGateRan(),
      filesystemGateFailed('existing file triggers absent failure'),
      narrowingPresent(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // H5: filesystem_unchanged — passes with correct hash
  scenarios.push({
    id: nextId('H', 'fs_unchanged_pass'),
    family: 'H',
    generator: 'fs_unchanged_pass',
    description: 'filesystem_unchanged passes when file hash matches',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/sample.txt', hash: fixtureFileHash, description: 'File hash should match' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifySucceeded('filesystem_unchanged should pass with matching hash'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // H6: filesystem_unchanged — fails with wrong hash
  scenarios.push({
    id: nextId('H', 'fs_unchanged_fail'),
    family: 'H',
    generator: 'fs_unchanged_fail',
    description: 'filesystem_unchanged fails when file hash does not match',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/sample.txt', hash: 'deadbeef0000000000000000000000000000000000000000000000000000dead', description: 'Wrong hash should fail' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifyFailedAt('filesystem', 'should fail when hash mismatches'),
      filesystemGateRan(),
      filesystemGateFailed('wrong hash triggers unchanged failure'),
      narrowingPresent(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // H7: filesystem_count — passes with correct count
  // NOTE: Moved to after all FS fixture files are created (see bottom of Family H)
  // so the dynamic count reflects the actual directory state at test time.

  // H8: filesystem_count — fails with wrong count
  scenarios.push({
    id: nextId('H', 'fs_count_fail'),
    family: 'H',
    generator: 'fs_count_fail',
    description: 'filesystem_count fails when directory entry count mismatches',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_count', path: 'test-data', count: 99, description: 'test-data definitely does not have 99 entries' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifyFailedAt('filesystem', 'should fail when count mismatches'),
      filesystemGateRan(),
      filesystemGateFailed('wrong count triggers failure'),
      narrowingPresent(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // H9: Fingerprint distinctness — different filesystem predicate types produce different fingerprints
  const fsPredicateA: Predicate = { type: 'filesystem_exists', file: 'server.js' };
  const fsPredicateB: Predicate = { type: 'filesystem_absent', file: 'server.js' };
  const fsPredicateC: Predicate = { type: 'filesystem_unchanged', file: 'server.js', hash: 'abc123' };
  const fsPredicateD: Predicate = { type: 'filesystem_count', path: 'test-data', count: 1 };

  scenarios.push({
    id: nextId('H', 'fs_fingerprint'),
    family: 'H',
    generator: 'fs_fingerprint',
    description: 'Filesystem predicates produce distinct fingerprints (K5 can tell them apart)',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [fsPredicateA, fsPredicateB],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      shouldNotCrash('filesystem fingerprint generation should not crash'),
      fingerprintDistinctness(
        'filesystem_exists',
        'filesystem_absent',
        () => fsPredicateA,
        () => fsPredicateB,
      ),
      fingerprintDistinctness(
        'filesystem_exists',
        'filesystem_unchanged',
        () => fsPredicateA,
        () => fsPredicateC,
      ),
      fingerprintDistinctness(
        'filesystem_exists',
        'filesystem_count',
        () => fsPredicateA,
        () => fsPredicateD,
      ),
      fingerprintDeterminism(
        'filesystem_exists fingerprint is stable',
        () => fsPredicateA,
      ),
    ],
    requiresDocker: false,
  });

  // H10: G5 containment — filesystem predicates are attributed (direct match on file/path)
  scenarios.push({
    id: nextId('H', 'fs_containment'),
    family: 'H',
    generator: 'fs_containment',
    description: 'Filesystem predicates are directly attributed by G5 containment',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_exists', file: 'server.js', description: 'Server file exists' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifySucceeded('containment should pass with filesystem predicates'),
      containmentAlwaysPasses(),
      editAttributed('server.js', 'direct'),
    ],
    requiresDocker: false,
  });

  // ===========================================================================
  // FS FAILURE SHAPES — Taxonomy FS-01 through FS-15
  // ===========================================================================
  // Each group targets one failure shape from FAILURE-TAXONOMY.md.
  // H1-H10 above cover basic pass/fail. These exercise the edge cases.

  const noopEdit: Edit = { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" };
  const noDockerGates = { staging: false, browser: false, http: false, invariants: false };

  // ── FS-01: File should exist but doesn't (after failed edit) ──
  // An edit creates a file, but the edit search string doesn't match,
  // so the file never appears — filesystem_exists catches the gap.

  scenarios.push({
    id: nextId('H', 'fs01_edit_creates_missing'),
    family: 'H',
    generator: 'fs01_edit_fail_no_create',
    failureClass: 'FS-01',
    description: 'FS-01: Edit meant to create file fails, filesystem_exists catches absence',
    edits: [
      // This edit won't apply — search string doesn't exist
      { file: 'new-page.html', search: 'THIS_DOES_NOT_EXIST', replace: '<h1>New Page</h1>' },
    ],
    predicates: [
      { type: 'filesystem_exists', file: 'new-page.html', description: 'New page should exist after edit' },
    ],
    config: {
      appDir,
      gates: { ...noDockerGates, grounding: false },
    },
    invariants: [
      // F9 should catch the bad edit before filesystem gate runs
      verifyFailedAt('F9', 'edit application should fail — file does not exist'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-02: File should not exist but does (leftover artifact) ──

  scenarios.push({
    id: nextId('H', 'fs02_leftover_artifact'),
    family: 'H',
    generator: 'fs02_leftover',
    failureClass: 'FS-02',
    description: 'FS-02: Leftover file (server.js) should be absent but exists',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_absent', file: 'server.js', description: 'server.js should have been deleted' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifyFailedAt('filesystem', 'existing file should fail absent check'),
      filesystemGateRan(),
      filesystemGateFailed('leftover artifact not removed'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-03: Directory vs file mismatch ──
  // Expected file at path, but it's actually a directory (test-data/)

  scenarios.push({
    id: nextId('H', 'fs03_dir_vs_file'),
    family: 'H',
    generator: 'fs03_dir_file_mismatch',
    failureClass: 'FS-03',
    description: 'FS-03: filesystem_unchanged on a directory (not a file) — should fail hash',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data', hash: 'deadbeef00000000000000000000000000000000000000000000000000000000', description: 'Directory should not hash like a file' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      // readFileSync on a directory throws — gate should handle gracefully
      shouldNotCrash('filesystem_unchanged on directory should not crash'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  scenarios.push({
    id: nextId('H', 'fs03_count_on_file'),
    family: 'H',
    generator: 'fs03_count_on_file',
    failureClass: 'FS-03',
    description: 'FS-03: filesystem_count on a file (not a directory) — should fail',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_count', path: 'server.js', count: 1, description: 'readdirSync on a file should fail' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      shouldNotCrash('filesystem_count on file should not crash'),
      filesystemGateRan(),
      filesystemGateFailed('readdirSync on a file should error'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-04: Relative path resolution edge cases ──

  scenarios.push({
    id: nextId('H', 'fs04_dotslash_path'),
    family: 'H',
    generator: 'fs04_dotslash',
    failureClass: 'FS-04',
    description: 'FS-04: Path with ./ prefix resolves correctly',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_exists', file: './server.js', description: 'Dot-slash path should resolve' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { ...noDockerGates, grounding: false },
    },
    invariants: [
      shouldNotCrash('dot-slash path should not crash'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('H', 'fs04_dotdot_traversal'),
    family: 'H',
    generator: 'fs04_dotdot',
    failureClass: 'FS-04',
    description: 'FS-04: Path with ../ traversal — fails in staging (temp dir isolation)',
    edits: [noopEdit],
    predicates: [
      // ../demo-app/server.js won't resolve in staging temp dir (parent has no demo-app/)
      // This correctly tests that staging isolation prevents parent traversal
      { type: 'filesystem_exists', file: '../demo-app/server.js', description: 'Parent traversal fails in staging temp dir' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { ...noDockerGates, grounding: false },
    },
    invariants: [
      shouldNotCrash('dot-dot path should not crash'),
      filesystemGateRan(),
      filesystemGateFailed('parent traversal does not resolve in staging'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-07: Content mismatch via hash change ──
  // Edit modifies a file, hash no longer matches grounding-time snapshot

  scenarios.push({
    id: nextId('H', 'fs07_edit_changes_hash'),
    family: 'H',
    generator: 'fs07_content_mismatch',
    failureClass: 'FS-07',
    description: 'FS-07: Edit changes file content, filesystem_unchanged detects hash drift',
    edits: [
      { file: 'test-data/sample.txt', search: 'hello world', replace: 'goodbye world' },
    ],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/sample.txt', hash: fixtureFileHash, description: 'File should be unchanged (but edit modified it)' },
      { type: 'content', file: 'test-data/sample.txt', pattern: 'goodbye' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifyFailedAt('filesystem', 'hash should mismatch after edit'),
      filesystemGateRan(),
      filesystemGateFailed('edit changed file content, hash mismatch'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-08: Encoding — BOM prefix in file ──
  // Create a UTF-8 BOM file. Hash computed on raw bytes including BOM.
  // If hash is computed without BOM awareness, it'll differ from a clean file.

  const bomFixtureDir = join(appDir, 'test-data');
  const bomFile = join(bomFixtureDir, 'bom-sample.txt');
  const bomContent = Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),  // UTF-8 BOM
    Buffer.from('hello world\n'),
  ]);
  writeFileSync(bomFile, bomContent);
  const bomHash = hashFile(bomFile);

  scenarios.push({
    id: nextId('H', 'fs08_bom_hash_match'),
    family: 'H',
    generator: 'fs08_bom_encoding',
    failureClass: 'FS-08',
    description: 'FS-08: UTF-8 BOM file — hash includes BOM bytes (raw byte comparison)',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/bom-sample.txt', hash: bomHash, description: 'BOM file hash should match raw bytes' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('BOM file with correct raw hash should pass'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // Hash computed WITHOUT BOM should fail
  const noBomHash = createHash('sha256').update('hello world\n').digest('hex');
  scenarios.push({
    id: nextId('H', 'fs08_bom_hash_mismatch'),
    family: 'H',
    generator: 'fs08_bom_mismatch',
    failureClass: 'FS-08',
    description: 'FS-08: UTF-8 BOM file — hash without BOM bytes does NOT match (encoding-aware failure)',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/bom-sample.txt', hash: noBomHash, description: 'Non-BOM hash should fail against BOM file' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifyFailedAt('filesystem', 'BOM bytes cause hash mismatch'),
      filesystemGateRan(),
      filesystemGateFailed('BOM presence causes hash difference'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-09: Line ending differences (CRLF/LF) ──
  // Same logical content, different line endings → different hash

  const crlfFile = join(bomFixtureDir, 'crlf-sample.txt');
  writeFileSync(crlfFile, 'line one\r\nline two\r\n');
  const crlfHash = hashFile(crlfFile);

  const lfOnlyHash = createHash('sha256').update('line one\nline two\n').digest('hex');

  scenarios.push({
    id: nextId('H', 'fs09_crlf_hash_match'),
    family: 'H',
    generator: 'fs09_crlf_match',
    failureClass: 'FS-09',
    description: 'FS-09: CRLF file hashes correctly when hash was captured from CRLF',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/crlf-sample.txt', hash: crlfHash, description: 'CRLF hash matches CRLF file' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('CRLF file with CRLF-aware hash should pass'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('H', 'fs09_crlf_lf_mismatch'),
    family: 'H',
    generator: 'fs09_crlf_lf_mismatch',
    failureClass: 'FS-09',
    description: 'FS-09: LF hash does not match CRLF file (line ending sensitivity)',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/crlf-sample.txt', hash: lfOnlyHash, description: 'LF hash should fail against CRLF file' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifyFailedAt('filesystem', 'CRLF vs LF hash mismatch'),
      filesystemGateRan(),
      filesystemGateFailed('line ending difference produces different hash'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-10: Binary file content check ──
  // Binary content (PNG-like header) should hash correctly without text interpretation

  const binaryFile = join(bomFixtureDir, 'binary-sample.bin');
  const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00]);
  writeFileSync(binaryFile, binaryContent);
  const binaryHash = hashFile(binaryFile);

  scenarios.push({
    id: nextId('H', 'fs10_binary_hash'),
    family: 'H',
    generator: 'fs10_binary_hash',
    failureClass: 'FS-10',
    description: 'FS-10: Binary file hashes correctly (no text misinterpretation)',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/binary-sample.bin', hash: binaryHash, description: 'Binary file hash should match' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('binary file with correct hash should pass'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('H', 'fs10_binary_exists'),
    family: 'H',
    generator: 'fs10_binary_exists',
    failureClass: 'FS-10',
    description: 'FS-10: Binary file exists check works for non-text files',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_exists', file: 'test-data/binary-sample.bin', description: 'Binary file should exist' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('binary file existence check should pass'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // ── FS-11: NUL bytes in text-like file ──

  const nulFile = join(bomFixtureDir, 'nul-sample.txt');
  writeFileSync(nulFile, Buffer.from('hello\x00world\n'));
  const nulHash = hashFile(nulFile);

  scenarios.push({
    id: nextId('H', 'fs11_nul_bytes'),
    family: 'H',
    generator: 'fs11_nul_bytes',
    failureClass: 'FS-11',
    description: 'FS-11: File with NUL bytes hashes correctly (no truncation)',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/nul-sample.txt', hash: nulHash, description: 'NUL-containing file hash should be stable' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('NUL byte file with correct hash should pass'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // NUL-stripped hash should NOT match
  const nulStrippedHash = createHash('sha256').update('helloworld\n').digest('hex');
  scenarios.push({
    id: nextId('H', 'fs11_nul_stripped_mismatch'),
    family: 'H',
    generator: 'fs11_nul_stripped',
    failureClass: 'FS-11',
    description: 'FS-11: NUL-stripped hash does not match NUL-containing file',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/nul-sample.txt', hash: nulStrippedHash, description: 'NUL-stripped hash should fail' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifyFailedAt('filesystem', 'NUL bytes affect hash'),
      filesystemGateRan(),
      filesystemGateFailed('NUL byte presence changes hash'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-14: Empty file (0 bytes) ──

  const emptyFile = join(bomFixtureDir, 'empty.txt');
  writeFileSync(emptyFile, '');
  const emptyHash = hashFile(emptyFile);

  scenarios.push({
    id: nextId('H', 'fs14_empty_exists'),
    family: 'H',
    generator: 'fs14_empty_exists',
    failureClass: 'FS-14',
    description: 'FS-14: Empty file (0 bytes) passes filesystem_exists',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_exists', file: 'test-data/empty.txt', description: 'Empty file should exist' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('empty file exists'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('H', 'fs14_empty_unchanged'),
    family: 'H',
    generator: 'fs14_empty_unchanged',
    failureClass: 'FS-14',
    description: 'FS-14: Empty file (0 bytes) has stable hash for filesystem_unchanged',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/empty.txt', hash: emptyHash, description: 'Empty file hash should match empty SHA-256' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('empty file with correct hash should pass'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  scenarios.push({
    id: nextId('H', 'fs14_empty_nonempty_hash'),
    family: 'H',
    generator: 'fs14_empty_nonempty_mismatch',
    failureClass: 'FS-14',
    description: 'FS-14: Non-empty hash does not match empty file',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/empty.txt', hash: fixtureFileHash, description: 'sample.txt hash should not match empty file' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifyFailedAt('filesystem', 'non-empty hash vs empty file'),
      filesystemGateRan(),
      filesystemGateFailed('hash mismatch between non-empty and empty'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-05/FS-06: Symlink edge cases ──
  // Only create on non-Windows (symlinks need admin on Windows)

  if (process.platform !== 'win32') {
    const { symlinkSync, unlinkSync } = require('fs');
    const symlinkPath = join(bomFixtureDir, 'link-to-sample.txt');
    try { unlinkSync(symlinkPath); } catch { /* may not exist */ }
    try {
      symlinkSync(join(bomFixtureDir, 'sample.txt'), symlinkPath);

      scenarios.push({
        id: nextId('H', 'fs05_symlink_exists'),
        family: 'H',
        generator: 'fs05_symlink_exists',
        failureClass: 'FS-05',
        description: 'FS-05: Symlink target exists — filesystem_exists follows symlink',
        edits: [noopEdit],
        predicates: [
          { type: 'filesystem_exists', file: 'test-data/link-to-sample.txt', description: 'Symlink should report as existing' },
          { type: 'content', file: 'server.js', pattern: 'Demo App' },
        ],
        config: {
          appDir,
          gates: noDockerGates,
        },
        invariants: [
          verifySucceeded('symlink to existing file should pass exists'),
          filesystemGateRan(),
          filesystemGatePassed(),
        ],
        requiresDocker: false,
      });

      scenarios.push({
        id: nextId('H', 'fs05_symlink_hash'),
        family: 'H',
        generator: 'fs05_symlink_hash',
        failureClass: 'FS-05',
        description: 'FS-05: Symlink hash matches target file hash (follows symlink)',
        edits: [noopEdit],
        predicates: [
          { type: 'filesystem_unchanged', file: 'test-data/link-to-sample.txt', hash: fixtureFileHash, description: 'Symlink hash should match target' },
          { type: 'content', file: 'server.js', pattern: 'Demo App' },
        ],
        config: {
          appDir,
          gates: noDockerGates,
        },
        invariants: [
          verifySucceeded('symlink hash should equal target file hash'),
          filesystemGateRan(),
          filesystemGatePassed(),
        ],
        requiresDocker: false,
      });
    } catch { /* symlink creation may fail */ }
  }

  // ── FS-12/FS-13: Missing field edge cases (harness robustness) ──
  // These test that the gate doesn't crash when predicates have missing fields

  scenarios.push({
    id: nextId('H', 'fs12_missing_path'),
    family: 'H',
    generator: 'fs12_missing_path',
    failureClass: 'FS-12',
    description: 'FS-12: filesystem_exists with no file/path field — should fail gracefully',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_exists', description: 'Missing path field' } as any,
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { ...noDockerGates, grounding: false },
    },
    invariants: [
      shouldNotCrash('missing path should not crash'),
      filesystemGateRan(),
      filesystemGateFailed('missing file/path field'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  scenarios.push({
    id: nextId('H', 'fs12_missing_hash'),
    family: 'H',
    generator: 'fs12_missing_hash',
    failureClass: 'FS-12',
    description: 'FS-12: filesystem_unchanged with no hash field — should fail gracefully',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_unchanged', file: 'test-data/sample.txt', description: 'Missing hash field' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { ...noDockerGates, grounding: false },
    },
    invariants: [
      shouldNotCrash('missing hash should not crash'),
      filesystemGateRan(),
      filesystemGateFailed('missing hash field'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  scenarios.push({
    id: nextId('H', 'fs12_missing_count'),
    family: 'H',
    generator: 'fs12_missing_count',
    failureClass: 'FS-12',
    description: 'FS-12: filesystem_count with no count field — should fail gracefully',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_count', path: 'test-data', description: 'Missing count field' } as any,
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { ...noDockerGates, grounding: false },
    },
    invariants: [
      shouldNotCrash('missing count should not crash'),
      filesystemGateRan(),
      filesystemGateFailed('missing count field'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // ── FS-15: Count includes hidden/dot files ──
  // Create a dotfile to test whether count includes it

  const dotFile = join(bomFixtureDir, '.hidden');
  writeFileSync(dotFile, 'hidden content\n');
  // Count should include all entries: sample.txt, bom-sample.txt, crlf-sample.txt,
  // binary-sample.bin, nul-sample.txt, empty.txt, .hidden = 7 (+ link if non-windows)
  const expectedEntries = readdirSync(bomFixtureDir);

  scenarios.push({
    id: nextId('H', 'fs15_count_includes_dotfiles'),
    family: 'H',
    generator: 'fs15_dotfile_count',
    failureClass: 'FS-15',
    description: 'FS-15: filesystem_count includes hidden/dot files in count',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_count', path: 'test-data', count: expectedEntries.length, description: `test-data should have ${expectedEntries.length} entries including dotfiles` },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifySucceeded('count should include dotfiles'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // Count WITHOUT dotfiles would be wrong
  scenarios.push({
    id: nextId('H', 'fs15_count_excludes_dotfiles_fails'),
    family: 'H',
    generator: 'fs15_dotfile_miscount',
    failureClass: 'FS-15',
    description: 'FS-15: Wrong count (excluding dotfile) should fail',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_count', path: 'test-data', count: expectedEntries.length - 1, description: 'Off-by-one (excluding dotfile) should fail' },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: noDockerGates,
    },
    invariants: [
      verifyFailedAt('filesystem', 'off-by-one count should fail'),
      filesystemGateRan(),
      filesystemGateFailed('count mismatch when dotfile excluded'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // H7: filesystem_count — passes with correct count (relocated after all fixture creation)
  const h7ActualCount = readdirSync(fsFixtureDir).length;
  scenarios.push({
    id: nextId('H', 'fs_count_pass'),
    family: 'H',
    generator: 'fs_count_pass',
    description: 'filesystem_count passes when directory entry count matches',
    edits: [
      { file: 'server.js', search: "Powered by Node.js", replace: "Powered by Node.js" },
    ],
    predicates: [
      { type: 'filesystem_count', path: 'test-data', count: h7ActualCount, description: `test-data has ${h7ActualCount} entries` },
      { type: 'content', file: 'server.js', pattern: 'Demo App' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, invariants: false },
    },
    invariants: [
      verifySucceeded('filesystem_count should pass with correct count'),
      filesystemGateRan(),
      filesystemGatePassed(),
    ],
    requiresDocker: false,
  });

  // ── K5 learning: filesystem failure seeds constraint ──

  scenarios.push({
    id: nextId('H', 'fs_k5_constraint_seeded'),
    family: 'H',
    generator: 'fs_k5_seed',
    description: 'Filesystem gate failure seeds K5 constraint for learning',
    edits: [noopEdit],
    predicates: [
      { type: 'filesystem_exists', file: 'does-not-exist.xyz', description: 'Missing file' },
    ],
    config: {
      appDir,
      gates: { ...noDockerGates, grounding: false },
    },
    invariants: [
      verifyFailedAt('filesystem', 'missing file triggers failure'),
      narrowingPresent(),
      constraintSeededOnFailure(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY V: VISION + TRIANGULATION
// =============================================================================

function generateFamilyV(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  const dummyEdit: Edit = { file: 'server.js', search: 'color: #666', replace: 'color: #666' };

  // -------------------------------------------------------------------------
  // V1: Vision gate skips when no visual predicates
  // -------------------------------------------------------------------------
  scenarios.push({
    id: nextId('V', 'V1_noVisualPredicates'),
    family: 'V',
    generator: 'V1_noVisualPredicates',
    description: 'Vision gate skips when only non-visual predicates are present',
    edits: [dummyEdit],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'subtitle' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, grounding: false },
      vision: {
        call: async () => { throw new Error('should not be called'); },
        screenshots: { '/': makeSolidPNG(0, 0, 0) },
      },
    },
    invariants: [
      shouldNotCrash('no visual predicates'),
      visionGateSkipped(),
    ],
    requiresDocker: false,
  });

  // -------------------------------------------------------------------------
  // V2: Vision gate skips when no vision callback configured
  // -------------------------------------------------------------------------
  scenarios.push({
    id: nextId('V', 'V2_noApiKey'),
    family: 'V',
    generator: 'V2_noApiKey',
    description: 'Vision gate skips when no vision callback configured',
    edits: [dummyEdit],
    predicates: [{ type: 'css', selector: 'body', property: 'background', expected: '#ffffff' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      // No vision config at all
    },
    invariants: [
      shouldNotCrash('no API key'),
      visionGateSkipped(),
    ],
    requiresDocker: false,
  });

  // -------------------------------------------------------------------------
  // V3: Vision gate with pre-captured blue screenshot — "blue" claim verified
  // Requires GEMINI_API_KEY
  // -------------------------------------------------------------------------
  scenarios.push({
    id: nextId('V', 'V3_blueVerified'),
    family: 'V',
    generator: 'V3_blueScreenshotVerified',
    description: 'Solid blue screenshot: "background is blue" should be VERIFIED',
    edits: [dummyEdit],
    predicates: [{ type: 'css', selector: 'body', property: 'background-color', expected: 'blue' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: null as any, // Placeholder — runner substitutes with geminiVision()
        screenshots: { '/': makeSolidPNG(0, 0, 255) },
      },
    },
    invariants: [
      shouldNotCrash('blue screenshot verified'),
      visionGateRan(),
      visionClaimVerified(),
    ],
    requiresDocker: false,
  });

  // -------------------------------------------------------------------------
  // V4: Vision gate with red screenshot — "blue" claim NOT verified
  // Requires GEMINI_API_KEY
  // -------------------------------------------------------------------------
  scenarios.push({
    id: nextId('V', 'V4_redNotVerified'),
    family: 'V',
    generator: 'V4_redScreenshotNotVerified',
    description: 'Solid red screenshot: "background is blue" should be NOT VERIFIED',
    edits: [dummyEdit],
    predicates: [{ type: 'css', selector: 'body', property: 'background-color', expected: 'blue' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: null as any, // Placeholder — runner substitutes with geminiVision()
        screenshots: { '/': makeSolidPNG(255, 0, 0) },
      },
    },
    invariants: [
      shouldNotCrash('red screenshot not verified'),
      visionGateRan(),
      visionGateFailed(),
      visionClaimNotVerified(),
    ],
    requiresDocker: false,
  });

  // -------------------------------------------------------------------------
  // V5-V10: Triangulation logic (pure — no API key needed)
  // These test the triangulation gate's verdict synthesis by manipulating
  // which gates are present in the results. Since triangulation reads from
  // the gates array, we can control inputs via gate toggles.
  // -------------------------------------------------------------------------

  // V5: Only deterministic gates run (no browser, no vision) → proceed
  scenarios.push({
    id: nextId('V', 'V5_deterministicOnly'),
    family: 'V',
    generator: 'V5_deterministicOnly',
    description: 'Only deterministic gates → triangulation proceeds (insufficient)',
    edits: [dummyEdit],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'subtitle' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: false, grounding: false },
    },
    invariants: [
      shouldNotCrash('deterministic only'),
      triangulationAction('proceed'),
      triangulationConfidence('insufficient'),
    ],
    requiresDocker: false,
  });

  // V6: No gates at all → triangulation proceeds (insufficient, 0 authorities)
  scenarios.push({
    id: nextId('V', 'V6_noAuthorities'),
    family: 'V',
    generator: 'V6_noAuthorities',
    description: 'No verification authorities → triangulation proceeds',
    edits: [dummyEdit],
    predicates: [],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: false, grounding: false, syntax: false, constraints: false, containment: false },
    },
    invariants: [
      shouldNotCrash('no authorities'),
      triangulationAction('proceed'),
    ],
    requiresDocker: false,
  });

  // V7: Vision gate ordering — must appear after browser in gate array
  scenarios.push({
    id: nextId('V', 'V7_gateOrderVisionAfterBrowser'),
    family: 'V',
    generator: 'V7_gateOrderVisionAfterBrowser',
    description: 'Vision gate must appear after browser gate in results',
    edits: [dummyEdit],
    predicates: [{ type: 'css', selector: 'body', property: 'background', expected: '#ffffff' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: async () => { throw new Error('should not be called'); },
        screenshots: { '/': makeSolidPNG(255, 255, 255) },
      },
    },
    invariants: [
      shouldNotCrash('gate ordering'),
      // Vision should be skipped here (no visual predicates that pass through),
      // but the gate ordering invariant only fires when both are present
    ],
    requiresDocker: false,
  });

  // V8: Triangulation always present — even when only F9 runs
  scenarios.push({
    id: nextId('V', 'V8_triangulationAlwaysPresent'),
    family: 'V',
    generator: 'V8_triangulationAlwaysPresent',
    description: 'Triangulation gate is always present in results',
    edits: [dummyEdit],
    predicates: [],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: false, grounding: false },
    },
    invariants: [
      shouldNotCrash('triangulation always present'),
      {
        name: 'triangulation_gate_present',
        category: 'triangulation' as any,
        layer: 'product' as const,
        check: (_scenario: any, result: any) => {
          if (result instanceof Error) return { passed: true, severity: 'info' as const };
          const gate = result.gates.find((g: any) => g.gate === 'triangulation');
          if (!gate) {
            return { passed: false, violation: 'Triangulation gate not in results', severity: 'bug' as const };
          }
          return { passed: true, severity: 'info' as const };
        },
      },
    ],
    requiresDocker: false,
  });

  // V9: Vision API failure → gate skipped (doesn't block)
  scenarios.push({
    id: nextId('V', 'V9_visionApiFailure'),
    family: 'V',
    generator: 'V9_visionApiFailure',
    description: 'Vision API failure should skip gate, not block pipeline',
    edits: [dummyEdit],
    predicates: [{ type: 'css', selector: 'body', property: 'background', expected: '#ffffff' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: async () => { throw new Error('invalid API key'); },
        screenshots: { '/': makeSolidPNG(255, 255, 255) },
      },
    },
    invariants: [
      shouldNotCrash('vision API failure'),
      visionGateSkipped(), // API failure → "gate skipped" in detail
    ],
    requiresDocker: false,
  });

  // V10: Multiple CSS predicates with vision → all claims addressed
  // Requires GEMINI_API_KEY
  scenarios.push({
    id: nextId('V', 'V10_multiplePredicates'),
    family: 'V',
    generator: 'V10_multiplePredicates',
    description: 'Multiple CSS predicates should each produce a vision claim',
    edits: [dummyEdit],
    predicates: [
      { type: 'css', selector: 'body', property: 'background-color', expected: 'green' },
      { type: 'css', selector: 'h1', property: 'color', expected: 'green' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: null as any, // Placeholder — runner substitutes with geminiVision()
        screenshots: { '/': makeSolidPNG(0, 128, 0) }, // green
      },
    },
    invariants: [
      shouldNotCrash('multiple predicates'),
      visionGateRan(),
      // At least the background claim should be verified (solid green image)
      visionClaimVerified(),
    ],
    requiresDocker: false,
  });

  // V11: Triangulation gate ordering — must appear last (after vision)
  scenarios.push({
    id: nextId('V', 'V11_triangulationAfterVision'),
    family: 'V',
    generator: 'V11_triangulationAfterVision',
    description: 'Triangulation must appear after vision in gate ordering',
    edits: [dummyEdit],
    predicates: [{ type: 'css', selector: 'body', property: 'background', expected: '#ffffff' }],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: async () => { throw new Error('should not be called'); },
        screenshots: { '/': makeSolidPNG(255, 255, 255) },
      },
    },
    invariants: [
      shouldNotCrash('triangulation ordering'),
      // Only checks when both gates are present
      gateOrderBefore('vision' as any, 'triangulation' as any),
    ],
    requiresDocker: false,
  });

  // V12: Non-visual predicate (content) with vision enabled → vision skips
  scenarios.push({
    id: nextId('V', 'V12_contentPredicateVisionSkips'),
    family: 'V',
    generator: 'V12_contentPredicateVisionSkips',
    description: 'Content-only predicates should cause vision gate to skip',
    edits: [dummyEdit],
    predicates: [
      { type: 'content', file: 'server.js', pattern: 'Demo' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: async () => { throw new Error('should not be called'); },
        screenshots: { '/': makeSolidPNG(0, 0, 0) },
      },
    },
    invariants: [
      shouldNotCrash('content predicate vision skip'),
      visionGateSkipped(),
    ],
    requiresDocker: false,
  });

  // V13: HTML predicate IS visual → vision should run (not skip)
  // Requires GEMINI_API_KEY
  scenarios.push({
    id: nextId('V', 'V13_htmlPredicateIsVisual'),
    family: 'V',
    generator: 'V13_htmlPredicateIsVisual',
    description: 'HTML predicates are visual — vision gate should run',
    edits: [dummyEdit],
    predicates: [
      { type: 'html', selector: 'h1', expected: 'exists' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: null as any, // Placeholder — runner substitutes with geminiVision()
        screenshots: { '/': makeSolidPNG(128, 128, 128) },
      },
    },
    invariants: [
      shouldNotCrash('html predicate is visual'),
      visionGateRan(),
    ],
    requiresDocker: false,
  });

  // V14: Vision + Triangulation end-to-end with mixed predicates
  // Tests that content predicates don't break vision, and triangulation
  // synthesizes correctly when vision is the only perceptual authority
  scenarios.push({
    id: nextId('V', 'V14_mixedPredicatesTriangulation'),
    family: 'V',
    generator: 'V14_mixedPredicatesTriangulation',
    description: 'Mixed predicates: content passes deterministic, vision runs for CSS',
    edits: [dummyEdit],
    predicates: [
      { type: 'content', file: 'server.js', pattern: 'subtitle' },
      { type: 'css', selector: 'body', property: 'background-color', expected: 'white' },
    ],
    config: {
      appDir,
      gates: { staging: false, browser: false, http: false, vision: true, grounding: false },
      vision: {
        call: null as any, // Placeholder — runner substitutes with geminiVision()
        screenshots: { '/': makeSolidPNG(255, 255, 255) }, // white matches
      },
    },
    invariants: [
      shouldNotCrash('mixed predicates triangulation'),
      visionGateRan(),
    ],
    requiresDocker: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY M: MESSAGE GATE (Governed Outbound Communication)
// =============================================================================
// Tests the message governance pipeline — destination, forbidden content,
// required content, claims with evidence, negation detection, denied patterns,
// and review hooks. 11 failure shapes: MSG-01 through MSG-11.

function generateFamilyM(_appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // Shared envelope factory
  const makeEnvelope = (overrides: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
    destination: { target: '#deployments', platform: 'slack' },
    content: { body: 'Status update: all systems operational' },
    sender: { identity: 'deploy-bot' },
    ...overrides,
  });

  // Shared deploy policy
  const deployPolicy: MessagePolicy = {
    destinations: { allow: ['#deployments', '#alerts'], deny: ['#general', '#random'] },
    forbidden: ['password', 'secret', /api[_-]?key/i],
    claims: {
      deploy: {
        unknown_assertions: 'clarify',
        assertions: {
          deploy_success: {
            triggers: ['deployed successfully', 'completed successfully', 'deploy completed'],
            evidence: 'checkpoint',
          },
          tests_passing: {
            triggers: ['all tests pass', 'tests are passing', 'test suite passed'],
            evidence: 'test_run',
          },
        },
      },
    },
  };

  // Evidence providers
  const validEvidence: Record<string, EvidenceProvider> = {
    checkpoint: async () => ({ exists: true, fresh: true, detail: 'CP-138 verified' }),
    test_run: async () => ({ exists: true, fresh: true, detail: 'Test run #42 passed' }),
  };

  const staleEvidence: Record<string, EvidenceProvider> = {
    checkpoint: async () => ({ exists: true, fresh: false, detail: 'CP-100 is 3 hours old', epoch: Date.now() - 3 * 3600 * 1000 }),
  };

  const missingEvidence: Record<string, EvidenceProvider> = {
    checkpoint: async () => ({ exists: false, fresh: false, detail: 'No checkpoint found for this deploy' }),
  };

  // ── MSG-01: Destination denied ─────────────────────────────────────
  scenarios.push({
    id: nextId('M', 'MSG01_dest_denied'),
    family: 'M',
    generator: 'MSG01_dest_denied',
    description: 'MSG-01: Message to denied destination is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({ destination: { target: '#general', platform: 'slack' } }),
      policy: deployPolicy,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'denied destination'),
      messageReason('destination_denied'),
      messageGateFailed('destination'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-01',
  });

  // ── MSG-01b: Destination not in allow list ─────────────────────────
  scenarios.push({
    id: nextId('M', 'MSG01b_dest_not_allowed'),
    family: 'M',
    generator: 'MSG01b_dest_not_allowed',
    description: 'MSG-01: Message to unlisted destination is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({ destination: { target: '#secret-channel', platform: 'slack' } }),
      policy: deployPolicy,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'destination not in allow list'),
      messageReason('destination_denied'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-01',
  });

  // ── MSG-02: Forbidden content ──────────────────────────────────────
  scenarios.push({
    id: nextId('M', 'MSG02_forbidden_string'),
    family: 'M',
    generator: 'MSG02_forbidden_string',
    description: 'MSG-02: Message with forbidden string is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'Deploy complete. DB password is hunter2' },
      }),
      policy: deployPolicy,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'forbidden content'),
      messageReason('forbidden_content'),
      messageGatePassed('destination'),
      messageGateFailed('forbidden_content'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-02',
  });

  // ── MSG-02b: Forbidden regex pattern ───────────────────────────────
  scenarios.push({
    id: nextId('M', 'MSG02b_forbidden_regex'),
    family: 'M',
    generator: 'MSG02b_forbidden_regex',
    description: 'MSG-02: Message with api_key pattern is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'Set api_key to sk-1234567890' },
      }),
      policy: deployPolicy,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'forbidden regex'),
      messageReason('forbidden_content'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-02',
  });

  // ── MSG-03: Claim with valid evidence — approved ───────────────────
  scenarios.push({
    id: nextId('M', 'MSG03_claim_verified'),
    family: 'M',
    generator: 'MSG03_claim_verified',
    description: 'MSG-03: Claim "deployed successfully" with valid checkpoint passes',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3 deployed successfully to production' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('approved', 'claim verified'),
      messageGatePassed('destination'),
      messageGatePassed('forbidden_content'),
      messageGatePassed('claims'),
      messageClaimVerified('deploy_success', true),
    ],
    requiresDocker: false,
    failureClass: 'MSG-03',
  });

  // ── MSG-04: Claim without evidence — blocked ───────────────────────
  scenarios.push({
    id: nextId('M', 'MSG04_claim_no_evidence'),
    family: 'M',
    generator: 'MSG04_claim_no_evidence',
    description: 'MSG-04: Claim "deployed successfully" without evidence is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3 deployed successfully to production' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: missingEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'claim unsupported'),
      messageReason('claim_unsupported'),
      messageClaimVerified('deploy_success', false),
    ],
    requiresDocker: false,
    failureClass: 'MSG-04',
  });

  // ── MSG-05: Missing required content ───────────────────────────────
  scenarios.push({
    id: nextId('M', 'MSG05_missing_required'),
    family: 'M',
    generator: 'MSG05_missing_required',
    description: 'MSG-05: Deploy message missing required version tag is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'Deploy completed' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: {
        ...deployPolicy,
        required: [{ topic: 'deploy', patterns: [/v\d+\.\d+/] }],
      },
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'missing required'),
      messageReason('missing_required'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-05',
  });

  // ── MSG-06a: Obvious negation suppresses trigger ───────────────────
  scenarios.push({
    id: nextId('M', 'MSG06a_obvious_negation'),
    family: 'M',
    generator: 'MSG06a_obvious_negation',
    description: 'MSG-06a: "has not deployed successfully" suppresses deploy_success trigger',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'The service has not deployed successfully — investigating' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('approved', 'negation suppresses trigger'),
      messageGatePassed('claims'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-06',
  });

  // ── MSG-06b: Ambiguous negation escalates to clarify ───────────────
  scenarios.push({
    id: nextId('M', 'MSG06b_ambiguous_negation'),
    family: 'M',
    generator: 'MSG06b_ambiguous_negation',
    description: 'MSG-06b: "possibly deployed successfully" triggers clarify',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'The release possibly deployed successfully but we are checking' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('clarify', 'ambiguous negation'),
      messageReason('ambiguous_negation'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-06',
  });

  // ── MSG-09: Unknown assertion in governed topic ─────────────────────
  scenarios.push({
    id: nextId('M', 'MSG09_unknown_assertion'),
    family: 'M',
    generator: 'MSG09_unknown_assertion',
    description: 'MSG-09: Novel claim "verified in staging" not in assertion list triggers clarify',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'The migration has been verified in staging and looks good' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('clarify', 'unknown assertion'),
      messageReason('unknown_assertion'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-09',
  });

  // ── MSG-09b: Unknown assertion with allow policy passes ────────────
  scenarios.push({
    id: nextId('M', 'MSG09b_unknown_allowed'),
    family: 'M',
    generator: 'MSG09b_unknown_allowed',
    description: 'MSG-09: Novel claim passes when unknown_assertions=allow',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'The migration has been verified in staging and looks good' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: {
        ...deployPolicy,
        claims: {
          deploy: {
            ...deployPolicy.claims!.deploy,
            unknown_assertions: 'allow',
          },
        },
      },
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('approved', 'unknown assertions allowed'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-09',
  });

  // ── MSG-10: Previously denied pattern (K5 memory) ──────────────────
  scenarios.push({
    id: nextId('M', 'MSG10_denied_pattern'),
    family: 'M',
    generator: 'MSG10_denied_pattern',
    description: 'MSG-10: Previously denied destination+content pattern is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'Deploy v1.0 completed successfully' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: validEvidence,
      deniedPatterns: [
        { pattern: 'v1.0', reason: 'v1.0 deploy claim was false last time', timestamp: Date.now() - 60000 },
      ],
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'previously denied'),
      messageReason('previously_denied'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-10',
  });

  // ── MSG-11: Stale evidence ─────────────────────────────────────────
  scenarios.push({
    id: nextId('M', 'MSG11_stale_evidence'),
    family: 'M',
    generator: 'MSG11_stale_evidence',
    description: 'MSG-11: Claim with stale checkpoint evidence is blocked',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3 deployed successfully to production' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: staleEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'stale evidence'),
      messageReason('claim_stale_evidence'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-11',
  });

  // ── MSG-07: Review hook blocks ─────────────────────────────────────
  scenarios.push({
    id: nextId('M', 'MSG07_review_blocked'),
    family: 'M',
    generator: 'MSG07_review_blocked',
    description: 'MSG-07: Review hook blocks message with structured reason',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'Announcing company-wide restructuring changes' },
      }),
      policy: {
        destinations: { allow: ['#deployments'] },
        review: async () => ({
          verdict: 'blocked' as const,
          reason: 'Sensitive announcement — requires VP approval',
          notes: 'Flagged by content sensitivity classifier',
        }),
      },
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('blocked', 'review blocked'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-07',
  });

  // ── MSG-08: Review hook escalates to clarify ───────────────────────
  scenarios.push({
    id: nextId('M', 'MSG08_review_clarify'),
    family: 'M',
    generator: 'MSG08_review_clarify',
    description: 'MSG-08: Review hook escalates ambiguous message to clarify',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'We might need to update the pricing page tonight' },
      }),
      policy: {
        destinations: { allow: ['#deployments'] },
        review: async () => ({
          verdict: 'clarify' as const,
          reason: 'Message implies a change — should this be a goal instead?',
        }),
      },
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('clarify', 'review clarify'),
      messageReason('review_escalated'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-08',
  });

  // ── MSG-12: Topic override narrowing ──────────────────────────────
  // Agent labels message as "general", but content says "deployed successfully"
  // → gate detects deploy topic from content keywords → narrowed verdict
  const topicPolicy: MessagePolicy = {
    ...deployPolicy,
    topics: {
      deploy: {
        trust_agent_label: false,
        detect: ['deployed', 'deploy completed', 'deployment', 'released'],
      },
      incident: {
        trust_agent_label: false,
        detect: ['outage', 'incident', 'downtime', 'degraded'],
      },
      general: {
        trust_agent_label: true,
        detect: [],
      },
    },
  };

  scenarios.push({
    id: nextId('M', 'MSG12_topic_override'),
    family: 'M',
    generator: 'MSG12_topic_override',
    description: 'MSG-12: Agent labels "general" but content has deploy keywords → topic overridden → narrowed',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3.1 deployed successfully to production' },
        topic: { value: 'general', source: 'agent' },
      }),
      policy: topicPolicy,
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('narrowed', 'topic override narrowing'),
      messageTopicResolution('policy_detected', true),
      messageNarrowing('topic_override'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-12',
  });

  // ── MSG-12 variant: agent and detection agree → approved (no override)
  scenarios.push({
    id: nextId('M', 'MSG12_topic_agree'),
    family: 'M',
    generator: 'MSG12_topic_agree',
    description: 'MSG-12 variant: agent labels "deploy" and content confirms → approved (no override)',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3.1 deployed successfully to production' },
        topic: { value: 'deploy', source: 'agent' },
      }),
      policy: topicPolicy,
      evidenceProviders: validEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('approved', 'topic agreement — no override'),
      messageTopicResolution('policy_detected', false),
    ],
    requiresDocker: false,
  });

  // ── MSG-13: Epoch-based evidence staleness → narrowed ──────────────
  // Evidence exists and provider says fresh=true, but epoch is stale
  const epochStaleEvidence: Record<string, EvidenceProvider> = {
    checkpoint: async () => ({
      exists: true,
      fresh: true, // Provider says fresh — gate overrides via epoch
      detail: 'CP-100 exists',
      epoch: 3,
      currentEpoch: 5,
    }),
  };

  scenarios.push({
    id: nextId('M', 'MSG13_epoch_stale'),
    family: 'M',
    generator: 'MSG13_epoch_stale',
    description: 'MSG-13: Evidence provider says fresh but epoch is stale → narrowed',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3.1 deployed successfully to production' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: deployPolicy,
      evidenceProviders: epochStaleEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('narrowed', 'epoch-based staleness'),
      messageReason('claim_stale_evidence'),
      messageNarrowing('evidence_staleness'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-13',
  });

  // ── MSG-13 variant: maxEvidenceAgeMs timestamp staleness → narrowed ─
  const timestampStaleEvidence: Record<string, EvidenceProvider> = {
    checkpoint: async () => ({
      exists: true,
      fresh: true, // Provider says fresh — gate overrides via timestamp
      detail: 'CP-100 exists',
      timestamp: Date.now() - 2 * 3600 * 1000, // 2 hours ago
    }),
  };

  const policyWithMaxAge: MessagePolicy = {
    ...deployPolicy,
    claims: {
      deploy: {
        unknown_assertions: 'clarify',
        assertions: {
          deploy_success: {
            triggers: ['deployed successfully', 'completed successfully', 'deploy completed'],
            evidence: 'checkpoint',
            maxEvidenceAgeMs: 30 * 60 * 1000, // 30 minutes
          },
        },
      },
    },
  };

  scenarios.push({
    id: nextId('M', 'MSG13_timestamp_stale'),
    family: 'M',
    generator: 'MSG13_timestamp_stale',
    description: 'MSG-13 variant: Evidence timestamp exceeds maxEvidenceAgeMs → narrowed',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3.1 deployed successfully to production' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policy: policyWithMaxAge,
      evidenceProviders: timestampStaleEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('narrowed', 'timestamp-based staleness'),
      messageReason('claim_stale_evidence'),
      messageNarrowing('evidence_staleness'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-13',
  });

  // ── MSG-14: Topic override + epoch staleness combined → narrowed ────
  scenarios.push({
    id: nextId('M', 'MSG14_combined_narrowing'),
    family: 'M',
    generator: 'MSG14_combined_narrowing',
    description: 'MSG-14: Topic overridden AND epoch stale → combined narrowing',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope({
        content: { body: 'v2.3.1 deployed successfully to production' },
        topic: { value: 'general', source: 'agent' },
      }),
      policy: topicPolicy,
      evidenceProviders: epochStaleEvidence,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('narrowed', 'combined narrowing'),
      messageTopicResolution('policy_detected', true),
      messageNarrowing('topic_override+evidence_staleness'),
    ],
    requiresDocker: false,
    failureClass: 'MSG-14',
  });

  // ── Clean pass: no claims, no topic, simple status ─────────────────
  scenarios.push({
    id: nextId('M', 'M_clean_pass'),
    family: 'M',
    generator: 'M_clean_pass',
    description: 'Clean pass: simple status message with no claims',
    edits: [],
    predicates: [],
    config: {},
    messageTest: {
      envelope: makeEnvelope(),
      policy: deployPolicy,
    },
    invariants: [
      messageDidNotCrash(),
      messageVerdict('approved', 'clean pass'),
      messageGatePassed('destination'),
      messageGatePassed('forbidden_content'),
    ],
    requiresDocker: false,
  });

  return scenarios;
}

// =============================================================================
// WAVE 2A: HTTP STATUS/BODY, HTML TEXT, CONTENT EDGE CASES,
//          CROSS-PREDICATE, F9 OVERLAPPING EDITS, K5/NARROWING
// =============================================================================
// Families: P (HTTP gate), I (cross-predicate interactions),
//           added to G (F9/K5/narrowing edge cases)
// =============================================================================

function generateFamilyP(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // =========================================================================
  // P-01: Status code mismatch
  // =========================================================================

  // P-01a: Correct status code on /health (200)
  scenarios.push({
    id: nextId('P', 'P01a_healthStatus200'),
    family: 'P',
    generator: 'P01a_correctStatus',
    failureClass: 'P-01',
    description: 'P-01: HTTP predicate with correct status code should pass',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/health', method: 'GET', expect: { status: 200 } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-01a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // P-01b: Wrong status code expectation (expect 404 from /health which returns 200)
  scenarios.push({
    id: nextId('P', 'P01b_wrongStatus'),
    family: 'P',
    generator: 'P01b_wrongStatus',
    failureClass: 'P-01',
    description: 'P-01: HTTP predicate expecting wrong status code should fail',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/health', method: 'GET', expect: { status: 404 } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-01b should not crash'),
      httpGateRan(),
      httpGateFailed('status mismatch'),
      httpGateDetailContains('expected'),
    ],
    requiresDocker: true,
    expectedSuccess: false,
  });

  // P-01c: Status on non-existent route (actual 404)
  scenarios.push({
    id: nextId('P', 'P01c_404route'),
    family: 'P',
    generator: 'P01c_404route',
    failureClass: 'P-01',
    description: 'P-01: HTTP predicate on non-existent route expecting 404 should pass',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/nonexistent', method: 'GET', expect: { status: 404 } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-01c should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // =========================================================================
  // P-02: Body content missing (bodyContains)
  // =========================================================================

  // P-02a: bodyContains with content that exists
  scenarios.push({
    id: nextId('P', 'P02a_bodyPresent'),
    family: 'P',
    generator: 'P02a_bodyContainsPresent',
    failureClass: 'P-02',
    description: 'P-02: bodyContains with content present in response should pass',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/health', method: 'GET', expect: { status: 200, bodyContains: 'ok' } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-02a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // P-02b: bodyContains with content that doesn't exist
  scenarios.push({
    id: nextId('P', 'P02b_bodyMissing'),
    family: 'P',
    generator: 'P02b_bodyContainsMissing',
    failureClass: 'P-02',
    description: 'P-02: bodyContains with content absent from response should fail',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/health', method: 'GET', expect: { status: 200, bodyContains: 'ERROR_NOT_HERE' } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-02b should not crash'),
      httpGateRan(),
      httpGateFailed('body content missing'),
      httpGateDetailContains('missing'),
    ],
    requiresDocker: true,
    expectedSuccess: false,
  });

  // =========================================================================
  // P-03: bodyContains array — all must match
  // =========================================================================

  // P-03a: Array where all terms exist
  scenarios.push({
    id: nextId('P', 'P03a_arrayAllPresent'),
    family: 'P',
    generator: 'P03a_bodyArrayAllPresent',
    failureClass: 'P-03',
    description: 'P-03: bodyContains array where all terms exist should pass',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: ['Alpha', 'Beta'] } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-03a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // P-03b: Array where one term is missing
  scenarios.push({
    id: nextId('P', 'P03b_arrayPartialMiss'),
    family: 'P',
    generator: 'P03b_bodyArrayPartialMiss',
    failureClass: 'P-03',
    description: 'P-03: bodyContains array where one term is missing should fail',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: ['Alpha', 'Gamma'] } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-03b should not crash'),
      httpGateRan(),
      httpGateFailed('partial array miss'),
      httpGateDetailContains('Gamma'),
    ],
    requiresDocker: true,
    expectedSuccess: false,
  });

  // P-03c: Array with empty string (edge case — should match everything)
  scenarios.push({
    id: nextId('P', 'P03c_arrayEmptyString'),
    family: 'P',
    generator: 'P03c_bodyArrayEmptyString',
    failureClass: 'P-03',
    description: 'P-03: bodyContains array with empty string should pass (empty string is in every body)',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/health', method: 'GET', expect: { bodyContains: ['ok', ''] } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-03c should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // =========================================================================
  // P-04: bodyRegex edge cases
  // =========================================================================

  // P-04a: Simple regex match
  scenarios.push({
    id: nextId('P', 'P04a_regexMatch'),
    family: 'P',
    generator: 'P04a_regexSimpleMatch',
    failureClass: 'P-04',
    description: 'P-04: bodyRegex matching response body should pass',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { bodyRegex: '"id":\\s*\\d+' } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-04a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // P-04b: Regex that doesn't match
  scenarios.push({
    id: nextId('P', 'P04b_regexNoMatch'),
    family: 'P',
    generator: 'P04b_regexNoMatch',
    failureClass: 'P-04',
    description: 'P-04: bodyRegex that does not match response body should fail',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/health', method: 'GET', expect: { bodyRegex: 'ERROR_\\d{4}' } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-04b should not crash'),
      httpGateRan(),
      httpGateFailed('regex no match'),
      httpGateDetailContains('regex'),
    ],
    requiresDocker: true,
    expectedSuccess: false,
  });

  // P-04c: Regex with special characters (JSON structure)
  scenarios.push({
    id: nextId('P', 'P04c_regexSpecialChars'),
    family: 'P',
    generator: 'P04c_regexSpecialChars',
    failureClass: 'P-04',
    description: 'P-04: bodyRegex with JSON-matching special chars should work',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { bodyRegex: '\\[\\{"id":\\d+' } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-04c should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // =========================================================================
  // P-05: Empty response body
  // =========================================================================

  // P-05a: bodyContains on route with non-empty response
  scenarios.push({
    id: nextId('P', 'P05a_nonEmptyBody'),
    family: 'P',
    generator: 'P05a_nonEmptyBody',
    failureClass: 'P-05',
    description: 'P-05: bodyContains against non-empty response should work normally',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/health', method: 'GET', expect: { status: 200, bodyContains: 'status' } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-05a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // =========================================================================
  // P-06: Wrong Content-Type (testing bodyContains still works on JSON)
  // =========================================================================

  // P-06a: JSON body with bodyContains (Content-Type is application/json)
  scenarios.push({
    id: nextId('P', 'P06a_jsonBodyContains'),
    family: 'P',
    generator: 'P06a_jsonContentType',
    failureClass: 'P-06',
    description: 'P-06: bodyContains works against JSON response regardless of Content-Type',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { bodyContains: '"name":"Alpha"' } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-06a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // =========================================================================
  // P-07: JSON structure assertion (key existence via bodyContains)
  // =========================================================================

  // P-07a: Check for JSON key existence
  scenarios.push({
    id: nextId('P', 'P07a_jsonKey'),
    family: 'P',
    generator: 'P07a_jsonKeyExists',
    failureClass: 'P-07',
    description: 'P-07: bodyContains can verify JSON key presence',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { bodyContains: ['"id"', '"name"'] } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-07a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // P-07b: Check for JSON key that doesn't exist
  scenarios.push({
    id: nextId('P', 'P07b_jsonKeyMissing'),
    family: 'P',
    generator: 'P07b_jsonKeyMissing',
    failureClass: 'P-07',
    description: 'P-07: bodyContains for absent JSON key should fail',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{ type: 'http', path: '/api/items', method: 'GET', expect: { bodyContains: ['"id"', '"email"'] } }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-07b should not crash'),
      httpGateRan(),
      httpGateFailed('missing JSON key'),
      httpGateDetailContains('email'),
    ],
    requiresDocker: true,
    expectedSuccess: false,
  });

  // =========================================================================
  // P-09: Sequence ordering (http_sequence)
  // =========================================================================

  // P-09a: Sequence with GET→GET (both should pass)
  scenarios.push({
    id: nextId('P', 'P09a_sequenceGetGet'),
    family: 'P',
    generator: 'P09a_sequenceGetGet',
    failureClass: 'P-09',
    description: 'P-09: http_sequence with GET→GET on valid endpoints should pass',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{
      type: 'http_sequence',
      steps: [
        { method: 'GET', path: '/health', expect: { status: 200 } },
        { method: 'GET', path: '/api/items', expect: { status: 200, bodyContains: 'Alpha' } },
      ],
    }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-09a should not crash'),
      httpGateRan(),
      httpGatePassed(),
    ],
    requiresDocker: true,
    expectedSuccess: true,
  });

  // P-09b: Sequence where second step fails
  scenarios.push({
    id: nextId('P', 'P09b_sequenceSecondFails'),
    family: 'P',
    generator: 'P09b_sequenceSecondStepFail',
    failureClass: 'P-09',
    description: 'P-09: http_sequence where second step has wrong expectation should fail',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{
      type: 'http_sequence',
      steps: [
        { method: 'GET', path: '/health', expect: { status: 200 } },
        { method: 'GET', path: '/api/items', expect: { status: 200, bodyContains: 'Nonexistent' } },
      ],
    }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-09b should not crash'),
      httpGateRan(),
      httpGateFailed('second step fails'),
      httpGateDetailContains('Step 2'),
    ],
    requiresDocker: true,
    expectedSuccess: false,
  });

  // P-09c: Sequence where first step fails (should stop early)
  scenarios.push({
    id: nextId('P', 'P09c_sequenceFirstFails'),
    family: 'P',
    generator: 'P09c_sequenceFirstStepFail',
    failureClass: 'P-09',
    description: 'P-09: http_sequence where first step fails should stop early',
    edits: [{ file: 'server.js', search: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));", replace: "res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));" }],
    predicates: [{
      type: 'http_sequence',
      steps: [
        { method: 'GET', path: '/health', expect: { status: 500 } },
        { method: 'GET', path: '/api/items', expect: { status: 200 } },
      ],
    }],
    config: { appDir },
    invariants: [
      shouldNotCrash('P-09c should not crash'),
      httpGateRan(),
      httpGateFailed('first step fails'),
      httpGateDetailContains('Step 1'),
    ],
    requiresDocker: true,
    expectedSuccess: false,
  });

  return scenarios;
}

// =============================================================================
// FAMILY I: CROSS-PREDICATE INTERACTIONS (Wave 2A)
// =============================================================================

function generateFamilyI(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // =========================================================================
  // I-01: CSS passes but HTML fails on same element
  // =========================================================================

  // I-01a: CSS predicate on h1 passes (color correct) but HTML predicate fails (wrong text)
  scenarios.push({
    id: nextId('I', 'I01a_cssPassHtmlFail'),
    family: 'I',
    generator: 'I01a_cssPassHtmlFail',
    failureClass: 'I-01',
    description: 'I-01: CSS predicate passes (correct color) but HTML predicate fails (wrong text) on same element',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [
      { type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' },
      { type: 'html', selector: 'h1', expected: 'Wrong Title Text' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('I-01a should not crash'),
      verifyFailedAt('grounding', 'HTML text mismatch should fail at grounding'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // I-01b: Both CSS and HTML pass on same element
  scenarios.push({
    id: nextId('I', 'I01b_bothPass'),
    family: 'I',
    generator: 'I01b_cssAndHtmlPass',
    failureClass: 'I-01',
    description: 'I-01: CSS and HTML predicates both pass on same element (control case)',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [
      { type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' },
      { type: 'html', selector: 'h1', expected: 'Demo App' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('I-01b should not crash'),
      verifySucceeded('Both predicates should pass'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // =========================================================================
  // I-03: Content passes but HTTP fails
  // =========================================================================

  // I-03a: Content predicate passes (file changed) but HTTP predicate fails (wrong expectation)
  // Non-Docker: both predicates evaluated at grounding level
  scenarios.push({
    id: nextId('I', 'I03a_contentPassHttpSetup'),
    family: 'I',
    generator: 'I03a_contentPassHttpFail',
    failureClass: 'I-03',
    description: 'I-03: Content predicate passes (pattern in file) alongside HTTP predicate (no Docker, HTTP skipped)',
    edits: [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Updated App</title>' }],
    predicates: [
      { type: 'content', file: 'server.js', pattern: 'Updated App' },
      { type: 'http', path: '/health', method: 'GET', expect: { status: 200 } },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('I-03a should not crash'),
      verifySucceeded('Content should pass, HTTP skipped'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // =========================================================================
  // I-06: Edit fixes one predicate but breaks another
  // =========================================================================

  // I-06a: Edit replaces title text — content predicate for OLD text fails, new text passes
  scenarios.push({
    id: nextId('I', 'I06a_editFixesOneBreaksOther'),
    family: 'I',
    generator: 'I06a_editFixesOneBreaksOther',
    failureClass: 'I-06',
    description: 'I-06: Edit changes title — predicate for old text fails grounding, new text passes',
    edits: [{ file: 'server.js', search: '<h1>Demo App</h1>', replace: '<h1>New App</h1>' }],
    predicates: [
      { type: 'html', selector: 'h1', expected: 'Demo App' },
      { type: 'html', selector: 'h1', expected: 'New App' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('I-06a should not crash'),
      // After edit, "Demo App" is gone from h1, "New App" is there.
      // Grounding checks BEFORE edit: h1 has "Demo App" — "New App" is a text change
      // The grounding gate should accept creation-like text changes
    ],
    requiresDocker: false,
  });

  // I-06b: CSS edit changes color but content predicate references old color value
  scenarios.push({
    id: nextId('I', 'I06b_cssEditContentConflict'),
    family: 'I',
    generator: 'I06b_cssEditContentConflict',
    failureClass: 'I-06',
    description: 'I-06: CSS edit changes color — content predicate for old color fails, CSS predicate for new passes',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [
      { type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' },
      { type: 'content', file: 'server.js', pattern: '#1a1a2e' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('I-06b should not crash'),
      // After edit, #1a1a2e is removed → content predicate fails
      // CSS predicate for #ff0000 passes
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // =========================================================================
  // I-07: One edit satisfies predicate A, violates predicate B (intra-goal conflict)
  // =========================================================================

  // I-07a: Two CSS predicates on same selector, conflicting expected values
  scenarios.push({
    id: nextId('I', 'I07a_conflictingPredicates'),
    family: 'I',
    generator: 'I07a_conflictingCSSPredicates',
    failureClass: 'I-07',
    description: 'I-07: Two CSS predicates on h1 color expecting different values — impossible to satisfy both',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: #ff0000' }],
    predicates: [
      { type: 'css', selector: 'h1', property: 'color', expected: '#ff0000' },
      { type: 'css', selector: 'h1', property: 'color', expected: '#0000ff' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('I-07a should not crash'),
      // One predicate can pass but not both — grounding evaluates pre-edit source
    ],
    requiresDocker: false,
  });

  // I-07b: Content predicate and CSS predicate conflict (edit removes the pattern content needs)
  scenarios.push({
    id: nextId('I', 'I07b_contentCSSConflict'),
    family: 'I',
    generator: 'I07b_contentCSSConflict',
    failureClass: 'I-07',
    description: 'I-07: Content predicate needs text that CSS edit removes',
    edits: [{ file: 'server.js', search: 'background: #ffffff', replace: 'background: #000000' }],
    predicates: [
      { type: 'css', selector: 'body', property: 'background', expected: '#000000' },
      { type: 'content', file: 'server.js', pattern: '#ffffff' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('I-07b should not crash'),
      // After edit, #ffffff is gone → content predicate fails
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  return scenarios;
}

// =============================================================================
// WAVE 2A ADDITIONS TO FAMILY G: F9 OVERLAPPING EDITS, K5 EDGE CASES,
//                                  HTML TEXT/CONTENT, NARROWING QUALITY
// =============================================================================

function generateWave2A_G(appDir: string): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];

  // =========================================================================
  // H-08: Whitespace in text content
  // =========================================================================

  // H-08a: HTML predicate with trimmed text matches source with whitespace
  scenarios.push({
    id: nextId('G', 'H08a_whitespace'),
    family: 'G',
    generator: 'H08a_whitespace_trim',
    failureClass: 'H-08',
    description: 'H-08: HTML text with surrounding whitespace vs trimmed expected text',
    edits: [{ file: 'server.js', search: '<h1>Demo App</h1>', replace: '<h1>  Demo App  </h1>' }],
    predicates: [{ type: 'html', selector: 'h1', expected: 'Demo App' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('H-08a should not crash'),
      // Grounding should handle whitespace normalization
    ],
    requiresDocker: false,
  });

  // H-08b: HTML predicate expects exact whitespace match
  scenarios.push({
    id: nextId('G', 'H08b_whitespace_exact'),
    family: 'G',
    generator: 'H08b_whitespace_exact',
    failureClass: 'H-08',
    description: 'H-08: HTML text with newlines in source — grounding should normalize',
    edits: [{ file: 'server.js', search: '<h1>Demo App</h1>', replace: '<h1>\n  Demo App\n</h1>' }],
    predicates: [{ type: 'html', selector: 'h1', expected: 'Demo App' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('H-08b should not crash')],
    requiresDocker: false,
  });

  // =========================================================================
  // H-09: HTML entities vs literal
  // =========================================================================

  // H-09a: HTML entity in source, literal in expected
  scenarios.push({
    id: nextId('G', 'H09a_entity'),
    family: 'G',
    generator: 'H09a_entity_amp',
    failureClass: 'H-09',
    description: 'H-09: Source has &amp; but predicate expects & — entity decoding',
    edits: [{ file: 'server.js', search: '<p class="subtitle">A minimal app for testing @sovereign-labs/verify</p>', replace: '<p class="subtitle">Tom &amp; Jerry</p>' }],
    predicates: [{ type: 'html', selector: 'p.subtitle', expected: 'Tom & Jerry' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('H-09a should not crash')],
    requiresDocker: false,
  });

  // H-09b: HTML numeric entity
  scenarios.push({
    id: nextId('G', 'H09b_numEntity'),
    family: 'G',
    generator: 'H09b_numeric_entity',
    failureClass: 'H-09',
    description: 'H-09: Source has &#39; (apostrophe) — entity vs literal',
    edits: [{ file: 'server.js', search: '<p class="subtitle">A minimal app for testing @sovereign-labs/verify</p>', replace: '<p class="subtitle">It&#39;s working</p>' }],
    predicates: [{ type: 'html', selector: 'p.subtitle', expected: "It's working" }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('H-09b should not crash')],
    requiresDocker: false,
  });

  // =========================================================================
  // H-10: Case sensitivity in text matching
  // =========================================================================

  // H-10a: Exact case match
  scenarios.push({
    id: nextId('G', 'H10a_caseExact'),
    family: 'G',
    generator: 'H10a_case_exact',
    failureClass: 'H-10',
    description: 'H-10: Exact case match — "Demo App" matches "Demo App"',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{ type: 'html', selector: 'h1', expected: 'Demo App' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('H-10a should not crash'),
      verifySucceeded('Exact case match should pass'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // H-10b: Wrong case — "demo app" vs "Demo App"
  scenarios.push({
    id: nextId('G', 'H10b_caseWrong'),
    family: 'G',
    generator: 'H10b_case_wrong',
    failureClass: 'H-10',
    description: 'H-10: Wrong case — "demo app" does not match "Demo App" (case sensitive)',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{ type: 'html', selector: 'h1', expected: 'demo app' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('H-10b should not crash'),
      // Case sensitivity: "demo app" != "Demo App" → grounding miss
    ],
    requiresDocker: false,
  });

  // H-10c: All uppercase
  scenarios.push({
    id: nextId('G', 'H10c_caseUpper'),
    family: 'G',
    generator: 'H10c_case_upper',
    failureClass: 'H-10',
    description: 'H-10: All uppercase — "DEMO APP" does not match "Demo App"',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{ type: 'html', selector: 'h1', expected: 'DEMO APP' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [shouldNotCrash('H-10c should not crash')],
    requiresDocker: false,
  });

  // =========================================================================
  // N-03: Pattern found in wrong file
  // =========================================================================

  // N-03a: Content predicate with correct file
  scenarios.push({
    id: nextId('G', 'N03a_correctFile'),
    family: 'G',
    generator: 'N03a_content_correctFile',
    failureClass: 'N-03',
    description: 'N-03: Content predicate with correct file reference should pass',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Demo App' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('N-03a should not crash'),
      verifySucceeded('Pattern exists in correct file'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // N-03b: Content predicate with wrong file reference
  scenarios.push({
    id: nextId('G', 'N03b_wrongFile'),
    family: 'G',
    generator: 'N03b_content_wrongFile',
    failureClass: 'N-03',
    description: 'N-03: Content predicate referencing wrong file should fail',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{ type: 'content', file: 'nonexistent.js', pattern: 'Demo App' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('N-03b should not crash'),
      verifyFailedAt('grounding', 'File does not exist → grounding failure'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // =========================================================================
  // N-09: Template syntax as literal
  // =========================================================================

  // N-09a: Content predicate matching template syntax literally
  scenarios.push({
    id: nextId('G', 'N09a_template'),
    family: 'G',
    generator: 'N09a_template_literal',
    failureClass: 'N-09',
    description: 'N-09: Content predicate matching ${variable} as literal text',
    edits: [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>${appName}</title>' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: '${appName}' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('N-09a should not crash'),
      // After edit, the literal string ${appName} is in the file
      verifySucceeded('Template syntax found literally in file'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // =========================================================================
  // N-26: Duplicate pattern count ambiguity
  // =========================================================================

  // N-26a: Pattern exists multiple times — content predicate still passes
  scenarios.push({
    id: nextId('G', 'N26a_dupPattern'),
    family: 'G',
    generator: 'N26a_duplicate_pattern',
    failureClass: 'N-26',
    description: 'N-26: Pattern exists multiple times in file — predicate should still pass',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'res.writeHead' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('N-26a should not crash'),
      // res.writeHead appears 4 times in demo-app server.js — should still pass
      verifySucceeded('Pattern found (even if multiple times)'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // N-26b: Pattern that appears only once
  scenarios.push({
    id: nextId('G', 'N26b_singlePattern'),
    family: 'G',
    generator: 'N26b_single_pattern',
    failureClass: 'N-26',
    description: 'N-26: Pattern appears exactly once — unambiguous match',
    edits: [{ file: 'server.js', search: 'placeholder', replace: 'placeholder' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'A minimal app for testing @sovereign-labs/verify' }],
    config: { appDir, gates: { syntax: false, staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('N-26b should not crash'),
      verifySucceeded('Unique pattern found'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // =========================================================================
  // X-66: Overlapping edits interfere
  // =========================================================================

  // X-66a: Two edits on adjacent lines (non-overlapping — should both apply)
  scenarios.push({
    id: nextId('G', 'X66a_adjacentEdits'),
    family: 'G',
    generator: 'X66a_adjacent_edits',
    failureClass: 'X-66',
    description: 'X-66: Two edits on adjacent but non-overlapping regions should both apply',
    edits: [
      { file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' },
      { file: 'server.js', search: 'font-size: 2rem', replace: 'font-size: 3rem' },
    ],
    predicates: [
      { type: 'css', selector: 'h1', property: 'color', expected: 'red' },
      { type: 'css', selector: 'h1', property: 'font-size', expected: '3rem' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-66a should not crash'),
      verifySucceeded('Adjacent edits should both apply cleanly'),
    ],
    requiresDocker: false,
    expectedSuccess: true,
  });

  // X-66b: Two edits on same line — second edit's search includes first edit's target
  scenarios.push({
    id: nextId('G', 'X66b_sameLineOverlap'),
    family: 'G',
    generator: 'X66b_sameLine_overlap',
    failureClass: 'X-66',
    description: 'X-66: Two edits targeting the same line — potential conflict',
    edits: [
      { file: 'server.js', search: 'h1 { color: #1a1a2e; font-size: 2rem; }', replace: 'h1 { color: red; font-size: 2rem; }' },
      { file: 'server.js', search: 'h1 { color: red; font-size: 2rem; }', replace: 'h1 { color: red; font-size: 3rem; }' },
    ],
    predicates: [
      { type: 'css', selector: 'h1', property: 'color', expected: 'red' },
      { type: 'css', selector: 'h1', property: 'font-size', expected: '3rem' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-66b should not crash'),
      // Second edit depends on first edit's output — sequential application needed
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // X-67: Edit order changes final result (non-commutative)
  // =========================================================================

  // X-67a: Two edits where order matters
  scenarios.push({
    id: nextId('G', 'X67a_orderMatters'),
    family: 'G',
    generator: 'X67a_edit_order',
    failureClass: 'X-67',
    description: 'X-67: Edit order matters — first edit creates search target for second',
    edits: [
      { file: 'server.js', search: 'Demo App', replace: 'Test App' },
      { file: 'server.js', search: '<title>Test App</title>', replace: '<title>Final App</title>' },
    ],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Final App' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-67a should not crash'),
      // If edits are applied in order: Demo App → Test App → Final App (success)
      // If edits are reversed: <title>Test App</title> not found (first edit hasn't run)
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // X-68: Search/replace hits previous replacement
  // =========================================================================

  // X-68a: Replacement text from edit 1 contains search string from edit 2
  scenarios.push({
    id: nextId('G', 'X68a_replacementHit'),
    family: 'G',
    generator: 'X68a_replacement_hit',
    failureClass: 'X-68',
    description: 'X-68: Edit 1 replacement creates text that edit 2 searches for',
    edits: [
      { file: 'server.js', search: 'Demo App', replace: 'New Demo App' },
      { file: 'server.js', search: 'New Demo', replace: 'Final' },
    ],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Final App' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-68a should not crash'),
      // Edit 1: "Demo App" → "New Demo App"
      // Edit 2: "New Demo" → "Final" (matches within edit 1's replacement)
      // Result: "Final App"
    ],
    requiresDocker: false,
  });

  // X-68b: Replacement creates ambiguity (appears multiple times after first edit)
  scenarios.push({
    id: nextId('G', 'X68b_replacementAmbiguity'),
    family: 'G',
    generator: 'X68b_replacement_ambiguity',
    failureClass: 'X-68',
    description: 'X-68: Edit 1 replacement makes edit 2 search string ambiguous',
    edits: [
      { file: 'server.js', search: '<h1>Demo App</h1>', replace: '<h1>App</h1>' },
      { file: 'server.js', search: 'App', replace: 'Application' },
    ],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Application' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-68b should not crash'),
      // After edit 1: "App" appears in <h1>App</h1> and also in "Demo App" in <title>
      // Edit 2 search for "App" is now ambiguous → F9 should catch this
    ],
    requiresDocker: false,
  });

  // =========================================================================
  // X-16: Concurrent constraint seeding (K5 edge case)
  // =========================================================================

  // X-16a: Multiple failures seed constraints — verify they don't conflict
  scenarios.push({
    id: nextId('G', 'X16a_concurrentSeeding'),
    family: 'G',
    generator: 'X16a_concurrent_constraints',
    failureClass: 'X-16',
    description: 'X-16: Multiple failing predicates seed distinct constraints',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
    predicates: [
      { type: 'css', selector: '.nonexistent1', property: 'color', expected: 'red' },
      { type: 'css', selector: '.nonexistent2', property: 'color', expected: 'blue' },
    ],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-16a should not crash'),
      // Both predicates reference fabricated selectors → grounding failures
      // Each should seed a distinct constraint (different fingerprints)
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // =========================================================================
  // X-17: Constraint with empty appliesTo
  // =========================================================================

  // X-17a: Constraint seeded with minimal predicate
  scenarios.push({
    id: nextId('G', 'X17a_emptyAppliesTo'),
    family: 'G',
    generator: 'X17a_empty_appliesTo',
    failureClass: 'X-17',
    description: 'X-17: Predicate with minimal fields still produces valid constraint',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
    predicates: [{ type: 'css', selector: '.nonexistent' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-17a should not crash'),
      // Minimal predicate: type + selector only, no property, no expected
      // Should still produce a valid fingerprint and constraint
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // =========================================================================
  // X-43: Hint references actual values
  // =========================================================================

  // X-43a: Failed grounding produces hint with real selector info
  scenarios.push({
    id: nextId('G', 'X43a_hintActualValues'),
    family: 'G',
    generator: 'X43a_hint_actual_values',
    failureClass: 'X-43',
    description: 'X-43: Grounding failure hint should reference available selectors',
    edits: [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
    predicates: [{ type: 'css', selector: '.completely-made-up', property: 'color', expected: 'red' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-43a should not crash'),
      narrowingPresent(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // =========================================================================
  // X-44: Hint is actionable
  // =========================================================================

  // X-44a: F9 failure (search not found) produces actionable hint
  scenarios.push({
    id: nextId('G', 'X44a_actionableHint'),
    family: 'G',
    generator: 'X44a_actionable_hint',
    failureClass: 'X-44',
    description: 'X-44: F9 search-not-found failure produces actionable hint',
    edits: [{ file: 'server.js', search: 'THIS_STRING_DOES_NOT_EXIST_ANYWHERE', replace: 'replacement' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'replacement' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-44a should not crash'),
      verifyFailedAt('F9', 'Search string not found'),
      narrowingPresent(),
      narrowingHintContains('not'),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // X-44b: F9 ambiguous edit produces actionable hint
  scenarios.push({
    id: nextId('G', 'X44b_ambiguousHint'),
    family: 'G',
    generator: 'X44b_ambiguous_hint',
    failureClass: 'X-44',
    description: 'X-44: F9 ambiguous search string produces hint about uniqueness',
    edits: [{ file: 'server.js', search: 'res.end', replace: 'res.end' }],  // "res.end" appears multiple times
    predicates: [{ type: 'content', file: 'server.js', pattern: 'res.end' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-44b should not crash'),
      // "res.end" appears 4 times → ambiguous → F9 should fail
      verifyFailedAt('F9', 'Ambiguous search string'),
      narrowingPresent(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
  });

  // =========================================================================
  // X-45: No hint on infrastructure error
  // =========================================================================

  // X-45a: Missing file → grounding failure is not an infra error
  scenarios.push({
    id: nextId('G', 'X45a_noInfraHint'),
    family: 'G',
    generator: 'X45a_no_infra_hint',
    failureClass: 'X-45',
    description: 'X-45: Missing file failure should produce a helpful hint (not infra)',
    edits: [{ file: 'nonexistent.js', search: 'old', replace: 'new' }],
    predicates: [{ type: 'content', file: 'server.js', pattern: 'Demo App' }],
    config: { appDir, gates: { staging: false, browser: false, http: false } },
    invariants: [
      shouldNotCrash('X-45a should not crash'),
      verifyFailedAt('F9', 'File not found'),
      narrowingPresent(),
    ],
    requiresDocker: false,
    expectedSuccess: false,
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
    ...generateFamilyH(appDir),
    ...generateFamilyI(appDir),
    ...generateFamilyM(appDir),
    ...generateFamilyP(appDir),
    ...generateFamilyV(appDir),
    ...generateWave2A_G(appDir),
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
    case 'G': return [...generateFamilyG(appDir), ...generateWave2A_G(appDir)];
    case 'H': return generateFamilyH(appDir);
    case 'I': return generateFamilyI(appDir);
    case 'M': return generateFamilyM(appDir);
    case 'P': return generateFamilyP(appDir);
    case 'V': return generateFamilyV(appDir);
  }
}
