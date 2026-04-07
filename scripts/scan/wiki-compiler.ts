/**
 * Wiki Compiler — Auto-Generate Knowledge Pages from Scan Results
 * ================================================================
 *
 * Reads batch JSONL + summary JSON files. Generates markdown pages.
 * Karpathy pattern: the machine writes and maintains its own docs.
 *
 * Usage:
 *   bun scripts/scan/wiki-compiler.ts              — compile all batches
 *   bun scripts/scan/wiki-compiler.ts --batch=Devin-001  — compile one batch
 *
 * Output:
 *   data/wiki/
 *     index.md                 — master index
 *     scans/Devin-001.md       — per-batch report
 *     agents/Devin.md          — per-agent profile (updated each batch)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const BATCH_DIR = join(import.meta.dir, '../../data/aidev-scan/batches');
const WIKI_DIR = join(import.meta.dir, '../../data/wiki');

// =============================================================================
// TYPES
// =============================================================================

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
  highCount: number;
  lowCount: number;
  unknownCount: number;
  duration_ms: number;
}

// =============================================================================
// BATCH REPORT PAGE
// =============================================================================

function generateBatchReport(summaryFile: string, resultsFile: string): string {
  const summary: BatchSummary = JSON.parse(readFileSync(summaryFile, 'utf-8'));
  const results: PRResult[] = readFileSync(resultsFile, 'utf-8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

  const lines: string[] = [];
  const date = summary.timestamp.split('T')[0];

  lines.push(`# Scan: ${summary.agent} Batch ${summary.batchNumber}`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Date | ${date} |`);
  lines.push(`| Agent | ${summary.agent} |`);
  lines.push(`| PRs scanned | ${summary.prsScanned} |`);
  lines.push(`| PRs with findings | ${summary.prsWithFindings} (${summary.findingRate}) |`);
  lines.push(`| High confidence | ${results.reduce((a, r) => a + r.highCount, 0)} |`);
  lines.push(`| Low confidence (known FP) | ${results.reduce((a, r) => a + r.lowCount, 0)} |`);
  lines.push(`| Unknown (needs review) | ${summary.unknowns.length} |`);
  lines.push('');

  // Gate fire rates
  lines.push('## Gate Fire Rates');
  lines.push('');
  lines.push('| Gate | Ran | Failed | Rate | High | Low | Unknown |');
  lines.push('|------|-----|--------|------|------|-----|---------|');
  for (const [gate, stats] of Object.entries(summary.gateStats).sort((a, b) => b[1].failed - a[1].failed)) {
    if (stats.failed === 0) continue;
    const rate = (stats.failed / stats.ran * 100).toFixed(1);
    lines.push(`| ${gate} | ${stats.ran} | ${stats.failed} | ${rate}% | ${stats.high} | ${stats.low} | ${stats.unknown} |`);
  }
  lines.push('');

  // Notable findings (high confidence)
  const highFindings = results
    .filter(r => r.highCount > 0)
    .sort((a, b) => b.highCount - a.highCount)
    .slice(0, 10);

  if (highFindings.length > 0) {
    lines.push('## Notable Findings (High Confidence)');
    lines.push('');
    for (const r of highFindings) {
      const gates = r.findings
        .filter(f => f.classification.confidence === 'high')
        .map(f => f.gate)
        .join(', ');
      lines.push(`- **${r.repo}** — ${r.title} (${gates})`);
    }
    lines.push('');
  }

  // Unknowns
  if (summary.unknowns.length > 0) {
    lines.push('## Unknowns (Needs Review)');
    lines.push('');
    lines.push('| PR | Gate | File | Detail |');
    lines.push('|----|------|------|--------|');
    for (const u of summary.unknowns) {
      lines.push(`| ${u.pr_id} | ${u.gate} | ${u.file} | ${u.detail.substring(0, 60)} |`);
    }
    lines.push('');
  }

  // Top repos by findings
  const repoFindings: Record<string, number> = {};
  for (const r of results) {
    if (r.highCount > 0) {
      repoFindings[r.repo] = (repoFindings[r.repo] ?? 0) + r.highCount;
    }
  }
  const topRepos = Object.entries(repoFindings).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topRepos.length > 0) {
    lines.push('## Top Repos by High-Confidence Findings');
    lines.push('');
    for (const [repo, count] of topRepos) {
      lines.push(`- ${repo}: ${count} finding(s)`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Generated by wiki-compiler.ts on ${new Date().toISOString().split('T')[0]}*`);

  return lines.join('\n');
}

// =============================================================================
// AGENT PROFILE PAGE
// =============================================================================

function generateAgentProfile(agent: string, batchFiles: string[]): string {
  const lines: string[] = [];
  let totalScanned = 0, totalWithFindings = 0;
  const allGateStats: Record<string, { ran: number; failed: number; high: number; low: number; unknown: number }> = {};
  const allRepos = new Set<string>();
  const batchSummaries: BatchSummary[] = [];

  for (const sf of batchFiles) {
    const summary: BatchSummary = JSON.parse(readFileSync(sf, 'utf-8'));
    batchSummaries.push(summary);
    totalScanned += summary.prsScanned;
    totalWithFindings += summary.prsWithFindings;

    for (const [gate, stats] of Object.entries(summary.gateStats)) {
      if (!allGateStats[gate]) allGateStats[gate] = { ran: 0, failed: 0, high: 0, low: 0, unknown: 0 };
      allGateStats[gate].ran += stats.ran;
      allGateStats[gate].failed += stats.failed;
      allGateStats[gate].high += stats.high;
      allGateStats[gate].low += stats.low;
      allGateStats[gate].unknown += stats.unknown;
    }
  }

  // Read all result files for repo list
  for (const sf of batchFiles) {
    const resultsFile = sf.replace('-summary.json', '.jsonl');
    if (!existsSync(resultsFile)) continue;
    const results: PRResult[] = readFileSync(resultsFile, 'utf-8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    for (const r of results) {
      if (r.repo) allRepos.add(r.repo);
    }
  }

  const findingRate = totalScanned > 0 ? (totalWithFindings / totalScanned * 100).toFixed(1) : '0';
  const totalHigh = Object.values(allGateStats).reduce((a, s) => a + s.high, 0);
  const adjustedRate = totalScanned > 0 ? (totalHigh / totalScanned * 100).toFixed(1) : '0';

  lines.push(`# Agent Profile: ${agent}`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| PRs scanned | ${totalScanned} |`);
  lines.push(`| Finding rate (raw) | ${findingRate}% |`);
  lines.push(`| Finding rate (high confidence only) | ${adjustedRate}% |`);
  lines.push(`| Batches completed | ${batchSummaries.length} |`);
  lines.push(`| Repos covered | ${allRepos.size} |`);
  lines.push('');

  // Gate breakdown
  lines.push('## Failure Patterns');
  lines.push('');
  lines.push('| Gate | Failed | Rate | High | Low (FP) | Unknown |');
  lines.push('|------|--------|------|------|----------|---------|');
  for (const [gate, stats] of Object.entries(allGateStats).sort((a, b) => b[1].failed - a[1].failed)) {
    if (stats.failed === 0) continue;
    const rate = (stats.failed / stats.ran * 100).toFixed(1);
    lines.push(`| ${gate} | ${stats.failed} | ${rate}% | ${stats.high} | ${stats.low} | ${stats.unknown} |`);
  }
  lines.push('');

  // Batch history
  lines.push('## Batch History');
  lines.push('');
  lines.push('| Batch | Date | PRs | Findings | Rate |');
  lines.push('|-------|------|-----|----------|------|');
  for (const s of batchSummaries) {
    const date = s.timestamp.split('T')[0];
    lines.push(`| ${s.batchNumber} | ${date} | ${s.prsScanned} | ${s.prsWithFindings} | ${s.findingRate} |`);
  }
  lines.push('');

  lines.push('---');
  lines.push(`*Auto-generated by wiki-compiler.ts. Updated ${new Date().toISOString().split('T')[0]}.*`);

  return lines.join('\n');
}

// =============================================================================
// INDEX PAGE
// =============================================================================

function generateIndex(agents: string[], batchCount: number, totalPRs: number): string {
  const lines: string[] = [];

  lines.push('# AIDev-POP Scan Wiki');
  lines.push('');
  lines.push(`Scanning ${totalPRs.toLocaleString()} real agent PRs through verify\'s 26-gate pipeline.`);
  lines.push('');
  lines.push('## Agent Profiles');
  lines.push('');
  for (const agent of agents) {
    lines.push(`- [${agent}](agents/${agent}.md)`);
  }
  lines.push('');
  lines.push('## Batch Reports');
  lines.push('');

  // List batch report files
  if (existsSync(join(WIKI_DIR, 'scans'))) {
    const scanFiles = readdirSync(join(WIKI_DIR, 'scans')).filter(f => f.endsWith('.md')).sort();
    for (const f of scanFiles) {
      const name = f.replace('.md', '');
      lines.push(`- [${name}](scans/${f})`);
    }
  }
  lines.push('');

  lines.push('## Gate Calibration Shapes');
  lines.push('');
  lines.push('| Shape | Pattern | Status |');
  lines.push('|-------|---------|--------|');
  lines.push('| GC-651 | Contention gate on frontend files | Fixed |');
  lines.push('| GC-652 | Access gate on type definitions | Fixed |');
  lines.push('| GC-653 | Access gate on config/infra files | Fixed (classifier) |');
  lines.push('');

  lines.push('---');
  lines.push(`*Auto-generated by wiki-compiler.ts. Updated ${new Date().toISOString().split('T')[0]}.*`);

  return lines.join('\n');
}

// =============================================================================
// MAIN
// =============================================================================

function compile() {
  if (!existsSync(BATCH_DIR)) {
    console.log('No batch results found in', BATCH_DIR);
    process.exit(1);
  }

  mkdirSync(join(WIKI_DIR, 'scans'), { recursive: true });
  mkdirSync(join(WIKI_DIR, 'agents'), { recursive: true });

  // Find all batch summary files
  const summaryFiles = readdirSync(BATCH_DIR)
    .filter(f => f.endsWith('-summary.json'))
    .map(f => join(BATCH_DIR, f))
    .sort();

  if (summaryFiles.length === 0) {
    console.log('No batch summaries found');
    process.exit(1);
  }

  console.log(`Compiling wiki from ${summaryFiles.length} batch(es)...\n`);

  const agents = new Set<string>();
  let totalPRs = 0;

  // Generate batch report pages
  for (const sf of summaryFiles) {
    const summary: BatchSummary = JSON.parse(readFileSync(sf, 'utf-8'));
    const batchName = basename(sf).replace('-summary.json', '');
    const resultsFile = sf.replace('-summary.json', '.jsonl');

    agents.add(summary.agent);
    totalPRs += summary.prsScanned;

    if (existsSync(resultsFile)) {
      const report = generateBatchReport(sf, resultsFile);
      writeFileSync(join(WIKI_DIR, 'scans', `${batchName}.md`), report);
      console.log(`  Generated: scans/${batchName}.md`);
    }
  }

  // Generate agent profile pages
  for (const agent of agents) {
    const agentBatches = summaryFiles.filter(f => {
      const s: BatchSummary = JSON.parse(readFileSync(f, 'utf-8'));
      return s.agent === agent;
    });

    const profile = generateAgentProfile(agent, agentBatches);
    writeFileSync(join(WIKI_DIR, 'agents', `${agent}.md`), profile);
    console.log(`  Generated: agents/${agent}.md`);
  }

  // Generate cross-agent comparison
  const comparison = generateComparison(summaryFiles);
  writeFileSync(join(WIKI_DIR, 'comparison.md'), comparison);
  console.log(`  Generated: comparison.md`);

  // Generate index
  const index = generateIndex([...agents].sort(), summaryFiles.length, totalPRs);
  writeFileSync(join(WIKI_DIR, 'index.md'), index);
  console.log(`  Generated: index.md`);

  console.log(`\nWiki compiled: ${WIKI_DIR}`);
}

// =============================================================================
// CROSS-AGENT COMPARISON PAGE
// =============================================================================

function generateComparison(summaryFiles: string[]): string {
  const lines: string[] = [];

  // Aggregate per agent
  const agentData: Record<string, {
    prs: number;
    findings: number;
    high: number;
    low: number;
    unknown: number;
    gates: Record<string, { ran: number; failed: number; high: number }>;
  }> = {};

  for (const sf of summaryFiles) {
    const s: BatchSummary = JSON.parse(readFileSync(sf, 'utf-8'));
    if (!agentData[s.agent]) {
      agentData[s.agent] = { prs: 0, findings: 0, high: 0, low: 0, unknown: 0, gates: {} };
    }
    const a = agentData[s.agent];
    a.prs += s.prsScanned;
    a.findings += s.prsWithFindings;

    for (const [gate, stats] of Object.entries(s.gateStats)) {
      if (!a.gates[gate]) a.gates[gate] = { ran: 0, failed: 0, high: 0 };
      a.gates[gate].ran += stats.ran;
      a.gates[gate].failed += stats.failed;
      a.gates[gate].high += stats.high;
    }
  }

  // Compute totals from results files
  for (const sf of summaryFiles) {
    const s: BatchSummary = JSON.parse(readFileSync(sf, 'utf-8'));
    const resultsFile = sf.replace('-summary.json', '.jsonl');
    if (!existsSync(resultsFile)) continue;
    const results: PRResult[] = readFileSync(resultsFile, 'utf-8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const a = agentData[s.agent];
    a.high += results.reduce((sum, r) => sum + r.highCount, 0);
    a.low += results.reduce((sum, r) => sum + r.lowCount, 0);
    a.unknown += results.reduce((sum, r) => sum + r.unknownCount, 0);
  }

  const totalPRs = Object.values(agentData).reduce((a, d) => a + d.prs, 0);
  const totalFindings = Object.values(agentData).reduce((a, d) => a + d.findings, 0);

  lines.push('# Cross-Agent Reliability Comparison');
  lines.push('');
  lines.push(`Based on ${totalPRs.toLocaleString()} real agent PRs from the AIDev-POP dataset.`);
  lines.push('');

  // Main comparison table
  lines.push('## Structural Finding Rates');
  lines.push('');
  lines.push('| Agent | PRs | Raw Finding Rate | High-Confidence Rate | Top Failure Pattern |');
  lines.push('|-------|-----|-----------------|---------------------|---------------------|');

  // Sort by high-confidence rate descending
  const sorted = Object.entries(agentData).sort((a, b) => {
    const rateA = a[1].high / a[1].prs;
    const rateB = b[1].high / b[1].prs;
    return rateB - rateA;
  });

  for (const [agent, data] of sorted) {
    const rawRate = (data.findings / data.prs * 100).toFixed(1);
    const highRate = (data.high / data.prs * 100).toFixed(1);
    // Find top gate
    const topGate = Object.entries(data.gates)
      .filter(([_, s]) => s.high > 0)
      .sort((a, b) => b[1].high - a[1].high)[0];
    const topPattern = topGate ? `${topGate[0]} (${topGate[1].high})` : 'none';
    lines.push(`| ${agent} | ${data.prs} | ${rawRate}% | ${highRate}% | ${topPattern} |`);
  }
  lines.push('');

  // Per-gate comparison
  lines.push('## Per-Gate Failure Rates (High Confidence Only)');
  lines.push('');

  const allGates = new Set<string>();
  for (const data of Object.values(agentData)) {
    for (const gate of Object.keys(data.gates)) allGates.add(gate);
  }

  const gateHeader = ['| Gate |', ...sorted.map(([a]) => ` ${a} |`)].join('');
  const gateSep = ['|------|', ...sorted.map(() => '------|')].join('');
  lines.push(gateHeader);
  lines.push(gateSep);

  for (const gate of [...allGates].sort()) {
    const hasFindings = sorted.some(([_, d]) => (d.gates[gate]?.high ?? 0) > 0);
    if (!hasFindings) continue;
    const cells = sorted.map(([_, d]) => {
      const stats = d.gates[gate];
      if (!stats || stats.high === 0) return ' — |';
      const rate = (stats.high / stats.ran * 100).toFixed(1);
      return ` ${rate}% (${stats.high}) |`;
    });
    lines.push(`| ${gate} |${cells.join('')}`);
  }
  lines.push('');

  // Key insights
  lines.push('## Key Insights');
  lines.push('');
  lines.push('- **Agents fail differently.** Each agent has a distinct structural failure signature.');
  lines.push(`- **Overall:** ${(totalFindings / totalPRs * 100).toFixed(1)}% of agent PRs have structural findings (${totalPRs.toLocaleString()} PRs scanned).`);

  const highTotal = Object.values(agentData).reduce((a, d) => a + d.high, 0);
  lines.push(`- **High confidence:** ${(highTotal / totalPRs * 100).toFixed(1)}% of PRs have high-confidence structural issues.`);

  // Agent-specific insights
  for (const [agent, data] of sorted) {
    const topGate = Object.entries(data.gates)
      .filter(([_, s]) => s.high > 0)
      .sort((a, b) => b[1].high - a[1].high)[0];
    if (topGate) {
      lines.push(`- **${agent}:** top issue is ${topGate[0]} (${topGate[1].high} high-confidence findings across ${data.prs} PRs).`);
    }
  }
  lines.push('');

  lines.push('---');
  lines.push(`*Auto-generated by wiki-compiler.ts from ${summaryFiles.length} batches. Updated ${new Date().toISOString().split('T')[0]}.*`);
  lines.push('*Dataset: [AIDev-POP](https://huggingface.co/datasets/hao-li/AIDev) — real agent PRs from popular open-source repos.*');

  return lines.join('\n');
}

compile();
