#!/usr/bin/env bun
/**
 * Auto-Triage — Post-flight dirty entry classification
 * ======================================================
 *
 * Runs AFTER self-test. Reads the self-test ledger. For each dirty entry,
 * classifies into one of three buckets:
 *
 *   gate_bug       — Gate gave wrong answer. Improve loop fuel.
 *   scenario_bug   — Scenario is stale or misconfigured. Fix or remove.
 *   fixture_limit  — Demo-app can't test what the gate checks. Informational.
 *
 * Cross-references data/fixture-gaps.json (from fixture auditor) and
 * data/stale-scenarios.json (from scenario quality monitor) when available.
 *
 * Output: data/triage-results.json
 *
 * Usage:
 *   bun scripts/harness/auto-triage.ts
 *   bun scripts/harness/auto-triage.ts --ledger=path/to/ledger.jsonl
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const PKG_ROOT = resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);

const ledgerArg = args.find(a => a.startsWith('--ledger='))?.split('=')[1];
const ledgerPath = ledgerArg || resolve(PKG_ROOT, 'data', 'self-test-ledger.jsonl');
const appDir = resolve(PKG_ROOT, 'fixtures', 'demo-app');
const outputPath = resolve(PKG_ROOT, 'data', 'triage-results.json');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LedgerEntry {
  id: string;
  scenario: {
    family: string;
    generator: string;
    description: string;
    failureClass?: string;
    editCount?: number;
    predicateCount?: number;
  };
  result: {
    success: boolean | null;
    gatesPassed: string[];
    gatesFailed: string[];
    error?: string;
    totalMs?: number;
  };
  invariants: Array<{
    name: string;
    passed: boolean;
    violation?: string;
    severity?: string;
    category?: string;
  }>;
  clean: boolean;
}

type TriageClass = 'gate_bug' | 'scenario_bug' | 'fixture_limit' | 'unclassified';

interface TriagedEntry {
  id: string;
  classification: TriageClass;
  reason: string;
  gate?: string;
  family?: string;
}

interface TriageResults {
  total_dirty: number;
  gate_bugs: number;
  scenario_bugs: number;
  fixture_limits: number;
  unclassified: number;
  details: {
    scenario_bugs: TriagedEntry[];
    fixture_limits: TriagedEntry[];
    unclassified: TriagedEntry[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Load cross-reference data (optional — produced by other auditors)
// ─────────────────────────────────────────────────────────────────────────────

const staleScenarioIds = new Set<string>();
const staleScenariosPath = resolve(PKG_ROOT, 'data', 'stale-scenarios.json');
if (existsSync(staleScenariosPath)) {
  try {
    const stale: Array<{ scenarioId: string }> = JSON.parse(readFileSync(staleScenariosPath, 'utf-8'));
    for (const s of stale) staleScenarioIds.add(s.scenarioId);
  } catch {}
}

const fixtureGapGates = new Set<string>();
const fixtureGapsPath = resolve(PKG_ROOT, 'data', 'fixture-gaps.json');
if (existsSync(fixtureGapsPath)) {
  try {
    const gaps: Array<{ gate: string }> = JSON.parse(readFileSync(fixtureGapsPath, 'utf-8'));
    for (const g of gaps) fixtureGapGates.add(g.gate);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// File existence cache for search string checks
// ─────────────────────────────────────────────────────────────────────────────

const fileCache = new Map<string, string>();

function getAppFile(relPath: string): string | null {
  if (fileCache.has(relPath)) return fileCache.get(relPath)!;
  const full = resolve(appDir, relPath);
  if (!existsSync(full)) return null;
  const content = readFileSync(full, 'utf-8');
  fileCache.set(relPath, content);
  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification heuristics
// ─────────────────────────────────────────────────────────────────────────────

function classify(entry: LedgerEntry): TriagedEntry {
  const gate = entry.result.gatesFailed[0];
  const error = entry.result.error ?? '';
  const failedInvariants = entry.invariants?.filter(i => !i.passed) ?? [];

  // Check 1: Is this scenario flagged as stale by scenario-quality?
  if (staleScenarioIds.has(entry.id)) {
    return { id: entry.id, classification: 'scenario_bug', reason: 'stale scenario (flagged by quality monitor)', gate, family: entry.scenario.family };
  }

  // Check 2: F9 failures with "not found" or "search string" → stale scenario
  if (gate === 'F9' && (error.includes('not found') || error.includes('search string'))) {
    return { id: entry.id, classification: 'scenario_bug', reason: 'stale search string (F9 edit failure)', gate, family: entry.scenario.family };
  }

  // Check 3: Gate failed but gate has known fixture gap → fixture_limit
  if (gate && fixtureGapGates.has(gate)) {
    return { id: entry.id, classification: 'fixture_limit', reason: `gate "${gate}" has known fixture gap`, gate, family: entry.scenario.family };
  }

  // Check 4: Staging failures without Docker → fixture_limit
  if (gate === 'staging' && (error.includes('Docker') || error.includes('docker'))) {
    return { id: entry.id, classification: 'fixture_limit', reason: 'staging requires Docker (not available)', gate, family: entry.scenario.family };
  }

  // Check 5: Invariant-only failures (success=true but invariant failed)
  if (entry.result.success && failedInvariants.length > 0) {
    const inv = failedInvariants[0];
    // Product invariants (fingerprint, gate ordering) → gate_bug
    if (inv.category === 'product' || inv.category === 'gate_sequence') {
      return { id: entry.id, classification: 'gate_bug', reason: `invariant violation: ${inv.name}`, gate: 'invariant', family: entry.scenario.family };
    }
    // Harness invariants → scenario_bug (test expectation wrong)
    if (inv.category === 'harness') {
      return { id: entry.id, classification: 'scenario_bug', reason: `harness invariant: ${inv.name}`, gate: 'invariant', family: entry.scenario.family };
    }
  }

  // Check 6: Expected success but verify failed → either stale scenario or gate bug
  if (gate && entry.result.success === false) {
    return { id: entry.id, classification: 'gate_bug', reason: `gate "${gate}" failed: ${error.substring(0, 80)}`, gate, family: entry.scenario.family };
  }

  // Default: gate_bug (safest — improve loop will try to fix)
  if (failedInvariants.length > 0) {
    return { id: entry.id, classification: 'gate_bug', reason: `invariant: ${failedInvariants[0].name}`, gate: 'invariant', family: entry.scenario.family };
  }

  return { id: entry.id, classification: 'unclassified', reason: 'no heuristic matched', gate, family: entry.scenario.family };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Auto-Triage ===');
console.log(`Ledger: ${ledgerPath}`);

if (!existsSync(ledgerPath)) {
  console.log('No ledger found. Run self-test first.');
  process.exit(0);
}

// Stream line-by-line to avoid OOM on large ledgers
const triaged: TriagedEntry[] = [];
let totalDirty = 0;
let totalLines = 0;
const counts: Record<TriageClass, number> = { gate_bug: 0, scenario_bug: 0, fixture_limit: 0, unclassified: 0 };

const file = Bun.file(ledgerPath);
const reader = file.stream().getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    totalLines++;
    let entry: LedgerEntry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.clean) continue;

    totalDirty++;
    const result = classify(entry);
    // Only store non-gate_bug details (gate_bugs are the majority, don't need individual tracking)
    if (result.classification !== 'gate_bug') {
      triaged.push(result);
    }
    counts[result.classification]++;
  }
}
// Process remaining buffer
if (buffer.trim()) {
  try {
    const entry: LedgerEntry = JSON.parse(buffer);
    if (!entry.clean) {
      totalDirty++;
      const result = classify(entry);
      if (result.classification !== 'gate_bug') triaged.push(result);
      counts[result.classification]++;
    }
  } catch {}
}

// Build output
const results: TriageResults = {
  total_dirty: totalDirty,
  gate_bugs: counts.gate_bug,
  scenario_bugs: counts.scenario_bug,
  fixture_limits: counts.fixture_limit,
  unclassified: counts.unclassified,
  details: {
    scenario_bugs: triaged.filter(t => t.classification === 'scenario_bug').slice(0, 50),
    fixture_limits: triaged.filter(t => t.classification === 'fixture_limit').slice(0, 50),
    unclassified: triaged.filter(t => t.classification === 'unclassified').slice(0, 50),
  },
};

mkdirSync(resolve(PKG_ROOT, 'data'), { recursive: true });
writeFileSync(outputPath, JSON.stringify(results, null, 2) + '\n');

// Summary
console.log(`\n  Total dirty: ${totalDirty}`);
console.log(`  gate_bugs:     ${counts.gate_bug} (improve loop fuel)`);
console.log(`  scenario_bugs: ${counts.scenario_bug} (fix or remove)`);
console.log(`  fixture_limits: ${counts.fixture_limit} (needs fixture expansion)`);
console.log(`  unclassified:  ${counts.unclassified}`);

if (staleScenarioIds.size > 0) console.log(`\n  Cross-ref: ${staleScenarioIds.size} stale scenarios from quality monitor`);
if (fixtureGapGates.size > 0) console.log(`  Cross-ref: ${fixtureGapGates.size} gates with fixture gaps`);

console.log(`\n  Report: ${outputPath}`);
