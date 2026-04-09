# Scanner Incidents

A catalog of scanner resilience bugs discovered during real-world Level 2/3 scans, with diagnosis, fix, and detection method for each.

**Scope:** This file is about **scanner bugs** — situations where the scanner itself failed to make progress, hung, crashed, or produced wrong output due to its own implementation. It is **not** about agent failure shapes (those live in `FAILURE-TAXONOMY.md`).

**Naming:** Incidents use the prefix `SI-` (Scanner Incident) and are numbered sequentially. Each entry is a 60-second read with diagnosis, fix, and detection method in one place.

**Note:** SI-006 includes a correction to the 2026-04-08 cal.com validation interpretation. See SI-006 § "Correction to the 2026-04-08 cal.com validation interpretation".

---

## SI-001 — extractCSS pathological on backtick-free large files

**Date:** 2026-04-08
**Severity:** blocker — scanner hangs indefinitely, no timeout, no progress log
**Discovered during:** First Level 2 production run on `calcom/cal.com`
**Triaged by:** Manual diagnosis from CPU/RSS/FD signals (no strace)

### Symptom

Level 2 scan on `calcom/cal.com` (220 PRs) entered the per-PR scan loop and immediately hung. Bun process pinned at 85% CPU, RSS flat at 296MB, no I/O activity, FD count steady at 14 (stdio + eventfds only — no data files open). Killed at 14:10 elapsed with zero PRs scanned.

The same scanner code completed cleanly on `modelcontextprotocol/inspector` (6 PRs) in 10.1 seconds during smoke testing. The variable was the codebase, not the scanner.

### Root cause

`extractCSS` in `src/gates/grounding.ts` (line 844 pre-fix) used this regex to find CSS-in-JS template literals:

```javascript
const cssLiteralPattern = /`([^`]*\{[^`]*\}[^`]*)`/g;
```

Three sequential greedy negated quantifiers (`[^`]*`) separated by literal `{` and `}` anchors. The regex is "safe" in the textbook sense — negated character classes don't trigger exponential backtracking — but on **content with no backticks**, the regex engine must:

1. Try every starting position in the string (linear in `n`)
2. At each position, attempt to match the pattern, which means exploring how to split the remaining content across three greedy `[^`]*` segments before any literal `{` or `}` can match
3. Fail at every position because no backtick exists

The result is **O(n²)** scan time per file, or worse in practice. On `cal.com/packages/platform/atoms/globals.css` (343KB of pure CSS, zero backticks), this never completed in a 60-second isolation test.

### Trigger

Any repository containing `.css`, `.html`, or text files larger than ~200KB with no backtick characters. Common in:
- **Tailwind output** — generated utility class dumps
- **Icon sprite CSS** — country flags, font icons (cal.com had 200KB of country flag CSS)
- **Vendor CSS bundles** — Bootstrap, framework themes
- **Framework dumps** — `globals.css`, `main.css` aggregations

### Diagnosis timeline

The blow-by-blow as a debugging story:

1. **Initial hypothesis (wrong):** "Slow JSON.parse loop in `loadCommitsForPRs` streaming the 1.7GB commit details file." Plausible because the silent phase started right after the clone finished.
2. **Evidence against:** FD count was zero on data files for 10+ minutes. A hot streaming loop would show transient FD activity. RSS was stable at 296MB — no growing in-memory map.
3. **Second hypothesis (also wrong, narrower):** "Catastrophic regex backtracking somewhere in the grounding extractors." Picked the big CSS files in cal.com as suspects without testing.
4. **Killed the scan at 14:10** — too early per the 15-minute threshold. Made the wrong call based on incomplete evidence.
5. **Isolation test (correct method):** Re-cloned cal.com shallow, called the `extractCSS` regex inline against `globals.css` with a 30s timeout. Confirmed timeout. Narrowed by phase: `styleBlockPattern` ran in 1ms, `cssLiteralPattern` timed out at 60s.
6. **Root cause identified:** Triple-greedy negated quantifiers on backtick-free input is the precise pathology. Confirmed by reading the regex carefully — the literal `{` and `}` anchors don't help when the engine has to find a backtick that doesn't exist.

**Lesson:** Don't kill a scan based on a hypothesis you haven't confirmed. The 14:10 kill was premature; the right move was to wait the full 15-20 minutes the smoke test math suggested, or attach an isolation test to a partial signal first. I owe future-me a reminder to confirm hypotheses before triggering kills.

### Fix

Two layers, shipped together in the same commit:

1. **Backtick short-circuit (root cause fix), in `extractCSS`:**
   ```javascript
   if (content.includes('`')) {
     // ... existing cssLiteralPattern loop ...
   }
   ```
   `String.includes('` ')` is O(n) with a tight inner loop — microseconds on 343KB. When it returns false, the entire pathological regex phase is skipped.

2. **Size cap with log warning (defense in depth), in `groundInReality`:**
   ```javascript
   if (content.length > 100_000) {
     console.warn(`[grounding] Skipping oversized file (${...}KB > 100KB): ${filePath}`);
     continue;
   }
   ```
   Files >100KB are almost always machine-generated and don't contain semantic selectors agents would edit. Skipping them loses nothing for grounding's real job and protects against unknown pathological patterns in any other extractor.

### Tests

Three regression tests in `tests/unit/grounding.test.ts` under the `SI-001 regression` describe block:

1. **Pathological:** 343KB CSS file with no backticks. Asserts grounding completes in <1s. Pre-fix this took 14+ minutes.
2. **Positive control:** Small TS file with CSS-in-JS template literal. Asserts the `.hero` and `.nav` selectors from the literal still get extracted. Guards against the short-circuit accidentally breaking legitimate template-literal parsing (used by styled-components, emotion, etc.).
3. **Mixed directory:** One oversized file + one normal file in the same dir. Asserts the oversized file is skipped but the normal file is still processed normally.

All three pass post-fix. The full grounding test file runs in 4.77s.

### Detection going forward

The fix added log output:
- `[grounding] Skipping oversized file (XKB > 100KB): path` — fires on every skip, visible in scan logs
- `[scan] PR i/N #id starting...` and `[scan] PR i/N #id done in Xms — N findings` — per-PR heartbeat in `level2-scanner.ts` so any future hang shows the exact PR and gate
- `[commits] Streaming pr_commit_details.jsonl...` and progress every 100K rows — heartbeat for the load-commits phase so the silent startup window is observable

If a future Level 2 run produces zero per-PR logs for >30s after the `[scan] Starting per-PR loop` line, that's the same class of hang and the file being processed needs inspection.

### Invisible at

- **Level 1** — uses synthetic file stubs (`search + '\n' + replace`), no large files possible
- **Smoke test** — `modelcontextprotocol/inspector` had no files larger than ~10KB

### Surfaced by

**`calcom/cal.com`** — first production monorepo target for Level 2. cal.com has 304 source files at depth 3, two of them >200KB pure CSS. The bug had been latent in grounding.ts for the entire history of the file but never tripped because Level 1 doesn't read real files.

This is the verification debt pattern turned inward: a bug in the grounding gate that affected every user running the GitHub Action against any large monorepo, invisible to those users because they had no way to diagnose it. The first hour of real Level 2 paid for itself by catching a production bug that was already shipping to users.

---

## SI-002 — discover-shapes silently dropped unroutable clusters

**Date:** 2026-04-08
**Severity:** high — flywheel output deleted, exit 0, invisible in logs
**Discovered during:** Operator question "what's the append bug?" during a Level 2 debugging session unrelated to nightly pipeline correctness
**Triaged by:** Code read of `scripts/harness/discover-shapes.ts` confirmed against nightly logs

### Symptom

Nightly `discover-shapes.ts --confirm` ran emit-shapes, clustered failures, and confirmed 3 new shapes (`X-103`, `X-104`, `X-105` — 89 total observations across 74 + 10 + 5 occurrences). Then dropped all 3 with:

```
WARNING: Could not find section for domain "unknown" — skipping 3 shape(s)
Appended 0 shape(s) to FAILURE-TAXONOMY.md
new_shapes=0
```

Exit code 0. Three nights running confirmed → ~9 shapes lost over the window. The nightly looked clean from the outside (no failures, no missing artifacts, no alerts) but the flywheel's actual output was being silently deleted.

### Root cause

Two stacked specification gaps, not a typo:

**Gap 1 — empty-gate fallback resolved to 'unknown':** In `clusterFailures` (pre-fix line 170), when `entry.result.gatesFailed` is empty the fallback gate name was `'invariant'`. But `GATE_TO_DOMAIN` had key `'invariants'` (plural — the gate's actual name) and not `'invariant'` (singular). The lookup `GATE_TO_DOMAIN['invariant']` returned `undefined`, the `?? 'unknown'` fallback fired, and the cluster's domain became `'unknown'`.

This is a **specification gap, not a typo**: `'invariant'` is also a legitimate value that appears in `HEADING_TO_DOMAIN['Invariant / System Health Failures']`. Fixing the spelling to `'invariants'` would unblock the append (it would route shapes to the Invariants section) but would land them in the wrong semantic home — these are "verify passed when it shouldn't have" cross-cutting false-negatives, not failures of specific runtime invariants.

**Gap 2 — appender treated missing section as warn-and-continue:** In `appendToTaxonomy` (pre-fix lines 417–420):

```typescript
if (insertAt === -1) {
  console.log(`  WARNING: Could not find section for domain "${domain}" — skipping ${shapes.length} shape(s)`);
  continue;
}
```

`console.log` warnings are invisible in log aggregation. `continue` advances the loop without recording the loss. The function returns `appended = 0` and `main()` happily logs `new_shapes=0` and exits 0. There is no signal to operator, CI, or alerting that work was discarded.

### Trigger

Any cluster where `entry.result.gatesFailed` is empty — i.e., the gate logic decided not to fail anything but the invariant layer detected a problem. This is the standard pattern for fuzz-mutation false negatives:

- `[FUZZ:type_swap]` mutations where verify passes but the scenario expected fail
- `[FUZZ:boundary]` numeric/string boundary cases where the gate underfires
- `[FUZZ:pred_flip]` predicate-flip mutations that the gate accepts incorrectly

The 89 lost observations were all of this shape: cross-cutting evidence that verify's overall discrimination power is weak on a class of mutations. The shape classifier was correctly refusing to attribute them to any single gate. The pipeline downstream of the classifier was silently throwing the evidence away.

### Diagnosis timeline

1. **Operator surfaced the symptom** by asking "what's the append bug?" — referring to the warning line that had been showing up in nightly logs.
2. **Read the appender code first.** Found `console.log("WARNING: ...") + continue` at line 417. That's the silent drop. Logged it as gap 2.
3. **Traced backwards to find why domain was 'unknown'.** Searched for where `domain` is assigned. Found `proposeShape` at line 196: `const domain = GATE_TO_DOMAIN[gate] ?? 'unknown';`. The fallback path.
4. **Traced backwards to find where `gate` is assigned.** Found `clusterFailures` at line 170: `const gate = entry.result.gatesFailed[0] ?? 'invariant';`. The string `'invariant'`.
5. **Searched for `'invariant'` in `GATE_TO_DOMAIN`** — not present. `'invariants'` (plural) is. That's gap 1.
6. **Almost called it a typo.** Pulled back: `'invariant'` is a legitimate value in `HEADING_TO_DOMAIN`. Both spellings are real strings in this codebase. The choice of `'invariant'` vs. `'invariants'` vs. `'crosscutting'` is a routing decision, not a misspelling.
7. **Asked the right semantic question:** where do "verify said OK when it shouldn't have, across multiple gate families" failures belong in the taxonomy? Answer: `## Cross-Cutting Failures (Gate-Level)` (line 1256 of FAILURE-TAXONOMY.md), which already uses the `X-` prefix and already houses X-01..X-56 of the same general flavor.
8. **Three findings before editing** that would have bitten a charge-ahead implementation:
   - `appendShapesToTaxonomy` (the name in the original write-up) didn't exist — the actual function is `appendToTaxonomy` with a 2-arg signature
   - `main()` was called unconditionally at the bottom of the file with no `import.meta.main` guard, so adding `export` keywords would let test imports trigger a full nightly run
   - `DOMAIN_TO_HEADING['crosscutting']` resolved to the **first** matching heading (`Cross-Predicate Interaction Failures`, which uses `I-NN` IDs) instead of the section that actually houses the X- series (`Cross-Cutting Failures (Gate-Level)`)

**Lesson:** Don't trust a diagnosis from another reader without confirming it against the file. The high-level diagnosis was correct; three implementation details would have produced a broken commit if I had skipped the verification pass.

### Fix

Five edits in `scripts/harness/discover-shapes.ts`, shipped together:

1. **Reroute the empty-gate fallback** (line ~170) from `'invariant'` to `'crosscutting'`. Cross-cutting false-negative shapes belong in the Gate-Level section, not the Invariants section.
2. **Add `crosscutting: 'crosscutting'`** to `GATE_TO_DOMAIN` so the new fallback resolves cleanly.
3. **Override `DOMAIN_TO_HEADING['crosscutting']`** after the reverse-map loop, forcing it to `'Cross-Cutting Failures (Gate-Level)'` (the section that actually uses the `X-` prefix). Without this override, "first match wins" would land shapes in the `I-NN` Cross-Predicate section.
4. **Replace the warn-and-continue at line 417** with `throw new Error(...)` that names the missing domain, the count of shapes that would be lost, and the specific shape IDs (so the operator can recover them from `discovered-shapes.jsonl`). Includes a pointer to this incident entry.
5. **Wrap `main()` in `if (import.meta.main)`** so regression tests can import `appendToTaxonomy` and `proposeShape` without triggering a full nightly run on test load.

`appendToTaxonomy`, `proposeShape`, and the `CandidateShape` / `FailureCluster` types were exported with comments noting the SI-002 reason for the export.

### Tests

Two regression tests in `tests/unit/discover-shapes-fail-loud.test.ts`:

1. **SI-002 routing test** — constructs a cluster with empty `gatesFailed`, calls `proposeShape`, asserts `shape.domain === 'crosscutting'` and `shape.proposedId` matches `/^X-\d+$/`. Plus a negative assertion that `shape.domain !== 'unknown'`. Pins the routing fix so a future edit to `GATE_TO_DOMAIN` or the fallback string cannot silently re-introduce the unknown-domain path.
2. **SI-002 fail-loud test** — calls `appendToTaxonomy` with a synthetic shape whose domain has no taxonomy section. Asserts the call throws (not warns) and that the error message contains the shape IDs, the missing domain name, and the SI-002 reference. Pins the fail-loud guard so a future refactor that reverts the throw to warn+continue fails the test instead of silently deleting work.

All 4 tests pass post-fix. Full unit suite (346 tests) passes with no regressions.

### Detection going forward

- Any future "no section for domain" failure now stops the nightly with a non-zero exit code. CI will surface it as a failed job; no silent drops possible.
- The error message names the dropped shape IDs, so the operator can immediately look them up in `data/discovered-shapes.jsonl` and decide whether to add a new section, update `DOMAIN_TO_HEADING`, or update `GATE_TO_DOMAIN`.
- Any future `console.warn + continue` pattern in pipeline code is now flagged as a silent-drop vector. **Prevention rule:** in pipeline steps where lost output would erode the flywheel, `throw` beats `console.warn + continue`. Nightly jobs should exit non-zero and open an issue, not exit 0 with a missed result.

### Invisible at

- **Log aggregation** — `console.log` warnings are indistinguishable from info messages
- **Exit codes** — `exit 0` means success regardless of whether work was dropped
- **Per-run metrics** — `new_shapes=0` is indistinguishable from "nothing to discover"
- **Self-test** — the self-test scenarios don't exercise the discover-shapes append path
- **Smoke test** — discover-shapes only runs in `--confirm` mode in the nightly, not in any test

### Surfaced by

Operator question during a Level 2 debugging session ("what's the append bug?"). The bug had been latent for an unknown number of nights — at least 3, possibly longer — and was only visible because the operator happened to ask about a warning line they had noticed. Without the question, the silent drop would have continued indefinitely.

This is the **silent-drop class** of infrastructure bug: a pipeline component that exits 0 and reports zero output is **almost always** dropping work, not "finding nothing to do." First debug question for any "everything looks fine but nothing happened" case should be: what was the input size, and where does the component fall through to a no-op path?

---

## SI-003 — Multi-commit PR file-creation false positive in F9

**Date:** 2026-04-08
**Severity:** medium — produces false F9 `file_missing` findings on PRs that create-then-modify the same file
**Discovered during:** cal.com Level 2 first production run triage (commit `cedf388`)
**Triaged by:** Manual code read of `generatePredicates()` + `runSyntaxGate()` + `parseDiff()`, followed by isolation test against PR 3161649548 in `pr_commit_details.jsonl`
**Status:** **FIXED** in commit `5861009` (Option C). Regression test at `tests/unit/level2-si003-filter.test.ts` (6 cases). Filter extracted as exported `filterCommitsForSI003()` in `scripts/scan/level2-scanner.ts`.

### Symptom

Cal.com Level 2 produced 26 F9 findings across 42 scanned PRs. ~5-6 of those (19% of findings) were `file not found` failures on files in large multi-commit PRs that introduce new packages or modules. Examples:

- PR 3224857167 (Devin, 1382 edits, "refactor Deel app to OAuth integration") — `packages/app-store/deel/lib/DeelService.ts: file not found` ×3
- PR 3161649548 (Devin, 93 edits, "framework-agnostic googleapis caching layer") — `packages/app-store/_utils/googleapis/CachedCalendarClient.ts: file not found` ×2
- PR 3241012029 (Devin, 48 edits, "add comprehensive getSlots performance tests") — `packages/lib/getSlots-performance.test.ts: file not found` ×3

In each case the file IS introduced by the PR — but in an earlier commit than the one containing the modifications that F9 fired on.

### Root cause

Three components were checked and ruled out before the actual root cause was found:

1. **`generatePredicates()` in `scripts/scan/level2-scanner.ts` (lines 215-219)** — CORRECT. Skips `filesystem_exists` for file-creation edits with empty `search` string.
2. **`runSyntaxGate()` in `src/gates/syntax.ts` (lines 36-43)** — CORRECT. Explicitly handles file creation: `if (edit.search === '' && edit.replace) continue`.
3. **`parseDiff()` in `src/parsers/git-diff.ts` (lines 52-63)** — CORRECT. Produces `{search: '', replace: <content>}` for files marked `isNew` in the diff header.

The actual bug is in **`scanPR()` in `scripts/scan/level2-scanner.ts`** at the diff reconstruction step (lines 305-315):

```typescript
const diff = commits.map(c => {
  const isNew = c.status === 'added';
  const header = isNew
    ? `diff --git ... new file mode 100644 --- /dev/null +++ b/${c.filename}\n`
    : `diff --git ... --- a/${c.filename} +++ b/${c.filename}\n`;
  return header + c.patch;
}).join('\n');
```

All commits in the PR are reconstructed as separate diff blocks and concatenated. `parseDiff()` then produces an `Edit[]` containing one creation edit (empty search, full content) **plus** subsequent modification edits with non-empty searches against the same file. The whole batch is evaluated against the parent of the **earliest** commit (`sha~1` of the first commit). At that base state, the file doesn't exist yet — so the modification edits fire `file_missing` even though the same edit batch contains the creation edit.

PR semantics require **sequential application** — file system state must evolve between commits within the same PR. The scanner squashes everything into a single base-commit evaluation, losing that ordering.

### Trigger

Any PR meeting all of:
- Multiple commits (`pr_commit_details.jsonl` shows ≥2 distinct SHAs for the PR)
- An earlier commit creates a file (`status: "added"`)
- A later commit modifies that same file (`status: "modified"`)
- The modification's edit has a non-empty `search` string

Most common in Devin PRs (which favor many small commits per PR) on monorepos with new-package introduction.

### Confirmation evidence

Isolation test against PR 3161649548 in `~/datasets/aidev-pop/pr_commit_details.jsonl`:

- 53 commits found for the PR
- `CachedCalendarClient.ts` entry has `status: "added"` (correctly marked in dataset)
- `parseDiff()` produces 3 edits for the file: 1 creation (empty search, 2049 bytes replace) + 2 modifications (255 and 117 byte non-empty searches)
- F9 evaluates all 3 edits against parent of earliest commit
- The creation edit passes (file-creation guard fires correctly)
- Both modification edits fail with `file_missing` because the file doesn't exist at the parent commit yet
- This is the false positive

### Fix candidates

**NOT YET APPLIED — documentation only until operator approves a fix path.**

**Option A — Pre-filter (simplest):** In `scanPR()`, after `parseDiff()` returns the edits array, build a `Set<string>` of files that have any edit with `search === ''` (creation). For those files, drop subsequent modification edits from the array before passing to `verify()`. Loses some F9 fidelity (any genuine fabrication in a post-creation modification will be silently dropped) but eliminates the FP class with ~5 lines of code.

**Option B — Sequential apply:** In `scanPR()`, group edits by commit SHA. Run F9 incrementally — apply commit 1's edits to a temporary working tree, then check commit 2's edits against the modified tree, etc. Most accurate but ~Nx slower per PR (where N is the commit count). Requires checkout/apply/restore cycles per commit.

**Option C — Status-aware filter (recommended):** In the diff reconstruction loop in `scanPR()` (lines 305-315), build a `Map<filename, "created" | "modified">` from the commit details' `status` field BEFORE reconstructing the diff. For files with any `status: "added"` entry, only emit the creation edit and skip the modification edits. Uses information already in the dataset, doesn't change F9 semantics, doesn't slow down scanning. ~10 lines in `level2-scanner.ts`.

**Why C over A:** A drops modifications based on what `parseDiff()` produces (post-parse), which means the scanner has to scan the parsed `Edit[]` for empty-search markers. C drops modifications based on what `pr_commit_details.jsonl` says (pre-parse), which is more authoritative — the dataset directly tells us "this file was added in this PR" without needing parser inference.

**Why not B:** Sequential application is the "correct" model but it's a 5-10x performance hit per PR and requires significant refactoring of `scanPR()`. The cal.com scan ran in 3:42; Option B would push that to 20-40 minutes. Not justified for the marginal accuracy gain.

### Tests (pending fix)

Once a fix is applied, regression test should:
- Reproduce a multi-commit creation+modification PR synthetically (one commit creates `foo.ts`, another commit modifies it)
- Assert F9 does not produce `file_missing` failures for the modification edits
- Assert F9 still catches genuine fabrications on existing files (positive control — must not be over-corrected)

### Detection going forward

If a Level 2 scan produces F9 `file_missing` findings concentrated on files in large PRs, check whether the same file appears with `status: "added"` in the commit details. Scriptable check:

```bash
grep -F "<filename>" ~/datasets/aidev-pop/pr_commit_details.jsonl | jq -r 'select(.pr_id=="<id>") | .status' | sort | uniq -c
```

If `added` appears in the count, this is the SI-003 false positive class.

### Impact estimate

In the cal.com Level 2 run, ~5-6 of 26 F9 findings (19-23%) are this false positive class. The 14-16 real fabrications (X-90 territory) are unaffected — those are on **existing** files where the agent's search string doesn't match real content.

Across the AIDev-POP dataset, multi-commit PRs are concentrated in:
- **Devin PRs** — Devin tends to commit incrementally, often 5-50+ commits per PR
- **Large refactor PRs** — sweeping renames, package introductions, framework migrations
- **Monorepos** — where new packages are introduced as separate commits

Single-commit PRs (common in Copilot, Codex) won't trigger SI-003 at all. Estimate: SI-003 affects 10-30% of F9 findings on Devin-heavy repos, near 0% on Copilot/Codex-heavy repos.

### Surfaced by

cal.com Level 2 first production run (commit `cedf388`). The bug was invisible at Level 1 (synthetic stubs always satisfy any search string), invisible on the smoke test (`modelcontextprotocol/inspector` had no multi-commit creation patterns), and only became diagnostic when the operator triaged the 26 F9 findings and noticed a sub-pattern of `file not found` clustered on large new-package PRs.

This is the second time on 2026-04-08 that an unexpected diagnostic signal pointed at the wrong layer first. Initial hypothesis was "predicate generator bug" → ruled out by code read. Second hypothesis was "F9 file-creation guard bug" → ruled out by code read. Third hypothesis was "diff parser bug" → ruled out by code read. Actual bug found in the scanner's diff reconstruction step, three layers up from where it surfaces. Lesson: when a diagnostic narrows to a specific gate output, the cause may be in the input pipeline that fed the gate, not in the gate itself.

---

## SI-004 — Serialization gate false positives (split into 004a and 004b)

**Date:** 2026-04-08 (split 2026-04-08)
**Discovered during:** cal.com Level 2 (commit `cedf388`) and total-typescript-monorepo Level 2 (commit `38b28b7`) cross-scan triage

**This entry was originally filed as one incident with five occurrences.** Triage on 2026-04-08 determined the five occurrences were two distinct bugs sharing a symptom (the serialization gate producing JSON parse errors on files where it shouldn't). They are split here:

- **SI-004a — Predicate generator emits serialization on YAML files.** ROOT CAUSE CONFIRMED, ONE-LINE FIX. Explains the cal.com `.github/workflows/all-checks.yml` finding (1 of 5 original occurrences).
- **SI-004b — Edit-content / file-path mismatch in diff reconstruction.** ROOT CAUSE HYPOTHESIS, SHARES FAMILY WITH SI-003. Explains the four total-typescript `lockfileVersion`-on-`package.json` findings and the related `.md` findings (4 of 5 original occurrences plus 2 cross-gate observations).

The two sub-incidents are documented separately below. The split matters for triage discipline: a future scan that re-fires the SI-004a pattern after the fix lands is a regression and should be flagged loudly, while a scan that fires the SI-004b pattern is the same known-open issue. Without the split, future occurrences of either would be filed under "known SI-004, ignore," which would mask a regression of either component.

---

## SI-004a — Predicate generator emits `serialization` on YAML files

**Date:** 2026-04-08
**Severity:** medium — guarantees a false `JSON Parse error` on every YAML file an agent edits
**Discovered during:** cal.com Level 2 (commit `cedf388`) — 1 occurrence at original triage time
**Status:** **FIXED** in commit `464dad1`. Regression test at `tests/unit/level2-predicate-generator.test.ts` (4 cases). Predicate generator now emits serialization only on `.json`.

### Symptom

cal.com Level 2 PR 3174617673 (Devin, "feat: add circular dependency check to CI workflow") — serialization gate fired on `.github/workflows/all-checks.yml` with `JSON Parse error: Unexpected identifier "name"`. The file is YAML, not JSON; `"name"` is a top-level GitHub Actions workflow key.

### Root cause

`generatePredicates()` in `scripts/scan/level2-scanner.ts` lines 221-227:

```typescript
// serialization — if agent edits JSON/YAML, validate structure
for (const edit of edits) {
  const lower = edit.file.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    predicates.push({ type: 'serialization', file: edit.file, comparison: 'structural' });
  }
}
```

The serialization gate at `src/gates/serialization.ts:244` uses `JSON.parse()` exclusively. It has no YAML support. Emitting a `serialization` predicate against a `.yaml` or `.yml` file is therefore guaranteed to produce a parse error on the first non-JSON token — for GitHub Actions workflow files, that's typically `name`, `on`, or `jobs`. The comment on line 221 (`"if agent edits JSON/YAML, validate structure"`) is aspirational; the gate underneath does not back it up.

### Fix

One-line change to the predicate generator: drop `.yaml` and `.yml` from the condition. The `.json` case remains correct.

```typescript
if (lower.endsWith('.json')) {
  predicates.push({ type: 'serialization', file: edit.file, comparison: 'structural' });
}
```

If YAML structural validation is desired in the future, that's a feature request: extend `serialization.ts` with a real YAML parser (`yaml`/`js-yaml`), then re-add the YAML branch here. Until then, the predicate generator must not assert against a gate that can't run.

### Tests

Regression test in `tests/unit/level2-predicate-generator.test.ts`:
- Given an edit array containing `.yaml`, `.yml`, and `.json` files, assert `generatePredicates()` emits `serialization` predicates **only** for the `.json` file.
- Positive control: a `.json` file in the input still produces a serialization predicate.

### Detection going forward

If any future Level 2 finding shows `gate: "serialization"` with a file ending in `.yaml` or `.yml`, SI-004a has regressed. Scriptable check:

```bash
cat ~/verify-l2/data/aidev-scan/level2/batches/<repo>.jsonl | jq -r 'select(.findings[]?.gate=="serialization") | .findings[] | select(.gate=="serialization" and (.file | endswith(".yaml") or endswith(".yml")))'
```

Non-zero output = regression.

### Impact estimate

Eliminates ~80% of MontrealAI scan serialization noise (per overnight 14k-PR run triage). Per the original SI-004 estimate, removing this surface alone reclaims most of the false positive volume; the remaining lockfile-specific surface is SI-004b.

### Surfaced by

cal.com Level 2 (1 occurrence). Originally filed as part of SI-004 cluster of 5 occurrences. Split out 2026-04-08 after triage determined this was a distinct bug from the lockfile-content-mismatch surface.

---

## SI-004b — Edit content does not match edit file path (diff reconstruction family)

**Date:** 2026-04-08
**Severity:** medium — produces false serialization findings on PRs that touch lockfiles, plus cross-gate findings on Markdown files; root cause likely shared with SI-003
**Discovered during:** cal.com Level 2 (commit `cedf388`) and total-typescript-monorepo Level 2 (commit `38b28b7`)
**Triaged by:** Pattern recognition across two independent scans on different agent populations
**Status:** documented, **root cause hypothesis pending investigation** — likely shares root cause family with SI-003. **Cross-check pending:** SI-003 was fixed in commit `5861009` on 2026-04-08; the next Level 2 validation re-run on total-typescript-monorepo should be checked for residual `lockfileVersion`-on-`package.json` findings. If gone, SI-004b closes via SI-003. If they persist, the bug is in `parseDiff()` and SI-004b needs its own fix.

### Symptom

The serialization gate produces `JSON Parse error: Unexpected identifier "<token>"` failures on file paths that legitimately contain JSON (e.g., `package.json`), but the parse-error token names a lockfile-specific field that does NOT belong in the named file type. The same theme appears on a `.md` path (where the predicate generator wouldn't even emit serialization), and on an access-gate finding against another `.md` file.

**4 confirmed serialization occurrences** (total-typescript-monorepo Level 2):
- PR 3192275043 (Cursor) — serialization on `apps/internal-cli/package.json`, error `JSON Parse error: Unexpected identifier "lockfileVersion"`
- PR 3192276530 (Cursor) — same path, same error: `lockfileVersion`
- PR 3196991617 (Cursor) — same path, same error: `lockfileVersion`
- PR 3196925778 (Cursor, classified `low`) — `PHASE_1_COMPLETION_REPORT.md` with same `lockfileVersion` error (wrong file type entirely — Markdown; the predicate generator does NOT emit serialization for `.md` files, so this occurrence cannot come from the predicate generator at all)

**1 cross-gate observation** (same family, different gate):
- PR 3192645075 (Cursor, classified `low`) — access gate fired on `ALONGSIDE_FLAG_FEATURE.md` with `1 error(s), 0 warning(s): 1× path traversal`. The access gate's `path_traversal` check should not be running against Markdown content. If `edit.file = 'ALONGSIDE_FLAG_FEATURE.md'` but `edit.replace` contains code-like content from a different real file, this is the same root cause manifesting on a different gate.

`lockfileVersion` is the top-level field of `package-lock.json`, `pnpm-lock.yaml`, and `yarn.lock`. It does NOT appear in `package.json`. The fact that the parser is finding it inside a `package.json`-named edit means the **content of the edit is lockfile content, not package.json content** — i.e., `edit.file` and `edit.replace` disagree.

### Hypothesis (NOT yet investigated)

Two candidate layers, both downstream of the predicate generator (which is now ruled out per SI-004a — the predicate generator emits serialization only on `.json`, so it cannot explain the `.md` occurrence):

1. **`parseDiff()` in `src/parsers/git-diff.ts`** — possibly producing edits with the wrong `file` field. If the diff reconstruction concatenates multiple commits' patches and a subsequent `diff --git` header isn't recognized, two files' contents can flow into one Edit object's `replace` string.

2. **`scanPR()` in `scripts/scan/level2-scanner.ts` diff reconstruction (lines 305-315)** — same suspect as SI-003. The function reconstructs each commit's diff with synthetic headers and concatenates. If the dataset has two commit_details rows where one has `filename: "package.json"` and the next has `filename: "package-lock.json"`, the concatenated diff might place lockfile patch content under the package.json header. **This is the most likely candidate** because it's the same code path that caused SI-003, and the `package.json`/`package-lock.json` filename pair is exactly the kind of close-name collision where the bug would manifest.

The above is **hypothesis only** — neither layer has been verified by isolation test. SI-004b is filed as documentation pending investigation. **Strongly suspected to share root cause with SI-003.** If the SI-003 Option C fix in `scanPR()` resolves the `scanPR()` diff reconstruction problem, SI-004b may close as a side effect — that should be checked explicitly after SI-003 lands.

### Trigger (suspected)

PRs that touch BOTH a lockfile AND a similarly-named JSON file in the same edit batch, OR PRs where multi-commit diff reconstruction places one file's content under a different file's header. Common in:
- Dependency updates (`pnpm install` modifies both `package.json` and `pnpm-lock.yaml`)
- Workspace setup PRs (multiple `package.json` files plus their lockfiles)
- Monorepo lockfile sync PRs
- Multi-commit PRs with file ordering that exposes a header-recognition gap in the parser

### Fix candidates

**NOT YET PROPOSED — investigation required first.** SI-004b is documented as a hypothesis-pending-investigation entry. Three things need to happen before fix candidates can be drafted:

1. **Reproduce the bug in isolation.** Pick one of the 4 occurrences (recommend PR 3192275043 — Cursor, total-typescript, only 5-10 commits to inspect) and run an isolation test that:
   - Loads the PR's commits from `pr_commit_details.jsonl`
   - Reconstructs the diff exactly as `scanPR()` does
   - Calls `parseDiff()` and prints the resulting `Edit[]` for inspection
   - Checks whether any edit's `file` field disagrees with its `replace` content type

2. **Determine whether the SI-003 fix closes this.** After SI-003 Option C lands, re-run the isolation reproduction. If the file/content mismatch is gone, SI-004b closes via SI-003. If it persists, the bug is in `parseDiff()` and needs its own fix.

3. **Identify the actual bug location** (if not closed by SI-003) and propose fix options A/B/C with tradeoffs.

### Tests (pending root cause)

Once the bug is located and fixed, regression tests should:
- Reproduce a synthetic multi-file PR where one commit modifies `package.json` and another modifies `package-lock.json`
- Assert the resulting edits have correct `file` ↔ `replace` correspondence (no cross-contamination)
- Assert the serialization gate does not fire `lockfileVersion` errors on `package.json`
- Positive control: assert legitimate JSON parse errors on actually-malformed package.json still fire

### Detection going forward

If a Level 2 scan produces serialization findings with `JSON Parse error: Unexpected identifier "lockfileVersion"` on a `.json` or `.md` file, that is the SI-004b pattern. Scriptable check:

```bash
cat ~/verify-l2/data/aidev-scan/level2/batches/<repo>.jsonl | jq -r 'select(.findings[]?.gate=="serialization") | .pr_id + " " + (.findings[] | select(.gate=="serialization") | .detail)' | grep lockfileVersion
```

If the count is non-zero, SI-004b is firing on this scan.

### Impact estimate

4 serialization occurrences plus 1 cross-gate observation across 2 scans, over a combined 96 scanned PRs. After SI-004a lands, this is the residual ~20% of serialization noise that the YAML-exclusion fix does NOT eliminate. Estimate: 1-3% of serialization findings on lockfile-heavy repos, near 0% on small libraries.

### Surfaced by

cal.com Level 2 + total-typescript-monorepo Level 2. Originally filed as part of SI-004 cluster of 5 occurrences. Split out 2026-04-08 after triage determined the cal.com YAML occurrence was a distinct bug (now SI-004a) from the lockfile-content-mismatch surface (this entry, SI-004b).

---

**Cluster note for SI-001 through SI-004b.** This is the **third time on 2026-04-08** that scanner output revealed a scanner bug, not an agent bug. SI-001 (catastrophic regex), SI-002 (silent shape drop in discover-shapes), SI-003 (multi-commit PR FP), and now SI-004a (predicate generator emits serialization on YAML) and SI-004b (edit-content/file-path mismatch). Pattern: real production scans surface scanner resilience bugs that are invisible to synthetic test suites because the test suites don't include the specific shape of bad input that triggers them. Lesson: the only way to find scanner bugs is to run the scanner on diverse production data.

---

## SI-006 — Sequential-modification reversal in F9

**Date:** 2026-04-09
**Severity:** medium — produces false F9 `search string not found` findings on PRs where the same file is modified in multiple sequential commits and later commits' search strings depend on earlier commits' patches being applied
**Discovered during:** N1 experiment ground truth audit, while triaging the 5 "newly-visible" F9 findings from the 2026-04-08 post-SI-003-fix cal.com re-run
**Triaged by:** Manual inspection of the 5 candidate cases against `pr_commit_details.jsonl` — all 5 confirmed to share the same mechanism
**Status:** documented, no fix applied

### Correction to the 2026-04-08 cal.com validation interpretation

The 2026-04-08 cal.com Level 2 re-run (commit `5861009` / `02b616e`) compared post-SI-003-fix findings to the pre-fix baseline and reported:

- 6 file-not-found false positives eliminated (SI-003 fix validated)
- 5 "newly-visible" `search string not found` findings that were not present in the baseline

The **initial interpretation** of those 5 newly-visible findings was: *"real F9 evaluations on edits that the buggy SI-003 reconstruction was implicitly masking; when the spurious file-missing failures dropped, the F9 gate stopped short-circuiting and started seeing the next layer of edit content. They are now-visible findings that need normal triage."*

The **corrected interpretation** is: all 5 of those newly-visible findings are a new scanner artifact class, not revealed-real agent findings. The SI-003 fix eliminated one bug class (create-then-modify false positives) and the resulting cleaner scan output revealed a **second bug class in the same code region** (modify-then-modify false positives) that the first bug had been masking. SI-003 did not cause SI-006; it simply stopped hiding it.

The cal.com validation's "F9 dropped from 26 to 25" headline number is unchanged, but the narrative should now read: "SI-003 eliminated 6 file-not-found FPs, SI-006 contributed 5 search-string-not-found FPs, net -1 F9 finding, scanner credibility on this specific bug class is partially — not fully — closed." This is a weaker statement than the original claim and the incident log should reflect that honestly.

### Symptom

F9 reports `search string not found` on a file in a multi-commit PR, where the failing search string matches content that *was added by an earlier commit in the same PR*. At the commit the scanner evaluates against (the parent of the earliest commit), the search string does not exist yet — it's part of the earlier commit's patch content. The F9 gate is correctly evaluating the search string against the provided base state; the base state is wrong for sequential modifications.

**5 confirmed occurrences** (all cal.com, all Devin, all multi-commit, all `modified` + `modified` with no `added` rows for the failing file):

| PR | File | Same-file commit count | Title |
|---|---|---|---|
| 3164956727 | `.github/workflows/pr.yml` | 2 (modified × 2) | feat: implement unit test code coverage with CLI and GitHub Actions integration |
| 3162624847 | `packages/lib/__tests__/autoLock.test.ts` | 2 (modified × 2) | feat: add warning threshold for autoLock with email notifications |
| 3177753579 | `packages/trpc/server/routers/viewer/slots/util.ts` | 2 (modified × 2) | feat: optimize slot generation with inverted algorithm |
| 3179554058 | `packages/trpc/server/routers/viewer/slots/util.ts` | 3 (modified × 3) | feat: optimize slot calculation performance for team event types |
| 3161649548 | `apps/api/v2/src/ee/bookings/2024-08-13/bookings.module.ts` | 2 (modified × 2) | feat: framework-agnostic googleapis caching layer |
| 3224857167 | `packages/trpc/server/routers/viewer/ooo/outOfOfficeCreateOrUpdate.handler.ts` | **9** (modified × 9) | feat: refactor Deel app to OAuth integration with automatic time-off creation |

PR 3224857167 is the extreme case: the agent touched `outOfOfficeCreateOrUpdate.handler.ts` across nine sequential commits, each modifying content the previous commit had introduced. The scanner concatenates all nine modification patches and evaluates the resulting `Edit[]` against the parent of the earliest commit. The probability that all nine search strings exist at that base state is essentially zero.

### Root cause

Three components were checked and ruled out before the actual root cause was located:

1. **The SI-003 Option C filter in `filterCommitsForSI003()`** — CORRECT for its scope. It drops modification commit rows only for files that have at least one `added` row in the same PR (the create-then-modify pattern). For files that are only ever `modified`, the filter passes all rows through unchanged. The 5 SI-006 cases have zero `added` rows for the failing files, so the SI-003 filter correctly does nothing to them. This is not an SI-003 regression; it is a different bug in the same code region.

2. **`parseDiff()` in `src/parsers/git-diff.ts`** — CORRECT. Each commit's patch is parsed independently and produces the correct `Edit[]` relative to the commit boundary the patch was generated against. parseDiff has no knowledge of sequential commits and doesn't need any — the bug is in how the scanner composes multiple commits' patches into a single diff, not in how parseDiff reads any individual patch.

3. **`runSyntaxGate()` in `src/gates/syntax.ts`** — CORRECT. F9 evaluates each edit's search string against the repo state at the provided base commit. When the scanner provides the parent of the earliest commit as the base state, F9 correctly reports "search string not found" for any edit whose search string was added by a later commit in the same PR. The gate is doing its job; it is being fed the wrong base state for the later edits.

The actual bug is in **`scanPR()` in `scripts/scan/level2-scanner.ts`** at the same diff reconstruction step as SI-003 (lines ~305-320 post-unification in the `filteredCommits.filter(c => c.patch).map(...)` block):

```typescript
const diff = filteredCommits
  .filter(c => c.patch)
  .map(c => {
    const isNew = c.status === 'added';
    const header = isNew
      ? `diff --git a/${c.filename} b/${c.filename}\nnew file mode 100644\n--- /dev/null\n+++ b/${c.filename}\n`
      : `diff --git a/${c.filename} b/${c.filename}\n--- a/${c.filename}\n+++ b/${c.filename}\n`;
    return header + c.patch;
  })
  .join('\n');
```

The scanner concatenates all commits' patches into a single unified diff and then evaluates the whole batch against `sha~1` of the earliest commit. This is correct when each file in the PR has at most one modification commit. It is **incorrect when the same file has multiple modification commits** because the second commit's patch was generated against the state *after* the first commit's patch was applied, not against the earliest commit's parent. F9 then reports false "search string not found" for any later modification whose search context was introduced by an earlier modification.

PR semantics require **sequential application** of commits when multiple commits touch the same file. The scanner's concatenate-and-evaluate-at-base approach is correct for create-then-modify only when SI-003's filter drops the modifications (because the file is marked `added`). It is incorrect for modify-then-modify because no `added` marker exists and the SI-003 filter does nothing.

This is the **same structural problem as SI-003** (sequential-commit assumption failure in `scanPR()`'s diff reconstruction) on an **adjacent but distinct operator** (`modified` + `modified` instead of `added` + `modified`).

### Trigger

Any PR meeting all of:
- Multiple commits (`pr_commit_details.jsonl` shows ≥2 distinct SHAs for the PR)
- At least one file modified in two or more commits
- None of those commits is marked `added` for that file (if any `added` row exists, SI-003's filter intercepts)
- The later modification's `search` string includes content introduced by the earlier modification's `replace` string

Most common in:
- **Devin PRs** — all 5 confirmed cases are Devin, which favors many small commits per PR and frequently revises the same file across commits
- **Large refactor PRs** — incremental rewrites that touch the same file repeatedly (all 6 cal.com affected PRs are refactor/feat labels on files being heavily reworked)
- **Any agent workflow that commits after each change** rather than squashing before submitting a PR

### Relationship to SI-004b

SI-004b was documented on 2026-04-08 with a "suspected shared root cause family with SI-003" cross-check note, pending re-run of total-typescript-monorepo after SI-003 landed. With SI-006 now identified, SI-004b's classification should be re-evaluated. The `lockfileVersion`-on-`package.json` findings that define SI-004b could belong to any of three families:

- **SI-003 family (create-then-modify):** package.json is created or deleted alongside lockfile changes in the same PR, with edit-content mismatch caused by the same concatenation mechanism SI-003 addresses
- **SI-006 family (modify-then-modify):** package.json is modified multiple times in the PR, and the scanner's concatenation places lockfile content under a package.json header
- **A third adjacent bug** in the same `scanPR()` code region that neither SI-003 nor SI-006 captures

The total-typescript re-run was recommended in the SI-004b entry as the cross-check; that recommendation still stands but the interpretation now has three possible outcomes instead of two. **Do not re-classify SI-004b until the total-typescript re-run produces evidence.**

### Fix candidates

**NOT YET APPLIED — documentation only until operator approves a fix path.** SI-006 is filed as a documented-not-fixed entry following the same discipline as SI-003's original writeup.

**Option A — Sequential apply:** In `scanPR()`, group edits by commit SHA. Run F9 incrementally — apply commit 1's edits to a temporary working tree, then check commit 2's edits against the modified tree, etc. Most accurate but ~Nx slower per PR (where N is the commit count), and requires checkout/apply/restore cycles per commit. Would resolve both SI-003 and SI-006 with a single mechanism change. **Not recommended** — same performance concerns as SI-003's rejected Option B (cal.com scan would grow from 3:42 to ~20-40 min).

**Option B — Drop-or-accept:** In `scanPR()`'s diff reconstruction, detect when a file has multiple `modified` rows in the same PR and either drop all-but-the-first modification (losing visibility into what the later commits did) or accept the false positives and mark F9 findings on those files as "suspected scanner artifact, review manually." Fast but sacrifices either accuracy or automation. **Not recommended** — the "accept false positives" path is exactly what this incident log is fighting, and the "drop later modifications" path has a silent accuracy loss that's hard to detect post-hoc.

**Option C — Extend the status-aware filter to handle modified-modified sequences (recommended):** Extend `filterCommitsForSI003()` (or introduce a sibling `filterCommitsForSI006()`) to track per-file commit ordering. For each file with multiple `modified` rows in the same PR, keep only the **first** commit's modification and drop subsequent ones. Uses information already in the dataset, doesn't change gate semantics, doesn't slow down scanning. Implementation is roughly 10-15 lines extending the existing filter.

**Subtle tradeoff in Option C that should be named explicitly:** for files where commit 2 is the one that actually matters — as in `autoLock.test.ts` above, where commit 2 extends the test file with additional test cases that commit 1's patch laid groundwork for — verify will no longer see commit 2's additions. The agent's later edits become invisible to the scanner. This is an accuracy loss, but it is a **known accuracy loss with a named failure mode** rather than a silent false positive that contaminates the finding pool. A false negative on a later commit is strictly better than a false positive that looks like a real finding, because false negatives are correctable when discovered and false positives erode the scanner's credibility in unrecoverable ways.

**Why C over A/B:** C mirrors SI-003's Option C reasoning — use data already in the dataset, preserve scan speed, accept a narrow and named accuracy loss to eliminate a false positive class. Same pattern, same tradeoff, same code region. The symmetry is what makes C the right answer: if SI-003's Option C was the right call (and the validation re-run confirmed it eliminated the 6 file-not-found FPs cleanly), then SI-006's Option C is the right call for the structurally analogous bug.

**Recommended implementation:** extend the existing `filterCommitsForSI003()` function in `scripts/scan/level2-scanner.ts` to handle both cases in a single pass, and rename it to `filterCommitsForSequentialAssumptions()` or similar. The two filters share the same pre-computation step (a `Map<filename, status[]>` keyed on filename) and can produce a single unified `filteredCommits` output. Alternatively, keep them as separate functions for clarity. Implementation detail, not a spec decision.

### Tests (pending fix)

Once the fix is applied, regression tests should:
- Reproduce a synthetic two-commit PR where commit 1 modifies `foo.ts` to add `function A()` and commit 2 modifies `foo.ts` to add `function B()` right after `function A()` (commit 2's search string contains `function A()` which doesn't exist at commit 1's parent)
- Assert F9 does NOT produce `search string not found` for commit 2's edit (the filter drops it)
- Assert the agent's work on commit 1 is still evaluated (positive control — commit 1's modification is not dropped)
- Reproduce a three-commit variant where all three commits modify the same file; assert only commit 1 survives the filter
- Positive control: assert legitimate `search string not found` findings on single-commit modifications still fire

### Detection going forward

If a Level 2 scan produces F9 `search string not found` findings on files in multi-commit PRs, check whether the same file appears with `status: "modified"` in two or more distinct commit SHAs in that PR. Scriptable check:

```bash
grep -F "<filename>" ~/datasets/aidev-pop/pr_commit_details.jsonl | \
  jq -r 'select(.pr_id == <pr_id_number>) | "\(.sha[0:8]) \(.status)"' | \
  sort | uniq -c | sort -rn
```

If the output shows 2+ `modified` rows for the same filename in the same PR with no `added` rows, the finding is likely SI-006. A stronger signal: check whether the failing search string matches content in an earlier commit's `replace` patch — if so, the diagnosis is definitive.

### Impact estimate

5 confirmed occurrences on the 42-PR cal.com post-fix re-run (~12% of scanned PRs, comparable to SI-003's pre-fix rate of ~19%). The cal.com numbers suggest SI-006 affects a similar population shape as SI-003 — Devin-heavy monorepos with incremental commit practices. Single-commit PRs are unaffected. Estimate: SI-006 affects 10-20% of F9 findings on Devin-heavy repos, near 0% on Copilot/Codex-heavy repos.

Combined with SI-003 (now fixed) and SI-006 (now documented), an **upper-bound estimate suggests that 25-40% of pre-fix F9 findings on Devin-heavy monorepo populations may be sequential-commit assumption failures, not real agent fabrications, pending confirmation via fixes to both bug classes and re-validation.** This estimate is **based on two measurement points from a single codebase** (SI-003 at ~19% of the pre-fix cal.com scan, SI-006 at ~12% of the post-SI-003-fix cal.com scan), and should not be extrapolated to other repositories or agent populations without independent measurement. This is a significant fraction of the F9 signal on Devin-heavy populations and has implications for any future claims about "how often agents fabricate edits" that lean on Level 2 F9 statistics from such populations.

### Surfaced by

N1 experiment ground truth audit on 2026-04-09. The audit was designed to classify the 5 "newly-visible" cal.com findings from the 2026-04-08 post-fix re-run as real fabrications or scanner artifacts before using them as seed data for the N1 convergence proof experiment. All 5 were confirmed as SI-006. Without the pre-experiment audit, the 5 cases would have been used as N1 input, the N1 experiment would have produced meaningless convergence data (neither raw nor governed loops can make a scanner false positive go away), and the "corrupted dataset" failure mode would have been attributed to `govern()` weakness rather than the scanner bug.

This is the **fourth time** scanner output has revealed a scanner bug rather than an agent bug (following SI-001, SI-003, SI-004a, and now SI-006). SI-002 was a different class — it was discovered by operator inspection of why the pipeline was producing no output, not by the scanner producing anomalous output. The pattern across the four SI-001/003/004a/006 cases holds: the only way to find scanner bugs that produce wrong output is to run the scanner on diverse production data *and* to triage the output honestly. The N1 pre-experiment audit was the discovery path in this instance.

---

**Cluster note updated.** The sequential-commit assumption is a family of bugs in `scanPR()`'s diff reconstruction, not a single bug. SI-003 addressed the create-then-modify variant; SI-006 documents the modify-then-modify variant; SI-004b's classification is pending a total-typescript re-run that may reveal a third variant or place SI-004b into one of the existing two. Any future fix should consider whether a unified sequential-commit-aware reconstruction is worth the complexity, or whether the patchwork of status-aware filters (one per variant) is the right shape given that each variant has slightly different semantics.
