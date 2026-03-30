#!/usr/bin/env bun
/**
 * stage-gate-audit.ts — Gate Audit Scenario Generator
 *
 * 10 targeted scenarios designed to BREAK specific gates based on
 * source code audit of gate implementations. Each scenario targets
 * a specific code weakness identified in the gate audit (March 29, 2026).
 *
 * These are the highest-ROI scenarios in the corpus — each dirty result
 * is a confirmed gate bug that the improve loop can fix.
 *
 * Run: bun scripts/harvest/stage-gate-audit.ts
 */
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';

const outPath = resolve('fixtures/scenarios/gate-audit-staged.json');
const demoDir = resolve('fixtures/demo-app');
const scenarios: any[] = [];

const serverContent = readFileSync(resolve(demoDir, 'server.js'), 'utf-8');

// =============================================================================
// AUDIT-001: Grounding — extractHTMLElements ignores nested tags
// grounding.ts:862 — regex /<([\w-]+)([^>]*)>([^<]*)<\/\1>/g
// [^<]* cannot match content containing child elements
// =============================================================================

scenarios.push({
  id: 'audit-001',
  description: 'Gate audit: grounding misses nested HTML elements',
  edits: [{
    file: 'server.js',
    search: '<h2>Team</h2>',
    replace: '<h2><strong>Team</strong></h2>',
  }],
  predicates: [{ type: 'html', selector: 'h2', content: 'Team' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'grounding', 'nested-html', 'AUDIT-01'],
  rationale: 'extractHTMLElements regex [^<]* cannot see text inside nested child elements like <h2><strong>Team</strong></h2>. The h2 element becomes invisible to grounding, causing false groundingMiss.',
});

// Also test with a real nested structure from the demo-app
scenarios.push({
  id: 'audit-001b',
  description: 'Gate audit: grounding misses hero-title inside hero div',
  edits: [{
    file: 'server.js',
    search: '<span class="hero-title">About This App</span>',
    replace: '<span class="hero-title"><em>About</em> This App</span>',
  }],
  predicates: [{ type: 'html', selector: '.hero-title', content: 'About' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'grounding', 'nested-html', 'AUDIT-01'],
  rationale: 'After adding <em> inside .hero-title, the element text "About" should still be grounded. But extractHTMLElements [^<]* stops at the <em> tag.',
});

// =============================================================================
// AUDIT-002: Grounding — CSS shorthand resolver is positional
// grounding.ts:952 — _rS splits by whitespace, takes index
// CSS shorthands are NOT strictly positional
// =============================================================================

scenarios.push({
  id: 'audit-002',
  description: 'Gate audit: CSS shorthand resolver wrong order for border',
  edits: [{
    file: 'server.js',
    search: 'input.search { padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; width: 200px; }',
    replace: 'input.search { padding: 0.5rem; border: solid 3px red; border-radius: 4px; width: 200px; }',
  }],
  predicates: [{ type: 'css', selector: 'input.search', property: 'border-color', expected: 'red' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'grounding', 'shorthand-positional', 'AUDIT-02'],
  rationale: '_rS splits "solid 3px red" by whitespace and takes positional index. For border: [width, style, color], index 2 = "red" works. But CSS allows any order — "solid 3px red" has style first, which _rS maps to border-width position.',
});

// =============================================================================
// AUDIT-003: Security — comment skip misses test fixtures
// security.ts:140-141 — startsWith('//') || startsWith('#') || startsWith('*')
// Doesn't handle code that LOOKS like secrets but is test data
// =============================================================================

scenarios.push({
  id: 'audit-003',
  description: 'Gate audit: security gate flags test fixture as leaked secret',
  edits: [{
    file: 'server.js',
    search: "const PORT = process.env.PORT || 3000;",
    replace: "const PORT = process.env.PORT || 3000;\nconst TEST_CONFIG = { api_key: 'test-key-abc123456789', db_password: 'testpass123' }; // test fixture",
  }],
  predicates: [{ type: 'security', securityCheck: 'secrets_in_code', target: 'server.js', expected: 'no_findings' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'security', 'test-fixture-false-positive', 'AUDIT-03'],
  rationale: 'Test config with api_key and db_password values that look like secrets but are clearly test data (inline comment, test prefix). Security gate should not flag these.',
});

// =============================================================================
// AUDIT-004: A11y — heading regex matches inside comments
// a11y.ts:118 — /<h([1-6])\b/gi matches ANYWHERE in file
// =============================================================================

scenarios.push({
  id: 'audit-004',
  description: 'Gate audit: a11y heading check triggered by HTML comment',
  edits: [{
    file: 'server.js',
    search: '<h2>Team</h2>',
    replace: '<h2>Team</h2>\n  <!-- TODO: restore <h4>Advisors</h4> section -->',
  }],
  predicates: [{ type: 'a11y', a11yCheck: 'heading_hierarchy', target: 'server.js', expected: 'no_findings' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'a11y', 'comment-heading', 'AUDIT-04'],
  rationale: 'Heading regex /<h([1-6])\\b/gi matches <h4> inside an HTML comment. The actual page has h1→h2 (valid), but the comment adds h4 which triggers "heading level skipped" false finding.',
});

// =============================================================================
// AUDIT-005: Propagation — extractCSSClassNames misses descendant selectors
// propagation.ts:395 — /\.([a-zA-Z_-][a-zA-Z0-9_-]*)\s*[{,:]/g
// Requires {, ,, or : after class — misses .a .b { where .a is before space
// =============================================================================

scenarios.push({
  id: 'audit-005',
  description: 'Gate audit: propagation misses CSS class rename in compound selector',
  edits: [{
    file: 'server.js',
    search: '.team-list li { padding: 0.3rem 0; }',
    replace: '.member-list li { padding: 0.3rem 0; }',
  }],
  predicates: [{ type: 'css', selector: '.member-list li', property: 'padding', expected: '0.3rem 0' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'propagation', 'descendant-selector', 'AUDIT-05'],
  rationale: 'extractCSSClassNames regex requires {,: after class name. In ".team-list li {", .team-list is followed by space (not {), so it is NOT extracted. The rename from .team-list to .member-list would go undetected by the propagation gate.',
});

// =============================================================================
// AUDIT-006: State — env pattern only matches SCREAMING_CASE
// state.ts:591 — /process\.env\.([A-Z_][A-Z0-9_]*)/g
// Misses camelCase env vars (common in Next.js, Vite)
// =============================================================================

scenarios.push({
  id: 'audit-006',
  description: 'Gate audit: state gate misses camelCase env var',
  edits: [{
    file: 'server.js',
    search: "const PORT = process.env.PORT || 3000;",
    replace: "const PORT = process.env.PORT || 3000;\nconst dbUrl = process.env.databaseUrl || 'postgres://localhost/dev';",
  }],
  predicates: [{ type: 'content', file: 'server.js', pattern: 'process.env.databaseUrl' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'state', 'camelcase-env', 'AUDIT-06'],
  rationale: 'State gate env pattern [A-Z_][A-Z0-9_]* only matches SCREAMING_CASE. process.env.databaseUrl (camelCase) is not detected, so divergence between code and .env is missed.',
});

// =============================================================================
// AUDIT-007: Temporal — extractRoutes matches file paths, not just routes
// temporal.ts:418 — /['"`](\/[a-zA-Z0-9/_:-]+)['"`]/g
// Matches ANY string literal starting with /
// =============================================================================

scenarios.push({
  id: 'audit-007',
  description: 'Gate audit: temporal gate confuses file path for route',
  edits: [{
    file: 'server.js',
    search: "const PORT = process.env.PORT || 3000;",
    replace: "const PORT = process.env.PORT || 3000;\nconst ASSETS_DIR = '/public/assets/images';",
  }],
  predicates: [{ type: 'content', file: 'server.js', pattern: '/public/assets/images' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'temporal', 'file-path-as-route', 'AUDIT-07'],
  rationale: 'extractRoutes regex matches any quoted string starting with /. The file path /public/assets/images would be detected as a "route", causing false temporal drift flags if it changes.',
});

// =============================================================================
// AUDIT-008: Containment — .replace('.','') + includes() trivial match
// containment.ts:72 — p.selector.replace('.', '') checked via includes()
// Short class names match everywhere
// =============================================================================

scenarios.push({
  id: 'audit-008',
  description: 'Gate audit: containment false attribution from short selector',
  edits: [{
    file: 'server.js',
    search: "res.end(JSON.stringify({ status: 'ok' }));",
    replace: "res.end(JSON.stringify({ status: 'ok', database: 'connected' }));",
  }],
  predicates: [{ type: 'css', selector: '.a', property: 'color', expected: 'red' }],
  expectedSuccess: false,
  tags: ['gate-audit', 'containment', 'trivial-match', 'AUDIT-08'],
  rationale: 'Containment checks p.selector.replace(".","")+includes(). Selector ".a" becomes "a". edit.replace contains "database" which includes "a". The edit is falsely attributed as "direct" when it has nothing to do with .a.',
});

// =============================================================================
// AUDIT-009: Security — SQL injection scanner misses multi-line queries
// security.ts:99-118 — line-by-line regex
// Real-world queries span multiple lines
// =============================================================================

scenarios.push({
  id: 'audit-009',
  description: 'Gate audit: SQL injection scanner misses multi-line query',
  edits: [{
    file: 'server.js',
    search: "const PORT = process.env.PORT || 3000;",
    replace: "const PORT = process.env.PORT || 3000;\nconst getUser = (id) => pool.query(\n  `SELECT * FROM users WHERE id = ${id}`\n);",
  }],
  predicates: [{ type: 'security', securityCheck: 'sql_injection', target: 'server.js', expected: 'has_findings' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'security', 'multiline-sql', 'AUDIT-09'],
  rationale: 'SQL injection scanner checks line-by-line. pool.query( is on line 1, the template literal with ${id} is on line 2. The regex for query+template literal cannot match across lines, so the injection goes undetected.',
});

// =============================================================================
// AUDIT-010: Grounding — 3-digit hex not normalized to 6-digit
// grounding.ts:892 — _nC returns #fff as-is, but white→#ffffff
// =============================================================================

scenarios.push({
  id: 'audit-010',
  description: 'Gate audit: 3-digit hex #fff not matching named color white',
  edits: [{
    file: 'server.js',
    search: '.hero { background: #3498db; color: white; padding: 2rem; border-radius: 8px; }',
    replace: '.hero { background: #3498db; color: #fff; padding: 2rem; border-radius: 8px; }',
  }],
  predicates: [{ type: 'css', selector: '.hero', property: 'color', expected: 'white' }],
  expectedSuccess: true,
  tags: ['gate-audit', 'grounding', 'hex-shorthand', 'AUDIT-10'],
  rationale: '_nC("#fff") returns "#fff" but _nC("white") returns "#ffffff". These are the same color but grounding comparison fails because 3-digit hex is not expanded to 6-digit before comparison.',
});

// Write output
writeFileSync(outPath, JSON.stringify(scenarios, null, 2));
console.log(`Wrote ${scenarios.length} gate audit scenarios to ${outPath}`);
console.log('Expected: several should be DIRTY (confirming real gate bugs)');
