/**
 * G5 Gate — Containment Attribution
 * ===================================
 *
 * Every edit should trace to a predicate. If the agent says "change the button color"
 * but also rewrites the auth system, containment catches that.
 *
 * Three attribution levels:
 * - direct:      Edit satisfies a predicate (CSS color change matches CSS predicate)
 * - scaffolding:  Edit enables a predicate (route handler for a predicate's path)
 * - unexplained:  No predicate explains this edit
 *
 * Advisory mode only — flags but doesn't block.
 */

import type { GateResult, GateContext, Edit, Predicate } from '../types.js';

export type Attribution = 'direct' | 'scaffolding' | 'unexplained';

export interface MutationAttribution {
  file: string;
  attribution: Attribution;
  matchedPredicate?: string;
}

export interface ContainmentGateResult extends GateResult {
  attributions: MutationAttribution[];
  summary: {
    total: number;
    direct: number;
    scaffolding: number;
    unexplained: number;
  };
}

export function runContainmentGate(ctx: GateContext): ContainmentGateResult {
  const start = Date.now();
  const attributions: MutationAttribution[] = [];

  for (const edit of ctx.edits) {
    const attr = attributeEdit(edit, ctx.predicates);
    attributions.push(attr);
  }

  const summary = {
    total: attributions.length,
    direct: attributions.filter(a => a.attribution === 'direct').length,
    scaffolding: attributions.filter(a => a.attribution === 'scaffolding').length,
    unexplained: attributions.filter(a => a.attribution === 'unexplained').length,
  };

  const passed = true; // Advisory mode — always passes
  let detail: string;

  if (summary.unexplained === 0) {
    detail = `All ${summary.total} edit(s) traced to predicates (${summary.direct} direct, ${summary.scaffolding} scaffolding)`;
  } else {
    detail = `${summary.unexplained}/${summary.total} edit(s) unexplained — no predicate covers: ${
      attributions.filter(a => a.attribution === 'unexplained').map(a => a.file).join(', ')
    }`;
  }

  return { gate: 'G5', passed, detail, durationMs: Date.now() - start, attributions, summary };
}

function attributeEdit(edit: Edit, predicates: Predicate[]): MutationAttribution {
  // Direct: edit file matches a predicate's file or selector context
  for (const p of predicates) {
    // CSS/HTML predicates — the edit file likely contains the styles/markup
    if ((p.type === 'css' || p.type === 'html') && isLikelySourceFile(edit.file)) {
      // Check if the edit content relates to the predicate
      if (p.selector && edit.replace.includes(p.selector.replace('.', ''))) {
        return { file: edit.file, attribution: 'direct', matchedPredicate: describePredicate(p) };
      }
      if (p.property && edit.replace.includes(p.property)) {
        return { file: edit.file, attribution: 'direct', matchedPredicate: describePredicate(p) };
      }
      if (p.expected && p.expected !== 'exists' && edit.replace.includes(p.expected)) {
        return { file: edit.file, attribution: 'direct', matchedPredicate: describePredicate(p) };
      }
    }

    // Content predicates — the edit file matches the predicate's file
    if (p.type === 'content' && p.file && edit.file.includes(p.file)) {
      return { file: edit.file, attribution: 'direct', matchedPredicate: describePredicate(p) };
    }

    // HTTP predicates — edit is in route handler
    if ((p.type === 'http' || p.type === 'http_sequence') && isRouteFile(edit.file)) {
      if (p.path && edit.replace.includes(p.path)) {
        return { file: edit.file, attribution: 'direct', matchedPredicate: describePredicate(p) };
      }
    }

    // DB predicates — edit is a migration file
    if (p.type === 'db' && edit.file.match(/migration|\.sql$/i)) {
      return { file: edit.file, attribution: 'direct', matchedPredicate: describePredicate(p) };
    }
  }

  // Scaffolding: common support files
  if (isScaffoldingFile(edit.file)) {
    return { file: edit.file, attribution: 'scaffolding' };
  }

  // Check if any predicate references a path, and the edit is in a route handler
  for (const p of predicates) {
    if (p.path && isRouteFile(edit.file)) {
      return { file: edit.file, attribution: 'scaffolding', matchedPredicate: describePredicate(p) };
    }
  }

  return { file: edit.file, attribution: 'unexplained' };
}

function isLikelySourceFile(file: string): boolean {
  return /\.(js|ts|jsx|tsx|html|css|scss|vue|svelte|php|rb|py)$/i.test(file);
}

function isRouteFile(file: string): boolean {
  return /route|server|handler|controller|api|page|app\.(js|ts)/i.test(file);
}

function isScaffoldingFile(file: string): boolean {
  return /package\.json|dockerfile|docker-compose|tsconfig|\.config\.|init\.sql/i.test(file);
}

function describePredicate(p: Predicate): string {
  if (p.description) return p.description;
  if (p.type === 'css') return `[css] ${p.selector} ${p.property}`;
  if (p.type === 'html') return `[html] ${p.selector}`;
  if (p.type === 'http') return `[http] ${p.method ?? 'GET'} ${p.path}`;
  if (p.type === 'content') return `[content] ${p.file} contains "${p.pattern?.substring(0, 30)}"`;
  if (p.type === 'db') return `[db] ${p.table} ${p.assertion}`;
  return `[${p.type}]`;
}
