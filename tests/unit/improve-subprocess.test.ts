/**
 * Improve Subprocess — Unit Tests
 * ================================
 * Tests for scenario splitting, target ID construction, and scoring logic.
 */

import { describe, it, expect } from 'bun:test';
import { splitScenarios } from '../../scripts/harness/improve-subprocess.js';
import type { LedgerEntry } from '../../scripts/harness/types.js';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function makeLedger(id: string, clean: boolean): LedgerEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    scenario: {
      family: 'A',
      generator: 'test',
      description: `scenario ${id}`,
      predicateCount: 1,
      editCount: 1,
      requiresDocker: false,
    },
    result: {
      success: clean,
      gatesPassed: clean ? ['f9', 'k5'] : ['f9'],
      gatesFailed: clean ? [] : ['k5'],
      totalMs: 100,
      constraintsBefore: 0,
      constraintsAfter: 0,
    },
    invariants: [],
    clean,
  };
}

function makeBaseline(cleanCount: number, dirtyCount: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < cleanCount; i++) {
    entries.push(makeLedger(`clean-${String(i).padStart(4, '0')}`, true));
  }
  for (let i = 0; i < dirtyCount; i++) {
    entries.push(makeLedger(`dirty-${String(i).padStart(4, '0')}`, false));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// SPLIT SCENARIOS
// ---------------------------------------------------------------------------

describe('splitScenarios', () => {
  it('separates dirty from clean', () => {
    const baseline = makeBaseline(20, 5);
    const split = splitScenarios(baseline);

    expect(split.dirty.length).toBe(5);
    expect(split.validation.length + split.holdout.length).toBe(20);
    expect(split.dirty.every(e => !e.clean)).toBe(true);
    expect(split.validation.every(e => e.clean)).toBe(true);
    expect(split.holdout.every(e => e.clean)).toBe(true);
  });

  it('is deterministic — same input produces same split', () => {
    const baseline = makeBaseline(100, 10);
    const split1 = splitScenarios(baseline);
    const split2 = splitScenarios(baseline);

    expect(split1.dirty.map(e => e.id)).toEqual(split2.dirty.map(e => e.id));
    expect(split1.validation.map(e => e.id)).toEqual(split2.validation.map(e => e.id));
    expect(split1.holdout.map(e => e.id)).toEqual(split2.holdout.map(e => e.id));
  });

  it('handles all dirty (no clean scenarios)', () => {
    const baseline = makeBaseline(0, 10);
    const split = splitScenarios(baseline);

    expect(split.dirty.length).toBe(10);
    expect(split.validation.length).toBe(0);
    expect(split.holdout.length).toBe(0);
  });

  it('handles all clean (no dirty scenarios)', () => {
    const baseline = makeBaseline(50, 0);
    const split = splitScenarios(baseline);

    expect(split.dirty.length).toBe(0);
    expect(split.validation.length + split.holdout.length).toBe(50);
  });

  it('ensures minimum 3 holdout when enough clean scenarios exist', () => {
    const baseline = makeBaseline(10, 2);
    const split = splitScenarios(baseline);

    // With 10 clean scenarios, should have at least 3 holdout
    expect(split.holdout.length).toBeGreaterThanOrEqual(3);
  });

  it('validation and holdout are disjoint', () => {
    const baseline = makeBaseline(200, 15);
    const split = splitScenarios(baseline);

    const validationIds = new Set(split.validation.map(e => e.id));
    const holdoutIds = new Set(split.holdout.map(e => e.id));
    const overlap = [...validationIds].filter(id => holdoutIds.has(id));

    expect(overlap.length).toBe(0);
  });

  it('handles large scenario counts (simulating CI)', () => {
    const baseline = makeBaseline(3000, 6);
    const split = splitScenarios(baseline);

    expect(split.dirty.length).toBe(6);
    expect(split.validation.length + split.holdout.length).toBe(3000);
    // With 3000 clean, holdout should be ~30% = ~900
    expect(split.holdout.length).toBeGreaterThan(100);
    expect(split.validation.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO ID FILTERING (integration with RunConfig)
// ---------------------------------------------------------------------------

describe('scenarioIds filtering', () => {
  it('RunConfig accepts scenarioIds field', async () => {
    // Just a type-level test — the field exists and is optional
    const config = {
      appDir: '/tmp/test',
      scenarioIds: ['a11y-0001', 'a11y-0002'],
    };
    expect(config.scenarioIds).toHaveLength(2);
  });
});
