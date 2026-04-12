/**
 * safety-gate.ts — Operational safety rules for migrations.
 *
 * Runs AFTER grounding (assumes targets exist). Checks whether
 * structurally valid operations are operationally dangerous.
 *
 * Shape IDs:
 *   DM-15  DROP COLUMN with incoming FK references (live dependents)
 *   DM-16  DROP TABLE with incoming FK references
 *   DM-17  ALTER COLUMN TYPE with narrowing conversion or live dependents
 *   DM-18  ADD/SET NOT NULL without safe preconditions (no default, column not new)
 *   DM-19  DROP INDEX that backs a UNIQUE or PK constraint
 *
 * Every finding can be suppressed by an ack comment in the migration:
 *   -- verify: ack DM-XX <reason>
 */
import type { Schema, MigrationSpec, MigrationOp, LocatedOp, MigrationFinding } from '../../src/types-migration';
import { normalizeName, applyOp } from './schema-loader';

// ---------------------------------------------------------------------------
// Narrowing type conversions — types that lose data when changed to
// ---------------------------------------------------------------------------

const NARROWING_PAIRS: Array<[string, string]> = [
  ['text', 'varchar'],
  ['varchar', 'char'],
  ['int8', 'int4'],
  ['int8', 'int2'],
  ['int4', 'int2'],
  ['float8', 'float4'],
  ['numeric', 'int4'],
  ['numeric', 'int8'],
  ['numeric', 'float4'],
  ['timestamptz', 'timestamp'],
  ['timestamptz', 'date'],
  ['timestamp', 'date'],
  ['text', 'int4'],
  ['text', 'int8'],
  ['text', 'bool'],
  ['jsonb', 'json'],
  ['json', 'text'],  // loses structure
];

function isNarrowing(fromType: string, toType: string): boolean {
  const from = fromType.toLowerCase();
  const to = toType.toLowerCase();
  return NARROWING_PAIRS.some(([f, t]) => from === f && to === t);
}

// ---------------------------------------------------------------------------
// Ack parser
// ---------------------------------------------------------------------------

function parseAcks(sql: string): Set<string> {
  const acks = new Set<string>();
  const pattern = /--\s*verify:\s*ack\s+(DM-\d+)/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    acks.add(match[1].toUpperCase());
  }
  return acks;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run safety checks with per-op progressive schema updates.
 *
 * Same progressive approach as grounding: each op is checked against the
 * schema state at that point (after all prior ops' effects have been applied).
 * This ensures that a DROP CONSTRAINT followed by DROP COLUMN in the same
 * migration correctly sees the constraint as already removed.
 *
 * Clones the schema — caller's schema is not modified.
 */
export function runSafetyGate(spec: MigrationSpec, schema: Schema): MigrationFinding[] {
  const acks = parseAcks(spec.raw);
  const allFindings: MigrationFinding[] = [];
  const workingSchema = cloneSchema(schema);

  for (const located of spec.operations) {
    const loc = { stmtIndex: located.stmtIndex, opIndex: located.opIndex, line: located.line };
    const findings = checkSafety(located.op, workingSchema);
    for (const f of findings) {
      f.location = loc;
      if (acks.has(f.shapeId)) {
        f.severity = 'warning';
        f.message += ' [ACKED]';
      }
      allFindings.push(f);
    }

    // Apply this op's schema effect for subsequent ops
    try { applyOp(workingSchema, located.op); } catch {}
  }

  return allFindings;
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

function finding(shapeId: string, message: string, op: MigrationOp, severity: 'error' | 'warning' = 'error'): MigrationFinding {
  return {
    shapeId,
    message,
    operation: op,
    severity,
    ackPattern: `-- verify: ack ${shapeId} <reason>`,
  };
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

function checkSafety(op: MigrationOp, schema: Schema): MigrationFinding[] {
  switch (op.op) {
    case 'drop_column': return checkDropColumnSafety(op, schema);
    case 'drop_table': return checkDropTableSafety(op, schema);
    case 'alter_column_type': return checkAlterTypeSafety(op, schema);
    case 'alter_column_set_not_null': return checkSetNotNullSafety(op, schema);
    case 'add_column': return checkAddColumnNotNull(op, schema);
    case 'drop_index': return checkDropIndexSafety(op, schema);
    default: return [];
  }
}

// DM-15: DROP COLUMN with live FK dependents
function checkDropColumnSafety(op: Extract<MigrationOp, { op: 'drop_column' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;

  const colNorm = normalizeName(op.column);

  // Check if this column is referenced by incoming FKs
  const dependents = table.fkIn.filter(fk => fk.columns.includes(colNorm));
  if (dependents.length > 0) {
    const refs = dependents.map(fk => `${fk.fromTable}(${fk.fromColumns.join(', ')})`).join(', ');
    findings.push(finding('DM-15',
      `DROP COLUMN ${op.table}.${op.column} has ${dependents.length} incoming FK reference(s): [${refs}]. ` +
      `DROP will cascade or fail at runtime.`,
      op));
  }

  // Also check if this column is part of an outgoing FK (this table references another)
  // — not a safety issue per se, but if CASCADE isn't specified the DROP will fail
  const outgoing = table.fkOut.filter(fk => fk.columns.includes(colNorm));
  if (outgoing.length > 0 && !op.cascade) {
    const refs = outgoing.map(fk => `-> ${fk.refTable}(${fk.refColumns.join(', ')})`).join(', ');
    findings.push(finding('DM-15',
      `DROP COLUMN ${op.table}.${op.column} is part of outgoing FK [${refs}] but CASCADE not specified. ` +
      `The constraint must be dropped first or CASCADE used.`,
      op, 'warning'));
  }

  return findings;
}

// DM-16: DROP TABLE with live FK dependents
function checkDropTableSafety(op: Extract<MigrationOp, { op: 'drop_table' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;

  if (table.fkIn.length > 0 && !op.cascade) {
    const refs = table.fkIn.map(fk => `${fk.fromTable}(${fk.fromColumns.join(', ')})`).join(', ');
    findings.push(finding('DM-16',
      `DROP TABLE ${op.table} has ${table.fkIn.length} incoming FK reference(s): [${refs}]. ` +
      `DROP will fail without CASCADE or prior constraint removal.`,
      op));
  }

  return findings;
}

// DM-17: ALTER COLUMN TYPE with narrowing or dependents
function checkAlterTypeSafety(op: Extract<MigrationOp, { op: 'alter_column_type' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;

  const col = table.columns.get(normalizeName(op.column));
  if (!col) return findings;

  // Check narrowing
  if (isNarrowing(col.type, op.newType)) {
    findings.push(finding('DM-17',
      `ALTER COLUMN ${op.table}.${op.column} TYPE ${col.type} → ${op.newType}: ` +
      `narrowing conversion may cause silent data loss.`,
      op));
  }

  // Check if column has FK dependents
  const colNorm = normalizeName(op.column);
  const dependents = table.fkIn.filter(fk => fk.columns.includes(colNorm));
  if (dependents.length > 0) {
    const refs = dependents.map(fk => `${fk.fromTable}(${fk.fromColumns.join(', ')})`).join(', ');
    findings.push(finding('DM-17',
      `ALTER COLUMN TYPE on ${op.table}.${op.column}: column has ${dependents.length} ` +
      `incoming FK reference(s) [${refs}]. Type change may break referencing columns.`,
      op, 'warning'));
  }

  return findings;
}

// DM-18: SET NOT NULL without safe preconditions
function checkSetNotNullSafety(op: Extract<MigrationOp, { op: 'alter_column_set_not_null' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const table = schema.tables.get(normalizeName(op.table));
  if (!table) return findings;

  const col = table.columns.get(normalizeName(op.column));
  if (!col) return findings;

  // If the column is nullable and has no default, SET NOT NULL on a non-empty table will fail
  // if any existing rows have NULL. We can't know if the table is empty, but we can flag it.
  if (col.nullable && !col.hasDefault) {
    findings.push(finding('DM-18',
      `SET NOT NULL on ${op.table}.${op.column}: column is currently nullable with no default. ` +
      `Will fail if any existing rows contain NULL.`,
      op, 'warning'));
  }

  return findings;
}

// DM-18 variant: ADD COLUMN NOT NULL without default
function checkAddColumnNotNull(op: Extract<MigrationOp, { op: 'add_column' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];

  if (!op.column.nullable && !op.column.hasDefault && !op.column.identity) {
    findings.push(finding('DM-18',
      `ADD COLUMN ${op.table}.${op.column.name} NOT NULL without DEFAULT. ` +
      `Will fail on any non-empty table.`,
      op));
  }

  return findings;
}

// DM-19: DROP INDEX that backs a constraint
function checkDropIndexSafety(op: Extract<MigrationOp, { op: 'drop_index' }>, schema: Schema): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const idxNorm = normalizeName(op.name);

  // Check if any table has a UNIQUE constraint or PK backed by this index name
  // Postgres auto-creates indexes for PK and UNIQUE — if the index name matches
  // a constraint's implicit index, dropping it would break the constraint.
  for (const [tableName, table] of schema.tables) {
    // PK index: conventionally <table>_pkey
    if (table.pk && idxNorm === `${tableName}_pkey`) {
      findings.push(finding('DM-19',
        `DROP INDEX ${op.name}: backs PRIMARY KEY on ${tableName}(${table.pk.join(', ')})`,
        op));
    }

    // UNIQUE constraint indexes
    for (const u of table.uniqueConstraints) {
      if (u.name && normalizeName(u.name) === idxNorm) {
        findings.push(finding('DM-19',
          `DROP INDEX ${op.name}: backs UNIQUE constraint on ${tableName}(${u.columns.join(', ')})`,
          op));
      }
    }
  }

  return findings;
}
