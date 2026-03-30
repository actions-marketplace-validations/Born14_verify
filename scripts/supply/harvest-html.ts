/**
 * Real-World HTML Harvester
 * =========================
 *
 * Reads real Mustache spec test data and converts to verify scenarios.
 * Tests content predicates against template rendering expectations.
 *
 * Input: Mustache specification (git clone)
 *   {cacheDir}/mustache-spec/repo/specs/*.json
 *   Each file: { overview, tests: [{ name, desc, data, template, expected }] }
 *
 * Output: VerifyScenario[] with source: 'real-world'
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

interface MustacheTest {
  name: string;
  desc: string;
  data: Record<string, any>;
  template: string;
  expected: string;
  partials?: Record<string, string>;
}

interface MustacheSpec {
  overview: string;
  tests: MustacheTest[];
}

interface VerifyScenario {
  id: string;
  description: string;
  edits: Array<{ file: string; search: string; replace: string }>;
  predicates: Array<Record<string, any>>;
  expectedSuccess: boolean;
  tags: string[];
  rationale: string;
  source: 'real-world';
}

/** Escape special regex characters so pattern matches literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a string for safe embedding in a JS template literal / JSON string. */
function escapeForEmbed(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}

/**
 * Truncate long strings for descriptions, preserving meaningful prefix.
 */
function truncate(s: string, max: number): string {
  const clean = s.replace(/\n/g, '\\n').replace(/\r/g, '');
  return clean.length <= max ? clean : clean.substring(0, max) + '...';
}

/**
 * Determine if a Mustache template is "static" — same output regardless of data.
 * These are templates where template === expected (no interpolation happened).
 */
function isStaticTemplate(test: MustacheTest): boolean {
  return test.template === test.expected;
}

/**
 * Extract a usable content pattern from the expected output.
 * Picks the longest non-whitespace line as the best anchor.
 */
function bestPatternFromExpected(expected: string): string | null {
  const lines = expected.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;
  // Pick the longest line as most distinctive
  lines.sort((a, b) => b.length - a.length);
  return lines[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// html5lib .dat format parser
// ─────────────────────────────────────────────────────────────────────────────

interface Html5libTest {
  data: string;
  errors: string[];
  document: string;
  documentFragment?: string;
}

/**
 * Parse html5lib tree-construction .dat files.
 * Format: sections delimited by #data, #errors, #document[-fragment], separated by blank lines.
 */
function parseHtml5libDat(content: string): Html5libTest[] {
  const tests: Html5libTest[] = [];
  // Split into test blocks by double-newline before #data
  const blocks = content.split(/\n(?=#data\n)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed.startsWith('#data')) continue;

    const sections: Record<string, string> = {};
    let currentSection = '';
    const lines = trimmed.split('\n');

    for (const line of lines) {
      if (line.startsWith('#')) {
        currentSection = line.substring(1).trim().toLowerCase();
        sections[currentSection] = '';
      } else if (currentSection) {
        sections[currentSection] += (sections[currentSection] ? '\n' : '') + line;
      }
    }

    const data = (sections['data'] || '').trim();
    if (!data) continue;

    tests.push({
      data,
      errors: (sections['errors'] || '').split('\n').filter(l => l.trim()),
      document: (sections['document'] || sections['document-fragment'] || '').trim(),
      documentFragment: sections['document-fragment'] ? sections['document-fragment'].trim() : undefined,
    });
  }

  return tests;
}

/**
 * Extract a meaningful text fragment from html5lib test data for content predicates.
 * Returns the first tag name or text content that's distinctive enough.
 */
function extractHtml5libPattern(data: string): string | null {
  // Try to find a distinctive tag or text
  const tagMatch = data.match(/<(\w+)(?:\s[^>]*)?>([^<]{3,})/);
  if (tagMatch && tagMatch[2].trim().length >= 3) {
    return escapeRegex(tagMatch[2].trim().substring(0, 60));
  }
  // Use the opening tag itself if it's distinctive
  const openTag = data.match(/<(\w+)(?:\s[^>]*)?>/);
  if (openTag && !['html', 'head', 'body', 'p', 'div', 'span'].includes(openTag[1].toLowerCase())) {
    return escapeRegex(openTag[0].substring(0, 60));
  }
  // Fall back to first non-empty line
  const firstLine = data.split('\n').map(l => l.trim()).find(l => l.length >= 4);
  if (firstLine) return escapeRegex(firstLine.substring(0, 60));
  return null;
}

/**
 * Harvest html5lib tree-construction tests into verify scenarios.
 */
function harvestHtml5lib(files: string[], maxScenarios: number, startCounter: number): { scenarios: VerifyScenario[], counter: number } {
  const scenarios: VerifyScenario[] = [];
  let counter = startCounter;

  const datFiles = files.filter(f => f.endsWith('.dat'));

  for (const filePath of datFiles) {
    if (scenarios.length >= maxScenarios) break;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch { continue; }

    const category = basename(filePath, '.dat');
    const tests = parseHtml5libDat(content);

    for (const test of tests) {
      if (scenarios.length >= maxScenarios) break;

      const pattern = extractHtml5libPattern(test.data);
      if (!pattern || pattern.length < 3) continue;

      counter++;
      const escapedData = escapeForEmbed(test.data.substring(0, 500));
      const hasErrors = test.errors.length > 0;

      // Scenario: inject HTML fragment, check content is present in source
      scenarios.push({
        id: `rw-html-h5l-${String(counter).padStart(4, '0')}`,
        description: `html5lib: ${category} — ${truncate(test.data, 60)}`,
        edits: [{
          file: 'server.js',
          search: '<footer>About page footer</footer>',
          replace: `<footer>About page footer</footer>\n  <div class="h5l-test">${escapedData}</div>`,
        }],
        predicates: [{
          type: 'content',
          file: 'server.js',
          pattern,
        }],
        expectedSuccess: true,
        tags: ['html', 'real-world', 'html5lib', category, hasErrors ? 'parse-error' : 'valid'],
        rationale: `html5lib tree-construction test (${category}): parser ${hasErrors ? 'error' : 'conformance'} case. Input: ${truncate(test.data, 80)}`,
        source: 'real-world',
      });

      if (scenarios.length >= maxScenarios) break;

      // If there are parse errors, also create a scenario where we check for
      // content that would only exist after error recovery (from #document section)
      if (hasErrors && test.document) {
        const docPattern = extractHtml5libPattern(test.document);
        if (docPattern && docPattern !== pattern && docPattern.length >= 3) {
          counter++;
          scenarios.push({
            id: `rw-html-h5l-${String(counter).padStart(4, '0')}e`,
            description: `html5lib: ${category} — error recovery output check`,
            edits: [{
              file: 'server.js',
              search: '<footer>About page footer</footer>',
              replace: `<footer>About page footer</footer>\n  <div class="h5l-test">${escapedData}</div>`,
            }],
            predicates: [{
              type: 'content',
              file: 'server.js',
              // The #document section shows what the parser produces after error recovery.
              // This content is NOT in the source — it's a render artifact.
              pattern: docPattern,
            }],
            expectedSuccess: false,
            tags: ['html', 'real-world', 'html5lib', category, 'error-recovery', 'expected-fail'],
            rationale: `html5lib error recovery: expected parse output "${truncate(test.document, 60)}" differs from source input, so content predicate on source should fail.`,
            source: 'real-world',
          });
        }
      }
    }
  }

  return { scenarios, counter };
}

/**
 * Convert Mustache spec test suite files into HTML content verify scenarios.
 *
 * For each test case:
 * - The template is injected into server.js as HTML content
 * - The expected output is used to create content predicates
 * - Static templates (template === expected) produce pass scenarios
 * - Dynamic templates produce both pass (expected in source) and fail scenarios
 */
export function harvestHTML(files: string[], maxScenarios: number): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  let counter = 0;

  // ── html5lib .dat files ──────────────────────────────────────────────────
  const datFiles = files.filter(f => f.endsWith('.dat'));
  if (datFiles.length > 0) {
    const h5lBudget = Math.min(Math.floor(maxScenarios * 0.6), maxScenarios);
    const h5l = harvestHtml5lib(datFiles, h5lBudget, counter);
    scenarios.push(...h5l.scenarios);
    counter = h5l.counter;
  }

  const remaining = maxScenarios - scenarios.length;
  if (remaining <= 0) {
    console.log(`  harvest-html: ${datFiles.length} dat files + 0 spec files, generated ${scenarios.length} scenarios`);
    return scenarios;
  }

  // ── Mustache JSON spec files ─────────────────────────────────────────────
  // Filter to JSON spec files, skip lambdas
  const specFiles = files.filter(f => {
    const name = basename(f);
    return name.endsWith('.json') && !name.startsWith('~') && !name.startsWith('_');
  });

  for (const filePath of specFiles) {
    if (scenarios.length >= maxScenarios) break;

    let spec: MustacheSpec;
    try {
      const content = readFileSync(filePath, 'utf-8');
      spec = JSON.parse(content);
      if (!spec.tests || !Array.isArray(spec.tests)) continue;
    } catch {
      continue;
    }

    const category = basename(filePath, '.json');

    for (const test of spec.tests) {
      if (scenarios.length >= maxScenarios) break;

      // Skip tests with empty templates or expected output
      if (!test.template || test.expected === undefined) continue;

      // Skip lambda tests (require runtime execution)
      if (test.data && typeof test.data === 'object') {
        const hasLambda = Object.values(test.data).some(
          v => typeof v === 'object' && v !== null && 'lambda' in (v as any)
        );
        if (hasLambda) continue;
      }

      counter++;
      const escapedTemplate = escapeForEmbed(test.template);

      // --- Scenario A: Template source is present (always passes) ---
      const templatePattern = bestPatternFromExpected(test.template);
      if (templatePattern && templatePattern.length > 2) {
        scenarios.push({
          id: `rw-html-must-${String(counter).padStart(4, '0')}a`,
          description: `Mustache spec: ${test.name} — template source present (${category})`,
          edits: [{
            file: 'server.js',
            search: '<footer>About page footer</footer>',
            replace: `<footer>About page footer</footer>\n  <div class="mustache-test">${escapedTemplate}</div>`,
          }],
          predicates: [{
            type: 'content',
            file: 'server.js',
            pattern: escapeRegex(templatePattern),
          }],
          expectedSuccess: true,
          tags: ['html', 'real-world', 'mustache', category, 'template-source'],
          rationale: `Mustache spec (${category}): ${test.desc}. Verifies template source text is present after injection.`,
          source: 'real-world',
        });

        if (scenarios.length >= maxScenarios) break;
      }

      // --- Scenario B: Expected output check ---
      // For static templates, expected === template, so the content exists in source.
      // For dynamic templates, the expected output differs from the template.
      if (isStaticTemplate(test)) {
        // Static: template renders as-is, content predicate should pass
        const pattern = bestPatternFromExpected(test.expected);
        if (pattern && pattern.length > 2) {
          counter++;
          scenarios.push({
            id: `rw-html-must-${String(counter).padStart(4, '0')}b`,
            description: `Mustache spec: ${test.name} — static render matches source (${category})`,
            edits: [{
              file: 'server.js',
              search: '<footer>About page footer</footer>',
              replace: `<footer>About page footer</footer>\n  <div class="mustache-test">${escapedTemplate}</div>`,
            }],
            predicates: [{
              type: 'content',
              file: 'server.js',
              pattern: escapeRegex(pattern),
            }],
            expectedSuccess: true,
            tags: ['html', 'real-world', 'mustache', category, 'static-render'],
            rationale: `Mustache spec (${category}): ${test.desc}. Static template — rendered output equals source text.`,
            source: 'real-world',
          });
        }
      } else {
        // Dynamic: expected differs from template.
        // The expected output won't be in the source file (it's a render result),
        // so a content predicate checking for expected output in source should FAIL.
        const pattern = bestPatternFromExpected(test.expected);
        if (pattern && pattern.length > 2 && !test.template.includes(pattern)) {
          counter++;
          scenarios.push({
            id: `rw-html-must-${String(counter).padStart(4, '0')}c`,
            description: `Mustache spec: ${test.name} — rendered output not in source (${category})`,
            edits: [{
              file: 'server.js',
              search: '<footer>About page footer</footer>',
              replace: `<footer>About page footer</footer>\n  <div class="mustache-test">${escapedTemplate}</div>`,
            }],
            predicates: [{
              type: 'content',
              file: 'server.js',
              pattern: escapeRegex(pattern),
            }],
            expectedSuccess: false,
            tags: ['html', 'real-world', 'mustache', category, 'dynamic-render', 'expected-fail'],
            rationale: `Mustache spec (${category}): ${test.desc}. Dynamic template — expected output "${truncate(pattern, 60)}" differs from template source, so content predicate on source file should fail.`,
            source: 'real-world',
          });
        }
      }
    }
  }

  console.log(`  harvest-html: ${datFiles.length} dat files + ${specFiles.length} spec files, generated ${scenarios.length} scenarios`);
  return scenarios;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone test
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const testDir = process.argv[2];
  if (!testDir) {
    console.log('Usage: bun scripts/supply/harvest-html.ts <cache-dir>');
    console.log('  cache-dir should contain mustache-spec/repo/specs/*.json');
    process.exit(1);
  }

  const repoDir = join(testDir, 'mustache-spec', 'repo', 'specs');
  if (!existsSync(repoDir)) {
    console.log(`Not found: ${repoDir}`);
    console.log('Run the fetch step first to populate the cache.');
    process.exit(1);
  }

  const files = readdirSync(repoDir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(repoDir, f));

  console.log(`Found ${files.length} spec files: ${files.map(f => basename(f)).join(', ')}`);
  const scenarios = harvestHTML(files, 300);
  console.log(`\nGenerated ${scenarios.length} scenarios`);

  // Show distribution by category
  const byCat: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  for (const s of scenarios) {
    for (const t of s.tags) {
      if (!['html', 'real-world', 'mustache'].includes(t)) {
        byTag[t] = (byTag[t] || 0) + 1;
      }
    }
  }
  console.log('\nBy category/tag:');
  for (const [k, v] of Object.entries(byTag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  // Show first 10 samples
  console.log('\nSample scenarios:');
  for (const s of scenarios.slice(0, 10)) {
    console.log(`  ${s.id}: [${s.expectedSuccess ? 'PASS' : 'FAIL'}] ${s.description.substring(0, 90)}`);
  }
}
