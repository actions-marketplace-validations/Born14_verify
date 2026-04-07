/**
 * Verify Action — Entry Point
 * =============================
 *
 * Runs verify on a PR diff and posts results as a comment.
 *
 * Three modes:
 *   Mode 1 (default): Structural — diff predicates only, no LLM, free
 *   Mode 2 (intent):  + PR title/description → intent predicates (needs api-key)
 *   Mode 3 (staging): + Docker build/run → behavioral verification
 */

import { parseDiff } from '../parsers/git-diff.js';
import { extractDiffPredicates, extractCrossFilePredicates, extractIntentPredicates } from '../parsers/pr-predicates.js';
import { verify } from '../verify.js';
import { getPRDiff, getPRMetadata, postPRComment } from './github.js';
import { formatComment } from './comment.js';
import type { Predicate } from '../types.js';

// =============================================================================
// ACTION ENTRY POINT
// =============================================================================

async function run(): Promise<void> {
  const startTime = Date.now();

  // Read inputs from environment (GitHub Actions sets INPUT_* env vars)
  const token = process.env.GITHUB_TOKEN ?? process.env.INPUT_TOKEN ?? '';
  const appDir = process.env.INPUT_APP_DIR ?? process.env['INPUT_APP-DIR'] ?? '.';
  const intentEnabled = (process.env.INPUT_INTENT ?? 'false') === 'true';
  const apiKey = process.env.INPUT_API_KEY ?? process.env['INPUT_API-KEY'] ?? '';
  const provider = process.env.INPUT_PROVIDER ?? 'gemini';
  const stagingEnabled = (process.env.INPUT_STAGING ?? 'false') === 'true';
  const commentEnabled = (process.env.INPUT_COMMENT ?? 'true') === 'true';
  const failOn = process.env.INPUT_FAIL_ON ?? process.env['INPUT_FAIL-ON'] ?? 'error';

  // Parse GitHub context
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.log('::error::Not running in GitHub Actions context (GITHUB_EVENT_PATH not set)');
    process.exit(1);
  }

  const { readFileSync } = await import('fs');
  const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
  const prNumber = event.pull_request?.number ?? event.number;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');

  if (!prNumber || !owner || !repo) {
    console.log('::error::Could not determine PR number or repository');
    process.exit(1);
  }

  if (!token) {
    console.log('::error::No GitHub token provided. Set GITHUB_TOKEN or use permissions: pull-requests: write');
    process.exit(1);
  }

  console.log(`Verify Action: ${owner}/${repo}#${prNumber}`);
  console.log(`  Mode: ${stagingEnabled ? 'Full (staging)' : intentEnabled ? 'Intent (LLM)' : 'Structural (free)'}`);
  console.log(`  App dir: ${appDir}`);

  // ─── Step 1: Get PR diff ──────────────────────────────────────────────
  console.log('\n[1/4] Reading PR diff...');
  const diff = await getPRDiff(token, owner, repo, prNumber);
  const edits = parseDiff(diff);
  console.log(`  ${edits.length} edit(s) from diff`);

  if (edits.length === 0) {
    console.log('  No edits found in diff (binary-only or empty PR). Skipping.');
    setOutput('success', 'true');
    setOutput('summary', 'No edits to verify');
    return;
  }

  // ─── Step 2: Generate predicates ──────────────────────────────────────
  console.log('\n[2/4] Generating predicates...');
  const predicates: Predicate[] = [];
  const tiers: string[] = [];

  // Tier 1: Deterministic from diff (always)
  const diffPreds = extractDiffPredicates(edits);
  predicates.push(...diffPreds.filter(p => (p as any).expected !== 'absent'));
  tiers.push('diff');
  console.log(`  Tier 1 (diff): ${diffPreds.length} predicates`);

  // Tier 2: Cross-file (if repo files available)
  try {
    const { readdirSync } = await import('fs');
    const existingFiles = listFiles(appDir, readdirSync);
    const crossFilePreds = extractCrossFilePredicates(edits, existingFiles);
    predicates.push(...crossFilePreds.filter(p => (p as any).expected !== 'absent'));
    tiers.push('cross-file');
    console.log(`  Tier 2 (cross-file): ${crossFilePreds.length} predicates`);
  } catch {
    console.log('  Tier 2 (cross-file): skipped (could not read repo files)');
  }

  // Tier 3a: Heuristic intent (if enabled)
  if (intentEnabled) {
    console.log('  Reading PR metadata...');
    const metadata = await getPRMetadata(token, owner, repo, prNumber);
    const intentPreds = extractIntentPredicates(edits, {
      title: metadata.title,
      description: metadata.body,
      issueTitle: metadata.issueTitle,
      commitMessages: metadata.commitMessages,
    });
    predicates.push(...intentPreds);
    tiers.push('intent-heuristic');
    console.log(`  Tier 3a (intent heuristic): ${intentPreds.length} predicates`);

    // Tier 3b: LLM intent (if api-key provided)
    if (apiKey) {
      console.log(`  Tier 3b (LLM intent via ${provider}): generating...`);
      try {
        const llmPreds = await extractLLMPredicates(edits, metadata, apiKey, provider);
        predicates.push(...llmPreds);
        tiers.push(`intent-llm-${provider}`);
        console.log(`  Tier 3b (LLM intent): ${llmPreds.length} predicates`);
      } catch (err: any) {
        console.log(`  Tier 3b (LLM intent): failed — ${err.message}`);
      }
    }
  }

  console.log(`  Total: ${predicates.length} predicates`);

  // ─── Step 3: Run verify ───────────────────────────────────────────────
  console.log('\n[3/4] Running verify...');
  const result = await verify(edits, predicates, {
    appDir,
    gates: {
      // Diff-only gates — all enabled (these work without Docker/repo cloning)
      // security, access, temporal, propagation, state, capacity, contention,
      // observation, containment (G5), constraints (K5) all fire on edits alone

      // Disabled: need Docker, Playwright, or full repo state
      grounding: false,    // needs real repo source files for selector validation
      syntax: false,       // needs real files for search string matching
      staging: stagingEnabled,
      browser: false,
      http: stagingEnabled,
      invariants: false,
      vision: false,
    },
  });

  const passed = result.gates.filter(g => g.passed).length;
  const failed = result.gates.filter(g => !g.passed).length;
  console.log(`  Result: ${result.success ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`);

  for (const g of result.gates) {
    if (!g.passed) console.log(`  \u274C ${g.gate}: ${g.detail?.substring(0, 80)}`);
  }

  // ─── Step 4: Post comment ─────────────────────────────────────────────
  if (commentEnabled) {
    console.log('\n[4/4] Posting PR comment...');
    const comment = formatComment(result, {
      prNumber,
      predicateCount: predicates.length,
      tiers,
      durationMs: Date.now() - startTime,
    });
    await postPRComment(token, owner, repo, prNumber, comment);
    console.log('  Comment posted.');
  }

  // ─── Set outputs ──────────────────────────────────────────────────────
  setOutput('success', String(result.success));
  setOutput('gates-passed', result.gates.filter(g => g.passed).map(g => g.gate).join(','));
  setOutput('gates-failed', result.gates.filter(g => !g.passed).map(g => g.gate).join(','));
  setOutput('summary', `${passed}/${passed + failed} gates passed${failed > 0 ? ` — ${result.gates.filter(g => !g.passed).map(g => g.gate).join(', ')} failed` : ''}`);

  // Exit with failure if configured
  if (failOn === 'error' && !result.success) {
    process.exit(1);
  }
}

// =============================================================================
// TIER 3b: LLM Intent Extraction
// =============================================================================

async function extractLLMPredicates(
  edits: Array<{ file: string; search: string; replace: string }>,
  metadata: { title: string; body: string; commitMessages: string[] },
  apiKey: string,
  provider: string = 'gemini',
): Promise<Predicate[]> {
  const diffSummary = edits.map(e =>
    `${e.file}: "${e.search.substring(0, 60)}" → "${e.replace.substring(0, 60)}"`
  ).join('\n');

  const prompt = `Given this PR:
Title: ${metadata.title}
Description: ${(metadata.body || '').substring(0, 500)}

Diff summary:
${diffSummary}

What should be true about the codebase AFTER this PR is applied?
Return a JSON array of assertions. Each assertion: { "file": "path", "pattern": "text that should exist", "reason": "why" }
Only include specific, testable assertions. Max 5.`;

  const text = await callLLM(prompt, apiKey, provider);

  // Extract JSON array from response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const assertions = JSON.parse(jsonMatch[0]) as Array<{ file: string; pattern: string; reason: string }>;
    return assertions
      .filter(a => a.file && a.pattern)
      .map(a => ({
        type: 'content' as const,
        file: a.file,
        pattern: a.pattern,
        description: a.reason || `LLM: "${a.pattern}" should exist in ${a.file}`,
      }));
  } catch {
    return [];
  }
}

// =============================================================================
// MULTI-PROVIDER LLM CALL
// =============================================================================

async function callLLM(prompt: string, apiKey: string, provider: string): Promise<string> {
  switch (provider) {
    case 'gemini': {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 500 },
        }),
      });
      if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
      const data = await res.json() as any;
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 500,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content ?? '';
    }

    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
      const data = await res.json() as any;
      return data.content?.[0]?.text ?? '';
    }

    default:
      throw new Error(`Unknown provider: ${provider}. Use gemini, openai, or anthropic.`);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const { appendFileSync } = require('fs');
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
  console.log(`::set-output name=${name}::${value}`);
}

function listFiles(dir: string, readdirSync: any, prefix = ''): string[] {
  const files: string[] = [];
  const skip = new Set(['node_modules', '.git', '.next', 'dist', '.verify', '__pycache__']);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...listFiles(`${dir}/${entry.name}`, readdirSync, rel));
      } else {
        files.push(rel);
      }
    }
  } catch { /* unreadable */ }
  return files;
}

// Run
run().catch(err => {
  console.log(`::error::${err.message}`);
  process.exit(1);
});
