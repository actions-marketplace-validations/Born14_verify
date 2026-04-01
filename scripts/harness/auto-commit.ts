#!/usr/bin/env bun
/**
 * Auto-Commit — Apply accepted improvements and push to main
 * =============================================================
 *
 * Reads data/improvement-ledger.jsonl after the improve loop.
 * For each accepted entry, applies the winning candidate's edits
 * to the real source tree, then commits and pushes.
 *
 * Safety: only applies edits to files under src/gates/ and src/store/.
 * Will not touch scenarios, fixtures, scripts, or any other path.
 *
 * Usage:
 *   bun scripts/harness/auto-commit.ts              # apply + commit + push
 *   bun scripts/harness/auto-commit.ts --dry-run    # show what would be committed
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { spawnSync } from 'child_process';

const PKG_ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const ledgerPath = resolve(PKG_ROOT, 'data', 'improvement-ledger.jsonl');

// ─────────────────────────────────────────────────────────────────────────────
// Safety: only these directories can be modified
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_PREFIXES = ['src/gates/', 'src/store/'];

function isAllowedFile(file: string): boolean {
  return ALLOWED_PREFIXES.some(p => file.startsWith(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Types (minimal — matches improve types)
// ─────────────────────────────────────────────────────────────────────────────

interface ProposedEdit {
  file: string;
  search?: string;
  replace: string;
}

interface CandidateResult {
  candidateId: string;
  strategy: string;
  edits: ProposedEdit[];
  improvements: string[];
  regressions: string[];
  score: number;
}

interface ImprovementEntry {
  id: string;
  timestamp: string;
  candidates: CandidateResult[];
  winner: string | null;
  verdict: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply edits
// ─────────────────────────────────────────────────────────────────────────────

function applyEdit(edit: ProposedEdit): { success: boolean; reason?: string } {
  const filePath = resolve(PKG_ROOT, edit.file);
  if (!existsSync(filePath)) {
    return { success: false, reason: `file not found: ${edit.file}` };
  }
  if (!edit.search) {
    return { success: false, reason: 'no search string (file creation not supported)' };
  }

  const content = readFileSync(filePath, 'utf-8');
  if (content.indexOf(edit.search) === -1) {
    return { success: false, reason: 'search string not found' };
  }

  const newContent = content.replace(edit.search, edit.replace);
  if (newContent === content) {
    return { success: false, reason: 'no change after replace' };
  }

  if (!dryRun) {
    writeFileSync(filePath, newContent);
  }
  return { success: true };
}

function git(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('git', args, { cwd: PKG_ROOT, encoding: 'utf-8', timeout: 30000 });
  return { ok: result.status === 0, output: (result.stdout + result.stderr).trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Auto-Commit ===');
if (dryRun) console.log('DRY RUN — no files modified, no commits made\n');

if (!existsSync(ledgerPath)) {
  console.log('No improvement ledger found. Nothing to commit.');
  process.exit(0);
}

const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(l => l);
const entries: ImprovementEntry[] = [];
for (const line of lines) {
  try { entries.push(JSON.parse(line)); } catch {}
}

const accepted = entries.filter(e => e.verdict === 'accepted' && e.winner);
console.log(`  Ledger entries: ${entries.length}`);
console.log(`  Accepted: ${accepted.length}\n`);

if (accepted.length === 0) {
  console.log('No accepted improvements. Nothing to commit.');
  process.exit(0);
}

// Apply each accepted entry's winning edits
const appliedFiles = new Set<string>();
let totalEdits = 0;
let totalApplied = 0;
const strategies: string[] = [];

for (const entry of accepted) {
  const winner = entry.candidates.find(c => c.candidateId === entry.winner);
  if (!winner) {
    console.log(`  SKIP ${entry.id}: winner "${entry.winner}" not found in candidates`);
    continue;
  }

  console.log(`  ${entry.id}: strategy="${winner.strategy}" (${winner.edits.length} edits)`);
  strategies.push(winner.strategy);

  for (const edit of winner.edits) {
    totalEdits++;
    if (!isAllowedFile(edit.file)) {
      console.log(`    SKIP ${edit.file} (outside allowed paths)`);
      continue;
    }

    const result = applyEdit(edit);
    if (result.success) {
      totalApplied++;
      appliedFiles.add(edit.file);
      console.log(`    ${dryRun ? 'WOULD APPLY' : 'APPLIED'} ${edit.file}`);
    } else {
      console.log(`    SKIP ${edit.file}: ${result.reason}`);
    }
  }
}

if (totalApplied === 0) {
  console.log('\nNo edits applied. Nothing to commit.');
  process.exit(0);
}

console.log(`\n  Applied: ${totalApplied}/${totalEdits} edits across ${appliedFiles.size} files`);

if (dryRun) {
  console.log('\n  DRY RUN complete. Run without --dry-run to commit.');
  process.exit(0);
}

// Git commit + push
const files = [...appliedFiles];
const addResult = git('add', ...files);
if (!addResult.ok) {
  console.log(`  git add failed: ${addResult.output}`);
  process.exit(1);
}

const strategyList = [...new Set(strategies)].join(', ');
const message = `verify: nightly auto-fix — ${totalApplied} edits (${strategyList})\n\nAccepted by improve loop: holdout clean, no regressions.\nFiles: ${files.join(', ')}`;

const commitResult = git('commit', '-m', message);
if (!commitResult.ok) {
  if (commitResult.output.includes('nothing to commit')) {
    console.log('  Nothing to commit (edits already match current state).');
    process.exit(0);
  }
  console.log(`  git commit failed: ${commitResult.output}`);
  process.exit(1);
}
console.log(`  Committed: ${commitResult.output.split('\n')[0]}`);

// Push to all configured remotes
for (const remote of ['origin', 'lenovo-tunnel', 'lenovo']) {
  const pushResult = git('push', remote, 'main');
  if (pushResult.ok) {
    console.log(`  Pushed to ${remote}`);
  }
  // Silent fail for remotes that don't exist on this machine
}

console.log('\n  Auto-commit complete.');
