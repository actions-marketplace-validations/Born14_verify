/**
 * N1 Phase 1b — Deterministic case selection for Source B (v2).
 *
 * Draws 40 false_negative non-zero-edit scenarios from
 * fixtures/scenarios/*-staged.json (excluding wpt-staged.json, matching
 * loadStagedScenarios() conformity filter from external-scenario-loader.ts).
 *
 * Algorithm: shape-family-aware allocation followed by stratified remainder.
 * Per DESIGN.md Amendment 2 Change 2, the selection process is:
 *
 *   1. Load all qualifying scenarios (false_negative, non-zero edits).
 *   2. Partition into primary-family pools by filename prefix matching:
 *      - f9       → f9-staged.json
 *      - content  → content-staged.json, content-advanced-staged.json
 *                   (NOT contention-*-staged.json)
 *      - propagation → propagation-*-staged.json
 *      - access   → access-*-staged.json
 *      - state    → state-*-staged.json
 *   3. For each primary family, sort by case_id (deterministic), shuffle
 *      with seed 20260409, take the first N:
 *        f9: 5, content: 4, propagation: 5, access: 5, state: 5
 *      Total primary allocation: 24 cases.
 *   4. Remove allocated primary-family cases from the remaining pool.
 *   5. Run proportional stratified sampling on the remaining pool for the
 *      16 leftover slots (≤12 per category cap, ≥3 per category floor).
 *   6. Merge primary + stratified into 40-case draw, sort by case_id.
 *
 * The within-family shuffles are performed in alphabetical family order
 * (access → content → f9 → propagation → state) so the rng consumption
 * order is deterministic. The stratified remainder runs last.
 *
 * Pre-registration (DESIGN.md):
 *   - Random seed: 20260409 (§15)
 *   - Source B selection algorithm: Amendment 2 Change 2
 *   - Primary families: f9, content, propagation, access, state (§7 + Amendment 2)
 *   - hallucination excluded (Amendment 2 Change 1 — struck from primary list)
 *   - ≥6 gate categories total (§7)
 *
 * Implementation details (documented in the Phase 1 lock commit, not DESIGN.md):
 *   - PRNG: mulberry32, pinned inline
 *   - Primary allocation order: alphabetical by family name
 *   - Stratified remainder: proportional with ≤12 cap and ≥3 floor
 *   - case_id format: "{category}:{scenario.id}" (scenario IDs are not
 *     globally unique; file-level prefix disambiguates)
 *
 * Usage:
 *   bun experiments/n1-convergence-proof/select-cases.ts <corpus-sha>
 *
 * Output:
 *   experiments/n1-convergence-proof/candidates-source-b.jsonl
 *
 * First line is a metadata header; subsequent lines are candidate records.
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';

// ============================================================================
// Constants from DESIGN.md (pre-registration, do not modify)
// ============================================================================

const RANDOM_SEED = 20260409; // DESIGN.md §15
const TARGET_SOURCE_B_COUNT = 40; // DESIGN.md §7
const MIN_CATEGORIES = 6; // DESIGN.md §7
const MAX_PER_CATEGORY_CAP = 12; // Implementation: ≤30% of 40
const MIN_CATEGORY_SIZE = 3; // Implementation: categories need ≥3 qualifying scenarios

// Amendment 2 Change 2: primary-family allocation.
// Order matters for PRNG determinism — primary families are shuffled in
// alphabetical order, so the rng consumption sequence is stable.
const PRIMARY_FAMILY_ALLOCATIONS: ReadonlyArray<{ family: string; allocation: number }> = [
  { family: 'access', allocation: 5 },
  { family: 'content', allocation: 4 }, // all 4 qualifying scenarios
  { family: 'f9', allocation: 5 },
  { family: 'propagation', allocation: 5 },
  { family: 'state', allocation: 5 },
];
const PRIMARY_TOTAL = PRIMARY_FAMILY_ALLOCATIONS.reduce((s, f) => s + f.allocation, 0); // 24
const STRATIFIED_REMAINDER_TARGET = TARGET_SOURCE_B_COUNT - PRIMARY_TOTAL; // 16

// ============================================================================
// mulberry32 PRNG (pinned inline, seeded with DESIGN.md §15 value)
// ============================================================================

/**
 * mulberry32 — fast 32-bit PRNG.
 * Source: https://gist.github.com/tommyettinger/46a3c6e5f27a75a84c8ed51ec3b3c3cf
 * Pinned inline to avoid library drift; five lines of code, audit-stable.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher-Yates shuffle using the PRNG.
 */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ============================================================================
// Scenario loading (mirrors external-scenario-loader.ts conformity filter)
// ============================================================================

interface SerializedScenario {
  id: string;
  description?: string;
  edits: Array<{ file: string; search: string; replace: string }>;
  predicates: Array<Record<string, unknown>>;
  expectedSuccess?: boolean;
  intent?: string;
  tags?: string[];
  rationale?: string;
  [key: string]: unknown;
}

interface Candidate {
  case_id: string;
  source: 'B';
  intent: 'false_negative';
  category: string;
  primary_family: string | null; // Amendment 2: which primary family, or null for stratified remainder
  track: 'N1-A';
  goal: string;
  reference_edits: Array<{ file: string; search: string; replace: string }>;
  reference_predicates: Array<Record<string, unknown>>;
  expected_success: boolean;
  scenario_file: string;
  scenario_id: string;
}

/**
 * Map a file-level category to a primary shape family, or null if the
 * category is not a primary family.
 *
 * Amendment 2 Change 2 primary-family mapping:
 *   f9       — f9-staged.json
 *   content  — content-staged.json, content-advanced-staged.json
 *              (CRITICAL: NOT contention-*-staged.json — they start with
 *               the same prefix but are a different shape family)
 *   propagation — propagation-*-staged.json
 *   access   — access-*-staged.json
 *   state    — state-*-staged.json
 */
function primaryFamilyForCategory(category: string): string | null {
  if (category === 'f9') return 'f9';
  if (category === 'content' || category === 'content-advanced') return 'content';
  if (category.startsWith('propagation-')) return 'propagation';
  if (category.startsWith('access-')) return 'access';
  if (category.startsWith('state-')) return 'state';
  return null;
}

function loadQualifyingScenarios(scenariosDir: string): Candidate[] {
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith('-staged.json') && f !== 'wpt-staged.json')
    .sort(); // deterministic file order

  const candidates: Candidate[] = [];

  for (const file of files) {
    const category = basename(file, '-staged.json');
    const filePath = join(scenariosDir, file);
    let raw: SerializedScenario[];
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8')) as SerializedScenario[];
    } catch {
      continue; // skip malformed files (matches loader behavior)
    }
    if (!Array.isArray(raw)) continue;

    // Conformity filter — must match loadStagedScenarios() in external-scenario-loader.ts
    // Additional N1 filter: false_negative intent, non-zero edits
    const conforming = raw.filter(
      (s) =>
        Array.isArray(s.edits) &&
        s.edits.length > 0 &&
        Array.isArray(s.predicates) &&
        s.intent === 'false_negative'
    );

    const family = primaryFamilyForCategory(category);

    for (const s of conforming) {
      candidates.push({
        case_id: `${category}:${s.id}`,
        source: 'B',
        intent: 'false_negative',
        category,
        primary_family: family,
        track: 'N1-A',
        goal: s.description ?? `${category} scenario ${s.id}`,
        reference_edits: s.edits,
        reference_predicates: s.predicates,
        expected_success: s.expectedSuccess ?? true,
        scenario_file: file,
        scenario_id: s.id,
      });
    }
  }

  // Sort by case_id for deterministic ordering before sampling
  candidates.sort((a, b) => a.case_id.localeCompare(b.case_id));
  return candidates;
}

// ============================================================================
// Primary-family allocation (Amendment 2 Change 2)
// ============================================================================

interface PrimaryAllocationResult {
  selected: Candidate[];
  perFamily: Record<string, { universe: number; allocated: number; selected_ids: string[] }>;
  remaining: Candidate[];
}

/**
 * Per Amendment 2 Change 2: for each primary family in alphabetical order,
 * sort the family's scenarios by case_id, shuffle with the shared rng,
 * take the first N (allocation). Return the selected primary cases and
 * the remaining (non-primary-allocated) pool.
 *
 * The primary families are processed in alphabetical order so the rng
 * consumption sequence is deterministic. Within each family the full
 * sorted pool is shuffled (not just the prefix that matches the allocation)
 * to use the same shuffle semantics as v1's per-category shuffle.
 *
 * If any primary family has fewer qualifying scenarios than its allocation,
 * the script throws — this is the "universe exhaustion" edge case that
 * Amendment 2 names explicitly for content (which has exactly 4 and is
 * allocated 4). Any future primary family with fewer than its allocation
 * requires an Amendment 3 per the Amendment 2 edge-case clause.
 */
function allocatePrimaryFamilies(
  candidates: Candidate[],
  rng: () => number
): PrimaryAllocationResult {
  const selected: Candidate[] = [];
  const perFamily: Record<string, { universe: number; allocated: number; selected_ids: string[] }> = {};
  const takenIds = new Set<string>();

  // Pool of candidates that belong to SOME primary family (keyed by family)
  const familyPools = new Map<string, Candidate[]>();
  for (const family of PRIMARY_FAMILY_ALLOCATIONS) {
    familyPools.set(family.family, []);
  }
  for (const c of candidates) {
    if (c.primary_family !== null) {
      const pool = familyPools.get(c.primary_family);
      if (pool) pool.push(c);
    }
  }

  // Process families in alphabetical order (deterministic rng consumption)
  const familiesInOrder = [...PRIMARY_FAMILY_ALLOCATIONS].sort((a, b) =>
    a.family.localeCompare(b.family)
  );

  for (const { family, allocation } of familiesInOrder) {
    const pool = familyPools.get(family) ?? [];
    // Sort the family pool by case_id before shuffling — removes any
    // dependency on file iteration order
    pool.sort((a, b) => a.case_id.localeCompare(b.case_id));

    if (pool.length < allocation) {
      throw new Error(
        `Primary family "${family}" has only ${pool.length} qualifying scenarios, ` +
          `below its Amendment 2 allocation of ${allocation}. Per Amendment 2's ` +
          `primary-family universe exhaustion edge case, this requires an Amendment 3 ` +
          `before the selection can proceed.`
      );
    }

    const shuffled = shuffle(pool, rng);
    const take = shuffled.slice(0, allocation);

    perFamily[family] = {
      universe: pool.length,
      allocated: allocation,
      selected_ids: take.map((c) => c.case_id),
    };

    for (const c of take) {
      selected.push(c);
      takenIds.add(c.case_id);
    }
  }

  // Build the remaining pool: everything not taken by primary allocation
  const remaining = candidates.filter((c) => !takenIds.has(c.case_id));

  return { selected, perFamily, remaining };
}

// ============================================================================
// Stratified remainder (Amendment 2 Change 2, Step 5)
// ============================================================================

interface StratifiedStats {
  pool_size: number;
  total_categories_in_pool: number;
  eligible_categories_after_floor: number;
  floor_dropped_categories: number;
  target_count: number;
  actual_count: number;
  cap_per_category: number;
  min_category_size: number;
  distribution: Record<string, number>;
}

/**
 * Proportional stratified sampling on the remaining (non-primary-allocated)
 * pool. Same algorithm as v1's selectStratified — it's the step that was
 * correct for v1 but was missing the primary-family guarantee. Under v2
 * this runs on the 1255 non-primary-allocated scenarios for 16 slots.
 */
function selectStratifiedRemainder(
  pool: Candidate[],
  target: number,
  minCategorySize: number,
  capPerCategory: number,
  rng: () => number
): { selected: Candidate[]; stats: StratifiedStats } {
  // Group by file-level category
  const groups = new Map<string, Candidate[]>();
  for (const c of pool) {
    const arr = groups.get(c.category) ?? [];
    arr.push(c);
    groups.set(c.category, arr);
  }

  const eligibleCategories = [...groups.entries()]
    .filter(([, arr]) => arr.length >= minCategorySize)
    .map(([cat, arr]) => ({ category: cat, scenarios: shuffle(arr, rng), size: arr.length }));

  // Sort by size descending for proportional then round-robin allocation
  eligibleCategories.sort((a, b) => b.size - a.size);

  const totalEligible = eligibleCategories.reduce((sum, c) => sum + c.size, 0);
  const allocations = new Map<string, number>();
  for (const { category, size } of eligibleCategories) {
    const proportional = Math.floor((size / totalEligible) * target);
    const capped = Math.min(proportional, capPerCategory);
    allocations.set(category, capped);
  }

  // Round-robin fill to reach target
  let currentTotal = [...allocations.values()].reduce((a, b) => a + b, 0);
  while (currentTotal < target) {
    let progressed = false;
    for (const { category, size } of eligibleCategories) {
      if (currentTotal >= target) break;
      const current = allocations.get(category) ?? 0;
      if (current >= capPerCategory) continue;
      if (current >= size) continue;
      allocations.set(category, current + 1);
      currentTotal++;
      progressed = true;
    }
    if (!progressed) {
      throw new Error(
        `Could not reach stratified remainder target ${target}: all eligible categories at cap or exhausted. ` +
          `Current total: ${currentTotal}.`
      );
    }
  }

  const selected: Candidate[] = [];
  for (const { category, scenarios } of eligibleCategories) {
    const alloc = allocations.get(category) ?? 0;
    if (alloc > 0) {
      selected.push(...scenarios.slice(0, alloc));
    }
  }

  const stats: StratifiedStats = {
    pool_size: pool.length,
    total_categories_in_pool: groups.size,
    eligible_categories_after_floor: eligibleCategories.length,
    floor_dropped_categories: groups.size - eligibleCategories.length,
    target_count: target,
    actual_count: selected.length,
    cap_per_category: capPerCategory,
    min_category_size: minCategorySize,
    distribution: Object.fromEntries(
      eligibleCategories
        .map(({ category }) => [category, allocations.get(category) ?? 0] as const)
        .filter(([, n]) => n > 0)
    ),
  };

  return { selected, stats };
}

// ============================================================================
// Top-level orchestrator (Amendment 2 Change 2, Steps 1-7)
// ============================================================================

interface SelectionStats {
  algorithm: string;
  total_universe: number;
  primary_allocation_total: number;
  stratified_remainder_target: number;
  final_count: number;
  primary_allocation: PrimaryAllocationResult['perFamily'];
  stratified: StratifiedStats;
  categories_represented: number;
  primary_families_represented: string[];
}

function selectCases(candidates: Candidate[], rng: () => number): { selected: Candidate[]; stats: SelectionStats } {
  // Step 1-3: primary-family allocation
  const primary = allocatePrimaryFamilies(candidates, rng);

  // Step 4-5: stratified remainder on non-primary pool
  const stratified = selectStratifiedRemainder(
    primary.remaining,
    STRATIFIED_REMAINDER_TARGET,
    MIN_CATEGORY_SIZE,
    MAX_PER_CATEGORY_CAP,
    rng
  );

  // Step 6: merge
  const merged = [...primary.selected, ...stratified.selected];

  // Step 7: final sort by case_id
  merged.sort((a, b) => a.case_id.localeCompare(b.case_id));

  const stats: SelectionStats = {
    algorithm: 'Amendment 2 Change 2: shape-family-aware allocation + stratified remainder',
    total_universe: candidates.length,
    primary_allocation_total: primary.selected.length,
    stratified_remainder_target: STRATIFIED_REMAINDER_TARGET,
    final_count: merged.length,
    primary_allocation: primary.perFamily,
    stratified: stratified.stats,
    categories_represented: new Set(merged.map((c) => c.category)).size,
    primary_families_represented: [
      ...new Set(merged.filter((c) => c.primary_family !== null).map((c) => c.primary_family as string)),
    ].sort(),
  };

  if (stats.categories_represented < MIN_CATEGORIES) {
    throw new Error(
      `Final draw has only ${stats.categories_represented} categories, below the ≥${MIN_CATEGORIES} floor in DESIGN.md §7.`
    );
  }

  return { selected: merged, stats };
}

// ============================================================================
// Output: candidates-source-b.jsonl with metadata header
// ============================================================================

function emitCandidates(
  outPath: string,
  selected: Candidate[],
  stats: SelectionStats,
  corpusSha: string
): void {
  const metadata = {
    __metadata: true,
    phase: 'N1 Phase 1b (Source B candidate selection, v2)',
    random_seed: RANDOM_SEED,
    corpus_sha: corpusSha,
    generated_at: new Date().toISOString(),
    design_md_version: 'v1 + Amendment 1 + Amendment 2',
    selection_algorithm:
      'Amendment 2 Change 2: shape-family-aware allocation (5 per family except content=4, total 24) + stratified remainder (16 slots, ≤12 cap, ≥3 floor)',
    target_count: TARGET_SOURCE_B_COUNT,
    min_categories: MIN_CATEGORIES,
    primary_families: PRIMARY_FAMILY_ALLOCATIONS.map((f) => `${f.family}=${f.allocation}`),
    stats,
  };

  const lines: string[] = [];
  lines.push(JSON.stringify(metadata));
  for (const c of selected) {
    lines.push(JSON.stringify(c));
  }

  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const scenariosDir = join(import.meta.dir, '..', '..', 'fixtures', 'scenarios');
  const outPath = join(import.meta.dir, 'candidates-source-b.jsonl');

  // Corpus SHA is passed in via argv[2] — the caller supplies the git SHA
  // explicitly to preserve reproducibility at invocation time.
  const corpusSha = process.argv[2] ?? 'UNSPECIFIED';
  if (corpusSha === 'UNSPECIFIED') {
    console.warn('WARN: corpus SHA not specified. Pass as first argument: bun select-cases.ts <sha>');
  }

  console.log(`Loading scenarios from ${scenariosDir}...`);
  const candidates = loadQualifyingScenarios(scenariosDir);
  console.log(`Loaded ${candidates.length} qualifying scenarios (false_negative, non-zero edits).`);

  const primaryCount = candidates.filter((c) => c.primary_family !== null).length;
  console.log(
    `  Primary-family pool: ${primaryCount} scenarios (f9, content, propagation, access, state)`
  );
  console.log(`  Non-primary pool:    ${candidates.length - primaryCount} scenarios`);
  console.log('');

  const rng = mulberry32(RANDOM_SEED);
  const { selected, stats } = selectCases(candidates, rng);

  console.log('=== Selection stats ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log('');

  console.log(`Writing ${selected.length} candidates to ${outPath}...`);
  emitCandidates(outPath, selected, stats, corpusSha);
  console.log('Done.');
}

if (import.meta.main) {
  main();
}
