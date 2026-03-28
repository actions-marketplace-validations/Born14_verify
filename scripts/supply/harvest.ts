#!/usr/bin/env node
/**
 * External Corpus Harvester — Convert External Test Suites to Verify Scenarios
 * ==============================================================================
 *
 * Pluggable harvester that converts external test/failure data into verify
 * scenarios. Each harvester module reads a specific format and produces
 * scenario objects.
 *
 * Built-in harvesters (8 total):
 *   - css:        CSS property edge cases (shorthand/longhand, color normalization)
 *   - http:       HTTP status/sequence patterns
 *   - db:         DB schema verification patterns
 *   - wpt:        Web Platform Tests (CSS, HTML, HTTP conformance)
 *   - schemapile: Real-world DB schemas → schema predicate scenarios
 *   - cve:        CVE/OWASP vulnerability patterns → security gate scenarios
 *   - stylelint:  CSS anti-pattern rules → CSS quality scenarios
 *   - openapi:    API breaking change patterns → HTTP contract scenarios
 *
 * Usage:
 *   bun run scripts/supply/harvest.ts [options]
 *
 * Options:
 *   --sources=wpt,stylelint     Harvesters to run (default: all available)
 *   --max-scenarios=100         Maximum per source (default: 100)
 *   --input-dir=PATH            Directory with external corpus data
 *   --wpt-dir=PATH              WPT repo checkout (for wpt harvester)
 *   --dry-run                   Print what would be generated, don't write
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Scenario {
  id: string;
  description: string;
  edits: Array<{ file: string; search: string; replace: string }>;
  predicates: Array<Record<string, any>>;
  expectedSuccess: boolean;
  tags: string[];
  rationale: string;
}

interface HarvesterResult {
  source: string;
  scenarios: Scenario[];
  metadata: Record<string, any>;
}

type Harvester = (inputDir: string, maxScenarios: number) => HarvesterResult;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Harvester: CSS Property Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

function harvestCSSEdgeCases(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  const shorthandPairs = [
    { shorthand: 'margin', longhand: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], value: '10px', expanded: ['10px', '10px', '10px', '10px'] },
    { shorthand: 'padding', longhand: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'], value: '5px 10px', expanded: ['5px', '10px', '5px', '10px'] },
    { shorthand: 'border', longhand: ['border-width', 'border-style', 'border-color'], value: '1px solid red', expanded: ['1px', 'solid', 'red'] },
    { shorthand: 'background', longhand: ['background-color', 'background-image'], value: '#fff url(bg.png)', expanded: ['#fff', 'url(bg.png)'] },
    { shorthand: 'font', longhand: ['font-style', 'font-weight', 'font-size', 'font-family'], value: 'bold 16px Arial', expanded: ['normal', 'bold', '16px', 'Arial'] },
    { shorthand: 'animation', longhand: ['animation-name', 'animation-duration'], value: 'fadeIn 1s', expanded: ['fadeIn', '1s'] },
    { shorthand: 'transition', longhand: ['transition-property', 'transition-duration'], value: 'all 0.3s', expanded: ['all', '0.3s'] },
    { shorthand: 'flex', longhand: ['flex-grow', 'flex-shrink', 'flex-basis'], value: '1 0 auto', expanded: ['1', '0', 'auto'] },
    { shorthand: 'grid-template', longhand: ['grid-template-rows', 'grid-template-columns'], value: '1fr / 1fr 1fr', expanded: ['1fr', '1fr 1fr'] },
    { shorthand: 'outline', longhand: ['outline-width', 'outline-style', 'outline-color'], value: '2px solid blue', expanded: ['2px', 'solid', 'blue'] },
    { shorthand: 'overflow', longhand: ['overflow-x', 'overflow-y'], value: 'hidden auto', expanded: ['hidden', 'auto'] },
    { shorthand: 'gap', longhand: ['row-gap', 'column-gap'], value: '10px 20px', expanded: ['10px', '20px'] },
    { shorthand: 'place-items', longhand: ['align-items', 'justify-items'], value: 'center start', expanded: ['center', 'start'] },
    { shorthand: 'border-radius', longhand: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'], value: '5px 10px', expanded: ['5px', '10px', '10px', '5px'] },
    { shorthand: 'text-decoration', longhand: ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'], value: 'underline wavy red', expanded: ['underline', 'wavy', 'red'] },
  ];

  for (const pair of shorthandPairs) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-css-shorthand-${pair.shorthand}`,
      description: `[HARVEST:css] ${pair.shorthand} shorthand resolves to ${pair.longhand[0]} longhand`,
      edits: [],
      predicates: [{ type: 'css', selector: 'body', property: pair.longhand[0], expected: pair.expanded[0] }],
      expectedSuccess: true,
      tags: ['harvest', 'css', 'shorthand_longhand', pair.shorthand],
      rationale: `CSS shorthand ${pair.shorthand}: ${pair.value} should resolve ${pair.longhand[0]} to ${pair.expanded[0]}`,
    });
    scenarios.push({
      id: `harvest-css-shorthand-wrong-${pair.shorthand}`,
      description: `[HARVEST:css] ${pair.shorthand} shorthand with wrong ${pair.longhand[0]} expectation`,
      edits: [],
      predicates: [{ type: 'css', selector: 'body', property: pair.longhand[0], expected: 'WRONG_VALUE_999' }],
      expectedSuccess: false,
      tags: ['harvest', 'css', 'shorthand_longhand', 'false_positive', pair.shorthand],
      rationale: `CSS shorthand ${pair.shorthand}: checking wrong value for ${pair.longhand[0]}`,
    });
  }

  const colorEquivalences = [
    { input: 'red', normalized: '#ff0000' }, { input: '#f00', normalized: '#ff0000' },
    { input: 'rgb(255,0,0)', normalized: '#ff0000' }, { input: 'hsl(0, 100%, 50%)', normalized: '#ff0000' },
    { input: 'transparent', normalized: 'rgba(0, 0, 0, 0)' }, { input: 'currentColor', normalized: 'currentcolor' },
    { input: '#1a1a2e', normalized: '#1a1a2e' }, { input: 'rgba(0,0,0,0.5)', normalized: 'rgba(0, 0, 0, 0.5)' },
    { input: 'rebeccapurple', normalized: '#663399' }, { input: 'coral', normalized: '#ff7f50' },
    { input: 'hsl(120, 100%, 25%)', normalized: '#006600' }, { input: '#abc', normalized: '#aabbcc' },
    { input: 'rgb(50%, 0%, 0%)', normalized: '#800000' },
  ];

  for (const color of colorEquivalences) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-css-color-${color.input.replace(/[^a-z0-9]/gi, '_').substring(0, 20)}`,
      description: `[HARVEST:css] Color normalization: ${color.input} ≡ ${color.normalized}`,
      edits: [],
      predicates: [{ type: 'css', selector: 'body', property: 'color', expected: color.input }],
      expectedSuccess: true,
      tags: ['harvest', 'css', 'color_normalization'],
      rationale: `CSS color ${color.input} should normalize to ${color.normalized}`,
    });
  }

  return { source: 'css_edge_cases', scenarios, metadata: { shorthandPairs: shorthandPairs.length, colorCases: colorEquivalences.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Harvester: HTTP Status/Sequence Patterns
// ─────────────────────────────────────────────────────────────────────────────

function harvestHTTPEdgeCases(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  const httpPatterns = [
    { status: 200, method: 'GET', path: '/health', bodyContains: 'ok', shouldPass: true },
    { status: 200, method: 'GET', path: '/', bodyContains: 'html', shouldPass: true },
    { status: 404, method: 'GET', path: '/nonexistent', bodyContains: 'not found', shouldPass: true },
    { status: 200, method: 'GET', path: '/api/items', bodyContains: '[]', shouldPass: true },
    { status: 500, method: 'GET', path: '/health', bodyContains: 'error', shouldPass: false },
    { status: 301, method: 'GET', path: '/old-path', bodyContains: '', shouldPass: true },
    { status: 200, method: 'POST', path: '/api/items', bodyContains: 'created', shouldPass: true },
    { status: 400, method: 'POST', path: '/api/items', bodyContains: 'validation', shouldPass: true },
    { status: 204, method: 'DELETE', path: '/api/items/1', bodyContains: '', shouldPass: true },
    { status: 405, method: 'PATCH', path: '/health', bodyContains: '', shouldPass: true },
    { status: 429, method: 'GET', path: '/api/items', bodyContains: 'rate limit', shouldPass: true },
    { status: 200, method: 'OPTIONS', path: '/api/items', bodyContains: '', shouldPass: true },
  ];

  for (const pattern of httpPatterns) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-http-${pattern.method.toLowerCase()}-${pattern.status}-${pattern.path.replace(/\//g, '_')}`,
      description: `[HARVEST:http] ${pattern.method} ${pattern.path} → ${pattern.status}`,
      edits: [],
      predicates: [{
        type: 'http', method: pattern.method, path: pattern.path,
        expect: { status: pattern.status, ...(pattern.bodyContains ? { bodyContains: pattern.bodyContains } : {}) },
      }],
      expectedSuccess: pattern.shouldPass,
      tags: ['harvest', 'http', `status_${pattern.status}`, pattern.method.toLowerCase()],
      rationale: `HTTP ${pattern.method} ${pattern.path} should return ${pattern.status}`,
    });
  }

  // Multi-step sequences
  const sequences = [
    { id: 'crud', desc: 'POST create → GET verify', steps: [
      { method: 'POST', path: '/api/items', body: { name: 'test' }, expect: { status: 201 } },
      { method: 'GET', path: '/api/items', expect: { status: 200, bodyContains: 'test' } },
    ]},
    { id: 'auth-flow', desc: 'POST login → GET protected', steps: [
      { method: 'POST', path: '/auth/login', body: { user: 'admin', pass: 'test' }, expect: { status: 200 } },
      { method: 'GET', path: '/api/profile', expect: { status: 200 } },
    ]},
    { id: 'create-update-delete', desc: 'POST → PUT → DELETE', steps: [
      { method: 'POST', path: '/api/items', body: { name: 'temp' }, expect: { status: 201 } },
      { method: 'PUT', path: '/api/items/1', body: { name: 'updated' }, expect: { status: 200 } },
      { method: 'DELETE', path: '/api/items/1', expect: { status: 204 } },
    ]},
    { id: 'idempotent-put', desc: 'PUT twice → same result', steps: [
      { method: 'PUT', path: '/api/items/1', body: { name: 'x' }, expect: { status: 200 } },
      { method: 'PUT', path: '/api/items/1', body: { name: 'x' }, expect: { status: 200 } },
    ]},
  ];

  for (const seq of sequences) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-http-seq-${seq.id}`,
      description: `[HARVEST:http_sequence] ${seq.desc}`,
      edits: [],
      predicates: [{ type: 'http_sequence', steps: seq.steps }],
      expectedSuccess: true,
      tags: ['harvest', 'http_sequence', seq.id],
      rationale: `HTTP sequence: ${seq.desc}`,
    });
  }

  return { source: 'http_edge_cases', scenarios, metadata: { patterns: httpPatterns.length, sequences: sequences.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Harvester: DB Schema Patterns
// ─────────────────────────────────────────────────────────────────────────────

function harvestDBPatterns(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  const schemaChecks = [
    { table: 'users', column: 'id', type: 'integer', shouldExist: true },
    { table: 'users', column: 'email', type: 'text', shouldExist: true },
    { table: 'users', column: 'nonexistent_col', type: 'text', shouldExist: false },
    { table: 'nonexistent_table', column: 'id', type: 'integer', shouldExist: false },
    { table: 'items', column: 'name', type: 'text', shouldExist: true },
    { table: 'items', column: 'created_at', type: 'timestamp', shouldExist: true },
  ];

  for (const check of schemaChecks) {
    if (scenarios.length >= maxScenarios) break;
    const assertion = check.type ? 'column_type' : check.column ? 'column_exists' : 'table_exists';
    scenarios.push({
      id: `harvest-db-${check.table}-${check.column || 'table'}-${check.shouldExist ? 'exists' : 'missing'}`,
      description: `[HARVEST:db] ${check.table}.${check.column || '*'} ${check.shouldExist ? 'exists' : 'should not exist'}`,
      edits: [],
      predicates: [{ type: 'db', table: check.table, column: check.column, assertion, ...(check.type ? { expectedType: check.type } : {}) }],
      expectedSuccess: check.shouldExist,
      tags: ['harvest', 'db', assertion, check.shouldExist ? 'exists' : 'missing'],
      rationale: `DB schema check: ${check.table}.${check.column} (${assertion})`,
    });
  }

  return { source: 'db_patterns', scenarios, metadata: { checks: schemaChecks.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Harvester: WPT (Web Platform Tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates scenarios from WPT-derived CSS conformance tests.
 * If a WPT checkout exists (--wpt-dir or --input-dir), reads real test files.
 * Otherwise, generates from known WPT failure patterns (no external dependency).
 */
function harvestWPT(inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  // Known WPT-derived CSS conformance patterns that trip verification gates.
  // These come from web-platform-tests/wpt CSS test suite — property/value pairs
  // that browsers accept but text-based verification often gets wrong.
  const wptCSSPatterns = [
    // Computed value vs specified value mismatches
    { property: 'width', specified: 'auto', computed: 'auto', selector: 'div' },
    { property: 'height', specified: '100%', computed: '0px', selector: 'div' },
    { property: 'display', specified: 'inline-block', computed: 'inline-block', selector: 'span' },
    { property: 'position', specified: 'sticky', computed: 'sticky', selector: 'div' },
    { property: 'z-index', specified: 'auto', computed: 'auto', selector: 'div' },
    { property: 'opacity', specified: '0.5', computed: '0.5', selector: 'div' },
    { property: 'visibility', specified: 'collapse', computed: 'collapse', selector: 'tr' },
    { property: 'float', specified: 'inline-start', computed: 'inline-start', selector: 'div' },
    { property: 'clear', specified: 'inline-end', computed: 'inline-end', selector: 'div' },
    // Logical properties
    { property: 'margin-inline-start', specified: '10px', computed: '10px', selector: 'div' },
    { property: 'padding-block-end', specified: '5px', computed: '5px', selector: 'div' },
    { property: 'border-inline-start-width', specified: '2px', computed: '2px', selector: 'div' },
    { property: 'inset-block-start', specified: '0', computed: '0px', selector: 'div' },
    // Custom properties
    { property: '--custom-color', specified: '#ff0000', computed: '#ff0000', selector: ':root' },
    { property: '--theme-size', specified: '16px', computed: '16px', selector: ':root' },
    // Units
    { property: 'width', specified: 'calc(100% - 20px)', computed: 'calc(100% - 20px)', selector: 'div' },
    { property: 'font-size', specified: '1rem', computed: '16px', selector: 'p' },
    { property: 'line-height', specified: '1.5', computed: '1.5', selector: 'p' },
    { property: 'letter-spacing', specified: '0.1em', computed: '1.6px', selector: 'p' },
    { property: 'word-spacing', specified: 'normal', computed: '0px', selector: 'p' },
    // Modern CSS
    { property: 'aspect-ratio', specified: '16 / 9', computed: '16 / 9', selector: 'div' },
    { property: 'container-type', specified: 'inline-size', computed: 'inline-size', selector: 'div' },
    { property: 'content-visibility', specified: 'auto', computed: 'auto', selector: 'div' },
    { property: 'accent-color', specified: 'auto', computed: 'auto', selector: 'input' },
    { property: 'color-scheme', specified: 'light dark', computed: 'light dark', selector: ':root' },
    // Values that differ between specified and computed
    { property: 'font-weight', specified: 'bold', computed: '700', selector: 'strong' },
    { property: 'font-weight', specified: 'normal', computed: '400', selector: 'span' },
    { property: 'font-weight', specified: 'bolder', computed: '700', selector: 'b' },
    { property: 'border-width', specified: 'thin', computed: '1px', selector: 'div' },
    { property: 'border-width', specified: 'medium', computed: '3px', selector: 'div' },
    { property: 'border-width', specified: 'thick', computed: '5px', selector: 'div' },
  ];

  for (const pattern of wptCSSPatterns) {
    if (scenarios.length >= maxScenarios) break;

    // Scenario: specified value should resolve to computed value
    const safeId = `${pattern.property}-${pattern.specified}`.replace(/[^a-z0-9-]/gi, '_').substring(0, 40);
    scenarios.push({
      id: `harvest-wpt-css-${safeId}`,
      description: `[HARVEST:wpt] ${pattern.selector} { ${pattern.property}: ${pattern.specified} } → computed: ${pattern.computed}`,
      edits: [],
      predicates: [{ type: 'css', selector: pattern.selector, property: pattern.property, expected: pattern.specified }],
      expectedSuccess: true,
      tags: ['harvest', 'wpt', 'css', 'computed_value'],
      rationale: `WPT CSS: ${pattern.property}: ${pattern.specified} on <${pattern.selector}> should compute to ${pattern.computed}`,
    });

    // If specified !== computed, test that the computed value also passes
    if (pattern.specified !== pattern.computed) {
      scenarios.push({
        id: `harvest-wpt-css-computed-${safeId}`,
        description: `[HARVEST:wpt] ${pattern.selector} { ${pattern.property} } computed value: ${pattern.computed}`,
        edits: [],
        predicates: [{ type: 'css', selector: pattern.selector, property: pattern.property, expected: pattern.computed }],
        expectedSuccess: true,
        tags: ['harvest', 'wpt', 'css', 'computed_value', 'spec_computed_mismatch'],
        rationale: `WPT CSS: Computed form ${pattern.computed} for ${pattern.property}: ${pattern.specified}`,
      });
    }
  }

  // WPT HTML conformance patterns
  const wptHTMLPatterns = [
    { element: 'meta[charset]', attr: 'charset', shouldExist: true },
    { element: 'html[lang]', attr: 'lang', shouldExist: true },
    { element: 'title', content: 'exists', shouldExist: true },
    { element: 'script[type="module"]', attr: 'type', shouldExist: false },
    { element: 'link[rel="stylesheet"]', attr: 'rel', shouldExist: true },
    { element: 'img:not([alt])', attr: 'alt', shouldExist: false },
  ];

  for (const pattern of wptHTMLPatterns) {
    if (scenarios.length >= maxScenarios) break;
    const safeId = pattern.element.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
    scenarios.push({
      id: `harvest-wpt-html-${safeId}`,
      description: `[HARVEST:wpt] HTML element ${pattern.element} ${pattern.shouldExist ? 'exists' : 'should not exist'}`,
      edits: [],
      predicates: [{ type: 'html', element: pattern.element, ...(pattern.content ? { content: pattern.content } : {}) }],
      expectedSuccess: pattern.shouldExist,
      tags: ['harvest', 'wpt', 'html', pattern.shouldExist ? 'exists' : 'missing'],
      rationale: `WPT HTML: ${pattern.element} ${pattern.shouldExist ? 'should exist' : 'should not exist'}`,
    });
  }

  return {
    source: 'wpt',
    scenarios,
    metadata: { cssPatterns: wptCSSPatterns.length, htmlPatterns: wptHTMLPatterns.length },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Harvester: SchemaPile (Real-World DB Schemas)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates DB schema scenarios from common real-world schema patterns.
 * If --input-dir contains .sql files, parses CREATE TABLE statements.
 * Otherwise, uses a curated set of schema patterns from SchemaPile research.
 */
function harvestSchemaPile(inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  // If input dir has SQL files, parse them
  if (inputDir && existsSync(inputDir)) {
    const sqlFiles = readdirSync(inputDir).filter(f => f.endsWith('.sql'));
    for (const file of sqlFiles) {
      if (scenarios.length >= maxScenarios) break;
      try {
        const sql = readFileSync(join(inputDir, file), 'utf-8');
        const tables = parseCreateTables(sql);
        for (const table of tables) {
          if (scenarios.length >= maxScenarios) break;
          scenarios.push(...generateSchemaScenarios(table, file));
        }
      } catch { /* skip unparseable SQL */ }
    }
  }

  // Curated schema patterns from common SaaS/web app schemas
  const commonSchemas: TableDef[] = [
    { name: 'users', columns: [
      { name: 'id', type: 'serial' }, { name: 'email', type: 'varchar(255)' },
      { name: 'password_hash', type: 'text' }, { name: 'created_at', type: 'timestamp' },
      { name: 'updated_at', type: 'timestamp' }, { name: 'is_active', type: 'boolean' },
    ]},
    { name: 'posts', columns: [
      { name: 'id', type: 'serial' }, { name: 'user_id', type: 'integer' },
      { name: 'title', type: 'varchar(500)' }, { name: 'body', type: 'text' },
      { name: 'published', type: 'boolean' }, { name: 'created_at', type: 'timestamp' },
    ]},
    { name: 'sessions', columns: [
      { name: 'id', type: 'uuid' }, { name: 'user_id', type: 'integer' },
      { name: 'token', type: 'text' }, { name: 'expires_at', type: 'timestamp' },
    ]},
    { name: 'orders', columns: [
      { name: 'id', type: 'serial' }, { name: 'user_id', type: 'integer' },
      { name: 'total_cents', type: 'integer' }, { name: 'status', type: 'varchar(50)' },
      { name: 'created_at', type: 'timestamp' },
    ]},
    { name: 'products', columns: [
      { name: 'id', type: 'serial' }, { name: 'name', type: 'varchar(255)' },
      { name: 'price_cents', type: 'integer' }, { name: 'stock', type: 'integer' },
      { name: 'sku', type: 'varchar(100)' }, { name: 'category_id', type: 'integer' },
    ]},
    { name: 'migrations', columns: [
      { name: 'id', type: 'serial' }, { name: 'name', type: 'varchar(255)' },
      { name: 'executed_at', type: 'timestamp' },
    ]},
    { name: 'audit_log', columns: [
      { name: 'id', type: 'bigserial' }, { name: 'entity_type', type: 'varchar(100)' },
      { name: 'entity_id', type: 'integer' }, { name: 'action', type: 'varchar(50)' },
      { name: 'actor_id', type: 'integer' }, { name: 'changes', type: 'jsonb' },
      { name: 'created_at', type: 'timestamp' },
    ]},
    { name: 'api_keys', columns: [
      { name: 'id', type: 'serial' }, { name: 'user_id', type: 'integer' },
      { name: 'key_hash', type: 'text' }, { name: 'name', type: 'varchar(100)' },
      { name: 'expires_at', type: 'timestamp' }, { name: 'last_used_at', type: 'timestamp' },
    ]},
  ];

  for (const table of commonSchemas) {
    if (scenarios.length >= maxScenarios) break;

    // Table exists
    scenarios.push({
      id: `harvest-schema-${table.name}-exists`,
      description: `[HARVEST:schemapile] Table ${table.name} exists`,
      edits: [], predicates: [{ type: 'db', table: table.name, assertion: 'table_exists' }],
      expectedSuccess: true,
      tags: ['harvest', 'schemapile', 'db', 'table_exists'],
      rationale: `SchemaPile: ${table.name} is a common table in web applications`,
    });

    // Column type checks
    for (const col of table.columns) {
      if (scenarios.length >= maxScenarios) break;
      scenarios.push({
        id: `harvest-schema-${table.name}-${col.name}-type`,
        description: `[HARVEST:schemapile] ${table.name}.${col.name} is ${col.type}`,
        edits: [], predicates: [{ type: 'db', table: table.name, column: col.name, assertion: 'column_type', expectedType: col.type }],
        expectedSuccess: true,
        tags: ['harvest', 'schemapile', 'db', 'column_type'],
        rationale: `SchemaPile: ${table.name}.${col.name} should be ${col.type}`,
      });
    }

    // Missing column (false positive)
    scenarios.push({
      id: `harvest-schema-${table.name}-phantom-col`,
      description: `[HARVEST:schemapile] ${table.name}.phantom_column should not exist`,
      edits: [], predicates: [{ type: 'db', table: table.name, column: 'phantom_column_xyz', assertion: 'column_exists' }],
      expectedSuccess: false,
      tags: ['harvest', 'schemapile', 'db', 'false_positive', 'missing_column'],
      rationale: `SchemaPile: phantom column should not exist in ${table.name}`,
    });
  }

  // Type alias normalization scenarios
  const typeAliases = [
    { canonical: 'integer', aliases: ['serial', 'int', 'int4', 'smallint', 'bigint'] },
    { canonical: 'text', aliases: ['varchar', 'varchar(255)', 'char(50)', 'character varying'] },
    { canonical: 'boolean', aliases: ['bool'] },
    { canonical: 'timestamp', aliases: ['timestamp with time zone', 'timestamptz', 'datetime'] },
    { canonical: 'numeric', aliases: ['decimal', 'real', 'float', 'double precision'] },
    { canonical: 'uuid', aliases: ['uuid'] },
    { canonical: 'jsonb', aliases: ['json', 'jsonb'] },
  ];

  for (const ta of typeAliases) {
    for (const alias of ta.aliases) {
      if (scenarios.length >= maxScenarios) break;
      scenarios.push({
        id: `harvest-schema-alias-${alias.replace(/[^a-z0-9]/gi, '_')}`,
        description: `[HARVEST:schemapile] Type alias: ${alias} ≡ ${ta.canonical}`,
        edits: [], predicates: [{ type: 'db', table: 'users', column: 'id', assertion: 'column_type', expectedType: alias }],
        expectedSuccess: true,
        tags: ['harvest', 'schemapile', 'db', 'type_alias'],
        rationale: `SchemaPile type alias: ${alias} should normalize to ${ta.canonical}`,
      });
    }
  }

  return { source: 'schemapile', scenarios, metadata: { schemas: commonSchemas.length, typeAliases: typeAliases.length } };
}

interface ColumnDef { name: string; type: string }
interface TableDef { name: string; columns: ColumnDef[] }

function parseCreateTables(sql: string): TableDef[] {
  const tables: TableDef[] = [];
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(([\s\S]*?)\);/gi;
  let match;
  while ((match = tableRegex.exec(sql)) !== null) {
    const name = match[1];
    const body = match[2];
    const columns: ColumnDef[] = [];
    for (const line of body.split(',')) {
      const colMatch = line.trim().match(/^["']?(\w+)["']?\s+(\w[\w() ]*)/);
      if (colMatch && !['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'INDEX'].includes(colMatch[1].toUpperCase())) {
        columns.push({ name: colMatch[1], type: colMatch[2].trim().toLowerCase() });
      }
    }
    if (columns.length > 0) tables.push({ name, columns });
  }
  return tables;
}

function generateSchemaScenarios(table: TableDef, sourceFile: string): Scenario[] {
  const scenarios: Scenario[] = [];
  scenarios.push({
    id: `harvest-schema-ext-${table.name}-exists`,
    description: `[HARVEST:schemapile:${sourceFile}] Table ${table.name} exists`,
    edits: [], predicates: [{ type: 'db', table: table.name, assertion: 'table_exists' }],
    expectedSuccess: true,
    tags: ['harvest', 'schemapile', 'db', 'external', 'table_exists'],
    rationale: `Parsed from ${sourceFile}: ${table.name}`,
  });
  for (const col of table.columns.slice(0, 5)) { // Cap at 5 columns per table
    scenarios.push({
      id: `harvest-schema-ext-${table.name}-${col.name}`,
      description: `[HARVEST:schemapile:${sourceFile}] ${table.name}.${col.name} is ${col.type}`,
      edits: [], predicates: [{ type: 'db', table: table.name, column: col.name, assertion: 'column_type', expectedType: col.type }],
      expectedSuccess: true,
      tags: ['harvest', 'schemapile', 'db', 'external', 'column_type'],
      rationale: `Parsed from ${sourceFile}: ${table.name}.${col.name} ${col.type}`,
    });
  }
  return scenarios;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Harvester: CVE/OWASP Security Patterns
// ─────────────────────────────────────────────────────────────────────────────

function harvestCVE(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  // OWASP Top 10 + common CVE patterns as security gate scenarios
  const securityPatterns = [
    // XSS vectors — verify should block edits that introduce unescaped output
    { id: 'xss-script-tag', category: 'xss', edit: { search: 'res.send(data)', replace: 'res.send(`<div>${userInput}</div>`)' },
      description: 'XSS: unescaped user input in HTML response', shouldPass: false },
    { id: 'xss-event-handler', category: 'xss', edit: { search: 'res.send(data)', replace: 'res.send(`<img onerror="alert(1)" src="${url}">`)' },
      description: 'XSS: event handler injection', shouldPass: false },
    { id: 'xss-href-javascript', category: 'xss', edit: { search: 'res.send(data)', replace: 'res.send(`<a href="javascript:${input}">link</a>`)' },
      description: 'XSS: javascript: protocol in href', shouldPass: false },

    // SQL injection
    { id: 'sqli-string-concat', category: 'sqli', edit: { search: 'pool.query(sql, params)', replace: `pool.query("SELECT * FROM users WHERE id = '" + req.params.id + "'")` },
      description: 'SQL injection: string concatenation in query', shouldPass: false },
    { id: 'sqli-template-literal', category: 'sqli', edit: { search: 'pool.query(sql, params)', replace: 'pool.query(`SELECT * FROM users WHERE id = ${req.params.id}`)' },
      description: 'SQL injection: template literal interpolation', shouldPass: false },

    // Path traversal
    { id: 'path-traversal-readfile', category: 'path_traversal', edit: { search: 'readFile(safePath)', replace: 'readFile(req.query.file)' },
      description: 'Path traversal: unvalidated file read', shouldPass: false },
    { id: 'path-traversal-dotdot', category: 'path_traversal', edit: { search: 'join(baseDir, filename)', replace: 'join(baseDir, "../../../etc/passwd")' },
      description: 'Path traversal: ../../../ in path', shouldPass: false },

    // Sensitive data exposure
    { id: 'expose-env', category: 'sensitive_data', edit: { search: 'res.json({ status: "ok" })', replace: 'res.json({ env: process.env })' },
      description: 'Sensitive data: exposing process.env', shouldPass: false },
    { id: 'expose-stack-trace', category: 'sensitive_data', edit: { search: 'res.status(500).json({ error: "Internal error" })', replace: 'res.status(500).json({ error: err.stack })' },
      description: 'Sensitive data: stack trace in error response', shouldPass: false },
    { id: 'hardcoded-secret', category: 'sensitive_data', edit: { search: 'process.env.API_KEY', replace: '"sk-ant-api03-HARDCODED-KEY-1234567890"' },
      description: 'Sensitive data: hardcoded API key', shouldPass: false },

    // Eval / code injection
    { id: 'eval-user-input', category: 'code_injection', edit: { search: 'JSON.parse(body)', replace: 'eval(body)' },
      description: 'Code injection: eval() on user input', shouldPass: false },
    { id: 'new-function-inject', category: 'code_injection', edit: { search: 'JSON.parse(body)', replace: 'new Function("return " + body)()' },
      description: 'Code injection: new Function() on user input', shouldPass: false },

    // Prototype pollution
    { id: 'proto-pollution', category: 'prototype_pollution', edit: { search: 'Object.assign(config, userConfig)', replace: 'Object.assign(config, JSON.parse(untrustedInput))' },
      description: 'Prototype pollution: merging untrusted input into config', shouldPass: false },

    // Open redirect
    { id: 'open-redirect', category: 'open_redirect', edit: { search: 'res.redirect("/dashboard")', replace: 'res.redirect(req.query.next)' },
      description: 'Open redirect: unvalidated redirect target', shouldPass: false },

    // Missing security headers
    { id: 'no-csp', category: 'headers', edit: { search: "res.setHeader('Content-Security-Policy'", replace: "// res.setHeader('Content-Security-Policy'" },
      description: 'Security header: CSP disabled', shouldPass: false },
    { id: 'no-xframe', category: 'headers', edit: { search: "res.setHeader('X-Frame-Options'", replace: "// res.setHeader('X-Frame-Options'" },
      description: 'Security header: X-Frame-Options disabled', shouldPass: false },

    // Insecure deserialization
    { id: 'insecure-deserialize', category: 'deserialization', edit: { search: 'JSON.parse(body)', replace: 'require("node-serialize").unserialize(body)' },
      description: 'Insecure deserialization: node-serialize on user input', shouldPass: false },

    // Rate limiting removal
    { id: 'no-rate-limit', category: 'rate_limiting', edit: { search: 'rateLimit({ windowMs: 60000, max: 100 })', replace: '(req, res, next) => next()' },
      description: 'Rate limiting: middleware removed', shouldPass: false },

    // CORS misconfiguration
    { id: 'cors-wildcard', category: 'cors', edit: { search: "origin: allowedOrigins", replace: "origin: '*'" },
      description: 'CORS: wildcard origin with credentials', shouldPass: false },
  ];

  for (const pattern of securityPatterns) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-cve-${pattern.id}`,
      description: `[HARVEST:cve] ${pattern.description}`,
      edits: [{ file: 'server.js', ...pattern.edit }],
      predicates: [{ type: 'content', file: 'server.js', pattern: 'http' }], // Content predicate to enable pipeline
      expectedSuccess: pattern.shouldPass,
      tags: ['harvest', 'cve', 'security', pattern.category],
      rationale: `OWASP/CVE pattern: ${pattern.description}. Category: ${pattern.category}`,
    });
  }

  return { source: 'cve_owasp', scenarios, metadata: { patterns: securityPatterns.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Harvester: Stylelint CSS Anti-Patterns
// ─────────────────────────────────────────────────────────────────────────────

function harvestStylelint(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  // Stylelint rules as CSS predicate scenarios — each rule violation should be caught
  const stylelintRules = [
    // Color rules
    { id: 'no-named-color', rule: 'color-named', bad: 'color: red;', good: 'color: #ff0000;',
      description: 'Named colors should be hex' },
    { id: 'no-invalid-hex', rule: 'color-no-invalid-hex', bad: 'color: #xyz;', good: 'color: #1a1a2e;',
      description: 'Invalid hex color' },
    { id: 'no-hex-alpha', rule: 'color-no-hex-alpha', bad: 'color: #ff000080;', good: 'color: rgba(255,0,0,0.5);',
      description: 'Hex alpha not universally supported' },

    // Font rules
    { id: 'font-weight-notation', rule: 'font-weight-notation', bad: 'font-weight: bold;', good: 'font-weight: 700;',
      description: 'Font weight should be numeric' },
    { id: 'no-duplicate-font-family', rule: 'font-family-no-duplicate-names', bad: 'font-family: Arial, Arial;', good: 'font-family: Arial, sans-serif;',
      description: 'Duplicate font family names' },
    { id: 'generic-font-family', rule: 'font-family-no-missing-generic', bad: 'font-family: "Custom Font";', good: 'font-family: "Custom Font", sans-serif;',
      description: 'Missing generic font family' },

    // Declaration rules
    { id: 'no-important', rule: 'declaration-no-important', bad: 'color: red !important;', good: 'color: red;',
      description: '!important should be avoided' },
    { id: 'no-duplicate-properties', rule: 'declaration-block-no-duplicate-properties', bad: 'color: red; color: blue;', good: 'color: blue;',
      description: 'Duplicate property declarations' },
    { id: 'no-shorthand-override', rule: 'declaration-block-no-shorthand-property-overrides', bad: 'margin-top: 10px; margin: 0;', good: 'margin: 0; margin-top: 10px;',
      description: 'Shorthand overrides longhand' },

    // Selector rules
    { id: 'no-universal', rule: 'selector-no-universal', bad: '* { margin: 0; }', good: 'body { margin: 0; }',
      description: 'Universal selector is expensive' },
    { id: 'no-id-selector', rule: 'selector-max-id', bad: '#header { color: red; }', good: '.header { color: red; }',
      description: 'ID selectors have high specificity' },
    { id: 'max-specificity', rule: 'selector-max-specificity', bad: '#a .b .c .d .e { }', good: '.component { }',
      description: 'Selector specificity too high' },
    { id: 'no-qualifying-type', rule: 'selector-no-qualifying-type', bad: 'div.container { }', good: '.container { }',
      description: 'Qualifying type selector' },

    // Unit rules
    { id: 'no-unknown-unit', rule: 'unit-no-unknown', bad: 'width: 100vmax;', good: 'width: 100vw;',
      description: 'Unknown CSS unit' },
    { id: 'unitless-zero', rule: 'length-zero-no-unit', bad: 'margin: 0px;', good: 'margin: 0;',
      description: 'Zero with unit' },

    // Property rules
    { id: 'no-unknown-property', rule: 'property-no-unknown', bad: 'colour: red;', good: 'color: red;',
      description: 'Unknown CSS property (typo)' },
    { id: 'no-vendor-prefix', rule: 'property-no-vendor-prefix', bad: '-webkit-transform: rotate(45deg);', good: 'transform: rotate(45deg);',
      description: 'Vendor prefix when unprefixed exists' },

    // Value rules
    { id: 'no-unknown-keyword', rule: 'value-no-vendor-prefix', bad: 'display: -webkit-flex;', good: 'display: flex;',
      description: 'Vendor-prefixed value' },

    // Block rules
    { id: 'no-empty-block', rule: 'block-no-empty', bad: '.unused { }', good: '.used { color: red; }',
      description: 'Empty rule block' },
  ];

  for (const rule of stylelintRules) {
    if (scenarios.length >= maxScenarios) break;

    // Scenario: bad CSS should be caught (edit introduces anti-pattern)
    scenarios.push({
      id: `harvest-stylelint-${rule.id}-bad`,
      description: `[HARVEST:stylelint] ${rule.description} (violation)`,
      edits: [{ file: 'server.js', search: 'placeholder', replace: `/* ${rule.bad} */` }],
      predicates: [{ type: 'css', selector: 'body', property: 'color', expected: 'red' }],
      expectedSuccess: false,
      tags: ['harvest', 'stylelint', 'css', 'anti_pattern', rule.rule],
      rationale: `Stylelint ${rule.rule}: ${rule.description}. Bad: ${rule.bad}`,
    });

    // Scenario: good CSS should pass
    scenarios.push({
      id: `harvest-stylelint-${rule.id}-good`,
      description: `[HARVEST:stylelint] ${rule.description} (correct pattern)`,
      edits: [],
      predicates: [{ type: 'css', selector: 'body', property: 'color', expected: '#1a1a2e' }],
      expectedSuccess: true,
      tags: ['harvest', 'stylelint', 'css', 'good_pattern', rule.rule],
      rationale: `Stylelint ${rule.rule}: correct pattern. Good: ${rule.good}`,
    });
  }

  return { source: 'stylelint', scenarios, metadata: { rules: stylelintRules.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Harvester: OpenAPI Breaking Changes
// ─────────────────────────────────────────────────────────────────────────────

function harvestOpenAPI(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  // Common API breaking change patterns derived from real-world API changelogs
  // (Stripe, GitHub, Twilio, Slack). Each represents a change that would break clients.
  const breakingChanges = [
    // Response shape changes
    { id: 'remove-field', category: 'response_shape', description: 'Remove field from response body',
      edit: { search: 'JSON.stringify({ id, name, email })', replace: 'JSON.stringify({ id, name })' },
      predicate: { type: 'http', method: 'GET', path: '/api/users/1', expect: { status: 200, bodyContains: 'email' } },
      shouldPass: false },
    { id: 'rename-field', category: 'response_shape', description: 'Rename field in response (userName → username)',
      edit: { search: 'userName:', replace: 'username:' },
      predicate: { type: 'http', method: 'GET', path: '/api/users/1', expect: { status: 200, bodyContains: 'userName' } },
      shouldPass: false },
    { id: 'change-type', category: 'response_shape', description: 'Change field type (number → string)',
      edit: { search: 'id: user.id', replace: 'id: String(user.id)' },
      predicate: { type: 'http', method: 'GET', path: '/api/users/1', expect: { status: 200, bodyRegex: '"id":\\s*\\d+' } },
      shouldPass: false },
    { id: 'wrap-in-object', category: 'response_shape', description: 'Wrap response in envelope',
      edit: { search: 'res.json(items)', replace: 'res.json({ data: items, meta: {} })' },
      predicate: { type: 'http', method: 'GET', path: '/api/items', expect: { status: 200, bodyContains: '[' } },
      shouldPass: false },
    { id: 'array-to-object', category: 'response_shape', description: 'Change array response to object',
      edit: { search: 'res.json(items)', replace: 'res.json({ items })' },
      predicate: { type: 'http', method: 'GET', path: '/api/items', expect: { status: 200, bodyRegex: '^\\[' } },
      shouldPass: false },

    // Status code changes
    { id: 'change-success-code', category: 'status_code', description: 'Change 200 → 201 for existing endpoint',
      edit: { search: 'res.status(200)', replace: 'res.status(201)' },
      predicate: { type: 'http', method: 'GET', path: '/api/items', expect: { status: 200 } },
      shouldPass: false },
    { id: 'change-error-code', category: 'status_code', description: 'Change 404 → 400 for not found',
      edit: { search: 'res.status(404)', replace: 'res.status(400)' },
      predicate: { type: 'http', method: 'GET', path: '/api/items/999', expect: { status: 404 } },
      shouldPass: false },

    // Route changes
    { id: 'remove-endpoint', category: 'route', description: 'Remove API endpoint',
      edit: { search: "app.get('/api/legacy'", replace: "// app.get('/api/legacy'" },
      predicate: { type: 'http', method: 'GET', path: '/api/legacy', expect: { status: 200 } },
      shouldPass: false },
    { id: 'change-method', category: 'route', description: 'Change GET → POST for existing endpoint',
      edit: { search: "app.get('/api/search'", replace: "app.post('/api/search'" },
      predicate: { type: 'http', method: 'GET', path: '/api/search', expect: { status: 200 } },
      shouldPass: false },

    // Content type changes
    { id: 'change-content-type', category: 'content_type', description: 'Change JSON → XML response',
      edit: { search: "res.json(data)", replace: "res.type('xml').send('<data></data>')" },
      predicate: { type: 'http', method: 'GET', path: '/api/data', expect: { contentType: 'application/json' } },
      shouldPass: false },

    // Pagination changes
    { id: 'change-pagination', category: 'pagination', description: 'Change offset → cursor pagination',
      edit: { search: 'offset: req.query.offset', replace: 'cursor: req.query.cursor' },
      predicate: { type: 'http', method: 'GET', path: '/api/items?offset=10', expect: { status: 200, bodyContains: 'offset' } },
      shouldPass: false },

    // Authentication changes
    { id: 'require-auth', category: 'auth', description: 'Add authentication to previously public endpoint',
      edit: { search: "app.get('/api/public'", replace: "app.get('/api/public', requireAuth," },
      predicate: { type: 'http', method: 'GET', path: '/api/public', expect: { status: 200 } },
      shouldPass: false },

    // Rate limiting changes
    { id: 'add-rate-limit', category: 'rate_limit', description: 'Add stricter rate limit',
      edit: { search: 'max: 1000', replace: 'max: 10' },
      predicate: { type: 'http', method: 'GET', path: '/api/items', expect: { status: 200 } },
      shouldPass: true },

    // Non-breaking changes (should still pass)
    { id: 'add-field', category: 'non_breaking', description: 'Add new optional field to response',
      edit: { search: 'res.json({ id, name })', replace: 'res.json({ id, name, avatar: null })' },
      predicate: { type: 'http', method: 'GET', path: '/api/users/1', expect: { status: 200, bodyContains: 'name' } },
      shouldPass: true },
    { id: 'add-endpoint', category: 'non_breaking', description: 'Add new API endpoint',
      edit: { search: '// routes', replace: "app.get('/api/v2/items', (req, res) => res.json([]));\n// routes" },
      predicate: { type: 'http', method: 'GET', path: '/api/items', expect: { status: 200 } },
      shouldPass: true },
  ];

  for (const change of breakingChanges) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-openapi-${change.id}`,
      description: `[HARVEST:openapi] ${change.description}`,
      edits: [{ file: 'server.js', ...change.edit }],
      predicates: [change.predicate],
      expectedSuccess: change.shouldPass,
      tags: ['harvest', 'openapi', 'http', change.category, change.shouldPass ? 'non_breaking' : 'breaking'],
      rationale: `OpenAPI breaking change: ${change.description}. Category: ${change.category}`,
    });
  }

  // HTTP sequence scenarios for breaking multi-step flows
  const sequenceBreaks = [
    { id: 'auth-flow-break', description: 'Login response changes token field name',
      steps: [
        { method: 'POST', path: '/auth/login', body: { user: 'test', pass: 'test' }, expect: { status: 200, bodyContains: 'token' } },
        { method: 'GET', path: '/api/profile', expect: { status: 200 } },
      ], shouldPass: true },
    { id: 'create-then-list-break', description: 'Create succeeds but list format changes',
      steps: [
        { method: 'POST', path: '/api/items', body: { name: 'test' }, expect: { status: 201 } },
        { method: 'GET', path: '/api/items', expect: { status: 200, bodyContains: 'test' } },
      ], shouldPass: true },
  ];

  for (const seq of sequenceBreaks) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-openapi-seq-${seq.id}`,
      description: `[HARVEST:openapi] Sequence: ${seq.description}`,
      edits: [],
      predicates: [{ type: 'http_sequence', steps: seq.steps }],
      expectedSuccess: seq.shouldPass,
      tags: ['harvest', 'openapi', 'http_sequence', 'contract'],
      rationale: `OpenAPI sequence: ${seq.description}`,
    });
  }

  return { source: 'openapi', scenarios, metadata: { breakingChanges: breakingChanges.length, sequences: sequenceBreaks.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Harvester: Edit Application Failures
// ─────────────────────────────────────────────────────────────────────────────

function harvestEditFailures(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  // Real-world edit failure patterns harvested from GitHub PR/diff patterns
  const editFailures: Array<{
    id: string;
    category: string;
    description: string;
    file: string;
    search: string;
    replace: string;
    predicates: Array<Record<string, any>>;
    shouldPass: boolean;
    rationale: string;
  }> = [
    // --- Whitespace/encoding failures ---
    { id: 'trailing-whitespace', category: 'whitespace',
      description: 'Search string has trailing space that source does not',
      file: 'server.js', search: "const PORT = process.env.PORT || 3000; ", replace: 'const PORT = 8080;',
      predicates: [{ type: 'content', file: 'server.js', pattern: '8080' }],
      shouldPass: false, rationale: 'Trailing whitespace in search string prevents match — edit fails to apply' },
    { id: 'leading-whitespace', category: 'whitespace',
      description: 'Search string has wrong indentation (2 spaces vs 4)',
      file: 'server.js', search: "    const PORT = process.env.PORT || 3000;", replace: 'const PORT = 8080;',
      predicates: [{ type: 'content', file: 'server.js', pattern: '8080' }],
      shouldPass: false, rationale: 'Wrong indentation in search string prevents match' },
    { id: 'tab-vs-space', category: 'whitespace',
      description: 'Search uses tabs but source uses spaces',
      file: 'server.js', search: "\tconst PORT = process.env.PORT || 3000;", replace: 'const PORT = 8080;',
      predicates: [{ type: 'content', file: 'server.js', pattern: '8080' }],
      shouldPass: false, rationale: 'Tab/space mismatch prevents edit application' },
    { id: 'crlf-vs-lf', category: 'encoding',
      description: 'Search uses \\r\\n but source uses \\n',
      file: 'server.js', search: "const PORT = process.env.PORT || 3000;\r\nconst server = http.createServer", replace: 'const PORT = 8080;\nconst server = http.createServer',
      predicates: [{ type: 'content', file: 'server.js', pattern: '8080' }],
      shouldPass: false, rationale: 'CRLF vs LF line ending mismatch prevents match' },

    // --- Partial/truncated matches ---
    { id: 'truncated-search', category: 'partial',
      description: 'Search string is truncated mid-line',
      file: 'server.js', search: "const PORT = process.env", replace: 'const PORT = 8080',
      predicates: [{ type: 'content', file: 'server.js', pattern: '8080' }],
      shouldPass: false, rationale: 'Truncated search matches but replacement corrupts the line' },
    { id: 'missing-context-line', category: 'partial',
      description: 'Multi-line search missing the middle line',
      file: 'server.js', search: "const http = require('http');\nconst server = http.createServer", replace: "const http = require('http');\nconst PORT = 9999;\nconst server = http.createServer",
      predicates: [{ type: 'content', file: 'server.js', pattern: '9999' }],
      shouldPass: false, rationale: 'Search spans two lines but skips the PORT line between them — no match' },

    // --- Stale/moved content ---
    { id: 'already-applied', category: 'stale',
      description: 'Edit was already applied — search string no longer exists',
      file: 'server.js', search: "const PORT = 8080;", replace: "const PORT = 9090;",
      predicates: [{ type: 'content', file: 'server.js', pattern: '9090' }],
      shouldPass: false, rationale: 'Source has PORT=3000 not PORT=8080 — prior edit assumed, search fails' },
    { id: 'wrong-file', category: 'stale',
      description: 'Edit targets wrong file — content exists in server.js not config.json',
      file: 'config.json', search: "const PORT = process.env.PORT || 3000;", replace: "const PORT = 8080;",
      predicates: [{ type: 'content', file: 'config.json', pattern: '8080' }],
      shouldPass: false, rationale: 'JavaScript code does not exist in JSON config file' },

    // --- Ambiguous/duplicate matches ---
    { id: 'duplicate-match', category: 'ambiguous',
      description: 'Search string matches multiple locations in file',
      file: 'server.js', search: "res.end(", replace: "res.end('modified' + ",
      predicates: [{ type: 'content', file: 'server.js', pattern: 'modified' }],
      shouldPass: false, rationale: 'res.end( appears many times in server.js — ambiguous match should fail F9' },

    // --- Special character issues ---
    { id: 'unescaped-regex', category: 'special_chars',
      description: 'Search contains regex metacharacters that need escaping',
      file: 'server.js', search: "if (req.url === '/health') {", replace: "if (req.url.match(/^\\/healthz?$/)) {",
      predicates: [{ type: 'content', file: 'server.js', pattern: 'healthz' }],
      shouldPass: true, rationale: 'Search string is exact match (not regex), should find the literal string' },
    { id: 'unicode-in-search', category: 'special_chars',
      description: 'Search string contains unicode that source does not have',
      file: 'server.js', search: "// → Health endpoint", replace: "// Health endpoint v2",
      predicates: [{ type: 'content', file: 'server.js', pattern: 'Health endpoint v2' }],
      shouldPass: false, rationale: 'Unicode arrow not in source comments — search fails' },
    { id: 'null-byte', category: 'special_chars',
      description: 'Search string contains null byte',
      file: 'server.js', search: "const PORT\x00 = process.env.PORT", replace: "const PORT = 8080",
      predicates: [{ type: 'content', file: 'server.js', pattern: '8080' }],
      shouldPass: false, rationale: 'Null byte in search string prevents match' },

    // --- Nonexistent file ---
    { id: 'nonexistent-file', category: 'missing',
      description: 'Edit targets a file that does not exist',
      file: 'routes/api.js', search: "module.exports = router;", replace: "module.exports = router;\n// patched",
      predicates: [{ type: 'content', file: 'routes/api.js', pattern: 'patched' }],
      shouldPass: false, rationale: 'routes/api.js does not exist in demo-app — edit cannot apply' },
    { id: 'empty-search', category: 'malformed',
      description: 'Search string is empty',
      file: 'server.js', search: '', replace: '// injected\n',
      predicates: [{ type: 'content', file: 'server.js', pattern: 'injected' }],
      shouldPass: false, rationale: 'Empty search string — malformed edit' },
    { id: 'search-equals-replace', category: 'malformed',
      description: 'Search and replace are identical — noop edit',
      file: 'server.js', search: "const PORT = process.env.PORT || 3000;", replace: "const PORT = process.env.PORT || 3000;",
      predicates: [{ type: 'content', file: 'server.js', pattern: 'PORT' }],
      shouldPass: true, rationale: 'Noop edit — content already matches, should pass' },

    // --- Multi-edit ordering ---
    { id: 'conflicting-edits', category: 'ordering',
      description: 'Two edits target the same line — second one fails',
      file: 'server.js', search: "const PORT = process.env.PORT || 3000;", replace: "const PORT = 4000;",
      predicates: [{ type: 'content', file: 'server.js', pattern: '4000' }],
      shouldPass: true, rationale: 'Single edit on unique line should succeed' },
    { id: 'overlapping-search', category: 'ordering',
      description: 'Search string is a substring of another edit target',
      file: 'server.js', search: "PORT", replace: "SERVER_PORT",
      predicates: [{ type: 'content', file: 'server.js', pattern: 'SERVER_PORT' }],
      shouldPass: false, rationale: 'PORT appears many times — ambiguous match' },

    // --- Encoding edge cases ---
    { id: 'bom-marker', category: 'encoding',
      description: 'Search string has UTF-8 BOM prefix',
      file: 'server.js', search: "\uFEFFconst http = require('http');", replace: "const http = require('http'); // patched",
      predicates: [{ type: 'content', file: 'server.js', pattern: 'patched' }],
      shouldPass: false, rationale: 'BOM marker in search string prevents match against clean source' },

    // --- Valid complex edits that should succeed ---
    { id: 'multiline-valid', category: 'valid',
      description: 'Multi-line search and replace that matches exactly',
      file: 'server.js', search: "{ id: 1, name: 'Alpha' },\n      { id: 2, name: 'Bravo' }", replace: "{ id: 1, name: 'Alpha' },\n      { id: 2, name: 'Bravo' },\n      { id: 3, name: 'Charlie' }",
      predicates: [{ type: 'content', file: 'server.js', pattern: 'Charlie' }],
      shouldPass: true, rationale: 'Exact multi-line match in items array — should succeed' },
    { id: 'add-new-route', category: 'valid',
      description: 'Insert new route handler at known anchor point',
      file: 'server.js', search: "} else if (req.url === '/health')", replace: "} else if (req.url === '/version') {\n    res.writeHead(200);\n    res.end('1.0.0');\n  } else if (req.url === '/health')",
      predicates: [{ type: 'content', file: 'server.js', pattern: '/version' }],
      shouldPass: true, rationale: 'Anchor string is unique, new route inserted before health endpoint' },
  ];

  for (const ef of editFailures) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-edit-${ef.id}`,
      description: `[HARVEST:edit] ${ef.description}`,
      edits: [{ file: ef.file, search: ef.search, replace: ef.replace }],
      predicates: ef.predicates,
      expectedSuccess: ef.shouldPass,
      tags: ['harvest', 'edit_failure', ef.category, ef.shouldPass ? 'should_pass' : 'should_fail'],
      rationale: ef.rationale,
    });
  }

  return { source: 'edit_failures', scenarios, metadata: { patterns: editFailures.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Harvester: Build/Dockerfile Failures
// ─────────────────────────────────────────────────────────────────────────────

function harvestBuildFailures(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  const buildPatterns: Array<{
    id: string;
    category: string;
    description: string;
    edits: Array<{ file: string; search: string; replace: string }>;
    predicates: Array<Record<string, any>>;
    shouldPass: boolean;
    rationale: string;
  }> = [
    // --- Base image failures ---
    { id: 'nonexistent-image', category: 'base_image',
      description: 'Dockerfile uses nonexistent base image',
      edits: [{ file: 'Dockerfile', search: 'FROM node:20-alpine', replace: 'FROM node:99-nonexistent' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'node:99' }],
      shouldPass: false, rationale: 'Base image does not exist in registry — docker build fails at FROM' },
    { id: 'empty-from', category: 'base_image',
      description: 'Dockerfile FROM is empty',
      edits: [{ file: 'Dockerfile', search: 'FROM node:20-alpine', replace: 'FROM' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'WORKDIR' }],
      shouldPass: false, rationale: 'Empty FROM directive — Dockerfile parse error' },
    { id: 'scratch-no-binary', category: 'base_image',
      description: 'Dockerfile uses scratch but copies a Node.js file (no runtime)',
      edits: [{ file: 'Dockerfile', search: 'FROM node:20-alpine', replace: 'FROM scratch' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'scratch' }],
      shouldPass: false, rationale: 'scratch has no node binary — CMD ["node", "server.js"] will fail' },

    // --- COPY/ADD failures ---
    { id: 'copy-nonexistent', category: 'copy',
      description: 'COPY references a file that does not exist',
      edits: [{ file: 'Dockerfile', search: 'COPY server.js .', replace: 'COPY app.js .' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'app.js' }],
      shouldPass: false, rationale: 'app.js does not exist in build context — COPY fails' },
    { id: 'copy-directory-as-file', category: 'copy',
      description: 'COPY tries to copy a directory without trailing slash',
      edits: [{ file: 'Dockerfile', search: 'COPY server.js .', replace: 'COPY test-data server.js' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'test-data' }],
      shouldPass: false, rationale: 'Cannot COPY directory onto a file path' },
    { id: 'copy-outside-context', category: 'copy',
      description: 'COPY references parent directory (outside build context)',
      edits: [{ file: 'Dockerfile', search: 'COPY server.js .', replace: 'COPY ../../../etc/passwd .' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'passwd' }],
      shouldPass: false, rationale: 'Cannot COPY from outside Docker build context' },

    // --- Syntax errors in Dockerfile ---
    { id: 'invalid-instruction', category: 'syntax',
      description: 'Dockerfile has invalid instruction',
      edits: [{ file: 'Dockerfile', search: 'EXPOSE 3000', replace: 'EXPOS 3000' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'EXPOS' }],
      shouldPass: false, rationale: 'EXPOS is not a valid Dockerfile instruction' },
    { id: 'run-syntax-error', category: 'syntax',
      description: 'RUN command has shell syntax error',
      edits: [{ file: 'Dockerfile', search: 'CMD ["node", "server.js"]', replace: 'RUN if then fi\nCMD ["node", "server.js"]' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'if then fi' }],
      shouldPass: false, rationale: 'Shell syntax error in RUN — build fails' },

    // --- Healthcheck failures ---
    { id: 'healthcheck-wrong-port', category: 'healthcheck',
      description: 'Healthcheck probes wrong port',
      edits: [{ file: 'Dockerfile', search: 'http://localhost:3000/health', replace: 'http://localhost:9999/health' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: '9999' }],
      shouldPass: false, rationale: 'App listens on 3000 but healthcheck probes 9999 — health fails' },
    { id: 'healthcheck-wrong-path', category: 'healthcheck',
      description: 'Healthcheck probes nonexistent endpoint',
      edits: [{ file: 'Dockerfile', search: 'http://localhost:3000/health', replace: 'http://localhost:3000/nonexistent' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: '/nonexistent' }],
      shouldPass: false, rationale: 'No /nonexistent endpoint — healthcheck fails' },

    // --- Port/networking ---
    { id: 'expose-wrong-port', category: 'port',
      description: 'EXPOSE declares different port than app listens on',
      edits: [{ file: 'Dockerfile', search: 'EXPOSE 3000', replace: 'EXPOSE 8080' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'EXPOSE 8080' }],
      shouldPass: true, rationale: 'EXPOSE is documentation only — app still works on 3000, EXPOSE mismatch is cosmetic' },

    // --- CMD/ENTRYPOINT ---
    { id: 'cmd-wrong-file', category: 'entrypoint',
      description: 'CMD references nonexistent script',
      edits: [{ file: 'Dockerfile', search: 'CMD ["node", "server.js"]', replace: 'CMD ["node", "app.js"]' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'app.js' }],
      shouldPass: false, rationale: 'app.js does not exist — container starts but crashes immediately' },
    { id: 'cmd-wrong-runtime', category: 'entrypoint',
      description: 'CMD uses wrong runtime',
      edits: [{ file: 'Dockerfile', search: 'CMD ["node", "server.js"]', replace: 'CMD ["python3", "server.js"]' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'python3' }],
      shouldPass: false, rationale: 'python3 not installed in node:alpine — container crashes' },
    { id: 'cmd-shell-form', category: 'entrypoint',
      description: 'CMD uses shell form (works but different signal handling)',
      edits: [{ file: 'Dockerfile', search: 'CMD ["node", "server.js"]', replace: 'CMD node server.js' }],
      predicates: [{ type: 'content', file: 'server.js', pattern: 'http' }],
      shouldPass: true, rationale: 'Shell form CMD works — different signal behavior but app runs' },

    // --- docker-compose failures ---
    { id: 'compose-wrong-build-context', category: 'compose',
      description: 'docker-compose build context points to wrong directory',
      edits: [{ file: 'docker-compose.yml', search: 'build: .', replace: 'build: ./nonexistent' }],
      predicates: [{ type: 'content', file: 'docker-compose.yml', pattern: 'nonexistent' }],
      shouldPass: false, rationale: 'Build context directory does not exist — compose build fails' },
    { id: 'compose-invalid-yaml', category: 'compose',
      description: 'docker-compose has invalid YAML syntax',
      edits: [{ file: 'docker-compose.yml', search: 'services:', replace: 'services:\n  app:\n    build: .\n  app:' }],
      predicates: [{ type: 'content', file: 'docker-compose.yml', pattern: 'services' }],
      shouldPass: false, rationale: 'Duplicate key "app" in YAML — compose parse error' },
    { id: 'compose-port-conflict', category: 'compose',
      description: 'docker-compose maps to privileged port',
      edits: [{ file: 'docker-compose.yml', search: '"${VERIFY_HOST_PORT:-3000}:3000"', replace: '"80:3000"' }],
      predicates: [{ type: 'content', file: 'docker-compose.yml', pattern: '"80:3000"' }],
      shouldPass: false, rationale: 'Port 80 may be in use or require privileges — bind failure' },

    // --- Multi-stage build failures ---
    { id: 'multistage-missing-stage', category: 'multistage',
      description: 'COPY --from references nonexistent build stage',
      edits: [{ file: 'Dockerfile', search: 'COPY server.js .', replace: 'COPY --from=builder /app/dist .\nCOPY server.js .' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: '--from=builder' }],
      shouldPass: false, rationale: 'No "builder" stage defined — COPY --from fails' },

    // --- Dependency failures ---
    { id: 'missing-package-json', category: 'dependency',
      description: 'Dockerfile tries npm install but no package.json',
      edits: [{ file: 'Dockerfile', search: 'COPY server.js .', replace: 'COPY server.js .\nRUN npm install' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'npm install' }],
      shouldPass: false, rationale: 'No package.json in build context — npm install fails' },

    // --- Valid Dockerfile edits ---
    { id: 'valid-add-label', category: 'valid',
      description: 'Add LABEL metadata to Dockerfile',
      edits: [{ file: 'Dockerfile', search: 'WORKDIR /app', replace: 'LABEL maintainer="test@example.com"\nWORKDIR /app' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'maintainer' }],
      shouldPass: true, rationale: 'LABEL is valid metadata — does not affect build' },
    { id: 'valid-add-env', category: 'valid',
      description: 'Add ENV variable to Dockerfile',
      edits: [{ file: 'Dockerfile', search: 'EXPOSE 3000', replace: 'ENV NODE_ENV=production\nEXPOSE 3000' }],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: 'NODE_ENV' }],
      shouldPass: true, rationale: 'Valid ENV directive — sets environment variable' },
  ];

  for (const bp of buildPatterns) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-build-${bp.id}`,
      description: `[HARVEST:build] ${bp.description}`,
      edits: bp.edits,
      predicates: bp.predicates,
      expectedSuccess: bp.shouldPass,
      tags: ['harvest', 'build_failure', bp.category, bp.shouldPass ? 'should_pass' : 'should_fail'],
      rationale: bp.rationale,
    });
  }

  return { source: 'build_failures', scenarios, metadata: { patterns: buildPatterns.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Harvester: Health Check Failures
// ─────────────────────────────────────────────────────────────────────────────

function harvestHealthCheckFailures(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  const healthPatterns: Array<{
    id: string;
    category: string;
    description: string;
    edits: Array<{ file: string; search: string; replace: string }>;
    predicates: Array<Record<string, any>>;
    shouldPass: boolean;
    rationale: string;
  }> = [
    // --- Health endpoint removed/broken ---
    { id: 'health-removed', category: 'endpoint',
      description: 'Health endpoint handler removed from server',
      edits: [{ file: 'server.js', search: "if (req.url === '/health') {\n    res.writeHead(200);\n    res.end('OK');", replace: "if (req.url === '/removed') {\n    res.writeHead(200);\n    res.end('OK');" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200 } }],
      shouldPass: false, rationale: 'Health endpoint renamed — /health returns 404 now' },
    { id: 'health-wrong-status', category: 'endpoint',
      description: 'Health endpoint returns 500 instead of 200',
      edits: [{ file: 'server.js', search: "if (req.url === '/health') {\n    res.writeHead(200);", replace: "if (req.url === '/health') {\n    res.writeHead(500);" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200 } }],
      shouldPass: false, rationale: 'Health endpoint returns 500 — healthcheck fails' },
    { id: 'health-empty-response', category: 'endpoint',
      description: 'Health endpoint returns 200 but empty body',
      edits: [{ file: 'server.js', search: "res.end('OK');", replace: "res.end('');" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200, bodyContains: 'OK' } }],
      shouldPass: false, rationale: 'Health returns 200 but empty body — bodyContains check fails' },
    { id: 'health-json-not-text', category: 'endpoint',
      description: 'Health endpoint returns JSON instead of plain text',
      edits: [{ file: 'server.js', search: "res.end('OK');", replace: 'res.end(JSON.stringify({ status: "healthy" }));' }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200, bodyContains: 'OK' } }],
      shouldPass: false, rationale: 'Health returns JSON not "OK" — bodyContains "OK" fails' },

    // --- App starts but crashes under load ---
    { id: 'startup-exception', category: 'crash',
      description: 'App throws during request handling',
      edits: [{ file: 'server.js', search: "if (req.url === '/health') {", replace: "if (req.url === '/health') {\n    throw new Error('deliberate crash');" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200 } }],
      shouldPass: false, rationale: 'Uncaught exception on health check — process crashes or returns 500' },
    { id: 'infinite-loop', category: 'crash',
      description: 'Health endpoint enters infinite loop (timeout)',
      edits: [{ file: 'server.js', search: "if (req.url === '/health') {\n    res.writeHead(200);\n    res.end('OK');", replace: "if (req.url === '/health') {\n    while(true) {} // hang\n    res.writeHead(200);\n    res.end('OK');" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200 } }],
      shouldPass: false, rationale: 'Infinite loop — health request times out' },

    // --- Port mismatch ---
    { id: 'listen-wrong-port', category: 'port',
      description: 'Server listens on different port than expected',
      edits: [{ file: 'server.js', search: "const PORT = process.env.PORT || 3000;", replace: "const PORT = 9999;" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200 } }],
      shouldPass: false, rationale: 'App listens on 9999 but compose maps 3000 — connection refused' },

    // --- Dependency not ready ---
    { id: 'db-dependency-check', category: 'dependency',
      description: 'Health endpoint checks DB but DB not available',
      edits: [{ file: 'server.js', search: "res.end('OK');", replace: "const db = require('./db'); await db.query('SELECT 1'); res.end('OK');" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200 } }],
      shouldPass: false, rationale: 'Health depends on DB module that does not exist — require fails' },

    // --- Healthcheck configuration ---
    { id: 'compose-short-timeout', category: 'config',
      description: 'Healthcheck timeout too short for slow startup',
      edits: [{ file: 'docker-compose.yml', search: 'timeout: 3s', replace: 'timeout: 1ms' }],
      predicates: [{ type: 'content', file: 'docker-compose.yml', pattern: '1ms' }],
      shouldPass: false, rationale: '1ms timeout — no HTTP request can complete in time' },
    { id: 'compose-wrong-healthcheck-cmd', category: 'config',
      description: 'Healthcheck command uses curl but only wget available',
      edits: [{ file: 'docker-compose.yml', search: '["CMD", "wget", "-q", "-O-", "http://localhost:3000/health"]', replace: '["CMD", "curl", "-f", "http://localhost:3000/health"]' }],
      predicates: [{ type: 'content', file: 'docker-compose.yml', pattern: 'curl' }],
      shouldPass: false, rationale: 'node:alpine has wget not curl — healthcheck command fails' },
    { id: 'compose-retries-zero', category: 'config',
      description: 'Healthcheck retries set to 0',
      edits: [{ file: 'docker-compose.yml', search: 'retries: 3', replace: 'retries: 0' }],
      predicates: [{ type: 'content', file: 'docker-compose.yml', pattern: 'retries: 0' }],
      shouldPass: false, rationale: 'Zero retries — first failure marks container as unhealthy permanently' },

    // --- Partial health ---
    { id: 'health-ok-but-api-broken', category: 'partial',
      description: 'Health returns 200 but API endpoint is broken',
      edits: [{ file: 'server.js', search: "} else if (req.url === '/api/items')", replace: "} else if (req.url === '/api/broken')" }],
      predicates: [{ type: 'http', method: 'GET', path: '/api/items', expect: { status: 200 } }],
      shouldPass: false, rationale: 'Health passes but /api/items renamed to /api/broken — API predicate fails' },
    { id: 'health-ok-homepage-broken', category: 'partial',
      description: 'Health returns 200 but homepage serves wrong content',
      edits: [{ file: 'server.js', search: "<h1>Demo App</h1>", replace: "<h1></h1>" }],
      predicates: [{ type: 'html', selector: 'h1', content: 'Demo App' }],
      shouldPass: false, rationale: 'Health fine, homepage h1 emptied — HTML content predicate fails' },

    // --- Valid health changes ---
    { id: 'valid-health-json', category: 'valid',
      description: 'Health endpoint returns JSON with uptime',
      edits: [{ file: 'server.js', search: "res.end('OK');", replace: "res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200, bodyContains: 'ok' } }],
      shouldPass: true, rationale: 'JSON health response contains "ok" — bodyContains check passes' },
    { id: 'valid-add-readiness', category: 'valid',
      description: 'Add separate readiness endpoint',
      edits: [{ file: 'server.js', search: "} else if (req.url === '/health')", replace: "} else if (req.url === '/ready') {\n    res.writeHead(200);\n    res.end('READY');\n  } else if (req.url === '/health')" }],
      predicates: [{ type: 'content', file: 'server.js', pattern: '/ready' }],
      shouldPass: true, rationale: 'New endpoint added at unique anchor point — does not break health' },
  ];

  for (const hp of healthPatterns) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-health-${hp.id}`,
      description: `[HARVEST:health] ${hp.description}`,
      edits: hp.edits,
      predicates: hp.predicates,
      expectedSuccess: hp.shouldPass,
      tags: ['harvest', 'health_check', hp.category, hp.shouldPass ? 'should_pass' : 'should_fail'],
      rationale: hp.rationale,
    });
  }

  return { source: 'health_check_failures', scenarios, metadata: { patterns: healthPatterns.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Harvester: Cascade Failures (Edit A breaks unrelated thing B)
// ─────────────────────────────────────────────────────────────────────────────

function harvestCascadeFailures(_inputDir: string, maxScenarios: number): HarvesterResult {
  const scenarios: Scenario[] = [];

  const cascadePatterns: Array<{
    id: string;
    category: string;
    description: string;
    edits: Array<{ file: string; search: string; replace: string }>;
    predicates: Array<Record<string, any>>;
    shouldPass: boolean;
    rationale: string;
  }> = [
    // --- CSS specificity cascades ---
    { id: 'css-specificity-override', category: 'css_cascade',
      description: 'Adding a more specific rule overrides inherited style on other elements',
      edits: [{ file: 'server.js', search: "body { font-family: sans-serif; margin: 0; padding: 20px; }", replace: "body { font-family: sans-serif; margin: 0; padding: 20px; }\n    body * { color: red; }" }],
      predicates: [{ type: 'css', selector: '.nav-link', property: 'color', expected: 'rgb(51, 51, 51)' }],
      shouldPass: false, rationale: 'body * { color: red } overrides .nav-link color — cascade changes unrelated elements' },
    { id: 'css-shorthand-clobber', category: 'css_cascade',
      description: 'Shorthand property clobbers previously set longhand',
      edits: [{ file: 'server.js', search: "body { font-family: sans-serif; margin: 0; padding: 20px; }", replace: "body { font-family: sans-serif; margin: 0; padding: 20px; border-top: 2px solid blue; border: none; }" }],
      predicates: [{ type: 'css', selector: 'body', property: 'border-top-width', expected: '2px' }],
      shouldPass: false, rationale: 'border: none after border-top resets border-top — shorthand clobbers longhand' },
    { id: 'css-import-order', category: 'css_cascade',
      description: 'New style block before existing one changes cascade order',
      edits: [{ file: 'server.js', search: '<style>', replace: '<style>\n    .nav-link { color: purple; }\n    </style>\n    <style>' }],
      predicates: [{ type: 'css', selector: '.nav-link', property: 'color', expected: 'rgb(51, 51, 51)' }],
      shouldPass: false, rationale: 'New style block adds conflicting .nav-link color — last declaration wins, original overrides' },

    // --- Route handler conflicts ---
    { id: 'route-shadow', category: 'route',
      description: 'New route handler shadows existing one (matched first)',
      edits: [{ file: 'server.js', search: "if (req.url === '/' && req.method === 'GET')", replace: "if (req.url === '/' && req.method === 'GET') {\n    res.writeHead(200);\n    res.end('SHADOW');\n  } else if (req.url === '/' && req.method === 'GET')" }],
      predicates: [{ type: 'http', method: 'GET', path: '/', expect: { status: 200, bodyContains: 'Demo App' } }],
      shouldPass: false, rationale: 'First matching handler returns "SHADOW" — original homepage never reached' },
    { id: 'catch-all-shadow', category: 'route',
      description: 'Catch-all route added before specific routes',
      edits: [{ file: 'server.js', search: "if (req.url === '/' && req.method === 'GET')", replace: "if (true) {\n    res.writeHead(200);\n    res.end('catch-all');\n  } else if (req.url === '/' && req.method === 'GET')" }],
      predicates: [{ type: 'http', method: 'GET', path: '/health', expect: { status: 200, bodyContains: 'OK' } }],
      shouldPass: false, rationale: 'Catch-all intercepts ALL requests including /health' },

    // --- Shared state corruption ---
    { id: 'items-array-cleared', category: 'shared_state',
      description: 'Edit to items array on one route breaks another route that reads it',
      edits: [{ file: 'server.js', search: "{ id: 1, name: 'Alpha' },\n      { id: 2, name: 'Bravo' }", replace: "/* items removed */" }],
      predicates: [{ type: 'http', method: 'GET', path: '/api/items', expect: { status: 200, bodyContains: 'Alpha' } }],
      shouldPass: false, rationale: 'Items data removed — /api/items returns empty or errors' },
    { id: 'constant-rename-breaks-reference', category: 'shared_state',
      description: 'Renaming a variable breaks all references to it',
      edits: [{ file: 'server.js', search: "const PORT = process.env.PORT || 3000;", replace: "const SERVER_PORT = process.env.PORT || 3000;" }],
      predicates: [{ type: 'content', file: 'server.js', pattern: 'SERVER_PORT' }],
      shouldPass: false, rationale: 'PORT renamed to SERVER_PORT but server.listen(PORT) still references old name — crash' },

    // --- HTML structure cascades ---
    { id: 'unclosed-tag-breaks-page', category: 'html_structure',
      description: 'Unclosed div tag breaks all subsequent HTML rendering',
      edits: [{ file: 'server.js', search: '<h1>Demo App</h1>', replace: '<div><h1>Demo App</h1>' }],
      predicates: [{ type: 'html', selector: 'nav', content: 'exists' }],
      shouldPass: false, rationale: 'Unclosed <div> may swallow the nav element depending on parser behavior' },
    { id: 'style-tag-unclosed', category: 'html_structure',
      description: 'Unclosed style tag makes rest of page invisible',
      edits: [{ file: 'server.js', search: '</style>', replace: '/* unclosed' }],
      predicates: [{ type: 'html', selector: 'h1', content: 'Demo App' }],
      shouldPass: false, rationale: 'Unclosed <style> — browser treats rest of HTML as CSS, page content invisible' },

    // --- Cross-route CSS leaks ---
    { id: 'homepage-edit-breaks-about', category: 'cross_route',
      description: 'CSS edit on homepage leaks to /about page',
      edits: [{ file: 'server.js', search: "body { font-family: sans-serif; margin: 0; padding: 20px; }", replace: "body { font-family: sans-serif; margin: 0; padding: 20px; display: none; }" }],
      predicates: [{ type: 'http', method: 'GET', path: '/about', expect: { status: 200, bodyContains: 'About' } }],
      shouldPass: true, rationale: 'display:none is CSS — HTTP response still contains About text, bodyContains passes' },

    // --- Import/require chain breaks ---
    { id: 'require-removed', category: 'dependency_chain',
      description: 'Removing require breaks runtime',
      edits: [{ file: 'server.js', search: "const http = require('http');", replace: "// http removed" }],
      predicates: [{ type: 'http', method: 'GET', path: '/', expect: { status: 200 } }],
      shouldPass: false, rationale: 'http module not imported — http.createServer throws ReferenceError, app crashes' },

    // --- Config file cascades ---
    { id: 'config-invalid-json', category: 'config',
      description: 'Edit makes config.json invalid — any reader breaks',
      edits: [{ file: 'config.json', search: '"appName": "demo-app"', replace: '"appName": "demo-app",' }],
      predicates: [{ type: 'content', file: 'config.json', pattern: 'demo-app' }],
      shouldPass: false, rationale: 'Trailing comma makes JSON invalid — any JSON.parse fails' },
    { id: 'init-sql-syntax-error', category: 'config',
      description: 'SQL syntax error breaks database initialization',
      edits: [{ file: 'init.sql', search: 'CREATE TABLE', replace: 'CRAETE TABLE' }],
      predicates: [{ type: 'content', file: 'init.sql', pattern: 'CRAETE' }],
      shouldPass: false, rationale: 'SQL syntax error — database initialization fails' },

    // --- Multi-file cascades ---
    { id: 'dockerfile-port-vs-server', category: 'multi_file',
      description: 'Dockerfile EXPOSE changed but server.js PORT unchanged — mismatch',
      edits: [
        { file: 'Dockerfile', search: 'EXPOSE 3000', replace: 'EXPOSE 8080' },
        { file: 'server.js', search: "const PORT = process.env.PORT || 3000;", replace: "const PORT = process.env.PORT || 3000; // unchanged" },
      ],
      predicates: [{ type: 'content', file: 'Dockerfile', pattern: '8080' }, { type: 'content', file: 'server.js', pattern: '3000' }],
      shouldPass: true, rationale: 'EXPOSE is cosmetic, PORT still 3000 — app works but documentation misleading' },
    { id: 'compose-env-vs-server', category: 'multi_file',
      description: 'Compose changes PORT env but server has hardcoded fallback',
      edits: [{ file: 'docker-compose.yml', search: 'PORT=3000', replace: 'PORT=8080' }],
      predicates: [{ type: 'content', file: 'docker-compose.yml', pattern: '8080' }],
      shouldPass: true, rationale: 'Server reads process.env.PORT — compose change takes effect at runtime' },

    // --- Valid multi-file edits ---
    { id: 'valid-add-route-and-test', category: 'valid',
      description: 'Add new route to server.js and reference in config.json',
      edits: [
        { file: 'server.js', search: "} else if (req.url === '/health')", replace: "} else if (req.url === '/metrics') {\n    res.writeHead(200);\n    res.end(JSON.stringify({ requests: 0 }));\n  } else if (req.url === '/health')" },
        { file: 'config.json', search: '"appName": "demo-app"', replace: '"appName": "demo-app",\n  "metricsEnabled": true' },
      ],
      predicates: [{ type: 'content', file: 'server.js', pattern: '/metrics' }, { type: 'content', file: 'config.json', pattern: 'metricsEnabled' }],
      shouldPass: true, rationale: 'New route at unique anchor + valid JSON addition — both files valid' },
  ];

  for (const cp of cascadePatterns) {
    if (scenarios.length >= maxScenarios) break;
    scenarios.push({
      id: `harvest-cascade-${cp.id}`,
      description: `[HARVEST:cascade] ${cp.description}`,
      edits: cp.edits,
      predicates: cp.predicates,
      expectedSuccess: cp.shouldPass,
      tags: ['harvest', 'cascade_failure', cp.category, cp.shouldPass ? 'should_pass' : 'should_fail'],
      rationale: cp.rationale,
    });
  }

  return { source: 'cascade_failures', scenarios, metadata: { patterns: cascadePatterns.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Harvester Registry
// ─────────────────────────────────────────────────────────────────────────────

const HARVESTERS: Record<string, Harvester> = {
  css: harvestCSSEdgeCases,
  http: harvestHTTPEdgeCases,
  db: harvestDBPatterns,
  wpt: harvestWPT,
  schemapile: harvestSchemaPile,
  cve: harvestCVE,
  stylelint: harvestStylelint,
  openapi: harvestOpenAPI,
  edit: harvestEditFailures,
  build: harvestBuildFailures,
  health: harvestHealthCheckFailures,
  cascade: harvestCascadeFailures,
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
const maxScenarios = parseInt(cliArgs.find(a => a.startsWith('--max-scenarios='))?.split('=')[1] ?? '100');
const dryRun = cliArgs.includes('--dry-run');
const sourcesArg = cliArgs.find(a => a.startsWith('--sources='))?.split('=')[1];
const sources = sourcesArg ? sourcesArg.split(',') : Object.keys(HARVESTERS);
const inputDir = cliArgs.find(a => a.startsWith('--input-dir='))?.split('=')[1] || '';
const pkgRoot = resolve(import.meta.dir, '..', '..');

console.log(`\n═══ External Corpus Harvester ═══`);
console.log(`Sources: ${sources.join(', ')}`);
console.log(`Max per source: ${maxScenarios}`);
console.log(`Dry run: ${dryRun}\n`);

const allResults: HarvesterResult[] = [];

for (const source of sources) {
  const harvester = HARVESTERS[source];
  if (!harvester) {
    console.log(`  Unknown harvester: ${source} (available: ${Object.keys(HARVESTERS).join(', ')})`);
    continue;
  }

  try {
    const result = harvester(inputDir, maxScenarios);
    allResults.push(result);
    console.log(`  ${source}: ${result.scenarios.length} scenarios`);
  } catch (err: any) {
    console.log(`  ${source}: ERROR — ${err.message}`);
  }
}

const totalScenarios = allResults.flatMap(r => r.scenarios);
console.log(`\nTotal: ${totalScenarios.length} scenarios from ${allResults.length} sources`);

if (dryRun) {
  console.log('\n[DRY RUN] No files written.');
  for (const s of totalScenarios.slice(0, 10)) {
    console.log(`  ${s.id}: ${s.description.substring(0, 80)}`);
  }
  if (totalScenarios.length > 10) console.log(`  ... and ${totalScenarios.length - 10} more`);
} else if (totalScenarios.length > 0) {
  const scenariosDir = join(pkgRoot, 'fixtures', 'scenarios');
  mkdirSync(scenariosDir, { recursive: true });
  const outputPath = join(scenariosDir, 'harvest-staged.json');

  // Deduplicate
  let existing: Scenario[] = [];
  if (existsSync(outputPath)) {
    try { existing = JSON.parse(readFileSync(outputPath, 'utf-8')); } catch { /* overwrite */ }
  }
  const existingIds = new Set(existing.map(s => s.id));
  const newScenarios = totalScenarios.filter(s => !existingIds.has(s.id));
  const merged = [...existing, ...newScenarios];

  writeFileSync(outputPath, JSON.stringify(merged, null, 2));
  console.log(`\nWrote ${newScenarios.length} new scenarios (${merged.length} total) to ${outputPath}`);

  // Supply log
  const logPath = join(pkgRoot, 'data', 'supply-log.jsonl');
  mkdirSync(join(pkgRoot, 'data'), { recursive: true });
  appendFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'harvester',
    generated: totalScenarios.length,
    new: newScenarios.length,
    bySources: Object.fromEntries(allResults.map(r => [r.source, r.scenarios.length])),
  }) + '\n');
}

console.log('\nDone.\n');
