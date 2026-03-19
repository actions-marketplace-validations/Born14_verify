/**
 * Staging Gate — Docker Build + Start + Health Check
 * ====================================================
 *
 * Builds the app in an ephemeral Docker container, starts it,
 * and verifies it boots without crashing. This catches:
 *
 * - Syntax errors that survive F9 (runtime errors)
 * - Missing dependencies
 * - Bad Docker configuration
 * - Import errors
 * - Crash-on-start bugs
 *
 * The container stays running for subsequent gates (browser, HTTP, invariants).
 */

import type { GateResult, GateContext, ContainerRunner } from '../types.js';

export interface StagingGateResult extends GateResult {
  /** Container logs on failure */
  logs?: string;
}

export async function runStagingGate(
  ctx: GateContext,
  runner: ContainerRunner,
): Promise<StagingGateResult> {
  const start = Date.now();

  // Determine if we need --no-cache (dependency files changed)
  const needsFullRebuild = ctx.edits.some(e => isBuildLayerFile(e.file));

  // Build
  ctx.log(`[staging] Building container${needsFullRebuild ? ' (full rebuild — dependency file changed)' : ' (cached)'}...`);
  const buildResult = await runner.build({ noCache: needsFullRebuild });

  if (buildResult.exitCode !== 0) {
    return {
      gate: 'staging',
      passed: false,
      detail: `Docker build failed: ${buildResult.stderr.substring(0, 200)}`,
      durationMs: Date.now() - start,
      logs: buildResult.stderr,
    };
  }

  // Start
  ctx.log('[staging] Starting container...');
  const startResult = await runner.start();

  if (startResult.exitCode !== 0) {
    return {
      gate: 'staging',
      passed: false,
      detail: `Container failed to start: ${startResult.stderr.substring(0, 200)}`,
      durationMs: Date.now() - start,
      logs: startResult.stderr,
    };
  }

  ctx.log(`[staging] Container healthy at ${runner.getAppUrl()}`);

  return {
    gate: 'staging',
    passed: true,
    detail: `Container built and healthy at ${runner.getAppUrl()}`,
    durationMs: Date.now() - start,
  };
}

/**
 * Build-layer files — changing these requires --no-cache.
 */
const BUILD_LAYER_FILES = new Set([
  'package.json', 'package-lock.json', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml',
  'requirements.txt', 'pipfile', 'pipfile.lock', 'pyproject.toml', 'poetry.lock',
  'go.mod', 'go.sum',
  'gemfile', 'gemfile.lock',
  'cargo.toml', 'cargo.lock',
  'composer.json', 'composer.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml',
]);

function isBuildLayerFile(file: string): boolean {
  const basename = file.split('/').pop()?.toLowerCase() ?? '';
  return BUILD_LAYER_FILES.has(basename);
}
