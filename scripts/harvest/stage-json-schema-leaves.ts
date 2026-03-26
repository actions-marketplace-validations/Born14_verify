/**
 * JSON Schema Test Suite Harvester
 * =================================
 *
 * Fetches test cases from the official JSON Schema Test Suite (draft2020-12)
 * and converts them into verify serialization gate scenarios.
 *
 * Source: https://github.com/json-schema-org/JSON-Schema-Test-Suite
 * License: MIT
 *
 * Each test case becomes a scenario that:
 *   - Writes test data to a JSON file via edit
 *   - Validates against the schema via serialization predicate
 *   - valid:true → expectedSuccess:true (schema should validate)
 *   - valid:false → expectedSuccess:false (schema should reject)
 *
 * Run: bun scripts/harvest/stage-json-schema-leaves.ts
 * Output: fixtures/scenarios/json-schema-staged.json
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const BASE_URL = 'https://raw.githubusercontent.com/json-schema-org/JSON-Schema-Test-Suite/main/tests/draft2020-12';

// All test files in draft2020-12
const TEST_FILES = [
  'additionalProperties', 'allOf', 'anyOf', 'boolean_schema', 'const',
  'contains', 'content', 'default', 'defs', 'dependentRequired',
  'dependentSchemas', 'enum', 'exclusiveMaximum', 'exclusiveMinimum',
  'format', 'if-then-else', 'items', 'maxContains', 'maxItems',
  'maxLength', 'maxProperties', 'maximum', 'minContains', 'minItems',
  'minLength', 'minProperties', 'minimum', 'multipleOf', 'not', 'oneOf',
  'pattern', 'patternProperties', 'prefixItems', 'properties', 'propertyNames',
  'ref', 'required', 'type', 'unevaluatedItems', 'unevaluatedProperties',
  'uniqueItems',
];

// Skip files that need $ref resolution to external URIs (our gate doesn't support that)
const SKIP_FILES = new Set(['ref', 'dynamicRef', 'vocabulary', 'anchor', 'defs', 'infinite-loop-detection']);

// Skip schemas that use features our simplified validator doesn't support
const SKIP_KEYWORDS = new Set([
  '$ref', '$dynamicRef', '$recursiveRef', '$anchor', '$dynamicAnchor',
  'if', 'then', 'else', // if-then-else needs full validator
  'unevaluatedItems', 'unevaluatedProperties', // needs annotation tracking
  'dependentSchemas', // needs full validator
  'patternProperties', // needs regex matching in schema validator
  'propertyNames', // needs per-key validation
  'prefixItems', // needs positional array validation
  'contains', 'maxContains', 'minContains', // needs contains logic
  'uniqueItems', // needs deep equality check
  'multipleOf', // needs numeric division
  'exclusiveMaximum', 'exclusiveMinimum', // needs range checks
  'format', 'content', 'contentEncoding', 'contentMediaType', // format validation
]);

interface TestGroup {
  description: string;
  schema: Record<string, unknown>;
  tests: Array<{
    description: string;
    data: unknown;
    valid: boolean;
  }>;
}

const outPath = resolve('fixtures/scenarios/json-schema-staged.json');
const scenarios: any[] = [];
let id = 1;
let fetched = 0;
let skipped = 0;

function push(s: any) {
  scenarios.push({ id: `json-schema-${String(id++).padStart(4, '0')}`, requiresDocker: false, ...s });
}

/**
 * Check if a schema uses only keywords our gate's validateSchema() supports.
 * Our gate supports: type, required, properties (recursive), items (first element).
 */
function isSupported(schema: Record<string, unknown>): boolean {
  const keys = Object.keys(schema).filter(k => k !== '$schema' && k !== 'description');
  for (const key of keys) {
    if (SKIP_KEYWORDS.has(key)) return false;
  }

  // Check nested schemas in properties
  if (schema.properties && typeof schema.properties === 'object') {
    for (const propSchema of Object.values(schema.properties as Record<string, any>)) {
      if (typeof propSchema === 'object' && propSchema !== null) {
        if (!isSupported(propSchema)) return false;
      }
    }
  }

  // Check items schema
  if (schema.items && typeof schema.items === 'object') {
    if (!isSupported(schema.items as Record<string, unknown>)) return false;
  }

  // Check allOf/anyOf/oneOf/not
  for (const combiner of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[combiner])) {
      for (const sub of schema[combiner] as any[]) {
        if (typeof sub === 'object' && sub !== null && !isSupported(sub)) return false;
      }
    }
  }
  if (schema.not && typeof schema.not === 'object') {
    if (!isSupported(schema.not as Record<string, unknown>)) return false;
  }

  return true;
}

/**
 * Check if our simplified gate can correctly evaluate this test case.
 * Our gate only checks: type, required fields, property types recursively, array items[0].
 * It does NOT check: min/max, pattern, enum, const, additionalProperties, allOf/anyOf/oneOf/not.
 *
 * So we only harvest tests where our gate CAN determine the answer.
 */
function canGateEvaluate(schema: Record<string, unknown>, data: unknown, valid: boolean): boolean {
  const keys = Object.keys(schema).filter(k => k !== '$schema' && k !== 'description' && k !== 'default');

  // Our gate checks: type, required fields, properties (recursive type check), items[0] type.
  // It does NOT check: min/max, pattern, enum, const, additionalProperties, allOf/anyOf/oneOf/not.
  // It does NOT check: boolean schemas (false = reject everything, true = accept everything).

  if (keys.length === 0) return false; // Empty schema — always valid, not interesting

  // Reject any schema with unsupported keywords
  const UNSUPPORTED = new Set([
    'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not',
    'additionalProperties', 'pattern', 'format',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minLength', 'maxLength', 'minItems', 'maxItems',
    'minProperties', 'maxProperties', 'multipleOf',
    'uniqueItems', 'contains', 'minContains', 'maxContains',
    'dependentRequired', 'dependentSchemas',
    'patternProperties', 'propertyNames',
    'prefixItems', 'unevaluatedItems', 'unevaluatedProperties',
    'if', 'then', 'else', '$ref', '$dynamicRef',
    'contentEncoding', 'contentMediaType',
  ]);
  if (keys.some(k => UNSUPPORTED.has(k))) return false;

  // Reject boolean schemas in properties (our gate iterates Object.entries but boolean schemas break)
  if (schema.properties && typeof schema.properties === 'object') {
    for (const val of Object.values(schema.properties as Record<string, any>)) {
      if (typeof val === 'boolean') return false; // boolean schema (true/false)
      if (typeof val === 'object' && val !== null && !canGateEvaluate(val, null, true)) return false;
    }
  }

  // Reject boolean items schema
  if (schema.items !== undefined) {
    if (typeof schema.items === 'boolean') return false;
    if (typeof schema.items === 'object' && schema.items !== null) {
      if (!canGateEvaluate(schema.items as Record<string, unknown>, null, true)) return false;
    }
  }

  // Reject required fields with exotic JS property names (our gate uses 'in' operator which doesn't handle __proto__ etc.)
  if (Array.isArray(schema.required)) {
    const exotic = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
    if ((schema.required as string[]).some(k => exotic.includes(k))) return false;
    // Also reject escaped unicode property names
    if ((schema.required as string[]).some(k => /[^\x20-\x7E]/.test(k) || k.includes('\\'))) return false;
  }

  // Only accept schemas with type, required, properties, items (the features our gate handles)
  if (!keys.every(k => ['type', 'required', 'properties', 'items'].includes(k))) return false;

  // Must have type to be useful
  if (!keys.includes('type')) return false;

  return true;
}

async function fetchTestFile(name: string): Promise<TestGroup[]> {
  const url = `${BASE_URL}/${name}.json`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.log(`  SKIP ${name}: HTTP ${resp.status}`);
    return [];
  }
  return resp.json();
}

async function main() {
  console.log('JSON Schema Test Suite Harvester');
  console.log('================================\n');

  for (const name of TEST_FILES) {
    if (SKIP_FILES.has(name)) {
      console.log(`SKIP ${name} (unsupported feature)`);
      continue;
    }

    let groups: TestGroup[];
    try {
      groups = await fetchTestFile(name);
      fetched++;
    } catch (e) {
      console.log(`SKIP ${name}: fetch error`);
      continue;
    }

    let fileCount = 0;
    for (const group of groups) {
      // Clean schema (remove $schema key for our gate)
      const schema = { ...group.schema };
      delete schema.$schema;

      if (!isSupported(schema)) {
        skipped += group.tests.length;
        continue;
      }

      for (const test of group.tests) {
        if (!canGateEvaluate(schema, test.data, test.valid)) {
          skipped++;
          continue;
        }

        const dataStr = JSON.stringify(test.data, null, 2);
        const schemaForPred = { ...schema };

        // For false_positive (valid:false): the data should NOT match the schema
        // → Our gate validates schema, so if data doesn't match, gate fails → expectedSuccess: false
        // For false_negative (valid:true): the data SHOULD match the schema
        // → Gate validates, passes → expectedSuccess: true

        push({
          description: `json-schema ${name}: ${group.description} — ${test.description}`,
          edits: [{
            file: 'test-data.json',
            search: '',
            replace: dataStr,
          }],
          predicates: [{
            type: 'serialization',
            file: 'test-data.json',
            schema: schemaForPred,
          }],
          expectedSuccess: test.valid,
          intent: test.valid ? 'false_negative' : 'false_positive',
          tags: ['serialization', 'json-schema', name],
          rationale: `JSON Schema Test Suite draft2020-12/${name}: ${test.description}`,
        });
        fileCount++;
      }
    }

    if (fileCount > 0) {
      console.log(`  ${name}: ${fileCount} scenarios`);
    }
  }

  // Write output
  writeFileSync(outPath, JSON.stringify(scenarios, null, 2));
  console.log(`\nTotal: ${scenarios.length} scenarios (skipped ${skipped} unsupported)`);
  console.log(`Fetched from ${fetched} test files`);
  console.log(`Output: ${outPath}`);
}

main().catch(console.error);
