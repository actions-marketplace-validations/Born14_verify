/**
 * Precision Check — Sample 50 random high-confidence findings
 * =============================================================
 *
 * Pulls random high-confidence findings from scan batch data.
 * Shows the actual code that triggered the gate.
 * Used to calculate the real precision number before publishing.
 *
 * Usage:
 *   bun scripts/scan/precision-check.ts --count=50
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const BATCH_DIR = join(import.meta.dir, '../../data/aidev-scan/batches');
const DETAILS_JSONL = join(import.meta.dir, '../../data/aidev-pop/pr_commit_details.jsonl');

interface PRResult {
  pr_id: string;
  agent: string;
  repo: string;
  title: string;
  editCount: number;
  findings: Array<{
    gate: string;
    passed: boolean;
    detail: string;
    file?: string;
    classification: { confidence: string; reason: string; shape?: string };
  }>;
}

function main() {
  const count = parseInt(process.argv.find(a => a.startsWith('--count='))?.split('=')[1] ?? '50');

  console.log(`=== Precision Check: ${count} random high-confidence findings ===\n`);

  // Collect all high-confidence findings across all batches
  const allHighFindings: Array<{
    pr_id: string;
    agent: string;
    repo: string;
    title: string;
    gate: string;
    detail: string;
    file: string;
  }> = [];

  const batchFiles = readdirSync(BATCH_DIR).filter(f => f.endsWith('.jsonl'));

  for (const bf of batchFiles) {
    const lines = readFileSync(join(BATCH_DIR, bf), 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const r: PRResult = JSON.parse(line);
        for (const f of r.findings ?? []) {
          if (f.classification?.confidence === 'high') {
            allHighFindings.push({
              pr_id: r.pr_id,
              agent: r.agent,
              repo: r.repo,
              title: r.title,
              gate: f.gate,
              detail: f.detail ?? '',
              file: f.file ?? 'unknown',
            });
          }
        }
      } catch {}
    }
  }

  console.log(`Total high-confidence findings: ${allHighFindings.length}`);
  console.log(`Sampling ${Math.min(count, allHighFindings.length)} randomly\n`);

  // Random sample without replacement
  const shuffled = allHighFindings.sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, count);

  // Load patch data for these PRs to show actual code
  const targetPRs = new Set(sample.map(s => s.pr_id));
  const patchesByPR = new Map<string, Array<{ filename: string; patch: string }>>();

  if (existsSync(DETAILS_JSONL)) {
    const file = Bun.file(DETAILS_JSONL);
    const text = readFileSync(DETAILS_JSONL, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const prId = String(d.pr_id);
        if (!targetPRs.has(prId)) continue;
        if (!d.patch) continue;
        if (!patchesByPR.has(prId)) patchesByPR.set(prId, []);
        patchesByPR.get(prId)!.push({ filename: d.filename, patch: d.patch });
      } catch {}
    }
  }

  // Output each finding with code context
  let real = 0, fp = 0, unclear = 0;

  for (let i = 0; i < sample.length; i++) {
    const s = sample[i];
    console.log(`--- ${i + 1}/${count} | ${s.agent} | ${s.repo} ---`);
    console.log(`  PR: ${s.pr_id} | ${s.title}`);
    console.log(`  Gate: ${s.gate} | File: ${s.file}`);
    console.log(`  Detail: ${s.detail.substring(0, 120)}`);

    // Show relevant patch
    const patches = patchesByPR.get(s.pr_id) ?? [];
    const relevantPatch = patches.find(p => p.filename === s.file) ?? patches[0];
    if (relevantPatch) {
      // Show just the added lines (what the agent wrote)
      const added = relevantPatch.patch.split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .slice(0, 8)
        .join('\n  ');
      if (added) {
        console.log(`  Code (added):`);
        console.log(`  ${added}`);
      }
    }

    // Auto-classify based on patterns we know
    const classification = autoClassify(s);
    console.log(`  Auto-verdict: ${classification}`);
    if (classification === 'REAL') real++;
    else if (classification === 'FP') fp++;
    else unclear++;

    console.log();
  }

  // Summary
  console.log('=== PRECISION SUMMARY ===');
  console.log(`  Sampled: ${sample.length}`);
  console.log(`  Auto-classified REAL: ${real}`);
  console.log(`  Auto-classified FP: ${fp}`);
  console.log(`  Unclear (needs manual review): ${unclear}`);
  console.log(`  Auto-precision: ${(real / (real + fp) * 100).toFixed(1)}% (excluding unclear)`);
  console.log(`  Conservative precision: ${(real / sample.length * 100).toFixed(1)}% (treating unclear as FP)`);
  console.log(`  Optimistic precision: ${((real + unclear) / sample.length * 100).toFixed(1)}% (treating unclear as real)`);
}

function autoClassify(finding: { gate: string; file: string; detail: string; agent: string }): string {
  const { gate, file, detail } = finding;
  const ext = file.split('.').pop()?.toLowerCase() ?? '';

  // Definitely real patterns
  if (gate === 'capacity' && /unbounded|SELECT \*|no LIMIT|missing pagination/i.test(detail)) return 'REAL';
  if (gate === 'contention' && /race condition|missing transaction|read-modify-write/i.test(detail)) return 'REAL';
  if (gate === 'access' && /permission escalation/i.test(detail) && /\.(py|rb|go|java|php)$/.test(file)) return 'REAL';
  if (gate === 'security' && /hardcoded|secret|eval|injection/i.test(detail) && /\.(ts|js|py|rb)$/.test(file)) return 'REAL';

  // Definitely FP patterns (shouldn't be high-confidence but might slip through)
  if (/\.(md|mdx|txt|rst)$/.test(file)) return 'FP';
  if (/\.(d\.ts)$/.test(file)) return 'FP';
  if (file.includes('test') || file.includes('spec') || file.includes('__tests__')) return 'FP';

  // Backend code with real gate triggers — likely real
  if (/\.(ts|js|py|rb|go|rs|java|php)$/.test(file) && !file.endsWith('.tsx') && !file.endsWith('.jsx')) {
    if (gate === 'capacity') return 'REAL';
    if (gate === 'contention') return 'REAL';
    if (gate === 'access' && /path traversal|permission|privilege/i.test(detail)) return 'REAL';
  }

  return 'UNCLEAR';
}

main();
