#!/usr/bin/env node
/**
 * Fixture Fuzzer — Mutate Existing Scenarios into Adversarial Variants
 * =====================================================================
 *
 * Takes existing passing/failing scenarios and systematically corrupts them
 * to generate new test cases. Each mutation class produces scenarios that
 * should expose different failure modes in verify's gates.
 *
 * Mutation classes:
 *   - predicate_flip:   Change expected values to wrong values
 *   - edit_corrupt:     Break edits (wrong search string, partial replace)
 *   - predicate_drift:  Shift predicates to adjacent-but-wrong selectors
 *   - type_swap:        Change predicate type (css→html, content→css)
 *   - boundary:         Edge cases (empty strings, huge values, special chars)
 *   - compound:         Combine 2+ mutations in one scenario
 *
 * Usage:
 *   bun run scripts/supply/fuzz.ts [options]
 *
 * Options:
 *   --max-variants=50     Maximum new scenarios to generate (default: 50)
 *   --output-dir=PATH     Output directory (default: fixtures/scenarios)
 *   --seed-families=A,B   Families to use as mutation seeds (default: all)
 *   --dry-run             Print what would be generated, don't write
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Scenario {
  id: string;
  description: string;
  edits: Array<{ file: string; search: string; replace: string }>;
  predicates: Array<Record<string, any>>;
  expectedSuccess: boolean;
  tags: string[];
  rationale?: string;
  [key: string]: any;
}

interface MutationResult {
  scenario: Scenario;
  mutationClass: string;
  sourceId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario Loader
// ─────────────────────────────────────────────────────────────────────────────

function loadAllScenarios(scenariosDir: string): Scenario[] {
  if (!existsSync(scenariosDir)) return [];
  const files = readdirSync(scenariosDir).filter(f => f.endsWith('.json'));
  const all: Scenario[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(scenariosDir, file), 'utf-8'));
      if (Array.isArray(raw)) all.push(...raw);
    } catch { /* skip corrupt files */ }
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation Classes
// ─────────────────────────────────────────────────────────────────────────────

const CSS_COLORS = ['red', 'blue', 'green', 'orange', '#ff0000', '#00ff00', '#0000ff', 'rgb(255,0,0)', 'rgb(0,128,0)', 'transparent', 'inherit'];
const CSS_SIZES = ['10px', '20px', '48px', '0', '100%', '2rem', '3em', '0.5vw'];
const CSS_PROPERTIES = ['color', 'background-color', 'font-size', 'font-weight', 'margin', 'padding', 'border', 'display', 'opacity'];
const HTML_ELEMENTS = ['h1', 'h2', 'h3', 'div', 'span', 'p', 'a', 'button', 'input', 'table', 'tr', 'td'];
const SPECIAL_CHARS = ['<script>alert(1)</script>', '"; DROP TABLE users;--', '../../../etc/passwd', '\x00\x01\x02', '🎯🔥💀', '   ', '\n\n\n', 'undefined', 'null', 'NaN', '[object Object]'];

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateId(sourceId: string, mutClass: string, index: number): string {
  return `fuzz-${mutClass}-${sourceId}-${index}`.substring(0, 80);
}

/**
 * Mutation 1: Flip predicate expected values to wrong values
 * A passing scenario with wrong expectations should fail.
 */
function mutatePredFlip(source: Scenario, index: number): MutationResult | null {
  if (!source.predicates?.length) return null;
  const pred = source.predicates.find(p => p.type === 'css' && p.expected);
  if (!pred) return null;

  const wrongValue = pred.expected?.startsWith('#')
    ? randomPick(CSS_COLORS.filter(c => c !== pred.expected))
    : randomPick(CSS_COLORS);

  const newPred = { ...pred, expected: wrongValue };
  return {
    scenario: {
      ...source,
      id: generateId(source.id, 'pred-flip', index),
      description: `[FUZZ:pred_flip] ${source.description} — expected flipped to ${wrongValue}`,
      predicates: source.predicates.map(p => p === pred ? newPred : { ...p }),
      expectedSuccess: false,
      tags: [...source.tags.filter(t => t !== 'false_negative'), 'fuzz', 'pred_flip', 'false_positive'],
      rationale: `Fuzzed from ${source.id}: predicate expected value changed from ${pred.expected} to ${wrongValue}`,
    },
    mutationClass: 'pred_flip',
    sourceId: source.id,
  };
}

/**
 * Mutation 2: Corrupt edits so they can't be applied
 * Scenarios with broken search strings should fail at F9.
 */
function mutateEditCorrupt(source: Scenario, index: number): MutationResult | null {
  if (!source.edits?.length) return null;
  const edit = source.edits[0];
  if (!edit.search || edit.search.length < 5) return null;

  // Corrupt the search string by inserting garbage in the middle
  const mid = Math.floor(edit.search.length / 2);
  const corruptSearch = edit.search.substring(0, mid) + '_CORRUPTED_' + edit.search.substring(mid);

  return {
    scenario: {
      ...source,
      id: generateId(source.id, 'edit-corrupt', index),
      description: `[FUZZ:edit_corrupt] ${source.description} — search string corrupted`,
      edits: [{ ...edit, search: corruptSearch }, ...source.edits.slice(1).map(e => ({ ...e }))],
      expectedSuccess: false,
      tags: [...source.tags.filter(t => t !== 'false_negative'), 'fuzz', 'edit_corrupt', 'false_positive'],
      rationale: `Fuzzed from ${source.id}: search string corrupted to prevent edit application`,
    },
    mutationClass: 'edit_corrupt',
    sourceId: source.id,
  };
}

/**
 * Mutation 3: Drift predicates to adjacent-but-wrong selectors
 * Tests whether verify correctly distinguishes similar selectors.
 */
function mutatePredDrift(source: Scenario, index: number): MutationResult | null {
  if (!source.predicates?.length) return null;
  const pred = source.predicates.find(p => p.type === 'css' && p.selector);
  if (!pred) return null;

  // Drift to a different element
  const current = pred.selector;
  const drifted = current.includes('h1') ? current.replace('h1', 'h2')
    : current.includes('.') ? current + '-nonexistent'
    : `.${current}-drifted`;

  return {
    scenario: {
      ...source,
      id: generateId(source.id, 'pred-drift', index),
      description: `[FUZZ:pred_drift] ${source.description} — selector drifted to ${drifted}`,
      predicates: source.predicates.map(p => p === pred ? { ...pred, selector: drifted } : { ...p }),
      expectedSuccess: false,
      tags: [...source.tags.filter(t => t !== 'false_negative'), 'fuzz', 'pred_drift', 'false_positive'],
      rationale: `Fuzzed from ${source.id}: CSS selector drifted from ${current} to ${drifted}`,
    },
    mutationClass: 'pred_drift',
    sourceId: source.id,
  };
}

/**
 * Mutation 4: Swap predicate types (css→html, html→content, etc.)
 * Tests whether verify handles type mismatches correctly.
 */
function mutateTypeSwap(source: Scenario, index: number): MutationResult | null {
  if (!source.predicates?.length) return null;
  const pred = source.predicates[0];
  if (!pred) return null;

  let swapped: Record<string, any>;
  switch (pred.type) {
    case 'css':
      // CSS → HTML: use selector as element, check exists
      swapped = { type: 'html', element: pred.selector || 'div', content: 'exists' };
      break;
    case 'html':
      // HTML → content: check file for element text
      swapped = { type: 'content', file: 'server.js', pattern: pred.content || pred.element || 'html' };
      break;
    case 'content':
      // Content → css: use pattern as a fake selector
      swapped = { type: 'css', selector: '.fuzz-nonexistent', property: 'color', expected: 'red' };
      break;
    default:
      return null;
  }

  return {
    scenario: {
      ...source,
      id: generateId(source.id, 'type-swap', index),
      description: `[FUZZ:type_swap] ${source.description} — predicate type ${pred.type}→${swapped.type}`,
      predicates: [swapped, ...source.predicates.slice(1).map(p => ({ ...p }))],
      expectedSuccess: false,
      tags: [...source.tags.filter(t => t !== 'false_negative'), 'fuzz', 'type_swap', 'false_positive'],
      rationale: `Fuzzed from ${source.id}: predicate type swapped from ${pred.type} to ${swapped.type}`,
    },
    mutationClass: 'type_swap',
    sourceId: source.id,
  };
}

/**
 * Mutation 5: Boundary/edge case values
 * Special characters, empty strings, huge values, injection attempts.
 */
function mutateBoundary(source: Scenario, index: number): MutationResult | null {
  if (!source.predicates?.length) return null;
  const pred = source.predicates.find(p => p.expected || p.pattern || p.content);
  if (!pred) return null;

  const boundary = randomPick(SPECIAL_CHARS);
  const field = pred.expected ? 'expected' : pred.pattern ? 'pattern' : 'content';

  return {
    scenario: {
      ...source,
      id: generateId(source.id, 'boundary', index),
      description: `[FUZZ:boundary] ${source.description} — ${field} set to boundary value`,
      predicates: source.predicates.map(p => p === pred ? { ...pred, [field]: boundary } : { ...p }),
      expectedSuccess: false,
      tags: [...source.tags.filter(t => t !== 'false_negative'), 'fuzz', 'boundary', 'false_positive'],
      rationale: `Fuzzed from ${source.id}: ${field} replaced with boundary value "${boundary.substring(0, 30)}"`,
    },
    mutationClass: 'boundary',
    sourceId: source.id,
  };
}

/**
 * Mutation 6: Compound — apply 2 mutations to one scenario
 */
function mutateCompound(source: Scenario, index: number): MutationResult | null {
  // Try pred_flip + edit_corrupt together
  const flipped = mutatePredFlip(source, index);
  if (!flipped) return null;

  const corrupted = mutateEditCorrupt(flipped.scenario, index);
  if (!corrupted) return flipped; // Fall back to single mutation

  return {
    scenario: {
      ...corrupted.scenario,
      id: generateId(source.id, 'compound', index),
      description: `[FUZZ:compound] ${source.description} — pred flipped + edit corrupted`,
      tags: [...source.tags.filter(t => !['false_negative', 'false_positive'].includes(t)), 'fuzz', 'compound', 'false_positive'],
      rationale: `Compound fuzz from ${source.id}: predicate flipped AND edit corrupted`,
    },
    mutationClass: 'compound',
    sourceId: source.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

const MUTATORS = [
  mutatePredFlip,
  mutateEditCorrupt,
  mutatePredDrift,
  mutateTypeSwap,
  mutateBoundary,
  mutateCompound,
];

function fuzzScenarios(scenarios: Scenario[], maxVariants: number): MutationResult[] {
  const results: MutationResult[] = [];
  const seenIds = new Set<string>();
  let globalIndex = 0;

  // Shuffle scenarios for variety
  const shuffled = [...scenarios].sort(() => Math.random() - 0.5);

  // Round-robin through mutators for even distribution
  for (const scenario of shuffled) {
    if (results.length >= maxVariants) break;

    for (const mutator of MUTATORS) {
      if (results.length >= maxVariants) break;

      const result = mutator(scenario, globalIndex++);
      if (result && !seenIds.has(result.scenario.id)) {
        seenIds.add(result.scenario.id);
        results.push(result);
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const maxVariants = parseInt(args.find(a => a.startsWith('--max-variants='))?.split('=')[1] ?? '50');
const dryRun = args.includes('--dry-run');
const pkgRoot = resolve(import.meta.dir, '..', '..');
const scenariosDir = join(pkgRoot, 'fixtures', 'scenarios');
const outputDir = args.find(a => a.startsWith('--output-dir='))?.split('=')[1] ?? scenariosDir;

console.log(`\n═══ Fixture Fuzzer ═══`);
console.log(`Max variants: ${maxVariants}`);
console.log(`Source: ${scenariosDir}`);
console.log(`Output: ${outputDir}`);
console.log(`Dry run: ${dryRun}\n`);

// Load existing scenarios as mutation seeds
const seeds = loadAllScenarios(scenariosDir);
console.log(`Loaded ${seeds.length} seed scenarios from ${readdirSync(scenariosDir).filter(f => f.endsWith('.json')).length} files`);

// Filter to good mutation candidates (have predicates and/or edits)
const candidates = seeds.filter(s => (s.predicates?.length ?? 0) > 0 || (s.edits?.length ?? 0) > 0);
console.log(`${candidates.length} candidates suitable for mutation`);

// Fuzz
const results = fuzzScenarios(candidates, maxVariants);

// Distribution report
const byClass: Record<string, number> = {};
for (const r of results) {
  byClass[r.mutationClass] = (byClass[r.mutationClass] ?? 0) + 1;
}
console.log(`\nGenerated ${results.length} variants:`);
for (const [cls, count] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls}: ${count}`);
}

if (dryRun) {
  console.log('\n[DRY RUN] No files written.');
  for (const r of results.slice(0, 5)) {
    console.log(`  ${r.scenario.id} (${r.mutationClass} from ${r.sourceId})`);
  }
  if (results.length > 5) console.log(`  ... and ${results.length - 5} more`);
} else {
  // Write to fuzz-staged.json
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'fuzz-staged.json');

  // Load existing fuzz scenarios if any, deduplicate
  let existing: Scenario[] = [];
  if (existsSync(outputPath)) {
    try {
      existing = JSON.parse(readFileSync(outputPath, 'utf-8'));
    } catch { /* overwrite */ }
  }

  const existingIds = new Set(existing.map(s => s.id));
  const newScenarios = results
    .map(r => r.scenario)
    .filter(s => !existingIds.has(s.id));

  const merged = [...existing, ...newScenarios];
  writeFileSync(outputPath, JSON.stringify(merged, null, 2));
  console.log(`\nWrote ${newScenarios.length} new scenarios (${merged.length} total) to ${outputPath}`);

  // Write supply log for nightly pipeline
  const logPath = join(pkgRoot, 'data', 'supply-log.jsonl');
  mkdirSync(join(pkgRoot, 'data'), { recursive: true });
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'fuzzer',
    generated: results.length,
    new: newScenarios.length,
    byClass,
  });
  const { appendFileSync } = require('fs');
  appendFileSync(logPath, logEntry + '\n');
}

console.log('\nDone.\n');
