/**
 * LocalDockerRunner — Ephemeral container management for verification.
 *
 * Builds, starts, and tears down Docker containers locally.
 * No SSH. No remote servers. No production access.
 * The container lives only as long as the verification run.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import type { ContainerRunner, CommandResult, VerifyConfig } from '../types.js';

const DEFAULT_PORT = 3000;
const DEFAULT_HEALTH_PATH = '/';
const DEFAULT_STARTUP_TIMEOUT = 60_000;
const DEFAULT_BUILD_TIMEOUT = 120_000;

export class LocalDockerRunner implements ContainerRunner {
  private readonly appDir: string;
  private readonly composefile: string;
  private readonly service: string;
  private readonly internalPort: number;
  private readonly healthPath: string;
  private readonly startupTimeout: number;
  private readonly buildTimeout: number;
  private readonly projectName: string;
  private hostPort: number = 0;
  private running = false;

  constructor(config: VerifyConfig) {
    this.appDir = config.appDir;
    this.composefile = config.docker?.composefile ?? 'docker-compose.yml';
    this.service = config.docker?.service ?? 'app';
    this.internalPort = config.docker?.port ?? DEFAULT_PORT;
    this.healthPath = config.docker?.healthPath ?? DEFAULT_HEALTH_PATH;
    this.startupTimeout = config.docker?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT;
    this.buildTimeout = config.docker?.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT;

    // Unique project name to avoid collisions with user's own containers
    this.projectName = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Pick a random host port in the ephemeral range
    this.hostPort = 13000 + Math.floor(Math.random() * 1000);
  }

  async build(opts?: { noCache?: boolean; timeoutMs?: number }): Promise<CommandResult> {
    const args = [
      'compose', '-f', this.composefile, '-p', this.projectName,
      'build', this.service,
    ];
    if (opts?.noCache) args.push('--no-cache');

    return this.run('docker', args, {
      timeoutMs: opts?.timeoutMs ?? this.buildTimeout,
      cwd: this.appDir,
    });
  }

  async start(opts?: { timeoutMs?: number }): Promise<CommandResult> {
    const timeout = opts?.timeoutMs ?? this.startupTimeout;

    // Start with port mapping override
    const result = await this.run('docker', [
      'compose', '-f', this.composefile, '-p', this.projectName,
      'up', '-d', '--build', this.service,
    ], {
      timeoutMs: this.buildTimeout + timeout,
      cwd: this.appDir,
      env: {
        ...process.env,
        // Override port mapping: host:container
        VERIFY_HOST_PORT: String(this.hostPort),
      },
    });

    if (result.exitCode !== 0) return result;

    // Wait for healthy
    const deadline = Date.now() + timeout;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        healthy = await this.isHealthy();
        if (healthy) break;
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!healthy) {
      const logs = await this.run('docker', [
        'compose', '-f', this.composefile, '-p', this.projectName,
        'logs', '--tail', '50', this.service,
      ], { cwd: this.appDir });

      return {
        stdout: '',
        stderr: `Container failed to become healthy within ${timeout}ms.\n\nContainer logs:\n${logs.stdout}\n${logs.stderr}`,
        exitCode: 1,
      };
    }

    this.running = true;
    return { stdout: `Container started on port ${this.hostPort}`, stderr: '', exitCode: 0 };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    try {
      await this.run('docker', [
        'compose', '-f', this.composefile, '-p', this.projectName,
        'down', '-v', '--remove-orphans',
      ], {
        cwd: this.appDir,
        timeoutMs: 30_000,
      });
    } catch {
      // Best effort cleanup
    }
    this.running = false;
  }

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult> {
    const containerName = this.getContainerName();
    return this.run('docker', [
      'exec', containerName, 'sh', '-c', command,
    ], { timeoutMs: opts?.timeoutMs ?? 10_000 });
  }

  getAppUrl(): string {
    return `http://localhost:${this.hostPort}`;
  }

  getContainerName(): string {
    return `${this.projectName}-${this.service}-1`;
  }

  async isHealthy(path?: string): Promise<boolean> {
    const url = `${this.getAppUrl()}${path ?? this.healthPath}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return resp.status < 500;
    } catch {
      return false;
    }
  }

  getHostPort(): number {
    return this.hostPort;
  }

  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Internal: shell command execution
  // -------------------------------------------------------------------------

  private run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const cwd = opts?.cwd ?? this.appDir;
      const child = spawn(cmd, args, {
        cwd,
        env: opts?.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          }, opts.timeoutMs)
        : undefined;

      child.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exitCode: 1 });
      });
    });
  }
}

/**
 * Check if Docker is available on this machine.
 */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Check if a docker-compose file exists in the given directory.
 */
export function hasDockerCompose(appDir: string, composefile?: string): boolean {
  const candidates = composefile
    ? [composefile]
    : ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

  return candidates.some(f => existsSync(join(appDir, f)));
}
