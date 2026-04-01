#!/usr/bin/env bun
/**
 * Fixture Auditor — What can't demo-app test?
 * =============================================
 *
 * Reads each gate's source to identify string patterns it checks for.
 * Then searches fixtures/demo-app/ for those patterns.
 * When a gate checks for something that doesn't exist in demo-app,
 * that's a fixture gap — the gate can't be meaningfully tested.
 *
 * Informational only. Does NOT modify demo-app.
 *
 * Output: data/fixture-gaps.json
 *
 * Usage:
 *   bun scripts/harness/fixture-auditor.ts
 *   bun scripts/harness/fixture-auditor.ts --gate=observation
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const PKG_ROOT = resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);

const gatesDir = resolve(PKG_ROOT, 'src', 'gates');
const appDir = resolve(PKG_ROOT, 'fixtures', 'demo-app');
const outputPath = resolve(PKG_ROOT, 'data', 'fixture-gaps.json');
const gateFilter = args.find(a => a.startsWith('--gate='))?.split('=')[1];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureGap {
  gate: string;
  requires: string;
  line: number;
  type: 'string_match' | 'regex_pattern';
  fixtureHas: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract patterns from gate source
// ─────────────────────────────────────────────────────────────────────────────

/** Extract string literals from .includes('...') and .indexOf('...') calls. */
function extractStringMatches(source: string): Array<{ pattern: string; line: number }> {
  const results: Array<{ pattern: string; line: number }> = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match .includes('...') or .includes("...")
    const includesMatches = line.matchAll(/\.includes\(\s*['"]([^'"]{3,})['"]|\.indexOf\(\s*['"]([^'"]{3,})['"]/g);
    for (const m of includesMatches) {
      const pattern = m[1] || m[2];
      if (pattern && !isBoilerplate(pattern)) {
        results.push({ pattern, line: i + 1 });
      }
    }
  }
  return results;
}

/** Filter out boilerplate/implementation patterns that aren't fixture-dependent. */
function isBoilerplate(pattern: string): boolean {
  // Skip internal implementation strings
  const skip = [
    'function', 'return', 'const ', 'let ', 'var ', 'import', 'export',
    'true', 'false', 'null', 'undefined',
    '.ts', '.js', 'node_modules', 'package.json',
    'passed', 'failed', 'error', 'warning',
    'Content-Type', 'text/html', 'application/json',
  ];
  return skip.some(s => pattern === s || pattern.startsWith('//'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Search demo-app for patterns
// ─────────────────────────────────────────────────────────────────────────────

let appContentCache: string | null = null;

/** Get all demo-app file contents concatenated (for pattern searching). */
function getAppContent(): string {
  if (appContentCache) return appContentCache;
  const parts: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.verify', '.verify-demo', 'node_modules', '.git', '.sovereign'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop();
        if (['js', 'ts', 'json', 'yml', 'yaml', 'sql', 'env', 'html', 'css', 'md', 'txt', 'cfg', 'conf'].includes(ext || '')) {
          try {
            parts.push(readFileSync(full, 'utf-8'));
          } catch {}
        }
      }
    }
  }

  walk(appDir);
  appContentCache = parts.join('\n');
  return appContentCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Fixture Auditor ===');
console.log(`Gates: ${gatesDir}`);
console.log(`App: ${appDir}\n`);

const allGaps: FixtureGap[] = [];
const appContent = getAppContent();

const gateFiles = readdirSync(gatesDir).filter(f => f.endsWith('.ts'));

for (const gateFile of gateFiles) {
  const gateName = gateFile.replace('.ts', '');
  if (gateFilter && gateName !== gateFilter) continue;

  const source = readFileSync(join(gatesDir, gateFile), 'utf-8');
  const stringMatches = extractStringMatches(source);

  const gaps: FixtureGap[] = [];
  const present: string[] = [];

  for (const { pattern, line } of stringMatches) {
    const found = appContent.includes(pattern);
    if (!found) {
      gaps.push({ gate: gateName, requires: pattern, line, type: 'string_match', fixtureHas: false });
    } else {
      present.push(pattern);
    }
  }

  if (gaps.length > 0 || present.length > 0) {
    const total = gaps.length + present.length;
    console.log(`  ${gateName}: ${gaps.length} missing / ${total} patterns checked`);
    for (const g of gaps.slice(0, 5)) {
      console.log(`    ${'\u2717'} "${g.requires}" (line ${g.line})`);
    }
    if (gaps.length > 5) console.log(`    ... and ${gaps.length - 5} more`);
  }

  allGaps.push(...gaps);
}

// Write report
mkdirSync(resolve(PKG_ROOT, 'data'), { recursive: true });
writeFileSync(outputPath, JSON.stringify(allGaps, null, 2) + '\n');

// Summary
const byGate: Record<string, number> = {};
for (const g of allGaps) {
  byGate[g.gate] = (byGate[g.gate] || 0) + 1;
}

console.log(`\n  Total fixture gaps: ${allGaps.length}`);
if (allGaps.length > 0) {
  console.log('  By gate:');
  for (const [gate, count] of Object.entries(byGate).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count.toString().padStart(4)} ${gate}`);
  }
}
console.log(`\n  Report: ${outputPath}`);
