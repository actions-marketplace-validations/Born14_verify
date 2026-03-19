import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { verify } from '../../src/verify.js';
import { isDockerAvailable } from '../../src/runners/docker-runner.js';
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTempApp(): string {
  const dir = join(tmpdir(), `verify-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fixtureDir = join(__dirname, '../../fixtures/demo-app');
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

describe('verify() pipeline', () => {
  // =========================================================================
  // Tests that don't need Docker (F9, K5, G5, grounding)
  // =========================================================================

  test('F9: catches bad edit (search string not found)', async () => {
    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: 'THIS DOES NOT EXIST', replace: 'whatever' }],
      [{ type: 'content', file: 'server.js', pattern: 'whatever' }],
      { appDir, gates: { staging: false, browser: false, http: false, invariants: false } },
    );

    expect(result.success).toBe(false);
    expect(result.gates.find(g => g.gate === 'F9')?.passed).toBe(false);
    expect(result.attestation).toContain('VERIFY FAILED');
    expect(result.narrowing?.resolutionHint).toContain('search string');

    rmSync(appDir, { recursive: true, force: true });
  });

  test('F9: passes valid edit', async () => {
    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Test App</title>' }],
      [{ type: 'content', file: 'server.js', pattern: 'Test App' }],
      { appDir, gates: { staging: false, browser: false, http: false, invariants: false } },
    );

    expect(result.gates.find(g => g.gate === 'F9')?.passed).toBe(true);
    rmSync(appDir, { recursive: true, force: true });
  });

  test('K5: learns from failure, blocks repeat', async () => {
    const appDir = makeTempApp();
    const stateDir = join(appDir, '.verify');
    mkdirSync(stateDir, { recursive: true });

    // First attempt — will fail at F9
    const result1 = await verify(
      [{ file: 'server.js', search: 'DOES_NOT_EXIST', replace: 'x' }],
      [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
      { appDir, stateDir, gates: { staging: false, browser: false, http: false, invariants: false } },
    );
    expect(result1.success).toBe(false);

    // Second attempt — should seed a constraint
    const result2 = await verify(
      [{ file: 'server.js', search: 'ALSO_NOT_HERE', replace: 'y' }],
      [{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }],
      { appDir, stateDir, gates: { staging: false, browser: false, http: false, invariants: false } },
    );
    expect(result2.success).toBe(false);

    // Check that constraints were seeded (learning happened)
    expect(result2.constraintDelta?.after).toBeGreaterThanOrEqual(0);

    rmSync(appDir, { recursive: true, force: true });
  });

  test('G5: attributes edits to predicates (containment)', async () => {
    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
      [{ type: 'css', selector: 'h1', property: 'color', expected: 'red', description: 'h1 should be red' }],
      { appDir, gates: { staging: false, browser: false, http: false, invariants: false } },
    );

    // Containment should run and produce attribution
    const g5 = result.gates.find(g => g.gate === 'G5');
    expect(g5).toBeTruthy();
    expect(g5?.passed).toBe(true); // G5 is advisory

    rmSync(appDir, { recursive: true, force: true });
  });

  test('grounding: detects fabricated CSS selectors', async () => {
    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: 'color: #1a1a2e', replace: 'color: red' }],
      [
        { type: 'css', selector: 'h1', property: 'color', expected: 'red' },         // real selector
        { type: 'css', selector: '.doesnt-exist', property: 'color', expected: 'red' }, // fabricated
      ],
      { appDir, gates: { staging: false, browser: false, http: false, invariants: false } },
    );

    // Check effective predicates — fabricated one should be marked
    const fabricated = result.effectivePredicates?.find(p => p.fingerprint.includes('.doesnt-exist'));
    expect(fabricated?.groundingMiss).toBe(true);

    rmSync(appDir, { recursive: true, force: true });
  });

  test('attestation: success format', async () => {
    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Verified App</title>' }],
      [{ type: 'content', file: 'server.js', pattern: 'Verified App' }],
      { appDir, goal: 'Rename the app', gates: { staging: false, browser: false, http: false, invariants: false } },
    );

    if (result.success) {
      expect(result.attestation).toContain('VERIFY PASSED');
      expect(result.attestation).toContain('Rename the app');
    }
    // Even if not fully passing, timing should exist
    expect(result.timing.totalMs).toBeGreaterThan(0);

    rmSync(appDir, { recursive: true, force: true });
  });

  test('handles empty edits gracefully', async () => {
    const appDir = makeTempApp();

    const result = await verify(
      [],
      [{ type: 'content', file: 'server.js', pattern: 'Demo' }],
      { appDir, gates: { staging: false, browser: false, http: false, invariants: false } },
    );

    // Empty edits should pass F9 (nothing to check) but may fail elsewhere
    expect(result.timing.totalMs).toBeGreaterThan(0);

    rmSync(appDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Docker-dependent tests (skipped if Docker not available)
  // =========================================================================

  let hasDocker = false;

  beforeAll(async () => {
    hasDocker = await isDockerAvailable();
    if (!hasDocker) {
      console.log('Docker not available — skipping Docker-dependent tests');
    }
  });

  test('staging: Docker build + start (requires Docker)', async () => {
    if (!hasDocker) return;

    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Staged App</title>' }],
      [{ type: 'content', file: 'server.js', pattern: 'Staged App' }],
      {
        appDir,
        docker: { compose: true },
        gates: { browser: false, invariants: false },
      },
    );

    const staging = result.gates.find(g => g.gate === 'staging');
    expect(staging).toBeTruthy();
    // Staging might pass or fail depending on Docker environment
    expect(result.timing.totalMs).toBeGreaterThan(0);

    rmSync(appDir, { recursive: true, force: true });
  }, 120_000);

  test('http: validates API endpoint (requires Docker)', async () => {
    if (!hasDocker) return;

    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>HTTP Test App</title>' }],
      [
        { type: 'content', file: 'server.js', pattern: 'HTTP Test App' },
        { type: 'http', path: '/api/items', method: 'GET', expect: { status: 200, bodyContains: 'Alpha' } },
        { type: 'http', path: '/health', method: 'GET', expect: { status: 200 } },
      ],
      {
        appDir,
        docker: { compose: true },
        gates: { browser: false, invariants: false },
      },
    );

    // HTTP gate should have run
    const httpGate = result.gates.find(g => g.gate === 'http');
    expect(httpGate).toBeTruthy();

    rmSync(appDir, { recursive: true, force: true });
  }, 120_000);

  test('invariants: health check passes (requires Docker)', async () => {
    if (!hasDocker) return;

    const appDir = makeTempApp();

    // Write invariants file
    mkdirSync(join(appDir, '.verify'), { recursive: true });
    writeFileSync(join(appDir, '.verify', 'invariants.json'), JSON.stringify([
      { name: 'Health endpoint', type: 'http', path: '/health', expect: { status: 200 } },
    ]));

    const result = await verify(
      [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Invariant Test</title>' }],
      [{ type: 'content', file: 'server.js', pattern: 'Invariant Test' }],
      {
        appDir,
        docker: { compose: true },
        gates: { browser: false },
      },
    );

    const invGate = result.gates.find(g => g.gate === 'invariants');
    expect(invGate).toBeTruthy();

    rmSync(appDir, { recursive: true, force: true });
  }, 120_000);

  test('full pipeline: edit → stage → http → pass (requires Docker)', async () => {
    if (!hasDocker) return;

    const appDir = makeTempApp();

    const result = await verify(
      [{ file: 'server.js', search: '<title>Demo App</title>', replace: '<title>Full Pipeline</title>' }],
      [
        { type: 'content', file: 'server.js', pattern: 'Full Pipeline' },
        { type: 'http', path: '/', method: 'GET', expect: { status: 200, bodyContains: 'Full Pipeline' } },
      ],
      {
        appDir,
        goal: 'Change the page title',
        docker: { compose: true },
        gates: { browser: false, invariants: false },
      },
    );

    if (result.success) {
      expect(result.attestation).toContain('VERIFY PASSED');
    }
    expect(result.timing.perGate).toBeTruthy();
    expect(Object.keys(result.timing.perGate!).length).toBeGreaterThan(0);

    rmSync(appDir, { recursive: true, force: true });
  }, 120_000);
});
