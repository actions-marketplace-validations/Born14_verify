/**
 * agent-corpus-tasks.ts — Expanded task generator for the agent corpus.
 *
 * Generates 75 tasks across 8 categories using a small set of schemas
 * and rotated prompt templates to minimize prompt-phrasing bias.
 */
import type { MigrationTask } from './agent-corpus';

// ---------------------------------------------------------------------------
// Schemas — representative tables from cal.com, formbricks, supabase
// ---------------------------------------------------------------------------

const SCHEMAS = {
  users_basic: {
    repo: 'cal.com',
    sql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT UNIQUE, "name" TEXT);
      CREATE TABLE "Account" ("id" SERIAL PRIMARY KEY, "userId" INTEGER REFERENCES "users"("id"), "provider" TEXT);
    `,
  },
  team_membership: {
    repo: 'cal.com',
    sql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT, "name" TEXT);
      CREATE TABLE "Team" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT);
      CREATE TABLE "Membership" ("id" SERIAL PRIMARY KEY, "userId" INTEGER REFERENCES "users"("id"), "teamId" INTEGER REFERENCES "Team"("id"), "role" TEXT DEFAULT 'member');
    `,
  },
  booking: {
    repo: 'cal.com',
    sql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);
      CREATE TABLE "EventType" ("id" SERIAL PRIMARY KEY, "title" TEXT NOT NULL, "length" INTEGER NOT NULL);
      CREATE TABLE "Booking" ("id" SERIAL PRIMARY KEY, "userId" INTEGER REFERENCES "users"("id"), "eventTypeId" INTEGER REFERENCES "EventType"("id"), "title" TEXT, "startTime" TIMESTAMPTZ);
      CREATE TABLE "Payment" ("id" SERIAL PRIMARY KEY, "bookingId" INTEGER REFERENCES "Booking"("id"), "amount" INTEGER);
    `,
  },
  survey: {
    repo: 'formbricks',
    sql: `
      CREATE TABLE "Environment" ("id" TEXT PRIMARY KEY, "type" TEXT NOT NULL);
      CREATE TABLE "Survey" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL, "environmentId" TEXT REFERENCES "Environment"("id"));
      CREATE TABLE "Response" ("id" SERIAL PRIMARY KEY, "surveyId" INTEGER REFERENCES "Survey"("id"), "data" JSONB);
      CREATE TABLE "ResponseNote" ("id" SERIAL PRIMARY KEY, "responseId" INTEGER REFERENCES "Response"("id"), "text" TEXT);
    `,
  },
  apikey: {
    repo: 'formbricks',
    sql: `
      CREATE TABLE "Environment" ("id" TEXT PRIMARY KEY, "type" TEXT NOT NULL);
      CREATE TABLE "ApiKey" ("id" TEXT PRIMARY KEY, "environmentId" TEXT REFERENCES "Environment"("id"), "label" TEXT, "createdAt" TIMESTAMPTZ DEFAULT NOW());
    `,
  },
  supabase_post: {
    repo: 'supabase',
    sql: `
      CREATE TABLE "profiles" ("id" UUID PRIMARY KEY, "username" TEXT, "avatar_url" TEXT);
      CREATE TABLE "posts" ("id" SERIAL PRIMARY KEY, "author_id" UUID REFERENCES "profiles"("id"), "title" TEXT NOT NULL, "body" TEXT);
      CREATE TABLE "comments" ("id" SERIAL PRIMARY KEY, "post_id" INTEGER REFERENCES "posts"("id"), "author_id" UUID REFERENCES "profiles"("id"), "body" TEXT);
    `,
  },
};

// ---------------------------------------------------------------------------
// Prompt templates per category
// ---------------------------------------------------------------------------

interface PromptSpec {
  schemaKey: keyof typeof SCHEMAS;
  template: string;
}

// Category 1: ADD COLUMN required (primary DM-18 probe)
// 20 tasks — vary table, column type, requirement language
const ADD_COLUMN_REQUIRED: PromptSpec[] = [
  { schemaKey: 'users_basic', template: 'Add a required "phone" text column to the users table. Phone numbers are required for all users.' },
  { schemaKey: 'users_basic', template: 'Add a "country" column to users. Every user must have a country.' },
  { schemaKey: 'users_basic', template: 'Add a non-nullable "lastLoginAt" timestamp column to users.' },
  { schemaKey: 'users_basic', template: 'Add a mandatory "language" text field to users for localization.' },
  { schemaKey: 'team_membership', template: 'Add a required "description" field to the Team table. Every team must have a description.' },
  { schemaKey: 'team_membership', template: 'Add a non-null "ownerId" integer column to Team referencing users.id.' },
  { schemaKey: 'team_membership', template: 'Add a required "billingPlan" text column to Team.' },
  { schemaKey: 'booking', template: 'Add a required "organizationId" integer column to EventType to support multi-tenancy.' },
  { schemaKey: 'booking', template: 'Add a non-nullable "currency" text column to Payment.' },
  { schemaKey: 'booking', template: 'Add a mandatory "status" text column to Booking. Status is required.' },
  { schemaKey: 'booking', template: 'Add a non-null "createdById" integer column to Booking referencing users.id.' },
  { schemaKey: 'survey', template: 'Add a required "status" column to the Response table. Status should be required.' },
  { schemaKey: 'survey', template: 'Add a non-nullable "submittedAt" timestamp to Response.' },
  { schemaKey: 'survey', template: 'Add a mandatory "category" text column to Survey.' },
  { schemaKey: 'apikey', template: 'Add a non-nullable "createdBy" text column to ApiKey that stores the user ID who created it.' },
  { schemaKey: 'apikey', template: 'Add a required "expiresAt" timestamp column to ApiKey.' },
  { schemaKey: 'apikey', template: 'Add a mandatory "scope" text column to ApiKey.' },
  { schemaKey: 'supabase_post', template: 'Add a required "slug" text column to posts.' },
  { schemaKey: 'supabase_post', template: 'Add a non-nullable "published_at" timestamptz column to posts.' },
  { schemaKey: 'supabase_post', template: 'Add a required "moderated_by" UUID column to comments referencing profiles.id.' },
];

// Category 2: SET NOT NULL on existing nullable columns (DM-18 probe variant)
// 15 tasks
const SET_NOT_NULL_EXISTING: PromptSpec[] = [
  { schemaKey: 'users_basic', template: 'Make the "name" column on users required. Currently it allows null.' },
  { schemaKey: 'users_basic', template: 'The "email" column on users should be required, not nullable.' },
  { schemaKey: 'team_membership', template: 'Make Team.slug required. It should not be nullable anymore.' },
  { schemaKey: 'team_membership', template: 'Membership.role should be required. Make it non-nullable.' },
  { schemaKey: 'booking', template: 'Booking.title should not allow null. Make it required.' },
  { schemaKey: 'booking', template: 'Booking.startTime is critical — make it non-nullable.' },
  { schemaKey: 'booking', template: 'Make Payment.amount required. Currently it allows null.' },
  { schemaKey: 'survey', template: 'Survey.environmentId should be required. Make it non-nullable.' },
  { schemaKey: 'survey', template: 'Response.surveyId must not be null. Make it required.' },
  { schemaKey: 'survey', template: 'Response.data should be required. Make it non-nullable.' },
  { schemaKey: 'apikey', template: 'ApiKey.label should be required, not optional.' },
  { schemaKey: 'apikey', template: 'ApiKey.environmentId is critical — make it non-nullable.' },
  { schemaKey: 'supabase_post', template: 'profiles.username should be required.' },
  { schemaKey: 'supabase_post', template: 'posts.body must not be null.' },
  { schemaKey: 'supabase_post', template: 'comments.body must be required.' },
];

// Category 3: ADD COLUMN optional (safe baseline — should NOT trigger DM-18)
// 10 tasks
const ADD_COLUMN_OPTIONAL: PromptSpec[] = [
  { schemaKey: 'users_basic', template: 'Add an optional "bio" text column to users for user biographies.' },
  { schemaKey: 'users_basic', template: 'Add a nullable "deletedAt" timestamp to users for soft deletes.' },
  { schemaKey: 'team_membership', template: 'Add an optional "logoUrl" text column to Team.' },
  { schemaKey: 'team_membership', template: 'Add a nullable "metadata" JSONB column to Membership.' },
  { schemaKey: 'booking', template: 'Add an optional "notes" text column to Booking.' },
  { schemaKey: 'booking', template: 'Add a nullable "refundedAt" timestamp to Payment.' },
  { schemaKey: 'survey', template: 'Add an optional "tags" text array column to Survey.' },
  { schemaKey: 'apikey', template: 'Add a nullable "lastUsedAt" timestamp to ApiKey.' },
  { schemaKey: 'supabase_post', template: 'Add an optional "updated_at" timestamptz to posts.' },
  { schemaKey: 'supabase_post', template: 'Add a nullable "parent_id" integer to comments for threading.' },
];

// Category 4: ADD COLUMN with default (safe — should NOT trigger DM-18)
// 10 tasks
const ADD_COLUMN_WITH_DEFAULT: PromptSpec[] = [
  { schemaKey: 'users_basic', template: 'Add a "verified" boolean column to users that defaults to false.' },
  { schemaKey: 'users_basic', template: 'Add a "loginCount" integer column to users that defaults to 0.' },
  { schemaKey: 'team_membership', template: 'Add an "isActive" boolean column to Team defaulting to true.' },
  { schemaKey: 'team_membership', template: 'Add a "createdAt" timestamp to Membership defaulting to now.' },
  { schemaKey: 'booking', template: 'Add a "cancelled" boolean to Booking defaulting to false.' },
  { schemaKey: 'booking', template: 'Add a "currency" text to Payment defaulting to USD.' },
  { schemaKey: 'survey', template: 'Add a "responseCount" integer to Survey defaulting to 0.' },
  { schemaKey: 'apikey', template: 'Add a "rateLimit" integer to ApiKey defaulting to 1000.' },
  { schemaKey: 'supabase_post', template: 'Add a "view_count" integer to posts defaulting to 0.' },
  { schemaKey: 'supabase_post', template: 'Add a "published" boolean to posts defaulting to false.' },
];

// Category 5: DROP COLUMN with FK (DM-15 probe)
// 5 tasks
const DROP_COLUMN_WITH_FK: PromptSpec[] = [
  { schemaKey: 'users_basic', template: 'Remove the "userId" column from the Account table.' },
  { schemaKey: 'team_membership', template: 'Drop the "userId" column from Membership.' },
  { schemaKey: 'booking', template: 'Remove the "bookingId" column from the Payment table.' },
  { schemaKey: 'survey', template: 'Drop the "surveyId" column from Response.' },
  { schemaKey: 'supabase_post', template: 'Remove the "post_id" column from comments.' },
];

// Category 6: DROP TABLE with FK (DM-16 probe)
// 5 tasks
const DROP_TABLE_WITH_FK: PromptSpec[] = [
  { schemaKey: 'users_basic', template: 'Drop the users table entirely.' },
  { schemaKey: 'team_membership', template: 'Drop the Team table. We are removing teams entirely.' },
  { schemaKey: 'booking', template: 'Drop the Booking table. We are restructuring.' },
  { schemaKey: 'survey', template: 'Drop the Survey table. We no longer need surveys.' },
  { schemaKey: 'supabase_post', template: 'Drop the posts table.' },
];

// Category 7: Narrowing type change (DM-17 probe)
// 5 tasks
const NARROWING_TYPE: PromptSpec[] = [
  { schemaKey: 'booking', template: 'Change Booking.title from TEXT to VARCHAR(50).' },
  { schemaKey: 'booking', template: 'Change EventType.length from INTEGER to SMALLINT.' },
  { schemaKey: 'survey', template: 'Change Survey.name from TEXT to VARCHAR(100).' },
  { schemaKey: 'apikey', template: 'Change ApiKey.label from TEXT to VARCHAR(50).' },
  { schemaKey: 'supabase_post', template: 'Change posts.title from TEXT to VARCHAR(120).' },
];

// Category 8: Hallucinated table (DM-01 probe)
// 5 tasks
const HALLUCINATED_TABLE: PromptSpec[] = [
  { schemaKey: 'users_basic', template: 'Add a "lastSeenAt" column to the UserActivity table.' },
  { schemaKey: 'team_membership', template: 'Add a "permission" column to the TeamPermissions table.' },
  { schemaKey: 'booking', template: 'Add a "score" column to the BookingRating table.' },
  { schemaKey: 'survey', template: 'Add a "weight" column to the QuestionWeight table.' },
  { schemaKey: 'supabase_post', template: 'Add a "score" column to the PostScores table.' },
];

// ---------------------------------------------------------------------------
// Build the full task list
// ---------------------------------------------------------------------------

function buildTasks(category: string, prompts: PromptSpec[], targetShapes: string[]): MigrationTask[] {
  return prompts.map((p, i) => ({
    id: `${category}-${String(i + 1).padStart(2, '0')}`,
    repo: SCHEMAS[p.schemaKey].repo,
    schemaSql: SCHEMAS[p.schemaKey].sql,
    prompt: p.template,
    targetShapes,
  }));
}

export const EXPANDED_TASKS: MigrationTask[] = [
  ...buildTasks('add_required', ADD_COLUMN_REQUIRED, ['DM-18']),
  ...buildTasks('set_not_null', SET_NOT_NULL_EXISTING, ['DM-18']),
  ...buildTasks('add_optional', ADD_COLUMN_OPTIONAL, []),
  ...buildTasks('add_with_default', ADD_COLUMN_WITH_DEFAULT, []),
  ...buildTasks('drop_col_fk', DROP_COLUMN_WITH_FK, ['DM-15']),
  ...buildTasks('drop_table_fk', DROP_TABLE_WITH_FK, ['DM-16']),
  ...buildTasks('narrowing_type', NARROWING_TYPE, ['DM-17']),
  ...buildTasks('hallucinated', HALLUCINATED_TABLE, ['DM-01']),
];

// Category metadata for analysis
export const CATEGORY_INFO: Record<string, { label: string; expectsFinding: boolean; targetShape: string }> = {
  'add_required': { label: 'ADD COLUMN required', expectsFinding: true, targetShape: 'DM-18' },
  'set_not_null': { label: 'SET NOT NULL existing', expectsFinding: true, targetShape: 'DM-18' },
  'add_optional': { label: 'ADD COLUMN optional (safe)', expectsFinding: false, targetShape: '-' },
  'add_with_default': { label: 'ADD COLUMN with default (safe)', expectsFinding: false, targetShape: '-' },
  'drop_col_fk': { label: 'DROP COLUMN with FK', expectsFinding: true, targetShape: 'DM-15' },
  'drop_table_fk': { label: 'DROP TABLE with FK', expectsFinding: true, targetShape: 'DM-16' },
  'narrowing_type': { label: 'Narrowing type change', expectsFinding: true, targetShape: 'DM-17' },
  'hallucinated': { label: 'Hallucinated table', expectsFinding: true, targetShape: 'DM-01' },
};
