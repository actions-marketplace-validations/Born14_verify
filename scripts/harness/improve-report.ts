/**
 * Improvement Report — Human-Readable Output
 * =============================================
 *
 * Formats improvement results for terminal display.
 */

import type { ImprovementEntry, LLMUsage } from './types.js';

export function printImprovementReport(entries: ImprovementEntry[], usage: LLMUsage): void {
  console.log('  ┌──────────────────────────────────────────────────┐');
  console.log('  │              IMPROVEMENT REPORT                  │');
  console.log('  └──────────────────────────────────────────────────┘\n');

  if (entries.length === 0) {
    console.log('  No evidence bundles to process — all clean.\n');
    return;
  }

  // Per-bundle results
  for (const entry of entries) {
    const icon = verdictIcon(entry.verdict);
    console.log(`  ${icon} ${entry.id}: ${entry.verdict}`);
    console.log(`     Violations: ${entry.bundle.violationCount}  Triage: ${entry.bundle.triageConfidence}`);

    if (entry.diagnosis) {
      console.log(`     Diagnosis: ${entry.diagnosis.substring(0, 120)}...`);
    }

    if (entry.candidates.length > 0) {
      console.log(`     Candidates: ${entry.candidates.length}`);
      for (const c of entry.candidates) {
        const sign = c.score > 0 ? '+' : '';
        const marker = c.candidateId === entry.winner ? ' ← WINNER' : '';
        console.log(`       • ${c.strategy}: score=${sign}${c.score} (↑${c.improvements.length} ↓${c.regressions.length})${marker}`);
      }
    }

    if (entry.winner) {
      console.log(`     Holdout: ${entry.holdoutResult}`);
      const winner = entry.candidates.find(c => c.candidateId === entry.winner);
      if (winner && entry.verdict === 'accepted') {
        console.log('\n     ACCEPTED EDITS:');
        for (const edit of winner.edits) {
          console.log(`       ${edit.file}:`);
          const searchPreview = edit.line != null ? `line:${edit.line}` : (edit.search ?? '').substring(0, 60).replace(/\n/g, '\\n');
          const replacePreview = edit.replace.substring(0, 60).replace(/\n/g, '\\n');
          console.log(`         - "${searchPreview}"`);
          console.log(`         + "${replacePreview}"`);
        }
      }
    }

    console.log('');
  }

  // Summary
  const accepted = entries.filter(e => e.verdict === 'accepted').length;
  const rejected = entries.filter(e => e.verdict.startsWith('rejected_')).length;
  const skipped = entries.filter(e => e.verdict.startsWith('skipped_')).length;

  console.log('  ────────────────────────────────────────────────────');
  console.log(`  Summary: ${accepted} accepted, ${rejected} rejected, ${skipped} skipped`);
  console.log(`  LLM cost: ${usage.calls} calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens`);
  console.log('');

  if (accepted > 0) {
    console.log('  ⚠ Accepted edits are NOT auto-applied. Review and apply manually.');
    console.log('');
  }
}

function verdictIcon(verdict: string): string {
  switch (verdict) {
    case 'accepted': return '✓';
    case 'rejected_regression': return '✗';
    case 'rejected_overfitting': return '✗';
    case 'rejected_no_fix': return '–';
    case 'skipped_all_clean': return '○';
    case 'skipped_no_llm': return '○';
    default: return '?';
  }
}
