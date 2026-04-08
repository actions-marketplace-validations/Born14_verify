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
