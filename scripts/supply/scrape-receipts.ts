#!/usr/bin/env node
/**
 * Receipt Scraper — Production Failures → Verify Scenarios
 * ==========================================================
 *
 * Reads MCP proxy receipt ledgers (.governance/receipts.jsonl) and extracts
 * failed tool calls into verify scenarios. Each failed sovereign_submit
 * receipt becomes a scenario that tests whether verify catches the same
 * failure class.
 *
 * Sources:
 *   - .governance-sovereign/receipts.jsonl (governed relay receipts)
 *   - Any path passed via --receipts-path or RECEIPTS_PATH env var
 *
 * Usage:
 *   bun run scripts/supply/scrape-receipts.ts [options]
 *
 * Options:
 *   --receipts-path=PATH   Path to receipts.jsonl (or RECEIPTS_PATH env)
 *   --max-scenarios=50     Maximum scenarios to extract (default: 50)
 *   --since=2026-03-01     Only process receipts after this date
 *   --dry-run              Print extracted scenarios, don't write
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Receipt {
  id: string;
  timestamp: string;
  toolName: string;
  args: Record<string, any>;
  result?: {
    success?: boolean;
    gates?: Array<{ gate: string; passed: boolean; detail?: string }>;
    narrowing?: {
      constraints?: Array<{ signature: string; type: string; reason: string }>;
      matchedBannedFingerprints?: string[];
    };
    attestation?: string;
  };
  mutationType?: 'mutating' | 'readonly';
  hash?: string;
  previousHash?: string;
}

interface Scenario {
  id: string;
  description: string;
  edits: Array<{ file: string; search: string; replace: string }>;
  predicates: Array<Record<string, any>>;
  expectedSuccess: boolean;
  tags: string[];
  rationale: string;
  sourceReceipt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipt Parser
// ─────────────────────────────────────────────────────────────────────────────

function parseReceipts(path: string, since?: string): Receipt[] {
  if (!existsSync(path)) {
    console.log(`  Receipt file not found: ${path}`);
    return [];
  }

  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
  const receipts: Receipt[] = [];

  for (const line of lines) {
    try {
      const receipt = JSON.parse(line) as Receipt;
      if (since && receipt.timestamp < since) continue;
      receipts.push(receipt);
    } catch { /* skip malformed lines */ }
  }

  return receipts;
}

/**
 * Extract failed sovereign_submit receipts into verify scenarios.
 * Each failed submission has: goal, edits, predicates, gate failure details.
 */
function extractSubmissionFailures(receipts: Receipt[]): Scenario[] {
  const scenarios: Scenario[] = [];

  const submissions = receipts.filter(r =>
    r.toolName === 'sovereign_submit' &&
    r.result &&
    r.result.success === false
  );

  for (const receipt of submissions) {
    const args = receipt.args || {};
    const result = receipt.result!;

    // Extract the failed gate
    const failedGate = result.gates?.find(g => !g.passed);
    if (!failedGate) continue;

    // Map receipt data to scenario format
    const edits = (args.edits || []).map((e: any) => ({
      file: e.file || 'server.js',
      search: e.search || '',
      replace: e.replace || '',
    }));

    const predicates = (args.predicates || []).map((p: any) => ({ ...p }));

    if (predicates.length === 0) continue;

    const gateTag = `failed_at_${failedGate.gate.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const signature = result.narrowing?.constraints?.[0]?.signature || 'unknown';

    scenarios.push({
      id: `receipt-${failedGate.gate}-${receipt.id.substring(0, 8)}`,
      description: `[RECEIPT] ${args.goal || 'Unknown goal'} — failed at ${failedGate.gate}: ${failedGate.detail?.substring(0, 100) || 'no detail'}`,
      edits,
      predicates,
      expectedSuccess: false,
      tags: ['receipt', gateTag, `sig_${signature}`, 'false_positive'],
      rationale: `Extracted from production receipt ${receipt.id}. Gate ${failedGate.gate} failed: ${failedGate.detail?.substring(0, 200) || 'unknown'}`,
      sourceReceipt: receipt.id,
    });
  }

  return scenarios;
}

/**
 * Extract failed tool calls (non-submit) that reveal runtime failures.
 * These become scenarios that test whether verify's error handling is correct.
 */
function extractToolFailures(receipts: Receipt[]): Scenario[] {
  const scenarios: Scenario[] = [];

  const failures = receipts.filter(r =>
    r.toolName?.startsWith('sovereign_') &&
    r.toolName !== 'sovereign_submit' &&
    r.mutationType === 'mutating' &&
    r.result &&
    (r.result as any).error
  );

  for (const receipt of failures) {
    const error = (receipt.result as any).error || '';

    // Create a regression guard — verify should handle this error gracefully
    scenarios.push({
      id: `receipt-tool-${receipt.toolName}-${receipt.id.substring(0, 8)}`,
      description: `[RECEIPT:tool] ${receipt.toolName} failed: ${error.substring(0, 100)}`,
      edits: [],
      predicates: [{ type: 'content', file: 'server.js', pattern: 'http' }],
      expectedSuccess: true,
      tags: ['receipt', 'tool_failure', `tool_${receipt.toolName}`, 'regression_guard'],
      rationale: `Tool ${receipt.toolName} failed in production. Error: ${error.substring(0, 200)}. This scenario guards against verify crashing on similar inputs.`,
      sourceReceipt: receipt.id,
    });
  }

  return scenarios;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const maxScenarios = parseInt(args.find(a => a.startsWith('--max-scenarios='))?.split('=')[1] ?? '50');
const since = args.find(a => a.startsWith('--since='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const pkgRoot = resolve(import.meta.dir, '..', '..');

// Find receipt files
const receiptsPath = args.find(a => a.startsWith('--receipts-path='))?.split('=')[1]
  || process.env.RECEIPTS_PATH
  || null;

const defaultPaths = [
  join(pkgRoot, '.governance-sovereign', 'receipts.jsonl'),
  join(pkgRoot, '..', '..', '.governance-sovereign', 'receipts.jsonl'),
];

const receiptPaths = receiptsPath ? [receiptsPath] : defaultPaths.filter(p => existsSync(p));

console.log(`\n═══ Receipt Scraper ═══`);
console.log(`Max scenarios: ${maxScenarios}`);
console.log(`Since: ${since || 'all time'}`);
console.log(`Receipt sources: ${receiptPaths.length > 0 ? receiptPaths.join(', ') : 'none found'}`);
console.log(`Dry run: ${dryRun}\n`);

if (receiptPaths.length === 0) {
  console.log('No receipt files found. Skipping receipt scraping.');
  console.log('Hint: Set RECEIPTS_PATH or --receipts-path to point to a receipts.jsonl file.\n');
  process.exit(0);
}

// Parse all receipts
let allReceipts: Receipt[] = [];
for (const path of receiptPaths) {
  const receipts = parseReceipts(path, since);
  console.log(`  ${path}: ${receipts.length} receipts`);
  allReceipts.push(...receipts);
}

console.log(`Total receipts: ${allReceipts.length}`);

// Extract scenarios
const submissionScenarios = extractSubmissionFailures(allReceipts);
const toolScenarios = extractToolFailures(allReceipts);
const allScenarios = [...submissionScenarios, ...toolScenarios].slice(0, maxScenarios);

console.log(`\nExtracted ${allScenarios.length} scenarios:`);
console.log(`  Submission failures: ${submissionScenarios.length}`);
console.log(`  Tool failures: ${toolScenarios.length}`);

if (dryRun) {
  console.log('\n[DRY RUN] No files written.');
  for (const s of allScenarios.slice(0, 5)) {
    console.log(`  ${s.id}: ${s.description.substring(0, 80)}`);
  }
  if (allScenarios.length > 5) console.log(`  ... and ${allScenarios.length - 5} more`);
} else if (allScenarios.length > 0) {
  const scenariosDir = join(pkgRoot, 'fixtures', 'scenarios');
  mkdirSync(scenariosDir, { recursive: true });
  const outputPath = join(scenariosDir, 'receipt-staged.json');

  // Deduplicate against existing
  let existing: Scenario[] = [];
  if (existsSync(outputPath)) {
    try { existing = JSON.parse(readFileSync(outputPath, 'utf-8')); } catch { /* overwrite */ }
  }
  const existingIds = new Set(existing.map(s => s.id));
  const newScenarios = allScenarios.filter(s => !existingIds.has(s.id));
  const merged = [...existing, ...newScenarios];

  writeFileSync(outputPath, JSON.stringify(merged, null, 2));
  console.log(`\nWrote ${newScenarios.length} new scenarios (${merged.length} total) to ${outputPath}`);

  // Supply log
  const logPath = join(pkgRoot, 'data', 'supply-log.jsonl');
  mkdirSync(join(pkgRoot, 'data'), { recursive: true });
  appendFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'receipt_scraper',
    generated: allScenarios.length,
    new: newScenarios.length,
    submissions: submissionScenarios.length,
    toolFailures: toolScenarios.length,
  }) + '\n');
} else {
  console.log('\nNo scenarios extracted from receipts.');
}

console.log('\nDone.\n');
