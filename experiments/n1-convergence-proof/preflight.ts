/**
 * N1 Phase 1c — Pre-flight check for Source B candidates.
 *
 * Per DESIGN.md §12, each candidate scenario's reference_edits are run
 * through verify() against fixtures/demo-app/ to confirm the scenario
 * still produces its declared expected_success outcome. Scenarios whose
 * reference edits no longer match the expected verify result are
 * stale-dropped per the Amendment 2 + §13 contingency rule.
 *
 * Protocol (DESIGN.md §12, §21):
 *   1. Copy fixtures/demo-app to a fresh temp directory per scenario
 *      (stateDir hygiene — no cross-scenario contamination).
 *   2. Run verify() with the scenario's reference_edits and
 *      reference_predicates against the temp appDir.
 *   3. Compare result.success to the scenario's expected_success.
 *   4. Record: 'pass' if they match, 'stale-drop' if they don't.
 *   5. Clean up the temp directory after the run (best-effort).
 *
 * Non-Docker gate set:
 *   Pre-flight runs with Docker-dependent gates explicitly disabled
 *   (staging, browser, http, invariants, vision). These gates would
 *   otherwise try to build and run a Docker container, which is both
 *   slow and unnecessary for the pre-flight's purpose (confirm ground
 *   truth stability, not exercise the full verification pipeline).
 *   The remaining gates (grounding, F9, K5, G5, access, temporal,
 *   propagation, state, capacity, contention, observation, filesystem,
 *   infrastructure, serialization, config, security, a11y, performance,
 *   triangulation, hallucination) are sufficient to detect whether
 *   a scenario's reference edits still produce its expected result.
 *
 * Usage:
 *   bun experiments/n1-convergence-proof/preflight.ts
 *
 * Output:
 *   experiments/n1-convergence-proof/preflight-results.jsonl
 *
 * First line is a metadata header; subsequent lines are per-case results.
 *
 * The drop count k is printed at the end. The operator then rules on the
 * §13 contingency rule classification (k ≤ 5, 6 ≤ k ≤ 15, k > 15).
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { verify } from '../../src/verify.js';
import type { Edit, Predicate, VerifyConfig } from '../../src/types.js';

// ============================================================================
// Types
// ============================================================================

interface CandidateRecord {
  case_id: string;
  source: 'B';
  intent: 'false_negative';
  category: string;
  primary_family: string | null;
  track: 'N1-A';
  goal: string;
  reference_edits: Edit[];
  reference_predicates: Predicate[];
  expected_success: boolean;
  scenario_file: string;
  scenario_id: string;
}

type PreflightStatus = 'pass' | 'stale-drop' | 'error';

interface PreflightResult {
  case_id: string;
  category: string;
  primary_family: string | null;
  status: PreflightStatus;
  observed_success: boolean | null;
  expected_success: boolean;
  mismatch_reason: string | null;
  gates_failed: string[];
  failure_detail: string | null;
  duration_ms: number;
}

// ============================================================================
// Candidate loader
// ============================================================================

function loadCandidates(path: string): { metadata: Record<string, unknown>; candidates: CandidateRecord[] } {
  const raw = readFileSync(path, 'utf-8').trim().split('\n');
  if (raw.length === 0) {
    throw new Error(`Empty candidates file: ${path}`);
  }

  const metadata = JSON.parse(raw[0]) as Record<string, unknown>;
  if (metadata.__metadata !== true) {
    throw new Error(`First line of ${path} is not a metadata header`);
  }

  const candidates = raw.slice(1).map((line, idx) => {
    try {
      return JSON.parse(line) as CandidateRecord;
    } catch (err) {
      throw new Error(`Failed to parse candidate line ${idx + 2}: ${(err as Error).message}`);
    }
  });

  return { metadata, candidates };
}

// ============================================================================
// Per-scenario pre-flight runner
// ============================================================================

/**
 * Copy fixtures/demo-app to a fresh temp directory for isolated pre-flight.
 * Matches the pattern from tests/govern.test.ts tmpAppDir().
 */
function stageDemoApp(demoAppFixture: string, caseId: string): string {
  const safe = caseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = join(tmpdir(), `n1-preflight-${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  cpSync(demoAppFixture, dir, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[/\\]/).pop() ?? '';
      return !['node_modules', '.git', '.verify'].includes(name);
    },
  });
  return dir;
}

function cleanupStagedDir(dir: string): void {
  if (dir && existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; don't fail the pre-flight over cleanup */
    }
  }
}

async function runPreflightForCase(
  candidate: CandidateRecord,
  demoAppFixture: string
): Promise<PreflightResult> {
  const start = Date.now();
  let stagedDir: string | null = null;

  try {
    stagedDir = stageDemoApp(demoAppFixture, candidate.case_id);

    // Non-Docker gate config. Staging/browser/http/invariants/vision are
    // explicitly disabled because pre-flight is a local mechanical check.
    // All other gates run at their defaults.
    const config: VerifyConfig = {
      appDir: stagedDir,
      goal: candidate.goal,
      gates: {
        staging: false,
        browser: false,
        http: false,
        invariants: false,
        vision: false,
      },
      // stateDir is auto-created inside stagedDir and will be wiped with the
      // temp directory after the run. This satisfies §21 stateDir hygiene.
      learning: 'session',
    };

    const result = await verify(candidate.reference_edits, candidate.reference_predicates, config);
    const observed = result.success;
    const matches = observed === candidate.expected_success;

    const gatesFailed = result.gates.filter((g) => !g.passed).map((g) => String(g.gate));
    const failureDetail = matches
      ? null
      : result.gates
          .filter((g) => !g.passed)
          .map((g) => `[${g.gate}] ${(g.detail ?? '').substring(0, 200)}`)
          .join('; ') || null;

    const mismatchReason = matches
      ? null
      : `expected success=${candidate.expected_success}, got success=${observed}${gatesFailed.length > 0 ? `; failing gates: ${gatesFailed.join(', ')}` : ''}`;

    return {
      case_id: candidate.case_id,
      category: candidate.category,
      primary_family: candidate.primary_family,
      status: matches ? 'pass' : 'stale-drop',
      observed_success: observed,
      expected_success: candidate.expected_success,
      mismatch_reason: mismatchReason,
      gates_failed: gatesFailed,
      failure_detail: failureDetail,
      duration_ms: Date.now() - start,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      case_id: candidate.case_id,
      category: candidate.category,
      primary_family: candidate.primary_family,
      status: 'error',
      observed_success: null,
      expected_success: candidate.expected_success,
      mismatch_reason: `verify() threw: ${msg.substring(0, 300)}`,
      gates_failed: [],
      failure_detail: null,
      duration_ms: Date.now() - start,
    };
  } finally {
    if (stagedDir) cleanupStagedDir(stagedDir);
  }
}

// ============================================================================
// Orchestrator
// ============================================================================

interface PreflightSummary {
  total: number;
  pass: number;
  stale_drop: number;
  error: number;
  k_drop_count: number;
  per_family_drops: Record<string, number>;
  per_category_drops: Record<string, number>;
  contingency_bucket: 'k≤5' | '6≤k≤15' | 'k>15';
  content_family_drop_edge_case: boolean;
}

function summarize(results: PreflightResult[]): PreflightSummary {
  const total = results.length;
  const pass = results.filter((r) => r.status === 'pass').length;
  const staleDrop = results.filter((r) => r.status === 'stale-drop').length;
  const error = results.filter((r) => r.status === 'error').length;

  // Per DESIGN.md §13: k is the count of stale-dropped Source B cases.
  // errors are reported separately from k — an error is a harness bug, not
  // a ground-truth drift. The operator rules on error cases separately.
  const k = staleDrop;

  const perFamilyDrops: Record<string, number> = {};
  const perCategoryDrops: Record<string, number> = {};
  let contentFamilyDrop = false;

  for (const r of results) {
    if (r.status === 'stale-drop') {
      const family = r.primary_family ?? 'non-primary';
      perFamilyDrops[family] = (perFamilyDrops[family] ?? 0) + 1;
      perCategoryDrops[r.category] = (perCategoryDrops[r.category] ?? 0) + 1;
      if (r.primary_family === 'content') contentFamilyDrop = true;
    }
  }

  let bucket: PreflightSummary['contingency_bucket'];
  if (k <= 5) bucket = 'k≤5';
  else if (k <= 15) bucket = '6≤k≤15';
  else bucket = 'k>15';

  return {
    total,
    pass,
    stale_drop: staleDrop,
    error,
    k_drop_count: k,
    per_family_drops: perFamilyDrops,
    per_category_drops: perCategoryDrops,
    contingency_bucket: bucket,
    content_family_drop_edge_case: contentFamilyDrop,
  };
}

/**
 * Parse CLI arguments:
 *   bun preflight.ts                              — default mode: candidates-source-b.jsonl → preflight-results.jsonl
 *   bun preflight.ts --input X.jsonl --output Y.jsonl  — custom input/output
 *
 * The --input/--output flags exist so pre-flight can run on subsets
 * (like the 3 replacement candidates after a §13 contingency draw)
 * without overwriting the original 40-case Phase 1c results. The
 * original preflight-results.jsonl is immutable once committed.
 */
interface PreflightCliArgs {
  inputPath: string;
  outputPath: string;
  phaseLabel: string;
}

function parsePreflightArgs(argv: string[]): PreflightCliArgs {
  let inputPath = join(import.meta.dir, 'candidates-source-b.jsonl');
  let outputPath = join(import.meta.dir, 'preflight-results.jsonl');
  let phaseLabel = 'N1 Phase 1c (Pre-flight check)';

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) {
      inputPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--output' && argv[i + 1]) {
      outputPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--phase' && argv[i + 1]) {
      phaseLabel = argv[i + 1];
      i++;
    }
  }
  return { inputPath, outputPath, phaseLabel };
}

async function main(): Promise<void> {
  const { inputPath, outputPath, phaseLabel } = parsePreflightArgs(process.argv);
  const candidatesPath = inputPath;
  const outPath = outputPath;
  const demoAppFixture = join(import.meta.dir, '..', '..', 'fixtures', 'demo-app');

  console.log('N1 Pre-flight check');
  console.log('================================');
  console.log(`  Phase label:     ${phaseLabel}`);
  console.log(`  Candidates file: ${candidatesPath}`);
  console.log(`  Demo-app fixture: ${demoAppFixture}`);
  console.log(`  Results file:    ${outPath}`);
  console.log('');

  if (!existsSync(candidatesPath)) {
    throw new Error(`Candidates file not found: ${candidatesPath}`);
  }
  if (!existsSync(demoAppFixture)) {
    throw new Error(`Demo-app fixture not found: ${demoAppFixture}`);
  }

  const { metadata, candidates } = loadCandidates(candidatesPath);
  console.log(
    `Loaded ${candidates.length} candidates (corpus_sha=${metadata.corpus_sha ?? 'UNKNOWN'}, seed=${metadata.random_seed ?? 'UNKNOWN'})`
  );
  console.log('');

  const results: PreflightResult[] = [];
  const globalStart = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const idx = String(i + 1).padStart(3, ' ');
    process.stdout.write(`  [${idx}/${candidates.length}] ${c.case_id} ... `);
    const result = await runPreflightForCase(c, demoAppFixture);
    results.push(result);
    const symbol = result.status === 'pass' ? '✓' : result.status === 'stale-drop' ? '✗' : '!';
    console.log(`${symbol} (${result.status}, ${result.duration_ms}ms)`);
    if (result.status === 'stale-drop' && result.mismatch_reason) {
      console.log(`         → ${result.mismatch_reason.substring(0, 180)}`);
    } else if (result.status === 'error' && result.mismatch_reason) {
      console.log(`         → ERROR: ${result.mismatch_reason.substring(0, 180)}`);
    }
  }

  const globalDuration = Date.now() - globalStart;
  console.log('');
  console.log('=== Pre-flight summary ===');
  const summary = summarize(results);
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  console.log(`Total wall time: ${(globalDuration / 1000).toFixed(1)}s`);
  console.log('');

  // Emit results
  const preflightMetadata = {
    __metadata: true,
    phase: phaseLabel,
    candidates_file: candidatesPath.split(/[\\/]/).pop() ?? candidatesPath,
    candidates_metadata: metadata,
    demo_app_fixture: 'fixtures/demo-app/',
    generated_at: new Date().toISOString(),
    design_md_version: 'v1 + Amendment 1 + Amendment 2 + Amendment 3',
    gate_config: {
      staging: false,
      browser: false,
      http: false,
      invariants: false,
      vision: false,
    },
    summary,
    total_wall_time_ms: globalDuration,
  };

  const lines: string[] = [JSON.stringify(preflightMetadata)];
  for (const r of results) {
    lines.push(JSON.stringify(r));
  }
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${results.length + 1} lines to ${outPath} (1 metadata header + ${results.length} results)`);
  console.log('');

  // Final k report for the operator
  console.log('🚩 CHECKPOINT 🚩');
  console.log(`  k (stale-drop count) = ${summary.k_drop_count}`);
  console.log(`  Contingency bucket: ${summary.contingency_bucket}`);
  if (summary.content_family_drop_edge_case) {
    console.log(`  ⚠️  CONTENT FAMILY DROP DETECTED — Amendment 2 Change 2 edge case triggered`);
  }
  if (summary.error > 0) {
    console.log(`  ⚠️  ${summary.error} harness errors (not counted in k, but need operator review)`);
  }
  console.log('');
  console.log('  The operator rules on the contingency classification before');
  console.log('  case-list.jsonl is committed. No further work proceeds until');
  console.log('  that ruling lands.');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('PRE-FLIGHT FAILED:', err);
    process.exit(1);
  });
}
