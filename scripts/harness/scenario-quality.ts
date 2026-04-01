#!/usr/bin/env bun
/**
 * Scenario Quality Monitor — Pre-flight stale data detection
 * ============================================================
 *
 * Runs BEFORE self-test. Reads every scenario in fixtures/scenarios/.
 * For each scenario, checks:
 *
 *   1. Does edit.search still exist in the target demo-app file?
 *   2. Does the predicate reference a file that exists in demo-app?
 *   3. Is expectedFailedGate a valid gate name?
 *
 * Output: data/stale-scenarios.json
 *
 * Usage:
 *   bun scripts/harness/scenario-quality.ts                   # report only
 *   bun scripts/harness/scenario-quality.ts --fix              # auto-fix stale expectations
 *   bun scripts/harness/scenario-quality.ts --app-dir=./path   # custom app dir
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const PKG_ROOT = resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);

const appDirArg = args.find(a => a.startsWith('--app-dir='))?.split('=')[1];
const appDir = appDirArg ? resolve(appDirArg) : resolve(PKG_ROOT, 'fixtures', 'demo-app');
const scenarioDir = resolve(PKG_ROOT, 'fixtures', 'scenarios');
const outputPath = resolve(PKG_ROOT, 'data', 'stale-scenarios.json');
const autoFix = args.includes('--fix');

// Valid gate names — read from src/gates/*.ts
const gatesDir = resolve(PKG_ROOT, 'src', 'gates');
const validGates = new Set(
  readdirSync(gatesDir)
    .filter(f => f.endsWith('.ts'))
    .map(f => f.replace('.ts', ''))
);
// Add composite gate names that don't map 1:1 to files
validGates.add('F9');
validGates.add('K5');
validGates.add('G5');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StaleEntry {
  file: string;
  scenarioId: string;
  reason: string;
  editFile?: string;
  searchPreview?: string;
}

interface Scenario {
  id: string;
  description?: string;
  edits: Array<{ file: string; search: string; replace: string }>;
  predicates: Array<Record<string, any>>;
  expectedSuccess: boolean;
  expectedFailedGate?: string;
  tags?: string[];
  [key: string]: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// File cache — avoid re-reading demo-app files for every scenario
// ─────────────────────────────────────────────────────────────────────────────

const fileCache = new Map<string, string | null>();

function readAppFile(relPath: string): string | null {
  if (fileCache.has(relPath)) return fileCache.get(relPath)!;
  const fullPath = join(appDir, relPath);
  if (!existsSync(fullPath)) {
    fileCache.set(relPath, null);
    return null;
  }
  const content = readFileSync(fullPath, 'utf-8');
  fileCache.set(relPath, content);
  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quality checks
// ─────────────────────────────────────────────────────────────────────────────

function checkScenario(scenario: Scenario, fileName: string): StaleEntry[] {
  if (!scenario || !scenario.id) return [];
  const issues: StaleEntry[] = [];

  // Check 1: Do edit search strings exist in demo-app?
  for (const edit of (scenario.edits || [])) {
    if (!edit.search) continue; // empty search = file creation, valid
    const content = readAppFile(edit.file);
    if (content === null) {
      issues.push({
        file: fileName,
        scenarioId: scenario.id,
        reason: `edit targets nonexistent file: ${edit.file}`,
        editFile: edit.file,
      });
    } else if (content.indexOf(edit.search) === -1) {
      issues.push({
        file: fileName,
        scenarioId: scenario.id,
        reason: 'search string not found in ' + edit.file,
        editFile: edit.file,
        searchPreview: edit.search.substring(0, 80),
      });
    }
  }

  // Check 2: Do predicates reference files that exist?
  for (const pred of (scenario.predicates || [])) {
    if (pred.file && pred.type !== 'filesystem_exists' && pred.type !== 'filesystem_absent') {
      const content = readAppFile(pred.file);
      if (content === null) {
        issues.push({
          file: fileName,
          scenarioId: scenario.id,
          reason: `predicate references nonexistent file: ${pred.file}`,
        });
      }
    }
  }

  // Check 3: Is expectedFailedGate valid?
  if (scenario.expectedFailedGate) {
    const gateName = scenario.expectedFailedGate.toLowerCase();
    if (!validGates.has(scenario.expectedFailedGate) && !validGates.has(gateName)) {
      issues.push({
        file: fileName,
        scenarioId: scenario.id,
        reason: `expectedFailedGate "${scenario.expectedFailedGate}" is not a valid gate`,
      });
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Scenario Quality Monitor ===');
console.log(`App dir: ${appDir}`);
console.log(`Scenarios: ${scenarioDir}\n`);

const allIssues: StaleEntry[] = [];
let totalScenarios = 0;
let filesChecked = 0;
let fixedCount = 0;

for (const fileName of readdirSync(scenarioDir)) {
  if (!fileName.endsWith('.json')) continue;
  filesChecked++;

  const filePath = join(scenarioDir, fileName);
  let data: any;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    console.log(`  SKIP ${fileName} (invalid JSON)`);
    continue;
  }

  const scenarios: Scenario[] = Array.isArray(data) ? data : (data.scenarios || []);
  totalScenarios += scenarios.length;

  const fileIssues: StaleEntry[] = [];
  for (const scenario of scenarios) {
    const issues = checkScenario(scenario, fileName);
    fileIssues.push(...issues);
  }

  if (fileIssues.length > 0) {
    allIssues.push(...fileIssues);

    // Auto-fix: scenarios with stale search strings that expect success → flip to expect failure
    if (autoFix) {
      let modified = false;
      for (const scenario of scenarios) {
        const staleSearch = fileIssues.find(
          i => i.scenarioId === scenario.id && i.reason.startsWith('search string not found')
        );
        if (staleSearch && scenario.expectedSuccess === true) {
          scenario.expectedSuccess = false;
          if (!scenario.expectedFailedGate) scenario.expectedFailedGate = 'F9';
          fixedCount++;
          modified = true;
        }
      }
      if (modified) {
        writeFileSync(filePath, JSON.stringify(Array.isArray(data) ? scenarios : { ...data, scenarios }, null, 2) + '\n');
      }
    }
  }
}

// Write report
const { mkdirSync } = await import('fs');
mkdirSync(resolve(PKG_ROOT, 'data'), { recursive: true });
writeFileSync(outputPath, JSON.stringify(allIssues, null, 2) + '\n');

// Summary
const byReason: Record<string, number> = {};
for (const issue of allIssues) {
  const key = issue.reason.split(':')[0].split(' in ')[0];
  byReason[key] = (byReason[key] || 0) + 1;
}

console.log(`  Files checked: ${filesChecked}`);
console.log(`  Scenarios checked: ${totalScenarios}`);
console.log(`  Issues found: ${allIssues.length}`);
if (allIssues.length > 0) {
  console.log('');
  for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count}x ${reason}`);
  }
}
if (autoFix && fixedCount > 0) {
  console.log(`\n  Auto-fixed: ${fixedCount} scenarios (expectedSuccess flipped to false)`);
}
console.log(`\n  Report: ${outputPath}`);
