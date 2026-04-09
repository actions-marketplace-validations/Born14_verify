import { describe, test, expect } from 'bun:test';
import { tier4Static } from '../../../src/extractor/index.js';

// Regression tests for tier4Static (the static-heuristic extraction tier).
//
// Moved from tests/unit/level2-predicate-generator.test.ts as part of the
// extractor consolidation. The assertions are unchanged — only the import
// and the call signature (tier4Static takes no appDir parameter; the legacy
// generatePredicates did, but never consulted it).
//
// SI-004a: serialization predicate must NOT be emitted for YAML files,
// because the serialization gate is JSON-only (src/gates/serialization.ts
// uses JSON.parse). Emitting against .yaml/.yml guarantees a parse error
// on the first non-JSON token in the file.

describe('tier4Static — serialization (SI-004a regression)', () => {
  test('emits serialization predicate for .json files', () => {
    const edits = [
      { file: 'package.json', search: '"foo": 1', replace: '"foo": 2' },
    ];
    const preds = tier4Static(edits);
    const ser = preds.filter((p) => p.type === 'serialization');
    expect(ser).toHaveLength(1);
    expect(ser[0].file).toBe('package.json');
  });

  test('SI-004a: does NOT emit serialization predicate for .yaml files', () => {
    const edits = [
      {
        file: '.github/workflows/all-checks.yml',
        search: 'on: pull_request',
        replace: 'on: [pull_request, push]',
      },
      { file: 'config.yaml', search: 'a: 1', replace: 'a: 2' },
    ];
    const preds = tier4Static(edits);
    const ser = preds.filter((p) => p.type === 'serialization');
    expect(ser).toHaveLength(0);
  });

  test('SI-004a: mixed JSON + YAML in one batch — only the JSON gets a serialization predicate', () => {
    const edits = [
      { file: 'tsconfig.json', search: '"strict": false', replace: '"strict": true' },
      { file: 'docker-compose.yml', search: 'image: x', replace: 'image: y' },
      { file: 'src/index.ts', search: 'foo()', replace: 'bar()' },
    ];
    const preds = tier4Static(edits);
    const ser = preds.filter((p) => p.type === 'serialization');
    expect(ser).toHaveLength(1);
    expect(ser[0].file).toBe('tsconfig.json');
  });

  test('SI-004a: case-insensitive — .JSON still emits, .YAML still does not', () => {
    const edits = [
      { file: 'Config.JSON', search: '{}', replace: '{"a":1}' },
      { file: 'Settings.YAML', search: 'a: 1', replace: 'a: 2' },
    ];
    const preds = tier4Static(edits);
    const ser = preds.filter((p) => p.type === 'serialization');
    expect(ser).toHaveLength(1);
    expect(ser[0].file).toBe('Config.JSON');
  });
});
