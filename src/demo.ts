/**
 * Demo Suite — Three scenarios that tell the verify story.
 * ========================================================
 *
 * Each demo answers three questions:
 *   1. What costly failure did you stop?
 *   2. Why would my current stack miss it?
 *   3. Why does the system get better after the miss?
 *
 * Uses real govern() with real gates, real K5, real grounding.
 * No Docker. No network. Pure tier only. Completes in <5 seconds.
 */

import { govern } from './govern.js';
import type { GovernAgent, GovernResult, GovernContext } from './govern.js';
import { join, resolve, dirname } from 'path';
import { mkdirSync, rmSync, cpSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

// =============================================================================
// TERMINAL COLORS
// =============================================================================

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';

function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }

function header(title: string) {
  const line = '\u2550'.repeat(56);
  console.log(`\n${BOLD}${line}${RESET}`);
  console.log(`${BOLD}  ${title}${RESET}`);
  console.log(`${BOLD}${line}${RESET}\n`);
}

// =============================================================================
// SHARED HELPERS
// =============================================================================

/** Suppress all console.log during govern() — we render post-facto. */
function suppressLogs(): () => void {
  const original = console.log;
  console.log = () => {};
  return () => { console.log = original; };
}

/** Create a temp copy of demo-app so demos don't pollute the fixture. */
function makeTempApp(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const fixtureDir = resolve(__dirname, '..', 'fixtures', 'demo-app');

  const tempDir = join(tmpdir(), `verify-demo-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  cpSync(fixtureDir, tempDir, { recursive: true });
  return tempDir;
}

function cleanup(tempDir: string) {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

function printWithout(lines: string[]) {
  console.log(`${DIM}WITHOUT verify:${RESET}`);
  for (const line of lines) {
    console.log(`  ${DIM}${line}${RESET}`);
  }
}

function printWhyMissed(lines: string[]) {
  console.log(`\n  ${YELLOW}Why your stack missed this:${RESET}`);
  for (const line of lines) {
    console.log(`  ${DIM}${line}${RESET}`);
  }
}

function printAuditTrail(result: GovernResult) {
  const final = result.finalResult;
  const gateStr = final.gates
    .map(g => `${g.gate}${g.passed ? green('\u2713') : red('\u2717')}`)
    .join(' ');

  console.log(`\n  ${DIM}Audit trail:${RESET}`);
  console.log(`  ${DIM}\u251c${RESET} Attestation: ${result.success ? green('VERIFIED') : red('FAILED')} \u2014 ${gateStr} ${dim(`(${final.gates.length} checks)`)}`);

  if (result.receipt.constraintsSeeded.length > 0) {
    console.log(`  ${DIM}\u251c${RESET} Banned: ${result.receipt.constraintsSeeded.map(c => red(c)).join(', ')}`);
  }

  const constraintCount = result.receipt.constraintsActive;
  if (constraintCount > 0) {
    console.log(`  ${DIM}\u251c${RESET} Constraint: future attempts cannot repeat banned patterns`);
    console.log(`  ${DIM}\u2514${RESET} K5 store: ${constraintCount} constraint${constraintCount > 1 ? 's' : ''} active \u2014 search space reduced`);
  } else {
    console.log(`  ${DIM}\u2514${RESET} Converged in ${result.attempts} attempt${result.attempts > 1 ? 's' : ''}`);
  }
}

// =============================================================================
// DEMO E: "The Agent Said Done" — THE HOOK
// =============================================================================

async function runDemoLiar() {
  header('The Agent Said Done');

  console.log(`${DIM}Goal: "Write the weekly report and save to reports/weekly.md"${RESET}\n`);

  // --- WITHOUT ---
  printWithout([
    'Agent: "Report saved successfully. \u2713"',
    '\u2192 File reports/weekly.md does not exist.',
    '\u2192 Next workflow stage triggers on false evidence.',
    '\u2192 Nobody noticed.',
  ]);

  console.log(`\n${CYAN}WITH verify:${RESET}\n`);

  // --- Run govern() silently ---
  const tempDir = makeTempApp();
  const stateDir = join(tempDir, '.verify-demo');
  mkdirSync(stateDir, { recursive: true });

  const agent: GovernAgent = {
    plan: async (_goal: string, ctx: GovernContext) => {
      if (ctx.attempt === 1) {
        return {
          edits: [],
          predicates: [{ type: 'filesystem_exists' as const, file: 'reports/weekly.md', description: 'Weekly report exists' }],
        };
      }
      return {
        edits: [{
          file: 'reports/weekly.md',
          search: '',
          replace: '# Weekly Report\n\nAll tasks completed.\n\n- Feature A: shipped\n- Bug B: fixed\n- Review C: approved\n',
        }],
        predicates: [{ type: 'filesystem_exists' as const, file: 'reports/weekly.md', description: 'Weekly report exists' }],
      };
    },
  };

  const restore = suppressLogs();
  const result = await govern({
    appDir: tempDir,
    goal: 'Write the weekly report and save to reports/weekly.md',
    agent,
    maxAttempts: 3,
    stateDir,
    gates: { grounding: false, staging: false, browser: false, http: false, vision: false, invariants: false },
  });
  restore();

  // --- Render attempt 1 ---
  console.log(`  ${bold('Attempt 1:')}`);
  console.log(`  ${dim('Agent claims: "Report saved successfully."')}`);
  if (result.history.length > 0 && !result.history[0].success) {
    const first = result.history[0];
    const failedGate = first.gates.find(g => !g.passed);
    console.log(`  ${red('\u2717')} ${failedGate?.detail || 'File reports/weekly.md does not exist.'}`);
    console.log(`    ${dim('The agent claimed it wrote the file. It didn\'t.')}`);
    console.log(`  \u2192 ${dim('Remembered: can\'t claim success without evidence.')}`);

    printWhyMissed([
      'The agent framework accepted the completion message at face value.',
      'A unit test wouldn\'t catch this \u2014 nothing asserted the artifact existed.',
    ]);
  }

  // --- Render attempt 2 ---
  if (result.success && result.attempts >= 2) {
    console.log(`\n  ${bold('Attempt 2:')}`);
    console.log(`  ${dim('Agent actually creates reports/weekly.md with content.')}`);
    console.log(`  ${green('\u2713')} Converged in ${result.attempts} attempts.`);
    printAuditTrail(result);
  }

  console.log(`\n${bold('Verify does not trust status messages. It checks reality.')}`);
  cleanup(tempDir);
}

// =============================================================================
// DEMO A: "Wrong World Model" — THE ENGINE
// =============================================================================

async function runDemoWorld() {
  header('Wrong World Model');

  console.log(`${DIM}Goal: "Add a profile section to the about page"${RESET}\n`);

  // --- WITHOUT ---
  printWithout([
    'Agent: "Added profile section using .profile-nav selector. \u2713"',
    '\u2192 .profile-nav doesn\'t exist in the codebase.',
    '\u2192 CSS rule targets nothing. Page unchanged.',
    '\u2192 Agent reported success.',
  ]);

  console.log(`\n${CYAN}WITH verify:${RESET}\n`);

  // --- Run govern() silently ---
  const tempDir = makeTempApp();
  const stateDir = join(tempDir, '.verify-demo');
  mkdirSync(stateDir, { recursive: true });

  const agent: GovernAgent = {
    plan: async (_goal: string, ctx: GovernContext) => {
      if (ctx.attempt === 1) {
        // Agent edits the hero section but claims .profile-nav exists
        // The edit doesn't create .profile-nav — the predicate is fabricated
        return {
          edits: [{
            file: 'server.js',
            search: '.hero { background: #3498db;',
            replace: '.hero { background: #2c3e50;',
          }],
          predicates: [{
            type: 'css' as const,
            selector: '.profile-nav',
            property: 'color',
            expected: '#2c3e50',
            path: '/about',
            description: 'Profile nav section styled',
          }],
        };
      }
      // Attempt 2: use a real selector that actually exists
      return {
        edits: [{
          file: 'server.js',
          search: 'a.nav-link { color: #0066cc; margin-right: 1rem; }',
          replace: 'a.nav-link { color: #0066cc; margin-right: 1rem; font-weight: bold; }',
        }],
        predicates: [{
          type: 'css' as const,
          selector: 'a.nav-link',
          property: 'font-weight',
          expected: 'bold',
          path: '/about',
          description: 'Nav links bold for profile section',
        }],
      };
    },
  };

  const restore = suppressLogs();
  const result = await govern({
    appDir: tempDir,
    goal: 'Add a profile section to the about page',
    agent,
    maxAttempts: 3,
    stateDir,
    gates: { staging: false, browser: false, http: false, vision: false, invariants: false },
  });
  restore();

  // --- Render attempt 1 ---
  console.log(`  ${bold('Attempt 1:')}`);
  console.log(`  ${dim('Agent uses selector .profile-nav')}`);
  if (result.history.length > 0 && !result.history[0].success) {
    console.log(`  ${red('\u2717')} That selector doesn't exist in your code.`);
    console.log(`    ${dim('Reality: .hero, .card, .nav-link, .team-list, .badge')}`);
    console.log(`  \u2192 ${dim('.profile-nav permanently banned. Search space narrowed.')}`);

    printWhyMissed([
      'A linter would not flag this \u2014 the CSS is syntactically valid.',
      'The agent framework saw valid code and called it done.',
    ]);
  }

  // --- Render attempt 2 ---
  if (result.success && result.attempts >= 2) {
    console.log(`\n  ${bold('Attempt 2:')}`);
    console.log(`  ${dim('Agent uses .nav-link \u2014 exists in reality.')}`);
    console.log(`  ${green('\u2713')} Converged in ${result.attempts} attempts.`);
    printAuditTrail(result);
  }

  console.log(`\n${bold('The agent planned against a world that doesn\'t exist. Verify forced it into the real one.')}`);
  cleanup(tempDir);
}

// =============================================================================
// DEMO B: "The Silent Drift" — THE CLOSER
// =============================================================================

async function runDemoDrift() {
  header('The Silent Drift');

  console.log(`${DIM}Goal: "Change the hero background to navy"${RESET}\n`);

  // --- WITHOUT ---
  printWithout([
    'Agent: "Updated hero section as requested. \u2713"',
    '\u2192 Hero background changed to navy. Looks correct.',
    '\u2192 Agent also modified config.json features and settings.',
    '\u2192 App works. Tests pass. Change ships.',
    '\u2192 Config breaks 3 days later. Nobody connects it to the hero change.',
  ]);

  console.log(`\n${CYAN}WITH verify:${RESET}\n`);

  // --- Run govern() silently ---
  const tempDir = makeTempApp();
  const stateDir = join(tempDir, '.verify-demo');
  mkdirSync(stateDir, { recursive: true });

  // Hash config.json before edits — used by filesystem_unchanged predicate
  const configHash = createHash('sha256')
    .update(readFileSync(join(tempDir, 'config.json')))
    .digest('hex');

  const agent: GovernAgent = {
    plan: async (_goal: string, ctx: GovernContext) => {
      if (ctx.attempt === 1) {
        // Agent changes hero AND silently modifies config.json
        // filesystem_unchanged predicate catches the undeclared drift
        return {
          edits: [
            {
              file: 'server.js',
              search: '.hero { background: #3498db; color: white; padding: 2rem; border-radius: 8px; }',
              replace: '.hero { background: #001f3f; color: white; padding: 2rem; border-radius: 8px; }',
            },
            {
              file: 'config.json',
              search: '"darkMode": true',
              replace: '"darkMode": false',
            },
            {
              file: 'config.json',
              search: '"analytics": false',
              replace: '"analytics": true',
            },
          ],
          predicates: [
            {
              type: 'css' as const,
              selector: '.hero',
              property: 'background',
              expected: '#001f3f',
              path: '/about',
              description: 'Hero background is navy',
            },
            {
              type: 'filesystem_unchanged' as const,
              file: 'config.json',
              hash: configHash,
              description: 'Config file unchanged',
            },
          ],
        };
      }
      // Attempt 2: only the declared change, no config drift
      return {
        edits: [{
          file: 'server.js',
          search: '.hero { background: #3498db; color: white; padding: 2rem; border-radius: 8px; }',
          replace: '.hero { background: #001f3f; color: white; padding: 2rem; border-radius: 8px; }',
        }],
        predicates: [{
          type: 'css' as const,
          selector: '.hero',
          property: 'background',
          expected: '#001f3f',
          path: '/about',
          description: 'Hero background is navy',
        }],
      };
    },
  };

  const restore = suppressLogs();
  const result = await govern({
    appDir: tempDir,
    goal: 'Change the hero background to navy',
    agent,
    maxAttempts: 3,
    stateDir,
    gates: { constraints: false, staging: false, browser: false, http: false, vision: false, invariants: false },
  });
  restore();

  // --- Render attempt 1 ---
  console.log(`  ${bold('Attempt 1:')}`);
  console.log(`  ${dim('Agent edits server.js \u2014 changes hero background.')}`);
  console.log(`  ${dim('Agent also modifies config.json features and settings.')}`);

  if (result.history.length > 0 && !result.history[0].success) {
    const first = result.history[0];
    const failedGate = first.gates.find(g => !g.passed);

    console.log(`  ${red('\u2717')} Your edit changed 3 files but only declared changes to 1.`);
    console.log(`    ${dim('Declared: server.js (.hero background)')}`);
    console.log(`    ${dim('Undeclared: config.json (darkMode flag), config.json (analytics flag)')}`);
    console.log(`    ${dim('These changes were not in your predicates.')}`);
    if (failedGate) {
      console.log(`  ${red('\u2717')} ${failedGate.detail}`);
    }
    console.log(`  \u2192 ${dim('Remembered: edits must match declarations.')}`);

    printWhyMissed([
      'The visible task succeeded. Tests pass \u2014 they don\'t test config consistency.',
      'Code review might catch it. At 3 AM on an auto-deploy, it won\'t.',
    ]);
  }

  // --- Render attempt 2 ---
  if (result.success && result.attempts >= 2) {
    console.log(`\n  ${bold('Attempt 2:')}`);
    console.log(`  ${dim('Agent edits only server.js \u2014 hero background only.')}`);
    console.log(`  ${green('\u2713')} Converged in ${result.attempts} attempts.`);
    printAuditTrail(result);
  }

  console.log(`\n${bold('The most dangerous agent failures are the ones that look like success.')}`);
  cleanup(tempDir);
}

// =============================================================================
// EXPORTS
// =============================================================================

export type DemoScenario = 'liar' | 'world' | 'drift';

export async function runDemo(scenario: DemoScenario) {
  switch (scenario) {
    case 'liar':
      return runDemoLiar();
    case 'world':
      return runDemoWorld();
    case 'drift':
      return runDemoDrift();
    default:
      console.error(`Unknown demo scenario: ${scenario}`);
      console.error('Available: liar, world, drift');
      process.exit(1);
  }
}
