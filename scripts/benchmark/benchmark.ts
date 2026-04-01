#!/usr/bin/env node
/**
 * Benchmark CLI — Prove Verify Works (or Doesn't)
 * =================================================
 *
 * npx tsx scripts/benchmark/benchmark.ts [options]
 *
 * Options:
 *   --app=<path>              App directory to benchmark against (default: fixtures/demo-app)
 *   --tasks=<n>               Number of tasks to generate (default: 20)
 *   --max-attempts=<n>        Max govern() attempts (default: 3)
 *   --llm=gemini|claude|anthropic|ollama  LLM provider (default: gemini)
 *   --api-key=<key>           API key (or set GEMINI_API_KEY / ANTHROPIC_API_KEY)
 *   --model=<model>           Model override
 *   --state-dir=<path>        State directory (default: .verify/benchmark)
 *   --verbose                 Show detailed per-task output
 *   --tasks-file=<path>       Load tasks from JSON file instead of generating
 *
 * The benchmark:
 *   1. Generates N coding tasks for the app (using the LLM)
 *   2. For each task, runs the agent twice:
 *      a. RAW: Agent produces edits, applied directly, checked by ground truth
 *      b. GOVERNED: Agent runs through govern(), checked by ground truth
 *   3. Ground truth is independent of verify — no verify code in the judge
 *   4. Produces a comparison table: success rates, tasks saved, regressions
 *
 * This is the proof. Run it. Look at the numbers.
 */

import { resolve, join } from 'path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { runBenchmark } from './runner.js';
import { groundInReality } from '../../src/gates/grounding.js';
import type { BenchmarkConfig, BenchmarkTask, LLMCallFn } from './types.js';

// =============================================================================
// ARG PARSING
// =============================================================================

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.join('=') || 'true';
    }
  }
  return args;
}

// =============================================================================
// LLM PROVIDERS
// =============================================================================

function createLLM(provider: string, apiKey: string, model?: string): { llm: LLMCallFn; model: string } {
  switch (provider) {
    case 'gemini': {
      const m = model ?? 'gemini-2.5-flash';
      return {
        model: m,
        llm: async (system, user) => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: user }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
            }),
          });
          if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
          const data = await resp.json() as any;
          const text = data.candidates?.[0]?.content?.parts
            ?.filter((p: any) => p.text && !p.thought)
            ?.map((p: any) => p.text).join('') || '';
          const usage = data.usageMetadata ?? {};
          return { text, inputTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0 };
        },
      };
    }
    case 'claude':
    case 'anthropic': {
      const m = model ?? 'claude-sonnet-4-20250514';
      return {
        model: m,
        llm: async (system, user) => {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: m,
              max_tokens: 4096,
              temperature: 0.3,
              system,
              messages: [{ role: 'user', content: user }],
            }),
          });
          if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
          const data = await resp.json() as any;
          const text = data.content?.map((b: any) => b.text).join('') ?? '';
          return {
            text,
            inputTokens: data.usage?.input_tokens ?? 0,
            outputTokens: data.usage?.output_tokens ?? 0,
          };
        },
      };
    }
    case 'ollama': {
      const m = model ?? 'qwen3:4b';
      const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
      return {
        model: m,
        llm: async (system, user) => {
          const resp = await fetch(`${host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: m,
              system,
              prompt: user,
              stream: false,
              options: { temperature: 0.3 },
            }),
          });
          if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
          const data = await resp.json() as any;
          return { text: data.response ?? '', inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 };
        },
      };
    }
    default:
      throw new Error(`Unknown LLM provider: ${provider}. Use gemini, claude, anthropic, or ollama.`);
  }
}

// =============================================================================
// TASK GENERATION
// =============================================================================

const TASK_GEN_SYSTEM = `You are generating benchmark tasks for a code verification system.
Each task is a realistic coding goal that an AI agent would be asked to do.

Generate tasks that:
1. Are achievable with search/replace edits on the given source files
2. Span different difficulty levels (trivial, moderate, hard)
3. Cover different categories (CSS changes, HTML changes, logic changes, config changes)
4. Have clear success criteria
5. Are independent of each other

Respond with a JSON array of tasks. No markdown fencing.
Each task: { "goal": "...", "category": "...", "difficulty": "trivial|moderate|hard" }`;

async function generateTasks(
  appDir: string,
  count: number,
  llm: LLMCallFn,
): Promise<BenchmarkTask[]> {
  console.log(`Generating ${count} benchmark tasks...`);

  // Build context from app
  const grounding = groundInReality(appDir);
  const lines: string[] = [];
  lines.push(`App directory: ${appDir}`);
  lines.push(`Routes: ${grounding.routes.join(', ')}`);
  lines.push('');

  // Read source files for context
  const { readdirSync, statSync } = require('fs');
  const sourceExts = new Set(['.js', '.ts', '.html', '.css', '.json']);
  const skipDirs = new Set(['node_modules', '.git', '.verify']);

  function walk(dir: string, prefix: string = ''): void {
    try {
      for (const entry of readdirSync(dir)) {
        if (skipDirs.has(entry)) continue;
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full, rel);
        else if (sourceExts.has(require('path').extname(entry)) && stat.size < 15_000) {
          lines.push(`--- ${rel} ---`);
          lines.push(readFileSync(full, 'utf-8'));
          lines.push('');
        }
      }
    } catch { /* skip */ }
  }
  walk(appDir);

  const prompt = `Generate exactly ${count} benchmark tasks for this app.\n\n${lines.join('\n')}`;
  const response = await llm(TASK_GEN_SYSTEM, prompt);

  let parsed: any[];
  try {
    let text = response.text.trim();
    if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(text);
  } catch {
    const match = response.text.match(/\[[\s\S]*\]/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('Failed to parse task generation response');
  }

  return parsed.map((t: any, i: number) => ({
    id: `task_${i + 1}`,
    goal: t.goal,
    appDir,
    predicates: t.predicates ?? [],
    category: t.category ?? 'general',
    difficulty: t.difficulty ?? 'moderate',
  }));
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = parseArgs();

  const appDir = resolve(args['app'] ?? join(__dirname, '../../fixtures/demo-app'));
  const taskCount = parseInt(args['tasks'] ?? '20', 10);
  const maxAttempts = parseInt(args['max-attempts'] ?? '3', 10);
  const provider = args['llm'] ?? 'gemini';
  const stateDir = resolve(args['state-dir'] ?? '.verify/benchmark');
  const verbose = args['verbose'] === 'true';
  const tasksFile = args['tasks-file'];

  // Resolve API key
  let apiKey = args['api-key'] ?? '';
  if (!apiKey) {
    if (provider === 'gemini') apiKey = process.env.GEMINI_API_KEY ?? '';
    if (provider === 'claude' || provider === 'anthropic') apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  }
  if (!apiKey && provider !== 'ollama') {
    console.error(`Error: No API key. Set --api-key or the appropriate env var.`);
    process.exit(1);
  }

  if (!existsSync(appDir)) {
    console.error(`Error: App directory not found: ${appDir}`);
    process.exit(1);
  }

  // Create LLM
  const { llm, model } = createLLM(provider, apiKey, args['model']);

  // Get or generate tasks
  let tasks: BenchmarkTask[];
  if (tasksFile && existsSync(tasksFile)) {
    console.log(`Loading tasks from ${tasksFile}...`);
    tasks = JSON.parse(readFileSync(tasksFile, 'utf-8'));
    // Set appDir on loaded tasks
    tasks = tasks.map(t => ({ ...t, appDir }));
  } else {
    tasks = await generateTasks(appDir, taskCount, llm);
    // Save generated tasks for reproducibility
    mkdirSync(stateDir, { recursive: true });
    const tasksPath = join(stateDir, `tasks-${Date.now()}.json`);
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
    console.log(`Tasks saved to: ${tasksPath} (use --tasks-file to reuse)`);
  }

  console.log(`\nLoaded ${tasks.length} tasks for ${appDir}`);

  // Run benchmark
  const config: BenchmarkConfig = {
    tasks,
    llm,
    llmProvider: provider,
    model,
    maxGovAttempts: maxAttempts,
    stateDir,
    verbose,
    skipDocker: true,
  };

  const run = await runBenchmark(config);

  // Exit code: 0 if verify helped or was neutral, 1 if regression
  if (run.summary.headToHead.verifyRegression > run.summary.headToHead.verifySaved) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nBenchmark failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
