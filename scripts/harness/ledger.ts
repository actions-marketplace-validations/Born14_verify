/**
 * Ledger — Append-Only JSONL Recording
 * ======================================
 *
 * Every scenario result is recorded. The ledger is the single source of truth.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import type { LedgerEntry, LedgerSummary, RunIdentity, Severity } from './types.js';

export class Ledger {
  private path: string;
  private entries: LedgerEntry[] = [];

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: LedgerEntry): void {
    this.entries.push(entry);
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }

  getEntries(): LedgerEntry[] {
    return this.entries;
  }

  summarize(identity: RunIdentity, startedAt: string, completedAt: string): LedgerSummary {
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    let bugs = 0;
    let unexpected = 0;
    let info = 0;
    let cleanScenarios = 0;
    let dirtyScenarios = 0;
    const byFamily: Record<string, { total: number; clean: number; dirty: number }> = {};
    const violationCounts = new Map<string, { count: number; severity: Severity; examples: string[] }>();

    for (const entry of this.entries) {
      if (entry.clean) {
        cleanScenarios++;
      } else {
        dirtyScenarios++;
      }

      // Count by severity
      for (const inv of entry.invariants) {
        if (!inv.passed) {
          const sev = inv.severity ?? 'info';
          if (sev === 'bug') bugs++;
          else if (sev === 'unexpected') unexpected++;
          else info++;

          // Track top violations
          const existing = violationCounts.get(inv.name);
          if (existing) {
            existing.count++;
            if (existing.examples.length < 3) {
              existing.examples.push(entry.scenario.description);
            }
          } else {
            violationCounts.set(inv.name, {
              count: 1,
              severity: sev as Severity,
              examples: [entry.scenario.description],
            });
          }
        }
      }

      // Count by family
      const fam = entry.scenario.family;
      if (!byFamily[fam]) byFamily[fam] = { total: 0, clean: 0, dirty: 0 };
      byFamily[fam].total++;
      if (entry.clean) byFamily[fam].clean++;
      else byFamily[fam].dirty++;
    }

    const topViolations = [...violationCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([name, data]) => ({
        invariant: name,
        count: data.count,
        severity: data.severity,
        examples: data.examples,
      }));

    const familySummary = Object.entries(byFamily)
      .map(([f, d]) => `${f}: ${d.dirty === 0 ? 'clean' : `${d.dirty} dirty`}`)
      .join(', ');

    const oneLiner = `${bugs} bugs | ${this.entries.length} scenarios | ${unexpected} unexpected | ${familySummary}`;

    return {
      identity,
      startedAt,
      completedAt,
      durationMs,
      totalScenarios: this.entries.length,
      cleanScenarios,
      dirtyScenarios,
      bugs,
      unexpected,
      info,
      byFamily,
      topViolations,
      oneLiner,
    };
  }
}

/**
 * Collect run identity metadata.
 */
export function collectRunIdentity(): RunIdentity {
  let packageVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    packageVersion = pkg.version;
  } catch { /* */ }

  let gitCommit: string | undefined;
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { /* */ }

  const runtime = `bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`;
  const platform = `${process.platform}-${process.arch}`;

  let dockerVersion: string | undefined;
  try {
    dockerVersion = execSync('docker --version', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { /* */ }

  return {
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    packageVersion,
    gitCommit,
    runtime,
    platform,
    dockerVersion,
  };
}
