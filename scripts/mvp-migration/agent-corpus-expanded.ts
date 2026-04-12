/**
 * agent-corpus-expanded.ts — Run 75 tasks across 3 models with category breakdown.
 *
 * Usage: bun run scripts/mvp-migration/agent-corpus-expanded.ts
 *
 * Loads keys from ~/sovereign/.env if not in process.env.
 */
import { loadModule } from 'libpg-query';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { buildSchemaFromSQL } from './schema-loader';
import { parseMigration } from './spec-from-ast';
import { runGroundingGate } from './grounding-gate';
import { runSafetyGate } from './safety-gate';
import { EXPANDED_TASKS, CATEGORY_INFO } from './agent-corpus-tasks';
import type { MigrationTask, AgentRun } from './agent-corpus';

const REPORT_DIR = join(import.meta.dir, 'reports');

// ---------------------------------------------------------------------------
// Load API keys from ~/sovereign/.env if not in env
// ---------------------------------------------------------------------------

function loadEnvFile() {
  const envPath = join(homedir(), 'sovereign', '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim();
    }
  }
}

loadEnvFile();

// ---------------------------------------------------------------------------
// LLM call (re-exported from agent-corpus.ts logic, inlined here)
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

  if (agent === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: task.prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.content?.[0]?.text ?? '';
  }

  if (agent === 'gemini') {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\nTask: ${task.prompt}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
    const data = await res.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  if (agent === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task.prompt },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content ?? '';
  }

  throw new Error(`Unknown agent: ${agent}`);
}

// ---------------------------------------------------------------------------
// Run task
// ---------------------------------------------------------------------------

async function runTask(task: MigrationTask, agent: string): Promise<AgentRun & { category: string }> {
  const category = task.id.replace(/-\d+$/, '');
  let generatedSql = '';
  try {
    generatedSql = await generateMigration(task, agent);
  } catch (err: any) {
    return {
      taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
      generatedSql: '', parseSuccess: false, parseError: err.message,
      findings: [], finalLabel: 'parse_error', targetShapes: task.targetShapes,
      category,
    };
  }

  generatedSql = generatedSql.replace(/^```(?:sql)?\n?/i, '').replace(/\n?```$/i, '').trim();

  let schema;
  try {
    schema = buildSchemaFromSQL([task.schemaSql]);
  } catch (err: any) {
    return {
      taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
      generatedSql, parseSuccess: false, parseError: `Schema build error: ${err.message}`,
      findings: [], finalLabel: 'parse_error', targetShapes: task.targetShapes,
      category,
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
      category,
    };
  }

  if (spec.meta.parseErrors.length > 0) {
    return {
      taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
      generatedSql, parseSuccess: false, parseError: spec.meta.parseErrors[0],
      findings: [], finalLabel: 'parse_error', targetShapes: task.targetShapes,
      category,
    };
  }

  const grounding = runGroundingGate(spec, schema);
  const safety = runSafetyGate(spec, schema);
  const allFindings = [...grounding, ...safety];
  const findings = allFindings.map(f => ({
    shapeId: f.shapeId, severity: f.severity, message: f.message,
  }));
  const hasErrors = allFindings.some(f => f.severity === 'error');
  const hasWarnings = allFindings.some(f => f.severity === 'warning');
  const finalLabel: 'unsafe' | 'safe_with_warning' | 'safe' =
    hasErrors ? 'unsafe' : hasWarnings ? 'safe_with_warning' : 'safe';

  return {
    taskId: task.id, repo: task.repo, prompt: task.prompt, agent,
    generatedSql, parseSuccess: true, parseError: null,
    findings, finalLabel,
    targetShapes: task.targetShapes,
    category,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadModule();

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

  const agents: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) agents.push('claude');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) agents.push('gemini');
  if (process.env.OPENAI_API_KEY) agents.push('openai');

  if (agents.length === 0) {
    console.error('No API keys found. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY.');
    process.exit(1);
  }

  console.log(`=== EXPANDED AGENT MIGRATION CORPUS ===`);
  console.log(`Agents: ${agents.join(', ')}`);
  console.log(`Tasks:  ${EXPANDED_TASKS.length}`);
  console.log(`Total runs: ${EXPANDED_TASKS.length * agents.length}\n`);

  const allRuns: Array<AgentRun & { category: string }> = [];

  for (const agent of agents) {
    console.log(`\n--- Agent: ${agent} ---`);
    let i = 0;
    for (const task of EXPANDED_TASKS) {
      i++;
      process.stdout.write(`  [${i}/${EXPANDED_TASKS.length}] ${task.id}... `);
      const run = await runTask(task, agent);
      allRuns.push(run);
      const status =
        run.finalLabel === 'unsafe' ? '⚠ unsafe (error)' :
        run.finalLabel === 'safe_with_warning' ? '⚠ safe + warning' :
        run.finalLabel === 'parse_error' ? '✗ parse error' :
        '✓ clean';
      const findings = run.findings.length > 0 ? ` (${run.findings.map(f => `${f.shapeId}/${f.severity[0]}`).join(',')})` : '';
      console.log(`${status}${findings}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary by agent
  // ---------------------------------------------------------------------------

  console.log('\n\n' + '='.repeat(70));
  console.log('EXPANDED AGENT CORPUS SUMMARY');
  console.log('='.repeat(70));

  for (const agent of agents) {
    const runs = allRuns.filter(r => r.agent === agent);
    const parsed = runs.filter(r => r.parseSuccess);
    const unsafe = runs.filter(r => r.finalLabel === 'unsafe');
    const safeWithWarning = runs.filter(r => r.finalLabel === 'safe_with_warning');
    const clean = runs.filter(r => r.finalLabel === 'safe');
    const errors = runs.filter(r => r.finalLabel === 'parse_error');

    console.log(`\n${agent}:`);
    console.log(`  Total runs:        ${runs.length}`);
    console.log(`  Parsed OK:         ${parsed.length}`);
    console.log(`  Parse errors:      ${errors.length}`);
    console.log(`  Unsafe (error):    ${unsafe.length} (${(unsafe.length / parsed.length * 100).toFixed(1)}% of parsed)`);
    console.log(`  Safe + warning:    ${safeWithWarning.length}`);
    console.log(`  Clean (no finds):  ${clean.length}`);

    const shapeCounts: Record<string, { error: number; warning: number }> = {};
    for (const r of runs) {
      for (const f of r.findings) {
        if (!shapeCounts[f.shapeId]) shapeCounts[f.shapeId] = { error: 0, warning: 0 };
        shapeCounts[f.shapeId][f.severity as 'error' | 'warning']++;
      }
    }
    if (Object.keys(shapeCounts).length > 0) {
      console.log(`  Findings by shape (error / warning):`);
      for (const [shape, counts] of Object.entries(shapeCounts).sort((a, b) => (b[1].error + b[1].warning) - (a[1].error + a[1].warning))) {
        console.log(`    ${shape}: ${counts.error} / ${counts.warning}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Category breakdown
  // ---------------------------------------------------------------------------

  console.log('\n\n=== CATEGORY BREAKDOWN ===\n');
  console.log('Category            | Expects | Agent  | Hits | Total | Hit rate');
  console.log('--------------------|---------|--------|------|-------|----------');

  const categories = Object.keys(CATEGORY_INFO);
  for (const cat of categories) {
    const info = CATEGORY_INFO[cat];
    const expectStr = info.expectsFinding ? `${info.targetShape}` : 'safe';

    for (const agent of agents) {
      const catRuns = allRuns.filter(r => r.category === cat && r.agent === agent && r.parseSuccess);
      const hits = catRuns.filter(r => r.findings.some(f => info.expectsFinding ? f.shapeId === info.targetShape : true));
      const hitRate = catRuns.length ? (hits.length / catRuns.length * 100).toFixed(0) + '%' : 'N/A';
      console.log(
        info.label.padEnd(20) + '| ' +
        expectStr.padEnd(8) + '| ' +
        agent.padEnd(7) + '| ' +
        String(hits.length).padEnd(5) + '| ' +
        String(catRuns.length).padEnd(6) + '| ' +
        hitRate
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Headline comparison
  // ---------------------------------------------------------------------------

  // Definitions:
  //   "DM-18 (any)"      — finding of any severity. Measures structural risk rate.
  //   "DM-18 (blocking)" — error-severity only. Measures CI-blocking rate.
  // Both columns shown so warning-only hits are never silently bucketed as safe.
  console.log('\n\n=== HUMAN vs AGENT (DM-18) ===\n');
  console.log('Source            | Tasks | DM-18 (any) | DM-18 (block) | Any rate');
  console.log('------------------|-------|-------------|---------------|---------');
  console.log('Human (backtest)  | 761   | 19          | 19            | 2.5%');

  // For DM-18, only count tasks designed to probe DM-18
  const dm18Categories = ['add_required', 'set_not_null'];
  for (const agent of agents) {
    const dm18Runs = allRuns.filter(r => dm18Categories.includes(r.category) && r.agent === agent && r.parseSuccess);
    const dm18Any = dm18Runs.filter(r => r.findings.some(f => f.shapeId === 'DM-18'));
    const dm18Block = dm18Runs.filter(r => r.findings.some(f => f.shapeId === 'DM-18' && f.severity === 'error'));
    console.log(
      agent.padEnd(18) + '| ' +
      String(dm18Runs.length).padEnd(6) + '| ' +
      String(dm18Any.length).padEnd(12) + '| ' +
      String(dm18Block.length).padEnd(14) + '| ' +
      (dm18Runs.length ? (dm18Any.length / dm18Runs.length * 100).toFixed(1) + '%' : 'N/A')
    );
  }

  // False positive check on safe categories
  console.log('\n\n=== FALSE POSITIVE CHECK (safe categories) ===\n');
  console.log('These categories should produce ZERO findings on any model.\n');
  console.log('Category            | Agent  | Findings | Sample finding');
  console.log('--------------------|--------|----------|----------------');
  const safeCategories = ['add_optional', 'add_with_default'];
  for (const cat of safeCategories) {
    for (const agent of agents) {
      const catRuns = allRuns.filter(r => r.category === cat && r.agent === agent && r.parseSuccess);
      const fpRuns = catRuns.filter(r => r.findings.length > 0);
      const sample = fpRuns[0]?.findings[0];
      console.log(
        CATEGORY_INFO[cat].label.padEnd(20) + '| ' +
        agent.padEnd(7) + '| ' +
        String(fpRuns.length).padEnd(9) + '| ' +
        (sample ? `${sample.shapeId}: ${sample.message.slice(0, 60)}` : '-')
      );
    }
  }

  // Write outputs
  const ts = new Date().toISOString().slice(0, 10);
  const runsPath = join(REPORT_DIR, `agent-corpus-expanded-${ts}.jsonl`);
  writeFileSync(runsPath, allRuns.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nRuns written to: ${runsPath}`);

  const summaryPath = join(REPORT_DIR, `agent-corpus-expanded-summary-${ts}.json`);
  const summary = {
    timestamp: new Date().toISOString(),
    agents,
    taskCount: EXPANDED_TASKS.length,
    totalRuns: allRuns.length,
    humanBaseline: { migrations: 761, dm18Hits: 19, hitRate: '2.5%' },
    labelDefinitions: {
      unsafe: 'at least one error-severity finding (blocking in CI)',
      safe_with_warning: 'no errors, but at least one warning-severity finding',
      safe: 'zero findings of any severity',
      parse_error: 'generated SQL failed to parse',
    },
    metricDefinitions: {
      dm18HitsAny: 'DM-18 finding of any severity — measures structural risk rate',
      dm18HitsBlocking: 'DM-18 finding of error severity — measures CI-blocking rate',
    },
    perAgent: agents.map(agent => {
      const runs = allRuns.filter(r => r.agent === agent);
      const parsed = runs.filter(r => r.parseSuccess);
      const dm18Runs = parsed.filter(r => dm18Categories.includes(r.category));
      const dm18Any = dm18Runs.filter(r => r.findings.some(f => f.shapeId === 'DM-18'));
      const dm18Block = dm18Runs.filter(r => r.findings.some(f => f.shapeId === 'DM-18' && f.severity === 'error'));
      const allShapeCounts: Record<string, { error: number; warning: number }> = {};
      for (const r of runs) for (const f of r.findings) {
        if (!allShapeCounts[f.shapeId]) allShapeCounts[f.shapeId] = { error: 0, warning: 0 };
        allShapeCounts[f.shapeId][f.severity as 'error' | 'warning']++;
      }
      return {
        agent,
        totalRuns: runs.length,
        parsed: parsed.length,
        parseErrors: runs.filter(r => !r.parseSuccess).length,
        unsafe: runs.filter(r => r.finalLabel === 'unsafe').length,
        safe_with_warning: runs.filter(r => r.finalLabel === 'safe_with_warning').length,
        safe: runs.filter(r => r.finalLabel === 'safe').length,
        dm18ProbeTasks: dm18Runs.length,
        dm18HitsAny: dm18Any.length,
        dm18HitsBlocking: dm18Block.length,
        dm18RateAny: dm18Runs.length ? (dm18Any.length / dm18Runs.length * 100).toFixed(1) + '%' : 'N/A',
        dm18RateBlocking: dm18Runs.length ? (dm18Block.length / dm18Runs.length * 100).toFixed(1) + '%' : 'N/A',
        shapeCounts: allShapeCounts,
      };
    }),
    perCategory: categories.map(cat => ({
      category: cat,
      label: CATEGORY_INFO[cat].label,
      expectedShape: CATEGORY_INFO[cat].targetShape,
      expectsFinding: CATEGORY_INFO[cat].expectsFinding,
      perAgent: agents.map(agent => {
        const catRuns = allRuns.filter(r => r.category === cat && r.agent === agent && r.parseSuccess);
        const hits = catRuns.filter(r =>
          CATEGORY_INFO[cat].expectsFinding
            ? r.findings.some(f => f.shapeId === CATEGORY_INFO[cat].targetShape)
            : r.findings.length > 0
        );
        return {
          agent,
          tasks: catRuns.length,
          hits: hits.length,
          hitRate: catRuns.length ? (hits.length / catRuns.length * 100).toFixed(0) + '%' : 'N/A',
        };
      }),
    })),
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Summary written to: ${summaryPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
