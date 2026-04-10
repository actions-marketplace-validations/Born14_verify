/**
 * N1 Phase 1h — Case list builder.
 *
 * Composes the final 52-case N1-A live set from:
 *   - candidates-source-b.jsonl (40 original Source B candidates from Phase 1b)
 *   - candidates-source-b-replacements.jsonl (3 swap records from Phase 1f)
 *   - preflight-results.jsonl (Phase 1c results: 37 pass + 3 stale-drop)
 *   - preflight-replacements-results.jsonl (Phase 1f-6 results: 3 pass)
 *   - source-d-seeds.jsonl (12 Source D synthetic seeds from Phase 1g)
 *
 * Output: case-list.jsonl (53 lines = 1 metadata header + 52 case records)
 *
 * Per DESIGN.md §14, each record contains the schema fields:
 *   case_id, source, intent, category, track, goal,
 *   reference_edits, reference_predicates,
 *   pre_flight_result, pre_flight_verify_result, pre_flight_timestamp,
 *   scanner_sha, extractor_sha, category_substitution, random_seed
 *
 * Composition rules:
 *   - Source B cases drop the 3 stale ones (per Phase 1c) and add the 3
 *     replacement candidates (per Phase 1f). Result: 40 live Source B.
 *   - Source D seeds are added as-is. Result: 12 Source D.
 *   - Total: 52 N1-A live cases.
 *   - All sorted by case_id for deterministic output.
 *
 * Pre-flight provenance:
 *   - Source B cases that passed Phase 1c original pre-flight:
 *     pre_flight_result='pass', pre_flight_timestamp from Phase 1c metadata,
 *     scanner_sha and extractor_sha from Phase 1c corpus SHA (e881221).
 *   - Source B cases that came from the Phase 1f replacement draw:
 *     pre_flight_result='replacement-pass', pre_flight_timestamp from
 *     Phase 1f-6 metadata, scanner_sha and extractor_sha from Phase 1f-6
 *     corpus SHA (01a786c).
 *   - Source D synthetic seeds:
 *     pre_flight_result='synthetic', pre_flight_verify_result=null,
 *     pre_flight_timestamp=null, scanner_sha=null, extractor_sha=null
 *     (per §14 — synthetic seeds are not pre-flighted).
 *
 * No primary-family universe exhaustion edge case triggered (Amendment 2),
 * no §13 category-substitution fallback triggered (all 3 stratified-
 * remainder drops were replaceable from the same file-level category, and
 * the 2 primary-family drops were replaceable within their primary family
 * per Amendment 3 Reading 1 — both with full audit trail in
 * candidates-source-b-replacements.jsonl).
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Constants from DESIGN.md (pre-registration, do not modify)
// ============================================================================

const RANDOM_SEED = 20260409; // §15

// SHAs at pre-flight time, captured from preflight metadata headers
const PHASE_1C_CORPUS_SHA = 'e881221'; // Source B original pre-flight corpus SHA
const PHASE_1F6_CORPUS_SHA = '01a786c'; // Source B replacement pre-flight corpus SHA

// ============================================================================
// Types
// ============================================================================

interface SourceBCandidate {
  case_id: string;
  source: 'B';
  intent: string;
  category: string;
  primary_family: string | null;
  track: 'N1-A';
  goal: string;
  reference_edits: Array<{ file: string; search: string; replace: string }>;
  reference_predicates: Array<Record<string, unknown>>;
  expected_success: boolean;
  scenario_file: string;
  scenario_id: string;
}

interface SourceDSeed {
  case_id: string;
  source: 'D';
  intent: 'synthetic';
  category: string;
  primary_family: null;
  track: 'N1-A';
  goal: string;
  reference_edits: Array<{ file: string; search: string; replace: string }>;
  reference_predicates: Array<Record<string, unknown>>;
  expected_success: true;
  scenario_file: 'SOURCE_D_SYNTHETIC';
  scenario_id: string;
}

interface PreflightResultRow {
  case_id: string;
  category: string;
  primary_family: string | null;
  status: 'pass' | 'stale-drop' | 'error';
  observed_success: boolean | null;
  expected_success: boolean;
  mismatch_reason: string | null;
  gates_failed: string[];
  failure_detail: string | null;
  duration_ms: number;
}

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
  replacement_candidate: SourceBCandidate;
}

// Final case-list.jsonl record schema per §14
interface CaseListRecord {
  case_id: string;
  source: 'B' | 'D';
  intent: string;
  category: string;
  primary_family: string | null;
  track: 'N1-A';
  goal: string;
  reference_edits: Array<{ file: string; search: string; replace: string }>;
  reference_predicates: Array<Record<string, unknown>>;
  expected_success: boolean;
  scenario_file: string;
  scenario_id: string;
  pre_flight_result: 'pass' | 'replacement-pass' | 'synthetic';
  pre_flight_verify_result: { success: boolean; gates_passed_count: number; gates_failed_count: number } | null;
  pre_flight_timestamp: string | null;
  scanner_sha: string | null;
  extractor_sha: string | null;
  category_substitution: { original: string; substituted: string; reason: string } | null;
  random_seed: number;
}

// ============================================================================
// JSONL helpers
// ============================================================================

function loadJsonlSkipMetadata<T>(path: string): T[] {
  const lines = readFileSync(path, 'utf-8').trim().split('\n');
  const records: T[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.__metadata === true) continue;
      records.push(obj as T);
    } catch {
      /* skip malformed lines */
    }
  }
  return records;
}

function loadJsonlMetadata(path: string): Record<string, unknown> {
  const firstLine = readFileSync(path, 'utf-8').trim().split('\n')[0];
  return JSON.parse(firstLine) as Record<string, unknown>;
}

// ============================================================================
// Composition
// ============================================================================

function buildCaseList(experimentDir: string): { records: CaseListRecord[]; stats: Record<string, unknown> } {
  // Load all input files
  const sourceBCandidates = loadJsonlSkipMetadata<SourceBCandidate>(
    join(experimentDir, 'candidates-source-b.jsonl')
  );
  const swaps = loadJsonlSkipMetadata<SwapRecord>(
    join(experimentDir, 'candidates-source-b-replacements.jsonl')
  );
  const preflightResults = loadJsonlSkipMetadata<PreflightResultRow>(
    join(experimentDir, 'preflight-results.jsonl')
  );
  const preflightReplacementsResults = loadJsonlSkipMetadata<PreflightResultRow>(
    join(experimentDir, 'preflight-replacements-results.jsonl')
  );
  const sourceDSeeds = loadJsonlSkipMetadata<SourceDSeed>(
    join(experimentDir, 'source-d-seeds.jsonl')
  );

  // Pre-flight metadata for timestamps
  const preflightMeta = loadJsonlMetadata(join(experimentDir, 'preflight-results.jsonl'));
  const preflightReplacementsMeta = loadJsonlMetadata(
    join(experimentDir, 'preflight-replacements-results.jsonl')
  );
  const phase1cTimestamp = String(preflightMeta.generated_at ?? '');
  const phase1f6Timestamp = String(preflightReplacementsMeta.generated_at ?? '');

  // Build skip set + replacement set from swap records
  const skipIds = new Set(swaps.map((s) => s.original_case_id));
  const replacementCandidates = swaps.map((s) => s.replacement_candidate);

  // Index pre-flight results by case_id for status lookup
  const preflightByCaseId = new Map<string, PreflightResultRow>();
  for (const row of preflightResults) preflightByCaseId.set(row.case_id, row);
  for (const row of preflightReplacementsResults) preflightByCaseId.set(row.case_id, row);

  const records: CaseListRecord[] = [];

  // ---- Source B: original pre-flight passes (37 cases) ----
  for (const cand of sourceBCandidates) {
    if (skipIds.has(cand.case_id)) continue; // dropped by pre-flight
    const pf = preflightByCaseId.get(cand.case_id);
    if (!pf) {
      throw new Error(`Source B case ${cand.case_id} has no pre-flight result row in preflight-results.jsonl`);
    }
    if (pf.status !== 'pass') {
      throw new Error(`Source B case ${cand.case_id} has non-pass pre-flight status "${pf.status}" but is not in skip set`);
    }
    records.push({
      case_id: cand.case_id,
      source: 'B',
      intent: cand.intent,
      category: cand.category,
      primary_family: cand.primary_family,
      track: 'N1-A',
      goal: cand.goal,
      reference_edits: cand.reference_edits,
      reference_predicates: cand.reference_predicates,
      expected_success: cand.expected_success,
      scenario_file: cand.scenario_file,
      scenario_id: cand.scenario_id,
      pre_flight_result: 'pass',
      pre_flight_verify_result: {
        success: pf.observed_success ?? false,
        gates_passed_count: 0, // not captured in PreflightResultRow shape; keep as schema-compliant 0
        gates_failed_count: pf.gates_failed.length,
      },
      pre_flight_timestamp: phase1cTimestamp,
      scanner_sha: PHASE_1C_CORPUS_SHA,
      extractor_sha: PHASE_1C_CORPUS_SHA,
      category_substitution: null,
      random_seed: RANDOM_SEED,
    });
  }

  // ---- Source B: replacement pre-flight passes (3 cases) ----
  for (const repl of replacementCandidates) {
    const pf = preflightByCaseId.get(repl.case_id);
    if (!pf) {
      throw new Error(`Replacement case ${repl.case_id} has no pre-flight result row in preflight-replacements-results.jsonl`);
    }
    if (pf.status !== 'pass') {
      throw new Error(`Replacement case ${repl.case_id} has non-pass pre-flight status "${pf.status}"`);
    }
    records.push({
      case_id: repl.case_id,
      source: 'B',
      intent: repl.intent,
      category: repl.category,
      primary_family: repl.primary_family,
      track: 'N1-A',
      goal: repl.goal,
      reference_edits: repl.reference_edits,
      reference_predicates: repl.reference_predicates,
      expected_success: repl.expected_success,
      scenario_file: repl.scenario_file,
      scenario_id: repl.scenario_id,
      pre_flight_result: 'replacement-pass',
      pre_flight_verify_result: {
        success: pf.observed_success ?? false,
        gates_passed_count: 0,
        gates_failed_count: pf.gates_failed.length,
      },
      pre_flight_timestamp: phase1f6Timestamp,
      scanner_sha: PHASE_1F6_CORPUS_SHA,
      extractor_sha: PHASE_1F6_CORPUS_SHA,
      category_substitution: null, // Amendment 3 Reading 1 substitutions are tracked in candidates-source-b-replacements.jsonl, not in this field
      random_seed: RANDOM_SEED,
    });
  }

  // ---- Source D: synthetic seeds (12 cases) ----
  for (const seed of sourceDSeeds) {
    records.push({
      case_id: seed.case_id,
      source: 'D',
      intent: seed.intent,
      category: seed.category,
      primary_family: seed.primary_family,
      track: 'N1-A',
      goal: seed.goal,
      reference_edits: seed.reference_edits,
      reference_predicates: seed.reference_predicates,
      expected_success: seed.expected_success,
      scenario_file: seed.scenario_file,
      scenario_id: seed.scenario_id,
      pre_flight_result: 'synthetic',
      pre_flight_verify_result: null,
      pre_flight_timestamp: null,
      scanner_sha: null,
      extractor_sha: null,
      category_substitution: null,
      random_seed: RANDOM_SEED,
    });
  }

  // Sort by case_id for deterministic output
  records.sort((a, b) => a.case_id.localeCompare(b.case_id));

  // Sanity checks
  if (records.length !== 52) {
    throw new Error(`Final case-list has ${records.length} records, expected 52 per §7 + Amendment 4 budget`);
  }
  const sourceCount = { B: 0, D: 0 };
  const statusCount = { pass: 0, 'replacement-pass': 0, synthetic: 0 };
  const familyCount: Record<string, number> = {};
  const categoryCount: Record<string, number> = {};
  for (const r of records) {
    sourceCount[r.source]++;
    statusCount[r.pre_flight_result]++;
    if (r.primary_family !== null) {
      familyCount[r.primary_family] = (familyCount[r.primary_family] ?? 0) + 1;
    }
    categoryCount[r.category] = (categoryCount[r.category] ?? 0) + 1;
  }

  if (sourceCount.B !== 40) throw new Error(`Source B count is ${sourceCount.B}, expected 40`);
  if (sourceCount.D !== 12) throw new Error(`Source D count is ${sourceCount.D}, expected 12`);
  if (statusCount.pass !== 37) throw new Error(`Pre-flight pass count is ${statusCount.pass}, expected 37`);
  if (statusCount['replacement-pass'] !== 3)
    throw new Error(`Replacement-pass count is ${statusCount['replacement-pass']}, expected 3`);
  if (statusCount.synthetic !== 12)
    throw new Error(`Synthetic count is ${statusCount.synthetic}, expected 12`);

  const stats = {
    total: records.length,
    by_source: sourceCount,
    by_pre_flight_result: statusCount,
    by_primary_family: familyCount,
    by_category: categoryCount,
    case_id_unique: new Set(records.map((r) => r.case_id)).size === records.length,
  };

  return { records, stats };
}

// ============================================================================
// Output
// ============================================================================

function emitCaseList(
  outPath: string,
  records: CaseListRecord[],
  stats: Record<string, unknown>,
  experimentMeta: { sourceB: Record<string, unknown>; sourceD: Record<string, unknown>; preflight: Record<string, unknown>; preflightReplacements: Record<string, unknown> }
): void {
  const metadata = {
    __metadata: true,
    phase: 'N1 Phase 1h (case-list lock)',
    generated_at: new Date().toISOString(),
    design_md_version: 'v1 + Amendment 1 + Amendment 2 + Amendment 3 + Amendment 4',
    pre_registration_chain: [
      { commit: 'd581838', label: 'DESIGN.md v1 (initial pre-registration)' },
      { commit: '2adf908', label: 'Amendment 1 (strike N1-B)' },
      { commit: 'e881221', label: 'Amendment 2 (Source B selection algorithm + content disclaimer)' },
      { commit: 'b6a029b', label: 'Amendment 3 (§13 ↔ Amendment 2 interaction, Reading 1)' },
      { commit: '0be531a', label: 'Amendment 4 (Source D reconciliation + 3 disclaimers + 3-class taxonomy)' },
    ],
    composition: {
      sources: [
        'candidates-source-b.jsonl (Phase 1b)',
        'candidates-source-b-replacements.jsonl (Phase 1f)',
        'preflight-results.jsonl (Phase 1c)',
        'preflight-replacements-results.jsonl (Phase 1f-6)',
        'source-d-seeds.jsonl (Phase 1g)',
      ],
      rule: '37 Source B original pre-flight passes + 3 Source B replacement passes + 12 Source D synthetic = 52 N1-A live cases',
    },
    random_seed: RANDOM_SEED,
    source_b_metadata: experimentMeta.sourceB,
    source_d_metadata: experimentMeta.sourceD,
    preflight_metadata: experimentMeta.preflight,
    preflight_replacements_metadata: experimentMeta.preflightReplacements,
    stats,
  };

  const lines: string[] = [JSON.stringify(metadata)];
  for (const r of records) {
    lines.push(JSON.stringify(r));
  }
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const experimentDir = import.meta.dir;
  const outPath = join(experimentDir, 'case-list.jsonl');

  console.log('N1 Phase 1h — Building case-list.jsonl');
  console.log('======================================');
  console.log('');

  const { records, stats } = buildCaseList(experimentDir);

  // Load metadata blocks for the case-list metadata header
  const sourceBMeta = loadJsonlMetadata(join(experimentDir, 'candidates-source-b.jsonl'));
  const sourceDMeta = loadJsonlMetadata(join(experimentDir, 'source-d-seeds.jsonl'));
  const preflightMeta = loadJsonlMetadata(join(experimentDir, 'preflight-results.jsonl'));
  const preflightReplacementsMeta = loadJsonlMetadata(
    join(experimentDir, 'preflight-replacements-results.jsonl')
  );

  emitCaseList(outPath, records, stats, {
    sourceB: sourceBMeta,
    sourceD: sourceDMeta,
    preflight: preflightMeta,
    preflightReplacements: preflightReplacementsMeta,
  });

  console.log(`Wrote ${records.length + 1} lines to ${outPath}`);
  console.log(`  1 metadata header + ${records.length} case records`);
  console.log('');
  console.log('=== Case list stats ===');
  console.log(JSON.stringify(stats, null, 2));
}

if (import.meta.main) {
  main();
}
