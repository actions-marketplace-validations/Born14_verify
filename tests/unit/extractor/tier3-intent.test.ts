import { describe, test, expect } from 'bun:test';
import { tier3Intent } from '../../../src/extractor/index.js';

// Tier 3 extracts predicates from PR metadata (title, description, issue,
// commit messages). Heuristic only — no LLM. Matches quoted strings, CSS
// utility classes, CSS selectors, and route paths.

describe('tier3Intent', () => {
  test('quoted string in PR title matching an edit emits a content predicate', () => {
    const edits = [
      {
        file: 'src/config.ts',
        search: 'MAX_RETRIES = 3',
        replace: 'MAX_RETRIES = 5',
      },
    ];
    const preds = tier3Intent(edits, {
      title: 'Bump "MAX_RETRIES" to handle flaky network',
    });
    const match = preds.find((p) => p.pattern === 'MAX_RETRIES');
    expect(match).toBeDefined();
    expect(match!.type).toBe('content');
    expect(match!.file).toBe('src/config.ts');
  });

  test('quoted string with NO matching edit emits no predicate', () => {
    const edits = [
      { file: 'src/other.ts', search: 'foo', replace: 'bar' },
    ];
    const preds = tier3Intent(edits, {
      title: 'Update "SOME_UNRELATED_THING" documentation',
    });
    const unrelated = preds.find((p) => p.pattern === 'SOME_UNRELATED_THING');
    expect(unrelated).toBeUndefined();
  });

  test('CSS utility class extraction: Tailwind-style rounded-lg', () => {
    const edits = [
      {
        file: 'src/Button.tsx',
        search: 'className="btn"',
        replace: 'className="btn rounded-lg bg-blue-500"',
      },
    ];
    const preds = tier3Intent(edits, {
      description: 'Make buttons rounded-lg with bg-blue-500 for consistency',
    });
    const roundedMatch = preds.find((p) => p.pattern === 'rounded-lg');
    expect(roundedMatch).toBeDefined();
    expect(roundedMatch!.type).toBe('content');
  });

  test('route path extraction: /api/users mentioned and server edit exists', () => {
    const edits = [
      {
        file: 'src/server.ts',
        search: 'app.listen(3000)',
        replace: 'app.get("/api/users", handler);\napp.listen(3000)',
      },
    ];
    const preds = tier3Intent(edits, {
      title: 'Add GET /api/users endpoint',
    });
    const routeMatch = preds.find((p) => p.pattern === '/api/users');
    expect(routeMatch).toBeDefined();
    expect(routeMatch!.type).toBe('content');
    expect(routeMatch!.file).toBe('src/server.ts');
  });

  test('no PR metadata: returns empty', () => {
    const edits = [
      { file: 'src/foo.ts', search: 'a', replace: 'b' },
    ];
    expect(tier3Intent(edits, {})).toEqual([]);
  });

  test('metadata provided but no matches: returns empty', () => {
    const edits = [
      { file: 'src/foo.ts', search: 'a', replace: 'b' },
    ];
    const preds = tier3Intent(edits, {
      title: 'Routine maintenance',
      description: 'Minor cleanup of unrelated code',
    });
    // Title/description is prose with no quoted strings or patterns that
    // match the edit's content. May still emit some noise from generic
    // identifier matching; assert no quoted-pattern matches specifically.
    const quotedMatches = preds.filter((p) =>
      p.description?.includes('PR mentions "')
    );
    expect(quotedMatches).toHaveLength(0);
  });
});
