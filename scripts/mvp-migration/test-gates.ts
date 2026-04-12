/**
 * test-gates.ts — End-to-end test: schema + spec + grounding + safety.
 *
 * Tests the full pipeline against golden fixtures and synthetic cases.
 *
 * Usage: bun run scripts/mvp-migration/test-gates.ts
 */
import { loadModule } from 'libpg-query';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildSchemaFromSQL, applyMigrationSQL } from './schema-loader';
import { parseMigration } from './spec-from-ast';
import { runGroundingGate } from './grounding-gate';
import { runSafetyGate } from './safety-gate';
import type { MigrationFinding } from '../../src/types-migration';

await loadModule();

const FIXTURES = join(import.meta.dir, 'fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function printFindings(findings: MigrationFinding[]) {
  if (findings.length === 0) {
    console.log('  (no findings)');
    return;
  }
  for (const f of findings) {
    const icon = f.severity === 'error' ? '✗' : '⚠';
    console.log(`  ${icon} ${f.shapeId}: ${f.message}`);
    if (f.ackPattern) console.log(`    suppress: ${f.ackPattern}`);
  }
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.log(`  FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Demo A — hallucinated table name (DM-01)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 1: Demo A — hallucinated table name ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "user_profile" ("id" SERIAL PRIMARY KEY, "name" TEXT);
  `]);

  const spec = parseMigration(
    'ALTER TABLE "user_profiles" ADD COLUMN "last_login_at" TIMESTAMPTZ;',
    'demo-a.sql'
  );

  const findings = runGroundingGate(spec, schema);
  printFindings(findings);

  assert(findings.length > 0, 'should have findings');
  assert(findings[0]?.shapeId === 'DM-01', 'should be DM-01');
  assert(findings[0]?.message.includes('user_profiles'), 'should mention wrong table');
  assert(findings[0]?.message.includes('user_profile'), 'should suggest closest match');
  console.log('✓ Test 1');
}

// ---------------------------------------------------------------------------
// Test 2: Demo B — DROP COLUMN with FK dependents (DM-15)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 2: Demo B — DROP COLUMN with FK dependents ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "orders" (
      "id" SERIAL PRIMARY KEY,
      "customer_id" INTEGER NOT NULL
    );
    CREATE TABLE "invoices" (
      "id" SERIAL PRIMARY KEY,
      "order_customer" INTEGER,
      CONSTRAINT "inv_cust_fk" FOREIGN KEY ("order_customer") REFERENCES "orders"("customer_id")
    );
    CREATE TABLE "shipments" (
      "id" SERIAL PRIMARY KEY,
      "customer_id" INTEGER,
      CONSTRAINT "ship_cust_fk" FOREIGN KEY ("customer_id") REFERENCES "orders"("customer_id")
    );
    CREATE TABLE "refunds" (
      "id" SERIAL PRIMARY KEY,
      "customer_id" INTEGER,
      CONSTRAINT "ref_cust_fk" FOREIGN KEY ("customer_id") REFERENCES "orders"("customer_id")
    );
  `]);

  const spec = parseMigration(
    'ALTER TABLE "orders" DROP COLUMN "customer_id";',
    'demo-b.sql'
  );

  const grounding = runGroundingGate(spec, schema);
  const safety = runSafetyGate(spec, schema);
  console.log('  Grounding:');
  printFindings(grounding);
  console.log('  Safety:');
  printFindings(safety);

  assert(safety.some(f => f.shapeId === 'DM-15'), 'should have DM-15');
  assert(safety.some(f => f.message.includes('3 incoming FK')), 'should report 3 dependents');
  assert(safety.some(f => f.message.includes('invoices')), 'should mention invoices');
  assert(safety.some(f => f.message.includes('shipments')), 'should mention shipments');
  assert(safety.some(f => f.message.includes('refunds')), 'should mention refunds');
  console.log('✓ Test 2');
}

// ---------------------------------------------------------------------------
// Test 3: NOT NULL without default (DM-18)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 3: ADD COLUMN NOT NULL without DEFAULT ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);
  `]);

  const spec = parseMigration(
    'ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL;',
    'dm18.sql'
  );

  const safety = runSafetyGate(spec, schema);
  printFindings(safety);

  assert(safety.some(f => f.shapeId === 'DM-18'), 'should have DM-18');
  assert(safety.some(f => f.message.includes('NOT NULL without DEFAULT')), 'should explain the issue');
  console.log('✓ Test 3');
}

// ---------------------------------------------------------------------------
// Test 4: Narrowing type change (DM-17)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 4: Narrowing type change ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "products" ("id" SERIAL PRIMARY KEY, "price" NUMERIC(10,2));
  `]);

  const spec = parseMigration(
    'ALTER TABLE "products" ALTER COLUMN "price" TYPE INTEGER;',
    'dm17.sql'
  );

  const safety = runSafetyGate(spec, schema);
  printFindings(safety);

  assert(safety.some(f => f.shapeId === 'DM-17'), 'should have DM-17');
  assert(safety.some(f => f.message.includes('narrowing')), 'should mention narrowing');
  console.log('✓ Test 4');
}

// ---------------------------------------------------------------------------
// Test 5: DROP TABLE with inbound FKs (DM-16)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 5: DROP TABLE with inbound FKs ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "categories" ("id" SERIAL PRIMARY KEY, "name" TEXT);
    CREATE TABLE "products" (
      "id" SERIAL PRIMARY KEY,
      "category_id" INTEGER,
      CONSTRAINT "prod_cat_fk" FOREIGN KEY ("category_id") REFERENCES "categories"("id")
    );
  `]);

  const spec = parseMigration(
    'DROP TABLE "categories";',
    'dm16.sql'
  );

  const safety = runSafetyGate(spec, schema);
  printFindings(safety);

  assert(safety.some(f => f.shapeId === 'DM-16'), 'should have DM-16');
  assert(safety.some(f => f.message.includes('products')), 'should mention products as dependent');
  console.log('✓ Test 5');
}

// ---------------------------------------------------------------------------
// Test 6: FK references nonexistent table (DM-03)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 6: FK references nonexistent table ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "orders" ("id" SERIAL PRIMARY KEY);
  `]);

  const spec = parseMigration(
    'ALTER TABLE "orders" ADD CONSTRAINT "fk_customer" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");',
    'dm03.sql'
  );

  const grounding = runGroundingGate(spec, schema);
  printFindings(grounding);

  assert(grounding.some(f => f.shapeId === 'DM-03'), 'should have DM-03');
  assert(grounding.some(f => f.message.includes('customers')), 'should mention missing table');
  console.log('✓ Test 6');
}

// ---------------------------------------------------------------------------
// Test 7: CREATE TABLE that already exists (DM-04)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 7: CREATE TABLE already exists ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "users" ("id" SERIAL PRIMARY KEY);
  `]);

  const spec = parseMigration(
    'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "name" TEXT);',
    'dm04.sql'
  );

  const grounding = runGroundingGate(spec, schema);
  printFindings(grounding);

  assert(grounding.some(f => f.shapeId === 'DM-04'), 'should have DM-04');
  console.log('✓ Test 7');
}

// ---------------------------------------------------------------------------
// Test 8: RENAME source missing (DM-05)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 8: RENAME source missing ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "orders" ("id" SERIAL PRIMARY KEY);
  `]);

  const spec = parseMigration(
    'ALTER TABLE "nonexistent" RENAME TO "new_table";',
    'dm05.sql'
  );

  const grounding = runGroundingGate(spec, schema);
  printFindings(grounding);

  assert(grounding.some(f => f.shapeId === 'DM-05'), 'should have DM-05');
  console.log('✓ Test 8');
}

// ---------------------------------------------------------------------------
// Test 9: Valid migration — no findings
// ---------------------------------------------------------------------------
console.log('\n=== TEST 9: Valid migration — no findings ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);
  `]);

  const spec = parseMigration(
    'ALTER TABLE "users" ADD COLUMN "name" TEXT DEFAULT \'unknown\';',
    'valid.sql'
  );

  const grounding = runGroundingGate(spec, schema);
  const safety = runSafetyGate(spec, schema);

  assert(grounding.length === 0, 'grounding should have no findings');
  assert(safety.length === 0, 'safety should have no findings');
  console.log('  (clean pass)');
  console.log('✓ Test 9');
}

// ---------------------------------------------------------------------------
// Test 10: Ack suppresses finding
// ---------------------------------------------------------------------------
console.log('\n=== TEST 10: Ack suppresses finding ===');
{
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);
  `]);

  const spec = parseMigration(
    `-- verify: ack DM-18 table is empty during migration window
ALTER TABLE "users" ADD COLUMN "name" TEXT NOT NULL;`,
    'acked.sql'
  );

  const safety = runSafetyGate(spec, schema);
  printFindings(safety);

  assert(safety.length > 0, 'should still report finding');
  assert(safety[0]?.severity === 'warning', 'should be downgraded to warning');
  assert(safety[0]?.message.includes('[ACKED]'), 'should be marked as acked');
  console.log('✓ Test 10');
}

// ---------------------------------------------------------------------------
// Test 11: Full fixture 04 — mixed migration against pre-built schema
// ---------------------------------------------------------------------------
console.log('\n=== TEST 11: Golden fixture 04 end-to-end ===');
{
  // Setup matches the schema BEFORE the migration runs:
  // - Availability has "label" (will be dropped) but NOT "scheduleId" (will be added)
  // - Schedule has "freeBusyTimes" and "title" (will be dropped) but NOT "name" (will be added)
  // - users does NOT have "defaultScheduleId" (will be added)
  const schema = buildSchemaFromSQL([`
    CREATE TABLE "Availability" ("id" SERIAL PRIMARY KEY, "label" TEXT);
    CREATE TABLE "Schedule" (
      "id" SERIAL PRIMARY KEY,
      "eventTypeId" INTEGER,
      "freeBusyTimes" TEXT,
      "title" TEXT,
      "userId" INTEGER
    );
    CREATE TABLE "users" ("id" SERIAL PRIMARY KEY);
  `]);

  const sql = readFixture('04_mixed_drop_notnull_fk.sql');
  const spec = parseMigration(sql, '04_mixed_drop_notnull_fk.sql');

  const grounding = runGroundingGate(spec, schema);
  const safety = runSafetyGate(spec, schema);

  console.log(`  Grounding findings: ${grounding.length}`);
  printFindings(grounding);
  console.log(`  Safety findings: ${safety.length}`);
  printFindings(safety);

  // No grounding noise — setup now matches pre-migration state
  assert(grounding.length === 0, 'grounding should be clean (no DM-04 noise)');

  // This migration has ADD COLUMN name NOT NULL without default → DM-18
  assert(safety.some(f => f.shapeId === 'DM-18'), 'should flag DM-18 for Schedule.name NOT NULL');

  // Check location is populated
  const dm18 = safety.find(f => f.shapeId === 'DM-18');
  assert(dm18?.location !== undefined, 'DM-18 finding should have source location');
  assert(dm18?.location?.line !== undefined && dm18.location.line > 0, 'DM-18 should have a positive line number');
  console.log(`  DM-18 location: line ${dm18?.location?.line}`);

  console.log('✓ Test 11');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n\n=== ${passed} assertions passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
