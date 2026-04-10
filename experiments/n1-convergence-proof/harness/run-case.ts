/**
 * N1 Phase 2 — Single-case runner (one case × one loop × one run).
 *
 * Orchestrates the end-to-end loop for a single run. This is the
 * capstone module that wires the five earlier deliverables together:
 *
 *   render-raw.ts      → raw retry-context renderer (§3)
 *   render-governed.ts → governed retry-context renderer (§4)
 *   state-dir.ts       → stageRun + cleanup (§21)
 *   llm-adapter.ts     → callLLMWithTracking + CostTracker (§20, §22)
 *   metrics.ts         → RunMetrics + AttemptRecord + narrowing_samples (§7, §17)
 *
 * Architecture per DESIGN.md §4:
 *
 *   Raw loop:  manual retry loop. For each attempt, the harness calls
 *              renderRawRetryContext() → LLM → parse → verify() → repeat.
 *              §3 "reasonable agent developer" default.
 *
 *   Governed loop: govern() is called once. govern() calls our agent
 *              adapter's plan(goal, context) each attempt. Our adapter
 *              calls renderGovernedRetryContext(goal, context, maxAttempts)
 *              → LLM → parse → returns AgentPlan. govern() handles verify()
 *              calls, narrowing, constraint seeding, convergence detection,
 *              stuck detection, and stop-reason classification internally.
 *
 *   Both loops share: §2 system prompt verbatim, model (§19 Gemini 2.0
 *   Flash, temperature=0 via callLLM), retry budget (§5 max 5),
 *   verify() oracle, edit/predicate output format, stateDir wipe.
 *   The ONLY difference between loops is which renderer produces the
 *   retry-context string — enforced architecturally.
 *
 * Stop-reason classification (§6):
 *   - converged: final verify() returned success: true
 *   - exhausted: ran out of retries, last result was success: false
 *   - stuck: governed loop only; govern() detected shape repetition or
 *            gate cycles (propagated from GovernResult.stopReason)
 *   - empty_plan_stall: 3+ consecutive empty plans (raw loop tracks its
 *     own counter; governed loop uses govern()'s detection)
 *   - agent_error: plan() threw or produced malformed JSON (per-attempt;
 *     the final stop reason escalates to agent_error only if ALL
 *     attempts errored — otherwise the loop continued and eventually
 *     exhausted or converged)
 *   - approval_aborted: harness bug signal. N1 does not use approval
 *     gates, so this should never appear. If it does, that's a bug.
 *
 * Determinism: temperature=0 at the model level is not a full determinism
 * guarantee (Gemini occasionally produces different outputs at temp=0),
 * but it is the reasonable agent-developer default. The 3-runs-per-case
 * protocol exists exactly to absorb any residual non-determinism.
 */

import { govern, type GovernAgent, type GovernContext, type AgentPlan, type StopReason } from '../../../src/govern.js';
import { verify } from '../../../src/verify.js';
import type { Edit, Predicate, VerifyConfig, VerifyResult } from '../../../src/types.js';

import { renderRawRetryContext } from './render-raw.js';
import {
  renderGovernedRetryContext,
  formatNarrowing,
} from './render-governed.js';
import { stageRun } from './state-dir.js';
import { buildAppManifest, formatAppManifest } from './manifest.js';
import { callLLMWithTracking, type CostTracker, type CallLLMImpl } from './llm-adapter.js';
import {
  createRunMetrics,
  finalizeRunMetrics,
  buildAttemptRecord,
  type RunMetrics,
} from './metrics.js';

// =============================================================================
// SHARED PROMPT SHELL (§2 — VERBATIM, DO NOT EDIT)
// =============================================================================
//
// This string is the exact §2 system prompt. It is byte-identical between
// raw and governed loops. Editing this string is a §26 DESIGN.md change
// and requires an amendment.

export const SYSTEM_PROMPT_SHELL = `You are an AI coding agent. You produce edits to accomplish a goal in a
codebase. Your output must be a JSON object with exactly two fields:

  {
    "edits": [
      { "file": "path/to/file.ext", "search": "exact text to find", "replace": "replacement text" }
    ],
    "predicates": [
      { "type": "content", "file": "path/to/file.ext", "pattern": "string that should exist after the edit" }
    ]
  }

Rules:
1. Each edit's "search" field must match the file content EXACTLY, character for character, including whitespace.
2. Predicates assert claims about the codebase after your edits are applied.
3. Produce the minimum number of edits required to achieve the goal.
4. Do not add commentary, explanation, or markdown. Output JSON only.
5. The APP FILES: manifest at the top of every prompt is the complete set of files in the app. You may only emit edits targeting files listed in that manifest. File paths not in the manifest do not exist and will cause the F9 gate to fail. Do not fabricate file paths.

On retry: you will receive feedback about why your previous attempt failed. Use that feedback to revise your edits and predicates. The goal remains the same across retries.`;

// =============================================================================
// MAX ATTEMPTS (§5)
// =============================================================================

export const MAX_ATTEMPTS = 5;

// =============================================================================
// LLM OUTPUT PARSING
// =============================================================================

/**
 * Parse the LLM's JSON output into an AgentPlan. Tolerant of markdown
 * code fences and leading/trailing prose — agents drop these even when
 * §2 says not to. Both loops use this SAME parser so any parser-level
 * confound is eliminated.
 *
 * Returns null if no JSON object is extractable. Never throws.
 */
export function parseAgentOutput(text: string): AgentPlan | null {
  if (!text || typeof text !== 'string') return null;

  // Strip common markdown code-fence patterns.
  let body = text.trim();
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch && fenceMatch[1]) {
    body = fenceMatch[1].trim();
  }

  // Find the outermost JSON object. Simple bracket-balanced scan.
  const firstBrace = body.indexOf('{');
  if (firstBrace < 0) return null;
  let depth = 0;
  let endIdx = -1;
  for (let i = firstBrace; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) return null;

  const jsonSlice = body.slice(firstBrace, endIdx + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const edits = Array.isArray(obj.edits) ? (obj.edits as Edit[]) : [];
  const predicates = Array.isArray(obj.predicates) ? (obj.predicates as Predicate[]) : [];

  return { edits, predicates };
}

/**
 * Combine the §2 system prompt shell with the body (raw or governed
 * retry context). Uses a consistent separator so both loops produce
 * structurally identical messages modulo the body.
 */
export function combinePrompt(body: string): string {
  return `${SYSTEM_PROMPT_SHELL}\n\n${body}`;
}

// =============================================================================
// CASE RECORD
// =============================================================================

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
  /** Mock override for tests. Omit in production to use the real callLLM. */
  callLLMImpl?: CallLLMImpl;
  /** Per-call options to pass to callLLMWithTracking. */
  apiKey?: string;
  provider?: string;
  /** Gate toggles. Pilot runs typically disable Docker-gated checks. */
  gates?: VerifyConfig['gates'];
}

// =============================================================================
// RAW LOOP — manual retry, §3 renderer
// =============================================================================

async function runRawCase(params: RunCaseParams): Promise<RunMetrics> {
  const { caseRecord, run_idx, fixtureAppDir, tracker } = params;
  const metrics = createRunMetrics(
    caseRecord.case_id,
    'raw',
    run_idx,
    caseRecord.scanner_sha,
    caseRecord.extractor_sha
  );
  const runStart = Date.now();

  const staged = stageRun(fixtureAppDir, caseRecord.case_id, 'raw', run_idx);
  let stopReason: StopReason = 'agent_error';
  let finalGatesFailed: string[] = [];
  let converged = false;
  let priorResult: VerifyResult | undefined = undefined;
  let emptyPlanCount = 0;
  let allAttemptsErrored = true;

  // Amendment 6: build the APP FILES manifest once per run, after
  // stageRun but before the attempt loop. The same formatted string is
  // passed to the renderer on every attempt (byte-identical across
  // attempts within a run per §3 attempt-1 + attempt-N specification).
  const appManifest = formatAppManifest(buildAppManifest(staged.appDir));

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const attemptStart = Date.now();

      // Build the body via §3 renderer, then wrap with §2 system prompt.
      const body = renderRawRetryContext(caseRecord.goal, attempt, MAX_ATTEMPTS, priorResult, appManifest);
      const fullPrompt = combinePrompt(body);

      // Call the LLM (mock or real).
      let llmResult;
      try {
        llmResult = await callLLMWithTracking(fullPrompt, tracker, {
          callLLMImpl: params.callLLMImpl,
          apiKey: params.apiKey,
          provider: params.provider,
        });
      } catch (err) {
        // Budget cap exceeded or env error — rethrow; this is a harness
        // abort, not an agent_error.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('§22 hard cap') || msg.includes('INPUT_API_KEY not set')) {
          throw err;
        }
        // Other network-ish errors count as agent_error for this attempt.
        metrics.attempts.push(
          buildAttemptRecord(
            attempt,
            body,
            { success: false, gates: [] },
            0,
            0,
            0,
            Date.now() - attemptStart
          )
        );
        continue;
      }

      // Parse the plan.
      const plan = parseAgentOutput(llmResult.text);
      if (!plan) {
        // agent_error this attempt — malformed output. Record and continue.
        metrics.attempts.push(
          buildAttemptRecord(
            attempt,
            body,
            { success: false, gates: [] },
            llmResult.inputTokens,
            llmResult.outputTokens,
            llmResult.estimatedCostUsd,
            Date.now() - attemptStart
          )
        );
        continue;
      }

      // Empty-plan stall tracking (§6 raw loop has its own counter).
      if (!plan.edits || plan.edits.length === 0) {
        emptyPlanCount += 1;
        const emptyResult: VerifyResult = {
          success: false,
          gates: [],
          attestation: 'RAW: empty plan',
          timing: { totalMs: 0, perGate: {} },
        };
        priorResult = emptyResult;
        metrics.attempts.push(
          buildAttemptRecord(
            attempt,
            body,
            { success: false, gates: [] },
            llmResult.inputTokens,
            llmResult.outputTokens,
            llmResult.estimatedCostUsd,
            Date.now() - attemptStart
          )
        );
        allAttemptsErrored = false;
        if (emptyPlanCount >= 3) {
          stopReason = 'empty_plan_stall';
          finalGatesFailed = [];
          break;
        }
        continue;
      } else {
        emptyPlanCount = 0;
      }
      allAttemptsErrored = false;

      // Run verify() against the staged appDir.
      const verifyResult: VerifyResult = await verify(plan.edits, plan.predicates, {
        appDir: staged.appDir,
        goal: caseRecord.goal,
        stateDir: staged.stateDir,
        gates: params.gates,
        learning: 'session',
      });

      priorResult = verifyResult;

      metrics.attempts.push(
        buildAttemptRecord(
          attempt,
          body,
          verifyResult,
          llmResult.inputTokens,
          llmResult.outputTokens,
          llmResult.estimatedCostUsd,
          Date.now() - attemptStart
        )
      );

      if (verifyResult.success) {
        converged = true;
        stopReason = 'converged';
        finalGatesFailed = [];
        break;
      }
    }

    if (!converged && stopReason === 'agent_error' && !allAttemptsErrored) {
      // At least one attempt produced a parseable plan but nothing converged.
      stopReason = 'exhausted';
      finalGatesFailed =
        priorResult?.gates.filter((g) => g.passed === false).map((g) => g.gate) ?? [];
    } else if (converged) {
      // Already set above.
    } else if (allAttemptsErrored) {
      // Every attempt errored → stop_reason agent_error is correct.
      finalGatesFailed = [];
    }
  } finally {
    staged.cleanup();
  }

  finalizeRunMetrics(metrics, stopReason, Date.now() - runStart, finalGatesFailed, converged);
  return metrics;
}

// =============================================================================
// GOVERNED LOOP — govern(), §4 renderer
// =============================================================================

async function runGovernedCase(params: RunCaseParams): Promise<RunMetrics> {
  const { caseRecord, run_idx, fixtureAppDir, tracker } = params;
  const metrics = createRunMetrics(
    caseRecord.case_id,
    'governed',
    run_idx,
    caseRecord.scanner_sha,
    caseRecord.extractor_sha
  );
  const runStart = Date.now();

  const staged = stageRun(fixtureAppDir, caseRecord.case_id, 'governed', run_idx);

  // Amendment 6: build the APP FILES manifest once per run, after
  // stageRun but before the govern() call. The agent adapter closure
  // captures this manifest and passes it to renderGovernedRetryContext
  // on every attempt (byte-identical across attempts within a run,
  // and byte-identical to the raw loop's manifest for the same case).
  const appManifest = formatAppManifest(buildAppManifest(staged.appDir));

  // Build the agent adapter. govern() calls plan(goal, context) each
  // attempt. Our adapter:
  //   1. Renders the §4 retry context from GovernContext
  //   2. Combines with the §2 system prompt
  //   3. Calls the LLM via callLLMWithTracking (same as raw)
  //   4. Parses the output into an AgentPlan
  //   5. Captures narrowing samples for §17
  //   6. Returns the plan; govern() handles verify/narrowing/convergence
  const agent: GovernAgent = {
    async plan(goal: string, context: GovernContext): Promise<AgentPlan> {
      const attemptStart = Date.now();
      const body = renderGovernedRetryContext(goal, context, MAX_ATTEMPTS, appManifest);
      const fullPrompt = combinePrompt(body);

      // §17 narrowing sample capture: on attempts ≥ 2 (where narrowing
      // exists), record the NARROWING block content alongside a summary
      // of the verify failure that produced it.
      if (context.attempt >= 2 && context.narrowing) {
        const narrowingContent = formatNarrowing(context.narrowing);
        const failureSummary = context.priorResult
          ? context.priorResult.gates
              .filter((g) => g.passed === false)
              .map((g) => `[${g.gate}] ${(g.detail ?? '').slice(0, 200)}`)
              .join('; ')
          : '';
        metrics.narrowing_samples.push({
          attempt: context.attempt,
          narrowing_content: narrowingContent,
          verify_failure_summary: failureSummary,
        });
      }

      let llmResult;
      try {
        llmResult = await callLLMWithTracking(fullPrompt, tracker, {
          callLLMImpl: params.callLLMImpl,
          apiKey: params.apiKey,
          provider: params.provider,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('§22 hard cap') || msg.includes('INPUT_API_KEY not set')) {
          throw err;
        }
        // Record an error attempt and return empty plan; govern() will
        // surface this as empty_plan_stall after 3 consecutive hits.
        metrics.attempts.push(
          buildAttemptRecord(
            context.attempt,
            body,
            { success: false, gates: [] },
            0,
            0,
            0,
            Date.now() - attemptStart
          )
        );
        return { edits: [], predicates: [] };
      }

      const parsed = parseAgentOutput(llmResult.text);
      // We DON'T know the verify result yet — govern() will run verify()
      // after plan() returns. Record the attempt-level token/cost/duration
      // now; the verify result is not stored per-attempt for the
      // governed loop (govern() exposes only the final result). This is
      // an acceptable compromise: raw loop captures per-attempt verify
      // results because it owns the loop; governed loop delegates to
      // govern() which only surfaces the final VerifyResult via history.
      // The governed metrics still capture per-attempt tokens and time.
      metrics.attempts.push(
        buildAttemptRecord(
          context.attempt,
          body,
          { success: false, gates: [] }, // placeholder — final result comes from govern()
          llmResult.inputTokens,
          llmResult.outputTokens,
          llmResult.estimatedCostUsd,
          Date.now() - attemptStart
        )
      );

      return parsed ?? { edits: [], predicates: [] };
    },
  };

  let stopReason: StopReason = 'agent_error';
  let finalGatesFailed: string[] = [];
  let converged = false;

  try {
    const govResult = await govern({
      appDir: staged.appDir,
      goal: caseRecord.goal,
      agent,
      maxAttempts: MAX_ATTEMPTS,
      stateDir: staged.stateDir,
      gates: params.gates,
    });

    stopReason = govResult.stopReason;
    converged = govResult.success;
    finalGatesFailed = govResult.finalResult.gates
      .filter((g) => g.passed === false)
      .map((g) => g.gate);

    // Patch the last attempt record with the final verify result, so
    // governed runs have at least one accurate verify result in the
    // attempts trail.
    if (metrics.attempts.length > 0 && govResult.finalResult) {
      const lastIdx = metrics.attempts.length - 1;
      metrics.attempts[lastIdx]!.verifyResult = {
        success: govResult.finalResult.success,
        gatesFailed: govResult.finalResult.gates
          .filter((g) => g.passed === false)
          .map((g) => g.gate),
        failureDetails: govResult.finalResult.gates
          .filter((g) => g.passed === false)
          .map((g) => (g.detail ?? '').slice(0, 300)),
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('§22 hard cap') || msg.includes('INPUT_API_KEY not set')) {
      staged.cleanup();
      throw err;
    }
    // Harness error during govern() — treat as agent_error and let the
    // metrics record the partial attempts.
    stopReason = 'agent_error';
  } finally {
    staged.cleanup();
  }

  finalizeRunMetrics(metrics, stopReason, Date.now() - runStart, finalGatesFailed, converged);
  return metrics;
}

// =============================================================================
// PUBLIC ENTRY POINT
// =============================================================================

/**
 * Execute a single run and return its metrics.
 *
 * Invariants:
 *   - Never throws on agent error. agent_error is a stop_reason, not an exception.
 *   - Throws on harness error (stateDir wipe failure, budget cap exceeded, missing env).
 *   - Cleanup always runs (finally block).
 */
export async function runCase(params: RunCaseParams): Promise<RunMetrics> {
  if (params.loop === 'raw') {
    return runRawCase(params);
  }
  return runGovernedCase(params);
}
