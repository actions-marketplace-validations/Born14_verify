/**
 * full-corpus-reverts.ts — Path B: full-corpus revert discovery scan.
 *
 * Inverts historical-followup.ts's input: instead of starting from DM-18
 * calibration findings and scanning forward for follow-up evidence, this
 * script walks every migration in every sequence, extracts the column-level
 * changes each migration introduces, and scans the next N migrations for
 * revert/fix evidence against those columns. Output is a list of candidate
 * revert pairs spanning the full corpus, independent of any existing rule.
 *
 * Discovery tool. Not a calibration run. Produces no precision numbers.
 * Output is reused by a later pre-fix pipeline session to build a
 * revert-derived corpus for DM-15 / DM-16 / DM-17 calibration attempts.
 *
 * Usage: bun run scripts/mvp-migration/full-corpus-reverts.ts
 */
import { loadModule } from 'libpg-query';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO_ADAPTERS, CLONE_DIR_NAME } from './repo-adapter';
import type { MigrationFile, MigrationSequence } from './repo-adapter';

const CORPUS_DIR = join(import.meta.dir, 'corpus');
const CLONE_DIR = join(CORPUS_DIR, CLONE_DIR_NAME);
const REPORT_DIR = join(import.meta.dir, 'reports');
const CALIBRATION_PATH = join(REPORT_DIR, 'calibration-postfix-2026-04-12.jsonl');
const LOOKAHEAD = 10; // scan this many migrations after the originating one

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChangeType =
  | 'set_not_null'
  | 'add_not_null'
  | 'add_column'
  | 'drop_column'
  | 'alter_type'
  | 'add_unique'
  | 'drop_constraint';

interface ColumnChange {
  table: string;
  column: string;
  change_type: ChangeType;
  line_excerpt: string;
}

interface RevertCandidate {
  repo: string;
  sequence: string;
  original_migration: string;
  original_migration_idx: number;
  revert_migration: string;
  revert_migration_idx: number;
  table: string;
  column: string;
  original_change: ChangeType;
  revert_evidence_type: string;
  revert_evidence_confidence: 'strong' | 'moderate' | 'weak';
  revert_evidence_excerpt: string;
  gap_migrations: number;
  matches_existing_dm18_finding: boolean;
}

// ---------------------------------------------------------------------------
// Evidence patterns — reused shape from historical-followup.ts
// ---------------------------------------------------------------------------

interface EvidenceHit {
  type: string;
  confidence: 'strong' | 'moderate' | 'weak';
  excerpt: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLine(sql: string, needle: string): string {
  const idx = sql.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return needle;
  const before = sql.lastIndexOf('\n', idx);
  const after = sql.indexOf('\n', idx);
  const line = sql.slice(before + 1, after === -1 ? undefined : after).trim();
  return line.length > 200 ? line.slice(0, 197) + '...' : line;
}

function searchForEvidence(sql: string, table: string, column: string): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  const tableLower = table.toLowerCase();
  const columnLower = column.toLowerCase();

  // drop_not_null_revert — strong: explicit revert of SET NOT NULL
  const dropNotNullPattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*alter\\s+(?:column\\s+)?["']?${escapeRegex(columnLower)}["']?\\s+drop\\s+not\\s+null`,
    'is',
  );
  if (dropNotNullPattern.test(sql)) {
    hits.push({ type: 'drop_not_null_revert', confidence: 'strong', excerpt: extractLine(sql, 'DROP NOT NULL') });
  }

  // drop_column_revert — strong: later migration drops the column the earlier added/changed
  const dropColumnPattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*drop\\s+column(?:\\s+if\\s+exists)?\\s+["']?${escapeRegex(columnLower)}["']?`,
    'is',
  );
  if (dropColumnPattern.test(sql)) {
    hits.push({ type: 'drop_column_revert', confidence: 'strong', excerpt: extractLine(sql, 'DROP COLUMN') });
  }

  // alter_type_change — strong: later migration changes type on same column
  const alterTypePattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*alter\\s+(?:column\\s+)?["']?${escapeRegex(columnLower)}["']?\\s+(?:set\\s+data\\s+)?type\\s+`,
    'is',
  );
  if (alterTypePattern.test(sql)) {
    hits.push({ type: 'alter_type_change', confidence: 'strong', excerpt: extractLine(sql, 'TYPE') });
  }

  // set_default_after — strong: fix by adding a default
  const setDefaultPattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*alter\\s+(?:column\\s+)?["']?${escapeRegex(columnLower)}["']?\\s+set\\s+default`,
    'is',
  );
  if (setDefaultPattern.test(sql)) {
    hits.push({ type: 'set_default_after', confidence: 'strong', excerpt: extractLine(sql, 'SET DEFAULT') });
  }

  // backfill_update — strong: UPDATE on same table/column
  const updatePattern = new RegExp(
    `update\\s+["']?${escapeRegex(tableLower)}["']?\\s+set\\s+.*["']?${escapeRegex(columnLower)}["']?`,
    'i',
  );
  if (updatePattern.test(sql)) {
    const match = sql.match(updatePattern);
    hits.push({ type: 'backfill_update', confidence: 'strong', excerpt: extractLine(sql, match?.[0] || '') });
  }

  // Path B v2 — evidence patterns for destructive originating events
  // (drop_column, drop_table, alter_type used as originators, not reverts).

  // add_column_restore — later migration re-adds the same column on same table
  const addColumnRestorePattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*add\\s+column(?:\\s+if\\s+not\\s+exists)?\\s+["']?${escapeRegex(columnLower)}["']?`,
    'is',
  );
  if (addColumnRestorePattern.test(sql)) {
    hits.push({ type: 'add_column_restore', confidence: 'strong', excerpt: extractLine(sql, 'ADD COLUMN') });
  }

  // add_constraint_restore — later migration adds an FK constraint mentioning the column
  const addConstraintRestorePattern = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*add\\s+constraint\\s+\\w+.*foreign\\s+key\\s*\\(\\s*["']?${escapeRegex(columnLower)}["']?`,
    'is',
  );
  if (addConstraintRestorePattern.test(sql)) {
    hits.push({ type: 'add_constraint_restore', confidence: 'strong', excerpt: extractLine(sql, 'FOREIGN KEY') });
  }

  // create_table_restore — later migration creates a table with the same name
  // (the "column" slot is unused for drop_table originators; the caller passes
  // the dropped table name as both table and column, or we just search for the
  // CREATE TABLE by name).
  const createTableRestorePattern = new RegExp(
    `create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+(?:["']?\\w+["']?\\.)?["']?${escapeRegex(tableLower)}["']?`,
    'i',
  );
  if (createTableRestorePattern.test(sql)) {
    hits.push({ type: 'create_table_restore', confidence: 'strong', excerpt: extractLine(sql, 'CREATE TABLE') });
  }

  // alter_type_back — later migration changes type on same column (any direction).
  // This is the same regex as alter_type_change above; we emit a distinct type
  // tag so the semantic-match filter can treat it as the v2 originator-pairing.
  if (/alter\s+column/i.test(sql)) {
    const alterTypeBackPattern = new RegExp(
      `alter\\s+(?:table\\s+)?["']?${escapeRegex(tableLower)}["']?.*alter\\s+(?:column\\s+)?["']?${escapeRegex(columnLower)}["']?\\s+(?:set\\s+data\\s+)?type\\s+`,
      'is',
    );
    if (alterTypeBackPattern.test(sql)) {
      hits.push({ type: 'alter_type_back', confidence: 'strong', excerpt: extractLine(sql, 'TYPE') });
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Column-change extraction (regex-based, matches historical-followup's style)
// ---------------------------------------------------------------------------

function extractChanges(sql: string): ColumnChange[] {
  const out: ColumnChange[] = [];

  // Normalize: strip line comments but keep structure
  const lines = sql.split('\n');

  // Track current ALTER TABLE target as we walk lines — Postgres migrations
  // commonly split ALTER TABLE / ALTER COLUMN across multiple lines.
  let currentTable: string | null = null;

  const alterTableRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:["']?\w+["']?\.)?["']?(\w+)["']?/i;
  const createTableRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["']?\w+["']?\.)?["']?(\w+)["']?/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    const atMatch = line.match(alterTableRe);
    if (atMatch) currentTable = atMatch[1];
    const ctMatch = line.match(createTableRe);
    if (ctMatch) currentTable = ctMatch[1];

    if (!currentTable) continue;

    // SET NOT NULL (ALTER COLUMN ... SET NOT NULL)
    const setNotNullMatch = line.match(/alter\s+column\s+["']?(\w+)["']?\s+set\s+not\s+null/i);
    if (setNotNullMatch) {
      out.push({
        table: currentTable,
        column: setNotNullMatch[1],
        change_type: 'set_not_null',
        line_excerpt: line.trim(),
      });
    }

    // ADD COLUMN ... NOT NULL (captures both add_column and add_not_null semantic)
    const addColMatch = line.match(/add\s+column(?:\s+if\s+not\s+exists)?\s+["']?(\w+)["']?\s+([^,;]+)/i);
    if (addColMatch) {
      const colName = addColMatch[1];
      const rest = addColMatch[2];
      const isNotNull = /not\s+null/i.test(rest);
      out.push({
        table: currentTable,
        column: colName,
        change_type: isNotNull ? 'add_not_null' : 'add_column',
        line_excerpt: line.trim(),
      });
    }

    // DROP COLUMN
    const dropColMatch = line.match(/drop\s+column(?:\s+if\s+exists)?\s+["']?(\w+)["']?/i);
    if (dropColMatch) {
      out.push({
        table: currentTable,
        column: dropColMatch[1],
        change_type: 'drop_column',
        line_excerpt: line.trim(),
      });
    }

    // DROP TABLE — standalone statement, table name captured directly
    // (does not depend on currentTable since DROP TABLE names its own target).
    const dropTableMatch = line.match(/drop\s+table(?:\s+if\s+exists)?\s+(?:["']?\w+["']?\.)?["']?(\w+)["']?/i);
    if (dropTableMatch) {
      const droppedName = dropTableMatch[1];
      out.push({
        // For drop_table, both table and column fields hold the table name —
        // the evidence search for create_table_restore looks up by table, and
        // this keeps the row shape uniform with other ColumnChange rows.
        table: droppedName,
        column: droppedName,
        change_type: 'drop_table',
        line_excerpt: line.trim(),
      });
    }

    // ALTER COLUMN ... TYPE
    const alterTypeMatch = line.match(/alter\s+column\s+["']?(\w+)["']?\s+(?:set\s+data\s+)?type\s+/i);
    if (alterTypeMatch) {
      out.push({
        table: currentTable,
        column: alterTypeMatch[1],
        change_type: 'alter_type',
        line_excerpt: line.trim(),
      });
    }

    // ADD CONSTRAINT ... UNIQUE (column captured if single-column inline)
    const addUniqueMatch = line.match(/add\s+constraint\s+\w+\s+unique\s*\(\s*["']?(\w+)["']?/i);
    if (addUniqueMatch) {
      out.push({
        table: currentTable,
        column: addUniqueMatch[1],
        change_type: 'add_unique',
        line_excerpt: line.trim(),
      });
    }

    // DROP CONSTRAINT (constraint name stored in "column" slot — coarse but useful)
    const dropConstraintMatch = line.match(/drop\s+constraint(?:\s+if\s+exists)?\s+["']?(\w+)["']?/i);
    if (dropConstraintMatch) {
      out.push({
        table: currentTable,
        column: dropConstraintMatch[1],
        change_type: 'drop_constraint',
        line_excerpt: line.trim(),
      });
    }

    // Reset currentTable at statement terminators if followed by clearly unrelated content
    if (lineLower.trim().endsWith(';')) {
      // Don't reset — next ALTER TABLE will overwrite anyway. Resetting here would
      // lose multi-line ALTER TABLE blocks where subcommands span past semicolons
      // (rare but possible in migrations with multiple ALTER TABLE stanzas).
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Load existing DM-18 calibration findings for matching
// ---------------------------------------------------------------------------

interface Dm18Row {
  repo: string;
  file: string;
  reason: string;
  label: string;
}

function loadDm18Tuples(): Set<string> {
  const s = new Set<string>();
  if (!existsSync(CALIBRATION_PATH)) return s;
  const lines = readFileSync(CALIBRATION_PATH, 'utf-8').trim().split('\n');
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const row = JSON.parse(l) as Dm18Row;
      if (row.label !== 'TP') continue;
      // Extract table.column from reason field (matches historical-followup logic)
      const m = row.reason.match(/(?:ADD COLUMN|SET NOT NULL on)\s+(\w+)\.(\w+)/i);
      if (m) {
        // Key by (repo, table, column). original_migration file name is truncated
        // in the calibration file so we match on the triple instead.
        s.add(`${row.repo}|${m[1].toLowerCase()}|${m[2].toLowerCase()}`);
      }
    } catch {
      // skip malformed line
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadModule();

  console.log('=== PATH B: FULL-CORPUS REVERT DISCOVERY SCAN ===\n');

  const dm18Tuples = loadDm18Tuples();
  console.log(`Loaded ${dm18Tuples.size} DM-18 TP tuples for matching\n`);

  // Load migration sequences per repo
  const allSequences: Array<{ repo: string; seq: MigrationSequence }> = [];
  for (const [name, adapter] of Object.entries(REPO_ADAPTERS)) {
    const root = join(CLONE_DIR, name);
    if (!existsSync(root)) {
      console.log(`  ⚠ ${name}: clone not found at ${root}, skipping`);
      continue;
    }
    const seqs = adapter.getSequences(root);
    for (const seq of seqs) {
      allSequences.push({ repo: name, seq });
    }
    console.log(`  ${name}: ${seqs.length} sequence(s), ${seqs.reduce((a, s) => a + s.migrations.length, 0)} migrations`);
  }

  const totalMigrations = allSequences.reduce((a, s) => a + s.seq.migrations.length, 0);
  console.log(`\nTotal migrations across all sequences: ${totalMigrations}\n`);

  const candidates: RevertCandidate[] = [];
  let totalChanges = 0;
  let totalScans = 0;

  for (const { repo, seq } of allSequences) {
    for (let i = 0; i < seq.migrations.length; i++) {
      const mig = seq.migrations[i];
      const changes = extractChanges(mig.sql);
      totalChanges += changes.length;

      for (const change of changes) {
        // Scan next LOOKAHEAD migrations for revert evidence
        const endIdx = Math.min(i + 1 + LOOKAHEAD, seq.migrations.length);
        for (let j = i + 1; j < endIdx; j++) {
          totalScans++;
          const laterMig = seq.migrations[j];
          const hits = searchForEvidence(laterMig.sql, change.table, change.column);
          if (hits.length === 0) continue;

          // Pick strongest hit
          const order = { strong: 0, moderate: 1, weak: 2 };
          const best = hits.sort((a, b) => order[a.confidence] - order[b.confidence])[0];

          // Self-revert filter: only count if the revert makes semantic sense for
          // this change type. E.g., drop_not_null only reverts set_not_null /
          // add_not_null; drop_column only reverts add_column / add_not_null.
          const semanticMatch =
            // v1 pairs (additive originators)
            (best.type === 'drop_not_null_revert' && (change.change_type === 'set_not_null' || change.change_type === 'add_not_null')) ||
            (best.type === 'drop_column_revert' && (change.change_type === 'add_column' || change.change_type === 'add_not_null')) ||
            (best.type === 'alter_type_change' && change.change_type === 'alter_type') ||
            (best.type === 'set_default_after' && (change.change_type === 'set_not_null' || change.change_type === 'add_not_null' || change.change_type === 'add_column')) ||
            (best.type === 'backfill_update' && (change.change_type === 'set_not_null' || change.change_type === 'add_not_null' || change.change_type === 'add_column')) ||
            // v2 pairs (destructive originators)
            (best.type === 'add_column_restore' && change.change_type === 'drop_column') ||
            (best.type === 'add_constraint_restore' && change.change_type === 'drop_column') ||
            (best.type === 'create_table_restore' && change.change_type === 'drop_table') ||
            (best.type === 'alter_type_back' && change.change_type === 'alter_type');

          if (!semanticMatch) continue;

          const tuple = `${repo}|${change.table.toLowerCase()}|${change.column.toLowerCase()}`;

          candidates.push({
            repo,
            sequence: seq.name,
            original_migration: mig.relPath,
            original_migration_idx: i,
            revert_migration: laterMig.relPath,
            revert_migration_idx: j,
            table: change.table,
            column: change.column,
            original_change: change.change_type,
            revert_evidence_type: best.type,
            revert_evidence_confidence: best.confidence,
            revert_evidence_excerpt: best.excerpt,
            gap_migrations: j - i,
            matches_existing_dm18_finding: dm18Tuples.has(tuple),
          });

          // Only keep the first revert pair per (change, revert-type) to avoid
          // exploding counts from the same revert matching many later scans.
          break;
        }
      }
    }
  }

  console.log(`Extracted ${totalChanges} column changes across ${totalMigrations} migrations`);
  console.log(`Performed ${totalScans} forward scans`);
  console.log(`Revert candidates found: ${candidates.length}\n`);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('='.repeat(70));
  console.log('PATH B REVERT DISCOVERY SUMMARY');
  console.log('='.repeat(70));

  const byRepo = new Map<string, number>();
  const byChangeType = new Map<string, number>();
  const byEvidenceType = new Map<string, number>();
  let matchingDm18 = 0;
  let novel = 0;

  for (const c of candidates) {
    byRepo.set(c.repo, (byRepo.get(c.repo) || 0) + 1);
    byChangeType.set(c.original_change, (byChangeType.get(c.original_change) || 0) + 1);
    byEvidenceType.set(c.revert_evidence_type, (byEvidenceType.get(c.revert_evidence_type) || 0) + 1);
    if (c.matches_existing_dm18_finding) matchingDm18++;
    else novel++;
  }

  console.log(`\nTotal revert candidates:      ${candidates.length}`);
  console.log(`  Matching existing DM-18 TP: ${matchingDm18}`);
  console.log(`  Novel (not seen by DM-18):  ${novel}`);

  console.log(`\nBy repo:`);
  for (const [k, v] of [...byRepo.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  console.log(`\nBy original change_type:`);
  for (const [k, v] of [...byChangeType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  console.log(`\nBy revert evidence type:`);
  for (const [k, v] of [...byEvidenceType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${v}`);
  }

  // Gap distribution
  const gaps = candidates.map((c) => c.gap_migrations).sort((a, b) => a - b);
  if (gaps.length > 0) {
    const median = gaps[Math.floor(gaps.length / 2)];
    const max = gaps[gaps.length - 1];
    const min = gaps[0];
    console.log(`\nGap distribution (migrations between original and revert):`);
    console.log(`  min=${min}  median=${median}  max=${max}`);
  }

  // Write output
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = join(REPORT_DIR, `full-corpus-reverts-${stamp}.jsonl`);
  writeFileSync(outPath, candidates.map((c) => JSON.stringify(c)).join('\n') + (candidates.length ? '\n' : ''));
  console.log(`\nResults written to: ${outPath}`);

  const summaryPath = join(REPORT_DIR, `full-corpus-reverts-${stamp}-summary.json`);
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        lookahead: LOOKAHEAD,
        total_migrations: totalMigrations,
        total_changes_extracted: totalChanges,
        total_forward_scans: totalScans,
        total_candidates: candidates.length,
        matching_existing_dm18: matchingDm18,
        novel: novel,
        by_repo: Object.fromEntries(byRepo),
        by_change_type: Object.fromEntries(byChangeType),
        by_evidence_type: Object.fromEntries(byEvidenceType),
        gap_stats: gaps.length > 0 ? { min: gaps[0], median: gaps[Math.floor(gaps.length / 2)], max: gaps[gaps.length - 1] } : null,
        notes: [
          'Path B is discovery, not calibration. No precision number is computed.',
          'Output JSONL is reusable input for a later pre-fix pipeline session.',
          'Do not make DM-28 promotion decisions from the summary alone — the manual review of individual revert pairs is the actual discovery work.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Summary written to: ${summaryPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
