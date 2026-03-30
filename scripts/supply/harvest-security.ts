/**
 * Real-World Security Harvester
 * ==============================
 *
 * Reads real XSS attack payloads from PayloadsAllTheThings and converts
 * to verify scenarios. Tests security gate detection of injection attacks.
 *
 * Input: PayloadsAllTheThings XSS (git clone)
 *   {cacheDir}/payloads-xss/repo/XSS Injection/
 *   Contains Intruder/*.txt files with one payload per line,
 *   plus markdown files with embedded payloads.
 *
 * Output: VerifyScenario[] with source: 'real-world'
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

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
// Payload Classification
// ─────────────────────────────────────────────────────────────────────────────

/** Dangerous patterns that a security gate must detect. Case-insensitive. */
const DANGEROUS_PATTERNS = [
  '<script',
  'onerror=',
  'onerror =',
  'onload=',
  'onload =',
  'onfocus=',
  'onfocus =',
  'onclick=',
  'onclick =',
  'onmouseover=',
  'onmouseover =',
  'onmouseout=',
  'onmouseenter=',
  'oninput=',
  'onchange=',
  'onsubmit=',
  'ondblclick=',
  'onkeydown=',
  'onkeyup=',
  'onkeypress=',
  'ondrag=',
  'onanimationend=',
  'ontransitionend=',
  'onpageshow=',
  'onbeforeunload=',
  'onhashchange=',
  'onpopstate=',
  'onresize=',
  'onscroll=',
  'onwheel=',
  'ontouchstart=',
  'ontouchend=',
  'onpointerdown=',
  'javascript:',
  'vbscript:',
  'livescript:',
  'eval(',
  'alert(',
  'confirm(',
  'prompt(',
  'document.cookie',
  'document.domain',
  'document.write',
  'document.location',
  'window.location',
  'window.open',
  'String.fromCharCode',
  'atob(',
  'btoa(',
  'setTimeout(',
  'setInterval(',
  'Function(',
  'constructor[',
  '.constructor(',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'srcdoc=',
  'data:text/html',
  'base64,',
  'expression(',
  'url(',
  '-moz-binding',
  'behavior:',
  '<iframe',
  '<object',
  '<embed',
  '<applet',
  '<form',
  '<input',
  '<meta',
  '<link',
  '<svg',
  '<math',
  '<video',
  '<audio',
  '<source',
  '<img',
  '<body',
  '<marquee',
  '<isindex',
  '<frameset',
  '<details',
  '<select',
  '<textarea',
  '<keygen',
  '<button',
  '<xss',
  'FSCommand',
  'seekSegmentTime',
];

/** Benign HTML tags that are not XSS vectors. */
const BENIGN_TAGS = ['<b>', '</b>', '<i>', '</i>', '<p>', '</p>', '<br>', '<br/>', '<br />', '<em>', '</em>', '<strong>', '</strong>', '<u>', '</u>', '<small>', '</small>', '<sub>', '</sub>', '<sup>', '</sup>', '<hr>', '<hr/>'];

/**
 * Classify whether a payload line is dangerous (XSS) or benign.
 * Returns 'dangerous' | 'benign' | 'skip'.
 */
function classifyPayload(line: string): 'dangerous' | 'benign' | 'skip' {
  const trimmed = line.trim();

  // Skip empty lines, comments, headers
  if (trimmed.length === 0) return 'skip';
  if (trimmed.startsWith('#')) return 'skip';
  if (trimmed.startsWith('//')) return 'skip';
  if (trimmed.startsWith('---')) return 'skip';
  if (trimmed.startsWith('```')) return 'skip';
  // Skip markdown headers and list items that are descriptions, not payloads
  if (/^#{1,6}\s/.test(trimmed)) return 'skip';

  // Very short lines are likely noise
  if (trimmed.length < 3) return 'skip';

  const lower = trimmed.toLowerCase();

  // Check against dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return 'dangerous';
    }
  }

  // Check for encoded variants (hex, unicode, url-encoded)
  if (/&#x?[0-9a-f]+;/i.test(trimmed)) return 'dangerous';  // HTML entities
  if (/%3c|%3e|%22|%27|%28|%29/i.test(trimmed)) return 'dangerous';  // URL-encoded < > " ' ( )
  if (/\\u00[0-9a-f]{2}/i.test(trimmed)) return 'dangerous';  // Unicode escapes
  if (/\\x[0-9a-f]{2}/i.test(trimmed)) return 'dangerous';  // Hex escapes

  // If it contains angle brackets but isn't a known benign tag, treat as suspicious
  if (/<[a-z]/i.test(trimmed)) {
    const isBenign = BENIGN_TAGS.some(tag => lower === tag.toLowerCase());
    return isBenign ? 'benign' : 'dangerous';
  }

  // Pure text without any HTML or script markers
  return 'benign';
}

/**
 * Classify the payload type for tagging purposes.
 */
function classifyPayloadType(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes('<script')) return 'script-injection';
  if (/on\w+=/.test(lower)) return 'event-handler';
  if (lower.includes('javascript:')) return 'protocol-handler';
  if (lower.includes('eval(') || lower.includes('function(')) return 'eval-injection';
  if (lower.includes('document.cookie') || lower.includes('document.domain')) return 'dom-access';
  if (lower.includes('<iframe') || lower.includes('<object') || lower.includes('<embed')) return 'element-injection';
  if (lower.includes('<svg') || lower.includes('<math')) return 'svg-math-injection';
  if (lower.includes('<img')) return 'img-injection';
  if (/&#x?[0-9a-f]+;/i.test(line) || /%3c/i.test(line)) return 'encoded-payload';
  if (lower.includes('expression(') || lower.includes('-moz-binding')) return 'css-injection';
  return 'other';
}

/**
 * Escape a payload string for safe embedding in JSON and JS source.
 */
function escapePayloadForEmbed(payload: string): string {
  return payload
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * Truncate a payload for use in descriptions.
 */
function truncatePayload(payload: string, max: number): string {
  const clean = payload.replace(/\n/g, '\\n').replace(/\r/g, '');
  return clean.length <= max ? clean : clean.substring(0, max) + '...';
}

/**
 * Collect all text files recursively from a directory.
 */
function collectTextFiles(dir: string): string[] {
  const result: string[] = [];
  if (!existsSync(dir)) return result;

  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (['.txt', '.md', '.lst', '.csv', '.dat', '.mjs', '.js'].includes(ext)) {
          result.push(full);
        }
      }
    }
  }

  walk(dir);
  return result;
}

// ────────────────────────────────────��────────────────────────────────────────
// DOMPurify fixture parser
// ──────���────────────────���──────────────────────────────────��──────────────────

interface DOMPurifyVector {
  payload: string;
  expected: string;
  title?: string;
}

/**
 * Parse DOMPurify test fixtures from .mjs/.js files.
 * The expect.mjs file uses JSON-style objects with "payload" and "expected" fields.
 * We parse it as JSON after stripping the ESM export wrapper.
 */
function parseDOMPurifyFixtures(content: string): DOMPurifyVector[] {
  // Strip ESM export: "export default [...]" → "[...]"
  let jsonStr = content
    .replace(/^export\s+default\s+/, '')
    .trim();
  // Remove trailing semicolons
  if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);

  try {
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return [];
    return arr.filter((item: any) =>
      typeof item === 'object' && item !== null && typeof item.payload === 'string'
    ).map((item: any) => ({
      payload: item.payload,
      expected: item.expected ?? '',
      title: item.title,
    }));
  } catch {
    // Fallback: regex extraction for non-standard formats
    const vectors: DOMPurifyVector[] = [];
    const entryRegex = /"payload"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"expected"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(content)) !== null) {
      vectors.push({
        payload: match[1].replace(/\\"/g, '"'),
        expected: match[2].replace(/\\"/g, '"'),
      });
    }
    return vectors;
  }
}

/**
 * Generate security scenarios from DOMPurify sanitization vectors.
 */
function harvestDOMPurify(
  files: string[],
  maxScenarios: number,
  startCounter: number,
  seen: Set<string>,
): { scenarios: VerifyScenario[], counter: number } {
  const scenarios: VerifyScenario[] = [];
  let counter = startCounter;

  const mjsFiles = files.filter(f => {
    const ext = extname(f).toLowerCase();
    return ext === '.mjs' || ext === '.js';
  });

  for (const filePath of mjsFiles) {
    if (scenarios.length >= maxScenarios) break;

    let content: string;
    try {
      const stats = statSync(filePath);
      if (stats.size > 5 * 1024 * 1024) continue;
      content = readFileSync(filePath, 'utf-8');
    } catch { continue; }

    // Only process files that look like DOMPurify fixtures (have payload and expected)
    if (!content.includes('payload') || !content.includes('expected')) continue;

    const vectors = parseDOMPurifyFixtures(content);
    if (vectors.length === 0) continue;

    const sourceFile = basename(filePath);

    for (const vec of vectors) {
      if (scenarios.length >= maxScenarios) break;

      // Dedup
      const dedupKey = vec.payload.substring(0, 50);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      counter++;

      // If payload !== expected, DOMPurify strips something — the input is dangerous
      const wasSanitized = vec.payload !== vec.expected;
      const payloadClassification = classifyPayload(vec.payload);
      const isDangerous = wasSanitized || payloadClassification === 'dangerous';

      if (payloadClassification === 'skip') continue;

      const payloadType = classifyPayloadType(vec.payload);
      const escapedPayload = escapePayloadForEmbed(vec.payload);

      scenarios.push({
        id: `rw-sec-dp-${String(counter).padStart(4, '0')}`,
        description: `DOMPurify: ${vec.title || truncatePayload(vec.payload, 60)} (${sourceFile})`,
        edits: [{
          file: 'server.js',
          search: '<p>Additional details appear here.</p>',
          replace: `<p>Additional details appear here.</p>\n    <div class="user-content">${escapedPayload}</div>`,
        }],
        predicates: [{
          type: 'security',
          check: 'xss',
          target: 'server.js',
          assertion: 'no_findings',
        }],
        expectedSuccess: !isDangerous,
        tags: [
          'security',
          'real-world',
          'dompurify',
          payloadType,
          isDangerous ? 'dangerous' : 'benign',
        ],
        rationale: isDangerous
          ? `DOMPurify sanitization vector (${sourceFile}): input was ${wasSanitized ? 'stripped' : 'flagged'} — ${payloadType}. Input: ${truncatePayload(vec.payload, 80)}`
          : `DOMPurify safe vector (${sourceFile}): input unchanged after sanitization. Input: ${truncatePayload(vec.payload, 80)}`,
        source: 'real-world',
      });
    }
  }

  return { scenarios, counter };
}

/**
 * Convert XSS payload files into security verify scenarios.
 *
 * For each XSS payload:
 * - Inject the payload into server.js via an edit
 * - Create a security predicate that should detect the XSS
 * - expectedSuccess: false when dangerous (gate should catch), true when benign
 */
export function harvestSecurity(files: string[], maxScenarios: number): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  let counter = 0;

  // Deduplicate payloads by first 50 characters
  const seen = new Set<string>();

  // ── DOMPurify fixtures (.mjs/.js) ──────────────────────────────────────
  const mjsFiles = files.filter(f => {
    const ext = extname(f).toLowerCase();
    return ext === '.mjs' || ext === '.js';
  });
  if (mjsFiles.length > 0) {
    const dpBudget = Math.min(Math.floor(maxScenarios * 0.3), maxScenarios);
    const dp = harvestDOMPurify(mjsFiles, dpBudget, counter, seen);
    scenarios.push(...dp.scenarios);
    counter = dp.counter;
  }

  // ── PayloadsAllTheThings (.txt/.md) ────────────────────────────────────
  for (const filePath of files) {
    if (scenarios.length >= maxScenarios) break;

    // Skip .mjs/.js files (handled by DOMPurify branch above)
    const fileExt = extname(filePath).toLowerCase();
    if (fileExt === '.mjs' || fileExt === '.js') continue;

    let content: string;
    try {
      // Skip very large files (>5MB)
      const stats = statSync(filePath);
      if (stats.size > 5 * 1024 * 1024) continue;

      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const sourceFile = basename(filePath);

    // Extract payload lines from the file
    // For markdown files, only extract lines inside code blocks or that look like payloads
    const isMarkdown = filePath.endsWith('.md');
    const lines = content.split('\n');
    let inCodeBlock = false;

    for (const rawLine of lines) {
      if (scenarios.length >= maxScenarios) break;

      // Track code block boundaries in markdown
      if (isMarkdown && rawLine.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      // In markdown, only process lines inside code blocks or that start with payload-like chars
      if (isMarkdown && !inCodeBlock) {
        const trimmed = rawLine.trim();
        // Skip pure prose lines
        if (!trimmed.startsWith('<') && !trimmed.startsWith('%') && !trimmed.includes('javascript:')) {
          continue;
        }
      }

      const line = rawLine.trim();
      const classification = classifyPayload(line);
      if (classification === 'skip') continue;

      // Dedup by first 50 chars
      const dedupKey = line.substring(0, 50);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      counter++;
      const escapedPayload = escapePayloadForEmbed(line);
      const payloadType = classifyPayloadType(line);
      const isDangerous = classification === 'dangerous';

      scenarios.push({
        id: `rw-sec-xss-${String(counter).padStart(4, '0')}`,
        description: `XSS payload: ${truncatePayload(line, 70)} (${sourceFile})`,
        edits: [{
          file: 'server.js',
          search: '<p>Additional details appear here.</p>',
          replace: `<p>Additional details appear here.</p>\n    <div class="user-content">${escapedPayload}</div>`,
        }],
        predicates: [{
          type: 'security',
          check: 'xss',
          target: 'server.js',
          assertion: 'no_findings',
        }],
        expectedSuccess: !isDangerous, // gate should CATCH dangerous, PASS benign
        tags: [
          'security',
          'real-world',
          'xss',
          payloadType,
          isDangerous ? 'dangerous' : 'benign',
        ],
        rationale: isDangerous
          ? `Real XSS payload from PayloadsAllTheThings (${sourceFile}) — security gate must detect ${payloadType} pattern: ${truncatePayload(line, 80)}`
          : `Benign content from PayloadsAllTheThings (${sourceFile}) — security gate should not flag: ${truncatePayload(line, 80)}`,
        source: 'real-world',
      });
    }
  }

  // Count dangerous vs benign for logging
  const dangerousCount = scenarios.filter(s => !s.expectedSuccess).length;
  const benignCount = scenarios.filter(s => s.expectedSuccess).length;
  const dpCount = scenarios.filter(s => s.tags.includes('dompurify')).length;
  console.log(`  harvest-security: ${files.length} files (${dpCount} dompurify), generated ${scenarios.length} scenarios (${dangerousCount} dangerous, ${benignCount} benign)`);

  return scenarios;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone test
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const testDir = process.argv[2];
  if (!testDir) {
    console.log('Usage: bun scripts/supply/harvest-security.ts <cache-dir>');
    console.log('  cache-dir should contain payloads-xss/repo/XSS Injection/');
    process.exit(1);
  }

  const xssDir = join(testDir, 'payloads-xss', 'repo', 'XSS Injection');
  if (!existsSync(xssDir)) {
    console.log(`Not found: ${xssDir}`);
    console.log('Run the fetch step first to populate the cache.');
    process.exit(1);
  }

  // Collect all text/markdown files from the XSS directory
  const files = collectTextFiles(xssDir);
  console.log(`Found ${files.length} payload files in ${xssDir}`);
  for (const f of files.slice(0, 10)) {
    console.log(`  ${basename(f)}`);
  }

  const scenarios = harvestSecurity(files, 1000);
  console.log(`\nGenerated ${scenarios.length} scenarios`);

  // Show distribution by payload type
  const byType: Record<string, number> = {};
  for (const s of scenarios) {
    const typeTag = s.tags.find(t => !['security', 'real-world', 'xss', 'dangerous', 'benign'].includes(t));
    if (typeTag) {
      byType[typeTag] = (byType[typeTag] || 0) + 1;
    }
  }
  console.log('\nBy payload type:');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  // Show dangerous vs benign
  const dangerous = scenarios.filter(s => !s.expectedSuccess).length;
  const benign = scenarios.filter(s => s.expectedSuccess).length;
  console.log(`\nDangerous (expectedSuccess: false): ${dangerous}`);
  console.log(`Benign (expectedSuccess: true): ${benign}`);

  // Show first 10 samples
  console.log('\nSample scenarios:');
  for (const s of scenarios.slice(0, 10)) {
    console.log(`  ${s.id}: [${s.expectedSuccess ? 'PASS' : 'FAIL'}] ${s.description.substring(0, 90)}`);
  }
}
