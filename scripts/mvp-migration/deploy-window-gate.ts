/**
 * deploy-window-gate.ts — Sequence-level DM-28 detector.
 *
 * DM-28: SET NOT NULL without application-compatibility window (deploy-window
 * race). The migration executes cleanly (either a safe backfill preceded it
 * or ADD COLUMN ... NOT NULL DEFAULT provided a working default) but new
 * writes from application code running a pre-migration revision fail because
 * they do not provide a value for the column. See calibration/shapes.json
 * DM-28 for the full hypothesis and evidence.
 *
 * Design: this gate is NOT a per-file safety check. It is a sequence-level
 * post-hoc detector: given an ordered MigrationSequence, it finds every
 * (set_not_null, later drop_not_null) pair on the same table.column where
 * the drop_not_null occurs within a lookahead window, and flags the
 * originating set_not_null migration as a confirmed DM-28 incident.
 *
 * This is the first-pass detector form. It is retrospective — it only fires
 * on incidents where the team already reverted — which is exactly what is
 * needed for calibration against revert-derived corpora. A future CI-gate
 * form (a static per-file heuristic for speculative DM-28 risk) is out of
 * scope for this first pass.
 *
 * Distinct from DM-18:
 *   - DM-18 fires on SET NOT NULL that cannot execute against a non-empty
 *     table (column is nullable, no default, no backfill in the same file).
 *     DM-18 is an execution-failure shape.
 *   - DM-28 fires on SET NOT NULL that DID execute and was LATER reverted.
 *     DM-28 is a deploy-coordination-failure shape.
 *   - A migration can trigger both, either, or neither. DM-28's signal does
 *     not imply DM-18's signal and vice versa.
 */
import type { MigrationSequence, MigrationFile } from './repo-adapter';

// ---------------------------------------------------------------------------
// Shape of one finding (not the generic MigrationFinding, because DM-28's
// finding is sequence-level and carries fields that MigrationFinding does
// not accommodate)
// ---------------------------------------------------------------------------

export interface Dm28Finding {
  shapeId: 'DM-28';
  severity: 'warning';
  message: string;
  table: string;
  column: string;
  originating_migration: string;
  originating_migration_idx: number;
  originating_pattern: 'set_not_null' | 'add_column_not_null_default';
  revert_migration: string;
  revert_migration_idx: number;
  gap_migrations: number;
}

export interface Dm28GateResult {
  findings: Dm28Finding[];
  stats: {
    total_migrations: number;
    set_not_null_events: number;
    confirmed_reverts: number;
  };
}

// ---------------------------------------------------------------------------
// Regex-based originating-event extraction
// ---------------------------------------------------------------------------

interface SetNotNullEvent {
  migration_idx: number;
  table: string;
  column: string;
  pattern: 'set_not_null' | 'add_column_not_null_default';
  raw_line: string;
}

/**
 * Extract SET NOT NULL events from a single migration file. Walks lines
 * looking for ALTER TABLE context and captures every ALTER COLUMN ... SET
 * NOT NULL pair plus every ADD COLUMN ... NOT NULL DEFAULT pair.
 *
 * The ADD COLUMN ... NOT NULL DEFAULT case is included because it executes
 * cleanly (the default satisfies existing rows) but can still produce a
 * deploy-window race if application writes don't provide the column. This
 * matches the DM-28 hypothesis as recorded in the shape's description.
 *
 * The ADD COLUMN ... NOT NULL (without DEFAULT) case is DM-18 territory and
 * is NOT emitted here — DM-18 already fires on execution-time failure for
 * that pattern and we want the shapes to be disjoint on the first pass.
 */
function extractSetNotNullEvents(mig: MigrationFile, idx: number): SetNotNullEvent[] {
  const out: SetNotNullEvent[] = [];
  const lines = mig.sql.split('\n');
  let currentTable: string | null = null;

  const alterTableRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:["']?\w+["']?\.)?["']?(\w+)["']?/i;
  const createTableRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["']?\w+["']?\.)?["']?(\w+)["']?/i;

  for (const line of lines) {
    const atMatch = line.match(alterTableRe);
    if (atMatch) currentTable = atMatch[1];
    const ctMatch = line.match(createTableRe);
    if (ctMatch) currentTable = ctMatch[1];

    if (!currentTable) continue;

    // ALTER COLUMN ... SET NOT NULL
    const setNotNullMatch = line.match(/alter\s+column\s+["']?(\w+)["']?\s+set\s+not\s+null/i);
    if (setNotNullMatch) {
      out.push({
        migration_idx: idx,
        table: currentTable,
        column: setNotNullMatch[1],
        pattern: 'set_not_null',
        raw_line: line.trim(),
      });
      continue;
    }

    // ADD COLUMN ... NOT NULL DEFAULT ...
    // Captures the case where the migration succeeds cleanly (default is
    // present) but application writes may still fail. Exclude NOT NULL
    // without DEFAULT because that is DM-18.
    const addColMatch = line.match(
      /add\s+column(?:\s+if\s+not\s+exists)?\s+["']?(\w+)["']?\s+([^,;]+)/i,
    );
    if (addColMatch) {
      const col = addColMatch[1];
      const rest = addColMatch[2];
      const hasNotNull = /\bnot\s+null\b/i.test(rest);
      const hasDefault = /\bdefault\b/i.test(rest);
      if (hasNotNull && hasDefault) {
        out.push({
          migration_idx: idx,
          table: currentTable,
          column: col,
          pattern: 'add_column_not_null_default',
          raw_line: line.trim(),
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Regex-based revert detection
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return true if `sql` contains an ALTER TABLE on `table` with an ALTER
 * COLUMN ... DROP NOT NULL on `column`. Matches the same defensive pattern
 * historical-followup.ts and full-corpus-reverts.ts use.
 */
function hasDropNotNullRevert(sql: string, table: string, column: string): boolean {
  const pat = new RegExp(
    `alter\\s+(?:table\\s+)?["']?${escapeRegex(table.toLowerCase())}["']?.*alter\\s+(?:column\\s+)?["']?${escapeRegex(column.toLowerCase())}["']?\\s+drop\\s+not\\s+null`,
    'is',
  );
  return pat.test(sql);
}

// ---------------------------------------------------------------------------
// Gate entry point
// ---------------------------------------------------------------------------

const DEFAULT_LOOKAHEAD = 30;

/**
 * Walk a single sequence, extract SET NOT NULL events per migration, and
 * scan forward up to `lookahead` migrations for DROP NOT NULL on the same
 * table.column. Emit one DM-28 finding per confirmed pair.
 *
 * `lookahead` is larger than the other gates' defaults (30 vs 10) because
 * the DM-28 deploy-window signature can manifest weeks after the original
 * migration. The cal.com Team.slug incident had a 27-day gap and 5
 * intervening migrations — a 10-migration lookahead would miss it.
 */
export function runDeployWindowGate(
  sequence: MigrationSequence,
  lookahead: number = DEFAULT_LOOKAHEAD,
): Dm28GateResult {
  const findings: Dm28Finding[] = [];
  let totalEvents = 0;

  for (let i = 0; i < sequence.migrations.length; i++) {
    const events = extractSetNotNullEvents(sequence.migrations[i], i);
    totalEvents += events.length;

    for (const ev of events) {
      const endIdx = Math.min(i + 1 + lookahead, sequence.migrations.length);
      for (let j = i + 1; j < endIdx; j++) {
        const later = sequence.migrations[j];
        if (hasDropNotNullRevert(later.sql, ev.table, ev.column)) {
          findings.push({
            shapeId: 'DM-28',
            severity: 'warning',
            message:
              `${ev.pattern === 'set_not_null' ? 'SET NOT NULL' : 'ADD COLUMN NOT NULL DEFAULT'} ` +
              `on ${ev.table}.${ev.column} was later reverted at migration ${j} ` +
              `(gap ${j - i} migrations). Deploy-window race signature: the migration ` +
              `executed cleanly but a subsequent migration dropped NOT NULL on the same ` +
              `column and the column and backfilled data were kept.`,
            table: ev.table,
            column: ev.column,
            originating_migration: sequence.migrations[i].relPath,
            originating_migration_idx: i,
            originating_pattern: ev.pattern,
            revert_migration: later.relPath,
            revert_migration_idx: j,
            gap_migrations: j - i,
          });
          // One finding per (originating migration, table, column) — the first
          // matching revert wins. Prevents counting the same incident twice
          // when the revert migration touches the column multiple times.
          break;
        }
      }
    }
  }

  return {
    findings,
    stats: {
      total_migrations: sequence.migrations.length,
      set_not_null_events: totalEvents,
      confirmed_reverts: findings.length,
    },
  };
}
