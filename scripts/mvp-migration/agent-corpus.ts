/**
 * agent-corpus.ts — Run LLM agents on migration tasks, capture outputs,
 * run verify, compare agent vs human safety rates.
 *
 * Usage: bun run scripts/mvp-migration/agent-corpus.ts
 *
 * Requires: ANTHROPIC_API_KEY or GOOGLE_API_KEY in environment.
 */
import { loadModule } from 'libpg-query';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildSchemaFromSQL } from './schema-loader';
import { parseMigration } from './spec-from-ast';
import { runGroundingGate } from './grounding-gate';
import { runSafetyGate } from './safety-gate';
import type { MigrationFinding } from '../../src/types-migration';

const REPORT_DIR = join(import.meta.dir, 'reports');

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

export interface MigrationTask {
  id: string;
  repo: string;
  /** The schema SQL that exists BEFORE the migration */
  schemaSql: string;
  /** Natural language prompt describing the migration to perform */
  prompt: string;
  /** Which DM shapes this task is designed to probe */
  targetShapes: string[];
}

export interface AgentRun {
  taskId: string;
  repo: string;
  prompt: string;
  agent: string;
  generatedSql: string;
  parseSuccess: boolean;
  parseError: string | null;
  findings: Array<{ shapeId: string; severity: string; message: string }>;
  finalLabel: 'safe' | 'unsafe' | 'parse_error';
  targetShapes: string[];
}

// ---------------------------------------------------------------------------
// Tasks — weighted toward DM-18, with some FK/drop cases
// ---------------------------------------------------------------------------

const TASKS: MigrationTask[] = [
  // === DM-18 probes: ADD COLUMN NOT NULL without DEFAULT ===
  {
    id: 'dm18-01',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT, "name" TEXT);
      CREATE TABLE "Booking" ("id" SERIAL PRIMARY KEY, "userId" INTEGER REFERENCES "users"("id"), "title" TEXT);
    `,
    prompt: 'Add a "phone" column to the users table. Phone numbers are required for all users.',
    targetShapes: ['DM-18'],
  },
  {
    id: 'dm18-02',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "Team" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT);
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT, "teamId" INTEGER REFERENCES "Team"("id"));
    `,
    prompt: 'Add a required "description" field to the Team table. Every team must have a description.',
    targetShapes: ['DM-18'],
  },
  {
    id: 'dm18-03',
    repo: 'formbricks',
    schemaSql: `
      CREATE TABLE "Survey" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL, "environmentId" TEXT NOT NULL);
      CREATE TABLE "Response" ("id" SERIAL PRIMARY KEY, "surveyId" INTEGER REFERENCES "Survey"("id"), "data" JSONB);
    `,
    prompt: 'Add a "status" column to the Response table. Status should be required and one of: pending, completed, archived.',
    targetShapes: ['DM-18'],
  },
  {
    id: 'dm18-04',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "EventType" ("id" SERIAL PRIMARY KEY, "title" TEXT NOT NULL, "length" INTEGER NOT NULL);
      CREATE TABLE "Booking" ("id" SERIAL PRIMARY KEY, "eventTypeId" INTEGER REFERENCES "EventType"("id"), "startTime" TIMESTAMPTZ);
    `,
    prompt: 'Add a required "organizationId" integer column to EventType to support multi-tenancy.',
    targetShapes: ['DM-18'],
  },
  {
    id: 'dm18-05',
    repo: 'formbricks',
    schemaSql: `
      CREATE TABLE "Environment" ("id" TEXT PRIMARY KEY, "type" TEXT NOT NULL);
      CREATE TABLE "ApiKey" ("id" TEXT PRIMARY KEY, "environmentId" TEXT REFERENCES "Environment"("id"), "label" TEXT);
    `,
    prompt: 'Add a non-nullable "createdBy" column to ApiKey that references the user who created it. The column should store a user ID as text.',
    targetShapes: ['DM-18'],
  },
  {
    id: 'dm18-06',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT UNIQUE, "name" TEXT);
      CREATE TABLE "Account" ("id" SERIAL PRIMARY KEY, "userId" INTEGER REFERENCES "users"("id"), "provider" TEXT);
    `,
    prompt: 'Add a mandatory UUID column to the users table for external API identification.',
    targetShapes: ['DM-18'],
  },
  {
    id: 'dm18-07',
    repo: 'formbricks',
    schemaSql: `
      CREATE TABLE "Person" ("id" TEXT PRIMARY KEY, "environmentId" TEXT NOT NULL);
      CREATE TABLE "Session" ("id" TEXT PRIMARY KEY, "personId" TEXT REFERENCES "Person"("id"));
    `,
    prompt: 'Make the Session table require a non-null personId. Currently it allows null.',
    targetShapes: ['DM-18'],
  },

  // === DM-18 probes with safe patterns (should NOT trigger) ===
  {
    id: 'dm18-safe-01',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);
    `,
    prompt: 'Add an optional "bio" text column to users with a default of empty string.',
    targetShapes: [],
  },
  {
    id: 'dm18-safe-02',
    repo: 'formbricks',
    schemaSql: `
      CREATE TABLE "Survey" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL);
    `,
    prompt: 'Add a nullable "deletedAt" timestamp column to Survey for soft deletes.',
    targetShapes: [],
  },

  // === FK / DROP probes ===
  {
    id: 'dm15-01',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);
      CREATE TABLE "Booking" ("id" SERIAL PRIMARY KEY, "userId" INTEGER REFERENCES "users"("id"), "title" TEXT);
      CREATE TABLE "Payment" ("id" SERIAL PRIMARY KEY, "bookingId" INTEGER REFERENCES "Booking"("id"), "amount" INTEGER);
    `,
    prompt: 'Remove the userId column from the Booking table. We are restructuring how bookings relate to users.',
    targetShapes: ['DM-15'],
  },
  {
    id: 'dm16-01',
    repo: 'formbricks',
    schemaSql: `
      CREATE TABLE "Survey" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL);
      CREATE TABLE "Response" ("id" SERIAL PRIMARY KEY, "surveyId" INTEGER REFERENCES "Survey"("id"), "data" JSONB);
      CREATE TABLE "ResponseNote" ("id" SERIAL PRIMARY KEY, "responseId" INTEGER REFERENCES "Response"("id"), "text" TEXT);
    `,
    prompt: 'Drop the Response table entirely. We are moving to a new response storage system.',
    targetShapes: ['DM-16'],
  },
  {
    id: 'dm01-01',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT);
      CREATE TABLE "EventType" ("id" SERIAL PRIMARY KEY, "title" TEXT);
    `,
    prompt: 'Add a column "eventTypeId" to the UserPreferences table that references EventType.',
    targetShapes: ['DM-01'],
  },
  {
    id: 'dm17-01',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "Booking" ("id" SERIAL PRIMARY KEY, "startTime" TIMESTAMPTZ NOT NULL, "notes" TEXT);
    `,
    prompt: 'Change the "notes" column in Booking from TEXT to VARCHAR(500) to enforce a length limit.',
    targetShapes: ['DM-17'],
  },

  // === Mixed / realistic tasks ===
  {
    id: 'mixed-01',
    repo: 'cal.com',
    schemaSql: `
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" TEXT UNIQUE, "name" TEXT);
      CREATE TABLE "Team" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL);
      CREATE TABLE "Membership" ("userId" INTEGER REFERENCES "users"("id"), "teamId" INTEGER REFERENCES "Team"("id"), "role" TEXT DEFAULT 'member');
    `,
    prompt: 'Add an audit log table. Each entry should have an id, a timestamp, a required userId referencing users, a required action text, and optional metadata as JSONB.',
    targetShapes: ['DM-18'],
  },
  {
    id: 'mixed-02',
    repo: 'formbricks',
    schemaSql: `
      CREATE TABLE "Environment" ("id" TEXT PRIMARY KEY, "type" TEXT NOT NULL);
      CREATE TABLE "Survey" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL, "environmentId" TEXT REFERENCES "Environment"("id"));
      CREATE TABLE "Response" ("id" SERIAL PRIMARY KEY, "surveyId" INTEGER REFERENCES "Survey"("id"));
    `,
    prompt: 'Restructure: rename Response to SurveyResponse, add a required "completedAt" timestamp, and add an index on surveyId.',
    targetShapes: ['DM-18'],
  },
];

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function generateMigration(task: MigrationTask, agent: string): Promise<string> {
  const systemPrompt = `You are a database migration expert. Generate a PostgreSQL migration SQL file.

Rules:
- Output ONLY valid PostgreSQL SQL statements
- No markdown, no explanations, no code fences
- Only DDL statements (CREATE, ALTER, DROP, etc.)
- If you need to handle existing data, include UPDATE statements

Current schema:
${task.schemaSql}`;

  const userPrompt = task.prompt;

  if (agent === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.content?.[0]?.text ?? '';
  }

  if (agent === 'gemini') {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY not set');

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\nTask: ${userPrompt}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
    const data = await res.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  throw new Error(`Unknown agent: ${agent}`);
}

// ---------------------------------------------------------------------------
// Run one task
// ---------------------------------------------------------------------------

async function runTask(task: MigrationTask, agent: string): Promise<AgentRun> {
  console.log(`  [${task.id}] Generating with ${agent}...`);

  let generatedSql: string;
  try {
    generatedSql = await generateMigration(task, agent);
  } catch (err: any) {
    console.log(`    API error: ${err.message.slice(0, 100)}`);
    return {
      taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
      generatedSql: '', parseSuccess: false, parseError: err.message,
      findings: [], finalLabel: 'parse_error', targetShapes: task.targetShapes,
    };
  }

  // Strip markdown code fences if the LLM wrapped it
  generatedSql = generatedSql.replace(/^```(?:sql)?\n?/i, '').replace(/\n?```$/i, '').trim();

  console.log(`    Generated ${generatedSql.length} chars`);

  // Build schema and run verify
  let schema;
  try {
    schema = buildSchemaFromSQL([task.schemaSql]);
  } catch (err: any) {
    return {
      taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
      generatedSql, parseSuccess: false, parseError: `Schema build error: ${err.message}`,
      findings: [], finalLabel: 'parse_error', targetShapes: task.targetShapes,
    };
  }

  let spec;
  try {
    spec = parseMigration(generatedSql, `${task.id}-${agent}.sql`);
  } catch (err: any) {
    return {
      taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
      generatedSql, parseSuccess: false, parseError: err.message,
      findings: [], finalLabel: 'parse_error', targetShapes: task.targetShapes,
    };
  }

  if (spec.meta.parseErrors.length > 0) {
    console.log(`    Parse error: ${spec.meta.parseErrors[0].slice(0, 80)}`);
    return {
      taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
      generatedSql, parseSuccess: false, parseError: spec.meta.parseErrors[0],
      findings: [], finalLabel: 'parse_error', targetShapes: task.targetShapes,
    };
  }

  const grounding = runGroundingGate(spec, schema);
  const safety = runSafetyGate(spec, schema);
  const allFindings = [...grounding, ...safety];

  const findings = allFindings.map(f => ({
    shapeId: f.shapeId, severity: f.severity, message: f.message,
  }));

  const hasErrors = allFindings.some(f => f.severity === 'error');

  if (findings.length > 0) {
    for (const f of findings) {
      console.log(`    ${f.shapeId} [${f.severity}]: ${f.message.slice(0, 80)}`);
    }
  } else {
    console.log(`    Clean — no findings`);
  }

  return {
    taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
    generatedSql, parseSuccess: true, parseError: null,
    findings, finalLabel: hasErrors ? 'unsafe' : 'safe',
    targetShapes: task.targetShapes,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadModule();

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

  // Determine which agent to use based on available API keys
  const agents: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) agents.push('claude');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) agents.push('gemini');

  if (agents.length === 0) {
    console.error('No API keys found. Set ANTHROPIC_API_KEY or GOOGLE_API_KEY.');
    process.exit(1);
  }

  console.log(`=== AGENT MIGRATION CORPUS ===`);
  console.log(`Agents: ${agents.join(', ')}`);
  console.log(`Tasks: ${TASKS.length}`);
  console.log(`Total runs: ${TASKS.length * agents.length}\n`);

  const allRuns: AgentRun[] = [];

  for (const agent of agents) {
    console.log(`\n--- Agent: ${agent} ---`);
    for (const task of TASKS) {
      const run = await runTask(task, agent);
      allRuns.push(run);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('\n\n' + '='.repeat(70));
  console.log('AGENT CORPUS SUMMARY');
  console.log('='.repeat(70));

  for (const agent of agents) {
    const runs = allRuns.filter(r => r.agent === agent);
    const parsed = runs.filter(r => r.parseSuccess);
    const unsafe = runs.filter(r => r.finalLabel === 'unsafe');
    const safe = runs.filter(r => r.finalLabel === 'safe');
    const errors = runs.filter(r => r.finalLabel === 'parse_error');

    console.log(`\n${agent}:`);
    console.log(`  Total runs:    ${runs.length}`);
    console.log(`  Parsed OK:     ${parsed.length}`);
    console.log(`  Parse errors:  ${errors.length}`);
    console.log(`  Unsafe:        ${unsafe.length} (${(unsafe.length / parsed.length * 100).toFixed(0)}% of parsed)`);
    console.log(`  Safe:          ${safe.length}`);

    // Shape breakdown
    const shapeCounts: Record<string, number> = {};
    for (const r of runs) {
      for (const f of r.findings) {
        shapeCounts[f.shapeId] = (shapeCounts[f.shapeId] || 0) + 1;
      }
    }
    if (Object.keys(shapeCounts).length > 0) {
      console.log(`  Findings by shape:`);
      for (const [shape, count] of Object.entries(shapeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${shape}: ${count}`);
      }
    }
  }

  // Comparison table
  console.log('\n=== HUMAN vs AGENT COMPARISON ===');
  console.log('');
  console.log('Source            | Migrations | DM-18 hits | Hit rate');
  console.log('-----------------|------------|------------|--------');
  console.log('Human (backtest) | 761        | 19         | 2.5%');

  for (const agent of agents) {
    const runs = allRuns.filter(r => r.agent === agent && r.parseSuccess);
    const dm18 = runs.filter(r => r.findings.some(f => f.shapeId === 'DM-18'));
    console.log(`${agent.padEnd(17)}| ${String(runs.length).padEnd(11)}| ${String(dm18.length).padEnd(11)}| ${(dm18.length / runs.length * 100).toFixed(1)}%`);
  }

  // Write outputs
  const runsPath = join(REPORT_DIR, `agent-corpus-${new Date().toISOString().slice(0, 10)}.jsonl`);
  writeFileSync(runsPath, allRuns.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nRuns written to: ${runsPath}`);

  const summaryPath = join(REPORT_DIR, `agent-corpus-summary-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    agents,
    taskCount: TASKS.length,
    humanBaseline: { migrations: 761, dm18Hits: 19, hitRate: '2.5%' },
    agentResults: agents.map(agent => {
      const runs = allRuns.filter(r => r.agent === agent);
      const parsed = runs.filter(r => r.parseSuccess);
      const dm18 = parsed.filter(r => r.findings.some(f => f.shapeId === 'DM-18'));
      return {
        agent,
        totalRuns: runs.length,
        parsed: parsed.length,
        parseErrors: runs.filter(r => !r.parseSuccess).length,
        unsafe: runs.filter(r => r.finalLabel === 'unsafe').length,
        safe: runs.filter(r => r.finalLabel === 'safe').length,
        dm18Hits: dm18.length,
        dm18Rate: parsed.length ? (dm18.length / parsed.length * 100).toFixed(1) + '%' : 'N/A',
      };
    }),
  }, null, 2));
  console.log(`Summary written to: ${summaryPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
