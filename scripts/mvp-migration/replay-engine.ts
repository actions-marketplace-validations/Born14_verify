/**
 * replay-engine.ts — Corpus replay: build schema from prior migrations,
 * run grounding + safety gates on each migration, emit JSONL findings.
 *
 * Usage: bun run scripts/mvp-migration/replay-engine.ts
 */
import { loadModule } from 'libpg-query';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { REPO_ADAPTERS, CLONE_DIR_NAME } from './repo-adapter';
import type { MigrationSequence, MigrationFile } from './repo-adapter';
import { createEmptySchema, applyMigrationSQL } from './schema-loader';
import { parseMigration } from './spec-from-ast';
import { runGroundingGate } from './grounding-gate';
import { runSafetyGate } from './safety-gate';
import type { Schema, MigrationFinding } from '../../src/types-migration';

const CORPUS_DIR = join(import.meta.dir, 'corpus');
const CLONE_DIR = join(CORPUS_DIR, CLONE_DIR_NAME);
const REPORT_DIR = join(import.meta.dir, 'reports');

// ---------------------------------------------------------------------------
// Finding row for JSONL output
// ---------------------------------------------------------------------------

interface FindingRow {
  repo: string;
  sequence: string;
  file: string;
  migrationIndex: number;
  totalMigrations: number;
  shapeId: string;
  severity: 'error' | 'warning';
  message: string;
  line: number | null;
  stmtIndex: number | null;
  opIndex: number | null;
  /** For DM-15/16: the dependency chain that caused the finding */
  dependencyDetail: string | null;
  /** Schema table count at time of check */
  schemaTableCount: number;
}

// ---------------------------------------------------------------------------
// Replay one sequence
// ---------------------------------------------------------------------------

function replaySequence(seq: MigrationSequence, repoName: string): {
  findings: FindingRow[];
  stats: { total: number; parsed: number; schemaErrors: number; withFindings: number };
} {
  const schema = createEmptySchema();
  const findings: FindingRow[] = [];
  let parsed = 0;
  let schemaErrors = 0;
  let withFindings = 0;

  for (let i = 0; i < seq.migrations.length; i++) {
    const mig = seq.migrations[i];

    // 1. Parse migration N into MigrationSpec
    const spec = parseMigration(mig.sql, mig.relPath);
    if (spec.meta.parseErrors.length > 0) {
      // Can't process — skip but don't crash
      schemaErrors++;
      continue;
    }
    parsed++;

    // 2. Run grounding + safety against PRE-migration schema
    const grounding = runGroundingGate(spec, schema);
    const safety = runSafetyGate(spec, schema);
    const allFindings = [...grounding, ...safety];

    if (allFindings.length > 0) withFindings++;

    for (const f of allFindings) {
      // Extract dependency detail for DM-15/16 (the FK chain info is in the message)
      let depDetail: string | null = null;
      if (f.shapeId === 'DM-15' || f.shapeId === 'DM-16') {
        const match = f.message.match(/\[([^\]]+)\]/);
        if (match) depDetail = match[1];
      }

      findings.push({
        repo: repoName,
        sequence: seq.name,
        file: mig.relPath,
        migrationIndex: i,
        totalMigrations: seq.migrations.length,
        shapeId: f.shapeId,
        severity: f.severity,
        message: f.message,
        line: f.location?.line ?? null,
        stmtIndex: f.location?.stmtIndex ?? null,
        opIndex: f.location?.opIndex ?? null,
        dependencyDetail: depDetail,
        schemaTableCount: schema.tables.size,
      });
    }

    // 3. Apply migration N to schema (advance schema state for next iteration)
    try {
      applyMigrationSQL(schema, mig.sql);
    } catch (err: any) {
      // Schema apply error — log but continue. The schema may be
      // partially updated, which could cause noise on subsequent
      // migrations. Record but don't abort.
      schemaErrors++;
    }
  }

  return {
    findings,
    stats: { total: seq.migrations.length, parsed, schemaErrors, withFindings },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadModule();

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

  console.log('=== CORPUS REPLAY ENGINE ===\n');

  const allFindings: FindingRow[] = [];
  const repoStats: Array<{
    repo: string;
    sequences: number;
    totalMigrations: number;
    parsed: number;
    schemaErrors: number;
    totalFindings: number;
    migrationsWithFindings: number;
  }> = [];

  for (const [repoName, adapter] of Object.entries(REPO_ADAPTERS)) {
    const repoRoot = join(CLONE_DIR, repoName);
    if (!existsSync(repoRoot)) {
      console.log(`[skip] ${repoName}: not cloned`);
      continue;
    }

    console.log(`\n--- ${repoName} ---`);
    const sequences = adapter.getSequences(repoRoot);
    console.log(`  ${sequences.length} sequence(s)`);

    let repoTotal = 0;
    let repoParsed = 0;
    let repoSchemaErrors = 0;
    let repoFindings = 0;
    let repoMigsWithFindings = 0;

    for (const seq of sequences) {
      if (seq.migrations.length === 0) continue;

      const { findings, stats } = replaySequence(seq, repoName);
      allFindings.push(...findings);

      repoTotal += stats.total;
      repoParsed += stats.parsed;
      repoSchemaErrors += stats.schemaErrors;
      repoFindings += findings.length;
      repoMigsWithFindings += stats.withFindings;

      if (findings.length > 0) {
        console.log(`  ${seq.name}: ${findings.length} finding(s) across ${stats.withFindings}/${stats.total} migrations`);
      }
    }

    repoStats.push({
      repo: repoName,
      sequences: sequences.length,
      totalMigrations: repoTotal,
      parsed: repoParsed,
      schemaErrors: repoSchemaErrors,
      totalFindings: repoFindings,
      migrationsWithFindings: repoMigsWithFindings,
    });

    console.log(`  Total: ${repoFindings} findings, ${repoSchemaErrors} schema errors, ${repoMigsWithFindings}/${repoTotal} migrations flagged`);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('\n\n' + '='.repeat(70));
  console.log('REPLAY SUMMARY');
  console.log('='.repeat(70));

  const totalMigrations = repoStats.reduce((s, r) => s + r.totalMigrations, 0);
  const totalFindings = allFindings.length;
  const totalFlagged = repoStats.reduce((s, r) => s + r.migrationsWithFindings, 0);

  console.log(`\nCorpus: ${repoStats.length} repos, ${totalMigrations} migrations`);
  console.log(`Total findings: ${totalFindings}`);
  console.log(`Migrations with ≥1 finding: ${totalFlagged} (${totalMigrations ? (totalFlagged / totalMigrations * 100).toFixed(1) : 0}%)`);

  // Shape distribution
  const shapeCounts: Record<string, { error: number; warning: number }> = {};
  for (const f of allFindings) {
    if (!shapeCounts[f.shapeId]) shapeCounts[f.shapeId] = { error: 0, warning: 0 };
    shapeCounts[f.shapeId][f.severity]++;
  }

  console.log('\nFindings by shape:');
  for (const [shape, counts] of Object.entries(shapeCounts).sort((a, b) => (b[1].error + b[1].warning) - (a[1].error + a[1].warning))) {
    console.log(`  ${shape}: ${counts.error} error, ${counts.warning} warning (${counts.error + counts.warning} total)`);
  }

  // Per-repo breakdown
  console.log('\nPer-repo:');
  for (const r of repoStats) {
    console.log(`  ${r.repo}: ${r.totalFindings} findings across ${r.migrationsWithFindings}/${r.totalMigrations} migrations (${r.schemaErrors} schema errors)`);
  }

  console.log(`\nNOTE: These are findings against replayed schema state.`);
  console.log(`"pattern present" is now "pattern present given schema context."`);
  console.log(`Still requires manual calibration to distinguish TP from FP.`);

  // ---------------------------------------------------------------------------
  // Write outputs
  // ---------------------------------------------------------------------------

  // JSONL findings
  const findingsPath = join(REPORT_DIR, `replay-findings-${new Date().toISOString().slice(0, 10)}.jsonl`);
  writeFileSync(findingsPath, allFindings.map(f => JSON.stringify(f)).join('\n') + '\n');
  console.log(`\nFindings written to: ${findingsPath} (${allFindings.length} rows)`);

  // Summary JSON
  const summaryPath = join(REPORT_DIR, `replay-summary-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    corpus: repoStats,
    summary: {
      totalMigrations,
      totalFindings,
      totalFlagged,
      flaggedRate: totalMigrations ? (totalFlagged / totalMigrations * 100).toFixed(1) + '%' : 'N/A',
      caveat: 'Findings are against replayed schema state. Manual calibration required for TP/FP classification.',
    },
    shapeDistribution: shapeCounts,
  }, null, 2));
  console.log(`Summary written to: ${summaryPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
