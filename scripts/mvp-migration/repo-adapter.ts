/**
 * repo-adapter.ts — Per-repo adapter for migration ordering + schema bootstrap.
 *
 * Each repo has a different migration layout. The adapter normalizes them
 * into a common shape: an ordered list of MigrationSequences, where each
 * sequence is an independent chain of migrations that share a schema.
 *
 * For Prisma repos (cal.com, formbricks): one sequence, sorted by timestamp folder.
 * For Supabase repos: one sequence per example project.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, relative, basename } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationFile {
  /** Path relative to repo root */
  relPath: string;
  /** Absolute path */
  absPath: string;
  /** Sort key (usually timestamp from filename or folder name) */
  sortKey: string;
  /** SQL content */
  sql: string;
}

export interface MigrationSequence {
  /** Human-readable name for this sequence (e.g., repo name or sub-project) */
  name: string;
  /** Ordered migration files — index 0 is the earliest */
  migrations: MigrationFile[];
}

export interface RepoAdapter {
  name: string;
  /** Detect migration sequences in the cloned repo */
  getSequences(repoRoot: string): MigrationSequence[];
}

// ---------------------------------------------------------------------------
// Prisma adapter: TIMESTAMP_name/migration.sql folders in a single directory
// ---------------------------------------------------------------------------

function prismaAdapter(repoName: string, migrationDir: string): RepoAdapter {
  return {
    name: repoName,
    getSequences(repoRoot: string): MigrationSequence[] {
      const dir = join(repoRoot, migrationDir);
      if (!existsSync(dir)) return [];

      const folders = readdirSync(dir)
        .filter(f => {
          const full = join(dir, f);
          return statSync(full).isDirectory() && existsSync(join(full, 'migration.sql'));
        })
        .sort(); // Timestamp prefix gives natural sort order

      const migrations: MigrationFile[] = folders.map(folder => {
        const absPath = join(dir, folder, 'migration.sql');
        return {
          relPath: relative(repoRoot, absPath).replace(/\\/g, '/'),
          absPath,
          sortKey: folder,
          sql: readFileSync(absPath, 'utf-8'),
        };
      });

      return [{ name: repoName, migrations }];
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase adapter: multiple example projects, each with supabase/migrations/*.sql
// ---------------------------------------------------------------------------

function supabaseAdapter(): RepoAdapter {
  return {
    name: 'supabase',
    getSequences(repoRoot: string): MigrationSequence[] {
      const sequences: MigrationSequence[] = [];
      const examplesDir = join(repoRoot, 'examples');
      if (!existsSync(examplesDir)) return sequences;

      // Walk examples looking for supabase/migrations dirs
      function findMigrationDirs(dir: string, depth: number) {
        if (depth > 4) return; // don't recurse too deep
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          try {
            if (!statSync(full).isDirectory()) continue;
          } catch { continue; }

          const migDir = join(full, 'supabase', 'migrations');
          if (existsSync(migDir)) {
            const projectName = relative(examplesDir, full).replace(/\\/g, '/');
            const sqlFiles = readdirSync(migDir)
              .filter(f => f.endsWith('.sql'))
              .sort();

            if (sqlFiles.length > 0) {
              const migrations: MigrationFile[] = sqlFiles.map(f => {
                const absPath = join(migDir, f);
                return {
                  relPath: relative(repoRoot, absPath).replace(/\\/g, '/'),
                  absPath,
                  sortKey: f,
                  sql: readFileSync(absPath, 'utf-8'),
                };
              });
              sequences.push({ name: `supabase/${projectName}`, migrations });
            }
          } else {
            // Keep looking deeper
            findMigrationDirs(full, depth + 1);
          }
        }
      }

      findMigrationDirs(examplesDir, 0);
      return sequences;
    },
  };
}

// ---------------------------------------------------------------------------
// Plain SQL adapter: *.sql files in a directory, sorted by filename
// ---------------------------------------------------------------------------

function plainSqlAdapter(repoName: string, migrationDir: string): RepoAdapter {
  return {
    name: repoName,
    getSequences(repoRoot: string): MigrationSequence[] {
      const dir = join(repoRoot, migrationDir);
      if (!existsSync(dir)) return [];

      const sqlFiles = readdirSync(dir)
        .filter(f => f.endsWith('.sql'))
        .sort();

      const migrations: MigrationFile[] = sqlFiles.map(f => {
        const absPath = join(dir, f);
        return {
          relPath: relative(repoRoot, absPath).replace(/\\/g, '/'),
          absPath,
          sortKey: f,
          sql: readFileSync(absPath, 'utf-8'),
        };
      });

      return [{ name: repoName, migrations }];
    },
  };
}

// ---------------------------------------------------------------------------
// Registry — maps repo names to their adapters
// ---------------------------------------------------------------------------

export const REPO_ADAPTERS: Record<string, RepoAdapter> = {
  'supabase': supabaseAdapter(),
  'cal.com': prismaAdapter('cal.com', 'packages/prisma/migrations'),
  'formbricks': prismaAdapter('formbricks', 'packages/database/migration'),
};

export const CLONE_DIR_NAME = '_repos';
