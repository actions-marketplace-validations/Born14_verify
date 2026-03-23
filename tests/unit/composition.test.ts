import { describe, test, expect } from 'bun:test';
import {
  decomposeFailure,
  productComposition,
  temporalComposition,
  getKnownCompositions,
  decomposeComposition,
  isComposition,
  isKnownShape,
  getShapeCatalog,
  scoreDecomposition,
  sortShapes,
  minimizeShapes,
} from '../../src/store/decompose.js';
import type { DecomposedShape, TemporalMode } from '../../src/store/decompose.js';
import type { VerifyResult, GateResult, PredicateResult } from '../../src/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    success: false,
    gates: [],
    attestation: '',
    timing: { totalMs: 100, perGate: {} },
    ...overrides,
  };
}

function makeGate(gate: string, passed: boolean, detail = '', durationMs = 10): GateResult {
  return { gate: gate as any, passed, detail, durationMs };
}

function makePredResult(overrides: Partial<PredicateResult> = {}): PredicateResult {
  return {
    predicateId: 'p1',
    type: 'css',
    passed: false,
    fingerprint: 'test',
    ...overrides,
  };
}

// =============================================================================
// 3.1 — COMPOSITION SHAPE CATALOG
// =============================================================================

describe('3.1 — Composition Shape Catalog', () => {
  test('I-05 through I-10 exist in shape catalog', () => {
    for (let i = 5; i <= 10; i++) {
      const id = `I-${i.toString().padStart(2, '0')}`;
      expect(isKnownShape(id)).toBe(true);
    }
  });

  test('all composition shapes are in interaction domain', () => {
    const catalog = getShapeCatalog();
    const compositionShapes = catalog.filter(s => s.id.match(/^I-0[5-9]$|^I-10$/));
    expect(compositionShapes.length).toBe(6);
    for (const s of compositionShapes) {
      expect(s.domain).toBe('interaction');
    }
  });

  test('composition shapes have correct claim types', () => {
    const catalog = getShapeCatalog();
    const byId = new Map(catalog.map(s => [s.id, s]));

    // I-05 CSS×HTTP = equality
    expect(byId.get('I-05')?.claimType).toBe('equality');
    // I-07 HTML×Content = containment
    expect(byId.get('I-07')?.claimType).toBe('containment');
  });

  test('staging shapes I-01 through I-04 still exist', () => {
    for (let i = 1; i <= 4; i++) {
      const id = `I-${i.toString().padStart(2, '0')}`;
      expect(isKnownShape(id)).toBe(true);
    }
  });
});

// =============================================================================
// 3.2 — PRODUCT COMPOSITION OPERATOR (×)
// =============================================================================

describe('3.2 — Product Composition Operator (×)', () => {
  test('CSS × HTTP → I-05', () => {
    const composed = productComposition('C-33', 'P-07');
    expect(composed).toBeDefined();
    expect(composed!.id).toBe('I-05');
    expect(composed!.domain).toBe('interaction');
  });

  test('CSS × HTML → I-06', () => {
    const composed = productComposition('C-33', 'H-01');
    expect(composed).toBeDefined();
    expect(composed!.id).toBe('I-06');
  });

  test('HTML × Content → I-07', () => {
    const composed = productComposition('H-01', 'N-06');
    expect(composed).toBeDefined();
    expect(composed!.id).toBe('I-07');
  });

  test('HTTP × DB → I-08', () => {
    const composed = productComposition('P-07', 'D-01');
    expect(composed).toBeDefined();
    expect(composed!.id).toBe('I-08');
  });

  test('CSS × Content → I-09', () => {
    const composed = productComposition('C-33', 'N-06');
    expect(composed).toBeDefined();
    expect(composed!.id).toBe('I-09');
  });

  test('HTML × HTTP → I-10', () => {
    const composed = productComposition('H-01', 'P-07');
    expect(composed).toBeDefined();
    expect(composed!.id).toBe('I-10');
  });

  test('same domain → undefined (not a product)', () => {
    const composed = productComposition('C-33', 'C-01');
    expect(composed).toBeUndefined();
  });

  test('unknown shape IDs → undefined', () => {
    const composed = productComposition('FAKE-01', 'FAKE-02');
    expect(composed).toBeUndefined();
  });

  test('composition confidence is product of inputs × 0.95', () => {
    const composed = productComposition('C-33', 'P-07');
    expect(composed).toBeDefined();
    // C-33 confidence = 0.9, P-07 confidence = 0.9
    // min(0.9, 0.9) * 0.95 = 0.855
    expect(composed!.confidence).toBeCloseTo(0.855, 2);
  });

  test('commutativity: A × B = B × A', () => {
    const ab = productComposition('C-33', 'P-07');
    const ba = productComposition('P-07', 'C-33');
    expect(ab).toBeDefined();
    expect(ba).toBeDefined();
    expect(ab!.id).toBe(ba!.id);
  });

  test('no known composition for filesystem × vision', () => {
    const composed = productComposition('FS-01', 'V-01');
    expect(composed).toBeUndefined();
  });
});

// =============================================================================
// 3.3 — TEMPORAL COMPOSITION OPERATOR (⊗)
// =============================================================================

describe('3.3 — Temporal Composition Operator (⊗)', () => {
  const modes: TemporalMode[] = ['snapshot', 'settled', 'ordered', 'stable', 'fresh'];

  test('any shape ⊗ any mode → shape with temporal annotation', () => {
    for (const mode of modes) {
      const composed = temporalComposition('C-33', mode);
      expect(composed).toBeDefined();
      expect(composed!.id).toBe('C-33');
      expect(composed!.temporal).toBe(mode);
    }
  });

  test('unknown shape → undefined', () => {
    const composed = temporalComposition('FAKE-99', 'fresh');
    expect(composed).toBeUndefined();
  });

  test('temporal composition preserves all shape fields', () => {
    const composed = temporalComposition('C-33', 'fresh');
    expect(composed).toBeDefined();
    expect(composed!.domain).toBe('css');
    expect(composed!.name).toBe('CSS value mismatch');
    expect(composed!.claimType).toBe('equality');
    expect(composed!.truthType).toBe('deterministic');
    expect(composed!.confidence).toBe(0.9);
    expect(composed!.temporal).toBe('fresh');
  });

  test('each temporal mode produces distinct shape', () => {
    const shapes = modes.map(m => temporalComposition('P-07', m));
    const temporals = shapes.map(s => s!.temporal);
    expect(new Set(temporals).size).toBe(5);
  });
});

// =============================================================================
// 3.4 — KNOWN COMPOSITIONS ENUMERATION
// =============================================================================

describe('3.4 — Known Compositions Enumeration', () => {
  test('getKnownCompositions returns 6 entries', () => {
    const compositions = getKnownCompositions();
    expect(compositions.length).toBe(6);
  });

  test('each composition has two distinct domains', () => {
    const compositions = getKnownCompositions();
    for (const c of compositions) {
      expect(c.domains.length).toBe(2);
      expect(c.domains[0]).not.toBe(c.domains[1]);
    }
  });

  test('all composition shape IDs are known', () => {
    const compositions = getKnownCompositions();
    for (const c of compositions) {
      expect(isKnownShape(c.shapeId)).toBe(true);
    }
  });

  test('composition names are non-empty', () => {
    const compositions = getKnownCompositions();
    for (const c of compositions) {
      expect(c.name.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// 3.5 — PRODUCT COMPOSITION DETECTION (decomposeFailure)
// =============================================================================

describe('3.5 — Product Composition Detection via decomposeFailure', () => {
  test('CSS + HTTP failure → detects I-05 composition', () => {
    const r = decomposeFailure(makeResult({
      gates: [makeGate('grounding', true), makeGate('verify', false, 'predicates failed')],
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'status 200' }),
      ],
    }));
    expect(r.composition).toBeDefined();
    expect(r.shapes.some(s => s.id === 'I-05')).toBe(true);
    // Also has atomic shapes
    expect(r.shapes.some(s => s.domain === 'css')).toBe(true);
    expect(r.shapes.some(s => s.domain === 'http')).toBe(true);
  });

  test('CSS + HTML failure → detects I-06 composition', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'html', passed: false, actual: '(not found)' }),
      ],
    }));
    expect(r.composition).toBeDefined();
    expect(r.shapes.some(s => s.id === 'I-06')).toBe(true);
  });

  test('HTML + Content failure → detects I-07 composition', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'html', passed: false, actual: '(not found)' }),
        makePredResult({ predicateId: 'p2', type: 'content', passed: false }),
      ],
    }));
    expect(r.composition).toBeDefined();
    expect(r.shapes.some(s => s.id === 'I-07')).toBe(true);
  });

  test('HTTP + DB failure → detects I-08 composition', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'http', passed: false, expected: 'body: items' }),
        makePredResult({ predicateId: 'p2', type: 'db', passed: false, expected: 'table users' }),
      ],
    }));
    expect(r.composition).toBeDefined();
    expect(r.shapes.some(s => s.id === 'I-08')).toBe(true);
  });

  test('CSS + Content failure → detects I-09 composition', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'content', passed: false }),
      ],
    }));
    expect(r.composition).toBeDefined();
    expect(r.shapes.some(s => s.id === 'I-09')).toBe(true);
  });

  test('HTML + HTTP failure → detects I-10 composition', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'html', passed: false, actual: '(not found)' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'body: test' }),
      ],
    }));
    expect(r.composition).toBeDefined();
    expect(r.shapes.some(s => s.id === 'I-10')).toBe(true);
  });

  test('single-domain failure → no composition shape', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'css', passed: false, expected: 'bold', actual: 'normal' }),
      ],
    }));
    // Should NOT have I-05 through I-10
    const compositionShapes = r.shapes.filter(s => s.id.match(/^I-0[5-9]$|^I-10$/));
    expect(compositionShapes.length).toBe(0);
  });

  test('all pass → no composition', () => {
    const r = decomposeFailure(makeResult({
      success: true,
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: true }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: true }),
      ],
    }));
    const compositionShapes = r.shapes.filter(s => s.id.match(/^I-0[5-9]$|^I-10$/));
    expect(compositionShapes.length).toBe(0);
  });
});

// =============================================================================
// 3.6 — ROUND-TRIP DECOMPOSITION (closure property)
// =============================================================================

describe('3.6 — Round-Trip Decomposition (Closure Property)', () => {
  test('CSS × HTTP round-trip: compose → decompose recovers components', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'status 200' }),
      ],
    });
    const { atomicShapes, compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape).toBeDefined();
    expect(compositionShape!.id).toBe('I-05');
    expect(atomicShapes.some(s => s.domain === 'css')).toBe(true);
    expect(atomicShapes.some(s => s.domain === 'http')).toBe(true);
  });

  test('CSS × HTML round-trip', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'html', passed: false, actual: '(not found)' }),
      ],
    });
    const { atomicShapes, compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape!.id).toBe('I-06');
    const domains = new Set(atomicShapes.map(s => s.domain));
    expect(domains.has('css')).toBe(true);
    expect(domains.has('html')).toBe(true);
  });

  test('HTML × Content round-trip', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'html', passed: false, actual: '(not found)' }),
        makePredResult({ predicateId: 'p2', type: 'content', passed: false }),
      ],
    });
    const { compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape!.id).toBe('I-07');
  });

  test('HTTP × DB round-trip', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'http', passed: false, expected: 'body: items' }),
        makePredResult({ predicateId: 'p2', type: 'db', passed: false, expected: 'table users' }),
      ],
    });
    const { compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape!.id).toBe('I-08');
  });

  test('CSS × Content round-trip', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'content', passed: false }),
      ],
    });
    const { compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape!.id).toBe('I-09');
  });

  test('HTML × HTTP round-trip', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'html', passed: false, actual: '(not found)' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'body: test' }),
      ],
    });
    const { compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape!.id).toBe('I-10');
  });

  test('single-domain failure round-trip: no composition expected', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
      ],
    });
    const { atomicShapes, compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape).toBeUndefined();
    expect(atomicShapes.length).toBeGreaterThan(0);
  });

  test('unknown domain pair: round-trip valid (no known composition)', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'filesystem_exists', passed: false }),
        makePredResult({ predicateId: 'p2', type: 'db', passed: false, expected: 'table users' }),
      ],
    });
    const { compositionShape, roundTripValid } = decomposeComposition(result);
    expect(roundTripValid).toBe(true);
    expect(compositionShape).toBeUndefined();
  });
});

// =============================================================================
// 3.7 — COMPOSITION SORTING & SCORING
// =============================================================================

describe('3.7 — Composition Sorting & Scoring', () => {
  test('composition shapes sort after atomic shapes (specificity 2)', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'status 200' }),
      ],
    }));
    // Find positions
    const cssIdx = r.shapes.findIndex(s => s.domain === 'css');
    const httpIdx = r.shapes.findIndex(s => s.domain === 'http');
    const compIdx = r.shapes.findIndex(s => s.domain === 'interaction');
    expect(cssIdx).toBeLessThan(compIdx);
    expect(httpIdx).toBeLessThan(compIdx);
  });

  test('composition reduces decomposition score (more shapes = lower parsimony)', () => {
    // Single shape
    const singleScore = scoreDecomposition([{
      id: 'C-33', domain: 'css', name: 'CSS value mismatch',
      claimType: 'equality', truthType: 'deterministic', confidence: 0.9,
    }]);

    // Composition (3 shapes: css + http + interaction)
    const compScore = scoreDecomposition([
      { id: 'C-33', domain: 'css', name: 'CSS value mismatch', claimType: 'equality', truthType: 'deterministic', confidence: 0.9 },
      { id: 'P-07', domain: 'http', name: 'HTTP status', claimType: 'equality', truthType: 'deterministic', confidence: 0.9 },
      { id: 'I-05', domain: 'interaction', name: 'CSS×HTTP', claimType: 'equality', truthType: 'deterministic', confidence: 0.85 },
    ]);

    expect(singleScore).toBeGreaterThan(compScore);
  });

  test('minimization preserves composition shapes alongside atomics', () => {
    const shapes: DecomposedShape[] = [
      { id: 'C-33', domain: 'css', name: 'CSS value mismatch', claimType: 'equality', truthType: 'deterministic', confidence: 0.9 },
      { id: 'P-07', domain: 'http', name: 'HTTP status', claimType: 'equality', truthType: 'deterministic', confidence: 0.9 },
      { id: 'I-05', domain: 'interaction', name: 'CSS×HTTP', claimType: 'equality', truthType: 'deterministic', confidence: 0.85 },
    ];
    const minimized = minimizeShapes(shapes);
    // All three should survive — interaction is specificity 2 (not cross-cutting)
    expect(minimized.length).toBe(3);
    expect(minimized.some(s => s.id === 'I-05')).toBe(true);
  });
});

// =============================================================================
// 3.8 — TRIPLE PRODUCT COMPOSITION
// =============================================================================

describe('3.8 — Triple Product Composition', () => {
  test('CSS + HTML + Content → detects multiple composition shapes', () => {
    const r = decomposeFailure(makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'html', passed: false, actual: '(not found)' }),
        makePredResult({ predicateId: 'p3', type: 'content', passed: false }),
      ],
    }));
    expect(r.composition).toBeDefined();
    // Should have composition from 3 domains
    const domains = new Set(r.shapes.map(s => s.domain));
    expect(domains.size).toBeGreaterThanOrEqual(3);
    // Should detect at least some pairwise compositions
    const compositionIds = r.shapes.filter(s => s.domain === 'interaction').map(s => s.id);
    expect(compositionIds.length).toBeGreaterThanOrEqual(1);
  });

  test('triple product has lower score than double product', () => {
    const doubleResult = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'status 200' }),
      ],
    });
    const tripleResult = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'html', passed: false, actual: '(not found)' }),
        makePredResult({ predicateId: 'p3', type: 'content', passed: false }),
      ],
    });
    const doubleDecomp = decomposeFailure(doubleResult);
    const tripleDecomp = decomposeFailure(tripleResult);
    const doubleScore = scoreDecomposition(doubleDecomp.shapes);
    const tripleScore = scoreDecomposition(tripleDecomp.shapes);
    expect(doubleScore).toBeGreaterThan(tripleScore);
  });
});

// =============================================================================
// 3.9 — TEMPORAL COMPOSITION IN DECOMPOSITION
// =============================================================================

describe('3.9 — Temporal Composition in Decomposition', () => {
  test('cache/stale context → fresh temporal annotation on shapes', () => {
    const r = decomposeFailure(makeResult({
      gates: [makeGate('verify', false, 'stale cached response returned')],
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
      ],
    }));
    expect(r.shapes.some(s => s.temporal === 'fresh')).toBe(true);
  });

  test('timeout context → settled temporal annotation', () => {
    const r = decomposeFailure(makeResult({
      gates: [makeGate('staging', false, 'container timed out during hydration')],
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'html', passed: false, actual: '(not found)' }),
      ],
    }));
    expect(r.shapes.some(s => s.temporal === 'settled')).toBe(true);
  });

  test('sequence context → ordered temporal annotation', () => {
    const r = decomposeFailure(makeResult({
      gates: [makeGate('verify', false, 'step 2 in sequence failed')],
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'http_sequence', passed: false }),
      ],
    }));
    expect(r.shapes.some(s => s.temporal === 'ordered')).toBe(true);
  });

  test('composition + temporal = both annotations present', () => {
    const r = decomposeFailure(makeResult({
      gates: [makeGate('verify', false, 'cached stale CSS served')],
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'status 200' }),
      ],
    }));
    // Should have composition (multi-domain)
    expect(r.composition).toBeDefined();
    // Should have temporal annotation
    expect(r.shapes.some(s => s.temporal === 'fresh')).toBe(true);
  });
});

// =============================================================================
// 3.10 — IDEMPOTENCE OF COMPOSITION DETECTION
// =============================================================================

describe('3.10 — Idempotence of Composition Detection', () => {
  test('decomposing same result twice produces identical shapes', () => {
    const result = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'http', passed: false, expected: 'status 200' }),
      ],
    });
    const r1 = decomposeFailure(result);
    const r2 = decomposeFailure(result);
    expect(r1.shapes.map(s => s.id)).toEqual(r2.shapes.map(s => s.id));
    expect(r1.composition).toEqual(r2.composition);
    expect(r1.outcome).toBe(r2.outcome);
  });

  test('composition detection is order-independent (predicate order)', () => {
    const result1 = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
        makePredResult({ predicateId: 'p2', type: 'html', passed: false, actual: '(not found)' }),
      ],
    });
    const result2 = makeResult({
      predicateResults: [
        makePredResult({ predicateId: 'p2', type: 'html', passed: false, actual: '(not found)' }),
        makePredResult({ predicateId: 'p1', type: 'css', passed: false, expected: 'green', actual: 'red' }),
      ],
    });
    const r1 = decomposeFailure(result1);
    const r2 = decomposeFailure(result2);
    // Same shapes (order may differ by sort, but IDs should be same set)
    const ids1 = new Set(r1.shapes.map(s => s.id));
    const ids2 = new Set(r2.shapes.map(s => s.id));
    expect(ids1).toEqual(ids2);
  });
});
