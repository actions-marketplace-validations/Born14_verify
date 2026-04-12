# How Verify Works

**Know how your AI coding agent fails.**

26 gates check your agent's work. On failure, it learns what went wrong and doesn't repeat it. On success, you have proof it worked. The gates themselves improve every night — automatically.

---

## The Problem

AI agents can now write code, edit files, update databases, and deploy software. But they make mistakes — wrong CSS values, broken SQL migrations, security vulnerabilities, files that don't exist. Today, most systems just trust the agent's output. If the agent says "done," you hope it's right.

Verify doesn't hope. It checks.

---

## What Verify Does

An agent proposes a change: "I edited server.js to change the background color to blue." Verify asks 26 independent questions about that change:

- **Grounding:** Does the CSS selector you're targeting actually exist in the code?
- **Syntax:** Is your edit valid? Will the file still parse after your change?
- **Constraints:** Have we seen this exact approach fail before?
- **Containment:** Did you only change what you said you'd change, or did you sneak in extra modifications?
- **Security:** Did your edit introduce an XSS vulnerability or expose a secret?
- **Accessibility:** Did you break keyboard navigation or screen reader support?
- **Infrastructure:** Does the Docker container still build and start?
- ... and 18 more.

Each question is a "gate." Every gate votes pass or fail. If any gate fails, the change is blocked and the agent gets specific feedback: "The grounding gate failed because `.sidebar-nav` doesn't exist in your CSS — the actual class is `.nav-link`."

That's `verify()` — one call, 26 gates, a verdict.

For multi-agent setups, `verifyBatch()` runs agents in sequence. Each agent sees the real filesystem the previous agent left behind. If Agent A changes a file, Agent B's edits are verified against Agent A's result — not the original. Edit conflicts are caught by the syntax gate. Predicate conflicts are caught by grounding. No coordination layer needed — the gates handle it.

---

## Predicate Extraction

A predicate is a structured claim about what should be true after an edit — "this file should exist," "this CSS class should be present in the rendered output," "the JSON in package.json should still parse." Gates consume predicates and check them against reality. `verify()` and `govern()` both consume predicates and are downstream of extraction.

Predicates can be supplied by the caller, or generated from the edit itself. The extractor lives in [src/extractor/](src/extractor/) and composes four tiers:

- **Tier 1 (diff):** deterministic predicates from the edit content — new files, deleted files, added/removed strings.
- **Tier 2 (context):** cross-file predicates when an identifier is removed from one file and may still be referenced in another.
- **Tier 3 (intent):** heuristic extraction from PR title, description, and commit messages — quoted values, CSS classes, route paths.
- **Tier 4 (static):** file-extension heuristics that wake up dormant gates — `.json` triggers serialization, code files trigger security, `.html` triggers a11y.

Each tier is independently callable. Callers compose what they need; the [facade](src/extractor/index.ts) provides a bundled default for callers that want all four.

---

## Learning From Failure

A single pass is useful. But the real power is the loop.

`govern()` wraps verify in a convergence cycle. When the agent's first attempt fails, govern remembers what went wrong and prevents the agent from trying the same bad approach again. The agent submits a revised plan, verify checks it again, and the cycle continues until the change passes all 26 gates — or the agent runs out of options.

```
Agent: "Change the link color to green"
  → verify: FAIL — selector .roster-link doesn't exist
  → constraint: don't use .roster-link again

Agent: "OK, use .nav-link instead"
  → verify: FAIL — color value 'green' doesn't match computed rgb(0,128,0)
  → constraint: use rgb format for colors

Agent: "Use .nav-link with color rgb(0,128,0)"
  → verify: PASS — all 26 gates clear
  → change deployed
```

Each failure narrows the space of allowed actions. The agent can't go in circles. It either converges on a correct solution or hits a wall — and that wall is visible to the human operator.

---

## How Do We Know the Gates Work?

This is where it gets interesting. Verify verifies agents. But who verifies verify?

**Scenarios.** Thousands of them. Each scenario is a controlled test: "Here's an edit, here's what the agent claims it does, and here's the right answer." We run every scenario through verify and check: did it give the correct verdict?

If verify says "pass" when the answer should be "fail" — we found a bug in a gate. If it says "fail" when the answer should be "pass" — same thing. Either way, we now know which gate has a problem and can fix it.

We have **18,391 scenarios** today. They come from two independent sources.

---

## Two Sources of Truth

### Synthetic Scenarios (11,867)

Written by developers (and Claude). Each one tests a specific, known failure pattern. "What happens when an agent references a CSS class that doesn't exist?" "What happens when a database column is renamed but the API still returns the old field name?"

There are 668+ known failure patterns in our taxonomy, organized across 30 domains (CSS, HTML, database, HTTP, security, accessibility, etc.). Includes 18 gate calibration shapes discovered from scanning 33,056 real agent PRs.

These are deterministic — they produce the same result every time. They're checked into the codebase and never change unless someone deliberately updates them. This stability is critical for testing whether a proposed gate fix actually improves things without breaking anything else.

### Real-World Scenarios (908)

Fetched from real public data sources:

| Source | What it is | What we get |
|--------|-----------|-------------|
| **SchemaPile** | 22,989 real PostgreSQL schemas from GitHub projects | "Does verify correctly handle a schema with `UnsignedInt` columns?" |
| **JSON Schema Test Suite** | Official validation conformance tests | "Does verify correctly classify valid vs invalid JSON structures?" |
| **MDN Compat Data** | Mozilla's browser compatibility database | "Does verify know which CSS properties are standard vs experimental?" |
| **Can I Use** | CSS feature support matrix | "Does verify handle flexbox, grid, container queries correctly?" |
| **PostCSS Parser Tests** | Extreme CSS edge cases from the PostCSS project | "Does verify's CSS parser choke on unusual but valid CSS?" |
| **Mustache Spec** | 203 official template conformance tests | "Does verify correctly validate template rendering?" |
| **PayloadsAllTheThings** | 2,708 known XSS attack vectors | "Does verify's security gate catch real-world attack patterns?" |
| **Heroku Error Codes** | 36 production infrastructure failure modes | "Does verify recognize real deployment failure patterns?" |

These scenarios test patterns nobody would think to hand-write. A real schema from a real project exercises code paths that synthetic scenarios miss.

Real-world scenarios are regenerated from live sources — they're not checked in because the upstream data can change. They complement the synthetic set: synthetic for precision, real-world for discovery.

### Choosing What to Run

```bash
# Synthetic only — fast, deterministic, the default
npx @sovereign-labs/verify self-test

# Real-world only — tests against fetched data
npx @sovereign-labs/verify self-test --source=real-world

# Both — the full picture
npx @sovereign-labs/verify self-test --source=all
```

---

## The Self-Improving Loop

Every night at 3 AM UTC, two independent runners execute the autonomous hardening loop:

1. **Harvest** real-world data from 13 public sources + generate adversarial scenarios
2. **Test** all 18,391+ scenarios through verify (Lenovo runs all 26 gates with Docker; GitHub CI runs 25 without Docker)
3. **Find** any scenarios where verify gives the wrong answer ("dirty" scenarios)
4. **Diagnose** which gate is broken, using an LLM to read the gate source code
5. **Fix** — the LLM generates pattern-based code changes (it says WHAT to change, the code finds WHERE)
6. **Validate** each candidate against a held-out set of scenarios (does it fix the problem without breaking anything?)
7. **Review** — auto-approve, auto-reject, or route to the operator for judgment
8. **Discover** — failures that don't match any known shape are clustered and proposed as new taxonomy entries

The machine finds its own bugs, proposes its own fixes, and discovers new failure categories. The operator reads a morning report and handles the 1% the machine can't resolve.

**Proven April 4-5, 2026:** The improve loop produced its first accepted fixes after weeks of 0/51. Fixes: triage misroute (16 bundles hitting frozen verify.ts), context injection (types + taxonomy), bundle size reduction (20→5). Result: 5 accepted fixes in one night. Then 681 dirty → 0 in one day of manual + automated fixing.

**Proven April 6-7, 2026:** Scanned 33,056 real agent PRs from AIDev-POP dataset through the gate pipeline. Deterministic, $0 cost. Found 8.5% of agent PRs have structural issues, 3.4% high-confidence. Five per-agent reliability profiles produced. 18 new gate calibration shapes discovered from real-world data.

A key architectural insight emerged: the LLM diagnoses which line to fix, but the *code* reads the actual line content from the file to build the edit. This "line-to-search grounding" eliminates the fragility of asking an LLM to reproduce exact source strings. Each component handles what it's best at — LLMs reason, code reads files.

---

## The Full Picture

```
                    ┌─────────────────────────┐
                    │     External Sources     │
                    │  SchemaPile, MDN, XSS    │
                    │  Mustache, Heroku, etc.  │
                    └────────────┬────────────┘
                                 │ fetch
                                 ▼
┌──────────────┐    ┌─────────────────────────┐
│  Generators  │    │   Real-World Harvesters  │
│  (100 files) │    │    (6 format parsers)    │
│  hand-written│    │   programmatic conversion│
└──────┬───────┘    └────────────┬────────────┘
       │                         │
       ▼                         ▼
  11,867 synthetic          908 real-world
    scenarios                 scenarios
       │                         │
       └────────────┬────────────┘
                    │
                    ▼
            ┌──────────────┐
            │  Self-Test   │
            │  Runner      │
            │  (per scenario:)
            │  apply edit  │
            │  → verify()  │  ← 26 gates
            │  → check     │
            │    verdict   │
            └──────┬───────┘
                   │
                   ▼
            ┌──────────────┐
            │   Ledger     │
            │  (pass/fail  │
            │   per scenario)
            └──────┬───────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
    All clean?         Dirty scenarios?
    → Ship it          → Improve loop
                       → LLM diagnoses
                       → Proposes fix
                       → Holdout check
                       → PR or reject
```

---

## The System Architecture

### Five Layers (from foundation to fuel)

```
Layer 5: Curriculum Agent         — generates new scenarios from the taxonomy
Layer 4: Improve Loop             — finds gate bugs, proposes fixes, validates via holdout
Layer 3: Self-Test Harness        — runs 18,391 scenarios, checks verdicts against oracles
Layer 2: Verification Pipeline    — verify() and govern(), the 26-gate product
Layer 1: Governance Kernel        — 7 invariants as pure functions (honesty, non-repetition, etc.)
```

Each layer depends only on the layers below it. The kernel never changes. The pipeline rarely changes. The harness changes when scenarios are added. The improve loop and curriculum agent run on top.

### The 26 Gates (with code size)

| Gate | File | LOC | What it checks |
|------|------|-----|----------------|
| Grounding | grounding.ts | 1,083 | Do referenced selectors/routes/tables exist? |
| Syntax | syntax.ts | 159 | Is the edit valid? Does search string exist? |
| Constraints | constraints.ts | 67 | Has this approach failed before? (K5) |
| Containment | containment.ts | 148 | Did the agent only change what it said? (G5) |
| Filesystem | filesystem.ts | 250 | File existence, permissions, size, encoding |
| Infrastructure | infrastructure.ts | 519 | Docker, compose, ports, health checks |
| Serialization | serialization.ts | 283 | JSON Schema, OpenAPI, data contracts |
| Config | config.ts | 284 | Runtime configuration correctness |
| Security | security.ts | 454 | XSS, injection, secrets, CORS |
| Accessibility | a11y.ts | 481 | WCAG, headings, ARIA, alt text |
| Performance | performance.ts | 586 | Bundle size, DOM depth, images |
| Message | message.ts | 1,141 | Agent communication governance |
| Staging | staging.ts | 88 | Docker build/start validation |
| Browser | browser.ts | 303 | Playwright CSS/HTML verification |
| HTTP | http.ts | 248 | Status, headers, body assertions |
| Temporal | temporal.ts | 523 | Timing failures across 8 surfaces |
| Propagation | propagation.ts | 698 | Cross-system state consistency |
| State | state.ts | 765 | Environment assumption mismatches |
| Access | access.ts | 573 | Permission and authorization boundaries |
| Capacity | capacity.ts | 539 | Resource exhaustion detection |
| Contention | contention.ts | 465 | Concurrent access conflicts |
| Observation | observation.ts | 589 | Observer effect detection |
| Invariants | invariants.ts | 182 | System-scoped health checks (frozen) |
| Vision | vision.ts | 304 | Screenshot-based visual verification |
| Triangulation | triangulation.ts | 302 | Cross-authority verdict synthesis |

**Total: 11,034 LOC across 25 gate files.**

### Nine Named Components

| Component | What it is | Where it lives |
|-----------|-----------|----------------|
| Package | The npm artifact | `@sovereign-labs/verify` |
| Pipeline | `verify()` + `govern()` | `src/verify.ts`, `src/govern.ts` |
| Gates | 26 domain-specific checkers | `src/gates/*.ts` |
| Store | K5 constraints + fault ledger | `src/store/*.ts` |
| Harness | Self-test runner + oracles | `scripts/harness/*.ts` |
| Generators | 100 synthetic scenario scripts | `scripts/harvest/stage-*.ts` |
| Harvesters | 6 real-world data converters | `scripts/supply/harvest-*.ts` |
| Improve Loop | 7-step self-fixing pipeline | `scripts/harness/improve*.ts` |
| MCP Server | 3 tools for external agents | `src/mcp-server.ts` |

### The Oracle (How scenarios know the right answer)

Every scenario encodes what the correct verdict should be. The oracle checks two classes of invariant:

**Product invariants** (verify's guarantees):
- Fabricated predicate → grounding gate must fail
- Invalid edit → syntax gate must fail
- Previously-failed approach → constraint gate must block
- First failing gate is the reported gate — downstream gates don't fabricate evidence
- Skipped gates are explicitly marked skipped, not silently absent

**Harness invariants** (test infrastructure):
- verify() never throws — errors are captured in the result
- Same scenario produces same result (deterministic)
- Gate timing is recorded and bounded

### The Demo App (Test Fixture)

All scenarios run against a single fixture app at `fixtures/demo-app/`:
- `server.js` — Node HTTP server with 7 routes: `/`, `/about`, `/form`, `/edge-cases`, `/health`, `/api/items`, `/api/echo`
- `init.sql` — PostgreSQL schema (4 tables: users, posts, sessions, settings)
- `config.json` — App configuration (name, port, database, features)
- `.env` — Environment variables (NODE_ENV, PORT, DATABASE_URL, SECRET_KEY)
- `Dockerfile` — Container definition (node:18-alpine)
- `docker-compose.yml` — Multi-service stack (app + db)

This is the ONLY fixture app. Every scenario's `edits.search` must match exact strings from these files.

### The Gates Are Universal

The gates check structural properties, not domain-specific content. The same gate logic works for any domain — only the predicates change:

| Gate | Code Vocabulary | Universal Vocabulary |
|------|----------------|---------------------|
| Grounding | "Does the CSS selector exist?" | "Does your target exist in reality?" |
| Syntax | "Is this a valid edit?" | "Is this action well-formed?" |
| Constraints | "Has this code pattern failed?" | "Has this approach been tried and failed?" |
| Containment | "Did you only edit what you said?" | "Did you only do what you declared?" |

This means verify can gate any agent touching any system — file system agents, communication agents, data pipeline agents, infrastructure agents. The predicate types change. The gate physics don't.

---

## What "Zero Dependencies" Means

Verify ships as a single npm package with no external dependencies. No frameworks, no runtime services, no cloud APIs required for the core pipeline. You install it, point it at your app directory, and it works.

The real-world harvesters need network access to fetch data. The improve loop needs an LLM API key (Gemini, Claude, or Ollama locally). But `verify()` itself — the 26-gate pipeline that checks your agent's work — runs entirely on your machine with zero network calls.

---

## Where It Came From

Verify was extracted from Sovereign, a self-hosted app platform where AI agents deploy, monitor, and heal web applications. Every time a Sovereign agent proposed a code change, it went through a governance pipeline with constraints (K5), containment checks (G5), and staged verification. Those mechanics were general enough to work for any agent editing any system — not just web deployments.

The extraction produced three packages:
- **@sovereign-labs/kernel** — the 7 governance invariants as pure functions
- **@sovereign-labs/mcp-proxy** — governed transport for MCP tool servers
- **@sovereign-labs/verify** — the 26-gate verification pipeline (this package)

---

## Current State (April 7, 2026)

| Metric | Value |
|--------|-------|
| Gates | 26 (all toggleable via config) |
| Core scenarios | ~2,800 (ALL CLEAN — 0 dirty) |
| Failure taxonomy | 668+ shapes (650 original + 18 gate calibration from real-world scan) |
| Real agent PRs scanned | 33,056 across 5 agents (AIDev-POP dataset) |
| Structural finding rate | 8.5% raw, 3.4% high-confidence |
| Nightly runners | 2 (Lenovo with Docker, GitHub CI without) |
| GitHub Action | Built, tested, multi-provider LLM |
| npm | v0.8.2, 691 weekly downloads |
| Runtime dependencies | 0 |

---

## Beyond Code: The Expansion Path

Verify was born checking code edits. But the gates are domain-agnostic — they check structural properties of actions, not code-specific content. Nine classes of agents could use verify today:

| Class | Agent Type | What verify checks |
|-------|-----------|-------------------|
| 1 | Code agents (Cursor, Copilot, Claude) | File edits, CSS, HTML, DB migrations |
| 2 | No-Docker developers | Pure-tier verification, no infrastructure needed |
| 3 | CI/Pre-commit teams | Gate as pre-merge check |
| 4 | Agent builders (LangChain, CrewAI) | Tool call verification |
| 5 | File system agents | File existence, permissions, content |
| 6 | Communication agents | Message destinations, content, claims |
| 7 | Data/document agents | Schema validation, query scoping |
| 8 | Infrastructure agents | Docker, Terraform, Kubernetes state |
| 9 | Browser/computer-use agents | DOM state, visual verification |

For each new domain, what changes is minimal:

| Component | Changes? |
|-----------|----------|
| Gate sequence (26 gates) | No |
| K5 constraints | No |
| G5 containment | No |
| Narrowing | No |
| Grounding | **Yes** — new ground truth sources |
| Predicates | **Yes** — new predicate types |
| Validation | **Yes** — new assertion logic |
| Scenarios | **Yes** — new test cases |

Adding a new domain requires two small functions — not a heavyweight adapter:

```typescript
// Grounding provider — what exists in this system right now?
// Gmail: contacts, labels, drafts. Discord: channels, roles. Terraform: resources.
type GroundingProvider = () => Promise<GroundingContext>;

// Evidence provider — did the claimed action actually happen?
// "Agent said it sent the email" → check the Sent folder → { exists: true/false }
type EvidenceProvider = (claim: string) => Promise<{ exists: boolean; fresh: boolean; detail: string }>;
```

Each provider is ~50 lines wrapping a platform API. The gates, K5 constraints, G5 containment, and narrowing all work unchanged.

---

## Migration Verification (April 12, 2026)

When a PR contains `.sql` migration files, verify also runs a separate **migration verification pipeline** alongside the original 26-gate code-edit checks. This is the first vertical of verify's three-vertical product strategy (code edits, migrations, HTTP contracts).

### How it works

```
PR opens with migrations/20260412_add_role.sql
  ↓
Action detects .sql files in the changed file list
  ↓
Group by migration root: each independent migration directory gets its own schema
  (packages/api/migrations and packages/web/migrations are NEVER unioned)
  ↓
For each group:
  ├─ Pin to PR base SHA (immutable, deterministic)
  ├─ Read all prior migrations from that root on the base branch
  ├─ Replay them in order to build the pre-migration schema in memory
  │   (with reverse FK index — every column knows which other columns reference it)
  └─ For each new migration in this PR:
       ├─ Parse with libpg-query → typed MigrationOp[]
       ├─ Run grounding gate (DM-01..05): does the operation reference real tables/columns?
       ├─ Run safety gate (DM-15..19): is the operation operationally dangerous?
       └─ Apply the operation to the working schema for the next file
  ↓
Post findings as a PR comment with shape IDs, line numbers, and ack instructions
  ↓
DM-18 (NOT NULL without default) blocks merge.
Other DM shapes are warning-only while they're calibrated.
```

No database connection. No shadow DB. Pure static analysis of the migration file against the replayed schema. The whole pipeline is deterministic — same PR + same base SHA → same result, every time.

### What's measured

DM-18 is the first calibrated shape in verify's entire taxonomy.

| Metric | Value |
|---|---|
| Corpus | 761 production migrations from cal.com, formbricks, supabase |
| True positives | 19 |
| False positives | 0 |
| Precision | 100% on this corpus |
| Real-world proof point | Cal.com shipped a `NOT NULL` migration on April 4, 2024; reverted it the next day in a migration named `make_guest_company_and_email_optional`. Verify would have caught the original. |

See [scripts/mvp-migration/MEASURED-CLAIMS.md](scripts/mvp-migration/MEASURED-CLAIMS.md) for the full methodology and reproduction steps.

### How agents fail differently than humans

Across 75 migration tasks given to Claude Sonnet, Gemini 2.5 Flash, and GPT-4o on the same prompts:

| Source | DM-18 hit rate on probe tasks |
|---|---|
| Human (backtest of 761 production migrations) | 2.5% |
| Claude Sonnet | 17.1% |
| GPT-4o | 14.3% |
| Gemini 2.5 Flash | 46.9% |

All three models are 6-19x worse than the human baseline on this specific failure class. The same prompt phrased differently produces safe SQL or unsafe SQL depending on the model. This isn't fixable with prompt engineering — the safe pattern is structural, and verify is the structural check.

False-positive sanity check: across 60 migrations on tasks designed to be safe (`ADD COLUMN` with `DEFAULT`, optional columns, etc.), the gate fired zero times on any model.

### The 10 DM-* shapes

| ID | What it catches | Status |
|---|---|---|
| DM-01 | Target table not found | shipped |
| DM-02 | Target column not found | shipped |
| DM-03 | FK references unknown table or column | shipped |
| DM-04 | Create target already exists | shipped |
| DM-05 | Rename source missing or target conflict | shipped |
| DM-15 | DROP COLUMN with incoming FK references | shipped (warning-only) |
| DM-16 | DROP TABLE with incoming FK references | shipped (warning-only) |
| DM-17 | Column type change is narrowing | shipped (warning-only) |
| **DM-18** | **NOT NULL without safe preconditions** | **calibrated, blocking in CI** |
| DM-19 | DROP INDEX backing a constraint | shipped (warning-only) |

See the [Database Migration Failures section of FAILURE-TAXONOMY.md](FAILURE-TAXONOMY.md#database-migration-failures) for the full catalog.

### Where it lives in the codebase

```
src/types-migration.ts                — typed schema, MigrationOp, MigrationFinding
src/action/migration-check.ts          — Action integration (group, parse, gate, format)
scripts/mvp-migration/
  ├─ schema-loader.ts                  — schema replay + reverse FK index
  ├─ spec-from-ast.ts                  — libpg-query AST → MigrationSpec
  ├─ grounding-gate.ts                 — DM-01..05 with per-op progressive schema
  ├─ safety-gate.ts                    — DM-15..19 with ack mechanism
  ├─ replay-engine.ts                  — corpus-wide backtest runner
  ├─ agent-corpus-expanded.ts          — three-model agent comparison (75 tasks)
  ├─ historical-followup.ts            — cross-reference findings with subsequent migrations
  ├─ MEASURED-CLAIMS.md                — frozen DM-18 calibration claim
  └─ fixtures/                          — 7 golden migration fixtures
```

### Architectural relationship to the rest of verify

The migration vertical is built on the same primitives as the original 26 gates: claim ↔ evidence binding, deterministic checks, schema-grounded verification. The difference is the surface (SQL migrations) and the calibration discipline (measured precision against an external corpus). DM-18 is the proof that the architecture can produce calibrated shapes; the rest of the existing taxonomy will follow the same path one shape at a time.

---

## The Bet

Most AI governance today focuses on what goes *into* the agent — prompt filtering, guardrails, content policies. Nobody systematically checks what comes *out* — the actual changes the agent made to the actual system, verified against ground truth.

That's the gap. Verify fills it.

**Attach verify to anything that executes. It becomes reliable.**
