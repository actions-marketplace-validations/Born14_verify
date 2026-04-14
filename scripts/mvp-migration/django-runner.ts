/**
 * django-runner.ts — Runs verify's safety gate against Django migrations.
 *
 * Reads JSONL emitted by django-parser.py, converts each file's operations
 * into typed MigrationOp objects, builds schema state progressively across
 * dependency-ordered migrations, runs runSafetyGate per file, and writes a
 * findings JSONL file.
 *
 * First-pass scope:
 *   - Target DM-15 (DROP COLUMN with FK dependents).
 *   - Minimum ops needed for meaningful DM-15 state: CreateModel, DeleteModel,
 *     AddField (w/ FK target), RemoveField, RenameField, RenameModel,
 *     AddConstraint (FK).
 *   - AlterField deferred (no narrowing check this pass).
 *   - RunPython / RunSQL / AddIndex / AlterUniqueTogether / AddConstraint(non-FK)
 *     etc. are skipped (parser marked them 'unsupported').
 *
 * Usage:
 *   bun scripts/mvp-migration/django-runner.ts <parsed-jsonl> <output-jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type {
  MigrationOp,
  LocatedOp,
  MigrationSpec,
  Schema,
  ColumnDef,
  Constraint,
} from '../../src/types-migration';
import { createEmptySchema, applyOp, normalizeName } from './schema-loader';
import { runSafetyGate } from './safety-gate';

// ---------------------------------------------------------------------------
// Parsed JSONL row shapes (from django-parser.py)
// ---------------------------------------------------------------------------

interface ParsedOp {
  django_op: string;
  line: number;
  table?: string;
  model_name?: string;
  column?: string;
  columns?: Array<{ name: string; type: string }>;
  foreign_keys?: Array<{ column: string; to: string }>;
  field_type?: string | null;
  fk_to?: string;
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
// Helpers
// ---------------------------------------------------------------------------

function defaultTable(appLabel: string, modelName: string): string {
  return `${appLabel}_${modelName.toLowerCase()}`;
}

/**
 * Resolve a Django FK `to=` reference to a table name.
 * Accepts "app.Model", "app.model", or bare "Model" (uses currentApp).
 * Does NOT handle Meta.db_table overrides — known first-pass limitation.
 */
function resolveFkTarget(toRef: string, currentApp: string): string {
  if (toRef.includes('.')) {
    const [app, model] = toRef.split('.', 2);
    return defaultTable(app, model);
  }
  return defaultTable(currentApp, toRef);
}

/** Topological order migrations by their dependencies. Migrations whose deps
 * aren't in the parsed set are treated as no-deps (common when deps are
 * Django's built-in apps like auth/contenttypes). Ties break by (app, name). */
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
    if (temp.has(k)) return; // cycle — skip re-entry
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
// Convert a parsed op to one or more typed MigrationOps
// ---------------------------------------------------------------------------

function convertOp(p: ParsedOp, app: string): MigrationOp[] {
  // Skip unsupported, state-only, and anything we don't have a table for.
  if (p.unsupported || p.state_only) return [];

  switch (p.django_op) {
    case 'CreateModel': {
      if (!p.table) return [];
      const columns: ColumnDef[] = (p.columns || []).map((c) => ({
        name: c.name,
        type: c.type || 'unknown',
        nullable: true, // parser doesn't introspect nullable for first pass
        hasDefault: false,
      }));
      // Ensure an `id` column exists if Django implicit PK would have been added
      if (!columns.some((c) => c.name === 'id')) {
        columns.push({ name: 'id', type: 'integer', nullable: false, hasDefault: true });
      }
      const constraints: Constraint[] = [{ type: 'primary_key', columns: ['id'] }];
      for (const fk of p.foreign_keys || []) {
        constraints.push({
          type: 'foreign_key',
          fk: {
            columns: [fk.column],
            refTable: resolveFkTarget(fk.to, app),
            refColumns: ['id'],
          },
        });
      }
      return [{ op: 'create_table', table: p.table, columns, constraints }];
    }

    case 'DeleteModel': {
      if (!p.table) return [];
      return [{ op: 'drop_table', table: p.table }];
    }

    case 'AddField': {
      if (!p.table || !p.column) return [];
      const ops: MigrationOp[] = [
        {
          op: 'add_column',
          table: p.table,
          column: {
            name: p.column,
            type: (p.field_type || 'unknown').toLowerCase(),
            nullable: true,
            hasDefault: false,
          },
        },
      ];
      if (p.fk_to) {
        ops.push({
          op: 'add_constraint',
          table: p.table,
          constraint: {
            type: 'foreign_key',
            fk: {
              columns: [p.column],
              refTable: resolveFkTarget(p.fk_to, app),
              refColumns: ['id'],
            },
          },
        });
      }
      return ops;
    }

    case 'RemoveField': {
      if (!p.table || !p.column) return [];
      return [{ op: 'drop_column', table: p.table, column: p.column }];
    }

    case 'RenameField': {
      if (!p.table || !p.column || !p.new_name) return [];
      return [{ op: 'rename_column', table: p.table, column: p.column, newName: p.new_name }];
    }

    case 'RenameModel': {
      if (!p.table || !p.new_name) return [];
      return [{ op: 'rename_table', table: p.table, newName: p.new_name }];
    }

    // AlterField, AlterModelOptions, AddIndex, AlterUniqueTogether,
    // AlterIndexTogether, RenameIndex, AddConstraint (non-FK for now),
    // RunPython, RunSQL: skipped for first pass.
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    console.error('usage: bun django-runner.ts <parsed-jsonl> <output-jsonl>');
    process.exit(2);
  }

  const rawLines = readFileSync(inputPath, 'utf-8').split('\n').filter((l) => l.trim());
  const migrations: ParsedMigration[] = rawLines.map((l) => JSON.parse(l));

  const ordered = toposort(migrations);

  const schema: Schema = createEmptySchema();
  const findingsOut: any[] = [];
  let totalOpsApplied = 0;
  let totalOpsSkipped = 0;
  const shapeCounts = new Map<string, number>();

  for (const mig of ordered) {
    if (mig.parse_error) continue;

    // Build typed LocatedOps for this file
    const located: LocatedOp[] = [];
    let opIdx = 0;
    for (const p of mig.operations) {
      const typed = convertOp(p, mig.app);
      if (typed.length === 0) {
        totalOpsSkipped++;
        continue;
      }
      for (const op of typed) {
        located.push({ opIndex: opIdx++, stmtIndex: 0, line: p.line, op });
        totalOpsApplied++;
      }
    }

    const spec: MigrationSpec = {
      file: mig.file,
      operations: located,
      raw: '', // first pass: no ack parsing
      meta: {
        totalStatements: mig.operations.length,
        supportedStatements: located.length,
        unsupportedStatements: mig.operations.length - located.length,
        parseErrors: [],
      },
    };

    // Run safety gate against schema state BEFORE applying this file's ops.
    // (runSafetyGate does per-op progressive clones internally.)
    const findings = runSafetyGate(spec, schema);

    for (const f of findings) {
      shapeCounts.set(f.shapeId, (shapeCounts.get(f.shapeId) || 0) + 1);
      findingsOut.push({
        shapeId: f.shapeId,
        severity: f.severity,
        message: f.message,
        file: mig.file,
        app: mig.app,
        migration: mig.name,
        line: f.location?.line ?? null,
        safe_after_deploy: mig.safe_after_deploy,
        operation: f.operation,
      });
    }

    // Advance schema state by applying this file's ops in order.
    for (const lop of located) {
      applyOp(schema, lop.op);
    }
  }

  writeFileSync(outputPath, findingsOut.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Summary to stderr
  const summary = {
    files: ordered.length,
    ops_applied: totalOpsApplied,
    ops_skipped: totalOpsSkipped,
    tables_in_schema: schema.tables.size,
    findings: findingsOut.length,
    by_shape: Object.fromEntries(shapeCounts),
    output: outputPath,
  };
  console.error('[django-runner]', JSON.stringify(summary, null, 2));
}

main();
