// Regression tests for SI-002 (Apr 8 2026): discover-shapes silently dropped
// 9+ shapes over 3 nights because (1) the empty-gate fallback resolved to an
// 'unknown' domain that had no taxonomy section, and (2) the appender logged
// a warning and continued instead of failing loud.
//
// These tests pin both halves of the fix:
//   * Routing test  — empty gatesFailed must produce a 'crosscutting' domain
//                     shape with an X- prefix.
//   * Fail-loud test — appendToTaxonomy must throw (not warn-and-continue) when
//                     a domain has no matching section in FAILURE-TAXONOMY.md.
//
// See SCANNER-INCIDENTS.md SI-002 for the full incident write-up.

import { describe, test, expect } from 'bun:test';
import {
  appendToTaxonomy,
  proposeShape,
  type CandidateShape,
  type FailureCluster,
} from '../../scripts/harness/discover-shapes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCluster(overrides: Partial<FailureCluster> = {}): FailureCluster {
  return {
    key: { gate: 'crosscutting', errorSignature: 'test::sig' },
    count: 5,
    entries: [
      {
        id: 'test-entry-1',
        scenario: {
          family: 'FUZZ',
          generator: 'type_swap',
          description: 'False positive still present: verify passed but should fail',
        },
        result: {
          success: true,
          gatesFailed: [],
          error: undefined,
        },
        invariants: [
          {
            name: 'expected_failure_detected',
            passed: false,
            violation: 'False positive still present: verify passed but should fail',
            severity: 'error',
          },
        ],
        clean: false,
      } as any,
    ],
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateShape> = {}): CandidateShape {
  return {
    proposedId: 'TEST-999',
    domain: 'nonexistent_domain_for_test',
    description: 'Test shape for fail-loud regression coverage',
    claimType: 'equality',
    evidence: {
      gate: 'crosscutting',
      errorSignature: 'test::sig',
      occurrences: 1,
      sampleScenarios: ['test scenario'],
    },
    status: 'confirmed',
    discoveredAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SI-002 Routing test
// ─────────────────────────────────────────────────────────────────────────────

describe('SI-002: empty-gate fallback routes to crosscutting', () => {
  test('cluster with empty gatesFailed proposes a shape in the crosscutting domain', () => {
    // Simulate the exact pattern that produced X-103/X-104/X-105 in the
    // nightly that motivated SI-002: a "verify passed but should fail"
    // meta-failure where no specific gate fired, so gatesFailed is empty.
    // The clusterer's fallback gate must be 'crosscutting' (not 'invariant'),
    // and proposeShape must classify it into the 'crosscutting' domain so the
    // appender lands it in the X-series Gate-Level section.
    const cluster = makeCluster({
      key: { gate: 'crosscutting', errorSignature: 'fuzz::false_negative' },
    });

    const shape = proposeShape(cluster, new Set());

    expect(shape.domain).toBe('crosscutting');
    // X- prefix matches the existing X-01..X-56 series in
    // ## Cross-Cutting Failures (Gate-Level).
    expect(shape.proposedId).toMatch(/^X-\d+$/);
  });

  test('proposeShape never falls back to the unknown domain for crosscutting clusters', () => {
    // Negative assertion: the 'unknown' domain was the silent-drop trigger.
    // If a future refactor reintroduces it, this test fails immediately.
    const cluster = makeCluster();
    const shape = proposeShape(cluster, new Set());
    expect(shape.domain).not.toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SI-002 Fail-loud test
// ─────────────────────────────────────────────────────────────────────────────

describe('SI-002: appendToTaxonomy fails loud on unroutable domain', () => {
  test('throws (not warns) when a shape domain has no section in FAILURE-TAXONOMY.md', () => {
    // Synthetic shape with a domain that intentionally has no matching
    // section in FAILURE-TAXONOMY.md. Pre-fix this would log a warning and
    // continue with appended=0 and exit 0. Post-fix it must throw.
    const shape = makeCandidate({
      proposedId: 'TEST-999',
      domain: 'nonexistent_domain_for_test',
    });

    expect(() => appendToTaxonomy([shape], new Map())).toThrow(
      /no section for domain/,
    );
  });

  test('error message names the dropped shape IDs so the operator can recover them', () => {
    const shapes = [
      makeCandidate({ proposedId: 'TEST-901', domain: 'nonexistent_domain_for_test' }),
      makeCandidate({ proposedId: 'TEST-902', domain: 'nonexistent_domain_for_test' }),
      makeCandidate({ proposedId: 'TEST-903', domain: 'nonexistent_domain_for_test' }),
    ];

    let caught: Error | undefined;
    try {
      appendToTaxonomy(shapes, new Map());
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('TEST-901');
    expect(caught!.message).toContain('TEST-902');
    expect(caught!.message).toContain('TEST-903');
    expect(caught!.message).toContain('nonexistent_domain_for_test');
    expect(caught!.message).toMatch(/SI-002/);
  });
});
