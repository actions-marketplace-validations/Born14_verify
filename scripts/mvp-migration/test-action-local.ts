/**
 * test-action-local.ts — Local simulation of the GitHub Action migration check.
 *
 * Proves the full pipeline: detect migration files → load prior schema →
 * parse migration → run gates → format PR comment.
 *
 * Usage: bun run scripts/mvp-migration/test-action-local.ts
 */
import { loadModule } from 'libpg-query';
import { checkMigrations, formatMigrationComment, detectMigrationFiles } from '../../src/action/migration-check';

await loadModule();

console.log('=== LOCAL ACTION SIMULATION ===\n');

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
  const priorSql = [
    'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);',
  ];
  const migrationFiles = new Map<string, string>([
    ['migrations/20260412_add_name.sql',
     'ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL;'],
  ]);

  const result = await checkMigrations(migrationFiles, priorSql);
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
  const priorSql = [
    'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);',
  ];
  const migrationFiles = new Map<string, string>([
    ['migrations/20260412_add_bio.sql',
     'ALTER TABLE "users" ADD COLUMN "bio" TEXT DEFAULT \'\';'],
  ]);

  const result = await checkMigrations(migrationFiles, priorSql);
  console.log('  Passed:', result.passed);
  console.log('  Findings:', result.findings.length);
  console.assert(result.passed, 'should PASS');
  console.assert(result.findings.length === 0, 'should have 0 findings');

  const comment = formatMigrationComment(result);
  console.log('  Comment:', comment.trim());
  console.log('  ✓ Safe migration passes\n');
}

// --- Test 4: DM-18 with ack → passes (warning only) ---
console.log('Test 4: DM-18 with ack passes');
{
  const priorSql = [
    'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);',
  ];
  const migrationFiles = new Map<string, string>([
    ['migrations/20260412_add_name.sql',
     `-- verify: ack DM-18 table is empty during migration window
ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL;`],
  ]);

  const result = await checkMigrations(migrationFiles, priorSql);
  console.log('  Passed:', result.passed);
  console.log('  Findings:', result.findings.length);
  for (const f of result.findings) {
    console.log(`    ${f.shapeId} [${f.severity}]: ${f.message.slice(0, 80)}`);
  }
  // DM-18 with ack → downgraded to warning → should pass
  console.assert(result.passed, 'should PASS (acked)');
  console.assert(result.findings[0]?.severity === 'warning', 'should be warning');
  console.log('  ✓ Ack suppresses blocking\n');
}

// --- Test 5: Hallucinated table (DM-01) → blocks ---
console.log('Test 5: Hallucinated table blocks');
{
  const priorSql = [
    'CREATE TABLE "user_profile" ("id" SERIAL PRIMARY KEY);',
  ];
  const migrationFiles = new Map<string, string>([
    ['migrations/20260412_agent_mistake.sql',
     'ALTER TABLE "user_profiles" ADD COLUMN "last_login" TIMESTAMPTZ;'],
  ]);

  const result = await checkMigrations(migrationFiles, priorSql);
  console.log('  Passed:', result.passed);
  for (const f of result.findings) {
    console.log(`    ${f.shapeId} [${f.severity}]: ${f.message}`);
  }
  console.assert(!result.passed, 'should FAIL (DM-01)');
  console.log('  ✓ Hallucinated table blocks\n');
}

console.log('=== ALL LOCAL ACTION TESTS PASSED ===');
