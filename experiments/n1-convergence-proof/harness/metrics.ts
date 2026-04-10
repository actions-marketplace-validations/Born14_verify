/**
 * N1 Phase 2 — Per-run metrics collection.
 *
 * Implements the metric schema described in DESIGN.md §7 (per-run metrics)
 * and §17 (narrowing quality raw data capture).
 *
 * Every run produces exactly one RunMetrics record regardless of loop type
 * (raw or governed). The record is written to the results file as one
 * JSONL line. Aggregation happens later in Phase 4 analysis — this file
 * does not aggregate, it only captures.
 *
 * Narrowing quality capture (§17): for each governed run, the harness
 * records the raw narrowing payload (the contents of the `NARROWING`
 * section shown to the agent on each retry) alongside the verify failure
 * summary. These tuples feed the Phase 4 inter-rater protocol. The raw
 * loop does not produce narrowing, so narrowing_samples is empty for raw
 * runs.
 *
 * Invariants:
 *   - One JSONL line per record, no trailing comma, no array wrapper.
 *   - Records are append-only. appendRunMetrics() writes with { flag: 'a' }.
 *   - If the results file does not exist, it is created.
 *   - Records must survive JSON round-trip: all fields are JSON-safe types.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { StopReason } from '../../../src/govern.js';

/**
 * Per-attempt record within a single run. Captures what the agent saw
 * and how verify() responded. Used by §17 narrowing quality raters to
 * evaluate whether the governed retry context was strictly more
 * informative than the raw failure — "if the hint stinks, it's not
 * narrowing crap" (operator framing, Phase 2 kickoff discussion).
 */
export interface AttemptRecord {
  attempt: number;
  promptChars: number;
  /** The full retry context shown to the agent (raw or governed) */
  retryContext: string;
  /** The verify() result produced by this attempt's edits */
  verifyResult: {
    success: boolean;
    gatesFailed: string[];
    failureDetails: string[];
  };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

/**
 * Per-run metrics record. One per (case × loop × run-idx).
 */
export interface RunMetrics {
  case_id: string;
  loop: 'raw' | 'governed';
  run_idx: number;
  stop_reason: StopReason;
  retry_count: number;
  converged: boolean;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  wall_time_ms: number;
  final_gates_failed: string[];
  /** Per-attempt trace. Length equals retry_count. */
  attempts: AttemptRecord[];
  /** Set by governed runs only — feeds §17 inter-rater protocol. */
  narrowing_samples: Array<{
    attempt: number;
    narrowing_content: string;
    verify_failure_summary: string;
  }>;
  /** When this run started (ISO), for audit only — never used in metrics */
  started_at: string;
  /** Scanner SHA / extractor SHA from case record, passed through for provenance */
  scanner_sha?: string;
  extractor_sha?: string;
}

/**
 * Create an empty metrics record for a fresh run. Caller mutates `attempts`
 * and `narrowing_samples` in place, then finalizes with `finalizeRunMetrics`
 * before writing.
 */
export function createRunMetrics(
  case_id: string,
  loop: 'raw' | 'governed',
  run_idx: number,
  scanner_sha?: string,
  extractor_sha?: string
): RunMetrics {
  // `started_at` uses ISO timestamp — this is pure provenance, never
  // read back into any metric calculation. Date.now() is allowed here
  // per Phase 2 constraints (not in anything the agent sees).
  return {
    case_id,
    loop,
    run_idx,
    stop_reason: 'agent_error', // placeholder; set by finalize
    retry_count: 0,
    converged: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    wall_time_ms: 0,
    final_gates_failed: [],
    attempts: [],
    narrowing_samples: [],
    started_at: new Date().toISOString(),
    ...(scanner_sha !== undefined ? { scanner_sha } : {}),
    ...(extractor_sha !== undefined ? { extractor_sha } : {}),
  };
}

/**
 * Roll up per-attempt tallies into the top-level aggregate fields.
 * Call this once before appendRunMetrics().
 */
export function finalizeRunMetrics(
  metrics: RunMetrics,
  stopReason: StopReason,
  wallTimeMs: number,
  finalGatesFailed: string[],
  converged: boolean
): void {
  metrics.stop_reason = stopReason;
  metrics.wall_time_ms = wallTimeMs;
  metrics.final_gates_failed = finalGatesFailed;
  metrics.converged = converged;
  metrics.retry_count = metrics.attempts.length;

  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  for (const a of metrics.attempts) {
    totalIn += a.inputTokens;
    totalOut += a.outputTokens;
    totalCost += a.costUsd;
  }
  metrics.total_input_tokens = totalIn;
  metrics.total_output_tokens = totalOut;
  metrics.total_cost_usd = totalCost;
}

/**
 * Append a run metrics record to a JSONL results file. One line per call.
 * Creates the parent directory if missing.
 */
export function appendRunMetrics(resultsPath: string, metrics: RunMetrics): void {
  const dir = dirname(resultsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(metrics) + '\n';
  appendFileSync(resultsPath, line, 'utf-8');
}

/**
 * Build a compact AttemptRecord from raw harness inputs. Helper so
 * run-case.ts doesn't have to manually shape the struct every iteration.
 */
export function buildAttemptRecord(
  attempt: number,
  retryContext: string,
  verifyResult: { success: boolean; gates: Array<{ gate: string; passed: boolean; detail: string }> },
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  durationMs: number
): AttemptRecord {
  const failed = verifyResult.gates.filter((g) => g.passed === false);
  return {
    attempt,
    promptChars: retryContext.length,
    retryContext,
    verifyResult: {
      success: verifyResult.success,
      gatesFailed: failed.map((g) => g.gate),
      failureDetails: failed.map((g) => (g.detail ?? '').slice(0, 300)),
    },
    inputTokens,
    outputTokens,
    costUsd,
    durationMs,
  };
}
