/**
 * schema-loader.ts — Build an in-memory Schema from libpg-query AST.
 *
 * Processes CreateStmt + AlterTableStmt to materialize:
 *   - tables, columns, PKs, unique constraints, FKs (outgoing)
 *   - reverse FK index (incoming references)
 *
 * Supports mutations: rename_column, rename_table, drop_column, drop_table.
 *
 * Ignores enums, triggers, policies, functions for the first grounding pass.
 */
import { loadModule, parseSync } from 'libpg-query';
import type { Schema, TableSchema } from '../../src/types-migration';

// ---------------------------------------------------------------------------
// Schema construction
// ---------------------------------------------------------------------------

export function createEmptySchema(): Schema {
  return { tables: new Map() };
}

function ensureTable(schema: Schema, name: string): TableSchema {
  const norm = normalizeName(name);
  let table = schema.tables.get(norm);
  if (!table) {
    table = {
      columns: new Map(),
      pk: undefined,
      uniqueConstraints: [],
      fkOut: [],
      fkIn: [],
      indexes: [],
    };
    schema.tables.set(norm, table);
  }
  return table;
}

/** Normalize table/column names: strip quotes, lowercase, strip public. prefix */
export function normalizeName(name: string): string {
  let n = name.replace(/^"|"$/g, '').toLowerCase();
  // Strip default schema prefix — "public.foo" → "foo"
  if (n.startsWith('public.')) n = n.slice(7);
  return n;
}

function formatRangeVar(rel: any): string {
  if (!rel) return '(unknown)';
  const schema = rel.schemaname ? `${rel.schemaname}.` : '';
  return normalizeName(`${schema}${rel.relname}`);
}

function extractTypeName(tn: any): string {
  if (!tn) return 'unknown';
  const names = (tn.TypeName?.names || tn.names || [])
    .map((n: any) => n.String?.sval || '?')
    .filter((n: string) => n !== 'pg_catalog');
  return names.join('.') || 'unknown';
}

// ---------------------------------------------------------------------------
// Process a single parsed statement and mutate schema
// ---------------------------------------------------------------------------

export function applyStatement(schema: Schema, stmt: any): void {
  const stmtType = Object.keys(stmt)[0];
  const detail = stmt[stmtType];

  switch (stmtType) {
    case 'CreateStmt':
      applyCreateTable(schema, detail);
      break;
    case 'AlterTableStmt':
      applyAlterTable(schema, detail);
      break;
    case 'DropStmt':
      applyDrop(schema, detail);
      break;
    case 'RenameStmt':
      applyRename(schema, detail);
      break;
    case 'IndexStmt':
      applyCreateIndex(schema, detail);
      break;
    // Ignore everything else (enums, triggers, policies, functions, DML)
  }
}

function applyCreateTable(schema: Schema, detail: any): void {
  const tableName = formatRangeVar(detail.relation);
  const table = ensureTable(schema, tableName);

  for (const elt of detail.tableElts || []) {
    if (elt.ColumnDef) {
      const col = elt.ColumnDef;
      const colName = normalizeName(col.colname);
      const colType = extractTypeName(col.typeName);
      const constraints = col.constraints || [];
      const nullable = !constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_NOTNULL');
      const hasDefault = constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_DEFAULT');
      const identity = constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_IDENTITY');

      table.columns.set(colName, { type: colType, nullable: nullable && !identity, hasDefault: hasDefault || identity });

      // Inline PK on a column
      if (constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_PRIMARY')) {
        table.pk = table.pk ? [...table.pk, colName] : [colName];
      }
      // Inline UNIQUE on a column
      if (constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_UNIQUE')) {
        table.uniqueConstraints.push({ columns: [colName] });
      }
      // Inline FK on a column
      for (const c of constraints) {
        if (c.Constraint?.contype === 'CONSTR_FOREIGN') {
          addForeignKey(schema, tableName, table, c.Constraint);
        }
      }
    }

    // Table-level constraints
    if (elt.Constraint) {
      const con = elt.Constraint;
      switch (con.contype) {
        case 'CONSTR_PRIMARY': {
          const cols = (con.keys || []).map((k: any) => normalizeName(k.String?.sval || ''));
          table.pk = cols;
          break;
        }
        case 'CONSTR_UNIQUE': {
          const cols = (con.keys || []).map((k: any) => normalizeName(k.String?.sval || ''));
          table.uniqueConstraints.push({ name: con.conname, columns: cols });
          break;
        }
        case 'CONSTR_FOREIGN': {
          addForeignKey(schema, tableName, table, con);
          break;
        }
      }
    }
  }
}

function addForeignKey(schema: Schema, tableName: string, table: TableSchema, con: any): void {
  const refTable = formatRangeVar(con.pktable);
  const fkCols = (con.fk_attrs || []).map((a: any) => normalizeName(a.String?.sval || ''));
  const pkCols = (con.pk_attrs || []).map((a: any) => normalizeName(a.String?.sval || ''));
  const onDelete = con.fk_del_action ? fkActionName(con.fk_del_action) : undefined;

  // Outgoing FK
  table.fkOut.push({
    name: con.conname,
    columns: fkCols,
    refTable,
    refColumns: pkCols,
    onDelete,
  });

  // Reverse FK index — register on the referenced table
  const refTableSchema = ensureTable(schema, refTable);
  refTableSchema.fkIn.push({
    name: con.conname,
    fromTable: normalizeName(tableName),
    fromColumns: fkCols,
    columns: pkCols,
  });
}

function fkActionName(action: string): string | undefined {
  switch (action) {
    case 'FKCONSTR_ACTION_CASCADE': return 'CASCADE';
    case 'FKCONSTR_ACTION_SETNULL': return 'SET NULL';
    case 'FKCONSTR_ACTION_SETDEFAULT': return 'SET DEFAULT';
    case 'FKCONSTR_ACTION_RESTRICT': return 'RESTRICT';
    case 'FKCONSTR_ACTION_NOACTION': return 'NO ACTION';
    default: return undefined;
  }
}

function applyAlterTable(schema: Schema, detail: any): void {
  const tableName = formatRangeVar(detail.relation);

  for (const cmd of detail.cmds || []) {
    const at = cmd.AlterTableCmd;
    if (!at) continue;

    switch (at.subtype) {
      case 'AT_AddColumn': {
        if (at.def?.ColumnDef) {
          const col = at.def.ColumnDef;
          const colName = normalizeName(col.colname);
          const colType = extractTypeName(col.typeName);
          const constraints = col.constraints || [];
          const nullable = !constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_NOTNULL');
          const hasDefault = constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_DEFAULT');
          const table = ensureTable(schema, tableName);
          table.columns.set(colName, { type: colType, nullable, hasDefault });
        }
        break;
      }
      case 'AT_DropColumn': {
        const colName = normalizeName(at.name);
        const normTable = normalizeName(tableName);
        const table = schema.tables.get(normTable);
        if (table) {
          table.columns.delete(colName);
          // Clean up: remove from PK if present
          if (table.pk) table.pk = table.pk.filter(c => c !== colName);
          // Remove fkOut entries involving this column AND clean up
          // the corresponding fkIn entries on the referenced tables
          const removedFks = table.fkOut.filter(fk => fk.columns.includes(colName));
          table.fkOut = table.fkOut.filter(fk => !fk.columns.includes(colName));
          for (const fk of removedFks) {
            const refTable = schema.tables.get(normalizeName(fk.refTable));
            if (refTable) {
              refTable.fkIn = refTable.fkIn.filter(
                r => !(r.fromTable === normTable && r.fromColumns.some(c => c === colName))
              );
            }
          }
          // Also clean up fkIn on THIS table where the dropped column is
          // the target of an incoming reference
          for (const fkIn of table.fkIn.filter(r => r.columns.includes(colName))) {
            const fromTable = schema.tables.get(normalizeName(fkIn.fromTable));
            if (fromTable) {
              fromTable.fkOut = fromTable.fkOut.filter(
                fk => !(normalizeName(fk.refTable) === normTable && fk.refColumns.includes(colName))
              );
            }
          }
          table.fkIn = table.fkIn.filter(r => !r.columns.includes(colName));
        }
        break;
      }
      case 'AT_AlterColumnType': {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing && at.def?.ColumnDef?.typeName) {
            existing.type = extractTypeName(at.def.ColumnDef.typeName);
          }
        }
        break;
      }
      case 'AT_SetNotNull': {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.nullable = false;
        }
        break;
      }
      case 'AT_DropNotNull': {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.nullable = true;
        }
        break;
      }
      case 'AT_ColumnDefault':
      case 'AT_SetDefault': {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.hasDefault = true;
        }
        break;
      }
      case 'AT_DropDefault': {
        const colName = normalizeName(at.name);
        const table = schema.tables.get(normalizeName(tableName));
        if (table) {
          const existing = table.columns.get(colName);
          if (existing) existing.hasDefault = false;
        }
        break;
      }
      case 'AT_AddConstraint': {
        if (at.def?.Constraint) {
          const con = at.def.Constraint;
          const table = ensureTable(schema, tableName);
          switch (con.contype) {
            case 'CONSTR_PRIMARY': {
              const cols = (con.keys || []).map((k: any) => normalizeName(k.String?.sval || ''));
              table.pk = cols;
              break;
            }
            case 'CONSTR_UNIQUE': {
              const cols = (con.keys || []).map((k: any) => normalizeName(k.String?.sval || ''));
              table.uniqueConstraints.push({ name: con.conname, columns: cols });
              break;
            }
            case 'CONSTR_FOREIGN': {
              addForeignKey(schema, tableName, table, con);
              break;
            }
          }
        }
        break;
      }
      case 'AT_DropConstraint': {
        const conName = at.name;
        const normT = normalizeName(tableName);
        const table = schema.tables.get(normT);
        if (table && conName) {
          // Try name-based match first
          let removedFk = table.fkOut.find(fk => fk.name === conName);
          if (!removedFk) {
            // Fallback: Prisma convention "TableName_columnName_fkey"
            const fkeyMatch = conName.match(/^.+_(.+)_fkey$/i);
            if (fkeyMatch) {
              const colName = normalizeName(fkeyMatch[1]);
              removedFk = table.fkOut.find(fk => !fk.name && fk.columns.length === 1 && fk.columns[0] === colName);
            }
          }
          if (removedFk) {
            table.fkOut = table.fkOut.filter(fk => fk !== removedFk);
            const refTable = schema.tables.get(normalizeName(removedFk.refTable));
            if (refTable) {
              refTable.fkIn = refTable.fkIn.filter(fk =>
                !(fk.fromTable === normT &&
                  fk.fromColumns.length === removedFk!.columns.length &&
                  fk.fromColumns.every((c, i) => c === removedFk!.columns[i]))
              );
            }
          } else {
            table.fkOut = table.fkOut.filter(fk => fk.name !== conName);
          }
          table.uniqueConstraints = table.uniqueConstraints.filter(u => u.name !== conName);
        }
        break;
      }
    }
  }
}

function applyDrop(schema: Schema, detail: any): void {
  if (detail.removeType === 'OBJECT_TABLE') {
    for (const obj of detail.objects || []) {
      const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
      const name = items.map((n: any) => n.String?.sval || '?').join('.');
      const norm = normalizeName(name);

      const table = schema.tables.get(norm);
      if (table) {
        // Clean up reverse FK refs from other tables
        for (const fk of table.fkOut) {
          const refTable = schema.tables.get(normalizeName(fk.refTable));
          if (refTable) {
            refTable.fkIn = refTable.fkIn.filter(r => r.fromTable !== norm);
          }
        }
        // Clean up fkIn on this table from other tables' fkOut
        for (const fk of table.fkIn) {
          const fromTable = schema.tables.get(normalizeName(fk.fromTable));
          if (fromTable) {
            fromTable.fkOut = fromTable.fkOut.filter(f => f.refTable !== norm);
          }
        }
        schema.tables.delete(norm);
      }
    }
  }
  if (detail.removeType === 'OBJECT_INDEX') {
    // Remove index from the table that owns it
    for (const [, table] of schema.tables) {
      for (const obj of detail.objects || []) {
        const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
        const idxName = items.map((n: any) => n.String?.sval || '?').join('.');
        table.indexes = table.indexes.filter(idx => idx.name !== normalizeName(idxName));
      }
    }
  }
}

function applyRename(schema: Schema, detail: any): void {
  // RenameStmt renameType values:
  // OBJECT_TABLE = rename table
  // OBJECT_COLUMN = rename column
  const renameType = detail.renameType;

  if (renameType === 'OBJECT_TABLE') {
    const oldName = formatRangeVar(detail.relation);
    const newName = normalizeName(detail.newname);
    const table = schema.tables.get(normalizeName(oldName));
    if (table) {
      schema.tables.delete(normalizeName(oldName));
      schema.tables.set(newName, table);
      // Update fkIn/fkOut references across all tables
      for (const [, t] of schema.tables) {
        for (const fk of t.fkOut) {
          if (normalizeName(fk.refTable) === normalizeName(oldName)) fk.refTable = newName;
        }
        for (const fk of t.fkIn) {
          if (normalizeName(fk.fromTable) === normalizeName(oldName)) fk.fromTable = newName;
        }
      }
    }
  } else if (renameType === 'OBJECT_COLUMN') {
    const tableName = formatRangeVar(detail.relation);
    const normTable = normalizeName(tableName);
    const oldCol = normalizeName(detail.subname);
    const newCol = normalizeName(detail.newname);
    const table = schema.tables.get(normTable);
    if (table) {
      const colDef = table.columns.get(oldCol);
      if (colDef) {
        table.columns.delete(oldCol);
        table.columns.set(newCol, colDef);
      }
      // Update PK
      if (table.pk) table.pk = table.pk.map(c => c === oldCol ? newCol : c);
      // Update fkOut columns (local side of outgoing FKs)
      for (const fk of table.fkOut) {
        const changed = fk.columns.includes(oldCol);
        fk.columns = fk.columns.map(c => c === oldCol ? newCol : c);
        // Update the corresponding fkIn.fromColumns on the referenced table
        if (changed) {
          const refTable = schema.tables.get(normalizeName(fk.refTable));
          if (refTable) {
            for (const fkIn of refTable.fkIn) {
              if (fkIn.fromTable === normTable) {
                fkIn.fromColumns = fkIn.fromColumns.map(c => c === oldCol ? newCol : c);
              }
            }
          }
        }
      }
      // Update fkIn columns (this table is the referenced side)
      for (const fkIn of table.fkIn) {
        const changed = fkIn.columns.includes(oldCol);
        fkIn.columns = fkIn.columns.map(c => c === oldCol ? newCol : c);
        // Update the corresponding fkOut.refColumns on the referencing table
        if (changed) {
          const fromTable = schema.tables.get(normalizeName(fkIn.fromTable));
          if (fromTable) {
            for (const fk of fromTable.fkOut) {
              if (normalizeName(fk.refTable) === normTable) {
                fk.refColumns = fk.refColumns.map(c => c === oldCol ? newCol : c);
              }
            }
          }
        }
      }
      // Update unique constraints
      for (const u of table.uniqueConstraints) {
        u.columns = u.columns.map(c => c === oldCol ? newCol : c);
      }
      // Update indexes
      for (const idx of table.indexes) {
        idx.columns = idx.columns.map(c => c === oldCol ? newCol : c);
      }
    }
  }
}

function applyCreateIndex(schema: Schema, detail: any): void {
  const tableName = formatRangeVar(detail.relation);
  const table = schema.tables.get(normalizeName(tableName));
  if (table) {
    const idxName = detail.idxname ? normalizeName(detail.idxname) : undefined;
    const cols = (detail.indexParams || [])
      .map((p: any) => normalizeName(p.IndexElem?.name || ''))
      .filter(Boolean);
    table.indexes.push({
      name: idxName,
      columns: cols,
      unique: !!detail.unique,
    });
  }
}

// ---------------------------------------------------------------------------
// High-level API: parse SQL and build schema
// ---------------------------------------------------------------------------

/**
 * Parse one or more SQL strings (e.g. migration files) in order and
 * return the resulting schema state.
 */
export function buildSchemaFromSQL(sqlFiles: string[]): Schema {
  const schema = createEmptySchema();
  for (const sql of sqlFiles) {
    const ast = parseSync(sql);
    for (const s of ast.stmts || []) {
      applyStatement(schema, s.stmt);
    }
  }
  return schema;
}

/**
 * Apply a single migration SQL to an existing schema, mutating it.
 */
export function applyMigrationSQL(schema: Schema, sql: string): void {
  const ast = parseSync(sql);
  for (const s of ast.stmts || []) {
    applyStatement(schema, s.stmt);
  }
}

/**
 * Apply a single typed MigrationOp to the schema. Used by the grounding
 * gate for per-op progressive schema updates.
 */
export function applyOp(schema: Schema, op: import('../../src/types-migration').MigrationOp): void {
  const n = normalizeName;

  switch (op.op) {
    case 'create_table': {
      const table = ensureTable(schema, op.table);
      for (const col of op.columns) {
        table.columns.set(n(col.name), { type: col.type, nullable: col.nullable, hasDefault: col.hasDefault });
      }
      for (const con of op.constraints) {
        if (con.type === 'primary_key' && con.columns) table.pk = con.columns.map(n);
        if (con.type === 'unique' && con.columns) table.uniqueConstraints.push({ name: con.name, columns: con.columns.map(n) });
        if (con.type === 'foreign_key' && con.fk) {
          const fk = con.fk;
          table.fkOut.push({ name: con.name, columns: fk.columns.map(n), refTable: n(fk.refTable), refColumns: fk.refColumns.map(n), onDelete: fk.onDelete });
          const ref = ensureTable(schema, fk.refTable);
          ref.fkIn.push({ name: con.name, fromTable: n(op.table), fromColumns: fk.columns.map(n), columns: fk.refColumns.map(n) });
        }
      }
      break;
    }
    case 'drop_table': {
      const normT = n(op.table);
      const table = schema.tables.get(normT);
      if (table) {
        for (const fk of table.fkOut) {
          const ref = schema.tables.get(n(fk.refTable));
          if (ref) ref.fkIn = ref.fkIn.filter(r => r.fromTable !== normT);
        }
        for (const fk of table.fkIn) {
          const from = schema.tables.get(n(fk.fromTable));
          if (from) from.fkOut = from.fkOut.filter(f => n(f.refTable) !== normT);
        }
        schema.tables.delete(normT);
      }
      break;
    }
    case 'add_column': {
      const table = schema.tables.get(n(op.table));
      if (table) table.columns.set(n(op.column.name), { type: op.column.type, nullable: op.column.nullable, hasDefault: op.column.hasDefault });
      break;
    }
    case 'drop_column': {
      const normT = n(op.table);
      const table = schema.tables.get(normT);
      if (table) {
        const colN = n(op.column);
        table.columns.delete(colN);
        if (table.pk) table.pk = table.pk.filter(c => c !== colN);
        const removedFks = table.fkOut.filter(fk => fk.columns.includes(colN));
        table.fkOut = table.fkOut.filter(fk => !fk.columns.includes(colN));
        for (const fk of removedFks) {
          const ref = schema.tables.get(n(fk.refTable));
          if (ref) ref.fkIn = ref.fkIn.filter(r => !(r.fromTable === normT && r.fromColumns.some(c => c === colN)));
        }
        for (const fkIn of table.fkIn.filter(r => r.columns.includes(colN))) {
          const from = schema.tables.get(n(fkIn.fromTable));
          if (from) from.fkOut = from.fkOut.filter(fk => !(n(fk.refTable) === normT && fk.refColumns.includes(colN)));
        }
        table.fkIn = table.fkIn.filter(r => !r.columns.includes(colN));
      }
      break;
    }
    case 'add_constraint': {
      const table = schema.tables.get(n(op.table));
      if (table && op.constraint.type === 'foreign_key' && op.constraint.fk) {
        const fk = op.constraint.fk;
        table.fkOut.push({ name: op.constraint.name, columns: fk.columns.map(n), refTable: n(fk.refTable), refColumns: fk.refColumns.map(n), onDelete: fk.onDelete });
        const ref = ensureTable(schema, fk.refTable);
        ref.fkIn.push({ name: op.constraint.name, fromTable: n(op.table), fromColumns: fk.columns.map(n), columns: fk.refColumns.map(n) });
      }
      if (table && op.constraint.type === 'primary_key' && op.constraint.columns) {
        table.pk = op.constraint.columns.map(n);
      }
      if (table && op.constraint.type === 'unique' && op.constraint.columns) {
        table.uniqueConstraints.push({ name: op.constraint.name, columns: op.constraint.columns.map(n) });
      }
      break;
    }
    case 'drop_constraint': {
      const normT = n(op.table);
      const table = schema.tables.get(normT);
      if (table) {
        // Try name-based match first, then fall back to convention-based match.
        // Prisma convention: "TableName_columnName_fkey" — the constraint may
        // have been registered without a name from an inline FK definition.
        let removed = table.fkOut.find(fk => fk.name === op.name);
        if (!removed) {
          // Try matching by Prisma naming convention: extract column name from
          // constraint name pattern "TableName_columnName_fkey"
          const fkeyMatch = op.name.match(/^.+_(.+)_fkey$/i);
          if (fkeyMatch) {
            const colName = n(fkeyMatch[1]);
            removed = table.fkOut.find(fk => !fk.name && fk.columns.length === 1 && fk.columns[0] === colName);
          }
        }
        if (removed) {
          table.fkOut = table.fkOut.filter(fk => fk !== removed);
          const ref = schema.tables.get(n(removed.refTable));
          if (ref) {
            // Match fkIn by fromTable + fromColumns since fkIn may also lack a name
            ref.fkIn = ref.fkIn.filter(fk =>
              !(fk.fromTable === normT &&
                fk.fromColumns.length === removed!.columns.length &&
                fk.fromColumns.every((c, i) => c === removed!.columns[i]))
            );
          }
        } else {
          // No FK match — try name-based removal (handles unique constraints etc.)
          table.fkOut = table.fkOut.filter(fk => fk.name !== op.name);
        }
        table.uniqueConstraints = table.uniqueConstraints.filter(u => u.name !== op.name);
      }
      break;
    }
    case 'rename_table': {
      const oldN = n(op.table);
      const newN = n(op.newName);
      const table = schema.tables.get(oldN);
      if (table) {
        schema.tables.delete(oldN);
        schema.tables.set(newN, table);
        for (const [, t] of schema.tables) {
          for (const fk of t.fkOut) { if (n(fk.refTable) === oldN) fk.refTable = newN; }
          for (const fk of t.fkIn) { if (n(fk.fromTable) === oldN) fk.fromTable = newN; }
        }
      }
      break;
    }
    case 'rename_column': {
      const table = schema.tables.get(n(op.table));
      if (table) {
        const oldC = n(op.column), newC = n(op.newName);
        const colDef = table.columns.get(oldC);
        if (colDef) { table.columns.delete(oldC); table.columns.set(newC, colDef); }
        if (table.pk) table.pk = table.pk.map(c => c === oldC ? newC : c);
        for (const fk of table.fkOut) fk.columns = fk.columns.map(c => c === oldC ? newC : c);
        for (const fkIn of table.fkIn) fkIn.columns = fkIn.columns.map(c => c === oldC ? newC : c);
      }
      break;
    }
    case 'alter_column_type': {
      const table = schema.tables.get(n(op.table));
      if (table) { const col = table.columns.get(n(op.column)); if (col) col.type = op.newType; }
      break;
    }
    case 'alter_column_set_not_null': {
      const table = schema.tables.get(n(op.table));
      if (table) { const col = table.columns.get(n(op.column)); if (col) col.nullable = false; }
      break;
    }
    case 'alter_column_drop_not_null': {
      const table = schema.tables.get(n(op.table));
      if (table) { const col = table.columns.get(n(op.column)); if (col) col.nullable = true; }
      break;
    }
    case 'alter_column_set_default': {
      const table = schema.tables.get(n(op.table));
      if (table) { const col = table.columns.get(n(op.column)); if (col) col.hasDefault = true; }
      break;
    }
    case 'alter_column_drop_default': {
      const table = schema.tables.get(n(op.table));
      if (table) { const col = table.columns.get(n(op.column)); if (col) col.hasDefault = false; }
      break;
    }
    case 'create_index': {
      const table = schema.tables.get(n(op.table));
      if (table) table.indexes.push({ name: op.name ? n(op.name) : undefined, columns: op.columns.map(n), unique: !!op.unique });
      break;
    }
    // create_schema, create_extension, create_function, drop_index, unsupported: no schema effect needed for grounding
  }
}

// ---------------------------------------------------------------------------
// Debug: print schema
// ---------------------------------------------------------------------------

export function printSchema(schema: Schema): void {
  for (const [tableName, table] of schema.tables) {
    console.log(`\nTABLE: ${tableName}`);
    if (table.pk) console.log(`  PK: (${table.pk.join(', ')})`);
    for (const [colName, col] of table.columns) {
      const flags = [
        col.nullable ? 'NULL' : 'NOT NULL',
        col.hasDefault ? 'DEFAULT' : '',
      ].filter(Boolean).join(' ');
      console.log(`  ${colName}: ${col.type} [${flags}]`);
    }
    for (const u of table.uniqueConstraints) {
      console.log(`  UNIQUE${u.name ? ` ${u.name}` : ''}: (${u.columns.join(', ')})`);
    }
    for (const fk of table.fkOut) {
      console.log(`  FK OUT${fk.name ? ` ${fk.name}` : ''}: (${fk.columns.join(', ')}) -> ${fk.refTable}(${fk.refColumns.join(', ')})${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ''}`);
    }
    for (const fk of table.fkIn) {
      console.log(`  FK IN${fk.name ? ` ${fk.name}` : ''}: ${fk.fromTable}(${fk.fromColumns.join(', ')}) -> (${fk.columns.join(', ')})`);
    }
    for (const idx of table.indexes) {
      console.log(`  INDEX${idx.name ? ` ${idx.name}` : ''}: (${idx.columns.join(', ')})${idx.unique ? ' UNIQUE' : ''}`);
    }
  }
}
