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

On retry: you will receive feedback about why your previous attempt failed. Use that feedback to revise your edits and predicates. The goal remains the same across retries.
```

This prompt is committed verbatim. No substitutions. No per-case variations. Both loops render the same system prompt bytes on every request.

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

On attempt 1, the raw loop sends the system prompt + `GOAL: {goal_string}` with no "previous attempt" section.

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

The harness reads the key from `process.env.INPUT_API_KEY` on startup. If not set, the harness exits with a clear error. No code changes to `src/action/index.ts` — the existing code is reused verbatim.

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

- **Version:** 1 (initial pre-registration) + Amendment 1 (2026-04-09) + Amendment 2 (2026-04-09)
- **Author:** builder Claude (execution), operator (approval)
- **Date:** 2026-04-09
- **Status:** committed as `d581838` + Amendment 1 + Amendment 2 appended
- **Commit:** `d581838` (initial) + Amendment 1 commit (`2adf908`) + Amendment 2 commit (see git log)

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
