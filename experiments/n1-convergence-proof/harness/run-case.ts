/**
 * N1 Phase 2 — Single-case runner (one case × one loop × one run).
 *
 * Orchestrates the end-to-end loop for a single run:
 *   1. stageRun() — fresh stateDir + fresh fixture copy (§21)
 *   2. Build the agent adapter (raw or governed flavor, both call callLLM)
 *   3. For raw loop: manual retry loop calling verify() each attempt, with
 *      renderRawRetryContext() as the prompt body on retry.
 *      For governed loop: single govern() call, agent's plan() uses
 *      renderGovernedRetryContext() to build the prompt body from
 *      GovernContext.
 *   4. Capture metrics after each attempt.
 *   5. Classify stop_reason.
 *   6. Cleanup the staged dirs (finally block).
 *
 * Loop parity (§4 "only difference between loops is the context renderer"):
 * the system prompt (§2), model (§19 Gemini 2.0 Flash, temperature=0, max
 * tokens 500), retry budget (§5 max 5 attempts), verify() call, edit/
 * predicate output format, and stateDir wipe protocol are IDENTICAL between
 * the two loops. The ONLY place they differ is which renderer produces the
 * retry-context string.
 *
 * Determinism: temperature=0 at the model level is not a full determinism
 * guarantee (Gemini occasionally produces different outputs at temp=0), but
 * it is the reasonable agent-developer default. The 3-runs-per-case
 * protocol exists exactly to absorb any residual non-determinism.
 *
 * Scaffold status: skeleton. Body implemented in deliverable 7 (built on
 * top of the earlier deliverables).
 */

import type { CostTracker } from './llm-adapter.js';
import type { RunMetrics } from './metrics.js';

export interface CaseRecord {
  case_id: string;
  source: 'B' | 'D';
  category: string;
  goal: string;
  reference_edits: unknown[];
  reference_predicates: unknown[];
  expected_success: boolean;
  scanner_sha?: string;
  extractor_sha?: string;
}

export interface RunCaseParams {
  caseRecord: CaseRecord;
  loop: 'raw' | 'governed';
  run_idx: number;
  fixtureAppDir: string;
  tracker: CostTracker;
}

/**
 * Execute a single run and return its metrics.
 *
 * Invariants:
 *   - Never throws on agent error. agent_error is a stop_reason, not an exception.
 *   - Throws on harness error (stateDir wipe failure, budget cap exceeded).
 *   - Cleanup always runs (finally block).
 */
export async function runCase(params: RunCaseParams): Promise<RunMetrics> {
  void params;
  throw new Error('NOT_IMPLEMENTED: run-case deliverable 7');
}
