/**
 * Verify Action — Migrations-only entry point.
 *
 * Checks SQL migration files in a PR for unsafe patterns (DM-18 etc.).
 * No 26-gate pipeline. No LLM. Just SQL parsing via libpg-query.
 */
import { detectMigrationFiles } from '../action/migration-check.js';
import type { MigrationGroup } from '../action/migration-check.js';
import {
  getPRFiles,
  getPRMetadata,
  getFileContent,
  postPRComment,
} from '../action/github.js';
import { parseMigration } from '../../scripts/mvp-migration/spec-from-ast.js';
import {
  createEmptySchema,
  applyMigrationSQL,
} from '../../scripts/mvp-migration/schema-loader.js';
import { runGroundingGate } from '../../scripts/mvp-migration/grounding-gate.js';
import { runSafetyGate } from '../../scripts/mvp-migration/safety-gate.js';
import { loadModule } from 'libpg-query';
import type { MigrationFinding, Schema } from '../types-migration.js';
import { formatComment } from './comment.js';

export type TaggedFinding = MigrationFinding & { file: string };

// Blocking shapes — these cause the check to fail
const BLOCKING_SHAPES = new Set(['DM-18']);

// Warning-only shapes — reported but don't fail the check
const WARNING_SHAPES = new Set(['DM-15', 'DM-16', 'DM-17']);

/**
 * Run migration gates on grouped migration files.
 * Returns findings tagged with their source file path.
 */
async function runMigrationGates(groups: MigrationGroup[]): Promise<{
  findings: TaggedFinding[];
  filesChecked: string[];
}> {
  await loadModule();
  const findings: TaggedFinding[] = [];
  const filesChecked: string[] = [];

  for (const group of groups) {
    const schema: Schema = createEmptySchema();
    let priorIdx = 0;
    for (const priorSql of group.priorMigrationsSql) {
      priorIdx++;
      try {
        applyMigrationSQL(schema, priorSql);
      } catch (err: any) {
        console.log(
          `::warning::Schema bootstrap incomplete in ${group.root}: prior migration ` +
            `${priorIdx}/${group.priorMigrationsSql.length} failed to apply ` +
            `(${err?.message ?? 'unknown error'}). Findings on this group may be incomplete.`,
        );
      }
    }

    for (const file of group.newFiles) {
      filesChecked.push(file.path);
      try {
        const spec = parseMigration(file.sql, file.path);
        if (spec.meta.parseErrors.length > 0) {
          console.log(
            `::warning::Could not parse ${file.path}: ${spec.meta.parseErrors[0]}. Skipping.`,
          );
          continue;
        }
        const grounding = runGroundingGate(spec, schema);
        const safety = runSafetyGate(spec, schema);
        for (const f of [...grounding, ...safety]) {
          // Tag with file path and apply severity rules
          if (!BLOCKING_SHAPES.has(f.shapeId) && WARNING_SHAPES.has(f.shapeId)) {
            f.severity = 'warning';
          }
          findings.push({ ...f, file: file.path });
        }
        try {
          applyMigrationSQL(schema, file.sql);
        } catch (err: any) {
          console.log(
            `::warning::Schema state could not advance after ${file.path} ` +
              `(${err?.message ?? 'unknown error'}). Subsequent files may produce incomplete findings.`,
          );
        }
      } catch (err: any) {
        console.log(
          `::warning::Failed to check ${file.path}: ${err?.message ?? 'unknown error'}.`,
        );
      }
    }
  }

  return { findings, filesChecked };
}

/**
 * Returns true if a finding has been suppressed by an in-file ack comment.
 */
function isAcked(f: MigrationFinding): boolean {
  return f.message.includes('[ACKED]');
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

// ---------------------------------------------------------------------------
// Migration root computation
// ---------------------------------------------------------------------------

function migrationRoot(p: string): { root: string; isPrisma: boolean } {
  if (/\/migration\.sql$/i.test(p)) {
    return { root: p.replace(/\/[^/]+\/migration\.sql$/i, ''), isPrisma: true };
  }
  return { root: p.replace(/\/[^/]+$/, ''), isPrisma: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const token = env('GITHUB_TOKEN') || env('INPUT_TOKEN') || '';
  const commentEnabled = (env('INPUT_COMMENT', 'true')) === 'true';
  const failOn = (env('INPUT_FAIL_ON') || env('INPUT_FAIL-ON') || 'error').toLowerCase();

  const eventPath = env('GITHUB_EVENT_PATH');
  if (!eventPath) {
    console.log('::error::Not running in GitHub Actions context');
    process.exit(1);
  }

  const { readFileSync } = await import('node:fs');
  const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
  const prNumber: number | undefined = event.pull_request?.number ?? event.number;
  const [owner, repo] = (env('GITHUB_REPOSITORY') || '').split('/');

  if (!prNumber || !owner || !repo) {
    console.log('::error::Could not determine PR number or repository');
    process.exit(1);
  }
  if (!token) {
    console.log('::error::No GitHub token. Set GITHUB_TOKEN or use permissions: pull-requests: write, contents: read');
    process.exit(1);
  }

  console.log(`Verify: PR #${prNumber} in ${owner}/${repo}`);

  // ── Phase 1: detect migration files ────────────────────────────────────
  let migrationPaths: string[] = [];
  try {
    const prFiles = await getPRFiles(token, owner, repo, prNumber);
    migrationPaths = detectMigrationFiles(prFiles.map((f) => f.filename));
  } catch (err: any) {
    console.log(`::error::Could not list PR files: ${err.message}`);
    process.exit(1);
  }

  if (migrationPaths.length === 0) {
    console.log('No migration files in this PR. Nothing to check.');
    return;
  }

  console.log(`Found ${migrationPaths.length} migration file(s)`);

  // ── Phase 2: build groups + run gates ──────────────────────────────────
  let allFindings: TaggedFinding[] = [];
  let filesChecked: string[] = [];

  try {
    const metadata = await getPRMetadata(token, owner, repo, prNumber);
    const baseRef = metadata.baseSha || metadata.baseBranch;
    console.log(
      `Schema pin: ${metadata.baseSha ? `base SHA ${metadata.baseSha.slice(0, 7)}` : `base branch ${metadata.baseBranch}`}`,
    );

    type RootInfo = { isPrisma: boolean; paths: string[] };
    const rootMap = new Map<string, RootInfo>();
    for (const p of migrationPaths) {
      const { root, isPrisma } = migrationRoot(p);
      const existing = rootMap.get(root);
      if (existing) existing.paths.push(p);
      else rootMap.set(root, { isPrisma, paths: [p] });
    }

    console.log(`Detected ${rootMap.size} migration root(s)`);

    const groups: MigrationGroup[] = [];
    for (const [root, info] of rootMap) {
      const priorSql: string[] = [];
      try {
        const dirRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(root)}?ref=${baseRef}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          },
        );
        if (dirRes.ok) {
          const dirContents = (await dirRes.json()) as any[];
          if (info.isPrisma) {
            const priorDirs = dirContents
              .filter((f: any) => f.type === 'dir')
              .map((f: any) => f.path)
              .sort();
            for (const subdir of priorDirs) {
              const sqlPath = `${subdir}/migration.sql`;
              if (info.paths.includes(sqlPath)) continue;
              const sql = await getFileContent(token, owner, repo, sqlPath, baseRef);
              if (sql) priorSql.push(sql);
            }
          } else {
            const priorFiles = dirContents
              .filter((f: any) => f.name.endsWith('.sql') && f.type === 'file')
              .map((f: any) => f.path)
              .filter((p: string) => !info.paths.includes(p))
              .sort();
            for (const pf of priorFiles) {
              const sql = await getFileContent(token, owner, repo, pf, baseRef);
              if (sql) priorSql.push(sql);
            }
          }
        }
      } catch {
        /* directory listing failed — group bootstraps from empty schema */
      }

      const sortedPaths = [...info.paths].sort();
      const newFiles: Array<{ path: string; sql: string }> = [];
      for (const path of sortedPaths) {
        const content = await getFileContent(token, owner, repo, path, metadata.headSha);
        if (content) newFiles.push({ path, sql: content });
      }

      groups.push({ root, priorMigrationsSql: priorSql, newFiles });
      console.log(`  ${root}: ${priorSql.length} prior migration(s) for bootstrap`);
    }

    const result = await runMigrationGates(groups);
    allFindings = result.findings;
    filesChecked = result.filesChecked;
    console.log(`${allFindings.length} total finding(s)`);
  } catch (err: any) {
    console.log(`::error::Migration verifier failed: ${err.message}`);
    if (err.stack) console.log(err.stack);
    process.exit(1);
  }

  // ── Phase 3: filter acked findings ─────────────────────────────────────
  const visible = allFindings.filter((f) => !isAcked(f));
  const ackedCount = allFindings.length - visible.length;
  if (ackedCount > 0) {
    console.log(`${ackedCount} finding(s) suppressed by ack comments`);
  }

  // ── Phase 4: post comment ──────────────────────────────────────────────
  if (commentEnabled) {
    const body = formatComment(visible, filesChecked);
    if (body) {
      try {
        await postPRComment(token, owner, repo, prNumber, body);
        console.log('Comment posted.');
      } catch (err: any) {
        console.log(`::warning::Could not post PR comment: ${err.message}`);
      }
    }
  }

  // ── Phase 5: exit code ─────────────────────────────────────────────────
  if (failOn === 'none') return;

  const hasError = visible.some((f) => f.severity === 'error');
  const hasWarning = visible.some((f) => f.severity === 'warning');

  if (failOn === 'error' && hasError) {
    console.log('::error::Blocking migration findings present — failing check');
    process.exit(1);
  }
  if (failOn === 'warning' && (hasError || hasWarning)) {
    console.log('::error::Migration findings present — failing check (fail-on: warning)');
    process.exit(1);
  }
}

if (process.env.GITHUB_ACTIONS) {
  run().catch((err) => {
    console.log(`::error::${err?.message ?? err}`);
    if (err?.stack) console.log(err.stack);
    process.exit(1);
  });
}
