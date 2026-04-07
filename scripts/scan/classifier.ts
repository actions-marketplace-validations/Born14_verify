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

  // GC-661: Access gate on agent config JSON (.promptx, .claude, .cursor config)
  if (gate === 'access' && (/\.promptx\//.test(file) || /\.claude\//.test(file) || /\.cursor\//.test(file))) {
    return { confidence: 'low', reason: 'GC-661: access gate on agent config JSON', shape: 'GC-661' };
  }

  // GC-662: Contention gate on config JSON (mcp.json, lockfiles)
  if (gate === 'contention' && (/mcp\.json$/.test(file) || /[-.]lock\.(json|yaml|yml)$|\.lock$/.test(file))) {
    return { confidence: 'low', reason: 'GC-662: contention gate on config JSON', shape: 'GC-662' };
  }

  // GC-663: Access gate on shell scripts — paths in scripts are normal
  if (gate === 'access' && /\.(sh|bash|zsh)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-663: access gate on shell script', shape: 'GC-663' };
  }

  // GC-664: Access gate on .env.example/.env.staging — template files, not production
  if (gate === 'access' && /\.env\.(example|sample|template|staging|development|test)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-664: access gate on env template file', shape: 'GC-664' };
  }

  // GC-665: Access gate on agent rule files
  if (gate === 'access' && /\.(cursorrules|clinerules)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-665: access gate on agent rule file', shape: 'GC-665' };
  }

  // GC-666: Access gate on Gradle build files
  if (gate === 'access' && /\.(gradle|gradle\.kts)$|settings\.gradle/.test(file)) {
    return { confidence: 'low', reason: 'GC-666: access gate on Gradle build file', shape: 'GC-666' };
  }

  // GC-667: Contention gate on CI workflow YAML
  if (gate === 'contention' && /\.(yaml|yml)$/.test(file) && file.includes('.github/')) {
    return { confidence: 'low', reason: 'GC-667: contention gate on CI workflow YAML', shape: 'GC-667' };
  }

  // GC-668: Propagation gate on JSONC config files
  if (gate === 'propagation' && /\.jsonc$/.test(file)) {
    return { confidence: 'low', reason: 'GC-668: propagation gate on JSONC config', shape: 'GC-668' };
  }

  // GC-669: Propagation gate on TS/JS — CSS class name false matches
  // Generic CSS classes (.container, .tooltip, .small) in string literals aren't cross-file renames
  if (gate === 'propagation' && /\.(ts|js|mjs|cjs)$/.test(file) && !file.endsWith('.tsx') && !file.endsWith('.jsx')) {
    return { confidence: 'low', reason: 'GC-669: propagation gate on TS/JS — CSS class string matches', shape: 'GC-669' };
  }

  // GC-670: Access gate on React/TSX components
  // UI components importing APIs and using function calls aren't privilege escalation
  if (gate === 'access' && /\.(tsx|jsx)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-670: access gate on React/TSX component', shape: 'GC-670' };
  }

  // GC-671: Propagation gate on React/TSX — CSS class name false matches
  if (gate === 'propagation' && /\.(tsx|jsx)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-671: propagation gate on React/TSX — CSS class string matches', shape: 'GC-671' };
  }

  // GC-672: Access gate on SQL test files — test scripts aren't real permission issues
  if (gate === 'access' && /\.(sql)$/.test(file) && (file.includes('test') || file.includes('Test') || file.includes('spec'))) {
    return { confidence: 'low', reason: 'GC-672: access gate on SQL test file', shape: 'GC-672' };
  }

  // GC-673: Access gate on C/C++ source files — includes and filesystem APIs are normal
  if (gate === 'access' && /\.(cpp|c|cc|cxx)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-673: access gate on C/C++ source file', shape: 'GC-673' };
  }

  // GC-674: Propagation gate on Solidity — import paths in .sol files are normal
  if (gate === 'propagation' && /\.sol$/.test(file)) {
    return { confidence: 'low', reason: 'GC-674: propagation gate on Solidity contract', shape: 'GC-674' };
  }

  // GC-675: Propagation gate on HTML — generic CSS class names aren't cross-file renames
  if (gate === 'propagation' && /\.html?$/.test(file)) {
    return { confidence: 'low', reason: 'GC-675: propagation gate on HTML — CSS class string matches', shape: 'GC-675' };
  }

  // GC-676: Access gate on .devcontainer config
  if (gate === 'access' && file.includes('.devcontainer')) {
    return { confidence: 'low', reason: 'GC-676: access gate on devcontainer config', shape: 'GC-676' };
  }

  // GC-677: Access gate on Zig source files — file paths in Zig are normal
  if (gate === 'access' && /\.zig$/.test(file)) {
    return { confidence: 'low', reason: 'GC-677: access gate on Zig source file', shape: 'GC-677' };
  }

  // GC-678: Access gate on Dart source files
  if (gate === 'access' && /\.dart$/.test(file)) {
    return { confidence: 'low', reason: 'GC-678: access gate on Dart source file', shape: 'GC-678' };
  }

  // GC-679: Access gate on Makefiles — paths in make rules are normal
  if (gate === 'access' && /[Mm]akefile/.test(file)) {
    return { confidence: 'low', reason: 'GC-679: access gate on Makefile', shape: 'GC-679' };
  }

  // GC-680: Access gate on Go module files
  if (gate === 'access' && /go\.(mod|sum|work)$/.test(file)) {
    return { confidence: 'low', reason: 'GC-680: access gate on Go module file', shape: 'GC-680' };
  }

  // GC-681: Access gate on RON/config files (.ron = Rust Object Notation)
  if (gate === 'access' && /\.ron$/.test(file)) {
    return { confidence: 'low', reason: 'GC-681: access gate on RON config file', shape: 'GC-681' };
  }

  // GC-682: Access gate on PowerShell scripts
  if (gate === 'access' && /\.ps1$/.test(file)) {
    return { confidence: 'low', reason: 'GC-682: access gate on PowerShell script', shape: 'GC-682' };
  }

  // GC-683: Contention gate on .mts (TypeScript module) files
  if (gate === 'contention' && /\.mts$/.test(file)) {
    return { confidence: 'low', reason: 'GC-683: contention gate on .mts TypeScript module', shape: 'GC-683' };
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
