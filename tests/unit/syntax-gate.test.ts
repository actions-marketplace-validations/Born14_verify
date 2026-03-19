import { describe, test, expect } from 'bun:test';
import { runSyntaxGate, applyEdits } from '../../src/gates/syntax.js';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { GateContext, VerifyConfig } from '../../src/types.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(dir: string, edits: any[]): GateContext {
  return {
    config: { appDir: dir } as VerifyConfig,
    edits,
    predicates: [],
    stageDir: dir,
    log: () => {},
  };
}

describe('F9 Syntax Gate', () => {
  test('passes when search string exists exactly once', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'index.html'), '<h1>Hello World</h1>');

    const result = runSyntaxGate(makeCtx(dir, [
      { file: 'index.html', search: 'Hello World', replace: 'Hello Verify' },
    ]));

    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('fails when search string not found', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'index.html'), '<h1>Hello World</h1>');

    const result = runSyntaxGate(makeCtx(dir, [
      { file: 'index.html', search: 'Goodbye', replace: 'Hello' },
    ]));

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe('not_found');
    rmSync(dir, { recursive: true, force: true });
  });

  test('fails when search string matches multiple times', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'index.html'), '<p>hello</p><p>hello</p>');

    const result = runSyntaxGate(makeCtx(dir, [
      { file: 'index.html', search: 'hello', replace: 'world' },
    ]));

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe('ambiguous_match');
    rmSync(dir, { recursive: true, force: true });
  });

  test('fails when file does not exist', () => {
    const dir = makeTempDir();

    const result = runSyntaxGate(makeCtx(dir, [
      { file: 'missing.html', search: 'hello', replace: 'world' },
    ]));

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe('file_missing');
    rmSync(dir, { recursive: true, force: true });
  });

  test('handles multiple edits, reports all failures', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.js'), 'const x = 1;');
    writeFileSync(join(dir, 'b.js'), 'const y = 2;');

    const result = runSyntaxGate(makeCtx(dir, [
      { file: 'a.js', search: 'const x = 1;', replace: 'const x = 42;' },
      { file: 'b.js', search: 'NOPE', replace: 'whatever' },
    ]));

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe('b.js');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('applyEdits', () => {
  test('applies edits to staging directory', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'index.html'), '<h1>Hello World</h1>');

    const results = applyEdits(
      [{ file: 'index.html', search: 'Hello World', replace: 'Hello Verify' }],
      dir,
    );

    expect(results.every(r => r.applied)).toBe(true);
    expect(readFileSync(join(dir, 'index.html'), 'utf-8')).toBe('<h1>Hello Verify</h1>');
    rmSync(dir, { recursive: true, force: true });
  });

  test('reports failure for missing file', () => {
    const dir = makeTempDir();

    const results = applyEdits(
      [{ file: 'missing.txt', search: 'hello', replace: 'world' }],
      dir,
    );

    expect(results[0].applied).toBe(false);
    expect(results[0].reason).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
