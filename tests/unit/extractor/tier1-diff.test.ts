import { describe, test, expect } from 'bun:test';
import { tier1Diff } from '../../../src/extractor/index.js';

// Tier 1 extracts deterministic predicates directly from edits:
//   - new file → filesystem_exists (postcondition on creation)
//   - deleted file → filesystem_absent
//   - modified file → content predicates for added strings (post-edit assertion)
//                    and for removed strings (expected: 'absent')

describe('tier1Diff', () => {
  test('new file emits filesystem_exists', () => {
    const edits = [
      { file: 'src/newthing.ts', search: '', replace: 'export const hello = "world";\n' },
    ];
    const preds = tier1Diff(edits);
    const fsExists = preds.filter((p) => p.type === 'filesystem_exists');
    expect(fsExists).toHaveLength(1);
    expect(fsExists[0].file).toBe('src/newthing.ts');
  });

  test('deleted file emits filesystem_absent', () => {
    const edits = [
      { file: 'src/old.ts', search: 'export const gone = 1;\n', replace: '' },
    ];
    const preds = tier1Diff(edits);
    const fsAbsent = preds.filter((p) => p.type === 'filesystem_absent');
    expect(fsAbsent).toHaveLength(1);
    expect(fsAbsent[0].file).toBe('src/old.ts');
  });

  test('modified file with added content emits content predicate', () => {
    const edits = [
      {
        file: 'src/service.ts',
        search: 'function greet() { return "hi"; }',
        replace: 'function greet() { return "hello world"; }',
      },
    ];
    const preds = tier1Diff(edits);
    const contentPreds = preds.filter((p) => p.type === 'content');
    // Should emit at least one "added" content predicate (no expected: 'absent')
    const added = contentPreds.filter((p) => p.expected !== 'absent');
    expect(added.length).toBeGreaterThan(0);
    expect(added[0].file).toBe('src/service.ts');
  });

  test('modified file with removed content emits content predicate with expected absent', () => {
    const edits = [
      {
        file: 'src/service.ts',
        search: 'const oldApiKey = "abc123";',
        replace: 'const newApiKey = "xyz789";',
      },
    ];
    const preds = tier1Diff(edits);
    const contentPreds = preds.filter((p) => p.type === 'content');
    const absent = contentPreds.filter((p) => p.expected === 'absent');
    expect(absent.length).toBeGreaterThan(0);
    expect(absent[0].file).toBe('src/service.ts');
  });

  test('new code file triggers security predicates via shared helper', () => {
    const edits = [
      { file: 'src/handler.ts', search: '', replace: 'export function handle() {}' },
    ];
    const preds = tier1Diff(edits);
    const sec = preds.filter((p) => p.type === 'security');
    // Three predicates: secrets_in_code, xss, sql_injection
    expect(sec).toHaveLength(3);
    expect(sec.map((p) => p.securityCheck).sort()).toEqual(['secrets_in_code', 'sql_injection', 'xss']);
    // Tier 1 attaches descriptions
    expect(sec[0].description).toBeDefined();
  });

  test('non-code file does NOT trigger security predicates', () => {
    const edits = [
      { file: 'docs/README.md', search: '', replace: '# Hello\n' },
    ];
    const preds = tier1Diff(edits);
    const sec = preds.filter((p) => p.type === 'security');
    expect(sec).toHaveLength(0);
  });

  test('empty edit array returns empty', () => {
    expect(tier1Diff([])).toEqual([]);
  });
});
