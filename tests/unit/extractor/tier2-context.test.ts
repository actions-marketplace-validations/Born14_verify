import { describe, test, expect } from 'bun:test';
import { tier2Context } from '../../../src/extractor/index.js';

// Tier 2 extracts cross-file predicates: when an edit removes an identifier
// that may be referenced elsewhere, flag the other files with content
// predicates (expected: 'absent'). Requires the existingFiles list.

describe('tier2Context', () => {
  test('cross-file reference: route path removed from server, flag config files', () => {
    // Tier 2's looksLikeReference heuristic says: "a route path (starts with /)
    // removed from any file, and the other file is docker/config/.env/server, flag it."
    const edits = [
      {
        file: 'src/server.ts',
        search: 'app.get("/api/legacy", handler);',
        replace: 'app.get("/api/v2", handler);',
      },
    ];
    const existingFiles = [
      'src/server.ts',
      'docker-compose.yml',
      '.env',
      'README.md', // should NOT be flagged per the heuristic
    ];
    const preds = tier2Context(edits, existingFiles);
    // Expect at least one predicate on docker-compose.yml or .env, none on README.md
    const configFilePreds = preds.filter(
      (p) => p.file === 'docker-compose.yml' || p.file === '.env'
    );
    const readmePreds = preds.filter((p) => p.file === 'README.md');
    expect(configFilePreds.length).toBeGreaterThan(0);
    expect(readmePreds).toHaveLength(0);
    // Cross-file predicates use expected: 'absent'
    for (const p of configFilePreds) {
      expect(p.expected).toBe('absent');
      expect(p.type).toBe('content');
    }
  });

  test('no existing files: returns empty', () => {
    const edits = [
      { file: 'src/foo.ts', search: 'a', replace: 'b' },
    ];
    expect(tier2Context(edits, undefined)).toEqual([]);
    expect(tier2Context(edits, [])).toEqual([]);
  });

  test('new file edit: no cross-file predicates (only modifications are considered)', () => {
    const edits = [
      { file: 'src/new.ts', search: '', replace: 'export const x = 1;' },
    ];
    const existingFiles = ['src/new.ts', 'docker-compose.yml'];
    const preds = tier2Context(edits, existingFiles);
    expect(preds).toHaveLength(0);
  });

  test('edited file excluded from cross-file check targets', () => {
    // The file being edited should not appear in its own cross-file predicates
    const edits = [
      {
        file: 'src/server.ts',
        search: '"/api/old"',
        replace: '"/api/new"',
      },
    ];
    const existingFiles = ['src/server.ts', 'docker-compose.yml'];
    const preds = tier2Context(edits, existingFiles);
    const selfRef = preds.filter((p) => p.file === 'src/server.ts');
    expect(selfRef).toHaveLength(0);
  });

  test('short removed strings (<4 chars) are skipped', () => {
    const edits = [
      {
        file: 'src/server.ts',
        search: 'const x = 1;',
        replace: 'const y = 2;',
      },
    ];
    // x, y are 1 char; "const" appears in both so it's not "removed"; should emit nothing
    // meaningful cross-file
    const existingFiles = ['src/server.ts', 'docker-compose.yml'];
    const preds = tier2Context(edits, existingFiles);
    // No meaningful 4+ char identifiers uniquely removed that look like references
    expect(preds.filter((p) => p.pattern === 'x' || p.pattern === 'y')).toHaveLength(0);
  });
});
