#!/usr/bin/env bun
/**
 * Stage 8: DISCOVER — Find unclassified failures, propose new shapes
 * ===================================================================
 *
 * When a scenario fails but has no failureClass, the failure doesn't map
 * to any known shape in the taxonomy. This script:
 *
 * 1. Scans the self-test ledger for dirty entries without failureClass
 * 2. Clusters by gate + predicate type + error signature
 * 3. When a cluster reaches 3+ occurrences, proposes a candidate shape
 * 4. Writes candidates to data/discovered-shapes.jsonl for operator review
 *
 * With --confirm: also compares candidates against FAILURE-TAXONOMY.md,
 * confirms genuinely new shapes, and appends them to the taxonomy.
 * This closes the loop: discover → confirm → taxonomy → curriculum → scenarios.
 *
 * The curriculum agent picks up confirmed shapes on the next nightly run.
 *
 * Usage:
 *   bun scripts/harness/discover-shapes.ts --ledger=data/self-test-ledger.jsonl
 *   bun scripts/harness/discover-shapes.ts --threshold=3   # minimum cluster size
 *   bun scripts/harness/discover-shapes.ts --confirm        # confirm + append to taxonomy
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { decomposeFailure } from '../../src/store/decompose.js';
import type { VerifyResult, GateResult } from '../../src/types.js';

const PKG_ROOT = resolve(import.meta.dir, '..', '..');

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
  };
  result: {
    success: boolean | null;
    gatesFailed: string[];
    error?: string;
  };
  invariants: Array<{
    name: string;
    passed: boolean;
    violation?: string;
    severity?: string;
  }>;
  clean: boolean;
}

interface ClusterKey {
  gate: string;
  errorSignature: string;
}

interface FailureCluster {
  key: ClusterKey;
  entries: LedgerEntry[];
  count: number;
}

interface CandidateShape {
  proposedId: string;
  domain: string;
  description: string;
  claimType: string;
  evidence: {
    gate: string;
    errorSignature: string;
    occurrences: number;
    sampleScenarios: string[];
  };
  status: 'proposed' | 'confirmed' | 'duplicate';
  discoveredAt: string;
  confirmedAt?: string;
}

interface TaxonomyShape {
  id: string;
  domain: string;
  description: string;
  keywords: string[];  // Normalized words for dedup matching
}

// ─────────────────────────────────────────────────────────────────────────────
// Error signature extraction
// ─────────────────────────────────────────────────────────────────────────────

/** Map gate name → domain for shape ID assignment */
const GATE_TO_DOMAIN: Record<string, string> = {
  grounding: 'css', F9: 'syntax', K5: 'constraints', G5: 'containment',
  staging: 'infra', browser: 'browser', http: 'http', invariants: 'invariant',
  vision: 'vision', triangulation: 'crosscutting', infrastructure: 'infra',
  serialization: 'serialization', config: 'config', security: 'security',
  a11y: 'a11y', performance: 'performance', filesystem: 'filesystem',
  access: 'access', capacity: 'capacity', contention: 'contention',
  state: 'state', temporal: 'temporal', propagation: 'propagation',
  observation: 'observation', content: 'content', hallucination: 'hallucination',
};

/** Domain → shape ID prefix */
const DOMAIN_TO_PREFIX: Record<string, string> = {
  css: 'C', html: 'H', filesystem: 'FS', content: 'N', http: 'P',
  db: 'D', security: 'SEC', config: 'CFG', performance: 'PERF',
  a11y: 'A11Y', infra: 'I', browser: 'BR', temporal: 'TO',
  invariant: 'INV', crosscutting: 'X', access: 'AC', capacity: 'CAP',
  contention: 'CO', state: 'ST', propagation: 'PROP', observation: 'OE',
  serialization: 'SER', containment: 'G5', syntax: 'F9', constraints: 'K5',
  vision: 'VIS', hallucination: 'HAL',
};

/**
 * Extract a stable error signature from a failure.
 * Strips variable parts (timestamps, line numbers, file paths) to cluster similar failures.
 */
function extractErrorSignature(entry: LedgerEntry): string {
  const parts: string[] = [];

  // Failed gates
  if (entry.result.gatesFailed.length > 0) {
    parts.push(`gates:${entry.result.gatesFailed.sort().join(',')}`);
  }

  // Error message (strip numbers and paths)
  if (entry.result.error) {
    const normalized = entry.result.error
      .replace(/\d+/g, 'N')       // numbers
      .replace(/["'][^"']*["']/g, '"..."')  // quoted strings
      .replace(/\/[^\s]+/g, '/...')  // file paths
      .substring(0, 100);
    parts.push(`err:${normalized}`);
  }

  // Failed invariant names + violations
  const failedInvariants = entry.invariants.filter(i => !i.passed);
  if (failedInvariants.length > 0) {
    const invNames = failedInvariants.map(i => i.name).sort().join(',');
    parts.push(`inv:${invNames}`);

    // First violation text (normalized)
    const firstViolation = failedInvariants[0]?.violation;
    if (firstViolation) {
      const normalized = firstViolation
        .replace(/\d+/g, 'N')
        .replace(/["'][^"']*["']/g, '"..."')
        .substring(0, 80);
      parts.push(`viol:${normalized}`);
    }
  }

  return parts.join('|') || 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Clustering
// ─────────────────────────────────────────────────────────────────────────────

function clusterFailures(entries: LedgerEntry[]): FailureCluster[] {
  const clusters = new Map<string, FailureCluster>();

  for (const entry of entries) {
    const gate = entry.result.gatesFailed[0] ?? 'invariant';
    const sig = extractErrorSignature(entry);
    const key = `${gate}::${sig}`;

    const existing = clusters.get(key);
    if (existing) {
      existing.entries.push(entry);
      existing.count++;
    } else {
      clusters.set(key, {
        key: { gate, errorSignature: sig },
        entries: [entry],
        count: 1,
      });
    }
  }

  return [...clusters.values()].sort((a, b) => b.count - a.count);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape proposal
// ─────────────────────────────────────────────────────────────────────────────

function proposeShape(cluster: FailureCluster, existingIds: Set<string>): CandidateShape {
  const gate = cluster.key.gate;
  const domain = GATE_TO_DOMAIN[gate] ?? 'unknown';
  const prefix = DOMAIN_TO_PREFIX[domain] ?? 'X';

  // Find next available ID
  let num = 100; // Start discovered shapes at 100 to avoid collisions
  while (existingIds.has(`${prefix}-${num}`)) num++;
  const id = `${prefix}-${num}`;
  existingIds.add(id);

  // Derive description from the cluster
  const sampleDescs = cluster.entries.slice(0, 3).map(e => e.scenario.description);
  const firstViolation = cluster.entries[0]?.invariants.find(i => !i.passed)?.violation
    ?? cluster.entries[0]?.result.error
    ?? cluster.key.errorSignature;

  // Infer claim type from gate
  const claimType = inferClaimTypeFromGate(gate);

  return {
    proposedId: id,
    domain,
    description: `Discovered: ${gate} gate failure — ${firstViolation?.substring(0, 100)}`,
    claimType,
    evidence: {
      gate,
      errorSignature: cluster.key.errorSignature,
      occurrences: cluster.count,
      sampleScenarios: sampleDescs,
    },
    status: 'proposed',
    discoveredAt: new Date().toISOString(),
  };
}

function inferClaimTypeFromGate(gate: string): string {
  const map: Record<string, string> = {
    grounding: 'existence', F9: 'equality', K5: 'invariance', G5: 'containment',
    staging: 'existence', browser: 'equality', http: 'equality', invariants: 'invariance',
    filesystem: 'existence', infrastructure: 'existence', serialization: 'equality',
    config: 'equality', security: 'absence', a11y: 'existence', performance: 'threshold',
    hallucination: 'containment',
  };
  return map[gate] ?? 'equality';
}

// ─────────────────────────────────────────────────────────────────────────────
// Taxonomy parsing + confirmation
// ─────────────────────────────────────────────────────────────────────────────

const TAXONOMY_PATH = join(PKG_ROOT, 'FAILURE-TAXONOMY.md');

/** Domain heading → domain key used in GATE_TO_DOMAIN / DOMAIN_TO_PREFIX */
const HEADING_TO_DOMAIN: Record<string, string> = {
  'CSS Predicate Failures': 'css',
  'HTML Predicate Failures': 'html',
  'Filesystem Predicate Failures': 'filesystem',
  'Content Predicate Failures': 'content',
  'HTTP Predicate Failures': 'http',
  'DB Predicate Failures': 'db',
  'Temporal / Stateful Failures': 'temporal',
  'Cross-Predicate Interaction Failures': 'crosscutting',
  'Invariant / System Health Failures': 'invariant',
  'Browser Runtime Failures': 'browser',
  'Identity & Reference Failures': 'identity',
  'Observer Effect Failures': 'observation',
  'Concurrency / Multi-Actor Failures': 'concurrency',
  'Scope Boundary Failures': 'scope',
  'Attribution / Root Cause Failures': 'attribution',
  'Drift / Regression Failures': 'drift',
  'Message Predicate Failures': 'message',
  'Cross-Cutting Failures (Gate-Level)': 'crosscutting',
  'Configuration Predicate Failures': 'config',
  'Accessibility (a11y) Predicate Failures': 'a11y',
  'Performance Predicate Failures': 'performance',
  'Security Predicate Failures': 'security',
  'Serialization / API Contract Failures': 'serialization',
  'Injection Predicate Failures': 'injection',
  'Hallucination Predicate Failures': 'hallucination',
  'Budget / Resource Bound Failures': 'budget',
};

/** Reverse: domain key → heading text */
const DOMAIN_TO_HEADING: Record<string, string> = {};
for (const [heading, domain] of Object.entries(HEADING_TO_DOMAIN)) {
  // First match wins (some domains like 'crosscutting' map to two headings)
  if (!DOMAIN_TO_HEADING[domain]) DOMAIN_TO_HEADING[domain] = heading;
}

/** Extract normalized keywords from a description for fuzzy matching */
function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !['the', 'and', 'for', 'not', 'but', 'with', 'has', 'was', 'are', 'from'].includes(w));
}

/** Parse all existing shapes from FAILURE-TAXONOMY.md */
function parseTaxonomy(): { shapes: TaxonomyShape[], maxIdPerPrefix: Map<string, number> } {
  if (!existsSync(TAXONOMY_PATH)) return { shapes: [], maxIdPerPrefix: new Map() };

  const content = readFileSync(TAXONOMY_PATH, 'utf-8');
  const shapes: TaxonomyShape[] = [];
  const maxIdPerPrefix = new Map<string, number>();

  // Match table rows: | C-01 | description | status | notes |
  const rowRe = /^\|\s*([A-Z0-9]+-\d+)\s*\|\s*([^|]+)\|/gm;
  let match;
  let currentDomain = 'unknown';

  // Track headings for domain context
  const lines = content.split('\n');
  let lineIdx = 0;
  for (const line of lines) {
    lineIdx++;
    // Check for domain heading
    const headingMatch = line.match(/^## (.+)/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      if (HEADING_TO_DOMAIN[heading]) {
        currentDomain = HEADING_TO_DOMAIN[heading];
      }
    }

    // Check for shape row
    const rowMatch = line.match(/^\|\s*([A-Z0-9]+-(\d+))\s*\|\s*([^|]+)\|/);
    if (rowMatch) {
      const id = rowMatch[1].trim();
      const num = parseInt(rowMatch[2]);
      const desc = rowMatch[3].trim();
      const prefix = id.replace(/-\d+$/, '');

      shapes.push({
        id,
        domain: currentDomain,
        description: desc,
        keywords: extractKeywords(desc),
      });

      const current = maxIdPerPrefix.get(prefix) ?? 0;
      if (num > current) maxIdPerPrefix.set(prefix, num);
    }
  }

  return { shapes, maxIdPerPrefix };
}

/** Check if a candidate is a duplicate of an existing shape */
function isDuplicate(candidate: CandidateShape, existingShapes: TaxonomyShape[]): TaxonomyShape | null {
  const candidateKeywords = extractKeywords(candidate.description);
  const sameDomain = existingShapes.filter(s => s.domain === candidate.domain);

  for (const existing of sameDomain) {
    // Jaccard similarity on keywords
    const intersection = candidateKeywords.filter(k => existing.keywords.includes(k));
    const union = new Set([...candidateKeywords, ...existing.keywords]);
    const similarity = union.size > 0 ? intersection.length / union.size : 0;

    if (similarity > 0.4) return existing;
  }

  return null;
}

/** Find the right insertion point in the taxonomy for a new shape in a given domain */
function findInsertionPoint(content: string, domain: string): number {
  const heading = DOMAIN_TO_HEADING[domain];
  if (!heading) return -1;

  const headingIdx = content.indexOf(`## ${heading}`);
  if (headingIdx === -1) return -1;

  // Find the last table row in this section (before the next ## heading or ---)
  const sectionStart = headingIdx;
  const nextHeading = content.indexOf('\n## ', sectionStart + 1);
  const nextSeparator = content.indexOf('\n---', sectionStart + 1);
  const sectionEnd = Math.min(
    nextHeading === -1 ? content.length : nextHeading,
    nextSeparator === -1 ? content.length : nextSeparator,
  );

  const section = content.substring(sectionStart, sectionEnd);

  // Find last table row (starts with |, contains a shape ID pattern)
  const sectionLines = section.split('\n');
  let lastRowOffset = -1;
  let offset = sectionStart;
  for (const line of sectionLines) {
    if (/^\|\s*[A-Z0-9]+-\d+\s*\|/.test(line)) {
      lastRowOffset = offset + line.length;
    }
    offset += line.length + 1; // +1 for \n
  }

  return lastRowOffset;
}

/** Append confirmed shapes to FAILURE-TAXONOMY.md */
function appendToTaxonomy(confirmed: CandidateShape[], maxIdPerPrefix: Map<string, number>): number {
  if (confirmed.length === 0) return 0;

  let content = readFileSync(TAXONOMY_PATH, 'utf-8');
  let appended = 0;

  // Group by domain
  const byDomain = new Map<string, CandidateShape[]>();
  for (const shape of confirmed) {
    const group = byDomain.get(shape.domain) ?? [];
    group.push(shape);
    byDomain.set(shape.domain, group);
  }

  // Process each domain (reverse order so insertion offsets don't shift)
  const domains = [...byDomain.entries()].sort((a, b) => {
    const posA = content.indexOf(`## ${DOMAIN_TO_HEADING[a[0]]}`);
    const posB = content.indexOf(`## ${DOMAIN_TO_HEADING[b[0]]}`);
    return posB - posA; // Reverse order
  });

  for (const [domain, shapes] of domains) {
    const insertAt = findInsertionPoint(content, domain);
    if (insertAt === -1) {
      console.log(`  WARNING: Could not find section for domain "${domain}" — skipping ${shapes.length} shape(s)`);
      continue;
    }

    const prefix = DOMAIN_TO_PREFIX[domain] ?? 'X';
    let nextNum = (maxIdPerPrefix.get(prefix) ?? 99) + 1;

    const rows: string[] = [];
    for (const shape of shapes) {
      const id = `${prefix}-${nextNum}`;
      shape.proposedId = id; // Update with actual assigned ID
      const shortDesc = shape.description
        .replace(/^Discovered: [a-z]+ gate failure — /, '')
        .substring(0, 80);
      rows.push(`| ${id} | ${shortDesc} | discovered | Auto-discovered from ${shape.evidence.occurrences}x cluster (${shape.evidence.gate} gate) |`);
      nextNum++;
    }

    const insert = '\n' + rows.join('\n');
    content = content.substring(0, insertAt) + insert + content.substring(insertAt);
    appended += rows.length;
    maxIdPerPrefix.set(prefix, nextNum - 1);
  }

  writeFileSync(TAXONOMY_PATH, content);
  return appended;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI + Main
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ledgerPath = args.find(a => a.startsWith('--ledger='))?.split('=')[1]
  ?? join(PKG_ROOT, 'data', 'self-test-ledger.jsonl');
const threshold = parseInt(args.find(a => a.startsWith('--threshold='))?.split('=')[1] ?? '3');
const confirmMode = args.includes('--confirm');
const outputPath = join(PKG_ROOT, 'data', 'discovered-shapes.jsonl');

function main() {
  console.log(`=== Stage 8: DISCOVER${confirmMode ? ' + CONFIRM' : ''} ===`);
  console.log(`Ledger: ${ledgerPath}`);
  console.log(`Threshold: ${threshold} occurrences`);
  console.log('');

  if (!existsSync(ledgerPath)) {
    console.log('No ledger found. Nothing to discover.');
    return;
  }

  // Parse ledger
  const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(l => l);
  const entries: LedgerEntry[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any;

  // Find dirty entries without a failure class
  const unclassified = entries.filter(e =>
    !e.clean && !e.scenario.failureClass
  );

  const classified = entries.filter(e => !e.clean && e.scenario.failureClass);

  console.log(`  Total entries: ${entries.length}`);
  console.log(`  Dirty: ${entries.filter(e => !e.clean).length}`);
  console.log(`  Classified (has shape ID): ${classified.length}`);
  console.log(`  Unclassified (no shape ID): ${unclassified.length}`);
  console.log('');

  if (unclassified.length === 0) {
    console.log('No unclassified failures. Nothing to discover.');
    return;
  }

  // Layer 0: Run decomposeFailure() on each entry before clustering.
  // Known shapes skip clustering. Only genuinely unclassified failures get proposed.
  const knownShapeHits: Record<string, number> = {};
  const genuinelyUnclassified: LedgerEntry[] = [];

  for (const entry of unclassified) {
    // Build minimal VerifyResult from ledger entry for decomposition
    const gates: GateResult[] = entry.result.gatesFailed.map(g => ({
      gate: g as any,
      passed: false,
      detail: entry.result.error ?? '',
      durationMs: 0,
    }));
    const minimalResult: VerifyResult = {
      success: entry.result.success ?? false,
      gates,
      attestation: '',
      timing: { totalMs: 0, perGate: {} },
    };

    const decomposed = decomposeFailure(minimalResult);
    if (decomposed.shapes.length > 0) {
      const shapeId = decomposed.shapes[0].id;
      knownShapeHits[shapeId] = (knownShapeHits[shapeId] || 0) + 1;
    } else {
      genuinelyUnclassified.push(entry);
    }
  }

  console.log(`  Decomposition: ${Object.keys(knownShapeHits).length} known shapes matched, ${genuinelyUnclassified.length} genuinely unclassified`);
  if (Object.keys(knownShapeHits).length > 0) {
    const top5 = Object.entries(knownShapeHits).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [id, count] of top5) {
      console.log(`    ${count}x ${id}`);
    }
  }
  console.log('');

  if (genuinelyUnclassified.length === 0) {
    console.log('All unclassified failures match known shapes via decomposition. Nothing to discover.');
    return;
  }

  // Cluster only genuinely unclassified (not already matched by decomposition)
  const clusters = clusterFailures(genuinelyUnclassified);
  console.log(`  Clusters found: ${clusters.length}`);
  for (const c of clusters.slice(0, 10)) {
    console.log(`    ${c.count}x — ${c.key.gate}: ${c.key.errorSignature.substring(0, 80)}`);
  }

  // Propose shapes for clusters above threshold
  const aboveThreshold = clusters.filter(c => c.count >= threshold);
  console.log(`\n  Clusters above threshold (${threshold}): ${aboveThreshold.length}`);

  if (aboveThreshold.length === 0) {
    console.log('  No clusters large enough to propose as shapes.');
    return;
  }

  // Load existing shape IDs to avoid collisions
  const existingIds = new Set<string>();
  if (existsSync(outputPath)) {
    const existing = readFileSync(outputPath, 'utf-8').trim().split('\n').filter(l => l);
    for (const line of existing) {
      try {
        const shape = JSON.parse(line);
        existingIds.add(shape.proposedId);
      } catch { /* skip */ }
    }
  }

  // Propose
  const candidates: CandidateShape[] = [];
  for (const cluster of aboveThreshold) {
    const candidate = proposeShape(cluster, existingIds);
    candidates.push(candidate);
    console.log(`\n  PROPOSED: ${candidate.proposedId} [${candidate.domain}]`);
    console.log(`    ${candidate.description}`);
    console.log(`    Claim type: ${candidate.claimType}`);
    console.log(`    Evidence: ${candidate.evidence.occurrences} occurrences`);
    console.log(`    Samples:`);
    for (const s of candidate.evidence.sampleScenarios.slice(0, 3)) {
      console.log(`      - ${s.substring(0, 80)}`);
    }
  }

  // Append to discovered shapes log
  const newLines = candidates.map(c => JSON.stringify(c)).join('\n');
  const existing = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8') : '';
  writeFileSync(outputPath, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + newLines + '\n');

  console.log(`\n  Written ${candidates.length} candidate shape(s) to ${outputPath}`);

  // ─── Confirmation mode: dedup against taxonomy, append new shapes ───
  if (!confirmMode) {
    console.log('  Operator: review and confirm with `--confirm` to add to taxonomy.');
    return;
  }

  console.log('\n  === CONFIRM: Checking candidates against taxonomy ===');
  const { shapes: taxonomyShapes, maxIdPerPrefix } = parseTaxonomy();
  console.log(`  Taxonomy has ${taxonomyShapes.length} existing shapes`);

  const confirmed: CandidateShape[] = [];
  const duplicates: Array<{ candidate: CandidateShape; matchedShape: TaxonomyShape }> = [];

  for (const candidate of candidates) {
    const match = isDuplicate(candidate, taxonomyShapes);
    if (match) {
      candidate.status = 'duplicate';
      duplicates.push({ candidate, matchedShape: match });
      console.log(`  SKIP (duplicate): ${candidate.proposedId} ≈ ${match.id} "${match.description.substring(0, 60)}"`);
    } else {
      candidate.status = 'confirmed';
      candidate.confirmedAt = new Date().toISOString();
      confirmed.push(candidate);
      console.log(`  CONFIRMED: ${candidate.proposedId} [${candidate.domain}] — new shape`);
    }
  }

  console.log(`\n  Result: ${confirmed.length} confirmed, ${duplicates.length} duplicates`);

  if (confirmed.length === 0) {
    console.log('  No new shapes to add to taxonomy.');
    // Output for CI
    console.log(`new_shapes=0`);
    return;
  }

  // Append to taxonomy
  const appended = appendToTaxonomy(confirmed, maxIdPerPrefix);
  console.log(`  Appended ${appended} shape(s) to FAILURE-TAXONOMY.md`);

  // Rewrite discovered-shapes.jsonl with updated statuses
  const allCandidates = [...candidates];
  const updatedLines = allCandidates.map(c => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(outputPath, updatedLines);

  // Output for CI
  console.log(`new_shapes=${appended}`);
}

main();
