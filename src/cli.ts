#!/usr/bin/env node
/**
 * @sovereign-labs/verify CLI
 * ==========================
 *
 * npx @sovereign-labs/verify init          — scaffold .verify/ in current project
 * npx @sovereign-labs/verify check         — run verification from .verify/check.json
 * npx @sovereign-labs/verify ground        — print grounding context (CSS, HTML, routes)
 * npx @sovereign-labs/verify doctor        — check Docker + Playwright availability
 * npx @sovereign-labs/verify self-test     — run 56 scenarios across 7 families
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verify } from './verify.js';
import { groundInReality } from './gates/grounding.js';
import { isDockerAvailable, hasDockerCompose } from './runners/docker-runner.js';
import { parseDiff } from './parsers/git-diff.js';
import type { Edit, Predicate, VerifyConfig } from './types.js';
import type { ScenarioFamily } from '../scripts/harness/types.js';
import { FaultLedger } from './store/fault-ledger.js';
import type { FaultClassification } from './store/fault-ledger.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'init':
      return runInit();
    case 'check':
      return runCheck();
    case 'ground':
      return runGround();
    case 'doctor':
      return runDoctor();
    case 'self-test':
      return runSelfTestCommand();
    case 'faults':
      return runFaults();
    case '--version':
    case '-v':
      return printVersion();
    case '--help':
    case '-h':
    case undefined:
      return printHelp();
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "npx @sovereign-labs/verify --help" for usage.');
      process.exit(1);
  }
}

// =============================================================================
// COMMANDS
// =============================================================================

function runInit() {
  const cwd = process.cwd();
  const verifyDir = join(cwd, '.verify');

  if (existsSync(verifyDir)) {
    console.log('.verify/ already exists. Skipping.');
    return;
  }

  mkdirSync(verifyDir, { recursive: true });

  // Create example check.json
  const exampleCheck = {
    $schema: 'https://unpkg.com/@sovereign-labs/verify/schemas/check.json',
    appDir: '.',
    goal: 'Example: change the homepage heading color to blue',
    edits: [
      {
        file: 'index.html',
        search: 'color: black;',
        replace: 'color: blue;',
      },
    ],
    predicates: [
      {
        type: 'css',
        selector: 'h1',
        property: 'color',
        expected: 'rgb(0, 0, 255)',
        description: 'Homepage heading should be blue',
      },
    ],
  };

  writeFileSync(
    join(verifyDir, 'check.json'),
    JSON.stringify(exampleCheck, null, 2) + '\n',
  );

  // Create example invariants.json
  const exampleInvariants = [
    {
      name: 'Homepage loads',
      type: 'http',
      path: '/',
      expect: { status: 200 },
    },
  ];

  writeFileSync(
    join(verifyDir, 'invariants.json'),
    JSON.stringify(exampleInvariants, null, 2) + '\n',
  );

  console.log('Created .verify/ with example files:');
  console.log('  .verify/check.json       — edit your verification spec here');
  console.log('  .verify/invariants.json   — system health checks (optional)');
  console.log('');
  console.log('Next: edit check.json with your real edits + predicates, then run:');
  console.log('  npx @sovereign-labs/verify check');
}

async function runCheck() {
  const cwd = process.cwd();

  // Find check spec
  const checkPath = args[1] ?? join(cwd, '.verify', 'check.json');
  if (!existsSync(checkPath)) {
    console.error(`Check file not found: ${checkPath}`);
    console.error('Run "npx @sovereign-labs/verify init" to create one.');
    process.exit(1);
  }

  let spec: any;
  try {
    spec = JSON.parse(readFileSync(checkPath, 'utf-8'));
  } catch (err: any) {
    console.error(`Invalid JSON in ${checkPath}: ${err.message}`);
    process.exit(1);
  }

  // Support stdin for edits (piped git diff)
  let edits: Edit[] = spec.edits ?? [];
  if (args.includes('--diff')) {
    const diffInput = readFileSync('/dev/stdin', 'utf-8');
    edits = parseDiff(diffInput);
    if (edits.length === 0) {
      console.error('No edits found in diff input.');
      process.exit(1);
    }
  }

  const predicates: Predicate[] = spec.predicates ?? [];
  if (predicates.length === 0) {
    console.error('No predicates defined. Add at least one predicate to check.json.');
    process.exit(1);
  }

  const appDir = resolve(cwd, spec.appDir ?? '.');
  if (!existsSync(appDir)) {
    console.error(`App directory not found: ${appDir}`);
    process.exit(1);
  }

  const config: VerifyConfig = {
    appDir,
    goal: spec.goal,
    docker: spec.docker ?? { compose: true },
    gates: spec.gates,
    stateDir: spec.stateDir ?? join(cwd, '.verify'),
    log: (msg: string) => {
      if (!args.includes('--quiet') && !args.includes('-q')) {
        console.log(msg);
      }
    },
  };

  console.log(`\nVerifying ${edits.length} edit(s) against ${predicates.length} predicate(s)...\n`);

  const result = await verify(edits, predicates, config);

  // Output
  console.log('\n' + '='.repeat(60));
  console.log(result.attestation);
  console.log('='.repeat(60));

  if (!result.success && result.narrowing) {
    console.log('\n--- What to try next ---');
    if (result.narrowing.resolutionHint) {
      console.log(`  Hint: ${result.narrowing.resolutionHint}`);
    }
    if (result.narrowing.patternRecall && result.narrowing.patternRecall.length > 0) {
      console.log('  Known fixes:');
      for (const fix of result.narrowing.patternRecall) {
        console.log(`    - ${fix}`);
      }
    }
    if (result.narrowing.bannedFingerprints && result.narrowing.bannedFingerprints.length > 0) {
      console.log('  Banned predicates (failed before):');
      for (const fp of result.narrowing.bannedFingerprints) {
        console.log(`    - ${fp}`);
      }
    }
  }

  if (args.includes('--json')) {
    console.log('\n' + JSON.stringify(result, null, 2));
  }

  process.exit(result.success ? 0 : 1);
}

function runGround() {
  const cwd = process.cwd();
  const appDir = resolve(cwd, args[1] ?? '.');

  if (!existsSync(appDir)) {
    console.error(`Directory not found: ${appDir}`);
    process.exit(1);
  }

  console.log(`Scanning ${appDir} for grounding context...\n`);

  const grounding = groundInReality(appDir);

  // Routes
  if (grounding.routes.length > 0) {
    console.log(`Routes (${grounding.routes.length}):`);
    for (const route of grounding.routes) {
      console.log(`  ${route}`);
    }
    console.log('');
  }

  // CSS
  let cssCount = 0;
  for (const [route, rules] of grounding.routeCSSMap) {
    if (rules.size === 0) continue;
    console.log(`CSS (${route}):`);
    for (const [selector, props] of rules) {
      const propStr = Object.entries(props).map(([k, v]) => `${k}: ${v}`).join('; ');
      console.log(`  ${selector} { ${propStr} }`);
      cssCount++;
    }
    console.log('');
  }

  // HTML elements
  let htmlCount = 0;
  for (const [route, elements] of grounding.htmlElements) {
    if (elements.length === 0) continue;
    console.log(`HTML Elements (${route}):`);
    for (const el of elements.slice(0, 20)) {
      const attrs = el.attributes ? ` ${Object.entries(el.attributes).map(([k, v]) => `${k}="${v}"`).join(' ')}` : '';
      console.log(`  <${el.tag}${attrs}>${el.text ?? ''}</${el.tag}>`);
      htmlCount++;
    }
    if (elements.length > 20) console.log(`  ... and ${elements.length - 20} more`);
    console.log('');
  }

  console.log(`Summary: ${grounding.routes.length} routes, ${cssCount} CSS rules, ${htmlCount} HTML elements`);
}

async function runDoctor() {
  console.log('Checking environment...\n');

  // Docker
  let docker = false;
  try { docker = await isDockerAvailable(); } catch {}
  console.log(`  Docker:           ${docker ? '✓ available' : '✗ not found'}`);

  // Docker Compose
  let compose = false;
  try { compose = docker ? await hasDockerCompose() : false; } catch {}
  console.log(`  Docker Compose:   ${compose ? '✓ available' : '✗ not found'}`);

  // Playwright image
  let playwright = false;
  if (docker) {
    try {
      const { spawn } = await import('child_process');
      playwright = await new Promise<boolean>((resolve) => {
        const child = spawn('docker', ['image', 'inspect', 'mcr.microsoft.com/playwright:v1.49.0-noble'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
    } catch {}
  }
  console.log(`  Playwright image: ${playwright ? '✓ available' : '○ not pulled (browser gate will skip)'}`);

  // State directory
  const stateDir = join(process.cwd(), '.verify');
  const hasState = existsSync(stateDir);
  console.log(`  .verify/ dir:     ${hasState ? '✓ exists' : '○ not initialized (run: npx @sovereign-labs/verify init)'}`);

  console.log('');
  if (docker && compose) {
    console.log('Ready to verify. Run: npx @sovereign-labs/verify check');
  } else if (!docker) {
    console.log('Docker is required. Install from https://docs.docker.com/get-docker/');
  } else {
    console.log('Docker Compose V2 is required. Included with Docker Desktop, or install the CLI plugin.');
  }
}

async function runSelfTestCommand() {
  const { runSelfTest } = await import('../scripts/harness/runner.js');

  // Resolve the fixtures/demo-app directory relative to this file
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageRoot = resolve(__dirname, '..');
  const appDir = resolve(packageRoot, 'fixtures', 'demo-app');

  if (!existsSync(appDir)) {
    console.error(`Demo app not found at ${appDir}`);
    console.error('The fixtures/demo-app directory is required for self-test.');
    process.exit(1);
  }

  // Parse self-test args
  const families: ScenarioFamily[] = [];
  const familiesArg = args.find(a => a.startsWith('--families='));
  if (familiesArg) {
    const letters = familiesArg.split('=')[1].split(',');
    for (const l of letters) {
      const upper = l.trim().toUpperCase();
      if ('ABCDEFG'.includes(upper)) {
        families.push(upper as ScenarioFamily);
      }
    }
  }

  const dockerEnabled = args.includes('--docker=true') || args.includes('--docker');
  const failOnBug = args.includes('--fail-on-bug');

  console.log(`\nRunning self-test from ${appDir}`);
  if (families.length > 0) console.log(`  Families: ${families.join(', ')}`);
  console.log(`  Docker: ${dockerEnabled ? 'enabled' : 'disabled (pure-only)'}`);
  console.log(`  Fail on bug: ${failOnBug}\n`);

  const result = await runSelfTest({
    appDir,
    families: families.length > 0 ? families : undefined,
    dockerEnabled,
    failOnBug,
  });

  process.exit(result.exitCode);
}

function runFaults() {
  const cwd = process.cwd();
  const ledgerPath = join(cwd, '.verify', 'faults.jsonl');
  const ledger = new FaultLedger(ledgerPath);

  const subcommand = args[1];

  switch (subcommand) {
    case 'list':
    case undefined: {
      const filter = args.find(a => a.startsWith('--filter='))?.split('=')[1];
      const appFilter = args.find(a => a.startsWith('--app='))?.split('=')[1];

      let entries = ledger.all();
      if (filter) entries = entries.filter(e => e.classification === filter);
      if (appFilter) entries = entries.filter(e => e.app === appFilter);

      if (entries.length === 0) {
        console.log('No fault entries found.');
        console.log('Faults are recorded automatically when verify() runs with cross-check probes,');
        console.log('or manually with: npx @sovereign-labs/verify faults log');
        return;
      }

      console.log(`\nFault Ledger (${entries.length} entries)\n`);
      for (const e of entries) {
        const encoded = e.scenarioId ? `→ ${e.scenarioId}` : '○ unencoded';
        const conf = e.confidence === 'high' ? '' : ` [${e.confidence}]`;
        const icon = e.classification === 'false_positive' ? '✗'
          : e.classification === 'false_negative' ? '✗'
          : e.classification === 'bad_hint' ? '~'
          : e.classification === 'correct' ? '✓'
          : e.classification === 'agent_fault' ? '·'
          : '?';
        console.log(`  ${icon} ${e.id}  ${e.classification}${conf}  ${encoded}`);
        console.log(`    ${e.app}: ${e.goal.slice(0, 60)}${e.goal.length > 60 ? '...' : ''}`);
        console.log(`    ${e.reason}`);
        console.log('');
      }
      break;
    }

    case 'inbox': {
      const unencoded = ledger.getUnencoded();
      if (unencoded.length === 0) {
        console.log('No unencoded faults. All discovered faults have scenarios.');
        return;
      }

      console.log(`\nUnencoded Faults (${unencoded.length} waiting for scenarios)\n`);
      for (const e of unencoded) {
        const conf = e.confidence === 'high' ? '' : ` [${e.confidence}]`;
        console.log(`  ${e.id}  ${e.classification}${conf}`);
        console.log(`    ${e.app}: ${e.goal.slice(0, 60)}${e.goal.length > 60 ? '...' : ''}`);
        console.log(`    Gate: ${e.failedGate ?? 'none (verify passed)'}  Signature: ${e.signature ?? 'none'}`);
        if (e.narrowingHint) console.log(`    Hint: ${e.narrowingHint.slice(0, 80)}`);
        console.log('');
      }
      break;
    }

    case 'review': {
      const needsReview = ledger.getNeedsReview();
      if (needsReview.length === 0) {
        console.log('No faults need review. All entries are classified with confidence.');
        return;
      }

      console.log(`\nFaults Needing Review (${needsReview.length})\n`);
      for (const e of needsReview) {
        console.log(`  ? ${e.id}  ${e.classification} [${e.confidence}]`);
        console.log(`    ${e.app}: ${e.goal.slice(0, 60)}${e.goal.length > 60 ? '...' : ''}`);
        console.log(`    Verify: ${e.verifyPassed ? 'PASS' : 'FAIL'}  Gate: ${e.failedGate ?? 'none'}`);
        console.log(`    Reason: ${e.reason}`);
        console.log('');
      }
      break;
    }

    case 'summary': {
      const summary = ledger.summarize();
      console.log(`\nFault Ledger Summary\n`);
      console.log(`  Total entries:     ${summary.total}`);
      console.log(`  Verify bugs:       ${summary.byClassification.false_positive + summary.byClassification.false_negative + summary.byClassification.bad_hint}`);
      console.log(`    False positives:  ${summary.byClassification.false_positive}`);
      console.log(`    False negatives:  ${summary.byClassification.false_negative}`);
      console.log(`    Bad hints:        ${summary.byClassification.bad_hint}`);
      console.log(`  Agent faults:      ${summary.byClassification.agent_fault}`);
      console.log(`  Correct:           ${summary.byClassification.correct}`);
      console.log(`  Ambiguous:         ${summary.byClassification.ambiguous}`);
      console.log(`  Unencoded:         ${summary.unencoded}`);
      console.log(`  Encoded:           ${summary.encoded}`);
      console.log(`  Needs review:      ${summary.needsReview}`);
      break;
    }

    case 'log': {
      // Manual entry: npx verify faults log --app=X --goal="Y" --class=false_positive --reason="Z"
      const app = args.find(a => a.startsWith('--app='))?.split('=')[1];
      const goal = args.find(a => a.startsWith('--goal='))?.split('=')[1];
      const cls = args.find(a => a.startsWith('--class='))?.split('=')[1];
      const reason = args.find(a => a.startsWith('--reason='))?.split('=')[1];
      const gate = args.find(a => a.startsWith('--gate='))?.split('=')[1];
      const notes = args.find(a => a.startsWith('--notes='))?.split('=')[1];

      if (!app || !goal || !cls || !reason) {
        console.error('Usage: npx @sovereign-labs/verify faults log --app=X --goal="Y" --class=false_positive --reason="Z"');
        console.error('');
        console.error('Required: --app, --goal, --class, --reason');
        console.error('Optional: --gate, --notes');
        console.error('');
        console.error('Classes: false_positive, false_negative, bad_hint, agent_fault');
        process.exit(1);
      }

      const entry = ledger.recordManual({
        app,
        goal,
        verifyPassed: cls === 'false_positive',
        failedGate: gate,
        classification: cls as FaultClassification,
        reason,
        notes,
      });

      console.log(`Logged: ${entry.id}`);
      console.log(`  ${entry.classification}: ${entry.goal}`);
      break;
    }

    case 'classify': {
      // Reclassify: npx verify faults classify <id> --class=false_positive --reason="Z"
      const id = args[2];
      const cls = args.find(a => a.startsWith('--class='))?.split('=')[1];
      const reason = args.find(a => a.startsWith('--reason='))?.split('=')[1];

      if (!id || !cls || !reason) {
        console.error('Usage: npx @sovereign-labs/verify faults classify <id> --class=false_positive --reason="Z"');
        process.exit(1);
      }

      const updated = ledger.reclassify(id, cls as FaultClassification, reason);
      if (!updated) {
        console.error(`Fault ${id} not found.`);
        process.exit(1);
      }

      console.log(`Reclassified: ${updated.id} → ${updated.classification}`);
      break;
    }

    case 'link': {
      // Link to scenario: npx verify faults link <id> --scenario=A11
      const id = args[2];
      const scenarioId = args.find(a => a.startsWith('--scenario='))?.split('=')[1];

      if (!id || !scenarioId) {
        console.error('Usage: npx @sovereign-labs/verify faults link <id> --scenario=A11');
        process.exit(1);
      }

      const updated = ledger.linkScenario(id, scenarioId);
      if (!updated) {
        console.error(`Fault ${id} not found.`);
        process.exit(1);
      }

      console.log(`Linked: ${updated.id} → scenario ${scenarioId}`);
      console.log('The improve loop will now guard this scenario.');
      break;
    }

    default:
      console.error(`Unknown faults subcommand: ${subcommand}`);
      console.error('Available: list, inbox, review, summary, log, classify, link');
      process.exit(1);
  }
}

function printVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    console.log(pkg.version);
  } catch {
    console.log('unknown');
  }
}

function printHelp() {
  console.log(`
@sovereign-labs/verify — Verification gate for AI-generated code

Commands:
  init              Create .verify/ with example check.json
  check [file]      Run verification (default: .verify/check.json)
  ground [dir]      Print grounding context (CSS, HTML, routes)
  doctor            Check Docker + Playwright availability
  self-test         Run the verification harness (56 scenarios, 7 families)
  faults            Manage the gate fault ledger (discovered verify bugs)

Options:
  --json            Output full result as JSON
  --quiet, -q       Suppress gate logs
  --diff            Read edits from stdin as unified diff

Self-test options:
  --families=A,B,G  Run specific families only
  --docker          Enable Docker scenarios (Family F)
  --fail-on-bug     Exit 1 on bug-severity violations

Fault ledger subcommands:
  faults list       All faults (--filter=false_positive, --app=myapp)
  faults inbox      Unencoded faults waiting for scenarios
  faults review     Faults needing human classification
  faults summary    Statistics overview
  faults log        Record a fault manually (--app, --goal, --class, --reason)
  faults classify   Reclassify a fault (faults classify <id> --class=X --reason=Y)
  faults link       Link fault to scenario (faults link <id> --scenario=A11)

Examples:
  npx @sovereign-labs/verify init
  npx @sovereign-labs/verify check
  npx @sovereign-labs/verify check my-check.json --json
  git diff | npx @sovereign-labs/verify check --diff
  npx @sovereign-labs/verify ground ./my-app
  npx @sovereign-labs/verify doctor
  npx @sovereign-labs/verify self-test
  npx @sovereign-labs/verify self-test --families=A,B --fail-on-bug
  npx @sovereign-labs/verify faults inbox
  npx @sovereign-labs/verify faults log --app=myapp --goal="change color" --class=false_positive --reason="health 500"
`);
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
