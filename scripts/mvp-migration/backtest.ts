/**
 * backtest.ts — Track A: run libpg-query across real OSS migration corpora.
 *
 * Phase 1: shallow-clone repos, find migration SQL files, parse each one,
 * record coverage (parsed vs errors, statement type distribution, op coverage).
 *
 * Usage: bun run scripts/mvp-migration/backtest.ts
 */
import { loadModule, parseSync } from 'libpg-query';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Corpus definition — repos with known Postgres migration directories
// ---------------------------------------------------------------------------

interface CorpusRepo {
  name: string;
  url: string;
  /** Directories to sparse-checkout (no globs — git sparse-checkout requires literal paths) */
  migrationDirs: string[];
  /** Notes on why this repo is included / migration format */
  notes: string;
}

const CORPUS: CorpusRepo[] = [
  {
    name: 'supabase',
    url: 'https://github.com/supabase/supabase.git',
    migrationDirs: ['examples'],
    notes: 'Postgres-native. Migrations in examples/*/supabase/migrations/*.sql',
  },
  {
    name: 'cal.com',
    url: 'https://github.com/calcom/cal.com.git',
    migrationDirs: ['packages/prisma/migrations'],
    notes: 'Prisma-generated Postgres migrations. Large migration history.',
  },
  {
    name: 'formbricks',
    url: 'https://github.com/formbricks/formbricks.git',
    migrationDirs: ['packages/database/migration'],
    notes: 'Prisma-generated Postgres migrations.',
  },
  {
    name: 'discourse',
    url: 'https://github.com/discourse/discourse.git',
    migrationDirs: ['db/migrate'],
    notes: 'Rails + Postgres. .rb migration files but some contain raw SQL via execute().',
  },
  {
    name: 'zulip',
    url: 'https://github.com/zulip/zulip.git',
    migrationDirs: ['zerver/migrations', 'zilencer/migrations', 'analytics/migrations', 'corporate/migrations'],
    notes: 'Django + Postgres. Python migration files with RunSQL operations.',
  },
];

const CLONE_DIR = join(import.meta.dir, 'corpus', '_repos');
const REPORT_DIR = join(import.meta.dir, 'reports');

// ---------------------------------------------------------------------------
// Corpus accounting — track every repo's status honestly
// ---------------------------------------------------------------------------

interface RepoStatus {
  name: string;
  status: 'cloned' | 'clone_failed' | 'no_sql_files';
  sqlFilesFound: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function shallowClone(repo: CorpusRepo): string {
  const dest = join(CLONE_DIR, repo.name);
  if (existsSync(dest)) {
    console.log(`  [skip] ${repo.name} already cloned`);
    return dest;
  }
  console.log(`  [clone] ${repo.name}...`);
  execSync(`git clone --depth 1 --filter=blob:none --sparse "${repo.url}" "${dest}"`, {
    stdio: 'pipe',
    timeout: 120000,
  });
  // Sparse checkout — literal directory paths only, no globs
  const dirs = repo.migrationDirs.map(d => `"${d}"`).join(' ');
  execSync(`cd "${dest}" && git sparse-checkout set ${dirs}`, {
    stdio: 'pipe',
    timeout: 30000,
  });
  return dest;
}

function findSqlFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.sql')) {
          files.push(full);
        }
      } catch { /* permission error, broken symlink, etc. */ }
    }
  }
  walk(dir);
  return files.sort();
}

interface ParseResult {
  /** Full path relative to the repo clone root — traceable, not just basename */
  file: string;
  repo: string;
  size: number;
  lines: number;
  stmtCount: number;
  stmtTypes: string[];
  error: string | null;
  /** Safety-relevant patterns */
  hasDropTable: boolean;
  hasDropColumn: boolean;
  hasAlterType: boolean;
  hasAddNotNull: boolean;
  hasForeignKey: boolean;
  hasCreateIndex: boolean;
  hasDropIndex: boolean;
  /** Detail for safety-flagged files */
  safetyDetails: string[];
}

function parseMigrationFile(filePath: string, repoName: string, repoRoot: string): ParseResult {
  const sql = readFileSync(filePath, 'utf-8');
  const relPath = relative(repoRoot, filePath).replace(/\\/g, '/');

  const result: ParseResult = {
    file: relPath,
    repo: repoName,
    size: sql.length,
    lines: sql.split('\n').length,
    stmtCount: 0,
    stmtTypes: [],
    error: null,
    hasDropTable: false,
    hasDropColumn: false,
    hasAlterType: false,
    hasAddNotNull: false,
    hasForeignKey: false,
    hasCreateIndex: false,
    hasDropIndex: false,
    safetyDetails: [],
  };

  try {
    const ast = parseSync(sql);
    const stmts = ast.stmts || [];
    result.stmtCount = stmts.length;

    for (const s of stmts) {
      const stmt = s.stmt;
      const stmtType = Object.keys(stmt)[0];
      result.stmtTypes.push(stmtType);
      const detail = stmt[stmtType];

      switch (stmtType) {
        case 'DropStmt': {
          if (detail.removeType === 'OBJECT_TABLE') {
            result.hasDropTable = true;
            const names = (detail.objects || []).map((o: any) => {
              if (Array.isArray(o)) return o.map((n: any) => n.String?.sval || '?').join('.');
              if (o.List?.items) return o.List.items.map((n: any) => n.String?.sval || '?').join('.');
              return '?';
            });
            result.safetyDetails.push(`DROP TABLE ${names.join(', ')}${detail.behavior === 'DROP_CASCADE' ? ' CASCADE' : ''}`);
          }
          if (detail.removeType === 'OBJECT_INDEX') {
            result.hasDropIndex = true;
            result.safetyDetails.push('DROP INDEX');
          }
          break;
        }
        case 'AlterTableStmt': {
          const tableName = formatRangeVar(detail.relation);
          for (const cmd of detail.cmds || []) {
            const at = cmd.AlterTableCmd;
            if (!at) continue;

            if (at.subtype === 'AT_DropColumn') {
              result.hasDropColumn = true;
              result.safetyDetails.push(`DROP COLUMN ${tableName}.${at.name}`);
            }
            if (at.subtype === 'AT_AlterColumnType') {
              result.hasAlterType = true;
              result.safetyDetails.push(`ALTER TYPE ${tableName}.${at.name}`);
            }
            if (at.subtype === 'AT_SetNotNull') {
              result.hasAddNotNull = true;
              result.safetyDetails.push(`SET NOT NULL ${tableName}.${at.name}`);
            }
            if (at.subtype === 'AT_AddColumn' && at.def?.ColumnDef) {
              const col = at.def.ColumnDef;
              const constraints = col.constraints || [];
              const hasNotNull = constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_NOTNULL');
              const hasDefault = constraints.some((c: any) => c.Constraint?.contype === 'CONSTR_DEFAULT');
              if (hasNotNull && !hasDefault) {
                result.hasAddNotNull = true;
                result.safetyDetails.push(`ADD COLUMN ${tableName}.${col.colname} NOT NULL (no default)`);
              }
            }
            // FIX: detect FK constraints added via ALTER TABLE
            if (at.subtype === 'AT_AddConstraint' && at.def?.Constraint) {
              const con = at.def.Constraint;
              if (con.contype === 'CONSTR_FOREIGN') {
                result.hasForeignKey = true;
                const refTable = formatRangeVar(con.pktable);
                const fkCols = (con.fk_attrs || []).map((a: any) => a.String?.sval || '?').join(', ');
                const pkCols = (con.pk_attrs || []).map((a: any) => a.String?.sval || '?').join(', ');
                result.safetyDetails.push(`ADD FK ${tableName}(${fkCols}) -> ${refTable}(${pkCols})`);
              }
            }
          }
          break;
        }
        case 'CreateStmt': {
          for (const elt of detail.tableElts || []) {
            if (elt.Constraint?.contype === 'CONSTR_FOREIGN') {
              result.hasForeignKey = true;
              const con = elt.Constraint;
              const refTable = formatRangeVar(con.pktable);
              const tableName = formatRangeVar(detail.relation);
              const fkCols = (con.fk_attrs || []).map((a: any) => a.String?.sval || '?').join(', ');
              const pkCols = (con.pk_attrs || []).map((a: any) => a.String?.sval || '?').join(', ');
              result.safetyDetails.push(`CREATE TABLE FK ${tableName}(${fkCols}) -> ${refTable}(${pkCols})`);
            }
          }
          break;
        }
        case 'IndexStmt':
          result.hasCreateIndex = true;
          break;
      }
    }
  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

function formatRangeVar(rel: any): string {
  if (!rel) return '(unknown)';
  const schema = rel.schemaname ? `${rel.schemaname}.` : '';
  return `${schema}${rel.relname}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadModule();

  ensureDir(CLONE_DIR);
  ensureDir(REPORT_DIR);

  console.log('=== MIGRATION BACKTEST ===\n');

  const allResults: ParseResult[] = [];
  const repoStatuses: RepoStatus[] = [];

  for (const repo of CORPUS) {
    console.log(`\n--- ${repo.name} ---`);
    console.log(`  Notes: ${repo.notes}`);

    let repoDir: string;
    try {
      repoDir = shallowClone(repo);
    } catch (err: any) {
      const msg = err.message?.slice(0, 120) || 'unknown error';
      console.log(`  [error] Failed to clone: ${msg}`);
      repoStatuses.push({ name: repo.name, status: 'clone_failed', sqlFilesFound: 0, error: msg });
      continue;
    }

    const sqlFiles = findSqlFiles(repoDir);
    console.log(`  Found ${sqlFiles.length} .sql files`);

    if (sqlFiles.length === 0) {
      repoStatuses.push({ name: repo.name, status: 'no_sql_files', sqlFilesFound: 0 });
      continue;
    }

    repoStatuses.push({ name: repo.name, status: 'cloned', sqlFilesFound: sqlFiles.length });

    for (const f of sqlFiles) {
      const result = parseMigrationFile(f, repo.name, repoDir);
      allResults.push(result);
      if (result.error) {
        console.log(`  [FAIL] ${result.file}: ${result.error.slice(0, 80)}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  console.log('\n\n' + '='.repeat(70));
  console.log('BACKTEST REPORT');
  console.log('='.repeat(70));

  // Honest corpus accounting
  console.log('\nCorpus accounting:');
  for (const rs of repoStatuses) {
    const icon = rs.status === 'cloned' ? '✓' : rs.status === 'no_sql_files' ? '○' : '✗';
    console.log(`  ${icon} ${rs.name}: ${rs.status}${rs.sqlFilesFound ? ` (${rs.sqlFilesFound} .sql files)` : ''}${rs.error ? ` — ${rs.error}` : ''}`);
  }
  const activeRepos = repoStatuses.filter(r => r.status === 'cloned');
  const skippedRepos = repoStatuses.filter(r => r.status !== 'cloned');
  console.log(`  Active: ${activeRepos.length}/${repoStatuses.length} repos. Skipped: ${skippedRepos.length} (${skippedRepos.map(r => r.name).join(', ') || 'none'})`);

  const parsed = allResults.filter(r => !r.error);
  const failed = allResults.filter(r => r.error);
  const totalFiles = allResults.length;

  console.log(`\nParse results (across ${activeRepos.length} active repos):`);
  console.log(`  Total .sql files:    ${totalFiles}`);
  console.log(`  Parsed successfully: ${parsed.length}${totalFiles ? ` (${(parsed.length / totalFiles * 100).toFixed(1)}%)` : ''}`);
  console.log(`  Parse errors:        ${failed.length}`);
  console.log(`  Total statements:    ${parsed.reduce((s, r) => s + r.stmtCount, 0)}`);

  // Per-repo breakdown
  console.log('\nPer-repo breakdown:');
  for (const rs of activeRepos) {
    const repoResults = allResults.filter(r => r.repo === rs.name);
    const repoOk = repoResults.filter(r => !r.error);
    console.log(`  ${rs.name}: ${repoOk.length}/${repoResults.length} parsed, ${repoResults.reduce((s, r) => s + r.stmtCount, 0)} stmts`);
  }

  // Statement type distribution
  const typeCounts: Record<string, number> = {};
  for (const r of parsed) {
    for (const t of r.stmtTypes) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }
  console.log('\nStatement type distribution:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Safety-relevant pattern counts
  const safetyFlagged = parsed.filter(r =>
    r.hasDropTable || r.hasDropColumn || r.hasAlterType || r.hasAddNotNull || r.hasDropIndex
  );

  console.log('\nSafety-relevant patterns detected:');
  console.log(`  DROP TABLE:                ${parsed.filter(r => r.hasDropTable).length} files`);
  console.log(`  DROP COLUMN:               ${parsed.filter(r => r.hasDropColumn).length} files`);
  console.log(`  ALTER COLUMN TYPE:         ${parsed.filter(r => r.hasAlterType).length} files`);
  console.log(`  ADD NOT NULL (no default): ${parsed.filter(r => r.hasAddNotNull).length} files`);
  console.log(`  DROP INDEX:                ${parsed.filter(r => r.hasDropIndex).length} files`);
  console.log(`  FOREIGN KEY (create+alter):${parsed.filter(r => r.hasForeignKey).length} files`);
  console.log(`  CREATE INDEX:              ${parsed.filter(r => r.hasCreateIndex).length} files`);
  console.log(`  ---`);
  console.log(`  Files with ≥1 safety flag: ${safetyFlagged.length} (${totalFiles ? (safetyFlagged.length / totalFiles * 100).toFixed(1) : 0}%)`);
  console.log(`  NOTE: "pattern present" ≠ "actually dangerous". Schema context required.`);

  // Print safety-flagged file details
  if (safetyFlagged.length > 0) {
    console.log('\nSafety-flagged files (first 30):');
    for (const r of safetyFlagged.slice(0, 30)) {
      console.log(`  ${r.repo}/${r.file}`);
      for (const d of r.safetyDetails) {
        console.log(`    → ${d}`);
      }
    }
    if (safetyFlagged.length > 30) {
      console.log(`  ... and ${safetyFlagged.length - 30} more`);
    }
  }

  // MigrationSpec op coverage
  const specOps = new Set([
    'CreateStmt', 'DropStmt', 'AlterTableStmt', 'IndexStmt',
    'CreateSchemaStmt', 'CreateExtensionStmt', 'CreateFunctionStmt',
    'RenameStmt',
  ]);
  const coveredOps = new Set(Object.keys(typeCounts).filter(t => specOps.has(t)));
  console.log(`\nMigrationSpec op coverage: ${coveredOps.size}/${specOps.size} (${(coveredOps.size / specOps.size * 100).toFixed(0)}%)`);
  console.log(`  Covered: ${[...coveredOps].join(', ')}`);
  console.log(`  Missing: ${[...specOps].filter(o => !coveredOps.has(o)).join(', ') || '(none)'}`);

  // Unsupported statement types
  const unsupported = Object.keys(typeCounts).filter(t => !specOps.has(t));
  if (unsupported.length > 0) {
    console.log(`\nStatement types NOT in MigrationSpec (potential gaps):`);
    for (const t of unsupported.sort((a, b) => typeCounts[b] - typeCounts[a])) {
      console.log(`  ${t}: ${typeCounts[t]}`);
    }
  }

  // Write JSON report
  const report = {
    timestamp: new Date().toISOString(),
    corpusDefinition: CORPUS.map(r => ({ name: r.name, notes: r.notes })),
    corpusAccounting: repoStatuses,
    summary: {
      activeRepos: activeRepos.length,
      totalRepos: repoStatuses.length,
      skippedRepos: skippedRepos.map(r => ({ name: r.name, reason: r.status, error: r.error })),
      totalFiles: totalFiles,
      parsedOk: parsed.length,
      parseErrors: failed.length,
      totalStatements: parsed.reduce((s, r) => s + r.stmtCount, 0),
      parseRate: totalFiles ? (parsed.length / totalFiles * 100).toFixed(1) + '%' : 'N/A',
      safetyFlaggedFiles: safetyFlagged.length,
      safetyFlaggedRate: totalFiles ? (safetyFlagged.length / totalFiles * 100).toFixed(1) + '%' : 'N/A',
      caveat: 'Pattern-present is not actually-dangerous. Schema context required for safety conclusions.',
    },
    stmtTypeDistribution: typeCounts,
    safetyPatterns: {
      dropTable: parsed.filter(r => r.hasDropTable).length,
      dropColumn: parsed.filter(r => r.hasDropColumn).length,
      alterColumnType: parsed.filter(r => r.hasAlterType).length,
      addNotNullNoDefault: parsed.filter(r => r.hasAddNotNull).length,
      foreignKey: parsed.filter(r => r.hasForeignKey).length,
      dropIndex: parsed.filter(r => r.hasDropIndex).length,
      createIndex: parsed.filter(r => r.hasCreateIndex).length,
    },
    perRepo: activeRepos.map(rs => {
      const rr = allResults.filter(r => r.repo === rs.name);
      return {
        name: rs.name,
        files: rr.length,
        parsed: rr.filter(r => !r.error).length,
        stmts: rr.reduce((s, r) => s + r.stmtCount, 0),
        errors: rr.filter(r => r.error).map(r => ({ file: r.file, error: r.error })),
      };
    }),
    results: allResults,
  };

  const reportPath = join(REPORT_DIR, `backtest-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
