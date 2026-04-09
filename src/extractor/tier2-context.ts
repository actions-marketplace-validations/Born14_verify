/**
 * Tier 2: Cross-file context predicate extraction.
 *
 * Checks that edits in one file don't leave other files stale.
 * Requires knowing what files exist in the repo.
 *
 * Moved verbatim from src/parsers/pr-predicates.ts as part of the extractor
 * consolidation. Renamed from extractCrossFilePredicates to tier2Context.
 *
 * Tier-local copies of findUniqueSubstrings/extractTokens are kept in this
 * file rather than shared with tier1. The tier-independence discipline is
 * that no tier imports from another tier; if a shared helpers module is ever
 * justified by a second legitimate consumer outside tier1/tier2, that's a
 * future refactor, not this branch.
 */

import type { Edit, Predicate } from '../types.js';

export function tier2Context(edits: Edit[], existingFiles?: string[]): Predicate[] {
  const predicates: Predicate[] = [];
  if (!existingFiles || existingFiles.length === 0) return predicates;

  const editedFiles = new Set(edits.map(e => e.file));

  for (const edit of edits) {
    if (!edit.search || !edit.replace) continue;

    // Find identifiers that were renamed in this edit
    const removed = findUniqueSubstrings(edit.search, edit.replace);

    for (const removedStr of removed) {
      // Skip very short strings (common words, operators)
      if (removedStr.length < 4) continue;

      // Check if any OTHER files in the repo might reference this string
      // (we can't read them here, but we can flag the relationship)
      for (const otherFile of existingFiles) {
        if (editedFiles.has(otherFile)) continue; // already edited
        if (otherFile === edit.file) continue;

        // Heuristic: if the removed string looks like a route, class, function name,
        // or config key, and the other file is a related type, flag it
        if (looksLikeReference(removedStr, edit.file, otherFile)) {
          predicates.push({
            type: 'content',
            file: otherFile,
            pattern: removedStr,
            description: `"${removedStr.substring(0, 30)}" removed from ${edit.file} — check if ${otherFile} still references it`,
            expected: 'absent',
          });
        }
      }
    }
  }

  return predicates;
}

// =============================================================================
// HELPERS (tier2-local; not exported; deliberately duplicated from tier1-diff
// to preserve tier independence)
// =============================================================================

function findUniqueSubstrings(a: string, b: string): string[] {
  const results: string[] = [];
  const tokensA = extractTokens(a);
  const tokensB = new Set(extractTokens(b));

  for (const token of tokensA) {
    if (!tokensB.has(token) && token.length >= 3) {
      results.push(token);
    }
  }

  return [...new Set(results)];
}

function extractTokens(s: string): string[] {
  const tokens: string[] = [];

  const quoted = s.match(/['"`]([^'"`\n]{3,60})['"`]/g);
  if (quoted) tokens.push(...quoted.map(q => q.slice(1, -1)));

  const identifiers = s.match(/\b[a-zA-Z_][\w.-]{2,40}\b/g);
  if (identifiers) tokens.push(...identifiers);

  const selectors = s.match(/[.#][\w-]{2,30}/g);
  if (selectors) tokens.push(...selectors);

  const routes = s.match(/\/[\w/-]{2,40}/g);
  if (routes) tokens.push(...routes);

  const numbers = s.match(/\b\d{2,5}\b/g);
  if (numbers) tokens.push(...numbers);

  return tokens;
}

function looksLikeReference(removedStr: string, sourceFile: string, otherFile: string): boolean {
  // Route paths referenced across server/config/docker files
  if (removedStr.startsWith('/') && (
    otherFile.includes('docker') || otherFile.includes('config') ||
    otherFile.includes('.env') || otherFile.includes('server')
  )) return true;

  // Port numbers referenced across config files
  if (/^\d{4,5}$/.test(removedStr) && (
    otherFile.includes('docker') || otherFile.includes('config') ||
    otherFile.includes('.env') || otherFile.includes('Dockerfile')
  )) return true;

  // CSS class names across HTML/JSX files
  if (removedStr.startsWith('.') && (
    otherFile.match(/\.(html|jsx?|tsx?)$/)
  )) return true;

  return false;
}
