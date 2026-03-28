# @sovereign-labs/verify

Verification gate for AI agent actions. Every edit gets a fair trial before it touches your users.

**For any agent** — coding agents, file system agents, or your own. The gates are universal. Only the predicates change.

## It found its own bug

In v0.1.1, HTTP predicates with different `bodyContains` values produced identical fingerprints — K5 couldn't tell them apart. A human caught it by reading the code.

Now 10,667 automated scenarios across 70 staged files catch it — 346 tests with 21,322 assertions, 0 failures:

```bash
npx @sovereign-labs/verify self-test

#   0 bugs | 738 scenarios | 0 unexpected | A: clean, ..., L: clean, ..., P: clean, B: clean
#   Failure Class Coverage: 376/376 clean
#   ALL CLEAN — No invariant violations detected.

npx @sovereign-labs/verify self-test --live

#   Skipped 63 Docker scenarios (Docker not available)  # or runs them if Docker is present
#   0 bugs | 783 scenarios | ...
```

The test that catches the v0.1.1 bug is scenario A10. It will never regress again.

## What it does

Your agent proposes edits. `verify()` checks them:

```
Grounding → F9 (syntax) → K5 (constraints) → G5 (containment) →
Filesystem (post-edit state) → Infrastructure (state files) →
Serialization → Config → Security → A11y → Performance →
Staging (Docker) → Browser (Playwright) → HTTP (fetch) →
Invariants (health) → Vision (screenshot) → Triangulation (3-authority verdict)
```

On **success**: returns proof that the edits work.
On **failure**: returns what went wrong + what to try next.
On **repeat failure**: K5 learns from mistakes, so attempt N+1 has a smaller, smarter search space.

## Beyond Code

The gates are domain-agnostic. K5 fingerprints any predicate type. G5 attributes any mutation. Narrowing guides any agent. Only the predicates are domain-specific.

Today verify gates code edits. But the same pipeline works for file system agents (move, rename, organize), communication agents (message the right channel), document agents (don't overwrite the wrong cells), and infrastructure agents (don't delete the production database).

**Built today:** Code predicates (css, html, content, http, db) + Filesystem predicates (exists, absent, unchanged, count) + Infrastructure predicates (resource existence, attribute values, manifest drift — The Alexei Gate) + Quality surface predicates (serialization, config, security, a11y, performance) + Communication predicates (destination, forbidden content, claims with evidence, negation detection, topic trust enforcement, epoch-based evidence staleness, review bundles for human surfaces).

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

### 2. Convergence loop — `govern()`

`verify()` is a single pass. `govern()` wraps it in a convergence loop — ground reality, plan, verify, narrow, retry. The agent learns from every failure.

```typescript
import { govern } from '@sovereign-labs/verify';

const result = await govern({
  appDir: './my-app',
  goal: 'Change the button color to orange',
  maxAttempts: 3,

  // Your agent — one method: plan
  agent: {
    plan: async (goal, context) => {
      // context.grounding: CSS, HTML, routes, DB schema — the app's ground truth
      // context.narrowing: what failed last time and why
      // context.failureShapes: taxonomy IDs (e.g., 'C-05', 'F9-02')
      // context.convergence: is the loop making progress?

      return {
        edits: [{ file: 'style.css', search: 'blue', replace: 'orange' }],
        predicates: [{ type: 'css', selector: '.btn', property: 'color', expected: 'orange' }],
      };
    },
  },

  // Optional: human approval before each verify() run
  onApproval: async (plan, context) => {
    console.log(`Attempt ${context.attempt}: ${plan.edits.length} edits`);
    return true; // false to abort
  },

  // Optional: observe progress without blocking
  onAttempt: (attempt, result) => {
    console.log(`Attempt ${attempt}: ${result.success ? 'PASS' : 'FAIL'}`);
  },
});

if (result.success) {
  console.log(`Converged in ${result.attempts} attempt(s)`);
  console.log(result.receipt.attestation);
} else {
  console.log(`Stopped: ${result.stopReason}`);
  // 'exhausted' — all attempts used, was making progress
  // 'stuck' — shape repetition or gate cycles detected
  // 'empty_plan_stall' — agent returned empty edits 3x
  // 'approval_aborted' — human rejected the plan
}
```

**Three exit paths:**
- **converged** — goal succeeded, edits verified
- **exhausted** — max attempts used but was making progress (more attempts might help)
- **stuck** — loop detected no progress (same shapes repeating, same gates failing, constraints growing but not helping)

**What the agent sees on retry** (`GovernContext`):
- `grounding` — CSS rules, HTML elements, routes, DB schema from the app
- `priorResult` — the previous `verify()` result (gates, narrowing, attestation)
- `narrowing` — resolution hints, banned fingerprints, pattern recall
- `failureShapes` — taxonomy shape IDs from `decomposeFailure()` (e.g., `C-05: named color vs computed RGB`)
- `constraints` — active K5 constraints (what's banned and why)
- `convergence` — shape progression, gate progression, empty plan count, progress summary

**Convergence detection** (ported from Sovereign's battle-tested agent loop):
- Shape repetition — same failure shapes across attempts means no new information
- Gate cycles — same gates failing the same way
- Empty plan stall — agent returning 0 edits repeatedly
- Constraint saturation — constraints growing but shapes unchanged (narrowing isn't helping)

**Fault ledger:** Every failure is automatically recorded to `.verify/faults.jsonl`. Unclassified failures (where the taxonomy has no matching shape) are flagged on `result.receipt.unclassifiedFailures`. Run `npx @sovereign-labs/verify faults` to inspect gaps.

### 3. As a CLI

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

### 4. As an MCP server

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

10,667 scenarios across 70 staged files exercise the verification pipeline's invariants. 2,584 non-WPT per-gate scenarios cover 20 domains (a11y, axe-a11y, config, content, db, f9, filesystem, g5, html, http, infrastructure, json-schema, k5, message, performance, secrets, security, serialization, triangulation) plus 48 parity-grid cross-cutting files, 28 universal integration scenarios, and 7,291 WPT-derived corpus scenarios. All non-WPT fixture files have 30+ scenarios minimum depth. 73 harvest/bolster scripts in `scripts/harvest/` generate deterministic scenarios from real fixture data. 346 unit tests with 21,322 assertions, 0 failures.

The harness includes 14 filesystem, 29 CSS (value normalization + shorthand), 8 content pattern, 10 F9 syntax gate, 8 fingerprinting/K5, 10 attribution error, 43 HTTP gate (mock server + Docker), 28 cross-predicate interaction (including 6 product compositions and 3 temporal compositions), 14 communication/message gate (including topic trust enforcement and epoch-based evidence staleness), 18 DB schema grounding (type aliases, fabricated references, case sensitivity), 18 infrastructure (The Alexei Gate — Terraform/Pulumi/CloudFormation state file verification), 8 serialization (JSON schema validation), 6 configuration (.env + JSON config parsing), 11 security (XSS, injection, CSP, CORS, eval, prototype pollution, path traversal, deserialization, open redirect, rate limiting), 11 accessibility (heading hierarchy, landmarks, ARIA, alt text, form labels, link text, lang attr, autoplay, skip nav), 11 performance (bundle size, image optimization, lazy loading, unminified assets, render blocking, DOM depth, cache headers, duplicate deps), 15 convergence loop (govern() with shape tracking, constraint propagation, convergence detection), 28 universal full-pipeline integration, and 9 HTML predicate failure classes tracked by the [failure taxonomy](FAILURE-TAXONOMY.md). A decomposition engine (`decomposeFailure()`) maps observations to taxonomy shape IDs — 349 shape rules across 24 domains (including drift, identity, and scope boundary), pure functions, zero LLM, with diagnostics (`computeDecompositionDiagnostics()`), composition operators (product ×, temporal ⊗), and round-trip decomposition verification. Run them to prove your install works, or use `--fail-on-bug` in CI.

```bash
# Pure-only (738 scenarios, ~20s, no Docker needed)
npx @sovereign-labs/verify self-test

# Pure + live Docker scenarios (783 scenarios, ~5min)
npx @sovereign-labs/verify self-test --live

# Everything including Playwright browser tests (~10min)
npx @sovereign-labs/verify self-test --full

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
| **E** | 114 | Grounding: CSS normalization/shorthand + content patterns + edge cases (C-01–C-67, N-04–N-17, X-01–X-47) | No |
| **F** | 6 + 20 live DB + 10 browser | Full Docker pipeline + live DB/browser scenarios | Yes |
| **G** | 407 | Edge cases, F9 syntax, HTML (H-01–H-48), content (N-03–N-17), CSS selectors deep (C-34–C-68), HTTP deep (P-10–P-35), scope/identity (SC-01–SC-10, ID-01–ID-11), cross-cutting (X-05–X-100), invariants (INV-01–INV-12), DB grounding (D-01–D-12), infrastructure (INFRA-01–INFRA-12, The Alexei Gate), serialization (SER-01–SER-09), config (CFG-01–CFG-08), security (SEC-01–SEC-12), a11y (A11Y-01–A11Y-11), performance (PERF-01–PERF-10), temporal/concurrency/observer/drift (DR-01–DR-11) + universal scenarios | No |
| **H** | 47 | Filesystem gate — 22 failure classes (FS-01 through FS-34) | No |
| **L** | 15 | Convergence loop (govern()) — shape tracking, constraint propagation, convergence detection | No |
| **I** | 28 | Cross-predicate interactions + product/temporal compositions (I-01–I-12, I-05×–I-10×, I-T01–T03) | No |
| **M** | 21 | Message gate — 14 failure classes (MSG-01 through MSG-14) | No |
| **P** | 43 + 15 live HTTP | HTTP gate — status, body, regex, content-type, sequence, mock server + live Docker (P-01–P-35) | Mixed |
| **V** | 14 | Vision + triangulation (3-authority verdict) | No |
| **UV** | 28 | Universal full-pipeline integration (color normalization, multi-predicate, F9 rejection, HTML predicates) | No |

10,667 total scenarios: 9,875 staged (2,584 non-WPT + 7,291 WPT) + 792 generated at runtime. 70 staged fixture files, all non-WPT at 30+ minimum depth. 738 pure scenarios + 45 live Docker scenarios = 783 in the self-test runner. Tiered: pure (738, ~20s), live (783 with Docker, ~5min), full (793 with Playwright, ~10min). 376 failure classes covered across 603 known failure shapes (63% atomic coverage). Decomposition engine maps observations to taxonomy shape IDs — 349 shape rules across 24 domains (48 CSS, 31 HTML, 18 HTTP, 14 content, 12 DB, 12 infrastructure, 12 serialization, 12 security, 11 configuration, 11 accessibility, 10 performance, 10 interaction, 52 cross-cutting, 8 attribution, 12 filesystem, 4 drift, 3 identity, 3 scope boundary, 3 vision, 7 invariant, 6 temporal, 6 observer, 6 concurrency, 5 staging, 1 message), with Phase 2 hardening: minimal basis enforcement, deterministic sort, decomposition scoring, claim-type driven decomposition, temporal mode integration, and composition operators (product ×, temporal ⊗) with round-trip verification. DB grounding validates predicates against init.sql schema with type alias normalization (serial→integer, varchar(N)→varchar, bool→boolean). Infrastructure grounding validates predicates against Terraform/Pulumi/CloudFormation state files (resource existence, attribute values, manifest drift). Quality surface gates (serialization, config, security, a11y, performance) perform pure static analysis — no Docker, no network. 346 unit tests, 21,322 assertions. Plus external fault-derived scenarios from `.verify/custom-scenarios.json` when testing against a real app. The harness is deterministic — no LLM calls, no network, no flakiness.

## Nightly Improve Loop

The improve loop is verify's compound learning system. It runs the self-test, diagnoses failures, generates fix candidates, validates against holdout scenarios, and either auto-merges improvements or files an issue. The scenario supply chain feeds it automatically.

### Pipeline

```
Supply (fuzz + harvest + receipts) → Baseline (self-test) → Improve (diagnose + fix) → Validate (holdout) → PR or Issue
```

### Scenario Supply Chain

Three automatic fuel sources generate new scenarios without manual authoring:

```bash
# Fixture fuzzer — mutate existing scenarios into adversarial variants
# 6 mutation classes: pred_flip, edit_corrupt, pred_drift, type_swap, boundary, compound
bun run supply:fuzz

# External corpus harvester — CSS edge cases, HTTP patterns, DB schema checks
# Pluggable: add harvesters for new domains in scripts/supply/harvest.ts
bun run supply:harvest

# Receipt scraper — extract failed submissions from MCP proxy receipts
# Reads .governance/receipts.jsonl, converts failures to regression scenarios
bun run supply:receipts

# All sources at once
bun run supply:all
```

### Running Locally

```bash
# Full nightly pipeline: supply → self-test → improve
bun run nightly

# Improve only (skip supply chain)
bun run improve -- --llm=gemini --api-key=$GEMINI_API_KEY

# Dry run (triage + diagnose, no apply)
bun run improve -- --llm=gemini --dry-run

# No-LLM triage (mechanical only, zero tokens)
bun run improve -- --llm=none
```

### GitHub Action (CI)

The nightly workflow runs at 3 AM UTC. On success, it creates a PR with the improvements. On failure, it files an issue with the diagnostic report.

```yaml
# .github/workflows/nightly-improve.yml
# Triggers: schedule (3 AM UTC) or manual dispatch
# Requires: GEMINI_API_KEY or ANTHROPIC_API_KEY secret
```

Manual trigger with custom options:
- `supply_sources`: comma-separated (fuzz, harvest, receipts)
- `llm_provider`: gemini, claude, anthropic, none
- `families`: scenario families to test (A-Z)
- `dry_run`: triage only, no apply

### Improve Verdicts

| Verdict | Meaning |
|---------|---------|
| `accepted` | Fix passed holdout validation, ready to merge |
| `rejected_regression` | Best candidate caused regressions |
| `rejected_overfitting` | Holdout check failed (overfit to dirty set) |
| `rejected_no_fix` | No candidate improved anything |
| `skipped_all_clean` | No violations to fix |
| `skipped_no_llm` | Needs LLM but no provider configured |

### Adding Custom Harvesters

Add a harvester function to `scripts/supply/harvest.ts`:

```typescript
// In HARVESTERS registry:
const HARVESTERS: Record<string, Harvester> = {
  css: harvestCSSEdgeCases,
  http: harvestHTTPEdgeCases,
  db: harvestDBPatterns,
  // Add yours:
  openapi: harvestOpenAPIBreakingChanges,
};
```

Each harvester receives `(inputDir, maxScenarios)` and returns `{ source, scenarios, metadata }`.

## Gates

| Gate | What it checks | Needs Docker? |
|------|---------------|---------------|
| **F9** (Syntax) | Search strings exist exactly once in target files | No |
| **K5** (Constraints) | Edit doesn't repeat a known-failed pattern | No |
| **G5** (Containment) | Every edit traces to a predicate (no sneaky changes) | No |
| **Filesystem** | Post-edit filesystem state (exists, absent, unchanged, count) | No |
| **Infrastructure** | Terraform/Pulumi/CloudFormation state file verification (The Alexei Gate) | No |
| **Serialization** | JSON schema validation, type checking, required fields, structure comparison | No |
| **Config** | Environment variable presence, config file value equality (.env + JSON) | No |
| **Security** | XSS patterns, SQL injection, secrets exposure, CSP, CORS | No |
| **A11y** | Heading hierarchy, landmark regions, ARIA labels, alt text, focus management | No |
| **Performance** | Bundle size, image optimization, lazy loading, connection count | No |
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
| `infra_resource` | Infrastructure resource exists | `{ type: 'infra_resource', resource: 'aws_db_instance.prod', assertion: 'exists' }` |
| `infra_attribute` | Resource attribute value | `{ type: 'infra_attribute', resource: 'aws_db_instance.prod', attribute: 'tags.Environment', expected: 'production' }` |
| `infra_manifest` | State file matches manifest | `{ type: 'infra_manifest', stateFile: 'terraform.tfstate', assertion: 'matches_manifest' }` |
| `serialization` | JSON schema compliance | `{ type: 'serialization', file: 'data.json', schema: { name: 'string' }, mode: 'strict' }` |
| `config` | Config key/value | `{ type: 'config', source: '.env', key: 'NODE_ENV', expected: 'production' }` |
| `security` | Vulnerability patterns | `{ type: 'security', check: 'xss', file: 'server.js', expected: 'no_findings' }` |
| `a11y` | Accessibility compliance | `{ type: 'a11y', check: 'heading_hierarchy', file: 'index.html', expected: 'no_findings' }` |
| `performance` | Performance budgets | `{ type: 'performance', check: 'bundle_size', file: 'dist/app.js', threshold: 500000 }` |

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

### Platform Adapters

The message gate is platform-agnostic. Adapters translate between platform vocabulary and `MessageEnvelope`:

- **[@sovereign-labs/verify-slack](https://github.com/Born14/verify-slack)** — Slack adapter. Governs bot messages, renders review bundles as Block Kit cards, handles approve/reject actions.

```bash
npm install @sovereign-labs/verify-slack @sovereign-labs/verify @slack/bolt
```

```typescript
import { createSlackGovernor } from '@sovereign-labs/verify-slack';

const govern = createSlackGovernor({ policy, evidenceProviders, reviewChannel: '#review' });
app.message(async ({ message, client }) => {
  const { result } = await govern(message, client);
});
```

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

**Session isolation (default):** Each `verify()` call cleans up its own constraints afterward, so failures in one call never poison the next. Use `learning: 'persistent'` in convergence loops (like `govern()`) where you want cross-attempt learning.

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
  learning?: 'session' | 'persistent'; // K5 constraint isolation mode (default: 'session')
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
