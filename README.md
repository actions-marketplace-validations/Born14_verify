# @sovereign-labs/verify

Verification gate for AI agent actions. Every edit gets a fair trial before it touches your users.

**For any agent** — coding agents, file system agents, or your own. The gates are universal. Only the predicates change.

## It found its own bug

In v0.1.1, HTTP predicates with different `bodyContains` values produced identical fingerprints — K5 couldn't tell them apart. A human caught it by reading the code.

Now 234 automated scenarios across 10 families catch it in under 20 seconds:

```bash
npx @sovereign-labs/verify self-test

#   0 bugs | 239 scenarios | 0 unexpected | A: clean, B: clean, ..., H: clean, M: clean, V: clean
#   Failure Class Coverage: 83/83 clean
#   ALL CLEAN — No invariant violations detected.
```

The test that catches the v0.1.1 bug is scenario A10. It will never regress again.

## What it does

Your agent proposes edits. `verify()` checks them:

```
Grounding → F9 (syntax) → K5 (constraints) → G5 (containment) →
Filesystem (post-edit state) → Staging (Docker) →
Browser (Playwright) → HTTP (fetch) → Invariants (health) →
Vision (screenshot) → Triangulation (3-authority verdict)
```

On **success**: returns proof that the edits work.
On **failure**: returns what went wrong + what to try next.
On **repeat failure**: K5 learns from mistakes, so attempt N+1 has a smaller, smarter search space.

## Beyond Code

The gates are domain-agnostic. K5 fingerprints any predicate type. G5 attributes any mutation. Narrowing guides any agent. Only the predicates are domain-specific.

Today verify gates code edits. But the same pipeline works for file system agents (move, rename, organize), communication agents (message the right channel), document agents (don't overwrite the wrong cells), and infrastructure agents (don't delete the production database).

**Built today:** Code predicates (css, html, content, http, db) + Filesystem predicates (exists, absent, unchanged, count) + Communication predicates (destination, forbidden content, claims with evidence, negation detection, topic trust enforcement, epoch-based evidence staleness, review bundles for human surfaces).

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

16 tools exposed across 4 categories:

**Core Pipeline** (any agent):
- `verify_ground` — Scan app for CSS rules, HTML elements, routes, schema
- `verify_read` — Read a source file
- `verify_submit` — Submit edits + predicates through the full gate pipeline

**Campaign** (surgical fault hunting):
- `verify_campaign_ground` — Ground + format for campaign brain
- `verify_campaign_run_goal` — Submit goal with edits + predicates, get verdict
- `verify_campaign_faults` — View fault ledger
- `verify_campaign_encode` — Encode fault as self-test scenario

**Chaos Engine** (autonomous stress-testing):
- `verify_chaos_plan` — Recon: grounding + constraints + coverage gaps + templates
- `verify_chaos_run` — Fire batch of goals, auto-classify, cache for encoding
- `verify_chaos_encode` — Encode bugs as permanent scenarios

**Improve Loop** (self-hardening):
- `verify_improve_discover` — Run baseline, return violations + triage
- `verify_improve_diagnose` — Structured diagnosis context
- `verify_improve_read` — Read verify source files
- `verify_improve_submit` — Submit fix edits, validate in subprocess + holdout
- `verify_improve_apply` — Apply winning edits to real source
- `verify_improve_cycle` — Full automated cycle with API LLM (fallback)

## Self-Test Harness

239 scenarios across 10 families exercise the verification pipeline's invariants — including 14 filesystem, 29 CSS (value normalization + shorthand), 5 content pattern, 7 F9 syntax gate, 6 fingerprinting/K5, 10 attribution error, 5 full-pipeline integration, 14 communication/message gate (including topic trust enforcement and epoch-based evidence staleness), and 6 HTML predicate failure classes tracked by the [failure taxonomy](FAILURE-TAXONOMY.md). Run them to prove your install works, or use `--fail-on-bug` in CI.

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
| **A** | 20 | Fingerprint collision detection + edge cases (X-51–X-53) | No |
| **B** | 14 | K5 constraint learning + store resilience (X-54–X-56) | No |
| **C** | 7 | Gate sequencing and consistency | No |
| **D** | 23 | G5 containment attribution + attribution errors (AT-01–AT-10) | No |
| **E** | 61 | Grounding: CSS normalization/shorthand + content patterns (C-01–C-30, C-44–C-52, N-04–N-08) | No |
| **F** | 6 | Full Docker pipeline (build → stage → verify) | Yes |
| **G** | 17 | Edge cases + F9 syntax gate (X-37–X-41: not_found, ambiguous, regex, empty, line endings) + external/universal scenarios | No |
| **H** | 34 | Filesystem gate — 14 failure classes (FS-01 through FS-16) | No |
| **M** | 21 | Message gate — 14 failure classes (MSG-01 through MSG-14) | No |
| **V** | 14 | Vision + triangulation (3-authority verdict) | No |
| **UV** | 28 | Universal full-pipeline integration (color normalization, multi-predicate, F9 rejection, HTML predicates) | No |

205 scenarios run pure from families. 28 universal scenarios test cross-gate integration including HTML predicates. 6 need Docker. Plus external fault-derived scenarios from `.verify/custom-scenarios.json` when testing against a real app. The harness is deterministic — no LLM calls, no network, no flakiness.

## Gates

| Gate | What it checks | Needs Docker? |
|------|---------------|---------------|
| **F9** (Syntax) | Search strings exist exactly once in target files | No |
| **K5** (Constraints) | Edit doesn't repeat a known-failed pattern | No |
| **G5** (Containment) | Every edit traces to a predicate (no sneaky changes) | No |
| **Filesystem** | Post-edit filesystem state (exists, absent, unchanged, count) | No |
| **Staging** | Docker build + start succeeds | Yes |
| **Browser** | CSS/HTML predicates pass in Playwright | Yes |
| **HTTP** | API endpoints return expected responses | Yes |
| **Invariants** | Health checks pass after all edits applied | Yes |
| **Vision** | Screenshot verified by vision model (pre-captured buffer) | No |
| **Triangulation** | Cross-authority verdict (deterministic + browser + vision) | No |
| **Message** | Outbound agent communication governed (destination, claims, evidence, topic trust, epoch staleness) | No |

Gates can be individually disabled:

```typescript
await verify(edits, predicates, {
  appDir: './my-app',
  gates: {
    staging: false,   // Skip Docker
    browser: false,   // Skip Playwright
    http: false,      // Skip HTTP checks
    invariants: false, // Skip health checks
    vision: false,     // Skip vision model (default: false)
    grounding: false,  // Skip grounding (default: true)
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
| `filesystem_exists` | File/dir exists at path | `{ type: 'filesystem_exists', file: 'config/app.json' }` |
| `filesystem_absent` | File does NOT exist | `{ type: 'filesystem_absent', file: 'tmp/scratch.log' }` |
| `filesystem_unchanged` | File hash unchanged | `{ type: 'filesystem_unchanged', file: 'LICENSE', hash: 'sha256:...' }` |
| `filesystem_count` | Directory entry count | `{ type: 'filesystem_count', path: 'migrations/', count: 3 }` |

## Communication Governance

Agent outbound messages get the same governance as code edits. `governMessage()` checks destination, content, claims, and evidence before a message is sent.

```typescript
import { governMessage } from '@sovereign-labs/verify';

const result = await governMessage(
  // Envelope: platform-agnostic message container
  {
    destination: { target: '#deployments', platform: 'slack' },
    content: { body: 'Deploy v2.3.1 completed successfully' },
    sender: { identity: 'deploy-bot' },
    topic: { value: 'deploy', source: 'adapter' },
  },
  // Policy: what's allowed
  {
    destinations: { allow: ['#deployments', '#alerts'] },
    forbidden: ['password', /api[_-]?key/i],
    claims: {
      deploy: {
        assertions: {
          deploy_success: {
            triggers: ['deployed successfully', 'completed successfully'],
            evidence: 'deploy_status',
          },
        },
      },
    },
  },
  // Evidence providers: verify claims deterministically
  {
    deploy_status: async () => ({
      exists: true,
      fresh: true,
      detail: 'v2.3.1 deployed at 14:32 UTC',
      epoch: 5,        // authority epoch of this evidence
      currentEpoch: 5, // current authority epoch (gate computes freshness)
    }),
  },
);

if (result.verdict === 'approved') {
  // Safe to send — claims verified, destination allowed, no forbidden content
} else if (result.verdict === 'narrowed') {
  // Send with caveats — topic was overridden or evidence is stale
  console.log(result.narrowing);
  // { type: 'evidence_staleness', resolutionHint: '...' }
} else if (result.verdict === 'clarify') {
  // Ambiguous — surface to human with full context
  console.log(result.reviewBundle);
  // { message, gateDetail, evidenceArtifacts, topicTrace, stalenessInfo }
} else {
  // blocked — hard rule violation
  console.log(result.reason, result.detail);
}
```

Four verdicts: `approved` (send it), `blocked` (do not send), `narrowed` (send with modifications), `clarify` (ambiguous — ask a human). Built-in negation detection prevents "has not deployed" from being treated as a deploy claim. Topic trust enforcement prevents agents from gaming governance by mislabeling topics — the gate detects topics from content keywords and overrides the agent's label when they disagree. Epoch-based evidence staleness computes freshness from authority epochs rather than trusting the evidence provider's self-report.

On `clarify` and `narrowed` verdicts, `result.reviewBundle` provides a self-contained package for human review surfaces — the original message, gate reasoning, evidence artifacts (with raw provider fields), topic resolution trace, and staleness info. A Slack modal, email thread, or dashboard card rendering a review bundle has everything it needs without chasing cross-references.

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

Constraints persist in `.verify/memory.jsonl`. Commit this file to share learning across your team.

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

Without Docker, F9/K5/G5/Filesystem gates still run — you get syntax validation, constraint checking, containment attribution, and filesystem state verification.

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
    vision?: boolean;      // Vision model gate (default: false)
    grounding?: boolean;   // Grounding gate (default: true)
  };
  vision?: {               // Vision model configuration
    call: (image: Buffer, prompt: string) => Promise<string>; // Provider-agnostic callback
    screenshots?: Record<string, Buffer>; // Pre-captured screenshots by route
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
