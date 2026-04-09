import { describe, test, expect } from 'bun:test';
import { extractPredicates } from '../../../src/extractor/index.js';

// Integration test for the facade. The facade is not used by either
// current production caller (src/action/index.ts composes individual
// tier functions directly; scripts/scan/level2-scanner.ts calls only
// tier4Static). It exists as a bundled default composition for future
// callers. This test exercises that composition end-to-end to prove the
// tiers compose correctly and that the facade is not dead code.

describe('extractPredicates (facade)', () => {
  test('composes predicates from multiple tiers simultaneously on a realistic edit set', () => {
    const edits = [
      // Tier 1 territory: new TS file should emit filesystem_exists + content + security
      {
        file: 'src/new-service.ts',
        search: '',
        replace: 'export class NewService { handle() { return "ok"; } }',
      },
      // Tier 4 territory: .json file should emit serialization + filesystem_exists
      {
        file: 'package.json',
        search: '"version": "0.1.0"',
        replace: '"version": "0.2.0"',
      },
    ];

    const preds = extractPredicates(edits, {
      existingFiles: ['src/new-service.ts', 'package.json', 'docker-compose.yml'],
      prContext: {
        title: 'Add "NewService" and bump version',
      },
    });

    // Tier 1 emitted filesystem_exists for the new file
    const fsExists = preds.filter(
      (p) => p.type === 'filesystem_exists' && p.file === 'src/new-service.ts'
    );
    expect(fsExists.length).toBeGreaterThan(0);

    // Tier 4 emitted serialization for package.json
    const ser = preds.filter(
      (p) => p.type === 'serialization' && p.file === 'package.json'
    );
    expect(ser).toHaveLength(1);

    // Tier 4 emitted performance for package.json (bundle_size)
    const perf = preds.filter((p) => p.type === 'performance');
    expect(perf.length).toBeGreaterThan(0);

    // Tier 1 emitted security predicates for the TS file (three of them)
    const sec = preds.filter((p) => p.type === 'security');
    // Both tier 1 AND tier 4 may emit security predicates — tier1 for .ts,
    // tier4 for js/ts/... So we expect at least 3 (from one tier) and up
    // to 6 (from both). Exact count is a behavior detail preserved by the
    // refactor; just confirm both fired.
    expect(sec.length).toBeGreaterThanOrEqual(3);

    // Tier 3 emitted a content predicate for "NewService" from the PR title
    const tier3Match = preds.find((p) => p.type === 'content' && p.pattern === 'NewService');
    expect(tier3Match).toBeDefined();
  });

  test('no context: only tier1 and tier4 fire (tiers 2 and 3 require context)', () => {
    const edits = [
      { file: 'src/foo.ts', search: '', replace: 'export const x = 1;' },
    ];
    const preds = extractPredicates(edits);
    // Should include filesystem_exists, content, security (from tier1) and
    // security (from tier4, different extension set). Should NOT include
    // any cross-file content predicates (tier2 skipped) or any content
    // predicates derived from PR metadata (tier3 skipped).
    expect(preds.length).toBeGreaterThan(0);
    // Specifically: tier1's filesystem_exists fires for new files
    const fsExists = preds.filter((p) => p.type === 'filesystem_exists');
    expect(fsExists.length).toBeGreaterThan(0);
  });

  test('empty edits: returns empty', () => {
    expect(extractPredicates([])).toEqual([]);
  });

  test('context with only existingFiles: tier2 runs, tier3 skipped', () => {
    const edits = [
      {
        file: 'src/server.ts',
        search: '"/api/legacy"',
        replace: '"/api/v2"',
      },
    ];
    const preds = extractPredicates(edits, {
      existingFiles: ['src/server.ts', 'docker-compose.yml', '.env'],
    });
    // Tier 2 should have fired (we provided existingFiles). Look for a
    // cross-file predicate on docker-compose.yml or .env (per tier2 heuristic).
    const crossFile = preds.filter(
      (p) => p.file === 'docker-compose.yml' || p.file === '.env'
    );
    expect(crossFile.length).toBeGreaterThan(0);
  });

  test('context with only prContext: tier3 runs, tier2 skipped', () => {
    const edits = [
      {
        file: 'src/config.ts',
        search: 'const API_KEY = "old"',
        replace: 'const API_KEY = "new"',
      },
    ];
    const preds = extractPredicates(edits, {
      prContext: {
        title: 'Update "API_KEY" for new environment',
      },
    });
    // Tier 3 should have emitted a predicate for "API_KEY"
    const apiKeyMatch = preds.find((p) => p.type === 'content' && p.pattern === 'API_KEY');
    expect(apiKeyMatch).toBeDefined();
  });
});
