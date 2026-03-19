/**
 * HTTP Gate — Endpoint Validation
 * =================================
 *
 * Validates HTTP and HTTP sequence predicates against the running staging container.
 * Direct fetch() — no docker exec, no SSH.
 *
 * Catches:
 * - API endpoints that return wrong status codes
 * - Response bodies missing expected content
 * - Multi-step flows that break (POST create → GET verify)
 */

import type { GateResult, GateContext, Predicate } from '../types.js';

export interface HttpPredicateResult {
  predicate: Partial<Predicate>;
  passed: boolean;
  expected?: string;
  actual?: string;
  detail: string;
}

export interface HttpGateResult extends GateResult {
  results: HttpPredicateResult[];
}

const REQUEST_TIMEOUT = 10_000;
const TOTAL_TIMEOUT = 30_000;

export async function runHttpGate(ctx: GateContext): Promise<HttpGateResult> {
  const start = Date.now();
  const appUrl = ctx.appUrl;

  if (!appUrl) {
    return {
      gate: 'http',
      passed: false,
      detail: 'No app URL available — staging gate must run first',
      durationMs: Date.now() - start,
      results: [],
    };
  }

  const httpPredicates = ctx.predicates.filter(
    p => p.type === 'http' || p.type === 'http_sequence'
  );

  if (httpPredicates.length === 0) {
    return {
      gate: 'http',
      passed: true,
      detail: 'No HTTP predicates to check',
      durationMs: Date.now() - start,
      results: [],
    };
  }

  const results: HttpPredicateResult[] = [];

  for (const pred of httpPredicates) {
    if (Date.now() - start > TOTAL_TIMEOUT) {
      results.push({
        predicate: pred,
        passed: false,
        detail: 'HTTP gate total timeout exceeded',
      });
      continue;
    }

    if (pred.type === 'http') {
      const result = await validateHttp(appUrl, pred);
      results.push(result);
    } else if (pred.type === 'http_sequence') {
      const result = await validateHttpSequence(appUrl, pred);
      results.push(result);
    }
  }

  const allPassed = results.every(r => r.passed);

  return {
    gate: 'http',
    passed: allPassed,
    detail: allPassed
      ? `${results.length} HTTP predicate(s) passed`
      : `${results.filter(r => !r.passed).length}/${results.length} HTTP predicate(s) failed`,
    durationMs: Date.now() - start,
    results,
  };
}

async function validateHttp(baseUrl: string, pred: Predicate): Promise<HttpPredicateResult> {
  const method = pred.method ?? 'GET';
  const url = `${baseUrl}${pred.path ?? '/'}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const fetchOpts: RequestInit = {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    };

    if (pred.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      fetchOpts.body = JSON.stringify(pred.body);
    }

    const resp = await fetch(url, fetchOpts);
    clearTimeout(timeout);

    const body = await resp.text();

    // Check status
    if (pred.expect?.status && resp.status !== pred.expect.status) {
      return {
        predicate: pred,
        passed: false,
        expected: `status ${pred.expect.status}`,
        actual: `status ${resp.status}`,
        detail: `${method} ${pred.path}: expected status ${pred.expect.status}, got ${resp.status}`,
      };
    }

    // Check body contains
    if (pred.expect?.bodyContains) {
      const terms = Array.isArray(pred.expect.bodyContains)
        ? pred.expect.bodyContains
        : [pred.expect.bodyContains];

      for (const term of terms) {
        if (!body.includes(term)) {
          return {
            predicate: pred,
            passed: false,
            expected: `body contains "${term}"`,
            actual: body.substring(0, 200),
            detail: `${method} ${pred.path}: body missing "${term}"`,
          };
        }
      }
    }

    // Check body regex
    if (pred.expect?.bodyRegex) {
      const regex = new RegExp(pred.expect.bodyRegex);
      if (!regex.test(body)) {
        return {
          predicate: pred,
          passed: false,
          expected: `body matches /${pred.expect.bodyRegex}/`,
          actual: body.substring(0, 200),
          detail: `${method} ${pred.path}: body doesn't match regex`,
        };
      }
    }

    return {
      predicate: pred,
      passed: true,
      detail: `${method} ${pred.path}: status ${resp.status} OK`,
    };
  } catch (err: any) {
    return {
      predicate: pred,
      passed: false,
      detail: `${method} ${pred.path}: ${err.message}`,
    };
  }
}

async function validateHttpSequence(baseUrl: string, pred: Predicate): Promise<HttpPredicateResult> {
  if (!pred.steps || pred.steps.length === 0) {
    return { predicate: pred, passed: true, detail: 'No steps in sequence' };
  }

  for (let i = 0; i < pred.steps.length; i++) {
    const step = pred.steps[i];
    const url = `${baseUrl}${step.path}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const fetchOpts: RequestInit = {
        method: step.method,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      };

      if (step.body && (step.method === 'POST' || step.method === 'PUT')) {
        fetchOpts.body = JSON.stringify(step.body);
      }

      const resp = await fetch(url, fetchOpts);
      clearTimeout(timeout);

      const body = await resp.text();

      if (step.expect?.status && resp.status !== step.expect.status) {
        return {
          predicate: pred,
          passed: false,
          expected: `step ${i + 1}: status ${step.expect.status}`,
          actual: `status ${resp.status}`,
          detail: `Step ${i + 1} (${step.method} ${step.path}): expected ${step.expect.status}, got ${resp.status}`,
        };
      }

      if (step.expect?.bodyContains) {
        const terms = Array.isArray(step.expect.bodyContains)
          ? step.expect.bodyContains
          : [step.expect.bodyContains];

        for (const term of terms) {
          if (!body.includes(term)) {
            return {
              predicate: pred,
              passed: false,
              expected: `step ${i + 1}: body contains "${term}"`,
              actual: body.substring(0, 200),
              detail: `Step ${i + 1} (${step.method} ${step.path}): body missing "${term}"`,
            };
          }
        }
      }
    } catch (err: any) {
      return {
        predicate: pred,
        passed: false,
        detail: `Step ${i + 1} (${step.method} ${step.path}): ${err.message}`,
      };
    }
  }

  return {
    predicate: pred,
    passed: true,
    detail: `All ${pred.steps.length} step(s) passed`,
  };
}
