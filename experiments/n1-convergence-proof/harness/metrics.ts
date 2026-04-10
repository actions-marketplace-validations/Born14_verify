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
 * Scaffold status: skeleton. Body implemented in deliverable 6.
 */

import type { StopReason } from '../../../src/govern.js';
import type { VerifyResult } from '../../../src/types.js';

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
  verifyResult: Pick<VerifyResult, 'success'> & {
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
 * Create an empty metrics record for a fresh run.
 */
export function createRunMetrics(
  case_id: string,
  loop: 'raw' | 'governed',
  run_idx: number,
  scanner_sha?: string,
  extractor_sha?: string
): RunMetrics {
  void case_id; void loop; void run_idx; void scanner_sha; void extractor_sha;
  throw new Error('NOT_IMPLEMENTED: metrics deliverable 6');
}

/**
 * Append a run metrics record to a JSONL results file. One line per call.
 */
export function appendRunMetrics(resultsPath: string, metrics: RunMetrics): void {
  void resultsPath; void metrics;
  throw new Error('NOT_IMPLEMENTED: metrics deliverable 6');
}
