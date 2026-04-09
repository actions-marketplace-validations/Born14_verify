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

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
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
  rng: () => number,
  skip: Set<string>
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

    // Shuffle the FULL family pool (always — does not depend on skip).
    // The rng consumption is identical between an initial run and a --skip
    // re-run, which is what makes the replacement deterministic.
    const shuffled = shuffle(pool, rng);

    // Filter out skipped IDs while preserving the shuffle order. Then take
    // the first `allocation` from the filtered list. If skip removes K IDs
    // from the prefix [0..allocation-1], the take walks past them into
    // positions [allocation..allocation+K-1] of the original shuffle.
    // This is the deterministic-replacement guarantee: same seed + same
    // corpus + same skip list always produces the same `take`.
    const filtered = shuffled.filter((c) => !skip.has(c.case_id));

    if (filtered.length < allocation) {
      throw new Error(
        `Primary family "${family}" has only ${filtered.length} qualifying scenarios after applying ` +
          `--skip, below its Amendment 2 allocation of ${allocation}. This is the universe-exhaustion ` +
          `edge case from Amendment 2 Change 2. Halt and surface to operator per the edge-case clause.`
      );
    }

    const take = filtered.slice(0, allocation);

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

  // Build the remaining pool: everything not taken by primary allocation.
  // CRITICAL FOR AMENDMENT 3 DETERMINISM: do NOT filter by skip here. The
  // skip filter must be applied inside selectStratifiedRemainder after each
  // per-category shuffle, not before, so the rng consumption is identical
  // between an initial run (empty skip) and a replacement run (non-empty
  // skip). If the skip filter is applied here, the per-category pool sizes
  // would differ between the two runs, which would change category
  // eligibility, which would diverge the rng sequence, which would silently
  // produce different stratified-remainder cases that aren't actually
  // replacements for any dropped case. The remaining pool returned here
  // contains all non-primary-allocated candidates regardless of skip.
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
  rng: () => number,
  skip: Set<string>
): { selected: Candidate[]; stats: StratifiedStats } {
  // CRITICAL FOR AMENDMENT 3 DETERMINISM:
  //
  // The pool passed in is the FULL non-primary-allocated pool, NOT a
  // skip-filtered version. This is essential because:
  //
  //   1. The rng consumption inside this function must be identical
  //      between an initial run (empty skip) and a replacement run
  //      (non-empty skip). The skip filter cannot affect which categories
  //      are eligible (the floor check), how many slots each category gets
  //      (the proportional + round-robin allocation math), or the order
  //      in which the rng is consumed by the per-category shuffles.
  //
  //   2. The shuffle of each category's full pre-skip pool happens BEFORE
  //      the skip filter. Same shuffle in both runs, same rng consumption
  //      sequence in both runs.
  //
  //   3. The skip filter applies AFTER the shuffle and AFTER the allocation
  //      math, only when picking which specific candidates fill each
  //      category's allocated slots. The slots themselves are pre-skip
  //      counts; the candidates that fill them are post-skip from the
  //      shuffled pool.
  //
  // The result: the only difference between the two runs is which
  // candidates fill the same slots in the same categories. No category
  // gains or loses eligibility, no allocation count changes, no rng
  // sequence diverges. The N replacement-mode swaps correspond exactly
  // to the N skipped cases — no silent rng-divergence artifacts.

  // Group by file-level category (using the FULL pre-skip pool)
  const groups = new Map<string, Candidate[]>();
  for (const c of pool) {
    const arr = groups.get(c.category) ?? [];
    arr.push(c);
    groups.set(c.category, arr);
  }

  // Eligibility floor check uses pre-skip pool size — a category's
  // eligibility is a property of the corpus, not of the skip set.
  // For each eligible category, sort by case_id (deterministic), then
  // shuffle on the FULL pool (consumes rng identically between runs).
  // The skip filter is applied later, when picking from the shuffled
  // pool to fill the allocated slots.
  const eligibleCategories = [...groups.entries()]
    .filter(([, arr]) => arr.length >= minCategorySize)
    .map(([cat, arr]) => {
      const sorted = [...arr].sort((a, b) => a.case_id.localeCompare(b.case_id));
      const shuffledFullPool = shuffle(sorted, rng);
      return {
        category: cat,
        shuffledFullPool, // pre-skip, deterministic
        size: arr.length, // pre-skip size for allocation math
      };
    });

  // Sort by size descending for proportional then round-robin allocation.
  // The size used here is the pre-skip pool size, ensuring identical
  // allocation math between an initial run and a replacement run.
  eligibleCategories.sort((a, b) => b.size - a.size);

  const totalEligible = eligibleCategories.reduce((sum, c) => sum + c.size, 0);
  const allocations = new Map<string, number>();
  for (const { category, size } of eligibleCategories) {
    const proportional = Math.floor((size / totalEligible) * target);
    const capped = Math.min(proportional, capPerCategory);
    allocations.set(category, capped);
  }

  // Round-robin fill to reach target. Uses pre-skip sizes — same in both runs.
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

  // Now apply the skip filter: for each category, walk the shuffled pool
  // in order, skip any case_ids in the skip set, and take the first N
  // (where N is the allocation). This is the only place skip affects the
  // output. The slot count is pre-skip; the candidates filling each slot
  // are post-skip. If a category's allocation exceeds its post-skip pool
  // size, the skip set has exhausted the category — throw and route to
  // operator per the §13 substitution fallback.
  const selected: Candidate[] = [];
  for (const { category, shuffledFullPool } of eligibleCategories) {
    const alloc = allocations.get(category) ?? 0;
    if (alloc === 0) continue;
    const filtered = shuffledFullPool.filter((c) => !skip.has(c.case_id));
    if (filtered.length < alloc) {
      throw new Error(
        `Stratified-remainder category "${category}" has only ${filtered.length} ` +
          `qualifying scenarios after applying --skip, below its allocation of ${alloc}. ` +
          `This is the §13 stratified-category exhaustion case. Halt and surface to ` +
          `operator for an explicit ruling.`
      );
    }
    selected.push(...filtered.slice(0, alloc));
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

function selectCases(
  candidates: Candidate[],
  rng: () => number,
  skip: Set<string>
): { selected: Candidate[]; stats: SelectionStats } {
  // Step 1-3: primary-family allocation
  const primary = allocatePrimaryFamilies(candidates, rng, skip);

  // Step 4-5: stratified remainder on non-primary pool
  const stratified = selectStratifiedRemainder(
    primary.remaining,
    STRATIFIED_REMAINDER_TARGET,
    MIN_CATEGORY_SIZE,
    MAX_PER_CATEGORY_CAP,
    rng,
    skip
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

/**
 * Parse CLI arguments. Supports:
 *   bun select-cases.ts <corpus-sha>
 *   bun select-cases.ts <corpus-sha> --skip <case-id-1>,<case-id-2>,...
 *
 * The --skip argument is the implementation of §13's pre-flight contingency
 * rule for replacement draws. Per Path A (operator-approved 2026-04-09):
 * the same seed + same corpus + same skip list always produces the same
 * replacement candidates. The replacement file (candidates-source-b-
 * replacements.jsonl) records the original-to-replacement mapping for
 * audit.
 */
interface CliArgs {
  corpusSha: string;
  skip: Set<string>;
}

function parseArgs(argv: string[]): CliArgs {
  const corpusSha = argv[2] ?? 'UNSPECIFIED';
  let skip = new Set<string>();
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--skip') {
      const list = argv[i + 1] ?? '';
      skip = new Set(list.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
      i++;
    }
  }
  return { corpusSha, skip };
}

/**
 * Swap record: documents one stale-drop and its replacement candidate.
 * Records both the dropped case (with its stale-drop reason from
 * preflight-results.jsonl) and the replacement case so a future reader
 * can reconstruct the post-replacement live set as
 * `(original 40-case draw ∖ dropped) ∪ replacements`.
 *
 * The full replacement Candidate object is included so pre-flight on
 * the replacement set has all the data it needs without re-querying
 * the corpus.
 *
 * Per Amendment 3: swap records distinguish primary-family drops
 * (which use Reading 1 — relaxed sub-file matching with category_match
 * potentially false) from stratified remainder drops (which use §13
 * literal text — strict file-level category matching, category_match
 * always true). The category_match flag and the substitution_reason
 * field surface the relaxation honestly when it applies.
 *
 * The substitution_reason field is mandatory when category_match is
 * false (i.e., for primary-family swaps where the replacement comes
 * from a different sub-file). It contains the Amendment-3-verbatim
 * language with placeholders populated from the dropped and
 * replacement candidates. For category_match=true swaps, the field
 * is null.
 */
interface SwapRecord {
  original_case_id: string;
  original_category: string;
  original_primary_family: string | null;
  stale_drop_reason: string | null;
  stale_drop_gates_failed: string[];
  replacement_case_id: string;
  replacement_category: string;
  replacement_primary_family: string | null;
  category_match: boolean;
  primary_family_match: boolean;
  substitution_reason: string | null;
  replacement_candidate: Candidate; // full replacement record for downstream pre-flight
}

/**
 * Build the Amendment 3 substitution_reason text. The template is
 * committed verbatim in Amendment 3 (DESIGN.md, Change "What changed",
 * primary-family bullet) and must be matched word-for-word.
 *
 * Template: "Amendment 3 primary-family replacement rule: same primary
 * family ({family_name}), different sub-file category ({original_sub_file}
 * → {replacement_sub_file}). §13's strict category match is not preserved
 * for primary-family drops; §13 + Amendment 3 explicitly permits sub-file
 * flexibility within primary families."
 */
function buildAmendment3SubstitutionReason(
  familyName: string,
  originalSubFile: string,
  replacementSubFile: string
): string {
  return `Amendment 3 primary-family replacement rule: same primary family (${familyName}), different sub-file category (${originalSubFile} → ${replacementSubFile}). §13's strict category match is not preserved for primary-family drops; §13 + Amendment 3 explicitly permits sub-file flexibility within primary families.`;
}

/**
 * Load preflight-results.jsonl to look up stale-drop reasons by case_id.
 * Returns a map { case_id → { reason, gates_failed } }.
 */
function loadPreflightDropReasons(
  preflightPath: string
): Map<string, { reason: string | null; gates_failed: string[] }> {
  const reasons = new Map<string, { reason: string | null; gates_failed: string[] }>();
  if (!existsSync(preflightPath)) return reasons;

  const lines = readFileSync(preflightPath, 'utf-8').trim().split('\n');
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.__metadata) continue;
      if (rec.status === 'stale-drop' && typeof rec.case_id === 'string') {
        reasons.set(rec.case_id, {
          reason: typeof rec.mismatch_reason === 'string' ? rec.mismatch_reason : null,
          gates_failed: Array.isArray(rec.gates_failed) ? (rec.gates_failed as string[]) : [],
        });
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return reasons;
}

function emitReplacements(
  outPath: string,
  swaps: SwapRecord[],
  corpusSha: string,
  skip: Set<string>
): void {
  const metadata = {
    __metadata: true,
    phase: 'N1 Phase 1f (Source B replacement draw under §13 + Amendments 2 and 3)',
    random_seed: RANDOM_SEED,
    corpus_sha: corpusSha,
    generated_at: new Date().toISOString(),
    design_md_version: 'v1 + Amendment 1 + Amendment 2 + Amendment 3',
    selection_algorithm:
      'Amendment 2 Change 2 with --skip applied (same seed, same corpus, post-shuffle filter preserves order); ' +
      'Amendment 3 Reading 1 applied to primary-family drops (relaxed sub-file matching with category_match flag); ' +
      '§13 literal text applied to stratified remainder drops (strict file-level category matching)',
    contingency_rule:
      '§13 k≤5 path with Amendment 3 two-rule structure: primary-family drops use Reading 1 (sub-file flexible), stratified remainder drops use §13 strict matching',
    note:
      'This file is a DELTA on candidates-source-b.jsonl. The post-replacement live set is reconstructable as: (original 40-case draw from candidates-source-b.jsonl) MINUS (skip_ids) UNION (replacement_case_ids). The original candidates-source-b.jsonl is NOT modified by replacement mode — it remains the immutable record of the initial selection.',
    skip_count: skip.size,
    skip_ids: [...skip].sort(),
    swap_count: swaps.length,
  };

  const lines: string[] = [JSON.stringify(metadata)];
  for (const swap of swaps) {
    lines.push(JSON.stringify(swap));
  }
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Compute swap records by comparing the initial selection (no skip) to the
 * replacement-aware selection (with skip). Each skipped case_id maps to the
 * candidate that took its slot in the with-skip run.
 *
 * The mapping is per-position: for each primary family, the original draw
 * had positions [c1..cN]. After skipping, some of those positions are
 * filled by later candidates from the same shuffled pool. The replacement
 * for a skipped case_id is the candidate at the same logical slot in the
 * with-skip selection.
 *
 * Stratified-remainder swaps are trickier because the algorithm uses
 * proportional + round-robin allocation per category. We compute the swap
 * by category: for each category that lost a case to the skip list, the
 * replacement is whichever new case_id from the same category appears in
 * the with-skip selection that wasn't in the initial selection.
 */
/**
 * Compute swap records by comparing the initial selection (no skip) to the
 * replacement-aware selection (with skip).
 *
 * Per Amendment 3, two separate rules apply based on the dropped case's
 * primary_family:
 *
 *   - dropped.primary_family is non-null (case was drawn from f9, content,
 *     propagation, access, or state via Amendment 2 Change 2's primary-family
 *     allocation): apply Reading 1. Match the replacement against the same
 *     primary family, with sub-file flexibility. The audit trail records
 *     category_match accurately (true if the replacement happens to come
 *     from the same sub-file, false if from a different sub-file in the
 *     same family). When category_match is false, the substitution_reason
 *     field is populated with the Amendment-3-verbatim language.
 *
 *   - dropped.primary_family is null (case was drawn from the stratified
 *     remainder by the per-category sampler): §13 literal text applies.
 *     Match the replacement against the same file-level category. If no
 *     same-category replacement exists, throw — this is a §13 substitution
 *     case requiring explicit operator ruling.
 *
 * Replacement matching is order-preserving within each pool (first dropped
 * primary-family case → first new primary-family case from the same family,
 * etc.) so the swap mapping is deterministic given the same inputs.
 */
function computeSwaps(
  initialSelected: Candidate[],
  replacementSelected: Candidate[],
  skip: Set<string>,
  dropReasons: Map<string, { reason: string | null; gates_failed: string[] }>
): SwapRecord[] {
  const initialIds = new Set(initialSelected.map((c) => c.case_id));

  // Cases that were dropped (in initial, in skip set), preserved in
  // initial-selection order so the matching loop is deterministic.
  const droppedCandidates = initialSelected.filter((c) => skip.has(c.case_id));

  // Cases that are NEW in the replacement run (in replacement, not in
  // initial), preserved in replacement-selection order.
  const newCandidates = replacementSelected.filter((c) => !initialIds.has(c.case_id));

  // Bucket new candidates two ways:
  //   - by primary_family (for primary-family drop matching under Reading 1)
  //   - by category (for stratified remainder drop matching under §13 literal)
  // The same new candidate may be eligible to match a primary-family drop
  // (via its family) OR a stratified drop (via its category), but never both
  // at once — once a candidate is claimed by a swap, it's removed from both
  // buckets.
  const newByFamily = new Map<string, Candidate[]>();
  const newByCategory = new Map<string, Candidate[]>();
  for (const nc of newCandidates) {
    if (nc.primary_family !== null) {
      const arr = newByFamily.get(nc.primary_family) ?? [];
      arr.push(nc);
      newByFamily.set(nc.primary_family, arr);
    }
    const carr = newByCategory.get(nc.category) ?? [];
    carr.push(nc);
    newByCategory.set(nc.category, carr);
  }

  // Helper to remove a claimed candidate from both buckets.
  const claimCandidate = (claimed: Candidate): void => {
    if (claimed.primary_family !== null) {
      const famPool = newByFamily.get(claimed.primary_family);
      if (famPool) {
        const idx = famPool.findIndex((c) => c.case_id === claimed.case_id);
        if (idx >= 0) famPool.splice(idx, 1);
      }
    }
    const catPool = newByCategory.get(claimed.category);
    if (catPool) {
      const idx = catPool.findIndex((c) => c.case_id === claimed.case_id);
      if (idx >= 0) catPool.splice(idx, 1);
    }
  };

  const swaps: SwapRecord[] = [];

  // Process primary-family drops first (Reading 1). Order is initial-
  // selection order to preserve determinism.
  for (const dropped of droppedCandidates) {
    if (dropped.primary_family === null) continue; // handled in next pass

    const reason = dropReasons.get(dropped.case_id) ?? { reason: null, gates_failed: [] };
    const familyPool = newByFamily.get(dropped.primary_family) ?? [];

    if (familyPool.length === 0) {
      // Reading 1 cannot be satisfied: no new candidate from the same
      // primary family is available. This would only occur if the primary-
      // family pool was exhausted by the skip set (the Amendment 2 Change 2
      // edge case). For k=3 with content holding, this should not trigger,
      // but we throw here to surface it explicitly per the edge-case clause.
      throw new Error(
        `No same-primary-family replacement found for dropped case "${dropped.case_id}" ` +
          `(primary_family="${dropped.primary_family}"). This is the Amendment 2 Change 2 ` +
          `primary-family universe exhaustion edge case. Halt and surface to operator ` +
          `for an explicit ruling per Amendment 2's edge-case clause.`
      );
    }

    const replacement = familyPool[0]; // first in family pool order
    claimCandidate(replacement);

    const categoryMatch = dropped.category === replacement.category;
    const primaryFamilyMatch = dropped.primary_family === replacement.primary_family;
    const substitutionReason = categoryMatch
      ? null
      : buildAmendment3SubstitutionReason(
          dropped.primary_family, // family_name
          dropped.category, // original_sub_file
          replacement.category // replacement_sub_file
        );

    swaps.push({
      original_case_id: dropped.case_id,
      original_category: dropped.category,
      original_primary_family: dropped.primary_family,
      stale_drop_reason: reason.reason,
      stale_drop_gates_failed: reason.gates_failed,
      replacement_case_id: replacement.case_id,
      replacement_category: replacement.category,
      replacement_primary_family: replacement.primary_family,
      category_match: categoryMatch,
      primary_family_match: primaryFamilyMatch,
      substitution_reason: substitutionReason,
      replacement_candidate: replacement,
    });
  }

  // Process stratified remainder drops (§13 literal text — strict
  // file-level category matching). Order is initial-selection order.
  for (const dropped of droppedCandidates) {
    if (dropped.primary_family !== null) continue; // already handled

    const reason = dropReasons.get(dropped.case_id) ?? { reason: null, gates_failed: [] };
    const categoryPool = newByCategory.get(dropped.category) ?? [];

    if (categoryPool.length === 0) {
      // §13 strict matching cannot be satisfied. This is the §13
      // category-substitution fallback case from the original pre-
      // registration (still binding for stratified remainder drops).
      // Per §13 clarification 1, the operator must rule on substitution
      // explicitly. Halt and surface.
      throw new Error(
        `No same-category replacement found for stratified-remainder dropped case ` +
          `"${dropped.case_id}" (category="${dropped.category}"). Per §13 clarification 1, ` +
          `this triggers the category-substitution fallback and requires an operator ruling. ` +
          `Halt and report. (Note: Amendment 3's Reading 1 relaxation does not apply here ` +
          `because the dropped case has no primary family.)`
      );
    }

    const replacement = categoryPool[0]; // first in category pool order
    claimCandidate(replacement);

    swaps.push({
      original_case_id: dropped.case_id,
      original_category: dropped.category,
      original_primary_family: dropped.primary_family, // null
      stale_drop_reason: reason.reason,
      stale_drop_gates_failed: reason.gates_failed,
      replacement_case_id: replacement.case_id,
      replacement_category: replacement.category,
      replacement_primary_family: replacement.primary_family,
      category_match: true, // strict match is the only path here
      primary_family_match: false, // both are null, so technically false
      substitution_reason: null, // no relaxation applied
      replacement_candidate: replacement,
    });
  }

  // Sort swaps by original_case_id for deterministic output ordering
  // (independent of which pass processed which swap).
  swaps.sort((a, b) => a.original_case_id.localeCompare(b.original_case_id));

  // Verify: every new candidate should have been claimed by some dropped case
  const unclaimedNew = [...newByCategory.values()].flat();
  if (unclaimedNew.length > 0) {
    console.warn(
      `WARN: ${unclaimedNew.length} new candidates were not matched to a dropped case: ${unclaimedNew
        .map((c) => c.case_id)
        .join(', ')}`
    );
  }

  return swaps;
}

function main(): void {
  const scenariosDir = join(import.meta.dir, '..', '..', 'fixtures', 'scenarios');
  const outPath = join(import.meta.dir, 'candidates-source-b.jsonl');
  const replacementsPath = join(import.meta.dir, 'candidates-source-b-replacements.jsonl');

  const { corpusSha, skip } = parseArgs(process.argv);
  if (corpusSha === 'UNSPECIFIED') {
    console.warn('WARN: corpus SHA not specified. Pass as first argument: bun select-cases.ts <sha>');
  }

  const replacementMode = skip.size > 0;

  console.log(`Loading scenarios from ${scenariosDir}...`);
  const candidates = loadQualifyingScenarios(scenariosDir);
  console.log(`Loaded ${candidates.length} qualifying scenarios (false_negative, non-zero edits).`);

  const primaryCount = candidates.filter((c) => c.primary_family !== null).length;
  console.log(
    `  Primary-family pool: ${primaryCount} scenarios (f9, content, propagation, access, state)`
  );
  console.log(`  Non-primary pool:    ${candidates.length - primaryCount} scenarios`);
  console.log('');

  if (replacementMode) {
    console.log(`Replacement mode: --skip ${[...skip].sort().join(', ')}`);
    console.log(`  Skip count: ${skip.size}`);
    console.log('');

    // Run BOTH the initial selection (no skip, fresh rng) and the
    // replacement-aware selection (with skip, fresh rng). The two runs use
    // independent rng instances seeded with the same value, so the shuffle
    // sequences are identical. Comparing the two selections gives us the
    // swap records.
    //
    // CRITICAL: in replacement mode, candidates-source-b.jsonl is NOT
    // overwritten. The original 40-case draw committed in a84c26e is the
    // immutable record of the initial selection. The replacement file
    // (candidates-source-b-replacements.jsonl) is a delta on top of it.
    // The post-replacement live set is reconstructable as:
    //   (original 40-case draw) MINUS (skip ids) UNION (replacement ids)
    const initialRng = mulberry32(RANDOM_SEED);
    const { selected: initialSelected } = selectCases(candidates, initialRng, new Set());

    const replacementRng = mulberry32(RANDOM_SEED);
    const { selected: replacementSelected } = selectCases(
      candidates,
      replacementRng,
      skip
    );

    // Pre-flight drop reasons are read from the existing preflight-results.jsonl
    // (produced by Phase 1c). The swap records pull the reason for each
    // dropped case_id directly from that file so the audit trail is complete.
    const preflightResultsPath = join(import.meta.dir, 'preflight-results.jsonl');
    const dropReasons = loadPreflightDropReasons(preflightResultsPath);

    const swaps = computeSwaps(initialSelected, replacementSelected, skip, dropReasons);

    console.log('=== Swap history ===');
    for (const swap of swaps) {
      console.log(
        `  ${swap.original_case_id}  →  ${swap.replacement_case_id}  ` +
          `(category_match=${swap.category_match}, family_match=${swap.primary_family_match})`
      );
      if (swap.stale_drop_reason) {
        console.log(`    drop reason: ${swap.stale_drop_reason.substring(0, 160)}`);
      }
    }
    console.log('');

    // Sanity check: skip count must equal swap count (every dropped case
    // got matched to exactly one replacement). If they don't match, the
    // computeSwaps logic missed something or the skip list contains IDs
    // that weren't in the original draw.
    if (swaps.length !== skip.size) {
      throw new Error(
        `Swap count mismatch: ${swaps.length} swaps for ${skip.size} dropped cases. ` +
          `One or more skip IDs may not match cases in the original draw, or computeSwaps ` +
          `failed to claim a new candidate. Halt and investigate.`
      );
    }

    console.log(`NOT overwriting ${outPath} — original draw is immutable in replacement mode.`);
    console.log(`Writing swap history (${swaps.length} swaps) to ${replacementsPath}...`);
    emitReplacements(replacementsPath, swaps, corpusSha, skip);
    console.log('');
    console.log('Post-replacement live set reconstruction:');
    console.log(`  (40-case original from candidates-source-b.jsonl)`);
    console.log(`  MINUS (${skip.size} skip ids)`);
    console.log(`  UNION (${swaps.length} replacement ids)`);
    console.log(`  = ${initialSelected.length - skip.size + swaps.length} live cases`);
    console.log('Done.');
  } else {
    const rng = mulberry32(RANDOM_SEED);
    const { selected, stats } = selectCases(candidates, rng, new Set());

    console.log('=== Selection stats ===');
    console.log(JSON.stringify(stats, null, 2));
    console.log('');

    console.log(`Writing ${selected.length} candidates to ${outPath}...`);
    emitCandidates(outPath, selected, stats, corpusSha);
    console.log('Done.');
  }
}

if (import.meta.main) {
  main();
}
