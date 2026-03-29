# @sovereign-labs/verify — Implementation Roadmap

**Date:** 2026-03-29
**Version:** 0.5.2 → targeting 0.6.0
**Author:** McCarty + Claude (system analysis session)
**For:** Any Claude instance picking up this work

---

## Context: Where We Are

Verify is a 25-gate verification pipeline for AI agent actions. It works. The engineering is ahead of the go-to-market.

### Baseline Results (March 29, 2026)

| Test | Result | Notes |
|------|--------|-------|
| Unit tests (`bun test`) | **341 pass, 0 fail**, 13 skip | 21,342 assertions. 12.9s. Skips are Docker/Gemini-dependent. |
| Real-world self-test (`--source=real-world`) | **708 clean, 0 bugs** | 90.5s. All 8 sources fetched and harvested. |
| Synthetic self-test | **1,360 clean, then watchdog kill** | Batch watchdog (exit 99) at 26%. Root cause: two capacity fixtures with 50KB/scenario edits. See P0. |

**Verdict:** Gates are healthy. Pipeline is working. Runner has a known performance issue with oversized scenarios.

### What's Working
- **25 gates** — grounding, syntax, constraints, containment, filesystem, infrastructure, security, a11y, performance, staging, browser, HTTP, and 13 more. 354 unit tests, 21,342 assertions, 0 failures.
- **Convergence loop** — `govern()` wraps `verify()` with K5 constraint learning. Proven by 15 scenarios.
- **Supply chain** — Three independent scenario sources:
  - **Synthetic:** 100 generators → 11,867 scenarios (99 staged fixtures, checked in)
  - **Real-world:** 6 harvesters → 908 scenarios from 8 public sources (gitignored, regenerated)
  - **WPT:** 7,291 web platform test scenarios (opt-in)
- **`--source` flag** — Developer chooses: `synthetic` (default), `real-world`, `all`
- **Improve loop** — Nightly CI finds gate bugs, proposes fixes via LLM, validates against holdout. Rejection path confirmed working (CI run 23694309983). Acceptance path unverified.
- **Coverage:** 596/647 failure shapes (92%). 80/80 parity grid cells (100%).
- **Docs:** HOW-IT-WORKS.md, README, HANDOFF, ASSESSMENT, FAILURE-TAXONOMY, PARITY-GRID, REAL-WORLD-SOURCES — all current.
- **Repos synced:** Born14/SOVEREIGN (monorepo), Born14/verify (public mirror), Lenovo (deployed)

### What's Broken
- **Runner crashes at 26%** on synthetic self-test. Two capacity fixtures (`capacity-config-staged.json` at 1.5MB, `capacity-verify-staged.json` at 750KB) contain 50KB+ edit strings that trigger the batch watchdog (exit 99). Real-world self-test completes fine (708 scenarios, 90s).

### What's Not Built
- Hallucination gate (15 shapes defined in taxonomy, 0 implemented)
- Browser scenarios (35 shapes, need Playwright)
- Curriculum agent (automated scenario generation from taxonomy)
- Improve loop acceptance path (never accepted a fix end-to-end)

---

## Implementation Sequence

**Do these in order. Each step depends on the previous.**

---

### P0: Fix Runner Crash
**Effort:** 30 minutes
**Unblocks:** Everything — can't validate anything without a clean baseline

#### The Problem
`scripts/harness/runner.ts` loads ALL staged fixtures into memory regardless of `--families` flag. Two capacity fixtures have scenarios with 50KB+ edit strings. The batch watchdog kills the process after the timeout.

#### The Fix
The CI workflow already handles this — commit `4547945` ("skip >500KB edits in CI, raise timeout for large edits"). Apply the same logic to the local runner.

#### Implementation
In `scripts/harness/runner.ts`, after staged scenarios are loaded (~line 264), add a filter:

```typescript
// Skip scenarios with extremely large edits (>500KB total) that hang the runner
const MAX_EDIT_BYTES = 500 * 1024;
const beforeFilter = scenarios.length;
scenarios = scenarios.filter(s => {
  const editSize = s.edits.reduce((sum, e) => sum + (e.search?.length || 0) + (e.replace?.length || 0), 0);
  return editSize < MAX_EDIT_BYTES;
});
const skippedLarge = beforeFilter - scenarios.length;
if (skippedLarge > 0) {
  console.log(`  Skipped ${skippedLarge} scenarios with >500KB edits`);
}
```

#### Verification
```bash
bun run self-test  # Must complete without exit 99. Expect 5,000+ scenarios, 0 bugs.
```

#### Done When
Full synthetic self-test completes. All scenarios either pass or are intentionally skipped. Ledger written.

---

### P1: Prove Improve Loop Acceptance Path
**Effort:** 2-4 hours
**Unblocks:** Product credibility — "self-improving gates" is the claim, must be proven

#### The Problem
The improve loop has correctly rejected bad fixes (March 28 CI run). It has NEVER accepted a good fix. The holdout check, PR creation, and auto-merge path are untested.

#### The Fix
Intentionally introduce a fixable regression into a gate, run the improve loop, verify it finds the bug, proposes a correct fix, validates against holdout, and produces a PR.

#### Implementation

**Step 1: Create the regression**
Pick a simple gate. For example, in `src/gates/security.ts`, weaken one pattern check:

```typescript
// INTENTIONAL REGRESSION — improve loop must catch and fix this
// Original: /eval\s*\(/
// Weakened: /eval_disabled\s*\(/  (will never match real eval() calls)
```

This will cause security scenarios that test `eval()` detection to become dirty (gate passes when it should fail).

**Step 2: Run baseline**
```bash
bun run self-test --fail-on-bug  # Should find dirty scenarios in security gate
```

Confirm: dirty scenarios exist, they're in the security domain.

**Step 3: Run improve loop**
```bash
bun run improve -- --llm=gemini --api-key=$GEMINI_API_KEY --max-candidates=3
```

Expected: The loop should diagnose the weakened regex, propose restoring the original pattern, validate the fix against holdout, and report `accepted`.

**Step 4: Verify the output**
- Check `data/improvement-ledger.jsonl` — should have an `accepted` entry
- Check if the fix candidate correctly restores the `eval\s*\(` pattern
- If the improve loop creates a PR branch: verify the diff is correct

**Step 5: Revert the intentional regression**
Restore the original security gate code. Commit with message explaining this was a controlled test.

#### Verification
The improve loop log shows: `baseline → bundle → split → diagnose → generate → validate → holdout → accepted`.

#### Done When
One complete acceptance cycle proven. The claim "self-improving gates" is backed by evidence.

---

### P2: Build the Hallucination Gate
**Effort:** 2-3 days
**Unblocks:** The strategic expansion from "execution trust" to "information trust"

#### Why This Gate
Verify currently checks if agent actions are structurally correct (valid CSS, real selectors, safe edits). It does NOT check if agent actions are semantically correct (did the agent fabricate a claim? reference a file that doesn't exist? invent a statistic?).

The hallucination gate bridges this gap WITHOUT putting an LLM in the pipeline. It uses the same deterministic, grounding-based approach as existing gates.

**Critical constraint:** NO LLM calls inside the gate. The gate is deterministic. The predicates encode intent. The gate checks predicates against ground truth.

#### The 15 Shapes (from FAILURE-TAXONOMY.md)

**Factual Fabrication (HAL-01 to HAL-05):**
- Invented statistic, entity, API parameter, file/function, conflated sources

**Schema/Structure Fabrication (HAL-06 to HAL-10):**
- Wrong column type, wrong table relationship, wrong API endpoint, wrong config key, wrong CSS selector

**Reasoning Fabrication (HAL-11 to HAL-15):**
- False causal claim, false temporal claim, false absence claim, confabulated error message, plausible but wrong code

#### Architecture

**New predicate type:** `hallucination`
```typescript
interface HallucinationPredicate {
  type: 'hallucination';
  claim: string;           // What the agent asserts ("users table has email column")
  source: string;          // Where to verify (file path, or 'schema', or 'routes')
  assertion: 'grounded' | 'fabricated';  // Expected: is this claim real or made up?
}
```

**New gate:** `src/gates/hallucination.ts`

The gate extracts claims from the predicate and checks them against the app's ground truth:
- File claims → does the file exist? does it contain the referenced function/class?
- Schema claims → does init.sql contain the referenced table/column/type?
- Route claims → does server.js contain the referenced route handler?
- Config claims → does config.json contain the referenced key?
- CSS claims → does the source contain the referenced selector/property?

This reuses existing infrastructure:
- `grounding.ts` already parses CSS selectors from source files
- `grounding.ts` already parses routes from server.js
- The DB grounding parser already parses init.sql
- The filesystem gate already checks file existence

The hallucination gate orchestrates these existing parsers against a new predicate type.

#### Implementation Steps

1. Add `HallucinationPredicate` to `src/types.ts` (add to Predicate union type)
2. Create `src/gates/hallucination.ts` (~200-300 LOC)
3. Wire into `src/verify.ts` gate sequence (after containment, before filesystem)
4. Write 15 scenarios covering HAL-01 through HAL-15 (use existing generator pattern)
5. Write unit tests (aim for 30+ tests, one per shape + edge cases)
6. Update FAILURE-TAXONOMY.md — change "no coverage" to "generator" for all 15 shapes

#### Gate Logic (pseudocode)
```
function checkHallucination(scenario, appDir):
  for each predicate where type === 'hallucination':
    truth = extractGroundTruth(predicate.source, appDir)
    claimExists = truth.contains(predicate.claim)

    if predicate.assertion === 'grounded' and !claimExists:
      FAIL — "claim not found in source"
    if predicate.assertion === 'fabricated' and claimExists:
      FAIL — "claim exists but was expected to be fabricated"

  PASS
```

#### Verification
```bash
bun test                    # All existing tests still pass
bun run self-test           # Existing scenarios unaffected
bun run self-test --families=G  # New hallucination scenarios pass
```

#### Done When
- 15 shapes covered with scenarios
- Gate passes all scenarios correctly
- Unit tests prove the gate catches fabricated claims and accepts grounded ones
- FAILURE-TAXONOMY.md updated: Hallucination coverage 15/15 (100%)
- Total failure shape coverage: 611/647 (94%)

---

### P3: npm 0.6.0 Bump
**Effort:** 1-2 hours
**Unblocks:** Market signal, public artifact

#### Changelog for 0.6.0
- Real-world harvest system (6 harvesters, 8 public sources, 908+ scenarios)
- `--source` flag (synthetic / real-world / all)
- 594 new synthetic scenarios (198 previously-uncovered failure shapes)
- Hallucination gate (15 failure shapes, new predicate type)
- Improve loop acceptance path verified
- Runner crash fix for large-edit scenarios
- Coverage: 611/647 shapes (94%), up from 376/647 (58%)
- Total scenarios: 13,000+ (up from 10,667)

#### Steps
1. Update `package.json` version to `0.6.0`
2. Run full self-test to confirm clean baseline
3. Commit: `verify: v0.6.0 — hallucination gate, real-world harvest, 94% coverage`
4. Push to Born14/SOVEREIGN (monorepo)
5. Push to Lenovo
6. Copy to `/tmp/verify-push/`, commit, push to Born14/verify
7. `npm publish --access public` from `/tmp/verify-push/`
8. Update memory file `verify-package.md` with new version

#### Verification
```bash
npm info @sovereign-labs/verify version  # Should show 0.6.0
npx @sovereign-labs/verify self-test     # Should work for any consumer
```

---

### P4: Expand Real-World Sources (Phase 2)
**Effort:** 1-2 days per source
**Unblocks:** Richer discovery fuel for the improve loop

#### Priority Sources

| Source | Harvester | Format | Est. Scenarios |
|--------|-----------|--------|---------------|
| html5lib-tests | harvest-html | .dat custom format | 2,000 |
| APIs.guru | harvest-http | OpenAPI JSON | 1,000 |
| DOMPurify | harvest-security | JSON/HTML fixtures | 200 |
| axe-core | harvest-html | JSON rules + HTML | 300 |
| PostgreSQL regression | harvest-db | SQL files | 500 |

#### Implementation Pattern (same for each)
1. Add source to `scripts/supply/sources.ts` registry
2. Add fetch spec (URL, format, sparse checkout paths)
3. Extend the appropriate harvester to handle the new format
4. Run `bun scripts/supply/harvest-real.ts --sources=<new-source>` to test
5. Verify scenarios load and pass: `bun run self-test --source=real-world`

#### Done When
5+ new sources live, 3,000+ real-world scenarios total.

---

### P5: Curriculum Agent (Automated Scenario Generation)
**Effort:** 1 week
**Unblocks:** Self-sustaining supply chain — the machine writes its own tests

#### What It Is
A generator that reads FAILURE-TAXONOMY.md, finds uncovered or thin shapes, and writes `*-curriculum-staged.json` scenarios. Same format as every other generator. Plugs into the existing runner with zero infrastructure changes.

#### Three-Phase Architecture

**Phase 1: SURVEY (deterministic, no LLM)**
```
Parse FAILURE-TAXONOMY.md
Extract all shapes with "no coverage" status
Cross-reference against existing fixtures/scenarios/*.json
→ UncoveredShape[] with { id, domain, description, claimType }
```

**Phase 2: PLAN (single LLM call per batch)**
```
For each uncovered shape (batched by domain):
  Input: shape definition + demo-app file contents + existing scenarios for dedup
  Output: 3-5 SerializedScenario objects per shape
  Constraints:
    - edits.search must be EXACT substring from demo-app file
    - predicates must use valid types from src/types.ts
    - At least 1 expectedSuccess:false, 1 expectedSuccess:true per shape
```

**Phase 3: VALIDATE (deterministic, no LLM)**
```
For each generated scenario:
  - indexOf(edit.search, fileContent) !== -1  → reject if search string missing
  - Predicate type in allowed set             → reject if invalid type
  - SHA-256(edits + predicates) not in existing set → reject if duplicate
  - Dry-run: apply edit, call verify(), no crash → reject if error
→ Write only structurally valid scenarios to *-curriculum-staged.json
```

**Phase 2b: ADVERSARIAL (after coverage is filled)**
```
Target: shapes with <5 scenarios AND existing gate source code
Prompt: "Here's the gate. Find an input where it gives the wrong answer."
Every success = new dirty scenario = improve loop fuel
```

#### The LLM Prompt (Phase 2)
```
You are generating test scenarios for a verification system.

SHAPE TO COVER:
  ID: {shape.id}
  Domain: {shape.domain}
  Description: {shape.description}
  Claim type: {shape.claimType}

DEMO APP FILES:
  server.js: [first 200 lines]
  init.sql: [full content]
  config.json: [full content]
  .env: [full content]
  Dockerfile: [full content]

EXISTING {DOMAIN} SCENARIOS (for dedup):
  [list of descriptions from existing staged files]

CONSTRAINTS:
  - edits.search must be an EXACT substring from the demo-app file shown above
  - edits.replace must be syntactically valid
  - predicates must use types: css, html, content, db, http, a11y, filesystem,
    config, performance, security, serialization, message, hallucination
  - Each scenario needs: id, description, edits[], predicates[],
    expectedSuccess (boolean), tags[] (include shape ID), rationale

Generate 4 scenarios testing shape {shape.id}.
Return as a JSON array.
```

#### Phase 3 Validation Rules (Critical — reject garbage strictly)

Every generated scenario MUST pass ALL of these checks or be rejected:

```typescript
// 1. Search string exists in demo-app file
for (const edit of scenario.edits) {
  const fileContent = readFileSync(join(demoDir, edit.file), 'utf-8');
  if (fileContent.indexOf(edit.search) === -1) → REJECT
  // No exceptions. indexOf === -1 means the LLM hallucinated the search string.
}

// 2. Predicate type is valid
const VALID_TYPES = ['css', 'html', 'content', 'db', 'http', 'http_sequence',
  'filesystem_exists', 'filesystem_absent', 'filesystem_unchanged', 'filesystem_count',
  'infra_resource', 'infra_attribute', 'infra_manifest', 'serialization',
  'config', 'security', 'a11y', 'performance', 'message', 'hallucination'];
for (const pred of scenario.predicates) {
  if (!VALID_TYPES.includes(pred.type)) → REJECT
}

// 3. Required fields present
if (!scenario.id || !scenario.description || !scenario.rationale) → REJECT
if (!Array.isArray(scenario.edits) || !Array.isArray(scenario.predicates)) → REJECT
if (typeof scenario.expectedSuccess !== 'boolean') → REJECT
if (!Array.isArray(scenario.tags) || !scenario.tags.some(t => /^[A-Z]+-\d+/.test(t))) → REJECT

// 4. Dedup — fingerprint by edit+predicate hash
const hash = sha256(JSON.stringify({ edits: scenario.edits, predicates: scenario.predicates }));
if (existingHashes.has(hash)) → REJECT

// 5. Dry-run — apply edit to temp copy, call verify(), must not throw
const tmpDir = copyDemoApp();
applyEdits(tmpDir, scenario.edits);
try { await verify(scenario.edits, scenario.predicates, { appDir: tmpDir }); }
catch (e) { → REJECT (verify crashed, scenario is malformed) }
```

**Why this matters:** When we wrote 594 scenarios via background agents earlier, some had subtly wrong search strings that wouldn't match the demo-app. A human catches these in review. The curriculum agent's Phase 3 must catch them programmatically — no exceptions.

#### What It Does NOT Do
- Does NOT modify gate code (that's improve's job)
- Does NOT run the improve loop (separate concern)
- Does NOT require Docker/Playwright (pure-tier scenarios only)
- Does NOT change the taxonomy (shapes are inputs, not outputs)
- Does NOT replace existing generators (additive, separate output file)

#### File: `scripts/harvest/curriculum-agent.ts`

Single file, ~300-400 LOC. CLI:
```bash
bun scripts/harvest/curriculum-agent.ts                    # all uncovered shapes
bun scripts/harvest/curriculum-agent.ts --domain css       # specific domain
bun scripts/harvest/curriculum-agent.ts --adversarial      # target thin shapes
bun scripts/harvest/curriculum-agent.ts --dry-run          # validate only
bun scripts/harvest/curriculum-agent.ts --provider gemini  # LLM provider
```

#### Cost
- Phase 1: 0 tokens
- Phase 2: ~2K tokens/shape × 51 uncovered shapes ≈ 100K tokens ≈ $0.02 (Gemini Flash)
- Phase 3: 0 tokens
- Phase 2b: ~3K tokens/shape (includes gate source code)
- Total per run: $0.05-0.15

#### Integration
```
FAILURE-TAXONOMY.md
        │
  ┌─────┼──────────────┐
  │     │              │
hand   curriculum    real-world
stage  agent         harvesters
  │     │              │
  ▼     ▼              ▼
*.json  *-curriculum   *-real-world
        -staged.json   -staged.json
  │     │              │
  └─────┼──────────────┘
        │
  loadStagedScenarios()
        │
    runner.ts → ledger
        │
   ┌────┴────┐
   │         │
 clean?   dirty?
   │         │
 done    improve loop
```

#### Done When
- `curriculum-agent.ts` exists and produces valid scenarios
- Phase 3 validation rejects scenarios with bad search strings (critical guardrail)
- Running against uncovered shapes produces scenarios that load and pass/fail correctly
- Adversarial mode produces at least some scenarios that verify gets wrong (improve loop fuel)

---

## Future: Beyond P5

### P6: Fault Telemetry (3 Tiers)
When external users run `govern()`, their failures can optionally feed back to improve the gates for everyone:

| Tier | What's shared | Privacy | Config |
|------|--------------|---------|--------|
| 1 — Local | Nothing. Faults stay in `.verify/memory.jsonl` | Full | Default |
| 2 — Shapes | Anonymous shape gap IDs (which failure shapes triggered) | High | `telemetry: 'shapes'` |
| 3 — Full | Complete fault reports (edits, predicates, results) | Medium | `telemetry: 'full'` |

Tier 2 lets us see which shapes are failing in the wild without seeing anyone's code. Tier 3 gives us real-world scenarios directly from production agent failures. This is the network effect: "Your agent's first attempt is as smart as everyone's hundredth."

### P7: Domain Expansion (Wedge Strategy)

Verify currently gates code agents. The expansion follows a 3-tier wedge strategy — each tier proves the thesis to a wider audience:

**Tier 1: Land customers (prove the thesis)**

| Domain | Why first | Wedge story | Predicates needed |
|--------|----------|-------------|-------------------|
| **Next.js / React SSR** | Largest agent-writing population (Cursor, Windsurf, Claude Code). Rich failure shapes: hydration, RSC boundaries, CSS modules vs Tailwind. | "Your Cursor agent broke SSR hydration and you didn't know until production. Verify catches it in 3 seconds." | Hydration consistency, bundle size, Core Web Vitals (CSS/HTML/HTTP already built) |
| **Database Migrations** | Highest fear. Data loss, downtime, rollback nightmares. Scariest automation frontier. | "Your agent added a NOT NULL column without a default. Verify blocks it before production." | Referential integrity, data preservation (row count), index existence, constraint validation, reversibility proofs (schema predicates partially built) |
| **API Contracts / OpenAPI** | #1 cause of integration failures. Every team with external consumers lives in fear. | "Your agent removed a field from the API response. 47 downstream consumers would have broken." | Schema compatibility (breaking vs non-breaking), response shape, status code contracts (HTTP predicates built) |

**Tier 2: Prove universality (expand TAM)**

| Domain | Wedge story | New predicates |
|--------|-------------|----------------|
| **Infrastructure-as-Code** (Terraform/Pulumi) | "Your agent opened port 22 to 0.0.0.0/0." | Security group rules, cost ceilings, blast radius (Alexei Gate already built) |
| **Mobile** (React Native/Flutter) | "App store rejection takes days to fix, not minutes." | Navigation, platform rendering, permissions manifest |
| **CI/CD Pipeline Config** | "A bad pipeline change breaks every deploy for every team." | Step ordering, secret exposure, cache invalidation |

**Tier 3: Universal agent governance (the vision sale)**
- **Document/Content agents** — fact-checking, citation, PII detection
- **Communication agents** (Slack, email, tickets) — recipient validation, content policy, escalation paths

Each domain needs: grounding adapter, predicate types, validation logic, scenarios. Gate sequence and K5/G5 mechanics are universal. Design the adapter interface against the DB migration case (most rigorous type requirements) — if it handles referential integrity proofs, it handles anything.

### The Encoding Gate (Scenario Promotion Pipeline)
When the curriculum agent or chaos engine discovers a verify bug in a live session, the fault needs to be promoted to a permanent scenario. The encoding pipeline prevents taxonomy pollution:

```
live fault → normalize → dedupe → corroborate (seen 2+ times) →
classify (harness_fault vs app_failure) → only app_failures with
2+ corroborations get encoded as permanent scenarios
```

### Design Principles (Discovered Through 4 Phases)
1. **Prove harness before flood.** Get one scenario per category working before generating hundreds.
2. **Prioritize by truth delta.** Cover the failure shapes that change verify's verdict, not the ones that confirm it.
3. **Gate live failures before encoding.** Don't promote every fault — corroborate first.
4. **Measure shape quality not count.** One scenario that catches a real bug > 100 that pass cleanly.

---

## Critical Invariants (Do Not Break)

1. **Zero runtime dependencies.** verify() runs with no network, no LLM, no external services. The curriculum agent and improve loop use LLMs — the gate pipeline does not.

2. **The improve loop cannot edit frozen files.** `verify.ts`, `types.ts`, `scripts/harness/*`, `invariants.ts` are constitutionally protected.

3. **The holdout check cannot be weakened.** It's the safety net against overfitting.

4. **Synthetic scenarios are deterministic.** They never change unless a human edits a generator. The improve loop's split/holdout depends on this.

5. **Real-world scenarios are gitignored.** They're regenerated from live sources. They complement synthetic — they don't replace it.

6. **Cross-cutting gates scan ONLY `edit.replace` content.** Not the full file.

7. **One leaf = one predicate = one scenario.** The taxonomy hierarchy bottoms out at one testable assertion.

---

## Key Files

```
src/
  verify.ts              — Pipeline orchestrator (FROZEN)
  govern.ts              — Convergence loop
  types.ts               — All TypeScript interfaces (FROZEN)
  cli.ts                 — CLI: self-test, improve, etc.
  gates/                 — 25 gate implementations (11,034 LOC)

scripts/
  harvest/               — 100 synthetic generators (stage-*.ts)
  supply/
    sources.ts           — Real-world source registry (8 sources)
    harvest-real.ts      — Orchestrator (fetch → harvest → write)
    harvest-{db,css,html,http,security,infra}.ts — 6 format harvesters
    harvest.ts           — Legacy synthetic harvester
    fuzz.ts              — Scenario fuzzer
  harness/
    runner.ts            — Self-test runner
    improve.ts           — 7-step improve loop
    types.ts             — RunConfig, VerifyScenario, etc.
    external-scenario-loader.ts — Loads staged + real-world + WPT

fixtures/
  demo-app/              — Test fixture app (server.js, init.sql, etc.)
  scenarios/             — 99 synthetic staged JSON files
    real-world/          — 8 real-world staged JSON files (gitignored)

.github/workflows/
  nightly-improve.yml    — 5-stage CI pipeline

FAILURE-TAXONOMY.md      — 647 shapes × 30 domains
REAL-WORLD-SOURCES.md    — 100+ external sources mapped
HOW-IT-WORKS.md          — Plain-language system overview
SYSTEM-ANALYSIS.md       — March 29 baseline results + assessment
```

---

## Current Numbers

| Metric | Value |
|--------|-------|
| Gates | 25 |
| Synthetic scenarios | 11,867 |
| Real-world scenarios | 908 |
| Failure shapes covered | 596/647 (92%) |
| Parity grid | 80/80 (100%) |
| Unit tests | 354 (21,342 assertions) |
| Real-world sources | 8 |
| Runtime dependencies | 0 |
| Package LOC | 113,672 |

---

## The Bet

Most AI governance gates what goes INTO the agent. Verify gates what comes OUT.

The engineering is done. The gap is go-to-market. This roadmap closes that gap:
- P0 fixes the operational blocker
- P1 proves the product claim
- P2 expands the product surface
- P3 ships the public artifact
- P4 deepens the data moat
- P5 makes the supply chain self-sustaining
