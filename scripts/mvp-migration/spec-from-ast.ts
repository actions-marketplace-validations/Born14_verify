/**
 * spec-from-ast.ts — Translate libpg-query AST into stable MigrationOp[].
 *
 * Gates consume MigrationSpec, not raw AST. This is the boundary.
 * Every supported statement becomes a typed MigrationOp.
 * Unsupported statements become { op: 'unsupported' } with the raw stmtType.
 */
import { loadModule, parseSync } from 'libpg-query';
import type { MigrationSpec, MigrationOp, LocatedOp, ColumnDef, Constraint, ForeignKey } from '../../src/types-migration';
import { normalizeName } from './schema-loader';

// ---------------------------------------------------------------------------
// AST → MigrationOp translators
// ---------------------------------------------------------------------------

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

function extractColumnDef(colAst: any): ColumnDef {
  const constraints = colAst.constraints || [];
  return {
    name: normalizeName(colAst.colname),
    type: extractTypeName(colAst.typeName),
    nullable: !constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_NOTNULL'),
    hasDefault: constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_DEFAULT'),
    identity: constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_IDENTITY'),
  };
}

function extractForeignKey(con: any): ForeignKey {
  return {
    columns: (con.fk_attrs || []).map((a: any) => normalizeName(a.String?.sval || '')),
    refTable: formatRangeVar(con.pktable),
    refColumns: (con.pk_attrs || []).map((a: any) => normalizeName(a.String?.sval || '')),
    onDelete: con.fk_del_action ? fkActionName(con.fk_del_action) : undefined,
    onUpdate: con.fk_upd_action ? fkActionName(con.fk_upd_action) : undefined,
  };
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

function extractConstraint(con: any): Constraint | null {
  switch (con.contype) {
    case 'CONSTR_PRIMARY': {
      const cols = (con.keys || []).map((k: any) => normalizeName(k.String?.sval || ''));
      return { type: 'primary_key', name: con.conname, columns: cols };
    }
    case 'CONSTR_UNIQUE': {
      const cols = (con.keys || []).map((k: any) => normalizeName(k.String?.sval || ''));
      return { type: 'unique', name: con.conname, columns: cols };
    }
    case 'CONSTR_FOREIGN': {
      return { type: 'foreign_key', name: con.conname, fk: extractForeignKey(con) };
    }
    case 'CONSTR_CHECK': {
      return { type: 'check', name: con.conname };
    }
    case 'CONSTR_EXCLUSION': {
      return { type: 'exclusion', name: con.conname };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Statement translators
// ---------------------------------------------------------------------------

function translateCreateStmt(detail: any): MigrationOp {
  const tableName = formatRangeVar(detail.relation);
  const columns: ColumnDef[] = [];
  const constraints: Constraint[] = [];

  for (const elt of detail.tableElts || []) {
    if (elt.ColumnDef) {
      columns.push(extractColumnDef(elt.ColumnDef));
      // Inline constraints on columns (FK, PK, UNIQUE)
      for (const c of elt.ColumnDef.constraints || []) {
        if (c.Constraint) {
          const con = extractConstraint(c.Constraint);
          if (con) constraints.push(con);
        }
      }
    }
    if (elt.Constraint) {
      const con = extractConstraint(elt.Constraint);
      if (con) constraints.push(con);
    }
  }

  let partitionBy: string | undefined;
  if (detail.partspec) {
    partitionBy = detail.partspec.strategy || 'unknown';
  }

  return {
    op: 'create_table',
    table: tableName,
    columns,
    constraints,
    partitionBy,
    ifNotExists: !!detail.if_not_exists,
  };
}

function translateAlterTableStmt(detail: any): MigrationOp[] {
  const tableName = formatRangeVar(detail.relation);
  const ops: MigrationOp[] = [];

  for (const cmd of detail.cmds || []) {
    const at = cmd.AlterTableCmd;
    if (!at) continue;

    switch (at.subtype) {
      case 'AT_AddColumn': {
        if (at.def?.ColumnDef) {
          ops.push({
            op: 'add_column',
            table: tableName,
            column: extractColumnDef(at.def.ColumnDef),
          });
        }
        break;
      }
      case 'AT_DropColumn': {
        ops.push({
          op: 'drop_column',
          table: tableName,
          column: normalizeName(at.name),
          cascade: at.behavior === 'DROP_CASCADE',
        });
        break;
      }
      case 'AT_AlterColumnType': {
        const newType = at.def?.ColumnDef?.typeName
          ? extractTypeName(at.def.ColumnDef.typeName)
          : 'unknown';
        ops.push({
          op: 'alter_column_type',
          table: tableName,
          column: normalizeName(at.name),
          newType,
        });
        break;
      }
      case 'AT_SetNotNull': {
        ops.push({
          op: 'alter_column_set_not_null',
          table: tableName,
          column: normalizeName(at.name),
        });
        break;
      }
      case 'AT_DropNotNull': {
        ops.push({
          op: 'alter_column_drop_not_null',
          table: tableName,
          column: normalizeName(at.name),
        });
        break;
      }
      case 'AT_ColumnDefault':
      case 'AT_SetDefault': {
        ops.push({
          op: 'alter_column_set_default',
          table: tableName,
          column: normalizeName(at.name),
          expr: '(expression)', // TODO: deparse the default expression
        });
        break;
      }
      case 'AT_DropDefault': {
        ops.push({
          op: 'alter_column_drop_default',
          table: tableName,
          column: normalizeName(at.name),
        });
        break;
      }
      case 'AT_AddConstraint': {
        if (at.def?.Constraint) {
          const con = extractConstraint(at.def.Constraint);
          if (con) {
            ops.push({ op: 'add_constraint', table: tableName, constraint: con });
          }
        }
        break;
      }
      case 'AT_DropConstraint': {
        ops.push({
          op: 'drop_constraint',
          table: tableName,
          name: at.name || '(unnamed)',
          cascade: at.behavior === 'DROP_CASCADE',
        });
        break;
      }
      default: {
        ops.push({ op: 'unsupported', stmtType: `AlterTableCmd:${at.subtype}` });
      }
    }
  }

  return ops;
}

function translateDropStmt(detail: any): MigrationOp[] {
  const ops: MigrationOp[] = [];
  const cascade = detail.behavior === 'DROP_CASCADE';
  const ifExists = !!detail.missing_ok;

  if (detail.removeType === 'OBJECT_TABLE') {
    for (const obj of detail.objects || []) {
      const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
      const name = normalizeName(items.map((n: any) => n.String?.sval || '?').join('.'));
      ops.push({ op: 'drop_table', table: name, cascade, ifExists });
    }
  } else if (detail.removeType === 'OBJECT_INDEX') {
    for (const obj of detail.objects || []) {
      const items = obj.List?.items || (Array.isArray(obj) ? obj : []);
      const name = normalizeName(items.map((n: any) => n.String?.sval || '?').join('.'));
      ops.push({ op: 'drop_index', name, cascade });
    }
  } else {
    ops.push({ op: 'unsupported', stmtType: `DropStmt:${detail.removeType}` });
  }

  return ops;
}

function translateRenameStmt(detail: any): MigrationOp {
  if (detail.renameType === 'OBJECT_TABLE') {
    return {
      op: 'rename_table',
      table: formatRangeVar(detail.relation),
      newName: normalizeName(detail.newname),
    };
  } else if (detail.renameType === 'OBJECT_COLUMN') {
    return {
      op: 'rename_column',
      table: formatRangeVar(detail.relation),
      column: normalizeName(detail.subname),
      newName: normalizeName(detail.newname),
    };
  }
  return { op: 'unsupported', stmtType: `RenameStmt:${detail.renameType}` };
}

function translateIndexStmt(detail: any): MigrationOp {
  return {
    op: 'create_index',
    table: formatRangeVar(detail.relation),
    name: detail.idxname ? normalizeName(detail.idxname) : undefined,
    columns: (detail.indexParams || [])
      .map((p: any) => normalizeName(p.IndexElem?.name || ''))
      .filter(Boolean),
    unique: !!detail.unique,
  };
}

function translateSimple(stmtType: string, detail: any): MigrationOp {
  switch (stmtType) {
    case 'CreateSchemaStmt':
      return { op: 'create_schema', name: normalizeName(detail.schemaname || '') };
    case 'CreateExtensionStmt':
      return { op: 'create_extension', name: detail.extname || '' };
    case 'CreateFunctionStmt': {
      const fname = (detail.funcname || []).map((n: any) => n.String?.sval || '?').join('.');
      return { op: 'create_function', name: fname };
    }
    default:
      return { op: 'unsupported', stmtType };
  }
}

// ---------------------------------------------------------------------------
// Main entry point: SQL → MigrationSpec
// ---------------------------------------------------------------------------

/** Convert byte offset in SQL to 1-based line number */
function byteOffsetToLine(sql: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql[i] === '\n') line++;
  }
  return line;
}

export function parseMigration(sql: string, file: string): MigrationSpec {
  const operations: LocatedOp[] = [];
  const parseErrors: string[] = [];
  let totalStatements = 0;
  let supportedStatements = 0;
  let opIndex = 0;

  let ast: any;
  try {
    ast = parseSync(sql);
  } catch (err: any) {
    parseErrors.push(err.message);
    return {
      file,
      operations: [],
      raw: sql,
      meta: { totalStatements: 0, supportedStatements: 0, unsupportedStatements: 0, parseErrors },
    };
  }

  function addOps(stmtIndex: number, line: number, ops: MigrationOp[]) {
    for (const op of ops) {
      operations.push({ opIndex: opIndex++, stmtIndex, line, op });
    }
  }

  for (let si = 0; si < (ast.stmts || []).length; si++) {
    const s = ast.stmts[si];
    totalStatements++;
    const stmt = s.stmt;
    const stmtType = Object.keys(stmt)[0];
    const detail = stmt[stmtType];
    const line = byteOffsetToLine(sql, s.stmt_location || 0);

    switch (stmtType) {
      case 'CreateStmt': {
        addOps(si, line, [translateCreateStmt(detail)]);
        supportedStatements++;
        break;
      }
      case 'AlterTableStmt': {
        addOps(si, line, translateAlterTableStmt(detail));
        supportedStatements++;
        break;
      }
      case 'DropStmt': {
        addOps(si, line, translateDropStmt(detail));
        supportedStatements++;
        break;
      }
      case 'RenameStmt': {
        addOps(si, line, [translateRenameStmt(detail)]);
        supportedStatements++;
        break;
      }
      case 'IndexStmt': {
        addOps(si, line, [translateIndexStmt(detail)]);
        supportedStatements++;
        break;
      }
      case 'CreateSchemaStmt':
      case 'CreateExtensionStmt':
      case 'CreateFunctionStmt': {
        addOps(si, line, [translateSimple(stmtType, detail)]);
        supportedStatements++;
        break;
      }
      default: {
        addOps(si, line, [{ op: 'unsupported', stmtType }]);
      }
    }
  }

  return {
    file,
    operations,
    raw: sql,
    meta: {
      totalStatements,
      supportedStatements,
      unsupportedStatements: totalStatements - supportedStatements,
      parseErrors,
    },
  };
}
