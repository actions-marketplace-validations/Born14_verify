# Verify Vertical #1 (Code-Edit Verification) — Calibration Status

Last updated: 2026-04-12

This document tracks calibration progress for vertical #1 (code-edit verification) under the promotion criteria committed in [FAILURE-TAXONOMY.md](FAILURE-TAXONOMY.md) bullet 2a. It is the vertical #1 counterpart to [scripts/mvp-migration/MEASURED-CLAIMS.md](scripts/mvp-migration/MEASURED-CLAIMS.md), which tracks vertical #2 (migration verification).

**Current calibrated shapes: 0 of 26 gates.** No vertical #1 shape has been promoted to `calibrated` under the bar. This document records the investigations that led to the current status and the open questions the next operator should resolve before a public vertical #1 calibration claim can ship.

## Session 2026-04-12 — first vertical #1 calibration attempt, stopped at provenance and data-shape blockers

### What was attempted

First-anchor calibration target selection for vertical #1 against the existing AIDev-POP scan corpus, following the successful DM-18 calibration pattern from vertical #2. The goal was to identify a single gate whose findings on the 32,623-PR AIDev-POP scan could be classified TP/FP/ambiguous under the pre-committed promotion criteria, and to use that as the first vertical #1 calibrated shape.

### What was found

The investigation hit two independent blockers before any classification work began.

**Blocker 1: most high-volume gates fail the independence requirement on this corpus.**

The promotion criteria require that a rule was not designed against the corpus it is measured against. A scan of `git log` against `src/gates/` surfaced the following history:

| Gate | Findings on AIDev-POP | Relevant commit | Independence status |
|---|---|---|---|
| `access` | 1493 | `6b66d3c` "access gate: context-aware path traversal detection" | ❌ Modified after the AIDev-POP scan ran |
| `contention` | 398 | `5f2405a` "GC-651 + GC-652: fix false positives from AIDev-POP scan" | ❌ Explicitly tuned on AIDev-POP findings |
| `capacity` | 692 | `e44c3f0` body: "capacity gate false positive on WHERE-bounded SQL queries" | ⚠ Ambiguous — commit attributes fix to improve loop, but the AIDev-POP scan ran before this commit and could have informed the fix indirectly |
| `propagation` | 179 | Only `b7b509c` (initial sync from sovereign monorepo) | ⚠ Cannot verify — no tuning visible in this repo's git log, but the gate originated in the sovereign monorepo whose history is not accessible here |

Three of the four high-volume gates are explicitly or ambiguously contaminated. `propagation` is the only candidate whose *visible* history is clean, but the sovereign monorepo history is not visible from this repo, so independence cannot be affirmatively proven.

Operator direction (2026-04-12): "If you cannot prove the tuning did not happen, you should not use it for a public calibrated claim." Under this direction, `propagation` is treated as **provenance-unverified** and is not promotion-eligible against the AIDev-POP corpus until the monorepo history is independently confirmed.

**Blocker 2: the AIDev-POP scan output is PR-aggregated and truncated, not per-finding and complete.**

Inspection of the scan output structure revealed that each row in `data/aidev-scan/batches/*.jsonl` represents *one PR with an aggregate count of findings*, not one discrete finding per row. The `detail` field is a concatenated string of up to ~200 characters that describes multiple individual errors (e.g., "3 propagation error(s), 0 warning(s): Import path 'X' changed in Y but Z still imports 'X'; Import path 'A'..."), and the string is truncated at the ~200-character limit. For PRs with many individual errors, the detail string contains only the first 1-2 errors and the rest are lost from the scan output.

Implications:

- **The scan's 179 propagation rows are 179 PRs, not 179 individual propagation errors.** The underlying per-error sample size is probably 500-1500, but cannot be recovered from the scan output alone.
- **Ground-truth labeling of individual errors requires either re-running the gate against reconstructed PR file content, or a new scan format that preserves per-finding evidence instead of aggregating at the PR level.** The AIDev-POP source data (`data/aidev-pop/pr_commit_details.jsonl`) does contain per-file diff patches at 2GB scale, so reconstruction is tractable — but it is a materially larger scope than the original "classify 179 findings" plan.
- **The existing `classification` block on each finding is a rule-based auto-classifier's output, not hand-labeled ground truth.** This is useful for triage and for training the classifier, but it cannot serve as the calibration label set under the promotion criteria.

### Decision

Stop vertical #1 calibration work for this session. Record this finding rather than pursue an exploratory 15-finding sanity batch. The reasons:

1. Even a successful internal sanity batch would not resolve the provenance blocker for `propagation`.
2. Even with provenance confirmed, the data-shape blocker requires either a gate re-run or patch-reconstruction work that is substantially larger than a "first anchor calibration" was scoped for.
3. A sanity batch classified against truncated detail strings would train the labeler on data that is not the same data a real calibration would measure against. That creates labeling drift risk.

### What this does NOT say

- It does not say `propagation` or `capacity` is a bad gate. Both appear to fire on real structural issues. This is about whether the existing corpus can be used to publish a *promotable precision number* under the bar — not about whether the rules work.
- It does not say AIDev-POP is a bad corpus. AIDev-POP is well-suited for triage, for training the confidence classifier, and for improve-loop development. It is not, in its current stored form, well-suited for ground-truth per-finding calibration against the promotion criteria. This is the same structural observation as the DM-18 / 761-corpus result in vertical #2: corpora are suited for specific purposes, not universally.
- It does not say vertical #1 calibration is impossible. It says the first attempt against the existing data hit two blockers that the next operator should resolve in order before trying again.

### What this DOES say

The honest one-line status for vertical #1:

> **Vertical #1 has 26 gates implemented and zero calibrated shapes. The first calibration attempt on 2026-04-12 hit an independence blocker on three of four high-volume gates and a data-shape blocker on the fourth. Resolving either blocker unlocks real calibration; neither was resolvable in-session.**

## Open questions for the next operator

These questions are documented here so the next session does not have to re-derive them. They are ordered by what most efficiently unblocks vertical #1 calibration.

### 1. Verify monorepo provenance for `propagation`

The fastest unblock. If it can be confirmed that `propagation` was developed and stabilized in the sovereign monorepo *before* the AIDev-POP scan was run, and that no commit in the monorepo history references AIDev-POP findings as a tuning source for `propagation`, then the gate clears the independence requirement and calibration against AIDev-POP becomes possible (subject to blocker 2).

**How to verify:**
- Access the sovereign monorepo's full git history on whatever machine has it
- Run `git log --all -- path/to/propagation.ts` (or equivalent) covering commits older than the `b7b509c` sync
- Look for any commit message, commit body, or inline comment referencing AIDev-POP, `data/aidev-scan`, or the batch scanner
- Look for any commit message referencing false-positive fixes dated after the AIDev-POP scan ran (check `data/aidev-scan/batches/*-summary.json` for scan timestamps — the first batch summary timestamp is the earliest possible tuning date)
- If nothing is found: propagation is clean, record the verification in this doc, and calibration can proceed
- If something is found: propagation joins `access` and `contention` as disqualified, and the next candidate is picked by the same independence check

Estimated effort: 15-30 minutes of git-history inspection on a machine that has the sovereign monorepo.

### 2. Spec a calibration-ready vertical #1 scan format

The more general unblock. The existing scan format was designed for triage and improve-loop work, where PR-aggregated truncated output is fine. A calibration-ready format needs to preserve:

- **One row per individual finding**, not one row per PR
- **The full finding detail**, not truncated at 200 characters
- **The file content context** that the gate observed (or enough of it to verify the finding post-hoc without re-running the gate)
- **A content hash or commit SHA** so the finding can be reproducibly re-verified against the source data
- **Classifier output as a separate field** from the raw finding, so classifier labels never contaminate ground-truth labels

One option: add a `--calibration` flag to the batch scanner that emits a second output file in this richer format alongside the existing triage output. The triage output stays as-is for classifier training; the calibration output feeds manual review. This makes the two use cases independent.

Estimated effort: 1-2 days to design the format, modify the scanner, re-run against AIDev-POP, and produce the first calibration-ready output file.

### 3. Identify a different first-anchor shape or corpus for vertical #1

The widest unblock, useful if both 1 and 2 prove hard. Options:

- **A different shape on the same corpus.** F9 (search-string syntax) did not fire in the AIDev-POP scan because the scan ran a diff-only gate subset that excludes F9. A commit history grep showed F9 fired in `level2/` (cal.com production run, 26 F9 findings) but not in `batches/`. The 26 F9 findings from the level2 run are a potential second-anchor candidate if the level2 scan format preserves more per-finding detail than the batches format. Worth checking.
- **A different corpus.** The corpus-suitability reasoning in [scripts/mvp-migration/MEASURED-CLAIMS.md](scripts/mvp-migration/MEASURED-CLAIMS.md) applies here: the AIDev-POP scan is suited to some shapes and not others. A different corpus (e.g., a curated set of PRs with known bug-fix outcomes, or a non-scan corpus built from adversarial prompts) might support shapes the existing scan cannot.
- **Synthetic test scenarios.** The self-test runner in `data/self-test-ledger.jsonl` contains ~5000 scenarios. If any of those scenarios are externally-sourced rather than verify-authored, they might qualify as an independent corpus. Needs provenance check.

Estimated effort: variable. The F9-on-level2 check is 30 minutes. Building a new corpus is 2-5 days. The self-test scenario provenance check is 1-2 hours.

## Pointers for the next session

- **Read first:** this document, then [FAILURE-TAXONOMY.md](FAILURE-TAXONOMY.md) bullet 2a (the promotion criteria), then [scripts/mvp-migration/MEASURED-CLAIMS.md](scripts/mvp-migration/MEASURED-CLAIMS.md) (the vertical #2 calibration story for pattern reference).
- **Scan output location:** `data/aidev-scan/batches/*.jsonl` (168 files, ~32,623 PR-level rows, 2,766 finding-bearing rows).
- **Source data location:** `data/aidev-pop/pr_commit_details.jsonl` (712K file-level diff rows, ~2GB).
- **Classifier location:** `scripts/scan/classifier.ts` (rule-based, not ground-truth).
- **Gate source files:** `src/gates/propagation.ts`, `src/gates/capacity.ts`, `src/gates/access.ts`, `src/gates/contention.ts`, etc.
- **The bar:** [FAILURE-TAXONOMY.md](FAILURE-TAXONOMY.md) bullet 2a — do not move without explicit operator decision.

## What not to do in the next session

- **Do not start classifying propagation findings against the existing scan output.** Without resolving blocker 2, the classifications would be against truncated aggregated data and would not produce a promotable precision number.
- **Do not calibrate `access` or `contention` against AIDev-POP.** Independence failure, recorded above.
- **Do not lower the promotion criteria to make vertical #1 calibration easier.** That is the exact goalpost-move the criteria exist to prevent. If the criteria prove impractical, they should be revised as a separate deliberate decision, committed before measurement, not tweaked to rescue an in-flight attempt.
- **Do not treat the classifier's output as ground truth.** It is a rule-based auto-tagger, not a human label set. It is useful for triage and classifier training, not for calibration label acquisition.
