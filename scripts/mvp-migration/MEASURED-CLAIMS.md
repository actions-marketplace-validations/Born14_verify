# Verify Migration Verification — Measured Claims

Last updated: 2026-04-12

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
