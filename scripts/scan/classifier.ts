/**
 * Finding Confidence Classifier
 * ==============================
 *
 * Auto-tags scan findings as high/low/unknown confidence before the
 * operator sees them. Replaces manual spot-checking for known patterns.
 *
 * High:    Backend code with executable patterns → likely real
 * Low:     Known false positive patterns (GC shapes) → skip
 * Unknown: New pattern, not yet classified → needs human review
 *
 * The classifier improves each batch: operator decisions on unknowns
 * become new rules for the next batch.
 */

export interface FindingClassification {
  confidence: 'high' | 'low' | 'unknown';
  reason: string;
  shape?: string; // taxonomy shape ID if matched
}

export interface ScanFinding {
  gate: string;
  file: string;
  detail: string;
  totalFindingsInPR: number;
}

// =============================================================================
// FILE TYPE DETECTION
// =============================================================================

const FRONTEND_EXTS = new Set(['tsx', 'jsx', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'sass']);
const BACKEND_EXTS = new Set(['ts', 'js', 'py', 'rb', 'go', 'rs', 'java', 'php', 'cs', 'scala', 'kt']);
const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg']);
const DOC_EXTS = new Set(['md', 'mdx', 'txt', 'rst', 'adoc']);

function getExt(file: string): string {
  return file.split('.').pop()?.toLowerCase() ?? '';
}

function isFrontendFile(file: string): boolean {
  return FRONTEND_EXTS.has(getExt(file));
}

function isBackendFile(file: string): boolean {
  const ext = getExt(file);
  // .ts and .js could be either — check for frontend indicators
  if (ext === 'ts' || ext === 'js') {
    return !file.includes('component') && !file.includes('page') &&
           !file.includes('layout') && !file.endsWith('.tsx') &&
           !file.endsWith('.jsx');
  }
  return BACKEND_EXTS.has(ext);
}

function isTypeDefinition(file: string): boolean {
  return file.endsWith('.d.ts') ||
         file.includes('types.ts') ||
         file.includes('types/') ||
         file.includes('interfaces.ts') ||
         file.includes('schemas/') && file.endsWith('.ts');
}

function isTestFile(file: string): boolean {
  return file.includes('test') || file.includes('spec') ||
         file.includes('__tests__') || file.includes('__mocks__');
}

function isDocFile(file: string): boolean {
  return DOC_EXTS.has(getExt(file)) ||
         file.includes('docs/') || file.includes('doc/');
}

function isConfigFile(file: string): boolean {
  return CONFIG_EXTS.has(getExt(file)) ||
         file.includes('config') || file.includes('.env');
}

// =============================================================================
// CLASSIFIER
// =============================================================================

export function classifyFinding(finding: ScanFinding): FindingClassification {
  const { gate, file, detail, totalFindingsInPR } = finding;
  const ext = getExt(file);

  // ── Known false positive shapes (GC series) ──

  // GC-651: Contention gate on frontend files
  if (gate === 'contention' && isFrontendFile(file)) {
    return { confidence: 'low', reason: 'GC-651: contention gate on frontend file', shape: 'GC-651' };
  }

  // GC-652: Access gate on type definitions
  if (gate === 'access' && isTypeDefinition(file)) {
    return { confidence: 'low', reason: 'GC-652: access gate on type definition', shape: 'GC-652' };
  }

  // GC-653: Access gate on config/infra files — not runtime code
  if (gate === 'access' && (
    file.endsWith('.gitignore') || file.endsWith('.dockerignore') ||
    file === 'package.json' || file.endsWith('/package.json') ||
    file.includes('.github/workflows/') ||
    (file.endsWith('.yml') && file.includes('.github/'))
  )) {
    return { confidence: 'low', reason: 'GC-653: access gate on config/infra file', shape: 'GC-653' };
  }

  // GC-654: Access gate on MSBuild/project files (.csproj, .fsproj, .vbproj)
  if (gate === 'access' && /\.(csproj|fsproj|vbproj|sln|props|targets)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-654: access gate on MSBuild project file', shape: 'GC-654' };
  }

  // GC-655: Access gate on Dockerfiles — paths in COPY/ADD are normal
  if (gate === 'access' && /[Dd]ockerfile/.test(file)) {
    return { confidence: 'low', reason: 'GC-655: access gate on Dockerfile', shape: 'GC-655' };
  }

  // GC-656: Access gate on lockfiles — generated, not authored
  if (gate === 'access' && /[-.]lock\.(json|yaml|yml)$|\.lock$|\.lockb$|^bun\.lock/.test(file)) {
    return { confidence: 'low', reason: 'GC-656: access gate on lockfile', shape: 'GC-656' };
  }

  // GC-657: Access gate on C/C++ headers — #include paths are normal
  if (gate === 'access' && /\.(h|hpp|hxx|hh)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-657: access gate on C/C++ header', shape: 'GC-657' };
  }

  // GC-658: Access gate on general YAML/config outside .github/
  if (gate === 'access' && /\.(yaml|yml|toml|ini|cfg)$/.test(file) && !file.includes('.github/')) {
    return { confidence: 'low', reason: 'GC-658: access gate on general config file', shape: 'GC-658' };
  }

  // GC-659: Access gate on Ruby bundler config
  if (gate === 'access' && (file.includes('.bundle/') || file === 'Gemfile' || file === 'Gemfile.lock')) {
    return { confidence: 'low', reason: 'GC-659: access gate on Ruby bundler config', shape: 'GC-659' };
  }

  // GC-660: Propagation gate on LICENSE files — license text isn't cross-file reference
  if (gate === 'propagation' && /LICENSE|LICENCE|COPYING/i.test(file)) {
    return { confidence: 'low', reason: 'GC-660: propagation gate on license file', shape: 'GC-660' };
  }

  // Doc files rarely have real issues (docs show examples, not production code)
  if (isDocFile(file)) {
    return { confidence: 'low', reason: 'finding in documentation file — likely example code' };
  }

  // Test files: contention/access findings in tests are usually testing those patterns
  if (isTestFile(file) && (gate === 'contention' || gate === 'access' || gate === 'capacity')) {
    return { confidence: 'low', reason: 'finding in test file — testing the pattern, not introducing it' };
  }

  // ── High confidence patterns ──

  // Security findings in backend code
  if (gate === 'security' && isBackendFile(file)) {
    return { confidence: 'high', reason: 'security finding in backend code' };
  }

  // Contention in backend code (race conditions, missing transactions)
  if (gate === 'contention' && isBackendFile(file)) {
    return { confidence: 'high', reason: 'contention finding in backend code' };
  }

  // Access findings in backend code (not types, not tests)
  if (gate === 'access' && isBackendFile(file) && !isTypeDefinition(file)) {
    return { confidence: 'high', reason: 'access finding in backend code' };
  }

  // Capacity in SQL files
  if (gate === 'capacity' && (file.endsWith('.sql') || detail.includes('SQL') || detail.includes('query'))) {
    return { confidence: 'high', reason: 'capacity finding involving SQL/queries' };
  }

  // Capacity in backend code (unbounded queries in server code)
  if (gate === 'capacity' && isBackendFile(file)) {
    return { confidence: 'high', reason: 'capacity finding in backend code' };
  }

  // ── Noise indicators ──

  // PR with 10+ findings from one gate = probably over-matching
  if (totalFindingsInPR > 10) {
    return { confidence: 'low', reason: 'high finding density (>10) suggests over-matching' };
  }

  // Config files: temporal/propagation findings are usually valid
  if (isConfigFile(file) && (gate === 'temporal' || gate === 'propagation')) {
    return { confidence: 'high', reason: `${gate} finding in config file — cross-file consistency issue` };
  }

  // ── Unknown — needs human review ──
  return { confidence: 'unknown', reason: `new pattern: ${gate} on ${ext} file, not yet classified` };
}

/**
 * Classify all findings in a scan result.
 */
export function classifyPRFindings(
  findings: Array<{ gate: string; detail: string; file?: string }>,
  totalFindings: number,
): Array<FindingClassification & { gate: string; file: string }> {
  return findings.map(f => {
    const file = f.file ?? 'unknown';
    const classification = classifyFinding({
      gate: f.gate,
      file,
      detail: f.detail,
      totalFindingsInPR: totalFindings,
    });
    return { ...classification, gate: f.gate, file };
  });
}
