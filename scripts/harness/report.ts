/**
 * Report — Console Output + Summary File
 * ========================================
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import type { LedgerSummary, LedgerEntry, Severity } from './types.js';

const SEVERITY_COLORS: Record<Severity, string> = {
  bug: '\x1b[31m',     // red
  unexpected: '\x1b[33m', // yellow
  info: '\x1b[36m',    // cyan
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';

export function printProgress(entry: LedgerEntry): void {
  const status = entry.clean ? `${GREEN}✓${RESET}` : `${SEVERITY_COLORS[entry.worstSeverity ?? 'info']}✗${RESET}`;
  const family = `[${entry.scenario.family}]`;
  const desc = entry.scenario.description.substring(0, 70);
  const ms = `${entry.result.totalMs}ms`;
  console.log(`  ${status} ${DIM}${family}${RESET} ${desc} ${DIM}${ms}${RESET}`);

  // Print violations inline
  for (const inv of entry.invariants) {
    if (!inv.passed) {
      const color = SEVERITY_COLORS[inv.severity as Severity] ?? '';
      console.log(`    ${color}${inv.severity}: ${inv.name}${RESET}`);
      if (inv.violation) {
        console.log(`    ${DIM}  → ${inv.violation}${RESET}`);
      }
    }
  }
}

export function printSummary(summary: LedgerSummary): void {
  console.log('');
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  VERIFY SELF-TEST SUMMARY${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log('');
  console.log(`  ${summary.oneLiner}`);
  console.log('');
  console.log(`  Run ID:    ${summary.identity.runId}`);
  console.log(`  Version:   ${summary.identity.packageVersion} (${summary.identity.gitCommit ?? 'no git'})`);
  console.log(`  Runtime:   ${summary.identity.runtime}`);
  console.log(`  Platform:  ${summary.identity.platform}`);
  console.log(`  Duration:  ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log('');

  // Per-family breakdown
  console.log(`  ${BOLD}By Family:${RESET}`);
  for (const [family, data] of Object.entries(summary.byFamily)) {
    const status = data.dirty === 0 ? `${GREEN}clean${RESET}` : `${SEVERITY_COLORS.bug}${data.dirty} dirty${RESET}`;
    console.log(`    ${family}: ${data.total} scenarios — ${status}`);
  }
  console.log('');

  // Top violations
  if (summary.topViolations.length > 0) {
    console.log(`  ${BOLD}Top Violations:${RESET}`);
    for (const v of summary.topViolations) {
      const color = SEVERITY_COLORS[v.severity] ?? '';
      console.log(`    ${color}${v.severity}${RESET} ${v.invariant} (${v.count}x)`);
      for (const ex of v.examples) {
        console.log(`      ${DIM}→ ${ex}${RESET}`);
      }
    }
    console.log('');
  }

  // Final verdict
  if (summary.bugs === 0 && summary.unexpected === 0) {
    console.log(`  ${GREEN}${BOLD}ALL CLEAN${RESET} — No invariant violations detected.`);
  } else if (summary.bugs > 0) {
    console.log(`  ${SEVERITY_COLORS.bug}${BOLD}${summary.bugs} BUG(S) FOUND${RESET} — Invariant violations indicate real defects.`);
  } else {
    console.log(`  ${SEVERITY_COLORS.unexpected}${BOLD}${summary.unexpected} UNEXPECTED BEHAVIOR(S)${RESET} — Review recommended.`);
  }
  console.log('');
}

export function saveSummary(summary: LedgerSummary, dataDir: string): string {
  const filename = `self-test-summary-${summary.identity.runId}.json`;
  const path = join(dataDir, filename);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  return path;
}
