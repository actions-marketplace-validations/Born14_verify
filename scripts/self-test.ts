#!/usr/bin/env bun
/**
 * Verify Self-Test — CLI Entry Point
 * ===================================
 *
 * Usage:
 *   bun run packages/verify/scripts/self-test.ts                              # Full run against demo-app
 *   bun run packages/verify/scripts/self-test.ts --appDir=apps/football       # Test against a real app
 *   bun run packages/verify/scripts/self-test.ts --families=A,B               # Specific families
 *   bun run packages/verify/scripts/self-test.ts --fail-on-bug                # Exit 1 on bug-severity violations
 *   bun run packages/verify/scripts/self-test.ts --docker=true                # Include Docker scenarios (Family F)
 *
 * Autoresearch:
 *   bun run packages/verify/scripts/self-test.ts --improve --llm=gemini --api-key=AIza...
 *   bun run packages/verify/scripts/self-test.ts --improve --dry-run --llm=gemini --api-key=AIza...
 *   bun run packages/verify/scripts/self-test.ts --improve --llm=ollama --ollama-model=qwen3:4b
 */

import { resolve, join } from 'path';
import type { ScenarioFamily, RunConfig, ImproveConfig } from './harness/types.js';
import { runSelfTest } from './harness/runner.js';
import { runImproveLoop } from './harness/improve.js';

interface ParsedArgs {
  runConfig: RunConfig;
  improveConfig: ImproveConfig | null;
}

function parseArgs(args: string[]): ParsedArgs {
  const packageRoot = resolve(import.meta.dir, '..');
  let appDir = join(packageRoot, 'fixtures', 'demo-app');

  let families: ScenarioFamily[] | undefined;
  let dockerEnabled = false;
  let failOnBug = false;

  let ledgerPath: string | undefined;

  let improve = false;
  let llm: ImproveConfig['llm'] = 'none';
  let apiKey: string | undefined;
  let ollamaModel: string | undefined;
  let ollamaHost: string | undefined;
  let maxCandidates = 3;
  let maxLines = 30;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--appDir=') || arg.startsWith('--app-dir=')) {
      appDir = resolve(arg.split('=').slice(1).join('='));
    } else if (arg.startsWith('--ledger=')) {
      ledgerPath = arg.slice('--ledger='.length);
    } else if (arg.startsWith('--families=')) {
      const raw = arg.slice('--families='.length);
      families = raw.split(',').map(f => f.trim().toUpperCase() as ScenarioFamily);
    } else if (arg.startsWith('--docker=')) {
      dockerEnabled = arg.slice('--docker='.length) === 'true';
    } else if (arg === '--fail-on-bug') {
      failOnBug = true;
    } else if (arg === '--improve') {
      improve = true;
    } else if (arg.startsWith('--llm=')) {
      llm = arg.slice('--llm='.length) as ImproveConfig['llm'];
    } else if (arg.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length);
    } else if (arg.startsWith('--ollama-model=')) {
      ollamaModel = arg.slice('--ollama-model='.length);
    } else if (arg.startsWith('--ollama-host=')) {
      ollamaHost = arg.slice('--ollama-host='.length);
    } else if (arg.startsWith('--max-candidates=')) {
      maxCandidates = parseInt(arg.slice('--max-candidates='.length), 10);
    } else if (arg.startsWith('--max-lines=')) {
      maxLines = parseInt(arg.slice('--max-lines='.length), 10);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
  Verify Self-Test — Autonomous Bug Discovery + Improvement

  Usage:
    bun run packages/verify/scripts/self-test.ts [options]

  Self-Test Options:
    --appDir=PATH      App directory to test against (default: fixtures/demo-app)
    --families=A,B,G   Run specific scenario families (default: all)
    --docker=true      Include Docker scenarios (default: false)
    --fail-on-bug      Exit with code 1 if bug-severity violations found
    --ledger=PATH      Write ledger to a specific path
    --help, -h         Show this help

  Autoresearch Options:
    --improve          Run improvement loop after self-test
    --llm=gemini       LLM provider: gemini, anthropic, ollama, none
    --api-key=KEY      API key for gemini or anthropic
    --ollama-model=M   Ollama model name (default: qwen3:4b)
    --ollama-host=URL  Ollama host (default: http://localhost:11434)
    --max-candidates=N Number of fix strategies per bundle (default: 3)
    --max-lines=N      Max changed lines per strategy (default: 30)
    --dry-run          Evidence bundling + triage only, no fixes

  Families:
    A  Fingerprint collision detection
    B  K5 constraint learning
    C  Gate sequencing
    D  Containment (G5) attribution
    E  Grounding validation
    F  Full Docker pipeline (auto-enables --docker)
    G  Edge cases, F9 syntax, HTML text, content, K5 edges, narrowing
    I  Cross-predicate interactions
    P  HTTP gate (auto-enables --docker)
`);
      process.exit(0);
    }
  }

  // Auto-enable Docker when Family F or P is explicitly requested
  if (families?.some(f => f === 'F' || f === 'P') && !dockerEnabled) {
    dockerEnabled = true;
  }

  const runConfig: RunConfig = { appDir, families, dockerEnabled, failOnBug, ledgerPath };
  const improveConfig: ImproveConfig | null = improve
    ? { llm, apiKey, ollamaModel, ollamaHost, maxCandidates, maxLines, dryRun }
    : null;

  return { runConfig, improveConfig };
}

async function main() {
  const args = process.argv.slice(2);
  const { runConfig, improveConfig } = parseArgs(args);

  if (improveConfig) {
    await runImproveLoop(runConfig, improveConfig);
  } else {
    const { exitCode } = await runSelfTest(runConfig);
    process.exit(exitCode);
  }
}

main().catch(err => {
  console.error(`\n  Fatal error: ${err.message}\n`);
  process.exit(2);
});
