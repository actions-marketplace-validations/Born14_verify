/**
 * Real-World HTTP Harvester
 * =========================
 *
 * Reads real JSON Schema test suites and converts to verify scenarios.
 * Tests HTTP/serialization predicates against real validation cases.
 *
 * Input: JSON Schema Test Suite (git clone)
 *   {cacheDir}/json-schema-test-suite/repo/tests/draft2020-12/*.json
 *   Each file: { description, schema, tests: [{ description, data, valid }] }
 *
 * Output: VerifyScenario[] with source: 'real-world'
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

interface JSONSchemaTestGroup {
  description: string;
  schema: Record<string, any>;
  tests: Array<{
    description: string;
    data: any;
    valid: boolean;
  }>;
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTPWG Structured Field Tests
// ─────────────────────────────────────────────────────────────────────────────

interface SFTestCase {
  name: string;
  raw?: string[];
  header_type?: string;
  expected?: any;
  must_fail?: boolean;
  can_fail?: boolean;
}

/**
 * Detect if a parsed JSON file is an HTTPWG structured-fields test file.
 * These files are arrays of test objects with `name`, `raw`, and optionally `must_fail`.
 */
function isSFTestFile(data: unknown): data is SFTestCase[] {
  if (!Array.isArray(data)) return false;
  if (data.length === 0) return false;
  const first = data[0];
  return typeof first === 'object' && first !== null && 'name' in first && ('raw' in first || 'must_fail' in first);
}

/**
 * Harvest HTTPWG structured field test cases into verify scenarios.
 */
function harvestStructuredFields(
  tests: SFTestCase[],
  headerType: string,
  maxScenarios: number,
  startCounter: number,
): { scenarios: VerifyScenario[], counter: number } {
  const scenarios: VerifyScenario[] = [];
  let counter = startCounter;

  for (const test of tests) {
    if (scenarios.length >= maxScenarios) break;

    const rawValues = test.raw || [];
    if (rawValues.length === 0 && !test.must_fail) continue;

    counter++;
    const rawStr = rawValues.join(', ');
    const rawSnippet = rawStr.length > 80 ? rawStr.substring(0, 80) + '...' : rawStr;
    const shouldFail = test.must_fail === true;

    // Inject a header-setting line into server.js
    const headerLine = rawStr.length > 0
      ? `res.setHeader('X-SF-Test', ${JSON.stringify(rawStr)});`
      : `// ${test.name}: must_fail test (no raw value)`;

    scenarios.push({
      id: `rw-http-sf-${String(counter).padStart(4, '0')}`,
      description: `Structured Fields ${headerType}: ${test.name}${shouldFail ? ' (must_fail)' : ''}`,
      edits: [{
        file: 'server.js',
        search: "res.end(JSON.stringify({ status: 'ok' }));",
        replace: `${headerLine}\n    res.end(JSON.stringify({ status: 'ok', sf_type: '${headerType}', sf_raw: ${JSON.stringify(rawStr)}, sf_valid: ${!shouldFail} }));`,
      }],
      predicates: [{
        type: 'serialization',
        file: 'server.js',
        headerType,
        raw: rawStr,
        expected: test.expected,
        assertion: shouldFail ? 'invalid' : 'valid',
      }],
      expectedSuccess: true, // gate should correctly classify valid/invalid
      tags: ['http', 'real-world', 'structured-fields', headerType, shouldFail ? 'must_fail' : 'valid'],
      rationale: `HTTPWG structured field test (${headerType}): ${test.name}. Raw: "${rawSnippet}". ${shouldFail ? 'Parser must reject.' : 'Parser must accept.'}`,
      source: 'real-world',
    });
  }

  return { scenarios, counter };
}

/**
 * Convert JSON Schema test suite and HTTPWG structured field test files
 * into HTTP/serialization verify scenarios.
 */
export function harvestHTTP(files: string[], maxScenarios: number): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  let counter = 0;

  // Find JSON test files
  const jsonFiles = files.filter(f => f.endsWith('.json') && !f.includes('_meta'));
  let jsonSchemaCount = 0;
  let sfCount = 0;

  for (const filePath of jsonFiles) {
    if (scenarios.length >= maxScenarios) break;

    let data: unknown;
    try {
      const content = readFileSync(filePath, 'utf-8');
      data = JSON.parse(content);
    } catch {
      continue;
    }

    const category = basename(filePath, '.json');

    // ── HTTPWG Structured Field Tests ─────────────────────────────────────
    if (isSFTestFile(data)) {
      sfCount++;
      const headerType = (data[0] as SFTestCase).header_type || category;
      const remaining = maxScenarios - scenarios.length;
      const sf = harvestStructuredFields(data, headerType, remaining, counter);
      scenarios.push(...sf.scenarios);
      counter = sf.counter;
      continue;
    }

    // ── JSON Schema Test Suite ────────────────────────────────────────────
    if (!Array.isArray(data)) continue;
    const groups = data as JSONSchemaTestGroup[];
    jsonSchemaCount++;

    for (const group of groups) {
      if (scenarios.length >= maxScenarios) break;
      if (!group.tests || !Array.isArray(group.tests)) continue;

      for (const test of group.tests) {
        if (scenarios.length >= maxScenarios) break;
        counter++;

        const schemaStr = JSON.stringify(group.schema);
        const dataStr = JSON.stringify(test.data);
        const schemaSnippet = schemaStr.length > 100 ? schemaStr.substring(0, 100) + '...' : schemaStr;

        scenarios.push({
          id: `rw-http-jss-${String(counter).padStart(4, '0')}`,
          description: `JSON Schema ${category}: ${group.description} — ${test.description}`,
          edits: [{
            file: 'server.js',
            search: "res.end(JSON.stringify({ status: 'ok' }));",
            replace: `res.end(JSON.stringify({ status: 'ok', schema: ${schemaStr}, data: ${dataStr}, valid: ${test.valid} }));`,
          }],
          predicates: [{
            type: 'serialization',
            file: 'server.js',
            schema: group.schema,
            data: test.data,
            assertion: test.valid ? 'valid' : 'invalid',
          }],
          expectedSuccess: true,
          tags: ['http', 'real-world', 'json-schema', category, test.valid ? 'valid' : 'invalid'],
          rationale: `Real JSON Schema test: ${group.description}. Data ${test.valid ? 'conforms to' : 'violates'} schema. Schema: ${schemaSnippet}`,
          source: 'real-world',
        });
      }
    }
  }

  console.log(`  harvest-http: ${jsonSchemaCount} JSON Schema + ${sfCount} structured-field files, generated ${scenarios.length} scenarios`);
  return scenarios;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone test
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const testDir = process.argv[2];
  if (!testDir) {
    console.log('Usage: bun scripts/supply/harvest-http.ts <cache-dir>');
    console.log('  cache-dir should contain json-schema-test-suite/repo/tests/draft2020-12/*.json');
    process.exit(1);
  }

  const repoDir = join(testDir, 'json-schema-test-suite', 'repo', 'tests', 'draft2020-12');
  if (!existsSync(repoDir)) {
    console.log(`Not found: ${repoDir}`);
    console.log('Run the fetch step first to populate the cache.');
    process.exit(1);
  }

  const files = readdirSync(repoDir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(repoDir, f));

  const scenarios = harvestHTTP(files, 100);
  console.log(`\nGenerated ${scenarios.length} scenarios`);
  for (const s of scenarios.slice(0, 5)) {
    console.log(`  ${s.id}: ${s.description.substring(0, 80)}`);
  }
}
