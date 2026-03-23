# Verify — Next Moves (Handoff Prompt)

Written March 23, 2026. Read `ASSESSMENT.md` first for the value hierarchy. Read `FAILURE-TAXONOMY.md` for the algebra spec.

## Current State

| Metric | Value |
|--------|-------|
| npm version | 0.3.1 |
| Total scenarios | 506 (12 families: A-H, I, M, P, V) |
| Shape catalog (decompose.ts) | 91 rules across 12 domains |
| Known taxonomy shapes | 567 |
| Coverage | 258/567 (46% atomic) |
| Decomposition tests | 360 tests (180 decompose + 50 composition + 130 phase2), 1,249 assertions |
| Gates | 12 (all implemented) |
| Predicate types | 10 (all implemented) |

**What's built and working:** Pipeline (12 gates), self-test harness (506 scenarios), K5 constraint learning, decomposition engine (Phase 2 complete with minimization, scoring, claim-type decomposition, temporal modes, diagnostics; composition operators: product ×, temporal ⊗, round-trip decomposition verified; Phase 3 shape expansion complete — 91 rules across 12 domains), fault ledger, external scenarios, improve loop, chaos engine, message gate.

**Demo app fixture:** `fixtures/demo-app/server.js` (4 routes, inline HTML/CSS, 199 LOC) + `fixtures/demo-app/init.sql` (4 tables: users, posts, sessions, settings).

## The Build Order

### ~~Move 1: Composition Generators~~ — COMPLETE

**Completed March 23, 2026.**

**What was built:**
1. **Product composition operator (×):** 6 new interaction shapes (I-05 through I-10) in the catalog. `productComposition(shapeIdA, shapeIdB)` computes the product of two shapes from different domains. Covers CSS×HTTP, CSS×HTML, HTML×Content, HTTP×DB, CSS×Content, HTML×HTTP. Commutativity enforced via sorted domain-pair keys.

2. **Temporal composition operator (⊗):** `temporalComposition(shapeId, mode)` produces time-dependent variants for all 5 temporal modes (snapshot, settled, ordered, stable, fresh). Preserves all fields from the base shape.

3. **Round-trip decomposition:** `decomposeComposition(result, predicates)` verifies the algebra's closure property — compose → decompose recovers original components. All 6 product pairs verified. `getKnownCompositions()` enumerates the full composition map.

4. **17 new scenarios** in Family I: 6 product compositions + controls, 3 temporal compositions, 2 triple product compositions. Family I grew from 15 → 28 scenarios (11 failure classes).

5. **50 composition tests, 145 assertions** in `tests/unit/composition.test.ts` covering catalog shapes, product/temporal operators, known compositions enumeration, detection via decomposeFailure, round-trip closure, sorting/scoring, triple products, temporal annotation, and idempotence.

**Results:** Shape catalog 46 → 52. Total scenarios 471 → 488. Self-test harness: ALL CLEAN.

---

### ~~Move 2: DB Tier 2 (Mock Schema via init.sql)~~ — COMPLETE

**Completed March 23, 2026.**

**What was built:**
1. **`fixtures/demo-app/init.sql`** — 4-table PostgreSQL schema (users, posts, sessions, settings) covering: SERIAL, VARCHAR, TEXT, BOOLEAN, INTEGER, UUID, JSONB, TIMESTAMP types; NOT NULL, UNIQUE, PRIMARY KEY, FOREIGN KEY, DEFAULT constraints; 2 indexes.

2. **DB grounding parser** (`src/gates/grounding.ts`):
   - `parseInitSQL(sql)` — regex-based CREATE TABLE parser extracting table/column/type/nullable/hasDefault
   - `normalizeDBType(raw)` — type alias resolution (serial→integer, varchar(N)→varchar, bool→boolean, etc.)
   - `findAndParseSchema(appDir)` — searches init.sql in appDir, db/, sql/, schema.sql
   - DB validation in `validateAgainstGrounding()`: table_exists, column_exists, column_type with case-insensitive lookup and alias normalization
   - Populated `GroundingContext.dbSchema` (was defined in types.ts but never wired)

3. **D-* shape catalog expansion** (3 → 12 shapes in `decompose.ts`):
   - D-01/02/03: Fixed to use `pred.assertion` field instead of fragile regex on `p.expected`
   - D-04: Table name case sensitivity
   - D-05: Column name case sensitivity
   - D-06: Type alias normalization (serial, varchar(N), bool, etc.)
   - D-07: Fabricated table reference (grounding rejects)
   - D-08: Fabricated column reference (grounding rejects)
   - D-09: Type mismatch after normalization
   - D-10: Row count assertion stub (no live DB)
   - D-11: Row value assertion stub (no live DB)
   - D-12: Constraint/index exists stub

4. **18 new DB scenarios** in scenario-generator.ts: grounding validation (fabricated tables/columns, type mismatches), case sensitivity, type alias normalization (serial, varchar, bool), valid grounded predicates, JSONB type, multi-predicate submission, data assertion stubs.

**Results:** Shape catalog 52 → 64. Total scenarios 488 → 506. Self-test harness: ALL CLEAN. 310 tests, 0 failures.

---

### ~~Move 3: Decomposition Engine Phase 3 — Shape Catalog Expansion~~ — COMPLETE

**Completed March 23, 2026.**

**What was built:**
1. **CSS shape expansion (16 new):** C-02 (RGB↔hex), C-03 (HSL↔hex), C-04 (RGBA alpha=1), C-06 (whitespace normalization), C-11 (auto/inherit/initial keywords), C-13 (em context-dependent), C-14 (percentage context-dependent), C-15 (new property not in source), C-32 (property not in selector source), C-34 (cross-route variance), C-35 (specificity/cascade), C-40 (inherited vs authored), C-42 (multi-block merge failure), C-45 (keyword↔numeric e.g. normal/400), C-49 (modern color syntax), C-52 (rem context-dependent). Helper functions: `isRgbValue()`, `isHexValue()`, `isHslValue()`, `isRelativeUnitMismatch()`, `isKeywordNumericMismatch()`.

2. **HTML shape expansion (3 new):** H-03 (wrong element tag), H-20 (element count mismatch), H-23 (dynamic/JS-rendered element grounding miss).

3. **HTTP shape expansion (2 new):** P-12 (method mismatch), P-15 (expected redirect got direct).

4. **Content shape expansion (2 new):** N-04 (regex-special chars matched literally), N-08 (partial substring false positive).

5. **Filesystem shape expansion (3 new):** FS-07 (hash drift detected), FS-12 (missing file/path field — structural predicate deficiency), FS-17 (extra files detected with directional count check).

6. **Cross-cutting shape expansion (2 new):** X-40 (empty search string), X-41 (line ending mismatch).

7. **Attribution shape expansion (2 new):** AT-03 (compound error first-match extraction), AT-04 (first gate failure masks downstream — requires known F9 error pattern).

8. **DOMINANCE map expanded** with 4 new entries (C-35→C-33, C-42→C-33, FS-03→FS-07, FS-04→FS-17) to prevent false co-occurrence.

9. **Key invariant enforced:** Shapes must NOT match on `p.passed === true` — passing predicates pollute failure decompositions. 5 shapes removed/commented (H-04, P-01, P-10, C-43) that were structurally indistinguishable from more general passing shapes.

**Results:** Shape catalog 64 → 91 (target was 80-90). Self-test harness: 506 scenarios, ALL CLEAN. Unit tests: 310 pass, 0 fail.

---

### Move 4: Quality Surface Predicate Types (Wave 5)

**Why fourth:** Opens 5 entirely new domains that don't exist today. Each needs a new predicate type in `types.ts`, a new gate (or gate branch), and new scenarios. This is the most architecturally significant work — it expands what verify CAN verify.

**New domains (in priority order):**

1. **Serialization (SER-01 through SER-07):** JSON schema validation, float precision, null semantics, date serialization, boolean handling, nested object comparison, array ordering. Predicate type: `json_schema` or `serialization`. Gate: compare parsed structures, not string equality.

2. **Configuration (CFG-01 through CFG-08):** Environment variable presence, feature flag state, config precedence, dotenv parsing, missing required config, type coercion, default fallback, override chain. Predicate type: `config`. Gate: parse .env/.json/.yaml config files.

3. **Security (SEC-01 through SEC-07):** XSS detection in output, SQL injection in queries, CSRF token presence, auth header requirements, secrets in logs, content security policy, CORS configuration. Predicate type: `security`. Gate: pattern matching + content scanning.

4. **Accessibility (A11Y-01 through A11Y-08):** ARIA labels, keyboard navigation, color contrast, alt text, heading hierarchy, focus management, screen reader compatibility, landmark regions. Predicate type: `a11y`. Gate: HTML structure analysis (pure) or axe-core (Docker).

5. **Performance (PERF-01 through PERF-06):** Response time threshold, bundle size limit, LCP target, image optimization, lazy loading, connection count. Predicate type: `performance`. Gate: HTTP timing + content size analysis.

**Dependencies:** Each domain is independent. Start with serialization (most pure, no Docker).

**Estimated work per domain:** 5-8 scenarios, 1 new gate file, 1 new predicate type. Total: 25-40 scenarios across 5 domains.

**Files to modify:**
- `src/types.ts` — new predicate types in Predicate union
- `src/gates/` — new gate file per domain
- `src/verify.ts` — wire new gates into pipeline
- `scripts/harness/scenario-generator.ts` — new families
- `src/store/decompose.ts` — new domain shape rules

---

### ~~Move 5: Improve Loop Hardening (10 Known Gaps)~~ — COMPLETE

**Completed March 23, 2026.**

**What was fixed (all 10 gaps in `@sovereign-labs/improve`):**

1. **Gap 1 — Timeout scoring** (`subprocess.ts`): Subprocess timeout scored as 0 (inconclusive), not -50 (regression). Timeout is infrastructure, not agent fault. Retry with 2× timeout before giving up.

2. **Gap 2 — JSON parsing** (`utils.ts`): `extractJSON` refactored with proper brace/bracket matching. Strategy 3 now tries both `[` and `{` starting characters. Extracted `extractBalancedBlock()` helper with string-aware depth tracking. Fence stripping regex handles inline and multi-line fence styles.

3. **Gap 3 — Edit error propagation** (`subprocess.ts`, `types.ts`): Added `editErrors` field to `CandidateResult`. Zero-applied-edits returns error details instead of silent failure. Per-edit failure reasons (search not found, file missing) propagated through the pipeline.

4. **Gap 4 — Rate limit handling** (`utils.ts`, `providers.ts`): Exponential backoff with jitter (30s × 2^attempt, capped at 5 min). All 4 providers (Gemini, Anthropic, Claude, Ollama) now propagate `err.status` and `err.headers` on HTTP errors. Network errors retry up to `maxRetries` with increasing delay.

5. **Gap 5 — Holdout bias** (`subprocess.ts`): Regression threshold changed from `holdoutSize < 10 ? 2 : 1` to always 1. Any regression on a small holdout is significant. Minimum holdout guarantee: at least 3 scenarios when 6+ clean available.

6. **Gap 6 — Cross-run dedup** (`improve.ts`): Track ALL tried hashes in cross-run history (not just failed ones). LLM won't regenerate candidates already tried in prior runs, regardless of outcome.

7. **Gap 7 — Prior attempts in all bundles** (`improve.ts`): Prior attempt context injected into fix generation for ALL confidence levels (mechanical, heuristic, needs_llm), not just when LLM diagnosis exists.

8. **Gap 8 — Partial credit ranking** (`improve.ts`): Ranking now uses `partialScore` as tie-breaker when `score` is equal. Partial improvements surface when no candidate achieves positive score.

9. **Gap 9 — Holdout confidence enforcement** (`improve.ts`, `types.ts`): New `minHoldoutConfidence` config option ('low' | 'medium' | 'high'). When holdout confidence is below threshold, fix is rejected as overfitting even if holdout passed clean.

10. **Gap 10 — Cross-run constraint memory** (`improve.ts`, `types.ts`): `ImproveHistoryRun` now records per-candidate files/regressions and derives `learnedConstraints` (file_causes_regression, strategy_ineffective, scenario_fragile). Constraints injected into LLM context for future runs.

**Files modified:**
- `packages/improve/src/utils.ts` — extractJSON rewrite, callLLMWithRetry exponential backoff
- `packages/improve/src/providers.ts` — HTTP error status/headers propagation (all 4 providers)
- `packages/improve/src/subprocess.ts` — timeout scoring, edit error propagation, holdout threshold
- `packages/improve/src/types.ts` — editErrors field, minHoldoutConfidence, learnedConstraints
- `packages/improve/src/improve.ts` — cross-run dedup, prior attempts injection, partial ranking, confidence enforcement, constraint derivation/injection

---

### Move 6: Infrastructure Predicates (The Alexei Gate)

**Why this matters:** Two weeks ago, an AI coding agent wiped a production database — 1.9 million rows of student data, backups included. The agent made no technical errors. Every action was logically correct. It simply didn't know it was operating on production infrastructure. The only thing that could have prevented it was a structural check that ran before the destroy command — exactly what verify's gate sequence does, but for a domain verify doesn't cover yet.

This is the domain with the most dramatic failure case, the clearest market signal, and the highest leverage for verify's positioning as a domain-agnostic governance layer.

**The core insight:** Alexei's agent needed three checks that didn't exist:
1. "Is this resource tagged as production?" (before destroying)
2. "Does the state file I'm operating on match the known production manifest?" (before any bulk change)
3. "After this change, do the production resources still exist?" (after the change)

These map directly to verify's existing patterns: grounding (check reality before acting), predicates (testable claims), invariants (must hold after every change).

**New predicate types (3):**

```typescript
// 1. Resource existence — does a named resource exist in a state file or API?
{ type: 'infra_resource', resource: 'aws_db_instance.production', assertion: 'exists' }
{ type: 'infra_resource', resource: 'aws_db_instance.production', assertion: 'absent' }

// 2. Resource attribute — does a resource have a specific tag/property?
{ type: 'infra_attribute', resource: 'aws_db_instance.production', attribute: 'tags.Environment', expected: 'production' }
{ type: 'infra_attribute', resource: 'aws_rds_cluster.main', attribute: 'deletion_protection', expected: 'true' }

// 3. State manifest — does the current state match a known-good manifest?
{ type: 'infra_manifest', stateFile: 'terraform.tfstate', assertion: 'matches_manifest' }
{ type: 'infra_manifest', stateFile: 'terraform.tfstate', assertion: 'no_production_drift' }
```

**New gate: `src/gates/infrastructure.ts`**

The gate checks infrastructure state **without executing commands**. Three verification modes:

| Mode | How it checks | No network? |
|------|---------------|-------------|
| **State file** | Parse `terraform.tfstate` / `pulumi.state.json` / CloudFormation template as JSON. Extract resources, attributes, tags. | Yes — pure file parsing |
| **Manifest comparison** | Diff current state file against a known-good manifest (committed baseline). Flag drift. | Yes — file comparison |
| **Live query** (optional) | Call cloud API to verify resource exists. Requires credentials. | No — network call |

**For self-test (pure mode only):** Fixtures include mock state files. No cloud credentials needed. The gate parses JSON, not AWS APIs.

**Fixture: `fixtures/demo-infra/terraform.tfstate`**

Mock Terraform state file with ~10 resources: a production RDS instance, a staging RDS instance, an S3 bucket, a VPC, security groups, an ECS cluster. Tagged with `Environment: production` vs `Environment: staging`. This is the equivalent of `init.sql` for the infrastructure domain — a representative fixture the grounding gate can parse.

**Fixture: `fixtures/demo-infra/manifest.json`**

Known-good baseline: list of production resource IDs + types + critical attributes. The `infra_manifest` predicate compares current state against this.

**Infrastructure shapes (INFRA-01 through INFRA-12):**

| # | Shape | Claim Type | Notes |
|---|---|---|---|
| INFRA-01 | Resource doesn't exist | existence | Resource expected but not in state file |
| INFRA-02 | Resource exists when should be absent | absence | Duplicate/orphan resource detected |
| INFRA-03 | Wrong environment tag | equality | Resource is production, agent thinks it's staging |
| INFRA-04 | Missing deletion protection | existence | Critical resource lacks safeguard attribute |
| INFRA-05 | State file drift from manifest | invariance | Current state doesn't match committed baseline |
| INFRA-06 | Bulk destroy scope exceeds intent | containment | Agent wants to remove 3 resources, command affects 47 |
| INFRA-07 | Archived config contamination | existence | Old state file mixed with current — foreign resources appear |
| INFRA-08 | Resource type mismatch | equality | Expected `aws_db_instance`, found `aws_rds_cluster` |
| INFRA-09 | Cross-account resource reference | existence | Resource ID references wrong AWS account |
| INFRA-10 | Provider-specific naming | equality | Same resource, different name convention across clouds |
| INFRA-11 | Dependency chain break | causal | Destroying VPC would orphan 12 dependent resources |
| INFRA-12 | State file format mismatch | existence | Terraform v0.12 state parsed as v1.0 — silent field drops |

**Grounding for infrastructure:**

Add `infra` branch to `validateAgainstGrounding()` in `grounding.ts`:
- Parse state file from fixture directory (same pattern as `findAndParseSchema` for DB)
- Validate `infra_resource` predicates against parsed resources
- Mark `groundingMiss` on resources not found in state
- Mark `groundingMiss` on attributes not present on resource

**K5 learning — what Alexei's scenario seeds:**

After a bulk destroy hits production resources:
- Constraint: `forbidden_action` on bulk infrastructure mutations without manifest comparison
- Constraint: `predicate_fingerprint` ban on the specific resource set that was incorrectly targeted
- Next attempt: agent must verify environment tags before any destroy operation

**The Alexei scenario as a self-test case:**

```typescript
// The exact failure mode: agent operates on archived production state
{
  id: 'INFRA_alexei_scenario',
  family: 'G',
  description: 'Alexei scenario: bulk destroy targets production resources from archived config',
  edits: [],  // No file edits — this is about infrastructure state
  predicates: [
    { type: 'infra_resource', resource: 'aws_db_instance.production', assertion: 'exists' },
    { type: 'infra_attribute', resource: 'aws_db_instance.production', attribute: 'tags.Environment', expected: 'production' },
  ],
  invariants: [
    shouldNotCrash('INFRA alexei scenario'),
    groundingRan(),
    predicateIsGrounded(0),  // Production DB exists in state
  ],
}
```

**What to build:**
1. `fixtures/demo-infra/terraform.tfstate` — Mock state file (~10 resources, production + staging)
2. `fixtures/demo-infra/manifest.json` — Known-good production baseline
3. `src/gates/infrastructure.ts` — State file parser + resource/attribute/manifest verification
4. Infrastructure predicate types in `src/types.ts`
5. Wire gate into `src/verify.ts`
6. Grounding branch in `src/gates/grounding.ts` for infrastructure state parsing
7. INFRA-01 through INFRA-12 shapes in `src/store/decompose.ts`
8. ~15-20 scenarios in `scripts/harness/scenario-generator.ts`

**Dependencies:** None. Infrastructure parsing is pure JSON — no cloud credentials, no Docker, no network.

**Estimated work:** 3 new predicate types, 1 new gate file, 2 fixture files, 12 shapes, ~20 scenarios. Self-test stays pure (mock state files only).

**The headline:** `verify` could have stopped Alexei's disaster. Not with a fancier model. Not with a bigger context window. With a predicate: `{ type: 'infra_attribute', resource: 'aws_db_instance.production', attribute: 'tags.Environment', expected: 'production' }`.

---

## What NOT to Build Next

- **Browser predicate types (Phase 4):** Deferred. Needs 4 new predicate types (interaction, navigation, visibility, storage) that require Playwright infrastructure. High effort, low coverage gain per shape.
- **Wave 3 infrastructure expansion:** Most of these are structural stubs already placed. The next coverage gain comes from composition (Move 1) and DB (Move 2), not from expanding stubs.
- **npm publish:** Don't publish until at least Move 3 is complete. Move 6 (infrastructure) is the headline for market positioning.

## Summary: The Correct Order

| Move | What | Why Now | Coverage Impact |
|------|------|---------|-----------------|
| ~~**1**~~ | ~~Composition generators~~ | ~~COMPLETE~~ | +6 interaction shapes, 17 scenarios, 50 tests |
| ~~**2**~~ | ~~DB Tier 2 (init.sql)~~ | ~~COMPLETE~~ | +12 DB shapes, 18 scenarios, grounding parser |
| ~~**3**~~ | ~~Shape catalog expansion~~ | ~~COMPLETE~~ | +27 shapes (64→91), 8 domains expanded |
| **4** | Quality surface predicates | Opens 5 new domains, expands what verify CAN verify | +5 new domains |
| ~~**5**~~ | ~~Improve loop hardening~~ | ~~COMPLETE~~ | 10/10 gaps fixed, cross-run learning |
| **6** | Infrastructure predicates | The Alexei Gate — stop production destruction | +1 new domain, 12 shapes, 3 predicate types |

Moves 1-3 are the decomposition engine completing its contract. Move 4 is pipeline expansion. Move 5 is loop reliability. Move 6 is the market story — the domain where verify's value proposition is most viscerally obvious.
