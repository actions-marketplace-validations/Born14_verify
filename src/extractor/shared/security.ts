/**
 * Shared security-predicate emitter.
 *
 * The only place in the extractor that enumerates the three security checks
 * (secrets_in_code, xss, sql_injection). Both tier1Diff and tier4Static want
 * to emit "scan the edited code files for these three things" when any
 * edit touches a code file — they differ in WHICH extensions count as code
 * and WHETHER to attach human-readable descriptions, so this helper takes
 * both as options. The duplication this collapses is the three-push pattern,
 * not the gate logic around it.
 */

import type { Predicate } from '../../types.js';

export interface EmitSecurityOptions {
  /**
   * Optional description template keyed by check name. If absent, no
   * description field is attached. Tier 1 attaches descriptions; Tier 4 does
   * not (preserving pre-refactor behavior exactly).
   */
  descriptions?: Partial<Record<'secrets_in_code' | 'xss' | 'sql_injection', string>>;
}

/**
 * Emit the three standard security-scan predicates. Callers decide whether
 * to call this at all (based on their own code-file detection).
 */
export function emitSecurityPredicates(opts: EmitSecurityOptions = {}): Predicate[] {
  const checks: Array<'secrets_in_code' | 'xss' | 'sql_injection'> = [
    'secrets_in_code',
    'xss',
    'sql_injection',
  ];

  return checks.map((check) => {
    const predicate: Predicate = {
      type: 'security',
      securityCheck: check,
      expected: 'no_findings',
    };
    if (opts.descriptions?.[check]) {
      predicate.description = opts.descriptions[check];
    }
    return predicate;
  });
}
