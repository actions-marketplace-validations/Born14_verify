/**
 * New Shape Emitter — Extract Candidate Shapes from Unknowns
 * =============================================================
 *
 * Groups all "unknown" findings across batches by gate + file extension.
 * If 3+ unknowns share the same group, they're a candidate shape.
 *
 * Output: data/aidev-scan/new-shapes.jsonl
 * The supply chain picks up new shapes on the next nightly run.
 *
 * Usage:
 *   bun scripts/scan/emit-shapes.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const BATCH_DIR = join(import.meta.dir, '../../data/aidev-scan/batches');
const OUTPUT = join(import.meta.dir, '../../data/aidev-scan/new-shapes.jsonl');

interface Unknown {
  pr_id: string;
  gate: string;
  file: string;
  detail: string;
  agent: string;
}

interface CandidateShape {
  id: string;
  gate: string;
  filePattern: string;
  occurrences: number;
  examples: Array<{ pr_id: string; file: string; detail: string; agent: string }>;
  suggestion: string;
}

function getFileCategory(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  if (file.includes('.github/')) return 'github-ci';
  if (file.endsWith('.md') || file.endsWith('.mdx') || file.endsWith('.rst')) return 'docs';
  if (/\.(json|yaml|yml|toml|ini|cfg|env)$/.test(file)) return 'config';
  if (/\.(ts|js)$/.test(file) && !file.endsWith('.d.ts')) return 'typescript-javascript';
  if (/\.(tsx|jsx)$/.test(file)) return 'frontend-react';
  if (/\.(vue|svelte)$/.test(file)) return 'frontend-other';
  if (/\.(py)$/.test(file)) return 'python';
  if (/\.(go)$/.test(file)) return 'go';
  if (/\.(rs)$/.test(file)) return 'rust';
  if (/\.(rb)$/.test(file)) return 'ruby';
  if (/\.(cpp|c|h|hpp)$/.test(file)) return 'c-cpp';
  if (/\.(java|kt|scala)$/.test(file)) return 'jvm';
  if (/\.(sh|bash|zsh)$/.test(file)) return 'shell';
  if (/\.(xml|csproj|fsproj|pom\.xml)$/.test(file)) return 'xml-project';
  if (/Dockerfile/i.test(file)) return 'docker';
  return 'other-' + ext;
}

function main() {
  if (!existsSync(BATCH_DIR)) {
    console.log('No batch results found');
    process.exit(1);
  }

  // Collect all unknowns from all batches
  const allUnknowns: Unknown[] = [];

  const summaryFiles = readdirSync(BATCH_DIR)
    .filter(f => f.endsWith('-summary.json'))
    .map(f => join(BATCH_DIR, f));

  for (const sf of summaryFiles) {
    const summary = JSON.parse(readFileSync(sf, 'utf-8'));
    const resultsFile = sf.replace('-summary.json', '.jsonl');
    if (!existsSync(resultsFile)) continue;

    const results = readFileSync(resultsFile, 'utf-8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

    for (const r of results) {
      for (const f of r.findings ?? []) {
        if (f.classification?.confidence === 'unknown') {
          allUnknowns.push({
            pr_id: r.pr_id,
            gate: f.gate,
            file: f.file ?? 'unknown',
            detail: f.detail?.substring(0, 100) ?? '',
            agent: r.agent,
          });
        }
      }
    }
  }

  console.log(`Found ${allUnknowns.length} unknowns across ${summaryFiles.length} batches`);

  // Group by gate + file category
  const groups = new Map<string, Unknown[]>();
  for (const u of allUnknowns) {
    const category = getFileCategory(u.file);
    const key = `${u.gate}::${category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(u);
  }

  // Filter: 3+ occurrences = candidate shape
  const candidates: CandidateShape[] = [];
  let shapeCounter = 700; // start after existing shapes

  for (const [key, unknowns] of groups) {
    if (unknowns.length < 3) continue;
    const [gate, filePattern] = key.split('::');

    candidates.push({
      id: `SCAN-${shapeCounter++}`,
      gate,
      filePattern,
      occurrences: unknowns.length,
      examples: unknowns.slice(0, 5).map(u => ({
        pr_id: u.pr_id,
        file: u.file,
        detail: u.detail,
        agent: u.agent,
      })),
      suggestion: unknowns.length >= 5
        ? `Strong candidate — add as GC shape (classifier rule to auto-classify as low)`
        : `Weak candidate — review examples before adding as shape`,
    });
  }

  // Sort by occurrence count
  candidates.sort((a, b) => b.occurrences - a.occurrences);

  // Write output
  writeFileSync(OUTPUT, candidates.map(c => JSON.stringify(c)).join('\n') + '\n');

  console.log(`\nCandidate shapes (3+ occurrences):`);
  for (const c of candidates) {
    console.log(`  ${c.id}: ${c.gate}::${c.filePattern} — ${c.occurrences} occurrences (${c.suggestion.split(' — ')[0]})`);
    for (const ex of c.examples.slice(0, 2)) {
      console.log(`    ${ex.agent} | ${ex.file} | ${ex.detail.substring(0, 50)}`);
    }
  }

  if (candidates.length === 0) {
    console.log('  None — all unknowns are isolated (< 3 occurrences each)');
  }

  console.log(`\nSaved to: ${OUTPUT}`);
}

main();
