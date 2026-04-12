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
