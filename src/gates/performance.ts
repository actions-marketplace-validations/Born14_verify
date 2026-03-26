/**
 * Performance Gate
 * ================
 *
 * Validates performance predicates by analyzing source files for
 * common performance patterns and anti-patterns.
 * Pure static analysis — no runtime measurement, no Docker.
 *
 * Predicate type: performance
 * Check types:
 *   - bundle_size: Total JS/CSS file sizes within threshold
 *   - image_optimization: Images use modern formats, have reasonable sizes
 *   - lazy_loading: Large assets/images use lazy loading
 *   - connection_count: Number of external resource references
 *   - response_time: (Advisory — requires runtime, deferred to HTTP gate)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import type { GateContext, GateResult, Predicate, PredicateResult } from '../types.js';

// =============================================================================
// PERFORMANCE ANALYZERS
// =============================================================================

type PerfCheckType = 'response_time' | 'bundle_size' | 'image_optimization' | 'lazy_loading' | 'connection_count'
  | 'unminified_assets' | 'render_blocking' | 'dom_depth' | 'cache_headers' | 'duplicate_deps';

/**
 * Measure total size of JS and CSS files in an app directory.
 */
function measureBundleSize(appDir: string): { totalBytes: number; files: Array<{ path: string; bytes: number }> } {
  const BUNDLE_EXTS = new Set(['.js', '.css', '.mjs', '.cjs']);
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);
  const files: Array<{ path: string; bytes: number }> = [];

  function scan(dir: string, rel: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (BUNDLE_EXTS.has(extname(entry.name).toLowerCase())) {
          try {
            const stats = statSync(fullPath);
            files.push({ path: rel ? `${rel}/${entry.name}` : entry.name, bytes: stats.size });
          } catch { /* unreadable */ }
        }
      }
    } catch { /* unreadable dir */ }
  }

  scan(appDir, '');
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return { totalBytes, files };
}

/**
 * Check images for optimization issues.
 */
function checkImageOptimization(appDir: string): Array<{ file: string; issue: string }> {
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff']);
  const MODERN_EXTS = new Set(['.webp', '.avif', '.svg']);
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);
  const issues: Array<{ file: string; issue: string }> = [];
  let hasOldFormat = false;
  let hasModernFormat = false;

  function scan(dir: string, rel: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            hasOldFormat = true;
            try {
              const stats = statSync(fullPath);
              if (stats.size > 500 * 1024) { // > 500KB
                issues.push({
                  file: rel ? `${rel}/${entry.name}` : entry.name,
                  issue: `Large image (${(stats.size / 1024).toFixed(0)}KB) — consider compression or modern format`,
                });
              }
            } catch { /* skip */ }
          }
          if (MODERN_EXTS.has(ext)) {
            hasModernFormat = true;
          }
        }
      }
    } catch { /* skip */ }
  }

  scan(appDir, '');

  if (hasOldFormat && !hasModernFormat) {
    issues.push({ file: '(project)', issue: 'No modern image formats (webp/avif/svg) found — consider converting' });
  }

  return issues;
}

/**
 * Check for lazy loading patterns.
 */
function checkLazyLoading(appDir: string): Array<{ file: string; issue: string }> {
  const issues: Array<{ file: string; issue: string }> = [];
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);

  function scan(dir: string, rel: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (['.html', '.htm', '.jsx', '.tsx', '.js'].includes(ext)) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              // Check for images without loading="lazy"
              const imgRegex = /<img\b[^>]*>/gi;
              let match;
              while ((match = imgRegex.exec(content)) !== null) {
                const tag = match[0];
                if (!tag.includes('loading=') && !tag.includes('loading =')) {
                  issues.push({
                    file: rel ? `${rel}/${entry.name}` : entry.name,
                    issue: 'Image without loading="lazy" attribute',
                  });
                }
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  scan(appDir, '');
  return issues;
}

/**
 * Count external resource references (scripts, stylesheets, fonts).
 */
function countConnections(appDir: string): { count: number; details: string[] } {
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);
  const externalRefs = new Set<string>();

  function scan(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (['.html', '.htm', '.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              // External script/link/fetch references
              const urlRegex = /(?:src|href|url)\s*=\s*['"]?(https?:\/\/[^'">\s]+)/gi;
              let match;
              while ((match = urlRegex.exec(content)) !== null) {
                try {
                  const host = new URL(match[1]).hostname;
                  externalRefs.add(host);
                } catch { /* invalid URL */ }
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  scan(appDir);
  return { count: externalRefs.size, details: [...externalRefs] };
}

/**
 * Check for unminified JS/CSS assets (files > 10KB without minification indicators).
 */
function checkUnminifiedAssets(appDir: string): Array<{ file: string; issue: string }> {
  const BUNDLE_EXTS = new Set(['.js', '.css', '.mjs', '.cjs']);
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);
  const issues: Array<{ file: string; issue: string }> = [];

  function scan(dir: string, rel: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (BUNDLE_EXTS.has(extname(entry.name).toLowerCase())) {
          // Skip already-minified files
          if (/\.min\.(js|css)$/i.test(entry.name)) continue;
          try {
            const stats = statSync(fullPath);
            if (stats.size > 10 * 1024) {
              const content = readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');
              const avgLineLen = content.length / Math.max(lines.length, 1);
              // Minified files typically have very long lines (avg > 200 chars)
              if (avgLineLen < 120) {
                issues.push({
                  file: rel ? `${rel}/${entry.name}` : entry.name,
                  issue: `Unminified asset (${(stats.size / 1024).toFixed(0)}KB, avg ${avgLineLen.toFixed(0)} chars/line)`,
                });
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  scan(appDir, '');
  return issues;
}

/**
 * Check for render-blocking resources in HTML files.
 */
function checkRenderBlocking(files: Array<{ relativePath: string; content: string }>): Array<{ file: string; issue: string }> {
  const issues: Array<{ file: string; issue: string }> = [];
  for (const file of files) {
    // Scripts in <head> without defer or async
    const headMatch = file.content.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    if (headMatch) {
      const headContent = headMatch[1];
      const scriptRegex = /<script\b[^>]*src\s*=[^>]*>/gi;
      let match;
      while ((match = scriptRegex.exec(headContent)) !== null) {
        const tag = match[0];
        if (!tag.includes('defer') && !tag.includes('async') && !tag.includes('type="module"')) {
          issues.push({ file: file.relativePath, issue: 'Render-blocking script in <head> without defer/async' });
        }
      }
    }
    // Stylesheets without media query
    const linkRegex = /<link\b[^>]*rel\s*=\s*['"]stylesheet['"][^>]*>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(file.content)) !== null) {
      const tag = linkMatch[0];
      if (tag.includes('href=') && /https?:\/\//.test(tag) && !tag.includes('media=')) {
        issues.push({ file: file.relativePath, issue: 'External stylesheet without media attribute may block rendering' });
      }
    }
  }
  return issues;
}

/**
 * Check for excessive DOM depth in HTML files.
 */
function checkDomDepth(files: Array<{ relativePath: string; content: string }>): Array<{ file: string; issue: string; depth: number }> {
  const issues: Array<{ file: string; issue: string; depth: number }> = [];
  const MAX_DEPTH = 15;

  for (const file of files) {
    // Simple depth estimation via tag nesting
    let depth = 0;
    let maxDepth = 0;
    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
    const VOID_ELEMENTS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    let match;
    while ((match = tagRegex.exec(file.content)) !== null) {
      const tag = match[0];
      const tagName = match[1].toLowerCase();
      if (VOID_ELEMENTS.has(tagName) || tag.endsWith('/>')) continue;
      if (tag.startsWith('</')) {
        depth = Math.max(0, depth - 1);
      } else {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
      }
    }
    if (maxDepth > MAX_DEPTH) {
      issues.push({ file: file.relativePath, issue: `DOM depth ${maxDepth} exceeds recommended max of ${MAX_DEPTH}`, depth: maxDepth });
    }
  }
  return issues;
}

/**
 * Check for missing cache headers configuration.
 */
function checkCacheHeaders(files: Array<{ relativePath: string; content: string }>): Array<{ file: string; issue: string }> {
  const issues: Array<{ file: string; issue: string }> = [];
  for (const file of files) {
    // Check server files for static asset serving without cache headers
    if (/\.(js|ts|mjs)$/i.test(file.relativePath)) {
      if (/express\.static|serve-static|sendFile|createReadStream/i.test(file.content)) {
        if (!/cache-control|maxAge|max-age|etag|last-modified/i.test(file.content)) {
          issues.push({ file: file.relativePath, issue: 'Static file serving without cache headers configuration' });
        }
      }
    }
  }
  return issues;
}

/**
 * Check for duplicate dependency imports.
 */
function checkDuplicateDeps(appDir: string): Array<{ dep: string; issue: string }> {
  const issues: Array<{ dep: string; issue: string }> = [];
  try {
    const pkgPath = join(appDir, 'package.json');
    if (!existsSync(pkgPath)) return issues;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    // Check for deps in both dependencies and devDependencies
    const overlap = deps.filter(d => devDeps.includes(d));
    for (const dep of overlap) {
      issues.push({ dep, issue: `"${dep}" appears in both dependencies and devDependencies` });
    }
    // Check for known duplicate-risk packages
    const DUPLICATE_GROUPS = [
      ['lodash', 'underscore'],
      ['moment', 'dayjs', 'date-fns'],
      ['axios', 'node-fetch', 'got', 'superagent'],
    ];
    const allDeps = new Set([...deps, ...devDeps]);
    for (const group of DUPLICATE_GROUPS) {
      const found = group.filter(d => allDeps.has(d));
      if (found.length > 1) {
        issues.push({ dep: found.join(', '), issue: `Duplicate utility libraries: ${found.join(', ')}` });
      }
    }
  } catch { /* skip */ }
  return issues;
}

// Helper: read HTML-like files for perf checks that need file content
function readHTMLFiles(appDir: string): Array<{ relativePath: string; content: string }> {
  const files: Array<{ relativePath: string; content: string }> = [];
  const HTML_EXTS = new Set(['.html', '.htm', '.ejs', '.hbs', '.jsx', '.tsx', '.js', '.ts']);
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);

  function scan(dir: string, rel: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (HTML_EXTS.has(extname(entry.name).toLowerCase())) {
          try {
            files.push({ relativePath: rel ? `${rel}/${entry.name}` : entry.name, content: readFileSync(fullPath, 'utf-8') });
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  scan(appDir, '');
  return files;
}

// =============================================================================
// PERFORMANCE GATE
// =============================================================================

export function runPerformanceGate(ctx: GateContext): GateResult & { predicateResults: PredicateResult[] } {
  const start = Date.now();
  const perfPreds = ctx.predicates.filter(p => p.type === 'performance');

  if (perfPreds.length === 0) {
    return {
      gate: 'performance' as any,
      passed: true,
      detail: 'No performance predicates to check',
      durationMs: Date.now() - start,
      predicateResults: [],
    };
  }

  const results: PredicateResult[] = [];
  let allPassed = true;
  const details: string[] = [];

  for (let i = 0; i < perfPreds.length; i++) {
    const p = perfPreds[i];
    const result = validatePerformancePredicate(p, ctx.stageDir ?? ctx.config.appDir);
    results.push({ ...result, predicateId: `perf_p${i}` });

    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? 'failed');
    }
  }

  const passCount = results.filter(r => r.passed).length;
  const detail = allPassed
    ? `All ${perfPreds.length} performance predicates passed`
    : `${passCount}/${perfPreds.length} passed: ${details.join('; ')}`;

  ctx.log(`[performance] ${detail}`);

  return {
    gate: 'performance' as any,
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results,
  };
}

function validatePerformancePredicate(
  p: Predicate,
  appDir: string,
): Omit<PredicateResult, 'predicateId'> {
  const check = p.perfCheck;
  const fingerprint = `type=performance|check=${check}|threshold=${p.threshold ?? 'default'}`;

  if (!check) {
    return { type: 'performance', passed: false, expected: 'perf check type', actual: '(no perfCheck specified)', fingerprint };
  }

  switch (check) {
    case 'bundle_size': {
      const threshold = p.threshold ?? 512 * 1024; // default 512KB
      const { totalBytes, files } = measureBundleSize(appDir);
      const passed = totalBytes <= threshold;
      return {
        type: 'performance',
        passed,
        expected: `bundle size ≤ ${formatBytes(threshold)}`,
        actual: `${formatBytes(totalBytes)} across ${files.length} files`,
        fingerprint,
      };
    }

    case 'image_optimization': {
      const issues = checkImageOptimization(appDir);
      const passed = issues.length === 0;
      return {
        type: 'performance',
        passed,
        expected: 'images optimized',
        actual: passed
          ? 'all images optimized'
          : `${issues.length} issue(s): ${issues.slice(0, 3).map(i => i.issue).join('; ')}`,
        fingerprint,
      };
    }

    case 'lazy_loading': {
      const issues = checkLazyLoading(appDir);
      const passed = issues.length === 0;
      return {
        type: 'performance',
        passed,
        expected: 'lazy loading on images',
        actual: passed
          ? 'all images have lazy loading'
          : `${issues.length} image(s) without lazy loading`,
        fingerprint,
      };
    }

    case 'connection_count': {
      const threshold = p.threshold ?? 10;
      const { count, details } = countConnections(appDir);
      const passed = count <= threshold;
      return {
        type: 'performance',
        passed,
        expected: `≤ ${threshold} external connections`,
        actual: `${count} external domain(s)${count > 0 ? `: ${details.slice(0, 5).join(', ')}` : ''}`,
        fingerprint,
      };
    }

    case 'response_time': {
      // Response time requires runtime measurement — advisory only
      return {
        type: 'performance',
        passed: true,
        expected: 'response time check (runtime — deferred)',
        actual: 'deferred to HTTP gate (requires running server)',
        fingerprint,
      };
    }

    case 'unminified_assets': {
      const issues = checkUnminifiedAssets(appDir);
      const passed = issues.length === 0;
      return {
        type: 'performance',
        passed,
        expected: 'assets minified',
        actual: passed
          ? 'all assets appear minified'
          : `${issues.length} unminified asset(s): ${issues.slice(0, 3).map(i => i.issue).join('; ')}`,
        fingerprint,
      };
    }

    case 'render_blocking': {
      const htmlFiles = readHTMLFiles(appDir);
      const issues = checkRenderBlocking(htmlFiles);
      const passed = issues.length === 0;
      return {
        type: 'performance',
        passed,
        expected: 'no render-blocking resources',
        actual: passed
          ? 'no render-blocking resources detected'
          : `${issues.length} render-blocking issue(s): ${issues.slice(0, 3).map(i => i.issue).join('; ')}`,
        fingerprint,
      };
    }

    case 'dom_depth': {
      const htmlFiles = readHTMLFiles(appDir);
      const depthIssues = checkDomDepth(htmlFiles);
      const passed = depthIssues.length === 0;
      return {
        type: 'performance',
        passed,
        expected: 'DOM depth ≤ 15',
        actual: passed
          ? 'DOM depth within limits'
          : `${depthIssues.length} file(s) with excessive DOM depth: ${depthIssues.slice(0, 3).map(i => `${i.file} (depth ${i.depth})`).join('; ')}`,
        fingerprint,
      };
    }

    case 'cache_headers': {
      const htmlFiles = readHTMLFiles(appDir);
      const issues = checkCacheHeaders(htmlFiles);
      const passed = issues.length === 0;
      return {
        type: 'performance',
        passed,
        expected: 'cache headers configured for static assets',
        actual: passed
          ? 'cache headers configured'
          : `${issues.length} issue(s): ${issues.slice(0, 3).map(i => i.issue).join('; ')}`,
        fingerprint,
      };
    }

    case 'duplicate_deps': {
      const issues = checkDuplicateDeps(appDir);
      const passed = issues.length === 0;
      return {
        type: 'performance',
        passed,
        expected: 'no duplicate dependencies',
        actual: passed
          ? 'no duplicate dependencies found'
          : `${issues.length} issue(s): ${issues.slice(0, 3).map(i => i.issue).join('; ')}`,
        fingerprint,
      };
    }

    default:
      return { type: 'performance', passed: false, expected: 'valid perf check', actual: `unknown check: ${check}`, fingerprint };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
