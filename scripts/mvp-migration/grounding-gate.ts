/**
 * grounding-gate.ts — Deterministic existence/dependency checks.
 *
 * Consumes a MigrationSpec + Schema, returns findings.
 * No heuristics, no LLM, no network. Pure lookup.
 *
 * Shape IDs:
 *   DM-01  Target table not found
 *   DM-02  Target column not found
 *   DM-03  FK references unknown table or column
 *   DM-04  Create target already exists (table or column)
 *   DM-05  Rename source missing or target already exists
 */
import type { Schema, MigrationSpec, MigrationOp, LocatedOp, MigrationFinding } from '../../src/types-migration';
import { normalizeName, applyOp } from './schema-loader';

/**
 * Schema prefixes for platform-managed tables that exist at runtime
 * but are not created by user migrations. FK references to these
 * tables should not trigger DM-03.
 */
const PLATFORM_SCHEMA_PREFIXES = [
  'auth.',       // Supabase Auth
  'storage.',    // Supabase Storage
  'realtime.',   // Supabase Realtime
  'extensions.', // Supabase Extensions
  'pgbouncer.',  // PgBouncer
  'pg_catalog.', // Postgres system catalog
  'information_schema.', // Postgres info schema
];

function isPlatformTable(tableName: string): boolean {
  const norm = normalizeName(tableName);
  return PLATFORM_SCHEMA_PREFIXES.some(prefix => norm.startsWith(prefix));
}

/**
 * Run grounding checks with per-op progressive schema updates.
 *
 * For each op: check it against the current working schema, then apply
 * its schema effect before checking the next op. This handles:
 * - CREATE TABLE + CREATE INDEX in the same file (inter-statement)
 * - ALTER TABLE DROP CONSTRAINT + DROP COLUMN in the same statement (intra-statement)
 *
 * IMPORTANT: This function CLONES the schema before mutating, so the
 * caller's schema is not modified. The safety gate receives the
 * original pre-migration schema for its own checks.
 */
export function runGroundingGate(spec: MigrationSpec, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const workingSchema = cloneSchema(schema);

  for (const located of spec.operations) {
    const loc = { stmtIndex: located.stmtIndex, opIndex: located.opIndex, line: located.line };

    // Check this op against current schema state
    for (const f of checkOp(located.op, workingSchema)) {
      f.location = loc;
      findings.push(f);
    }

    // Apply this op's schema effect for subsequent ops
    try { applyOp(workingSchema, located.op); } catch {}
  }

  return findings;
}

function cloneSchema(schema: Schema): Schema {
  const clone: Schema = { tables: new Map() };
  for (const [name, table] of schema.tables) {
    clone.tables.set(name, {
      columns: new Map(table.columns),
      pk: table.pk ? [...table.pk] : undefined,
      uniqueConstraints: table.uniqueConstraints.map(u => ({ ...u, columns: [...u.columns] })),
      fkOut: table.fkOut.map(fk => ({ ...fk, columns: [...fk.columns], refColumns: [...fk.refColumns] })),
      fkIn: table.fkIn.map(fk => ({ ...fk, fromColumns: [...fk.fromColumns], columns: [...fk.columns] })),
      indexes: table.indexes.map(idx => ({ ...idx, columns: [...idx.columns] })),
    });
  }
  return clone;
}

function checkOp(op: MigrationOp, schema: Schema): MigrationFinding[] {
  switch (op.op) {
    case 'create_table': return checkCreateTable(op, schema);
    case 'drop_table': return checkDropTable(op, schema);
    case 'add_column': return checkAddColumn(op, schema);
    case 'drop_column': return checkDropColumn(op, schema);
    case 'alter_column_type': return checkAlterColumnType(op, schema);
    case 'alter_column_set_not_null': return checkColumnExists(op, schema, op.table, op.column);
    case 'alter_column_drop_not_null': return checkColumnExists(op, schema, op.table, op.column);
    case 'alter_column_set_default': return checkColumnExists(op, schema, op.table, op.column);
    case 'alter_column_drop_default': return checkColumnExists(op, schema, op.table, op.column);
    case 'add_constraint': return checkAddConstraint(op, schema);
    case 'drop_constraint': return checkDropConstraint(op, schema);
    case 'create_index': return checkCreateIndex(op, schema);
    case 'drop_index': return checkDropIndex(op, schema);
    case 'rename_table': return checkRenameTable(op, schema);
    case 'rename_column': return checkRenameColumn(op, schema);
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(schema: Schema, name: string): boolean {
  return schema.tables.has(normalizeName(name));
}

function columnExists(schema: Schema, table: string, column: string): boolean {
  const t = schema.tables.get(normalizeName(table));
  return t ? t.columns.has(normalizeName(column)) : false;
}

function findClosestTable(schema: Schema, name: string): string | undefined {
  const norm = normalizeName(name);
  let best: string | undefined;
  let bestDist = Infinity;
  for (const key of schema.tables.keys()) {
    const d = levenshtein(norm, key);
    if (d < bestDist && d <= 3) { // only suggest if reasonably close
      bestDist = d;
      best = key;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function finding(shapeId: string, message: string, op: MigrationOp, severity: 'error' | 'warning' = 'error'): MigrationFinding {
  return { shapeId, message, operation: op, severity };
}

// ---------------------------------------------------------------------------
// Check functions
// ---------------------------------------------------------------------------

function checkCreateTable(op: Extract<MigrationOp, { op: 'create_table' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (op.ifNotExists) return findings; // IF NOT EXISTS is safe

  if (tableExists(schema, op.table)) {
    findings.push(finding('DM-04', `CREATE TABLE ${op.table}: table already exists`, op));
  }

  // Check FK constraints reference valid tables/columns
  for (const con of op.constraints) {
    if (con.type === 'foreign_key' && con.fk) {
      findings.push(...checkFkTarget(op, con.fk, schema));
    }
  }

  return findings;
}

function checkDropTable(op: Extract<MigrationOp, { op: 'drop_table' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (op.ifExists) return findings; // IF EXISTS is safe against missing table

  if (!tableExists(schema, op.table)) {
    const closest = findClosestTable(schema, op.table);
    const hint = closest ? ` Closest match: '${closest}'.` : '';
    findings.push(finding('DM-01', `DROP TABLE ${op.table}: table not found in schema.${hint}`, op));
  }

  return findings;
}

function checkAddColumn(op: Extract<MigrationOp, { op: 'add_column' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, op.table)) {
    const closest = findClosestTable(schema, op.table);
    const hint = closest ? ` Closest match: '${closest}'.` : '';
    findings.push(finding('DM-01', `ADD COLUMN to ${op.table}: table not found.${hint}`, op));
    return findings;
  }

  if (columnExists(schema, op.table, op.column.name)) {
    findings.push(finding('DM-04', `ADD COLUMN ${op.table}.${op.column.name}: column already exists`, op));
  }

  return findings;
}

function checkDropColumn(op: Extract<MigrationOp, { op: 'drop_column' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, op.table)) {
    findings.push(finding('DM-01', `DROP COLUMN on ${op.table}: table not found`, op));
    return findings;
  }

  if (!columnExists(schema, op.table, op.column)) {
    findings.push(finding('DM-02', `DROP COLUMN ${op.table}.${op.column}: column not found`, op));
  }

  return findings;
}

function checkAlterColumnType(op: Extract<MigrationOp, { op: 'alter_column_type' }>, schema: Schema): MigrationFinding[] {
  return checkColumnExists(op, schema, op.table, op.column);
}

function checkColumnExists(op: MigrationOp, schema: Schema, table: string, column: string): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, table)) {
    findings.push(finding('DM-01', `${op.op} on ${table}: table not found`, op));
    return findings;
  }

  if (!columnExists(schema, table, column)) {
    findings.push(finding('DM-02', `${op.op} ${table}.${column}: column not found`, op));
  }

  return findings;
}

function checkAddConstraint(op: Extract<MigrationOp, { op: 'add_constraint' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, op.table)) {
    findings.push(finding('DM-01', `ADD CONSTRAINT on ${op.table}: table not found`, op));
    return findings;
  }

  if (op.constraint.type === 'foreign_key' && op.constraint.fk) {
    findings.push(...checkFkTarget(op, op.constraint.fk, schema));
  }

  // For PK/UNIQUE, check columns exist
  if (op.constraint.columns) {
    for (const col of op.constraint.columns) {
      if (!columnExists(schema, op.table, col)) {
        findings.push(finding('DM-02', `ADD CONSTRAINT on ${op.table}: column '${col}' not found`, op));
      }
    }
  }

  return findings;
}

function checkDropConstraint(op: Extract<MigrationOp, { op: 'drop_constraint' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, op.table)) {
    findings.push(finding('DM-01', `DROP CONSTRAINT on ${op.table}: table not found`, op));
  }

  return findings;
}

function checkCreateIndex(op: Extract<MigrationOp, { op: 'create_index' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, op.table)) {
    findings.push(finding('DM-01', `CREATE INDEX on ${op.table}: table not found`, op));
    return findings;
  }

  for (const col of op.columns) {
    if (!columnExists(schema, op.table, col)) {
      findings.push(finding('DM-02', `CREATE INDEX on ${op.table}: column '${col}' not found`, op));
    }
  }

  return findings;
}

function checkDropIndex(op: Extract<MigrationOp, { op: 'drop_index' }>, schema: Schema): MigrationFinding[] {
  // Index existence is hard to verify without a full index registry; skip for now.
  // The schema loader tracks indexes but matching by name across schemas is fragile.
  return [];
}

function checkRenameTable(op: Extract<MigrationOp, { op: 'rename_table' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, op.table)) {
    findings.push(finding('DM-05', `RENAME TABLE ${op.table}: source table not found`, op));
  }

  if (tableExists(schema, op.newName)) {
    findings.push(finding('DM-05', `RENAME TABLE ${op.table} TO ${op.newName}: target already exists`, op));
  }

  return findings;
}

function checkRenameColumn(op: Extract<MigrationOp, { op: 'rename_column' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!tableExists(schema, op.table)) {
    findings.push(finding('DM-01', `RENAME COLUMN on ${op.table}: table not found`, op));
    return findings;
  }

  if (!columnExists(schema, op.table, op.column)) {
    findings.push(finding('DM-02', `RENAME COLUMN ${op.table}.${op.column}: source column not found`, op));
  }

  if (columnExists(schema, op.table, op.newName)) {
    findings.push(finding('DM-05', `RENAME COLUMN ${op.table}.${op.column} TO ${op.newName}: target already exists`, op));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// FK target validation (shared by CREATE TABLE and ADD CONSTRAINT)
// ---------------------------------------------------------------------------

function checkFkTarget(op: MigrationOp, fk: { refTable: string; refColumns: string[]; columns: string[] }, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  // Skip FK checks against platform-managed tables (auth.users, etc.)
  if (isPlatformTable(fk.refTable)) return findings;

  if (!tableExists(schema, fk.refTable)) {
    const closest = findClosestTable(schema, fk.refTable);
    const hint = closest ? ` Closest match: '${closest}'.` : '';
    findings.push(finding('DM-03',
      `FK references table '${fk.refTable}' which does not exist.${hint}`, op));
    return findings;
  }

  for (const col of fk.refColumns) {
    if (!columnExists(schema, fk.refTable, col)) {
      findings.push(finding('DM-03',
        `FK references column '${fk.refTable}.${col}' which does not exist`, op));
    }
  }

  return findings;
}
