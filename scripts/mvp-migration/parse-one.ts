/**
 * parse-one.ts — Day 1 proof: libpg-query parses real migrations.
 *
 * Usage: bun run scripts/mvp-migration/parse-one.ts <path-to-sql-file>
 *        bun run scripts/mvp-migration/parse-one.ts   (runs all corpus files)
 */
import { loadModule, parseSync } from 'libpg-query';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

// Must init WASM before using parseSync
await loadModule();

const CORPUS_DIR = join(import.meta.dir, 'corpus');

function parseMigration(filePath: string) {
  const sql = readFileSync(filePath, 'utf-8');
  const name = basename(filePath);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`FILE: ${name}`);
  console.log(`SIZE: ${sql.length} bytes, ${sql.split('\n').length} lines`);
  console.log('='.repeat(70));

  try {
    const ast = parseSync(sql);
    const stmts = ast.stmts || [];
    console.log(`PARSED: ${stmts.length} statement(s)\n`);

    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i].stmt;
      const stmtType = Object.keys(stmt)[0];
      const detail = stmt[stmtType];

      console.log(`  [${i + 1}] ${stmtType}`);

      // Extract key details based on statement type
      switch (stmtType) {
        case 'CreateStmt': {
          const tableName = formatRangeVar(detail.relation);
          const cols = (detail.tableElts || [])
            .filter((e: any) => e.ColumnDef)
            .map((e: any) => {
              const col = e.ColumnDef;
              return `    - ${col.colname}: ${formatTypeName(col.typeName)}`;
            });
          const constraints = (detail.tableElts || [])
            .filter((e: any) => e.Constraint)
            .map((e: any) => `    - ${e.Constraint.contype} constraint`);
          console.log(`    TABLE: ${tableName}`);
          if (detail.partbound) console.log(`    PARTITIONED: yes`);
          if (detail.partspec) console.log(`    PARTITION BY: ${detail.partspec.strategy}`);
          cols.forEach((c: string) => console.log(c));
          constraints.forEach((c: string) => console.log(c));
          break;
        }
        case 'AlterTableStmt': {
          const tableName = formatRangeVar(detail.relation);
          console.log(`    TABLE: ${tableName}`);
          for (const cmd of detail.cmds || []) {
            const atCmd = cmd.AlterTableCmd;
            if (atCmd) {
              console.log(`    CMD: subtype=${atCmd.subtype}, name=${atCmd.name || '(none)'}`);
              if (atCmd.def?.ColumnDef) {
                const col = atCmd.def.ColumnDef;
                console.log(`    ADD COLUMN: ${col.colname}: ${formatTypeName(col.typeName)}`);
              }
            }
          }
          break;
        }
        case 'IndexStmt': {
          const tableName = formatRangeVar(detail.relation);
          const idxName = detail.idxname || '(unnamed)';
          const cols = (detail.indexParams || [])
            .map((p: any) => p.IndexElem?.name || '?')
            .join(', ');
          console.log(`    INDEX: ${idxName} ON ${tableName} (${cols})`);
          break;
        }
        case 'CreateSchemaStmt': {
          console.log(`    SCHEMA: ${detail.schemaname}`);
          break;
        }
        case 'CreateExtensionStmt': {
          console.log(`    EXTENSION: ${detail.extname}`);
          break;
        }
        case 'CreateFunctionStmt': {
          const name = (detail.funcname || []).map((n: any) => n.String?.sval || n.str || '?').join('.');
          console.log(`    FUNCTION: ${name}`);
          break;
        }
        default:
          // Dump raw keys for unknown statement types
          console.log(`    KEYS: ${Object.keys(detail).join(', ')}`);
      }
    }

    return { file: name, stmts: stmts.length, error: null, stmtTypes: stmts.map((s: any) => Object.keys(s.stmt)[0]) };
  } catch (err: any) {
    console.log(`PARSE ERROR: ${err.message}`);
    return { file: name, stmts: 0, error: err.message, stmtTypes: [] };
  }
}

function formatRangeVar(rel: any): string {
  if (!rel) return '(unknown)';
  const schema = rel.schemaname ? `${rel.schemaname}.` : '';
  return `${schema}${rel.relname}`;
}

function formatTypeName(tn: any): string {
  if (!tn) return '(unknown type)';
  const names = (tn.TypeName?.names || tn.names || [])
    .map((n: any) => n.String?.sval || n.str || '?')
    .filter((n: string) => n !== 'pg_catalog')
    .join('.');
  return names || '(complex type)';
}

// --- Main ---

const args = process.argv.slice(2);

if (args.length > 0) {
  // Parse specific file
  const result = parseMigration(args[0]);
  console.log('\n--- SUMMARY ---');
  console.log(JSON.stringify(result, null, 2));
} else {
  // Parse all corpus files
  const results: any[] = [];

  function walkDir(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walkDir(full);
      } else if (entry.endsWith('.sql')) {
        results.push(parseMigration(full));
      }
    }
  }

  walkDir(CORPUS_DIR);

  console.log('\n\n' + '='.repeat(70));
  console.log('CORPUS SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total files: ${results.length}`);
  console.log(`Parsed OK:   ${results.filter(r => !r.error).length}`);
  console.log(`Errors:      ${results.filter(r => r.error).length}`);
  console.log(`Total stmts: ${results.reduce((sum, r) => sum + r.stmts, 0)}`);

  // Statement type distribution
  const typeCounts: Record<string, number> = {};
  for (const r of results) {
    for (const t of r.stmtTypes) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }
  console.log('\nStatement type distribution:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  if (results.some(r => r.error)) {
    console.log('\nFailed files:');
    for (const r of results.filter(r => r.error)) {
      console.log(`  ${r.file}: ${r.error}`);
    }
  }
}
