/**
 * Shared Utilities for the Improve Loop
 * =======================================
 *
 * Pure functions shared across improve-*.ts modules:
 * - extractJSON: robust LLM response parsing
 * - hashEdits: deterministic fix candidate hashing
 * - callLLMWithRetry: retry wrapper for LLM API calls
 */

import { createHash } from 'crypto';
import type { ProposedEdit, LLMCallFn, LLMUsage } from './types.js';

// =============================================================================
// EXTRACT JSON — robust parsing of LLM responses
// =============================================================================

/**
 * Extract JSON from an LLM response that may include markdown fences,
 * commentary, or other wrapping. Tries multiple strategies:
 * 1. Direct JSON.parse (fast path)
 * 2. Strip markdown fences and retry
 * 3. Extract first [...] or {...} block via brace/bracket matching
 */
export function extractJSON<T = unknown>(raw: string): T | null {
  if (!raw || !raw.trim()) return null;

  // Strategy 1: direct parse
  try {
    return JSON.parse(raw) as T;
  } catch { /* continue */ }

  // Strategy 2: strip markdown fences
  const fenceStripped = raw
    .replace(/^```(?:json|typescript|ts|javascript|js)?\s*\n?/gm, '')
    .replace(/^```\s*$/gm, '')
    .trim();
  if (fenceStripped !== raw) {
    try {
      return JSON.parse(fenceStripped) as T;
    } catch { /* continue */ }
  }

  // Strategy 3: extract first JSON block via brace/bracket matching
  const firstBracket = raw.indexOf('[');
  const firstBrace = raw.indexOf('{');
  let startIdx: number;
  let openChar: string;
  let closeChar: string;

  if (firstBracket === -1 && firstBrace === -1) return null;
  if (firstBracket === -1) {
    startIdx = firstBrace; openChar = '{'; closeChar = '}';
  } else if (firstBrace === -1) {
    startIdx = firstBracket; openChar = '['; closeChar = ']';
  } else {
    // Use whichever comes first
    if (firstBracket < firstBrace) {
      startIdx = firstBracket; openChar = '['; closeChar = ']';
    } else {
      startIdx = firstBrace; openChar = '{'; closeChar = '}';
    }
  }

  // Find matching close by counting depth
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const block = raw.substring(startIdx, i + 1);
        try {
          return JSON.parse(block) as T;
        } catch { return null; }
      }
    }
  }

  // Strategy 4: truncated array recovery — find last complete object, close the array
  const arrayStart = raw.indexOf('[');
  if (arrayStart !== -1) {
    // Find all complete top-level objects in the array
    let depth = 0;
    let inStr = false;
    let esc = false;
    let lastObjEnd = -1;
    for (let i = arrayStart + 1; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) lastObjEnd = i;
      }
    }
    if (lastObjEnd > arrayStart) {
      const recovered = raw.substring(arrayStart, lastObjEnd + 1) + ']';
      try {
        return JSON.parse(recovered) as T;
      } catch { /* continue */ }
    }
  }

  return null;
}

// =============================================================================
// HASH EDITS — deterministic candidate deduplication
// =============================================================================

/**
 * Deterministic hash of a fix candidate's edits for deduplication.
 * Sorted by file+search to be order-independent.
 */
export function hashEdits(edits: ProposedEdit[]): string {
  const normalized = edits
    .map(e => `${e.file}::${e.line ?? e.search}::${e.replace}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

// =============================================================================
// LLM CALL WITH RETRY — graceful error handling
// =============================================================================

/**
 * Wraps an LLM call with retry logic for transient failures.
 * - 429 rate limit: wait retry-after or 60s, retry up to 3 times
 * - timeout/network: retry once after 5s
 * - other errors: return null (caller handles gracefully)
 */
export async function callLLMWithRetry(
  callLLM: LLMCallFn,
  systemPrompt: string,
  userPrompt: string,
  usage: LLMUsage,
  maxRetries: number = 3,
): Promise<{ text: string; inputTokens: number; outputTokens: number } | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await callLLM(systemPrompt, userPrompt);
      usage.inputTokens += result.inputTokens;
      usage.outputTokens += result.outputTokens;
      usage.calls++;
      return result;
    } catch (err: any) {
      lastError = err;
      const message = err?.message ?? String(err);
      const status = err?.status ?? err?.statusCode ?? 0;

      // Rate limit (429)
      if (status === 429 || message.includes('429') || message.toLowerCase().includes('rate limit')) {
        const retryAfter = err?.headers?.['retry-after']
          ? parseInt(err.headers['retry-after'], 10) * 1000
          : 60_000;
        if (attempt < maxRetries) {
          console.log(`        [LLM] Rate limited — waiting ${Math.round(retryAfter / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(retryAfter);
          continue;
        }
      }

      // Timeout / network errors — retry once after 5s
      if (message.includes('timeout') || message.includes('ECONNREFUSED') ||
          message.includes('ETIMEDOUT') || message.includes('fetch failed') ||
          message.includes('network')) {
        if (attempt === 0) {
          console.log(`        [LLM] Network error — retrying in 5s (${message.substring(0, 80)})`);
          await sleep(5_000);
          continue;
        }
      }

      // Other errors — don't retry
      console.log(`        [LLM] Error: ${message.substring(0, 120)}`);
      break;
    }
  }

  console.log(`        [LLM] All retries exhausted — skipping this LLM call`);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
