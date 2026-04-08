import { describe, test, expect } from 'bun:test';
import { filterCommitsForSI003 } from '../../scripts/scan/level2-scanner.js';

// SI-003 regression: when a multi-commit PR creates a file in one commit
// and modifies it in a later commit, the scanner used to emit both edits
// against the parent of the EARLIEST commit. F9 then fired `file_missing`
// on the modification edits because the file didn't exist at that base.
// Option C fix: drop modification commit rows for files that have any
// `added` row in the same PR.

const mk = (sha: string, filename: string, status: string, patch = '@@ ... @@') => ({
  sha,
  filename,
  status,
  patch,
});

describe('filterCommitsForSI003', () => {
  test('SI-003: drops modification rows for files created in same PR', () => {
    const commits = [
      mk('a1', 'packages/foo/Service.ts', 'added'),
      mk('b2', 'packages/foo/Service.ts', 'modified'),
      mk('c3', 'packages/foo/Service.ts', 'modified'),
    ];
    const filtered = filterCommitsForSI003(commits);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sha).toBe('a1');
    expect(filtered[0].status).toBe('added');
  });

  test('SI-003: preserves modification rows for files NOT created in this PR (positive control)', () => {
    // This is the case the fix MUST NOT over-correct: a genuine modification
    // of a pre-existing file should still be evaluated by F9.
    const commits = [
      mk('a1', 'src/existing.ts', 'modified'),
      mk('b2', 'src/existing.ts', 'modified'),
    ];
    const filtered = filterCommitsForSI003(commits);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(c => c.status === 'modified')).toBe(true);
  });

  test('SI-003: handles a PR that mixes created and modified files', () => {
    const commits = [
      mk('a1', 'new-file.ts', 'added'),
      mk('a1', 'existing.ts', 'modified'),
      mk('b2', 'new-file.ts', 'modified'), // should be dropped
      mk('b2', 'existing.ts', 'modified'), // should be kept
    ];
    const filtered = filterCommitsForSI003(commits);
    expect(filtered).toHaveLength(3);
    expect(filtered.find(c => c.filename === 'new-file.ts' && c.status === 'modified')).toBeUndefined();
    expect(filtered.filter(c => c.filename === 'existing.ts')).toHaveLength(2);
    expect(filtered.find(c => c.filename === 'new-file.ts' && c.status === 'added')).toBeDefined();
  });

  test('SI-003: handles file created and modified in the same commit batch (multiple added rows)', () => {
    // Edge case: dataset may produce multiple `added` rows for the same file
    // (e.g. across rebased branches). All `added` rows should be preserved;
    // only modified/other rows for that file should be dropped.
    const commits = [
      mk('a1', 'foo.ts', 'added'),
      mk('a2', 'foo.ts', 'added'),
      mk('b1', 'foo.ts', 'modified'),
    ];
    const filtered = filterCommitsForSI003(commits);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(c => c.status === 'added')).toBe(true);
  });

  test('SI-003: cal.com PR 3161649548 reproduction shape', () => {
    // From the SI-003 confirmation evidence: PR creates CachedCalendarClient.ts
    // in one commit and modifies it in two later commits. Pre-fix, this produced
    // 2 file_missing F9 findings. Post-fix, only the creation row survives.
    const commits = [
      mk('sha1', 'packages/app-store/_utils/googleapis/CachedCalendarClient.ts', 'added'),
      mk('sha2', 'packages/app-store/_utils/googleapis/CachedCalendarClient.ts', 'modified'),
      mk('sha3', 'packages/app-store/_utils/googleapis/CachedCalendarClient.ts', 'modified'),
      mk('sha4', 'unrelated/file.ts', 'modified'),
    ];
    const filtered = filterCommitsForSI003(commits);
    expect(filtered).toHaveLength(2);
    const cachedClientRows = filtered.filter(c => c.filename.endsWith('CachedCalendarClient.ts'));
    expect(cachedClientRows).toHaveLength(1);
    expect(cachedClientRows[0].status).toBe('added');
    const unrelatedRows = filtered.filter(c => c.filename === 'unrelated/file.ts');
    expect(unrelatedRows).toHaveLength(1);
    expect(unrelatedRows[0].status).toBe('modified');
  });

  test('SI-003: empty input returns empty', () => {
    expect(filterCommitsForSI003([])).toEqual([]);
  });
});
