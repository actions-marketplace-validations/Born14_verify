# CLAUDE.md — verify (public product surface)

Orientation for any Claude session opening this repo.

## What this repo is

This is the **public product surface** for verify. It contains:

- The shipped GitHub Action (`dist/action/index.cjs`)
- The Action's manifest (`action.yml`)
- The README and methodology documentation
- The published calibration registry (`calibration/shapes.json`, `calibration/corpora.json`, `calibration/attempts.jsonl`)
- Published calibration evidence (`scripts/mvp-migration/reports/calibration-postfix-2026-04-12.jsonl` — the 19 DM-18 findings)
- Readable detector source (the key files that back the shipped precision claim)

## Where development happens

**Development does NOT happen here.** All substrate work — new detectors, corpus scanning, experiments, planning, harness work — lives in the private `Born14/verify-engine` repo at `c:/Users/mccar/verify-engine`.

The flow is: build and test in verify-engine → rebuild the Action bundle → copy `dist/action/index.cjs` here → update README / registry entries if the user-visible surface changed → commit and push both repos → move `v1` tag in this repo when a user-facing change ships.

If a future Claude session lands here and is asked to add a detector, implement a feature, run tests, or do calibration work, the correct response is: **switch to the verify-engine repo.** This repo should only receive: the Action bundle after rebuild, README/docs updates, calibration registry entries for newly-calibrated shapes, and published evidence artifacts.

## What verify is (brief)

Verify is a **harness for agent output** with a published calibrated taxonomy of failure shapes. It currently deploys as:

1. A GitHub Action that runs on every PR touching SQL migration files. Shipped.
2. A Claude Code CLI hook (in development, v0 being built). Not yet shipped as of 2026-04-17.

The shipped shape is DM-18 (NOT NULL without DEFAULT), calibrated at 19 TP / 0 FP / 0 ambiguous on 761 production migrations. Evidence JSONL is published at `scripts/mvp-migration/reports/calibration-postfix-2026-04-12.jsonl` and is independently verifiable.

DM-28 (deploy-window race) runs at INFO severity in the Action — it surfaces past revert patterns in the repo's migration history as a "Historical context" section in the PR comment. Never blocks. Uncalibrated; first calibration attempt held-to-bar at 28.6%.

## Load-bearing conventions

- **The calibration ledger is the primary asset.** Every shape has honest status (calibrated / held-to-bar / shipped / designed). Held-to-bar negatives are recorded as prominently as promotions.
- **Deterministic, not LLM-as-judge.** No LLM runs in the check path.
- **Documentation stance.** Posts to public channels are timestamps on work, not pitches. Don't add "marketing"-style copy to the README or `action.yml`. Match the tone of the existing files: honest, specific, falsifiable.

## If in doubt

Open `c:/Users/mccar/verify-engine/CLAUDE.md` for the full development context. Most work doesn't belong in this repo.
