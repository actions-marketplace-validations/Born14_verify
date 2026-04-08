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
