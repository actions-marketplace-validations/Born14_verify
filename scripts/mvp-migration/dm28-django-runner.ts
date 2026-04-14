/**
 * dm28-django-runner.ts — DM-28 detector for Django-parsed corpora.
 *
 * Django's AlterField operations don't emit SQL at parse time. The
 * SET-NOT-NULL / DROP-NOT-NULL transitions are implicit in the `null=`
 * kwarg of the field definition. Detecting DM-28 on Django requires:
 *   1. tracking per-(model, field) nullability state across the migration
 *      sequence,
 *   2. flagging AlterField ops that transition a field from nullable to
 *      non-null (the "SET NOT NULL" moment),
 *   3. scanning forward for a later AlterField on the same (model, field)
 *      that transitions back to nullable (the "DROP NOT NULL" revert).
 *
 * This runner reads the JSONL emitted by the extended django-parser.py
 * (which now records `nullable` on CreateModel columns, AddField rows,
 * and AlterField rows) and emits the same Dm28Finding shape as the SQL
 * runner so the two outputs can be concatenated for a unified picture.
 *
 * Usage:
 *   bun scripts/mvp-migration/dm28-django-runner.ts <parsed-jsonl> <corpus-label>
 *
 * Example:
 *   bun scripts/mvp-migration/dm28-django-runner.ts \
 *     scripts/mvp-migration/reports/_rtd-parsed.jsonl \
 *     django-readthedocs-v1
 */
import { readFileSync, writeFileSync } from 'node:fs';

const LOOKAHEAD = 30; // match the SQL DM-28 runner default

// ---------------------------------------------------------------------------
// Parser JSONL row shape (mirrors django-parser.py output)
// ---------------------------------------------------------------------------

interface ParsedOp {
  django_op: string;
  line: number;
  table?: string;
  model_name?: string;
  column?: string;
  columns?: Array<{ name: string; type: string; nullable: boolean | null }>;
  field_type?: string | null;
  nullable?: boolean | null;
  new_name?: string;
  old_model_name?: string;
  new_model_name?: string;
  state_only?: boolean;
  unsupported?: boolean;
}

interface ParsedMigration {
  file: string;
  app: string;
  name: string;
  dependencies: Array<[string, string]>;
  safe_after_deploy: boolean | null;
  operations: ParsedOp[];
  parse_error?: string;
}

// ---------------------------------------------------------------------------
// Finding shape (mirrors deploy-window-gate.ts Dm28Finding)
// ---------------------------------------------------------------------------

interface Dm28DjangoFinding {
  shapeId: 'DM-28';
  severity: 'warning';
  message: string;
  table: string;
  column: string;
  originating_migration: string;
  originating_migration_idx: number;
  originating_pattern: 'alter_field_to_not_null' | 'add_field_not_null_default';
  revert_migration: string;
  revert_migration_idx: number;
  gap_migrations: number;
  corpus_id: string;
  ecosystem: 'django';
}

// ---------------------------------------------------------------------------
// Toposort (copy of django-runner.ts's logic, trimmed)
// ---------------------------------------------------------------------------

function toposort(migrations: ParsedMigration[]): ParsedMigration[] {
  const key = (m: { app: string; name: string }) => `${m.app}/${m.name}`;
  const byKey = new Map<string, ParsedMigration>();
  for (const m of migrations) byKey.set(key(m), m);

  const visited = new Set<string>();
  const temp = new Set<string>();
  const out: ParsedMigration[] = [];

  const sorted = [...migrations].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );

  function visit(m: ParsedMigration) {
    const k = key(m);
    if (visited.has(k)) return;
    if (temp.has(k)) return;
    temp.add(k);
    const deps = (m.dependencies || [])
      .map(([app, name]) => byKey.get(`${app}/${name}`))
      .filter((x): x is ParsedMigration => x !== undefined);
    for (const d of deps) visit(d);
    temp.delete(k);
    visited.add(k);
    out.push(m);
  }

  for (const m of sorted) visit(m);
  return out;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

function fieldKey(table: string, column: string): string {
  return `${table}\u0001${column}`;
}

interface OriginatingEvent {
  migration_idx: number;
  table: string;
  column: string;
  pattern: 'alter_field_to_not_null' | 'add_field_not_null_default';
}

function runDetector(
  ordered: ParsedMigration[],
  corpusId: string,
): { findings: Dm28DjangoFinding[]; stats: { total_migrations: number; originating_events: number } } {
  // Per-(table, column) nullability state. true = nullable, false = not-null.
  // Django's default when `null=` is unspecified is FALSE (required), so we
  // treat a null value in the parser output as "explicit False" when the row
  // actually carried a field (AddField, AlterField, CreateModel column).
  const nullableState = new Map<string, boolean>();

  const originating: OriginatingEvent[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const mig = ordered[i];
    if (mig.parse_error) continue;

    for (const op of mig.operations) {
      if (op.unsupported || op.state_only) continue;

      // CreateModel — initialize state for every declared column. Default
      // nullability is False when unspecified.
      if (op.django_op === 'CreateModel' && op.table && Array.isArray(op.columns)) {
        for (const c of op.columns) {
          const k = fieldKey(op.table, c.name);
          nullableState.set(k, c.nullable === true);
        }
        continue;
      }

      // AddField — initialize state for the new field. Also surface the
      // "add not null with default" pattern as an originating event, since
      // Django generates an ALTER TABLE ADD COLUMN with a backfill default
      // and subsequent writes from old app code still won't provide the value.
      if (op.django_op === 'AddField' && op.table && op.column) {
        const isNullable = op.nullable === true;
        nullableState.set(fieldKey(op.table, op.column), isNullable);
        // Only flag AddField as originating if the field is NOT nullable AND
        // the operation is on an existing table (not a CreateModel). We cannot
        // know table age from the parser output, so we approximate: if the
        // model already had other columns tracked when AddField runs, treat
        // it as a post-creation add.
        // Skipping this for first pass — conservative filter, only flag
        // alter_field_to_not_null transitions as DM-28 originators. Keeps
        // the detector strictly aligned with what the registry evidence used.
        continue;
      }

      // AlterField — the DM-28 signal. Check whether this transitions a
      // previously-nullable field to not-nullable.
      if (op.django_op === 'AlterField' && op.table && op.column) {
        const k = fieldKey(op.table, op.column);
        const prev = nullableState.get(k);
        const next = op.nullable === true;

        // prev === true means the field was known to be nullable.
        // next === false means this AlterField makes it not-null.
        if (prev === true && next === false) {
          originating.push({
            migration_idx: i,
            table: op.table,
            column: op.column,
            pattern: 'alter_field_to_not_null',
          });
        }
        nullableState.set(k, next);
        continue;
      }

      // RemoveField — drop tracking.
      if (op.django_op === 'RemoveField' && op.table && op.column) {
        nullableState.delete(fieldKey(op.table, op.column));
        continue;
      }

      // DeleteModel — drop all tracking for that table's fields.
      if (op.django_op === 'DeleteModel' && op.table) {
        const prefix = `${op.table}\u0001`;
        for (const k of [...nullableState.keys()]) {
          if (k.startsWith(prefix)) nullableState.delete(k);
        }
        continue;
      }

      // RenameField — transfer state.
      if (op.django_op === 'RenameField' && op.table && op.column && op.new_name) {
        const oldK = fieldKey(op.table, op.column);
        const val = nullableState.get(oldK);
        nullableState.delete(oldK);
        if (val !== undefined) nullableState.set(fieldKey(op.table, op.new_name), val);
        continue;
      }
    }
  }

  // Forward-scan each originating event for a later AlterField that sets
  // the same (table, column) back to nullable.
  const findings: Dm28DjangoFinding[] = [];

  for (const ev of originating) {
    const endIdx = Math.min(ev.migration_idx + 1 + LOOKAHEAD, ordered.length);
    for (let j = ev.migration_idx + 1; j < endIdx; j++) {
      const later = ordered[j];
      if (later.parse_error) continue;
      let reverted = false;
      for (const op of later.operations) {
        if (op.django_op !== 'AlterField') continue;
        if (op.table !== ev.table || op.column !== ev.column) continue;
        if (op.nullable === true) {
          reverted = true;
          break;
        }
      }
      if (reverted) {
        findings.push({
          shapeId: 'DM-28',
          severity: 'warning',
          message:
            `AlterField set ${ev.table}.${ev.column} to not-null at migration ${ev.migration_idx} ` +
            `and was later reverted at migration ${j} (gap ${j - ev.migration_idx} migrations). ` +
            `Deploy-window race signature: the transition to NOT NULL was reverted while the ` +
            `column and any backfilled data were kept.`,
          table: ev.table,
          column: ev.column,
          originating_migration: ordered[ev.migration_idx].file,
          originating_migration_idx: ev.migration_idx,
          originating_pattern: ev.pattern,
          revert_migration: later.file,
          revert_migration_idx: j,
          gap_migrations: j - ev.migration_idx,
          corpus_id: corpusId,
          ecosystem: 'django',
        });
        break; // one finding per originating event
      }
    }
  }

  return {
    findings,
    stats: {
      total_migrations: ordered.length,
      originating_events: originating.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const inputPath = process.argv[2];
  const corpusLabel = process.argv[3];
  if (!inputPath || !corpusLabel) {
    console.error('usage: bun dm28-django-runner.ts <parsed-jsonl> <corpus-label>');
    process.exit(2);
  }

  const rawLines = readFileSync(inputPath, 'utf-8').split('\n').filter((l) => l.trim());
  const migrations: ParsedMigration[] = rawLines.map((l) => JSON.parse(l));
  const ordered = toposort(migrations);

  const { findings, stats } = runDetector(ordered, corpusLabel);

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = `scripts/mvp-migration/reports/dm28-${corpusLabel}-${stamp}.jsonl`;
  writeFileSync(
    outPath,
    findings.map((f) => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : ''),
  );

  console.error(
    '[dm28-django] ' +
      JSON.stringify(
        {
          corpus: corpusLabel,
          input: inputPath,
          total_migrations: stats.total_migrations,
          originating_events: stats.originating_events,
          findings: findings.length,
          output: outPath,
        },
        null,
        2,
      ),
  );
}

main();
