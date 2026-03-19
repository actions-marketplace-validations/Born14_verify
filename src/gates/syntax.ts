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
      failures.push({ file: edit.file, search: edit.search.substring(0, 80), reason: 'file_missing' });
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');

    // Count occurrences
    let count = 0;
    let idx = 0;
    while (true) {
      idx = content.indexOf(edit.search, idx);
      if (idx === -1) break;
      count++;
      idx += 1;
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
      results.push({ file: edit.file, applied: false, reason: 'file not found' });
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');
    const idx = content.indexOf(edit.search);

    if (idx === -1) {
      results.push({ file: edit.file, applied: false, reason: 'search string not found' });
      continue;
    }

    // Check uniqueness
    const secondIdx = content.indexOf(edit.search, idx + 1);
    if (secondIdx !== -1) {
      results.push({ file: edit.file, applied: false, reason: 'ambiguous match' });
      continue;
    }

    // Apply
    const { writeFileSync } = require('fs');
    const newContent = content.slice(0, idx) + edit.replace + content.slice(idx + edit.search.length);
    writeFileSync(filePath, newContent, 'utf-8');
    results.push({ file: edit.file, applied: true });
  }

  return results;
}
