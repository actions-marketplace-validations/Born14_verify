/**
 * N1 Phase 2.5 — Pilot driver (5 cases × 2 loops × 3 runs = 30 runs).
 *
 * Per DESIGN.md §18:
 *   - 5 cases drawn from the N1-A Source B pool (one per primary family:
 *     f9, content, propagation, access, state)
 *   - 2 loops (raw, governed)
 *   - 3 runs per case per loop
 *   - Primary model: Gemini 2.0 Flash, temperature 0 (§19)
 *   - Cost budget: $30 hard cap, $20 alert (§22)
 *
 * Decision gate (§18) — evaluated after all 30 runs complete:
 *   1. Raw convergence rate: 20% ≤ rate ≤ 80%
 *      (< 20% = model too weak; > 80% = model too strong; either way HALT)
 *   2. Zero harness crashes
 *   3. Avg tokens per run ≤ 5,000
 *   4. Avg wall time per run ≤ 30 seconds
 *
 * If any gate fails → HALT and escalate. Do NOT proceed to Phase 3 on a
 * broken pilot.
 *
 * Deterministic case selection:
 *   Read case-list.jsonl (skip metadata header line). For each primary
 *   family in the fixed order [f9, content, propagation, access, state],
 *   pick the FIRST Source B case whose primary_family matches. This
 *   selection is deterministic given the locked case-list.jsonl — the
 *   same file produces the same 5 cases on every run.
 *
 * Usage:
 *   INPUT_API_KEY=<gemini-key> INPUT_PROVIDER=gemini \
 *     bun experiments/n1-convergence-proof/harness/run-pilot.ts
 *
 * Output:
 *   experiments/n1-convergence-proof/pilot-results.jsonl
 *   (1 metadata header + 30 per-run records)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runCase, type CaseRecord } from './run-case.js';
import { createCostTracker, type CostTracker } from './llm-adapter.js';
import { appendRunMetrics, type RunMetrics } from './metrics.js';
import type { StopReason } from '../../../src/govern.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const CASE_LIST_PATH = join(import.meta.dir, '..', 'case-list.jsonl');
const RESULTS_PATH = join(import.meta.dir, '..', 'pilot-results.jsonl');
const FIXTURE_APP_DIR = join(import.meta.dir, '..', '..', '..', 'fixtures', 'demo-app');

const PRIMARY_FAMILIES = ['f9', 'content', 'propagation', 'access', 'state'] as const;
const RUNS_PER_LOOP = 3;
const LOOPS: Array<'raw' | 'governed'> = ['raw', 'governed'];

// §22 budget limits
const HARD_CAP_USD = 30;
const ALERT_THRESHOLD_USD = 20;

// §18 decision gate thresholds
const GATE_RAW_CONVERGENCE_MIN = 0.20;
const GATE_RAW_CONVERGENCE_MAX = 0.80;
const GATE_AVG_TOKENS_MAX = 5000;
const GATE_AVG_WALL_TIME_MS_MAX = 30_000;

// Hermetic gate set for the pilot — no Docker, no browser, no network.
// Matches the gate set used in the run-case end-to-end tests, which are
// green against fixtures/demo-app.
const HERMETIC_GATES = {
  staging: false,
  browser: false,
  http: false,
  invariants: false,
  vision: false,
} as const;

// =============================================================================
// CASE LIST LOADING
// =============================================================================

export interface CaseListRecord extends CaseRecord {
  primary_family: string | null;
  track: string;
  intent: string;
  pre_flight_result?: string;
  scenario_file?: string;
  scenario_id?: string;
}

export function loadCaseList(path: string): CaseListRecord[] {
  if (!existsSync(path)) {
    throw new Error(`case-list.jsonl not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8').trim().split('\n');
  if (raw.length < 2) {
    throw new Error(`case-list.jsonl has fewer than 2 lines (expected metadata header + cases)`);
  }
  // Skip the metadata header (first line — contains __metadata: true).
  const header = JSON.parse(raw[0]!) as Record<string, unknown>;
  if (header.__metadata !== true) {
    throw new Error(`First line of case-list.jsonl is not a metadata header`);
  }
  const cases: CaseListRecord[] = [];
  for (let i = 1; i < raw.length; i++) {
    const line = raw[i]!.trim();
    if (!line) continue;
    cases.push(JSON.parse(line) as CaseListRecord);
  }
  return cases;
}

/**
 * Deterministic pilot case selection per §18.
 *
 * For each primary family in the fixed order, pick the first Source B
 * case in case-list.jsonl order whose primary_family matches. Returns
 * exactly 5 cases in the order [f9, content, propagation, access, state].
 *
 * Throws if any primary family has zero matching cases.
 */
export function selectPilotCases(allCases: CaseListRecord[]): CaseListRecord[] {
  const selected: CaseListRecord[] = [];
  for (const family of PRIMARY_FAMILIES) {
    const match = allCases.find(
      (c) => c.source === 'B' && c.primary_family === family
    );
    if (!match) {
      throw new Error(
        `Pilot case selection: no Source B case found for primary_family='${family}'. ` +
          `case-list.jsonl may be malformed or missing a primary family.`
      );
    }
    selected.push(match);
  }
  return selected;
}

// =============================================================================
// DECISION GATE EVALUATION
// =============================================================================

export interface PilotSummary {
  total_runs: number;
  runs_per_loop: { raw: number; governed: number };
  stop_reasons: { raw: Record<StopReason, number>; governed: Record<StopReason, number> };
  convergence_rates: { raw: number; governed: number };
  avg_tokens_per_run: { raw: number; governed: number; overall: number };
  avg_wall_time_ms: { raw: number; governed: number; overall: number };
  total_cost_usd: number;
  crashes: number;
  gate_results: {
    raw_convergence_in_band: { pass: boolean; observed: number; min: number; max: number };
    zero_crashes: { pass: boolean; observed: number };
    avg_tokens_within_budget: { pass: boolean; observed: number; max: number };
    avg_wall_time_within_budget: { pass: boolean; observed: number; max: number };
  };
  all_gates_passed: boolean;
}

function emptyStopReasonTally(): Record<StopReason, number> {
  return {
    converged: 0,
    exhausted: 0,
    stuck: 0,
    empty_plan_stall: 0,
    approval_aborted: 0,
    agent_error: 0,
  };
}

export function summarizePilot(metrics: RunMetrics[], crashes: number): PilotSummary {
  const raw = metrics.filter((m) => m.loop === 'raw');
  const gov = metrics.filter((m) => m.loop === 'governed');

  const rawStops = emptyStopReasonTally();
  const govStops = emptyStopReasonTally();
  for (const m of raw) rawStops[m.stop_reason] += 1;
  for (const m of gov) govStops[m.stop_reason] += 1;

  // Convergence rate denominator per §1: converged + exhausted + stuck + empty_plan_stall.
  // agent_error and approval_aborted are data-quality metrics, not convergence failures.
  const rawDenom =
    rawStops.converged + rawStops.exhausted + rawStops.stuck + rawStops.empty_plan_stall;
  const govDenom =
    govStops.converged + govStops.exhausted + govStops.stuck + govStops.empty_plan_stall;
  const rawConvRate = rawDenom > 0 ? rawStops.converged / rawDenom : 0;
  const govConvRate = govDenom > 0 ? govStops.converged / govDenom : 0;

  const avgTokens = (ms: RunMetrics[]): number => {
    if (ms.length === 0) return 0;
    const total = ms.reduce((s, m) => s + m.total_input_tokens + m.total_output_tokens, 0);
    return total / ms.length;
  };
  const avgWall = (ms: RunMetrics[]): number => {
    if (ms.length === 0) return 0;
    const total = ms.reduce((s, m) => s + m.wall_time_ms, 0);
    return total / ms.length;
  };

  const rawAvgTokens = avgTokens(raw);
  const govAvgTokens = avgTokens(gov);
  const overallAvgTokens = avgTokens(metrics);
  const rawAvgWall = avgWall(raw);
  const govAvgWall = avgWall(gov);
  const overallAvgWall = avgWall(metrics);

  const totalCost = metrics.reduce((s, m) => s + m.total_cost_usd, 0);

  const rawConvPass =
    rawConvRate >= GATE_RAW_CONVERGENCE_MIN && rawConvRate <= GATE_RAW_CONVERGENCE_MAX;
  const crashesPass = crashes === 0;
  const tokensPass = overallAvgTokens <= GATE_AVG_TOKENS_MAX;
  const wallPass = overallAvgWall <= GATE_AVG_WALL_TIME_MS_MAX;

  return {
    total_runs: metrics.length,
    runs_per_loop: { raw: raw.length, governed: gov.length },
    stop_reasons: { raw: rawStops, governed: govStops },
    convergence_rates: { raw: rawConvRate, governed: govConvRate },
    avg_tokens_per_run: { raw: rawAvgTokens, governed: govAvgTokens, overall: overallAvgTokens },
    avg_wall_time_ms: { raw: rawAvgWall, governed: govAvgWall, overall: overallAvgWall },
    total_cost_usd: totalCost,
    crashes,
    gate_results: {
      raw_convergence_in_band: {
        pass: rawConvPass,
        observed: rawConvRate,
        min: GATE_RAW_CONVERGENCE_MIN,
        max: GATE_RAW_CONVERGENCE_MAX,
      },
      zero_crashes: { pass: crashesPass, observed: crashes },
      avg_tokens_within_budget: {
        pass: tokensPass,
        observed: overallAvgTokens,
        max: GATE_AVG_TOKENS_MAX,
      },
      avg_wall_time_within_budget: {
        pass: wallPass,
        observed: overallAvgWall,
        max: GATE_AVG_WALL_TIME_MS_MAX,
      },
    },
    all_gates_passed: rawConvPass && crashesPass && tokensPass && wallPass,
  };
}

// =============================================================================
// ORCHESTRATOR
// =============================================================================

async function main(): Promise<void> {
  console.log('N1 Phase 2.5 — Pilot driver');
  console.log('================================');
  console.log(`  Case list:       ${CASE_LIST_PATH}`);
  console.log(`  Fixture appDir:  ${FIXTURE_APP_DIR}`);
  console.log(`  Results file:    ${RESULTS_PATH}`);
  console.log(`  Budget:          $${HARD_CAP_USD} hard cap, $${ALERT_THRESHOLD_USD} alert`);
  console.log('');

  if (!existsSync(FIXTURE_APP_DIR)) {
    throw new Error(`Fixture appDir not found: ${FIXTURE_APP_DIR}`);
  }

  const allCases = loadCaseList(CASE_LIST_PATH);
  console.log(`Loaded ${allCases.length} cases from case-list.jsonl`);

  const pilotCases = selectPilotCases(allCases);
  console.log(`Selected ${pilotCases.length} pilot cases (1 per primary family):`);
  for (const c of pilotCases) {
    console.log(`  - [${c.primary_family}] ${c.case_id} — ${c.goal.substring(0, 70)}`);
  }
  console.log('');

  // §22 cost tracker shared across all runs.
  const tracker: CostTracker = createCostTracker(HARD_CAP_USD, ALERT_THRESHOLD_USD);

  // Write the metadata header to the results file BEFORE any runs.
  // This is immediately readable even if the pilot aborts mid-way.
  const metadata = {
    __metadata: true,
    phase: 'N1 Phase 2.5 (Pilot)',
    generated_at: new Date().toISOString(),
    case_list_path: 'experiments/n1-convergence-proof/case-list.jsonl',
    fixture_app_dir: 'fixtures/demo-app/',
    primary_families: PRIMARY_FAMILIES,
    pilot_cases: pilotCases.map((c) => ({
      case_id: c.case_id,
      primary_family: c.primary_family,
      goal: c.goal,
    })),
    runs_per_loop: RUNS_PER_LOOP,
    loops: LOOPS,
    total_runs_planned: pilotCases.length * LOOPS.length * RUNS_PER_LOOP,
    budget: { hard_cap_usd: HARD_CAP_USD, alert_threshold_usd: ALERT_THRESHOLD_USD },
    decision_gate_thresholds: {
      raw_convergence_min: GATE_RAW_CONVERGENCE_MIN,
      raw_convergence_max: GATE_RAW_CONVERGENCE_MAX,
      avg_tokens_max: GATE_AVG_TOKENS_MAX,
      avg_wall_time_ms_max: GATE_AVG_WALL_TIME_MS_MAX,
    },
    hermetic_gates: HERMETIC_GATES,
  };
  const { appendFileSync, writeFileSync } = await import('fs');
  writeFileSync(RESULTS_PATH, JSON.stringify(metadata) + '\n', 'utf-8');
  void appendFileSync;

  const allMetrics: RunMetrics[] = [];
  let crashCount = 0;
  let runIdxGlobal = 0;
  const totalRunsPlanned = pilotCases.length * LOOPS.length * RUNS_PER_LOOP;
  const globalStart = Date.now();

  for (const caseRecord of pilotCases) {
    for (const loop of LOOPS) {
      for (let runIdx = 0; runIdx < RUNS_PER_LOOP; runIdx++) {
        runIdxGlobal += 1;
        const label = `[${String(runIdxGlobal).padStart(2, ' ')}/${totalRunsPlanned}]`;
        const caseLabel = `${caseRecord.primary_family}/${caseRecord.case_id}`;
        process.stdout.write(`  ${label} ${loop.padEnd(9)} ${caseLabel} r${runIdx} ... `);

        // Alert threshold check.
        if (tracker.overAlert) {
          console.log('');
          console.log(`  [§22 alert] Cumulative spend $${tracker.totalSpentUsd.toFixed(4)} crossed $${ALERT_THRESHOLD_USD}.`);
          console.log(`  Continuing the pilot (alert only, not hard cap). Monitor carefully.`);
        }

        let metrics: RunMetrics;
        try {
          metrics = await runCase({
            caseRecord: {
              case_id: caseRecord.case_id,
              source: caseRecord.source,
              category: caseRecord.category,
              goal: caseRecord.goal,
              reference_edits: caseRecord.reference_edits,
              reference_predicates: caseRecord.reference_predicates,
              expected_success: caseRecord.expected_success,
              ...(caseRecord.scanner_sha !== undefined ? { scanner_sha: caseRecord.scanner_sha } : {}),
              ...(caseRecord.extractor_sha !== undefined ? { extractor_sha: caseRecord.extractor_sha } : {}),
            },
            loop,
            run_idx: runIdx,
            fixtureAppDir: FIXTURE_APP_DIR,
            tracker,
            gates: HERMETIC_GATES,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('§22 hard cap')) {
            console.log('HARD CAP HIT');
            console.log('');
            console.log(`  [§22 hard cap] Pilot aborted. Cumulative spend $${tracker.totalSpentUsd.toFixed(4)}.`);
            console.log(`  Escalating to operator.`);
            break;
          }
          // Any other exception is a harness crash per §18 gate 2.
          crashCount += 1;
          console.log(`CRASH: ${msg.substring(0, 120)}`);
          continue;
        }

        allMetrics.push(metrics);
        appendRunMetrics(RESULTS_PATH, metrics);

        const symbol = metrics.converged ? '✓' : metrics.stop_reason === 'agent_error' ? '!' : '✗';
        const costStr = `$${metrics.total_cost_usd.toFixed(4)}`;
        const tokStr = `${metrics.total_input_tokens + metrics.total_output_tokens}tok`;
        console.log(
          `${symbol} ${metrics.stop_reason} r=${metrics.retry_count} ${tokStr} ${metrics.wall_time_ms}ms ${costStr}`
        );
      }

      if (tracker.overCap) break;
    }
    if (tracker.overCap) break;
  }

  const globalDuration = Date.now() - globalStart;
  console.log('');
  console.log('=== Pilot summary ===');
  const summary = summarizePilot(allMetrics, crashCount);
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  console.log(`Total wall time: ${(globalDuration / 1000).toFixed(1)}s`);
  console.log(`Total spend: $${tracker.totalSpentUsd.toFixed(4)} (${tracker.totalCalls} LLM calls)`);
  console.log('');

  // Append the summary to the results file as the final line.
  const { appendFileSync: appendFS } = await import('fs');
  appendFS(
    RESULTS_PATH,
    JSON.stringify({ __summary: true, ...summary, total_wall_time_ms: globalDuration }) + '\n',
    'utf-8'
  );

  console.log('🚩 §18 DECISION GATE 🚩');
  const gr = summary.gate_results;
  const line = (name: string, pass: boolean, detail: string): void => {
    console.log(`  ${pass ? '✓' : '✗'} ${name}: ${detail}`);
  };
  line(
    'raw_convergence_in_band',
    gr.raw_convergence_in_band.pass,
    `observed ${(gr.raw_convergence_in_band.observed * 100).toFixed(1)}%, band [${gr.raw_convergence_in_band.min * 100}%, ${gr.raw_convergence_in_band.max * 100}%]`
  );
  line('zero_crashes', gr.zero_crashes.pass, `${gr.zero_crashes.observed} crash(es)`);
  line(
    'avg_tokens_within_budget',
    gr.avg_tokens_within_budget.pass,
    `observed ${gr.avg_tokens_within_budget.observed.toFixed(0)} tok, max ${gr.avg_tokens_within_budget.max}`
  );
  line(
    'avg_wall_time_within_budget',
    gr.avg_wall_time_within_budget.pass,
    `observed ${(gr.avg_wall_time_within_budget.observed / 1000).toFixed(1)}s, max ${gr.avg_wall_time_within_budget.max / 1000}s`
  );
  console.log('');

  if (summary.all_gates_passed) {
    console.log('  ✓ ALL GATES PASSED. Pilot authorizes Phase 3 full execution.');
    console.log('    The operator still reviews this summary and gives the go-ahead.');
  } else {
    console.log('  ✗ ONE OR MORE GATES FAILED. HALT — do not proceed to Phase 3.');
    console.log('    Escalate to operator for ruling. Do not amend the harness silently.');
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('PILOT DRIVER FAILED:', err);
    process.exit(1);
  });
}
