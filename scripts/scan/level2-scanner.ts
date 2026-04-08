/**
 * Level 2 Scanner — Repo-Aware Gate Scanning
 * =============================================
 *
 * Clones real repos, checks out the pre-agent commit, and runs verify
 * with grounding + F9 + auto-generated predicates from the file tree.
 *
 * Level 1 ran 10 gates on diffs. Level 2 runs 18-20 gates on real code.
 * Cost: $0 — all gates are deterministic, no LLM calls.
 *
 * Usage:
 *   bun scripts/scan/level2-scanner.ts --top=100
 *   bun scripts/scan/level2-scanner.ts --repo=calcom/cal.com
 *   bun scripts/scan/level2-scanner.ts --resume
 *   bun scripts/scan/level2-scanner.ts --all
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { classifyFinding, type FindingClassification, type ScanFinding } from './classifier.js';

const DATA_DIR = join(import.meta.dir, '../../data/aidev-pop');
const OUTPUT_DIR = join(import.meta.dir, '../../data/aidev-scan/level2');
const BATCH_DIR = join(OUTPUT_DIR, 'batches');
const CHECKPOINT_FILE = join(OUTPUT_DIR, 'checkpoint.json');
const CLONE_BASE = join(tmpdir(), 'verify-l2');
const COOLDOWN_MS = 10_000; // 10s between repos — thermal management

// =============================================================================
// TYPES
// =============================================================================

interface PRRecord {
  id: string;
  agent: string;
  repo: string;       // owner/name
  title: string;
  repoUrl: string;    // https://github.com/owner/name
}

interface CommitInfo {
  sha: string;
  filename: string;
  patch: string;
  status: string;
}

interface Checkpoint {
  completedRepos: string[];
  totalPRsScanned: number;
  totalPRsSkipped: number;
  timestamp: string;
}

interface RepoSummary {
  timestamp: string;
  repo: string;
  prCount: number;
  prsScanned: number;
  prsSkipped: number;
  prsWithFindings: number;
  findingRate: string;
  highConfidenceRate: string;
  gateStats: Record<string, { ran: number; failed: number; high: number; low: number; unknown: number }>;
  newGatesVsLevel1: { grounding: number; syntax: number; filesystem: number; serialization: number; security: number; a11y: number; performance: number };
}

// =============================================================================
// CHECKPOINT — crash-safe resume
// =============================================================================

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
  }
  return { completedRepos: [], totalPRsScanned: 0, totalPRsSkipped: 0, timestamp: '' };
}

function saveCheckpoint(cp: Checkpoint): void {
  cp.timestamp = new Date().toISOString();
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// =============================================================================
// DATA LOADING — group PRs by repo
// =============================================================================

function loadPRsByRepo(filterRepo?: string): Map<string, PRRecord[]> {
  const prJSONL = join(DATA_DIR, 'pull_request.jsonl');
  const prText = readFileSync(prJSONL, 'utf-8');
  const repoMap = new Map<string, PRRecord[]>();

  for (const line of prText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      const repo = (raw.repo_url ?? '').replace('https://api.github.com/repos/', '');
      if (filterRepo && repo !== filterRepo) continue;
      if (!repo) continue;

      const repoUrl = `https://github.com/${repo}`;
      if (!repoMap.has(repo)) repoMap.set(repo, []);
      repoMap.get(repo)!.push({
        id: String(raw.id),
        agent: raw.agent ?? 'unknown',
        repo,
        title: (raw.title ?? '').substring(0, 100),
        repoUrl,
      });
    } catch {}
  }

  return repoMap;
}

/**
 * Stream commit details for a set of PR IDs.
 * Returns map of pr_id → CommitInfo[] (earliest commit first).
 */
async function loadCommitsForPRs(prIds: Set<string>): Promise<Map<string, CommitInfo[]>> {
  const detailsJSONL = join(DATA_DIR, 'pr_commit_details.jsonl');
  const file = Bun.file(detailsJSONL);
  const stream = file.stream();
  const decoder = new TextDecoder();
  let buffer = '';

  const commitsByPR = new Map<string, CommitInfo[]>();

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const prId = String(d.pr_id);
        if (!prIds.has(prId)) continue;

        if (!commitsByPR.has(prId)) commitsByPR.set(prId, []);
        commitsByPR.get(prId)!.push({
          sha: d.sha,
          filename: d.filename,
          status: d.status,
          patch: d.patch ?? '',
        });
      } catch {}
    }
  }

  return commitsByPR;
}

// =============================================================================
// REPO CLONER
// =============================================================================

function cloneRepo(repoUrl: string, targetDir: string): boolean {
  try {
    // Full clone — we need history to resolve sha~1
    execSync(`git clone --quiet "${repoUrl}.git" "${targetDir}"`, {
      timeout: 300_000,  // 5 min max per clone
      stdio: 'pipe',
    });
    return true;
  } catch (err: any) {
    console.error(`  ✗ Clone failed: ${err.message?.substring(0, 100)}`);
    return false;
  }
}

function checkoutParent(repoDir: string, commitSha: string): boolean {
  try {
    execSync(`git checkout --quiet "${commitSha}~1"`, {
      cwd: repoDir,
      timeout: 30_000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function cleanupRepo(repoDir: string): void {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
}

// =============================================================================
// AUTO-PREDICATE GENERATOR — wakes up dormant gates
// =============================================================================

function generatePredicates(appDir: string, edits: Array<{ file: string; search: string; replace: string }>): any[] {
  const predicates: any[] = [];

  // filesystem_exists — every file the agent modifies should exist pre-edit
  for (const edit of edits) {
    if (edit.search) {  // modified file, not new
      predicates.push({ type: 'filesystem_exists', file: edit.file });
    }
  }

  // serialization — if agent edits JSON/YAML, validate structure
  for (const edit of edits) {
    const lower = edit.file.toLowerCase();
    if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      predicates.push({ type: 'serialization', file: edit.file, comparison: 'structural' });
    }
  }

  // security — auto-generate for code files
  const codeExts = new Set(['js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'php', 'mjs', 'cjs', 'jsx', 'tsx']);
  if (edits.some(e => codeExts.has(e.file.split('.').pop()?.toLowerCase() ?? ''))) {
    predicates.push(
      { type: 'security', securityCheck: 'secrets_in_code', expected: 'no_findings' },
      { type: 'security', securityCheck: 'xss', expected: 'no_findings' },
      { type: 'security', securityCheck: 'sql_injection', expected: 'no_findings' },
    );
  }

  // a11y — if HTML files edited
  if (edits.some(e => /\.html?$/i.test(e.file))) {
    predicates.push({ type: 'a11y', a11yCheck: 'alt_text' });
  }

  // performance — if package.json edited (bundle size concern)
  if (edits.some(e => e.file === 'package.json' || e.file.endsWith('/package.json'))) {
    predicates.push({ type: 'performance', perfCheck: 'bundle_size' });
  }

  // config — if config files edited
  const configFiles = ['.env', '.env.local', 'tsconfig.json', 'webpack.config.js', 'vite.config.ts', 'next.config.js'];
  if (edits.some(e => configFiles.some(c => e.file.endsWith(c)))) {
    predicates.push({ type: 'config' });
  }

  return predicates;
}

// =============================================================================
// GATE CONFIG — Level 2 enables grounding + F9
// =============================================================================

const LEVEL2_GATES = {
  // NOW ENABLED — real repo files available
  grounding: true,
  syntax: true,

  // Still enabled from Level 1 (fire on edits + predicates)
  // access, temporal, propagation, state, capacity, contention,
  // observation, K5, G5, security, filesystem, serialization,
  // config, a11y, performance, triangulation, narrowing

  // Still disabled — need live running app (Level 3)
  staging: false,
  browser: false,
  http: false,
  invariants: false,
  vision: false,
};

// =============================================================================
// SCAN ONE PR
// =============================================================================

async function scanPR(
  pr: PRRecord,
  commits: CommitInfo[],
  repoDir: string,
  verify: Function,
  parseDiff: Function,
): Promise<{ result: any; skipped: boolean; skipReason?: string }> {

  // Get earliest commit SHA for this PR
  const uniqueShas = [...new Set(commits.map(c => c.sha))];
  const earliestSha = uniqueShas[0]; // first in file order = earliest

  if (!earliestSha) {
    return { result: null, skipped: true, skipReason: 'no_commit_sha' };
  }

  // Checkout parent of earliest commit (pre-agent state)
  if (!checkoutParent(repoDir, earliestSha)) {
    return { result: null, skipped: true, skipReason: 'checkout_failed' };
  }

  // Reconstruct unified diff from commit patches
  const diff = commits
    .filter(c => c.patch)
    .map(c => {
      const isNew = c.status === 'added';
      const header = isNew
        ? `diff --git a/${c.filename} b/${c.filename}\nnew file mode 100644\n--- /dev/null\n+++ b/${c.filename}\n`
        : `diff --git a/${c.filename} b/${c.filename}\n--- a/${c.filename}\n+++ b/${c.filename}\n`;
      return header + c.patch;
    })
    .join('\n');

  // Parse diff into edits
  let edits;
  try {
    edits = parseDiff(diff);
  } catch {
    return { result: null, skipped: true, skipReason: 'diff_parse_failed' };
  }

  if (edits.length === 0) {
    return { result: null, skipped: true, skipReason: 'no_edits' };
  }

  // Auto-generate predicates from real file tree
  const predicates = generatePredicates(repoDir, edits);

  // Run verify with Level 2 gate config against real repo
  const prStart = Date.now();
  let gateResults: Array<{ gate: string; passed: boolean; detail: string }> = [];
  try {
    const result = await verify(edits, predicates, {
      appDir: repoDir,
      gates: LEVEL2_GATES,
    });
    gateResults = result.gates.map((g: any) => ({
      gate: g.gate,
      passed: g.passed,
      detail: g.detail?.substring(0, 200) ?? '',
    }));
  } catch (err: any) {
    gateResults = [{ gate: 'crash', passed: false, detail: err.message?.substring(0, 100) ?? 'unknown' }];
  }

  // Classify findings
  const failedGates = gateResults.filter(g => !g.passed);
  const findings: any[] = [];
  let highCount = 0, lowCount = 0, unknownCount = 0;

  for (const g of gateResults) {
    if (!g.passed) {
      const fileMatch = g.detail.match(/^([\w/.-]+\.[\w]+)/);
      const file = fileMatch?.[1] ?? edits[0]?.file ?? 'unknown';

      const classification = classifyFinding({
        gate: g.gate,
        file,
        detail: g.detail,
        totalFindingsInPR: failedGates.length,
      });

      findings.push({ ...g, file, classification });

      if (classification.confidence === 'high') highCount++;
      else if (classification.confidence === 'low') lowCount++;
      else unknownCount++;
    }
  }

  return {
    skipped: false,
    result: {
      pr_id: pr.id,
      agent: pr.agent,
      repo: pr.repo,
      title: pr.title,
      editCount: edits.length,
      predicateCount: predicates.length,
      findings,
      highCount,
      lowCount,
      unknownCount,
      duration_ms: Date.now() - prStart,
      gatesRan: gateResults.map(g => g.gate),
    },
  };
}

// =============================================================================
// SCAN ONE REPO — all its PRs
// =============================================================================

async function scanRepo(
  repo: string,
  prs: PRRecord[],
  verify: Function,
  parseDiff: Function,
): Promise<{ summary: RepoSummary; scanned: number; skipped: number }> {
  const repoStart = Date.now();
  const repoSlug = repo.replace(/\//g, '-');
  const repoDir = join(CLONE_BASE, repoSlug);

  console.log(`\n═══ ${repo} (${prs.length} PRs) ═══`);

  // Clean any leftover from previous crash
  cleanupRepo(repoDir);

  // Clone
  const repoUrl = `https://github.com/${repo}`;
  if (!cloneRepo(repoUrl, repoDir)) {
    return {
      summary: emptyRepoSummary(repo, prs.length),
      scanned: 0,
      skipped: prs.length,
    };
  }

  // Load commit data for all PRs in this repo
  const prIds = new Set(prs.map(p => p.id));
  const commitsByPR = await loadCommitsForPRs(prIds);

  // Prepare output file
  mkdirSync(BATCH_DIR, { recursive: true });
  const outputFile = join(BATCH_DIR, `${repoSlug}.jsonl`);
  // Clear previous results for this repo (re-run safe)
  writeFileSync(outputFile, '');

  const gateStats: Record<string, { ran: number; failed: number; high: number; low: number; unknown: number }> = {};
  const newGateHits = { grounding: 0, syntax: 0, filesystem: 0, serialization: 0, security: 0, a11y: 0, performance: 0 };
  let scanned = 0;
  let skipped = 0;
  let withFindings = 0;
  let totalHigh = 0;

  for (const pr of prs) {
    const commits = commitsByPR.get(pr.id);
    if (!commits || commits.length === 0) {
      skipped++;
      continue;
    }

    const { result, skipped: wasSkipped, skipReason } = await scanPR(
      pr, commits, repoDir, verify, parseDiff,
    );

    if (wasSkipped) {
      skipped++;
      continue;
    }

    scanned++;

    // Append to JSONL
    appendFileSync(outputFile, JSON.stringify(result) + '\n');

    // Accumulate gate stats — count every gate that ran
    for (const gate of result.gatesRan) {
      if (!gateStats[gate]) gateStats[gate] = { ran: 0, failed: 0, high: 0, low: 0, unknown: 0 };
      gateStats[gate].ran++;
    }

    // Count failures + classify
    for (const f of result.findings) {
      if (!gateStats[f.gate]) gateStats[f.gate] = { ran: 0, failed: 0, high: 0, low: 0, unknown: 0 };
      gateStats[f.gate].failed++;
      if (f.classification.confidence === 'high') gateStats[f.gate].high++;
      else if (f.classification.confidence === 'low') gateStats[f.gate].low++;
      else gateStats[f.gate].unknown++;

      // Track new gate findings (gates that were dormant in Level 1)
      if (f.gate === 'grounding') newGateHits.grounding++;
      if (f.gate === 'F9') newGateHits.syntax++;
      if (f.gate === 'filesystem') newGateHits.filesystem++;
      if (f.gate === 'serialization') newGateHits.serialization++;
      if (f.gate === 'security') newGateHits.security++;
      if (f.gate === 'a11y') newGateHits.a11y++;
      if (f.gate === 'performance') newGateHits.performance++;
    }

    if (result.findings.length > 0) withFindings++;
    totalHigh += result.highCount;

    // Progress
    if ((scanned + skipped) % 20 === 0) {
      const total = scanned + skipped;
      const pct = (total / prs.length * 100).toFixed(0);
      console.log(`  [${pct}%] ${scanned} scanned, ${skipped} skipped | ${withFindings} with findings`);
    }
  }

  // Cleanup — delete clone immediately
  cleanupRepo(repoDir);

  const summary: RepoSummary = {
    timestamp: new Date().toISOString(),
    repo,
    prCount: prs.length,
    prsScanned: scanned,
    prsSkipped: skipped,
    prsWithFindings: withFindings,
    findingRate: scanned > 0 ? (withFindings / scanned * 100).toFixed(1) + '%' : '0%',
    highConfidenceRate: withFindings > 0 ? (totalHigh / withFindings * 100).toFixed(1) + '%' : '0%',
    gateStats,
    newGatesVsLevel1: newGateHits,
  };

  // Save summary
  writeFileSync(join(BATCH_DIR, `${repoSlug}-summary.json`), JSON.stringify(summary, null, 2));

  // Report
  const duration = ((Date.now() - repoStart) / 1000).toFixed(1);
  console.log(`  Done: ${scanned} scanned, ${skipped} skipped, ${withFindings} with findings (${summary.findingRate})`);
  console.log(`  New gate findings — grounding:${newGateHits.grounding} F9:${newGateHits.syntax} fs:${newGateHits.filesystem} sec:${newGateHits.security}`);
  console.log(`  Duration: ${duration}s`);

  return { summary, scanned, skipped };
}

function emptyRepoSummary(repo: string, prCount: number): RepoSummary {
  return {
    timestamp: new Date().toISOString(),
    repo,
    prCount,
    prsScanned: 0,
    prsSkipped: prCount,
    prsWithFindings: 0,
    findingRate: '0%',
    highConfidenceRate: '0%',
    gateStats: {},
    newGatesVsLevel1: { grounding: 0, syntax: 0, filesystem: 0, serialization: 0, security: 0, a11y: 0, performance: 0 },
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI args
  const topN = parseInt(args.find(a => a.startsWith('--top='))?.split('=')[1] ?? '0');
  const filterRepo = args.find(a => a.startsWith('--repo='))?.split('=')[1];
  const resumeMode = args.includes('--resume');
  const allMode = args.includes('--all');

  if (!topN && !filterRepo && !resumeMode && !allMode) {
    console.log('Level 2 Scanner — Repo-Aware Gate Scanning');
    console.log('==========================================');
    console.log('');
    console.log('Usage:');
    console.log('  bun scripts/scan/level2-scanner.ts --top=100     # Top 100 repos by PR count');
    console.log('  bun scripts/scan/level2-scanner.ts --repo=calcom/cal.com');
    console.log('  bun scripts/scan/level2-scanner.ts --resume       # Resume from checkpoint');
    console.log('  bun scripts/scan/level2-scanner.ts --all          # All 2,807 repos');
    process.exit(0);
  }

  // Setup output dirs
  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(BATCH_DIR, { recursive: true });
  mkdirSync(CLONE_BASE, { recursive: true });

  // Load PR data grouped by repo
  const repoMap = loadPRsByRepo(filterRepo);
  console.log(`Loaded ${[...repoMap.values()].reduce((a, b) => a + b.length, 0)} PRs across ${repoMap.size} repos`);

  // Sort repos by PR count descending (most valuable first)
  const sortedRepos = [...repoMap.entries()]
    .sort((a, b) => b[1].length - a[1].length);

  // Apply --top filter
  const targetRepos = topN ? sortedRepos.slice(0, topN) : sortedRepos;
  const totalPRs = targetRepos.reduce((a, [_, prs]) => a + prs.length, 0);
  console.log(`Target: ${targetRepos.length} repos, ${totalPRs} PRs`);

  // Load checkpoint for resume
  const checkpoint = loadCheckpoint();
  const completedSet = new Set(checkpoint.completedRepos);

  if (resumeMode || (completedSet.size > 0 && !filterRepo)) {
    console.log(`Resuming: ${completedSet.size} repos already done, ${checkpoint.totalPRsScanned} PRs scanned`);
  }

  // Import verify and parseDiff
  const { parseDiff } = await import('../../src/parsers/git-diff.js');
  const { verify } = await import('../../src/verify.js');

  const globalStart = Date.now();
  let totalScanned = checkpoint.totalPRsScanned;
  let totalSkipped = checkpoint.totalPRsSkipped;
  let reposCompleted = completedSet.size;

  for (const [repo, prs] of targetRepos) {
    // Skip completed repos
    if (completedSet.has(repo)) continue;

    const { scanned, skipped } = await scanRepo(repo, prs, verify, parseDiff);

    totalScanned += scanned;
    totalSkipped += skipped;
    reposCompleted++;

    // Save checkpoint after each repo
    checkpoint.completedRepos.push(repo);
    checkpoint.totalPRsScanned = totalScanned;
    checkpoint.totalPRsSkipped = totalSkipped;
    saveCheckpoint(checkpoint);

    // Progress report
    const elapsed = ((Date.now() - globalStart) / 1000 / 60).toFixed(1);
    const repoIdx = reposCompleted;
    const repoTotal = targetRepos.length;
    console.log(`\n  ── Progress: ${repoIdx}/${repoTotal} repos | ${totalScanned} scanned | ${elapsed} min elapsed ──`);

    // Thermal cooldown
    if (repoIdx < repoTotal) {
      console.log(`  Cooling down ${COOLDOWN_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, COOLDOWN_MS));
    }
  }

  // Final report
  const totalElapsed = ((Date.now() - globalStart) / 1000 / 60).toFixed(1);
  console.log('\n═══════════════════════════════════════');
  console.log('  Level 2 Scan Complete');
  console.log(`  Repos: ${reposCompleted}`);
  console.log(`  PRs scanned: ${totalScanned}`);
  console.log(`  PRs skipped: ${totalSkipped}`);
  console.log(`  Duration: ${totalElapsed} min`);
  console.log(`  Results: ${BATCH_DIR}`);
  console.log('═══════════════════════════════════════');
}

main().catch(err => {
  console.error('Level 2 scan failed:', err);
  process.exit(1);
});
