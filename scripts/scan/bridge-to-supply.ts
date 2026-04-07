/**
 * Bridge: Scan Loop → Supply Chain
 * ==================================
 *
 * Converts AIDev scan candidate shapes (new-shapes.jsonl) into the format
 * the discovery pipeline reads (discovered-shapes.jsonl). This bridges the
 * scan loop (discovers shapes from real PRs) with the supply chain
 * (generates scenarios to test those shapes).
 *
 * The flow:
 *   Scan Loop → new-shapes.jsonl → THIS BRIDGE → discovered-shapes.jsonl
 *   → curriculum-agent reads taxonomy gaps → generates scenarios
 *   → scenarios enter nightly baseline → improve loop fixes gates
 *
 * Usage:
 *   bun scripts/scan/bridge-to-supply.ts
 *   bun scripts/scan/bridge-to-supply.ts --dry-run    # preview without writing
 *
 * Called by nightly.sh after the scan stage completes.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';

const PKG_ROOT = resolve(import.meta.dir, '..', '..');
const SCAN_SHAPES = join(PKG_ROOT, 'data', 'aidev-scan', 'new-shapes.jsonl');
const DISCOVERED_SHAPES = join(PKG_ROOT, 'data', 'discovered-shapes.jsonl');
const TAXONOMY = join(PKG_ROOT, 'FAILURE-TAXONOMY.md');

interface ScanShape {
  id: string;
  gate: string;
  filePattern: string;
  occurrences: number;
  examples: Array<{ pr_id: string; file: string; detail: string; agent: string }>;
  suggestion: string;
}

interface DiscoveredShape {
  id: string;
  gate: string;
  domain: string;
  description: string;
  occurrences: number;
  source: 'aidev-scan';
  examples: Array<{ id: string; description: string }>;
  clusterKey: string;
  proposedAt: string;
  confirmedInTaxonomy: boolean;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('=== Bridge: Scan Loop → Supply Chain ===');
  console.log(`  Source: ${SCAN_SHAPES}`);
  console.log(`  Target: ${DISCOVERED_SHAPES}`);
  if (dryRun) console.log('  Mode: DRY RUN');
  console.log('');

  if (!existsSync(SCAN_SHAPES)) {
    console.log('No scan shapes found. Run the scanner first.');
    return;
  }

  // Load scan candidates
  const scanLines = readFileSync(SCAN_SHAPES, 'utf-8').split('\n').filter(l => l.trim());
  const scanShapes: ScanShape[] = scanLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any;
  console.log(`  Scan candidates: ${scanShapes.length}`);

  // Load existing discovered shapes to avoid duplicates
  const existingIds = new Set<string>();
  if (existsSync(DISCOVERED_SHAPES)) {
    const existing = readFileSync(DISCOVERED_SHAPES, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of existing) {
      try {
        const shape = JSON.parse(line);
        existingIds.add(shape.id ?? shape.clusterKey ?? '');
      } catch {}
    }
  }
  console.log(`  Existing discovered shapes: ${existingIds.size}`);

  // Check taxonomy for already-documented shapes
  let taxonomyText = '';
  if (existsSync(TAXONOMY)) {
    taxonomyText = readFileSync(TAXONOMY, 'utf-8');
  }

  // Convert scan shapes → discovered shapes format
  const newShapes: DiscoveredShape[] = [];
  let skippedDuplicate = 0;
  let skippedInTaxonomy = 0;
  let skippedLowConfidence = 0;

  for (const scan of scanShapes) {
    // Skip if already in discovered shapes
    if (existingIds.has(scan.id) || existingIds.has(`${scan.gate}::${scan.filePattern}`)) {
      skippedDuplicate++;
      continue;
    }

    // Skip if it's a GC shape (already in taxonomy as a known false positive)
    if (scan.suggestion.includes('GC shape') || scan.suggestion.includes('auto-classify as low')) {
      // Check if it's actually in the taxonomy
      if (taxonomyText.includes(scan.gate) && taxonomyText.includes(scan.filePattern.replace('-', ' '))) {
        skippedInTaxonomy++;
        continue;
      }
    }

    // Skip weak candidates with < 5 occurrences (they said "Weak candidate")
    if (scan.occurrences < 5 && scan.suggestion.includes('Weak')) {
      skippedLowConfidence++;
      continue;
    }

    // Map scan filePattern to a domain for the curriculum agent
    const domain = mapFilePatternToDomain(scan.filePattern);

    const discovered: DiscoveredShape = {
      id: scan.id,
      gate: scan.gate,
      domain,
      description: `${scan.gate} gate fires on ${scan.filePattern} files (${scan.occurrences} occurrences across real agent PRs)`,
      occurrences: scan.occurrences,
      source: 'aidev-scan',
      examples: scan.examples.slice(0, 3).map(e => ({
        id: e.pr_id,
        description: `${e.agent}: ${e.file} — ${e.detail.substring(0, 60)}`,
      })),
      clusterKey: `${scan.gate}::${scan.filePattern}`,
      proposedAt: new Date().toISOString(),
      confirmedInTaxonomy: false,
    };

    newShapes.push(discovered);
  }

  console.log(`\n  Results:`);
  console.log(`    New shapes to bridge: ${newShapes.length}`);
  console.log(`    Skipped (duplicate): ${skippedDuplicate}`);
  console.log(`    Skipped (in taxonomy): ${skippedInTaxonomy}`);
  console.log(`    Skipped (weak, <5 occurrences): ${skippedLowConfidence}`);
  console.log('');

  if (newShapes.length === 0) {
    console.log('  No new shapes to bridge.');
    return;
  }

  // Preview
  for (const s of newShapes) {
    console.log(`  ${s.id}: ${s.gate}::${s.domain} — ${s.occurrences} occurrences`);
    console.log(`    ${s.description}`);
  }

  // Write
  if (!dryRun) {
    const lines = newShapes.map(s => JSON.stringify(s)).join('\n') + '\n';
    appendFileSync(DISCOVERED_SHAPES, lines);
    console.log(`\n  Appended ${newShapes.length} shapes to ${DISCOVERED_SHAPES}`);
    console.log('  The curriculum agent will pick these up on the next nightly run.');
  } else {
    console.log('\n  DRY RUN — nothing written.');
  }
}

function mapFilePatternToDomain(filePattern: string): string {
  const map: Record<string, string> = {
    'typescript-javascript': 'javascript',
    'frontend-react': 'react',
    'frontend-other': 'frontend',
    'python': 'python',
    'go': 'go',
    'rust': 'rust',
    'ruby': 'ruby',
    'c-cpp': 'cpp',
    'jvm': 'java',
    'shell': 'shell',
    'config': 'config',
    'github-ci': 'ci',
    'docker': 'docker',
    'xml-project': 'build',
    'docs': 'docs',
  };
  // Extract base pattern (strip "other-" prefix)
  const base = filePattern.replace(/^other-/, '');
  return map[filePattern] ?? map[base] ?? base;
}

main();
