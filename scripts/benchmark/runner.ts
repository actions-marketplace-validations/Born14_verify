/**
 * Benchmark Runner — The Head-to-Head Test
 * ==========================================
 *
 * Same agent. Same tasks. Two paths.
 *   Path A: Agent edits, apply raw, check ground truth.
 *   Path B: Agent edits through govern(), check ground truth.
 *
 * Ground truth is checked independently — not by verify.
 * This is the proof. If the numbers are good, verify works.
 * If they're not, verify is a research project.
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { verify } from '../../src/verify.js';
import { govern } from '../../src/govern.js';
import type { GovernAgent, GovernContext, AgentPlan } from '../../src/govern.js';
import { applyEdits } from '../../src/gates/syntax.js';
import { groundInReality } from '../../src/gates/grounding.js';
import { validateGroundTruth } from './ground-truth.js';
import type {
  BenchmarkConfig, BenchmarkTask, BenchmarkRun, BenchmarkSummary,
  TaskComparison, RawRunResult, GovernedRunResult, LLMCallFn,
} from './types.js';

// =============================================================================
// EDIT GENERATION PROMPT (shared between raw and governed paths)
// =============================================================================

const AGENT_SYSTEM = `You are a coding agent. Given a goal and the app's source code, produce search/replace edits.

Rules:
1. "search" must be an EXACT substring in the file — copy verbatim
2. "search" must appear EXACTLY ONCE in the file
3. "replace" is what replaces it
4. Keep edits minimal
5. Include predicates that verify the goal was achieved

Respond with JSON only (no markdown):
{
  "edits": [{ "file": "path", "search": "exact", "replace": "new" }],
  "predicates": [{ "type": "content", "file": "path", "pattern": "expected text" }]
}`;

function buildAgentPrompt(
  task: BenchmarkTask,
  appDir: string,
  priorFailure?: string,
): string {
  const lines: string[] = [];

  lines.push(`Goal: ${task.goal}`);
  lines.push('');

  if (priorFailure) {
    lines.push('PREVIOUS ATTEMPT FAILED:');
    lines.push(priorFailure);
    lines.push('Fix the issue and try again.');
    lines.push('');
  }

  // Read source files
  const sourceExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.sql']);
  const skipDirs = new Set(['node_modules', '.git', '.next', 'dist', '.verify', 'coverage']);

  function readDir(dir: string, prefix: string = ''): void {
    try {
      const { readdirSync, statSync } = require('fs');
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (skipDirs.has(entry)) continue;
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        const stat = statSync(full);
        if (stat.isDirectory()) {
          readDir(full, rel);
        } else if (sourceExts.has(require('path').extname(entry))) {
          if (stat.size > 20_000) continue; // skip huge files
          const content = readFileSync(full, 'utf-8');
          lines.push(`--- ${rel} ---`);
          lines.push(content);
          lines.push('');
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  lines.push('Source files:');
  readDir(appDir);

  return lines.join('\n');
}

// =============================================================================
// PARSE LLM RESPONSE
// =============================================================================

function parseLLMResponse(text: string): { edits: any[]; predicates: any[] } {
  // Strip markdown fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      edits: Array.isArray(parsed.edits) ? parsed.edits : [],
      predicates: Array.isArray(parsed.predicates) ? parsed.predicates : [],
    };
  } catch {
    // Try to extract JSON from the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          edits: Array.isArray(parsed.edits) ? parsed.edits : [],
          predicates: Array.isArray(parsed.predicates) ? parsed.predicates : [],
        };
      } catch { /* fall through */ }
    }
    return { edits: [], predicates: [] };
  }
}

// =============================================================================
// ISOLATED APP COPY — each run gets its own copy
// =============================================================================

function makeIsolatedCopy(appDir: string, label: string): string {
  const copyDir = join(tmpdir(), `verify-bench-${label}-${Date.now()}`);
  mkdirSync(copyDir, { recursive: true });
  cpSync(appDir, copyDir, { recursive: true });
  return copyDir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// =============================================================================
// PATH A: RAW AGENT (no verify)
// =============================================================================

async function runRaw(
  task: BenchmarkTask,
  llm: LLMCallFn,
  verbose: boolean,
): Promise<RawRunResult> {
  const start = Date.now();
  let totalInput = 0;
  let totalOutput = 0;

  if (verbose) log(`  [RAW] Starting raw agent run...`);

  // Get agent's edits
  let edits: any[] = [];
  let predicates: any[] = [];
  let agentError: string | null = null;

  try {
    const prompt = buildAgentPrompt(task, task.appDir);
    const response = await llm(AGENT_SYSTEM, prompt);
    totalInput += response.inputTokens;
    totalOutput += response.outputTokens;
    const parsed = parseLLMResponse(response.text);
    edits = parsed.edits;
    predicates = parsed.predicates;
  } catch (err: any) {
    agentError = err.message;
  }

  if (edits.length === 0 && !agentError) {
    if (verbose) log(`  [RAW] Agent produced no edits`);
    return {
      edits: [],
      predicates: [],
      agentProducedEdits: false,
      agentError,
      groundTruth: emptyGroundTruth(),
      durationMs: Date.now() - start,
      tokens: { input: totalInput, output: totalOutput },
    };
  }

  // Apply edits to isolated copy
  const copyDir = makeIsolatedCopy(task.appDir, `raw-${task.id}`);
  try {
    // Apply edits manually (no verify involvement)
    for (const edit of edits) {
      const filePath = join(copyDir, edit.file);
      if (!existsSync(filePath)) continue;
      let content = readFileSync(filePath, 'utf-8');
      if (content.includes(edit.search)) {
        content = content.replace(edit.search, edit.replace);
        writeFileSync(filePath, content);
      }
    }

    // Check ground truth
    const groundTruth = validateGroundTruth(copyDir, edits, predicates);

    if (verbose) {
      log(`  [RAW] Ground truth: ${groundTruth.goalAchieved ? 'ACHIEVED' : 'FAILED'}`);
      if (!groundTruth.goalAchieved) {
        for (const err of groundTruth.fileErrors.slice(0, 3)) log(`    - ${err}`);
      }
    }

    return {
      edits,
      predicates,
      agentProducedEdits: true,
      agentError,
      groundTruth,
      durationMs: Date.now() - start,
      tokens: { input: totalInput, output: totalOutput },
    };
  } finally {
    cleanup(copyDir);
  }
}

// =============================================================================
// PATH B: GOVERNED AGENT (with verify)
// =============================================================================

async function runGoverned(
  task: BenchmarkTask,
  llm: LLMCallFn,
  maxAttempts: number,
  stateDir: string,
  verbose: boolean,
): Promise<GovernedRunResult> {
  const start = Date.now();
  let totalInput = 0;
  let totalOutput = 0;
  let lastEdits: any[] = [];
  let lastPredicates: any[] = [];

  if (verbose) log(`  [GOV] Starting governed run (max ${maxAttempts} attempts)...`);

  // Make an isolated copy for the governed run
  const copyDir = makeIsolatedCopy(task.appDir, `gov-${task.id}`);
  const govStateDir = join(copyDir, '.verify');
  mkdirSync(govStateDir, { recursive: true });

  try {
    // Build a GovernAgent that calls the LLM
    const agent: GovernAgent = {
      plan: async (goal: string, ctx: GovernContext): Promise<AgentPlan> => {
        let priorFailure: string | undefined;
        if (ctx.priorResult && !ctx.priorResult.success) {
          const failedGate = ctx.priorResult.gates.find(g => !g.passed);
          priorFailure = failedGate
            ? `Gate "${failedGate.gate}" failed: ${failedGate.details?.reason ?? 'unknown'}`
            : 'Unknown failure';
          if (ctx.narrowing?.hint) {
            priorFailure += `\nHint: ${ctx.narrowing.hint}`;
          }
          if (ctx.constraints.length > 0) {
            priorFailure += '\nConstraints: ' + ctx.constraints.map(c => c.reason).join('; ');
          }
        }

        const prompt = buildAgentPrompt(task, copyDir, priorFailure);
        const response = await llm(AGENT_SYSTEM, prompt);
        totalInput += response.inputTokens;
        totalOutput += response.outputTokens;

        const parsed = parseLLMResponse(response.text);
        lastEdits = parsed.edits;
        lastPredicates = parsed.predicates;
        return { edits: parsed.edits, predicates: parsed.predicates };
      },
    };

    const result = await govern({
      appDir: copyDir,
      goal: task.goal,
      agent,
      maxAttempts,
      stateDir: govStateDir,
      gates: {
        staging: false,   // no Docker in benchmark by default
        browser: false,
        http: false,
        vision: false,
      },
      onAttempt: (attempt, verifyResult) => {
        if (verbose) {
          const verdict = verifyResult.success ? 'PASS' : 'FAIL';
          const gate = verifyResult.gates.find(g => !g.passed)?.gate ?? '-';
          log(`  [GOV] Attempt ${attempt}: ${verdict} (gate: ${gate})`);
        }
      },
    });

    // Check ground truth on the final state of the copy
    const groundTruth = validateGroundTruth(copyDir, lastEdits, lastPredicates);

    if (verbose) {
      log(`  [GOV] Stop reason: ${result.convergence.stopReason}`);
      log(`  [GOV] Ground truth: ${groundTruth.goalAchieved ? 'ACHIEVED' : 'FAILED'}`);
    }

    return {
      edits: lastEdits,
      predicates: lastPredicates,
      attempts: result.attempts.length,
      stopReason: result.convergence.stopReason ?? 'exhausted',
      verifyPassed: result.success,
      agentError: null,
      groundTruth,
      durationMs: Date.now() - start,
      tokens: { input: totalInput, output: totalOutput },
    };
  } catch (err: any) {
    return {
      edits: lastEdits,
      predicates: lastPredicates,
      attempts: 0,
      stopReason: 'agent_error',
      verifyPassed: false,
      agentError: err.message,
      groundTruth: emptyGroundTruth(),
      durationMs: Date.now() - start,
      tokens: { input: totalInput, output: totalOutput },
    };
  } finally {
    cleanup(copyDir);
  }
}

// =============================================================================
// COMPARE — classify the outcome
// =============================================================================

function compareResults(
  task: BenchmarkTask,
  raw: RawRunResult,
  governed: GovernedRunResult,
): TaskComparison {
  const rawAchieved = raw.groundTruth.goalAchieved;
  const govAchieved = governed.groundTruth.goalAchieved;

  let outcome: TaskComparison['verdict']['outcome'];

  if (!raw.agentProducedEdits && governed.edits.length === 0) {
    outcome = 'both_no_edits';
  } else if (!raw.agentProducedEdits) {
    outcome = 'raw_no_edits';
  } else if (governed.edits.length === 0) {
    outcome = 'governed_no_edits';
  } else if (!rawAchieved && govAchieved) {
    outcome = 'verify_saved';
  } else if (rawAchieved && govAchieved) {
    outcome = 'both_succeeded';
  } else if (!rawAchieved && !govAchieved) {
    outcome = 'both_failed';
  } else if (rawAchieved && !govAchieved) {
    outcome = 'verify_regression';
  } else {
    outcome = 'verify_overhead';
  }

  return {
    task,
    raw,
    governed,
    verdict: { rawAchieved, governedAchieved: govAchieved, outcome },
  };
}

// =============================================================================
// SUMMARY — compute the headline numbers
// =============================================================================

function computeSummary(comparisons: TaskComparison[]): BenchmarkSummary {
  const total = comparisons.length;

  const rawAchieved = comparisons.filter(c => c.verdict.rawAchieved).length;
  const govAchieved = comparisons.filter(c => c.verdict.governedAchieved).length;

  const rawNoEdits = comparisons.filter(c => !c.raw.agentProducedEdits).length;
  const govNoEdits = comparisons.filter(c => c.governed.edits.length === 0).length;

  const rawTokens = comparisons.reduce((acc, c) => ({
    input: acc.input + c.raw.tokens.input,
    output: acc.output + c.raw.tokens.output,
  }), { input: 0, output: 0 });

  const govTokens = comparisons.reduce((acc, c) => ({
    input: acc.input + c.governed.tokens.input,
    output: acc.output + c.governed.tokens.output,
  }), { input: 0, output: 0 });

  const verifySaved = comparisons.filter(c => c.verdict.outcome === 'verify_saved').length;
  const bothSucceeded = comparisons.filter(c => c.verdict.outcome === 'both_succeeded').length;
  const bothFailed = comparisons.filter(c => c.verdict.outcome === 'both_failed').length;
  const verifyOverhead = comparisons.filter(c => c.verdict.outcome === 'verify_overhead').length;
  const verifyRegression = comparisons.filter(c => c.verdict.outcome === 'verify_regression').length;

  const rawSuccessRate = total > 0 ? rawAchieved / total : 0;
  const govSuccessRate = total > 0 ? govAchieved / total : 0;
  const improvement = rawSuccessRate > 0
    ? ((govSuccessRate - rawSuccessRate) / rawSuccessRate) * 100
    : govSuccessRate > 0 ? 100 : 0;

  return {
    totalTasks: total,
    raw: {
      goalsAchieved: rawAchieved,
      goalsFailed: total - rawAchieved - rawNoEdits,
      noEdits: rawNoEdits,
      successRate: rawSuccessRate,
      avgDurationMs: total > 0
        ? comparisons.reduce((s, c) => s + c.raw.durationMs, 0) / total : 0,
      totalTokens: rawTokens,
    },
    governed: {
      goalsAchieved: govAchieved,
      goalsFailed: total - govAchieved - govNoEdits,
      noEdits: govNoEdits,
      successRate: govSuccessRate,
      avgAttempts: total > 0
        ? comparisons.reduce((s, c) => s + c.governed.attempts, 0) / total : 0,
      avgDurationMs: total > 0
        ? comparisons.reduce((s, c) => s + c.governed.durationMs, 0) / total : 0,
      totalTokens: govTokens,
    },
    headToHead: {
      verifySaved,
      bothSucceeded,
      bothFailed,
      verifyOverhead,
      verifyRegression,
    },
    improvementPercent: improvement,
    netTasksSaved: verifySaved - verifyRegression,
  };
}

// =============================================================================
// REPORT — human-readable output
// =============================================================================

function printReport(run: BenchmarkRun): void {
  const s = run.summary;
  const divider = '═'.repeat(60);

  log(`\n${divider}`);
  log(`  VERIFY BENCHMARK — ${run.llmProvider} / ${run.model}`);
  log(`  ${run.comparisons.length} tasks, ${run.apps.join(', ')}`);
  log(divider);

  log(`\n  HEAD-TO-HEAD RESULTS`);
  log(`  ${'─'.repeat(50)}`);
  log(`                          Raw Agent    With Verify`);
  log(`  Goals achieved:         ${pad(s.raw.goalsAchieved)}           ${pad(s.governed.goalsAchieved)}`);
  log(`  Goals failed:           ${pad(s.raw.goalsFailed)}           ${pad(s.governed.goalsFailed)}`);
  log(`  No edits produced:      ${pad(s.raw.noEdits)}           ${pad(s.governed.noEdits)}`);
  log(`  Success rate:           ${pct(s.raw.successRate)}        ${pct(s.governed.successRate)}`);
  log(`  Avg duration:           ${ms(s.raw.avgDurationMs)}      ${ms(s.governed.avgDurationMs)}`);
  log(`  Avg attempts:           1.0            ${s.governed.avgAttempts.toFixed(1)}`);

  log(`\n  VERDICT BREAKDOWN`);
  log(`  ${'─'.repeat(50)}`);
  log(`  Verify saved the task:     ${s.headToHead.verifySaved}`);
  log(`  Both succeeded:            ${s.headToHead.bothSucceeded}`);
  log(`  Both failed:               ${s.headToHead.bothFailed}`);
  log(`  Verify overhead (harmless):${s.headToHead.verifyOverhead}`);
  log(`  Verify regression:         ${s.headToHead.verifyRegression}`);

  log(`\n  THE HEADLINE`);
  log(`  ${'─'.repeat(50)}`);

  if (s.improvementPercent > 0) {
    log(`  Verify improved success rate by ${s.improvementPercent.toFixed(1)}%`);
    log(`  Net tasks saved: ${s.netTasksSaved}`);
  } else if (s.improvementPercent === 0) {
    log(`  No difference in success rate.`);
  } else {
    log(`  Verify DECREASED success rate by ${Math.abs(s.improvementPercent).toFixed(1)}%`);
    log(`  Net regressions: ${Math.abs(s.netTasksSaved)}`);
  }

  log(`\n  TOKEN COST`);
  log(`  ${'─'.repeat(50)}`);
  log(`  Raw:      ${s.raw.totalTokens.input.toLocaleString()} in / ${s.raw.totalTokens.output.toLocaleString()} out`);
  log(`  Governed: ${s.governed.totalTokens.input.toLocaleString()} in / ${s.governed.totalTokens.output.toLocaleString()} out`);
  log(`  Overhead: ${((s.governed.totalTokens.input + s.governed.totalTokens.output) / Math.max(1, s.raw.totalTokens.input + s.raw.totalTokens.output)).toFixed(1)}x tokens`);

  log(`\n${divider}`);

  // Per-task breakdown
  log(`\n  PER-TASK BREAKDOWN`);
  log(`  ${'─'.repeat(50)}`);
  for (const c of run.comparisons) {
    const icon = c.verdict.outcome === 'verify_saved' ? '+' :
                 c.verdict.outcome === 'both_succeeded' ? '=' :
                 c.verdict.outcome === 'verify_regression' ? '!' :
                 c.verdict.outcome === 'both_failed' ? 'x' : '-';
    log(`  [${icon}] ${c.task.goal.slice(0, 55).padEnd(55)} ${c.verdict.outcome}`);
  }

  log(`\n${divider}\n`);
}

// =============================================================================
// MAIN RUNNER
// =============================================================================

export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkRun> {
  const runId = `bench_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = new Date().toISOString();

  log(`\nVerify Benchmark — ${config.tasks.length} tasks`);
  log(`LLM: ${config.llmProvider} / ${config.model}`);
  log(`Max govern attempts: ${config.maxGovAttempts}`);
  log(`${'─'.repeat(50)}`);

  const comparisons: TaskComparison[] = [];

  for (let i = 0; i < config.tasks.length; i++) {
    const task = config.tasks[i];
    log(`\n[${i + 1}/${config.tasks.length}] ${task.goal}`);
    log(`  Category: ${task.category}, Difficulty: ${task.difficulty}`);

    // Run both paths
    const raw = await runRaw(task, config.llm, config.verbose);
    const governed = await runGoverned(
      task, config.llm, config.maxGovAttempts, config.stateDir, config.verbose,
    );

    // Compare
    const comparison = compareResults(task, raw, governed);
    comparisons.push(comparison);

    // Live progress
    const icon = comparison.verdict.outcome === 'verify_saved' ? '[+]' :
                 comparison.verdict.outcome === 'both_succeeded' ? '[=]' :
                 comparison.verdict.outcome === 'verify_regression' ? '[!]' :
                 comparison.verdict.outcome === 'both_failed' ? '[x]' : '[-]';
    log(`  Result: ${icon} ${comparison.verdict.outcome}`);
  }

  const summary = computeSummary(comparisons);
  const apps = [...new Set(config.tasks.map(t => {
    const parts = t.appDir.split('/');
    return parts[parts.length - 1];
  }))];

  const run: BenchmarkRun = {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    llmProvider: config.llmProvider,
    model: config.model,
    apps,
    comparisons,
    summary,
  };

  // Print report
  printReport(run);

  // Save to disk
  const reportPath = join(config.stateDir, `benchmark-${runId}.json`);
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(run, null, 2));
  log(`Full results saved to: ${reportPath}`);

  return run;
}

// =============================================================================
// HELPERS
// =============================================================================

function log(msg: string): void { console.log(msg); }
function pad(n: number): string { return String(n).padStart(3); }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%`.padStart(6); }
function ms(n: number): string { return `${(n / 1000).toFixed(1)}s`.padStart(6); }

function emptyGroundTruth(): import('./types.js').GroundTruthResult {
  return {
    filesApplied: false,
    fileErrors: ['No edits to apply'],
    testsPass: null,
    testOutput: '',
    appStarts: true,
    startupError: '',
    contentPredicatesPass: false,
    predicateResults: [],
    goalAchieved: false,
  };
}
