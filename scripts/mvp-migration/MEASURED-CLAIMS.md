# Verify Migration Verification — Measured Claims

Last updated: 2026-04-12 (Phase 1 — corrected reporting semantics applied)

## DM-18: NOT NULL without safe preconditions

On a reviewed replay set of 761 real migrations across 3 repos, DM-18 produced 19 true positives and 0 false positives.

### Methodology

- **Corpus:** 761 Postgres migration files from 3 open-source production repos (cal.com 590, formbricks 140, supabase examples 31).
- **Migration style:** Prisma-generated SQL migrations (cal.com, formbricks) and hand-written Supabase migrations.
- **Schema replay:** For each migration N, schema was built by replaying migrations 0..N-1 using libpg-query (v17.7.3, WASM) + a custom schema loader with progressive per-op updates.
- **Gates:** Grounding gate (DM-01..05) + safety gate (DM-15..19) run against each migration.
- **Calibration:** All 19 findings were manually reviewed and labeled TP/FP/ambiguous by the author. Calibration file: `reports/calibration-postfix-2026-04-12.jsonl`.

### What DM-18 catches

- `ADD COLUMN ... NOT NULL` without a `DEFAULT` clause — will fail on any non-empty table.
- `ALTER COLUMN ... SET NOT NULL` on a column that is currently nullable and has no default — will fail if any existing rows contain NULL.

### What DM-18 does not catch

- NOT NULL additions with a `DEFAULT` clause (these are safe and correctly pass).
- NOT NULL additions on tables that happen to be empty (the rule has no runtime knowledge of row counts — it flags the structural risk regardless).
- NOT NULL additions inside transactions with prior data-backfill `UPDATE` statements (the rule checks structural preconditions, not data-flow within the migration).

### Limitations

- Corpus is Prisma-heavy (730 of 761 files). Precision on hand-written SQL, Django, Rails, or Alembic migrations is unmeasured.
- Schema replay depends on libpg-query's ability to parse prior migrations. Statement types not handled by the schema loader (enums, triggers, policies, functions) are skipped — this can cause incomplete schema state in rare cases.
- 0% false-positive rate is measured on this specific corpus. Do not generalize to all Postgres migration styles without additional testing.

### Reproducibility

```bash
# Clone the corpus
bun run scripts/mvp-migration/backtest.ts

# Run the replay with gates
bun run scripts/mvp-migration/replay-engine.ts

# Output: reports/replay-findings-YYYY-MM-DD.jsonl
# Compare against: reports/calibration-postfix-2026-04-12.jsonl
```

### Progression

| Run | Total findings | TP | FP | Ambiguous | Precision |
|-----|---------------|----|----|-----------|-----------|
| Pre-fix (initial) | 664 | — | — | — | — |
| Post-progressive-schema | 40 | 19 | 13 | 8 | 48% |
| Post-platform-exclusion + per-op + constraint-name fix | 19 | 19 | 0 | 0 | 100% |

---

## DM-15: DROP COLUMN with FK dependents — calibration attempted, did not promote

Calibration was attempted against the same canonical 761-migration corpus used for DM-18 on 2026-04-12. **DM-15 produced zero findings on the corpus.** Under the promotion criteria documented in [FAILURE-TAXONOMY.md](../../FAILURE-TAXONOMY.md) (bullet 2a), zero findings is below the 10-finding sample-size floor, and DM-15 therefore **stays in `shipped`** rather than promoting to `calibrated`. It remains warning-only in CI.

This is an honest negative result, not a calibration win. It is recorded here because the calibration discipline requires it to be: an attempt that failed its sample-size floor is still an attempt, and silently moving on would erase the integrity of the bar.

### What was measured

| Property | Value |
|---|---|
| Corpus | 761 production migrations (cal.com 590 + formbricks 140 + supabase 31) |
| Replay | Same `replay-engine.ts` run as DM-18 — schema replayed via libpg-query, grounding + safety gates fired against pre-migration state for each file |
| DROP COLUMN occurrences in corpus | ~39 migration files contain at least one DROP COLUMN |
| DM-15 findings | **0** |
| TP / FP / ambiguous | 0 / 0 / 0 |
| Sample size vs floor | 0 < 10 — below promotion floor |
| Tier | `shipped` (unchanged) |
| CI severity | warning-only (unchanged) |

### Why the corpus produced zero DM-15 findings

Spot-checking five DROP COLUMN migrations across the corpus revealed a consistent pattern: production Prisma migrations follow a defensive sequence. Before dropping a column that has FK dependents, Prisma's migration generator emits an explicit `ALTER TABLE ... DROP CONSTRAINT ..._fkey` statement, and *only then* drops the column. By the time `DROP COLUMN` runs, the FK is already gone from the schema, and DM-15 correctly sees no live dependents.

A representative example from cal.com (migration `20220622110735_allow_one_schedule_to_apply_to_multiple_event_types`):

```sql
-- DropForeignKey
ALTER TABLE "Schedule" DROP CONSTRAINT "Schedule_eventTypeId_fkey";

-- DropIndex
DROP INDEX "Schedule_eventTypeId_key";

-- ... (column added on inverse table, data backfilled) ...

-- AlterTable
ALTER TABLE "Schedule" DROP COLUMN "eventTypeId";

-- AddForeignKey
ALTER TABLE "EventType" ADD CONSTRAINT "EventType_scheduleId_fkey" ...
```

This is the safe pattern DM-15 is designed to *encourage*. The rule fired zero times because the corpus contains zero violations of the rule.

### What this does and does not say

**It does say:** in 761 production migrations from three established codebases, no developer attempted an unsafe `DROP COLUMN` against a column with live FK dependents. The Prisma migration generator's defensive sequence eliminates the failure mode at source.

**It does not say:** DM-15 has 0% precision, 100% precision, or any precision at all. Precision is undefined when the denominator is zero. The rule has been *implemented and tested*, but not *measured* against a real-world failure rate.

**It does not say:** DM-15 is unnecessary or should be removed. Hand-written SQL migrations, Django, Rails, Alembic, and agent-generated migrations that bypass Prisma's defensive sequence may produce DM-15-eligible patterns. The rule fires correctly on synthetic test cases (see `test-gates.ts`) and on adversarial inputs in the agent corpus. The 761-migration corpus is simply the wrong corpus for this rule.

### Implications for the calibration roadmap

- **The 761-corpus is calibrated for DM-18 (NOT NULL) but not for the FK-drop safety family.** DM-18 fires on a structural pattern (NOT NULL without DEFAULT) that Prisma cannot auto-fix; DM-15/16 fire on patterns that Prisma's generator pre-empts. This is a property of the corpus, not the rules.
- **A different corpus is needed to calibrate DM-15.** Candidates: hand-written Postgres migrations, Django `RemovedField` operations, Rails `remove_column` migrations, or adversarial agent-generated migrations. None of those corpora are in place yet.
- **Alternative calibration targets that the 761-corpus likely supports:** the grounding shapes (DM-01..05). Grounding shapes fire on hallucinated names and unknown references, which Prisma cannot generate by construction (Prisma migrations are generated from a validated schema). If agents or hand-edits exist anywhere in the 761 corpus, grounding findings would surface them. This is a candidate for the next calibration attempt after the DM-15/16 cycle is closed.

### What does NOT change as a result

- **DM-18's calibrated claim is unchanged.** 19 TP / 0 FP / 761 still stands. DM-15's negative result tells us nothing about DM-18.
- **DM-15's implementation is unchanged.** Same code, same unit tests, same warning-only behavior in CI.
- **The promotion bar in FAILURE-TAXONOMY.md is unchanged.** It was committed *before* this calibration ran. Holding to it is the point.

### Reproducibility

```bash
bun run scripts/mvp-migration/replay-engine.ts
# Output: reports/replay-findings-YYYY-MM-DD.jsonl
# Filter: jq 'select(.shapeId == "DM-15")' reports/replay-findings-2026-04-12.jsonl
# Result on 2026-04-12: 0 rows
```

---

## DM-16: DROP TABLE with FK dependents — calibration attempted, did not promote

Calibration was attempted against the same canonical 761-migration corpus on 2026-04-12, immediately after the DM-15 attempt. **DM-16 also produced zero findings.** Same outcome, same reasoning, same disposition: DM-16 stays in `shipped` and remains warning-only in CI.

DM-16 is documented separately rather than collapsed into the DM-15 section because the calibration discipline requires each shape's attempt to be recorded as an attempt — even when the result is identical to the previous shape's. Two empty results from the same corpus is a stronger statement than one.

### What was measured

| Property | Value |
|---|---|
| Corpus | 761 production migrations (same as DM-18 and DM-15) |
| Replay | Same `replay-engine.ts` output as DM-15 — both shapes filtered from the same JSONL |
| DROP TABLE occurrences in corpus | 15 in the 761-file corpus |
| DM-16 findings | **0** |
| TP / FP / ambiguous | 0 / 0 / 0 |
| Sample size vs floor | 0 < 10 — below promotion floor |
| Tier | `shipped` (unchanged) |
| CI severity | warning-only (unchanged) |

### Why the corpus produced zero DM-16 findings

Identical reason to DM-15. Production Prisma migrations follow the defensive sequence for `DROP TABLE` as well as for `DROP COLUMN`: drop the FK constraints first, then drop the table. A representative example from cal.com (migration `20220803091114_drop_daily_event_reference`):

```sql
-- DropForeignKey
ALTER TABLE "DailyEventReference" DROP CONSTRAINT "DailyEventReference_bookingId_fkey";

-- DropTable
DROP TABLE "DailyEventReference";
```

By the time `DROP TABLE` runs, the FK is gone from the schema and DM-16 correctly sees no live dependents. This is the safe pattern DM-16 is designed to encourage; the corpus contains zero violations.

### What two consecutive zero-result attempts establish

A single zero result could be a coincidence — maybe DM-15's specific shape happened to be absent. Two zero results on the same corpus, on shapes from the same family (FK-drop safety), establish a **pattern about the corpus**, not about the rules:

> The 761-migration canonical corpus is well-suited to calibrating shapes that fire on patterns Prisma's migration generator cannot auto-fix (like DM-18, NOT NULL without DEFAULT). It is **not** suited to calibrating shapes that fire on patterns Prisma's generator pre-empts by construction (like DM-15 and DM-16, which Prisma defends against by emitting `DROP CONSTRAINT` before `DROP COLUMN`/`DROP TABLE`).

This is a useful empirical finding even though it's not a calibration win. It tells the next operator something concrete about which shapes should be calibrated against this corpus and which need a different one.

### Reassessment after the DM-15/DM-16 cycle

The honest result of this cycle:

- **DM-18 calibrated** (19 TP / 0 FP / 761) — unchanged
- **DM-15 attempted, did not promote** (0 findings on 761) — recorded
- **DM-16 attempted, did not promote** (0 findings on 761) — recorded
- **Calibrated count: 1 of 10 Tier 1 shapes** (unchanged)
- **Calibration attempts: 3 of 10 Tier 1 shapes** (DM-18, DM-15, DM-16)

Calibration attempts ≠ calibrations. The discipline counts both. The honest story to tell partners is:

> **Verify calibrated DM-18 successfully on the canonical 761-migration corpus.** When we attempted to calibrate DM-15 and DM-16 on the same corpus, both shapes produced zero findings — not because the rules are wrong, but because Prisma's migration generator pre-empts the failure modes by construction. We are recording those attempts as held-to-the-bar negative results rather than promoting under a relaxed threshold.

That sentence is stronger than "we calibrated three shapes," because it demonstrates the bar holds against the operator's own preferences. A bar that always promotes the next shape isn't a bar.

### Forward path for DM-15 and DM-16

Three options exist for eventually calibrating these shapes. None are committed work; they are documented here so the next attempt has a starting point:

1. **Different corpus.** Hand-written Postgres migrations from non-Prisma codebases (Django, Rails, Alembic, raw SQL projects). Likely to contain DROP COLUMN / DROP TABLE without the defensive constraint-drop sequence, because the migration generators don't all defend against this case.

2. **Adversarial agent corpus at scale.** The agent comparison experiment shows OpenAI produced unsafe DROP TABLE on 2/5 probes. A larger agent-generated corpus (200-500 tasks) might produce enough DM-15/16 findings to clear the sample-size floor — but only if it counts as "real corpus" under the promotion criteria. Per the criteria, agent-generated corpora are supplementary evidence, not calibration corpora. This option requires either revising the criteria (a separate decision) or treating the agent corpus as a *secondary* calibration source after the rule has been measured against a real corpus first.

3. **Defer indefinitely.** Keep DM-15/16 in `shipped` (warning-only) and pivot calibration effort to shapes that the existing 761-corpus can support. The grounding shapes (DM-01..05) are the next obvious candidate — they fire on hallucinations and unknown references, which Prisma cannot generate by construction.

The recommended next move is option 3: pivot to grounding shapes for the next calibration attempt, leave DM-15/16 in `shipped` until a non-Prisma corpus is available.

### Reproducibility

```bash
bun run scripts/mvp-migration/replay-engine.ts
# Filter: jq 'select(.shapeId == "DM-16")' reports/replay-findings-2026-04-12.jsonl
# Result on 2026-04-12: 0 rows
```

---

## Agent comparison — DM-18 (April 2026, three models)

A separate, smaller experiment: 75 synthetic migration tasks across 8 categories, run against three frontier models at temperature 0. The point of this experiment is **not** to calibrate DM-18 — that's the human-corpus measurement above. The point is to see how often each model produces the structural patterns DM-18 catches, and to compare those rates against the human baseline.

### Two distinct metrics

Phase 1 reporting introduced two explicit metrics where prior reporting conflated them:

- **`DM-18 (any)` — structural risk rate.** A finding of any severity (warning or error). Measures how often the model produces a NOT NULL pattern that *trips the structural rule*, regardless of whether verify would block the PR.
- **`DM-18 (block)` — CI-blocking rate.** Error-severity findings only. Measures how often the model produces a NOT NULL pattern verify would actually stop in CI.

A model can be high on `(any)` but low on `(block)` if it consistently produces patterns that are warning-shaped but not flagrant enough to cross the blocking threshold. These are different stories about the same model and should not be reported under a single number.

### Results

| Source | Tasks | DM-18 (any) | DM-18 (block) | Any rate | Blocking rate |
|---|---|---|---|---|---|
| Human (production migrations) | 761 | 19 | 19 | 2.5% | 2.5% |
| Claude Sonnet 4 | 35 | 6 | 1 | 17.1% | 2.9% |
| Gemini 2.5 Flash | 32 | 16 | 0 | 50.0% | 0.0% |
| GPT-4o | 35 | 5 | 5 | 14.3% | 14.3% |

### What this says

- **OpenAI is the strongest blocking-risk signal.** Every DM-18 hit on OpenAI is blocking-severity. When OpenAI ships an unsafe NOT NULL pattern, it ships it flagrantly — no defaults, no backfill, no safe preconditions. OpenAI's blocking rate (14.3%) is roughly **5.7× the human baseline** (2.5%).
- **Gemini and Claude are mostly warning-shape risk, not blocking risk.** Gemini's 50% any-rate is the highest in the test, but **zero** of those hits are blocking — Gemini reliably trips the structural rule but stays just inside what verify would let through. Claude sits between, with 6 any-hits and 1 blocking-hit. Both models' blocking rates (0.0% and 2.9%) are at or below the human baseline.
- **Safe-baseline categories produced zero findings on all three models.** 60 tasks across two safe categories (`add_optional`, `add_with_default`); zero blocking findings, zero warning findings. The DM-18 rule's 100% precision on the human corpus is consistent with its behavior on agent-generated safe inputs.

### How to talk about these numbers

The honest version of the agent-vs-human story is two sentences, not one:

> **Structural risk rate (any DM-18 hit):** Gemini 50%, Claude 17%, OpenAI 14% vs human 2.5%. All three agents produce NOT NULL patterns that trip verify's structural rule far more often than humans do.
>
> **CI-blocking rate (would actually stop the PR):** OpenAI 14%, Claude 3%, Gemini 0% vs human 2.5%. Only OpenAI produces flagrantly unsafe NOT NULL migrations at meaningfully higher rates than humans. Claude and Gemini trip warning patterns frequently but rarely produce something verify would block.

### Limitations

- **75 tasks is a small sample.** Confidence intervals are wide. Do not move calibration thresholds based on this experiment alone.
- **Synthetic prompts, not real-world PRs.** The tasks are designed to probe specific shapes; they don't reflect the distribution of migrations agents write in production codebases.
- **Temperature 0 is not deterministic across providers.** Especially Gemini drifts between API runs. Small absolute changes in counts between reruns are noise.
- **The agent test is not the calibration claim.** The 19 TP / 0 FP / 761 figure above is the load-bearing precision claim; this experiment is supplementary evidence about agent-generated code.

### Reproducibility

```bash
# Requires ANTHROPIC_API_KEY, OPENAI_API_KEY, and GEMINI_API_KEY in env
# (loaded from ~/sovereign/.env if not in process.env)
bun run scripts/mvp-migration/agent-corpus-expanded.ts

# Output:
#   reports/agent-corpus-expanded-YYYY-MM-DD.jsonl
#   reports/agent-corpus-expanded-summary-YYYY-MM-DD.json
```
