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

// =============================================================================
// GROUNDING CACHE — mtime-based invalidation per appDir
// =============================================================================

interface GroundingCacheEntry {
  context: GroundingContext;
  maxMtimeMs: number;  // max mtime across source files at scan time
  cachedAt: number;    // wall-clock time of cache population
}

const _groundingCache = new Map<string, GroundingCacheEntry>();

// TTL for cache validation bypass — avoid stat storms on CI (5 seconds)
const CACHE_TTL_MS = 5_000;

/** Get the max mtime across source files (fast — stat only, no reads). */
function getMaxMtime(appDir: string): number {
  const files = findSourceFiles(appDir);
  let max = 0;
  for (const f of files) {
    try {
      const s = statSync(f);
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch { /* skip */ }
  }
  return max;
}

/** Clear the grounding cache (useful after edits are applied). */
export function clearGroundingCache(appDir?: string): void {
  if (appDir) _groundingCache.delete(appDir);
  else _groundingCache.clear();
}

/**
 * Scan the app directory and extract grounding context.
 * Results are cached per appDir with TTL + mtime-based invalidation.
 * TTL prevents stat storms when the same appDir is verified thousands of times
 * (e.g., CI self-test running 2600+ scenarios against the same demo app).
 */
export function groundInReality(appDir: string): GroundingContext {
  // Check cache — use TTL to avoid stat storms on CI
  const cached = _groundingCache.get(appDir);
  if (cached) {
    // Within TTL: return cached without filesystem check
    if (Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.context;
    // Beyond TTL: verify via mtime
    const currentMtime = getMaxMtime(appDir);
    if (currentMtime <= cached.maxMtimeMs) {
      cached.cachedAt = Date.now(); // Refresh TTL
      return cached.context;
    }
  }
  const routeCSSMap = new Map<string, Map<string, Record<string, string>>>();
  const htmlElements = new Map<string, Array<{ tag: string; text?: string; attributes?: Record<string, string> }>>();
  const routes: string[] = [];
  const routeClassTokens = new Map<string, Set<string>>();

  // Find source files
  const sourceFiles = findSourceFiles(appDir);

  for (const filePath of sourceFiles) {
    const content = readFileSync(filePath, 'utf-8');

    // SI-001 defense in depth: skip oversized files. Files >100KB are
    // almost always generated/minified bundles, icon sprites, vendor CSS,
    // or framework dumps — they don't contain semantic selectors agents
    // typically edit, and they're the most likely to trigger pathological
    // regex scans even after individual extractor short-circuits.
    if (content.length > 100_000) {
      console.warn(`[grounding] Skipping oversized file (${Math.round(content.length / 1024)}KB > 100KB): ${filePath}`);
      continue;
    }

    // Extract routes
    const fileRoutes = extractRoutes(content);
    routes.push(...fileRoutes);

    // Try route-scoped extraction first (each route handler's own CSS/HTML)
    const routeBlocks = extractRouteBlocks(content);

    if (routeBlocks.size > 0) {
      // Route-scoped: extract CSS and HTML from each handler independently
      for (const [route, block] of routeBlocks) {
        const cssRules = extractCSS(block);
        if (cssRules.size > 0) {
          const existing = routeCSSMap.get(route) ?? new Map();
          for (const [selector, props] of cssRules) {
            const existingProps = existing.get(selector) ?? {};
            existing.set(selector, { ...existingProps, ...props });
          }
          routeCSSMap.set(route, existing);
        }

        const elements = extractHTMLElements(block);
        if (elements.length > 0) {
          const existing = htmlElements.get(route) ?? [];
          existing.push(...elements);
          htmlElements.set(route, existing);
        }

        const tokens = extractClassTokens(block, route);
        if (tokens.size > 0) {
          const existing = routeClassTokens.get(route) ?? new Set();
          for (const t of tokens) existing.add(t);
          routeClassTokens.set(route, existing);
        }
      }
    } else {
      // Fallback: no route blocks found — assign all CSS/HTML to all routes (or '/')
      const cssRules = extractCSS(content);
      if (cssRules.size > 0) {
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

      const elements = extractHTMLElements(content);
      if (elements.length > 0) {
        const targetRoutes = fileRoutes.length > 0 ? fileRoutes : ['/'];
        for (const route of targetRoutes) {
          const existing = htmlElements.get(route) ?? [];
          existing.push(...elements);
          htmlElements.set(route, existing);
        }
      }

      for (const route of fileRoutes) {
        const tokens = extractClassTokens(content, route);
        if (tokens.size > 0) {
          const existing = routeClassTokens.get(route) ?? new Set();
          for (const t of tokens) existing.add(t);
          routeClassTokens.set(route, existing);
        }
      }
    }
  }

  // Deduplicate routes
  const uniqueRoutes = [...new Set(routes)];

  // Parse DB schema from init.sql (if present)
  const dbSchema = findAndParseSchema(appDir);

  // Parse infrastructure state (terraform.tfstate etc.) if present
  let infraState: import('../types.js').InfraStateContext | undefined;
  try {
    const { findInfraDir, findAndParseState } = require('./infrastructure.js');
    const infraDir = findInfraDir(appDir);
    if (infraDir) infraState = findAndParseState(infraDir);
  } catch { /* infrastructure gate not available — optional */ }

  const context: GroundingContext = {
    routeCSSMap, htmlElements, routes: uniqueRoutes, routeClassTokens,
    ...(dbSchema ? { dbSchema } : {}),
    ...(infraState ? { infraState } : {}),
  };

  // Cache with current max mtime
  _groundingCache.set(appDir, { context, maxMtimeMs: getMaxMtime(appDir), cachedAt: Date.now() });

  return context;
}

/**
 * Validate predicates against grounding context.
 * Returns predicates with groundingMiss flag set.
 *
 * Checks:
 * 1. CSS selector existence — reject fabricated selectors
 * 2. CSS property existence — reject fabricated properties on known selectors
 * 3. HTML text content — reject predicates claiming wrong text
 * 4. Content patterns — reject patterns that don't exist in the file
 * 5. HTTP predicates without Docker — flag as unverifiable
 */
export function validateAgainstGrounding<T extends {
  type: string;
  selector?: string;
  property?: string;
  expected?: string;
  path?: string;
  file?: string;
  pattern?: string;
  method?: string;
  expect?: { bodyContains?: string | string[] };
  hash?: string;
  count?: number;
}>(
  predicates: T[],
  grounding: GroundingContext,
  opts?: { appDir?: string; dockerAvailable?: boolean; edits?: Array<{ file: string; search: string; replace: string }>; appUrl?: string },
): T[] {
  return predicates.map(p => {
    // ── CSS predicates: check selector, property, value, and route scope ──
    if (p.type === 'css' && p.selector) {
      // Determine which route CSS maps to check
      const targetCSS: Map<string, Record<string, string>>[] = [];
      if (p.path) {
        // Path-scoped: only check the specified route
        const routeCSS = grounding.routeCSSMap.get(p.path);
        if (routeCSS) targetCSS.push(routeCSS);
      } else {
        // No path: check all routes
        targetCSS.push(...grounding.routeCSSMap.values());
      }

      // Check selector exists (in scoped routes)
      const found = targetCSS.some(routeCSS => routeCSS.has(p.selector!));
      if (!found) {
        // Before rejecting, check if an edit introduces this selector
        const editCreatesSelector = opts?.edits?.some(e =>
          e.replace.includes(p.selector!) && !e.search.includes(p.selector!)
        );
        if (!editCreatesSelector) {
          const scopeMsg = p.path ? ` on route "${p.path}"` : ' in app source';
          return { ...p, groundingMiss: true, groundingReason: `CSS selector "${p.selector}" not found${scopeMsg}` };
        }
        // Edit creates this selector — skip remaining grounding checks (trust the edit)
        return p;
      }

      // If selector exists, check that the claimed property exists on it
      // (only for non-"exists" predicates — if expected === 'exists', presence is enough)
      if (p.property && p.expected && p.expected !== 'exists') {
        let propertyFound = false;
        let _shVal: string|undefined;
        for (const routeCSS of targetCSS) {
          const sp = routeCSS.get(p.selector!);
          if (sp) {
            if (p.property! in sp) { propertyFound = true; break; }
            for (const [sh, lhs] of Object.entries(_SH)) {
              if (lhs.includes(p.property!) && sh in sp) { propertyFound = true; _shVal = _rS(sh, sp[sh], p.property!); break; }
            }
            if (propertyFound) break;
          }
        }
        if (!propertyFound) {
          // Before rejecting, check if an edit would ADD this property to the selector.
          // Three patterns to detect:
          //   1. Direct: edit replace contains the exact property name (e.g., "transition: ...")
          //   2. Shorthand: edit adds a shorthand that expands to this property (e.g., "flex:" → "flex-grow")
          //   3. Vendor prefix: edit adds -webkit-X and predicate checks X (or vice versa)
          const editAddsProperty = opts?.edits?.some(e => {
            const prop = p.property!;
            const rep = e.replace;
            const srch = e.search;

            // Direct match: replace contains the property, search doesn't
            const directMatch = rep.includes(prop) && !srch.includes(prop);

            // Shorthand match: replace contains a shorthand that maps to this longhand
            let shorthandMatch = false;
            for (const [sh, longhands] of Object.entries(_SH)) {
              if (longhands.includes(prop) && rep.includes(sh) && !srch.includes(sh)) {
                shorthandMatch = true;
                break;
              }
            }
            // Also check complex shorthands (edit detection only, not value resolution)
            if (!shorthandMatch) {
              for (const [sh, longhands] of Object.entries(_SH_EDIT_ONLY)) {
                if (longhands.includes(prop) && rep.includes(sh) && !srch.includes(sh)) {
                  shorthandMatch = true;
                  break;
                }
              }
            }

            // Vendor prefix match: edit has -webkit-X for property X, or edit has X for -webkit-X
            let vendorMatch = false;
            const stripped = _stripVendor(prop);
            if (stripped && rep.includes(stripped) && !srch.includes(stripped)) {
              vendorMatch = true;  // predicate checks -webkit-X, edit has X
            }
            // Or: edit has -webkit-X, predicate checks X
            if (!vendorMatch) {
              for (const prefix of ['-webkit-', '-moz-', '-ms-', '-o-']) {
                const vendored = prefix + prop;
                if (rep.includes(vendored) && !srch.includes(vendored)) {
                  vendorMatch = true;
                  break;
                }
              }
            }

            if (!directMatch && !shorthandMatch && !vendorMatch) return false;

            // Verify the edit is plausibly within this selector's block:
            // The search string should contain content from the selector's existing properties
            // OR the search string contains the selector name itself
            const selectorProps = targetCSS.flatMap(rc => {
              const props = rc.get(p.selector!);
              return props ? Object.keys(props) : [];
            });
            return selectorProps.some(prp => e.search.includes(prp)) || e.search.includes(p.selector!);
          });
          if (!editAddsProperty) {
            return { ...p, groundingMiss: true, groundingReason: `CSS property "${p.property}" not found on selector "${p.selector}"` };
          }
          // Edit adds this property — trust the edit
        }

        const editWouldChange = opts?.edits?.some(e => {
          const rep = e.replace;
          // Direct property match (e.g., replace has 'color: red' and predicate expects 'red')
          if (rep.includes(p.property!) && rep.includes(p.expected!)) return true;
          // Named color equivalence: edit uses 'navy', predicate expects '#000080'
          if (rep.includes(p.property!)) {
            // Extract the value after the property in the replace string
            const propIdx = rep.indexOf(p.property!);
            const afterProp = rep.slice(propIdx + p.property!.length);
            const valMatch = afterProp.match(/\s*:\s*([^;}\n]+)/);
            if (valMatch) {
              const editVal = valMatch[1].trim();
              if (_nC(editVal, p.property) === _nC(p.expected!, p.property)) return true;
            }
          }
          // Shorthand edit implies longhand change: edit has 'border: 3px solid',
          // predicate expects 'border-width: 3px'
          for (const [sh, lhs] of Object.entries(_SH)) {
            if (lhs.includes(p.property!) && rep.includes(sh + ':') || rep.includes(sh + ' :')) {
              const shIdx = rep.indexOf(sh);
              const afterSh = rep.slice(shIdx + sh.length);
              const shValMatch = afterSh.match(/\s*:\s*([^;}\n]+)/);
              if (shValMatch) {
                const resolved = _rS(sh, shValMatch[1].trim(), p.property!);
                if (resolved && _nC(resolved, p.property) === _nC(p.expected!, p.property)) return true;
              }
            }
          }
          return false;
        });
        if (!editWouldChange) {
          if (_shVal !== undefined) {
            if (_nC(_shVal, p.property) !== _nC(p.expected!, p.property)) {
              return { ...p, groundingMiss: true, groundingReason: `CSS "${p.selector}" "${p.property}" resolves to "${_shVal}" from shorthand but predicate claims "${p.expected}"` };
            }
          } else {
            for (const routeCSS of targetCSS) {
              const sp = routeCSS.get(p.selector!);
              if (sp && p.property! in sp) {
                if (_nC(sp[p.property!], p.property) !== _nC(p.expected!, p.property)) {
                  return { ...p, groundingMiss: true, groundingReason: `CSS "${p.selector}" "${p.property}" is "${sp[p.property!]}" in source but predicate claims "${p.expected}"` };
                }
              }
            }
          }
        }
      }

      // Cross-route ambiguity: if no path and selector+property has different values
      // across routes, reject — predicate is ambiguous without path scoping
      if (!p.path && p.property) {
        const routeValues: string[] = [];
        for (const routeCSS of targetCSS) {
          const selectorProps = routeCSS.get(p.selector!);
          if (selectorProps && p.property! in selectorProps) {
            routeValues.push(selectorProps[p.property!]);
          }
        }
        const uniqueValues = new Set(routeValues);
        if (uniqueValues.size > 1) {
          return { ...p, groundingMiss: true, groundingReason: `CSS "${p.selector}" "${p.property}" has conflicting values across routes (${[...uniqueValues].join(' vs ')}). Add a path to scope the predicate.` };
        }
      }
    }

    // ── HTML predicates: check element existence (exists predicates) ──
    // When expected === 'exists', verify the tag name appears in grounding.
    // CSS-style selectors (a[href], .class, #id, :pseudo) must match by tag only.
    if (p.type === 'html' && p.selector && p.expected === 'exists') {
      // Extract bare tag from CSS-style selectors (e.g., "a[href='/']" → "a", "td:first-child" → "td")
      const bareTag = p.selector.replace(/[.#\[:].*/s, '').trim().toLowerCase();
      const targetRoutes = p.path ? [p.path] : [...grounding.htmlElements.keys()];
      let found = false;

      for (const route of targetRoutes) {
        const elements = grounding.htmlElements.get(route) ?? [];
        if (elements.some(el => el.tag === bareTag)) {
          found = true;
          break;
        }
      }

      if (!found) {
        // Check other routes for wrong-route diagnosis
        if (p.path) {
          const otherRoutes = [...grounding.htmlElements.keys()].filter(r => r !== p.path);
          for (const route of otherRoutes) {
            const elements = grounding.htmlElements.get(route) ?? [];
            if (elements.some(el => el.tag === bareTag)) {
              return { ...p, groundingMiss: true, groundingReason: `HTML element "${bareTag}" exists on route "${route}" but not on claimed route "${p.path}"` };
            }
          }
        }
        // Check if edits create it
        if (opts?.edits) {
          const tagPat = new RegExp(`<${bareTag}[\\s>/]`, 'i');
          if (!opts.edits.some(edit => tagPat.test(edit.replace))) {
            return { ...p, groundingMiss: true, groundingReason: `HTML element "${bareTag}" not found in app source and no edit creates it` };
          }
        } else {
          return { ...p, groundingMiss: true, groundingReason: `HTML element "${bareTag}" not found in app source` };
        }
      }
    }

    // ── HTML predicates: check element existence AND text content match ──
    if (p.type === 'html' && p.selector && p.expected && p.expected !== 'exists') {
      // Find matching elements across routes
      const targetRoutes = p.path ? [p.path] : [...grounding.htmlElements.keys()];
      let elementFound = false;
      let textMatches = false;

      for (const route of targetRoutes) {
        const elements = grounding.htmlElements.get(route) ?? [];
        for (const el of elements) {
          // Match by tag name (e.g., "h1", "h2", "p")
          if (el.tag === p.selector) {
            elementFound = true;
            if (el.text && el.text.includes(p.expected)) {
              textMatches = true;
              break;
            }
          }
        }
        if (textMatches) break;
      }

      if (elementFound && !textMatches) {
        // Check if an edit changes the element's text to match the expected value
        if (opts?.edits) {
          const tagPattern = new RegExp(`<${p.selector}[^>]*>[^<]*</${p.selector}>`, 'gi');
          let editFixesText = false;
          for (const edit of opts.edits) {
            const match = tagPattern.exec(edit.replace);
            if (match && match[0].includes(p.expected)) {
              editFixesText = true;
              break;
            }
            tagPattern.lastIndex = 0; // reset for next edit
          }
          if (!editFixesText) {
            return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" exists but does not contain text "${p.expected}" and no edit changes it to match` };
          }
        } else {
          return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" exists but does not contain text "${p.expected}"` };
        }
      }
      if (!elementFound) {
        // Path-scoped: check if element exists on OTHER routes (wrong-route error)
        if (p.path) {
          const otherRoutes = [...grounding.htmlElements.keys()].filter(r => r !== p.path);
          for (const route of otherRoutes) {
            const elements = grounding.htmlElements.get(route) ?? [];
            if (elements.some(el => el.tag === p.selector)) {
              return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" exists on route "${route}" but not on claimed route "${p.path}"` };
            }
          }
        }
        // Element not found in source — check if edits would create it
        if (opts?.edits && p.expected) {
          const tagPattern = new RegExp(`<${p.selector}[^>]*>([^<]*)</${p.selector}>`, 'i');
          let editCreates = false;
          for (const edit of opts.edits) {
            const match = tagPattern.exec(edit.replace);
            if (match) {
              editCreates = true;
              const editText = match[1].trim();
              if (editText && !editText.includes(p.expected)) {
                return { ...p, groundingMiss: true, groundingReason: `Edit creates <${p.selector}> with text "${editText}" but predicate expects "${p.expected}"` };
              }
            }
          }
          if (!editCreates) {
            return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" not found in app source and no edit creates it` };
          }
        } else if (!opts?.edits) {
          return { ...p, groundingMiss: true, groundingReason: `HTML element "${p.selector}" not found in app source` };
        }
      }
    }

    // ── Content predicates: check pattern against actual file contents ──
    // Two checks:
    //   1. Pre-edit: pattern must exist in source OR an edit creates it
    //   2. Post-edit: if pattern exists pre-edit but an edit removes it, that's
    //      a goal contradiction (Shape 648: edit destroys what predicate asserts)
    if (p.type === 'content' && p.file && p.pattern && opts?.appDir) {
      try {
        const filePath = join(opts.appDir, p.file);
        if (existsSync(filePath)) {
          // Normalize line endings for cross-platform matching (CRLF → LF)
          const content = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
          const normalizedPattern = p.pattern.replace(/\r\n/g, '\n');
          if (!content.includes(normalizedPattern)) {
            // Check if any edit's replace string would introduce this pattern
            const editsWouldCreate = opts.edits?.some(
              e => e.file === p.file && e.replace.replace(/\r\n/g, '\n').includes(normalizedPattern)
            );
            if (!editsWouldCreate) {
              return { ...p, groundingMiss: true, groundingReason: `Pattern "${p.pattern}" not found in file "${p.file}" and no edit would create it` };
            }
          } else {
            // Pattern EXISTS pre-edit. Check if an edit on this file REMOVES it.
            // Simulate post-edit content by applying edits to the file content.
            const fileEdits = opts.edits?.filter(e => e.file === p.file) ?? [];
            if (fileEdits.length > 0) {
              let postEdit = content;
              for (const e of fileEdits) {
                const normalizedSearch = e.search.replace(/\r\n/g, '\n');
                if (postEdit.includes(normalizedSearch)) {
                  postEdit = postEdit.replace(normalizedSearch, e.replace.replace(/\r\n/g, '\n'));
                }
              }
              if (!postEdit.includes(normalizedPattern)) {
                return { ...p, groundingMiss: true, groundingReason: `Edit removes "${p.pattern}" from "${p.file}" — post-edit content no longer matches predicate` };
              }
            }
          }
        } else {
          // File doesn't exist — reject unless an edit targets this file
          const editCreatesFile = opts.edits?.some(e => e.file === p.file);
          if (!editCreatesFile) {
            return { ...p, groundingMiss: true, groundingReason: `File "${p.file}" does not exist in app directory` };
          }
          // File will be created by edit — check if post-edit content contains the pattern
          const normalizedPattern = p.pattern.replace(/\r\n/g, '\n');
          const fileEdits = opts.edits?.filter(e => e.file === p.file) ?? [];
          const postEditContent = fileEdits.map(e => e.replace.replace(/\r\n/g, '\n')).join('\n');
          if (postEditContent && !postEditContent.includes(normalizedPattern)) {
            return { ...p, groundingMiss: true, groundingReason: `New file "${p.file}" will not contain pattern "${p.pattern}" after edit` };
          }
        }
      } catch { /* read error — don't reject */ }
    }

    // ── Filesystem predicates: validate path existence and hash ──
    if (p.type === 'filesystem_exists' || p.type === 'filesystem_absent' ||
        p.type === 'filesystem_unchanged' || p.type === 'filesystem_count') {
      const filePath = p.file ?? p.path;
      if (!filePath) {
        return { ...p, groundingMiss: true, groundingReason: `Filesystem predicate missing file/path field` };
      }
      if (opts?.appDir) {
        const fullPath = join(opts.appDir, filePath);
        if (p.type === 'filesystem_exists') {
          // For exists: the path should exist at grounding time OR an edit creates it
          // No grounding rejection — existence is checked post-edit by the filesystem gate
        }
        if (p.type === 'filesystem_absent') {
          // For absent: the path should exist NOW (before edit removes it)
          // If it doesn't exist already, the predicate is trivially true but suspicious
          if (!existsSync(fullPath)) {
            return { ...p, groundingMiss: true, groundingReason: `Path "${filePath}" already absent — predicate is trivially true` };
          }
        }
        if (p.type === 'filesystem_unchanged') {
          if (!p.hash) {
            return { ...p, groundingMiss: true, groundingReason: `filesystem_unchanged requires a hash field captured at grounding time` };
          }
          if (!existsSync(fullPath)) {
            return { ...p, groundingMiss: true, groundingReason: `Path "${filePath}" does not exist — cannot verify unchanged` };
          }
        }
        if (p.type === 'filesystem_count') {
          if (p.count == null) {
            return { ...p, groundingMiss: true, groundingReason: `filesystem_count requires a count field` };
          }
        }
      }
    }

    // ── HTTP predicates: validate claimed body content against source ──
    // Skip when appUrl is provided — the HTTP gate will validate against the real server
    if (p.type === 'http' && opts?.appDir && !opts?.appUrl) {
      // Extract claimed body content from either expect.bodyContains or expected
      const claimedContent: string[] = [];
      if (p.expect?.bodyContains) {
        if (Array.isArray(p.expect.bodyContains)) {
          claimedContent.push(...p.expect.bodyContains);
        } else {
          claimedContent.push(p.expect.bodyContains);
        }
      }
      if (p.expected && p.expected !== 'exists') {
        claimedContent.push(p.expected);
      }

      // If there's claimed body content, check if it appears in any source file
      if (claimedContent.length > 0) {
        const sourceFiles = findSourceFiles(opts.appDir);
        const allSource = sourceFiles.map(f => {
          try { return readFileSync(f, 'utf-8'); } catch { return ''; }
        }).join('\n');

        for (const claim of claimedContent) {
          if (!allSource.includes(claim)) {
            // Check if any edit introduces this content (same pattern as HTML text exemption)
            let editAddsContent = false;
            if (opts?.edits) {
              for (const edit of opts.edits) {
                if (edit.replace && edit.replace.includes(claim)) {
                  editAddsContent = true;
                  break;
                }
              }
            }
            if (!editAddsContent) {
              return { ...p, groundingMiss: true, groundingReason: `HTTP body content "${claim}" not found in any app source file` };
            }
          }
        }
      }
    }

    // ── DB predicates: validate table/column/type against parsed init.sql schema ──
    if (p.type === 'db' && grounding.dbSchema && grounding.dbSchema.length > 0) {
      const assertion = (p as any).assertion as string | undefined;
      const tableName = (p as any).table as string | undefined;
      const columnName = (p as any).column as string | undefined;

      if (tableName && assertion) {
        // Find table (case-insensitive)
        const tableEntry = grounding.dbSchema.find(
          t => t.table.toLowerCase() === tableName.toLowerCase()
        );

        // Helper: check if any edit introduces a SQL identifier (table or column name)
        const editIntroduces = (name: string): boolean => {
          if (!opts?.edits) return false;
          const lower = name.toLowerCase();
          return opts.edits.some(e =>
            e.replace && e.replace.toLowerCase().includes(lower) &&
            (!e.search || !e.search.toLowerCase().includes(lower))
          );
        };

        if (assertion === 'table_exists') {
          if (!tableEntry) {
            // Check if an edit (migration) introduces this table
            if (!editIntroduces(`CREATE TABLE ${tableName}`) && !editIntroduces(`create table ${tableName}`)) {
              return { ...p, groundingMiss: true, groundingReason: `Table "${tableName}" not found in init.sql schema` };
            }
          }
        }

        if (assertion === 'column_exists' && columnName) {
          if (!tableEntry) {
            if (!editIntroduces(`CREATE TABLE ${tableName}`) && !editIntroduces(`create table ${tableName}`)) {
              return { ...p, groundingMiss: true, groundingReason: `Table "${tableName}" not found in init.sql schema (checking column "${columnName}")` };
            }
          } else {
            const colEntry = tableEntry.columns.find(
              c => c.name.toLowerCase() === columnName.toLowerCase()
            );
            if (!colEntry) {
              // Check if edit adds this column (ALTER TABLE ADD COLUMN or within a CREATE TABLE)
              if (!editIntroduces(columnName)) {
                return { ...p, groundingMiss: true, groundingReason: `Column "${columnName}" not found in table "${tableName}"` };
              }
            }
          }
        }

        if (assertion === 'column_type' && columnName && p.expected) {
          if (!tableEntry) {
            if (!editIntroduces(`CREATE TABLE ${tableName}`) && !editIntroduces(`create table ${tableName}`)) {
              return { ...p, groundingMiss: true, groundingReason: `Table "${tableName}" not found in init.sql schema (checking column type)` };
            }
          } else {
            const colEntry = tableEntry.columns.find(
              c => c.name.toLowerCase() === columnName.toLowerCase()
            );
            if (!colEntry) {
              if (!editIntroduces(columnName)) {
                return { ...p, groundingMiss: true, groundingReason: `Column "${columnName}" not found in table "${tableName}" (checking type)` };
              }
              // Edit introduces the column — trust it for type too
            } else {
              // Compare types with alias normalization
              const actualNorm = normalizeDBType(colEntry.type);
              const expectedNorm = normalizeDBType(p.expected);
              if (actualNorm !== expectedNorm) {
                // Check if edit changes the column type
                if (!editIntroduces(p.expected)) {
                  return { ...p, groundingMiss: true, groundingReason: `Column "${tableName}.${columnName}" type is "${colEntry.type}" (normalized: "${actualNorm}") but predicate claims "${p.expected}" (normalized: "${expectedNorm}")` };
                }
              }
            }
          }
        }
      }
    }

    // ── Infrastructure predicates: validate resource/attribute against state file ──
    if (p.type === 'infra_resource' && grounding.infraState && grounding.infraState.resources.length > 0) {
      const resourceAddr = (p as any).resource as string | undefined;
      if (resourceAddr) {
        const found = grounding.infraState.resources.some(r => r.address === resourceAddr);
        const assertion = (p as any).assertion ?? 'exists';
        if (assertion === 'exists' && !found) {
          return { ...p, groundingMiss: true, groundingReason: `Resource "${resourceAddr}" not found in infrastructure state file` };
        }
        // For 'absent' assertion, resource existing is expected (we're checking it should be absent after changes)
      }
    }

    if (p.type === 'infra_attribute' && grounding.infraState && grounding.infraState.resources.length > 0) {
      const resourceAddr = (p as any).resource as string | undefined;
      const attribute = (p as any).attribute as string | undefined;
      if (resourceAddr) {
        const found = grounding.infraState.resources.some(r => r.address === resourceAddr);
        if (!found) {
          return { ...p, groundingMiss: true, groundingReason: `Resource "${resourceAddr}" not found in infrastructure state file (checking attribute "${attribute}")` };
        }
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
        if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.vue', '.svelte', '.php', '.rb', '.py', '.sql'].includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch { /* permission error or similar */ }

  return files;
}

/**
 * Extract route handler blocks — the source text belonging to each route.
 * Returns a map of route → handler source text.
 *
 * Supports:
 * - Vanilla HTTP: if (url.pathname === '/path') { ... return; }
 * - Express: app.get('/path', (req, res) => { ... });
 */
function extractRouteBlocks(content: string): Map<string, string> {
  const blocks = new Map<string, string>();

  // Strategy: find each route check, then extract from that point to the
  // next route check (or end of file). This captures the full handler body
  // including its template string with <style> blocks.

  // Vanilla HTTP: url.pathname === '/path' or req.url === '/path'
  const vanillaPattern = /(?:url\.pathname|req\.url)\s*===?\s*['"`]([^'"`]+)['"`]/g;
  // Express: app.get('/path', ...
  const expressPattern = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;

  // Collect all route start positions
  const routeStarts: Array<{ route: string; index: number }> = [];

  let match;
  while ((match = vanillaPattern.exec(content)) !== null) {
    routeStarts.push({ route: match[1], index: match.index });
  }
  while ((match = expressPattern.exec(content)) !== null) {
    routeStarts.push({ route: match[2], index: match.index });
  }

  // Sort by position in file
  routeStarts.sort((a, b) => a.index - b.index);

  // Extract blocks: from each route start to the next route start
  for (let i = 0; i < routeStarts.length; i++) {
    const start = routeStarts[i].index;
    const end = i + 1 < routeStarts.length ? routeStarts[i + 1].index : content.length;
    const block = content.slice(start, end);

    // Only include blocks that have HTML content (skip API-only routes)
    if (block.includes('<style') || block.includes('<html') || block.includes('text/html')) {
      blocks.set(routeStarts[i].route, block);
    }
  }

  return blocks;
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
  // SI-001 short-circuit: cssLiteralPattern uses three sequential greedy
  // negated quantifiers (`[^`]*\{[^`]*\}[^`]*`) which exhibit O(n²) scan
  // time on backtick-free content. Skip the regex entirely if there are
  // no backticks — the pattern can't possibly match.
  if (content.includes('`')) {
    while ((match = cssLiteralPattern.exec(content)) !== null) {
      if (match[1].includes('{') && match[1].includes(':')) {
        cssBlocks.push(match[1]);
      }
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

const _NC: Record<string,string> = {black:'#000000',white:'#ffffff',red:'#ff0000',green:'#008000',blue:'#0000ff',navy:'#000080',orange:'#ffa500',yellow:'#ffff00',purple:'#800080',gray:'#808080',grey:'#808080',silver:'#c0c0c0',maroon:'#800000',teal:'#008080',cyan:'#00ffff',coral:'#ff7f50',tomato:'#ff6347',gold:'#ffd700',indigo:'#4b0082',crimson:'#dc143c',salmon:'#fa8072',lime:'#00ff00',aqua:'#00ffff',pink:'#ffc0cb',olive:'#808000',fuchsia:'#ff00ff',violet:'#ee82ee'};

function _nC(v: string, property?: string): string {
  const l = v.trim().toLowerCase();
  // Font-weight equivalence: normal ↔ 400, bold ↔ 700
  if (property === 'font-weight' || !property) {
    if (l === 'normal' || l === '400') return '400';
    if (l === 'bold' || l === '700') return '700';
  }
  // Named color → hex
  if (_NC[l]) return _NC[l];
  // Zero unit equivalence: 0px, 0em, 0rem, 0%, 0pt, 0vh, 0vw → "0"
  if (/^0(?:px|em|rem|%|pt|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pc)$/.test(l)) return '0';
  // Normalize internal whitespace in functional notation: rgb( 255, 0, 0 ) → rgb(255,0,0)
  if (/^(?:rgb|hsl)a?\s*\(/.test(l)) {
    const norm = l.replace(/\s+/g, '').replace(/,\s*/g, ',');
    // rgba(r,g,b,1) → rgb(r,g,b) (alpha=1 is fully opaque)
    const rgbaM = norm.match(/^rgba\((\d+),(\d+),(\d+),(1(?:\.0*)?)\)$/);
    if (rgbaM) return _rgbToHex(+rgbaM[1], +rgbaM[2], +rgbaM[3]);
    // hsla(h,s%,l%,1) → hsl → hex
    const hslaM = norm.match(/^hsla\(([\d.]+),([\d.]+)%,([\d.]+)%,(1(?:\.0*)?)\)$/);
    if (hslaM) return _hslToHex(+hslaM[1], +hslaM[2], +hslaM[3]);
    // rgb(r,g,b) → hex
    const rgbM = norm.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
    if (rgbM) return _rgbToHex(+rgbM[1], +rgbM[2], +rgbM[3]);
    // hsl(h,s%,l%) → hex
    const hslM = norm.match(/^hsl\(([\d.]+),([\d.]+)%,([\d.]+)%\)$/);
    if (hslM) return _hslToHex(+hslM[1], +hslM[2], +hslM[3]);
    return norm;
  }
  return l;
}

function _rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map(c => c.toString(16).padStart(2, '0')).join('');
}

function _hslToHex(h: number, s: number, l: number): string {
  const s1 = s / 100, l1 = l / 100;
  const c = (1 - Math.abs(2 * l1 - 1)) * s1;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l1 - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return _rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
const _SH: Record<string,string[]> = {border:['border-width','border-style','border-color'],'border-top':['border-top-width','border-top-style','border-top-color'],'border-right':['border-right-width','border-right-style','border-right-color'],'border-bottom':['border-bottom-width','border-bottom-style','border-bottom-color'],'border-left':['border-left-width','border-left-style','border-left-color'],margin:['margin-top','margin-right','margin-bottom','margin-left'],padding:['padding-top','padding-right','padding-bottom','padding-left'],background:['background-color'],font:['font-style','font-variant','font-weight','font-size','line-height','font-family'],outline:['outline-width','outline-style','outline-color'],flex:['flex-grow','flex-shrink','flex-basis'],overflow:['overflow-x','overflow-y']};

// Shorthands whose value format is too complex for _rS (comma-separated, not positional).
// Used ONLY for edit-adds-property detection, NOT for value resolution via _rS.
const _SH_EDIT_ONLY: Record<string,string[]> = {transition:['transition-property','transition-duration','transition-timing-function','transition-delay'],animation:['animation-name','animation-duration','animation-timing-function','animation-delay','animation-iteration-count','animation-direction','animation-fill-mode','animation-play-state'],'grid-template':['grid-template-rows','grid-template-columns']};

function _stripVendor(prop: string): string|undefined {
  const m = prop.match(/^-(?:webkit|moz|ms|o)-(.+)$/);
  return m ? m[1] : undefined;
}
function _rS(sp: string, sv: string, lp: string): string|undefined { const ls=_SH[sp]; if(!ls) return; const i=ls.indexOf(lp); if(i===-1) return; const t=sv.trim().split(/\s+/); return t[i]; }

// =============================================================================
// DB SCHEMA PARSING — init.sql → GroundingContext.dbSchema
// =============================================================================

/** Type alias normalization map: PostgreSQL type variants → canonical form. */
const DB_TYPE_ALIASES: Record<string, string> = {
  'serial': 'integer',
  'bigserial': 'bigint',
  'smallserial': 'smallint',
  'int': 'integer',
  'int4': 'integer',
  'int8': 'bigint',
  'int2': 'smallint',
  'bool': 'boolean',
  'character varying': 'varchar',
  'character': 'char',
  'double precision': 'double',
  'float4': 'real',
  'float8': 'double',
  'timestamptz': 'timestamp with time zone',
  'timetz': 'time with time zone',
};

/** Normalize a DB column type for comparison (lowercase, strip size, apply aliases). */
export function normalizeDBType(raw: string): string {
  let t = raw.trim().toLowerCase();
  // Strip size/precision: varchar(50) → varchar, integer(11) → integer
  t = t.replace(/\s*\([^)]*\)/, '');
  // Apply aliases
  return DB_TYPE_ALIASES[t] ?? t;
}

/**
 * Parse a SQL file (init.sql) and extract table/column/type information.
 * Handles standard CREATE TABLE statements with column definitions.
 */
export function parseInitSQL(sql: string): Array<{ table: string; columns: Array<{ name: string; type: string; nullable: boolean; hasDefault: boolean }> }> {
  const tables: Array<{ table: string; columns: Array<{ name: string; type: string; nullable: boolean; hasDefault: boolean }> }> = [];

  // Strip SQL comments
  const clean = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // Match CREATE TABLE blocks
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(([\s\S]*?)\)\s*;/gi;
  let tableMatch;

  while ((tableMatch = tablePattern.exec(clean)) !== null) {
    const tableName = tableMatch[1];
    const body = tableMatch[2];
    const columns: Array<{ name: string; type: string; nullable: boolean; hasDefault: boolean }> = [];

    // Split body by commas, but respect parentheses (for REFERENCES, DEFAULT gen_random_uuid(), etc.)
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());

    for (const part of parts) {
      const trimmed = part.trim();
      // Skip constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, CONSTRAINT)
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(trimmed)) continue;

      // Match: column_name TYPE [constraints...]
      const colMatch = trimmed.match(/^["']?(\w+)["']?\s+(\w+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone))?)/i);
      if (colMatch) {
        const colName = colMatch[1];
        const rawType = colMatch[2];
        const nullable = !/NOT\s+NULL/i.test(trimmed);
        const hasDefault = /DEFAULT\b/i.test(trimmed);
        columns.push({ name: colName, type: rawType, nullable, hasDefault });
      }
    }

    if (columns.length > 0) {
      tables.push({ table: tableName, columns });
    }
  }

  return tables;
}

/**
 * Find and parse init.sql from the app directory.
 * Searches: appDir/init.sql, appDir/migrations/*.sql, appDir/db/init.sql
 */
function findAndParseSchema(appDir: string): GroundingContext['dbSchema'] | undefined {
  const candidates = [
    join(appDir, 'init.sql'),
    join(appDir, 'db', 'init.sql'),
    join(appDir, 'sql', 'init.sql'),
    join(appDir, 'schema.sql'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const sql = readFileSync(candidate, 'utf-8');
        const parsed = parseInitSQL(sql);
        if (parsed.length > 0) return parsed;
      } catch { /* read error */ }
    }
  }

  return undefined;
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
