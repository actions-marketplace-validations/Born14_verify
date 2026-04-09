/**
 * Bundled default composition of all four extraction tiers.
 *
 * This facade exists for callers that want "give me every predicate you can
 * derive from these edits" with default behavior. It is NOT used by the two
 * current callers in this repo:
 *
 *   - src/action/index.ts needs conditional tier composition (Tier 2 try/catch,
 *     Tier 3 intent/LLM flags, per-tier naming for comment formatting) and
 *     calls each tier function directly.
 *
 *   - scripts/scan/level2-scanner.ts needs only static-heuristic extraction
 *     and calls tier4Static directly.
 *
 * Future callers (runtime governance, benchmark harnesses, etc.) can use this
 * facade if their composition needs match the default, or import individual
 * tier functions for finer control. No tier depends on any other tier; they
 * compose only here.
 *
 * Design: the facade is deliberately dumb. It does not know about PRContext
 * validation, filesystem-error recovery, absent-predicate filtering, or any
 * other caller-specific concern. Callers that need those behaviors compose
 * tiers themselves. If a composition pattern emerges across two or more real
 * callers, it can be lifted into a helper here — not before.
 *
 * Open architectural gaps for this module: see ./GAPS.md
 * Filed during the unified extractor consolidation, 2026-04-09.
 */

import type { Edit, Predicate } from '../types.js';
import { tier1Diff } from './tier1-diff.js';
import { tier2Context } from './tier2-context.js';
import { tier3Intent, type PRContext } from './tier3-intent.js';
import { tier4Static } from './tier4-static.js';

// Re-export individual tier functions so callers can import them from one place
export { tier1Diff } from './tier1-diff.js';
export { tier2Context } from './tier2-context.js';
export { tier3Intent, type PRContext } from './tier3-intent.js';
export { tier4Static } from './tier4-static.js';
export { emitSecurityPredicates } from './shared/security.js';

/**
 * Optional context the facade can forward to tiers that accept it.
 * Minimal by design — only fields the tier functions actually consume.
 */
export interface ExtractionContext {
  /** Files that exist in the repo before the PR — consumed by tier2Context */
  existingFiles?: string[];
  /** PR metadata — consumed by tier3Intent */
  prContext?: PRContext;
}

/**
 * Default composition: run all four tiers and return the combined predicate
 * set. Callers that need conditional tier runs, per-tier error handling, or
 * post-processing (e.g., absent-predicate filtering) should import the tier
 * functions directly instead of using this facade.
 */
export function extractPredicates(edits: Edit[], context?: ExtractionContext): Predicate[] {
  const predicates: Predicate[] = [];

  // Tier 1: deterministic from diff
  predicates.push(...tier1Diff(edits));

  // Tier 2: cross-file context (only if existingFiles provided)
  if (context?.existingFiles && context.existingFiles.length > 0) {
    predicates.push(...tier2Context(edits, context.existingFiles));
  }

  // Tier 3: PR intent (only if prContext provided)
  if (context?.prContext) {
    predicates.push(...tier3Intent(edits, context.prContext));
  }

  // Tier 4: static heuristic from file extensions
  predicates.push(...tier4Static(edits));

  return predicates;
}
