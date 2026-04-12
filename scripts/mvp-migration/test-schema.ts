/**
 * test-schema.ts — Verify schema-loader against golden fixtures.
 *
 * Usage: bun run scripts/mvp-migration/test-schema.ts
 */
import { loadModule } from 'libpg-query';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildSchemaFromSQL, applyMigrationSQL, printSchema, createEmptySchema } from './schema-loader';

await loadModule();

const FIXTURES = join(import.meta.dir, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

// ---------------------------------------------------------------------------
// Test 1: Simple CREATE TABLE
// ---------------------------------------------------------------------------
console.log('\n=== TEST 1: Simple CREATE TABLE ===');
{
  const schema = buildSchemaFromSQL([readFixture('01_create_table_simple.sql')]);
  printSchema(schema);

  const emp = schema.tables.get('employees');
  console.assert(emp !== undefined, 'employees table should exist');
  console.assert(emp!.columns.has('id'), 'id column should exist');
  console.assert(emp!.columns.has('name'), 'name column should exist');
  console.assert(emp!.columns.get('name')!.nullable === false, 'name should be NOT NULL');
  console.assert(emp!.columns.get('email')!.nullable === true, 'email should be nullable');
  console.log('\n✓ Test 1 passed');
}

// ---------------------------------------------------------------------------
// Test 2: ALTER TABLE ADD COLUMN
// ---------------------------------------------------------------------------
console.log('\n=== TEST 2: ALTER TABLE ADD COLUMN ===');
{
  const schema = buildSchemaFromSQL([
    readFixture('01_create_table_simple.sql'),
    readFixture('02_alter_add_column.sql'),
  ]);
  printSchema(schema);

  const emp = schema.tables.get('employees');
  console.assert(emp!.columns.has('department'), 'department column should exist after ALTER');
  console.assert(emp!.columns.get('department')!.hasDefault === true, 'department should have DEFAULT');
  console.log('\n✓ Test 2 passed');
}

// ---------------------------------------------------------------------------
// Test 3: CREATE with FK + partitions
// ---------------------------------------------------------------------------
console.log('\n=== TEST 3: CREATE with FK + partitions ===');
{
  const schema = buildSchemaFromSQL([readFixture('03_create_with_fk_partitions.sql')]);
  printSchema(schema);

  const chatMsgs = schema.tables.get('chat_messages');
  console.assert(chatMsgs!.fkOut.length > 0, 'chat_messages should have outgoing FK');
  console.assert(chatMsgs!.fkOut[0].refTable === 'chats', 'FK should reference chats');

  const chats = schema.tables.get('chats');
  console.assert(chats!.fkIn.length > 0, 'chats should have incoming FK from chat_messages');
  console.log('\n✓ Test 3 passed');
}

// ---------------------------------------------------------------------------
// Test 4: Mixed DROP COLUMN + NOT NULL + ADD FK
// ---------------------------------------------------------------------------
console.log('\n=== TEST 4: Mixed DROP + NOT NULL + FK ===');
{
  // First create the tables the migration references
  const setup = `
    CREATE TABLE "Availability" (
      "id" SERIAL PRIMARY KEY,
      "label" TEXT,
      "scheduleId" INTEGER
    );
    CREATE TABLE "Schedule" (
      "id" SERIAL PRIMARY KEY,
      "eventTypeId" INTEGER,
      "freeBusyTimes" TEXT,
      "title" TEXT,
      "userId" INTEGER
    );
    CREATE TABLE "users" (
      "id" SERIAL PRIMARY KEY,
      "defaultScheduleId" INTEGER
    );
  `;
  const schema = buildSchemaFromSQL([setup, readFixture('04_mixed_drop_notnull_fk.sql')]);
  printSchema(schema);

  const avail = schema.tables.get('availability');
  console.assert(!avail!.columns.has('label'), 'label should be dropped');
  console.assert(avail!.columns.has('scheduleid'), 'scheduleId should exist');
  console.assert(avail!.fkOut.length > 0, 'Availability should have FK to Schedule');

  const sched = schema.tables.get('schedule');
  console.assert(!sched!.columns.has('freebusytimes'), 'freeBusyTimes should be dropped');
  console.assert(!sched!.columns.has('title'), 'title should be dropped');
  console.assert(sched!.columns.has('name'), 'name should exist');
  console.assert(sched!.columns.get('name')!.nullable === false, 'name should be NOT NULL');
  console.assert(sched!.fkIn.length > 0, 'Schedule should have incoming FK from Availability');

  console.log('\n✓ Test 4 passed');
}

// ---------------------------------------------------------------------------
// Test 5: DROP TABLE + recreate with new FKs (the big one)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 5: DROP TABLE + recreate + FK graph ===');
{
  // Setup the tables that fixture 05 references
  const setup = `
    CREATE TABLE "users" ("id" SERIAL PRIMARY KEY);
    CREATE TABLE "Team" ("id" SERIAL PRIMARY KEY);
    CREATE TABLE "platform_oauth_clients" (
      "id" TEXT PRIMARY KEY,
      "organization_id" INTEGER,
      CONSTRAINT "platform_oauth_clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Team"("id")
    );
    CREATE TABLE "platform_authorization_token" (
      "id" TEXT PRIMARY KEY,
      "user_id" INTEGER,
      "platform_oauth_client_id" TEXT,
      CONSTRAINT "platform_authorization_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
      CONSTRAINT "platform_authorization_token_platform_oauth_client_id_fkey" FOREIGN KEY ("platform_oauth_client_id") REFERENCES "platform_oauth_clients"("id")
    );
    CREATE TABLE "platform_access_tokens" (
      "id" SERIAL PRIMARY KEY,
      "user_id" INTEGER,
      "platform_oauth_client_id" TEXT,
      CONSTRAINT "platform_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
      CONSTRAINT "platform_access_tokens_platform_oauth_client_id_fkey" FOREIGN KEY ("platform_oauth_client_id") REFERENCES "platform_oauth_clients"("id")
    );
    CREATE TABLE "platform_refresh_token" (
      "id" SERIAL PRIMARY KEY,
      "user_id" INTEGER,
      "platform_oauth_client_id" TEXT,
      CONSTRAINT "platform_refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
      CONSTRAINT "platform_refresh_token_platform_oauth_client_id_fkey" FOREIGN KEY ("platform_oauth_client_id") REFERENCES "platform_oauth_clients"("id")
    );
    CREATE TABLE "_PlatformOAuthClientToUser" (
      "A" TEXT NOT NULL,
      "B" INTEGER NOT NULL,
      CONSTRAINT "_PlatformOAuthClientToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "platform_oauth_clients"("id")
    );
  `;

  const schema = buildSchemaFromSQL([setup]);
  console.log('--- BEFORE migration ---');
  console.log('Tables:', [...schema.tables.keys()].join(', '));
  const teamBefore = schema.tables.get('team');
  console.log('Team fkIn count before:', teamBefore?.fkIn.length);

  applyMigrationSQL(schema, readFixture('05_drop_table_recreate_fk.sql'));
  console.log('\n--- AFTER migration ---');
  printSchema(schema);

  // Old tables should be gone
  console.assert(!schema.tables.has('platform_oauth_clients'), 'old platform_oauth_clients should be dropped');
  console.assert(!schema.tables.has('platform_access_tokens'), 'old platform_access_tokens should be dropped');
  // New tables should exist
  console.assert(schema.tables.has('platformoauthclient'), 'PlatformOAuthClient should exist');
  console.assert(schema.tables.has('accesstoken'), 'AccessToken should exist');
  console.assert(schema.tables.has('refreshtoken'), 'RefreshToken should exist');

  // Check FK graph integrity
  const oauth = schema.tables.get('platformoauthclient');
  console.assert(oauth!.fkOut.length > 0, 'PlatformOAuthClient should have FK to Team');
  console.assert(oauth!.fkIn.length > 0, 'PlatformOAuthClient should have incoming FKs');

  const team = schema.tables.get('team');
  console.assert(team!.fkIn.length > 0, 'Team should have incoming FK from PlatformOAuthClient');

  const users = schema.tables.get('users');
  console.assert(users!.fkIn.length >= 3, 'users should have ≥3 incoming FKs (AuthToken, Access, Refresh)');
  console.log(`users fkIn count: ${users!.fkIn.length}`);

  console.log('\n✓ Test 5 passed');
}

// ---------------------------------------------------------------------------
// Test 6: RENAME COLUMN
// ---------------------------------------------------------------------------
console.log('\n=== TEST 6: RENAME COLUMN ===');
{
  const setup = `
    CREATE TABLE "EventTypeCustomInput" (
      "id" SERIAL PRIMARY KEY,
      "type" TEXT NOT NULL
    );
  `;
  const schema = buildSchemaFromSQL([setup, readFixture('06_rename_column_alter_type.sql')]);
  printSchema(schema);

  const table = schema.tables.get('eventtypecustominput');
  console.assert(!table!.columns.has('type_old'), 'type_old should have been dropped');
  console.assert(table!.columns.has('type'), 'type should exist');
  console.log('\n✓ Test 6 passed');
}

// ---------------------------------------------------------------------------
// Test 7: Enum type swap (fixture 07)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 7: Enum type swap ===');
{
  const setup = `
    CREATE TABLE "Survey" (
      "id" SERIAL PRIMARY KEY,
      "status" TEXT NOT NULL DEFAULT 'draft'
    );
  `;
  const schema = buildSchemaFromSQL([setup, readFixture('07_enum_type_swap.sql')]);
  printSchema(schema);

  const survey = schema.tables.get('survey');
  console.assert(survey !== undefined, 'Survey table should exist');
  console.assert(survey!.columns.has('status'), 'status column should exist');
  // After the enum swap, the column type changes and default is re-set
  console.assert(survey!.columns.get('status')!.hasDefault === true, 'status should have DEFAULT after swap');
  console.log('\n✓ Test 7 passed');
}

// ---------------------------------------------------------------------------
// Test 8: RENAME TABLE
// ---------------------------------------------------------------------------
console.log('\n=== TEST 8: RENAME TABLE ===');
{
  const setup = `
    CREATE TABLE "old_users" ("id" SERIAL PRIMARY KEY, "name" TEXT);
    CREATE TABLE "profiles" (
      "id" SERIAL PRIMARY KEY,
      "user_id" INTEGER,
      CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "old_users"("id")
    );
  `;
  const schema = buildSchemaFromSQL([setup]);

  // Verify FK graph before rename
  const oldUsers = schema.tables.get('old_users');
  console.assert(oldUsers!.fkIn.length === 1, 'old_users should have 1 fkIn before rename');

  // Apply rename
  applyMigrationSQL(schema, 'ALTER TABLE "old_users" RENAME TO "new_users";');
  printSchema(schema);

  console.assert(!schema.tables.has('old_users'), 'old_users should not exist after rename');
  console.assert(schema.tables.has('new_users'), 'new_users should exist after rename');

  // FK graph should be updated
  const newUsers = schema.tables.get('new_users');
  console.assert(newUsers!.fkIn.length === 1, 'new_users should have 1 fkIn after rename');

  const profiles = schema.tables.get('profiles');
  console.assert(profiles!.fkOut[0].refTable === 'new_users', 'profiles FK should point to new_users');

  console.log('\n✓ Test 8 passed');
}

// ---------------------------------------------------------------------------
// Test 9: ALTER COLUMN TYPE assertion
// ---------------------------------------------------------------------------
console.log('\n=== TEST 9: ALTER COLUMN TYPE ===');
{
  const setup = `CREATE TABLE "items" ("id" SERIAL PRIMARY KEY, "price" INTEGER NOT NULL);`;
  const schema = buildSchemaFromSQL([setup]);

  console.assert(schema.tables.get('items')!.columns.get('price')!.type === 'int4', 'price should be int4 before alter');

  applyMigrationSQL(schema, 'ALTER TABLE "items" ALTER COLUMN "price" TYPE NUMERIC(10,2);');

  const priceType = schema.tables.get('items')!.columns.get('price')!.type;
  console.log(`  price type after alter: ${priceType}`);
  console.assert(priceType === 'numeric', 'price should be numeric after alter');
  console.log('\n✓ Test 9 passed');
}

// ---------------------------------------------------------------------------
// Test 10: DROP COLUMN cleans up stale fkIn (regression for bug #1)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 10: DROP COLUMN cleans fkIn on referenced table ===');
{
  const setup = `
    CREATE TABLE "departments" ("id" SERIAL PRIMARY KEY, "name" TEXT);
    CREATE TABLE "employees" (
      "id" SERIAL PRIMARY KEY,
      "dept_id" INTEGER,
      CONSTRAINT "emp_dept_fkey" FOREIGN KEY ("dept_id") REFERENCES "departments"("id")
    );
  `;
  const schema = buildSchemaFromSQL([setup]);

  // Before drop: departments should have 1 fkIn
  console.assert(schema.tables.get('departments')!.fkIn.length === 1, 'departments should have 1 fkIn before drop');

  // Drop the FK column
  applyMigrationSQL(schema, 'ALTER TABLE "employees" DROP COLUMN "dept_id";');

  // After drop: departments.fkIn should be empty
  const deptFkIn = schema.tables.get('departments')!.fkIn;
  console.log(`  departments.fkIn after drop: ${deptFkIn.length}`);
  console.assert(deptFkIn.length === 0, 'departments.fkIn should be 0 after dropping dept_id');

  // employees.fkOut should also be empty
  const empFkOut = schema.tables.get('employees')!.fkOut;
  console.assert(empFkOut.length === 0, 'employees.fkOut should be 0 after dropping dept_id');

  console.log('\n✓ Test 10 passed');
}

// ---------------------------------------------------------------------------
// Test 11: RENAME COLUMN updates fkIn (regression for bug #2)
// ---------------------------------------------------------------------------
console.log('\n=== TEST 11: RENAME COLUMN updates fkIn ===');
{
  const setup = `
    CREATE TABLE "teams" ("id" SERIAL PRIMARY KEY);
    CREATE TABLE "members" (
      "id" SERIAL PRIMARY KEY,
      "team_id" INTEGER,
      CONSTRAINT "members_team_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    );
  `;
  const schema = buildSchemaFromSQL([setup]);

  // Rename the FK column
  applyMigrationSQL(schema, 'ALTER TABLE "members" RENAME COLUMN "team_id" TO "group_id";');

  // fkOut on members should use new name
  const membersFk = schema.tables.get('members')!.fkOut[0];
  console.log(`  members.fkOut columns: ${membersFk.columns}`);
  console.assert(membersFk.columns[0] === 'group_id', 'members.fkOut should use group_id');

  // fkIn on teams should also use new name
  const teamsFkIn = schema.tables.get('teams')!.fkIn[0];
  console.log(`  teams.fkIn fromColumns: ${teamsFkIn.fromColumns}`);
  console.assert(teamsFkIn.fromColumns[0] === 'group_id', 'teams.fkIn.fromColumns should use group_id');

  console.log('\n✓ Test 11 passed');
}

console.log('\n\n=== ALL TESTS PASSED ===');
