/**
 * N1 Phase 2.5 — APP FILES manifest builder (Amendment 6).
 *
 * Implements DESIGN.md §2 "Codebase visibility" (added by Amendment 6)
 * and Amendment 6 Change 5 bullet 1.
 *
 * Two functions:
 *
 *   buildAppManifest(appDir) → string[]
 *     Reads the staged app directory recursively. Returns a sorted array
 *     of POSIX-style relative paths (forward slashes on every platform),
 *     excluding any path where any path segment (after splitting on "/")
 *     begins with ".". This is the path-segment exclusion rule from
 *     Amendment 6 Change 1. It catches state directories (.verify/,
 *     .verify-k5-*), environment files (.env*), and deliberately-hidden
 *     fixture files (test-data/.hidden) in a single uniform rule.
 *
 *   formatAppManifest(files) → string
 *     Formats the sorted array as:
 *       APP FILES:
 *       <path1>
 *       <path2>
 *       ...
 *       <pathN>
 *       <blank line>
 *     The trailing blank line separates the manifest from the §3 or §4
 *     retry template body that follows.
 *
 * Invariants (Amendment 6 Change 5):
 *   - buildAppManifest is DETERMINISTIC. Identical input directory →
 *     identical output array. No Date.now(), no Math.random(), no
 *     environment reads.
 *   - Reads ONLY directory structure. Never reads file contents. The
 *     agent discovers contents through the existing §3 retry template's
 *     gate failure detail on attempt N ≥ 2.
 *   - Sort order is lexicographic on POSIX relative paths, producing a
 *     stable ordering that does not depend on filesystem enumeration
 *     order or platform.
 *
 * Ground-truth reference (verified 2026-04-10 against fixtures/demo-app/):
 * the 19-file post-exclusion manifest for fixtures/demo-app/ is exactly
 * the list in DESIGN.md Amendment 6 Change 6 (the §3 worked example).
 * See the hermetic test in harness.test.ts that asserts this verbatim.
 */

import { readdirSync, statSync } from 'fs';
import { join, sep as pathSep } from 'path';

/**
 * Return true if any path segment begins with ".".
 * Path segments are computed by splitting on BOTH forward slash and the
 * platform's native separator, so this works on Windows and POSIX.
 */
function hasDotfileSegment(relPath: string): boolean {
  // Normalize to forward slashes for the segment check.
  const posix = relPath.split(pathSep).join('/');
  const segments = posix.split('/');
  for (const seg of segments) {
    if (seg.length > 0 && seg.startsWith('.')) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively walk a directory and collect all file paths relative to the
 * given root. Applies the path-segment exclusion rule at every level to
 * skip entire subtrees whose directory names begin with ".".
 *
 * Pruning at the directory level (rather than filtering only at the file
 * level) is an optimization: a large .git directory or .verify state dir
 * is not traversed at all, avoiding wasted stat() calls.
 */
function walk(root: string, relPrefix: string = ''): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(root, relPrefix));
  } catch {
    return out;
  }

  // Sort at each directory level so the final output is deterministic
  // regardless of filesystem enumeration order.
  entries.sort();

  for (const name of entries) {
    // Prune dotfile directories/files at the segment level. This check
    // is redundant with the final hasDotfileSegment filter below, but
    // doing it here skips the stat() call and recursion into excluded
    // subtrees.
    if (name.startsWith('.')) {
      continue;
    }

    const entryRel = relPrefix ? `${relPrefix}/${name}` : name;
    const absPath = join(root, entryRel);

    let st;
    try {
      st = statSync(absPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      out.push(...walk(root, entryRel));
    } else if (st.isFile()) {
      // Defense in depth: run the full path-segment check even though
      // we pruned dotfile directories above. This catches any file
      // whose parent directory structure somehow contained a dotfile
      // segment we missed (shouldn't happen, but the invariant is:
      // "no output path contains a dotfile segment").
      if (!hasDotfileSegment(entryRel)) {
        out.push(entryRel);
      }
    }
  }

  return out;
}

/**
 * Build the app manifest for a given directory.
 *
 * Returns a sorted array of POSIX-style relative paths, with any path
 * excluded if any of its segments begins with ".".
 *
 * Example output for fixtures/demo-app/ (ground truth, 2026-04-10):
 *   [
 *     "Dockerfile",
 *     "config.json",
 *     "config.prod.json",
 *     ...
 *     "test-data/valid.json",
 *   ]
 */
export function buildAppManifest(appDir: string): string[] {
  const files = walk(appDir, '');
  // Top-level sort is already applied by per-directory sorting during
  // walk, but explicit sort here is a belt-and-suspenders guarantee of
  // total ordering across platforms.
  files.sort();
  return files;
}

/**
 * Format a manifest array as the APP FILES: block that prepends to
 * every prompt body per Amendment 6 Change 1.
 *
 * Output format (with trailing blank line so the manifest owns the
 * separator — callers concatenate directly without adding newlines):
 *
 *   APP FILES:\n
 *   <path1>\n
 *   <path2>\n
 *   ...\n
 *   <pathN>\n
 *   \n                       ← blank line, owned by the manifest
 *
 * That is: the string ends with exactly two newlines. The last path is
 * followed by \n, and then an empty line is inserted before whatever
 * the caller concatenates next.
 *
 * On attempt 1 a caller does:
 *   `${formatAppManifest(files)}GOAL: ${goal}`
 * producing:
 *   APP FILES:
 *   <p1>
 *   ...
 *   <pN>
 *   <blank>
 *   GOAL: <goal>
 *
 * Empty manifest safety: if files is [], the output is "APP FILES:\n\n"
 * which still correctly separates an empty manifest from the next
 * section. Callers receive a well-formed block regardless.
 */
export function formatAppManifest(files: string[]): string {
  return ['APP FILES:', ...files, '', ''].join('\n');
}
