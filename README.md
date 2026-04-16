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
      - uses: Born14/verify@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

That's it. When a PR contains `.sql` migration files, Verify parses them, replays prior schema state from your base branch, and checks each migration for unsafe patterns. Results appear as a PR comment.

## What it checks

| Shape | Name | Severity | Status |
|-------|------|----------|--------|
| DM-18 | NOT NULL without DEFAULT | Blocking | Calibrated (19/0) |
| DM-15 | DROP COLUMN with FK dependents | Warning | Shipped, uncalibrated |
| DM-16 | DROP TABLE with FK dependents | Warning | Shipped, uncalibrated |
| DM-17 | ALTER TYPE with implicit data loss | Warning | Shipped, uncalibrated |

Blocking shapes fail the check. Warning shapes appear in the PR comment but don't block merge.

## What it does NOT check

- Application code (JavaScript, Python, Ruby, etc.)
- Security vulnerabilities or secrets
- Code style or formatting
- Anything that requires an LLM to evaluate

Verify checks the structural correctness of database migrations against schema reality. That's it.

## Suppressing a finding

If Verify flags a migration you've reviewed and determined is safe (for example, the table is known to be empty):

```sql
-- verify: ack DM-18 table is empty at this point in the deploy
ALTER TABLE "users" ADD COLUMN "company" TEXT NOT NULL;
```

The `-- verify: ack` comment tells Verify you've reviewed the finding. It will still appear in the PR comment as acknowledged, but it won't block merge.

## Scope and honesty

- **Database support:** PostgreSQL only.
- **Migration formats:** Prisma-generated SQL and hand-written `.sql` files. Django, Rails, and Alembic support is in development.
- **Calibration:** DM-18 is calibrated against 761 production migrations with published precision. Other shapes are shipped but uncalibrated — they may produce false positives while being measured.
- **No runtime knowledge:** Verify parses SQL statically. It doesn't know your table has zero rows. It flags the structural risk regardless.
- **Deterministic:** Every finding is reproducible. Same migration in, same result out. No probabilities.

## How it works

Verify uses [libpg-query](https://github.com/pganalyze/libpg-query) (PostgreSQL's actual parser, compiled to WASM) to parse migration SQL into an AST. It replays prior migrations from your base branch to build the schema state at the point of each new migration, then runs shape detectors against each operation.

The detector source is readable: [safety-gate.ts](scripts/mvp-migration/safety-gate.ts), [schema-loader.ts](scripts/mvp-migration/schema-loader.ts).

## Calibration and trust

Every shape in Verify's taxonomy goes through a tier lifecycle:

1. **Observed** — a failure pattern has been identified
2. **Shipped** — a detector exists and runs as a warning
3. **Calibrated** — the detector has been measured against a real-world corpus with published precision

Only calibrated shapes block merges. The calibration registry is public so claims are falsifiable:

- [shapes.json](calibration/shapes.json) — every shape, its tier, its detector status
- [corpora.json](calibration/corpora.json) — every corpus, its sources, its limitations
- [attempts.jsonl](calibration/attempts.jsonl) — every calibration attempt, including failures and held-to-bar negatives

See [METHODOLOGY.md](METHODOLOGY.md) for the full calibration discipline.

## The taxonomy

Verify maintains a catalog of the specific, deterministic ways that database operations fail when they meet production reality. Each entry is a named failure shape — a pattern an operator would recognize from a 3am page.

See [FAILURE-TAXONOMY.md](FAILURE-TAXONOMY.md) for the full catalog.

## Why deterministic

AI code review tools (Qodo, CodeRabbit, Greptile) use LLMs to read your PR and flag issues probabilistically. They're useful for catching logic errors and style issues. They cannot sit in a blocking CI gate because false positives from a probabilistic tool get the tool disabled within a week.

Verify is deterministic. When it says "this migration is unsafe," the reason is a specific SQL pattern matched against a specific schema state. You can read the detector, agree or disagree, and decide. The verdict doesn't change between runs. That's why it can block merges without burning developer trust.

## What's coming

- Django migration support
- DM-28: Deploy-window safety (SET NOT NULL without application-level coordination)
- Additional migration shape families
- More framework parsers (Rails, Alembic)

## License

MIT. See [LICENSE](LICENSE).

## Contact

Built by [@Born14](https://github.com/Born14). Questions, bug reports, or "verify caught a real bug" stories: [open an issue](https://github.com/Born14/verify/issues).
