# Calibration Registry

This directory is the source-of-truth registry for verify's calibration discipline. It holds structured records of shapes, corpora, and calibration attempts, and is designed so that the public claim documents (notably [scripts/mvp-migration/MEASURED-CLAIMS.md](../scripts/mvp-migration/MEASURED-CLAIMS.md)) can eventually be generated from these files rather than hand-edited.

## Files

### `shapes.json`
One record per shape in verify's taxonomy. Each record describes the shape's identity, current tier, current CI severity, implementation pointer, corpus suitability notes, tier history, and pointers to the attempts that currently promote it (if any). This is a small, structured mirror of the "what shapes exist and what tier are they in" information that is otherwise scattered across `FAILURE-TAXONOMY.md` and the gate source files.

Edits to this file are **state changes** — a shape moving from `shipped` to `calibrated`, a severity override, a deprecation. Every such change should append an entry to the shape's `tier_history` array so the lifecycle is recorded.

### `corpora.json`
One record per calibration corpus. Each record describes the corpus id, description, source repos, adapter functions used to walk it, the date it was sourced, its current status (`candidate`, `active`, or `retired`), and explicit suitability notes describing which shapes the corpus can and cannot calibrate.

Naming convention: `{framework}-{quality}-v{n}`. Examples: `prisma-production-v1`, `django-production-v1`. The version suffix is load-bearing — a re-sourcing of the same conceptual corpus at a later date becomes `v2`, not a replacement of `v1`, because the two are different artifacts even when they have the same character.

### `attempts.jsonl`
Append-only ledger of calibration attempts. One JSON object per line. Each line records a single attempt's shape id, corpus id, date, bar commit, measurement commit, TP/FP/ambiguous counts, precision, disposition, evidence path, and provenance notes.

**This file is append-only.** Rows are never edited or deleted. A mistake in an attempt is corrected by appending a new row that supersedes the old one and noting the correction in the new row's `notes` field. The old row stays in the ledger because the discipline's own test (did the bar hold in the order the commits say it did) requires the historical record to be immutable.

JSONL is used instead of a JSON array because it makes the file trivially appendable with a single line write, which keeps git diffs minimal when attempts are added and which matches the format already used by the per-finding calibration files in `scripts/mvp-migration/reports/`.

## Relationship to existing docs

- `FAILURE-TAXONOMY.md` remains the prose taxonomy document. The `shapes.json` file is the structured mirror of its tier state, not a replacement.
- `scripts/mvp-migration/MEASURED-CLAIMS.md` remains the hand-authored claim document for now. Eventually it will be generated from these files (see "The regeneration step" below), but that generation is not yet wired up.
- `calibration/corpora.json` supersedes the implicit corpus list that currently lives in `scripts/mvp-migration/backtest.ts`'s `CORPUS` array and `scripts/mvp-migration/repo-adapter.ts`'s `REPO_ADAPTERS` registry. Those runtime files stay as-is until the registry is wired into the runtime path; for now they are parallel to the registry, not replaced by it.
- `attempts.jsonl` supersedes nothing directly. It is new infrastructure.

## The regeneration step (not yet built)

The intended end state is that a small script reads `shapes.json`, `corpora.json`, and `attempts.jsonl` and emits `scripts/mvp-migration/MEASURED-CLAIMS.md` as a rendered view. At that point, hand-edits to MEASURED-CLAIMS.md stop being allowed — the source of truth is the registry, and the doc is a projection.

That script does not yet exist. Until it exists, MEASURED-CLAIMS.md continues to be hand-authored and the registry is a parallel record that can be audited against the doc for drift.

When the script is built, the discipline's expensive surface shifts from MEASURED-CLAIMS.md to the registry files. The claim doc becomes free-surface (cheap to regenerate) and the registry files become the new place where claim-surface changes are made.

## How to add new work

When a new calibration attempt happens, the flow is:

1. **If the corpus is new:** add a record to `corpora.json` with status `active`.
2. **If the shape is new or needs updating:** add or update the record in `shapes.json`.
3. **Run the calibration** using the existing replay/scan infrastructure.
4. **Append one row to `attempts.jsonl`** with the attempt's metadata, counts, precision, and disposition.
5. **If the attempt promoted the shape:** update the shape's `current_tier`, `current_severity`, and `promoted_attempts` in `shapes.json`, and append a `tier_history` entry.
6. **Regenerate or hand-update MEASURED-CLAIMS.md** to reflect the new attempt.

The per-attempt cost is: one line appended to `attempts.jsonl`, zero to two fields updated in `shapes.json`, zero to one record added to `corpora.json`. That is the minimum overhead the discipline can charge for a new calibration attempt, and it is much lower than the current hand-editing cost for MEASURED-CLAIMS.md prose sections.

## What NOT to do with this registry

- **Do not build a database.** The registry lives in git so that `git log` and `git blame` are the audit trail. A database would move the source of truth out of the place the discipline depends on for its integrity.
- **Do not build a UI first.** A dashboard is a view over the registry, not a replacement for it. The registry is edited in VS Code or any text editor, and that is intentional.
- **Do not modify `attempts.jsonl` rows.** Append-only. Corrections happen by appending new rows that reference the old ones.
- **Do not let MEASURED-CLAIMS.md drift from the registry once the regeneration script exists.** If the generated doc differs from the hand-edited version, the generated version is the correct one and the hand-edits are the drift.
- **Do not introduce a second source of truth.** Once the registry exists, `backtest.ts`'s `CORPUS` array should eventually import from `corpora.json` rather than maintaining its own list. Two lists that can disagree is worse than either list alone.

## Current state (2026-04-13)

- **Shapes tracked:** 10 (DM-01 through DM-05, DM-15 through DM-19)
- **Corpora tracked:** 1 (`prisma-production-v1`)
- **Attempts recorded:** 3 (DM-18 promoted, DM-15 held-to-bar, DM-16 held-to-bar)
- **Regeneration script:** not built
- **Runtime integration:** not wired

This is the starting state. The registry is functional as a record but is not yet the source of truth for the public claim doc. That transition happens when the regeneration script is built and MEASURED-CLAIMS.md is flipped from hand-authored to generated.
