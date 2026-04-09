/**
 * Tier 3: Intent-based predicate extraction from PR metadata.
 *
 * Heuristic extraction — no LLM. Looks for quoted values, code references,
 * and common patterns in PR titles and descriptions. The LLM-based Tier 3b
 * extractor lives in src/action/index.ts and is intentionally NOT part of
 * this module — LLM extraction has different tradeoffs, different scope,
 * and different callers.
 *
 * Moved verbatim from src/parsers/pr-predicates.ts as part of the extractor
 * consolidation. Renamed from extractIntentPredicates to tier3Intent.
 */

import type { Edit, Predicate } from '../types.js';

/**
 * PR metadata that Tier 3 can draw predicates from. All fields optional —
 * the extractor works with whatever subset the caller supplies.
 */
export interface PRContext {
  /** PR title */
  title?: string;
  /** PR description/body */
  description?: string;
  /** Linked issue title */
  issueTitle?: string;
  /** Commit messages */
  commitMessages?: string[];
  /** Files that exist in the repo before the PR */
  existingFiles?: string[];
}

export function tier3Intent(edits: Edit[], context: PRContext): Predicate[] {
  const predicates: Predicate[] = [];
  const allText = [context.title, context.description, context.issueTitle, ...(context.commitMessages ?? [])].filter(Boolean).join(' ');
  if (!allText) return predicates;

  // Extract quoted strings from PR text — these are often the specific values
  const quoted = allText.match(/[`'"]([\w.#-]{3,40})[`'"]/g) ?? [];
  for (const q of quoted) {
    const value = q.slice(1, -1);
    // Find which edit file this likely refers to
    const targetEdit = edits.find(e => e.replace?.includes(value) || e.search?.includes(value));
    if (targetEdit) {
      predicates.push({
        type: 'content',
        file: targetEdit.file,
        pattern: value,
        description: `PR mentions "${value}" — should exist in ${targetEdit.file} post-edit`,
      });
    }
  }

  // Extract CSS utility classes (Tailwind-style: rounded-lg, text-center, bg-blue-500)
  const cssUtilities = allText.match(/\b[a-z][\w]*-[\w-]{1,30}\b/g) ?? [];
  for (const cls of cssUtilities) {
    // Only if the class appears in an edit (confirms it's code-relevant, not prose)
    const targetEdit = edits.find(e => e.replace?.includes(cls) || e.search?.includes(cls));
    if (targetEdit) {
      predicates.push({
        type: 'content',
        file: targetEdit.file,
        pattern: cls,
        description: `PR mentions "${cls}" — should exist in ${targetEdit.file} post-edit`,
      });
    }
  }

  // Extract CSS selectors mentioned (.class-name, #id-name)
  const selectors = allText.match(/[.#][\w-]{2,30}/g) ?? [];
  for (const sel of selectors) {
    const targetEdit = edits.find(e => e.file.match(/\.(css|scss|less|tsx?|jsx?|html)$/));
    if (targetEdit) {
      predicates.push({
        type: 'content',
        file: targetEdit.file,
        pattern: sel,
        description: `PR references selector "${sel}" — should exist post-edit`,
      });
    }
  }

  // Extract route paths mentioned (/path, /api/something)
  const routes = allText.match(/\/[\w/-]{2,40}/g) ?? [];
  for (const route of routes) {
    if (route.startsWith('/api/') || route.startsWith('/health') || route.match(/^\/[\w-]+$/)) {
      const serverEdit = edits.find(e => e.file.match(/server|app|index|route/i));
      if (serverEdit) {
        predicates.push({
          type: 'content',
          file: serverEdit.file,
          pattern: route,
          description: `PR mentions route "${route}" — should exist in server post-edit`,
        });
      }
    }
  }

  return predicates;
}
