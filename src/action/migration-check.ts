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

/**
 * One independent group of migrations sharing a schema.
 *
 * Each migration root in a repo (e.g., "packages/api/migrations" and
 * "packages/web/migrations") gets its own MigrationGroup with its own
 * bootstrap SQL and its own new files. Schemas are NEVER shared across
 * roots — that would let tables from one app satisfy lookups for another.
 */
export interface MigrationGroup {
  /** Migration root directory, used for reporting */
  root: string;
  /** SQL content of prior migrations in this root, in order, for schema bootstrap */
  priorMigrationsSql: string[];
  /** New migration files in this PR for this root, ordered by path */
  newFiles: Array<{ path: string; sql: string }>;
}

export interface MigrationCheckResult {
  /** Did any blocking findings occur across all groups? */
  passed: boolean;
  /** All findings across all groups (blocking + warning) */
  findings: MigrationFinding[];
  /** Migration files that were checked across all groups */
  filesChecked: string[];
  /** Per-group schema sizes for the report */
  groupSummaries: Array<{ root: string; schemaTableCount: number; fileCount: number; findingCount: number }>;
  /** Any errors during processing */
  errors: string[];
}

/**
 * Check migration files from a PR, partitioned by migration root.
 *
 * Each MigrationGroup is processed independently with its own schema —
 * tables from one root cannot satisfy lookups in another.
 */
export async function checkMigrations(
  groups: MigrationGroup[],
): Promise<MigrationCheckResult> {
  const errors: string[] = [];
  const allFindings: MigrationFinding[] = [];
  const filesChecked: string[] = [];
  const groupSummaries: MigrationCheckResult['groupSummaries'] = [];

  // Lazy-load the heavy modules (WASM init)
  const { loadModule } = await import('libpg-query');
  const { createEmptySchema, applyMigrationSQL } = await import('../../scripts/mvp-migration/schema-loader.js');
  const { parseMigration } = await import('../../scripts/mvp-migration/spec-from-ast.js');
  const { runGroundingGate } = await import('../../scripts/mvp-migration/grounding-gate.js');
  const { runSafetyGate } = await import('../../scripts/mvp-migration/safety-gate.js');

  await loadModule();

  for (const group of groups) {
    // Each group gets a fresh schema — never shared across roots
    const schema = createEmptySchema();

    // Bootstrap from this root's prior migrations only
    for (const sql of group.priorMigrationsSql) {
      try {
        applyMigrationSQL(schema, sql);
      } catch {
        // Non-fatal — prior migration may contain unsupported SQL
      }
    }

    let groupFindingCount = 0;

    // Check each new migration file in this root, in order
    for (const file of group.newFiles) {
      filesChecked.push(file.path);

      try {
        const spec = parseMigration(file.sql, file.path);

        if (spec.meta.parseErrors.length > 0) {
          errors.push(`${file.path}: parse error — ${spec.meta.parseErrors[0]}`);
          continue;
        }

        const grounding = runGroundingGate(spec, schema);
        const safety = runSafetyGate(spec, schema);

        for (const f of [...grounding, ...safety]) {
          // Downgrade non-blocking warning-only shapes
          if (!BLOCKING_SHAPES.has(f.shapeId) && WARNING_SHAPES.has(f.shapeId)) {
            f.severity = 'warning';
          }
          allFindings.push(f);
          groupFindingCount++;
        }

        // Advance schema for subsequent files in the same group
        try {
          applyMigrationSQL(schema, file.sql);
        } catch {}
      } catch (err: any) {
        errors.push(`${file.path}: ${err.message}`);
      }
    }

    groupSummaries.push({
      root: group.root,
      schemaTableCount: schema.tables.size,
      fileCount: group.newFiles.length,
      findingCount: groupFindingCount,
    });
  }

  const hasBlockingFindings = allFindings.some(
    f => f.severity === 'error' && (BLOCKING_SHAPES.has(f.shapeId) || f.shapeId.startsWith('DM-0'))
  );

  return {
    passed: !hasBlockingFindings,
    findings: allFindings,
    filesChecked,
    groupSummaries,
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

  if (result.groupSummaries.length === 1) {
    const g = result.groupSummaries[0];
    lines.push(`Checked ${g.fileCount} migration file(s) in \`${g.root}\` against ${g.schemaTableCount} tables.`);
  } else {
    lines.push(`Checked ${result.filesChecked.length} migration file(s) across ${result.groupSummaries.length} migration roots:`);
    for (const g of result.groupSummaries) {
      lines.push(`- \`${g.root}\` — ${g.fileCount} file(s), ${g.schemaTableCount} tables, ${g.findingCount} finding(s)`);
    }
  }
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

  // Exclude test fixtures, corpus files, and scripts — these are verify's
  // own development artifacts, not the user's migration files.
  const excludes = [
    /^scripts\//i,
    /^fixtures\//i,
    /^tests?\//i,
    /corpus\//i,
  ];

  return changedFiles.filter(f =>
    patterns.some(p => p.test(f)) && !excludes.some(e => e.test(f))
  );
}
