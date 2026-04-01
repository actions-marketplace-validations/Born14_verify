#!/usr/bin/env bun
/**
 * Record demo output as asciinema v2 cast file.
 * Captures real terminal output with timing, outputs .cast JSON.
 *
 * Usage:
 *   bun run scripts/record-demo.ts liar > demo-liar.cast
 *   bun run scripts/record-demo.ts world > demo-world.cast
 *   bun run scripts/record-demo.ts drift > demo-drift.cast
 *   bun run scripts/record-demo.ts all > demo-all.cast
 *
 * Then convert to SVG:
 *   cat demo-liar.cast | npx svg-term-cli --out demo-liar.svg --window --no-cursor --width 85 --height 40
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const scenario = process.argv[2] || 'liar';

// Asciinema v2 header
const header = {
  version: 2,
  width: 85,
  height: 40,
  timestamp: Math.floor(Date.now() / 1000),
  env: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
};

const events: Array<[number, string, string]> = [];
const startTime = Date.now();

function elapsed(): number {
  return (Date.now() - startTime) / 1000;
}

async function recordScenario(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Add a prompt line before the command
    const cmd = `npx @sovereign-labs/verify demo --scenario=${name}`;
    events.push([elapsed(), 'o', `\x1b[32m$\x1b[0m ${cmd}\r\n`]);

    const child = spawn('bun', ['run', 'src/cli.ts', 'demo', `--scenario=${name}`], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: process.platform === 'win32',
    });

    child.stdout.on('data', (data: Buffer) => {
      // Split into lines to add slight delays between them for animation
      const text = data.toString();
      events.push([elapsed(), 'o', text]);
    });

    child.stderr.on('data', (data: Buffer) => {
      // Capture stderr too (some output goes here)
      events.push([elapsed(), 'o', data.toString()]);
    });

    child.on('close', (code) => {
      // Add a small pause at the end
      events.push([elapsed() + 0.5, 'o', '\r\n']);
      resolve();
    });

    child.on('error', reject);
  });
}

async function main() {
  if (scenario === 'all') {
    await recordScenario('liar');
    events.push([elapsed() + 1, 'o', '\r\n']);
    await recordScenario('world');
    events.push([elapsed() + 1, 'o', '\r\n']);
    await recordScenario('drift');
  } else {
    await recordScenario(scenario);
  }

  // Output asciinema v2 format
  process.stdout.write(JSON.stringify(header) + '\n');
  for (const event of events) {
    process.stdout.write(JSON.stringify(event) + '\n');
  }
}

main().catch(console.error);
