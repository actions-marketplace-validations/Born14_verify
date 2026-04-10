# N1 — Convergence Proof Experiment: DESIGN

**Status:** Pre-registration draft, pending operator honesty gate.
**Date:** 2026-04-09
**Branch:** `main`
**Owner:** builder Claude (execution); operator (approval, interpretation).

This document is the **binding pre-registration** for the N1 convergence proof experiment. Once operator-approved and committed, no changes to the experimental design, case list, success criteria, or contingency rules are permitted without an explicit **pre-registration amendment** commit (see §26 — Pre-registration freeze protocol).

---

## 1. Question, hypotheses, and pre-registered success criteria

### Question

**Does `govern()` — the convergence loop wrapping `verify()` with narrowing — produce meaningfully better outcomes than a raw agent loop on failure cases that `verify()` would otherwise catch?**

The answer to this question decides a strategic fork for the verify project:

- **Path A (equivalence):** If `govern()` and raw perform equivalently, verify's distinctive claim lives in extraction + gates + taxonomy, not in the convergence loop. The convergence loop remains an internal tool but doesn't carry the public narrative. Next steps: extraction benchmark, discriminated union refactor, measurement-first framing.
- **Path B (improvement):** If `govern()` meaningfully improves over raw, the convergence loop is the distinctive product. Extraction + gates become the enforcement mechanism; narrowing becomes the intelligence. Next steps: `govern()` as the primary entry point, narrowing-centric framing, cross-session narrowing work.

### Hypotheses

- **Null (H0):** Raw and governed loops perform equivalently on the N1 dataset, modulo noise. Convergence rates, retry counts, and narrowing quality do not meaningfully differ.
- **Path B (H1):** The governed loop produces one or more of (a) higher convergence rate, (b) qualitatively different failure modes caught, (c) actionable narrowings that rate "useful" on the inter-rater scale.
- **Path A (H2):** Both loops converge at statistically indistinguishable rates, and narrowing quality rates "neutral" or worse on majority of sampled cases.

### Denominator rule for convergence-rate claims

Six stop reasons are emitted by `govern()`: `converged`, `exhausted`, `stuck`, `empty_plan_stall`, `approval_aborted`, `agent_error`. These are **not all commensurable** as convergence outcomes.

- **Include in convergence denominator:** `converged`, `exhausted`, `stuck`, `empty_plan_stall`. These are runs where the loop ran its course and produced an answer about whether convergence happened (success, failure by exhaustion, failure by detected stuckness, or failure by persistent empty plans). All four are legitimate convergence verdicts.
- **Exclude from denominator — report separately as data quality metric:** `agent_error` (infrastructure/LLM failure), `approval_aborted` (not used in N1 — if observed, it's a harness bug).

**Convergence rate** = `converged` ÷ (`converged` + `exhausted` + `stuck` + `empty_plan_stall`).

**Data quality metric** = (`agent_error` + `approval_aborted`) ÷ total runs attempted. Reported per loop per case, as a separate number. A data quality rate above 10% on any case-loop combination triggers re-investigation of that case before the result is trusted.

For the raw loop, only `converged`, `exhausted`, and `agent_error` are possible (raw has no stuck-detector, no empty-plan stall detector, no approval gate). `exhausted` is the raw-loop equivalent of "ran all retries, none succeeded." The denominator for raw is `converged + exhausted`.

### Pre-registered success criteria

All thresholds are **deltas between governed and raw convergence rates**, computed on their respective denominators (see denominator rule above). These are committed *before* any runs happen. No adjustment during or after execution.

- **Strong Path B:** `governed_convergence_rate - raw_convergence_rate ≥ 20 percentage points` on the N1-A primary track. Unambiguous Path B signal. Recommended next step: commit to the convergence narrative, start the Path B product branch.

- **Weak Path B:** `governed_convergence_rate - raw_convergence_rate ≥ 10 percentage points` on N1-A primary track, **AND** inter-rater narrowing quality rates "useful" on ≥50% of sampled cases **with ≥70% inter-rater agreement**. Narrowing quality must hold on its own — if agreement drops below 70%, the narrowing quality signal is too noisy to support Weak Path B, and the experiment falls back on the convergence rate criterion alone.

- **Path A (equivalence):** `|governed_convergence_rate - raw_convergence_rate| < 5 percentage points`, retry count means within ±15% of each other, and narrowing quality rates "neutral" or worse on majority of sampled cases. Recommended next step: extraction-first framing, convergence loop stays internal.

- **Regression:** `raw_convergence_rate > governed_convergence_rate` by any margin. This would be surprising and requires investigation before any conclusion. Do not ship `govern()` as a user-facing feature until the regression is understood.

- **Ambiguous:** Any result that doesn't fall into the four buckets above. RESULTS.md must specify what additional data would disambiguate and whether it's worth collecting.

The **N1-B supplementary track** (bad_hint cases, governed-only) is not part of the primary success criteria. It reports narrowing quality as an independent secondary finding.

---

## 2. Shared prompt shell (verbatim)

This is the exact system prompt used by **both** the raw loop and the governed loop. It is identical in both cases. The behavioral difference between loops is in the *context payload* that gets rendered into the message body on retries, not in the system prompt or the instruction structure.

```
You are an AI coding agent. You produce edits to accomplish a goal in a
codebase. Your output must be a JSON object with exactly two fields:

  {
    "edits": [
      { "file": "path/to/file.ext", "search": "exact text to find", "replace": "replacement text" }
    ],
    "predicates": [
      { "type": "content", "file": "path/to/file.ext", "pattern": "string that should exist after the edit" }
    ]
  }

Rules:
1. Each edit's "search" field must match the file content EXACTLY, character for character, including whitespace.
2. Predicates assert claims about the codebase after your edits are applied.
3. Produce the minimum number of edits required to achieve the goal.
4. Do not add commentary, explanation, or markdown. Output JSON only.
5. The APP FILES: manifest at the top of every prompt is the complete set of files in the app. You may only emit edits targeting files listed in that manifest. File paths not in the manifest do not exist and will cause the F9 gate to fail. Do not fabricate file paths.

On retry: you will receive feedback about why your previous attempt failed. Use that feedback to revise your edits and predicates. The goal remains the same across retries.
```

This prompt is committed verbatim. No substitutions. No per-case variations. Both loops render the same system prompt bytes on every request.

**Codebase visibility (added by Amendment 6).** On every prompt (attempt 1 and retries), the agent is provided with a flat file manifest of the app directory it must edit. The manifest is a newline-separated list of file paths relative to the app root, sorted lexicographically, with **any path excluded if any of its path segments (after splitting on `/`) begins with `.`**. This catches state directories (`.verify/`, `.verify-k5-*/`), environment files (`.env`, `.env.prod`, `.env.staging`), and deliberately-hidden fixture files (`test-data/.hidden`) in a single uniform rule. The manifest is prepended to the body of every prompt under the literal header `APP FILES:` followed by a blank line, followed by the §3 or §4 retry template body. The manifest is **not filtered by relevance to the goal** — the agent receives the full post-exclusion file list and must select the correct target file(s) itself. This matches the deployment-time behavior of real coding agents (Cursor, Claude Code, Aider, Cline) which surface the full workspace tree rather than pre-selecting relevant files. The manifest does not include file contents; it includes only paths. The agent discovers contents by proposing an edit with a `search` field and observing the gate failure detail on retry (existing attempt-N mechanism).

---

## 3. Raw loop context renderer (verbatim template)

On retry attempt N ≥ 2, the raw loop appends a "previous attempt" section to the user message. The template is:

```
GOAL: {goal_string}

ATTEMPT {N} of {max_attempts}.

Your previous attempt failed. Here are the raw gate failure messages:

{gate_failures_formatted}

Revise your edits and try again.
```

Where:
- `{goal_string}` is the scenario's `description` field, passed verbatim.
- `{N}` is the current attempt number (1-indexed).
- `{max_attempts}` is 5 (see §5 — Retry budget).
- `{gate_failures_formatted}` is rendered as:
  ```
  - [gate_name]: {gate.detail truncated to 300 chars}
  ```
  One line per failed gate, using the `GateResult.gate` and `GateResult.detail` fields from the prior `VerifyResult` object. Failed gates are those with `passed === false`. If zero gates failed but the overall result was unsuccessful, the formatted output contains one line: `- [unknown]: verify returned success: false with no specific gate failure.`

**Worked example** for a raw-loop retry on attempt 2, with goal "F9 exact match: change port number in server.js" and a failed F9 gate:

```
GOAL: F9 exact match: change port number in server.js

ATTEMPT 2 of 5.

Your previous attempt failed. Here are the raw gate failure messages:

- [F9]: server.js: search string not found; searched for "const PORT = process.env.PORT || 9999;" in server.js

Revise your edits and try again.
```

**Attempt-1 shape (updated by Amendment 6).** On attempt 1, the raw loop sends the system prompt + `APP FILES:` manifest + `GOAL: {goal_string}` with no "previous attempt" section. The `APP FILES:` manifest is the deterministic output of `buildAppManifest(appDir)` (defined in `experiments/n1-convergence-proof/harness/manifest.ts` per Amendment 6 Change 5), formatted by `formatAppManifest(files: string[])` as the literal header `APP FILES:` followed by a newline, then one path per line, then a blank line, then `GOAL: {goal_string}`. On attempt N ≥ 2, the `APP FILES:` manifest is prepended to the existing §3 retry template in the same position (before the `ATTEMPT {N} of {max_attempts}` line). The manifest is byte-identical between attempts within a single run — it is built once at run start from the staged app directory (§21) and reused for every attempt.

The renderer is a pure function `renderRawRetryContext(goal: string, attempt: number, maxAttempts: number, priorResult: VerifyResult): string`. It will be implemented in `experiments/n1-convergence-proof/harness/raw-loop.ts` and its exact bytes will match this specification.

---

## 4. Governed loop context renderer (verbatim template)

On retry attempt N ≥ 2, the governed loop receives a `GovernContext` from `govern()` and renders a "previous attempt" section that includes everything the raw loop shows PLUS the narrowing and convergence signals. The template is:

```
GOAL: {goal_string}

ATTEMPT {N} of {max_attempts}.

Your previous attempt failed. Here are the raw gate failure messages:

{gate_failures_formatted}

NARROWING (guidance from the verification system):

{narrowing_formatted}

CONSTRAINTS currently active ({constraint_count} total):

{constraints_formatted}

FAILURE SHAPES observed across attempts:

{failure_shapes_formatted}

CONVERGENCE PROGRESS:

{convergence_summary}

Revise your edits and try again.
```

Where:
- `{goal_string}`, `{N}`, `{max_attempts}`, `{gate_failures_formatted}` are rendered identically to the raw loop.
- `{narrowing_formatted}` is rendered from the `Narrowing` object on the prior `VerifyResult`:
  - If `narrowing.resolutionHint` is present: `HINT: {resolutionHint}` on its own line.
  - If `narrowing.fileEvidence` is present: `EVIDENCE: {fileEvidence}` on its own line.
  - If `narrowing.patternRecall` is non-empty: `PRIOR SUCCESSFUL PATTERNS: {patternRecall.join('; ')}` on its own line.
  - If `narrowing.nextMoves` is non-empty: `SUGGESTED NEXT MOVES:` followed by one line per next move: `  - {move.kind} (score {move.score}): {move.rationale}`.
  - If `narrowing.bannedFingerprints` is non-empty: `AVOID: these predicate patterns have failed before: {bannedFingerprints.slice(0, 5).join(', ')}`.
  - If `narrowing` is undefined or all the above fields are empty/absent: the section renders as `(no narrowing produced for this failure)`.
- `{constraint_count}` is `context.constraints.length`.
- `{constraints_formatted}` is one line per constraint: `- [{constraint.type}] {constraint.reason}`. If no constraints are active, renders as `(none)`.
- `{failure_shapes_formatted}` is one line per shape: `- {shape_id}`. If no shapes have been classified, renders as `(none)`.
- `{convergence_summary}` is `context.convergence?.progressSummary ?? 'first attempt — no convergence history'`.

**Worked example** for a governed-loop retry on attempt 2, same failure as the raw example:

```
GOAL: F9 exact match: change port number in server.js

ATTEMPT 2 of 5.

Your previous attempt failed. Here are the raw gate failure messages:

- [F9]: server.js: search string not found; searched for "const PORT = process.env.PORT || 9999;" in server.js

NARROWING (guidance from the verification system):

HINT: The search string did not match any content in the file. Check the exact text in the file and match whitespace and punctuation precisely.
EVIDENCE: Expected "const PORT = process.env.PORT || 9999;" but file contains "const PORT = process.env.PORT || 3000;"

CONSTRAINTS currently active (1 total):

- [search-string] Edit search field must exactly match existing file content before substitution

FAILURE SHAPES observed across attempts:

- F9-001

CONVERGENCE PROGRESS:

1 new shape(s)

Revise your edits and try again.
```

The renderer is a pure function `renderGovernedRetryContext(goal: string, context: GovernContext, maxAttempts: number): string`. It will be implemented in `experiments/n1-convergence-proof/harness/governed-loop.ts`.

**Note:** in the actual N1 harness, the governed loop does NOT manually render this — `govern()` calls the agent's `plan()` function and passes the `GovernContext` directly. The harness-supplied agent adapter is what calls the renderer. The renderer runs inside the agent adapter, translating `GovernContext` to the prompt body that goes to the LLM. This is the architecturally honest shape of the experiment.

**Attempt-1 shape (explicit under Amendment 6).** On attempt 1 (or when `context.priorResult` is undefined), the governed loop produces bytes identical to the raw loop's attempt-1 output: system prompt (from §2, including Rule 5) + `APP FILES:` manifest + `GOAL: {goal_string}`, with no NARROWING / CONSTRAINTS / FAILURE SHAPES / CONVERGENCE PROGRESS sections. Both loops prepend the `APP FILES:` manifest via the shared `formatAppManifest` helper, guaranteeing that the raw and governed attempt-1 prompts are byte-identical on both the §2 shell and the `APP FILES:` manifest. The only difference between loops remains what appears after the `GOAL:` line on attempts N ≥ 2 — the governed renderer adds the §4-specific NARROWING / CONSTRAINTS / FAILURE SHAPES / CONVERGENCE PROGRESS sections. On attempt N ≥ 2, the governed renderer prepends the same `APP FILES:` manifest before the §4 retry template in the same position the raw renderer prepends it.

### Invariant: the only difference between loops is the context renderer

Both loops share:
- The same system prompt (§2)
- The same LLM model and temperature (§19)
- The same retry budget (§5)
- The same `verify()` call after each attempt
- The same success/failure oracle (`VerifyResult.success`)
- The same edit/predicate output format (enforced by the system prompt)
- The same case set for N1-A (no loop-specific case selection)

They differ in exactly one place: what the agent's `plan()` function receives when building the retry prompt. The raw loop receives only the prior `VerifyResult`. The governed loop receives the full `GovernContext` with narrowing, constraints, convergence state, and failure shapes. Both get rendered into the prompt by the respective renderer function, and the resulting bytes are what differ.

---

## 5. Retry budget

**Max attempts: 5.**

Justification:
- **Minimum 3** is needed to meaningfully distinguish "first-try fails, second-try uses narrowing, third-try stable" from "immediate convergence" or "stuck." Below 3, the convergence loop doesn't get a chance to demonstrate narrowing's effect.
- **Maximum 7** is a practical ceiling before token costs and wall-clock time start dominating the experiment budget. At 5-7 retries per case × 3 runs per case × 52 cases, the retry budget is the single largest lever on experiment cost.
- **5 is the sweet spot** observed in real agent deployments (Cursor, Devin, Claude Code default retry budgets cluster around 3-5 per task), so 5 is at the upper bound of realistic deployment and gives the convergence loop enough room to show benefit without bloating the budget.
- **Committed, not adjustable.** If a case would benefit from more retries, that does not justify raising the budget mid-experiment. The limit is the limit.

The retry budget applies uniformly to both the raw and governed loops. Both loops get exactly 5 attempts per run.

---

## 6. Six stop reasons and denominator rule

See §1 for the denominator rule. This section is explicit about what each stop reason means and how it's tracked.

| Stop reason | Meaning | Raw loop possible? | Included in convergence denominator? |
|---|---|---|---|
| `converged` | The final verify() returned `success: true` | yes | **yes** (numerator) |
| `exhausted` | All retries used, loop was making progress but ran out of attempts | yes | yes |
| `stuck` | `govern()` detected shape repetition, gate cycles, or constraint saturation | no (raw has no stuck-detector) | yes |
| `empty_plan_stall` | Agent returned zero edits for 3+ consecutive attempts | yes (raw has its own stall counter) | yes |
| `agent_error` | Agent's `plan()` threw or produced malformed output | yes | **no** (data quality metric) |
| `approval_aborted` | Human approval gate rejected the plan | no (N1 does not use approval gate) | **no** (harness bug signal if observed) |

**Secondary metric — stop reason distribution per loop:** The distribution of stop reasons per loop per case is reported in RESULTS.md as a separate finding. This is the metric that reveals *how* the loops fail differently, not just *whether* they fail. A governed loop that shows 40% `stuck` vs a raw loop that shows 5% `exhausted` is a qualitative finding about govern()'s stuck-detector that doesn't show up in the convergence rate alone.

---

## 7. N1-A primary track structure

**Purpose:** Direct raw-vs-governed comparison on convergence behavior.

**Cases:** 52 total.
- 40 from Source B (fixtures/scenarios staged, `false_negative` intent, non-zero edits)
- 12 from Source D (hand-constructed synthetic seeds filling coverage gaps in config, grounding, security, a11y)

**Runs per case:** 3 per loop per case.

**Total runs:** 52 cases × 2 loops × 3 runs = **312 runs**.

**Per-run metrics:**
- Stop reason (one of six)
- Retry count (1 to 5)
- Token spend (input + output, per retry, summed per run)
- Wall clock time (ms per run)
- Final VerifyResult (for inspection, not for metrics — convergence is decided by `success` boolean)

**Aggregated metrics:**
- Per-case: convergence rate per loop (majority of 3 runs, or average if fractional), retry count distribution, token cost, stop-reason distribution
- Per-category: convergence rate delta (governed − raw), per gate category (f9, content, propagation, access, state, hallucination, config, grounding, security, a11y)
- Overall: convergence rate delta, retry count delta, token cost delta, inter-rater narrowing quality (from §17)

**Track-specific reporting:** primary success criteria (§1) are evaluated on N1-A alone.

---

## 8. N1-B supplementary narrowing quality track

**Purpose:** Direct measurement of narrowing quality on cases explicitly designed to exercise it.

**Cases:** 15-20 from Source B (`bad_hint` intent — scenarios where narrowing is expected to exist and be useful). Exact count locked during Phase 1 based on availability in the staged fixtures.

**Runs per case:** 3 per case, **governed loop only** (no raw comparison — bad_hint cases are about narrowing quality, not convergence parity).

**Total runs:** 15-20 cases × 1 loop × 3 runs = **45-60 runs**.

**Per-run metrics:**
- Stop reason
- Narrowing content captured for inter-rater review (not aggregated automatically — fed to §17 protocol)
- Retry count and token spend (secondary)

**Aggregated metrics:**
- Narrowing quality distribution (useful / neutral / noise) — from inter-rater review
- Inter-rater agreement
- Convergence rate on the bad_hint subset (for context, not for primary criteria)

**Track-specific reporting:** N1-B reports are a separate section in RESULTS.md. N1-B does not contribute to the Strong/Weak Path B criteria directly. It provides an independent line of evidence that either corroborates or contradicts the N1-A narrowing quality signal.

**Total N1 runs (both tracks):** 312 + (45 to 60) = **357 to 372 runs**.

---

## 9. Source classification

**Source A — cal.com post-fix findings: EXCLUDED.** All 5 candidate cases confirmed as SI-006 scanner artifacts during the 2026-04-09 ground truth audit. Routed to `SCANNER-INCIDENTS.md` SI-006 incident entry. Cal.com provides zero cases for N1.

**Source B — fixtures/scenarios staged: PRIMARY.** ~120+ usable `false_negative` non-zero-edit scenarios across ≥6 gate categories, pre-labeled with `expectedSuccess` and `intent` fields, wired to the `fixtures/demo-app/` fixture, loaded by `scripts/harness/external-scenario-loader.ts`. 40 cases drawn for N1-A + 15-20 cases drawn for N1-B.

**Source C — existing test fixtures: DEFERRED.** Unit tests (`tests/govern.test.ts`, `tests/unit/hallucination-gate.test.ts`, `tests/unit/verify-batch.test.ts`) contain edit fixtures, but they're shaped for gate-unit testing, not agent-loop execution, and the conversion cost exceeds the marginal value when Source B is this rich. Source C can be revisited in a follow-up experiment if Source B + Source D turn out to miss coverage.

**Source D — synthetic seeds: SECONDARY.** 12 hand-constructed cases filling coverage gaps in Source B (4 config-nonzero, 2 content-rich, 3 grounding, 2 security, 1 a11y). Hand-construction happens during Phase 1 case assembly.

---

## 10. Cal.com exclusion disclosure

During the N1 ground truth audit on 2026-04-09, 5 candidate cases from the 2026-04-08 post-SI-003-fix cal.com re-run were considered as seed data for the experiment:

- PR 3164956727 (`.github/workflows/pr.yml`)
- PR 3162624847 (`packages/lib/__tests__/autoLock.test.ts`)
- PR 3177753579 (`packages/trpc/.../slots/util.ts`)
- PR 3179554058 (`packages/trpc/.../slots/util.ts`)
- PR 3161649548 (`apps/api/v2/.../bookings.module.ts`)
- PR 3224857167 (`packages/trpc/.../outOfOfficeCreateOrUpdate.handler.ts`)

All six (the 5 "newly visible" findings plus the 9-commit `outOfOfficeCreateOrUpdate` case) were confirmed as instances of a previously-undiscovered scanner bug class: **SI-006 — Sequential-modification reversal in F9**. See `SCANNER-INCIDENTS.md` § SI-006 for the full incident writeup, including the correction to the 2026-04-08 cal.com validation interpretation.

Cal.com findings are excluded from N1 because SI-006 cases are scanner false positives — neither a raw nor a governed agent loop can make them go away via edit quality. Using these cases as N1 seeds would have produced noise attributed to `govern()` weakness instead of the scanner bug.

This exclusion is named here so the final N1 dataset isn't a post-hoc selection. Cal.com was considered and excluded before the experiment began, with a documented reason. Any reader of DESIGN.md can verify the exclusion rationale by reading SI-006 and cross-referencing the cal.com commit history.

---

## 11. Threats to validity

Honest enumeration of known limitations that constrain the generalizability of N1 results.

### Source B concentration risk (demo-app homogeneity)

40 of 52 N1-A cases, and 15-20 of 15-20 N1-B cases, are drawn from a single fixture environment: `fixtures/demo-app/`. The shape categories vary (f9, content, propagation, access, state, hallucination, plus whatever N1-B covers), but the environment is identical — same file tree, same surface, same handler shapes, same CSS, same HTML structure.

**Risk:** If a real LLM agent has a particular failure mode against demo-app's specific structure (e.g., it gets confused by the health endpoint pattern, or it misreads the config structure), we measure that failure mode 40+ times and attribute it to "convergence behavior" when it's actually "demo-app idiosyncrasy." Observed convergence patterns may partially reflect environment-specific agent behavior rather than fully general convergence capability.

**Mitigation:** This is not a blocker — Source B is still the right primary given the ground-truth density it provides. But the risk is real and must be named in RESULTS.md's limitations section verbatim.

**Named next step if the risk materializes:** A follow-up experiment (N1.1) with multiple fixture environments is a natural extension. Candidate fixtures: the `fixtures/demo-infra/` directory for infrastructure gates, freshly-synthesized repos for each shape category, or a small curated set of real-world repo snapshots that aren't cal.com.

### Single-codebase ground truth extrapolation

All Source B cases share the demo-app codebase. The pre-flight check confirms that each scenario's reference edits still produce the expected result against the current scanner, but it does not test whether the scenario's *difficulty* (i.e., how hard the goal is for an LLM agent) generalizes to other codebases. A case that's easy on demo-app may be hard on a larger real codebase, and vice versa. N1's results characterize convergence behavior on demo-app, not on "code in general."

### Single-labeler narrowing quality risk

The inter-rater narrowing quality protocol uses two raters: the operator and builder Claude. Both have deep context on verify's design. An independent third-party rater would provide a stronger signal. The current protocol mitigates this by reporting inter-rater agreement explicitly — if agreement is low, the narrowing quality signal is flagged as unreliable. But the fundamental limitation remains: two raters sharing project context may systematically agree or disagree in ways a neutral rater would not.

**Mitigation:** If N1 results motivate a publishable outcome, a third rater outside the verify project should be recruited for a follow-up narrowing quality study before any public claim.

### Retry budget bounds the experiment's power

5 retries per attempt is an upper bound of realistic deployment but a lower bound of what's possible. A case that would converge with 8 retries looks like `exhausted` at 5. The experiment is insensitive to convergence behavior beyond the retry cliff. If the governed loop consistently converges just beyond 5 while the raw loop doesn't, N1 records equivalence when Path B is actually true.

**Mitigation:** Report the *shape* of the retry distribution, not just the aggregate count. A loop that exhausts at retry 5 consistently (flat distribution) is a different signal than a loop that exhausts at retry 5 due to a few hard cases (skewed distribution).

### Model choice effects

Gemini 2.0 Flash is the primary model (§19). A stronger model might converge on first try regardless of loop type, masking govern()'s benefit; a weaker model might fail randomly in ways unrelated to narrowing. The Phase 2.5 pilot (§18) catches this for the specific model chosen, but it cannot rule out the possibility that Path B is "true for some models and false for others." N1's result is scoped to the primary model used, with the Haiku 4.5 sanity check as a cross-model corroboration on a small subset.

### Contamination risk: pre-flight drops as a selection signal

If pre-flight drops a material fraction of Source B cases, the remaining "live" scenarios may share properties (newer, more carefully maintained, etc.) that correlate with LLM-agent difficulty in unknown ways. The pre-flight contingency rule (§13) tries to preserve distribution, but selection bias cannot be fully eliminated. RESULTS.md must report the exact pre-flight drop count and the category distribution before and after replacement draws.

---

## 12. Pre-flight check methodology

Before any case enters the N1 dataset, its **reference edits** (the scenario's hardcoded `edits` field — what a correct agent *should* produce) are run through `verify()` against the `fixtures/demo-app/` appDir with default gates. The expected outcome is:

- For `false_negative` scenarios: `result.success === true` (the reference edits should make verify pass)
- For `bad_hint` scenarios (N1-B): `result.success === false` with `result.narrowing` present and non-empty (the reference edits should fail in a way that produces narrowing)

If the observed outcome matches the scenario's declared `expectedSuccess` and `intent`, the scenario is **live** and enters the N1 dataset.

If the observed outcome does not match, the scenario is **stale-dropped** and recorded in `case-list.jsonl` (§14) with a `stale-drop` result and the specific mismatch noted (e.g., "expected success=true, got success=false; gate F9 failed with: ...").

**The pre-flight check is run once, during Phase 1 case assembly.** Its output is committed to the repo as part of the case list lock.

**Important:** the pre-flight check is NOT a test of the LLM agent. It is a test of the scenario's ground truth stability. The LLM agent is introduced in Phase 2 (harness construction) and Phase 2.5 (pilot). Pre-flight is purely mechanical: can the scenario's hardcoded correct edits still produce the expected verify result on the current codebase?

### Calibration oracle use

Source B scenarios' reference edits serve a second purpose beyond pre-flight: they are the **calibration oracle** for narrowing quality ratings (§17). When a governed loop converges via narrowing to a solution different from the reference edits, the inter-rater reviewer can compare the agent's edits to the reference and classify the outcome as:

- **Same solution:** agent's edits are structurally identical to the reference (same files, same search/replace structure)
- **Different-but-valid solution:** agent's edits differ from the reference but `VerifyResult.success === true`, meaning both paths solve the goal
- **Failure:** agent's edits did not converge

The "different-but-valid" category is significant for interpretation: a governed loop that converges more often but always to the reference solution suggests narrowing is steering the agent toward a known path; a governed loop that converges more often and sometimes to different-but-valid solutions suggests narrowing is helping the agent reason more broadly. Both are Path B signals, but they have different implications for how the narrowing is working.

---

## 13. Pre-flight contingency rule

Let **k** = number of Source B cases dropped by the pre-flight check (reference edits no longer produce `result.success === expectedSuccess` or reference edits no longer produce narrowing for bad_hint cases).

**This rule is pre-registered. Commit to it before Phase 1 pre-flight runs. No adjustment after seeing pre-flight results.**

- **k ≤ 5:** Draw `k` replacement Source B cases from the **same category distribution** as the dropped cases (if 2 dropped cases were from f9 and 3 were from access-fs, draw 2 new f9 + 3 new access-fs). Re-run pre-flight on replacements. Repeat until 40 live Source B cases are held. Total N1-A target remains 52 cases.

- **6 ≤ k ≤ 15:** Draw replacements as above until 40 live Source B cases are held, AND add `k` additional synthetic seeds to Source D (bringing Source D from 12 to 12+k). Total N1-A target becomes 52+k cases. The extra Source D cases compensate for the increased selection bias in the Source B pool caused by repeated draws from a pool with known drift.

- **k > 15:** Stop and report. Do not proceed to harness construction. Something is wrong with Source B's ground truth stability, and the experiment needs re-planning, not more replacement drawing. A pre-registration amendment is required before any further work on N1.

**In all cases:** the final N1-A dataset has **≥50 total cases**. Below that threshold, pre-registered success criteria become statistically unreliable and the experiment is paused for re-planning.

**Clarification 1 — "Same category distribution" edge case.** If a category is exhausted before replacements can be drawn (e.g., 3 dropped cases from a category with only 3 live candidates remaining), pull from a related category in this priority order: same gate with different context (f9 → any f9 variant), same shape family (access-fs → access-http → access-cli), any remaining false_negative non-zero-edit scenario. Every substitution is logged in `case-list.jsonl` with a `category_substitution` note.

**Clarification 2 — Random seed for reproducibility.** All case selection from Source B uses a pinned random seed: **20260409**. A reviewer running the same experiment against the same scenario corpus should get the same case list. The seed is part of the pre-registration and does not change during execution. If re-running months later produces a different case list, the scenario corpus has drifted and that drift is itself a finding worth investigating.

---

## 14. Pre-flight artifact specification (`case-list.jsonl`)

Committed at `experiments/n1-convergence-proof/case-list.jsonl` during Phase 1. One JSON object per line.

**Schema:**

```json
{
  "case_id": "f9-exact-001",
  "source": "B",
  "intent": "false_negative",
  "category": "f9",
  "track": "N1-A",
  "goal": "F9 exact match: change port number in server.js",
  "reference_edits": [{"file": "...", "search": "...", "replace": "..."}],
  "reference_predicates": [{"type": "content", "file": "...", "pattern": "..."}],
  "pre_flight_result": "pass",
  "pre_flight_verify_result": {"success": true, "gates_passed_count": 14, "gates_failed_count": 0},
  "pre_flight_timestamp": "2026-04-09T...",
  "scanner_sha": "38bbd03",
  "extractor_sha": "38bbd03",
  "category_substitution": null,
  "random_seed": 20260409
}
```

**Fields:**
- `case_id`: unique, stable across runs; for Source B cases this is the scenario's `id` field verbatim
- `source`: `"B"` or `"D"`
- `intent`: `"false_negative"` or `"bad_hint"` (Source B) or `"synthetic"` (Source D)
- `category`: the gate category (e.g., `"f9"`, `"content"`, `"config"`, `"security"`)
- `track`: `"N1-A"` or `"N1-B"`
- `goal`: the scenario's `description` field verbatim (Source B) or the hand-written goal (Source D)
- `reference_edits`: the scenario's `edits` array (Source B) or the constructed correct answer (Source D)
- `reference_predicates`: the scenario's `predicates` array (Source B) or the constructed correct predicates (Source D)
- `pre_flight_result`: one of `"pass"`, `"stale-drop"`, `"synthetic"` (Source D, pre-flight not applicable), `"replacement-pass"` (drawn after an initial drop), `"replacement-stale-drop"` (replacement that also failed)
- `pre_flight_verify_result`: the `{success, gates_passed_count, gates_failed_count}` summary from the pre-flight verify() call (null for synthetic cases)
- `pre_flight_timestamp`: ISO 8601
- `scanner_sha`: the git SHA of the scanner code at pre-flight time
- `extractor_sha`: the git SHA of the extractor code at pre-flight time (may match scanner_sha)
- `category_substitution`: null if drawn from the original category, or `{"original": "access-fs", "substituted": "access-http", "reason": "original category exhausted"}` if substituted per §13 clarification 1
- `random_seed`: the pinned seed used for case selection (always 20260409)

Once committed, `case-list.jsonl` does not change during the experiment. If the experiment is re-run later, the pre-flight artifact is the record of what was tested. Any changes require a pre-registration amendment commit (§26).

---

## 15. Random seed for reproducible case selection

**Seed: 20260409** (the date of DESIGN.md authoring, in YYYYMMDD format).

This seed is used by the Phase 1 case-assembly script when drawing 40 Source B cases from the `false_negative` non-zero-edit pool, and 15-20 Source B cases from the `bad_hint` pool. The selection is deterministic: running the Phase 1 script against the same Source B corpus with this seed produces the same case list.

The seed is pinned in DESIGN.md, not in a separate config file, because pre-registration requires the full experimental specification to be in the honesty-gated document. A reviewer reading DESIGN.md sees the exact integer. If the seed were in a config file, it could be edited later without triggering a DESIGN.md amendment, which would defeat the pre-registration.

---

## 16. Calibration oracle use in narrowing quality rating

See §12 (pre-flight methodology) for the mechanism. Summary: Source B reference edits serve as the comparator when inter-rater reviewers classify governed-loop outcomes.

During the Phase 4 analysis, each sampled governed failure (or governed success, for cases where convergence-via-narrowing is observed) is classified by each rater on two axes:

**Axis 1 — Narrowing quality:** useful / neutral / noise (§17)

**Axis 2 — Solution similarity to reference:** same / different-but-valid / failure

The combined classification feeds the narrowing quality interpretation:

- **Useful narrowing + different-but-valid solution:** strongest Path B signal — narrowing helped the agent reason to a valid alternative
- **Useful narrowing + same solution:** Path B signal — narrowing steered the agent toward the known correct path
- **Neutral narrowing + same solution:** weak signal — agent may have converged without meaningfully using the narrowing
- **Noise narrowing + failure:** negative signal — narrowing may be harmful or confusing

---

## 17. Inter-rater narrowing quality protocol

**Raters:** two independent raters.
- **Rater 1:** operator
- **Rater 2:** builder Claude (rating independently, without seeing the operator's ratings before submitting own ratings)

**Sample size:** 10-15 governed failures sampled from N1-A + all 15-20 cases from N1-B (governed-only). Total sample: 25-35 cases rated.

**Rating scale:**
- **Useful:** the narrowing provides information that could plausibly help a next attempt succeed, grounded in the specific failure observed
- **Neutral:** the narrowing is accurate but generic (e.g., "verify returned failure") and doesn't provide actionable guidance specific to this failure
- **Noise:** the narrowing is irrelevant, wrong, misleading, or contradicts the actual failure

**Protocol:**
1. Phase 4 analysis script samples N1-A governed failures and extracts narrowing content for each. Generates a flat list of (case_id, run_id, narrowing_content, verify_failure_summary) tuples.
2. Each rater independently rates each tuple: `useful | neutral | noise`. No discussion between raters before rating.
3. Each rater also rates each tuple on solution similarity: `same | different-but-valid | failure` (§16).
4. Ratings are written to `experiments/n1-convergence-proof/ratings-{rater}.jsonl`.
5. Analysis script computes per-rater distribution, raw agreement percentage, and per-category breakdown.
6. Disagreements are flagged with specific examples for discussion in RESULTS.md.

**Reliability gate:** If raters disagree on more than 30% of rated cases (raw agreement < 70%), the narrowing quality signal is flagged as too noisy to support the Weak Path B criterion. In that case, the experiment falls back to the convergence rate criterion alone for Path B determination, and RESULTS.md acknowledges the narrowing quality measurement as inconclusive.

**Transparency:** Both raters' full ratings are committed to the repo so a reviewer can audit agreement independently.

---

## 18. Pilot phase structure

**Before the full 357-372 run execution, a pilot phase validates the harness and the model choice.**

- **Pilot cases:** 5 cases drawn from the N1-A Source B pool, using the same random seed. These 5 must be a representative subset (1 from each of 5 gate categories: f9, content, propagation, access, state).
- **Pilot runs:** 5 cases × 2 loops × 3 runs = **30 runs**
- **Model:** primary model (Gemini 2.0 Flash, §19)
- **Runtime estimate:** 10-20 minutes
- **Cost estimate:** ~$2

**Decision gate:** Before proceeding to the full batch, the pilot results must satisfy:

1. **Raw convergence rate on pilot:** 20% ≤ raw_convergence_rate ≤ 80%. If below 20%, the model is failing for reasons unrelated to convergence (weak model masks governance benefit). If above 80%, the model succeeds so often there's no room for governance to add value (strong model masks benefit). In either case, **stop and pick a different model**.
2. **No harness crashes:** zero runs terminated with unexpected exceptions. If crashes occur, fix the harness before proceeding.
3. **Token usage within budget:** average tokens per run ≤ 5,000. If higher than expected, investigate before spending money on the full batch.
4. **Per-run wall time reasonable:** average ≤ 30 seconds per run. If much higher, investigate rate limiting or prompt bloat.

**If pilot fails any gate:** stop, investigate, fix, re-pilot. Do NOT proceed to the full batch on a partially-satisfactory pilot result.

**If pilot passes all gates:** proceed to full execution (Phase 3).

---

## 19. Model choice

**Primary model: Gemini 2.0 Flash**
- **Reasoning:** Mid-capability tier — powerful enough to attempt the task but not so powerful that first-try success is automatic. Low cost per run (~$0.02-0.05). The existing `callLLM()` helper in `src/action/index.ts` already wraps the Gemini API and handles response parsing.
- **Temperature:** 0 (deterministic output, reduces run-to-run variance within a case)
- **Max tokens per response:** 500 (enough for a multi-edit plan; plans longer than this are rare for the case categories in N1)

**Sanity check model: Claude Haiku 4.5**
- **Scope:** 6-8 cases from the N1-A pool, run through both loops with the same 3-runs-per-case protocol
- **Purpose:** Confirm that N1 results are not a Gemini-specific artifact. If Haiku produces qualitatively similar raw-vs-governed deltas, the result generalizes across at least two models. If Haiku produces different deltas, the RESULTS.md limitations section names the cross-model inconsistency as a finding.
- **Cost:** ~$2-3 additional

**Total expected token cost for both models:** $8-20 depending on retry patterns. The cost budget (§22) is $30 with alert at $20, which leaves comfortable margin.

---

## 20. API key source

**Re-use the existing `callLLM()` helper from `src/action/index.ts` lines 253-310.** This helper already wraps three providers (Gemini, OpenAI, Anthropic) with the auth and response-parsing logic needed. The N1 harness imports `callLLM()` directly and passes it the agent prompt + scenario context.

**Environment variables:**
- Primary model (Gemini): `INPUT_API_KEY` with provider set to `gemini`
- Sanity check model (Haiku): `INPUT_API_KEY` with provider set to `anthropic`

The harness reads the key from `process.env.INPUT_API_KEY` on startup. If not set, the harness exits with a clear error. The `callLLM` function in `src/action/index.ts` is exported and reused verbatim. The function body, its call sites inside `src/action/index.ts`, and its behavior when `src/action/index.ts` is executed as an entry point are unchanged. Two mechanical edits are permitted: (a) adding `export` to the `async function callLLM` declaration, and (b) wrapping the bottom-of-file `run().catch(...)` invocation in an `if (import.meta.main)` guard so side-effect execution only fires when the file is run directly, not when imported by the harness. See Amendment 5.

**Key management:** the operator provides the key via environment variable at execution time. The key is never committed to the repo, never logged, and never included in any experiment output.

---

## 21. stateDir hygiene (first-class harness requirement)

**CRITICAL:** `govern()` persists constraints in a stateDir across runs (ConstraintStore at `${stateDir}/constraints.json`, FaultLedger at `${stateDir}/faults.jsonl`). If the same case is run through the governed loop 3 times without wiping state, runs 2 and 3 start with constraints seeded by run 1, which would contaminate the 3-runs-per-case protocol.

**The harness MUST wipe stateDir before each governed-loop run within a case.** The raw loop is clean by construction (it does not use ConstraintStore), but for uniformity the harness wipes stateDir before raw runs too.

**Implementation in the harness:**
- Each run gets a unique temporary stateDir: `${os.tmpdir()}/n1-${case_id}-${loop_type}-${run_idx}-${pid}`
- The stateDir is created fresh, populated by the loop, and deleted after the run completes (regardless of outcome)
- Failure to wipe (permission error, file lock, etc.) aborts the run with an error; the harness does NOT silently proceed on unwiped state

**This is a first-class requirement, not a TODO.** The harness test suite (built during Phase 2) includes an explicit test: run the same case twice through the governed loop with wipe, assert the constraint store counts match; without wipe, assert they differ. This test catches any regression in the wipe logic before full execution.

---

## 22. Cost budget and alert threshold

**Total budget: $30** across all N1 execution phases (pilot + full batch + sanity check).

**Alert threshold: $20.** If mid-execution the total spend crosses $20, the harness stops, reports the spend, and waits for operator confirmation before continuing. Do not let it run to completion on autopilot.

**Estimated breakdown:**
- Pilot: ~$2
- N1-A full batch: ~$10-15 (312 runs × ~$0.03 average)
- N1-B bad_hint track: ~$2-4 (45-60 runs × ~$0.04 average)
- Haiku sanity check: ~$2-3 (6-8 cases × 2 loops × 3 runs × ~$0.08 average)
- **Total estimated:** $16-24
- **Budget margin:** $6-14

**Token budgets per run:** soft cap 5,000 tokens per run (§18 pilot gate). A single run exceeding 10,000 tokens is flagged in the logs as an anomaly for post-hoc investigation.

**Cost tracking:** the harness records per-run token counts (input + output) and per-run estimated cost based on the provider's published pricing. Aggregate cost is reported after each phase (pilot → N1-A → N1-B → Haiku).

---

## 23. Outcome-to-next-action mapping

What happens after RESULTS.md is written, for each possible outcome of N1. This is pre-committed so the experiment produces a decision path, not just data.

### Strong Path B (governed − raw ≥ 20 pp)
- **Commit to the convergence narrative publicly.** `govern()` becomes the primary entry point in the README, REFERENCE.md is reframed around narrowing as the distinctive feature.
- **Start the cross-session narrowing branch.** The missing piece identified earlier (narrowing that persists across govern() invocations, not just within one loop) becomes the next major feature.
- **Build one visible "raw vs governed" demo** that reproduces the N1 result in a form a reader can run in 5 minutes. This becomes the core of the launch narrative.
- **Publish N1 results as a methodology post.** The pre-registration discipline and the SI-006 discovery during the audit are load-bearing evidence of experimental honesty.

### Weak Path B (governed − raw ≥ 10 pp with narrowing quality ≥ 50% useful at ≥70% inter-rater agreement)
- **Keep convergence internal for now.** Path B is defensible but not overwhelming; publishing a weak result risks overclaiming.
- **Publish the extraction benchmark first** (the Path A work), then revisit convergence in 3 months with a larger experiment (N1.1 with multiple fixtures, more cases, possibly a second model run as primary).
- **Start the discriminated union follow-up branch** (gap #6 from the extractor consolidation) — this is load-bearing for either path.

### Path A (equivalence, |governed − raw| < 5 pp, narrowing quality neutral or worse)
- **Commit to extraction-first framing.** Rewrite the README around extraction as the product. Reframe `FAILURE-TAXONOMY.md` as an extraction capability catalog.
- **Start the benchmark harness branch.** The precision/recall number becomes the headline claim.
- **Start the discriminated union follow-up branch.** Same work as Weak Path B, now with even higher priority because it supports the benchmark story.
- **Keep `govern()` in the codebase as an internal tool** but remove it from the public API until a future experiment reshapes the Path B hypothesis.

### Regression (raw > governed by any margin)
- **Do not ship `govern()` as a user-facing feature until the regression is understood.** A governance loop that makes agents *worse* is a serious finding that requires root-cause investigation.
- **Investigate before drawing conclusions.** Possible explanations: the narrowing is producing misleading information, the constraint accumulation is over-restricting the agent's search space, the governed loop's stuck-detector is firing too aggressively. Each requires its own investigation.
- **File as a new incident** (probably `GI-001` — Governance Incident 001) with the same discipline as the SI series.
- **Do not publish N1 results publicly until the regression is resolved or explained.** This is the one outcome where public disclosure is risky because it would undermine the project before the root cause is known.

### Ambiguous (any result not fitting the four buckets above)
- **RESULTS.md specifies what additional data would disambiguate.** Possible disambiguation: larger case count, different model, different retry budget, different narrowing rendering.
- **Decide whether it's worth collecting** based on the cost-vs-decisiveness tradeoff. An ambiguous result that could be disambiguated by another $10 of runs should probably be disambiguated. An ambiguous result that would require a month of work to disambiguate should be filed and returned to later.

---

## 24. "What would change our mind" section

Honest enumeration of results that would cause the author to abandon or seriously revise the current interpretation of N1. **The strength of this section is proportional to how hard it would be for the author to write it honestly. If it feels uncomfortable, it is being written correctly.**

### Results that would make the author say "Path A is right after all"

- **Governed and raw have the same convergence rate within 5 pp on the primary 52 cases.** The convergence loop adds no measurable benefit; the narrowing feedback is providing information the agent would have inferred from the raw failure message anyway.
- **Narrowing quality rates "neutral" on the majority of sampled cases**, with ≥70% inter-rater agreement. The narrowing is accurate but generic — it doesn't help the agent reason in a way that feeds convergence.
- **The N1-B bad_hint track shows governed-loop convergence on <50% of cases that were explicitly designed to benefit from narrowing.** If narrowing doesn't help even when the cases are hand-constructed to exercise it, narrowing is not the distinctive feature.
- **Retry count distributions are indistinguishable between loops.** Both loops retry the same number of times on average, which would suggest the narrowing isn't changing the agent's retry behavior in any measurable way.
- **Token spend is higher in governed than raw for equivalent convergence rates.** govern() would be strictly worse — more cost, same outcome.

### Results that would make the author say "the experiment was misdesigned"

- **Pilot phase fails the decision gate (raw convergence <20% or >80%).** The model choice doesn't provide enough dynamic range to measure governance benefit. The experiment must be re-piloted with a different model.
- **Pre-flight drops more than 15 cases from Source B.** The contingency rule triggers a full stop. Source B ground truth has drifted too far from current scanner behavior to be trustworthy.
- **Data quality metric (agent_error + approval_aborted rate) exceeds 10% on any case.** The LLM is flaking on specific cases in ways unrelated to convergence. Either the case is malformed or the model is unreliable on that shape; either way, the per-case result is unreliable.
- **Inter-rater agreement on narrowing quality drops below 70%.** The two raters share context but cannot agree on what "useful" means. The narrowing quality signal is subjective enough that it cannot support Weak Path B claims.
- **Stop reason distributions differ dramatically between pilot and full batch.** The pilot predicted convergence patterns that don't hold at scale. Something about the full-batch execution environment differs from the pilot in unexpected ways.

### Results that would make the author say "`govern()` has a problem we didn't anticipate"

- **Governed loop stops with `stuck` at >30% while raw exhausts at <10% on the same cases.** The stuck-detector is firing on cases that raw would have solved given more retries. This would be a bug in `govern()`'s convergence detection — too-aggressive stuck detection prevents cases from succeeding.
- **Governed loop converges MORE often but with DIFFERENT stop reasons on N1-B bad_hint cases than on N1-A false_negative cases.** The governance loop works differently on cases explicitly designed to exercise narrowing than on general convergence cases. This is a compositional problem — govern() is not a uniform lift across failure categories.
- **Running the same case 3 times produces different convergence outcomes on the governed loop but the same outcome on the raw loop.** Stochasticity in convergence despite deterministic LLM temperature (temperature=0). This would suggest govern()'s state handling between runs is contaminating the experiment despite the stateDir wipe — a harness bug or a `govern()` bug that needs debugging.
- **Constraint accumulation is visibly over-restricting the agent's search space.** If the agent's attempts grow MORE constrained over retries to the point of generating empty plans, `govern()` is narrowing too aggressively. The narrowing becomes a straitjacket instead of guidance.
- **The pre-flight check reveals that the scenario corpus contains more stale ground truth than expected**, and the replacement draws consistently come from the same sub-categories. Source B has a systematic staleness bias that the category-preserving replacement rule cannot fully correct for.

### Results that would make the author say "we need N1.1 before any decision"

- **Strong Path B on N1-A, Weak Path A on N1-B, or vice versa.** The two tracks give contradictory signals. One line of evidence supports Path B, the other supports Path A, and neither is strong enough to overrule the other. A larger N1.1 is needed to resolve the contradiction.
- **Different shapes of the raw-vs-governed delta across gate categories.** If `govern()` helps massively on f9 but not on content, or vice versa, the claim "convergence loop works" is too coarse. N1.1 must measure per-category.
- **The Haiku sanity check produces different deltas from Gemini.** Cross-model inconsistency. The result is model-dependent, not universal.
- **Demo-app concentration risk materializes visibly in the results.** If the majority of governed-loop convergences come from scenarios that share specific demo-app structural features (e.g., all the wins are on CSS scenarios, none on server.js route scenarios), N1's result is a fixture-specific artifact. N1.1 with multiple fixtures is required.

### The meta-question the author is committed to asking about their own result

"If I were a hostile reviewer trying to dismiss this result, what would I attack first?"

For each outcome above, the author commits to answering this question in RESULTS.md — not as a defense against criticism, but as a pre-empted disclosure. The credibility of any N1 result depends on the author's willingness to name its weaknesses in the same document that presents the strengths.

---

## 25. Outcome-to-next-action mapping (cross-reference)

See §23 for the full mapping. This section exists as a placeholder so the 25-item checklist from the pre-design review is fully satisfied. The content lives in §23 to keep it next to the outcome buckets.

---

## 26. Pre-registration freeze protocol

Once this document is operator-approved and committed, **no changes to the experimental design, case list, success criteria, success thresholds, contingency rules, or any specification in §1 through §25 are permitted without an explicit pre-registration amendment commit.**

An amendment commit must:

1. **Touch this DESIGN.md file** with the change clearly visible in the diff.
2. **Include a new section at the bottom** titled `## Pre-registration amendment N (YYYY-MM-DD)` where N is the amendment number (starting from 1), explaining:
   - What changed (specific section, specific text)
   - Why the change was needed (what was wrong with the original)
   - Whether any already-collected data is invalidated by the amendment (e.g., if success criteria change after runs have started, the old runs must be re-run under the new criteria)
   - Operator approval of the amendment
3. **Reference the amendment in the commit message** with format `N1 DESIGN.md pre-registration amendment N: <short description>`.
4. **Be committed and pushed separately from any other work** — no slipping design changes into unrelated commits.

**The amendment protocol is the discipline that makes this document binding.** Without it, "pre-registered" is aspirational. With it, any future reader can audit the git history of this file and verify that the experimental design was not silently adjusted mid-experiment. If the first version of DESIGN.md (this one) is the baseline, every amendment is visible as a distinct commit with a distinct rationale.

**Mid-experiment changes that would require an amendment:**
- Adding or removing cases from the case list
- Changing success criteria thresholds (even by a small amount)
- Changing the retry budget
- Changing the LLM model, temperature, or prompt shell
- Changing the denominator rule or stop reason classification
- Changing the pre-flight contingency rule
- Changing the bad_hint track structure
- Changing the inter-rater protocol or rating scale

**Changes that do NOT require an amendment:**
- Fixing bugs in the harness code that don't affect the experimental logic (e.g., a typo in a log message)
- Clarifying ambiguous language in DESIGN.md without changing the meaning (an editorial amendment is still recommended for transparency, but not required)
- Adding comments in the harness source code
- Re-running the entire experiment from scratch with the same DESIGN.md (this is a *replication*, not an amendment)

**Refusal clause:** If an operator or builder feels pressure to change the design mid-experiment without going through the amendment protocol — because "it's a small change" or "we'll document it in RESULTS.md" or "the pre-registration is too strict" — that pressure is exactly the scenario this protocol exists to prevent. The amendment protocol is inconvenient by design. Its inconvenience is the feature, not a bug.

**This refusal clause binds the builder as well as the operator.** If future-builder-Claude feels the pressure to make a small tweak without amendment because "it's obvious" or "nobody will notice" or "the amendment overhead isn't worth it for this change," that is also the scenario this protocol exists to prevent. Both sides of the operator/builder relationship are bound equally. A builder who silently adjusts the design mid-experiment, even with the best intentions, defeats pre-registration the same way an operator who waves through a "small change" does. The discipline is bilateral.

---

## Document status

- **Version:** 1 (initial pre-registration) + Amendment 1 (2026-04-09) + Amendment 2 (2026-04-09) + Amendment 3 (2026-04-09) + Amendment 4 (2026-04-09)
- **Author:** builder Claude (execution), operator (approval)
- **Date:** 2026-04-09
- **Status:** committed as `d581838` + Amendments 1 through 4 appended
- **Commit:** `d581838` (initial) + Amendment 1 (`2adf908`) + Amendment 2 (`e881221`) + Amendment 3 (`b6a029b`) + Amendment 4 (see git log)

Once committed, this document is frozen per §26 unless amended via the amendment protocol.

---

## Pre-registration amendment 1 (2026-04-09)

**Title:** Strike §8 (N1-B supplementary narrowing quality track) in its entirety.

**Authored by:** builder Claude
**Approved by:** operator (explicit ruling delivered during Phase 1 halt, 2026-04-09)
**Authorization reference:** Operator's ruling delivered in the N1 session immediately following the Phase 1 inventory step, titled "Ruling 1/2/3 — audit gap acknowledged, Option 1 selected, Amendment 1 authorized." The full operator response is the authorization of record.
**Amendment commit:** see git log for the commit landing this amendment.

### What changed

**§8 (N1-B supplementary narrowing quality track) is struck in its entirety.**

Specifically:
- The N1-B case structure (15-20 `bad_hint` scenarios from Source B) is removed from the experiment scope.
- The N1-B run count (45-60 governed-only runs) is removed from total run counts.
- The N1-B reporting section (a separate RESULTS.md section for narrowing quality on bad_hint cases) is removed.
- The "N1-B track reports are a separate section in RESULTS.md" rule is struck.
- Total N1 run count drops from **357-372 runs** (N1-A 312 + N1-B 45-60) to **312 runs** (N1-A only), plus the Haiku sanity check subset which remains unchanged.

**§17 (inter-rater narrowing quality protocol) is scoped down** to cover only the sample drawn from N1-A governed failures. The current §17 text reads:

> Sample size: 10-15 governed failures sampled from N1-A + all 15-20 cases from N1-B (governed-only). Total sample: 25-35 cases rated.

Under Amendment 1, the scoped-down reading is:

> Sample size: 10-15 governed failures sampled from N1-A. Total sample: 10-15 cases rated.

The rest of §17 (rating scale, protocol, reliability gate, transparency) is unaffected. The inter-rater protocol still runs; it just runs over a smaller sample.

### Why

Phase 1 inventory (2026-04-09) ran an aggregate intent-value scan across the full `fixtures/scenarios/` corpus. The results:

- `false_negative`: 2,190 scenarios
- `false_positive`: 2,249 scenarios
- `null` (untagged): 35 scenarios
- `regression_guard`: 18 scenarios
- **`bad_hint`: 0 scenarios**

Across ~90 staged files, the `bad_hint` intent is completely unpopulated. Zero scenarios carry this intent in the actual corpus.

DESIGN.md §8 was drafted based on the scenario loader's type definition in `scripts/harness/external-scenario-loader.ts`, which accepts `bad_hint` as one of four valid intent values. The inference that `bad_hint` scenarios existed in the corpus was made from the loader's type declaration, not from a data-level verification during the Phase 0b ground truth audit.

**This is an audit gap, acknowledged.** The Phase 0b audit checked `false_negative` vs `false_positive` counts in 6 sampled files and inferred `bad_hint` availability from the loader's type. An aggregate intent-value scan across the full corpus was not run during Phase 0b. If it had been, the `bad_hint = 0` finding would have surfaced before N1-B was included in DESIGN.md §8, and the amendment protocol would not have been needed.

The gap is named here because the credibility of Amendment 1 depends on being honest about how the original design committed to a data source that doesn't exist. Future readers should see that the builder caught the gap during Phase 1 execution, before any runs, and used the §26 amendment protocol to correct it. No silent substitution. No rationalization.

### What was considered and rejected

Two alternative responses to the empty `bad_hint` pool were considered and rejected before Option 1 was adopted.

**Option 2 — Hand-construct 15-20 `bad_hint` cases in Source D.**

Rejected because:
1. It would concentrate the entire supplementary track on `fixtures/demo-app/`, worsening the concentration risk already named in §11 as a threat to validity. The original hybrid track's justification was that N1-B drew from Source B's pre-labeled ground truth; replacing it with hand-crafted cases loses that property.
2. The entire reason Source B was promoted to primary in Report 3 was that it provides pre-labeled ground truth. Synthetic `bad_hint` cases don't have that property. Substituting them for the real data source defeats the reason N1-B was added to the design.
3. The inter-rater protocol in §17 pairs the operator and builder Claude as raters. If the operator hand-constructed the N1-B cases, the operator would be rating narrowings on cases the operator designed, which introduces a different bias than the single-labeler risk §11 already names. The independence assumption of inter-rater rating would break.

**Option 3 — Write a `bad_hint` generator script that corrupts Source B `false_negative` cases.**

Rejected because:
1. Auto-corrupted cases are a third class of input (neither pre-labeled nor hand-crafted) and the experiment has no infrastructure for a third source type. Adding one mid-stream is a scope expansion and would itself require a §26 amendment beyond this one.
2. Corruption strategies (mangle expected values, break search strings) produce failures that may not exercise narrowing at all — they may just exercise basic gate failure modes. Verifying that corrupted cases actually test narrowing quality would require inspecting each generated case by hand, which defeats the "automated generator" justification.

Both rejected options were less honest than Option 1 (strike the track). Option 1 is the response that matches the data that actually exists, with no substitute and no workaround.

### What this invalidates

- **§8 (N1-B supplementary narrowing quality track) in full.** The entire section is struck.
- **§17's sample size calculation.** The original calculation included 15-20 N1-B cases; the scoped-down calculation includes only the 10-15 N1-A sample.
- **§22's total run count estimate.** The original estimated 357-372 runs; the amended total is 312 runs (N1-A only), plus the Haiku sanity check subset (6-8 cases × 2 loops × 3 runs = 36-48 runs, unchanged), for a new total of **348-360 runs**.
- **§22's cost estimate narrative.** The cost estimates were built against the 357-372 run count; the actual cost is reduced proportionally. The **cost budget cap of $30 and the alert threshold of $20 are unchanged** — the amended run count is comfortably inside the original budget.

### What this does NOT invalidate

- **§1-§7 (question, hypotheses, success criteria, denominator rule, shared prompt shell, context renderers, retry budget, stop reasons, N1-A primary track).** The primary experiment is unchanged.
- **§9-§16 (source classification, cal.com exclusion, threats to validity, pre-flight methodology, contingency rule, pre-flight artifact, random seed, calibration oracle).** All unchanged.
- **§18-§21 (pilot phase, model choice, API key source, stateDir hygiene).** All unchanged.
- **§23-§25 (outcome mapping, "what would change our mind," cross-reference).** All unchanged.
- **§26 (Pre-registration freeze protocol).** Unchanged, and now governs Amendment 1 itself (see below).
- **The pre-registered success criteria (Strong/Weak Path B, Path A, Regression, Ambiguous).** All thresholds are unchanged. The criteria still apply to N1-A alone, which was always the primary track.
- **The random seed (20260409).** Unchanged.
- **The pre-flight contingency rule (§13).** Unchanged. The rule applies only to Source B `false_negative` draws, which are unaffected by this amendment.
- **The case budget for N1-A (40 Source B + 12 Source D = 52 cases).** Unchanged.

### Impact on the primary experiment

N1-A at 312 runs is unaffected by this amendment. The primary experiment can still distinguish all four primary outcomes (Strong Path B, Weak Path B, Path A, Regression) per §1's criteria. The loss is real but bounded: N1-B was a second independent line of evidence on narrowing quality. Without it, the narrowing quality signal rests on the §17 inter-rater review of 10-15 governed failures sampled from N1-A. That is weaker than two independent tracks, but it is not absent.

**RESULTS.md framing under Amendment 1:** "N1-B was planned as a supplementary narrowing quality track using `bad_hint` scenarios from Source B. During Phase 1 inventory, the `bad_hint` intent was found to be unpopulated in the scenario corpus (zero cases across ~90 staged files). Per §26, pre-registration Amendment 1 struck N1-B entirely rather than substituting a synthetic data source. Narrowing quality signal is reported from the N1-A sample only, as a secondary finding under §17."

This is a sharper methodology note than any synthetic replacement would have produced. It states the limitation, names the decision, and cites the amendment by reference.

### Amendment freeze clause

**Amendment 1 is now part of the pre-registration.** It is subject to §26 equally with the original DESIGN.md sections. Specifically:

1. **Amendment 1 cannot be reverted without another amendment.** If a future session decides N1-B should be reintroduced (say, if a future scenario corpus update populates `bad_hint` cases), that reintroduction requires a **Pre-registration Amendment 2** that explicitly references Amendment 1 and explains how the two interact.

2. **Future amendments must acknowledge Amendment 1.** Any Amendment N for N ≥ 2 must include a section titled "Interaction with prior amendments" that lists every preceding amendment and states whether and how Amendment N modifies or supersedes their effects.

3. **The §26 bilateral refusal clause applies to Amendment 1.** Neither the operator nor the builder may silently reverse or modify Amendment 1 under a "small change" rationalization. If pressure arises to reintroduce N1-B informally, §26 requires that pressure to be refused and routed through the amendment protocol.

4. **Amendment 1's rationale is itself audit-gated.** The audit gap named in the "Why" section ("The inference that bad_hint scenarios existed in the corpus was not verified against data during Phase 0b audit") is committed to the public record and cannot be retroactively rewritten to minimize the error. Future readers should see the gap as it was named on 2026-04-09, not as it might be re-framed later.

A pre-registration protocol that allows unlimited silent amendments is no protocol at all. Amendment 1 is binding.

---

### Phase 1 resumption note

Phase 1 was halted at step 1a (Source B inventory) when the empty `bad_hint` pool was discovered. Under Amendment 1, Phase 1 resumes at step 1b (build the selection script) on the amended design. The selection script draws only from the `false_negative` non-zero-edit pool for the 40 Source B cases targeting N1-A. No `bad_hint` draw step runs. All other Phase 1 substeps (pre-flight check, contingency rule application, synthetic seed construction, case-list.jsonl emission) proceed as originally designed.

The pre-flight checkpoint at Phase 1e — report drop count `k` to operator before committing `case-list.jsonl` — is unchanged. The operator and builder have agreed to pause at that checkpoint regardless of this amendment.

---

## Pre-registration amendment 2 (2026-04-09)

**Title:** Strike `hallucination` from the §7 primary-category reporting list; restructure the Source B selection algorithm to guarantee per-family coverage; pre-specify content-family small-sample disclaimer.

**Authored by:** builder Claude
**Approved by:** operator (explicit ruling delivered during Phase 1b distribution checkpoint, 2026-04-09)
**Authorization reference:** Operator's ruling delivered in the N1 session immediately following the Phase 1b candidate distribution report, titled "Four rulings, all aligned with your leans" (strike hallucination, content Option A, seeded shuffle, update §7 reporting row list from 10 to 9). The full operator response is the authorization of record.
**Amendment commit:** see git log for the commit landing this amendment.

### Interaction with prior amendments

**Amendment 2 is independent of Amendment 1.** Per §26's amendment chain requirement, this interaction is named explicitly so a future reader auditing the amendment sequence can see that neither amendment modifies or supersedes the other:

- **Amendment 1** struck §8 (the N1-B supplementary narrowing quality track) in its entirety after the `bad_hint` intent was found to be unpopulated in the Source B corpus. Amendment 1 does not affect the N1-A primary track's case selection or reporting.
- **Amendment 2** modifies the §7 primary-category reporting list (strikes `hallucination`), changes the Source B selection algorithm for the N1-A primary track (from category-level stratified sampling to shape-family-aware allocation with stratified remainder), and pre-specifies a small-sample disclaimer for the content-family reporting row. Amendment 2 does not affect the N1-B track (which no longer exists under Amendment 1) or any other pre-registration specification unrelated to §7.

Both amendments remain binding per §26. Neither amendment can be reverted without a further amendment that explicitly references the prior amendment chain and explains how the reversal interacts with both.

### What changed

**§7 (N1-A primary track) is modified in four specific ways under Amendment 2.** §7 is not struck in full; it is clarified and restructured. The following sub-changes apply:

**Change 1: `hallucination` is struck from the §7 primary-category reporting list.**

The current §7 language reads:

> **Per-category:** convergence rate delta (governed − raw), per gate category (f9, content, propagation, access, state, hallucination, config, grounding, security, a11y)

Under Amendment 2, the amended reading is:

> **Per-category:** convergence rate delta (governed − raw), per gate category (f9, content, propagation, access, state, config, grounding, security, a11y)

The list is reduced from 10 categories to 9. `hallucination` is removed entirely.

**Change 2: Source B selection algorithm is restructured to guarantee per-family coverage.**

The original §7 language committed to "distributed across ≥6 gate categories for coverage" without specifying the distribution algorithm. The implementation in `select-cases.ts` v1 used proportional stratified sampling across all 90 file-level categories, which produced a distribution where 4 of 6 primary shape families (content, propagation, state, hallucination) had 0 representation. This violated §7's per-category reporting commitment because 4 of the 10 RESULTS.md rows would be empty.

Under Amendment 2, the Source B selection algorithm is replaced with **shape-family-aware allocation followed by stratified remainder**:

1. **Load all qualifying scenarios** (`false_negative` intent, non-zero edits, conformity filter matching `loadStagedScenarios()`).
2. **Partition into primary-family pools** by filename prefix matching:
   - `f9` family: scenarios from `f9-staged.json`
   - `content` family: scenarios from `content-staged.json` and `content-advanced-staged.json` (not `contention-*-staged.json`)
   - `propagation` family: scenarios from files matching `propagation-*-staged.json`
   - `access` family: scenarios from files matching `access-*-staged.json`
   - `state` family: scenarios from files matching `state-*-staged.json`
3. **For each primary family, sort the family's scenarios by `case_id` (deterministic)**, then shuffle with the pinned mulberry32 seed (20260409), then take the first N scenarios where N is:
   - `f9`: 5
   - `content`: **4** (all qualifying scenarios — the universe is exactly 4)
   - `propagation`: 5
   - `access`: 5
   - `state`: 5
   - Total primary allocation: **5 + 4 + 5 + 5 + 5 = 24 cases**
4. **Remove the allocated primary-family cases from the remaining pool.** The remaining pool contains 1279 − 24 = **1255 scenarios** from non-primary categories.
5. **Run the existing stratified sampling algorithm** (proportional with ≤12-per-category cap and ≥3-per-category floor) on the remaining pool for **16** leftover slots.
6. **Merge primary + stratified** into the final 40-case draw.
7. **Sort the final draw by `case_id`** for deterministic ordering in `candidates-source-b.jsonl`.

This algorithm is deterministic given the pinned seed. The within-family shuffle happens after sorting by `case_id` to remove any dependency on file iteration order.

**Edge case: primary-family universe exhaustion under pre-flight drops.** The content family has exactly 4 qualifying scenarios in the corpus, and Amendment 2 allocates all 4 to N1-A. If pre-flight (§12) drops any content-family case, the §13 "same category distribution" replacement rule cannot be satisfied from within the content family because the universe is exhausted by the initial allocation. In this specific scenario, Phase 1 halts at the pre-flight `k` checkpoint and the specific dropped content case is surfaced to the operator for an explicit ruling on whether to (a) accept content-family under-representation at 3 or fewer cases with an updated small-sample disclaimer, (b) substitute from a different source, or (c) trigger an Amendment 3 to revise the Source B selection rules. **No silent substitution is permitted.** This edge case applies only to primary families whose total qualifying universe is exhausted by the initial Amendment 2 allocation; as of the Phase 1b feasibility inventory (2026-04-09), content is the only such family. If future Source B corpus updates reduce another primary family's universe below its Amendment 2 allocation (currently f9, propagation, access, state all have ≥15 qualifying scenarios, well above the allocation), this edge case extends to that family as well.

**Change 3: Content family is pre-specified with a small-sample disclaimer.**

The content family has exactly 4 qualifying scenarios in the corpus (`content-staged.json`: 4, `content-advanced-staged.json`: 0). Allocating all 4 to N1-A yields 4 cases × 3 runs × 2 loops = **24 data points per loop**, which is below the statistical interpretability floor of 30 data points per loop named during the Amendment 2 ruling.

**Amendment 2 pre-commits the following disclaimer language to be used verbatim in RESULTS.md's content-family reporting row:**

> **Content family N1-A sample:** 4 cases × 3 runs × 2 loops = 24 data points per loop. Below the 30-point floor named as the statistical interpretability threshold in Amendment 2. Per-category delta reported for completeness; any claim about content-family convergence behavior is **provisional** and requires a follow-up N1.1 with a larger content sample before publication.

This disclaimer binds the reporting in both directions. If the content delta comes in favoring the governed loop, the disclaimer prevents writing "governed wins decisively on content" without first citing the sample-size caveat. If the delta comes in showing equivalence, the disclaimer prevents writing "content shows equivalence" without the caveat either. The disclaimer is pre-specified, not deferred to RESULTS.md drafting, to remove the post-hoc softening temptation.

**Change 4: §7 reporting table schema is updated to distinguish sources.**

The original §7 per-category reporting table conflated all 10 categories into a single list without indicating which categories came from Source B (pre-labeled ground truth) and which came from Source D (hand-constructed synthetic seeds). Amendment 2 updates the reporting table schema to make the source explicit. The amended §7 reporting table has these columns:

| Category | Source | Count | Convergence rate (raw) | Convergence rate (governed) | Delta | Notes |
|---|---|---|---|---|---|---|

Where **Source** is one of:
- `B-primary` — category is a primary shape family under the Amendment 2 selection algorithm (f9, content, propagation, access, state)
- `B-stratified` — category is drawn from the stratified remainder pool after primary-family allocation (any non-primary category that received ≥1 case)
- `D-synthetic` — category is filled by hand-constructed Source D synthetic seeds (config, grounding, security, a11y per Report 3)

A reader of RESULTS.md can immediately see which categories came from pre-labeled ground truth versus which came from hand-construction, and any interpretation of the delta for a given category should weight the source appropriately.

### Why

The operator ruling on the Phase 1b candidate distribution found that the stratified sampling algorithm in `select-cases.ts` v1 produced a distribution where 4 of 6 §7-named primary shape families had zero representation. Specifically:

- **f9**: 2 cases (represented, but under-allocated)
- **content**: 0 cases
- **propagation**: 0 cases (0 across all 8 propagation-* files)
- **access**: 1 case (only `access-browser`)
- **state**: 0 cases (0 across all 6 state-* files)
- **hallucination**: 0 cases

The root cause is that the stratified sampling treats each staged file as its own category, so shape families that span multiple sub-categorized files (propagation has 8 sub-files, access has 8, state has 6) get 0-1 cases at the proportional allocation stage because no individual sub-file is large enough to receive a proportional slot. The round-robin fill then prioritizes the file-level largest categories (`mdn-compat` at 119, `secrets` at 93, `a11y` at 60), none of which are primary shape families.

The result is that §7's per-category reporting commitment — "convergence rate delta per gate category (f9, content, propagation, access, state, hallucination, config, grounding, security, a11y)" — cannot be satisfied from the current draw. Four of the 10 RESULTS.md rows would be empty, and no number in those rows would be reportable.

This is the second pre-registration audit gap discovered during Phase 1 execution, following Amendment 1's `bad_hint` gap. Both gaps are structurally identical: a pre-registered commitment in DESIGN.md turns out to be unsatisfiable from the data under the current implementation. Both are caught before any experimental runs.

**The specific audit gap named explicitly:** The original Phase 0b ground-truth audit counted `false_negative` vs `false_positive` distributions in 6 sampled files and inferred that all §7 primary categories had adequate representation. It did not verify at the shape-family level, and it did not verify that primary families spanning multiple sub-categorized files would be picked up by the stratified sampling algorithm. The gap is that the audit tested category availability at the file level but the §7 commitment was at the shape-family level. These are different questions, and conflating them produced the current situation.

**A separate finding** surfaced during feasibility verification: the `hallucination-staged.json` file contains 30 `false_negative` scenarios, but **all 30 have zero edits**. They are pure predicate-check scenarios (verify that certain claims are grounded in reality) that do not have an agent-edit action for the N1 convergence loop to iterate on. Under the "non-zero edits" requirement, all 30 are filtered out, making the hallucination family structurally absent from the N1-eligible pool. This is not a fixable gap — N1 measures convergence behavior on edit-producing scenarios, and hallucination-class failures in the corpus are not edit-producing. Hallucination is a real shape family that N1 cannot measure under its current design.

### What was considered and rejected

Five alternative responses were considered and rejected before Amendment 2 was adopted.

**Option R1 — Weaken §7 to "illustrative not required" for the primary-category list.**

Rejected because:
1. The §7 list was specifically chosen to guarantee that primary shape families would be reported. Weakening the list to "illustrative" retroactively waters down the coverage commitment in the same way weakening Amendment 1 would have. The refusal clause from §26 binds against this exact rationalization.
2. RESULTS.md readers would lose the ability to verify that the experiment tested the shape families verify claims to catch. A weakened list turns the per-category table into "whatever we happened to draw" rather than "the shape families we committed to measuring."
3. The test from §26's clarification is: "if the choice could be swapped for a different choice without changing any number in DESIGN.md, it's implementation detail." Weakening §7 changes the meaning of a DESIGN.md commitment; it is not implementation detail.

**Option R2 — Hand-construct hallucination cases in Source D.**

Rejected because:
1. The hallucination family in the corpus is predicate-only (zero-edit). Hand-crafted hallucination-shaped cases would have to be invented as edit-producing scenarios, which would not exercise the same failure mode as the predicate-only corpus they'd be filed under. They would be hand-crafted *action* scenarios dressed up as hallucination cases, which is methodologically misleading.
2. This parallels Amendment 1's rejection of hand-crafted `bad_hint` cases — synthetic substitutes for missing data sources concentrate on demo-app and lose the pre-labeled ground truth that justified Source B as primary.
3. Hallucination is structurally different from other primary families. Other families (f9, content, propagation, access, state) have edit-producing scenarios in the corpus. Hallucination does not. Substituting hand-crafted edit scenarios for predicate-only corpus scenarios would misrepresent what N1 measures.

**Option R3 — Strike content alongside hallucination.**

Rejected because:
1. The content family has 4 qualifying scenarios in the corpus. Striking it because the sample is small loses signal that exists, unlike hallucination where the sample is structurally zero. Amendment 1's N1-B strike was justified by 0 cases; content's 4 cases do not meet the same bar.
2. Weak-but-present evidence with a disclosed sample-size caveat is more honest than no evidence with the category silently removed. The small-sample disclaimer (Change 3) is the right way to express "we have weak evidence here" without throwing the evidence away.
3. The cost of the disclaimer is disclosed; the cost of silent removal would be a reader looking at the §7 list and wondering why content isn't reported. The disclaimer path is more auditable.

**Option R4 — Hand-construct 1 additional content case in Source D to bring content-family coverage to 5.**

Rejected because:
1. Mixing Source B and Source D within the same category introduces a confound that makes the per-category delta harder to interpret. A reader seeing "content: 5 cases, delta 12%" cannot distinguish whether the delta came from the 4 real scenarios or the 1 synthetic one.
2. Keeping Source B and Source D disjoint by category preserves the interpretability of the per-category numbers. The Amendment 2 reporting table schema (Change 4) makes the source visible per row; mixing sources within a row defeats that visibility.
3. Source D has a fixed 12-case budget earmarked for coverage gaps (config, grounding, security, a11y). Adding a 13th case for content expands Source D beyond its Report 3 specification, which would itself require justification.

**Option R5 — Proportional within-family distribution for sub-file allocation.**

Rejected because:
1. Distributing cases within a family proportional to sub-file size oversamples the sub-categories that happen to have the most scenarios, which correlates with how actively that sub-category has been developed. This introduces a hidden selection bias: the best-developed sub-categories get the most weight, and the less-developed ones get the least.
2. The experiment wants a mix of well-understood and less-understood cases, not a concentration in the former. Proportional distribution within a family defeats that goal.

**Option R6 — Round-robin within-family distribution for sub-file allocation.**

Rejected because:
1. Round-robin fails for families where sub-files have wildly different sizes. The state family has `state-browser`=5, `state-config`=1, `state-db`=0, `state-fs`=3, `state-http`=3, `state-multistep`=3. Round-robin across non-empty sub-files gives each sub-file 1 case, which means state-browser (5 scenarios) and state-config (1 scenario) get equal weight. That's not a signal about convergence; it's a signal about sub-file partitioning.
2. The selected approach (seeded shuffle over the sorted full family pool) is agnostic to sub-file partitioning. The seed governs the selection deterministically, and the sub-file distribution within the family is a seed-determined output that can be inspected in the candidates file.

### What this invalidates

- **§7's per-category reporting list.** Reduced from 10 categories to 9 (hallucination removed).
- **§7's Source B selection algorithm language** ("distributed across ≥6 gate categories for coverage"). Replaced with the shape-family-aware algorithm specified in Change 2.
- **§7's per-category reporting table schema.** Updated to include the `Source` column (B-primary, B-stratified, D-synthetic).
- **The current `candidates-source-b.jsonl` file** (produced by `select-cases.ts` v1 on 2026-04-09). This file does not satisfy the Amendment 2 selection algorithm and must be regenerated by `select-cases.ts` v2.
- **The current `select-cases.ts` implementation.** The v1 algorithm is file-level stratified sampling; the v2 algorithm is shape-family-aware allocation with stratified remainder. The v1 file must be updated before the next selection run.
- **Any claim about hallucination-family convergence behavior in RESULTS.md.** RESULTS.md must include a scope limit stating "N1 did not test hallucination-family scenarios. The `hallucination-staged.json` corpus file contains 30 `false_negative` scenarios, all of which are predicate-only (zero-edit) and therefore filtered out by the N1 oracle. Hallucination-class failures require a separate experiment design that does not rely on agent-edit iteration."
- **The content-family row in RESULTS.md.** Must include the pre-specified small-sample disclaimer from Change 3 verbatim.

### What this does NOT invalidate

- **§1-§6 (question, hypotheses, success criteria, denominator rule, shared prompt shell, context renderers, retry budget, stop reasons).** All unchanged. The success criteria thresholds are unchanged; they still apply to N1-A as a whole, not to individual categories.
- **§8 (N1-B supplementary narrowing quality track).** Already struck by Amendment 1; Amendment 2 does not re-introduce N1-B.
- **§9-§16 (source classification beyond the §7 primary list, cal.com exclusion, threats to validity, pre-flight methodology, contingency rule, pre-flight artifact, random seed, calibration oracle).** All unchanged. The cal.com exclusion, pre-flight contingency rule, pre-flight artifact schema, and random seed (20260409) are unchanged.
- **§11 threats to validity.** The existing entries are unchanged. Amendment 2 adds a new threat-to-validity note (the hallucination exclusion) that will be incorporated into RESULTS.md's limitations section verbatim.
- **§13 pre-flight contingency rule.** Unchanged. The rule applies only to pre-flight drops, and the new selection algorithm does not affect how drops are handled.
- **§14 pre-flight artifact specification.** Unchanged. The case-list.jsonl schema is the same; only the cases flowing through it differ.
- **§15 random seed (20260409).** Unchanged.
- **§17 inter-rater narrowing quality protocol.** Unchanged beyond the sample-size scoping already done by Amendment 1.
- **§18-§21 (pilot phase, model choice, API key source, stateDir hygiene).** All unchanged.
- **§22 cost budget and alert threshold.** Unchanged. The total run count is already bounded by the 52-case budget which is unchanged.
- **§23-§25 (outcome-to-next-action mapping, "what would change our mind," cross-reference).** All unchanged.
- **§26 (Pre-registration freeze protocol).** Unchanged, and now governs Amendment 2 as well as Amendment 1.
- **The case budget for N1-A (40 Source B + 12 Source D = 52 cases).** Unchanged. Only the internal distribution of the 40 Source B cases changes under Amendment 2.

### Impact on the primary experiment

N1-A at 52 cases and 312 runs is unchanged in total count. What changes is:

1. **Which 40 cases are selected from Source B.** The new algorithm allocates 24 cases to primary shape families (f9, content, propagation, access, state) and 16 cases to the stratified remainder across non-primary categories. The category coverage of N1-A now matches §7's reporting commitment.

2. **The hallucination row in the §7 reporting table is struck.** RESULTS.md reports 9 per-category rows instead of 10.

3. **The content row in the §7 reporting table carries a pre-specified small-sample disclaimer.** The disclaimer is not optional and cannot be removed post-hoc.

4. **The §7 reporting table schema includes a source column.** Each row is labeled B-primary, B-stratified, or D-synthetic so a reader can weight the source appropriately.

The primary success criteria (Strong Path B / Weak Path B / Path A / Regression / Ambiguous) are unchanged. They apply to the N1-A aggregate, not to individual categories. A per-category delta is a secondary finding; the primary finding is the aggregate convergence rate delta across all 52 cases.

### Amendment freeze clause

**Amendment 2 is now part of the pre-registration.** It is subject to §26 equally with the original DESIGN.md sections and with Amendment 1. Specifically:

1. **Amendment 2 cannot be reverted without another amendment.** If a future session decides to change the Source B selection algorithm, restore hallucination to the §7 reporting list, or remove the content small-sample disclaimer, that change requires a **Pre-registration Amendment 3** that explicitly references both Amendment 1 and Amendment 2 and explains how the three interact.

2. **Future amendments must acknowledge Amendment 2.** Any Amendment N for N ≥ 3 must include a section titled "Interaction with prior amendments" that lists Amendment 1, Amendment 2, and any other preceding amendments, and states whether and how Amendment N modifies or supersedes their effects.

3. **The §26 bilateral refusal clause applies to Amendment 2.** Neither the operator nor the builder may silently reverse or modify Amendment 2 under a "small change" rationalization. If pressure arises to relax the per-family coverage guarantee, restore hallucination, or soften the content disclaimer, §26 requires that pressure to be refused and routed through the amendment protocol.

4. **Amendment 2's rationale is itself audit-gated.** The audit gap named in the "Why" section ("the audit tested category availability at the file level but the §7 commitment was at the shape-family level") is committed to the public record and cannot be retroactively rewritten to minimize the error. Future readers should see the gap as it was named on 2026-04-09, not as it might be re-framed later.

5. **The pre-specified content disclaimer language is binding.** The disclaimer text in Change 3 is committed verbatim to Amendment 2 and must appear in RESULTS.md's content-family reporting row without alteration. Any softening, conditionalization, or reformulation of the disclaimer requires an Amendment 3. This is the strongest form of pre-commitment and is the direct consequence of the operator's ruling that the disclaimer binds the reporting in both directions.

A pre-registration protocol that allows unlimited silent amendments is no protocol at all. Amendment 2 is binding.

---

### Phase 1b resumption note (Amendment 2)

Phase 1b was halted at the candidate distribution reporting checkpoint when the per-category coverage gap was discovered. Under Amendment 2, Phase 1b resumes with:

1. **Update `select-cases.ts`** to implement the shape-family-aware allocation algorithm (Change 2). The v1 implementation is replaced by a v2 implementation that partitions the qualifying scenario pool into primary-family pools, allocates per-family, and runs stratified sampling on the remainder.
2. **Re-run `select-cases.ts` v2** with the unchanged seed (20260409) and the unchanged corpus SHA (the Amendment 2 commit SHA, once landed). The output is a new `candidates-source-b.jsonl` that replaces the v1 file.
3. **Report the new distribution** to the operator for approval before proceeding to pre-flight. The new distribution should show: 5 cases from f9, 4 cases from content, 5 cases from propagation, 5 cases from access, 5 cases from state, and 16 cases distributed via stratified remainder across non-primary categories.
4. **Proceed to Phase 1c (pre-flight check)** only after operator approval of the new distribution.

The pre-flight checkpoint at Phase 1e — report drop count `k` to operator before committing `case-list.jsonl` — is unchanged by Amendment 2. Amendment 1 and Amendment 2 both preserve the operator-builder pause at the pre-flight checkpoint regardless of other changes.

---

## Pre-registration amendment 3 (2026-04-09)

**Title:** Clarify §13's "same category distribution" replacement rule for primary-family drops under Amendment 2 Change 2's family-level allocation; preserve §13's literal text for stratified remainder drops.

**Authored by:** builder Claude
**Approved by:** operator (explicit ruling delivered during Phase 1f replacement-draw checkpoint, 2026-04-09)
**Authorization reference:** Operator's ruling delivered in the N1 session immediately following the `computeSwaps` halt for the propagation-http drop, titled "Three rulings, fast — yes §26 amendment situation, Reading 1, draft Amendment 3 immediately." The full operator response is the authorization of record.
**Amendment commit:** see git log for the commit landing this amendment.

### Interaction with prior amendments

**Amendment 3 is independent of Amendment 1 and Amendment 2.** Per §26's amendment chain requirement, this is the first three-amendment chain in the pre-registration, and the interaction section is named explicitly so a future reader auditing the chain can see how the three amendments compose:

- **Amendment 1** struck §8 (the N1-B supplementary narrowing quality track) in its entirety after the `bad_hint` intent was found to be unpopulated in the Source B corpus. Amendment 1 affects the supplementary track only and does not interact with Source B selection or §13.

- **Amendment 2** modified §7's primary-category reporting list (struck `hallucination`), restructured the Source B selection algorithm for the N1-A primary track from category-level stratified sampling to shape-family-aware allocation followed by stratified remainder, pre-specified the content-family small-sample disclaimer, and updated §7's reporting table schema. Amendment 2 created the algorithmic surface that Amendment 3 now clarifies. The §13 ↔ Amendment 2 Change 2 interaction gap that Amendment 3 resolves did not exist before Amendment 2 — under the v1 stratified-only algorithm, §13's "same category distribution" rule had only one possible reading.

- **Amendment 3** clarifies how §13's replacement rule operates when a dropped case belongs to a primary family allocated under Amendment 2 Change 2. Amendment 3 does not modify §7, Amendment 1, or Amendment 2. It resolves an interaction gap that emerged when Amendment 2's algorithm reshaped the meaning of "category" for primary-family drops.

All three amendments remain binding per §26. None of the three modifies or supersedes any of the others. Future amendments must include an "Interaction with prior amendments" section that lists Amendments 1, 2, and 3 in order and states whether and how the new amendment modifies or supersedes each of their effects.

### What changed

§13 (pre-flight contingency rule) is **not modified** in its original location. The original rule remains exactly as written and continues to govern stratified remainder drops. Amendment 3 adds a clarification that applies only to primary-family drops, where the Amendment 2 Change 2 algorithm and §13's literal text interact in a way the original pre-registration did not specify.

Under Amendment 3, §13's "same category distribution" rule is interpreted as follows:

**Primary-family drops (cases drawn from one of the Amendment 2 Change 2 primary families: f9, content, propagation, access, state):**

- Replacement is drawn from the **same primary family** as the dropped case.
- Replacement need NOT be from the same file-level category (sub-file). A drop from `propagation-http` may be replaced by a case from `propagation-cli`, `propagation-browser`, or any other propagation sub-file, as determined by the deterministic post-shuffle filter that the v2 selection algorithm produces under `--skip`.
- The audit trail in `candidates-source-b-replacements.jsonl` MUST surface the relaxation by setting `category_match: false` and `primary_family_match: true` on the swap record. A reader scanning the swap history immediately sees that a primary-family relaxation was applied and is not left wondering whether the script silently bypassed §13.
- The audit trail MUST include a `substitution_reason` field on swap records where `category_match: false` that names Amendment 3 as the authority for the relaxation. The exact substitution reason language is:

  > "Amendment 3 primary-family replacement rule: same primary family ({family_name}), different sub-file category ({original_sub_file} → {replacement_sub_file}). §13's strict category match is not preserved for primary-family drops; §13 + Amendment 3 explicitly permits sub-file flexibility within primary families."

  Where `{family_name}`, `{original_sub_file}`, and `{replacement_sub_file}` are populated from the dropped and replacement candidates.

**Stratified remainder drops (cases drawn from any non-primary category by the proportional + round-robin stratified sampler):**

- §13 is **unchanged**. Replacement is drawn from the same file-level category as the dropped case. Strict matching applies. Amendment 3 does not modify this code path.
- The audit trail records `category_match: true` and `primary_family_match: null` (or `false` if the dropped case has no primary family, which is always the case for stratified remainder drops) on these swap records. No `substitution_reason` is required because no relaxation was applied.

**Two separate rules for two separate code paths.** The implementation in `computeSwaps` must distinguish primary-family drops from stratified-remainder drops by inspecting `dropped.primary_family` (non-null vs null), apply Reading 1 to the former, and apply §13's literal text to the latter. Conflating the two code paths would defeat Amendment 3's two-rule structure.

### Why

This is a **different class of audit gap** than Amendments 1 and 2. The first two amendments were data-level gaps — the corpus did not match what DESIGN.md assumed about it (Amendment 1: `bad_hint` intent unpopulated; Amendment 2: stratified sampling produced 0 cases in 4 of 6 §7-named primary shape families). Amendment 3 is an **interaction-level gap** — two pre-registered rules (§13 and Amendment 2 Change 2) compose in a way the original pre-registration did not fully specify.

Naming this distinction matters for future readers trying to understand what kind of discipline prevented the gap from corrupting the experiment. The discipline isn't just "verify data against assumptions" but also "verify that pre-registered rules compose cleanly when one rule is amended." The first kind of gap is caught by data audits at the start of Phase 1. The second kind of gap is caught when pre-registered rules are exercised against each other in code, which is what happened in `computeSwaps` when it tried to honor §13's category-distribution rule against an Amendment 2 family-level allocation.

The specific gap, named precisely:

The §13 rule reads: *"Draw `k` replacement Source B cases from the **same category distribution** as the dropped cases (if 2 dropped cases were from f9 and 3 were from access-fs, draw 2 new f9 + 3 new access-fs)."*

§13 was written before Amendment 2 existed. At the time, the v1 selection algorithm operated at the file-level category — every staged file was its own category, and "same category distribution" meant strict file-level matching. Under v1, a `propagation-http` drop would be replaced by another `propagation-http` case, full stop.

Amendment 2 Change 2 reshaped the selection algorithm to operate at the **primary family** level for the 5 families named in §7 (f9, content, propagation, access, state). The v2 algorithm pools all `propagation-*` files into a single propagation family pool, shuffles the pool, and takes the first 5 — the algorithm is no longer aware of the sub-file partitioning at the allocation level. When `--skip` is applied to a primary-family drop and the deterministic post-shuffle filter promotes the next candidate from the shuffled pool, that candidate may come from a different sub-file than the dropped case.

This is the interaction gap. §13 says "same category." Amendment 2 says "same family, sub-file flexible." Both are pre-registered. Both are binding. They produce different replacement candidates for primary-family drops. The original pre-registration did not specify which interpretation governs when they conflict.

**The Phase 1c k=3 report I gave the operator implicitly assumed Reading 2 (strict file-level match)** without verifying whether the Amendment 2 v2 algorithm could deliver same-sub-file replacements. The Phase 1c report stated: "The 3 drops break down by **original drawing category**: 1. `access-cli` — needs 1 replacement from `access-cli`; 2. `postcss-edge-cases` — needs 1 replacement from `postcss-edge-cases`; 3. `propagation-http` — needs 1 replacement from `propagation-http`." That framing was wrong for the two primary-family drops (`access-cli` and `propagation-http`) because the v2 algorithm's primary-family allocation does not track sub-file allocations. The framing was correct for the stratified remainder drop (`postcss-edge-cases`) because that drop was made by the per-category stratified sampler, which does honor strict file-level matching.

**The script halted on the propagation-http drop when `computeSwaps` tried to find a same-category replacement and found zero new candidates from `propagation-http` in the replacement-aware run.** The halt is the §26 protocol working at exactly the right granularity: a pre-registered rule (§13's strict category matching) hit a post-amendment reality (Amendment 2's family-level allocation) and the discipline routed the conflict through the amendment protocol instead of allowing a unilateral interpretation.

### What was considered and rejected

**Reading 2 — Strict file-level category matching for primary-family drops.**

Under Reading 2, §13's literal text is preserved for all drops, including primary-family drops. A drop from `propagation-http` must be replaced by another `propagation-http` case.

Rejected because:

1. **It would require a large algorithm change to the v2 selection script.** The v2 algorithm's primary-family allocation pools all sub-files together and takes 5 from the shuffled family pool. To deliver a same-sub-file replacement, the algorithm would need to track sub-file allocations within each primary family, re-shuffle each sub-file pool, and apply per-sub-file allocation logic. This is a significant restructuring of Amendment 2 Change 2's algorithm, and it would itself be a §26 amendment because it changes the meaning of "5 cases per primary family" — the count would now be distributed across sub-files in some specific way, which Amendment 2 deliberately left to the seeded shuffle.

2. **Or it would reduce primary-family coverage below 5.** If the algorithm cannot deliver a same-sub-file replacement from within the primary-family allocation, the only fallback under Reading 2 is to draw the replacement from outside the primary allocation entirely — which would mean the primary family ends up with 4 cases instead of 5 plus a substituted case from somewhere else. This violates Amendment 2 Change 2's coverage guarantee that each primary family gets 5 cases (or 4 for content), which is the entire reason Amendment 2 exists.

3. **Reading 2's audit trail would be misleading.** A `category_match: true` flag on a propagation-http → propagation-http replacement would suggest that the replacement was drawn cleanly from the same shuffled sub-pool, when in reality the algorithm doesn't have a sub-pool for it. The audit trail would either lie or require even more complex tracking to be honest.

Both options are worse than Reading 1 (relax category matching for primary-family drops, preserve §13 strict matching for stratified remainder drops, surface the relaxation in the audit trail with the `category_match: false` flag and the `substitution_reason` field).

**Reading 1 (the chosen path)** preserves Amendment 2's primary-family coverage guarantee, honors §13's literal text for stratified remainder drops where strict matching is achievable, and surfaces the relaxation honestly in the audit trail rather than hiding it. The cost of Reading 1 is that primary-family drops are replaced with weaker category matching than the original pre-registration implied — but this cost is paid in disclosure, not in silent algorithm modification.

### What this invalidates

- **§13's interpretation for primary-family drops.** Under Amendment 3, §13's "same category distribution" rule is read as "same primary family with sub-file flexibility" when applied to primary-family drops. The literal text of §13 in its original location is unchanged; Amendment 3 adds the interpretive clarification.
- **The implicit assumption in the Phase 1c k=3 report** that all three drops would be replaced from their respective file-level categories. The report's framing was wrong for the `access-cli` and `propagation-http` drops; it was correct for the `postcss-edge-cases` drop.
- **The original `computeSwaps` implementation in `select-cases.ts`** that throws when no same-category replacement is found. Under Amendment 3, `computeSwaps` must distinguish primary-family drops from stratified-remainder drops and apply the relaxed matching rule to the former. This is a code change required to implement Amendment 3, not a separate amendment.

### What this does NOT invalidate

- **§13 in its original location.** The literal text of §13 is unchanged. Amendment 3 adds an interpretive clarification for the primary-family drop case; the stratified remainder rule continues to read exactly as §13 originally stated.
- **§13 for stratified remainder drops.** Strict file-level category matching still applies. The `postcss-edge-cases` drop must be replaced by another `postcss-edge-cases` case under §13 unmodified. Amendment 3 explicitly preserves this code path.
- **§7** (per-category reporting list, primary track structure, reporting table schema, Amendment 2 Change 4 source column).
- **§8** (struck by Amendment 1; not re-introduced).
- **§9-§16** (source classification, cal.com exclusion, threats to validity, pre-flight methodology, contingency rule original text, pre-flight artifact specification, random seed, calibration oracle).
- **§17-§26** (inter-rater protocol, pilot phase, model choice, API key source, stateDir hygiene, cost budget, outcome mapping, "what would change our mind," cross-reference, freeze protocol).
- **Amendment 1 (struck N1-B).** Amendment 3 does not affect the supplementary track question because the supplementary track no longer exists.
- **Amendment 2 (struck hallucination, restructured Source B selection, content disclaimer, source column).** Amendment 3 does not modify any of Amendment 2's four changes. Specifically: the primary-family allocation rule, the per-family counts (f9=5, content=4, propagation=5, access=5, state=5), the content small-sample disclaimer language, and the §7 reporting table schema all remain exactly as Amendment 2 specified.
- **The 40-case live set from the initial selection.** The Phase 1b draw committed in `a84c26e` is unchanged. Amendment 3 clarifies how replacements are drawn after the initial selection, not what the initial selection contains.
- **The pre-flight results from Phase 1c.** k=3 is unchanged. The three dropped cases are unchanged. The pass/fail status of the 37 non-dropped cases is unchanged. Amendment 3 only affects how the 3 replacements are drawn.
- **The content-family Amendment 2 edge case.** Not triggered by k=3, not affected by Amendment 3. Content remains at 4 cases.
- **The pre-flight contingency buckets** (k ≤ 5, 6 ≤ k ≤ 15, k > 15). The current k=3 is in the k ≤ 5 bucket per §13, and Amendment 3 does not modify the bucket boundaries or their semantics.
- **The random seed (20260409).** Unchanged.

### Impact on the primary experiment

**Zero direct impact.** The N1-A 52-case target, the 312-run total, the per-loop split, the success criteria, the denominator rule, the §17 inter-rater protocol, the pilot phase, the model choice, the cost budget, the outcome mapping, and the "what would change our mind" section are all unchanged. The 40-case Source B initial draw is unchanged. The k=3 pre-flight result is unchanged.

The only thing that changes is the interpretation of how the 3 replacement candidates are drawn. Under Amendment 3, two of the three replacements (for the `access-cli` and `propagation-http` drops, both primary-family drops) are drawn under Reading 1's relaxed sub-file matching, and one (for the `postcss-edge-cases` drop, a stratified remainder drop) is drawn under §13's strict matching. The post-replacement live set is then 40 cases as planned, with the `category_match: false` flag set on the two primary-family swap records and `category_match: true` set on the stratified remainder swap record.

Phase 1f resumes immediately after Amendment 3 commits with the updated `computeSwaps` logic. No experimental runs are affected because no experimental runs have happened yet — Amendment 3 lands during Phase 1, before Phase 2 (harness construction) begins.

### A named expectation for future amendments

This is the first instance of an interaction-level gap (as opposed to the data-level gaps that Amendments 1 and 2 resolved). The pattern that produced Amendment 3 is: a pre-registered rule (§13) was written assuming a specific selection algorithm structure, that algorithm was later replaced by an amendment (Amendment 2 Change 2), and the original rule's interpretation under the new structure was not specified by the amending document.

**The same pattern may apply to other §13-era rules.** Specifically, the pre-flight contingency buckets (k ≤ 5, 6 ≤ k ≤ 15, k > 15) were written when "category" meant file-level category, and they may have similar interaction gaps with Amendment 2's family-level allocation. For example: if a future pre-flight produces drops that span multiple primary families (e.g., 2 from `propagation`, 3 from `access`, 5 from various stratified categories), the bucket interpretation might be straightforward, OR it might require clarification about whether the 10 total drops trigger the `6 ≤ k ≤ 15` bucket regardless of family origin, or whether the family-level drops are counted separately from the stratified-remainder drops.

**Amendment 3 does not resolve these potential future gaps.** It is naming them here so the audit trail shows that the issue was considered during Amendment 3 drafting and explicitly deferred. If a future pre-flight produces a drop pattern that exposes one of these gaps, an Amendment 4 (or later) should be drafted to resolve it, following the same template as Amendments 1, 2, and 3. The bilateral §26 refusal clause applies — neither the operator nor the builder may silently interpret the §13-era rules under Amendment 2's algorithm without explicit pre-registration clarification.

### Amendment freeze clause

**Amendment 3 is now part of the pre-registration.** It is subject to §26 equally with the original DESIGN.md sections and with Amendments 1 and 2. Specifically:

1. **Amendment 3 cannot be reverted without another amendment.** If a future session decides to restore strict file-level matching for primary-family drops, that change requires a **Pre-registration Amendment 4** that explicitly references Amendments 1, 2, and 3 and explains how the four interact.

2. **Future amendments must acknowledge Amendment 3.** Any Amendment N for N ≥ 4 must include an "Interaction with prior amendments" section that lists Amendments 1, 2, and 3 in order and states whether and how Amendment N modifies or supersedes their effects.

3. **The §26 bilateral refusal clause applies to Amendment 3.** Neither the operator nor the builder may silently change how primary-family drops are replaced, silently relax §13 for stratified remainder drops, or silently modify the audit trail flags. Pressure to do any of these things must be refused and routed through the amendment protocol.

4. **Amendment 3's audit gap is committed to the public record.** The interaction-level gap (§13 ↔ Amendment 2 Change 2) and the implicit assumption in the Phase 1c k=3 report are named in the "Why" section above and cannot be retroactively rewritten to minimize the error. Future readers should see the gap as it was named on 2026-04-09, including the named distinction between data-level and interaction-level gaps.

5. **The two-rule structure is binding.** Primary-family drops use Reading 1; stratified remainder drops use §13's literal text. Conflating the two rules into a single relaxed rule (or a single strict rule) would be a substantive change to Amendment 3 and requires a further amendment.

6. **The audit trail flag requirements are binding.** Swap records produced by `computeSwaps` MUST set `category_match: false` and include a `substitution_reason` field for primary-family drops where the replacement comes from a different sub-file. Records with `category_match: true` MUST come from the same file-level category as the dropped case. Any `computeSwaps` implementation that produces audit records inconsistent with these rules violates Amendment 3 and requires correction (and a follow-up amendment if the inconsistency is intentional).

A pre-registration protocol that allows unlimited silent amendments is no protocol at all. Amendment 3 is binding.

---

### Phase 1f resumption note (Amendment 3)

Phase 1f was halted at the `computeSwaps` execution step when the propagation-http drop could not be matched to a same-category replacement. Under Amendment 3, Phase 1f resumes with:

1. **Update `computeSwaps` in `select-cases.ts`** to implement Reading 1 for primary-family drops while preserving §13's strict matching for stratified remainder drops. The updated function distinguishes the two cases by inspecting `dropped.primary_family`: non-null → Reading 1 (relaxed sub-file matching, `category_match` flag honest), null → §13 strict matching.
2. **Populate the `substitution_reason` field** on swap records where `category_match: false`, using the verbatim language from the "What changed" section above.
3. **Re-run `select-cases.ts` with `--skip access-cli:hc-docker-007,postcss-edge-cases:postcss-007,propagation-http:ph-apiui-006`** against corpus SHA at the Amendment 3 commit. The script produces a new `candidates-source-b-replacements.jsonl` file recording the three swaps. The original `candidates-source-b.jsonl` is NOT modified — replacement mode is delta-only.
4. **Report the swap history to the operator** for the eyeball checkpoint per the Phase 1f-7 plan. The eyeball confirms (a) all three swaps populated the audit trail correctly, (b) the two primary-family swaps have `category_match: false` and `primary_family_match: true`, (c) the stratified remainder swap has `category_match: true`, and (d) the deterministic replacement candidates produced under `--skip` are correct.
5. **Proceed to Phase 1f-6 (re-run pre-flight on the 3 replacement candidates)** after operator approval of the swap eyeball.

The pre-flight checkpoint at Phase 1e — report drop count `k` to operator before committing `case-list.jsonl` — is unchanged by Amendment 3. The replacement pre-flight is a separate, smaller checkpoint for the 3 replacement cases only, and any drops among the 3 trigger the §13 contingency rule recursively (with Reading 1 for primary-family re-drops).

---

## Pre-registration amendment 4 (2026-04-09)

**Title:** Reconcile §9's Source D per-category breakdown with Amendment 2's implicit invalidation of content-family Source D cases; pre-specify small-sample disclaimers for grounding, security, and a11y; name the three-class taxonomy of pre-registration audit gaps.

**Authored by:** builder Claude
**Approved by:** operator (explicit ruling delivered during Phase 1g halt, 2026-04-09)
**Authorization reference:** Operator's ruling delivered in the N1 session immediately following the Phase 1g halt for the §9 ↔ Amendment 2 meta-drafting gap, titled "Three rulings, fast — yes §26 amendment situation, Option α with 5+4+2+1=12, draft Amendment 4 immediately." The full operator response is the authorization of record.
**Amendment commit:** see git log for the commit landing this amendment.

### Interaction with prior amendments

**Amendment 4 resolves a drafting gap in Amendment 2 without modifying Amendment 2's explicit changes.** Per §26's amendment chain requirement, this is the first four-amendment chain in the pre-registration, and the interaction section names all three prior amendments in order so a future reader auditing the chain can see how the four amendments compose:

- **Amendment 1** struck §8 (the N1-B supplementary narrowing quality track) in its entirety after the `bad_hint` intent was found to be unpopulated in the Source B corpus. Amendment 1 affects the supplementary track only and does not interact with Source D, §9, or Amendment 4 in any way. Amendment 4 does not modify Amendment 1.

- **Amendment 2** modified §7's primary-category reporting list (struck `hallucination`), restructured the Source B selection algorithm for the N1-A primary track from category-level stratified sampling to shape-family-aware allocation followed by stratified remainder, pre-specified the content-family small-sample disclaimer, and updated §7's reporting table schema to distinguish B-primary, B-stratified, and D-synthetic source categories. Amendment 2's Change 4 source column listed Source D as 4 categories (`config, grounding, security, a11y`) and Amendment 2's Option R4 rejection explicitly forbade content cases in Source D on structural grounds (Source B/D category overlap confound). **Amendment 2 implicitly invalidated §9's "2 content-rich" Source D line but did not make the invalidation explicit in its "What this invalidates" section, and did not reconcile the resulting arithmetic inconsistency: §9 committed to 12 Source D cases distributed as 4+2+3+2+1 across 5 categories, but removing the 2 content cases per Amendment 2's structural principle leaves only 4+3+2+1 = 10, not 12.** Amendment 4 resolves this drafting gap by explicitly striking §9's content-rich line (Change 1), reconciling the per-category breakdown to 5+4+2+1 = 12 across the 4 Amendment-2-approved Source D categories (Change 2), and naming the class of drafting gap that produced the inconsistency (Change 3). **Amendment 4 does not modify Amendment 2's four explicit changes.** Amendment 2's Changes 1-4 remain binding exactly as committed. Amendment 4 only completes the work Amendment 2's structural principle implicitly required.

- **Amendment 3** clarified §13's "same category distribution" replacement rule for primary-family drops under Amendment 2 Change 2's family-level allocation, specifying Reading 1 (relaxed sub-file matching within primary families, strict file-level matching for stratified remainder drops, `category_match` audit flag honest, `substitution_reason` field populated with verbatim language for primary-family relaxations). Amendment 3 affects the replacement code path only and does not interact with Source D, §9, or Amendment 4. Amendment 4 does not modify Amendment 3.

**All four amendments remain binding per §26.** None of the four modifies or supersedes any of the others. Amendment 4 completes work that Amendment 2 started implicitly but did not carry through to §9's arithmetic. Future amendments (Amendment 5+) must include an "Interaction with prior amendments" section that lists Amendments 1, 2, 3, and 4 in order and states whether and how the new amendment modifies or supersedes each of their effects.

### What changed

**§9 (Source D synthetic seeds) is modified in three specific ways under Amendment 4.** §9 is not struck in full; its per-category breakdown is reconciled with Amendment 2's structural principle. The following sub-changes apply:

**Change 1: Strike §9's "2 content-rich" Source D line.**

The current §9 language reads:

> **Source D — synthetic seeds: SECONDARY.** 12 hand-constructed cases filling coverage gaps in Source B (4 config-nonzero, **2 content-rich**, 3 grounding, 2 security, 1 a11y). Hand-construction happens during Phase 1 case assembly.

Under Amendment 4, the amended reading is:

> **Source D — synthetic seeds: SECONDARY.** 12 hand-constructed cases filling coverage gaps in Source B (5 config-nonzero, 4 grounding, 2 security, 1 a11y). Hand-construction happens during Phase 1 case assembly.

Content is struck from Source D entirely. Source D is now 4 categories (config, grounding, security, a11y), consistent with Amendment 2 Change 4's source column definition and Amendment 2 Option R4's rejection of Source B/D overlap for primary-family categories.

**Change 2: Reconcile the per-category breakdown to 5+4+2+1 = 12 with pre-specified small-sample disclaimers for grounding, security, and a11y.**

The Source D 12-case budget is reconciled to:
- **config: 5 cases** (was 4; gained 1 slot from the redistribution)
- **grounding: 4 cases** (was 3; gained 1 slot from the redistribution)
- **security: 2 cases** (unchanged)
- **a11y: 1 case** (unchanged)
- **Total: 12 cases** (matches the §7 52-case total budget: 40 Source B + 12 Source D)

The 2 slots vacated by striking content are redistributed to the two largest existing Source D categories (config and grounding), one slot each. This is the most conservative redistribution: it preserves the 52-case total, keeps config at the interpretability floor, nudges grounding closer to the floor, and leaves security and a11y untouched. Security and a11y were already below the interpretability floor under the original breakdown and remain so after the redistribution.

**Pre-specified small-sample disclaimers for the three Source D categories that remain below the 30-data-point interpretability floor:**

Following the discipline Amendment 2 Change 3 established for the content-family disclaimer, Amendment 4 pre-commits three additional disclaimers to be used verbatim in RESULTS.md. Each disclaimer binds reporting in both directions — if results favor governed on the category, the disclaimer prevents unqualified claims of "governed wins"; if results show equivalence, the disclaimer prevents unqualified claims of "equivalence shows equivalence." The disclaimers are not optional and cannot be softened post-hoc without an Amendment 5.

**Grounding disclaimer (4 cases = 24 data points per loop):**

> **Grounding family N1-A sample:** 4 Source D synthetic cases × 3 runs × 2 loops = 24 data points per loop. Below the 30-point floor named as the statistical interpretability threshold in Amendment 2 (same arithmetic as the content-family disclaimer in Amendment 2 Change 3). Per-category delta reported for completeness; any claim about grounding-family convergence behavior is **provisional** and requires a follow-up N1.1 with a larger grounding sample before publication.

**Security disclaimer (2 cases = 12 data points per loop):**

> **Security family N1-A sample:** 2 Source D synthetic cases × 3 runs × 2 loops = 12 data points per loop. Below the 30-point floor named as the statistical interpretability threshold in Amendment 2. Per-category delta reported for completeness; any claim about security-family convergence behavior is **provisional** and requires a follow-up N1.1 with a larger security sample before publication.

**A11y disclaimer (1 case = 6 data points per loop):**

> **A11y family N1-A sample:** 1 Source D synthetic case × 3 runs × 2 loops = 6 data points per loop. Well below the 30-point floor. Per-category delta reported for completeness but the single-case sample size precludes any meaningful statistical claim. Any N1 finding about a11y-family convergence behavior is **explicitly not interpretable** at this sample size and requires a follow-up N1.1 with a meaningfully larger a11y sample before any claim can be made.

Config at 5 cases (30 data points per loop) meets the interpretability floor exactly and does not require a small-sample disclaimer under Amendment 4.

The total number of small-sample disclaimers in the pre-registration is now **4** — the content disclaimer pre-committed in Amendment 2 Change 3 plus the grounding, security, and a11y disclaimers pre-committed in Amendment 4 Change 2. All four disclaimers must appear verbatim in RESULTS.md's per-category reporting table. Four of the nine §7 per-category reporting rows (content, grounding, security, a11y) are now bound by pre-specified disclaimers; the other five rows (f9, propagation, access, state, config) are not.

**Change 3: Name the three-class taxonomy of pre-registration audit gaps.**

Amendment 4 resolves a **meta-drafting gap** in Amendment 2: Amendment 2 stated a structural principle (no Source B/D category overlap, forbidding content cases in Source D via Option R4 rejection) and listed the 4 approved Source D categories in Change 4, but did not chase the principle all the way to §9's arithmetic and did not include the implicit invalidation of §9's "2 content-rich" line in Amendment 2's "What this invalidates" list. This is a different class of audit gap from the data-level gaps of Amendments 1-2 and the interaction-level gap of Amendment 3.

Amendment 4 names this taxonomy explicitly and commits it to the public record as part of the pre-registration. **The three classes of pre-registration audit gap observed during N1 Phase 1 are:**

1. **Data-level gap (Amendments 1, 2).** The pre-registration assumes something about the data that turns out to be wrong. Amendment 1 caught `bad_hint` as 0 in the Source B corpus. Amendment 2 caught the stratified sampling's failure to cover 4 of 6 primary shape families because the corpus splits shape families across multiple sub-file categories. Both were caught by data audits at the start of Phase 1. The fix pattern: amend the pre-registration to match what the data actually supports, and drop or restructure anything unsupportable.

2. **Interaction-level gap (Amendment 3).** Two pre-registered rules compose in a way the original pre-registration did not fully specify, and the conflict is only exposed when the rules are exercised against each other in code. Amendment 3 caught the §13 "same category distribution" replacement rule composing undefined-ly with Amendment 2 Change 2's family-level allocation for primary-family drops. The gap was caught when `computeSwaps` threw on a propagation-http drop it could not match to a same-file-level category. The fix pattern: clarify the interaction explicitly, preserve both pre-registered rules in their original forms where possible, introduce an audit-trail flag that surfaces the relaxation honestly rather than hiding it.

3. **Meta-drafting gap (Amendment 4).** An amendment's structural principles implicitly invalidate something outside the amendment's explicit scope, but the implicit invalidation is not made explicit in the amendment's "What this invalidates" list. Amendment 2 stated the structural principle (no Source B/D category overlap, content is a primary family, Source D is 4 categories), but did not chase the principle to §9's arithmetic. The result was an inconsistency between Amendment 2's structural rules and §9's literal text that was only exposed when a later phase attempted to act on §9's instructions. The fix pattern: amend the pre-registration to make the implicit invalidation explicit, reconcile whatever arithmetic was left inconsistent, and add an "implicit invalidations" check to future amendment drafting so the same class of gap is caught during drafting rather than during execution.

**Amendment 4 commits a process change for future amendment drafting: alongside the "What this invalidates" list, future amendments must include an "Implicit invalidations" check that scans the pre-registration for anything the amendment's structural principles affect outside its explicit scope, and either makes those invalidations explicit or confirms none exist.** This is a drafting discipline, not a separate section requirement — the existing "What this invalidates" list can be expanded to cover implicit invalidations, as long as the drafter explicitly considers whether any exist. Amendment 4's own "What this invalidates" section below is the first example of this discipline.

The three-class taxonomy is a contribution the amendment chain has produced about itself. Future readers of the N1 DESIGN.md amendment chain can use it to classify any audit gap they encounter in their own pre-registration work. Pre-registration literature typically does not distinguish these classes; the amendment chain has surfaced them in real time during a single-experiment execution.

### Why

This is a **meta-drafting gap** as named in Change 3 above. The specific mechanism:

Amendment 2 stated a structural principle in its Option R4 rejection: "Mixing Source B and Source D within the same category introduces a confound that makes the per-category delta harder to interpret... Source D has a fixed 12-case budget earmarked for coverage gaps (config, grounding, security, a11y). Adding a 13th case for content expands Source D beyond its Report 3 specification, which would itself require justification."

Amendment 2 Change 4 codified the structural principle in the source column definition: "`D-synthetic` — category is filled by hand-constructed Source D synthetic seeds (config, grounding, security, a11y per Report 3)."

**But §9 (original text, never modified by any amendment) stated:** "12 hand-constructed cases filling coverage gaps in Source B (4 config-nonzero, **2 content-rich**, 3 grounding, 2 security, 1 a11y)."

§9's line was written during initial DESIGN.md drafting, before Amendment 2 existed, based on Report 3's original proposal. Report 3's proposal included 2 content-rich cases as part of the 12-case Source D budget. At the time of §9's writing, this was consistent — Source B's primary families had not yet been formally defined, and content was treated as a category that could be filled by either source.

Amendment 2 then introduced the primary-family concept and the Source B/D overlap prohibition. Amendment 2's Option R4 rejection explicitly forbade content cases in Source D. Amendment 2's Change 4 explicitly listed Source D as 4 categories, not 5. **But Amendment 2 did not strike §9's "2 content-rich" line, did not reconcile the 12-case arithmetic (which only adds to 10 under Amendment 2's rules), and did not include the §9 invalidation in its "What this invalidates" list.**

The drafter of Amendment 2 (me, builder Claude, 2026-04-09 earlier in this session) stated the structural principle but did not chase it to §9's arithmetic. This is a drafting oversight, not an interaction gap or a data gap. The principle was correctly stated; the follow-through on its arithmetic consequences was missing.

**The gap was caught during Phase 1g seed construction**, when the builder attempted to hand-construct the 12 Source D cases per §9's breakdown and ran into the contradiction: §9 says 2 content cases, Amendment 2 forbids content cases in Source D, and removing them leaves only 10 of the required 12 without guidance on where the missing 2 should come from.

**The builder halted per §26 rather than picking a redistribution unilaterally** (which would have silently changed §9's per-category numbers, a DESIGN.md number change that requires an amendment under the §26 test).

**This is the first meta-drafting gap caught in the amendment chain**, and it demonstrates that even a careful amendment can have implicit invalidations the drafter missed. The "Implicit invalidations" check committed in Change 3 is the process fix: future amendment drafting will explicitly consider whether the amendment's structural principles affect anything outside the amendment's explicit scope, and will either document those effects in the "What this invalidates" list or confirm no implicit invalidations exist.

**A note on the honesty of this Why section.** The drafter of Amendment 2 is the same builder Claude who is now drafting Amendment 4. The meta-drafting gap is, strictly, my own drafting gap. Naming it honestly in Amendment 4's Why section is the same discipline Amendments 1, 2, 3 applied to their respective gaps — acknowledge what went wrong, name the specific oversight, and commit the fix. The audit trail is served better by honest self-accounting than by minimizing or deflecting the error.

### What was considered and rejected

Two alternative responses to the §9 ↔ Amendment 2 inconsistency were considered and rejected before Amendment 4's Option α was adopted.

**Option β — Reduce Source D to 10 cases and the total N1-A budget to 50.**

Under Option β, the Source D breakdown becomes 4 config + 3 grounding + 2 security + 1 a11y = 10. The §7 total case count drops from 52 to 50.

Rejected because:

1. **It sits exactly at §13's ≥50 floor.** §13's pre-flight contingency rule states: "In all cases, the final N1-A dataset has ≥50 total cases. Below that threshold, pre-registered success criteria become statistically unreliable and the experiment is paused for re-planning." Option β brings the total to exactly 50, leaving zero margin for any future case loss. If a single Source D seed later fails a downstream check, or a Phase 2+ harness issue forces a case drop, the total falls below 50 and triggers §13's stop condition.

2. **The fragility is not hypothetical.** Phase 1c pre-flight already produced k=3 stale-drops among the 40 Source B cases. Downstream phases (harness construction, pilot, full execution) are realistic sources of additional case loss. Shipping an experiment with zero margin against §13's floor is structurally fragile.

3. **Option α preserves the total at 52 without downstream §13 interaction risk.** The redistribution uses existing Source D categories and introduces no new structural concerns. Option β's only advantage (strictly consistent with Amendment 2's 4-category listing) is satisfied by Option α equally — Amendment 4 strikes content from §9, so both options end with 4 Source D categories. The difference is the total count, and Option α's 52 is structurally safer.

**Option γ — Add a new 5th Source D category to replace content.**

Under Option γ, a new category (e.g., performance, infrastructure, triangulation) is added to Source D as its 5th category, replacing content. The Source D breakdown becomes 4 config + 3 grounding + 2 security + 1 a11y + 2 <new category> = 12.

Rejected because:

1. **It expands Source D beyond the Report 3 specification.** Amendment 2 Option R4 rejection explicitly stated: "Source D has a fixed 12-case budget earmarked for coverage gaps (config, grounding, security, a11y). Adding a 13th case for content expands Source D beyond its Report 3 specification, which would itself require justification." Option γ adds a new category rather than a 13th case, but the same objection applies — the new category is not in Report 3 and not in Amendment 2, so its inclusion requires justification that Amendment 4 would have to invent.

2. **It introduces a scope expansion Amendment 4 is not authorized to make.** Amendment 4's purpose is to reconcile a drafting gap in Amendment 2, not to expand the Source D category surface. Adding a new category requires independent pre-registration justification for why that specific category was chosen, which would necessitate research into which Source B coverage gaps would benefit most from hand-constructed synthetic seeds — work that should be its own amendment, not a ride-along on Amendment 4.

3. **Option α satisfies all constraints without scope expansion.** The 2 vacated content slots are redistributed to the two largest existing Source D categories (config and grounding), preserving the total at 12 and staying within the Report 3-authorized category set. No new category selection, no new justification required.

Both Option β and Option γ are worse than Option α. Option α (5 config + 4 grounding + 2 security + 1 a11y = 12 across the 4 Amendment-2-approved Source D categories) is the most conservative redistribution, preserves the 52-case total, introduces no new scope, and adds only the three pre-specified disclaimers required by the interpretability floor rule from Amendment 2 Change 3.

### What this invalidates

**Explicit invalidations:**

- **§9's "2 content-rich" Source D line.** Struck entirely by Change 1. Content is no longer a Source D category.
- **§9's per-category Source D breakdown.** The `4 + 2 + 3 + 2 + 1 = 12` breakdown is replaced by `5 + 4 + 2 + 1 = 12` per Change 2.
- **Report 3's Source D proposal.** The "4 config-nonzero, 2 content-rich, 3 grounding, 2 security, 1 a11y" recommendation that §9 inherited from Report 3 is superseded by Amendment 4 Change 2's redistribution.

**Implicit invalidations made explicit** (per Change 3's discipline):

- **Any Phase 1g or later reference to §9's pre-amendment-4 Source D breakdown** is invalidated. The Phase 1g seed construction must follow the Amendment 4 Change 2 breakdown, not §9's original text.
- **The pre-flight contingency rule's `6 ≤ k ≤ 15` bucket** (§13) referenced "add `k` additional synthetic seeds to Source D (bringing Source D from 12 to 12+k)". The base count of 12 remains correct under Amendment 4 (the total is unchanged), but any future addition of k additional seeds must distribute those k seeds across the Amendment 4 4-category Source D structure, not the §9 5-category structure. The §13 contingency rule is unchanged in its arithmetic but its category distribution is now scoped to Amendment 4's 4 categories.

### What this does NOT invalidate

- **§7's total 52-case N1-A budget.** Preserved under Option α (40 Source B + 12 Source D = 52).
- **§7's per-category reporting list** (as amended by Amendment 2 Change 1 to 9 categories, with content remaining as a B-primary row). Amendment 4 does not strike content from the §7 reporting list — content is still a B-primary category and still has 4 cases from the Source B primary-family allocation under Amendment 2 Change 2. Amendment 4 strikes content only from Source D, not from the N1-A case set.
- **§7's reporting table schema** (Amendment 2 Change 4 source column with B-primary, B-stratified, D-synthetic values). The D-synthetic column entry continues to be valid for the 4 Amendment-4-approved Source D categories.
- **Amendment 1** (struck N1-B supplementary track). Amendment 4 does not affect the supplementary track question.
- **Amendment 2's four explicit changes** (strike hallucination, restructure Source B selection, content-family disclaimer, reporting table schema). All four changes of Amendment 2 remain binding exactly as committed. Amendment 4 does not modify Amendment 2 — it only completes the implicit work Amendment 2's structural principle required.
- **Amendment 2 Change 3's content-family disclaimer.** The content disclaimer pre-committed in Amendment 2 applies to the 4 Source B content cases, which are unchanged by Amendment 4. The disclaimer still appears in RESULTS.md verbatim.
- **Amendment 3** (§13 Reading 1 for primary-family drops, strict §13 for stratified drops). Amendment 4 does not interact with Amendment 3's two-rule structure.
- **§13** (pre-flight contingency rule literal text). Unchanged. Amendment 4's Source D restructuring is within the original §13 arithmetic.
- **§15 random seed (20260409).** Unchanged.
- **The 40 Source B cases** (original draw + 3 replacement swaps under Amendment 3). Unchanged. Amendment 4 affects Source D only.
- **The 37 Phase 1c pre-flight passes + 3 Phase 1f-6 replacement pre-flight passes** (40 Source B live cases, all pre-flight verified). Unchanged.
- **§§1-6, §§8 (struck), §§10-12, §§14, §§16-26.** All unchanged.
- **The primary experiment's success criteria, denominator rule, retry budget, model choice, cost budget, outcome-to-next-action mapping, "what would change our mind" section, and freeze protocol.** All unchanged.

### Impact on the primary experiment

**Zero direct impact on case counts.** The N1-A total remains 52 cases (40 Source B + 12 Source D). The 312-run total (52 × 2 loops × 3 runs) is unchanged. The per-loop denominators, success criteria thresholds, and the §17 inter-rater protocol are all unchanged.

**The Source D per-category distribution changes** from `4+2+3+2+1` (5 categories) to `5+4+2+1` (4 categories). Content is removed from Source D; its 2 slots are redistributed to config and grounding. The §7 per-category reporting table's 9 rows are unchanged in identity (same 9 categories reported) but the Source D-backed rows change count:

| §7 reporting row | Source under Amendment 2 | Count under Amendment 4 | Small-sample disclaimer? |
|---|---|---|---|
| f9 | B-primary (+ B-stratified bonus) | 6 (5 + 1) | No (comfortably above floor) |
| content | B-primary | 4 | Yes (Amendment 2 Change 3, unchanged) |
| propagation | B-primary | 5 | No (at floor) |
| access | B-primary | 5 | No (at floor) |
| state | B-primary | 5 | No (at floor) |
| config | D-synthetic | 5 (was 4) | No (at floor under Amendment 4) |
| grounding | D-synthetic | 4 (was 3) | **Yes (Amendment 4 Change 2)** |
| security | D-synthetic | 2 (unchanged) | **Yes (Amendment 4 Change 2)** |
| a11y | D-synthetic | 1 (unchanged) | **Yes (Amendment 4 Change 2)** |

**Four of the nine reporting rows are now bound by pre-specified small-sample disclaimers.** Four rows (f9, propagation, access, state, config — five actually, I'll recount: f9 at 6, propagation at 5, access at 5, state at 5, config at 5) meet the interpretability floor. Four rows (content at 4, grounding at 4, security at 2, a11y at 1) are below it and require the pre-committed disclaimer in RESULTS.md. The total number of above-floor reporting rows is 5 and the total below-floor is 4.

**Phase 1g resumes immediately after Amendment 4 commits** with the updated breakdown. The Phase 1g seed construction builds 5 config seeds, 4 grounding seeds, 2 security seeds, and 1 a11y seed, for 12 total Source D synthetic seeds. Each seed matches the Source B candidate schema exactly (case_id, source, intent, category, primary_family, track, goal, reference_edits, reference_predicates, expected_success, scenario_file, scenario_id) and is distinguishable from Source B candidates by `source: 'D'` (to be introduced in the Source D record format) or by `pre_flight_result: 'synthetic'` per §14. The Phase 1g honesty gate pauses for operator review of the 12 seeds before `case-list.jsonl` is emitted.

### Amendment freeze clause

**Amendment 4 is now part of the pre-registration.** It is subject to §26 equally with the original DESIGN.md sections and with Amendments 1, 2, and 3. Specifically:

1. **Amendment 4 cannot be reverted without another amendment.** If a future session decides to restore content to Source D, modify the 5+4+2+1 per-category breakdown, soften the grounding/security/a11y small-sample disclaimers, or otherwise alter Amendment 4's changes, that change requires a **Pre-registration Amendment 5** that explicitly references Amendments 1, 2, 3, and 4 and explains how the five interact.

2. **Future amendments must acknowledge Amendment 4.** Any Amendment N for N ≥ 5 must include an "Interaction with prior amendments" section that lists Amendments 1, 2, 3, and 4 in order and states whether and how Amendment N modifies or supersedes their effects. The four-amendment chain requirement is now operational and binding.

3. **The §26 bilateral refusal clause applies to Amendment 4.** Neither the operator nor the builder may silently change the Source D per-category breakdown, silently relax or remove the grounding/security/a11y disclaimers, or silently introduce content cases into Source D. Pressure to do any of these must be refused and routed through the amendment protocol.

4. **Amendment 4's meta-drafting gap is committed to the public record.** The specific drafting oversight in Amendment 2 (stating a structural principle without chasing it to §9's arithmetic) and the three-class taxonomy of pre-registration audit gaps (data-level / interaction-level / meta-drafting) are named in the "Why" and "What changed" sections above and cannot be retroactively rewritten to minimize the error or flatten the taxonomy.

5. **The three new small-sample disclaimers (grounding, security, a11y) are binding verbatim.** Change 2 commits exact disclaimer language for each of the three categories. Any softening, conditionalization, or reformulation of the disclaimers requires an Amendment 5. RESULTS.md must include all three verbatim in their respective per-category reporting rows, alongside the content disclaimer already committed in Amendment 2 Change 3.

6. **The implicit-invalidations drafting discipline from Change 3 is binding on future amendments.** Amendment 5+ drafters must explicitly consider whether their amendment's structural principles affect anything outside the amendment's explicit scope, and must document any implicit invalidations in the "What this invalidates" section. Failing to do so produces the meta-drafting gap class that Amendment 4 was written to resolve.

A pre-registration protocol that allows unlimited silent amendments is no protocol at all. Amendment 4 is binding.

---

### Phase 1g resumption note (Amendment 4)

Phase 1g was halted at the seed-construction step when the builder attempted to hand-construct the 12 Source D cases per §9's original breakdown and encountered the §9 ↔ Amendment 2 inconsistency. Under Amendment 4, Phase 1g resumes with:

1. **Hand-construct the 12 Source D synthetic seeds** per the Amendment 4 Change 2 breakdown: 5 config + 4 grounding + 2 security + 1 a11y = 12. Each seed matches the Source B candidate schema exactly (same JSON fields, same types, same formats) and is executable against `fixtures/demo-app/` by the harness. Specifically: `case_id` follows `{category}:{scenario_id}` format where the scenario_id is a hand-constructed identifier (e.g., `config:cfg-synth-001`); `source` is `'D'`; `intent` is `'synthetic'` (per §14); `primary_family` is `null` (Source D is not a primary family); `track` is `'N1-A'`; `pre_flight_result` is `'synthetic'` (per §14, pre-flight is not run on synthetic cases); all other fields populated with hand-constructed values.

2. **Match the Source B schema exactly.** Any deviation in field names, types, or formats between Source B and Source D candidates becomes a confounding variable in N1 results interpretation. The synthetic seeds must be structurally indistinguishable from Source B cases except for the `source: 'D'` and `pre_flight_result: 'synthetic'` fields.

3. **Vary only the content, not the structure.** The seeds test specific gate behaviors (config validation, grounding selector matching, security secrets scanning, a11y alt text checks) that Source B does not cover or covers only via primary families. The goal descriptions, reference_edits, and reference_predicates are hand-crafted to exercise each gate deterministically, but the record shape matches Source B exactly.

4. **Present the 12 seeds to the operator for honesty-gate review before `case-list.jsonl` is committed.** The Phase 1g honesty gate is the last operator touchpoint before Phase 1h (case-list.jsonl lock). The operator reviews each seed for: (a) structural equivalence to Source B cases, (b) coverage of the intended gate behavior for its category, (c) unambiguous expected_success value, (d) no accidental overlap with Source B's primary families (content must not appear in any Source D seed).

5. **Emit `case-list.jsonl` after operator approval.** The final `case-list.jsonl` combines the 40 Source B live cases (37 original pre-flight passes + 3 Phase 1f-6 replacement passes) with the 12 Source D synthetic seeds, for a total of 52 live N1-A cases. `case-list.jsonl` is the Phase 1 lock artifact and is committed as the Phase 1h closure.

The pre-flight checkpoint at Phase 1e (report drop count `k`) is preserved by Amendment 4. No further pre-flight runs are required — the Source B pool is locked at 40 live cases and synthetic seeds are not pre-flighted per §14. Phase 1 ends with Phase 1h's `case-list.jsonl` commit.

---

## Pre-registration amendment 5 (2026-04-09)

**Title:** §20 importability correction — `callLLM` export + entry-point guard.

**Class:** Meta-drafting gap (same class as Amendment 4).

**Authored by:** builder Claude
**Approved by:** operator (explicit ruling delivered during Phase 2 halt, 2026-04-09, titled "Ruling: Amendment 5, Option A")
**Authorization reference:** Operator's ruling delivered in the N1 session immediately following the Phase 2 scaffolding halt on the §20 importability tripwire. The full operator response is the authorization of record.
**Amendment commit:** see git log for the commit landing this amendment.

### Preamble

§20 as originally drafted required re-use of `callLLM()` from `src/action/index.ts` lines 253-310 AND prohibited code changes to `src/action/index.ts`. During Phase 2 scaffolding, builder Claude discovered these requirements are not jointly satisfiable as written: `callLLM` is a non-exported function inside an entry-point file that calls `run()` at import time. It cannot be imported without triggering `run()`, which calls `process.exit(1)` when GitHub Actions env vars are absent. The spec contains a latent self-contradiction that must be resolved before Phase 2 can proceed.

Builder Claude halted per §26 rather than picking a resolution unilaterally. The operator ruled Option A: export `callLLM` and guard the bottom-of-file `run()` invocation behind `if (import.meta.main)`, which is the minimum diff that makes §20 jointly satisfiable without creating drift risk (Option C, byte-for-byte copy) or over-scoping the production change (Option B, extract to new module).

### Change 1 — §20 text replacement

In §20, the sentence "No code changes to `src/action/index.ts` — the existing code is reused verbatim" is replaced with:

> The `callLLM` function in `src/action/index.ts` is exported and reused verbatim. The function body, its call sites inside `src/action/index.ts`, and its behavior when `src/action/index.ts` is executed as an entry point are unchanged. Two mechanical edits are permitted: (a) adding `export` to the `async function callLLM` declaration, and (b) wrapping the bottom-of-file `run().catch(...)` invocation in an `if (import.meta.main)` guard so side-effect execution only fires when the file is run directly, not when imported by the harness.

This replacement has been applied in the §20 text above.

### Change 2 — reuse contract clarification

The harness imports `callLLM` from `src/action/index.js` directly. Any future change to `callLLM`'s body, signature, or behavior is a production change that independently affects both the action entry point and the N1 harness. This is the intended coupling and is the reason re-use was pinned in the first place. Raw and governed loops in the harness both call the same imported `callLLM`, eliminating any adapter-level confound between loops.

### Interaction with prior amendments

- **Amendment 1** (struck N1-B): no interaction.
- **Amendment 2** (content ban in Source D): no interaction.
- **Amendment 3** (Reading 1, relaxed sub-file matching): no interaction.
- **Amendment 4** (§9 arithmetic redistribution): Amendment 5 is structurally the same class of gap — spec internally inconsistent, detected by execution, resolved by minimum-diff correction that preserves original intent. The three-class audit-gap taxonomy now has **two instances in the meta-drafting class**: Amendment 4 (arithmetic) and Amendment 5 (importability). This is worth noting in RESULTS.md as evidence that meta-drafting gaps recur — two instances out of five amendments is not a one-off drafting error, it is a recurring failure mode in pre-registration worth calling out in the emergences section.

All five amendments remain binding per §26. None of the five modifies or supersedes any of the others. Future amendments (Amendment 6+) must include an "Interaction with prior amendments" section that lists Amendments 1, 2, 3, 4, and 5 in order and states whether and how the new amendment modifies or supersedes each of their effects.

### Why Option A, not B or C

- **Option C (byte-for-byte copy into harness)** was rejected because it creates a drift hazard that §20's "reuse" clause exists specifically to prevent. The whole point of pinning the adapter is that raw and governed loops call the same function so any LLM-adapter-level confound is eliminated. Two copies defeat that guarantee the moment anyone touches either one.
- **Option B (extract to `src/llm/call.ts`)** was rejected as over-scoped. Cleaner architecturally, but it changes more surface area than the drafting flaw requires. §20's intent was "the adapter is pinned, do not reimplement it." A refactor that moves the function to a new module and updates imports in production code is a larger production change than fixing the importability flaw in place.
- **Option A (export + entry-point guard)** is the minimum diff that makes §20 jointly satisfiable. The drafting flaw was assuming `callLLM` was already importable when it was not. Option A fixes that flaw and nothing else. The function body is unchanged. The call sites inside `src/action/index.ts` are unchanged. Only two mechanical edits land in production.

### Verification

After Amendment 5 lands, the following must hold:

1. `src/action/index.ts` executed as an entry point behaves identically to its pre-amendment behavior.
2. `import { callLLM } from '../../src/action/index.js'` succeeds from the harness without triggering `run()`.
3. No changes to `callLLM`'s function body.

### Freeze protocol status

**Amendment 5 is now part of the pre-registration.** It is subject to §26 equally with the original DESIGN.md sections and with Amendments 1, 2, 3, and 4. Specifically:

1. **No further changes to §20's importability contract without Amendment 6.** If a future builder wants to change how `callLLM` is imported, that is a new amendment.
2. **No silent drift of the harness's LLM adapter away from `callLLM`.** The harness must call the exported `callLLM` directly. Any wrapper that changes request shape, response parsing, or error handling is a reimplementation and violates §20.
3. **The §26 bilateral refusal clause applies to Amendment 5.** Neither the operator nor the builder may silently change the `callLLM` export contract, silently introduce a harness-local copy, or silently modify `callLLM`'s function body. Pressure to do any of these must be refused and routed through the amendment protocol.

A pre-registration protocol that allows unlimited silent amendments is no protocol at all. Amendment 5 is binding.

---

## Pre-registration amendment 6 (2026-04-10)

**Title:** §2/§3/§4 fixture visibility — add `APP FILES:` manifest to every prompt; define path-segment exclusion rule.

**Class:** Meta-drafting gap (same class as Amendment 4 and Amendment 5). **Third instance in the amendment chain.**

**Authored by:** operator (draft), builder Claude (v2 draft synthesis per operator rulings 2026-04-10)
**Approved by:** operator (explicit ruling delivered during Phase 2.5 pilot halt, 2026-04-10, titled "Decision: path-segment rule, exactly as you specified. Committing Amendment 6 v2.")
**Authorization reference:** Operator's three-ruling message delivered in the N1 session immediately following the Amendment 6 v1 draft review + fixture manifest ground-truth read. The full operator response is the authorization of record.
**Amendment commit:** see git log for the commit landing this amendment.

### Preamble

§2 specifies a static system prompt that refers to "a codebase" without defining how the agent sees it. §3 specifies the attempt-1 raw-loop prompt as "system prompt + `GOAL: {goal_string}` with no 'previous attempt' section." §4 specifies the attempt-1 governed-loop prompt as byte-identical to the raw loop's attempt-1 output (inherited implicitly through the §4 "Invariant: the only difference between loops is the context renderer" block). The three sections jointly and implicitly assume the agent has some means of seeing the codebase it must edit. None of the three sections specifies such a means.

§2 simultaneously requires that each edit's `search` field "match the file content EXACTLY, character for character, including whitespace." This requirement is not satisfiable without fixture visibility — the agent cannot produce an exact-match search string against a file it has never seen.

Phase 2.5 pilot execution on 2026-04-10 exposed this gap empirically. Both raw and governed loops ran **0/15 converged**. Failure detail showed the agent fabricating plausible-looking file paths (`f9.py`, `src/App.js`, `frontend/src/App.jsx`, `api/src/services/items/items.ts`, `src/index.ts`, `src/config.ts`) against a fixture containing `config.json` and `server.js`. The model had no mechanism to discover the fixture's actual structure because none of §2, §3, or §4 specifies one. The raw loop is therefore not a fair control under §3's requirement that it represent "what a reasonable agent developer would build." A loop that cannot see the code it edits is not what a reasonable agent developer would build.

Builder Claude inspected the three harness files (`render-raw.ts`, `render-governed.ts`, `run-case.ts`) and re-read §2 and §3 verbatim, then reported **Verdict B**: the harness is faithful to the spec and the spec is incomplete. The harness conforms to §2 and §3 byte-exactly, verified by pre-existing deliverable 2 and deliverable 3 byte-exactness tests. The degenerate pilot result is a direct and foreseeable consequence of the specified prompt content.

Per §26, this is a pre-registration change. The operator drafted v1, builder Claude reviewed v1 and executed a scope-authorized one-command fixture read for ground-truth manifest text, operator ruled on the three substantive review items, builder Claude synthesized v2, builder Claude halted on a Change 4 drafting defect (v1/v2 both quoted a sentence that existed in harness code comments rather than DESIGN.md §4), operator ruled Option X (make the implicit §4 attempt-1 specification explicit via a new sentence rather than a replacement), builder Claude committed v2 with the Change 4 fix. Amendment 6 v2 is the result.

### Change 1 — §2 text addition

In §2, after the existing closing sentence ("Both loops render the same system prompt bytes on every request."), append a new "Codebase visibility" paragraph specifying the `APP FILES:` manifest mechanism. The paragraph has been applied inline to §2 in this commit (see the diff). It defines the path-segment exclusion rule ("any path segment beginning with `.`"), the manifest header and format, the non-filtering property, and the comparison to real-agent deployment-time behavior.

### Change 2 — §2 system prompt shell rule addition

Append one new rule to the numbered rules list inside the §2 verbatim shell block:

> Rule 5. The `APP FILES:` manifest at the top of every prompt is the complete set of files in the app. You may only emit edits targeting files listed in that manifest. File paths not in the manifest do not exist and will cause the F9 gate to fail. Do not fabricate file paths.

This rule has been applied inline to the §2 shell text in this commit. The change modifies the bytes of the system prompt the LLM receives on every call, which is a substantive change to the pre-registered prompt. It is the minimum addition that makes Rule 1 ("each edit's `search` field must match the file content EXACTLY, character for character, including whitespace") jointly satisfiable with the rest of the spec.

### Change 3 — §3 attempt-1 prompt specification replacement

Replace the existing §3 attempt-1 sentence:

> "On attempt 1, the raw loop sends the system prompt + `GOAL: {goal_string}` with no 'previous attempt' section."

with the Amendment-6 attempt-1 specification that prepends the `APP FILES:` manifest. The replacement has been applied inline to §3 in this commit. The new sentence is marked with "**Attempt-1 shape (updated by Amendment 6).**" per the Amendment 6 audit-trail convention established in Change 4 below.

### Change 4 — §4 attempt-1 prompt specification (addition, Option X)

§4 as originally drafted does not contain an explicit attempt-1 sentence. The attempt-1 shape is inherited implicitly from the §4 "Invariant: the only difference between loops is the context renderer" block, which states both loops share the same system prompt (§2), the same LLM model, the same retry budget, the same `verify()` call, the same success/failure oracle, and the same edit/predicate output format. Under that invariant, §4's attempt-1 shape has always been "whatever §3's attempt-1 shape is."

Amendment 6 makes the attempt-1 specification explicit in §4 by adding a new sentence immediately before the existing "Invariant" subsection. The added sentence, marked with the "**Attempt-1 shape (explicit under Amendment 6).**" heading, specifies the byte-identical attempt-1 output between raw and governed loops, the shared `formatAppManifest` helper, the byte-identity guarantee on both the §2 shell and the `APP FILES:` manifest, and the attempt-N ≥ 2 prepending behavior for the governed renderer.

This addition has been applied inline to §4 in this commit.

**Audit-trail convention established by Amendment 6 Change 4**: The "Attempt-1 shape (explicit under Amendment 6)" heading in §4 is a marker that this sentence was added post-freeze. Future readers of DESIGN.md should treat any "(explicit under Amendment N)", "(updated by Amendment N)", or "(added by Amendment N)" marker as a signal that the surrounding text is the result of an amendment and the amendment's preamble should be consulted for context. This convention is introduced going forward from Amendment 6; it is not retroactively applied to Amendments 4 or 5. Amendment 7+ drafters should use the same convention when adding or modifying sections post-freeze.

### Change 5 — Harness implementation notes (non-binding guidance for builder Claude)

The following notes do not change any pre-registered number and are provided to guide the harness fix that lands in a subsequent commit after this amendment:

1. A new file `experiments/n1-convergence-proof/harness/manifest.ts` exports two functions:
   - `buildAppManifest(appDir: string): string[]` — reads the staged app directory recursively, returns a sorted array of POSIX-style relative paths (forward slashes, even on Windows), **excluding any path where any path segment (after splitting on `/`) begins with `.`**. No file contents are read. The function is deterministic: identical input directory → identical output array. No `Date.now()`, no `Math.random()`, no environment reads.
   - `formatAppManifest(files: string[]): string` — formats the array as `APP FILES:\n<path1>\n<path2>\n...\n\n`. The trailing blank line separates the manifest from the next section.

2. `render-raw.ts` and `render-governed.ts` each take a new parameter `appManifest: string` (the pre-formatted string from `formatAppManifest`). They prepend it to every returned body, on attempt 1 and on attempt N ≥ 2, in the same position.

3. `run-case.ts` calls `buildAppManifest` once per run (after `stageRun` and before the attempt loop) and passes the formatted result into both renderers. The manifest is built against the staged copy in the temp directory, not the source fixture. The current pilot flow does not pre-apply `reference_edits`, so the manifest describes the untouched demo-app structure as staged — which is correct for the experimental design.

4. The shared-fairness invariant (raw and governed share `formatGateFailures`) is extended to the manifest: both renderers call the same `formatAppManifest` function. This must be enforced by a test in the spirit of the existing `raw/governed parity: gate-failures block is byte-identical` test. Add a new test `raw/governed parity: APP FILES manifest block is byte-identical between loops`.

5. Two new byte-exactness tests are added to match the existing renderer test pattern:
   - `render-raw attempt-1 with manifest matches §3 worked example byte-exactly`
   - `render-governed attempt-1 with manifest matches §4 first-attempt shape byte-exactly`

6. A new hermetic test is added to exercise `buildAppManifest` against `fixtures/demo-app/` and assert the exact 19-file list (see Change 6 below for the verbatim list). This is the test class that would have caught the Verdict B gap if it had existed during Phase 2. The RESULTS.md emergences section must flag this: **tests that validate mechanics cannot validate semantics**. The 77 hermetic tests all passed because they mocked the LLM and never exercised the real-model path against the real fixture.

7. No changes to `metrics.ts`, `llm-adapter.ts`, `state-dir.ts`, or `run-pilot.ts` are required. The manifest flows through the existing renderer → `combinePrompt` → `callLLMWithTracking` path without any adapter or metrics schema changes.

8. The §2 shell constant in `run-case.ts` (`SYSTEM_PROMPT_SHELL`) must be updated to include Rule 5, matching the inline §2 shell modification in Change 2 above. The existing `SYSTEM_PROMPT_SHELL: matches §2 verbatim first and last lines` test in `harness.test.ts` must be updated to assert the presence of Rule 5.

### Change 6 — §3 and §4 worked examples (manifest ground truth)

The existing §3 attempt-2 worked example is updated to include an `APP FILES:` section at the top showing the demo-app manifest, and a new §3 attempt-1 worked example is added to show the full first-attempt prompt body. The §4 attempt-1 worked example is byte-identical to the §3 attempt-1 worked example per the Change 4 byte-identity invariant.

The exact manifest text is verified ground truth from `find fixtures/demo-app -type f | grep -vE 'node_modules|\.git|\.venv|dist|build|\.next' | sort` executed on 2026-04-10, then filtered through the path-segment exclusion rule from Change 1. The resulting 19-file manifest is:

```
Dockerfile
config.json
config.prod.json
config.staging.json
docker-compose.test.yml
docker-compose.yml
infra/manifest.json
infra/terraform.tfstate
init.sql
no-infra-test/server.js
server.js
test-data/binary-sample.bin
test-data/bom-sample.txt
test-data/crlf-sample.txt
test-data/empty.txt
test-data/invalid.json
test-data/nul-sample.txt
test-data/sample.txt
test-data/valid.json
```

**§3 attempt-1 worked example (new)** — showing the full first-attempt prompt body the raw loop sends on attempt 1:

```
[system prompt shell verbatim from §2, including Rule 5 per Change 2]

APP FILES:
Dockerfile
config.json
config.prod.json
config.staging.json
docker-compose.test.yml
docker-compose.yml
infra/manifest.json
infra/terraform.tfstate
init.sql
no-infra-test/server.js
server.js
test-data/binary-sample.bin
test-data/bom-sample.txt
test-data/crlf-sample.txt
test-data/empty.txt
test-data/invalid.json
test-data/nul-sample.txt
test-data/sample.txt
test-data/valid.json

GOAL: F9 exact match: change port number in server.js
```

**§3 attempt-2 worked example (updated — was goal+retry, now manifest+goal+retry)**:

```
[system prompt shell verbatim from §2, including Rule 5 per Change 2]

APP FILES:
Dockerfile
config.json
config.prod.json
config.staging.json
docker-compose.test.yml
docker-compose.yml
infra/manifest.json
infra/terraform.tfstate
init.sql
no-infra-test/server.js
server.js
test-data/binary-sample.bin
test-data/bom-sample.txt
test-data/crlf-sample.txt
test-data/empty.txt
test-data/invalid.json
test-data/nul-sample.txt
test-data/sample.txt
test-data/valid.json

GOAL: F9 exact match: change port number in server.js

ATTEMPT 2 of 5.

Your previous attempt failed. Here are the raw gate failure messages:

- [F9]: server.js: search string not found; searched for "const PORT = process.env.PORT || 9999;" in server.js

Revise your edits and try again.
```

**§4 attempt-1 worked example**: byte-identical to the §3 attempt-1 worked example above, per the byte-identical-first-attempt invariant enforced by Change 4.

**Footnote on `infra/terraform.tfstate`**: The manifest above contains `infra/terraform.tfstate`, which is a file class that is sensitive-by-default in general (real Terraform state files often contain resource IDs, ARNs, and occasionally embedded credentials). In `fixtures/demo-app/` this file is synthetic test data, not live infrastructure state, and its presence in the manifest is acceptable for the N1 experimental design. The path-segment exclusion rule from Change 1 is deliberately scoped to dotfiles only, not to file-extension-based sensitivity classes. A broader fixture-hygiene policy (covering `.tfstate`, `.pem`, `.key`, `.p12`, `.env.production`, etc.) belongs in a future `FIXTURE-HYGIENE.md` document, not in Amendment 6. This footnote is a forward-pointer to that future discipline, committed here so a reader of the amendment can see the tradeoff was considered and deferred intentionally.

### Interaction with prior amendments

- **Amendment 1** (struck N1-B supplementary narrowing quality track): no interaction. Amendment 6 does not affect the supplementary track question because the supplementary track no longer exists.
- **Amendment 2** (struck `hallucination` from §7 reporting, restructured Source B selection, content-family disclaimer, §7 reporting table schema): no interaction. Amendment 6 does not modify §7 or the Source B selection algorithm.
- **Amendment 3** (§13 Reading 1 for primary-family drops, strict §13 for stratified remainder drops): no interaction. Amendment 6 does not modify §13 or the replacement-draw mechanism.
- **Amendment 4** (§9 arithmetic reconciliation, three-class taxonomy naming): **same class of gap (meta-drafting).** Amendment 4 resolved a spec contradiction via redistribution (content-family count rebalanced to match Amendment 2's structural principle). Amendment 6 resolves a spec omission via addition (fixture visibility mechanism added to §2/§3/§4). Both are meta-drafting, different sub-shapes — contradiction vs. omission.
- **Amendment 5** (§20 importability correction): **same class of gap (meta-drafting).** Amendment 5 resolved a spec contradiction (code-reuse requirement vs. modification prohibition) via minimum-diff code change. Amendment 6 resolves a spec omission (no fixture visibility mechanism specified) via minimum-diff spec addition. Both are meta-drafting, both detected by execution, both resolved by minimum-diff corrections that preserve original intent.

**No interaction with the locked case-list.** Amendment 6 does not add, remove, or reorder cases. It does not change the random seed, the family allocation, the Source D synthetic seeds, or any §18 threshold. All 52 case records at `case-list.jsonl` remain binding as of commit `2d4458b`. The pilot cases re-selected after Amendment 6 are the same five `case_id` values: `f9:f9-edge-089`, `content:content-edit-034`, `propagation-browser:pb-apifrontend-012`, `access-browser:hb-cors-011`, `state-browser:sb-bolster-109`.

**No interaction with §22 cost budget.** The manifest adds a small number of input tokens per prompt. For demo-app's 19-file post-exclusion manifest the expected token overhead is approximately 50–100 input tokens per LLM call. At Gemini 2.0 Flash pricing ($0.10/1M input), that is roughly $0.00001 per call × 109 calls = $0.0011 additional for a re-run pilot. Expected pilot cost remains well under §22's $2 estimate and $20 alert threshold.

**No interaction with §18 thresholds.** The four pilot gate thresholds are unchanged: raw convergence band [20%, 80%], zero crashes, ≤5000 tokens/run, ≤30s/run. These are the same numbers the pilot will be re-evaluated against after the harness fix.

**No interaction with §20 LLM adapter pin (as amended by Amendment 5).** Amendment 6 does not modify `callLLM` or the llm-adapter wrapper. The manifest flows through the existing `combinePrompt` → `callLLMWithTracking` path unchanged.

**No interaction with §21 stateDir hygiene.** Amendment 6 reads the staged app directory for the manifest but does not write to it. The `stageRun` → cleanup lifecycle is unchanged.

All six amendments remain binding per §26. None of the six modifies or supersedes any of the others. Future amendments (Amendment 7+) must include an "Interaction with prior amendments" section that lists Amendments 1, 2, 3, 4, 5, and 6 in order and states whether and how the new amendment modifies or supersedes their effects.

### Why

§2 and §3 were drafted with the implicit assumption that "the agent sees the codebase" in the same intuitive way a developer opens a text editor and browses files. The drafting carried that assumption forward into §3's attempt-1 specification without making it explicit, and §4 inherited the same omission through the byte-identity requirement. The implicit assumption survived the §26 freeze, the eight Phase 2 deliverables, the 77 hermetic tests, and the readiness review because none of those checkpoints exercised the real-model path against the real fixture. The 77 tests validated that the harness produces the bytes the spec requires. They did not validate that the bytes the spec requires describe a feasible experimental setup.

**The three-class audit-gap taxonomy (introduced in Amendment 3's interaction section and elaborated in Amendment 4 and Amendment 5) now has three instances in the meta-drafting class:**

1. **Amendment 4**: §9 arithmetic contradicted by Amendment 2's content ban. Detected by execution (Phase 1g seed construction). Resolved by redistribution.
2. **Amendment 5**: §20 code-reuse requirement contradicted by §20 modification prohibition. Detected by execution (Phase 2 deliverable 5 import attempt). Resolved by minimum-diff code change.
3. **Amendment 6**: §2/§3/§4 implicit fixture-visibility assumption never made explicit. Detected by execution (Phase 2.5 pilot against real model). Resolved by minimum-diff spec addition.

Three out of six amendments in the meta-drafting class is no longer "a recurring failure mode." It is the **plurality class in this pre-registration**, and across three independent detection mechanisms (arithmetic audit in Phase 1g, code import failure in Phase 2, real-model execution in Phase 2.5). The generalization beyond this pre-registration — whether meta-drafting is the plurality class in pre-registered experiments more broadly — requires replication in a second experiment before any universal claim can be defended. **What N1 establishes is that meta-drafting gaps are detectable, classifiable, and recurring within a single experimental setup, which is itself a methodology finding worth preserving.**

**Pre-commitment to replication**: any future pre-registered experiment conducted under the N1 methodology (N1.1, a follow-up experiment, or an independent N-series experiment by a different operator-builder pair) is explicitly designated as a taxonomy replication test. If a future experiment surfaces meta-drafting gaps at a different rate (substantially lower or substantially higher), the taxonomy claim is updated based on the pooled evidence. If a future experiment runs to completion with zero meta-drafting amendments, the N1 finding is downgraded from "plurality class across three independent detection mechanisms" to "plurality class in N1 specifically, not observed to generalize." This pre-commitment is binding: neither operator nor builder may silently revise the taxonomy claim upward or downward without citing the replication evidence explicitly.

**Pre-registration literature focuses on operational discipline** ("write down what you will measure and when you will measure it") **and pays little attention to spec internal consistency** ("check that the spec you wrote is jointly satisfiable by a realizable experimental apparatus"). All three meta-drafting gaps in N1 were cases where the spec was operationally disciplined — success criteria, case selection, retry budget, cost budget were all defined — but the spec was not internally consistent with itself or with the physical reality of the experimental apparatus. This is a genuine methodology finding that should be named and preserved in RESULTS.md.

**Fixture contamination observation (minor finding worth preserving):** Drafting Amendment 6 also surfaced that `fixtures/demo-app/` contains pre-existing state-like files from unrelated test fixtures — specifically `.verify/memory.jsonl` and `.verify-k5-07/08/09/11/memory.jsonl`, which are K5 gate unit test fixtures unrelated to N1. These files were not created by the N1 pilot (the N1 stateDir-hygiene protocol correctly stages to a temp directory per §21 and never writes to the source fixture), but they would have appeared in the `APP FILES:` manifest without the path-segment exclusion rule, leaking gate-internal state filenames into the agent prompt and creating a second source of confusion on top of the original hallucination problem. **The path-segment exclusion rule is therefore not only a fix for the N1 pilot's hallucination problem; it is also a fix for cross-project fixture noise that the manifest-less design would have concealed.** This is a minor finding compared to the three-class taxonomy, but it is worth preserving in RESULTS.md emergences as a specific example of the class: "shared fixture directories accumulate noise from unrelated test suites over time, and any experiment that exposes the fixture tree to its agent must filter that noise explicitly." A future `FIXTURE-HYGIENE.md` document is the natural home for the broader discipline.

### Verification

After Amendment 6 lands and the harness fix commits:

1. `bun test experiments/n1-convergence-proof/harness/harness.test.ts` passes with all new manifest tests green. Total test count increases from 77 to approximately 82:
   - `buildAppManifest: returns the exact 19-file list for fixtures/demo-app/`
   - `buildAppManifest: excludes any path with a dotfile segment (path-segment rule)`
   - `render-raw attempt-1 with manifest matches §3 worked example byte-exactly`
   - `render-governed attempt-1 with manifest matches §4 first-attempt shape byte-exactly`
   - `raw/governed parity: APP FILES manifest block is byte-identical between loops`
2. The `SYSTEM_PROMPT_SHELL: matches §2 verbatim first and last lines` test is updated to assert the presence of Rule 5.
3. `buildAppManifest(fixtures/demo-app/)` output is dumped once during the harness fix commit and the result pasted into a comment in `manifest.ts` as the ground-truth reference, so future test drift is immediately visible in code review.
4. The pilot re-run against the same five cases produces non-zero raw convergence. If raw convergence is still 0/15 after the fix, that is a separate diagnosis event and requires re-halt under §26.
5. The cost of the re-run pilot is logged and compared against the original pilot's $0.0075. The manifest addition should produce a modest token increase (~50–100 input tokens per call, ~$0.0011 total for 109 calls); anything above $0.05 for the 30-run pilot is flagged for inspection.

### Scope of this amendment

Amendment 6 modifies DESIGN.md §2, §3, and §4 only. It does not modify §1, §5–§18, §19–§22, or §23–§26. It does not touch `case-list.jsonl`. It does not change any pre-registered number. It changes what is in the prompt body on every attempt, defines the mechanism by which the change is computed, and specifies the tests that enforce the change. The §18 decision gate, §22 cost budget, §20 LLM adapter pin (as amended by Amendment 5), and §21 stateDir hygiene are all unchanged and remain binding.

### Freeze protocol status

**Amendment 6 is now part of the pre-registration.** It is subject to §26 equally with the original DESIGN.md sections and with Amendments 1, 2, 3, 4, and 5. Specifically:

1. **Amendment 6 cannot be reverted without another amendment.** If a future session decides to remove the `APP FILES:` manifest, change the path-segment exclusion rule, or alter the Rule 5 shell text, that change requires a **Pre-registration Amendment 7** that explicitly references Amendments 1 through 6 and explains how the seven interact.
2. **Future amendments must acknowledge Amendment 6.** Any Amendment N for N ≥ 7 must include an "Interaction with prior amendments" section that lists Amendments 1, 2, 3, 4, 5, and 6 in order and states whether and how Amendment N modifies or supersedes their effects.
3. **The §26 bilateral refusal clause applies to Amendment 6.** Neither the operator nor the builder may silently change the manifest format, the exclusion rule, Rule 5 of the §2 shell, or the byte-identity invariant between raw and governed attempt-1 outputs. Pressure to do any of these must be refused and routed through the amendment protocol.
4. **The pre-commitment to replication is binding.** The taxonomy claim (three meta-drafting instances across three detection mechanisms = plurality class in N1) is scoped to N1 until replicated. Future experiments are designated as taxonomy replication tests by this amendment, and the taxonomy claim must be updated based on pooled evidence from those replications.
5. **The path-segment exclusion rule is binding and uniform.** It is not a list of dotfile names to exclude. It is a path-segment rule that applies uniformly to any path segment beginning with `.`. Adding named exceptions, allowlists, or file-extension carve-outs requires a new amendment.
6. **The fixture contamination observation is a committed finding.** The pre-existing `.verify/` and `.verify-k5-*/` state files discovered during Amendment 6 drafting are part of the audit trail. Cleaning them out of `fixtures/demo-app/` in a future commit is acceptable but does not retroactively rewrite the finding in RESULTS.md. A reader of the amendment chain must be able to see that the fixture contamination was discovered during Phase 2.5 diagnosis.
7. **The Amendment 6 Change 4 audit-trail convention is binding going forward.** Any text added to DESIGN.md by an amendment must be marked with "(added by Amendment N)", "(updated by Amendment N)", or "(explicit under Amendment N)" so future readers can identify amendment-sourced text without cross-referencing git history. This applies to Amendment 7+; it is not retroactively applied to Amendments 1-5.

A pre-registration protocol that allows unlimited silent amendments is no protocol at all. Amendment 6 is binding.

---

### Phase 2.5 resumption note (Amendment 6)

Phase 2.5 was halted at the §18 decision gate failure on 2026-04-10, with the raw convergence rate at 0.0% and the governed loop halting at `stuck` on every run. Under Amendment 6, Phase 2.5 resumes with:

1. **Implement the harness fix** per Change 5 guidance:
   - Create `experiments/n1-convergence-proof/harness/manifest.ts` with `buildAppManifest` and `formatAppManifest`.
   - Update `render-raw.ts` and `render-governed.ts` to accept and prepend the manifest.
   - Update `run-case.ts` to build the manifest once per run and pass it to both renderers.
   - Update `SYSTEM_PROMPT_SHELL` in `run-case.ts` to include Rule 5 verbatim per Change 2.
   - Update the existing `SYSTEM_PROMPT_SHELL` test and add the new tests enumerated in Change 5 items 4, 5, and 6.
2. **Run the 77+5 ≈ 82-test suite on Windows** to verify no hermetic regression.
3. **Push the harness fix commit** to `origin/main`.
4. **Fast-forward verify-l2 on Lenovo** to the new HEAD.
5. **Re-run the pilot** against the same five cases per the existing pilot driver. The case selection is unchanged (deterministic first-Source-B-per-primary-family from the locked `case-list.jsonl`).
6. **Evaluate §18 decision gate** on the re-run results.
7. **Report pass/fail per the post-pilot protocol.** If all four gates pass, halt and await Phase 3 authorization. If any gate fails, halt and escalate — a second pilot failure is a substantially different signal and warrants its own ruling.

The pre-flight checkpoint at Phase 1e (report drop count `k`) is preserved by Amendment 6 (Phase 1 is complete and unchanged). The §18 decision gate thresholds are preserved by Amendment 6 (no changes to §18). The §22 cost budget is preserved by Amendment 6 (no changes to §22). The re-run pilot is a clean second attempt at the same pilot spec, against the same five cases, under a harness that now implements the updated §2/§3/§4.
