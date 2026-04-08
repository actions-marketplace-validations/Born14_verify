# Scanner Incidents

A catalog of scanner resilience bugs discovered during real-world Level 2/3 scans, with diagnosis, fix, and detection method for each.

**Scope:** This file is about **scanner bugs** — situations where the scanner itself failed to make progress, hung, crashed, or produced wrong output due to its own implementation. It is **not** about agent failure shapes (those live in `FAILURE-TAXONOMY.md`).

**Naming:** Incidents use the prefix `SI-` (Scanner Incident) and are numbered sequentially. Each entry is a 60-second read with diagnosis, fix, and detection method in one place.

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
**Status:** documented, no fix applied

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

## SI-004 — Serialization gate misfire on lockfile content routed to package.json path

**Date:** 2026-04-08
**Severity:** medium — produces false serialization findings on PRs that touch lockfiles, via a path/content mismatch in the scanner's edit reconstruction
**Discovered during:** cal.com Level 2 (commit `cedf388`) and total-typescript-monorepo Level 2 (commit `38b28b7`) cross-scan triage
**Triaged by:** Pattern recognition across two independent scans on different agent populations
**Status:** documented, **root cause hypothesis pending investigation** — three layers candidate but not yet ruled out

### Symptom

The serialization gate produces `JSON Parse error: Unexpected identifier "<token>"` failures on file paths that legitimately contain JSON (e.g., `package.json`, `.json` configs), but the parse-error token names a lockfile-specific field that does NOT belong in the named file type.

**5 confirmed occurrences across 2 scans:**

cal.com Level 2 (1 occurrence):
- PR 3174617673 (Devin, "feat: add circular dependency check to CI workflow") — serialization gate fired on `.github/workflows/all-checks.yml` with `JSON Parse error: Unexpected identifier "name"`. The file is YAML, not JSON; `"name"` is a top-level GitHub Actions workflow key.

total-typescript-monorepo Level 2 (4 occurrences):
- PR 3192275043 (Cursor) — serialization on `apps/internal-cli/package.json`, error `JSON Parse error: Unexpected identifier "lockfileVersion"`
- PR 3192276530 (Cursor) — same path, same error: `lockfileVersion`
- PR 3196991617 (Cursor) — same path, same error: `lockfileVersion`
- PR 3196925778 (Cursor, classified `low`) — `PHASE_1_COMPLETION_REPORT.md` with same `lockfileVersion` error (wrong file type entirely — Markdown)

`lockfileVersion` is the top-level field of `package-lock.json`, `pnpm-lock.yaml`, and `yarn.lock`. It does NOT appear in `package.json`. The fact that the parser is finding it inside a `package.json`-named edit means the **content of the edit** is lockfile content, not package.json content.

### Hypothesis (NOT yet investigated)

Per the SI-003 lesson — "when a diagnostic narrows to a specific gate output, the cause may be in the input pipeline that fed the gate, not in the gate itself" — three candidate layers need to be ruled out before naming the actual bug:

1. **`generatePredicates()` in `scripts/scan/level2-scanner.ts` (lines ~221-227)** — possibly emitting `serialization` predicates on the wrong file type. Code at the time of writing:

   ```typescript
   for (const edit of edits) {
     const lower = edit.file.toLowerCase();
     if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
       predicates.push({ type: 'serialization', file: edit.file, comparison: 'structural' });
     }
   }
   ```

   The generator already does NOT emit serialization for `.md` files, so the `PHASE_1_COMPLETION_REPORT.md` finding **cannot come from this path** unless the upstream `edit.file` value is itself wrong.

2. **`parseDiff()` in `src/parsers/git-diff.ts`** — possibly producing edits with the wrong `file` field. If the diff reconstruction concatenates multiple commits' patches and a subsequent `diff --git` header isn't recognized, two file's contents can flow into one Edit object's `replace` string.

3. **`scanPR()` in `scripts/scan/level2-scanner.ts` diff reconstruction (lines 305-315)** — same suspect as SI-003. The function reconstructs each commit's diff with synthetic headers and concatenates. If the dataset has two commit_details rows where one has `filename: "package.json"` and the next has `filename: "package-lock.json"`, the concatenated diff might place lockfile patch content under the package.json header. **This is the most likely candidate** because:
   - It's the same code path that caused SI-003
   - It explains both the cal.com YAML case (workflow file path with workflow content but parsed as JSON because the predicate generator only checks file extension) and the total-typescript lockfile case (package.json path with lockfile content)
   - The `.md` finding fits if the diff reconstruction produces an edit with `file: 'PHASE_1_COMPLETION_REPORT.md'` whose `replace` content contains lockfile fragments — possible if a single commit_details entry has cross-contaminated data

The above is **hypothesis only** — none of the three layers has been verified by code read or isolation test tonight. SI-004 is filed as documentation pending investigation.

### Trigger (suspected)

PRs that touch BOTH a lockfile AND a similarly-named JSON file in the same edit batch. Common in:
- Dependency updates (`pnpm install` modifies both `package.json` and `pnpm-lock.yaml`)
- Workspace setup PRs (multiple `package.json` files plus their lockfiles)
- Monorepo lockfile sync PRs

The 4 cal.com YAML occurrence is a different variant — workflow file with workflow content, parsed as JSON because the predicate generator includes `.yml` in its serialization trigger set. **This may be a separate bug or the same bug with a different surface.** Investigation should distinguish them.

### Related observation — gates firing on Markdown files

In addition to the serialization-on-`.md` finding above (PR 3196925778), the total-typescript scan also produced an **access gate finding on a `.md` file**:

- PR 3192645075 (Cursor, classified `low`) — `ALONGSIDE_FLAG_FEATURE.md` with `1 error(s), 0 warning(s): 1× path traversal`

The access gate's `path_traversal` check should not be running against Markdown content. Either:
- The auto-predicate generator is not the source (it doesn't gate predicates on file extension for security/access — those run on every code file)
- The access gate's `scanSystemPaths` function is matching on a `/var/`, `/etc/`, or `..` substring inside the Markdown text content, which is content-not-context-aware
- Or the diff parser is producing an edit with `file: 'ALONGSIDE_FLAG_FEATURE.md'` whose `search`/`replace` contains code-like content from a different real file

This is the **same theme as SI-004**: gates firing on file types they shouldn't, possibly because the `edit.file` value doesn't match the actual `edit.replace` content. If SI-004's root cause turns out to be the `scanPR()` diff reconstruction, this access-on-Markdown observation would be the same bug surfacing on a different gate. **Treating as a related observation, not a separate incident, until investigation confirms.**

### Fix candidates

**NOT YET PROPOSED — investigation required first.** SI-004 is documented as a hypothesis-pending-investigation entry. Three things need to happen before fix candidates can be drafted:

1. **Reproduce the bug in isolation.** Pick one of the 5 occurrences (recommend PR 3192275043 — Cursor, total-typescript, only 5-10 commits to inspect) and run an isolation test that:
   - Loads the PR's commits from `pr_commit_details.jsonl`
   - Reconstructs the diff exactly as `scanPR()` does
   - Calls `parseDiff()` and prints the resulting `Edit[]` for inspection
   - Checks whether any edit's `file` field disagrees with its `replace` content type

2. **Rule out the three candidate layers** (predicate generator, diff parser, scanner reconstruction) with code reads + isolation evidence, same protocol as SI-003.

3. **Identify the actual bug location** and propose fix options A/B/C with tradeoffs.

Once those three steps are done, write a "Fix candidates" section into this entry following the SI-003 pattern.

### Tests (pending root cause)

Once the bug is located and fixed, regression tests should:
- Reproduce a synthetic multi-file PR where one commit modifies `package.json` and another modifies `package-lock.json`
- Assert the resulting edits have correct `file` ↔ `replace` correspondence (no cross-contamination)
- Assert the serialization gate does not fire `lockfileVersion` errors on `package.json`
- Positive control: assert legitimate JSON parse errors on actually-malformed package.json still fire

### Detection going forward

If a Level 2 scan produces serialization findings with `JSON Parse error: Unexpected identifier "lockfileVersion"`, that is the SI-004 pattern. Scriptable check:

```bash
cat ~/verify-l2/data/aidev-scan/level2/batches/<repo>.jsonl | jq -r 'select(.findings[]?.gate=="serialization") | .pr_id + " " + (.findings[] | select(.gate=="serialization") | .detail)' | grep lockfileVersion
```

If the count is non-zero, SI-004 is firing on this scan.

### Impact estimate

5 occurrences across 2 scans (cal.com 1, total-typescript 4) over a combined 96 scanned PRs. Roughly 5% of scanned PRs hit this class on agent populations that touch lockfiles. The 0% rate on remix-forms (54 PRs scanned) is consistent with remix-forms being a small library that doesn't routinely modify lockfiles in agent PRs.

Across the AIDev-POP dataset, dependency-update and workspace-setup PRs are common in:
- **Cursor PRs** — Cursor has high lockfile-touch rates per PR
- **Devin PRs** — particularly on monorepo refactor PRs
- **Codex PRs** — lower rate, library-focused PRs touch lockfiles less often

Estimate: SI-004 affects 2-10% of serialization findings on lockfile-heavy repos, near 0% on small libraries.

### Surfaced by

cal.com Level 2 (1 occurrence, originally classified as "Candidate 4 — held below threshold") + total-typescript-monorepo Level 2 (4 occurrences, pushing total above threshold). Same flywheel pattern as SI-003: a single-occurrence anomaly was held in scratch from the first scan, then a second scan on a different agent population produced 4 more occurrences of the same shape, promoting the pattern from "noise" to "incident."

This is the **third time on 2026-04-08** that scanner output revealed a scanner bug, not an agent bug. SI-001 (catastrophic regex), SI-002 (silent shape drop in discover-shapes), SI-003 (multi-commit PR FP), and now SI-004 (serialization-on-lockfile-content path mismatch). Pattern: real production scans surface scanner resilience bugs that are invisible to synthetic test suites because the test suites don't include the specific shape of bad input that triggers them. Lesson: the only way to find scanner bugs is to run the scanner on diverse production data.
