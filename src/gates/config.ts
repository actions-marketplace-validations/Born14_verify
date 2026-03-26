/**
 * Configuration Gate
 * ==================
 *
 * Validates configuration predicates against parsed config files.
 * Supports .env, JSON, YAML, and dotenv formats.
 * Pure file parsing — no network, no Docker.
 *
 * Predicate type: config
 * Check types:
 *   - Key existence (config key is present)
 *   - Value matching (key has expected value)
 *   - Source-specific parsing (.env, JSON, YAML, dotenv)
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GateContext, GateResult, Predicate, PredicateResult } from '../types.js';

// =============================================================================
// CONFIG PARSERS
// =============================================================================

/**
 * Parse a .env / dotenv file into key-value pairs.
 * Handles comments, blank lines, quoted values, and inline comments.
 */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Get a nested value from a JSON object using dot-notation key.
 * "database.host" → obj.database.host
 */
function getNestedValue(obj: unknown, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Simple YAML parser — handles flat key: value and basic nesting.
 * NOT a full YAML parser; covers the 80% case for config files.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: result }];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const content_line = trimmed.trim();
    const colonIdx = content_line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = content_line.slice(0, colonIdx).trim();
    let value = content_line.slice(colonIdx + 1).trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (value === '' || value === '|' || value === '>') {
      // Nested object
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      // Strip inline comments
      if (value.includes(' #')) {
        value = value.slice(0, value.indexOf(' #')).trim();
      }
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Parse booleans and numbers
      if (value === 'true') parent[key] = true;
      else if (value === 'false') parent[key] = false;
      else if (value === 'null') parent[key] = null;
      else if (/^-?\d+(\.\d+)?$/.test(value)) parent[key] = Number(value);
      else parent[key] = value;
    }
  }
  return result;
}

/**
 * Flatten a nested object into dot-notation keys.
 */
function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}

// =============================================================================
// CONFIG FILE DISCOVERY
// =============================================================================

/**
 * Find and parse config files from an app directory.
 * Returns a unified flat key→value map with source annotations.
 */
function loadConfigValues(
  appDir: string,
  source?: 'env' | 'json' | 'yaml' | 'dotenv',
): { values: Record<string, string>; sources: Record<string, string> } {
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};

  const candidates = [
    { file: '.env', type: 'dotenv' as const },
    { file: '.env.local', type: 'dotenv' as const },
    { file: '.env.production', type: 'dotenv' as const },
    { file: 'config.json', type: 'json' as const },
    { file: 'config.yaml', type: 'yaml' as const },
    { file: 'config.yml', type: 'yaml' as const },
    { file: 'package.json', type: 'json' as const },
  ];

  for (const { file, type } of candidates) {
    if (source && type !== source) continue;
    const filePath = join(appDir, file);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      let parsed: Record<string, string>;

      if (type === 'dotenv') {
        parsed = parseDotenv(content);
      } else if (type === 'json') {
        const json = JSON.parse(content);
        parsed = flattenObject(json);
      } else if (type === 'yaml') {
        const yaml = parseSimpleYaml(content);
        parsed = flattenObject(yaml);
      } else {
        continue;
      }

      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in values)) {
          values[key] = value;
          sources[key] = file;
        }
      }
    } catch { /* invalid file — skip */ }
  }

  return { values, sources };
}

// =============================================================================
// CONFIG GATE
// =============================================================================

export function runConfigGate(ctx: GateContext): GateResult & { predicateResults: PredicateResult[] } {
  const start = Date.now();
  const configPreds = ctx.predicates.filter(p => p.type === 'config');

  if (configPreds.length === 0) {
    return {
      gate: 'config' as any,
      passed: true,
      detail: 'No config predicates to check',
      durationMs: Date.now() - start,
      predicateResults: [],
    };
  }

  const results: PredicateResult[] = [];
  let allPassed = true;
  const details: string[] = [];

  for (let i = 0; i < configPreds.length; i++) {
    const p = configPreds[i];
    const result = validateConfigPredicate(p, ctx.stageDir ?? ctx.config.appDir);
    results.push({ ...result, predicateId: `cfg_p${i}` });

    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? 'failed');
    }
  }

  const passCount = results.filter(r => r.passed).length;
  const detail = allPassed
    ? `All ${configPreds.length} config predicates passed`
    : `${passCount}/${configPreds.length} passed: ${details.join('; ')}`;

  ctx.log(`[config] ${detail}`);

  return {
    gate: 'config' as any,
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results,
  };
}

function validateConfigPredicate(
  p: Predicate,
  appDir: string,
): Omit<PredicateResult, 'predicateId'> {
  const fingerprint = `type=config|key=${p.key}|source=${p.source ?? 'any'}`;

  if (!p.key) {
    return { type: 'config', passed: false, expected: 'config key', actual: '(no key specified)', fingerprint };
  }

  const { values, sources } = loadConfigValues(appDir, p.source);

  // Key existence check
  if (!(p.key in values)) {
    return {
      type: 'config',
      passed: false,
      expected: p.expected ?? `${p.key} exists`,
      actual: `key "${p.key}" not found in ${p.source ?? 'any config file'}`,
      fingerprint,
    };
  }

  const actualValue = values[p.key];
  const sourceFile = sources[p.key];

  // If no expected value, just check existence
  if (!p.expected || p.expected === 'exists') {
    return {
      type: 'config',
      passed: true,
      expected: `${p.key} exists`,
      actual: `${p.key} = "${actualValue}" (from ${sourceFile})`,
      fingerprint,
    };
  }

  // Value comparison
  const passed = actualValue === p.expected;
  return {
    type: 'config',
    passed,
    expected: `${p.key} == "${p.expected}"`,
    actual: `${p.key} = "${actualValue}" (from ${sourceFile})`,
    fingerprint,
  };
}
