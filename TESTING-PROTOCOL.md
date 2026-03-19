# Verify Testing Protocol

How the self-test harness works, how to run it, and how to extend it.

## What This Is

An autonomous testing system for `@sovereign-labs/verify`. 56 scenarios across 7 families exercise the verification pipeline's invariants.

The harness is the constitution. Verify is the governed subject.

## Quick Reference

```bash
# Pure-only (no Docker, ~2s)
npx @sovereign-labs/verify self-test

# Full suite with Docker (~80s)
npx @sovereign-labs/verify self-test --docker

# Specific families
npx @sovereign-labs/verify self-test --families=A,B,G

# CI mode — exit 1 on bug-severity violations
npx @sovereign-labs/verify self-test --fail-on-bug
```

## The 7 Scenario Families

| Family | Count | Docker? | What It Tests | Key Bug Class |
|--------|-------|---------|---------------|---------------|
| **A** | 10 | No | Fingerprint collision detection | v0.1.1: HTTP predicates with different `bodyContains` producing identical fingerprints |
| **B** | 9 | No | K5 constraint learning (multi-step) | Constraint poisoning, scope leakage, false blocks |
| **C** | 7 | No | Gate sequencing and consistency | Gate ordering bugs, disabled gate leaks |
| **D** | 8 | No | G5 containment attribution | Attribution arithmetic (direct/scaffolding/unexplained) |
| **E** | 6 | No | Grounding validation | Grounding false negatives, fabricated selectors |
| **F** | 6 | Yes | Full Docker pipeline | End-to-end regressions (build → stage → verify) |
| **G** | 10 | No | Edge cases and robustness | Crash/hang on unicode, large inputs, nulls |

### Family A: Fingerprint Collision

Generates **pairs** of predicates differing in exactly one field. Oracle asserts `predicateFingerprint(a) !== predicateFingerprint(b)`.

- A1: HTTP status 200 vs 404
- A2: HTTP bodyContains "Alpha" vs "Beta"
- A3: http_sequence with different step orders
- A4: CSS with different expected values
- A5: Same type/selector, different path
- A6: Optional field present vs absent
- A7: DB predicates differing in table/assertion
- A8: Canonicalization traps (null vs undefined vs absent, type coercion)
- A9: Triplets + permutations (3 predicates, any 2 must differ)
- A10: Regression guard (v0.1.1 exact reproduction)

### Family B: K5 Constraint Learning (Multi-Step)

Ordered sequences of `verify()` calls sharing a constraint store. Tests the learning loop.

- B1: 3 failures → constraint count monotonically increases
- B2: Corrected predicate (different fingerprint) passes K5
- B3: Same fingerprint blocked after failure
- B4: Expired constraint does not fire
- B5: Constraints persist across store reload
- B6: Max depth enforcement (cap at 5)
- B7: Override bypass via `overrideConstraints`
- B8: Harness-fault failure (DNS error) does NOT seed constraints
- B9: Scope isolation — constraint for path /a doesn't block path /b

### Family C: Gate Sequencing

- C1: F9 failure prevents K5 from running
- C2: Same input twice → identical gate names and order
- C3: Disabled gates absent from results
- C4: Most gates disabled → only F9 runs
- C5: Every gate has `durationMs >= 0`
- C6: Every failed gate has non-empty detail
- C7: K5 failure prevents staging

### Family D: Containment (G5) Attribution

- D1: CSS edit + CSS predicate → direct
- D2: Content edit + content predicate → direct
- D3: Dockerfile edit → scaffolding
- D4: Unrelated file → unexplained
- D5: Mixed edits → correct attribution split
- D6: Route handler + HTTP predicate → direct
- D7: Migration file + DB predicate → direct
- D8: No predicates → all unexplained

### Family E: Grounding Validation

- E1: Real selector (h1) → grounded
- E2: Fabricated selector → `groundingMiss=true`
- E3: Mixed real + fabricated
- E4: HTML predicates exempt (creation goals)
- E5: Real class selector (.subtitle) → grounded
- E6: Content/HTTP/DB predicates exempt

### Family F: Full Docker Pipeline

Requires Docker. Builds the demo-app fixture, runs verify with real container lifecycle.

- F1: Valid CSS edit passes all gates
- F2: Nonexistent file fails at F9
- F3: HTTP with bodyContains passes
- F4: HTTP with wrong bodyContains fails
- F5: Health invariant passes
- F6: Full pipeline audit (metadata, timing, gate count)

### Family G: Edge Cases

- G1: Empty edit array
- G2: Empty predicate array
- G3: Search string >10KB
- G4: Unicode in selector/expected
- G5: Duplicate edits
- G6: No-op edit (search == replace)
- G7: Non-existent file target
- G8: Predicate with every possible field
- G9: Pipe/equals/newline in values
- G10: Explicit null/undefined in fields

## How Scenarios Are Created

Scenarios are **deterministic generators** in `scripts/harness/scenario-generator.ts`. Each generator returns a `VerifyScenario` with:

```typescript
interface VerifyScenario {
  id: string;                    // e.g., "A2_http_bodyContains_collision"
  family: ScenarioFamily;        // 'A' | 'B' | ... | 'G'
  generator: string;             // generator function name
  description: string;           // human-readable
  edits: Edit[];                 // file edits to apply
  predicates: Predicate[];       // predicates to verify
  config: Partial<VerifyConfig>; // gate config overrides
  invariants: InvariantCheck[];  // what to check after verify() runs
  requiresDocker: boolean;
  steps?: VerifyScenario[];      // for multi-step (B family)
  expectedSuccess?: boolean;
}
```

To add a new scenario:

1. Pick the family (or create family H if needed)
2. Write a generator function that returns a `VerifyScenario`
3. Add invariant checks — what must be true after `verify()` runs?
4. Register it in `generateFamily()` switch
5. Run `--families=X` to test in isolation

## The Oracle

Two invariant categories prevent confusion about whether verify is wrong or the harness is wrong:

**Product invariants** (verify is correct):
- `success` is boolean, `gates` is non-empty array
- If `success === true`, all gates passed
- Constraint count never decreases within a session
- Same predicate → same fingerprint (determinism)
- No individual gate > 5 minutes
- First failing gate is the reported failing gate

**Harness invariants** (self-test is correct):
- `verify()` completes without throwing
- Temp state dirs cleaned up
- Ledger append succeeds

**Severity levels:**
- `bug` — real defect (fingerprint collision, K5 false positive)
- `unexpected` — suspicious but possibly valid (gate took >30s)
- `info` — interesting observation

## Output Artifacts

All written to `data/` (gitignored):

| File | Contents |
|------|----------|
| `self-test-ledger.jsonl` | Per-scenario results (append-only) |
| `self-test-summary-{runId}.json` | Run summary with one-liner |

## Key Files

```
scripts/
  harness/
    types.ts                      # All shared types
    scenario-generator.ts         # 7 families of generators
    oracle.ts                     # Invariant checks
    runner.ts                     # Orchestrator (pure, multi-step, Docker phases)
    ledger.ts                     # JSONL persistence
    report.ts                     # Console output + summary
fixtures/
  demo-app/                       # Test fixture (server.js, Dockerfile, etc.)
src/                              # The governed subject (what gets tested)
data/                             # Runtime artifacts (gitignored)
```
