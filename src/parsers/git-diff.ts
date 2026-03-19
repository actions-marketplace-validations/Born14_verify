/**
 * Git Diff Parser
 * ===============
 *
 * Converts unified diff output (git diff, git diff --cached, git show)
 * into Edit[] that verify() understands.
 *
 * Usage:
 *   const edits = parseDiff(gitDiffOutput);
 *   const result = await verify(edits, predicates, config);
 *
 * Handles:
 *   - Modified files (search/replace from context)
 *   - New files (empty search, full content as replace)
 *   - Deleted files (full content as search, empty replace)
 *   - Multiple hunks per file
 *   - Binary files (skipped)
 */

import type { Edit } from '../types.js';

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

/**
 * Parse a unified diff string into Edit[] for verify().
 */
export function parseDiff(diff: string): Edit[] {
  const files = parseDiffFiles(diff);
  const edits: Edit[] = [];

  for (const file of files) {
    if (file.isBinary) continue;

    const filePath = file.newPath ?? file.oldPath;
    if (!filePath) continue;

    if (file.isNew) {
      // New file: search is empty, replace is the full content
      const content = file.hunks
        .flatMap(h => h.lines.filter(l => l.startsWith('+')).map(l => l.slice(1)))
        .join('\n');

      edits.push({
        file: filePath,
        search: '',
        replace: content,
      });
      continue;
    }

    if (file.isDeleted) {
      // Deleted file: search is full content, replace is empty
      const content = file.hunks
        .flatMap(h => h.lines.filter(l => l.startsWith('-')).map(l => l.slice(1)))
        .join('\n');

      edits.push({
        file: filePath,
        search: content,
        replace: '',
      });
      continue;
    }

    // Modified file: each hunk becomes an edit
    for (const hunk of file.hunks) {
      const { search, replace } = extractHunkEdit(hunk);
      if (search === replace) continue; // no actual change

      edits.push({
        file: filePath,
        search,
        replace,
      });
    }
  }

  return edits;
}

/**
 * Parse diff text into structured DiffFile objects.
 */
function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Find next file header
    if (!lines[i].startsWith('diff --git')) {
      i++;
      continue;
    }

    const file: DiffFile = {
      oldPath: null,
      newPath: null,
      hunks: [],
      isBinary: false,
      isNew: false,
      isDeleted: false,
    };

    i++; // skip "diff --git" line

    // Parse header lines until first hunk or next file
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
      const line = lines[i];

      if (line.startsWith('--- ')) {
        const path = line.slice(4);
        file.oldPath = path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
        if (path === '/dev/null') file.isNew = true;
      } else if (line.startsWith('+++ ')) {
        const path = line.slice(4);
        file.newPath = path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
        if (path === '/dev/null') file.isDeleted = true;
      } else if (line.startsWith('Binary files')) {
        file.isBinary = true;
      } else if (line.startsWith('new file mode')) {
        file.isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        file.isDeleted = true;
      }

      i++;
    }

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith('diff --git')) {
      if (lines[i].startsWith('@@')) {
        const hunk = parseHunk(lines, i);
        file.hunks.push(hunk.hunk);
        i = hunk.nextLine;
      } else {
        i++;
      }
    }

    files.push(file);
  }

  return files;
}

function parseHunk(lines: string[], start: number): { hunk: DiffHunk; nextLine: number } {
  const headerMatch = lines[start].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!headerMatch) {
    return {
      hunk: { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines: [] },
      nextLine: start + 1,
    };
  }

  const hunk: DiffHunk = {
    oldStart: parseInt(headerMatch[1], 10),
    oldCount: parseInt(headerMatch[2] ?? '1', 10),
    newStart: parseInt(headerMatch[3], 10),
    newCount: parseInt(headerMatch[4] ?? '1', 10),
    lines: [],
  };

  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
    const line = lines[i];
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
      hunk.lines.push(line);
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    } else {
      break;
    }
    i++;
  }

  return { hunk, nextLine: i };
}

/**
 * Extract search/replace strings from a hunk.
 * Context lines (space prefix) are included in both search and replace.
 * Removed lines (- prefix) go in search only.
 * Added lines (+ prefix) go in replace only.
 */
function extractHunkEdit(hunk: DiffHunk): { search: string; replace: string } {
  const searchLines: string[] = [];
  const replaceLines: string[] = [];

  for (const line of hunk.lines) {
    if (line.startsWith('-')) {
      searchLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      replaceLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      searchLines.push(line.slice(1));
      replaceLines.push(line.slice(1));
    } else if (line === '') {
      // Empty context line
      searchLines.push('');
      replaceLines.push('');
    }
  }

  return {
    search: searchLines.join('\n'),
    replace: replaceLines.join('\n'),
  };
}
