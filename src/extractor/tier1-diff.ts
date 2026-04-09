/**
 * Tier 1: Deterministic predicate extraction from edits (zero LLM).
 *
 * For each edit, generates predicates that assert the post-edit state
 * matches what the diff claims. Catches:
 *   - Edit doesn't apply (F9 catches this too, but predicates make it explicit)
 *   - Added content should exist post-edit
 *   - Removed content should NOT exist post-edit
 *   - New files should exist, deleted files should be absent
 *
 * Moved verbatim from src/parsers/pr-predicates.ts as part of the extractor
 * consolidation. Renamed from extractDiffPredicates to tier1Diff.
 */

import type { Edit, Predicate } from '../types.js';
import { emitSecurityPredicates } from './shared/security.js';

export function tier1Diff(edits: Edit[]): Predicate[] {
  const predicates: Predicate[] = [];

  for (const edit of edits) {
    // New file: search is empty, replace has content
    if (!edit.search && edit.replace) {
      predicates.push({
        type: 'filesystem_exists',
        file: edit.file,
        description: `New file "${edit.file}" should exist after edit`,
      });

      // Extract meaningful lines from the new file content (skip blank lines)
      const significantLines = edit.replace.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 10 && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('*'));

      if (significantLines.length > 0) {
        // Use the first significant line as a content assertion
        predicates.push({
          type: 'content',
          file: edit.file,
          pattern: significantLines[0],
          description: `New file should contain: "${significantLines[0].substring(0, 50)}"`,
        });
      }
      continue;
    }

    // Deleted file: search has content, replace is empty
    if (edit.search && !edit.replace) {
      predicates.push({
        type: 'filesystem_absent',
        file: edit.file,
        description: `Deleted file "${edit.file}" should not exist after edit`,
      });
      continue;
    }

    // Modified file: check what was added vs removed
    if (edit.search && edit.replace) {
      // Find strings unique to replace (added) and unique to search (removed)
      const added = findUniqueSubstrings(edit.replace, edit.search);
      const removed = findUniqueSubstrings(edit.search, edit.replace);

      // Post-edit: added content should exist
      for (const a of added.slice(0, 3)) { // cap at 3 per edit
        predicates.push({
          type: 'content',
          file: edit.file,
          pattern: a,
          description: `Edit adds "${a.substring(0, 40)}" — should exist post-edit`,
        });
      }

      // Post-edit: removed content should NOT exist (if the removal is significant)
      // We express this as a content predicate with the removed text — Shape 648
      // will catch if the text still exists when it shouldn't
      for (const r of removed.slice(0, 2)) { // cap at 2 per edit
        predicates.push({
          type: 'content',
          file: edit.file,
          pattern: r,
          description: `Edit removes "${r.substring(0, 40)}" — should be gone post-edit`,
          // Note: this predicate SHOULD FAIL if the pattern still exists.
          // The caller should set expectedSuccess=false or use expected='absent'
          expected: 'absent',
        });
      }
    }
  }

  // Auto-generate security predicates for code files.
  // Extension set is tier1-specific (Tier 4 uses a slightly different set) —
  // do not try to unify with tier4; the two sets are preserved exactly as
  // they were pre-refactor. Shared helper handles the three-predicate emission.
  const codeExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.php']);
  const codeFiles = [...new Set(edits.map(e => e.file))].filter(f => codeExts.has('.' + f.split('.').pop()));
  if (codeFiles.length > 0) {
    predicates.push(...emitSecurityPredicates({
      descriptions: {
        secrets_in_code: 'Auto-scan: no hardcoded secrets in edited code files',
        xss: 'Auto-scan: no XSS patterns in edited code files',
        sql_injection: 'Auto-scan: no SQL injection patterns in edited code files',
      },
    }));
  }

  return predicates;
}

// =============================================================================
// HELPERS (tier1-local; not exported)
// =============================================================================

/**
 * Find substrings unique to `a` that don't appear in `b`.
 * Returns meaningful tokens (identifiers, values, paths).
 */
function findUniqueSubstrings(a: string, b: string): string[] {
  const results: string[] = [];

  // Split into tokens and find ones unique to `a`
  const tokensA = extractTokens(a);
  const tokensB = new Set(extractTokens(b));

  for (const token of tokensA) {
    if (!tokensB.has(token) && token.length >= 3) {
      results.push(token);
    }
  }

  return [...new Set(results)];
}

/**
 * Extract meaningful tokens from a string.
 */
function extractTokens(s: string): string[] {
  const tokens: string[] = [];

  // Quoted strings
  const quoted = s.match(/['"`]([^'"`\n]{3,60})['"`]/g);
  if (quoted) tokens.push(...quoted.map(q => q.slice(1, -1)));

  // Identifiers (camelCase, snake_case, kebab-case, PascalCase)
  const identifiers = s.match(/\b[a-zA-Z_][\w.-]{2,40}\b/g);
  if (identifiers) tokens.push(...identifiers);

  // CSS selectors
  const selectors = s.match(/[.#][\w-]{2,30}/g);
  if (selectors) tokens.push(...selectors);

  // Route paths
  const routes = s.match(/\/[\w/-]{2,40}/g);
  if (routes) tokens.push(...routes);

  // Numbers with context (port numbers, sizes)
  const numbers = s.match(/\b\d{2,5}\b/g);
  if (numbers) tokens.push(...numbers);

  return tokens;
}
