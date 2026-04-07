# Verify Reference

Detailed API documentation, gate descriptions, and contributor guides. For the product overview, see [README.md](README.md). For how it works, see [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## Self-Test Harness

18,000+ scenarios across 100+ staged files exercise the verification pipeline's 26 gates. **~2,800 core scenarios** (ALL CLEAN as of April 7, 2026 — 0 dirty). **~2,400 aspirational scenarios** (tagged, excluded from default runs). Plus supply chain, real-world harvesters, and WPT corpus. 668+ failure shapes in taxonomy (650 original + 18 gate calibration from real-world scan). 100 generator scripts produce synthetic scenarios; 7 harvesters fetch real-world data. **33,056 real agent PRs scanned** from AIDev-POP dataset with empirical structural failure rates published. 354 unit tests with 21,342 assertions, 0 failures.

The harness includes 14 filesystem, 29 CSS (value normalization + shorthand), 8 content pattern, 10 F9 syntax gate, 8 fingerprinting/K5, 10 attribution error, 43 HTTP gate (mock server + Docker), 28 cross-predicate interaction (including 6 product compositions and 3 temporal compositions), 14 communication/message gate (including topic trust enforcement and epoch-based evidence staleness), 18 DB schema grounding (type aliases, fabricated references, case sensitivity), 18 infrastructure (The Alexei Gate — Terraform/Pulumi/CloudFormation state file verification), 8 serialization (JSON schema validation), 6 configuration (.env + JSON config parsing), 11 security (XSS, injection, CSP, CORS, eval, prototype pollution, path traversal, deserialization, open redirect, rate limiting), 11 accessibility (heading hierarchy, landmarks, ARIA, alt text, form labels, link text, lang attr, autoplay, skip nav), 11 performance (bundle size, image optimization, lazy loading, unminified assets, render blocking, DOM depth, cache headers, duplicate deps), 15 convergence loop (govern() with shape tracking, constraint propagation, convergence detection), 28 universal full-pipeline integration, and 9 HTML predicate failure classes tracked by the [failure taxonomy](FAILURE-TAXONOMY.md). A decomposition engine (`decomposeFailure()`) maps observations to taxonomy shape IDs — 349 shape rules across 24 domains (including drift, identity, and scope boundary), pure functions, zero LLM, with diagnostics (`computeDecompositionDiagnostics()`), composition operators (product ×, temporal ⊗), and round-trip decomposition verification. Run them to prove your install works, or use `--fail-on-bug` in CI.

```bash
# Synthetic only — deterministic, fast (default)
npx @sovereign-labs/verify self-test

# Real-world only — requires prior harvest (bun scripts/supply/harvest-real.ts)
npx @sovereign-labs/verify self-test --source=real-world

# Both synthetic + real-world
npx @sovereign-labs/verify self-test --source=all

# Pure + live Docker scenarios (~5min)
npx @sovereign-labs/verify self-test --live

# Everything including Playwright browser tests (~10min)
npx @sovereign-labs/verify self-test --full

# Specific families
npx @sovereign-labs/verify self-test --families=A,B,G

# CI mode — exit 1 on bug-severity violations
npx @sovereign-labs/verify self-test --fail-on-bug

# Include WPT corpus (7K+ additional scenarios)
npx @sovereign-labs/verify self-test --wpt
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

12,775 total scenarios: 11,867 synthetic (99 staged files) + 908 real-world (8 staged files, gitignored). Plus 7,291 WPT (opt-in via `--wpt`). Tiered execution: pure (default, no Docker), live (+Docker), full (+Playwright). Source filtering: `--source=synthetic` (default, deterministic), `--source=real-world`, `--source=all`. 596/647 failure shapes covered (92%) across 30 domains. Decomposition engine: 349 shape rules, pure functions, zero LLM. DB grounding validates against init.sql with type alias normalization. Infrastructure grounding validates against Terraform/Pulumi/CloudFormation state files. Quality surface gates (serialization, config, security, a11y, performance) perform pure static analysis. 354 unit tests, 21,342 assertions. The synthetic harness is deterministic — no LLM calls, no network, no flakiness. Real-world scenarios are regenerated from live sources via `bun scripts/supply/harvest-real.ts`.

## Nightly Improve Loop

The improve loop is verify's compound learning system. It runs the self-test, diagnoses failures, generates fix candidates, validates against holdout scenarios, and either auto-merges improvements or files an issue. The scenario supply chain feeds it automatically.

### Pipeline

```
Supply (fuzz + harvest + receipts) → Baseline (self-test) → Improve (diagnose + fix) → Validate (holdout) → PR or Issue
```

### Scenario Supply Chain

Two independent scenario sources, selectable at runtime:

**Synthetic** — Deterministic, checked-in, one shape per scenario. Written by `scripts/harvest/stage-*.ts` generators. 11,867 scenarios across 99 staged fixtures. Never changes unless a human edits a generator. The improve loop's holdout/validation split depends on this stability.

**Real-world** — Fetched from external sources nightly, gitignored, regenerated from live data. 908+ scenarios from 8 public data sources. Finds failure patterns humans wouldn't think to write.

```bash
# Run self-test against synthetic only (default — fast, deterministic)
npx @sovereign-labs/verify self-test

# Run against real-world only (requires prior fetch)
npx @sovereign-labs/verify self-test --source=real-world

# Run against both
npx @sovereign-labs/verify self-test --source=all
```

#### Real-World Harvest

Fetches real data from public sources, converts to scenarios via 6 format-specific harvesters:

```bash
# Fetch all 8 sources and generate scenarios
bun scripts/supply/harvest-real.ts

# Fetch specific sources
bun scripts/supply/harvest-real.ts --sources=schemapile,mdn-compat

# Use cached data (skip network, 24h TTL)
bun scripts/supply/harvest-real.ts --cache-only

# Dry run (fetch but don't write fixtures)
bun scripts/supply/harvest-real.ts --dry-run

# Cap scenarios per source
bun scripts/supply/harvest-real.ts --max-per-source=100
```

| Source | Harvester | Real Data | Scenarios |
|--------|-----------|-----------|-----------|
| SchemaPile | harvest-db | 22,989 PostgreSQL schemas (HuggingFace) | 200 |
| JSON Schema Test Suite | harvest-http | 83 validation test files (json-schema-org) | 200 |
| MDN Compat Data | harvest-css | Browser compat database (unpkg) | 100 |
| Can I Use | harvest-css | CSS feature support matrix (Fyrd/caniuse) | 33 |
| PostCSS Parser Tests | harvest-css | 24 CSS edge cases (postcss repo) | 33 |
| Mustache Spec | harvest-html | 203 template conformance tests (mustache/spec) | 200 |
| PayloadsAllTheThings | harvest-security | 2,708 XSS vectors (swisskyrepo) | 95 |
| Heroku Error Codes | harvest-infra | 36 production error codes | 47 |

Cache: `.verify-cache/` (gitignored, 24h TTL). Output: `fixtures/scenarios/real-world/` (gitignored).

#### Synthetic Supply

Three fuel sources for the synthetic corpus:

```bash
# Fixture fuzzer — mutate existing scenarios into adversarial variants
bun run supply:fuzz

# Legacy synthetic harvester (hardcoded patterns)
bun run supply:harvest

# Receipt scraper — extract failed submissions from MCP proxy receipts
bun run supply:receipts

# All synthetic sources at once
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

The nightly workflow runs at 3 AM UTC. On success, it creates a PR with the improvements. On failure, it files an issue with the diagnostic report. The full acceptance cycle has been proven: baseline → diagnose → generate → validate → holdout → accepted (March 29, 2026 — security gate regex fix, score +0.8, 0 regressions).

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

## Fault Management

Track and classify scenarios where verify gives wrong answers:

```bash
# List unresolved faults
npx @sovereign-labs/verify faults list

# Review faults interactively
npx @sovereign-labs/verify faults review

# Summary by classification
npx @sovereign-labs/verify faults summary

# Filter by classification
npx @sovereign-labs/verify faults list --filter=false_positive
```

### Fault Classifications

| Classification | Meaning | Action |
|---------------|---------|--------|
| `false_positive` | Verify wrongly PASSES (should fail) | Gate has a blind spot — needs fix |
| `false_negative` | Verify wrongly FAILS (should pass) | Gate is too strict — needs relaxing |
| `bad_hint` | Narrowing sends wrong direction | Hint logic needs correction |
| `correct` | Verify got it right | No action — scenario confirms gate works |
| `agent_fault` | Agent made a genuine mistake | Not a verify bug |
| `ambiguous` | Can't determine correct verdict | Needs human judgment |

## Writing New Scenarios

Every scenario follows the same pattern — a JSON object with edits, predicates, and expected outcome:

```typescript
{
  id: 'my-scenario-001',
  description: 'What this tests',
  edits: [{ file: 'server.js', search: 'exact string', replace: 'new string' }],
  predicates: [{ type: 'css', selector: '.nav', property: 'color', expected: 'red' }],
  expectedSuccess: false,  // Should verify pass or fail?
  tags: ['css', 'grounding', 'MY-SHAPE-ID'],
  rationale: 'Why this scenario tests the failure shape',
}
```

**Critical constraint:** `edits.search` must be an EXACT substring from the demo-app fixture file. If the string doesn't exist, the syntax gate rejects immediately.

### Adding a Scenario to an Existing Generator

1. Open `scripts/harvest/stage-{domain}.ts`
2. Add a `scenarios.push({...})` call following the pattern above
3. Run the generator: `bun scripts/harvest/stage-{domain}.ts`
4. Verify it loads: `bun run self-test --families=G`

### Adding a New Generator

1. Create `scripts/harvest/stage-{name}.ts`
2. Follow the pattern: read demo-app files → generate scenarios → write to `fixtures/scenarios/{name}-staged.json`
3. The runner picks up `*-staged.json` files automatically — no wiring needed

## LLM Provider Configuration

| Provider | Env Var | Model | Notes |
|----------|---------|-------|-------|
| `gemini` | `GEMINI_API_KEY` | gemini-2.5-flash | Default for CI. Temp 0.2 |
| `anthropic` | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 | Temp 0.2, max 4096 |
| `claude` | `ANTHROPIC_API_KEY` | Configurable | Uses RELATED_FILES context |
| `claude-code` | N/A | N/A | Filesystem exchange via MCP |
| `ollama` | `OLLAMA_HOST` | qwen3:4b (default) | Local, no API key needed |
| `none` | N/A | N/A | Dry-run plumbing tests |

