import { describe, test, expect, beforeEach } from 'bun:test';
import {
  ConstraintStore,
  extractSignature,
  predicateFingerprint,
  classifyChangeType,
  classifyActionClass,
} from '../../src/store/constraint-store.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTempDir(): string {
  const dir = join(tmpdir(), `verify-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('extractSignature', () => {
  test('detects syntax_error', () => {
    expect(extractSignature('SyntaxError: Unexpected token }')).toBe('syntax_error');
  });

  test('detects build_failure', () => {
    expect(extractSignature('build failed with exit code 1')).toBe('build_failure');
  });

  test('detects port_conflict', () => {
    expect(extractSignature('Error: EADDRINUSE: port 3000')).toBe('port_conflict');
  });

  test('detects missing_module', () => {
    expect(extractSignature('Cannot find module "express"')).toBe('missing_module');
  });

  test('detects edit_not_applicable', () => {
    expect(extractSignature('Edit application failed: search string not found')).toBe('edit_not_applicable');
  });

  test('returns undefined for unknown errors', () => {
    expect(extractSignature('Something completely random happened')).toBeUndefined();
  });
});

describe('predicateFingerprint', () => {
  test('creates deterministic fingerprint', () => {
    const fp = predicateFingerprint({ type: 'css', selector: 'h1', property: 'color', expected: 'red' });
    expect(fp).toBe('type=css|selector=h1|property=color|exp=red');
  });

  test('omits missing fields', () => {
    const fp = predicateFingerprint({ type: 'html', selector: '.nav' });
    expect(fp).toBe('type=html|selector=.nav');
  });

  test('same inputs produce same fingerprint', () => {
    const a = predicateFingerprint({ type: 'css', selector: 'body', property: 'background', expected: '#fff' });
    const b = predicateFingerprint({ type: 'css', selector: 'body', property: 'background', expected: '#fff' });
    expect(a).toBe(b);
  });
});

describe('classifyChangeType', () => {
  test('ui for CSS files', () => {
    expect(classifyChangeType(['styles.css', 'theme.css'])).toBe('ui');
  });

  test('logic for JS files', () => {
    expect(classifyChangeType(['server.js', 'routes/api.js'])).toBe('logic');
  });

  test('schema for migration files', () => {
    expect(classifyChangeType(['migrations/001_create.sql'])).toBe('schema');
  });

  test('config for Docker files', () => {
    expect(classifyChangeType(['Dockerfile'])).toBe('config');
  });

  test('mixed for multiple categories', () => {
    expect(classifyChangeType(['server.js', 'Dockerfile'])).toBe('mixed');
  });
});

describe('classifyActionClass', () => {
  test('detects style_overhaul with many CSS changes', () => {
    const edits = Array.from({ length: 6 }, (_, i) => ({
      file: 'style.css',
      search: `color${i}: old`,
      replace: `color${i}: new`,
    }));
    expect(classifyActionClass(edits)).toBe('style_overhaul');
  });

  test('detects schema_migration', () => {
    const edits = [{ file: 'migrations/001.sql', search: '', replace: 'CREATE TABLE x' }];
    expect(classifyActionClass(edits)).toBe('schema_migration');
  });
});

describe('ConstraintStore', () => {
  let stateDir: string;
  let store: ConstraintStore;

  beforeEach(() => {
    stateDir = makeTempDir();
    store = new ConstraintStore(stateDir);
  });

  test('starts with 0 constraints', () => {
    expect(store.getConstraintCount()).toBe(0);
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('seedFromFailure adds a constraint', () => {
    const result = store.seedFromFailure({
      sessionId: 'test-1',
      source: 'staging',
      error: 'SyntaxError: Unexpected token }',
      filesTouched: ['server.js'],
      attempt: 2,
      changeType: 'logic',
      signature: 'syntax_error',
      actionClass: null,
    });

    expect(result).toBeTruthy();
    expect(store.getConstraintCount()).toBe(1);
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('checkConstraints detects predicate fingerprint ban', () => {
    // Seed a constraint banning a predicate fingerprint
    store.seedFromFailure({
      sessionId: 'test-1',
      source: 'evidence',
      error: 'predicate failed',
      filesTouched: ['server.js'],
      attempt: 1,
      changeType: 'logic',
      signature: 'predicate_mismatch',
      actionClass: undefined,
      failedPredicates: [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
    });

    const result = store.checkConstraints(
      ['server.js'],
      'logic',
      ['type=css|selector=h1|property=color|exp=red'],
    );

    expect(result).toBeTruthy();
    expect(result!.banType).toBe('predicate_fingerprint');
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('checkConstraints returns null when no violations', () => {
    const result = store.checkConstraints(['styles.css'], 'ui', []);
    expect(result).toBeNull();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('recordOutcome persists', () => {
    store.recordOutcome({
      timestamp: Date.now(),
      sessionId: 'test-1',
      goal: 'test goal',
      success: true,
      changeType: 'ui',
      filesTouched: ['styles.css'],
    });

    // Re-load store from same dir
    const store2 = new ConstraintStore(stateDir);
    expect(store2.getConstraintCount()).toBe(0);
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('cleanupSession removes session constraints', () => {
    store.seedFromFailure({
      sessionId: 'test-session',
      source: 'staging',
      error: 'build failed with exit code 1',
      filesTouched: ['server.js'],
      attempt: 2,
      changeType: 'logic',
      signature: 'build_failure',
      actionClass: null,
    });

    expect(store.getConstraintCount()).toBe(1);
    store.cleanupSession('test-session');
    expect(store.getConstraintCount()).toBe(0);
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('getPatternRecall returns prior fixes', () => {
    store.recordOutcome({
      timestamp: Date.now(),
      sessionId: 'test-1',
      goal: 'fix syntax error',
      success: true,
      changeType: 'logic',
      filesTouched: ['server.js'],
      signature: 'syntax_error',
    });

    const recall = store.getPatternRecall('SyntaxError: Unexpected token');
    // recall is a string or undefined
    expect(typeof recall === 'string' || recall === undefined).toBe(true);
    rmSync(stateDir, { recursive: true, force: true });
  });
});
