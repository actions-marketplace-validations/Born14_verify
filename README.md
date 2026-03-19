# @sovereign-labs/verify

Verification gate for AI-generated code. Every edit gets a fair trial before it touches your users.

**For any coding agent** — Cursor, Aider, OpenHands, Claude Code, or your own.

## It found its own bug

In v0.1.1, HTTP predicates with different `bodyContains` values produced identical fingerprints — K5 couldn't tell them apart. A human caught it by reading the code.

Now 56 automated scenarios catch it in under 2 seconds:

```bash
npx @sovereign-labs/verify self-test

#   0 bugs | 50 scenarios | 0 unexpected | A: clean, B: clean, C: clean ...
#   ALL CLEAN — No invariant violations detected.
```

The test that catches the v0.1.1 bug is scenario A10. It will never regress again.

## What it does

Your agent proposes edits. `verify()` checks them:

```
F9 (syntax) → K5 (constraints) → G5 (containment) →
Staging (Docker) → Browser (Playwright) → HTTP (fetch) →
Invariants (health)
```

On **success**: returns proof that the edits work.
On **failure**: returns what went wrong + what to try next.
On **repeat failure**: K5 learns from mistakes, so attempt N+1 has a smaller, smarter search space.

## Install

```bash
npm install @sovereign-labs/verify
# or
bun add @sovereign-labs/verify
```

## Quick Start

### 1. As a library

```typescript
import { verify } from '@sovereign-labs/verify';

const result = await verify(
  // Edits: search-and-replace mutations
  [
    { file: 'server.js', search: 'color: blue', replace: 'color: red' },
    { file: 'server.js', search: 'Hello', replace: 'Welcome' },
  ],
  // Predicates: what should be true after the edits
  [
    { type: 'css', selector: 'h1', property: 'color', expected: 'red' },
    { type: 'content', file: 'server.js', pattern: 'Welcome' },
    { type: 'http', path: '/health', method: 'GET', expect: { status: 200 } },
  ],
  // Config
  { appDir: './my-app' }
);

if (result.success) {
  console.log(result.attestation);
  // VERIFY PASSED
  // Gates: F9✓ K5✓ G5✓ Staging✓ Browser✓ HTTP✓
} else {
  console.log(result.narrowing);
  // { resolutionHint: "...", constraints: [...], bannedFingerprints: [...] }
}
```

### 2. As a CLI

```bash
# Initialize config
npx @sovereign-labs/verify init

# Run verification from a spec file
npx @sovereign-labs/verify check

# Pipe git diff directly
git diff | npx @sovereign-labs/verify check --diff

# Scan grounding context (what CSS/HTML/routes exist)
npx @sovereign-labs/verify ground

# Check Docker + Playwright availability
npx @sovereign-labs/verify doctor
```

### 3. As an MCP server

Add to your agent's MCP config:

```json
{
  "mcpServers": {
    "verify": {
      "command": "npx",
      "args": ["@sovereign-labs/verify", "mcp"]
    }
  }
}
```

Tools exposed:
- `verify_ground` — Scan app for CSS rules, HTML elements, routes, schema
- `verify_read` — Read a source file
- `verify_submit` — Submit edits + predicates through the full gate pipeline

## Self-Test Harness

56 scenarios across 7 families exercise the verification pipeline's invariants. Run them to prove your install works, or use `--fail-on-bug` in CI.

```bash
# Pure-only (~2s, no Docker needed)
npx @sovereign-labs/verify self-test

# Full suite with Docker (~80s)
npx @sovereign-labs/verify self-test --docker

# Specific families
npx @sovereign-labs/verify self-test --families=A,B,G

# CI mode — exit 1 on bug-severity violations
npx @sovereign-labs/verify self-test --fail-on-bug
```

| Family | Scenarios | What it tests | Docker? |
|--------|-----------|---------------|---------|
| **A** | 10 | Fingerprint collision detection | No |
| **B** | 9 | K5 constraint learning (multi-step) | No |
| **C** | 7 | Gate sequencing and consistency | No |
| **D** | 8 | G5 containment attribution | No |
| **E** | 6 | Grounding validation | No |
| **F** | 6 | Full Docker pipeline (build → stage → verify) | Yes |
| **G** | 10 | Edge cases (unicode, empty inputs, no-ops) | No |

50 scenarios run pure. 6 need Docker. The harness is deterministic — no LLM calls, no network, no flakiness.

## Gates

| Gate | What it checks | Needs Docker? |
|------|---------------|---------------|
| **F9** (Syntax) | Search strings exist exactly once in target files | No |
| **K5** (Constraints) | Edit doesn't repeat a known-failed pattern | No |
| **G5** (Containment) | Every edit traces to a predicate (no sneaky changes) | No |
| **Staging** | Docker build + start succeeds | Yes |
| **Browser** | CSS/HTML predicates pass in Playwright | Yes |
| **HTTP** | API endpoints return expected responses | Yes |
| **Invariants** | Health checks pass after all edits applied | Yes |

Gates can be individually disabled:

```typescript
await verify(edits, predicates, {
  appDir: './my-app',
  gates: {
    staging: false,   // Skip Docker
    browser: false,   // Skip Playwright
    http: false,      // Skip HTTP checks
    invariants: false, // Skip health checks
  },
});
```

## Predicates

Predicates declare what should be true after the edits are applied.

| Type | What it verifies | Example |
|------|-----------------|---------|
| `css` | CSS property value | `{ type: 'css', selector: 'h1', property: 'color', expected: 'red' }` |
| `html` | HTML element exists | `{ type: 'html', selector: '.nav-link' }` |
| `content` | File contains pattern | `{ type: 'content', file: 'server.js', pattern: 'Welcome' }` |
| `http` | HTTP response check | `{ type: 'http', path: '/api', method: 'GET', expect: { status: 200 } }` |
| `http_sequence` | Multi-step HTTP flow | `{ type: 'http_sequence', steps: [{ method: 'POST', path: '/api/users', ... }] }` |
| `db` | Database structure | `{ type: 'db', table: 'users', column: 'email', assertion: 'column_exists' }` |

## K5: Learning from Failures

The constraint store remembers what failed. Pass a `stateDir` to persist learning across calls:

```typescript
const result1 = await verify(edits, predicates, {
  appDir: './my-app',
  stateDir: './.verify',  // K5 memory persists here
});
// result1.success === false (bad edit)

const result2 = await verify(differentEdits, predicates, {
  appDir: './my-app',
  stateDir: './.verify',  // Same dir = remembers result1
});
// result2 benefits from result1's failure — banned patterns, tighter radius
```

On failure, `result.narrowing` tells the agent:
- **`resolutionHint`** — What went wrong and how to fix it
- **`constraints`** — What's now banned (signatures, file patterns)
- **`bannedFingerprints`** — Which predicate fingerprints failed (for self-correction)
- **`patternRecall`** — Prior winning fixes for similar failures

Constraints persist in `.verify/constraints.json`. Commit this file to share learning across your team.

## Grounding

Before submitting edits, scan the app to understand what actually exists:

```typescript
import { groundInReality } from '@sovereign-labs/verify';

const grounding = groundInReality('./my-app');
// grounding.routes      → ['/api/users', '/health', '/']
// grounding.routeCSSMap → Map<route, Map<selector, properties>>
// grounding.htmlElements → Map<route, [{tag, text, attrs}]>
```

This prevents predicates that reference non-existent selectors or routes.

## Git Diff Integration

Parse `git diff` output into edits:

```typescript
import { parseDiff, verify } from '@sovereign-labs/verify';

const diff = execSync('git diff').toString();
const edits = parseDiff(diff);

const result = await verify(edits, predicates, { appDir: '.' });
```

## App Requirements

For full verification (Docker gates), your app needs:
- A `Dockerfile`
- A `docker-compose.yml` (or `docker-compose.yaml`)
- A health check endpoint (recommended)

Without Docker, F9/K5/G5 gates still run — you get syntax validation, constraint checking, and containment attribution.

## Configuration

### `VerifyConfig`

```typescript
{
  appDir: string;          // Path to your app (required)
  stateDir?: string;       // Where K5 memory lives (default: appDir/.verify)
  goal?: string;           // Human description of what edits achieve
  docker?: {
    compose?: boolean;     // Use docker-compose (default: true)
    timeout?: number;      // Build timeout ms (default: 120000)
  };
  gates?: {
    syntax?: boolean;      // F9 gate (default: true)
    constraints?: boolean; // K5 gate (default: true)
    containment?: boolean; // G5 gate (default: true)
    staging?: boolean;     // Docker staging (default: true)
    browser?: boolean;     // Playwright browser (default: true)
    http?: boolean;        // HTTP predicates (default: true)
    invariants?: boolean;  // Health checks (default: true)
  };
  invariants?: Array<{     // System-scoped health checks
    name: string;
    type: 'http' | 'command';
    path?: string;
    command?: string;
    expect: { status?: number; contains?: string };
  }>;
}
```

### `VerifyResult`

```typescript
{
  success: boolean;
  gates: Array<{ gate: string; passed: boolean; durationMs: number; detail: string }>;
  attestation: string;         // Human-readable summary
  narrowing?: Narrowing;       // On failure: what to try next
  effectivePredicates?: Array<{ id: string; type: string; fingerprint: string }>;
  constraintDelta?: { before: number; after: number };
  timing: { totalMs: number; perGate?: Record<string, number> };
}
```

## License

MIT
