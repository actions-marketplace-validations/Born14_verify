/**
 * Verify migration PR comment formatter.
 *
 * Format: precision claim first, findings table second, fix guidance third.
 */
import type { MigrationFinding } from '../types-migration.js';

const METHODOLOGY_URL =
  'https://github.com/Born14/verify/blob/main/scripts/mvp-migration/MEASURED-CLAIMS.md';

type TaggedFinding = MigrationFinding & { file: string };

function findingRow(f: TaggedFinding): string {
  const line = f.location?.line ?? '';
  const sevIcon = f.severity === 'error' ? '\u274C' : '\u26A0\uFE0F';
  const msg = f.message.length > 120 ? f.message.slice(0, 117) + '...' : f.message;
  return `| \`${f.shapeId}\` | ${sevIcon} | \`${f.file}\` | ${line} | ${msg} |`;
}

export function formatComment(
  findings: TaggedFinding[],
  filesScanned: string[],
): string | null {
  if (filesScanned.length === 0) return null;

  if (findings.length === 0) {
    return [
      '### \u2705 Verify: Migration Safety',
      '',
      `Checked ${filesScanned.length} migration file${filesScanned.length === 1 ? '' : 's'}. No issues found.`,
      '',
      `DM-18 precision: **19 TP / 0 FP** on 761 production migrations. [Methodology](${METHODOLOGY_URL})`,
    ].join('\n');
  }

  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');

  const header = [
    errors.length > 0 ? '### \u274C Verify: Migration Safety' : '### \u26A0\uFE0F Verify: Migration Safety',
    '',
    errors.length > 0
      ? `**${errors.length} blocking finding${errors.length === 1 ? '' : 's'}** in ${filesScanned.length} migration file${filesScanned.length === 1 ? '' : 's'}.`
      : `${warnings.length} warning${warnings.length === 1 ? '' : 's'} in ${filesScanned.length} migration file${filesScanned.length === 1 ? '' : 's'}. No blocking findings.`,
    '',
    `DM-18 precision: **19 TP / 0 FP** on 761 production migrations. [Methodology](${METHODOLOGY_URL})`,
    '',
    '| Shape | Sev | File | Line | Finding |',
    '|-------|-----|------|------|---------|',
  ];

  const rows = findings.map(findingRow);

  const fix = [
    '',
    '**To fix NOT NULL findings:** add a `DEFAULT` clause, or split into three steps (ADD nullable \u2192 backfill \u2192 SET NOT NULL).',
  ];

  // Suppression instructions for blocking findings
  if (errors.length > 0) {
    fix.push(
      '',
      '<details>',
      '<summary>Suppress a finding</summary>',
      '',
      'If the migration targets a known-empty table, add a SQL comment:',
      '',
      '```sql',
      '-- verify: ack DM-18 <reason>',
      '```',
      '',
      '</details>',
    );
  }

  return [...header, ...rows, ...fix].join('\n');
}
