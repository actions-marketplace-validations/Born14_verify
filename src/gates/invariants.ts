/**
 * Invariants Gate — System Health Checks
 * ========================================
 *
 * Operator-defined rules that must hold after EVERY change.
 * Unlike predicates (goal-scoped), invariants are system-scoped.
 *
 * Two types:
 * - http:    GET a path, check status and/or body contains
 * - command: Run a shell command in the container, check output
 *
 * Budget: 10s per check, 30s total.
 */

import type { GateResult, GateContext, Invariant, ContainerRunner } from '../types.js';

export interface InvariantResult {
  name: string;
  passed: boolean;
  durationMs: number;
  actual?: string;
  detail: string;
}

export interface InvariantsGateResult extends GateResult {
  results: InvariantResult[];
}

const PER_CHECK_TIMEOUT = 10_000;
const TOTAL_TIMEOUT = 30_000;

export async function runInvariantsGate(
  ctx: GateContext,
  invariants: Invariant[],
  runner?: ContainerRunner,
): Promise<InvariantsGateResult> {
  const start = Date.now();

  if (invariants.length === 0) {
    return {
      gate: 'invariants',
      passed: true,
      detail: 'No invariants configured',
      durationMs: 0,
      results: [],
    };
  }

  const results: InvariantResult[] = [];

  for (const inv of invariants) {
    if (Date.now() - start > TOTAL_TIMEOUT) {
      results.push({
        name: inv.name,
        passed: false,
        durationMs: 0,
        detail: 'Budget exceeded — skipped',
      });
      continue;
    }

    const checkStart = Date.now();

    if (inv.type === 'http') {
      const result = await checkHttpInvariant(inv, ctx.appUrl!);
      results.push({ ...result, durationMs: Date.now() - checkStart });
    } else if (inv.type === 'command' && runner) {
      const result = await checkCommandInvariant(inv, runner);
      results.push({ ...result, durationMs: Date.now() - checkStart });
    } else {
      results.push({
        name: inv.name,
        passed: true,
        durationMs: 0,
        detail: `Skipped — ${inv.type === 'command' ? 'no container runner' : 'unknown type'}`,
      });
    }
  }

  const allPassed = results.every(r => r.passed);

  return {
    gate: 'invariants',
    passed: allPassed,
    detail: allPassed
      ? `${results.length} invariant(s) passed`
      : `${results.filter(r => !r.passed).length}/${results.length} invariant(s) failed`,
    durationMs: Date.now() - start,
    results,
  };
}

async function checkHttpInvariant(
  inv: Invariant,
  appUrl: string,
): Promise<Omit<InvariantResult, 'durationMs'>> {
  const url = `${appUrl}${inv.path ?? '/'}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PER_CHECK_TIMEOUT);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const body = await resp.text();

    // Check status
    if (inv.expect?.status && resp.status !== inv.expect.status) {
      return {
        name: inv.name,
        passed: false,
        actual: `status ${resp.status}`,
        detail: `${inv.name}: expected status ${inv.expect.status}, got ${resp.status}`,
      };
    }

    // Check body contains
    if (inv.expect?.contains && !body.includes(inv.expect.contains)) {
      return {
        name: inv.name,
        passed: false,
        actual: body.substring(0, 100),
        detail: `${inv.name}: body missing "${inv.expect.contains}"`,
      };
    }

    return {
      name: inv.name,
      passed: true,
      detail: `${inv.name}: OK (status ${resp.status})`,
    };
  } catch (err: any) {
    return {
      name: inv.name,
      passed: false,
      detail: `${inv.name}: ${err.message}`,
    };
  }
}

async function checkCommandInvariant(
  inv: Invariant,
  runner: ContainerRunner,
): Promise<Omit<InvariantResult, 'durationMs'>> {
  if (!inv.command) {
    return { name: inv.name, passed: true, detail: `${inv.name}: no command specified — skipped` };
  }

  try {
    const result = await runner.exec(inv.command, { timeoutMs: PER_CHECK_TIMEOUT });

    if (inv.expect?.contains) {
      if (!result.stdout.includes(inv.expect.contains)) {
        return {
          name: inv.name,
          passed: false,
          actual: result.stdout.substring(0, 100),
          detail: `${inv.name}: output missing "${inv.expect.contains}"`,
        };
      }
    } else if (result.exitCode !== 0) {
      return {
        name: inv.name,
        passed: false,
        actual: `exit code ${result.exitCode}`,
        detail: `${inv.name}: command failed with exit code ${result.exitCode}`,
      };
    }

    return {
      name: inv.name,
      passed: true,
      detail: `${inv.name}: OK`,
    };
  } catch (err: any) {
    return {
      name: inv.name,
      passed: false,
      detail: `${inv.name}: ${err.message}`,
    };
  }
}
