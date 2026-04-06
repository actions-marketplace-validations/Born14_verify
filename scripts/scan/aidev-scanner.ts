/**
 * AIDev-POP Scanner — Diff-Only Gate Analysis
 * =============================================
 *
 * Scans real agent PRs from the AIDev dataset through verify's gates.
 * Diff-only mode: no repo cloning, uses only gates that work on edits alone.
 *
 * Gates tested (10 of 26):
 *   security, containment (G5), access, temporal, propagation,
 *   state, capacity, contention, observation, F9 (partial)
 *
 * Usage:
 *   bun scripts/scan/aidev-scanner.ts [--limit=100] [--agent=devin]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// We'll read parquet via a Python subprocess since parquet-wasm is complex
// Simpler: convert parquet to JSONL first, then scan

const DATA_DIR = join(import.meta.dir, '../../data/aidev-pop');
const OUTPUT_DIR = join(import.meta.dir, '../../data/aidev-scan');

interface CommitDetail {
  sha: string;
  pr_id: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

interface PRInfo {
  pr_id: string;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  user_login: string;
  agent?: string;
  repo_full_name: string;
  created_at: string;
}

interface ScanResult {
  pr_id: string;
  agent: string;
  repo: string;
  title: string;
  editCount: number;
  gateResults: Array<{
    gate: string;
    passed: boolean;
    detail: string;
  }>;
  findings: string[];
  duration_ms: number;
}

// =============================================================================
// PARQUET → JSONL CONVERSION (via Python — simplest cross-platform approach)
// =============================================================================

async function convertParquetToJSONL(parquetFile: string, jsonlFile: string, columns?: string[]): Promise<void> {
  if (existsSync(jsonlFile)) {
    console.log(`  ${jsonlFile} already exists, skipping conversion`);
    return;
  }

  const colFilter = columns ? `[${columns.map(c => `"${c}"`).join(',')}]` : 'None';
  const script = `
import pandas as pd
import json
import sys

df = pd.read_parquet("${parquetFile.replace(/\\/g, '/')}", columns=${colFilter})
with open("${jsonlFile.replace(/\\/g, '/')}", 'w') as f:
    for _, row in df.iterrows():
        f.write(json.dumps(row.to_dict(), default=str) + '\\n')
print(f"Converted {len(df)} rows")
`;

  // Try python then python3
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const proc = Bun.spawn([pythonCmd, '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (code !== 0) throw new Error(`Python conversion failed: ${err}`);
  console.log('  ' + out.trim());
}

// =============================================================================
// SCANNER — Run verify gates on parsed diffs
// =============================================================================

async function scanPR(
  patches: CommitDetail[],
  prInfo: PRInfo,
  verify: any,
  parseDiff: any,
  tmpDir: string,
): Promise<ScanResult> {
  const start = Date.now();

  // Reconstruct unified diff from patches
  const diffs = patches
    .filter(p => p.patch && p.status !== 'removed')
    .map(p => {
      // Build a minimal unified diff header
      const isNew = p.status === 'added';
      const header = isNew
        ? `diff --git a/${p.filename} b/${p.filename}\nnew file mode 100644\n--- /dev/null\n+++ b/${p.filename}\n`
        : `diff --git a/${p.filename} b/${p.filename}\n--- a/${p.filename}\n+++ b/${p.filename}\n`;
      return header + p.patch;
    })
    .join('\n');

  if (!diffs) {
    return {
      pr_id: prInfo.pr_id,
      agent: prInfo.agent ?? 'unknown',
      repo: prInfo.repo_full_name,
      title: prInfo.title?.substring(0, 100) ?? '',
      editCount: 0,
      gateResults: [],
      findings: [],
      duration_ms: Date.now() - start,
    };
  }

  // Parse diff into edits
  let edits;
  try {
    edits = parseDiff(diffs);
  } catch {
    return {
      pr_id: prInfo.pr_id,
      agent: prInfo.agent ?? 'unknown',
      repo: prInfo.repo_full_name,
      title: prInfo.title?.substring(0, 100) ?? '',
      editCount: 0,
      gateResults: [],
      findings: ['parse_error'],
      duration_ms: Date.now() - start,
    };
  }

  if (edits.length === 0) {
    return {
      pr_id: prInfo.pr_id,
      agent: prInfo.agent ?? 'unknown',
      repo: prInfo.repo_full_name,
      title: prInfo.title?.substring(0, 100) ?? '',
      editCount: 0,
      gateResults: [],
      findings: [],
      duration_ms: Date.now() - start,
    };
  }

  // Create a minimal temp dir for this PR (no repo needed for diff-only gates)
  const prDir = join(tmpDir, prInfo.pr_id);
  mkdirSync(prDir, { recursive: true });

  // Write the files that the edits reference so security/containment gates can scan them
  for (const edit of edits) {
    try {
      const filePath = join(prDir, edit.file);
      const { dirname } = await import('path');
      mkdirSync(dirname(filePath), { recursive: true });
      // Write search + replace content so the file has both pre and post edit content
      const content = (edit.search || '') + '\n' + (edit.replace || '');
      writeFileSync(filePath, content);
    } catch { /* skip files with problematic paths */ }
  }

  // Run verify with diff-only gates (F9 disabled — without real repo it's just testing our synthetic files)
  try {
    const result = await verify(edits, [], {
      appDir: prDir,
      gates: {
        grounding: false,    // needs real repo
        syntax: false,       // needs real repo files for search string matching
        staging: false,       // needs Docker
        browser: false,       // needs Playwright
        http: false,          // needs running app
        invariants: false,    // needs running app
        vision: false,        // needs screenshots
      },
    });

    const findings: string[] = [];
    const gateResults = result.gates.map((g: any) => {
      if (!g.passed) findings.push(`${g.gate}: ${g.detail?.substring(0, 100)}`);
      return { gate: g.gate, passed: g.passed, detail: g.detail?.substring(0, 200) ?? '' };
    });

    // Cleanup
    try { Bun.spawn(['rm', '-rf', prDir]); } catch {}

    return {
      pr_id: prInfo.pr_id,
      agent: prInfo.agent ?? 'unknown',
      repo: prInfo.repo_full_name,
      title: prInfo.title?.substring(0, 100) ?? '',
      editCount: edits.length,
      gateResults,
      findings,
      duration_ms: Date.now() - start,
    };
  } catch (err: any) {
    try { Bun.spawn(['rm', '-rf', prDir]); } catch {}
    return {
      pr_id: prInfo.pr_id,
      agent: prInfo.agent ?? 'unknown',
      repo: prInfo.repo_full_name,
      title: prInfo.title?.substring(0, 100) ?? '',
      editCount: edits.length,
      gateResults: [],
      findings: [`crash: ${err.message?.substring(0, 100)}`],
      duration_ms: Date.now() - start,
    };
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const agentArg = args.find(a => a.startsWith('--agent='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 100;
  const agentFilter = agentArg ? agentArg.split('=')[1] : undefined;

  console.log('═══ AIDev-POP Scanner — Diff-Only Gate Analysis ═══');
  console.log(`  Limit: ${limit} PRs`);
  if (agentFilter) console.log(`  Agent filter: ${agentFilter}`);
  console.log();

  // Check data files exist
  const detailsParquet = join(DATA_DIR, 'pr_commit_details.parquet');
  const prParquet = join(DATA_DIR, 'pull_request.parquet');

  if (!existsSync(detailsParquet)) {
    console.error('Missing: ' + detailsParquet);
    console.error('Download from: https://huggingface.co/datasets/hao-li/AIDev');
    process.exit(1);
  }
  if (!existsSync(prParquet)) {
    console.error('Missing: ' + prParquet);
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1: Convert parquet to JSONL (one-time)
  console.log('[1/4] Converting parquet to JSONL...');
  const detailsJSONL = join(DATA_DIR, 'pr_commit_details.jsonl');
  const prJSONL = join(DATA_DIR, 'pull_request.jsonl');

  await convertParquetToJSONL(detailsParquet, detailsJSONL, ['sha', 'pr_id', 'filename', 'status', 'additions', 'deletions', 'changes', 'patch']);
  await convertParquetToJSONL(prParquet, prJSONL, ['id', 'number', 'title', 'body', 'agent', 'user', 'state', 'created_at', 'repo_url', 'html_url']);

  // Step 2: Load PR metadata — only the 33K POP subset (small, ~16MB parquet)
  console.log('\n[2/4] Loading PR metadata...');
  const prMap = new Map<string, PRInfo>();
  const agentCounts: Record<string, number> = {};

  // Stream line by line using Bun's file reader
  const prFile = Bun.file(prJSONL);
  const prText = await prFile.text();
  for (const line of prText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      const pr: PRInfo = {
        pr_id: String(raw.id ?? raw.pr_id ?? ''),
        title: raw.title ?? '',
        body: raw.body ?? '',
        state: raw.state ?? '',
        merged: raw.state === 'closed' && !!raw.merged_at,
        user_login: raw.user ?? raw.user_login ?? '',
        agent: raw.agent ?? 'unknown',
        repo_full_name: raw.repo_url?.replace('https://api.github.com/repos/', '') ?? raw.repo_full_name ?? '',
        created_at: raw.created_at ?? '',
      };
      prMap.set(pr.pr_id, pr);
      agentCounts[pr.agent!] = (agentCounts[pr.agent!] ?? 0) + 1;
    } catch {}
  }
  console.log(`  Loaded ${prMap.size} PRs`);
  console.log('  By agent:', Object.entries(agentCounts).map(([a, c]) => `${a}: ${c}`).join(', '));

  // Step 3: Stream commit details, collect only patches for PRs we'll scan
  console.log('\n[3/4] Scanning PRs...');

  // Import verify
  const { verify } = await import('../../src/verify.js');
  const { parseDiff } = await import('../../src/parsers/git-diff.js');

  const tmpDir = join(OUTPUT_DIR, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  // First pass: find which PR IDs exist in the details file (streaming, stop early)
  // Read line-by-line to avoid loading 711K rows into memory
  console.log('  Streaming commit details to find scannable PRs...');
  const patchesByPR = new Map<string, CommitDetail[]>();
  const targetPRIds = new Set<string>();
  let detailsRead = 0;

  const detailFile = Bun.file(detailsJSONL);
  const detailStream = detailFile.stream();
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of detailStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      detailsRead++;
      try {
        const detail = JSON.parse(line) as CommitDetail;
        if (!detail.patch) continue;
        const prId = String(detail.pr_id);

        // Only keep if this PR is in our POP subset
        if (!prMap.has(prId)) continue;

        // Agent filter
        if (agentFilter && prMap.get(prId)!.agent !== agentFilter) continue;

        if (!patchesByPR.has(prId)) patchesByPR.set(prId, []);
        patchesByPR.get(prId)!.push(detail);
        targetPRIds.add(prId);
      } catch {}

      // Stop early once we have enough PRs
      if (targetPRIds.size >= limit * 2) break; // collect 2x to have buffer after filtering
    }
    if (targetPRIds.size >= limit * 2) break;

    if (detailsRead % 100000 === 0) {
      console.log(`    ${detailsRead} rows read, ${targetPRIds.size} PRs collected...`);
    }
  }
  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const detail = JSON.parse(buffer) as CommitDetail;
      if (detail.patch) {
        const prId = String(detail.pr_id);
        if (prMap.has(prId)) {
          if (!patchesByPR.has(prId)) patchesByPR.set(prId, []);
          patchesByPR.get(prId)!.push(detail);
          targetPRIds.add(prId);
        }
      }
    } catch {}
  }

  console.log(`  ${detailsRead} rows streamed, ${patchesByPR.size} PRs have patches`);

  // Filter by agent and limit
  let prIds = [...patchesByPR.keys()].filter(id => {
    const pr = prMap.get(id);
    if (!pr) return false;
    if (agentFilter && pr.agent !== agentFilter) return false;
    return true;
  });

  if (prIds.length > limit) prIds = prIds.slice(0, limit);
  console.log(`  Scanning ${prIds.length} PRs...`);
  console.log();

  // Scan
  const results: ScanResult[] = [];
  const gateFireCounts: Record<string, number> = {};
  const gatePassCounts: Record<string, number> = {};
  let totalWithFindings = 0;

  for (let i = 0; i < prIds.length; i++) {
    const prId = prIds[i];
    const pr = prMap.get(prId)!;
    const patches = patchesByPR.get(prId)!;

    const result = await scanPR(patches, pr, verify, parseDiff, tmpDir);
    results.push(result);

    for (const g of result.gateResults) {
      gateFireCounts[g.gate] = (gateFireCounts[g.gate] ?? 0) + 1;
      if (g.passed) gatePassCounts[g.gate] = (gatePassCounts[g.gate] ?? 0) + 1;
    }

    if (result.findings.length > 0) totalWithFindings++;

    if ((i + 1) % 10 === 0 || i === prIds.length - 1) {
      const pct = ((i + 1) / prIds.length * 100).toFixed(0);
      const findRate = (totalWithFindings / (i + 1) * 100).toFixed(1);
      console.log(`  [${pct}%] ${i + 1}/${prIds.length} scanned | ${totalWithFindings} with findings (${findRate}%)`);
    }
  }

  // Step 4: Report
  console.log('\n[4/4] Results');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  PRs scanned: ${results.length}`);
  console.log(`  PRs with findings: ${totalWithFindings} (${(totalWithFindings / results.length * 100).toFixed(1)}%)`);
  console.log();

  console.log('  Gate fire rates:');
  for (const [gate, count] of Object.entries(gateFireCounts).sort((a, b) => b[1] - a[1])) {
    const passCount = gatePassCounts[gate] ?? 0;
    const failCount = count - passCount;
    const failRate = (failCount / count * 100).toFixed(1);
    console.log(`    ${gate.padEnd(16)} ${count} ran, ${failCount} failed (${failRate}%)`);
  }

  console.log();

  // Per-agent breakdown
  const agentResults: Record<string, { total: number; withFindings: number }> = {};
  for (const r of results) {
    if (!agentResults[r.agent]) agentResults[r.agent] = { total: 0, withFindings: 0 };
    agentResults[r.agent].total++;
    if (r.findings.length > 0) agentResults[r.agent].withFindings++;
  }

  console.log('  Per-agent failure rates:');
  for (const [agent, data] of Object.entries(agentResults).sort((a, b) => b[1].total - a[1].total)) {
    const rate = (data.withFindings / data.total * 100).toFixed(1);
    console.log(`    ${agent.padEnd(12)} ${data.total} PRs, ${data.withFindings} with findings (${rate}%)`);
  }

  // Save results
  const outputPath = join(OUTPUT_DIR, `scan-${Date.now()}.jsonl`);
  writeFileSync(outputPath, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\n  Results saved to: ${outputPath}`);

  // Save summary
  const summary = {
    timestamp: new Date().toISOString(),
    prsScanned: results.length,
    prsWithFindings: totalWithFindings,
    findingRate: (totalWithFindings / results.length * 100).toFixed(1) + '%',
    gateFireRates: Object.entries(gateFireCounts).map(([gate, count]) => ({
      gate,
      ran: count,
      failed: count - (gatePassCounts[gate] ?? 0),
      failRate: ((count - (gatePassCounts[gate] ?? 0)) / count * 100).toFixed(1) + '%',
    })),
    perAgent: agentResults,
  };
  writeFileSync(join(OUTPUT_DIR, 'scan-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`  Summary saved to: ${join(OUTPUT_DIR, 'scan-summary.json')}`);
}

main().catch(err => {
  console.error('Scanner failed:', err);
  process.exit(1);
});
