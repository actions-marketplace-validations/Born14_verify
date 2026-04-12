/**
 * types-migration.ts — Migration verification types.
 *
 * Shaped by what libpg-query actually emits on real Postgres migrations.
 * Will be promoted to src/types.ts once stable.
 */

// ---------------------------------------------------------------------------
// Column & Constraint primitives
// ---------------------------------------------------------------------------

export interface ColumnDef {
  name: string;
  type: string;           // normalized: int8, text, timestamptz, varchar, etc.
  nullable: boolean;      // true unless NOT NULL is present
  hasDefault: boolean;    // true if DEFAULT clause exists
  identity?: boolean;     // GENERATED ALWAYS AS IDENTITY
}

export interface ForeignKey {
  columns: string[];        // local columns
  refTable: string;         // referenced table (schema-qualified if present)
  refColumns: string[];     // referenced columns
  onDelete?: string;        // CASCADE, SET NULL, etc.
  onUpdate?: string;
}

export interface Constraint {
  type: 'primary_key' | 'unique' | 'foreign_key' | 'check' | 'exclusion';
  name?: string;
  columns?: string[];
  fk?: ForeignKey;          // only for foreign_key type
}

// ---------------------------------------------------------------------------
// MigrationOp — one DDL operation parsed from a migration file
// ---------------------------------------------------------------------------

export type MigrationOp =
  | { op: 'create_table'; table: string; columns: ColumnDef[]; constraints: Constraint[]; partitionBy?: string; ifNotExists?: boolean }
  | { op: 'drop_table'; table: string; cascade?: boolean; ifExists?: boolean }
  | { op: 'add_column'; table: string; column: ColumnDef }
  | { op: 'drop_column'; table: string; column: string; cascade?: boolean }
  | { op: 'alter_column_type'; table: string; column: string; newType: string; using?: string }
  | { op: 'alter_column_set_not_null'; table: string; column: string }
  | { op: 'alter_column_drop_not_null'; table: string; column: string }
  | { op: 'alter_column_set_default'; table: string; column: string; expr: string }
  | { op: 'alter_column_drop_default'; table: string; column: string }
  | { op: 'add_constraint'; table: string; constraint: Constraint }
  | { op: 'drop_constraint'; table: string; name: string; cascade?: boolean }
  | { op: 'create_index'; table: string; name?: string; columns: string[]; unique?: boolean }
  | { op: 'drop_index'; name: string; cascade?: boolean }
  | { op: 'create_schema'; name: string }
  | { op: 'create_extension'; name: string }
  | { op: 'create_function'; name: string }
  | { op: 'rename_table'; table: string; newName: string }
  | { op: 'rename_column'; table: string; column: string; newName: string }
  // Catch-all for ops the parser recognizes but we don't have a typed handler for
  | { op: 'unsupported'; stmtType: string; raw?: string };

/** A MigrationOp with source location info for triage and PR comments */
export interface LocatedOp {
  /** Index of this op in the MigrationSpec.operations array */
  opIndex: number;
  /** Index of the originating SQL statement (0-based) */
  stmtIndex: number;
  /** Line number in the source SQL (1-based) */
  line: number;
  /** The operation */
  op: MigrationOp;
}

// ---------------------------------------------------------------------------
// MigrationSpec — the full parsed migration
// ---------------------------------------------------------------------------

export interface MigrationSpec {
  /** Source file path (relative to repo root) */
  file: string;
  /** Ordered list of operations in the migration (with source locations) */
  operations: LocatedOp[];
  /** Raw SQL text, for reporting */
  raw: string;
  /** Parsing metadata */
  meta: {
    totalStatements: number;
    supportedStatements: number;
    unsupportedStatements: number;
    parseErrors: string[];
  };
}

// ---------------------------------------------------------------------------
// Schema — in-memory representation of DB state at a point in time
// ---------------------------------------------------------------------------

export interface TableSchema {
  columns: Map<string, { type: string; nullable: boolean; hasDefault: boolean }>;
  pk?: string[];
  uniqueConstraints: Array<{ name?: string; columns: string[] }>;
  /** Outgoing FK references (this table → other tables) */
  fkOut: Array<{ name?: string; columns: string[]; refTable: string; refColumns: string[]; onDelete?: string }>;
  /** Incoming FK references (other tables → this table) — reverse index */
  fkIn: Array<{ name?: string; fromTable: string; fromColumns: string[]; columns: string[] }>;
  indexes: Array<{ name?: string; columns: string[]; unique: boolean }>;
}

export interface Schema {
  tables: Map<string, TableSchema>;
}

// ---------------------------------------------------------------------------
// Grounding & Safety results
// ---------------------------------------------------------------------------

export interface MigrationFinding {
  /** DM-XX shape ID */
  shapeId: string;
  /** Human-readable message */
  message: string;
  /** Which operation triggered this finding */
  operation: MigrationOp;
  /** Source location in the migration file */
  location?: { stmtIndex: number; opIndex: number; line: number };
  /** Severity: error blocks merge, warning is informational */
  severity: 'error' | 'warning';
  /** Optional: ack comment that would suppress this finding */
  ackPattern?: string;
}

export interface MigrationVerifyResult {
  file: string;
  spec: MigrationSpec;
  findings: MigrationFinding[];
  /** Overall verdict */
  passed: boolean;
}
