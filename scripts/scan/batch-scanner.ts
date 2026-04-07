/**
 * Batch Scanner — AIDev-POP with Accumulating Knowledge
 * =======================================================
 *
 * Processes the AIDev dataset in batches per agent.
 * Each batch improves the gates for the next batch.
 *
 * Usage:
 *   bun scripts/scan/batch-scanner.ts --agent=devin --batch=1 --size=500
 *   bun scripts/scan/batch-scanner.ts --report
 *
 * Source adapter interface: each dataset implements getPatches().
 * AIDev is the first adapter. New sources are one file each.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { classifyFinding, type FindingClassification, type ScanFinding } from './classifier.js';

const DATA_DIR = join(import.meta.dir, '../../data/aidev-pop');
const OUTPUT_DIR = join(import.meta.dir, '../../data/aidev-scan');
const BATCH_DIR = join(OUTPUT_DIR, 'batches');

// =============================================================================
// SOURCE ADAPTER INTERFACE
// =============================================================================

export interface PatchEntry {
  id: string;
  agent: string;
  repo: string;
  title: string;
  diff: string; // unified diff format
}

export interface SourceAdapter {
  name: string;
  getPatches(options: {
    agent?: string;
    offset: number;
    limit: number;
  }): AsyncGenerator<PatchEntry>;
}

// =============================================================================
// AIDEV ADAPTER
// =============================================================================

function createAIDevAdapter(): SourceAdapter {
  const prJSONL = join(DATA_DIR, 'pull_request.jsonl');
  const detailsJSONL = join(DATA_DIR, 'pr_commit_details.jsonl');

  return {
    name: 'aidev-pop',

    async *getPatches(options) {
      const { agent, offset, limit } = options;

      // Load PR metadata (33K rows — small enough)
      // Sort by ID for deterministic batching
      const allPRs: Array<{ id: string; agent: string; repo: string; title: string }> = [];
      const prText = readFileSync(prJSONL, 'utf-8');
      for (const line of prText.split('\n')) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          const prAgent = raw.agent ?? 'unknown';
          if (agent && prAgent !== agent) continue;
          allPRs.push({
            id: String(raw.id),
            agent: prAgent,
            repo: raw.repo_url?.replace('https://api.github.com/repos/', '') ?? '',
            title: raw.title ?? '',
          });
        } catch {}
      }

      // Deterministic batch: sort by ID, slice [offset, offset+limit)
      allPRs.sort((a, b) => a.id.localeCompare(b.id));
      const batchPRs = allPRs.slice(offset, offset + limit);
      const targetIds = new Set(batchPRs.map(p => p.id));
      const prMap = new Map(batchPRs.map(p => [p.id, { agent: p.agent, repo: p.repo, title: p.title }]));

      // Stream commit details, collect patches per PR
      // Stream commit details, collect ONLY patches for this batch's target IDs
      const file = Bun.file(detailsJSONL);
      const stream = file.stream();
      const decoder = new TextDecoder();
      let buffer = '';

      const patchesByPR = new Map<string, Array<{ filename: string; status: string; patch: string }>>();

      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (!d.patch) continue;
            const prId = String(d.pr_id);
            if (!targetIds.has(prId)) continue; // only collect for this batch

            if (!patchesByPR.has(prId)) patchesByPR.set(prId, []);
            patchesByPR.get(prId)!.push({
              filename: d.filename,
              status: d.status,
              patch: d.patch,
            });
          } catch {}
        }
      }

      // Yield all collected PRs in batch order
      for (const batchPR of batchPRs) {
        const patches = patchesByPR.get(batchPR.id);
        if (!patches || patches.length === 0) continue;

        const pr = prMap.get(batchPR.id)!;
        const diff = patches.map(p => {
          const isNew = p.status === 'added';
          const header = isNew
            ? `diff --git a/${p.filename} b/${p.filename}\nnew file mode 100644\n--- /dev/null\n+++ b/${p.filename}\n`
            : `diff --git a/${p.filename} b/${p.filename}\n--- a/${p.filename}\n+++ b/${p.filename}\n`;
          return header + p.patch;
        }).join('\n');

        yield {
          id: batchPR.id,
          agent: pr.agent,
          repo: pr.repo,
          title: pr.title,
          diff,
        };
      }
    },
  };
}

// =============================================================================
// SCAN RESULT TYPES
// =============================================================================

interface BatchFinding {
  gate: string;
  passed: boolean;
  detail: string;
  file?: string;
  classification: FindingClassification;
}

interface BatchPRResult {
  pr_id: string;
  agent: string;
  repo: string;
  title: string;
  editCount: number;
  findings: BatchFinding[];
  highCount: number;
  lowCount: number;
  unknownCount: number;
  duration_ms: number;
}

interface BatchSummary {
  timestamp: string;
  adapter: string;
  agent: string;
  batchNumber: number;
  batchSize: number;
  prsScanned: number;
  prsWithFindings: number;
  findingRate: string;
  highConfidenceRate: string;
  gateStats: Record<string, { ran: number; failed: number; high: number; low: number; unknown: number }>;
  unknowns: Array<{ pr_id: string; gate: string; file: string; detail: string }>;
}

// =============================================================================
// BATCH SCANNER
// =============================================================================

async function runBatch(agent: string, batchNumber: number, batchSize: number): Promise<void> {
  const start = Date.now();
  console.log(`\n═══ Batch Scan: ${agent} #${batchNumber} (${batchSize} PRs) ═══\n`);

  mkdirSync(BATCH_DIR, { recursive: true });

  const adapter = createAIDevAdapter();
  const { parseDiff } = await import('../../src/parsers/git-diff.js');
  const { verify } = await import('../../src/verify.js');

  const offset = (batchNumber - 1) * batchSize;
  const results: BatchPRResult[] = [];
  const gateStats: Record<string, { ran: number; failed: number; high: number; low: number; unknown: number }> = {};
  const unknowns: BatchSummary['unknowns'] = [];
  let totalWithFindings = 0;
  let scanned = 0;

  const tmpDir = join(OUTPUT_DIR, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  for await (const entry of adapter.getPatches({ agent, offset, limit: batchSize })) {
    scanned++;
    const prStart = Date.now();

    // Parse diff
    let edits;
    try {
      edits = parseDiff(entry.diff);
    } catch {
      results.push({
        pr_id: entry.id, agent: entry.agent, repo: entry.repo,
        title: entry.title.substring(0, 100), editCount: 0,
        findings: [], highCount: 0, lowCount: 0, unknownCount: 0,
        duration_ms: Date.now() - prStart,
      });
      continue;
    }

    if (edits.length === 0) {
      results.push({
        pr_id: entry.id, agent: entry.agent, repo: entry.repo,
        title: entry.title.substring(0, 100), editCount: 0,
        findings: [], highCount: 0, lowCount: 0, unknownCount: 0,
        duration_ms: Date.now() - prStart,
      });
      continue;
    }

    // Create temp files for the edits
    const prDir = join(tmpDir, entry.id);
    mkdirSync(prDir, { recursive: true });
    for (const edit of edits) {
      try {
        const filePath = join(prDir, edit.file);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, (edit.search || '') + '\n' + (edit.replace || ''));
      } catch {}
    }

    // Auto-generate security predicates for code files (same as the Action does)
    const codeExts = new Set(['js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'php', 'mjs', 'cjs']);
    const hasCodeEdits = edits.some(e => codeExts.has(e.file.split('.').pop()?.toLowerCase() ?? ''));
    const securityPredicates = hasCodeEdits ? [
      { type: 'security', securityCheck: 'secrets_in_code', expected: 'no_findings' },
      { type: 'security', securityCheck: 'xss', expected: 'no_findings' },
      { type: 'security', securityCheck: 'sql_injection', expected: 'no_findings' },
    ] : [];

    // Run verify with security predicates
    let gateResults: Array<{ gate: string; passed: boolean; detail: string }> = [];
    try {
      const result = await verify(edits, securityPredicates as any, {
        appDir: prDir,
        gates: {
          grounding: false, syntax: false, staging: false,
          browser: false, http: false, invariants: false, vision: false,
        },
      });
      gateResults = result.gates.map((g: any) => ({
        gate: g.gate, passed: g.passed, detail: g.detail?.substring(0, 200) ?? '',
      }));
    } catch (err: any) {
      gateResults = [{ gate: 'crash', passed: false, detail: err.message?.substring(0, 100) ?? 'unknown' }];
    }

    // Cleanup
    try { const { rmSync } = await import('fs'); rmSync(prDir, { recursive: true, force: true }); } catch {}

    // Classify findings
    const failedGates = gateResults.filter(g => !g.passed);
    const findings: BatchFinding[] = [];
    let highCount = 0, lowCount = 0, unknownCount = 0;

    for (const g of gateResults) {
      // Track gate stats
      if (!gateStats[g.gate]) gateStats[g.gate] = { ran: 0, failed: 0, high: 0, low: 0, unknown: 0 };
      gateStats[g.gate].ran++;

      if (!g.passed) {
        gateStats[g.gate].failed++;

        // Classify each failed gate finding
        // Try to extract file from detail
        const fileMatch = g.detail.match(/^([\w/.-]+\.[\w]+)/);
        const file = fileMatch?.[1] ?? edits[0]?.file ?? 'unknown';

        const classification = classifyFinding({
          gate: g.gate,
          file,
          detail: g.detail,
          totalFindingsInPR: failedGates.length,
        });

        findings.push({ ...g, file, classification });

        if (classification.confidence === 'high') { highCount++; gateStats[g.gate].high++; }
        else if (classification.confidence === 'low') { lowCount++; gateStats[g.gate].low++; }
        else { unknownCount++; gateStats[g.gate].unknown++; unknowns.push({ pr_id: entry.id, gate: g.gate, file, detail: g.detail.substring(0, 100) }); }
      }
    }

    if (findings.length > 0) totalWithFindings++;

    results.push({
      pr_id: entry.id, agent: entry.agent, repo: entry.repo,
      title: entry.title.substring(0, 100), editCount: edits.length,
      findings, highCount, lowCount, unknownCount,
      duration_ms: Date.now() - prStart,
    });

    if (scanned % 50 === 0 || scanned === batchSize) {
      const pct = (scanned / batchSize * 100).toFixed(0);
      const findRate = (totalWithFindings / scanned * 100).toFixed(1);
      console.log(`  [${pct}%] ${scanned}/${batchSize} | ${totalWithFindings} with findings (${findRate}%) | ${unknowns.length} unknowns`);
    }
  }

  // Generate summary
  const summary: BatchSummary = {
    timestamp: new Date().toISOString(),
    adapter: 'aidev-pop',
    agent,
    batchNumber,
    batchSize,
    prsScanned: scanned,
    prsWithFindings: totalWithFindings,
    findingRate: (totalWithFindings / scanned * 100).toFixed(1) + '%',
    highConfidenceRate: (results.reduce((a, r) => a + r.highCount, 0) / Math.max(1, totalWithFindings) * 100).toFixed(1) + '%',
    gateStats,
    unknowns: unknowns.slice(0, 50), // cap at 50 for readability
  };

  // Save results
  const batchName = `${agent}-${String(batchNumber).padStart(3, '0')}`;
  writeFileSync(join(BATCH_DIR, `${batchName}.jsonl`), results.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(BATCH_DIR, `${batchName}-summary.json`), JSON.stringify(summary, null, 2));

  // Report
  console.log('\n═══ Batch Results ═══');
  console.log(`  PRs scanned: ${scanned}`);
  console.log(`  PRs with findings: ${totalWithFindings} (${summary.findingRate})`);
  console.log(`  High confidence: ${results.reduce((a, r) => a + r.highCount, 0)}`);
  console.log(`  Low confidence (known FP): ${results.reduce((a, r) => a + r.lowCount, 0)}`);
  console.log(`  Unknown (needs review): ${unknowns.length}`);
  console.log();

  console.log('  Gate stats:');
  for (const [gate, stats] of Object.entries(gateStats).sort((a, b) => b[1].failed - a[1].failed)) {
    if (stats.failed === 0) continue;
    console.log(`    ${gate.padEnd(14)} ${stats.failed} failed (${stats.high} high, ${stats.low} low, ${stats.unknown} unknown)`);
  }

  if (unknowns.length > 0) {
    console.log(`\n  Unknowns (${unknowns.length} — needs operator review):`);
    for (const u of unknowns.slice(0, 10)) {
      console.log(`    ${u.pr_id} | ${u.gate} | ${u.file} | ${u.detail.substring(0, 60)}`);
    }
    if (unknowns.length > 10) console.log(`    ... and ${unknowns.length - 10} more`);
  }

  console.log(`\n  Saved: ${join(BATCH_DIR, batchName + '.jsonl')}`);
  console.log(`  Summary: ${join(BATCH_DIR, batchName + '-summary.json')}`);
  console.log(`  Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// =============================================================================
// MAIN
// =============================================================================

const args = process.argv.slice(2);

if (args.includes('--report')) {
  // Generate cross-batch report (future: wiki compiler)
  console.log('Cross-batch report not yet implemented. Use wiki-compiler.ts');
  process.exit(0);
}

const agentArg = args.find(a => a.startsWith('--agent='))?.split('=')[1];
const batchArg = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] ?? '1');
const sizeArg = parseInt(args.find(a => a.startsWith('--size='))?.split('=')[1] ?? '500');

if (!agentArg) {
  console.log('Usage: bun scripts/scan/batch-scanner.ts --agent=devin --batch=1 --size=500');
  console.log('Agents: Devin, Copilot, Cursor, Claude_Code, OpenAI_Codex');
  process.exit(1);
}

runBatch(agentArg, batchArg, sizeArg).catch(err => {
  console.error('Batch scan failed:', err);
  process.exit(1);
});
