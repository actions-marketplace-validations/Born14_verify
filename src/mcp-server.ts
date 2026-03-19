#!/usr/bin/env node
/**
 * @sovereign-labs/verify MCP Server
 * ==================================
 *
 * Exposes verify as MCP tools that any coding agent can call.
 * Three tools:
 *
 *   verify_ground  — Read grounding context (CSS, HTML, routes) before crafting edits
 *   verify_read    — Read a source file from the app directory
 *   verify_submit  — Submit edits + predicates through the verification pipeline
 *
 * Usage:
 *   Add to your MCP client config:
 *   {
 *     "mcpServers": {
 *       "verify": {
 *         "command": "npx",
 *         "args": ["@sovereign-labs/verify", "mcp"]
 *       }
 *     }
 *   }
 */

import { createInterface } from 'readline';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { verify } from './verify.js';
import { groundInReality } from './gates/grounding.js';
import type { Edit, Predicate, VerifyConfig } from './types.js';

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// MCP protocol types
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

const SERVER_INFO = {
  name: '@sovereign-labs/verify',
  version: '0.1.0',
};

const CAPABILITIES = {
  tools: {},
};

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

const TOOLS: Tool[] = [
  {
    name: 'verify_ground',
    description: '[READ-ONLY] Scan the app source code and return grounding context: CSS selectors with properties and values, HTML elements, available routes. Use this BEFORE crafting edits to understand what actually exists in the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        appDir: {
          type: 'string',
          description: 'Path to the app directory to scan. Defaults to current directory.',
        },
      },
    },
  },
  {
    name: 'verify_read',
    description: '[READ-ONLY] Read a source file from the app directory. Use this to get exact file contents before crafting search/replace edits.',
    inputSchema: {
      type: 'object',
      properties: {
        appDir: {
          type: 'string',
          description: 'Path to the app directory.',
        },
        file: {
          type: 'string',
          description: 'Relative path to the file within the app directory.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'verify_submit',
    description: '[MUTATION] Submit code edits and predicates through the verification pipeline. Edits are applied to a staging container, validated against predicates, and checked for system health. Returns success/failure with narrowing hints on what to try next if it fails.',
    inputSchema: {
      type: 'object',
      properties: {
        appDir: {
          type: 'string',
          description: 'Path to the app directory.',
        },
        goal: {
          type: 'string',
          description: 'Human-readable description of what the edits accomplish.',
        },
        edits: {
          type: 'array',
          description: 'Array of file edits. Each edit has file (relative path), search (exact string to find), and replace (replacement string).',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'Relative file path' },
              search: { type: 'string', description: 'Exact string to find (must appear exactly once)' },
              replace: { type: 'string', description: 'Replacement string' },
            },
            required: ['file', 'search', 'replace'],
          },
        },
        predicates: {
          type: 'array',
          description: 'Testable claims about the end state. Types: css (selector + property + expected value), html (selector exists or has text), content (file contains pattern), http (endpoint returns expected response), http_sequence (ordered multi-step flow).',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['css', 'html', 'content', 'db', 'http', 'http_sequence'] },
              selector: { type: 'string' },
              property: { type: 'string' },
              expected: { type: 'string' },
              path: { type: 'string' },
              file: { type: 'string' },
              description: { type: 'string' },
              pattern: { type: 'string' },
              method: { type: 'string' },
              body: { type: 'object' },
              expect: { type: 'object' },
              steps: { type: 'array' },
            },
            required: ['type'],
          },
        },
        overrideConstraints: {
          type: 'array',
          description: 'Optional: constraint signatures to override (bypass learned restrictions).',
          items: { type: 'string' },
        },
      },
      required: ['edits', 'predicates'],
    },
  },
];

// =============================================================================
// TOOL HANDLERS
// =============================================================================

async function handleToolCall(name: string, args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case 'verify_ground':
      return handleGround(args);
    case 'verify_read':
      return handleRead(args);
    case 'verify_submit':
      return handleSubmit(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function handleGround(args: any) {
  const appDir = resolve(args.appDir ?? process.cwd());

  if (!existsSync(appDir)) {
    return text(`App directory not found: ${appDir}`);
  }

  const grounding = groundInReality(appDir);

  const sections: string[] = [];

  // Routes
  if (grounding.routes.length > 0) {
    sections.push(`Routes:\n${grounding.routes.map(r => `  ${r}`).join('\n')}`);
  }

  // CSS
  for (const [route, rules] of grounding.routeCSSMap) {
    if (rules.size === 0) continue;
    const lines = [...rules.entries()].map(([sel, props]) => {
      const propStr = Object.entries(props).map(([k, v]) => `${k}: ${v}`).join('; ');
      return `  ${sel} { ${propStr} }`;
    });
    sections.push(`CSS (${route}):\n${lines.join('\n')}`);
  }

  // HTML
  for (const [route, elements] of grounding.htmlElements) {
    if (elements.length === 0) continue;
    const lines = elements.slice(0, 30).map(el => {
      const attrs = el.attributes ? ` ${Object.entries(el.attributes).map(([k, v]) => `${k}="${v}"`).join(' ')}` : '';
      return `  <${el.tag}${attrs}>${el.text ?? ''}</${el.tag}>`;
    });
    sections.push(`HTML (${route}):\n${lines.join('\n')}`);
  }

  return text(sections.join('\n\n') || 'No grounding context found. Check that the app directory contains source files.');
}

function handleRead(args: any) {
  const appDir = resolve(args.appDir ?? process.cwd());
  const filePath = join(appDir, args.file);

  if (!existsSync(filePath)) {
    return text(`File not found: ${args.file}`);
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return text(content);
  } catch (err: any) {
    return text(`Error reading file: ${err.message}`);
  }
}

async function handleSubmit(args: any) {
  const appDir = resolve(args.appDir ?? process.cwd());

  if (!existsSync(appDir)) {
    return text(`App directory not found: ${appDir}`);
  }

  const edits: Edit[] = args.edits ?? [];
  const predicates: Predicate[] = args.predicates ?? [];

  if (edits.length === 0) {
    return text('No edits provided.');
  }
  if (predicates.length === 0) {
    return text('No predicates provided. At least one predicate is required.');
  }

  const logs: string[] = [];
  const config: VerifyConfig = {
    appDir,
    goal: args.goal,
    docker: { compose: true },
    stateDir: join(appDir, '.verify'),
    overrideConstraints: args.overrideConstraints,
    log: (msg: string) => logs.push(msg),
  };

  const result = await verify(edits, predicates, config);

  // Format response
  const sections: string[] = [];

  sections.push(result.attestation);

  if (result.success) {
    sections.push(`\nAll gates passed. Edits are verified.`);
  } else {
    if (result.narrowing?.resolutionHint) {
      sections.push(`\nResolution: ${result.narrowing.resolutionHint}`);
    }
    if (result.narrowing?.patternRecall && result.narrowing.patternRecall.length > 0) {
      sections.push(`\nKnown fixes:\n${result.narrowing.patternRecall.map(f => `  - ${f}`).join('\n')}`);
    }
    if (result.narrowing?.bannedFingerprints && result.narrowing.bannedFingerprints.length > 0) {
      sections.push(`\nBanned predicates (failed before):\n${result.narrowing.bannedFingerprints.map(f => `  - ${f}`).join('\n')}`);
    }
    if (result.effectivePredicates && result.effectivePredicates.length > 0) {
      sections.push(`\nEffective predicates:\n${result.effectivePredicates.map(p =>
        `  ${p.id}: [${p.type}] ${p.description ?? p.fingerprint}${p.groundingMiss ? ' (ungrounded)' : ''}`
      ).join('\n')}`);
    }
  }

  sections.push(`\nTiming: ${result.timing.totalMs}ms total`);

  return text(sections.join('\n'));
}

function text(content: string) {
  return { content: [{ type: 'text', text: content }] };
}

// =============================================================================
// MCP PROTOCOL HANDLER
// =============================================================================

function handleMessage(request: JsonRpcRequest): JsonRpcResponse | null {
  switch (request.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES,
        },
      };

    case 'notifications/initialized':
      return null; // No response needed

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { tools: TOOLS },
      };

    default:
      return null; // Handled async
  }
}

async function handleMessageAsync(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params ?? {};
    try {
      const result = await handleToolCall(name, args ?? {});
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: err.message },
      };
    }
  }
  return null;
}

// =============================================================================
// STDIO TRANSPORT
// =============================================================================

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line);
  } catch {
    return; // Ignore malformed input
  }

  // Try sync handler first
  const syncResponse = handleMessage(request);
  if (syncResponse) {
    process.stdout.write(JSON.stringify(syncResponse) + '\n');
    return;
  }

  // Try async handler
  const asyncResponse = await handleMessageAsync(request);
  if (asyncResponse) {
    process.stdout.write(JSON.stringify(asyncResponse) + '\n');
  }
});

rl.on('close', () => process.exit(0));
