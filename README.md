# Verify

**Catches unsafe database migrations before they hit production.**

Deterministic. No LLM in the check path. The answer is not "probably."

## What it catches

**DM-18: ADD COLUMN NOT NULL without DEFAULT**

When an AI agent (or a human) writes a migration like this:

```sql
ALTER TABLE "users" ADD COLUMN "company" TEXT NOT NULL;
```

That migration will fail on any non-empty table. The database tries to apply `NOT NULL` to every existing row, finds no value (no default was provided), and rejects the operation. Your deploy breaks at 3am.

Verify catches it before it merges.

**Measured precision:** 19 true positives, 0 false positives across 761 production migrations from [cal.com](https://github.com/calcom/cal.com), [formbricks](https://github.com/formbricks/formbricks), and [supabase](https://github.com/supabase/supabase). See [MEASURED-CLAIMS.md](scripts/mvp-migration/MEASURED-CLAIMS.md) for full methodology and reproducibility steps.

**DM-28 (deploy-window race) — research-only, does not fire on your PRs today.**

A related failure mode exists where a migration adds a NOT NULL constraint that executes cleanly but breaks writes from application code running a pre-migration revision. We have a detector for this pattern, but its current form is **retrospective** — it scans a repo's full migration history for SET NOT NULL followed by a later DROP NOT NULL revert on the same column. That form cannot fire at PR time, because the revert that confirms the pattern hasn't happened yet when you're writing the originating migration.

Verify's Action does **not** check for DM-28 on your PRs right now. The retrospective detector and its first calibration attempt (15 findings, 4 TP / 10 FP / 1 ambiguous, held-to-bar) are published in the [calibration registry](calibration/) as research artifacts. A prospective per-file detector is planned; it will be registered as a PR-time warning when it ships.

## Install (60 seconds)

Add this to `.github/workflows/verify.yml`:

```yaml
name: Verify Migrations
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  pull-requests: write
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: Born14/verify@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

That's it. When a PR contains `.sql` migration files, Verify parses them, replays prior schema state from your base branch, and checks each migration for unsafe patterns. Results appear as a PR comment.

## What it does NOT check

- Application code (JavaScript, Python, Ruby, etc.)
- Security vulnerabilities or secrets
- Code style or formatting
- Anything that requires an LLM to evaluate

Verify checks one migration pattern at PR time today: NOT NULL without DEFAULT (DM-18, blocks merge). A deploy-window race detector (DM-28) exists in the calibration registry as a research artifact; it does not run against your PRs in its current form. Verify does not check application code, security, or style.

## Suppressing a finding

If Verify flags a migration you've reviewed and determined is safe (for example, the table is known to be empty):

```sql
-- verify: ack DM-18 table is empty at this point in the deploy
ALTER TABLE "users" ADD COLUMN "company" TEXT NOT NULL;
```

The `-- verify: ack` comment tells Verify you've reviewed the finding. It will still appear in the PR comment as acknowledged, but it won't block merge.

## Scope and honesty

- **Database support:** PostgreSQL only.
- **Migration formats:** Prisma-generated SQL and hand-written `.sql` files.
- **One calibrated rule runs on your PRs today.** DM-18 is measured against 761 production migrations with published precision and blocks unsafe NOT NULL migrations before merge. DM-28 (deploy-window race) exists as a retrospective research detector but does not run at PR time in its current form. Additional detectors (FK-dependent drops, narrowing type changes, prospective deploy-window) are in development.
- **No runtime knowledge:** Verify parses SQL statically. It doesn't know your table has zero rows. It flags the structural risk regardless.
- **Deterministic:** Every finding is reproducible. Same migration in, same result out. No probabilities.

## How is this different from Squawk?

[Squawk](https://squawkhq.com) is an established Postgres migration linter with 30+ rules. If you're already using Squawk, you're well-covered.

Verify's differences:

- **Progressive schema replay.** Verify replays your prior migrations from the base branch to build the schema state at the point of each new migration. This means it knows whether a column is currently nullable before checking a SET NOT NULL — it's not just pattern-matching the SQL in isolation.
- **Published calibration data.** Every rule has a measured precision number against a named corpus. Failed calibration attempts are published too. See [METHODOLOGY.md](METHODOLOGY.md).
- **One rule, deeply measured, vs. many rules without published precision.** Verify currently catches less than Squawk. What it catches, it measures.

If you need broad coverage today, use Squawk. If you want calibrated precision with schema-aware detection, try Verify. They can run side by side.

## How it works

Verify uses [libpg-query](https://github.com/pganalyze/libpg-query) (PostgreSQL's actual parser, compiled to WASM) to parse migration SQL into an AST. It replays prior migrations from your base branch to build the schema state at the point of each new migration, then runs shape detectors against each operation.

The detector source is readable: [safety-gate.ts](scripts/mvp-migration/safety-gate.ts), [schema-loader.ts](scripts/mvp-migration/schema-loader.ts).

## Calibration and trust

Every rule in Verify goes through a tier lifecycle:

1. **Observed** — a failure pattern has been identified
2. **Shipped** — a detector exists and runs as a warning
3. **Calibrated** — the detector has been measured against a real-world corpus with published precision

Only calibrated rules block merges. The calibration registry is public so claims are falsifiable:

- [shapes.json](calibration/shapes.json) — every rule, its tier, its detector status
- [corpora.json](calibration/corpora.json) — every corpus, its sources, its limitations
- [attempts.jsonl](calibration/attempts.jsonl) — every calibration attempt, including failures and held-to-bar negatives

See [METHODOLOGY.md](METHODOLOGY.md) for the full calibration discipline.

## What's coming

- DM-28 prospective: a per-file deploy-window warning that fires at PR time (replaces the current retrospective-only DM-28)
- More migration detectors (FK-dependent drops, narrowing type changes)
- Django migration support
- More framework parsers (Rails, Alembic)

## License

MIT. See [LICENSE](LICENSE).

## Contact

Built by [@Born14](https://github.com/Born14). Questions, bug reports, or "verify caught a real bug" stories: [open an issue](https://github.com/Born14/verify/issues).
