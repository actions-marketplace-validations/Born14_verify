/**
 * Improvement Prompts — Diagnosis + Multi-Candidate Fix Generation
 * ================================================================
 *
 * LLM prompts for the evidence-centric autoresearch loop.
 * Two phases: diagnosis (optional, skipped for mechanical triage)
 * and multi-candidate fix generation.
 */

import type { EvidenceBundle, FixCandidate, LLMCallFn, LLMUsage } from './types.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractJSON, callLLMWithRetry } from './improve-utils.js';

// =============================================================================
// DIAGNOSIS (only for needs_llm bundles)
// =============================================================================

const DIAGNOSIS_SYSTEM = `You are a debugging expert analyzing @sovereign-labs/verify, a TypeScript verification library (runs on Bun).

PACKAGE STRUCTURE:
  src/verify.ts          — Main pipeline orchestrator (runs gates in sequence)
  src/govern.ts          — Higher-level governance wrapper around verify
  src/types.ts           — All TypeScript interfaces (GateResult, Predicate, Edit, etc.)
  src/store/             — State management (constraint-store.ts, fault-ledger.ts, decompose.ts)
  src/gates/             — Individual gate implementations:
    grounding.ts         — CSS/HTML parsing, route extraction, selector validation
    browser.ts           — Playwright CSS/HTML validation against running containers
    http.ts              — HTTP predicate validation (status, body, sequences)
    syntax.ts            — F9 edit application (search/replace validation)
    constraints.ts       — K5 constraint enforcement
    containment.ts       — G5 mutation-to-predicate attribution
    vision.ts            — Vision model screenshot verification
    triangulation.ts     — Cross-authority verdict synthesis
    filesystem.ts        — File existence/content verification
    security.ts          — Secret/eval/XSS scanning
    a11y.ts              — Accessibility checks
    performance.ts       — Bundle size, connection checks
    staging.ts           — Docker build/start orchestration
    invariants.ts        — System health definitions
    + 11 more domain gates (config, serialization, propagation, etc.)
  src/runners/           — Docker runner, local runner

Rules:
- Name the EXACT function and file from the structure above
- Be concise: 2-3 sentences max
- Focus on WHY the invariant failed, not what the invariant checks
- Gate functions follow the pattern: run{GateName}Gate() (e.g., runGroundingGate(), runBrowserGate())
- Store functions: predicateFingerprint(), checkConstraints(), seedFromFailure(), etc.`;

export async function diagnoseBundleWithLLM(
  bundle: EvidenceBundle,
  packageRoot: string,
  callLLM: LLMCallFn,
  usage: LLMUsage,
): Promise<string | null> {
  const violations = bundle.violations
    .map(v => {
      let line = `  - [${v.family}] ${v.invariant}: ${v.violation}`;
      if (v.scenarioDescription) line += `\n    Scenario: "${v.scenarioDescription}"`;
      if (v.gatesFailed?.length) line += `\n    Failed gates: ${v.gatesFailed.join(', ')}`;
      return line;
    })
    .join('\n');

  // Read the target file source if available — helps LLM spot the bug
  let targetSource = '';
  if (bundle.triage.targetFile) {
    try {
      const content = readFileSync(join(packageRoot, bundle.triage.targetFile), 'utf-8');
      const lines = content.split('\n');
      targetSource = `\n\nTARGET FILE (${bundle.triage.targetFile}, ${lines.length} lines):\n` +
        (lines.length > 200
          ? lines.slice(0, 200).join('\n') + '\n// ... truncated ...'
          : content);
    } catch { /* file not found — skip */ }
  }

  const userPrompt = `FAILURE EVIDENCE:
${violations}

Scenario IDs: ${bundle.violations.map(v => v.scenarioId).join(', ')}
${targetSource}

Look at the target file source code. What regex pattern, condition, or function is broken? Be specific — name the exact line or pattern that needs to change.`;

  const result = await callLLMWithRetry(callLLM, DIAGNOSIS_SYSTEM, userPrompt, usage);
  if (!result) return null;
  return result.text;
}

// =============================================================================
// MULTI-CANDIDATE FIX GENERATION
// =============================================================================

const FIX_SYSTEM = `You are fixing a bug in @sovereign-labs/verify, a TypeScript verification library.
You will receive failure evidence and the target source code with line numbers.

RULES:
- Propose exactly {NUM_CANDIDATES} DISTINCT fix strategies
- STRONGLY PREFER minimal fixes: change the fewest lines possible. If one line fixes the bug, that's the best strategy.
- Strategy 1 MUST be the most minimal fix (1-2 edits). Strategies 2-3 can be alternatives.
- Do NOT add new functions, new check types, or architectural changes if a regex/value fix works.
- Each strategy: JSON array of edits
- Max {MAX_LINES} changed lines per strategy
- PREFERRED: Use pattern-based edits: { "file": "path", "pattern": "wrong_substring", "replacement": "correct_substring" }
  The system will find ALL lines containing "pattern" and replace it with "replacement" in each line.
  This is the most reliable format — you only need to identify WHAT is wrong, not WHERE it is.
  The pattern must be a literal substring that appears in the buggy lines.
- FALLBACK: Use line-based edits: { "file": "path", "line": NUMBER, "replace": "full replacement line" }
- The "file" field must match the TARGET file path shown in the evidence
- Must not break existing passing scenarios
- Output ONLY valid JSON — no markdown, no explanation outside the JSON

OUTPUT FORMAT (JSON):
[
  {
    "strategy": "short name for the approach",
    "rationale": "one sentence why this works",
    "edits": [
      { "file": "TARGET_FILE_PATH_HERE", "pattern": "wrong_value", "replacement": "correct_value" }
    ]
  }
]`;

export async function generateFixCandidates(
  bundle: EvidenceBundle,
  diagnosis: string | null,
  packageRoot: string,
  callLLM: LLMCallFn,
  usage: LLMUsage,
  maxCandidates: number,
  maxLines: number,
): Promise<FixCandidate[]> {
  const targetFile = bundle.triage.targetFile;
  if (!targetFile) return [];

  // Read the target file
  let sourceContent: string;
  try {
    sourceContent = readFileSync(join(packageRoot, targetFile), 'utf-8');
  } catch {
    return [];
  }

  // Focus on the target function if file is large — show 500 lines centered on function
  const sourceLines = sourceContent.split('\n');
  let truncated: string;
  if (sourceLines.length > 500 && bundle.triage.targetFunction) {
    const funcName = bundle.triage.targetFunction.replace(/\(\)$/, '');
    const funcIdx = sourceLines.findIndex(l =>
      l.includes(`function ${funcName}`) ||
      l.includes(`const ${funcName}`) ||
      l.includes(`${funcName}(`) ||
      l.includes(`${funcName} =`) ||
      new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?${funcName}\\s*[(<]`).test(l)
    );
    if (funcIdx >= 0) {
      // Center 500 lines around the target function
      const start = Math.max(0, funcIdx - 100);
      const end = Math.min(sourceLines.length, funcIdx + 400);
      truncated = `// ... lines 1-${start} omitted ...\n`
        + sourceLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
        + `\n// ... lines ${end + 1}-${sourceLines.length} omitted ...`;
    } else {
      truncated = sourceLines.slice(0, 500).map((l, i) => `${i + 1}: ${l}`).join('\n') + '\n// ... truncated ...';
    }
  } else {
    truncated = sourceLines.length > 500
      ? sourceLines.slice(0, 500).map((l, i) => `${i + 1}: ${l}`).join('\n') + '\n// ... truncated ...'
      : sourceLines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  }

  const violations = bundle.violations
    .map(v => {
      let line = `  - [${v.family}] ${v.invariant}: ${v.violation}`;
      if (v.scenarioDescription) line += `\n    Scenario: "${v.scenarioDescription}"`;
      if (v.gatesFailed?.length) line += `\n    Failed gates: ${v.gatesFailed.join(', ')}`;
      return line;
    })
    .join('\n');

  const diagnosisBlock = diagnosis
    ? `\nDIAGNOSIS:\n${diagnosis}\n`
    : '';

  const systemPrompt = FIX_SYSTEM
    .replace('{NUM_CANDIDATES}', String(maxCandidates))
    .replace('{MAX_LINES}', String(maxLines));

  const userPrompt = `FAILURE EVIDENCE:
${violations}

TARGET: ${bundle.triage.targetFunction ?? 'unknown'} in ${targetFile}
${diagnosisBlock}
SOURCE CODE (${targetFile}):
\`\`\`typescript
${truncated}
\`\`\`

Generate ${maxCandidates} distinct fix strategies as JSON.`;

  const result = await callLLMWithRetry(callLLM, systemPrompt, userPrompt, usage);
  if (!result) return [];

  // Debug: show raw LLM response
  console.log(`        [LLM RAW] ${result.text.length} chars, ${result.outputTokens} tokens`);
  console.log(`        [LLM RAW] ${result.text.substring(0, 2000)}`);

  // Parse JSON from response
  const candidates = parseFixCandidates(result.text, bundle.id);

  // Post-process: expand pattern-based and line-based edits into grounded search/replace.
  // The LLM describes the transformation; the code finds the actual lines.
  const expanded: FixCandidate[] = [];
  for (const c of candidates) {
    const groundedEdits: typeof c.edits = [];
    for (const e of c.edits) {
      // Pattern-based: LLM says "find X, replace with Y" — code greps file for all matches
      if (e.pattern && e.replacement) {
        try {
          const fileContent = readFileSync(join(packageRoot, e.file), 'utf-8');
          const lines = fileContent.split('\n');
          let found = 0;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(e.pattern)) {
              groundedEdits.push({
                file: e.file,
                search: lines[i],
                replace: lines[i].replace(e.pattern, e.replacement),
              });
              console.log(`        [PATTERN] ${e.file}:${i + 1} "${e.pattern}" → "${e.replacement}"`);
              found++;
            }
          }
          if (found === 0) console.log(`        [PATTERN] ${e.file}: "${e.pattern}" not found`);
        } catch { console.log(`        [PATTERN] ${e.file}: file not found`); }
        continue;
      }
      // Line-based: read actual line content as search string
      if (e.line != null && !e.search) {
        try {
          const fileContent = readFileSync(join(packageRoot, e.file), 'utf-8');
          const lines = fileContent.split('\n');
          const idx = e.line - 1;
          if (idx >= 0 && idx < lines.length) {
            e.search = lines[idx];
            console.log(`        [LINE→SEARCH] ${e.file}:${e.line} → "${e.search.substring(0, 80)}"`);
          }
        } catch { /* file not found */ }
      }
      groundedEdits.push(e);
    }
    if (groundedEdits.length > 0) {
      expanded.push({ ...c, edits: groundedEdits });
    }
  }
  return expanded;
}

function parseFixCandidates(text: string, bundleId: string): FixCandidate[] {
  const parsed = extractJSON<Array<{
    strategy?: string;
    rationale?: string;
    edits?: Array<{ file?: string; search?: string; replace?: string; line?: number; pattern?: string; replacement?: string }>;
  }>>(text);

  if (!parsed || !Array.isArray(parsed)) {
    console.log(`        [PARSE] Failed to extract JSON from LLM response (${text.length} chars)`);
    return [];
  }

  return parsed
    .filter(p => p.edits && Array.isArray(p.edits) && p.edits.length > 0)
    .map((p, i) => ({
      id: `${bundleId}_fix_${i + 1}`,
      strategy: p.strategy ?? `strategy_${i + 1}`,
      rationale: p.rationale ?? '',
      edits: (p.edits ?? [])
        .filter(e => e.file && (
          (e.pattern && e.replacement) ||  // pattern-based
          (e.replace && (e.search || e.line != null))  // line or search-based
        ))
        .map(e => ({
          file: e.file!,
          ...(e.pattern && e.replacement
            ? { pattern: e.pattern, replacement: e.replacement, replace: '' }
            : { replace: e.replace!, ...(e.line != null ? { line: e.line } : { search: e.search! }) }),
        })),
    }))
    .filter(c => c.edits.length > 0);
}
