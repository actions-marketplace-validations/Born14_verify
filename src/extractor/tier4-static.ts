/**
 * Tier 4: Static-heuristic predicate extraction from file extensions.
 *
 * Wakes up dormant gates based on what file types the agent edited, without
 * looking at content. This is the least-specific tier but the cheapest; it
 * runs in constant time per edit and produces the same predicates regardless
 * of what the edit actually contains.
 *
 * Moved verbatim from scripts/scan/level2-scanner.ts generatePredicates as
 * part of the extractor consolidation. Renamed to tier4Static. The unused
 * appDir parameter from the original signature is dropped — the function
 * never consulted it.
 *
 * SI-004a note: the serialization emission is JSON-only. The gate at
 * src/gates/serialization.ts uses JSON.parse exclusively, and emitting this
 * predicate against a .yaml/.yml file guaranteed a parse error on the first
 * non-JSON token. Do not re-expand the extension set without also teaching
 * the serialization gate about YAML.
 */

import type { Edit, Predicate } from '../types.js';
import { emitSecurityPredicates } from './shared/security.js';

export function tier4Static(edits: Edit[]): Predicate[] {
  const predicates: Predicate[] = [];

  // filesystem_exists — every file the agent modifies should exist pre-edit.
  // Note: this is a PRECONDITION check on existing files (modified). Tier 1
  // emits filesystem_exists with different semantics (POSTCONDITION on newly
  // created files). The two emissions are complementary, not redundant — they
  // use disjoint trigger conditions (edit.search vs !edit.search) and the
  // filesystem gate checks existence in both cases.
  for (const edit of edits) {
    if (edit.search) {  // modified file, not new
      predicates.push({ type: 'filesystem_exists', file: edit.file });
    }
  }

  // serialization — if agent edits JSON, validate structure. JSON only —
  // see the SI-004a note in this file's header.
  for (const edit of edits) {
    const lower = edit.file.toLowerCase();
    if (lower.endsWith('.json')) {
      predicates.push({ type: 'serialization', file: edit.file, comparison: 'structural' });
    }
  }

  // security — auto-generate for code files. Extension set is tier4-specific
  // (Tier 1 uses a slightly different set: tier1 includes .mjs/.cjs but
  // excludes go/rs/java; tier4 is the inverse). Do not try to unify these
  // without a deliberate behavior decision — the difference is pre-existing
  // and preserved exactly.
  const codeExts = new Set(['js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'php', 'mjs', 'cjs', 'jsx', 'tsx']);
  if (edits.some(e => codeExts.has(e.file.split('.').pop()?.toLowerCase() ?? ''))) {
    // Tier 4 historically emitted these without descriptions; preserved via
    // the default (no descriptions) path of the shared helper.
    predicates.push(...emitSecurityPredicates());
  }

  // a11y — if HTML files edited
  if (edits.some(e => /\.html?$/i.test(e.file))) {
    predicates.push({ type: 'a11y', a11yCheck: 'alt_text' });
  }

  // performance — if package.json edited (bundle size concern)
  if (edits.some(e => e.file === 'package.json' || e.file.endsWith('/package.json'))) {
    predicates.push({ type: 'performance', perfCheck: 'bundle_size' });
  }

  // config — if config files edited
  const configFiles = ['.env', '.env.local', 'tsconfig.json', 'webpack.config.js', 'vite.config.ts', 'next.config.js'];
  if (edits.some(e => configFiles.some(c => e.file.endsWith(c)))) {
    predicates.push({ type: 'config' });
  }

  return predicates;
}
