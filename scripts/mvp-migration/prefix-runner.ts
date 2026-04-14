/**
 * prefix-runner.ts — Pre-fix pipeline v1.
 *
 * Reads the revert-pair JSONL emitted by full-corpus-reverts.ts (committed
 * in fc2d72e), reconstructs the pre-revert schema state of each pair's
 * originating migration by replaying the sequence up to (but not including)
 * the originating index, parses the originating migration into a
 * MigrationSpec, and runs the existing grounding and safety gates against
 * that state. Emits one finding row per rule firing, tagged with the
 * originating revert pair and the replay provenance.
 *
 * This is the v1 scoped in pre-fix-pipeline-v1-scope-draft.md:
 *   - revert-derived states from already-cloned repos only
 *   - no filesystem checkouts (replay is in-memory)
 *   - no gate or taxonomy changes
 *   - no precision computed (manual classification is a separate session)
 *   - output is reusable input for future attempt sessions
 *
 * Usage: bun run scripts/mvp-migration/prefix-runner.ts [revert-jsonl-path]
 */
import { loadModule } from 'libpg-query';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO_ADAPTERS, CLONE_DIR_NAME } from './repo-adapter';
import type { MigrationSequence } from './repo-adapter';
import { createEmptySchema, applyMigrationSQL } from './schema-loader';
import { parseMigration } from './spec-from-ast';
import { runGroundingGate } from './grounding-gate';
import { runSafetyGate } from './safety-gate';

const CORPUS_DIR = join(import.meta.dir, 'corpus');
const CLONE_DIR = join(CORPUS_DIR, CLONE_DIR_NAME);
const REPORT_DIR = join(import.meta.dir, 'reports');
const DEFAULT_REVERT_JSONL = join(REPORT_DIR, 'full-corpus-reverts-2026-04-14.jsonl');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RevertCandidate {
  repo: string;
  sequence: string;
  original_migration: string;
  original_migration_idx: number;
  revert_migration: string;
  revert_migration_idx: number;
  table: string;
  column: string;
  original_change: string;
  revert_evidence_type: string;
  revert_evidence_confidence: string;
  revert_evidence_excerpt: string;
  gap_migrations: number;
  matches_existing_dm18_finding: boolean;
}

interface PrefixFinding {
  shapeId: string;
  severity: string;
  message: string;
  line: number | null;
  stmtIndex: number | null;
  opIndex: number | null;
  revert_pair_source: {
    repo: string;
    sequence: string;
    original_migration: string;
    original_migration_idx: number;
    revert_migration: string;
    revert_migration_idx: number;
    original_change: string;
    revert_evidence_type: string;
    gap_migrations: number;
    matches_existing_dm18_finding: boolean;
  };
  pre_fix_state_provenance: string;
  pre_fix_schema_tables: number;
  corpus_id: string;
}

// ---------------------------------------------------------------------------
// Sequence cache — load each (repo, sequence) once
// ---------------------------------------------------------------------------

interface SeqKey {
  repo: string;
  sequenceName: string;
}

function seqCacheKey(k: SeqKey): string {
  return `${k.repo}::${k.sequenceName}`;
}

function loadSequenceFor(repo: string, sequenceName: string): MigrationSequence | null {
  const adapter = REPO_ADAPTERS[repo];
  if (!adapter) return null;
  const root = join(CLONE_DIR, repo);
  if (!existsSync(root)) return null;
  const seqs = adapter.getSequences(root);
  return seqs.find((s) => s.name === sequenceName) ?? seqs[0] ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadModule();

  const inputPath = process.argv[2] || DEFAULT_REVERT_JSONL;
  console.log(`=== PRE-FIX PIPELINE v1 ===`);
  console.log(`Input: ${inputPath}\n`);

  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(2);
  }

  const candidates: RevertCandidate[] = readFileSync(inputPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log(`Loaded ${candidates.length} revert candidates\n`);

  // Group by (repo, sequence) so we load each sequence once
  const sequences = new Map<string, MigrationSequence>();
  const byGroup = new Map<string, RevertCandidate[]>();
  for (const c of candidates) {
    const k = seqCacheKey({ repo: c.repo, sequenceName: c.sequence });
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(c);
  }

  for (const k of byGroup.keys()) {
    const [repo, seqName] = k.split('::');
    const seq = loadSequenceFor(repo, seqName);
    if (!seq) {
      console.log(`  ⚠ ${k}: sequence not loadable, skipping ${byGroup.get(k)!.length} candidates`);
      continue;
    }
    sequences.set(k, seq);
    console.log(`  ${k}: ${seq.migrations.length} migrations loaded`);
  }
  console.log();

  const findings: PrefixFinding[] = [];
  const shapeCounts = new Map<string, number>();
  let processed = 0;
  let skipped = 0;
  let parseFail = 0;

  // Sort candidates within each group by original_migration_idx so the
  // replay can be done once per group, advancing incrementally rather than
  // replaying from zero for every candidate. Significant speedup on dense
  // groups like cal.com.
  for (const [k, group] of byGroup) {
    const seq = sequences.get(k);
    if (!seq) {
      skipped += group.length;
      continue;
    }
    const sorted = [...group].sort((a, b) => a.original_migration_idx - b.original_migration_idx);

    const schema = createEmptySchema();
    let replayedUpTo = 0; // schema reflects migrations [0, replayedUpTo)

    for (const cand of sorted) {
      const targetIdx = cand.original_migration_idx;

      // Advance schema state to just before the originating migration
      while (replayedUpTo < targetIdx) {
        const mig = seq.migrations[replayedUpTo];
        try {
          applyMigrationSQL(schema, mig.sql);
        } catch (err) {
          // Continue past schema apply errors — matches replay-engine.ts behavior
        }
        replayedUpTo++;
      }

      if (targetIdx < 0 || targetIdx >= seq.migrations.length) {
        skipped++;
        continue;
      }

      // Parse originating migration into a spec
      const origMig = seq.migrations[targetIdx];
      const spec = parseMigration(origMig.sql, origMig.relPath);
      if (spec.meta.parseErrors.length > 0) {
        parseFail++;
        continue;
      }

      // Run both gates against the replayed pre-fix schema state
      const grounding = runGroundingGate(spec, schema);
      const safety = runSafetyGate(spec, schema);
      const all = [...grounding, ...safety];

      processed++;

      for (const f of all) {
        shapeCounts.set(f.shapeId, (shapeCounts.get(f.shapeId) || 0) + 1);
        findings.push({
          shapeId: f.shapeId,
          severity: f.severity,
          message: f.message,
          line: f.location?.line ?? null,
          stmtIndex: f.location?.stmtIndex ?? null,
          opIndex: f.location?.opIndex ?? null,
          revert_pair_source: {
            repo: cand.repo,
            sequence: cand.sequence,
            original_migration: cand.original_migration,
            original_migration_idx: cand.original_migration_idx,
            revert_migration: cand.revert_migration,
            revert_migration_idx: cand.revert_migration_idx,
            original_change: cand.original_change,
            revert_evidence_type: cand.revert_evidence_type,
            gap_migrations: cand.gap_migrations,
            matches_existing_dm18_finding: cand.matches_existing_dm18_finding,
          },
          pre_fix_state_provenance: `replayed from sequence index 0 through ${targetIdx - 1}`,
          pre_fix_schema_tables: schema.tables.size,
          corpus_id: 'prisma-revert-derived-v1',
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  const stamp = new Date().toISOString().slice(0, 10);
  const findingsPath = join(REPORT_DIR, `prefix-findings-${stamp}.jsonl`);
  writeFileSync(
    findingsPath,
    findings.map((f) => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : ''),
  );

  const summaryPath = join(REPORT_DIR, `prefix-findings-${stamp}-summary.json`);
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        input: inputPath,
        candidates_loaded: candidates.length,
        candidates_processed: processed,
        candidates_skipped: skipped,
        candidates_parse_failed: parseFail,
        total_findings: findings.length,
        by_shape: Object.fromEntries(shapeCounts),
        corpus_id: 'prisma-revert-derived-v1',
        notes: [
          'Pre-fix pipeline v1 output. Not a calibration run.',
          'No precision computed. Manual classification is a separate session.',
          'corpus_id prisma-revert-derived-v1 is pre-registered by name but not yet in calibration/corpora.json. The first attempt session adds it alongside its attempt row.',
          'Findings are tagged with the originating revert pair so the classifier can read both the originating and the revert migration when judging TP/FP.',
        ],
      },
      null,
      2,
    ),
  );

  console.log('='.repeat(70));
  console.log('PRE-FIX PIPELINE v1 SUMMARY');
  console.log('='.repeat(70));
  console.log(`Candidates loaded:     ${candidates.length}`);
  console.log(`  Processed:           ${processed}`);
  console.log(`  Parse failures:      ${parseFail}`);
  console.log(`  Skipped (no seq):    ${skipped}`);
  console.log(`Total findings:        ${findings.length}`);
  if (shapeCounts.size > 0) {
    console.log('\nBy shape:');
    for (const [shape, count] of [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${shape.padEnd(8)} ${count}`);
    }
  } else {
    console.log('\nNo findings. The revert candidates in this input do not trigger any');
    console.log('existing grounding or safety shape against the replayed pre-fix state.');
    console.log('This is a real result, not a failure — record it and stop.');
  }
  console.log(`\nFindings: ${findingsPath}`);
  console.log(`Summary:  ${summaryPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
