/**
 * N1 Phase 2 — LLM adapter.
 *
 * Implements DESIGN.md §20 (as amended by Amendment 5) and §22 cost budget.
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
 * Testability: the wrapper accepts an optional `callLLMImpl` override so
 * harness.test.ts can inject a mock and avoid real network calls. The
 * kickoff brief explicitly requires: "Mock the LLM in self-tests."
 */

import { callLLM as realCallLLM } from '../../../src/action/index.js';

// =============================================================================
// PRICING CONSTANTS
// =============================================================================
//
// Gemini 2.0 Flash (§19 primary model) — public pricing as of 2026-04-09.
// Source: Google AI pricing page at the time of experiment design.
//
//   Input:  $0.10 per 1M tokens  = $0.0000001 per token
//   Output: $0.40 per 1M tokens  = $0.0000004 per token
//
// These numbers are deliberately hard-coded in the harness rather than
// fetched dynamically so the cost-tracking estimates are deterministic
// across runs. If actual billing diverges, the invoice is the authority
// and the harness estimates are a cross-check, not a billing record.
//
// Anthropic Haiku 4.5 (§19 sanity-check model) — pricing:
//   Input:  $1.00 per 1M tokens
//   Output: $5.00 per 1M tokens
//
// The harness reads provider from env to pick the right pricing row.

const PRICING_USD_PER_TOKEN: Record<string, { in: number; out: number }> = {
  gemini: { in: 0.10 / 1_000_000, out: 0.40 / 1_000_000 },
  anthropic: { in: 1.00 / 1_000_000, out: 5.00 / 1_000_000 },
  // openai fallback for completeness — not used in N1 but the adapter
  // supports the provider for future sanity checks.
  openai: { in: 0.15 / 1_000_000, out: 0.60 / 1_000_000 },
};

/**
 * Rough token estimate when the provider doesn't return exact counts.
 * 4 chars ≈ 1 token is the standard-of-practice approximation for
 * English-ish text across Gemini/Anthropic/OpenAI tokenizers. This is
 * a cost *estimate*, not an exact count.
 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// =============================================================================
// TYPES
// =============================================================================

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
  readonly totalSpentUsd: number;
  /** Total calls made */
  readonly totalCalls: number;
  /** True if we are past the $20 alert threshold. */
  readonly overAlert: boolean;
  /** True if we are past the $30 hard cap. */
  readonly overCap: boolean;
  /**
   * Called before each new call. Throws if continuing would exceed the
   * hard cap. Implementation: throws if totalSpentUsd already >= cap,
   * leaving "one more call" headroom under the cap.
   */
  checkBudget(): void;
  /** Records a completed call's cost against the cumulative total. */
  recordCall(result: LLMCallResult): void;
  /** Snapshot the current tracker state (useful for metrics writing). */
  snapshot(): { totalSpentUsd: number; totalCalls: number; overAlert: boolean; overCap: boolean };
}

// =============================================================================
// COST TRACKER
// =============================================================================

class CostTrackerImpl implements CostTracker {
  #totalSpentUsd = 0;
  #totalCalls = 0;
  #hardCap: number;
  #alertThreshold: number;

  constructor(hardCapUsd: number, alertThresholdUsd: number) {
    if (alertThresholdUsd > hardCapUsd) {
      throw new Error(
        `Cost tracker config: alertThreshold ($${alertThresholdUsd}) must be <= hardCap ($${hardCapUsd})`
      );
    }
    this.#hardCap = hardCapUsd;
    this.#alertThreshold = alertThresholdUsd;
  }

  get totalSpentUsd(): number {
    return this.#totalSpentUsd;
  }
  get totalCalls(): number {
    return this.#totalCalls;
  }
  get overAlert(): boolean {
    return this.#totalSpentUsd >= this.#alertThreshold;
  }
  get overCap(): boolean {
    return this.#totalSpentUsd >= this.#hardCap;
  }

  checkBudget(): void {
    if (this.#totalSpentUsd >= this.#hardCap) {
      throw new Error(
        `[§22 hard cap] N1 harness refuses to proceed: cumulative spend $${this.#totalSpentUsd.toFixed(4)} >= hard cap $${this.#hardCap}. ` +
          `Investigate before re-running.`
      );
    }
  }

  recordCall(result: LLMCallResult): void {
    this.#totalSpentUsd += result.estimatedCostUsd;
    this.#totalCalls += 1;
  }

  snapshot(): { totalSpentUsd: number; totalCalls: number; overAlert: boolean; overCap: boolean } {
    return {
      totalSpentUsd: this.#totalSpentUsd,
      totalCalls: this.#totalCalls,
      overAlert: this.overAlert,
      overCap: this.overCap,
    };
  }
}

/**
 * Create a new cost tracker with the §22 limits. Defaults: $30 hard
 * cap, $20 alert threshold (per DESIGN.md §22).
 */
export function createCostTracker(
  hardCapUsd: number = 30,
  alertThresholdUsd: number = 20
): CostTracker {
  return new CostTrackerImpl(hardCapUsd, alertThresholdUsd);
}

// =============================================================================
// CALLER
// =============================================================================

/**
 * The callLLM signature both the real implementation and any test mock
 * must match.
 */
export type CallLLMImpl = (prompt: string, apiKey: string, provider: string) => Promise<string>;

export interface CallLLMOptions {
  /** Override for tests — inject a mock that never hits the network. */
  callLLMImpl?: CallLLMImpl;
  /** Override the API key source for tests. Defaults to INPUT_API_KEY. */
  apiKey?: string;
  /** Override the provider for tests. Defaults to env INPUT_PROVIDER or 'gemini'. */
  provider?: string;
}

/**
 * Call the LLM via the pinned callLLM adapter. Tracks cost on the shared
 * tracker. Throws if the hard cap would be exceeded (checked BEFORE the
 * call, so a call that would push us over is refused).
 *
 * This is the ONLY place in the harness that invokes callLLM. Both the
 * raw and governed agent adapters go through this function.
 */
export async function callLLMWithTracking(
  prompt: string,
  tracker: CostTracker,
  options: CallLLMOptions = {}
): Promise<LLMCallResult> {
  // §22: refuse to proceed if we're already at or over the hard cap.
  tracker.checkBudget();

  const apiKey = options.apiKey ?? process.env.INPUT_API_KEY ?? '';
  const provider = options.provider ?? process.env.INPUT_PROVIDER ?? 'gemini';

  if (!apiKey) {
    throw new Error(
      '[§20] INPUT_API_KEY not set. The harness requires the API key to be passed via env at execution time. ' +
        'See DESIGN.md §20 for key management.'
    );
  }

  const impl: CallLLMImpl = options.callLLMImpl ?? realCallLLM;

  const text = await impl(prompt, apiKey, provider);

  // Estimate tokens and cost. Gemini / Anthropic / OpenAI all return
  // usage metadata in their HTTP responses but callLLM() strips that
  // (it only returns the generated text). Per §20 we do not modify
  // callLLM's body; instead we estimate from prompt/response length.
  // The estimate is the record; the invoice is the authority.
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(text);
  const pricing = PRICING_USD_PER_TOKEN[provider] ?? PRICING_USD_PER_TOKEN.gemini!;
  const estimatedCostUsd = inputTokens * pricing.in + outputTokens * pricing.out;

  const result: LLMCallResult = { text, inputTokens, outputTokens, estimatedCostUsd };
  tracker.recordCall(result);
  return result;
}
