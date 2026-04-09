import { describe, test, expect } from 'bun:test';
import { emitSecurityPredicates } from '../../../src/extractor/index.js';

// The shared security helper emits the three standard security-scan
// predicates (secrets_in_code, xss, sql_injection). Callers decide whether
// to invoke it at all based on their own code-file detection (the helper
// is not gated by file extension — that logic lives in each tier).

describe('emitSecurityPredicates', () => {
  test('default call (no descriptions) emits three predicates', () => {
    const preds = emitSecurityPredicates();
    expect(preds).toHaveLength(3);
    expect(preds.map((p) => p.securityCheck).sort()).toEqual([
      'secrets_in_code',
      'sql_injection',
      'xss',
    ]);
    // All are security-type with expected: 'no_findings'
    for (const p of preds) {
      expect(p.type).toBe('security');
      expect(p.expected).toBe('no_findings');
    }
  });

  test('no descriptions by default: the description field is absent', () => {
    const preds = emitSecurityPredicates();
    for (const p of preds) {
      expect(p.description).toBeUndefined();
    }
  });

  test('descriptions option attaches per-check descriptions when provided', () => {
    const preds = emitSecurityPredicates({
      descriptions: {
        secrets_in_code: 'No hardcoded secrets',
        xss: 'No XSS patterns',
        sql_injection: 'No SQL injection patterns',
      },
    });
    const byCheck = Object.fromEntries(preds.map((p) => [p.securityCheck!, p]));
    expect(byCheck.secrets_in_code.description).toBe('No hardcoded secrets');
    expect(byCheck.xss.description).toBe('No XSS patterns');
    expect(byCheck.sql_injection.description).toBe('No SQL injection patterns');
  });

  test('partial descriptions: only specified checks get description fields', () => {
    const preds = emitSecurityPredicates({
      descriptions: {
        xss: 'Only XSS has a description',
      },
    });
    const byCheck = Object.fromEntries(preds.map((p) => [p.securityCheck!, p]));
    expect(byCheck.xss.description).toBe('Only XSS has a description');
    expect(byCheck.secrets_in_code.description).toBeUndefined();
    expect(byCheck.sql_injection.description).toBeUndefined();
  });

  test('returns new predicate objects each call (not shared references)', () => {
    const a = emitSecurityPredicates();
    const b = emitSecurityPredicates();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});
