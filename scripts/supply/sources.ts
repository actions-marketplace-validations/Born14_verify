/**
 * Real-World Source Registry
 * ==========================
 *
 * Declarative config for external data sources. Each source specifies:
 * - What to fetch (URL, git repo, or GitHub API)
 * - Which harvester processes it
 * - How many scenarios to produce (cap)
 *
 * Sources are fetched to a local cache dir, then processed by harvesters.
 * The cache is gitignored — real data never enters the repo.
 *
 * Usage:
 *   import { SOURCES, fetchSource } from './sources.js';
 *   const data = await fetchSource(SOURCES['mustache-spec'], cacheDir);
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { spawnSync } from 'child_process';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FetchType = 'url' | 'git' | 'github-raw';

export interface FetchSpec {
  type: FetchType;
  /** For 'url': direct download URL. For 'git': repo URL. For 'github-raw': raw.githubusercontent.com base. */
  url: string;
  /** For 'git': specific paths to sparse checkout (saves bandwidth). */
  sparse?: string[];
  /** For 'github-raw': list of file paths relative to repo root. */
  files?: string[];
  /** Expected format of the fetched data. */
  format: 'json' | 'jsonl' | 'text' | 'css' | 'sql' | 'html' | 'dat' | 'yaml' | 'mjs';
}

export interface RealWorldSource {
  id: string;
  name: string;
  harvester: 'db' | 'css' | 'html' | 'http' | 'security' | 'infra';
  fetch: FetchSpec;
  maxScenarios: number;
  tags: string[];
  /** License of the source data. */
  license: string;
}

export interface FetchResult {
  source: RealWorldSource;
  /** Local paths to fetched files. */
  files: string[];
  /** Raw content keyed by filename (for single-file fetches). */
  content?: Record<string, string>;
  /** Whether data was served from cache. */
  cached: boolean;
  /** Fetch duration in ms. */
  fetchMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Registry
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCES: Record<string, RealWorldSource> = {
  // ── DB Sources ────────────────────────────────────────────────────────────

  'schemapile': {
    id: 'schemapile',
    name: 'SchemaPile (HuggingFace)',
    harvester: 'db',
    fetch: {
      type: 'url',
      url: 'https://huggingface.co/datasets/trl-lab/schemapile/resolve/main/data.jsonl',
      format: 'jsonl',
    },
    maxScenarios: 2000,
    tags: ['db', 'real-world', 'schemapile'],
    license: 'Apache-2.0',
  },

  'json-schema-test-suite': {
    id: 'json-schema-test-suite',
    name: 'JSON Schema Test Suite',
    harvester: 'http',
    fetch: {
      type: 'git',
      url: 'https://github.com/json-schema-org/JSON-Schema-Test-Suite.git',
      sparse: ['tests/draft2020-12'],
      format: 'json',
    },
    maxScenarios: 1000,
    tags: ['http', 'real-world', 'json-schema'],
    license: 'MIT',
  },

  // ── CSS Sources ───────────────────────────────────────────────────────────

  'mdn-compat': {
    id: 'mdn-compat',
    name: 'MDN Browser Compat Data',
    harvester: 'css',
    fetch: {
      type: 'url',
      url: 'https://unpkg.com/@mdn/browser-compat-data/data.json',
      format: 'json',
    },
    maxScenarios: 2000,
    tags: ['css', 'real-world', 'mdn'],
    license: 'CC0-1.0',
  },

  'caniuse': {
    id: 'caniuse',
    name: 'Can I Use Feature Data',
    harvester: 'css',
    fetch: {
      type: 'url',
      url: 'https://raw.githubusercontent.com/Fyrd/caniuse/main/fulldata-json/data-2.0.json',
      format: 'json',
    },
    maxScenarios: 1000,
    tags: ['css', 'real-world', 'caniuse'],
    license: 'CC-BY-4.0',
  },

  'postcss-parser-tests': {
    id: 'postcss-parser-tests',
    name: 'PostCSS Parser Tests',
    harvester: 'css',
    fetch: {
      type: 'git',
      url: 'https://github.com/postcss/postcss-parser-tests.git',
      format: 'css',
    },
    maxScenarios: 100,
    tags: ['css', 'real-world', 'postcss'],
    license: 'MIT',
  },

  // ── HTML Sources ──────────────────────────────────────────────────────────

  'mustache-spec': {
    id: 'mustache-spec',
    name: 'Mustache Specification',
    harvester: 'html',
    fetch: {
      type: 'git',
      url: 'https://github.com/mustache/spec.git',
      sparse: ['specs'],
      format: 'json',
    },
    maxScenarios: 300,
    tags: ['html', 'real-world', 'mustache'],
    license: 'MIT',
  },

  // ── Security Sources ──────────────────────────────────────────────────────

  'payloads-xss': {
    id: 'payloads-xss',
    name: 'PayloadsAllTheThings XSS',
    harvester: 'security',
    fetch: {
      type: 'git',
      url: 'https://github.com/swisskyrepo/PayloadsAllTheThings.git',
      sparse: ['XSS Injection'],
      format: 'text',
    },
    maxScenarios: 1000,
    tags: ['security', 'real-world', 'xss'],
    license: 'MIT',
  },

  // ── HTML Sources (additional) ───────────────────────────────────────────

  'html5lib-tests': {
    id: 'html5lib-tests',
    name: 'html5lib Parser Conformance Tests',
    harvester: 'html',
    fetch: {
      type: 'git',
      url: 'https://github.com/html5lib/html5lib-tests.git',
      sparse: ['tree-construction'],
      format: 'dat',
    },
    maxScenarios: 2000,
    tags: ['html', 'real-world', 'html5lib', 'parser-conformance'],
    license: 'MIT',
  },

  // ── Security Sources (additional) ─────────────────────────────────────

  'dompurify': {
    id: 'dompurify',
    name: 'DOMPurify Sanitization Tests',
    harvester: 'security',
    fetch: {
      type: 'git',
      url: 'https://github.com/cure53/DOMPurify.git',
      sparse: ['test'],
      format: 'mjs',
    },
    maxScenarios: 500,
    tags: ['security', 'real-world', 'dompurify', 'xss'],
    license: 'Apache-2.0',
  },

  // ── DB Sources (additional) ───────────────────────────────────────────

  'pg-regress': {
    id: 'pg-regress',
    name: 'PostgreSQL Regression Tests',
    harvester: 'db',
    fetch: {
      type: 'github-raw',
      url: 'https://raw.githubusercontent.com',
      files: [
        'postgres/postgres/master/src/test/regress/sql/create_table.sql',
        'postgres/postgres/master/src/test/regress/sql/foreign_key.sql',
        'postgres/postgres/master/src/test/regress/sql/alter_table.sql',
        'postgres/postgres/master/src/test/regress/sql/create_index.sql',
        'postgres/postgres/master/src/test/regress/sql/constraints.sql',
        'postgres/postgres/master/src/test/regress/sql/create_type.sql',
        'postgres/postgres/master/src/test/regress/sql/create_view.sql',
        'postgres/postgres/master/src/test/regress/sql/inherit.sql',
        'postgres/postgres/master/src/test/regress/sql/partition_info.sql',
        'postgres/postgres/master/src/test/regress/sql/triggers.sql',
      ],
      format: 'sql',
    },
    maxScenarios: 500,
    tags: ['db', 'real-world', 'pg-regress'],
    license: 'PostgreSQL',
  },

  // ── HTTP Sources (additional) ─────────────────────────────────────────

  'httpwg-sf-tests': {
    id: 'httpwg-sf-tests',
    name: 'HTTPWG Structured Field Tests',
    harvester: 'http',
    fetch: {
      type: 'git',
      url: 'https://github.com/httpwg/structured-field-tests.git',
      format: 'json',
    },
    maxScenarios: 500,
    tags: ['http', 'real-world', 'structured-fields', 'rfc'],
    license: 'BSD-3-Clause',
  },

  // ── Infra Sources (additional) ────────────────────────────────────────

  'awesome-compose': {
    id: 'awesome-compose',
    name: 'Docker Awesome Compose',
    harvester: 'infra',
    fetch: {
      type: 'git',
      url: 'https://github.com/docker/awesome-compose.git',
      format: 'yaml',
    },
    maxScenarios: 500,
    tags: ['infra', 'real-world', 'docker-compose'],
    license: 'Apache-2.0',
  },

  // ── HTTP Sources ──────────────────────────────────────────────────────────

  'heroku-error-codes': {
    id: 'heroku-error-codes',
    name: 'Heroku Error Codes',
    harvester: 'infra',
    fetch: {
      type: 'github-raw',
      url: 'https://raw.githubusercontent.com',
      files: [
        // Heroku error docs aren't in a git repo — use the devcenter page
        // We'll fetch the raw page and parse error codes from it
      ],
      format: 'html',
    },
    maxScenarios: 100,
    tags: ['infra', 'real-world', 'heroku'],
    license: 'Public',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Engine
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch a real-world source to the local cache directory.
 * Returns paths to fetched files and whether the cache was used.
 */
export async function fetchSource(source: RealWorldSource, cacheDir: string): Promise<FetchResult> {
  const sourceDir = join(cacheDir, source.id);
  const metaPath = join(sourceDir, '_meta.json');
  const start = Date.now();

  // Check cache freshness
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const age = Date.now() - meta.fetchedAt;
      if (age < CACHE_TTL_MS) {
        const files = listDataFiles(sourceDir);
        return { source, files, cached: true, fetchMs: Date.now() - start };
      }
    } catch { /* stale cache, refetch */ }
  }

  mkdirSync(sourceDir, { recursive: true });

  switch (source.fetch.type) {
    case 'url':
      await fetchUrl(source.fetch.url, sourceDir, source.id);
      break;
    case 'git':
      await fetchGit(source.fetch.url, sourceDir, source.fetch.sparse);
      break;
    case 'github-raw':
      await fetchGithubRaw(source.fetch.url, source.fetch.files ?? [], sourceDir);
      break;
  }

  // Write cache metadata
  writeFileSync(metaPath, JSON.stringify({
    sourceId: source.id,
    fetchedAt: Date.now(),
    url: source.fetch.url,
  }, null, 2));

  const files = listDataFiles(sourceDir);
  return { source, files, cached: false, fetchMs: Date.now() - start };
}

/**
 * Fetch a single URL and save to cache dir.
 */
async function fetchUrl(url: string, destDir: string, name: string): Promise<void> {
  console.log(`  Fetching ${url}...`);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'sovereign-labs-verify/0.5' },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const content = await response.text();
  const ext = url.endsWith('.jsonl') ? '.jsonl'
    : url.endsWith('.json') ? '.json'
    : url.endsWith('.css') ? '.css'
    : url.endsWith('.sql') ? '.sql'
    : '.dat';

  writeFileSync(join(destDir, `${name}${ext}`), content);
}

/**
 * Shallow git clone with optional sparse checkout.
 */
async function fetchGit(repoUrl: string, destDir: string, sparse?: string[]): Promise<void> {
  const repoDir = join(destDir, 'repo');

  // Remove old clone if exists
  if (existsSync(repoDir)) {
    spawnSync('rm', ['-rf', repoDir], { shell: true });
  }

  if (sparse && sparse.length > 0) {
    console.log(`  Sparse clone ${repoUrl} [${sparse.join(', ')}]...`);
    // Init + sparse checkout for minimal bandwidth
    spawnSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', repoUrl, repoDir], {
      stdio: 'pipe',
      shell: true,
    });
    spawnSync('git', ['-C', repoDir, 'sparse-checkout', 'set', ...sparse], {
      stdio: 'pipe',
      shell: true,
    });
  } else {
    console.log(`  Shallow clone ${repoUrl}...`);
    spawnSync('git', ['clone', '--depth', '1', repoUrl, repoDir], {
      stdio: 'pipe',
      shell: true,
    });
  }
}

/**
 * Fetch individual files from raw.githubusercontent.com.
 */
async function fetchGithubRaw(baseUrl: string, files: string[], destDir: string): Promise<void> {
  for (const filePath of files) {
    const url = `${baseUrl}/${filePath}`;
    console.log(`  Fetching ${filePath}...`);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'sovereign-labs-verify/0.5' },
    });
    if (!response.ok) {
      console.log(`    WARN: ${response.status} for ${filePath}`);
      continue;
    }
    const content = await response.text();
    const name = basename(filePath);
    writeFileSync(join(destDir, name), content);
  }
}

/**
 * List all data files in a source cache directory (exclude metadata).
 */
function listDataFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name === '.git') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(full);
    }
  }

  walk(dir);
  return entries;
}

/**
 * List all registered source IDs.
 */
export function listSources(): string[] {
  return Object.keys(SOURCES);
}

/**
 * Get sources for a specific harvester.
 */
export function getSourcesForHarvester(harvester: string): RealWorldSource[] {
  return Object.values(SOURCES).filter(s => s.harvester === harvester);
}
