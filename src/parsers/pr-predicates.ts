/**
 * PR Predicate Extractor
 * =======================
 *
 * Generates predicates from PR data without an LLM.
 * Three tiers:
 *   Tier 1: Deterministic from diff (what was added/removed)
 *   Tier 2: Structural from repo context (cross-file consistency)
 *   Tier 3: Intent from PR metadata (title, description, linked issue)
 *
 * Tier 1 is always available. Tier 2 needs repo access. Tier 3 needs
 * either heuristics or an LLM.
 */

import type { Edit, Predicate } from '../types.js';

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

/**
 * Tier 1: Extract predicates directly from edits (deterministic, zero LLM).
 *
 * For each edit, generates predicates that assert the post-edit state
 * matches what the diff claims. Catches:
 *   - Edit doesn't apply (F9 catches this too, but predicates make it explicit)
 *   - Added content should exist post-edit
 *   - Removed content should NOT exist post-edit
 *   - New files should exist, deleted files should be absent
 */
export function extractDiffPredicates(edits: Edit[]): Predicate[] {
  const predicates: Predicate[] = [];

  for (const edit of edits) {
    // New file: search is empty, replace has content
    if (!edit.search && edit.replace) {
      predicates.push({
        type: 'filesystem_exists' as any,
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
        type: 'filesystem_absent' as any,
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

  // Auto-generate security predicates for code files
  // This ensures the security gate always scans edited code files
  const codeExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.php']);
  const codeFiles = [...new Set(edits.map(e => e.file))].filter(f => codeExts.has('.' + f.split('.').pop()));
  if (codeFiles.length > 0) {
    // Add a broad security scan predicate — the gate will scan all files
    predicates.push({
      type: 'security' as any,
      securityCheck: 'secrets_in_code',
      expected: 'no_findings',
      description: 'Auto-scan: no hardcoded secrets in edited code files',
    } as any);
    predicates.push({
      type: 'security' as any,
      securityCheck: 'xss',
      expected: 'no_findings',
      description: 'Auto-scan: no XSS patterns in edited code files',
    } as any);
    predicates.push({
      type: 'security' as any,
      securityCheck: 'sql_injection',
      expected: 'no_findings',
      description: 'Auto-scan: no SQL injection patterns in edited code files',
    } as any);
  }

  return predicates;
}

/**
 * Tier 2: Extract predicates from cross-file relationships.
 *
 * Checks that edits in one file don't leave other files stale.
 * Requires knowing what files exist in the repo.
 */
export function extractCrossFilePredicates(edits: Edit[], existingFiles?: string[]): Predicate[] {
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

/**
 * Tier 3: Extract predicates from PR metadata (title, description).
 *
 * Heuristic extraction — no LLM. Looks for quoted values, code references,
 * and common patterns in PR titles and descriptions.
 */
export function extractIntentPredicates(edits: Edit[], context: PRContext): Predicate[] {
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

// =============================================================================
// HELPERS
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

/**
 * Heuristic: does `removedStr` look like something `otherFile` might reference?
 */
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
