# Verify Methodology

How Verify's claims are made and how you can check them.

## The problem

AI agents and humans write database migrations that are syntactically valid but operationally unsafe. A migration that adds `NOT NULL` without a `DEFAULT` will succeed in development (empty table) and fail in production (millions of rows). No test suite catches this. No code reviewer sees it without knowing the production schema state.

Verify catches these failures deterministically by parsing the migration SQL against the accumulated schema state from prior migrations.

## Why deterministic

A deterministic detector produces the same output for the same input, every time. No randomness, no model calls, no "confidence scores." When Verify says a migration is unsafe, the reason is a specific SQL pattern matched against a specific schema state. You can read the detector source, trace the logic, and agree or disagree.

This property is what allows Verify to sit in a blocking CI gate. Probabilistic tools (LLM-based code review) produce false positives that vary between runs. Engineers disable them within a week. Deterministic tools produce consistent verdicts that engineers can evaluate once and trust going forward.

## The tier lifecycle

Every failure shape in Verify's taxonomy has a tier that tells you how much to trust it.

### Observed

A failure pattern has been identified and named. No detector exists yet. The shape lives in the taxonomy as a candidate for future development.

### Shipped

A detector exists, has been tested against internal fixtures, and runs in the GitHub Action. Shipped shapes produce **warnings** in PR comments but do not block merges. They may produce false positives -- that's expected and acceptable at this tier.

### Calibrated

The detector has been measured against a real-world corpus of production-merged migrations. The measurement produces a precision number (true positives vs false positives) and is published in the calibration registry. Only calibrated shapes with acceptable precision are promoted to **blocking** severity.

Calibration is the gate for blocking merges. Nothing else.

## The calibration bar

To promote a shape from shipped to calibrated:

1. **Pre-register the bar.** Before running the measurement, write down what precision is required for promotion. The bar does not move after the run.
2. **Select a corpus.** The corpus must be production-merged migrations from real open-source projects. Synthetic fixtures do not count.
3. **Run the detector against the corpus.** Record every finding.
4. **Label every finding.** Each finding is manually reviewed and labeled true positive, false positive, or ambiguous by the author.
5. **Compute precision.** True positives / (true positives + false positives).
6. **Record the attempt.** The attempt is recorded in [attempts.jsonl](calibration/attempts.jsonl) regardless of outcome -- including failures and held-to-bar negatives.
7. **Promote or hold.** If precision meets the pre-registered bar, the shape is promoted to calibrated and its severity changes to blocking. If not, the shape stays at shipped/warning and the held-to-bar negative is published.

Publishing held-to-bar negatives is the discipline that makes the registry trustworthy. Anyone can publish successes. Publishing failures proves the bar is real.

## The calibration registry

Three files, all public:

- **[shapes.json](calibration/shapes.json)** -- every shape in the taxonomy, its current tier, its detector status, and its severity in the Action.
- **[corpora.json](calibration/corpora.json)** -- every corpus used for calibration, its sources, its limitations, and its suitability for specific shapes. Includes commit SHAs for reproducibility.
- **[attempts.jsonl](calibration/attempts.jsonl)** -- every calibration attempt. Each line records: the shape, the corpus, the date, the precision, the disposition (promoted or held-to-bar), and the reason.

Per-finding evidence (individual TP/FP labels for each finding) is kept private. The aggregate counts and dispositions are public.

## Reproducing a claim

Every calibrated shape has a reproducibility section in [MEASURED-CLAIMS.md](scripts/mvp-migration/MEASURED-CLAIMS.md) that tells you how to re-run the measurement yourself. The corpus sources are public repositories. The detector source is readable. The schema replay logic is in [schema-loader.ts](scripts/mvp-migration/schema-loader.ts).

If you get different numbers, [open an issue](https://github.com/Born14/verify/issues). The claim is falsifiable by design.

## What Verify is not

- **Not a security scanner.** Verify does not check for SQL injection, secrets, or vulnerabilities.
- **Not a code reviewer.** Verify does not read application code or evaluate logic.
- **Not a linter.** Verify does not check SQL style or formatting.
- **Not a migration runner.** Verify does not execute migrations. It parses them statically.

Verify checks one thing: whether a database migration is structurally safe to run against a production schema. It checks this deterministically, publishes its precision, and lets you verify the claim yourself.
