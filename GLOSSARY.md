# Verify Glossary

Plain-language definitions for the terms that matter.

---

## Core Concepts

### verify()
The one function. Takes edits + predicates, runs them through 17 gates, returns a verdict. Every edit gets a fair trial before it touches users. No LLM calls, no network (unless Docker/browser gates are enabled). Pure judgment.

### govern()
The convergence loop that wraps verify(). Agent plans → verify judges → failure narrows the search space → agent retries with more information. Three exit paths: converged (success), exhausted (ran out of attempts), stuck (no progress detected).

### Gate
A checkpoint in the verification pipeline. Each gate checks one thing. If it fails, everything stops. There are 26, they always run in the same order. All gates support config toggles (`gates: { temporal: false }` to disable). Think of them as a gauntlet your edit has to survive.

**Gate order:** Grounding → F9 (syntax) → K5 (constraints) → G5 (containment) → Hallucination → Access → Temporal → Propagation → State → Capacity → Contention → Observation → Filesystem → Infrastructure → Serialization → Config → Security → A11y → Performance → Staging (Docker) → Browser (Playwright) → HTTP (fetch) → Invariants (health) → Vision (screenshot) → Triangulation (3-authority verdict) → Message

### Predicate
A claim about what should be true after your edit. "The h1 should be red." "The /health endpoint should return 200." "The users table should have a bio column." You declare what success looks like, verify checks if reality agrees.

### Edit
A search-and-replace mutation. Find this string in this file, replace it with that. The atomic unit of change that verify gates.

### Narrowing
What you get back when verify says no. Includes: what went wrong, what's now banned (K5 constraints), what to try next (resolution hints, pattern recall, next moves). The failure receipt that makes the next attempt better.

### Attestation
The human-readable verdict. "VERIFY PASSED — Gates: F9✓ K5✓ G5✓ Staging✓ Browser✓" or "VERIFY FAILED at K5 — predicate fingerprint is banned." Self-contained — reading the attestation tells the full story without parsing JSON.

### Convergence
The process of narrowing toward a correct solution. Each failed attempt seeds constraints, bans failed fingerprints, and surfaces hints. The search space shrinks on every retry. The opposite of "try harder" — it's "try smarter in a smaller world."

---

## The Parity Model

### Parity Grid
The strategic map. An 8×10 matrix of agent capabilities × failure classes = 80 cells. Each cell either has coverage (✓), partial coverage (◐), or is blind (✗). The grid drives priorities — fill blind cells first. See PARITY-GRID.md.

### Execution Parity
Verify has parity when every (agent capability × failure class) intersection is represented by at least one grounded, reproducible failure shape backed by a generator that simulates real-world failure mechanics.

### Capability
What agents actually do. The 8 rows of the grid: Filesystem Edits, HTTP Calls, Browser Interaction, Database Operations, CLI/Process Execution, Multi-Step Workflows, Verification/Observation, Configuration/State.

### Failure Class
How reality breaks, invariant across all capabilities. The 10 columns of the grid: Selection (wrong target), Mutation (change didn't apply), State Assumption (wrong belief about reality), Temporal (ordering/timing/readiness), Propagation (change didn't cascade), Observation (verification itself is wrong), Convergence (repeating failed patterns), Access (privilege/permission boundary), Capacity (resource exhaustion), Contention (concurrency/race conditions).

### Cell
One intersection on the parity grid. "Temporal × Database" is a cell. A cell is filled when at least one shape has a working generator that simulates the real failure mechanic.

### Shape
A specific failure pattern within a cell. TD-01: "Connection pool serves stale schema after migration" is a shape in the Temporal × Database cell. PARITY-GRID.md defines 2-3 shapes per priority cell. FAILURE-TAXONOMY.md provides full technical detail.

### Generator
A harvest script that produces concrete scenarios from a shape. It must simulate the real failure mechanic — timing delays for temporal shapes, cross-surface chains for propagation shapes, environment divergence for state assumption shapes. Static mocks don't count for D/E/C cells.

---

## Failure Classification

### Failure Taxonomy
The dictionary. FAILURE-TAXONOMY.md defines 603 individual failure shapes across 27 domains. The parity grid is the map; the taxonomy is the reference. Every shape should reference its grid cell.

### Failure Shape
A named, described way that a predicate can produce wrong results. Either a false positive (passes when it shouldn't) or a false negative (fails when it shouldn't). The atomic unit of the taxonomy. One shape maps to one grid cell.

### Failure Algebra
The foundational principle: failure shapes are finite, composable, enumerable, and decomposable. Multi-surface failures are products of single-surface shapes. New bugs map to existing shapes before creating new ones.

### Claim Type
What a predicate asserts about reality. Nine types: Existence, Equality, Absence, Containment, Ordering, Transformation, Invariance, Threshold, Causal. Each has its own failure physics.

### Temporal Mode
When the observation happens relative to the change. Five modes: snapshot (point-in-time), settled (after stabilization), ordered (sequence-dependent), stable (persists over time), fresh (not stale). Temporal failures are verify's biggest blind spot.

### Decomposition
The process of mapping a verify failure to taxonomy shape IDs. Five-step algorithm: Can it decompose into Shape A × Shape B? → Can it reduce to existing shape? → Temporal variant? → Scope variant? → New shape needed? Pure function, no LLM.

### Failure Signature
A regex-extracted error class. 21 signatures: syntax_error, port_conflict, migration_timeout, edit_not_applicable, browser_gate_failed, etc. Deterministic — no LLM needed to classify what went wrong.

### Failure Kind
Who was wrong:
- **app_failure** — the agent's code was bad. Learn from it.
- **harness_fault** — infrastructure hiccup (DNS, Docker, SSH). Don't learn from it.
- **unknown** — can't tell. Don't seed constraints.

### Action Class
How the edit strategy went wrong. rewrite_page (too aggressive), global_replace (too broad), schema_migration (wrong domain), unrelated_edit (off-topic). Used by K5 to ban strategies, not just specific edits.

---

## Gates (Named)

### Grounding
Reading the app's actual state before verifying anything. What CSS rules exist? What routes? What HTML elements? What DB tables? Prevents predicates that reference things that don't exist. Runs first — everything downstream depends on it.

### F9 (Syntax)
Checks that every search string in your edits exists exactly once in its target file. If the string isn't there or appears twice, the edit is ambiguous. Named for the internal gate identifier.

### K5 (Constraints)
The memory gate. Checks if this edit repeats a known-failed pattern. Powered by the constraint store — fingerprints of failed predicates, banned action classes, radius limits. The gate that makes agents converge instead of loop.

### G5 (Containment)
Checks that every edit traces to a predicate — no sneaky unrelated changes. Attribution levels: direct (satisfies a predicate), scaffolding (enables one), unexplained (nothing justifies it).

### Staging
Docker build + start + health check. Validates that the edits produce a working container before going further. Detects build-layer changes (package.json, Dockerfile) and forces full rebuilds when needed.

### Browser
Playwright in Docker validates CSS and HTML predicates against the running container. Evaluates `getComputedStyle()` for CSS, `querySelector()` for HTML, visibility checks. DOM settle detection (300ms mutation silence). Disables animations. Captures screenshots for the vision gate.

### HTTP
Direct `fetch()` validation against the running container. Supports single requests (status, body contains, body regex) and sequences (POST create → GET verify). Budget: 10s per request, 30s total.

### Invariants
System-scoped health checks that must hold after every mutation. "Is /health still responding?" "Is the DB still accessible?" Unlike predicates (goal-scoped), invariants are permanent and universal.

### Vision
Screenshot verification by an AI model. The caller brings their own model (Gemini, GPT, whatever). Verify sends the image + prompt, gets back pass/fail. One of three triangulation authorities.

### Triangulation
Three independent authorities vote on whether the edit worked:
1. **Deterministic** — file/HTTP/DB checks (causal truth)
2. **Browser** — Playwright getComputedStyle (rendered truth)
3. **Vision** — screenshot + AI model (perceptual truth)

Majority rules. Outlier is identified. Disagreement escalates to human.

---

## Constraint System (K5)

### Constraint
A hard guardrail learned from a prior failure. "Don't try this predicate fingerprint again" or "Don't touch more than 2 files." Constraints shrink the search space so each retry is smarter, not wider. Enforced by the harness, not the LLM — a plan that violates a constraint is rejected before it reaches approval.

### Fingerprint
A deterministic hash of a predicate's important fields. Two predicates that mean the same thing produce the same fingerprint. `type=css|selector=.roster-link|property=color|exp=green`. Used by K5 to remember what already failed.

### Constraint Store
The persistence layer for K5. Stores constraints in `.verify/memory.jsonl`. Session-scoped constraints expire with the job. Persistent constraints survive across calls (used by `govern()` for cross-attempt learning).

### Radius Limit
A constraint that shrinks how many files an agent can touch: ∞ → 5 → 3 → 2 → 1. Seeded after repeated failures. Forces the agent to be more precise with each retry.

### Grounding Miss
A predicate references something that doesn't exist in reality. CSS selector `.nonexistent` when the app has no such class. Hard-rejected at the grounding gate for CSS/DB predicates. Soft-rejected for HTML (might be creating a new element).

### Pattern Recall
When a failure matches a known error signature, prior winning fixes are surfaced. "This looks like migration_timeout — last time, splitting the migration worked." Memory that compounds.

---

## Self-Test Harness

### Self-Test
The proof that verify() itself works. Runs scenarios through the real `verify()` pipeline and checks if verify gets the right verdict. Not used in production — used to test verify's gates before production use.

### Scenario
A self-test case. Edits + predicates + expected outcome. "Given these edits and these predicates, verify should pass/fail at this gate." The unit of knowledge in the harness. One generator produces 2-50 scenarios from a single failure shape.

### Family
A group of related scenarios. A tests fingerprints, B tests constraints, C tests gate sequencing, D tests convergence, E tests staged per-gate scenarios, G tests WPT/web platform, etc. 12 families currently.

### Harvest Script
A TypeScript file in `scripts/harvest/` that generates scenarios from fixture data. Reads real files (demo-app HTML, SQL, config), produces `HarvestedLeaf` objects, writes to `fixtures/scenarios/*-staged.json`. 22 harvest scripts currently.

### Harvested Leaf
The output format of a harvest script. One leaf = one scenario = one predicate + one edit + one expected verdict. The atomic unit of harvested test data before it becomes a scenario.

### Staged Scenarios
Scenarios stored in `fixtures/scenarios/*-staged.json`. Produced by harvest scripts. Loaded by the self-test runner alongside built-in generated scenarios. 952 per-gate staged scenarios currently.

### WPT Scenarios
Web Platform Test scenarios harvested from W3C test suites. 7,291 scenarios in `wpt-staged.json`. Opt-in via `--wpt` flag because they take longer to run. Test CSS/HTML/HTTP spec compliance.

### Oracle
The set of invariant checks that run after each scenario. The oracle decides if verify did the right thing. It's what makes the self-test a real test — not "did it run" but "did it judge correctly."

### Clean / Dirty
A scenario is **clean** if all its invariants passed — verify produced the correct verdict. **Dirty** if any invariant failed — meaning verify has a bug. The improve loop only cares about dirty scenarios.

### Ledger
The append-only log of all self-test results. Every scenario run gets a line: what happened, which invariants passed, clean or dirty. The raw data the improve loop reads.

### Fault Ledger
The real-world version of the ledger. Records when verify was wrong against a live app (not a synthetic scenario). Auto-classifies: false positive, false negative, bad hint, correct, agent fault, ambiguous.

### Tier
How much infrastructure the self-test uses:
- **Pure** (default) — no Docker, no network. ~2,800 core scenarios, ~2 min. Aspirational scenarios excluded by default (`--exclude-tags=aspirational`).
- **Live** (`--live`) — adds Docker + real Postgres. Core + supply chain scenarios, ~5 min.
- **Full** (`--full`) — adds Playwright browser. All tiers, ~10 min.
- **Total corpus:** 18,000+ scenarios across all tiers (core + aspirational + supply chain + WPT).
- **WPT** (`--wpt`) — adds 7,291 web platform tests. Combinable with any tier.

---

## Improve System

### Improve Loop
The self-hardening cycle. Run self-test → find dirty scenarios → diagnose the bug → generate fix candidates → validate in subprocess → check holdout → human reviews. Turns discovered bugs into permanent fixes. Separate package: `@sovereign-labs/improve`.

### Holdout
30% of clean scenarios held back during fix validation. If a fix breaks a holdout scenario, it's rejected as overfitting. The loop can't cheat by only fixing the scenarios it saw.

### Bounded Surface
The files the improve loop is allowed to edit. All are predicate gates — they evaluate truth claims about reality. Environment gates (staging.ts) and constitutional gates (invariants.ts) are frozen.

### Triage
Deterministic mapping from invariant violation → target function + file. When confidence is "mechanical," no LLM needed. When "needs_llm," the diagnosis step kicks in. Zero tokens for the common case.

### Chaos Engine
Three MCP tools that autonomously stress-test verify. Plan → Run → Encode. Fires diverse goals through the pipeline, auto-records faults, converts bugs into permanent scenarios. Discovers what the harness needs to catch.

---

## Infrastructure

### LocalDockerRunner
Container lifecycle manager. Build → start → health check → stop. Uses `docker compose` with unique project names and random host ports for isolation. Exported as public API.

### Demo App
The test fixture in `fixtures/demo-app/`. A Node.js HTTP server with routes, CSS, HTML, a Dockerfile, and a Postgres schema (4 tables). All built-in scenarios run against it. Real enough to exercise every gate.

### DBHarness
Test helper that starts the demo-app's Docker Compose stack (app + Postgres) for live-tier self-tests. Provides `getAppUrl()` for HTTP/browser validation against real containers.

### Browser Gate Runner
`fixtures/browser-gate-runner.mjs` — the actual Playwright script. Reads predicates from JSON, evaluates them against a running page, writes results to JSON. Fixed and auditable. Zero code generation, zero injection risk.

---

## Supply Chain

### Failure Supply Chain
The industrialized pipeline from raw public failure data to active governance coverage. Lifecycle: Harvested → Staged → Triage → Active → Saturated (or Quarantine → Re-triage → Retire). Scenarios are inventory with logistics.

### Poison Parent
A parent class that produces hundreds of failures, all same gate, same root cause, disproportionate fix cost. Triage catches these before the improve loop wastes budget on them.

---

## Document Map

| Document | Role |
|----------|------|
| **PARITY-GRID.md** | The map — what must be covered (8×10 grid, priorities, metrics) |
| **FAILURE-TAXONOMY.md** | The dictionary — 603 shapes, 27 domains, technical detail |
| **GLOSSARY.md** | This file — plain-language definitions |
| **ASSESSMENT.md** | The settled view — what verify is, what not to say about it |
