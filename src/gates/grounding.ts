/**
 * Grounding — Read Reality Before Verifying
 * ===========================================
 *
 * Scans the app's source files to extract real CSS selectors, HTML elements,
 * routes, and structure. This data is used to:
 *
 * 1. Validate predicates against reality (reject fabricated selectors)
 * 2. Provide context for guided recovery (nextMoves)
 * 3. Power deterministic predicate synthesis
 *
 * Ported from Sovereign's grounding.ts — filesystem reads only, no SSH.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import type { GroundingContext } from '../types.js';

/**
 * Scan the app directory and extract grounding context.
 */
export function groundInReality(appDir: string): GroundingContext {
  const routeCSSMap = new Map<string, Map<string, Record<string, string>>>();
  const htmlElements = new Map<string, Array<{ tag: string; text?: string; attributes?: Record<string, string> }>>();
  const routes: string[] = [];
  const routeClassTokens = new Map<string, Set<string>>();

  // Find source files
  const sourceFiles = findSourceFiles(appDir);

  for (const filePath of sourceFiles) {
    const content = readFileSync(filePath, 'utf-8');

    // Extract routes
    const fileRoutes = extractRoutes(content);
    routes.push(...fileRoutes);

    // Extract CSS per route
    const cssRules = extractCSS(content);
    if (cssRules.size > 0) {
      // Assign to routes found in this file, or to '/' as default
      const targetRoutes = fileRoutes.length > 0 ? fileRoutes : ['/'];
      for (const route of targetRoutes) {
        const existing = routeCSSMap.get(route) ?? new Map();
        for (const [selector, props] of cssRules) {
          const existingProps = existing.get(selector) ?? {};
          existing.set(selector, { ...existingProps, ...props });
        }
        routeCSSMap.set(route, existing);
      }
    }

    // Extract HTML elements
    const elements = extractHTMLElements(content);
    if (elements.length > 0) {
      const targetRoutes = fileRoutes.length > 0 ? fileRoutes : ['/'];
      for (const route of targetRoutes) {
        const existing = htmlElements.get(route) ?? [];
        existing.push(...elements);
        htmlElements.set(route, existing);
      }
    }

    // Extract class tokens per route
    for (const route of fileRoutes) {
      const tokens = extractClassTokens(content, route);
      if (tokens.size > 0) {
        const existing = routeClassTokens.get(route) ?? new Set();
        for (const t of tokens) existing.add(t);
        routeClassTokens.set(route, existing);
      }
    }
  }

  // Deduplicate routes
  const uniqueRoutes = [...new Set(routes)];

  return { routeCSSMap, htmlElements, routes: uniqueRoutes, routeClassTokens };
}

/**
 * Validate predicates against grounding context.
 * Returns predicates with groundingMiss flag set.
 */
export function validateAgainstGrounding<T extends { type: string; selector?: string }>(
  predicates: T[],
  grounding: GroundingContext,
): T[] {
  return predicates.map(p => {
    if (p.type === 'css' && p.selector) {
      // Check if selector exists in any route's CSS
      const found = [...grounding.routeCSSMap.values()].some(
        routeCSS => routeCSS.has(p.selector!)
      );
      if (!found) {
        return { ...p, groundingMiss: true };
      }
    }
    return p;
  });
}

// =============================================================================
// INTERNAL: File scanning and extraction
// =============================================================================

function findSourceFiles(dir: string, maxDepth = 3, depth = 0): string[] {
  if (depth > maxDepth) return [];

  const files: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.sovereign', '.verify', '.verify-tmp']);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findSourceFiles(fullPath, maxDepth, depth + 1));
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.vue', '.svelte', '.php', '.rb', '.py'].includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch { /* permission error or similar */ }

  return files;
}

function extractRoutes(content: string): string[] {
  const routes: string[] = [];

  // Express-style: app.get('/path', ...
  const expressPattern = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;
  while ((match = expressPattern.exec(content)) !== null) {
    routes.push(match[2]);
  }

  // Vanilla HTTP: url.pathname === '/path' or req.url === '/path'
  const vanillaPattern = /(?:url\.pathname|req\.url)\s*===?\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = vanillaPattern.exec(content)) !== null) {
    routes.push(match[1]);
  }

  // Next.js-style: page.tsx in app router
  // (route inferred from file path — handled at caller level)

  return routes;
}

function extractCSS(content: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();

  // Find all <style> blocks and CSS-in-JS template literals
  const styleBlockPattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const cssLiteralPattern = /`([^`]*\{[^`]*\}[^`]*)`/g;

  const cssBlocks: string[] = [];

  let match;
  while ((match = styleBlockPattern.exec(content)) !== null) {
    cssBlocks.push(match[1]);
  }
  while ((match = cssLiteralPattern.exec(content)) !== null) {
    if (match[1].includes('{') && match[1].includes(':')) {
      cssBlocks.push(match[1]);
    }
  }

  for (const block of cssBlocks) {
    // Parse CSS rules: selector { property: value; }
    const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
    while ((match = rulePattern.exec(block)) !== null) {
      const selector = match[1].trim();
      const body = match[2];

      // Skip @media, @keyframes, etc.
      if (selector.startsWith('@')) continue;

      const props: Record<string, string> = {};
      const propPattern = /([a-z-]+)\s*:\s*([^;]+)/gi;
      let propMatch;
      while ((propMatch = propPattern.exec(body)) !== null) {
        props[propMatch[1].trim()] = propMatch[2].trim();
      }

      // Merge with existing (later blocks override — CSS cascade)
      const existing = rules.get(selector) ?? {};
      rules.set(selector, { ...existing, ...props });
    }
  }

  return rules;
}

function extractHTMLElements(content: string): Array<{ tag: string; text?: string; attributes?: Record<string, string> }> {
  const elements: Array<{ tag: string; text?: string; attributes?: Record<string, string> }> = [];

  // Match HTML tags in template strings and HTML files
  const tagPattern = /<([\w-]+)([^>]*)>([^<]*)<\/\1>/g;
  let match;

  while ((match = tagPattern.exec(content)) !== null) {
    const tag = match[1];
    const attrString = match[2];
    const text = match[3].trim();

    // Skip common wrapper tags
    if (['div', 'span', 'section', 'main', 'head', 'body', 'html', 'script', 'style'].includes(tag)) continue;

    const attributes: Record<string, string> = {};
    const attrPattern = /([\w-]+)=["']([^"']+)["']/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrString)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }

    elements.push({
      tag,
      text: text || undefined,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });
  }

  return elements;
}

function extractClassTokens(content: string, route: string): Set<string> {
  const tokens = new Set<string>();

  // Find class attributes in HTML near the route handler
  const classPattern = /class=["']([^"']+)["']/g;
  let match;
  while ((match = classPattern.exec(content)) !== null) {
    for (const token of match[1].split(/\s+/)) {
      if (token.length > 0) tokens.add(token);
    }
  }

  return tokens;
}
