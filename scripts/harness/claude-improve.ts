/**
 * Claude Improve Brain — Native Intelligence for the Inner Loop
 * ==============================================================
 *
 * When Claude diagnoses a verify bug, it isn't pattern-matching
 * against a prompt. It's reasoning from the architecture it built.
 *
 * This module provides Claude-specific overrides for the improve
 * loop's diagnosis and fix generation phases. The key difference
 * from the generic LLM path:
 *
 * 1. System prompts carry verify's full architectural knowledge
 * 2. Source context is enriched with related functions, not just
 *    the target function in isolation
 * 3. Fix candidates consider downstream invariant effects
 *
 * The improve loop orchestrator (improve.ts) calls the same
 * LLMCallFn interface — this module just provides the richer
 * prompts and optional source enrichment.
 */

import type { EvidenceBundle, FixCandidate, LLMCallFn, LLMUsage } from './types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { extractJSON, callLLMWithRetry } from './improve-utils.js';
import {
  CLAUDE_DIAGNOSIS_SYSTEM,
  CLAUDE_FIX_SYSTEM,
} from '../campaign/claude-brain.js';
import { getCoreTypes, getTaxonomyForViolations, RELATED_FILES, getRelatedContext } from './improve-context.js';

// RELATED_FILES and getRelatedContext are imported from improve-context.ts
// Re-export for any downstream consumers
export { RELATED_FILES };

// =============================================================================
// CLAUDE-ENHANCED DIAGNOSIS
// =============================================================================

/**
 * Diagnose a violation bundle using Claude with architectural context.
 *
 * The key difference from generic diagnosis:
 * - System prompt names specific invariant families and their contracts
 * - Claude knows the codebase structure, so it can pinpoint exact functions
 * - Response format is the same (2-3 sentence diagnosis)
 */
export async function diagnoseWithClaude(
  bundle: EvidenceBundle,
  packageRoot: string,
  callLLM: LLMCallFn,
  usage: LLMUsage,
): Promise<string | null> {
  const violations = bundle.violations
    .map(v => `  - [${v.family}] ${v.invariant}: ${v.violation}`)
    .join('\n');

  // Include the target file content if known
  let sourceContext = '';
  if (bundle.triage.targetFile) {
    const fullPath = join(packageRoot, bundle.triage.targetFile);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const truncated = content.length > 15000
          ? content.substring(0, 15000) + '\n// ... truncated ...'
          : content;
        sourceContext = `\nTARGET SOURCE (${bundle.triage.targetFile}):\n\`\`\`typescript\n${truncated}\n\`\`\``;
      } catch { /* skip */ }
    }
    // Add related files for architectural context
    sourceContext += getRelatedContext(bundle.triage.targetFile, packageRoot, 8000);
  }

  // Surgical context: type interfaces + failure taxonomy
  const coreTypes = getCoreTypes(packageRoot);
  const taxonomy = getTaxonomyForViolations(bundle.violations, packageRoot);
  const contextBlock = [
    coreTypes ? `\nTYPE CONTRACTS:\n\`\`\`typescript\n${coreTypes}\n\`\`\`` : '',
    taxonomy ? `\nFAILURE SEMANTICS (what these failure shapes catch):\n${taxonomy}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = `FAILURE EVIDENCE:
${violations}

Scenario IDs: ${bundle.violations.map(v => v.scenarioId).join(', ')}
Triage confidence: ${bundle.triage.confidence}
Target: ${bundle.triage.targetFunction ?? 'unknown'} in ${bundle.triage.targetFile ?? 'unknown'}
${sourceContext}
${contextBlock}

What is the root cause? Name the exact function, file, and explain WHY the invariant fails.`;

  const result = await callLLMWithRetry(callLLM, CLAUDE_DIAGNOSIS_SYSTEM, userPrompt, usage);
  if (!result) return null;
  return result.text;
}

// =============================================================================
// CLAUDE-ENHANCED FIX GENERATION
// =============================================================================

/**
 * Generate fix candidates using Claude with full architectural context.
 *
 * Key differences from generic fix generation:
 * - System prompt knows the bounded edit surface and frozen files
 * - Includes related files so Claude can reason about downstream effects
 * - Fix rationales reference specific invariants, not generic explanations
 */
export async function generateFixesWithClaude(
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

  // Focus on target function if file is large
  const sourceLines = sourceContent.split('\n');
  let truncated: string;
  if (sourceLines.length > 300 && bundle.triage.targetFunction) {
    const funcName = bundle.triage.targetFunction.replace(/\(\)$/, '');
    const funcIdx = sourceLines.findIndex(l =>
      l.includes(`function ${funcName}`) || l.includes(`${funcName}(`)
    );
    if (funcIdx >= 0) {
      const start = Math.max(0, funcIdx - 20);
      const end = Math.min(sourceLines.length, funcIdx + 150);
      truncated = `// ... lines 1-${start} omitted ...\n`
        + sourceLines.slice(start, end).map((l, i) => `/* ${start + i + 1} */ ${l}`).join('\n')
        + `\n// ... lines ${end + 1}-${sourceLines.length} omitted ...`;
    } else {
      truncated = sourceLines.slice(0, 300).join('\n') + '\n// ... truncated ...';
    }
  } else {
    truncated = sourceLines.length > 300
      ? sourceLines.slice(0, 300).join('\n') + '\n// ... truncated ...'
      : sourceContent;
  }

  // Get related files for architectural reasoning
  const relatedContext = getRelatedContext(targetFile, packageRoot, 8000);

  const violations = bundle.violations
    .map(v => `  - [${v.family}] ${v.invariant}: ${v.violation}`)
    .join('\n');

  const diagnosisBlock = diagnosis
    ? `\nDIAGNOSIS:\n${diagnosis}\n`
    : '';

  const systemPrompt = CLAUDE_FIX_SYSTEM
    .replace('{NUM_CANDIDATES}', String(maxCandidates))
    .replace('{MAX_LINES}', String(maxLines));

  // Surgical context: type interfaces + failure taxonomy
  const coreTypes = getCoreTypes(packageRoot);
  const taxonomy = getTaxonomyForViolations(bundle.violations, packageRoot);
  const contextBlock = [
    coreTypes ? `\nTYPE CONTRACTS:\n\`\`\`typescript\n${coreTypes}\n\`\`\`` : '',
    taxonomy ? `\nFAILURE SEMANTICS (what these failure shapes catch):\n${taxonomy}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = `FAILURE EVIDENCE:
${violations}

TARGET: ${bundle.triage.targetFunction ?? 'unknown'} in ${targetFile}
${diagnosisBlock}
SOURCE CODE (${targetFile}):
\`\`\`typescript
${truncated}
\`\`\`
${relatedContext ? `\nRELATED CONTEXT (architecturally coupled files):${relatedContext}` : ''}
${contextBlock}

Generate ${maxCandidates} distinct fix strategies as JSON.
Remember: the holdout check will catch any regressions. Your fix must not break passing scenarios.`;

  const result = await callLLMWithRetry(callLLM, systemPrompt, userPrompt, usage);
  if (!result) return [];

  // Debug output
  console.log(`        [Claude] ${result.text.length} chars, ${result.outputTokens} tokens`);
  if (result.text.length < 500) {
    console.log(`        [Claude] ${result.text}`);
  } else {
    console.log(`        [Claude] ${result.text.substring(0, 300)}...`);
  }

  return parseFixCandidates(result.text, bundle.id);
}

// =============================================================================
// RESPONSE PARSING (shared with generic path)
// =============================================================================

function parseFixCandidates(text: string, bundleId: string): FixCandidate[] {
  const parsed = extractJSON<Array<{
    strategy?: string;
    rationale?: string;
    edits?: Array<{ file?: string; search?: string; replace?: string }>;
  }>>(text);

  if (!parsed || !Array.isArray(parsed)) {
    console.log(`        [PARSE] Failed to extract JSON from Claude response (${text.length} chars)`);
    return [];
  }

  return parsed
    .filter(p => p.edits && Array.isArray(p.edits) && p.edits.length > 0)
    .map((p, i) => ({
      id: `${bundleId}_claude_${i + 1}`,
      strategy: p.strategy ?? `claude_strategy_${i + 1}`,
      rationale: p.rationale ?? '',
      edits: (p.edits ?? [])
        .filter(e => e.file && e.search && e.replace)
        .map(e => ({
          file: e.file!,
          search: e.search!,
          replace: e.replace!,
        })),
    }))
    .filter(c => c.edits.length > 0);
}
