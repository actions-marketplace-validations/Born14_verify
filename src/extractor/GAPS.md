# Open Gaps — Predicate Extractor

Filed during the unified extractor consolidation on 2026-04-09. These are
product questions discovered during the refactor that are not urgent but
should not be forgotten. Remove entries from this file as they are resolved.

The refactor that surfaced these gaps was deliberately shape-neutral — it
consolidated four disjoint extraction paths (`extractDiffPredicates`,
`extractCrossFilePredicates`, `extractIntentPredicates`, scanner
`generatePredicates`) into `src/extractor/` without changing behavior. Every
gap below was present before the refactor; the refactor made them visible
by concentrating the extraction logic in one place where patterns could be
compared side by side.

---

## 1. Absent-predicate consumer path is half-built

Tier 1 (`tier1Diff`) and Tier 2 (`tier2Context`) emit predicates with
`expected: 'absent'` to assert that removed content should NOT exist
post-edit and that cross-file references to a removed identifier should
also be gone. The emission path is live.

The consumer path is not. `src/action/index.ts` at lines 86 and 96 drops
these predicates with a filter:

```typescript
predicates.push(...diffPreds.filter(p => p.expected !== 'absent'));
```

The comment in `pr-predicates.ts` before the refactor said the downstream
machinery — "this predicate passing means the pattern is absent, which is
good" — was the caller's responsibility via an `expectedSuccess=false`
mechanism that was never wired. The tier still emits absent-expectation
predicates, the action still drops them, and no gate ever sees them.

**Decision needed:** wire the consumer (invert the success check for
absent-expectation predicates in the gate dispatch) or stop emitting them
at the tier level. Both are legitimate; the current state is neither.

## 2. `filesystem_exists` has two semantic modes

`tier1Diff` emits `{ type: 'filesystem_exists', file }` for files that are
NEW in the edit batch (`!edit.search && edit.replace`) — asserting the
file should exist AFTER the edit (post-creation assertion).

`tier4Static` emits `{ type: 'filesystem_exists', file }` for files that
are being MODIFIED (`edit.search` is non-empty) — asserting the file
should exist BEFORE the edit (pre-edit existence check).

The filesystem gate does not distinguish between these two semantic modes.
It simply checks existence at the time it runs. The two emissions work
today because both "pre" and "post" states of an extant file are the same
(the file exists), and the gate runs at a moment when both assertions can
be checked against the current filesystem state.

This is fragile. If the gate ever needs to distinguish — for example, if
it were extended to handle race-condition assertions, or if a future tier
needed to say "this file must exist at the moment of the edit being
applied, not at gate run time" — the current type would conflate real
distinctions.

**Decision needed:** introduce a `when?: 'pre-edit' | 'post-edit'`
discriminator on `FilesystemExistsPredicate` (a form of discriminated
union), OR split into two separate predicate types
(`filesystem_exists_pre` and `filesystem_exists_post`), OR declare
the current ambiguity intentional and document it in `REFERENCE.md`.
This decision is blocked on the discriminated-union refactor (gap #6).

## 3. Tier 1 and Tier 4 use divergent code-extension sets

The security-predicate gate in both tiers is guarded by a code-file check.
The two code-extension sets are different:

- **Tier 1** (`src/extractor/tier1-diff.ts`):
  `{ .js, .ts, .jsx, .tsx, .mjs, .cjs, .py, .rb, .php }`
- **Tier 4** (`src/extractor/tier4-static.ts`):
  `{ js, ts, py, rb, go, rs, java, php, mjs, cjs, jsx, tsx }`

Tier 1 has `.mjs` and `.cjs` that Tier 4 lacks. Tier 4 has `go`, `rs`,
`java` that Tier 1 lacks. Neither is a superset of the other. A PR
touching `server.go` would trigger security predicates from Tier 4 but
not Tier 1. A PR touching `service.cjs` would trigger from Tier 1 but not
Tier 4.

The divergence was preserved exactly by the refactor because merging the
sets would be a behavior change — some callers would see more security
predicates, some would see fewer, and the rescoped plan forbade behavior
changes on the consolidation branch.

**Decision needed:** reconcile to a single canonical set. Options:
(a) the union of both sets (more security scanning, slightly more false
positives), (b) the intersection (less noise, some files stop being
scanned), (c) explicit per-tier purpose (Tier 1 for diff-based analysis
where .mjs/.cjs matter for module context, Tier 4 for scan-time where
compiled languages matter — which is the current de facto state), or
(d) move the extension list into a shared constant in
`src/extractor/shared/` and have both tiers reference it.

## 4. Token helpers duplicated across Tier 1 and Tier 2

`findUniqueSubstrings()` and `extractTokens()` are byte-identical in
`src/extractor/tier1-diff.ts` and `src/extractor/tier2-context.ts`.
The duplication is **deliberate**, not accidental: the tier-independence
discipline — "no tier imports from another tier" — was chosen over DRY
because it preserves the ability for any future caller to pick tiers in
any composition without pulling in transitive dependencies.

If a third consumer ever legitimately needs these helpers (e.g., a
future `tier5` or a benchmark harness that does its own token analysis),
extract them into `src/extractor/shared/tokens.ts` at that point. Until
then, two copies of ~50 lines is cheaper than a premature abstraction.

**No decision needed today.** This entry exists only so a future reader
who notices the duplication does not "fix" it by creating a shared
module that gets used by exactly one caller.

## 5. SCANNER-INCIDENTS.md has stale line references

`SCANNER-INCIDENTS.md` documents SI-003 and SI-004a with direct
references to `scripts/scan/level2-scanner.ts:221-227` and similar line
numbers. Those line numbers pointed at the old `generatePredicates`
body, which has been relocated to `src/extractor/tier4-static.ts` as
part of the consolidation.

The incidents themselves are historically correct — the bugs were
found, diagnosed, and fixed at those locations as of those commits.
But a reader who follows the line references today will find unrelated
code.

**Decision needed:** update the SI-003 and SI-004a entries to point at
the new location (`src/extractor/tier4-static.ts`, approximate lines),
OR leave the old references as historical pointers with a one-line
"moved to X in commit Y" annotation, OR adopt a convention where
SCANNER-INCIDENTS entries cite commits rather than file:line.

## 6. Predicate is a fat interface, not a discriminated union (LARGE)

This is the most important gap in the list and the one that blocks
several others.

### Current state

`src/types.ts` defines `Predicate` as a single flat interface with 16
literal `type` values and roughly 30 optional fields pooled across all
variants. Any field can appear on any variant at the type level. There
is no compile-time discrimination between, say, a `filesystem_exists`
predicate's `file` and a `db` predicate's `table` — both are optional
fields on the same interface.

The M3 refactor added a **weak exhaustiveness helper**
(`_exhaustivePredicateTypeCheck` in `src/types.ts`) that proves every
type literal in `Predicate['type']` is known at compile time. If a new
literal is added without a matching case, tsc flags it. This is the
best we can do without a real refactor.

### What a strong discriminated union would look like

Each `type` literal becomes its own interface extending a narrow
`PredicateBase`. Fields appear only on the variants that use them.
Consumers narrow with `p.type === 'filesystem_exists'` and the
compiler knows which fields are available. A gate can `switch (p.type)`
with an `assertNever` default, and adding a new variant produces
compile errors at every gate that consumes predicates.

### Why it wasn't done on this branch

The M3 code audit found **254 `as any` casts across 52 files**,
approximately 30–40 of which are predicate-field reads in
`src/gates/*`, `src/verify.ts`, and `src/store/*` that currently read
fields like `(p as any).source`, `(p as any).table`, `(p as any).count`
without narrowing on `p.type` first. Tightening the `Predicate` union
to a real discriminated union would make every one of these reads a
compile error until they are narrowed.

This triggered the rescoped plan's hard stop condition: "if fixing the
union cascades to more than 3–4 files outside `src/extractor/` and
`src/types.ts`, stop and report." The actual cascade is estimated at
10–15 files minimum, plus ~6 test files that construct predicates by
hand. The refactor was halted at the boundary as designed.

### What the follow-up branch needs to do

1. Full audit of all 26 gate files and `src/verify.ts` to enumerate
   every site that reads a predicate field without narrowing.
2. Decide which fields are truly cross-variant (currently `expected`,
   `description`, possibly `file`) and keep them on `PredicateBase`.
3. Move variant-specific fields (`table`, `securityCheck`, `perfCheck`,
   `a11yCheck`, etc.) to their respective variant interfaces.
4. Resolve the `source` name collision: it is currently used by
   `DBPredicate` (values: `'schema' | 'routes' | 'css' | ...`) and
   `HallucinationPredicate` (values: `'schema' | 'routes' | 'css' | file`).
   The two fields have overlapping but distinct valid values. Either
   rename one, or put separate fields on each variant with explicit
   names (`dbSource`, `halSource`).
5. Decide on field-tightening: should `ContentPredicate.file` be
   required (every current emitter passes it) or stay optional
   (safer, forces narrowing at consumption)?
6. Resolve gap #2 (`filesystem_exists` temporal modes) as part of
   the variant design, since a real variant interface is the natural
   place to add a `when` discriminator.
7. Add `assertNever` exhaustiveness checks to at least one gate that
   consumes a discriminated predicate, replacing the weak helper in
   `src/types.ts` with the strong form.
8. Update every consumer (gates, verify, store, decompose, test
   fixtures) to narrow correctly.
9. Run the full test suite and the cal.com Level 2 validation scan
   to confirm no behavioral drift.

### Scope estimate

Two to four focused days of work, bounded by how many gate files need
narrowing updates. The work is mechanical — read current cast, narrow
on `p.type`, replace cast with typed access — but it touches a large
number of files and requires careful validation because gates are the
enforcement layer. A regression here would produce wrong verdicts.

**Do not attempt this on an extractor-consolidation branch.** It is a
primary piece of work that deserves its own branch, its own PR review,
and its own operator decision about the field-tightening tradeoffs
above.
