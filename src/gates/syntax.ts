/**
 * F9 Gate — Syntax Validation
 * ===========================
 *
 * Checks that every edit's search string exists exactly once in the target file.
 * No LLM. No Docker. Pure filesystem check.
 *
 * Catches:
 * - Search strings that don't exist (agent hallucinated the code)
 * - Search strings that match multiple locations (ambiguous edit)
 * - Files that don't exist
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Edit, GateResult, GateContext } from '../types.js';

export interface SyntaxFailure {
  file: string;
  search: string;
  reason: 'not_found' | 'ambiguous_match' | 'file_missing';
  matchCount?: number;
}

export interface SyntaxGateResult extends GateResult {
  failures: SyntaxFailure[];
}

export function runSyntaxGate(ctx: GateContext): SyntaxGateResult {
  const start = Date.now();
  const failures: SyntaxFailure[] = [];

  for (const edit of ctx.edits) {
    const filePath = join(ctx.stageDir ?? ctx.config.appDir, edit.file);

    if (!existsSync(filePath)) {
      // File creation: empty search + non-empty replace = create new file (valid edit)
      if (edit.search === '' && edit.replace) {
        continue; // File creation is syntactically valid — applyEdits will handle it
      }
      failures.push({ file: edit.file, search: edit.search.substring(0, 80), reason: 'file_missing' });
      continue;
    }

    // Empty search string on an existing file is ambiguous
    if (!edit.search) {
      failures.push({ file: edit.file, search: '(empty)', reason: 'ambiguous_match', matchCount: -1 });
      continue;
    }

    // Normalize line endings for cross-platform matching (CRLF → LF)
    const content = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
    const search = edit.search.replace(/\r\n/g, '\n');

    // Count occurrences
    let count = 0;
    let idx = 0;
    while (true) {
      idx = content.indexOf(search, idx);
      if (idx === -1) break;
      count++;
      idx += search.length;
    }

    if (count === 0) {
      failures.push({
        file: edit.file,
        search: edit.search.substring(0, 80),
        reason: 'not_found',
      });
    } else if (count > 1) {
      failures.push({
        file: edit.file,
        search: edit.search.substring(0, 80),
        reason: 'ambiguous_match',
        matchCount: count,
      });
    }
  }

  const passed = failures.length === 0;
  const durationMs = Date.now() - start;

  let detail: string;
  if (passed) {
    detail = `All ${ctx.edits.length} edit(s) have unique search strings`;
  } else {
    const reasons = failures.map(f => {
      if (f.reason === 'file_missing') return `${f.file}: file not found`;
      if (f.reason === 'not_found') return `${f.file}: search string not found`;
      return `${f.file}: ambiguous match (${f.matchCount} occurrences)`;
    });
    detail = reasons.join('; ');
  }

  return { gate: 'F9', passed, detail, durationMs, failures };
}

/**
 * Apply edits to files in a directory. Returns per-edit results.
 */
export function applyEdits(
  edits: Edit[],
  targetDir: string,
): Array<{ file: string; applied: boolean; reason?: string }> {
  const results: Array<{ file: string; applied: boolean; reason?: string }> = [];

  for (const edit of edits) {
    const filePath = join(targetDir, edit.file);

    if (!existsSync(filePath)) {
      // Support file creation: empty search + non-empty replace = create new file
      if (edit.search === '' && edit.replace) {
        try {
          const dir = filePath.substring(0, filePath.lastIndexOf('/') > 0 ? filePath.lastIndexOf('/') : filePath.lastIndexOf('\\'));
          if (dir && !existsSync(dir)) {
            const { mkdirSync } = require('fs');
            mkdirSync(dir, { recursive: true });
          }
          const { writeFileSync: wfs } = require('fs');
          wfs(filePath, edit.replace.replace(/\r\n/g, '\n'), 'utf-8');
          results.push({ file: edit.file, applied: true });
        } catch (e) {
          results.push({ file: edit.file, applied: false, reason: `create failed: ${(e as Error).message}` });
        }
        continue;
      }
      results.push({ file: edit.file, applied: false, reason: 'file not found' });
      continue;
    }

    // Normalize line endings for cross-platform matching (CRLF → LF)
    const rawContent = readFileSync(filePath, 'utf-8');
    const content = rawContent.replace(/\r\n/g, '\n');
    const search = edit.search.replace(/\r\n/g, '\n');
    const idx = content.indexOf(search);

    if (idx === -1) {
      results.push({ file: edit.file, applied: false, reason: 'search string not found' });
      continue;
    }

    // Check uniqueness
    const secondIdx = content.indexOf(search, idx + 1);
    if (secondIdx !== -1) {
      results.push({ file: edit.file, applied: false, reason: 'ambiguous match' });
      continue;
    }

    // Apply — write with normalized line endings
    const { writeFileSync } = require('fs');
    const replace = edit.replace.replace(/\r\n/g, '\n');
    const newContent = content.slice(0, idx) + replace + content.slice(idx + search.length);
    writeFileSync(filePath, newContent, 'utf-8');
    results.push({ file: edit.file, applied: true });
  }

  return results;
}
