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
| Synthetic self-test (post-P0) | **5,253 scenarios, 5,248 clean, 5 dirty** | 24 min. 1 skipped (>500KB edit). Dirty scenarios were capacity gate false positives — fixed. |
| Improve loop (P1) | **ACCEPTED** | Full cycle: baseline → diagnose → generate → validate → holdout → accepted. Score +0.8, 0 regressions. |

**Verdict:** All systems operational. Gates healthy. Improve loop acceptance path proven.

### What's Working
- **25 gates** — grounding, syntax, constraints, containment, filesystem, infrastructure, security, a11y, performance, staging, browser, HTTP, and 13 more. 354 unit tests, 21,342 assertions, 0 failures.
- **Convergence loop** — `govern()` wraps `verify()` with K5 constraint learning. Proven by 15 scenarios.
- **Supply chain** — Five scenario strategies, each with a different purpose:
  - **Synthetic generators:** 100 stage-*.ts scripts → 11,867 scenarios. Tests known failure shapes. Deterministic.
  - **Real-world harvesters:** 6 harvesters → 908 scenarios from 8 public sources. Tests patterns humans wouldn't write.
  - **WPT corpus:** 7,291 web platform test scenarios. Browser conformance ground truth.
  - **Gate audit:** Read gate source code, identify implementation weaknesses, write targeted scenarios designed to break specific gates. Highest ROI — every dirty scenario = a real bug.
  - **Curriculum agent (P5):** LLM reads taxonomy, generates scenarios for uncovered shapes + adversarial hardening of thin shapes.
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

### P0: Fix Runner Crash — DONE (March 29)

**Result:** 5-line filter in `runner.ts` skips scenarios with >500KB total edit size. Self-test completes: 5,253 scenarios, no exit 99 watchdog kill. Local watchdog relaxed to 10 minutes (vs 5 minutes CI).

**Also fixed:** Capacity gate false positive on WHERE-bounded SQL queries (`capacity.ts:135`). SELECT with WHERE clause is bounded — not a "full table scan." Resolved 5 pre-existing dirty scenarios in security/SQL injection detection.

---

### P1: Prove Improve Loop Acceptance Path — DONE (March 29)

**Result:** Full acceptance cycle completed end-to-end.

```
Baseline (4,845 scenarios, 2 dirty) → Bundle (security.ts) →
Diagnose (eval_disabled regex on lines 70+201) → Generate (3 candidates) →
Validate ("Minimal Regex Correction" score +0.8, 1 improvement, 0 regressions) →
Holdout (clean) → ACCEPTED
```

**The claim "self-improving gates" is now proven with evidence.** Verdict: `accepted` in `data/improvement-ledger.jsonl`.

#### What was learned: Line-to-Search Grounding

The original improve loop asked the LLM to produce exact `search` strings matching source code. This was brittle — the LLM consistently diagnosed the right bug but couldn't reproduce exact whitespace/formatting. Score: -100 (edits=0/2) on every attempt.

**The fix:** Separate what the LLM does well (diagnosis + line identification) from what code does well (reading exact file content).

```
LLM says: { line: 77, replace: "new content" }
Code reads: actual line 77 from the file → sets search = actualContent
Result: search string guaranteed to match (it came from the file, not the LLM)
```

This evolved into **pattern-based edits**: the LLM says `{ pattern: "eval_disabled", replacement: "eval" }`, the code greps the file for all occurrences, and builds grounded search/replace from the actual line content. Score +1.8 (2 improvements, 0 regressions). Both lines 77 and 199 found from a single pattern. The `[PATTERN]` log entry confirms each grounding.

**Infrastructure changes for P1:**
- Line-based edits `{ line, replace }` alongside search/replace in `types.ts`, `improve-subprocess.ts`
- Line-to-search grounding in `improve-prompts.ts` (post-processing step)
- `GEMINI_MODEL` env var in `llm-providers.ts` (configurable model selection)
- Enhanced diagnosis prompt with scenario descriptions + gate failure details
- Source view without line-number prefixes (prevents LLM from copying them into search strings)
- Relaxed local watchdog (10 min) in `runner.ts`

---

### P1.5: Gate Audit — 10 Targeted Bug Scenarios
**Effort:** 2-4 hours
**Unblocks:** Real gate improvements via the improve loop

#### Why This Is Highest ROI

The 594 synthetic scenarios we wrote confirmed gates that already work. The real-world harvesters found 0 dirty scenarios. We need scenarios that **break** gates, not confirm them. A deep audit of gate source code identified 10 probable bugs — each one a specific code weakness with a specific input that would trigger it.

10 targeted scenarios that find real bugs > 500 scenarios that confirm working gates.

#### The 10 Probable Bugs

| # | Gate | Bug | Input That Breaks It | Direction |
|---|------|-----|---------------------|-----------|
| **1** | Grounding | `extractHTMLElements` regex `/<([\w-]+)([^>]*)>([^<]*)<\/\1>/g` ignores nested tags | `<h2><strong>Roster</strong></h2>` → invisible to grounding | False positive (CRITICAL) |
| **2** | Grounding | CSS shorthand resolver `_rS` is positional but CSS shorthands aren't | `border: solid 3px red` → `border-color` resolves to `solid` | Both directions (HIGH) |
| **3** | Security | Comment-skip `startsWith('*')` misses test fixtures and inline comments | Test file with `api_key: 'test-key-12345'` flagged as leaked secret | False positive (HIGH) |
| **4** | A11y | Heading regex `/<h([1-6])\b/gi` matches inside HTML comments and JS strings | `<!-- <h3>Old</h3> -->` triggers heading skip violation | False positive (MEDIUM-HIGH) |
| **5** | Propagation | `extractCSSClassNames` regex requires `{,:` after class — misses `.a .b { }` | `.roster-link .player-name {}` → only `.player-name` captured | False negative (HIGH) |
| **6** | State | Env pattern `[A-Z_][A-Z0-9_]*` only matches SCREAMING_CASE | `process.env.databaseUrl` not detected | False negative (MEDIUM) |
| **7** | Temporal | `extractRoutes` matches all `/path` string literals including file paths | `'/public/images'` flagged as a route | False positive (MEDIUM) |
| **8** | Containment | `.replace('.','')` + `includes()` — `.a` matches any string containing `a` | Predicate `.btn`, edit has `submitBtn` → false "direct" attribution | False negative (HIGH) |
| **9** | Security | SQL injection scanner is line-by-line — misses multi-line queries | `pool.query(\n  \`SELECT * FROM users WHERE id = ${id}\`\n)` not caught | False negative (MEDIUM-HIGH) |
| **10** | Grounding | `_nC` doesn't expand 3-digit hex `#fff` → `#ffffff` | `white` vs `#fff` fails grounding comparison | False positive (HIGH) |

#### Implementation

Write `scripts/harvest/stage-gate-audit.ts` — 10 scenarios, each targeting one specific bug:

```typescript
// Example: Bug #1 — nested HTML elements
{
  id: 'audit-001',
  description: 'Grounding: nested HTML element should be visible',
  edits: [{ file: 'server.js', search: '<h2>Team</h2>', replace: '<h2><strong>Team</strong></h2>' }],
  predicates: [{ type: 'html', selector: 'h2', content: 'Team' }],
  expectedSuccess: true,  // gate SHOULD pass (h2 with Team exists)
  tags: ['gate-audit', 'grounding', 'nested-html'],
  rationale: 'extractHTMLElements regex [^<]* cannot see text inside nested child elements',
}
```

Run, collect dirty results, feed to improve loop. Each dirty scenario = a gate fix.

#### Done When
- 10 scenarios written and run
- Dirty count reported (expected: several of the 10 should be dirty)
- Dirty scenarios fed to improve loop or manually fixed
- Gates measurably stronger

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

### P3.5: Developer Experience + Demo
**Effort:** 1-2 days
**Unblocks:** Go-to-market — the bridge between engineering and adoption

#### The Problem

Verify's internal language (K5, G5, F9, "containment attribution," "narrowing injection," "convergence loop," "epoch staleness," "parity grid cells") is engineering terminology that means nothing to someone evaluating the package. The gates work. But nobody will discover that if the first thing they see is jargon.

#### Two Layers of Language

**What the user sees** (human-readable, zero jargon):
```
verify: FAIL
  ✗ That CSS selector doesn't exist in your code
  ✗ Your edit changed files you didn't declare
  → Try: use .nav-link instead of .sidebar-nav
```

**What the developer sees** (if they dig into the result object):
```
Gate: grounding (FAIL) — selector .sidebar-nav not found in server.js
Gate: containment/G5 (FAIL) — 2 unexplained mutations
Narrowing: { hint: "use .nav-link", bannedFingerprints: [...] }
```

The internals stay complex. The surface stays simple. Same package, two audiences.

#### Three Output Surfaces

| Surface | Consumer | What matters |
|---------|----------|-------------|
| **CLI** (`npx @sovereign-labs/verify check`) | Developer trying it out | First impression. Zero jargon. Plain English. |
| **`VerifyResult.attestation`** | Agent framework displaying status | Human-readable summary shown in UI |
| **`VerifyResult.narrowing.hint`** | LLM receiving feedback to retry | Clear enough for both humans reading logs AND LLMs acting on it |
| **`VerifyResult.gates[].detail`** | Developer debugging a specific gate | Can stay technical — they're already deep |

The primary consumers after launch will be **agent framework builders** (LangChain, CrewAI, custom loops) who wrap verify and surface results to their users. They read `VerifyResult` in code. Their users see `attestation`.

#### The Demo Command

```bash
npx @sovereign-labs/verify demo
```

Runs a pre-built `govern()` convergence loop that tells a story in 3 iterations:

```
═══ Verify Demo: Agent Convergence Loop ═══

Goal: "Add a profile section to the about page"

Iteration 1 of 3:
  Applying 2 edits to server.js...
  Running 25 verification gates...
  ✗ FAIL — That CSS selector doesn't exist in your code (.profile-nav)
  → Learning: won't try .profile-nav again
  → Hint: available selectors on /about include .nav-link, .hero, .card

Iteration 2 of 3:
  Applying 2 edits to server.js...
  Running 25 verification gates...
  ✗ FAIL — Your edit changed 3 files but only declared changes to 1
  → Learning: edits must match declarations
  → Hint: declare all files you intend to modify

Iteration 3 of 3:
  Applying 1 edit to server.js...
  Running 25 verification gates...
  ✓ PASS — All 25 gates clear

Converged in 3 iterations.
Each failure narrowed the search space. The agent can't repeat mistakes.
```

No video needed. No website. Ships with the npm package. First thing anyone runs.

**The demo story isn't "the model is dumb."** It's "even the best model benefits from a verification loop that remembers what failed."

#### Implementation

1. **Audit `attestation` strings** across all 25 gates — rewrite to plain English. No gate codes in the user-facing summary. "Grounding gate failed: selector not found" → "That CSS selector doesn't exist in your code."

2. **Audit `narrowing.hint`** strings — make them actionable for both humans and LLMs. "Banned fingerprint" → "This exact approach already failed. Try a different selector."

3. **Build `demo` CLI command** — `src/cli.ts` case 'demo'. Pre-built scenario with 3 iterations showing grounding fail → containment fail → pass. Uses `govern()` internally. Prints human-readable output. ~100 LOC.

4. **Rewrite README top 50 lines** — zero jargon first impression. The engineering terminology lives in FAILURE-TAXONOMY.md and ASSESSMENT.md for people who want depth. The README speaks to someone who's never heard of verify.

#### Done When
- `npx @sovereign-labs/verify demo` runs and prints the convergence story
- `attestation` strings on all gates are human-readable
- README first 50 lines contain zero internal jargon (no K5, G5, F9, "containment," "narrowing injection")
- Someone who's never seen verify can understand the README and run the demo in under 60 seconds

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

### P7: Domain Expansion (Provider Model + Action Gate)

#### Drop the "Adapter" Framing

The original plan called for per-domain adapters. Building the filesystem and infrastructure gates proved this was wrong — K5, G5, grounding, narrowing all worked unchanged. No new gates were written. New domains were added by:

1. Adding a predicate type to the union
2. Adding a validation function

That's it. The word "adapter" implies heavyweight plugin architecture. What's actually needed is two small functions per domain.

#### The Provider Interface (2 functions per domain)

```typescript
// Grounding provider — what exists in this system right now?
type GroundingProvider = () => Promise<GroundingContext>;

// Evidence provider — did the claimed action actually happen?
type EvidenceProvider = (claim: string) => Promise<{ exists: boolean; fresh: boolean; detail: string }>;
```

Examples — all return the same shape:

```typescript
// Gmail
ground: () => ({ contacts, labels, drafts, recentSent })
evidence: (claim) => { check Sent folder via Gmail API → { exists, fresh, detail } }

// Discord
ground: () => ({ channels, roles, recentMessages })
evidence: (claim) => { check channel messages via Discord API → { exists, fresh, detail } }

// OpenClaw / any task system
ground: () => ({ tasks, agents, schedules, lastRuns })
evidence: (claim) => { check task status via API → { exists, fresh, detail } }

// Outlook
ground: () => ({ contacts, folders, rules, calendar })
evidence: (claim) => { check calendar via Graph API → { exists, fresh, detail } }
```

Each provider is a ~50-line file wrapping a platform API. Ship as thin npm packages: `@sovereign-labs/verify-gmail`, `verify-discord`, etc.

#### The Action Gate (1 new gate)

Generalized version of the message gate's claim-evidence pipeline. Not limited to messages — any agent claiming it did something gets verified:

```
┌─────────────────────────────────────────────┐
│              verify() pipeline              │
│  Grounding → F9 → K5 → G5 → ... → Action   │
│                                     Gate    │
└──────────────────────┬──────────────────────┘
                       │
          ┌────────────┴────────────┐
          │     Action Gate         │
          │                         │
          │  1. Parse claim         │
          │  2. Call evidence()     │
          │  3. Check freshness     │
          │  4. Pass/fail           │
          └────────────┬────────────┘
                       │
          ┌────────────┴────────────┐
          │  Provider Registry      │
          │                         │
          │  gmail:    { ground, evidence }  ← npm package or user-supplied
          │  discord:  { ground, evidence }  ← npm package or user-supplied
          │  openclaw: { ground, evidence }  ← user writes 2 functions
          │  custom:   { ground, evidence }  ← user writes 2 functions
          └─────────────────────────┘
```

New predicate type:
```typescript
{ type: 'action_completed', system: 'gmail', check: 'message_in_sent', params: { to: 'team@...' } }
{ type: 'action_completed', system: 'discord', check: 'message_in_channel', params: { channel: '#deploys' } }
{ type: 'action_completed', system: 'openclaw', check: 'task_status', params: { task: 'write-report', status: 'done' } }
```

#### The Real-World Pain (Why This Matters)

From a Reddit thread about OpenClaw: "The agent says it will do X, Y, and Z, and then nothing happens." One user spent 30 hours trying to fix agent autonomy. This is the claim-without-evidence problem.

With verify:
```typescript
const result = await govern({
  goal: 'Write the weekly report and update the task',
  providers: {
    ground: () => openclaw.getTasks(),
    evidence: {
      task_updated: (claim) => {
        const task = openclaw.getTask(claim.taskId);
        return { exists: task.modifiedAt > attemptStartTime, fresh: true };
      },
      file_created: (claim) => {
        return { exists: fs.existsSync(claim.path), fresh: true };
      }
    }
  }
});
// Agent claims "report written" but file doesn't exist → BLOCKED
// Agent claims "task updated" but modifiedAt is stale → BLOCKED
// K5 remembers the lying pattern → banned next session
```

No more "apologizing and repeating the same mistake." K5 bans the pattern permanently.

#### Market Wedge (3 Tiers)

**Tier 1: Land customers (prove the thesis)**

| Domain | Wedge story | What's needed |
|--------|-------------|---------------|
| **Next.js / React SSR** | "Your Cursor agent broke SSR hydration. Verify catches it in 3 seconds." | Hydration predicate type + grounding provider |
| **Database Migrations** | "Your agent added NOT NULL without a default. Verify blocks it." | Referential integrity predicates (schema predicates partially built) |
| **API Contracts / OpenAPI** | "Your agent removed a response field. 47 consumers would have broken." | Schema compatibility predicates (HTTP predicates built) |

**Tier 2: Prove universality (expand TAM)**

| Domain | Wedge story | What's needed |
|--------|-------------|---------------|
| **Infrastructure-as-Code** | "Your agent opened port 22 to 0.0.0.0/0." | Provider for Terraform state (Alexei Gate already built) |
| **Task Systems** (OpenClaw, Linear, Jira) | "Your agent said it updated the task. It didn't." | `action_completed` predicate + task API provider |
| **Communication** (Gmail, Slack, Discord) | "Your agent sent the email to the wrong person." | `action_completed` predicate + messaging API provider |

**Tier 3: Universal agent governance (the vision sale)**
- **Document agents** — fact-checking, citation, PII detection
- **Mobile agents** — app store rejection prevention
- **CI/CD agents** — pipeline config verification

#### What Changes Per Domain

| Component | Changes? |
|-----------|----------|
| Gate sequence (25 gates + action gate) | **No** |
| K5 constraints | **No** |
| G5 containment | **No** |
| Narrowing | **No** |
| Grounding provider | **Yes** — 1 function per domain (~50 LOC) |
| Evidence provider | **Yes** — 1 function per domain (~50 LOC) |
| Predicate types | **Yes** — add to union + validator |
| Scenarios | **Yes** — new test cases |

The gates are the architecture. The predicates are the extension model. The providers are just I/O plumbing.

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
