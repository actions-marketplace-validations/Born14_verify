/**
 * historical-followup.ts — Check whether DM-18 findings correlate with
 * subsequent fixes in the repo's migration history.
 *
 * For each TP, scan the next 10 migrations for:
 *   - backfill UPDATE on the same table/column
 *   - SET DEFAULT on the same column
 *   - DROP NOT NULL / ALTER COLUMN ... DROP NOT NULL
 *   - revert or cleanup language in SQL comments or filenames
 *
 * Usage: bun run scripts/mvp-migration/historical-followup.ts
 */
import { loadModule } from 'libpg-query';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO_ADAPTERS, CLONE_DIR_NAME } from './repo-adapter';

const CORPUS_DIR = join(import.meta.dir, 'corpus');
const CLONE_DIR = join(CORPUS_DIR, CLONE_DIR_NAME);
const REPORT_DIR = join(import.meta.dir, 'reports');
const CALIBRATION_PATH = join(REPORT_DIR, 'calibration-postfix-2026-04-12.jsonl');
const LOOKAHEAD = 10; // check this many migrations after the flagged one

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CalibrationRow {
  shapeId: string;
  repo: string;
  file: string;
  label: string;
  reason: string;
}

interface FollowupRow {
  repo: string;
  migration_file: string;
  shape_id: string;
  table: string;
  column: string;
  target_resolution: 'reason' | 'sql_second_pass' | 'unresolved';
  followup_found: boolean;
  evidence_type: string | null;
  evidence_ref: string | null;
  evidence_excerpt: string | null;
  confidence: 'strong' | 'moderate' | 'weak' | 'none';
}

// ---------------------------------------------------------------------------
// Evidence patterns
// ---------------------------------------------------------------------------

interface EvidenceHit {
  type: string;
  ref: string;
  excerpt: string;
  confidence: 'strong' | 'moderate' | 'weak';
}

function searchForEvidence(sql: string, migFile: string, table: string, column: string): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  const sqlLower = sql.toLowerCase();
  const tableLower = table.toLowerCase();
  const columnLower = column.toLowerCase();

  // Pattern 1: UPDATE on the same table setting the same column (backfill)
  // e.g., UPDATE "users" SET "name" = 'default' WHERE "name" IS NULL;
  const updatePattern = new RegExp(
    `update\\s+["']?${escapeRegex(tableLower)}["']?\\s+set\\s+.*["']?${escapeRegex(columnLower)}["']?`,
    'i'
  );
  if (updatePattern.test(sql)) {
    const match = sql.match(updatePattern);
    hits.push({
      type: 'backfill_update',
      ref: migFile,
      excerpt: extractLine(sql, match?.[0] || ''),
      confidence: 'strong',
    });
  }

  // Pattern 2: SET DEFAULT on the same column
  const setDefaultPattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*alter\\s+(?:column\\s+)?["']?${escapeRegex(columnLower)}["']?\\s+set\\s+default`,
    'is'
  );
  if (setDefaultPattern.test(sql)) {
    hits.push({
      type: 'set_default_after',
      ref: migFile,
      excerpt: extractLine(sql, 'SET DEFAULT'),
      confidence: 'strong',
    });
  }

  // Pattern 3: DROP NOT NULL on the same column (revert)
  const dropNotNullPattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*alter\\s+(?:column\\s+)?["']?${escapeRegex(columnLower)}["']?\\s+drop\\s+not\\s+null`,
    'is'
  );
  if (dropNotNullPattern.test(sql)) {
    hits.push({
      type: 'drop_not_null_revert',
      ref: migFile,
      excerpt: extractLine(sql, 'DROP NOT NULL'),
      confidence: 'strong',
    });
  }

  // Pattern 4: Column made nullable again or default added in a later migration
  // Simpler regex: just check if the column name appears in an ALTER TABLE on the same table
  const alterColumnPattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*["']?${escapeRegex(columnLower)}["']?`,
    'is'
  );
  if (alterColumnPattern.test(sql) && !updatePattern.test(sql) && !setDefaultPattern.test(sql) && !dropNotNullPattern.test(sql)) {
    hits.push({
      type: 'alter_same_column',
      ref: migFile,
      excerpt: extractLine(sql, columnLower),
      confidence: 'weak',
    });
  }

  // Pattern 5: Filename contains revert/fix/hotfix/rollback language
  const migLower = migFile.toLowerCase();
  if (/revert|rollback|hotfix|fix_|undo/.test(migLower)) {
    // And mentions the table
    if (sqlLower.includes(tableLower)) {
      hits.push({
        type: 'revert_filename',
        ref: migFile,
        excerpt: migFile,
        confidence: 'moderate',
      });
    }
  }

  // Pattern 6: SQL comment mentions the column or table with warning/fix/revert language
  const commentPattern = new RegExp(
    `--.*(?:fix|revert|rollback|workaround|hotfix|patch|backfill).*${escapeRegex(columnLower)}`,
    'i'
  );
  const commentMatch = sql.match(commentPattern);
  if (commentMatch) {
    hits.push({
      type: 'fix_comment',
      ref: migFile,
      excerpt: commentMatch[0].trim(),
      confidence: 'moderate',
    });
  }

  // Pattern 7: Prisma warning comment mentioning the column
  const prismaWarning = new RegExp(
    `Warnings:.*${escapeRegex(columnLower)}`,
    'is'
  );
  if (prismaWarning.test(sql)) {
    const warnMatch = sql.match(new RegExp(`--.*(${escapeRegex(columnLower)}).*`, 'i'));
    hits.push({
      type: 'prisma_warning_reference',
      ref: migFile,
      excerpt: warnMatch?.[0]?.trim() || 'Prisma warning references this column',
      confidence: 'weak',
    });
  }

  return hits;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLine(sql: string, needle: string): string {
  const idx = sql.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return needle;
  // Find the line containing this position
  const before = sql.lastIndexOf('\n', idx);
  const after = sql.indexOf('\n', idx);
  const line = sql.slice(before + 1, after === -1 ? undefined : after).trim();
  return line.length > 200 ? line.slice(0, 197) + '...' : line;
}

// ---------------------------------------------------------------------------
// Parse table.column from calibration reason
// ---------------------------------------------------------------------------

/**
 * Parse target table.column from a calibration row's reason field.
 * Only returns a result when BOTH table and column are present in explicit
 * `table.column` form. Returns null otherwise — caller must do a second-pass
 * lookup against the migration SQL to recover the table name.
 *
 * Integrity rule: never return an empty table name. Empty table names produce
 * regexes that match unrelated statements across the corpus and inflate
 * follow-up counts.
 */
function parseTarget(reason: string): { table: string; column: string } | null {
  // "ADD COLUMN schedule.name NOT NULL without DEFAULT"
  // "SET NOT NULL on users.email without default"
  const match = reason.match(/(?:ADD COLUMN|SET NOT NULL on)\s+(\w+)\.(\w+)/i);
  if (match && match[1] && match[2]) {
    return { table: match[1], column: match[2] };
  }
  return null;
}

/**
 * Second-pass: when the calibration reason lacks `table.column` form,
 * extract the column from the reason and find its enclosing table by
 * parsing the actual migration SQL. Returns null if either piece can't
 * be recovered with confidence.
 */
function extractTargetFromSql(reason: string, sql: string): { table: string; column: string } | null {
  // Pull a column hint from the reason — first identifier after a known verb.
  const colMatch = reason.match(/(?:ADD COLUMN|SET NOT NULL(?:\s+on)?|ALTER COLUMN)\s+["']?(\w+)["']?/i);
  if (!colMatch || !colMatch[1]) return null;
  const column = colMatch[1];

  // Walk the SQL looking for an ALTER TABLE / CREATE TABLE block that contains
  // an ADD COLUMN / SET NOT NULL / ALTER COLUMN reference to this column.
  // Pattern: capture the table name from the nearest preceding
  //   ALTER TABLE [schema.]"?table"?  or  CREATE TABLE [IF NOT EXISTS] [schema.]"?table"?
  const tableStmtRe = /(?:ALTER\s+TABLE(?:\s+IF\s+EXISTS)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:["']?\w+["']?\.)?["']?(\w+)["']?/gi;
  const colRe = new RegExp(
    `(?:ADD\\s+COLUMN(?:\\s+IF\\s+NOT\\s+EXISTS)?|ALTER\\s+COLUMN|SET\\s+NOT\\s+NULL\\s+on)\\s+["']?${escapeRegex(column)}["']?\\b`,
    'i'
  );

  // Find every table-introducing statement and the slice of SQL it owns
  // (until the next such statement). If our column reference appears in that
  // slice, the table is our match.
  const matches: Array<{ table: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = tableStmtRe.exec(sql)) !== null) {
    matches.push({ table: m[1], start: m.index });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].start;
    const end = i + 1 < matches.length ? matches[i + 1].start : sql.length;
    const slice = sql.slice(start, end);
    if (colRe.test(slice)) {
      return { table: matches[i].table, column };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadModule();

  console.log('=== HISTORICAL FOLLOW-UP ===\n');

  // Load calibration data
  const calibLines = readFileSync(CALIBRATION_PATH, 'utf-8').trim().split('\n');
  const tps = calibLines.map(l => JSON.parse(l) as CalibrationRow).filter(r => r.label === 'TP');
  console.log(`Loaded ${tps.length} TPs from calibration\n`);

  // Load migration sequences per repo
  const seqCache: Map<string, ReturnType<typeof REPO_ADAPTERS[string]['getSequences']>> = new Map();
  for (const [name, adapter] of Object.entries(REPO_ADAPTERS)) {
    const root = join(CLONE_DIR, name);
    if (existsSync(root)) {
      seqCache.set(name, adapter.getSequences(root));
    }
  }

  const results: FollowupRow[] = [];

  for (const tp of tps) {
    // First pass: try to resolve target from the calibration reason text
    let resolved = parseTarget(tp.reason);
    let resolution: 'reason' | 'sql_second_pass' | 'unresolved' =
      resolved ? 'reason' : 'unresolved';
    let table = resolved?.table ?? '';
    let column = resolved?.column ?? '';

    console.log(`--- ${tp.repo} | ${table || '?'}.${column || '?'} ---`);
    console.log(`  Source: ${tp.file}`);

    // Find which sequence and index this migration belongs to
    const sequences = seqCache.get(tp.repo) || [];
    let foundSeq: any = null;
    let foundIdx = -1;

    for (const seq of sequences) {
      for (let i = 0; i < seq.migrations.length; i++) {
        // Match by sortKey (the folder/file name used for ordering)
        const migSortKey = seq.migrations[i].sortKey;
        // The calibration file field is truncated — extract the timestamp prefix
        const tpTimestamp = tp.file.match(/^(\d{14,})/)?.[1] || '';
        if (migSortKey.startsWith(tpTimestamp) || seq.migrations[i].relPath.includes(tp.file.replace('...', ''))) {
          foundSeq = seq;
          foundIdx = i;
          break;
        }
      }
      if (foundIdx >= 0) break;
    }

    if (!foundSeq || foundIdx < 0) {
      console.log(`  ⚠ Could not locate migration in sequence`);
      results.push({
        repo: tp.repo, migration_file: tp.file, shape_id: tp.shapeId,
        table, column, target_resolution: resolution,
        followup_found: false,
        evidence_type: null, evidence_ref: null, evidence_excerpt: null,
        confidence: 'none',
      });
      continue;
    }

    // Second pass: if reason-based parse failed, try to recover the table
    // from the migration SQL itself.
    if (!resolved) {
      const sourceSql = foundSeq.migrations[foundIdx].sql as string;
      const fromSql = extractTargetFromSql(tp.reason, sourceSql);
      if (fromSql) {
        table = fromSql.table;
        column = fromSql.column;
        resolution = 'sql_second_pass';
        console.log(`  ↪ second-pass resolved target: ${table}.${column}`);
      } else {
        console.log(`  ⚠ Target unresolved — excluding from headline metrics`);
        results.push({
          repo: tp.repo, migration_file: tp.file, shape_id: tp.shapeId,
          table: '', column: '', target_resolution: 'unresolved',
          followup_found: false,
          evidence_type: null, evidence_ref: null, evidence_excerpt: null,
          confidence: 'none',
        });
        continue;
      }
    }

    console.log(`  Found at index ${foundIdx}/${foundSeq.migrations.length} in ${foundSeq.name}`);

    // Scan next LOOKAHEAD migrations for evidence
    const allHits: EvidenceHit[] = [];
    const endIdx = Math.min(foundIdx + 1 + LOOKAHEAD, foundSeq.migrations.length);

    for (let i = foundIdx + 1; i < endIdx; i++) {
      const nextMig = foundSeq.migrations[i];
      const hits = searchForEvidence(nextMig.sql, nextMig.relPath, table, column);
      allHits.push(...hits);
    }

    // Also check the SAME migration for backfill patterns (UPDATE before SET NOT NULL)
    const sameMigHits = searchForEvidence(foundSeq.migrations[foundIdx].sql, foundSeq.migrations[foundIdx].relPath, table, column);
    // Only count backfill_update from same migration
    for (const h of sameMigHits) {
      if (h.type === 'backfill_update') {
        allHits.push({ ...h, type: 'same_migration_backfill' });
      }
    }

    if (allHits.length > 0) {
      // Pick the strongest evidence
      const best = allHits.sort((a, b) => {
        const order = { strong: 0, moderate: 1, weak: 2 };
        return order[a.confidence] - order[b.confidence];
      })[0];

      console.log(`  ✓ Evidence found: ${best.type} [${best.confidence}]`);
      console.log(`    ${best.excerpt.slice(0, 100)}`);

      results.push({
        repo: tp.repo, migration_file: tp.file, shape_id: tp.shapeId,
        table, column, target_resolution: resolution,
        followup_found: true,
        evidence_type: best.type, evidence_ref: best.ref, evidence_excerpt: best.excerpt,
        confidence: best.confidence,
      });

      // Log all hits for manual review
      if (allHits.length > 1) {
        console.log(`    (${allHits.length} total hits — showing best)`);
      }
    } else {
      console.log(`  ✗ No followup evidence found in next ${LOOKAHEAD} migrations`);
      results.push({
        repo: tp.repo, migration_file: tp.file, shape_id: tp.shapeId,
        table, column, target_resolution: resolution,
        followup_found: false,
        evidence_type: null, evidence_ref: null, evidence_excerpt: null,
        confidence: 'none',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('\n\n' + '='.repeat(70));
  console.log('HISTORICAL FOLLOW-UP SUMMARY');
  console.log('='.repeat(70));

  // Integrity rule: rows with unresolved targets never contribute to
  // headline metrics. They get their own bucket so the count stays honest.
  const unresolved = results.filter(r => r.target_resolution === 'unresolved');
  const resolved = results.filter(r => r.target_resolution !== 'unresolved');
  const reasonResolved = results.filter(r => r.target_resolution === 'reason');
  const sqlResolved = results.filter(r => r.target_resolution === 'sql_second_pass');

  const withFollowup = resolved.filter(r => r.followup_found);
  const withoutFollowup = resolved.filter(r => !r.followup_found);
  const strong = resolved.filter(r => r.confidence === 'strong');
  const moderate = resolved.filter(r => r.confidence === 'moderate');
  const weak = resolved.filter(r => r.confidence === 'weak');

  console.log(`\nTotal TPs reviewed:    ${results.length}`);
  console.log(`  Resolved (counted):  ${resolved.length}`);
  console.log(`    via reason:        ${reasonResolved.length}`);
  console.log(`    via SQL 2nd pass:  ${sqlResolved.length}`);
  console.log(`  Unresolved (excluded from headline): ${unresolved.length}`);
  console.log(`\n--- Headline metrics (resolved targets only) ---`);
  console.log(`Has followup evidence: ${withFollowup.length}`);
  console.log(`No followup evidence:  ${withoutFollowup.length}`);
  console.log(`\nBy confidence:`);
  console.log(`  Strong:   ${strong.length}`);
  console.log(`  Moderate: ${moderate.length}`);
  console.log(`  Weak:     ${weak.length}`);
  console.log(`  None:     ${resolved.filter(r => r.confidence === 'none').length}`);

  if (strong.length > 0) {
    console.log(`\n=== STRONG EVIDENCE (team had to act) ===`);
    for (const r of strong) {
      console.log(`  ${r.repo} | ${r.table}.${r.column}`);
      console.log(`    Type: ${r.evidence_type}`);
      console.log(`    Ref:  ${r.evidence_ref}`);
      console.log(`    Excerpt: ${r.evidence_excerpt?.slice(0, 120)}`);
    }
  }

  // Write outputs
  const followupPath = join(REPORT_DIR, 'historical-followup-2026-04-12.jsonl');
  writeFileSync(followupPath, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nResults written to: ${followupPath}`);

  const summaryPath = join(REPORT_DIR, 'historical-followup-summary-2026-04-12.json');
  writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total_tps: results.length,
    target_resolution: {
      reason: reasonResolved.length,
      sql_second_pass: sqlResolved.length,
      unresolved: unresolved.length,
    },
    headline_note: 'Headline metrics below exclude unresolved-target rows.',
    resolved_count: resolved.length,
    has_followup: withFollowup.length,
    no_followup: withoutFollowup.length,
    by_confidence: { strong: strong.length, moderate: moderate.length, weak: weak.length, none: resolved.filter(r => r.confidence === 'none').length },
    strong_evidence: strong.map(r => ({
      repo: r.repo, table: r.table, column: r.column,
      evidence_type: r.evidence_type, evidence_ref: r.evidence_ref,
      evidence_excerpt: r.evidence_excerpt,
    })),
    unresolved_rows: unresolved.map(r => ({
      repo: r.repo, migration_file: r.migration_file,
    })),
  }, null, 2));
  console.log(`Summary written to: ${summaryPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
