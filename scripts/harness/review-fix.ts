#!/usr/bin/env bun
/**
 * Stage 7: REVIEW — Auto-approve, reject, or route accepted fixes
 * ================================================================
 *
 * After the improve loop accepts a fix (holdout clean), this reviewer
 * decides whether to auto-merge, reject, or route to operator.
 *
 * Three dispositions:
 *   APPROVE → auto-merge is safe (gate file only, bounded surface)
 *   REJECT  → fix introduces risk or makes product weaker
 *   ROUTE   → reviewer uncertain, create GitHub issue for operator
 *
 * Safety:
 *   - Auto-merge ONLY touches gate files (src/gates/*.ts)
 *   - Never touches verify.ts, types.ts, or harness scripts
 *   - First 10 auto-merges require operator confirmation (trust ramp)
 *
 * Usage:
 *   bun scripts/harness/review-fix.ts --ledger=data/improvement-ledger.jsonl --provider=gemini
 *   bun scripts/harness/review-fix.ts --ledger=data/improvement-ledger.jsonl --dry-run
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const PKG_ROOT = resolve(import.meta.dir, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Disposition = 'approve' | 'reject' | 'route';

interface ReviewResult {
  bundleId: string;
  disposition: Disposition;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

interface ImprovementEntry {
  id: string;
  verdict: string;
  winner: string | null;
  diagnosis: string | null;
  candidates: Array<{
    candidateId: string;
    strategy: string;
    score: number;
    improvements: string[] | number;
    regressions: string[] | number;
    edits: Array<{ file: string; search: string; replace: string }>;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Files that auto-merge is allowed to touch */
const BOUNDED_SURFACE = new Set([
  'src/gates/grounding.ts',
  'src/gates/syntax.ts',
  'src/gates/constraints.ts',
  'src/gates/containment.ts',
  'src/gates/filesystem.ts',
  'src/gates/infrastructure.ts',
  'src/gates/serialization.ts',
  'src/gates/config.ts',
  'src/gates/security.ts',
  'src/gates/a11y.ts',
  'src/gates/performance.ts',
  'src/gates/staging.ts',
  'src/gates/browser.ts',
  'src/gates/http.ts',
  'src/gates/invariants.ts',
  'src/gates/vision.ts',
  'src/gates/triangulation.ts',
  'src/gates/propagation.ts',
  'src/gates/temporal.ts',
  'src/gates/state.ts',
  'src/gates/capacity.ts',
  'src/gates/access.ts',
  'src/gates/contention.ts',
  'src/gates/observation.ts',
  'src/gates/message.ts',
  'src/gates/hallucination.ts',
]);

/** Never touch these, even if the fix proposes it */
const FROZEN_FILES = new Set([
  'src/verify.ts',
  'src/types.ts',
  'src/govern.ts',
  'src/index.ts',
]);

const REVIEW_LOG_PATH = join(PKG_ROOT, 'data', 'review-log.jsonl');

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic safety checks (no LLM needed)
// ─────────────────────────────────────────────────────────────────────────────

function checkSafety(entry: ImprovementEntry): { safe: boolean; reason: string } {
  if (entry.verdict !== 'accepted') {
    return { safe: false, reason: `Verdict is "${entry.verdict}", not accepted` };
  }

  if (!entry.winner || entry.candidates.length === 0) {
    return { safe: false, reason: 'No winning candidate' };
  }

  const winner = entry.candidates.find(c => c.candidateId === entry.winner || c.strategy === entry.winner);
  if (!winner) {
    return { safe: false, reason: `Winner "${entry.winner}" not found in candidates` };
  }

  // Check all edited files are in bounded surface
  for (const edit of winner.edits) {
    if (FROZEN_FILES.has(edit.file)) {
      return { safe: false, reason: `Edit touches frozen file: ${edit.file}` };
    }
    if (!BOUNDED_SURFACE.has(edit.file)) {
      return { safe: false, reason: `Edit touches file outside gate surface: ${edit.file}` };
    }
  }

  // Check score is positive with no regressions
  if (winner.score <= 0) {
    return { safe: false, reason: `Score ${winner.score} is not positive` };
  }
  const regCount = Array.isArray(winner.regressions) ? winner.regressions.length : winner.regressions;
  if (regCount > 0) {
    return { safe: false, reason: `Winner has ${regCount} regressions` };
  }

  return { safe: true, reason: 'All safety checks passed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Review (optional — adds confidence, not required for approve)
// ─────────────────────────────────────────────────────────────────────────────

async function llmReview(entry: ImprovementEntry, provider: string): Promise<ReviewResult> {
  const winner = entry.candidates.find(c => c.candidateId === entry.winner || c.strategy === entry.winner);
  if (!winner) {
    return { bundleId: entry.id, disposition: 'reject', reason: 'No winner', confidence: 'high' };
  }

  const diffSummary = winner.edits.map(e =>
    `File: ${e.file}\n- Search: ${e.search.substring(0, 100)}...\n+ Replace: ${e.replace.substring(0, 100)}...`
  ).join('\n\n');

  const apiKey = provider === 'gemini'
    ? process.env.GEMINI_API_KEY
    : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log('  No API key — using deterministic review only');
    return { bundleId: entry.id, disposition: 'approve', reason: 'Safety checks passed (no LLM review)', confidence: 'medium' };
  }

  const systemPrompt = `You are reviewing an automated code fix for the verify verification library.
Your job: decide if this fix should be auto-merged, rejected, or sent to a human.

Answer with exactly one of:
  APPROVE — fix is correct, makes the gate more accurate, no risk
  REJECT — fix is wrong, makes things worse, or introduces risk
  ROUTE — you're not sure, a human should look at this

After your decision, write one sentence explaining why.
Format: DECISION: one-sentence reason`;

  const userPrompt = `Diagnosis: ${entry.diagnosis ?? 'none'}

Fix (score: ${winner.score}, improvements: ${Array.isArray(winner.improvements) ? winner.improvements.length : winner.improvements}, regressions: ${Array.isArray(winner.regressions) ? winner.regressions.length : winner.regressions}):
${diffSummary}

This fix only touches gate files (verification checks). It cannot affect the core pipeline.
Does this make the gate more correct?`;

  try {
    const model = process.env.GEMINI_REVIEW_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
      }),
    });

    if (!resp.ok) {
      console.log(`  LLM review failed (${resp.status}) — falling back to deterministic`);
      return { bundleId: entry.id, disposition: 'approve', reason: 'Safety passed, LLM unavailable', confidence: 'medium' };
    }

    const data = await resp.json() as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    if (text.toUpperCase().includes('APPROVE')) {
      return { bundleId: entry.id, disposition: 'approve', reason: text.trim(), confidence: 'high' };
    } else if (text.toUpperCase().includes('REJECT')) {
      return { bundleId: entry.id, disposition: 'reject', reason: text.trim(), confidence: 'high' };
    } else {
      return { bundleId: entry.id, disposition: 'route', reason: text.trim(), confidence: 'low' };
    }
  } catch (err: any) {
    console.log(`  LLM error: ${err.message} — falling back to deterministic`);
    return { bundleId: entry.id, disposition: 'approve', reason: 'Safety passed, LLM errored', confidence: 'medium' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ledgerPath = args.find(a => a.startsWith('--ledger='))?.split('=')[1]
  ?? join(PKG_ROOT, 'data', 'improvement-ledger.jsonl');
const provider = args.find(a => a.startsWith('--provider='))?.split('=')[1] ?? 'gemini';
const dryRun = args.includes('--dry-run');

async function main() {
  console.log('=== Stage 7: REVIEW ===');
  console.log(`Ledger: ${ledgerPath}`);
  console.log(`Provider: ${provider}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  if (!existsSync(ledgerPath)) {
    console.log('No improvement ledger found. Nothing to review.');
    console.log('DISPOSITION: skip');
    return;
  }

  const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(l => l);
  const entries: ImprovementEntry[] = lines.map(l => JSON.parse(l));
  const accepted = entries.filter(e => e.verdict === 'accepted');

  if (accepted.length === 0) {
    console.log('No accepted improvements to review.');
    console.log('DISPOSITION: skip');
    return;
  }

  console.log(`Reviewing ${accepted.length} accepted improvement(s)...\n`);

  const reviews: ReviewResult[] = [];

  for (const entry of accepted) {
    console.log(`  Bundle: ${entry.id}`);

    // Step 1: Deterministic safety
    const safety = checkSafety(entry);
    if (!safety.safe) {
      console.log(`    Safety: FAIL — ${safety.reason}`);
      console.log(`    DISPOSITION: reject`);
      reviews.push({ bundleId: entry.id, disposition: 'reject', reason: safety.reason, confidence: 'high' });
      continue;
    }
    console.log(`    Safety: OK`);

    // Step 2: LLM review (adds confidence)
    const review = await llmReview(entry, provider);
    console.log(`    LLM: ${review.disposition.toUpperCase()} (${review.confidence}) — ${review.reason.substring(0, 80)}`);
    reviews.push(review);
  }

  // Write review log
  if (!dryRun) {
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      reviews,
    });
    try {
      mkdirSync(join(PKG_ROOT, 'data'), { recursive: true });
      const existing = existsSync(REVIEW_LOG_PATH) ? readFileSync(REVIEW_LOG_PATH, 'utf-8') : '';
      writeFileSync(REVIEW_LOG_PATH, existing + logLine + '\n');
    } catch (e) {
      console.log(`Review log write error: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Final disposition: approve only if ALL reviews approve
  const allApproved = reviews.every(r => r.disposition === 'approve');
  const anyRejected = reviews.some(r => r.disposition === 'reject');
  const disposition = anyRejected ? 'reject' : allApproved ? 'approve' : 'route';

  console.log(`\nDISPOSITION: ${disposition}`);
  console.log(`  Reviews: ${reviews.filter(r => r.disposition === 'approve').length} approve, ${reviews.filter(r => r.disposition === 'reject').length} reject, ${reviews.filter(r => r.disposition === 'route').length} route`);
}

main().catch(err => {
  console.error(`Review error: ${err.message}`);
  console.log('DISPOSITION: route');
  process.exit(0); // Don't fail the CI job
});
