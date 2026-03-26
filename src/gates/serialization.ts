/**
 * Serialization Gate
 * ==================
 *
 * Validates JSON/data serialization predicates against parsed file content.
 * Pure file parsing — no network, no Docker.
 *
 * Predicate type: serialization
 * Check types:
 *   - Schema validation (JSON structure matches expected shape)
 *   - Structural comparison (same keys/types, different values ok)
 *   - Subset matching (response contains expected fields)
 *   - Float precision, null semantics, date formats, boolean handling
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { GateContext, GateResult, Predicate, PredicateResult } from '../types.js';

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Deep-compare two values with configurable comparison mode.
 */
function compareValues(
  actual: unknown,
  expected: unknown,
  mode: 'strict' | 'structural' | 'subset',
): { passed: boolean; detail: string } {
  if (mode === 'strict') {
    const match = JSON.stringify(actual) === JSON.stringify(expected);
    return {
      passed: match,
      detail: match ? 'exact match' : `value mismatch`,
    };
  }

  if (mode === 'structural') {
    return compareStructure(actual, expected);
  }

  if (mode === 'subset') {
    return checkSubset(actual, expected);
  }

  return { passed: false, detail: `unknown comparison mode: ${mode}` };
}

/**
 * Structural comparison — same keys and types, values may differ.
 */
function compareStructure(actual: unknown, expected: unknown): { passed: boolean; detail: string } {
  const actualType = typeof actual;
  const expectedType = typeof expected;

  if (actualType !== expectedType) {
    return { passed: false, detail: `type mismatch: expected ${expectedType}, got ${actualType}` };
  }

  if (actual === null && expected === null) return { passed: true, detail: 'both null' };
  if (actual === null || expected === null) {
    return { passed: false, detail: `null mismatch: ${actual === null ? 'actual' : 'expected'} is null` };
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { passed: false, detail: 'expected array, got non-array' };
    if (expected.length > 0 && actual.length === 0) {
      return { passed: false, detail: 'expected non-empty array, got empty' };
    }
    // Check first element structure if both have elements
    if (expected.length > 0 && actual.length > 0) {
      return compareStructure(actual[0], expected[0]);
    }
    return { passed: true, detail: 'array structure matches' };
  }

  if (actualType === 'object') {
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    const missingKeys = expectedKeys.filter(k => !actualKeys.includes(k));
    if (missingKeys.length > 0) {
      return { passed: false, detail: `missing keys: ${missingKeys.join(', ')}` };
    }
    return { passed: true, detail: 'structure matches' };
  }

  return { passed: true, detail: 'primitive type matches' };
}

/**
 * Subset check — actual contains all fields from expected.
 */
function checkSubset(actual: unknown, expected: unknown): { passed: boolean; detail: string } {
  if (typeof expected !== 'object' || expected === null) {
    return compareValues(actual, expected, 'strict');
  }

  if (typeof actual !== 'object' || actual === null) {
    return { passed: false, detail: 'expected object for subset check, got non-object' };
  }

  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;

  for (const [key, value] of Object.entries(expectedObj)) {
    if (!(key in actualObj)) {
      return { passed: false, detail: `missing key: ${key}` };
    }
    if (typeof value === 'object' && value !== null) {
      const sub = checkSubset(actualObj[key], value);
      if (!sub.passed) return { passed: false, detail: `${key}: ${sub.detail}` };
    } else {
      if (JSON.stringify(actualObj[key]) !== JSON.stringify(value)) {
        return { passed: false, detail: `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualObj[key])}` };
      }
    }
  }

  return { passed: true, detail: 'subset match' };
}

/**
 * Validate a JSON schema (simplified — checks type, required, properties).
 */
function validateSchema(
  data: unknown,
  schema: Record<string, unknown>,
): { passed: boolean; detail: string } {
  const rawType = schema.type;
  const schemaTypes: string[] | undefined = rawType
    ? (Array.isArray(rawType) ? rawType as string[] : [rawType as string])
    : undefined;

  if (schemaTypes) {
    const actualType = Array.isArray(data) ? 'array' : (data === null ? 'null' : typeof data);
    const matchesAny = schemaTypes.some(st => {
      if (st === 'integer') return typeof data === 'number' && Number.isInteger(data);
      return actualType === st;
    });
    if (!matchesAny) {
      return { passed: false, detail: `schema type mismatch: expected ${schemaTypes.join('|')}, got ${actualType}` };
    }
  }

  if (schemaTypes?.includes('object') && typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    const required = (schema.required as string[]) ?? [];
    for (const key of required) {
      if (!(key in obj)) {
        return { passed: false, detail: `missing required field: ${key}` };
      }
    }

    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          const result = validateSchema(obj[key], propSchema);
          if (!result.passed) return { passed: false, detail: `${key}: ${result.detail}` };
        }
      }
    }
  }

  if (schemaTypes?.includes('array') && Array.isArray(data)) {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items && data.length > 0) {
      const result = validateSchema(data[0], items);
      if (!result.passed) return { passed: false, detail: `items[0]: ${result.detail}` };
    }
  }

  return { passed: true, detail: 'schema valid' };
}

// =============================================================================
// SERIALIZATION GATE
// =============================================================================

export function runSerializationGate(ctx: GateContext): GateResult & { predicateResults: PredicateResult[] } {
  const start = Date.now();
  const serPreds = ctx.predicates.filter(p => p.type === 'serialization');

  if (serPreds.length === 0) {
    return {
      gate: 'serialization' as any,
      passed: true,
      detail: 'No serialization predicates to check',
      durationMs: Date.now() - start,
      predicateResults: [],
    };
  }

  const results: PredicateResult[] = [];
  let allPassed = true;
  const details: string[] = [];

  for (let i = 0; i < serPreds.length; i++) {
    const p = serPreds[i];
    const result = validateSerializationPredicate(p, ctx.stageDir ?? ctx.config.appDir);
    results.push({ ...result, predicateId: `ser_p${i}` });

    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? 'failed');
    }
  }

  const passCount = results.filter(r => r.passed).length;
  const detail = allPassed
    ? `All ${serPreds.length} serialization predicates passed`
    : `${passCount}/${serPreds.length} passed: ${details.join('; ')}`;

  ctx.log(`[serialization] ${detail}`);

  return {
    gate: 'serialization' as any,
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results,
  };
}

function validateSerializationPredicate(
  p: Predicate,
  appDir: string,
): Omit<PredicateResult, 'predicateId'> {
  const fingerprint = `type=serialization|file=${p.file}|comparison=${p.comparison ?? 'strict'}`;

  if (!p.file) {
    return { type: 'serialization', passed: false, expected: 'file path', actual: '(no file specified)', fingerprint };
  }

  const filePath = join(appDir, p.file);
  if (!existsSync(filePath)) {
    return { type: 'serialization', passed: false, expected: `file ${p.file} exists`, actual: 'file not found', fingerprint };
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return { type: 'serialization', passed: false, expected: 'valid JSON', actual: `parse error: ${(e as Error).message}`, fingerprint };
  }

  // Schema validation mode
  if (p.schema) {
    const result = validateSchema(data, p.schema);
    return {
      type: 'serialization',
      passed: result.passed,
      expected: 'matches schema',
      actual: result.detail,
      fingerprint,
    };
  }

  // Comparison mode (against expected value)
  if (p.expected) {
    let expectedData: unknown;
    try {
      expectedData = JSON.parse(p.expected);
    } catch {
      return { type: 'serialization', passed: false, expected: p.expected, actual: 'invalid expected JSON', fingerprint };
    }

    const mode = p.comparison ?? 'strict';
    const result = compareValues(data, expectedData, mode);
    return {
      type: 'serialization',
      passed: result.passed,
      expected: `${mode}: ${p.expected.substring(0, 50)}`,
      actual: result.detail,
      fingerprint,
    };
  }

  // Default: just check it's valid JSON (already parsed above)
  return { type: 'serialization', passed: true, expected: 'valid JSON', actual: 'valid JSON', fingerprint };
}
