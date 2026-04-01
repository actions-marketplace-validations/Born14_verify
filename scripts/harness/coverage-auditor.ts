#!/usr/bin/env bun
/**
 * Coverage Auditor — Gate code paths vs scenario coverage
 * =========================================================
 *
 * Advisory only. Reads each gate source file in src/gates/*.ts.
 * Extracts testable patterns (regex, string matches, switch/case branches,
 * named check functions). Cross-references against existing scenarios.
 *
 * Does NOT drive scenario generation. Reports suspicious blind spots
 * for the operator to review in the nightly report.
 *
 * Output: data/coverage-gaps.json
 *
 * Usage:
 *   bun scripts/harness/coverage-auditor.ts                 # audit all gates
 *   bun scripts/harness/coverage-auditor.ts --gate=capacity  # audit one gate
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const PKG_ROOT = resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);

const gatesDir = resolve(PKG_ROOT, 'src', 'gates');
const scenarioDir = resolve(PKG_ROOT, 'fixtures', 'scenarios');
const outputPath = resolve(PKG_ROOT, 'data', 'coverage-gaps.json');
const gateFilter = args.find(a => a.startsWith('--gate='))?.split('=')[1];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CoverageGap {
  gate: string;
  file: string;
  line: number;
  pattern: string;
  type: 'switch_case' | 'string_match' | 'regex_pattern' | 'named_function';
  scenarioCount: number;
  gateLOC: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract testable patterns from gate source
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedPattern {
  pattern: string;
  line: number;
  type: CoverageGap['type'];
}

function extractPatterns(source: string): ExtractedPattern[] {
  const results: ExtractedPattern[] = [];
  const lines = source.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Switch/case branches: case 'unbounded_query':
    const caseMatch = line.match(/case\s+['"]([a-z_]+)['"]\s*:/);
    if (caseMatch && !seen.has(caseMatch[1])) {
      seen.add(caseMatch[1]);
      results.push({ pattern: caseMatch[1], line: i + 1, type: 'switch_case' });
    }

    // String match patterns: .includes('docker stats') or .indexOf('SELECT')
    const includesMatches = [...line.matchAll(/\.(?:includes|indexOf)\(\s*['"]([^'"]{4,50})['"]/g)];
    for (const m of includesMatches) {
      const pat = m[1];
      if (pat && !seen.has(pat) && !isImplementationNoise(pat)) {
        seen.add(pat);
        results.push({ pattern: pat, line: i + 1, type: 'string_match' });
      }
    }

    // Regex patterns: /pattern/gi or new RegExp('pattern')
    const regexLiteral = line.match(/\/([^/]{4,60})\/[gimsy]*/);
    if (regexLiteral && !seen.has(regexLiteral[1]) && !isImplementationNoise(regexLiteral[1])) {
      seen.add(regexLiteral[1]);
      results.push({ pattern: regexLiteral[1], line: i + 1, type: 'regex_pattern' });
    }

    const regexConstructor = line.match(/new\s+RegExp\(\s*['"]([^'"]{4,60})['"]/);
    if (regexConstructor && !seen.has(regexConstructor[1]) && !isImplementationNoise(regexConstructor[1])) {
      seen.add(regexConstructor[1]);
      results.push({ pattern: regexConstructor[1], line: i + 1, type: 'regex_pattern' });
    }

    // Named check functions: function checkFormLabels, function scanSQLInjection
    const funcMatch = line.match(/function\s+(check[A-Z]\w+|scan[A-Z]\w+|detect[A-Z]\w+|validate[A-Z]\w+)\s*\(/);
    if (funcMatch && !seen.has(funcMatch[1])) {
      seen.add(funcMatch[1]);
      results.push({ pattern: funcMatch[1], line: i + 1, type: 'named_function' });
    }
  }

  return results;
}

/** Filter out patterns that are implementation plumbing, not failure-mode detection. */
function isImplementationNoise(pattern: string): boolean {
  const noise = [
    'function', 'return', 'const', 'import', 'export', 'require',
    'string', 'number', 'boolean', 'object', 'undefined', 'null',
    'true', 'false', 'length', 'push', 'filter', 'map',
    'error', 'Error', 'throw', 'catch', 'finally',
    '\\s', '\\d', '\\w', '\\b',  // common regex atoms
  ];
  if (noise.some(n => pattern === n)) return true;
  // Skip patterns that are just regex syntax fragments
  if (/^[\\.\\[\]\\(\\)\\+\\*\\?\\|]+$/.test(pattern)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load all scenario text for cross-referencing
// ─────────────────────────────────────────────────────────────────────────────

let scenarioCorpus: string | null = null;

function getScenarioCorpus(): string {
  if (scenarioCorpus) return scenarioCorpus;
  const parts: string[] = [];
  for (const f of readdirSync(scenarioDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      parts.push(readFileSync(join(scenarioDir, f), 'utf-8'));
    } catch {}
  }
  scenarioCorpus = parts.join('\n').toLowerCase();
  return scenarioCorpus;
}

/** Count how many times a pattern appears in scenario corpus (approximate). */
function countScenarioMentions(pattern: string): number {
  const corpus = getScenarioCorpus();
  const needle = pattern.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = corpus.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Coverage Auditor ===');
console.log(`Gates: ${gatesDir}`);
console.log(`Scenarios: ${scenarioDir}\n`);

const allGaps: CoverageGap[] = [];
const gateFiles = readdirSync(gatesDir).filter(f => f.endsWith('.ts'));

for (const gateFile of gateFiles) {
  const gateName = gateFile.replace('.ts', '');
  if (gateFilter && gateName !== gateFilter) continue;

  const filePath = join(gatesDir, gateFile);
  const source = readFileSync(filePath, 'utf-8');
  const loc = source.split('\n').length;
  const patterns = extractPatterns(source);

  if (patterns.length === 0) continue;

  let zeroCount = 0;
  for (const p of patterns) {
    const mentions = countScenarioMentions(p.pattern);
    if (mentions === 0) {
      zeroCount++;
      allGaps.push({
        gate: gateName,
        file: `src/gates/${gateFile}`,
        line: p.line,
        pattern: p.pattern,
        type: p.type,
        scenarioCount: 0,
        gateLOC: loc,
      });
    }
  }

  if (zeroCount > 0) {
    console.log(`  ${gateName} (${loc} LOC): ${zeroCount} untested / ${patterns.length} patterns`);
    const gaps = allGaps.filter(g => g.gate === gateName).slice(-3);
    for (const g of gaps) {
      console.log(`    0x [${g.type}] "${g.pattern}" (line ${g.line})`);
    }
    if (zeroCount > 3) console.log(`    ... and ${zeroCount - 3} more`);
  }
}

// Sort by gateLOC descending (bigger gates = more likely to have real blind spots)
allGaps.sort((a, b) => b.gateLOC - a.gateLOC);

// Write report
mkdirSync(resolve(PKG_ROOT, 'data'), { recursive: true });
writeFileSync(outputPath, JSON.stringify(allGaps, null, 2) + '\n');

// Summary
const byGate: Record<string, number> = {};
for (const g of allGaps) {
  byGate[g.gate] = (byGate[g.gate] || 0) + 1;
}

console.log(`\n  Total untested patterns: ${allGaps.length}`);
if (allGaps.length > 0) {
  console.log('  By gate (sorted by LOC — bigger gates first):');
  const sorted = Object.entries(byGate).sort((a, b) => {
    const aLoc = allGaps.find(g => g.gate === a[0])?.gateLOC ?? 0;
    const bLoc = allGaps.find(g => g.gate === b[0])?.gateLOC ?? 0;
    return bLoc - aLoc;
  });
  for (const [gate, count] of sorted) {
    const loc = allGaps.find(g => g.gate === gate)?.gateLOC ?? 0;
    console.log(`    ${count.toString().padStart(4)} ${gate} (${loc} LOC)`);
  }
}
console.log(`\n  Report: ${outputPath}`);
