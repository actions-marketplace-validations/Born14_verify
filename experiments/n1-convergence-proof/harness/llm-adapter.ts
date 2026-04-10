/**
 * N1 Phase 2 — LLM adapter.
 *
 * Implements DESIGN.md §20 (as amended by Amendment 5).
 *
 * Thin wrapper over callLLM() from src/action/index.ts. Reused verbatim
 * per §20 — the raw and governed loops both call the SAME callLLM,
 * eliminating any adapter-level confound between loops.
 *
 * Per Amendment 5: callLLM is exported from src/action/index.ts. Importing
 * does not trigger run() (guarded by `if (import.meta.main)`). Any change
 * to callLLM's body, signature, or behavior is a production change that
 * affects both the action entry point and the N1 harness — this is the
 * intended coupling.
 *
 * This wrapper's ONLY responsibilities:
 *
 *   1. Read INPUT_API_KEY and provider from env (§20).
 *   2. Call callLLM(prompt, apiKey, provider) and return its output verbatim.
 *   3. Track cost per call (§22): tokens in, tokens out, estimated $.
 *   4. Enforce the $30 hard cap and $20 alert threshold (§22).
 *
 * What this wrapper DOES NOT do (these would be reimplementation and
 * violate §20 as amended):
 *
 *   - Modify the prompt before calling callLLM
 *   - Modify the response before returning it
 *   - Implement its own HTTP logic
 *   - Implement its own provider switch
 *   - Implement its own retry/backoff inside a single call
 *   - Parse the response as JSON (that's the agent adapter's job)
 *
 * Scaffold status: skeleton. Body implemented in deliverable 5.
 */

export interface LLMCallResult {
  /** The raw text returned by callLLM */
  text: string;
  /** Estimated input tokens (rough, based on prompt length) */
  inputTokens: number;
  /** Estimated output tokens (rough, based on response length) */
  outputTokens: number;
  /** Estimated cost in USD for this call */
  estimatedCostUsd: number;
}

export interface CostTracker {
  /** Cumulative USD spent across all calls so far */
  totalSpentUsd: number;
  /** Total calls made */
  totalCalls: number;
  /** Called before each new call. Throws if continuing would exceed the cap. */
  checkBudget: () => void;
  /** Records a completed call's cost. */
  recordCall: (result: LLMCallResult) => void;
  /** True if we are past the $20 alert threshold. */
  overAlert: boolean;
}

/**
 * Create a new cost tracker with the §22 limits.
 */
export function createCostTracker(
  hardCapUsd: number = 30,
  alertThresholdUsd: number = 20
): CostTracker {
  void hardCapUsd; void alertThresholdUsd;
  throw new Error('NOT_IMPLEMENTED: llm-adapter deliverable 5');
}

/**
 * Call the LLM via the pinned callLLM adapter. Tracks cost on the shared
 * tracker. Throws if the hard cap would be exceeded.
 */
export async function callLLMWithTracking(
  prompt: string,
  tracker: CostTracker
): Promise<LLMCallResult> {
  void prompt; void tracker;
  throw new Error('NOT_IMPLEMENTED: llm-adapter deliverable 5');
}
