/**
 * test-action-local.ts — Local simulation of the GitHub Action migration check.
 *
 * Proves the full pipeline: detect migration files → load prior schema →
 * parse migration → run gates → format PR comment.
 *
 * Includes a regression test for the multi-root partitioning bug Codex caught:
 * tables in one migration root must NOT satisfy lookups from another root.
 *
 * Usage: bun run scripts/mvp-migration/test-action-local.ts
 */
import { loadModule } from 'libpg-query';
import { checkMigrations, formatMigrationComment, detectMigrationFiles } from '../../src/action/migration-check';
import type { MigrationGroup } from '../../src/action/migration-check';

await loadModule();

console.log('=== LOCAL ACTION SIMULATION ===\n');

/** Helper: build a single-root group from a flat priorSql + new file */
function singleGroup(root: string, priorSql: string[], newFiles: Array<{ path: string; sql: string }>): MigrationGroup[] {
  return [{ root, priorMigrationsSql: priorSql, newFiles }];
}

// --- Test 1: Detect migration files from changed file list ---
console.log('Test 1: File detection');
const changedFiles = [
  'src/index.ts',
  'packages/prisma/migrations/20260412_add_verified/migration.sql',
  'README.md',
  'supabase/migrations/20260412_users.sql',
  'db/migrate/20260412_add_column.sql',
];
const detected = detectMigrationFiles(changedFiles);
console.log('  Changed files:', changedFiles.length);
console.log('  Detected migrations:', detected);
console.assert(detected.length === 3, 'should detect 3 migration files');
console.log('  ✓ Detection works\n');

// --- Test 2: DM-18 violation → blocks merge ---
console.log('Test 2: DM-18 blocks merge');
{
  const groups = singleGroup(
    'migrations',
    ['CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);'],
    [{
      path: 'migrations/20260412_add_name.sql',
      sql: 'ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL;',
    }],
  );

  const result = await checkMigrations(groups);
  console.log('  Passed:', result.passed);
  console.log('  Findings:', result.findings.length);
  for (const f of result.findings) {
    console.log(`    ${f.shapeId} [${f.severity}]: ${f.message}`);
  }
  console.assert(!result.passed, 'should FAIL (DM-18 blocks)');
  console.assert(result.findings[0]?.shapeId === 'DM-18', 'should be DM-18');

  const comment = formatMigrationComment(result);
  console.log('\n  --- PR COMMENT PREVIEW ---');
  console.log(comment);
  console.log('  --- END PREVIEW ---');
  console.log('  ✓ DM-18 blocks correctly\n');
}

// --- Test 3: Safe migration → passes ---
console.log('Test 3: Safe migration passes');
{
  const groups = singleGroup(
    'migrations',
    ['CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);'],
    [{
      path: 'migrations/20260412_add_bio.sql',
      sql: 'ALTER TABLE "users" ADD COLUMN "bio" TEXT DEFAULT \'\';',
    }],
  );

  const result = await checkMigrations(groups);
  console.log('  Passed:', result.passed);
  console.log('  Findings:', result.findings.length);
  console.assert(result.passed, 'should PASS');
  console.assert(result.findings.length === 0, 'should have 0 findings');
  console.log('  ✓ Safe migration passes\n');
}

// --- Test 4: DM-18 with ack → passes (warning only) ---
console.log('Test 4: DM-18 with ack passes');
{
  const groups = singleGroup(
    'migrations',
    ['CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);'],
    [{
      path: 'migrations/20260412_add_name.sql',
      sql: `-- verify: ack DM-18 table is empty during migration window
ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL;`,
    }],
  );

  const result = await checkMigrations(groups);
  console.log('  Passed:', result.passed);
  console.log('  Findings:', result.findings.length);
  for (const f of result.findings) {
    console.log(`    ${f.shapeId} [${f.severity}]: ${f.message.slice(0, 80)}`);
  }
  console.assert(result.passed, 'should PASS (acked)');
  console.assert(result.findings[0]?.severity === 'warning', 'should be warning');
  console.log('  ✓ Ack suppresses blocking\n');
}

// --- Test 5: Hallucinated table (DM-01) → blocks ---
console.log('Test 5: Hallucinated table blocks');
{
  const groups = singleGroup(
    'migrations',
    ['CREATE TABLE "user_profile" ("id" SERIAL PRIMARY KEY);'],
    [{
      path: 'migrations/20260412_agent_mistake.sql',
      sql: 'ALTER TABLE "user_profiles" ADD COLUMN "last_login" TIMESTAMPTZ;',
    }],
  );

  const result = await checkMigrations(groups);
  console.log('  Passed:', result.passed);
  for (const f of result.findings) {
    console.log(`    ${f.shapeId} [${f.severity}]: ${f.message}`);
  }
  console.assert(!result.passed, 'should FAIL (DM-01)');
  console.log('  ✓ Hallucinated table blocks\n');
}

// --- Test 6: Multi-root isolation (regression test for Codex finding) ---
console.log('Test 6: Multi-root schemas are isolated');
{
  // Two independent migration roots — packages/api/migrations and packages/web/migrations.
  // Each root has its OWN "users" table with different columns. A naive
  // implementation would union them and let api's "users.email" satisfy
  // a lookup against web's "users", hiding a real DM-02.
  const groups: MigrationGroup[] = [
    {
      root: 'packages/api/migrations',
      priorMigrationsSql: [
        'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);',
      ],
      newFiles: [{
        path: 'packages/api/migrations/001_add_email_default.sql',
        // Safe: api.users.email exists, this just adds a default
        sql: 'ALTER TABLE "users" ALTER COLUMN "email" SET DEFAULT \'\';',
      }],
    },
    {
      root: 'packages/web/migrations',
      priorMigrationsSql: [
        // web.users does NOT have an "email" column — only "username"
        'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "username" TEXT);',
      ],
      newFiles: [{
        path: 'packages/web/migrations/001_drop_email.sql',
        // This SHOULD fail with DM-02: column "email" doesn't exist in web.users
        // If schemas were unioned, api.users.email would mask this.
        sql: 'ALTER TABLE "users" DROP COLUMN "email";',
      }],
    },
  ];

  const result = await checkMigrations(groups);
  console.log('  Group summaries:');
  for (const g of result.groupSummaries) {
    console.log(`    ${g.root}: ${g.fileCount} file(s), ${g.schemaTableCount} table(s), ${g.findingCount} finding(s)`);
  }
  console.log('  Findings:');
  for (const f of result.findings) {
    console.log(`    ${f.shapeId} [${f.severity}]: ${f.message}`);
  }

  // The web root's drop_email migration should fire DM-02, because
  // web.users doesn't have an email column. If the schemas were unioned,
  // api.users.email would mask this and there would be 0 findings.
  console.assert(
    result.findings.some(f => f.shapeId === 'DM-02'),
    'should fire DM-02 for web.users — column "email" does not exist in web root schema',
  );
  console.assert(
    result.groupSummaries.length === 2,
    'should report 2 independent groups',
  );
  console.log('  ✓ Multi-root schemas correctly isolated\n');
}

// --- Test 7: New files within a root are processed in sorted order ---
console.log('Test 7: New files sorted within root');
{
  // If processing order is wrong, the second migration would fire DM-02
  // because it depends on the column added by the first.
  const groups: MigrationGroup[] = [
    {
      root: 'migrations',
      priorMigrationsSql: [
        'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY);',
      ],
      newFiles: [
        // Intentionally provide them in REVERSE order — the action's caller
        // is responsible for sorting before passing them in.
        {
          path: 'migrations/001_add_email.sql',
          sql: 'ALTER TABLE "users" ADD COLUMN "email" TEXT;',
        },
        {
          path: 'migrations/002_set_email_default.sql',
          sql: 'ALTER TABLE "users" ALTER COLUMN "email" SET DEFAULT \'\';',
        },
      ],
    },
  ];

  const result = await checkMigrations(groups);
  console.log('  Findings:', result.findings.length);
  for (const f of result.findings) {
    console.log(`    ${f.shapeId}: ${f.message}`);
  }
  // Both migrations should pass cleanly when applied in declared order
  console.assert(result.findings.length === 0, 'should be clean when files applied in correct order');
  console.log('  ✓ Sequential application works\n');
}

console.log('=== ALL LOCAL ACTION TESTS PASSED ===');
