/**
 * Browser Gate — Playwright CSS/HTML Validation
 * ===============================================
 *
 * Runs Playwright in Docker to validate CSS and HTML predicates
 * against the actual rendered page. This catches what file-level
 * parsing misses:
 *
 * - CSS shorthand vs longhand (margin: 10px → margin-top: 10px)
 * - Computed styles after cascade resolution
 * - Dynamic DOM elements
 * - Responsive layout issues
 *
 * Requires: Docker + mcr.microsoft.com/playwright image available.
 * If unavailable, gate is skipped (not failed).
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import type { GateResult, GateContext, Predicate } from '../types.js';

export interface BrowserPredicateResult {
  predicate: Partial<Predicate>;
  path: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  detail: string;
}

export interface BrowserGateResult extends GateResult {
  results: BrowserPredicateResult[];
}

const PLAYWRIGHT_BASE_IMAGE = 'mcr.microsoft.com/playwright:v1.49.0-noble';
const PLAYWRIGHT_IMAGE = 'verify-playwright:latest';
const PER_PATH_TIMEOUT = 10_000;
const TOTAL_TIMEOUT = 30_000;

export async function runBrowserGate(ctx: GateContext): Promise<BrowserGateResult> {
  const start = Date.now();

  const browserPredicates = ctx.predicates.filter(
    p => p.type === 'css' || p.type === 'html'
  );

  if (browserPredicates.length === 0) {
    return {
      gate: 'browser',
      passed: true,
      detail: 'No CSS/HTML predicates to check',
      durationMs: Date.now() - start,
      results: [],
    };
  }

  if (!ctx.appUrl) {
    return {
      gate: 'browser',
      passed: false,
      detail: 'No app URL available — staging gate must run first',
      durationMs: Date.now() - start,
      results: [],
    };
  }

  // Check if Playwright image is available
  const hasPlaywright = await checkPlaywrightImage();
  if (!hasPlaywright) {
    ctx.log('[browser] Playwright image not available — skipping browser gate');
    return {
      gate: 'browser',
      passed: true,
      detail: 'Playwright image not available — build with: docker build -t verify-playwright:latest (see docs)',
      durationMs: Date.now() - start,
      results: [],
    };
  }

  // Group predicates by path
  const pathGroups = new Map<string, Predicate[]>();
  for (const p of browserPredicates) {
    const path = p.path ?? '/';
    if (!pathGroups.has(path)) pathGroups.set(path, []);
    pathGroups.get(path)!.push(p);
  }

  // Cap at 3 paths
  const paths = [...pathGroups.keys()].slice(0, 3);

  // Write input file for browser gate runner
  const workDir = join(ctx.config.appDir, '.verify-tmp');
  mkdirSync(workDir, { recursive: true });

  const input = {
    baseUrl: ctx.appUrl,
    paths: paths.map(path => ({
      path,
      predicates: (pathGroups.get(path) ?? []).map((p, i) => ({
        id: `p${i}`,
        type: p.type,
        selector: p.selector,
        property: p.property,
        // Map expected → operator + value for the runner
        operator: !p.expected || p.expected === 'exists' ? 'exists' : '==',
        value: p.expected === 'exists' ? undefined : p.expected,
        expected: p.expected,
      })),
    })),
    timeout: PER_PATH_TIMEOUT,
  };

  const inputPath = join(workDir, 'browser-gate-input.json');
  const resultsPath = join(workDir, 'browser-gate-results.json');
  writeFileSync(inputPath, JSON.stringify(input, null, 2));

  // Find the browser gate runner
  const runnerPath = findBrowserGateRunner();
  if (!runnerPath) {
    return {
      gate: 'browser',
      passed: true,
      detail: 'Browser gate runner not found — gate skipped',
      durationMs: Date.now() - start,
      results: [],
    };
  }

  // Run Playwright in Docker
  ctx.log(`[browser] Running Playwright against ${paths.length} path(s)...`);

  const exitCode = await runPlaywrightDocker(
    runnerPath, inputPath, resultsPath, workDir, ctx.appUrl, TOTAL_TIMEOUT
  );

  if (exitCode !== 0 || !existsSync(resultsPath)) {
    return {
      gate: 'browser',
      passed: false,
      detail: 'Playwright execution failed',
      durationMs: Date.now() - start,
      results: [],
    };
  }

  // Parse results — runner outputs flat { results: [{id, actual, selector, property}] }
  const rawResults = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  const results: BrowserPredicateResult[] = [];

  for (const r of rawResults.results ?? []) {
    // Match back to the original predicate by id or selector+property
    const pred = browserPredicates.find(p =>
      p.selector === r.selector &&
      (p.property ?? '') === (r.property ?? '')
    );

    const expected = pred?.expected;
    const actual = r.actual;

    // Use runner's `passed` if it computed one (HTML predicates do this).
    // For CSS predicates, runner leaves `passed: undefined` — compute here.
    // If runner returned an error, always fail.
    let passed: boolean;
    if (r.error) {
      passed = false;
    } else if (r.passed !== undefined && r.passed !== null) {
      passed = r.passed;
    } else {
      passed = actual !== undefined && actual !== null && actual !== '(not found)' &&
        (expected === 'exists' || !expected || normalizeColor(actual) === normalizeColor(expected));
    }

    const path = pred?.path ?? '/';
    results.push({
      predicate: pred ?? {},
      path,
      passed,
      expected,
      actual,
      detail: passed
        ? `${r.selector} ${r.property ?? 'exists'}: OK (actual: ${actual})`
        : `${r.selector} ${r.property ?? 'exists'}: expected "${expected}", got "${actual}"`,
    });
  }

  const allPassed = results.length > 0 && results.every(r => r.passed);

  // Cleanup
  try {
    const { rmSync } = require('fs');
    rmSync(workDir, { recursive: true, force: true });
  } catch { /* best effort */ }

  return {
    gate: 'browser',
    passed: allPassed,
    detail: allPassed
      ? `${results.length} browser predicate(s) passed`
      : formatBrowserFailures(results),
    durationMs: Date.now() - start,
    results,
  };
}

function formatBrowserFailures(results: BrowserPredicateResult[]): string {
  const failures = results.filter(r => !r.passed);
  const lines = ['BROWSER GATE FAILED:'];
  lines.push('  Path       Selector     Property          Expected    Actual');
  for (const f of failures) {
    const path = (f.path ?? '/').padEnd(10);
    const selector = (f.predicate.selector ?? '?').padEnd(12);
    const prop = (f.predicate.property ?? '-').padEnd(17);
    const expected = (f.expected ?? '?').padEnd(11);
    const actual = f.actual ?? '?';
    lines.push(`  ${path} ${selector} ${prop} ${expected} ${actual}`);
  }
  return lines.join('\n');
}

function normalizeColor(val: string): string {
  if (!val) return val;
  // Normalize whitespace in rgb/rgba values: rgb(255,102,0) === rgb(255, 102, 0)
  return val.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function checkPlaywrightImage(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['image', 'inspect', PLAYWRIGHT_IMAGE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function findBrowserGateRunner(): string | null {
  // Look in common locations
  const candidates = [
    join(__dirname, '../../fixtures/browser-gate-runner.mjs'),
    join(__dirname, '../../../src/tools/browser-gate-runner.mjs'),
    join(process.cwd(), 'node_modules/@sovereign-labs/verify/fixtures/browser-gate-runner.mjs'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function runPlaywrightDocker(
  runnerPath: string,
  inputPath: string,
  resultsPath: string,
  workDir: string,
  appUrl: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'run', '--rm',
      '--network', 'host',
      '-v', `${runnerPath}:/app/browser-gate-runner.mjs:ro`,
      '-v', `${workDir}:/data`,
      PLAYWRIGHT_IMAGE,
      'node', '/app/browser-gate-runner.mjs',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}
