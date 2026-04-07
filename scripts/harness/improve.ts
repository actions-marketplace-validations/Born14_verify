/**
 * Evidence-Centric Improvement Engine — Orchestrator
 * ====================================================
 *
 * Pipeline: baseline → bundle → triage → diagnose → generate → validate → rank → verdict
 *
 * Zero-token fast path: mechanical triage + subprocess validation only.
 * LLM path: diagnosis + multi-candidate fix generation when triage says needs_llm.
 */

import { resolve, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import type {
  RunConfig, LedgerEntry, ImproveConfig, ImprovementEntry,
  ImprovementVerdict, CandidateResult, LLMUsage, EvidenceBundle,
} from './types.js';
import { runSelfTest } from './runner.js';
import { bundleViolations, isEditAllowed, FROZEN_FILES } from './improve-triage.js';
import { diagnoseBundleWithLLM, generateFixCandidates } from './improve-prompts.js';
import { diagnoseWithClaude, generateFixesWithClaude } from './claude-improve.js';
import { splitScenarios, validateCandidate, runHoldout } from './improve-subprocess.js';
import { createLLMProvider } from './llm-providers.js';
import { printImprovementReport } from './improve-report.js';
import { hashEdits } from './improve-utils.js';

// =============================================================================
// CROSS-RUN MEMORY — improve-history.json
// =============================================================================

interface ImproveHistoryRun {
  timestamp: string;
  failingScenarios: string[];
  candidatesTried: Array<{ hash: string; passed: boolean; reason: string }>;
  verdict: string;
}

interface ImproveHistory {
  runs: ImproveHistoryRun[];
}

function loadHistory(dataDir: string): ImproveHistory {
  const path = join(dataDir, 'improve-history.json');
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* corrupt file — start fresh */ }
  return { runs: [] };
}

function saveHistory(dataDir: string, history: ImproveHistory): void {
  // Cap at last 10 runs
  if (history.runs.length > 10) {
    history.runs = history.runs.slice(-10);
  }
  writeFileSync(join(dataDir, 'improve-history.json'), JSON.stringify(history, null, 2));
}

// =============================================================================
// IN-RUN TRACKING — prior attempts + dedup
// =============================================================================

interface AttemptRecord {
  hash: string;
  strategy: string;
  edits: Array<{ file: string; searchPreview: string }>;
  passed: boolean;
  failedScenarios: string[];
}

function formatPriorAttempts(attempts: AttemptRecord[], maxAttempts: number = 3): string {
  if (attempts.length === 0) return '';
  const recent = attempts.slice(-maxAttempts);
  const lines = recent.map((a, i) => {
    const files = a.edits.map(e => e.file).join(', ');
    const status = a.passed ? 'PASSED validation' : `FAILED (${a.failedScenarios.length} regressions)`;
    return `  ${i + 1}. "${a.strategy}" — edited ${files} — ${status}`;
  });
  return `\nPREVIOUSLY ATTEMPTED FIXES (do NOT repeat these approaches):\n${lines.join('\n')}\n`;
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

export async function runImproveLoop(
  runConfig: RunConfig,
  improveConfig: ImproveConfig,
): Promise<void> {
  const maxIterations = improveConfig.maxIterations ?? 1;
  const continuous = maxIterations > 1;

  if (continuous) {
    console.log('\n  ╔══════════════════════════════════════════════════╗');
    console.log('  ║  Verify Improvement Engine — Continuous Mode      ║');
    console.log('  ╚══════════════════════════════════════════════════╝\n');
    console.log(`  Max iterations: ${maxIterations}  LLM: ${improveConfig.llm}  Candidates: ${improveConfig.maxCandidates}\n`);
  }

  const cumulativeUsage: LLMUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const allEntries: ImprovementEntry[] = [];
  let totalAccepted = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (continuous) {
      console.log(`\n  ═══ Iteration ${iteration}/${maxIterations} ═══════════════════════════════\n`);
    }

    const { entries, usage, hadAccepted } = await runSingleIteration(
      runConfig, improveConfig,
    );

    allEntries.push(...entries);
    cumulativeUsage.inputTokens += usage.inputTokens;
    cumulativeUsage.outputTokens += usage.outputTokens;
    cumulativeUsage.calls += usage.calls;

    const accepted = entries.filter(e => e.verdict === 'accepted').length;
    totalAccepted += accepted;

    // Early termination: no improvements → stop climbing
    if (!hadAccepted) {
      if (continuous && iteration < maxIterations) {
        console.log(`  No improvements in iteration ${iteration} — stopping continuous loop.\n`);
      }
      break;
    }

    // If continuous and we accepted something, next iteration re-baselines
    if (continuous && iteration < maxIterations) {
      console.log(`  Iteration ${iteration}: ${accepted} accepted — re-baselining for next iteration...\n`);
    }
  }

  // Cumulative summary for continuous mode
  if (continuous && totalAccepted > 0) {
    console.log(`\n  Continuous mode complete: ${totalAccepted} total accepted across ${allEntries.length} bundles.`);
    console.log(`  LLM cost: ${cumulativeUsage.inputTokens} input + ${cumulativeUsage.outputTokens} output tokens (${cumulativeUsage.calls} calls)\n`);
  }
}

/**
 * Run a single iteration of the improve loop.
 * Extracted to support continuous mode (multiple iterations with re-baselining).
 */
async function runSingleIteration(
  runConfig: RunConfig,
  improveConfig: ImproveConfig,
): Promise<{ entries: ImprovementEntry[]; usage: LLMUsage; hadAccepted: boolean }> {
  const packageRoot = resolve(import.meta.dir, '../..');
  const dataDir = join(packageRoot, 'data');
  mkdirSync(dataDir, { recursive: true });

  const callLLM = createLLMProvider(improveConfig);

  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  Verify Improvement Engine — Evidence-Centric    ║');
  console.log('  ╚══════════════════════════════════════════════════╝\n');
  console.log(`  LLM: ${improveConfig.llm}  Candidates: ${improveConfig.maxCandidates}  Max lines: ${improveConfig.maxLines}`);
  if (improveConfig.dryRun) console.log('  Mode: DRY RUN (no edits applied)\n');
  else console.log('');

  // ─── Step 1: Baseline run ─────────────────────────────────────────────
  console.log('  [1/7] Running baseline self-test...');
  const baselineLedger = await collectBaseline(runConfig);
  const dirty = baselineLedger.filter(e => !e.clean);
  const clean = baselineLedger.filter(e => e.clean);
  console.log(`        ${baselineLedger.length} scenarios: ${clean.length} clean, ${dirty.length} dirty\n`);

  if (dirty.length === 0) {
    console.log('  ✓ All scenarios clean — nothing to improve.\n');
    saveImprovementLedger(dataDir, []);
    return { entries: [], usage: { inputTokens: 0, outputTokens: 0, calls: 0 }, hadAccepted: false };
  }

  // ─── Step 2: Evidence bundling ────────────────────────────────────────
  console.log('  [2/7] Bundling violations by root cause...');
  const bundles = bundleViolations(baselineLedger);
  console.log(`        ${bundles.length} evidence bundle(s)\n`);

  for (const b of bundles) {
    const conf = b.triage.confidence;
    const target = b.triage.targetFile ?? '(unknown)';
    console.log(`        • ${b.id}: ${b.violations.length} violation(s), confidence=${conf}, target=${target}`);
  }
  console.log('');

  // ─── Step 3: Scenario split ───────────────────────────────────────────
  console.log('  [3/7] Splitting scenarios for validation/holdout...');
  const split = splitScenarios(baselineLedger);
  console.log(`        dirty=${split.dirty.length}  validation=${split.validation.length}  holdout=${split.holdout.length}\n`);

  // ─── Load cross-run history ──────────────────────────────────────────
  const history = loadHistory(dataDir);
  const priorHashes = new Set<string>();
  for (const run of history.runs) {
    for (const c of run.candidatesTried) {
      if (!c.passed) priorHashes.add(c.hash);
    }
  }
  if (priorHashes.size > 0) {
    console.log(`  Prior run history: ${history.runs.length} runs, ${priorHashes.size} known-bad candidates\n`);
  }

  // ─── Step 4-6: Process each bundle ────────────────────────────────────
  const entries: ImprovementEntry[] = [];
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const attemptedHashes = new Set<string>(priorHashes);
  const attempts: AttemptRecord[] = [];

  for (const bundle of bundles) {
    const entry = await processBundle(
      bundle, split, packageRoot, runConfig, improveConfig, callLLM, usage,
      attemptedHashes, attempts,
    );
    entries.push(entry);
  }

  // ─── Save cross-run history ─────────────────────────────────────────
  const historyRun: ImproveHistoryRun = {
    timestamp: new Date().toISOString(),
    failingScenarios: dirty.map(d => d.id),
    candidatesTried: attempts.map(a => ({
      hash: a.hash,
      passed: a.passed,
      reason: a.passed ? 'accepted' : a.failedScenarios.length > 0 ? 'regression' : 'no_improvement',
    })),
    verdict: entries.every(e => e.verdict === 'accepted') ? 'improved'
      : entries.some(e => e.verdict === 'accepted') ? 'partial'
      : 'no_improvement',
  };
  history.runs.push(historyRun);
  saveHistory(dataDir, history);

  // ─── Step 7: Report ───────────────────────────────────────────────────
  saveImprovementLedger(dataDir, entries);
  printImprovementReport(entries, usage);

  const hadAccepted = entries.some(e => e.verdict === 'accepted');
  return { entries, usage, hadAccepted };
}

// =============================================================================
// PROCESS A SINGLE EVIDENCE BUNDLE
// =============================================================================

async function processBundle(
  bundle: EvidenceBundle,
  split: ReturnType<typeof splitScenarios>,
  packageRoot: string,
  runConfig: RunConfig,
  improveConfig: ImproveConfig,
  callLLM: ReturnType<typeof createLLMProvider>,
  usage: LLMUsage,
  attemptedHashes: Set<string>,
  attempts: AttemptRecord[],
): Promise<ImprovementEntry> {
  const timestamp = new Date().toISOString();
  const bundleId = bundle.id;

  console.log(`  [4/7] Processing ${bundleId} (${bundle.triage.confidence})...`);

  // ─── Triage: skip if target file is frozen or unknown ─────────────────
  if (bundle.triage.targetFile && !isEditAllowed(bundle.triage.targetFile)) {
    console.log(`        Target ${bundle.triage.targetFile} is frozen — skipping\n`);
    return makeEntry(bundleId, timestamp, bundle, null, [], null, 'skipped', 'rejected_no_fix', usage);
  }

  // ─── Diagnosis (only for needs_llm) ───────────────────────────────────
  let diagnosis: string | null = null;

  if (bundle.triage.confidence === 'needs_llm') {
    if (!callLLM) {
      console.log('        Needs LLM but no provider configured — skipping\n');
      return makeEntry(bundleId, timestamp, bundle, null, [], null, 'skipped', 'skipped_no_llm', usage);
    }
    const isClaude = improveConfig.llm === 'claude' || improveConfig.llm === 'claude-code';
    console.log(`        Diagnosing with ${isClaude ? 'Claude (domain-aware)' : 'LLM'}...`);
    diagnosis = isClaude
      ? await diagnoseWithClaude(bundle, packageRoot, callLLM, usage)
      : await diagnoseBundleWithLLM(bundle, packageRoot, callLLM, usage);
    if (!diagnosis) {
      console.log('        Diagnosis failed (LLM error) — continuing without diagnosis\n');
    } else {
      console.log(`        Diagnosis: ${diagnosis.substring(0, 100)}...\n`);
    }
  }

  // ─── Fix generation ───────────────────────────────────────────────────
  if (!callLLM) {
    console.log('        No LLM provider — cannot generate fixes\n');
    return makeEntry(bundleId, timestamp, bundle, diagnosis, [], null, 'skipped', 'skipped_no_llm', usage);
  }

  // Enrich diagnosis with prior attempt context (Fix 7)
  const priorContext = formatPriorAttempts(attempts);
  const enrichedDiagnosis = diagnosis
    ? diagnosis + priorContext
    : priorContext || null;

  const isClaude = improveConfig.llm === 'claude' || improveConfig.llm === 'claude-code';
  console.log(`  [5/7] Generating fix candidates${isClaude ? ' (Claude — architectural context)' : ''}...`);
  const candidates = isClaude
    ? await generateFixesWithClaude(
        bundle, enrichedDiagnosis, packageRoot, callLLM, usage,
        improveConfig.maxCandidates, improveConfig.maxLines,
      )
    : await generateFixCandidates(
        bundle, enrichedDiagnosis, packageRoot, callLLM, usage,
        improveConfig.maxCandidates, improveConfig.maxLines,
      );

  if (candidates.length === 0) {
    console.log('        LLM returned no valid candidates\n');
    return makeEntry(bundleId, timestamp, bundle, diagnosis, [], null, 'skipped', 'rejected_no_fix', usage);
  }

  // ─── Dedup: skip candidates already tried (this run or prior runs) ──
  const dedupCandidates = candidates.filter(c => {
    const h = hashEdits(c.edits);
    if (attemptedHashes.has(h)) {
      console.log(`        Skipping duplicate fix "${c.strategy}" (hash ${h})`);
      return false;
    }
    return true;
  });

  if (dedupCandidates.length === 0) {
    console.log('        All candidates are duplicates of prior attempts\n');
    return makeEntry(bundleId, timestamp, bundle, diagnosis, [], null, 'skipped', 'rejected_no_fix', usage);
  }

  console.log(`        ${dedupCandidates.length} candidate(s) after dedup (${candidates.length} generated)\n`);

  // ─── Dry run: stop here ───────────────────────────────────────────────
  if (improveConfig.dryRun) {
    console.log('        DRY RUN — skipping subprocess validation\n');
    for (const c of dedupCandidates) {
      console.log(`        • ${c.strategy}: ${c.edits.length} edit(s) — ${c.rationale}`);
    }
    console.log('');
    return makeEntry(bundleId, timestamp, bundle, diagnosis, [], null, 'skipped', 'rejected_no_fix', usage);
  }

  // ─── Validate candidates against edit surface — REMOVE invalid edits ──
  const surfaceCandidates = dedupCandidates.map(candidate => {
    const validEdits = candidate.edits.filter(edit => {
      if (!isEditAllowed(edit.file)) {
        console.log(`        ⚠ ${candidate.strategy}: edit to frozen/unbounded file ${edit.file} — removed`);
        return false;
      }
      return true;
    });
    return { ...candidate, edits: validEdits };
  }).filter(c => c.edits.length > 0);

  if (surfaceCandidates.length === 0) {
    console.log('        All candidates target frozen/unbounded files\n');
    return makeEntry(bundleId, timestamp, bundle, diagnosis, [], null, 'skipped', 'rejected_no_fix', usage);
  }

  // ─── Subprocess validation (parallel) ────────────────────────────────
  console.log(`  [6/7] Subprocess validation (${surfaceCandidates.length} candidates in parallel)...`);

  const validationPromises = surfaceCandidates.map(async (candidate) => {
    const h = hashEdits(candidate.edits);
    attemptedHashes.add(h);

    console.log(`        Testing "${candidate.strategy}"...`);
    const result = await validateCandidate(
      candidate.id, candidate.strategy, candidate.edits,
      split, packageRoot, runConfig,
    );

    const sign = result.score > 0 ? '+' : '';
    const partial = result.partialScore !== undefined ? ` partial=${result.partialScore.toFixed(2)}` : '';
    const timeout = result.timedOut ? ' (timed out)' : '';
    const editInfo = result.skippedEdits ? ` edits=${result.appliedEdits}/${(result.appliedEdits ?? 0) + (result.skippedEdits ?? 0)}` : '';
    console.log(`          "${candidate.strategy}": score=${sign}${result.score.toFixed(1)}${partial}${editInfo}  improvements=${result.improvements.length}  regressions=${result.regressions.length}${timeout}`);

    return { candidate, result, hash: h };
  });

  const validationResults = await Promise.all(validationPromises);

  const results: CandidateResult[] = [];
  for (const { candidate, result, hash: h } of validationResults) {
    results.push(result);
    attempts.push({
      hash: h,
      strategy: candidate.strategy,
      edits: candidate.edits.map(e => ({ file: e.file, searchPreview: e.line != null ? `line:${e.line}` : (e.search ?? '').substring(0, 60) })),
      passed: result.score > 0 && result.regressions.length === 0,
      failedScenarios: result.regressions,
    });
  }
  console.log('');

  // ─── Rank survivors ───────────────────────────────────────────────────
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const best = ranked[0];

  if (best.score <= 0) {
    // Report best partial score even when no candidate fully passes
    const bestPartial = ranked.find(r => (r.partialScore ?? 0) > 0);
    if (bestPartial && bestPartial.partialScore) {
      console.log(`        No candidate passed, but "${bestPartial.strategy}" fixed ${bestPartial.improvements.length}/${split.dirty.length} scenarios (partial=${bestPartial.partialScore.toFixed(2)}, ${bestPartial.regressions.length} regressions)\n`);
    } else {
      console.log('        No candidate improved anything\n');
    }
    return makeEntry(bundleId, timestamp, bundle, diagnosis, results, null, 'skipped', 'rejected_no_fix', usage);
  }

  if (best.regressions.length > 0) {
    console.log(`        Best candidate "${best.strategy}" has regressions — rejected\n`);
    return makeEntry(bundleId, timestamp, bundle, diagnosis, results, null, 'skipped', 'rejected_regression', usage);
  }

  // ─── Holdout check ────────────────────────────────────────────────────
  console.log(`  [7/7] Holdout check for "${best.strategy}"...`);
  const holdoutResult = await runHoldout(best.edits, split.holdout, packageRoot, runConfig);

  if (holdoutResult.verdict === 'regression') {
    const confNote = holdoutResult.confidence === 'low' ? ' (low confidence)' : '';
    console.log(`        Holdout regression detected (${holdoutResult.regressionCount}/${holdoutResult.holdoutSize} regressed${confNote}) — overfitting\n`);
    return makeEntry(bundleId, timestamp, bundle, diagnosis, results, best.candidateId, holdoutResult.verdict, 'rejected_overfitting', usage);
  }

  const confNote = holdoutResult.confidence !== 'high'
    ? ` (${holdoutResult.holdoutSize} scenarios — ${holdoutResult.confidence} confidence)`
    : '';
  console.log(`        Holdout clean${confNote} — ACCEPTED\n`);
  return makeEntry(bundleId, timestamp, bundle, diagnosis, results, best.candidateId, holdoutResult.verdict, 'accepted', usage);
}

// =============================================================================
// HELPERS
// =============================================================================

async function collectBaseline(runConfig: RunConfig): Promise<LedgerEntry[]> {
  // Use a dedicated ledger path so we only get entries from this run
  const packageRoot = resolve(import.meta.dir, '../..');
  const dataDir = join(packageRoot, 'data');
  const ledgerPath = join(dataDir, `improve-baseline-${Date.now()}.jsonl`);

  // Override ledger path for this run
  const baselineConfig: RunConfig = { ...runConfig, ledgerPath };
  const { exitCode } = await runSelfTest(baselineConfig);

  if (!existsSync(ledgerPath)) {
    throw new Error(`Baseline ledger not created at ${ledgerPath} (self-test exit code: ${exitCode})`);
  }

  const content = readFileSync(ledgerPath, 'utf-8');
  const entries: LedgerEntry[] = [];
  let malformed = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { malformed++; }
  }

  if (entries.length === 0) {
    throw new Error(`Baseline ledger is empty (${malformed} malformed lines, exit code: ${exitCode})`);
  }

  if (malformed > 0) {
    console.log(`        ⚠ ${malformed} malformed ledger lines skipped`);
  }

  // Clean up temp ledger
  try { rmSync(ledgerPath); } catch { /* */ }
  return entries;
}

function makeEntry(
  id: string,
  timestamp: string,
  bundle: EvidenceBundle,
  diagnosis: string | null,
  candidates: CandidateResult[],
  winner: string | null,
  holdoutResult: 'clean' | 'regression' | 'skipped',
  verdict: ImprovementVerdict,
  usage: LLMUsage,
): ImprovementEntry {
  return {
    id,
    timestamp,
    bundle: {
      id: bundle.id,
      violationCount: bundle.violations.length,
      triageConfidence: bundle.triage.confidence,
    },
    diagnosis,
    candidates,
    winner,
    holdoutResult,
    verdict,
    cost: { ...usage },
  };
}

function saveImprovementLedger(dataDir: string, entries: ImprovementEntry[]): void {
  const path = join(dataDir, 'improvement-ledger.jsonl');
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(path, lines + '\n');
}
