/**
 * PR Comment Formatter
 * =====================
 *
 * Formats verify gate results as a markdown PR comment.
 */

import type { VerifyResult, GateResult } from '../types.js';

export interface CommentOptions {
  /** PR number for link */
  prNumber?: number;
  /** How many predicates were generated */
  predicateCount?: number;
  /** Which tiers were used */
  tiers?: string[];
  /** Duration in ms */
  durationMs?: number;
}

/**
 * Format verify results as a markdown PR comment.
 */
export function formatComment(result: VerifyResult, opts?: CommentOptions): string {
  const lines: string[] = [];

  // Header
  const icon = result.success ? '\u2705' : '\u274C';
  lines.push(`## ${icon} Verify Agent Check`);
  lines.push('');

  // Summary line
  const passed = result.gates.filter(g => g.passed).length;
  const failed = result.gates.filter(g => !g.passed).length;
  const total = result.gates.length;

  if (result.success) {
    lines.push(`**All ${total} gates passed.** This PR looks structurally sound.`);
  } else {
    lines.push(`**${failed} of ${total} gates failed.** Issues found in this PR.`);
  }
  lines.push('');

  // Gate results table
  lines.push('| Gate | Status | Detail |');
  lines.push('|------|--------|--------|');

  for (const g of result.gates) {
    const status = g.passed ? '\u2705 Pass' : '\u274C Fail';
    const detail = truncate(g.detail || '', 80);
    const name = formatGateName(g.gate);
    lines.push(`| ${name} | ${status} | ${detail} |`);
  }
  lines.push('');

  // Failed gate details (expanded)
  const failures = result.gates.filter(g => !g.passed);
  if (failures.length > 0) {
    lines.push('### Issues');
    lines.push('');
    for (const g of failures) {
      lines.push(`**${formatGateName(g.gate)}:** ${g.detail}`);
      lines.push('');
    }
  }

  // Predicate results if available
  if (result.predicateResults && result.predicateResults.length > 0) {
    const predFailed = result.predicateResults.filter(p => !p.passed);
    if (predFailed.length > 0) {
      lines.push('### Predicate Failures');
      lines.push('');
      for (const p of predFailed) {
        lines.push(`- **${p.type}**: expected \`${p.expected}\`, got \`${p.actual}\`${p.detail ? ` \u2014 ${p.detail}` : ''}`);
      }
      lines.push('');
    }
  }

  // Footer
  lines.push('<details>');
  lines.push('<summary>Details</summary>');
  lines.push('');
  if (opts?.predicateCount) lines.push(`- Predicates checked: ${opts.predicateCount}`);
  if (opts?.tiers) lines.push(`- Extraction tiers: ${opts.tiers.join(', ')}`);
  if (opts?.durationMs) lines.push(`- Duration: ${(opts.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Gates run: ${total} (${passed} passed, ${failed} failed)`);
  lines.push(`- Timing: ${result.timing.totalMs}ms`);
  lines.push('');
  lines.push('Powered by [@sovereign-labs/verify](https://www.npmjs.com/package/@sovereign-labs/verify) \u2014 deterministic verification of agent edits.');
  lines.push('Questions? [GitHub Discussions](https://github.com/Born14/verify/discussions)');
  lines.push('');
  lines.push('</details>');

  return lines.join('\n');
}

function formatGateName(gate: string): string {
  const names: Record<string, string> = {
    grounding: 'Grounding',
    F9: 'Syntax (F9)',
    K5: 'Constraints (K5)',
    G5: 'Containment (G5)',
    staging: 'Staging',
    browser: 'Browser',
    http: 'HTTP',
    invariants: 'Invariants',
    security: 'Security',
    a11y: 'Accessibility',
    performance: 'Performance',
    access: 'Access Control',
    temporal: 'Temporal',
    propagation: 'Propagation',
    state: 'State',
    capacity: 'Capacity',
    contention: 'Contention',
    observation: 'Observation',
    triangulation: 'Triangulation',
    vision: 'Vision',
    filesystem: 'Filesystem',
    config: 'Config',
    serialization: 'Serialization',
    infrastructure: 'Infrastructure',
    hallucination: 'Hallucination',
    content: 'Content',
  };
  return names[gate] ?? gate;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}
