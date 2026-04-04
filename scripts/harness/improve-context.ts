/**
 * Surgical Context Loader for the Improve Loop
 * ==============================================
 *
 * Extracts minimal, high-signal context to inject into diagnosis and fix
 * prompts. The goal is NOT to dump everything — it's to give the LLM
 * exactly the interfaces and failure semantics it needs.
 *
 * Three context slices:
 * 1. Core type interfaces from src/types.ts (~80 lines)
 * 2. Relevant FAILURE-TAXONOMY.md section keyed by gate (~30-60 lines)
 * 3. Related file graph + reader (canonical location, used by both paths)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// =============================================================================
// 1. TYPE INTERFACES — extracted once per process, cached
// =============================================================================

let _typesCache: string | null = null;

/**
 * Extract core interfaces from src/types.ts that the LLM needs to
 * understand Edit, Predicate, GateResult, and Narrowing shapes.
 *
 * Returns ~80 lines of interface definitions, not the whole 566-line file.
 */
export function getCoreTypes(packageRoot: string): string {
  if (_typesCache !== null) return _typesCache;

  const typesPath = join(packageRoot, 'src/types.ts');
  if (!existsSync(typesPath)) {
    _typesCache = '';
    return _typesCache;
  }

  const content = readFileSync(typesPath, 'utf-8');
  const lines = content.split('\n');

  // Extract specific interface blocks by finding their start/end
  const blocks: string[] = [];
  const targets = ['export interface Edit {', 'export interface Predicate {', 'export interface GateResult {', 'export interface Narrowing {'];

  for (const target of targets) {
    const startIdx = lines.findIndex((l: string) => l.includes(target));
    if (startIdx < 0) continue;

    // For Predicate, only grab the type field + first few key fields (not all 40+ optional fields)
    if (target.includes('Predicate')) {
      const predicateLines: string[] = [];
      predicateLines.push(lines[startIdx]);
      // Grab the type field and a few key fields, then close
      let braceDepth = 1;
      let fieldCount = 0;
      for (let i = startIdx + 1; i < lines.length && braceDepth > 0; i++) {
        const line = lines[i];
        if (line.includes('{')) braceDepth++;
        if (line.includes('}')) braceDepth--;

        if (braceDepth === 0) {
          predicateLines.push('}');
          break;
        }

        // Include type, selector, property, expected, path, file, description, pattern fields
        // and the section headers (comments with ---)
        if (fieldCount < 12 || line.trim().startsWith('//') || line.trim().startsWith('type:')) {
          predicateLines.push(line);
          if (line.includes('?:') || line.includes('type:')) fieldCount++;
        } else if (fieldCount === 12) {
          predicateLines.push('  // ... additional optional fields for db, http, filesystem, infra, security, a11y, performance, hallucination ...');
          fieldCount++;
        }
      }
      blocks.push(predicateLines.join('\n'));
      continue;
    }

    // For other interfaces, grab until the closing brace at depth 0
    let braceDepth = 0;
    const blockLines: string[] = [];
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      blockLines.push(line);
      if (line.includes('{')) braceDepth++;
      if (line.includes('}')) braceDepth--;
      if (braceDepth === 0 && blockLines.length > 1) break;
    }
    blocks.push(blockLines.join('\n'));
  }

  _typesCache = blocks.length > 0
    ? `// Core interfaces from src/types.ts\n${blocks.join('\n\n')}`
    : '';
  return _typesCache;
}

// =============================================================================
// 2. FAILURE TAXONOMY — keyed by gate name
// =============================================================================

/**
 * Map from gate names (as they appear in GateResult.gate and violation evidence)
 * to the ## section header in FAILURE-TAXONOMY.md.
 */
const GATE_TO_TAXONOMY_SECTION: Record<string, string[]> = {
  // Gate name → taxonomy section header(s) to extract
  'grounding':      ['CSS Predicate Failures', 'HTML Predicate Failures'],
  'F9':             ['Content Predicate Failures'],  // syntax/edit application
  'K5':             [],  // constraint enforcement — no taxonomy section (it's meta)
  'G5':             ['Attribution / Root Cause Failures'],  // containment
  'browser':        ['Browser Runtime Failures', 'CSS Predicate Failures'],
  'http':           ['HTTP Predicate Failures'],
  'staging':        [],  // Docker build — no taxonomy section
  'filesystem':     ['Filesystem Predicate Failures'],
  'infrastructure': [],
  'serialization':  ['Serialization / API Contract Failures'],
  'config':         ['Configuration Predicate Failures'],
  'security':       ['Security Predicate Failures'],
  'a11y':           ['Accessibility (a11y) Predicate Failures'],
  'performance':    ['Performance Predicate Failures'],
  'hallucination':  ['Hallucination Predicate Failures'],
  'state':          ['Temporal / Stateful Failures'],
  'temporal':       ['Temporal / Stateful Failures'],
  'propagation':    ['Cross-Predicate Interaction Failures'],
  'contention':     ['Concurrency / Multi-Actor Failures'],
  'access':         ['Scope Boundary Failures'],
  'capacity':       ['Budget / Resource Bound Failures'],
  'content':        ['Content Predicate Failures'],
  'message':        ['Message Predicate Failures'],
  'observation':    ['Observer Effect Failures'],
  'vision':         [],
  'triangulation':  [],
};

let _taxonomyCache: string | null = null;

function loadTaxonomy(packageRoot: string): string {
  if (_taxonomyCache !== null) return _taxonomyCache;
  const taxPath = join(packageRoot, 'FAILURE-TAXONOMY.md');
  if (!existsSync(taxPath)) {
    _taxonomyCache = '';
    return '';
  }
  const content = readFileSync(taxPath, 'utf-8');
  _taxonomyCache = content;
  return content;
}

/**
 * Extract the relevant FAILURE-TAXONOMY.md section(s) for a given gate.
 *
 * Returns only the matching ## section(s), typically 30-60 lines each.
 * If the gate has no mapped taxonomy section, returns empty string.
 */
export function getTaxonomyForGate(gate: string, packageRoot: string): string {
  const sectionNames = GATE_TO_TAXONOMY_SECTION[gate.toLowerCase()];
  if (!sectionNames || sectionNames.length === 0) return '';

  const taxonomy = loadTaxonomy(packageRoot);
  if (!taxonomy) return '';

  const lines = taxonomy.split('\n');
  const sections: string[] = [];

  for (const sectionName of sectionNames) {
    const headerPattern = `## ${sectionName}`;
    const startIdx = lines.findIndex(l => l.trim() === headerPattern);
    if (startIdx < 0) continue;

    // Find the next ## header (end of this section)
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ') && !lines[i].startsWith('### ')) {
        endIdx = i;
        break;
      }
    }

    // Cap at 50 lines per section — enough for the shape tables, not the prose
    const sectionLines = lines.slice(startIdx, Math.min(endIdx, startIdx + 50));
    sections.push(sectionLines.join('\n'));
  }

  return sections.length > 0
    ? `// Relevant failure shapes from FAILURE-TAXONOMY.md\n${sections.join('\n\n')}`
    : '';
}

/**
 * Extract taxonomy context from violation evidence.
 * Looks at the gates that failed across all violations in a bundle.
 */
export function getTaxonomyForViolations(
  violations: Array<{ gatesFailed?: string[] }>,
  packageRoot: string,
): string {
  // Collect unique gate names from all violations
  const gates = new Set<string>();
  for (const v of violations) {
    if (v.gatesFailed) {
      for (const g of v.gatesFailed) gates.add(g.toLowerCase());
    }
  }

  if (gates.size === 0) return '';

  const sections: string[] = [];
  const seen = new Set<string>(); // avoid duplicate sections when multiple gates map to same taxonomy

  for (const gate of gates) {
    const taxonomy = getTaxonomyForGate(gate, packageRoot);
    if (taxonomy && !seen.has(taxonomy)) {
      seen.add(taxonomy);
      sections.push(taxonomy);
    }
  }

  return sections.join('\n\n');
}

// =============================================================================
// 3. RELATED FILE GRAPH — canonical location, imported by claude-improve.ts
// =============================================================================

/**
 * When the LLM reads a target file to generate fixes, it also gets
 * the files that are architecturally coupled. This graph defines those
 * relationships.
 */
export const RELATED_FILES: Record<string, string[]> = {
  // ── Core orchestrator ──
  'src/verify.ts': [
    'src/types.ts',
    'src/store/constraint-store.ts',
  ],
  'src/govern.ts': [
    'src/verify.ts',
    'src/store/constraint-store.ts',
    'src/store/decompose.ts',
    'src/store/fault-ledger.ts',
  ],

  // ── Store layer ──
  'src/store/constraint-store.ts': [
    'src/gates/constraints.ts',
    'src/types.ts',
  ],
  'src/store/decompose.ts': [
    'src/store/constraint-store.ts',
    'src/types.ts',
  ],
  'src/store/fault-ledger.ts': [
    'src/store/constraint-store.ts',
    'src/types.ts',
  ],
  'src/store/external-scenarios.ts': [
    'src/types.ts',
  ],

  // ── Governance gates ──
  'src/gates/constraints.ts': [
    'src/store/constraint-store.ts',
    'src/types.ts',
  ],
  'src/gates/containment.ts': [
    'src/types.ts',
  ],
  'src/gates/grounding.ts': [
    'src/gates/browser.ts',
    'src/types.ts',
  ],
  'src/gates/browser.ts': [
    'src/gates/grounding.ts',
    'src/types.ts',
  ],
  'src/gates/http.ts': [
    'src/types.ts',
  ],
  'src/gates/syntax.ts': [
    'src/types.ts',
  ],
  'src/gates/vision.ts': [
    'src/gates/triangulation.ts',
    'src/types.ts',
  ],
  'src/gates/triangulation.ts': [
    'src/gates/vision.ts',
    'src/gates/browser.ts',
    'src/types.ts',
  ],
  'src/gates/staging.ts': [
    'src/types.ts',
    'src/runners/docker-runner.ts',
  ],
  'src/gates/invariants.ts': [
    'src/types.ts',
  ],

  // ── Domain gates ──
  'src/gates/a11y.ts':            ['src/types.ts'],
  'src/gates/access.ts':          ['src/types.ts'],
  'src/gates/capacity.ts':        ['src/types.ts'],
  'src/gates/config.ts':          ['src/types.ts'],
  'src/gates/contention.ts':      ['src/types.ts'],
  'src/gates/filesystem.ts':      ['src/types.ts'],
  'src/gates/infrastructure.ts':  ['src/types.ts'],
  'src/gates/message.ts':         ['src/types.ts'],
  'src/gates/observation.ts':     ['src/types.ts'],
  'src/gates/performance.ts':     ['src/types.ts'],
  'src/gates/propagation.ts':     ['src/types.ts'],
  'src/gates/security.ts':        ['src/types.ts'],
  'src/gates/serialization.ts':   ['src/types.ts'],
  'src/gates/state.ts':           ['src/types.ts'],
  'src/gates/temporal.ts':        ['src/types.ts'],

  // ── Runners / Parsers ──
  'src/runners/docker-runner.ts': ['src/types.ts'],
  'src/parsers/git-diff.ts':     ['src/types.ts'],

  // ── Types (the root) ──
  'src/types.ts': [
    'src/verify.ts',
  ],
};

/**
 * Read related files for context enrichment.
 * Skips types.ts since we inject it separately via getCoreTypes.
 */
export function getRelatedContext(targetFile: string, packageRoot: string, maxBytesPerFile: number = 4000): string {
  const related = RELATED_FILES[targetFile];
  if (!related || related.length === 0) return '';

  const sections: string[] = [];
  for (const relPath of related) {
    // Skip types.ts — injected separately via getCoreTypes
    if (relPath === 'src/types.ts') continue;

    const fullPath = join(packageRoot, relPath);
    if (!existsSync(fullPath)) continue;

    try {
      let content = readFileSync(fullPath, 'utf-8');
      if (content.length > maxBytesPerFile) {
        content = content.substring(0, maxBytesPerFile) + '\n// ... truncated ...';
      }
      sections.push(`--- Related: ${relPath} ---\n${content}`);
    } catch { /* skip */ }
  }

  return sections.length > 0 ? sections.join('\n\n') : '';
}
