/**
 * migration-check.ts — Migration verification for the GitHub Action.
 *
 * Detects SQL migration files in a PR, loads schema from prior migrations
 * in the base branch, runs grounding + safety gates, returns findings.
 *
 * Only DM-18 blocks merge. DM-15 is warning-only until constraint-name
 * matching is fixed.
 */
import type { MigrationFinding } from '../types-migration.js';

// Blocking shapes — these cause the check to fail
const BLOCKING_SHAPES = new Set(['DM-18']);

// Warning-only shapes — reported but don't fail the check
const WARNING_SHAPES = new Set(['DM-15', 'DM-16', 'DM-17']);

export interface MigrationCheckResult {
  /** Did any blocking findings occur? */
  passed: boolean;
  /** All findings (blocking + warning) */
  findings: MigrationFinding[];
  /** Migration files that were checked */
  filesChecked: string[];
  /** Schema table count at time of check */
  schemaTableCount: number;
  /** Any errors during processing */
  errors: string[];
}

/**
 * Check migration files from a PR diff.
 *
 * @param migrationFiles - SQL content keyed by file path
 * @param priorMigrationsSql - SQL content of all prior migrations in order, for schema bootstrapping
 */
export async function checkMigrations(
  migrationFiles: Map<string, string>,
  priorMigrationsSql: string[],
): Promise<MigrationCheckResult> {
  const errors: string[] = [];
  const allFindings: MigrationFinding[] = [];
  const filesChecked: string[] = [];

  // Lazy-load the heavy modules (WASM init)
  const { loadModule } = await import('libpg-query');
  const { createEmptySchema, applyMigrationSQL } = await import('../../scripts/mvp-migration/schema-loader.js');
  const { parseMigration } = await import('../../scripts/mvp-migration/spec-from-ast.js');
  const { runGroundingGate } = await import('../../scripts/mvp-migration/grounding-gate.js');
  const { runSafetyGate } = await import('../../scripts/mvp-migration/safety-gate.js');

  await loadModule();

  // Build schema from prior migrations
  const schema = createEmptySchema();
  for (const sql of priorMigrationsSql) {
    try {
      applyMigrationSQL(schema, sql);
    } catch (err: any) {
      // Non-fatal — prior migration may contain unsupported SQL
    }
  }

  // Check each new migration file
  for (const [filePath, sql] of migrationFiles) {
    filesChecked.push(filePath);

    try {
      const spec = parseMigration(sql, filePath);

      if (spec.meta.parseErrors.length > 0) {
        errors.push(`${filePath}: parse error — ${spec.meta.parseErrors[0]}`);
        continue;
      }

      const grounding = runGroundingGate(spec, schema);
      const safety = runSafetyGate(spec, schema);

      for (const f of [...grounding, ...safety]) {
        // Downgrade non-blocking shapes to warnings
        if (!BLOCKING_SHAPES.has(f.shapeId) && WARNING_SHAPES.has(f.shapeId)) {
          f.severity = 'warning';
        }
        // Skip shapes that aren't in either set (grounding-only findings
        // like DM-01..05 are real errors and should block)
        allFindings.push(f);
      }

      // Apply this migration to schema for subsequent files in the same PR
      try {
        applyMigrationSQL(schema, sql);
      } catch {}
    } catch (err: any) {
      errors.push(`${filePath}: ${err.message}`);
    }
  }

  const hasBlockingFindings = allFindings.some(
    f => f.severity === 'error' && (BLOCKING_SHAPES.has(f.shapeId) || f.shapeId.startsWith('DM-0'))
  );

  return {
    passed: !hasBlockingFindings,
    findings: allFindings,
    filesChecked,
    schemaTableCount: schema.tables.size,
    errors,
  };
}

/**
 * Format migration findings as a markdown section for the PR comment.
 */
export function formatMigrationComment(result: MigrationCheckResult): string {
  if (result.filesChecked.length === 0) return '';

  const lines: string[] = [];
  const icon = result.passed ? '\u2705' : '\u274C';

  lines.push(`### ${icon} Migration Verification`);
  lines.push('');
  lines.push(`Checked ${result.filesChecked.length} migration file(s) against ${result.schemaTableCount} tables in schema.`);
  lines.push('');

  if (result.findings.length === 0 && result.errors.length === 0) {
    lines.push('No issues found. Migration is structurally safe.');
    return lines.join('\n');
  }

  // Findings table
  if (result.findings.length > 0) {
    lines.push('| Shape | Severity | File | Line | Finding |');
    lines.push('|-------|----------|------|------|---------|');

    for (const f of result.findings) {
      const sevIcon = f.severity === 'error' ? '\u274C' : '\u26A0\uFE0F';
      const file = f.operation && 'table' in f.operation ? f.operation.table : '';
      const line = f.location?.line ?? '';
      const msg = f.message.length > 120 ? f.message.slice(0, 117) + '...' : f.message;
      lines.push(`| \`${f.shapeId}\` | ${sevIcon} ${f.severity} | ${file} | ${line} | ${msg} |`);
    }
    lines.push('');

    // Ack instructions for blocking findings
    const blocking = result.findings.filter(f => f.severity === 'error');
    if (blocking.length > 0) {
      lines.push('<details>');
      lines.push('<summary>How to acknowledge expected findings</summary>');
      lines.push('');
      lines.push('Add a comment to your migration file to suppress known-safe findings:');
      lines.push('```sql');
      const shapes = [...new Set(blocking.map(f => f.shapeId))];
      for (const s of shapes) {
        lines.push(`-- verify: ack ${s} <reason why this is safe>`);
      }
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }
  }

  // Errors
  if (result.errors.length > 0) {
    lines.push('**Processing errors:**');
    for (const e of result.errors) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Detect SQL migration files from a list of changed file paths.
 * Returns paths that look like migration files based on common patterns.
 */
export function detectMigrationFiles(changedFiles: string[]): string[] {
  const patterns = [
    /migrations?\/.*\.sql$/i,
    /migrate\/.*\.sql$/i,
    /db\/migrate\/.*\.sql$/i,
    /supabase\/migrations\/.*\.sql$/i,
  ];

  return changedFiles.filter(f =>
    patterns.some(p => p.test(f))
  );
}
