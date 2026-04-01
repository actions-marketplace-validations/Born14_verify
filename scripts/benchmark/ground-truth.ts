/**
 * Ground Truth Validator — Independent of Verify
 * ================================================
 *
 * This is the judge. It does NOT use any verify gate code.
 * It checks: did the file changes actually apply? Do content predicates hold?
 * Does the app still work?
 *
 * If this uses verify internals, the benchmark is circular. Keep it clean.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { Edit, Predicate } from '../../src/types.js';
import type { GroundTruthResult } from './types.js';

// =============================================================================
// FILE CHECKS — did the edits actually land?
// =============================================================================

function checkFilesApplied(
  appDir: string,
  edits: Edit[],
): { applied: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const edit of edits) {
    const filePath = join(appDir, edit.file);

    if (!existsSync(filePath)) {
      errors.push(`File not found: ${edit.file}`);
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');

    // The replace string should be present in the file
    if (!content.includes(edit.replace)) {
      errors.push(`Expected content not found in ${edit.file}: "${edit.replace.slice(0, 60)}..."`);
    }

    // The search string should NOT be present (it was replaced)
    // Unless search === replace (no-op) or replace contains search
    if (edit.search !== edit.replace && !edit.replace.includes(edit.search)) {
      if (content.includes(edit.search)) {
        errors.push(`Original content still present in ${edit.file}: "${edit.search.slice(0, 60)}..."`);
      }
    }
  }

  return { applied: errors.length === 0, errors };
}

// =============================================================================
// CONTENT PREDICATE CHECKS — independent of verify's gate logic
// =============================================================================

function checkContentPredicates(
  appDir: string,
  predicates: Predicate[],
): Array<{ predicate: Predicate; passed: boolean; reason: string }> {
  const results: Array<{ predicate: Predicate; passed: boolean; reason: string }> = [];

  for (const pred of predicates) {
    if (pred.type === 'content' && pred.file && pred.pattern) {
      const filePath = join(appDir, pred.file);
      if (!existsSync(filePath)) {
        results.push({ predicate: pred, passed: false, reason: `File not found: ${pred.file}` });
        continue;
      }
      const content = readFileSync(filePath, 'utf-8');
      const found = content.includes(pred.pattern);
      results.push({
        predicate: pred,
        passed: found,
        reason: found ? 'Pattern found' : `Pattern not found: "${pred.pattern.slice(0, 60)}"`,
      });
    }

    if (pred.type === 'filesystem_exists' && pred.file) {
      const filePath = join(appDir, pred.file);
      const exists = existsSync(filePath);
      results.push({
        predicate: pred,
        passed: exists,
        reason: exists ? 'File exists' : `File not found: ${pred.file}`,
      });
    }

    if (pred.type === 'filesystem_absent' && pred.file) {
      const filePath = join(appDir, pred.file);
      const absent = !existsSync(filePath);
      results.push({
        predicate: pred,
        passed: absent,
        reason: absent ? 'File absent as expected' : `File unexpectedly exists: ${pred.file}`,
      });
    }

    // CSS and HTML predicates need a browser — skip if no Docker
    if (pred.type === 'css' || pred.type === 'html') {
      results.push({
        predicate: pred,
        passed: false,
        reason: 'Requires browser (skipped in ground-truth, file checks only)',
      });
    }
  }

  return results;
}

// =============================================================================
// APP HEALTH — does the app still start?
// =============================================================================

function checkAppStarts(appDir: string): { starts: boolean; error: string } {
  // Try node --check on server files (syntax validation)
  const serverFiles = ['server.js', 'index.js', 'app.js', 'server.ts', 'index.ts', 'app.ts'];

  for (const file of serverFiles) {
    const filePath = join(appDir, file);
    if (existsSync(filePath)) {
      // For .ts files, just check they're parseable
      if (file.endsWith('.ts')) {
        try {
          readFileSync(filePath, 'utf-8');
          return { starts: true, error: '' };
        } catch (err: any) {
          return { starts: false, error: `Cannot read ${file}: ${err.message}` };
        }
      }
      // For .js files, use node --check
      try {
        execSync(`node --check "${filePath}"`, {
          cwd: appDir,
          timeout: 10_000,
          stdio: 'pipe',
        });
        return { starts: true, error: '' };
      } catch (err: any) {
        return { starts: false, error: `node --check ${file} failed: ${err.stderr?.toString().slice(0, 200) ?? err.message}` };
      }
    }
  }

  // No server file found — can't check
  return { starts: true, error: '' };
}

// =============================================================================
// TEST RUNNER — does npm test / pytest pass?
// =============================================================================

function checkTestsPass(appDir: string): { pass: boolean | null; output: string } {
  const packageJson = join(appDir, 'package.json');
  if (existsSync(packageJson)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJson, 'utf-8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        const result = execSync('npm test', {
          cwd: appDir,
          timeout: 30_000,
          stdio: 'pipe',
        });
        return { pass: true, output: result.toString().slice(-500) };
      }
    } catch (err: any) {
      const output = err.stdout?.toString().slice(-300) ?? '';
      const stderr = err.stderr?.toString().slice(-300) ?? '';
      return { pass: false, output: `${output}\n${stderr}`.trim() };
    }
  }

  // No test runner found
  return { pass: null, output: 'No test command found' };
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Run independent ground-truth validation.
 * Does NOT use any verify code. That's the whole point.
 */
export function validateGroundTruth(
  appDir: string,
  edits: Edit[],
  predicates: Predicate[],
): GroundTruthResult {
  // 1. Did the file changes apply?
  const fileCheck = checkFilesApplied(appDir, edits);

  // 2. Do content predicates hold?
  const predResults = checkContentPredicates(appDir, predicates);
  const checkablePredicates = predResults.filter(r =>
    r.predicate.type !== 'css' && r.predicate.type !== 'html'
  );
  const contentPass = checkablePredicates.length === 0 ||
    checkablePredicates.every(r => r.passed);

  // 3. Does the app still start?
  const appCheck = checkAppStarts(appDir);

  // 4. Do tests pass?
  const testCheck = checkTestsPass(appDir);

  // Overall: files applied + content predicates hold + app doesn't crash
  const goalAchieved = fileCheck.applied && contentPass && appCheck.starts;

  return {
    filesApplied: fileCheck.applied,
    fileErrors: fileCheck.errors,
    testsPass: testCheck.pass,
    testOutput: testCheck.output,
    appStarts: appCheck.starts,
    startupError: appCheck.error,
    contentPredicatesPass: contentPass,
    predicateResults: predResults,
    goalAchieved,
  };
}
