/**
 * N1 Phase 1g — Source D synthetic seed emitter.
 *
 * Hand-constructs 12 Source D synthetic seed cases per DESIGN.md
 * Amendment 4 Change 2: 5 config + 4 grounding + 2 security + 1 a11y = 12.
 *
 * Each seed:
 *   - Matches the Source B candidate schema exactly (same fields, same types,
 *     same formats), varying only content, not structure.
 *   - Has reference_edits targeting verified strings in fixtures/demo-app/
 *     (all search strings grep-confirmed unambiguous in their target file at
 *     corpus SHA 79d8977).
 *   - Has reference_predicates hand-crafted to exercise exactly one gate
 *     behavior relevant to the seed's category.
 *   - Has expected_success: true — the scenario is the "correct answer"
 *     shape the reviewer should inspect.
 *   - Has source: 'D', intent: 'synthetic', primary_family: null
 *     (Source D is not a primary family; see Amendment 2 Option R4 rejection).
 *   - Has scenario_file: 'SOURCE_D_SYNTHETIC' as a marker that distinguishes
 *     hand-constructed seeds from Source B staged scenarios.
 *
 * Per DESIGN.md §14, synthetic seeds are NOT pre-flighted. Their
 * pre_flight_result field is 'synthetic' in case-list.jsonl, not 'pass'.
 *
 * Output: experiments/n1-convergence-proof/source-d-seeds.jsonl
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

interface SourceDSeed {
  case_id: string;
  source: 'D';
  intent: 'synthetic';
  category: 'config' | 'grounding' | 'security' | 'a11y';
  primary_family: null;
  track: 'N1-A';
  goal: string;
  reference_edits: Array<{ file: string; search: string; replace: string }>;
  reference_predicates: Array<Record<string, unknown>>;
  expected_success: true;
  scenario_file: 'SOURCE_D_SYNTHETIC';
  scenario_id: string;
}

// ============================================================================
// The 12 seeds
// ============================================================================

const seeds: SourceDSeed[] = [
  // ==========================================================================
  // Config (5 seeds) — exercise the config gate's key/source/expected match
  // against the 4 config files in fixtures/demo-app/: config.json, .env,
  // .env.staging, .env.prod. Each seed edits a single config value and
  // asserts the config gate can read the new value.
  // ==========================================================================

  {
    case_id: 'config:cfg-synth-001',
    source: 'D',
    intent: 'synthetic',
    category: 'config',
    primary_family: null,
    track: 'N1-A',
    goal: 'config: rename the public app name from "Demo App" to "Production App" in config.json; the config gate should read app.name and match the new value',
    reference_edits: [
      {
        file: 'config.json',
        search: '"name": "Demo App",\n    "port": 3000',
        replace: '"name": "Production App",\n    "port": 3000',
      },
    ],
    reference_predicates: [
      {
        type: 'config',
        key: 'app.name',
        source: 'json',
        expected: 'Production App',
        file: 'config.json',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'cfg-synth-001',
  },

  {
    case_id: 'config:cfg-synth-002',
    source: 'D',
    intent: 'synthetic',
    category: 'config',
    primary_family: null,
    track: 'N1-A',
    goal: 'config: change PORT from 3000 to 8080 in the .env file; the config gate should read PORT and match the new value',
    reference_edits: [
      {
        file: '.env',
        search: 'PORT=3000',
        replace: 'PORT=8080',
      },
    ],
    reference_predicates: [
      {
        type: 'config',
        key: 'PORT',
        source: 'dotenv',
        expected: '8080',
        file: '.env',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'cfg-synth-002',
  },

  {
    case_id: 'config:cfg-synth-003',
    source: 'D',
    intent: 'synthetic',
    category: 'config',
    primary_family: null,
    track: 'N1-A',
    goal: 'config: enable the analytics feature flag in config.json by setting features.analytics to true; the config gate should read features.analytics and match',
    reference_edits: [
      {
        file: 'config.json',
        search: '"analytics": false',
        replace: '"analytics": true',
      },
    ],
    reference_predicates: [
      {
        type: 'config',
        key: 'features.analytics',
        source: 'json',
        expected: 'true',
        file: 'config.json',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'cfg-synth-003',
  },

  {
    case_id: 'config:cfg-synth-004',
    source: 'D',
    intent: 'synthetic',
    category: 'config',
    primary_family: null,
    track: 'N1-A',
    goal: 'config: disable DEBUG in the staging .env file by flipping DEBUG=true to DEBUG=false; the config gate should read DEBUG from .env.staging and match',
    reference_edits: [
      {
        file: '.env.staging',
        search: 'DEBUG=true',
        replace: 'DEBUG=false',
      },
    ],
    reference_predicates: [
      {
        type: 'config',
        key: 'DEBUG',
        source: 'dotenv',
        expected: 'false',
        file: '.env.staging',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'cfg-synth-004',
  },

  {
    case_id: 'config:cfg-synth-005',
    source: 'D',
    intent: 'synthetic',
    category: 'config',
    primary_family: null,
    track: 'N1-A',
    goal: 'config: rotate the production SECRET_KEY in .env.prod to include a Q2 suffix; the config gate should read SECRET_KEY and match the new value',
    reference_edits: [
      {
        file: '.env.prod',
        search: 'SECRET_KEY="prod-secret-rotated-2026"',
        replace: 'SECRET_KEY="prod-secret-rotated-2026-q2"',
      },
    ],
    reference_predicates: [
      {
        type: 'config',
        key: 'SECRET_KEY',
        source: 'dotenv',
        expected: 'prod-secret-rotated-2026-q2',
        file: '.env.prod',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'cfg-synth-005',
  },

  // ==========================================================================
  // Grounding (4 seeds) — exercise the grounding gate's CSS selector/property
  // matching against the /about page's embedded CSS in server.js. Each seed
  // modifies a real CSS rule and asserts the grounding gate can find the new
  // value. All four selectors (.hero, .badge, a.nav-link, .card) exist in
  // the demo-app's /about-page source.
  // ==========================================================================

  {
    case_id: 'grounding:grd-synth-001',
    source: 'D',
    intent: 'synthetic',
    category: 'grounding',
    primary_family: null,
    track: 'N1-A',
    goal: 'grounding: change .hero background from blue (#3498db) to dark navy (#2c3e50) on the /about page; the grounding gate should find the new background value for selector .hero',
    reference_edits: [
      {
        file: 'server.js',
        search: '.hero { background: #3498db; color: white; padding: 2rem; border-radius: 8px; }',
        replace: '.hero { background: #2c3e50; color: white; padding: 2rem; border-radius: 8px; }',
      },
    ],
    reference_predicates: [
      {
        type: 'css',
        selector: '.hero',
        property: 'background',
        expected: '#2c3e50',
        path: '/about',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'grd-synth-001',
  },

  {
    case_id: 'grounding:grd-synth-002',
    source: 'D',
    intent: 'synthetic',
    category: 'grounding',
    primary_family: null,
    track: 'N1-A',
    goal: 'grounding: recolor the .badge from red (#e74c3c) to green (#27ae60) on the /about page; the grounding gate should find the new background value for selector .badge',
    reference_edits: [
      {
        file: 'server.js',
        search: '.badge { display: inline-block; background: #e74c3c; color: white; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.8rem; }',
        replace: '.badge { display: inline-block; background: #27ae60; color: white; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.8rem; }',
      },
    ],
    reference_predicates: [
      {
        type: 'css',
        selector: '.badge',
        property: 'background',
        expected: '#27ae60',
        path: '/about',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'grd-synth-002',
  },

  {
    case_id: 'grounding:grd-synth-003',
    source: 'D',
    intent: 'synthetic',
    category: 'grounding',
    primary_family: null,
    track: 'N1-A',
    goal: 'grounding: change .hero .hero-title font-size from 2.5rem to 3rem on the /about page; the grounding gate should find the new font-size value for selector .hero .hero-title. The .hero .hero-title selector appears exactly once in server.js (on /about), avoiding any cross-route shared-selector collision.',
    reference_edits: [
      {
        file: 'server.js',
        search: '.hero .hero-title { color: white; font-size: 2.5rem; }',
        replace: '.hero .hero-title { color: white; font-size: 3rem; }',
      },
    ],
    reference_predicates: [
      {
        type: 'css',
        selector: '.hero .hero-title',
        property: 'font-size',
        expected: '3rem',
        path: '/about',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'grd-synth-003',
  },

  {
    case_id: 'grounding:grd-synth-004',
    source: 'D',
    intent: 'synthetic',
    category: 'grounding',
    primary_family: null,
    track: 'N1-A',
    goal: 'grounding: change .card background from pure white to light gray (#f5f5f5) on the /about page; the grounding gate should find the new background value for selector .card',
    reference_edits: [
      {
        file: 'server.js',
        search: '.card { background: white; padding: 1.5rem; margin: 1rem 0; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }',
        replace: '.card { background: #f5f5f5; padding: 1.5rem; margin: 1rem 0; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }',
      },
    ],
    reference_predicates: [
      {
        type: 'css',
        selector: '.card',
        property: 'background',
        expected: '#f5f5f5',
        path: '/about',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'grd-synth-004',
  },

  // ==========================================================================
  // Security (2 seeds) — exercise the security gate's secrets_in_code and
  // xss scanners. Each seed makes a security-neutral edit and asserts the
  // scanner reports no findings. The edits are explicitly NOT vulnerable —
  // adding a comment and adding a console.log with a static string are both
  // security-neutral operations that should not trigger any scanner.
  // ==========================================================================

  {
    case_id: 'security:sec-synth-001',
    source: 'D',
    intent: 'synthetic',
    category: 'security',
    primary_family: null,
    track: 'N1-A',
    goal: 'security: add a code comment to server.js describing the http module; the secrets_in_code scanner should report no findings because the comment contains no secret material',
    reference_edits: [
      {
        file: 'server.js',
        search: "const http = require('http');",
        replace: "const http = require('http'); // HTTP server module",
      },
    ],
    reference_predicates: [
      {
        type: 'security',
        securityCheck: 'secrets_in_code',
        expected: 'no_findings',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'sec-synth-001',
  },

  {
    case_id: 'security:sec-synth-002',
    source: 'D',
    intent: 'synthetic',
    category: 'security',
    primary_family: null,
    track: 'N1-A',
    goal: 'security: add a DEBUG-guarded startup log statement to server.js; the secrets_in_code scanner should report no findings because the log message is a static literal string with no secret material. Note: the original Phase 1g draft framed this as an xss test, but the fixture has no xss-adjacent code (no innerHTML, textContent, document.write, or dangerouslySetInnerHTML) so xss-category edits are not viable against the demo-app. This seed falls back to secrets_in_code, which the edit genuinely exercises: it adds a string literal that could contain secret material but does not. Both Source D security seeds therefore test secrets_in_code with different edit shapes (seed 10 = comment addition, seed 11 = runtime log statement).',
    reference_edits: [
      {
        file: 'server.js',
        search: 'const PORT = process.env.PORT || 3000;',
        replace: "const PORT = process.env.PORT || 3000;\nif (process.env.DEBUG) console.log('[startup] server initializing');",
      },
    ],
    reference_predicates: [
      {
        type: 'security',
        securityCheck: 'secrets_in_code',
        expected: 'no_findings',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'sec-synth-002',
  },

  // ==========================================================================
  // A11y (1 seed) — exercise the a11y gate's landmark sub-check. The fixture
  // currently has no <main> element anywhere in server.js (across all routes)
  // and no role="main" attribute. The landmark check is project-scoped: it
  // concatenates all HTML files and asks whether ANY page has a <main> tag
  // or role="main" attribute; if none does, it emits one finding at the
  // project level.
  //
  // The seed adds role="main" to the .hero div on the /about page, which
  // satisfies the landmark check globally (since the check is project-scoped,
  // not page-scoped). Pre-edit state: landmark check returns 1 finding
  // ("Missing landmark: <main> or role=\"main\""). Post-edit state: 0
  // findings. The predicate expected: 'no_findings' holds only in the
  // post-edit state — this is a genuine state-transition test, not a
  // gate-indifference test.
  //
  // Why landmark and not aria_label, alt_text, heading_hierarchy, or other
  // declared a11yCheck sub-types:
  //   - alt_text: fixture's only <img> already has alt; gate indifferent
  //   - aria_label: only examines <button>/<a>, all of which have visible
  //     text in the fixture; gate currently clean
  //   - heading_hierarchy: only flags empty/hidden headings; fixture has none
  //   - color_contrast: dispatch returns [] with "Requires computed styles
  //     — deferred to browser gate" note; not testable statically
  //   - focus_management: declared but not well-suited to static editing
  //   - landmark: fixture has <nav> but no <main> — real defect, editable,
  //     gate scores the transition
  //
  // landmark is the only declared a11yCheck sub-type that scores a
  // meaningful state transition in this fixture.
  // ==========================================================================

  {
    case_id: 'a11y:a11y-synth-001',
    source: 'D',
    intent: 'synthetic',
    category: 'a11y',
    primary_family: null,
    track: 'N1-A',
    goal: 'a11y: add role="main" to the hero div on the /about page; the fixture currently has no <main> element anywhere in server.js, so the a11y gate\'s landmark check emits a finding ("Missing landmark: <main> or role=\\"main\\""). After the edit, role="main" satisfies the landmark requirement and the check should report no findings. Note: the landmark check is project-scoped (concatenates all HTML files and asks whether any page has a landmark), not page-scoped. Adding role="main" to the /about page satisfies the gate globally; the seed tests the gate\'s state transition from finding to no-finding, not per-page coverage.',
    reference_edits: [
      {
        file: 'server.js',
        search: '<div class="hero">',
        replace: '<div class="hero" role="main">',
      },
    ],
    reference_predicates: [
      {
        type: 'a11y',
        a11yCheck: 'landmark',
        expected: 'no_findings',
      },
    ],
    expected_success: true,
    scenario_file: 'SOURCE_D_SYNTHETIC',
    scenario_id: 'a11y-synth-001',
  },
];

// ============================================================================
// Emit source-d-seeds.jsonl with metadata header
// ============================================================================

function main(): void {
  const outPath = join(import.meta.dir, 'source-d-seeds.jsonl');

  // Sanity check: the per-category counts must match Amendment 4 Change 2
  const counts = {
    config: seeds.filter((s) => s.category === 'config').length,
    grounding: seeds.filter((s) => s.category === 'grounding').length,
    security: seeds.filter((s) => s.category === 'security').length,
    a11y: seeds.filter((s) => s.category === 'a11y').length,
  };

  if (counts.config !== 5 || counts.grounding !== 4 || counts.security !== 2 || counts.a11y !== 1) {
    throw new Error(
      `Per-category count mismatch. Expected 5 config + 4 grounding + 2 security + 1 a11y = 12. ` +
        `Got ${JSON.stringify(counts)} = ${seeds.length}. This violates Amendment 4 Change 2 and must be fixed before commit.`
    );
  }
  if (seeds.length !== 12) {
    throw new Error(`Total seed count is ${seeds.length}, expected 12 per Amendment 4 Change 2.`);
  }

  // Sanity check: all case_ids must be unique
  const ids = new Set(seeds.map((s) => s.case_id));
  if (ids.size !== seeds.length) {
    throw new Error(`Duplicate case_ids detected. Expected ${seeds.length} unique ids, got ${ids.size}.`);
  }

  const metadata = {
    __metadata: true,
    phase: 'N1 Phase 1g (Source D synthetic seeds)',
    generated_at: new Date().toISOString(),
    design_md_version: 'v1 + Amendment 1 + Amendment 2 + Amendment 3 + Amendment 4',
    authority: 'Amendment 4 Change 2: 5 config + 4 grounding + 2 security + 1 a11y = 12',
    demo_app_fixture: 'fixtures/demo-app/',
    note: 'These are hand-constructed synthetic seeds. Per DESIGN.md §14, synthetic seeds are NOT pre-flighted; their pre_flight_result in case-list.jsonl is "synthetic". Each seed targets verified strings in the demo-app fixture (all search strings grep-confirmed unambiguous at the corpus SHA committed alongside this file). Small-sample disclaimers from Amendment 2 Change 3 (content) and Amendment 4 Change 2 (grounding, security, a11y) will apply to the corresponding RESULTS.md reporting rows.',
    counts,
    seed_count: seeds.length,
  };

  const lines: string[] = [JSON.stringify(metadata)];
  for (const s of seeds) {
    lines.push(JSON.stringify(s));
  }

  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`Wrote ${seeds.length + 1} lines to ${outPath}`);
  console.log(`  1 metadata header + ${seeds.length} seed records`);
  console.log('');
  console.log('Per-category counts (Amendment 4 Change 2):');
  console.log(`  config:    ${counts.config}`);
  console.log(`  grounding: ${counts.grounding}`);
  console.log(`  security:  ${counts.security}`);
  console.log(`  a11y:      ${counts.a11y}`);
  console.log(`  total:     ${seeds.length}`);
}

if (import.meta.main) {
  main();
}
