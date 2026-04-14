/**
 * dm28-runner.ts — Run the DM-28 deploy-window gate against all cloned
 * Prisma-corpus sequences and emit a findings JSONL + summary.
 *
 * First-pass runnable result. Not a calibration attempt. The output is a
 * factual "the detector fired N times on the revert-derived corpus"
 * statement, recorded locally so the next calibration session can
 * manually classify and decide promotion.
 *
 * Usage: bun run scripts/mvp-migration/dm28-runner.ts
 */
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO_ADAPTERS, CLONE_DIR_NAME } from './repo-adapter';
import { runDeployWindowGate } from './deploy-window-gate';
import type { Dm28Finding } from './deploy-window-gate';

const CORPUS_DIR = join(import.meta.dir, 'corpus');
const CLONE_DIR = join(CORPUS_DIR, CLONE_DIR_NAME);
const REPORT_DIR = join(import.meta.dir, 'reports');

interface RichFinding extends Dm28Finding {
  repo: string;
  sequence: string;
  corpus_id: string;
}

function main() {
  console.log('=== DM-28 DEPLOY-WINDOW GATE — FIRST-PASS RUN ===\n');

  const rich: RichFinding[] = [];
  let totalMigrations = 0;
  let totalSetNotNullEvents = 0;

  for (const [repo, adapter] of Object.entries(REPO_ADAPTERS)) {
    const root = join(CLONE_DIR, repo);
    if (!existsSync(root)) {
      console.log(`  ⚠ ${repo}: clone not found, skipping`);
      continue;
    }
    const seqs = adapter.getSequences(root);
    for (const seq of seqs) {
      const result = runDeployWindowGate(seq);
      totalMigrations += result.stats.total_migrations;
      totalSetNotNullEvents += result.stats.set_not_null_events;

      if (result.stats.total_migrations > 0) {
        console.log(
          `  ${repo}::${seq.name}: ${result.stats.total_migrations} migrations, ` +
            `${result.stats.set_not_null_events} SET-NOT-NULL events, ` +
            `${result.stats.confirmed_reverts} confirmed reverts`,
        );
      }

      for (const f of result.findings) {
        rich.push({
          ...f,
          repo,
          sequence: seq.name,
          corpus_id: 'prisma-revert-derived-v1',
        });
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('DM-28 FIRST-PASS SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total migrations scanned:     ${totalMigrations}`);
  console.log(`Total SET-NOT-NULL events:    ${totalSetNotNullEvents}`);
  console.log(`DM-28 findings (confirmed):   ${rich.length}`);

  if (rich.length > 0) {
    console.log('\nFindings:');
    for (const f of rich) {
      console.log(
        `  ${f.repo} ${f.table}.${f.column} (${f.originating_pattern}, gap=${f.gap_migrations})`,
      );
      console.log(`    orig:   ${f.originating_migration}`);
      console.log(`    revert: ${f.revert_migration}`);
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const findingsPath = join(REPORT_DIR, `dm28-findings-${stamp}.jsonl`);
  writeFileSync(
    findingsPath,
    rich.map((f) => JSON.stringify(f)).join('\n') + (rich.length ? '\n' : ''),
  );

  const summaryPath = join(REPORT_DIR, `dm28-findings-${stamp}-summary.json`);
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        total_migrations_scanned: totalMigrations,
        total_set_not_null_events: totalSetNotNullEvents,
        total_findings: rich.length,
        corpus_id: 'prisma-revert-derived-v1',
        by_repo: rich.reduce<Record<string, number>>((acc, f) => {
          acc[f.repo] = (acc[f.repo] || 0) + 1;
          return acc;
        }, {}),
        notes: [
          'First-pass DM-28 detector run. Not a calibration attempt.',
          'Retrospective detection: only fires on incidents where the team already reverted.',
          'corpus_id prisma-revert-derived-v1 is pre-registered by name and awaits a formal calibration attempt before being added to calibration/corpora.json.',
          'Manual classification is a separate session; no TP/FP labels are assigned here.',
        ],
      },
      null,
      2,
    ),
  );

  console.log(`\nFindings: ${findingsPath}`);
  console.log(`Summary:  ${summaryPath}`);
}

main();
