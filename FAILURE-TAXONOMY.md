# Verify Failure Taxonomy

A finite, composable algebra of failure shapes — every known way that a predicate can produce wrong results. Either passing when it should fail (false confidence), or failing when it should pass (false rejection). Every shape is a generator target.

**See also:** [PARITY-GRID.md](PARITY-GRID.md) — the strategic map. This file is the dictionary. The grid drives priorities; this file provides depth. Every shape should reference its grid cell (Capability × Failure Class).

**Why this matters:** Verify gets better by closing failure classes, not by bigger models. Each generator produces 2-50 scenarios from one failure shape. This taxonomy is the map of what's been closed and what's still open.

**Coverage formula:** `(shapes with generators / total known shapes) = coverage %`

---

## Foundational Framework

### The Failure Algebra

This taxonomy is not a test suite. It is a **finite, composable set of failure shapes** — the "periodic table" of ways reality can be misrepresented to a verification system. Like chemical elements, these shapes are:

- **Finite:** There is a bounded number of ways a predicate can disagree with reality
- **Composable:** Multi-surface failures are products of single-surface shapes (C-07 × P-02 = "case-normalized CSS passes but HTTP body check is case-sensitive")
- **Enumerable:** New bugs map to existing shapes or extend the taxonomy cleanly (closure property)
- **Surface-bound:** Every shape lives on exactly one reality surface, or explicitly crosses surfaces
- **Decomposable:** New bugs must first attempt decomposition into existing shapes before creating a new shape (closure enforcement)

### Three Axioms

1. **A predicate is a claim about reality.** Every predicate asserts that some observable property of the system holds. The taxonomy enumerates ways this claim can be wrong.

2. **Evidence is surface-bound.** CSS evidence comes from `getComputedStyle()` or source parsing. HTTP evidence comes from `fetch()`. DB evidence comes from schema introspection. Each surface has its own evidence mechanism, its own failure modes, and its own resolution semantics.

3. **Verification is observation, not mutation.** The act of checking should not change the thing being checked. When it does, that's an Observer Effect failure (OE-*).

### Claim Taxonomy

Every predicate makes a claim. Claims are not all the same kind — they differ in what they assert about reality. Shapes that look surface-specific often share the same claim type across surfaces. This taxonomy ensures we don't miss entire failure classes just because they weren't framed as a surface problem.

| Claim Type | What It Asserts | Example Predicates | Failure Mode |
|-----------|----------------|-------------------|-------------|
| **Existence** | Something is present | `table_exists`, `filesystem_exists`, HTML `exists`, CSS selector grounding | Target absent, wrong identity, phantom presence |
| **Equality** | Observed value matches expected | CSS `color == green`, HTTP `status == 200`, DB `column_type == varchar` | Wrong value, wrong representation, normalization mismatch |
| **Absence** | Something is NOT present | `filesystem_absent`, content pattern NOT in file | Present when shouldn't be, different identity |
| **Containment** | A value appears within a larger structure | `bodyContains`, content `pattern`, HTML text content | Partial match, wrong context, substring false positive |
| **Ordering** | Elements appear in a specific sequence | `http_sequence` step order, HTML element ordering, migration order | Wrong order, missing step, concurrent reordering |
| **Transformation** | Input maps to expected output | CSS `calc()` → computed, `var()` → resolved, shorthand → longhand | Wrong resolution, context-dependent, intermediate state |
| **Invariance** | Property holds across all mutations | System invariants, `filesystem_unchanged`, preservation predicates | Side-effect violation, scope leak, delayed manifestation |
| **Threshold** | Value falls within acceptable bounds | Performance budgets, contrast ratios, response times | Boundary precision, measurement noise, environment variance |
| **Causal** | Action A produces effect B | HTTP POST creates resource, migration adds column, edit changes style | Correlation ≠ causation, delayed effect, side channel |

**Why this matters for exhaustiveness:** Each claim type has its own failure physics. Existence claims fail by identity confusion. Equality claims fail by representation mismatch. Containment claims fail by context confusion. If a surface has no shapes for a claim type it supports, that's a coverage gap — not because we haven't tested enough, but because we haven't thought about that claim type on that surface.

**Claim type × Surface = shape space:** The full shape space is the product of claim types that a surface supports. Not every surface supports every claim type (CSS doesn't have ordering claims, filesystem doesn't have threshold claims). But where they intersect, shapes should exist.

### Claim ↔ Evidence Binding

Every predicate creates a **claim-evidence pair**:

```
Claim:    "The element .roster-link has color: green"
Evidence: getComputedStyle(el).color === 'green'  (browser gate)
          OR source CSS block contains 'color: green'  (grounding gate)
```

A failure shape is a known way for this binding to break:

| Binding Failure | Example | Shape Class |
|----------------|---------|-------------|
| **Claim true, evidence false** | CSS shorthand `border: 1px solid red` → predicate checks `border-color` → grounding misses it | C-17 (shorthand resolution) |
| **Claim false, evidence true** | Pattern found in comment, not in code → predicate passes | N-06 (pattern in comment) |
| **Evidence stale** | File edited after grounding ran → grounding says exists, reality changed | TO-05 (cache staleness) |
| **Evidence from wrong surface** | HTTP 200 but response is error page HTML → bodyContains matches error text | P-23 (error page match) |
| **Evidence mechanism disturbs target** | HTTP verification call triggers rate limit → next real request fails | OE-05 (rate limit trigger) |
| **No evidence mechanism exists** | Predicate claims "animation completes smoothly" → no deterministic check possible | BR-23 (layout shift) |

### Time as an Orthogonal Axis

Time is **not a domain** — it is an **orthogonal axis** that modifies every surface. Every shape in the taxonomy has an implicit temporal assumption. When that assumption breaks, the failure is the product of the shape and the temporal mode.

**The temporal modes:**

| Temporal Mode | Assumption | When It Breaks |
|--------------|------------|----------------|
| **Snapshot** | Reality is static during verification | File changes between read and check (FS-28) |
| **Settled** | Async operations have completed | DOM not hydrated yet (TO-01, BR-21) |
| **Ordered** | Operations happen in specified sequence | Two predicates see different app states (TO-04) |
| **Stable** | Same check produces same result | Animation midpoint sampled (TO-07) |
| **Fresh** | Evidence reflects current state | Cached response returned (TO-05, P-57) |

**Every predicate implicitly carries a temporal mode.** The full identity of a failure is not just `(surface, shape)` but `(surface, shape, temporal_mode)`:

```
C-33 under Snapshot  = "CSS value mismatch" (normal)
C-33 under Settled   = "CSS value mismatch because transition hasn't completed"
C-33 under Fresh     = "CSS value mismatch because cached stylesheet served"
```

**The TO-* domain vs temporal axis:** The TO-* domain captures shapes where timing IS the primary failure mechanism — the surface-level claim is correct, but the evidence was gathered at the wrong moment. On other surfaces, temporal mode is a modifier — the surface-level claim itself is wrong, and timing is incidental. The distinction: if fixing the timing fixes the failure, it's TO-*. If fixing the timing just reveals a different surface-level failure, it belongs to the primary surface with a temporal annotation.

**Implication for generators:** Generators that produce timing-variant scenarios should annotate which temporal mode they exercise. A CSS generator that tests animation midpoint sampling is exercising `C-33 × Stable`, not just C-33. This annotation enables coverage analysis across the temporal axis independent of surface coverage.

### Composability: Multi-Surface Failures

Single-surface shapes compose into multi-surface failures. The algebra is **executable, not just descriptive** — composed failures have a formal representation and decomposition is the first step in classifying any new bug.

#### Composition Operators — IMPLEMENTED

**Product composition (×):** Surface A shape × Surface B shape = multi-surface failure. **Implemented** as `productComposition(shapeIdA, shapeIdB)` in `decompose.ts`. 6 known products (CSS×HTTP, CSS×HTML, HTML×Content, HTTP×DB, CSS×Content, HTML×HTTP) mapped via `PRODUCT_COMPOSITION_MAP`. Commutativity enforced via sorted domain-pair keys.
- C-07 (case normalization) × N-07 (case sensitivity) = CSS passes case-insensitively, content check fails case-sensitively on same value
- P-02 (body missing) × D-01 (table missing) = API returns empty because table doesn't exist, but HTTP predicate only checks status code

**Temporal composition (⊗):** Any shape ⊗ Temporal mode = time-dependent variant. **Implemented** as `temporalComposition(shapeId, mode)` in `decompose.ts`. All 5 modes supported (snapshot, settled, ordered, stable, fresh).
- H-01 (element not found) ⊗ Settled = element exists after hydration but not at check time

**Round-trip verification:** `decomposeComposition(result, predicates)` verifies closure — compose → decompose recovers original atomic components. All 6 product pairs verified via 50 tests, 145 assertions.

**Scope composition (⊘):** Any shape ⊘ Scope boundary = boundary-mismatched variant. Not yet implemented as an executable operator.
- D-03 (column type mismatch) ⊘ SC-03 (wrong environment) = column type correct in dev, different in prod

#### Composed Failure Representation

A composed failure is represented as an array of component shapes, not a single shape ID:

```typescript
// Single-surface failure
{ shapes: ["C-33"], surface: "css" }

// Multi-surface failure (product)
{ shapes: ["P-07", "TO-05", "I-04"], surfaces: ["http", "temporal", "interaction"] }

// Temporal variant
{ shapes: ["C-33"], surface: "css", temporal: "Settled" }

// Full composition
{ shapes: ["C-07", "N-07"], surfaces: ["css", "content"], temporal: "Snapshot", scope: "local" }
```

#### Decomposition-First Rule

**New bugs must attempt decomposition before creating a new shape.** This is the enforcement mechanism for closure:

1. **Decompose:** Can this failure be expressed as Shape A × Shape B (× Shape C...)? If yes → classify as composed failure, do not create new shape.
2. **Reduce:** Can this failure be reduced to an existing shape on a different surface? If yes → classify under existing shape.
3. **Extend:** Only if decomposition and reduction both fail → create a new atomic shape.

The Interaction domain (I-*) captures **frequently observed** compositions that deserve their own tracking. An I-* shape is a composition that occurs often enough in practice to warrant a generator — but it remains decomposable into its component shapes. The I-* ID is a convenience label, not a new atomic element.

#### Implications for Generators

Generators should be able to produce composed scenarios, not just single-shape scenarios:

- **Atomic generators** produce scenarios testing one shape in isolation
- **Composition generators** produce scenarios testing known shape products (I-* shapes are exactly these)
- **Temporal variant generators** produce scenarios testing shapes under non-default temporal modes

The taxonomy does NOT enumerate all products — that would be combinatorial explosion (567 × 567 = 321K pairs). Instead, the Interaction domain captures observed compositions, and the algebra explains how to recognize new ones.

### Closure Discipline

The taxonomy is **closed** when any new bug maps to existing shapes (atomic or composed) rather than requiring a new primitive. Closure is the system's most important long-term property — without it, the taxonomy grows without bound and becomes a list, not an algebra.

**Closure criteria (all three must hold):**

1. **Shape closure:** A new failure is either (a) an instance of an existing shape, (b) a **composition** of existing shapes (decomposition-first rule), or (c) a genuinely new shape that extends the taxonomy
2. **Surface closure:** A new predicate type either maps to an existing surface or introduces a new surface with its own failure shapes
3. **Gate closure:** A new gate either inherits failure shapes from existing gates or introduces gate-specific shapes in the cross-cutting section

**The decomposition-first rule (enforced, not advisory):**

When classifying a new bug:

```
Step 1: Can it decompose into Shape A × Shape B?        → composed failure, no new shape
Step 2: Can it reduce to existing shape on new data?     → classify under existing shape
Step 3: Is it a temporal variant of existing shape?       → annotate temporal mode, no new shape
Step 4: Is it a scope variant of existing shape?          → annotate scope, no new shape
Step 5: Does it require a new claim↔evidence binding?    → new atomic shape (extend taxonomy)
```

Only Step 5 creates a new shape. Steps 1-4 are **reductions** that keep the taxonomy bounded.

**When to extend vs. when to classify:**
- If the failure mechanism is identical to an existing shape but on different data → classify under existing shape
- If the failure mechanism is new (new way for claim↔evidence binding to break) → new shape
- If the failure crosses surfaces in a way no existing interaction shape captures → new I-* shape (but it remains decomposable)
- If the failure requires a new reality surface (new evidence mechanism) → new domain section
- If the failure is a temporal variant → annotate the temporal mode, do not create new shape unless the timing mechanism itself is novel

### Outcome Spectrum: Beyond Pass/Fail

The taxonomy's core model is binary: a predicate passes or fails, producing false confidence or false rejection. But real verification encounters **intermediate outcomes** that this binary framing under-captures:

| Outcome | Description | Example | Current Handling |
|---------|-------------|---------|-----------------|
| **Pass** | Claim matches evidence | CSS color is green | Normal |
| **Fail** | Claim contradicts evidence | CSS color is red, expected green | Normal |
| **Partial success** | Claim partially matches | API returns 3 of 5 expected items, bodyContains matches but data incomplete | P-02 passes (bodyContains finds token), but response is degraded |
| **Degraded correctness** | Claim matches now, will break soon | Response time 2.4s (threshold 2.5s), memory at 89% | Invisible to deterministic predicates |
| **Misleading success** | Evidence says pass, but for wrong reason | CSS color correct because of `!important` override, not because edit worked | C-12 captures this shape, but AT-05/AT-06 are the general case |
| **Honest uncertainty** | Cannot determine pass or fail | Browser gate didn't run, DB not available, vision model absent | Three-valued logic (`true`, `false`, `null`) already used in G4 |

**Why this matters:** Partial success is the most dangerous outcome — the verification system reports "pass" when reality is degraded. The existing shapes cover many instances (P-23 error page match, AT-05 accidental correctness, INV-01 health green but route broken), but they aren't unified under a common framework.

**The degradation axis:** Every claim type from the Claim Taxonomy has a degradation mode:

| Claim Type | Degradation Mode | Shape Class |
|-----------|-----------------|-------------|
| Existence | Present but non-functional | INV-01, BR-03 |
| Equality | Approximately equal, not exactly | C-44 (rounding), SER-02 (float precision) |
| Containment | Partial containment | P-02 partial body, N-08 partial match |
| Ordering | Mostly ordered, some swaps | P-09 partial sequence |
| Transformation | Approximately correct output | C-09 calc() rounding |
| Invariance | Mostly invariant, occasional violation | PERF-05 (memory leak — slow degradation) |
| Threshold | At boundary, not clearly pass/fail | PERF-01, A11Y-04 |

**Implication for generators:** Generators should explicitly test the boundary between pass and degraded pass, not just pass vs clear fail. The most dangerous bugs live at this boundary.

### Truth Types: Deterministic vs Evaluative

The 23 domains are not all the same kind of truth. Conflating them risks polluting the deterministic verification core with threshold-based judgment.

| Truth Type | Nature | Evidence | Reproducibility | Domains |
|-----------|--------|----------|----------------|---------|
| **Deterministic** | Binary — pass or fail, no interpretation | Computed value, file content, schema structure, HTTP response | 100% — same input, same output, always | CSS, HTML, Filesystem, Content, HTTP, DB, Message |
| **Evaluative** | Threshold-based — policy determines pass/fail | Measurement, score, ratio, timing | High but not absolute — environment variance | Performance, Accessibility, Security |
| **Contextual** | Depends on deployment context | Runtime config, feature flags, environment state | Varies by target | Configuration |
| **Contractual** | Schema/format compliance | Structural validation | 100% for structure, variable for semantics | Serialization |

**Why this matters for the verification engine:**

- **Deterministic surfaces** are the core. Their predicates produce `true` or `false` with no ambiguity. The engine can be fully confident in their verdicts.
- **Evaluative surfaces** require thresholds. A performance predicate doesn't have a "right answer" — it has a policy boundary. The engine must distinguish "failed because threshold exceeded" from "failed because measurement was wrong."
- **Contextual surfaces** require environment awareness. A config predicate that passes in staging may fail in production — this is correct behavior, not a bug.
- **Contractual surfaces** are deterministic in structure but evaluative in semantics. JSON schema validation is binary, but "is this the right schema?" is a policy question.

**Architectural rule:** Deterministic surfaces are always gated (block on failure). Evaluative/contextual/contractual surfaces are advisory by default, gated only when the operator opts in. This prevents threshold noise from breaking the deterministic core.

### Cross-Cutting Domain Hygiene

The cross-cutting domain (X-*) has 89 shapes — the largest in the taxonomy. This is a structural signal, not just a coverage gap. When a domain grows disproportionately, it may be absorbing concepts that deserve their own identity.

**Current X-* subsections and their structural status:**

| Subsection | Shapes | Status | Notes |
|-----------|--------|--------|-------|
| Fingerprinting (K5) | 12 | **Clean** — specific to K5 gate mechanics | Keep |
| Constraint Learning (K5) | 11 | **Clean** — specific to K5 learning loop | Keep |
| Gate Sequencing | 8 | **Clean** — specific to gate pipeline | Keep |
| Containment (G5) | 7 | **Clean** — specific to G5 attribution | Keep |
| Grounding | 6 | **Clean** — specific to grounding gate | Keep |
| Syntax (F9) | 11 | **Clean** — specific to F9 edit validation | Keep |
| Narrowing | 8 | **Potential extraction** — narrowing is a cross-gate concept, not gate-specific |
| Vision / Triangulation | 11 | **Potential extraction** — triangulation spans multiple authorities |
| Receipt & Attestation | 4 | **Clean** — audit trail integrity | Keep |
| Predicate Lifecycle | 4 | **Potential extraction** — predicate staleness is a temporal/identity concern |

**Rule for X-* hygiene:** A shape belongs in X-* only if it is about verify's own gate logic, not about a reality surface. If a shape could be decomposed as `Surface shape × Gate shape`, it belongs on the surface with a gate annotation, not in X-*.

**When to extract:** If a subsection exceeds 15 shapes, consider whether it should become its own domain. Narrowing (8 shapes) is not there yet but is the most likely candidate for extraction.

### DB Testing Strategy

DB predicate testing uses a three-tier approach:

| Tier | Strategy | What It Tests | Fixture |
|------|----------|---------------|---------|
| **1 (current)** | Structural stubs | Pipeline doesn't crash with DB predicates | No init.sql, `gates: { staging: false, browser: false, http: false }` |
| **2 (next)** | Mock schema via init.sql | Grounding validates against schema, deferred validation semantics | `fixtures/demo-app/init.sql` with CREATE TABLE/INDEX/CONSTRAINT statements |
| **3 (deferred)** | Docker DB | Full schema introspection, migration testing, data assertions | Docker Postgres container in CI |

**Tier 2 implementation (mock schema):**
- Add `fixtures/demo-app/init.sql` with representative schema (users, posts, sessions tables)
- Grounding gate gains `if (p.type === 'db')` branch that parses init.sql for table/column/type existence
- DB predicates validated deterministically against parsed schema — no Docker, no network
- Generators produce scenarios that test grounding accuracy against mock schema
- Coverage target: D-01 through D-12 (schema assertions) fully testable at Tier 2

---

## CSS Predicate Failures

CSS predicates assert computed style properties on DOM elements. The gap between authored CSS (source code) and computed CSS (browser reality) is where most failures live.

### Value Resolution

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| C-01 | Named color ↔ hex equivalence | generator (E) | 4 scenarios: red→#ff0000 ✓, navy ✓, rebeccapurple gap, hex→named gap |
| C-02 | RGB ↔ hex equivalence | generator (E) | 2 scenarios: rgb(255,0,0)→#ff0000 ✓, rgb(128,0,128)→#800080 ✓ |
| C-03 | HSL ↔ hex/rgb equivalence | generator (E) | 1 scenario: hsl(120,100%,50%)→#00ff00 ✓ |
| C-04 | RGBA with alpha=1 ↔ RGB | generator (E) | 1 scenario: rgba(255,0,0,1)→#ff0000 ✓ |
| C-05 | HSLA with alpha=1 ↔ HSL | generator (E) | 1 scenario: hsla(120,100%,50%,1)→#00ff00 ✓ |
| C-06 | Whitespace in values | generator (E) | 2 scenarios: internal whitespace gap, outer whitespace handled |
| C-07 | Casing in values | generator (E) | 3 scenarios: hex case ✓, named case ✓, upper named→hex ✓ |
| C-08 | Zero equivalences | generator (E) | 3 scenarios: 0px→0 ✓, 0em→0 ✓, 0rem→0 ✓ (all zero-units normalize to "0") |
| C-09 | `calc()` expressions | generator (E) | 2 scenarios: calc→computed gap, calc literal match ✓ |
| C-10 | CSS custom properties (`var()`) | generator (E) | 1 scenario: var()→value false confidence (source matches) |
| C-11 | `auto`, `inherit`, `initial`, `unset` keywords | generator (E) | 2 scenarios: auto→computed gap, inherit→parent gap |
| C-12 | `!important` override | generator (E) | 1 scenario: !important value substring match ✓ |
| C-13 | Unit equivalence (relative) | generator (E) | 1 scenario: em→px context-dependent gap |
| C-14 | Percentage values | generator (E) | 1 scenario: %→px context-dependent gap |
| C-15 | Multiple values on one property | generator (E) | 1 scenario: new property not in source → groundingMiss |
| C-16 | Browser-specific prefixes | generator (E) | 1 scenario: -webkit-transform→transform not mapped |
| C-44 | Fractional rounding differences | generator (E) | 1 scenario: 33.3333%→33.33% rounding gap |
| C-45 | `normal` keyword resolution | generator (E) | 1 scenario: normal→400 not mapped |
| C-46 | Font family normalization | generator (E) | 1 scenario: quoted vs unquoted gap |
| C-47 | Transform matrix equivalence | **generator (E)** | 1 scenario: translateX vs matrix equivalence |
| C-48 | Filter/backdrop-filter normalization | **generator (E)** | 1 scenario: filter computed serialization |
| C-49 | Color space differences (modern syntax) | generator (E) | 1 scenario: modern rgb() vs legacy rgb() gap |
| C-50 | CSS variable fallback path | **generator (E)** | 1 scenario: var() fallback when variable missing |
| C-51 | Invalid value silently dropped | generator (E) | 1 scenario: invalid value→inherited gap |
| C-52 | Unit conversion with root-relative context | generator (E) | 1 scenario: rem→px root-dependent gap |

### Shorthand Resolution

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| C-17 | `border` → `border-width/style/color` | generator (E) + scenarios (uv-012, uv-015) | 2 scenarios: border-bottom not in _SH, direct property match ✓ |
| C-18 | `margin` → directional components | generator (E) | 4 scenarios: top ✓, right ✓, bottom 4-value ✓, bottom 2-value false confidence |
| C-19 | `padding` → directional components | generator (E) | 1 scenario: padding-top from shorthand ✓ |
| C-20 | `background` → longhand components | generator (E) | 2 scenarios: simple ✓, complex positional mismatch |
| C-21 | `font` → size/weight/family/style | generator (E) | 1 scenario: font shorthand not in source → miss |
| C-22 | `flex` → grow/shrink/basis | no coverage | `flex: 1 0 auto` |
| C-23 | `grid` shorthand family | no coverage | `grid-template`, `grid-area`, etc. |
| C-24 | `animation` → name/duration/timing/etc. | generator (E) | 1 scenario: animation-name not in _SH |
| C-25 | `transition` → property/duration/timing/delay | generator (E) | 1 scenario: transition-duration not in _SH |
| C-26 | `list-style` → type/position/image | no coverage | 3 longhand properties |
| C-27 | `text-decoration` → line/color/style/thickness | no coverage | 4 longhand properties |
| C-28 | `outline` → width/style/color | generator (E) | 1 scenario: outline not in source → miss |
| C-29 | `overflow` → overflow-x/overflow-y | no coverage | 2 longhand properties |
| C-30 | Shorthand component ordering ambiguity | generator (E) | 1 scenario: positional token mismatch documented |

### Selector Matching

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| C-31 | Fabricated selector (grounding miss) | generator (E2) + scenarios (uv-001, uv-004) | Well covered |
| C-32 | Property not found on valid selector | scenario only (uv-002) | Single scenario |
| C-33 | Value mismatch (expected ≠ actual) | scenario only (uv-009) | Single scenario |
| C-34 | Cross-route selector ambiguity | generator (G) | 3 scenarios: cross-route read, diff value, edit on one route |
| C-35 | Specificity/cascade conflict | generator (E+G) | 2 scenarios: specificity conflict, edit overrides |
| C-36 | Multi-selector rules | generator (E) | 1 scenario: comma-separated multi-selector |
| C-37 | Selector combinators | generator (G) | 2 scenarios: descendant grounded, child combinator miss |
| C-38 | Pseudo-class selectors | generator (G) | 2 scenarios: :hover grounded, :focus fabricated→miss |
| C-39 | Pseudo-element selectors | generator (G) | 2 scenarios: ::after grounded, ::before fabricated→miss |
| C-40 | Inherited vs computed values | generator (G) | 2 scenarios: .subtitle color grounded, font-family inherited→miss |
| C-41 | Media query scoped styles | generator (G) | 2 scenarios: @media fabricated→miss, edit adds @media block |
| C-42 | Multiple style blocks with same selector | generator (E) | 2 scenarios: multi-block merge, original preserved |
| C-43 | Duplicate properties in same block | generator (E+G) | 4 scenarios: later wins, first-value check, dup prop edit |
| C-53 | Escaped selectors and special characters | generator (G) | 2 scenarios: #contact-form HTML, #details CSS ID selector |
| C-54 | Attribute selectors | generator (G) | 2 scenarios: input[type="text"] grounded, [data-role] fabricated→miss |
| C-55 | Shadow DOM boundary | generator (G) | 1 scenario: ::shadow fabricated→grounding miss |
| C-56 | Style source precedence mismatch | generator (G) | 2 scenarios: .card .card-title grounded, .badge edit changes value |
| C-57 | Cascade layers (`@layer`) | generator (G) | 1 scenario: @layer fabricated→grounding miss |
| C-58 | Container query scoped styles | generator (G) | 1 scenario: @container fabricated→grounding miss |
| C-59 | Logical properties | generator (G) | 2 scenarios: margin-inline-start read, edit adds→miss |
| C-60 | Browser default styles mistaken for success | generator (G) | 2 scenarios: display:block UA default, edit adds explicit→miss |
| C-61 | Property not observable via getComputedStyle | generator (G) | 2 scenarios: content on pseudo-element, will-change edit→miss |
| C-62 | Longhand/shorthand beyond known families | generator (G) | 2 scenarios: box-shadow grounded, transition edit→longhand miss |

### Modern CSS Features

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| C-63 | `color-mix()` / `color()` computed resolution | no coverage | Modern color functions resolve to computed values — source has `color-mix(in srgb, red, blue)` |
| C-64 | CSS nesting (`&` syntax) selector resolution | no coverage | Nested `& .child` computes to flat selector — source vs computed mismatch |
| C-65 | `@property` registered custom property type | no coverage | Typed custom property (`@property --x { syntax: "<color>" }`) — type constraints |
| C-66 | `subgrid` value on grid-template-* | no coverage | `subgrid` inherits tracks from parent — computed vs authored |
| C-67 | `clamp()` / `min()` / `max()` computed resolution | no coverage | `clamp(1rem, 5vw, 3rem)` resolves context-dependent |
| C-68 | `@scope` rule boundary | no coverage | Scoped styles not visible outside scope boundary |
| C-69 | `extractCSS` parser does not recognize modern CSS features | discovered 2026-04-08 | Grounding gate's `extractCSS` helper misses pseudo-elements (`::placeholder`, `::marker`, `::selection`), logical properties (`inline-size`, `block-size`), and function values (`fit-content()`, `clamp()`). Causes false positives — valid modern CSS flagged as fabricated. Auto-discovered via Bundles 9 + 18 in improvement-ledger run #43. Workarounds available; root fix requires upgrading the parser. |

**CSS total: 69 shapes. Generator coverage: 61 (C-01–C-30, C-32–C-62). No coverage: 8 (C-31, C-63–C-69).**

---

## HTML Predicate Failures

HTML predicates assert element existence, text content, and structure. The gap between source HTML and parsed DOM is where failures live.

### Element Matching

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-01 | Element not found (wrong tag) | **generator (G)** | 2 scenarios: grounding-skip exists + wrong tag text mismatch |
| H-02 | Wrong text content | **generator (G)** | 2 scenarios: wrong text → grounding miss, edit changes text |
| H-03 | Element exists but wrong tag type | generator (G) | 1 scenario: predicate expects h2 but page has h1 → grounding miss |
| H-04 | Multiple matching elements | generator (G) | 1 scenario: multiple li elements, HTML predicate ambiguous |
| H-05 | Nested element text extraction | generator (G) | 1 scenario: nav contains anchor text (nested element text) |
| H-06 | Self-closing tag variants | generator (G) | 1 scenario: img self-closing tag existence |
| H-07 | SVG/foreign namespace elements | no coverage | `<svg:rect>` vs `<rect>` — no SVG in demo-app |

### Text Content

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-08 | Whitespace in text content | **generator (G/W2A)** | 2 scenarios: leading/trailing whitespace match ✓, internal whitespace collapse ✓ |
| H-09 | HTML entities vs literal | **generator (G/W2A)** | 2 scenarios: &amp; entity match ✓, &#39; numeric entity match ✓ |
| H-10 | Case sensitivity in text matching | **generator (G/W2A)** | 2 scenarios: exact case match ✓, wrong case → grounding miss ✓ |
| H-11 | Unicode normalization | generator (G) | 1 scenario: ASCII text exact match |
| H-12 | Template expression in source | generator (G) | 1 scenario: template literal matched literally in source |
| H-13 | Text across child elements | generator (G) | 1 scenario: p with strong child — concatenated text |
| H-14 | Invisible text (display:none content) | generator (G) | 1 scenario: .hidden element has content but display:none |
| H-24 | textContent vs innerText mismatch | **generator (G)** | 2 scenarios: hidden text in source, html predicate on hidden element |
| H-25 | Comment nodes in text extraction | generator (G) | 1 scenario: edit adds HTML comment, content still found |
| H-26 | Script/style tag text counted as content | generator (G) | 1 scenario: content predicate matches inside style block |
| H-27 | Non-breaking spaces and special whitespace | generator (G) | 1 scenario: &amp;nbsp; in source treated as content |
| H-28 | Bidirectional text / RTL markers | no coverage | `\u200F`, `\u200E` — no RTL text in demo-app |
| H-29 | Placeholder vs actual form value | generator (G) | 1 scenario: placeholder text exists in form source |

### Attributes

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-15 | Boolean attributes | generator (G) | 1 scenario: required attribute exists on input |
| H-16 | Class attribute matching | generator (G) | 1 scenario: .form-group class on about page |
| H-17 | Data attributes | generator (G) | 1 scenario: fabricated data-id selector → grounding miss |
| H-18 | URL attributes (href, src) | generator (G) | 1 scenario: nav-link with href exists |
| H-19 | ARIA attributes | generator (G) | 1 scenario: fabricated [aria-label] → grounding miss |
| H-30 | DOM property vs HTML attribute mismatch | generator (G) | 1 scenario: required attribute in source detectable |
| H-31 | Boolean state differs from serialized source | **generator (G)** | 2 scenarios: attribute selector exists-skip, edit adds selected attr |

### Structure

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-20 | Element count (cardinality) | generator (G) | 2 scenarios: team-list has 3 li elements, existence check |
| H-21 | Element ordering | generator (G) | 2 scenarios: first team member is Alice, order-dependent text |
| H-22 | Nesting depth | generator (G) | 2 scenarios: span.role inside li inside ol, ul nesting |
| H-23 | Dynamic/JS-rendered content | generator (G) | 1 scenario: fabricated JS-rendered element → grounding miss |
| H-32 | Hidden but accessible text (or vice versa) | generator (G) | 1 scenario: .hidden div exists but display:none |
| H-33 | Slotting / shadow DOM content projection | no coverage | `<slot>` content — no shadow DOM in demo-app |
| H-34 | Duplicate IDs causing ambiguous selection | generator (G) | 1 scenario: edit creates second #details, ambiguous |
| H-35 | Fragment parsing differences | **generator (G)** | 2 scenarios: thead exists in table context, content check on table data |
| H-36 | Malformed HTML autocorrection | generator (G) | 1 scenario: missing closing tag, parser handles |
| H-37 | Template/inert content (`<template>`) | generator (G) | 1 scenario: fabricated template selector → grounding miss |
| H-38 | Parent/ancestor requirement not enforced | generator (G) | 1 scenario: td exists inside table on about page |
| H-39 | Sibling relationship assertion | generator (G) | 1 scenario: th elements are siblings in table header |
| H-40 | Landmark/semantic structure mismatch | generator (G) | 1 scenario: nav element exists on homepage |
| H-41 | Hydration mismatch (source vs runtime DOM) | no coverage | No client JS in demo-app |

### Semantic & Meta

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-42 | Conditional rendering (framework `v-if`/`{show && ...}`) | no coverage | Element in source template, not rendered at runtime |
| H-43 | Meta tags / Open Graph assertions | no coverage | `<meta property="og:title">` content mismatch |
| H-44 | Form validation state mismatch | no coverage | Element exists but `validity.valid` is false — invisible to source check |
| H-45 | Accessibility tree vs DOM mismatch | no coverage | ARIA live region text differs from textContent |
| H-46 | `<iframe>` content assertions | no coverage | Content inside iframe from different origin — cross-origin barrier |
| H-47 | `<picture>` / `<source>` media selection | no coverage | Different `<source>` selected at different viewports |
| H-48 | `<dialog>` open/closed state | no coverage | `<dialog>` element exists but `open` attribute absent — not visible |

**HTML total: 48 shapes. Generator coverage: 37 (H-01–H-06, H-08–H-27, H-29–H-32, H-34–H-40). No coverage: 11 (H-07, H-28, H-33, H-41–H-48 — need richer fixtures: SVG, RTL, shadow DOM, hydration, meta, forms, iframes).**

### HTML Domain Surface Design (Wave 2 Target)

HTML predicates use the existing `html` type with `selector` (tag name), `expected` (text content or `"exists"`), and `path` (route). Verification happens at two layers:

**Layer 1 — Grounding (pre-edit, no Docker):**
- Element tag existence: `selector` matched against parsed HTML tags per route
- Text content validation: `expected` compared against element's text content
- Creation goal detection: if element doesn't exist but edit creates it, grounding allows it through
- Text change detection: if element exists but text doesn't match expected, `groundingMiss` (by design — grounding validates source truth, not intended truth)

**Layer 2 — Browser gate (post-edit, requires Docker):**
- `document.querySelector(selector)` against rendered DOM
- `element.textContent` for text assertions
- Handles dynamic content, template rendering, JavaScript-created elements

**Initial scenarios shipped (6 in UV family):**
| Scenario | Shape | What it tests |
|---|---|---|
| uv-023 | H-01/H-02 happy path | Element exists with correct text |
| uv-024 | H-01 exists check | Element existence without text assertion |
| uv-025 | Creation goal | Edit creates new element — grounding allows |
| uv-026 | Cross-surface (I-01) | CSS + HTML multi-predicate on same element |
| uv-027 | H-03 wrong tag | Wrong element tag rejected by grounding |
| uv-028 | H-02 text change | Text change on existing element triggers grounding miss |

---

## Filesystem Predicate Failures

Filesystem predicates assert file existence, structure, and state. The most deterministic domain — no interpretation, no rendering, no probability. Promoted from a subsection of Content because filesystem truth is fundamentally different from content-pattern truth.

### Existence & Presence

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-01 | File should exist but doesn't | **generator (H)** | Missing after failed edit — 1 scenario |
| FS-02 | File should not exist but does | **generator (H)** | Leftover artifact — 1 scenario |
| FS-03 | Directory vs file mismatch | **generator (H)** | Expected file, found directory (or vice versa) — 2 scenarios |
| FS-04 | Wrong path resolution (relative vs absolute) | **generator (H)** | `../` traversal blocked by staging isolation — 2 scenarios |
| FS-05 | Symlink resolution | **generator (H)** | Symlink target matches real file — 2 scenarios (Unix-only) |
| FS-06 | Symlink cycle or traversal edge case | no coverage | Infinite loop or `../../../` escape |

### Content Integrity

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-07 | Content mismatch (exact) | **generator (H)** | Hash comparison via filesystem_unchanged — 1 scenario |
| FS-08 | Encoding mismatch (UTF-8 vs other) | **generator (H)** | BOM prefix affects hash — 2 scenarios |
| FS-09 | Line ending differences (CRLF/LF) | **generator (H)** | `\r\n` vs `\n` hash difference — 2 scenarios |
| FS-10 | Binary vs text misinterpretation | **generator (H)** | PNG file hashed as binary — 2 scenarios |
| FS-11 | NUL bytes in text-like files | **generator (H)** | Corrupted file with NUL bytes — 2 scenarios |
| FS-12 | Partial write / truncated file | **generator (H)** | Malformed predicates (missing fields, bad type) — 3 scenarios |
| FS-13 | Compressed or encoded content | no coverage | `.gz`, `.br` treated as plain text |
| FS-14 | Empty file (0 bytes) | **generator (H)** | Empty file exists/hash/count — 3 scenarios |
| FS-15 | Minified files | **generator (H)** | Dotfiles included in filesystem_count — 2 scenarios |

### Structural / Count

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-16 | Wrong number of files | **generator (H)** | filesystem_count pass/fail — 2 scenarios (H7/H8) |
| FS-17 | Unexpected extra files | **generator (H)** | 2 scenarios: extra files in filesystem count |
| FS-18 | Missing expected files in set | **generator (H)** | 1 scenario: missing file in expected set |
| FS-19 | Generated/build artifact matched instead of source | **generator (H)** | 1 scenario: build artifact vs source file |

### Path & Resolution

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-20 | Case sensitivity across OSes | **generator (H)** | 2 scenarios: case-sensitive path matching |
| FS-21 | Unicode normalization in filenames | **generator (H)** | 1 scenario: unicode path normalization |
| FS-22 | Glob expansion mismatch | **generator (H)** | 1 scenario: glob pattern edge case |
| FS-23 | Path traversal normalization | **generator (H)** | 2 scenarios: path traversal normalization |

### Permissions & Access

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-24 | File exists but unreadable | **generator (H)** | 1 scenario: unreadable file handling |
| FS-25 | Execution bit issues | no coverage | Script not executable after edit |
| FS-26 | Container vs host filesystem mismatch | no coverage | Different view of same volume |
| FS-27 | Mounted volume inconsistencies | no coverage | Host edit not visible in container |

### State & Timing

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-28 | File not yet written when checked | no coverage | Race between edit and verification |
| FS-29 | Stale read after write | no coverage | OS cache returns old content |
| FS-30 | Concurrent modification during read | no coverage | Another process writes while we read |
| FS-31 | File watcher/cache stale after edit | no coverage | Verification reads cached, not fresh |

### Identity & Equality

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-32 | Same content, different hash method | **generator (H)** | 1 scenario: hash method sensitivity |
| FS-33 | Same logical file, different path reference | no coverage | Alias, mount, symlink — same bytes |
| FS-34 | Duplicate files causing ambiguity | **generator (H)** | 2 scenarios: duplicate filename in different dirs |

### Build & Transform

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-35 | Source file matches, build artifact differs | no coverage | Source CSS correct, minified output different (whitespace, shorthand collapse) |
| FS-36 | .gitignore hides file from verification glob | no coverage | File exists but glob respects .gitignore — invisible |
| FS-37 | Lock file stale after dependency change | no coverage | `package-lock.json` not regenerated — predicate sees old deps |
| FS-38 | Temp file left from failed write | no coverage | `.tmp` or `~` suffix file exists alongside target |
| FS-39 | `filesystem_unchanged` false negative on hash-matched no-op edit | discovered 2026-04-08 | Predicate fails despite hash matching and zero edits — auto-discovered from 6× cluster across `config.json`, `init.sql`, `.env`. Filesystem gate bug, not a real divergence. |

**Filesystem total: 39 shapes. Generator coverage: 22 (FS-01–FS-05, FS-07–FS-12, FS-14–FS-15, FS-17–FS-24, FS-32, FS-34). No coverage: 17.**

---

## Content Predicate Failures

Content predicates assert that patterns exist inside files. Distinct from filesystem (which is about structure/state) — content is about meaning within files.

### Pattern Matching

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| N-01 | Pattern not found in file | scenario (uv-007) | Single scenario |
| N-02 | File doesn't exist | scenario (uv-008) | Single scenario |
| N-03 | Pattern found in wrong file | **generator (G/W2A)** | 2 scenarios: pattern in wrong file → fail ✓, pattern in correct file → pass ✓ |
| N-04 | Regex vs literal matching | generator (E) | 2 scenarios: dot is literal ✓, regex-special chars literal ✓ |
| N-05 | Multi-line pattern matching | generator (E) | 1 scenario: cross-line includes() works ✓ |
| N-06 | Pattern in comment vs code | generator (E) | 1 scenario: comment text matches (false positive) |
| N-07 | Case sensitivity | generator (E) | 2 scenarios: correct case ✓, wrong case → miss |
| N-08 | Partial match vs full match | generator (E) | 2 scenarios: substring false positive, pattern not found |
| N-26 | Duplicate pattern count ambiguity | **generator (G/W2A)** | 2 scenarios: pattern appears multiple times → still passes (includes()) ✓, unique pattern → passes ✓ |

### Semantic Edge Cases

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| N-09 | Template syntax as literal | **generator (G/W2A)** | 1 scenario: template-like pattern `${` matched literally ✓ |
| N-10 | Very large files (performance) | no coverage | Scanning 10MB file |
| N-11 | Pattern in generated scaffold | no coverage | Matches boilerplate, not user-authored code |
| N-12 | Concatenated/bundled content | no coverage | Pattern exists in bundle but not in source module |

### Structural Content

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| N-13 | JSON structure assertion (key path) | no coverage | File contains valid JSON but `data.users[0].name` path doesn't exist |
| N-14 | YAML/TOML config value assertion | no coverage | Config file parsed differently by different parsers (anchors, merge keys) |
| N-15 | Environment variable reference in file | no coverage | `${DB_HOST}` in config — literal match vs resolved value |
| N-16 | Import/require graph assertion | no coverage | File imports module X — `require('./db')` exists in source |
| N-17 | BOM (Byte Order Mark) offset | no coverage | File starts with `\uFEFF` — pattern position shifted by 3 bytes |

### Post-Edit Goal Contradiction

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| N-27 | Edit removes pattern the predicate asserts | **generator + real-world** | shadcn/ui PR #9512: prompt said `rounded-lg`, agent replaced with `rounded-xl`. Pattern existed pre-edit, absent post-edit. First shape from real-world validation. |

**Content total: 19 shapes. Generator coverage: 12 (N-03–N-12, N-26, N-27). No coverage: 7.**

---

## HTTP Predicate Failures

HTTP predicates assert status codes, body content, and request/response behavior. The gap between expected and actual HTTP behavior is where failures live.

### Status & Body

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| P-01 | Status code mismatch | **generator (P)** | 3 scenarios: 200→404 mismatch ✓, 404→200 mismatch ✓, fingerprint (A1) ✓ |
| P-02 | Body content missing (bodyContains) | **generator (P)** | 2 scenarios: bodyContains present ✓, bodyContains missing → fail ✓ |
| P-03 | bodyContains array — all must match | **generator (P)** | 2 scenarios: all terms present ✓, one term missing → fail ✓ |
| P-04 | bodyRegex edge cases | **generator (P)** | 2 scenarios: regex matches ✓, regex no match → fail ✓ |
| P-05 | Empty response body | **generator (P)** | 1 scenario: bodyContains on empty response → fail ✓ |
| P-06 | Wrong Content-Type | **generator (P)** | 2 scenarios: correct content-type ✓, wrong content-type → fail ✓ |
| P-07 | JSON structure assertion | **generator (P)** | 2 scenarios: bodyContains on JSON key ✓, missing JSON key → fail ✓ |
| P-08 | Response body encoding | **generator (P)** | 1 scenario: unicode body content via bodyContains ✓ |
| P-23 | bodyContains succeeds on error page | **generator (G)** | 1 scenario: /nonexistent returns "Not Found" |
| P-24 | JSON key ordering differences | **generator (G)** | 2 scenarios: bodyContains individual key ✓, bodyRegex assumes serialization order |
| P-25 | Numeric/string/null distinctions in JSON | **generator (G)** | 1 scenario: /api/items numeric id (1 not "1") |
| P-26 | Duplicate keys / malformed JSON | **generator (G)** | 1 scenario: bodyRegex expects valid JSON array from /api/items |
| P-27 | Charset mismatch (headers vs body) | no coverage | Content-Type says UTF-8, body is Latin-1 |
| P-28 | Compression auto-decoding differences | no coverage | gzip/br handled inconsistently across clients |
| P-29 | HTML and JSON both contain expected token | **generator (G)** | 1 scenario: "Alpha" in both HTML and JSON |

### Request Handling

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| P-09 | Sequence ordering (http_sequence) | **generator (P)** | 3 scenarios: sequence passes ✓, step fails mid-sequence → partial ✓, wrong order → fail ✓ |
| P-10 | Request body interpolation | **generator (G)** | 1 scenario: POST /api/echo with {{jobId}} token |
| P-11 | Query parameter handling | **generator (G)** | 1 scenario: /api/items?page=1 returns items |
| P-12 | Request method mismatch | **generator (G)** | 1 scenario: GET to POST-only /api/echo → 404 |
| P-13 | Request headers | no coverage | Authorization, custom headers |
| P-14 | Cookie handling | no coverage | Set-Cookie in response, cookie jar |
| P-30 | Idempotency mismatch | **generator (G)** | 1 scenario: http_sequence with two identical POSTs to /api/echo |
| P-31 | Sequence step dependency leakage | no coverage | Step 2 passes only because of unrelated prior state |
| P-32 | Cross-request variable collision | no coverage | Interpolation namespace collision across steps |
| P-33 | Auth state leakage between tests | no coverage | Cookie/header reuse across scenarios |
| P-34 | Method override behavior | no coverage | `X-HTTP-Method-Override` alters semantics |
| P-35 | Query param order normalization | **generator (G)** | 2 scenarios: path with query params, reversed param order |
| P-36 | Repeated query keys / array encoding | no coverage | `?id=1&id=2` — array or last-wins? |
| P-37 | Multipart/form-data parsing | no coverage | File upload body handling |
| P-38 | HEAD/OPTIONS differing from GET/POST | no coverage | Status/headers same but no body |

### Network & Protocol

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| P-15 | Redirect handling (301/302) | **generator (G)** | 1 scenario: expecting 301 from /about (returns 200) |
| P-16 | Timeout vs error distinction | **generator (G)** | 1 scenario: predicate structure on /health |
| P-17 | CORS headers | no coverage | Preflight, Access-Control-* |
| P-18 | HTTPS/TLS certificate issues | no coverage | Self-signed, expired |
| P-19 | Chunked/streaming responses | no coverage | Response arrives in pieces |
| P-20 | Rate limiting (429) | no coverage | Repeated checks trigger rate limit |
| P-21 | Relative vs absolute URL | **generator (G)** | 1 scenario: /health path works as relative |
| P-22 | Trailing slash sensitivity | **generator (G)** | 1 scenario: /about vs /about/ |
| P-39 | DNS resolution differences | no coverage | `localhost` vs container network name vs `127.0.0.1` |
| P-40 | Port-binding race during staging | no coverage | Port not ready when predicate runs |
| P-41 | Retry turns infra failure into false success | no coverage | Flaky endpoint works on retry by coincidence |
| P-42 | Proxy/load balancer alters response | no coverage | Injected headers/body from infrastructure |
| P-43 | HTTP/1.1 vs HTTP/2 behavioral mismatch | no coverage | Protocol-level differences |
| P-44 | Localized content via Accept-Language | no coverage | Same endpoint, different response by locale |
| P-45 | CSRF protection blocks mutation route | no coverage | Realistic flow requires CSRF token |

### Advanced Protocol

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| P-46 | ETag / conditional GET returns 304 empty body | no coverage | `bodyContains` expects content, gets 304 Not Modified with no body |
| P-47 | Streaming/chunked response truncated | no coverage | Response body ends before expected token — partial delivery |
| P-48 | Server-Sent Events (SSE) stream assertion | no coverage | `text/event-stream` response — line-by-line protocol, not single body |
| P-49 | WebSocket upgrade handshake | no coverage | 101 Switching Protocols — HTTP predicate model doesn't apply |
| P-50 | Content-Encoding auto-decode mismatch | no coverage | gzip response auto-decompressed by some clients, not others |
| P-51 | IPv6 address format in URL | no coverage | `[::1]:8080` parsed differently by HTTP client libraries |
| P-52 | 1xx informational response before final | no coverage | `100 Continue` or `103 Early Hints` read as final response |
| P-53 | Range request returns 206 partial body | no coverage | `bodyContains` checks full content against partial response |
| P-54 | Proxy/CDN injects response headers or body | no coverage | Upstream proxy adds `X-Cache`, rewrites body — predicate sees modified |

**HTTP total: 54 shapes. Generator coverage: 23 (P-01 through P-12, P-15, P-16, P-21–P-26, P-29, P-30, P-35). No coverage: 31.**

---

## DB Predicate Failures

DB predicates assert schema structure and data state. The gap between expected schema and actual database state is where failures live.

### Schema Assertions

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| D-01 | Table doesn't exist | **grounded (G)** | 2 scenarios: table_exists assertion + multi-predicate. Grounding validates against init.sql |
| D-02 | Column doesn't exist | **grounded (G)** | 3 scenarios: column_exists assertion + valid grounded + wrong table. Grounding validates against init.sql |
| D-03 | Column type mismatch | **grounded (G)** | 4 scenarios: column_type assertion + valid type + JSONB + alias normalization. Grounding validates with `normalizeDBType()` |
| D-04 | Case sensitivity in names | **grounded (G)** | 2 scenarios: mixed-case table/column names. Case-insensitive lookup in grounding parser |
| D-05 | Column name case sensitivity | **grounded (G)** | 1 scenario: mixed-case column resolves via grounding. Shape D-05 in decompose.ts |
| D-06 | Type alias normalization | **grounded (G)** | 3 scenarios: serial→integer, varchar(N)→varchar, bool→boolean. `normalizeDBType()` + `DB_TYPE_ALIASES` map |
| D-07 | Fabricated table reference | **grounded (G)** | 2 scenarios: grounding rejects tables not in init.sql (orders, products). Shape D-07 in decompose.ts |
| D-08 | Fabricated column reference | **grounded (G)** | 2 scenarios: grounding rejects columns not in schema (users.phone, posts.token). Shape D-08 |
| D-09 | Type mismatch after normalization | **grounded (G)** | 2 scenarios: column found but type wrong even after alias resolution (email→varchar≠integer, id→uuid≠text) |
| D-10 | Row count assertion (stub) | **generator (G)** | 1 scenario: data assertion requiring live DB (deferred). Shape D-10 in decompose.ts |
| D-11 | Row value assertion (stub) | **generator (G)** | 1 scenario: data assertion requiring live DB (deferred). Shape D-11 in decompose.ts |
| D-12 | Constraint/index exists (stub) | **generator (G)** | 2 scenarios: nullable column + index exists. Shape D-12 in decompose.ts |
| D-23 | Schema-qualified names | no coverage | `public.users` vs `users` |
| D-24 | Generated/computed columns | no coverage | Virtual column not visible in standard schema check |
| D-25 | Collation differences | no coverage | Case/accent sensitivity varies by DB and column |
| D-26 | Partial indexes / expression indexes | no coverage | Index exists but only for subset of rows |
| D-27 | Composite primary/unique keys | no coverage | Multi-column constraints |
| D-28 | Column order assumptions | no coverage | Predicate assumes positional, schema returns alphabetical |
| D-29 | Trigger existence/behavior | no coverage | Not reflected in simple schema checks |
| D-30 | Materialized views vs views vs tables | no coverage | Same query surface, different refresh semantics |
| D-31 | Foreign key deferrable behavior | no coverage | Constraint checked at commit, not statement |
| D-32 | Migration applied but introspection cache stale | no coverage | Schema changed but cached result returned |

### Data Assertions

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| D-13 | Row count assertion | no coverage | Expected N rows, found M |
| D-14 | Row-level value assertion | no coverage | Specific column = specific value |
| D-15 | Sequence / auto-increment state | no coverage | Next ID is 5 but expected 1 |
| D-16 | Empty table vs missing table | **generator (G)** | 1 scenario: empty vs missing distinction |
| D-17 | Transaction isolation effects | no coverage | Read committed vs serializable |
| D-33 | NULL semantics in comparisons | no coverage | `NULL = NULL` is false in SQL |
| D-34 | Floating-point precision mismatch | no coverage | `0.1 + 0.2 ≠ 0.3` in stored values |
| D-35 | Timezone-aware vs naive timestamps | no coverage | `timestamptz` vs `timestamp`, UTC vs local |
| D-36 | Default values only on insert path | no coverage | Not visible in schema-only check |
| D-37 | Soft delete vs actual delete | no coverage | Row exists but `deleted_at IS NOT NULL` |
| D-38 | Phantom rows (transaction isolation) | no coverage | Visible in one isolation level, not another |
| D-39 | Ordering not guaranteed without ORDER BY | no coverage | Predicate assumes stable row order |
| D-40 | Sequence gaps after rollback | no coverage | Auto-increment skips numbers |
| D-41 | Trigger-mutated values | no coverage | Stored value differs from submitted value |
| D-42 | Referential integrity in single vs global view | no coverage | Passes in transaction, fails globally |

### Cross-DB Portability

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| D-18 | Postgres vs MySQL type naming | **generator (G)** | 1 scenario: cross-DB type naming |
| D-19 | Identifier quoting | no coverage | `"table"` (Postgres) vs `` `table` `` (MySQL) |
| D-20 | Boolean representation | **generator (G)** | 1 scenario: boolean representation |
| D-21 | Date/timestamp formats | no coverage | ISO 8601 vs database-native format |
| D-22 | Permission / ownership | no coverage | Schema visible but not queryable |
| D-43 | SQLite vs Postgres behavior | no coverage | Lightweight fixtures use different engine |
| D-44 | Reserved keyword identifiers | no coverage | `user`, `order`, `table` as column names |
| D-45 | Locale/collation affecting sort or equality | no coverage | Locale-dependent comparison results |
| D-46 | Permission model differs for introspection vs query | no coverage | Can read schema but not data (or vice versa) |

### Advanced Schema & Runtime

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| D-47 | Stored procedure / function existence | no coverage | Function exists but signature changed — introspection sees old signature |
| D-48 | Extension availability (PostGIS, pgcrypto, etc.) | no coverage | Extension required but not installed — `CREATE EXTENSION` not run |
| D-49 | Row-level security policy active | no coverage | Table exists, rows visible to admin but not to app role |
| D-50 | Table partitioning transparent to queries | no coverage | Partitioned table — parent exists, child partitions invisible to simple check |
| D-51 | Connection pool exhaustion | no coverage | Schema check succeeds (fast), production query hangs — pool drained |
| D-52 | Prepared statement type coercion | no coverage | Parameter type mismatch silently coerced — schema says INT, query sends TEXT |
| D-53 | JSON/JSONB column path query | no coverage | Column type is JSONB — `data->>'key'` path not validated by schema check |
| D-54 | Temporary table visibility (session-scoped) | no coverage | Temp table exists in session A, invisible to session B introspection |
| D-55 | Replication lag on read replica | no coverage | Schema check on replica returns stale state — DDL not replicated yet |
| D-56 | Constraint deferral mode mismatch | no coverage | FK deferred to COMMIT — introspection reports IMMEDIATE |

**DB total: 56 shapes. Grounded coverage: 12 shapes (D-01–D-12) with init.sql grounding validation + type alias normalization. Generator coverage: D-13 stubs, D-16, D-18, D-20. No coverage: 40.**

---

## Temporal / Stateful Failures

Failures where the same predicate produces different results depending on WHEN it's evaluated. Most other categories assume static snapshot comparison — temporal failures break that assumption.

### Settlement & Timing

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| TO-01 | State not yet settled when evaluated | **generator (G)** | 1 scenario: async init race |
| TO-02 | Predicate passes transiently, regresses after async | no coverage | Initial state correct, background work overwrites |
| TO-03 | Retry changes outcome without code change | no coverage | Creates flaky verification — non-determinism |
| TO-04 | Two predicates observe different app states | no coverage | HTML sees pre-hydration, CSS sees post-hydration |
| TO-06 | Debounce/throttle timing causes false negative | no coverage | User-visible effect delayed past check window |
| TO-07 | Animation/transition midpoint sampled | no coverage | Captured between states, not at final state |

### Cache & Staleness

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| TO-05 | Cached state causes stale result after edit | **generator (G)** | 1 scenario: cache staleness |
| TO-08 | Eventual consistency in DB/API | no coverage | Read-after-write returns stale data |
| TO-09 | Background job not finished before check | no coverage | Async worker still processing when predicate runs |

### Environment-Dependent Time

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| TO-10 | Time-dependent logic changes outcome | **generator (G)** | 1 scenario: time-dependent outcome |

### Clock & Calendar

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| TO-11 | Timezone-dependent rendering | no coverage | Server renders UTC, browser displays local — content check sees wrong time string |
| TO-12 | Daylight saving time transition | no coverage | Scheduled check skipped or runs twice during DST change |
| TO-13 | System clock drift / NTP correction | no coverage | Timestamp-based ordering breaks after clock adjustment mid-verification |
| TO-14 | Locale-dependent date formatting | no coverage | `toLocaleDateString()` output varies by server locale — content predicate fails |
| TO-15 | TTL-based expiry between check and use | no coverage | Session valid at check time, expired by time deploy completes |

**Temporal total: 15 shapes. Generator coverage: 3 (TO-01, TO-05, TO-10). No coverage: 12.**

### Parity Grid — Temporal Column (Phase 1, 66 scenarios)

Shapes added by Phase 1 parity work. These fill cells D×1 through D×5 on the grid.
See [PARITY-GRID.md](PARITY-GRID.md) for strategic context.

| # | Shape | Grid Cell | Scenarios | Generator |
|---|---|---|---|---|
| TF-01 | File written but not flushed when checked | D×1 (Temporal × Filesystem) | 5 | `stage-temporal-fs.ts` |
| TF-02 | Source edited but build artifact stale | D×1 (Temporal × Filesystem) | 5 | `stage-temporal-fs.ts` |
| TF-03 | Container volume mount not synced | D×1 (Temporal × Filesystem) | 5 | `stage-temporal-fs.ts` |
| TH-01 | Server started but not accepting connections | D×2 (Temporal × HTTP) | 7 | `stage-temporal-http.ts` |
| TH-02 | Response cached by proxy after deploy | D×2 (Temporal × HTTP) | 7 | `stage-temporal-http.ts` |
| TB-01 | DOM not settled when CSS evaluated | D×3 (Temporal × Browser) | 5 | `stage-temporal-browser.ts` |
| TB-02 | Async content not rendered at check time | D×3 (Temporal × Browser) | 4 | `stage-temporal-browser.ts` |
| TB-03 | CSS transition midpoint captured | D×3 (Temporal × Browser) | 3 | `stage-temporal-browser.ts` |
| TD-01 | Connection pool serves stale schema after migration | D×4 (Temporal × Database) | 7 | `stage-temporal-db.ts` |
| TD-02 | Read-after-write returns old data (replication lag) | D×4 (Temporal × Database) | 4 | `stage-temporal-db.ts` |
| TD-03 | Auto-increment/table not visible after migration | D×4 (Temporal × Database) | 3 | `stage-temporal-db.ts` |
| TC-01 | Process restart not complete when checked | D×5 (Temporal × CLI) | 4 | `stage-temporal-cli.ts` |
| TC-02 | Config change not picked up by running process | D×5 (Temporal × CLI) | 7 | `stage-temporal-cli.ts` |

### Parity Grid — Propagation Column (Phase 2, 44 scenarios)

Shapes added by Phase 2 parity work. These fill cells E×1 through E×3 on the grid.
See [PARITY-GRID.md](PARITY-GRID.md) for strategic context.

**Core pattern:** Edit upstream, check downstream. The upstream change succeeds but the downstream consumer still has old values — the propagation gap IS the failure.

| # | Shape | Grid Cell | Scenarios | Generator |
|---|---|---|---|---|
| PF-01 | Source correct but downstream artifact differs | E×1 (Propagation × Filesystem) | 8 | `stage-propagation-fs.ts` |
| PF-02 | File edit doesn't propagate to related files | E×1 (Propagation × Filesystem) | 7 | `stage-propagation-fs.ts` |
| PH-01 | DB schema changed but API returns old shape | E×2 (Propagation × HTTP) | 4 | `stage-propagation-http.ts` |
| PH-02 | API contract changed but frontend not updated | E×2 (Propagation × HTTP) | 5 | `stage-propagation-http.ts` |
| PH-03 | Env var changed but process serves old config | E×2 (Propagation × HTTP) | 5 | `stage-propagation-http.ts` |
| PB-01 | CSS class renamed but HTML still uses old name | E×3 (Propagation × Browser) | 5 | `stage-propagation-browser.ts` |
| PB-02 | HTML structure changed but selectors target old structure | E×3 (Propagation × Browser) | 5 | `stage-propagation-browser.ts` |
| PB-03 | API response changed but frontend renders stale state | E×3 (Propagation × Browser) | 5 | `stage-propagation-browser.ts` |

**Tier distribution:** 31 pure-tier (no Docker), 7 live-tier (Docker + live HTTP), 6 full-tier (Docker + Playwright).

---

### Parity Grid — State Assumption Column (Phase 3, 39 scenarios)

Shapes added by Phase 3 parity work. These fill cells C×4, C×5, and C×8 on the grid.
See [PARITY-GRID.md](PARITY-GRID.md) for strategic context.

**Core pattern:** Config sources already disagree BEFORE any edit — the agent's mental model of the environment doesn't match reality. Unlike Propagation (edit A, B didn't update), State Assumption means A and B were never consistent.

| # | Shape | Grid Cell | Scenarios | Generator |
|---|---|---|---|---|
| SA-01 | Feature flag divergence — flag in one surface, behavior governed by another | C×5/C×8 (State × Config) | 6 | `stage-state-config.ts` |
| SA-02 | Default masks missing config — fallback silently degrades | C×5/C×8 (State × Config) | 6 | `stage-state-config.ts` |
| SA-03 | Config precedence unpredictable — same value in multiple sources | C×5/C×8 (State × Config) | 9 | `stage-state-config.ts` |
| SD-01 | Schema→app assumption gap — DDL without app code | C×4 (State × Database) | 6 | `stage-state-db.ts` |
| SD-02 | Data assumed present — table exists but is empty | C×4 (State × Database) | 6 | `stage-state-db.ts` |
| SD-03 | Migration targets wrong DB — config surfaces disagree on connection | C×4 (State × Database) | 6 | `stage-state-db.ts` |

**Tier distribution:** All 39 pure-tier (no Docker needed) — tests structural cross-source inconsistency detection.

---

## Cross-Predicate Interaction Failures

Failures that only manifest when multiple predicate types are evaluated against the same system. Individual predicates pass in isolation but contradict each other or miss systemic issues.

### Cross-Surface Contradictions

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| I-01 | CSS passes, HTML fails — same selector wrong element | **generator (I)** | 2 scenarios: CSS pass + HTML fail ✓, both pass (control) ✓ |
| I-02 | HTML passes on source, CSS fails in browser | **generator (I)** | 1 scenario: source vs browser CSS mismatch |
| I-03 | Content passes (source changed), HTTP fails (behavior didn't) | **generator (I)** | 1 scenario: content predicate passes + HTTP predicate on same system ✓ |
| I-04 | HTTP passes, DB fails (response cached/mocked) | no coverage | API returns stale data |
| I-05 | DB passes, HTTP fails (serialization changed) | no coverage | Schema correct but JSON shape differs |
| I-06 | CSS edit fixes style but breaks HTML structure | **generator (I)** | 2 scenarios: title text change → old text fails grounding ✓, CSS color change → old color content fails ✓ |
| I-07 | One edit satisfies predicate A, violates predicate B | **generator (I)** | 2 scenarios: contradictory CSS predicates on same property ✓, content predicate for text that CSS edit removes ✓ |
| I-08 | Grounding says exists, runtime never renders | **generator (I)** | 1 scenario: conditional render mismatch |
| I-09 | Vision agrees with browser, deterministic disagrees | **generator (I)** | 1 scenario: normalization bug path |
| I-10 | Deterministic passes on source, browser fails (JS mutation) | **generator (I)** | 1 scenario: JS DOM mutation |
| I-11 | Filesystem passes on artifact, source unchanged | **generator (I)** | 1 scenario: build artifact vs source |
| I-12 | Multi-step workflow passes per step, invariant fails | **generator (I)** | 1 scenario: per-step pass, holistic fail |

### Temporal Compositions

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| I-13 | Grounding passes (source truth), browser fails (runtime truth) — async gap | no coverage | Element in source, not rendered by check time (TO-01 × H-01) |
| I-14 | HTTP passes at check time, DB has already changed | no coverage | API serves cached response while DB was migrated (TO-05 × P-07) |
| I-15 | CSS edit passes browser gate, invariant fails (side effect) | no coverage | Style change triggers JS error via CSS-dependent logic |
| I-16 | All individual predicates pass, system invariant fails | no coverage | Each predicate correct in isolation, but combined state is invalid |

**Interaction total: 16 shapes. Generator coverage: 10 (I-01–I-03, I-06–I-12). No coverage: 6.** Plus 6 product composition shapes (I-05×–I-10×) and 3 temporal composition scenarios in decompose.ts — these are executable algebra operators, not taxonomy shapes.

---

## Invariant / System Health Failures

Invariants are system-scoped checks that must hold after EVERY mutation. Unlike predicates (goal-scoped), invariants verify the system didn't break. This domain is underweighted in the taxonomy relative to its gate position.

### Health Endpoint

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INV-01 | Health green but core route broken | **generator (G)** | 1 scenario: health pass but route broken |
| INV-02 | Health red due to unrelated transient | no coverage | Temporary network glitch, not mutation damage |
| INV-03 | Health passes before side effect manifests | no coverage | Mutation damage is delayed |

### Scope & Coverage

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INV-04 | Invariant checks wrong service/container | **generator (G)** | 1 scenario: wrong service checked |
| INV-05 | Command output parsing mismatch | no coverage | `pg_isready` output format changes |
| INV-06 | Invariant status cached/stale | no coverage | Previous result returned instead of fresh check |
| INV-07 | One invariant masks another | **generator (G)** | 1 scenario: invariant budget masking |
| INV-08 | Scope too broad — false negatives | **generator (G)** | 1 scenario: broad scope false negative |
| INV-09 | Scope too narrow — misses blast radius | **generator (G)** | 1 scenario: narrow scope blast radius |

### Invariant Design

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INV-10 | Invariant too expensive — budget exceeded before completion | no coverage | 30s budget cap reached, remaining invariants unevaluated |
| INV-11 | Invariant order-dependent — later invariant depends on earlier | no coverage | Health check passes, but DB invariant fails because health doesn't check DB |
| INV-12 | Command invariant exit code 0 but stdout contains error text | no coverage | `pg_isready` returns 0 but prints warning — `contains` check misses it |
| INV-13 | HTTP invariant follows redirect to wrong destination | no coverage | `/health` redirects to `/login` — 200 status, wrong body |
| INV-14 | Invariant passes on wrong container (staging vs prod) | no coverage | Command runs against staging container, not deployed prod |

**Invariant total: 14 shapes. Generator coverage: 5 (INV-01, INV-04, INV-07–INV-09). No coverage: 9.**

---

## Browser Runtime Failures

Browser is a stateful runtime environment, not just CSS + HTML. These failures live in the behavioral layer — event handling, navigation, storage, lifecycle — that falls through the cracks between CSS (style truth) and HTML (structure truth). The browser domain captures: "does the app actually work?"

### Interaction & Events

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-01 | Click handler doesn't fire | no coverage | Button exists, event listener not attached |
| BR-02 | Wrong event type (click vs submit vs change) | no coverage | Form submits on enter but test clicks button |
| BR-03 | Element exists but not clickable | **generator (G)** | 1 scenario: unclickable element |
| BR-04 | Event fires but state change doesn't propagate | no coverage | Handler runs, DOM not updated |
| BR-05 | Double-click / rapid-fire creates unexpected state | no coverage | Debounce missing, duplicate submission |
| BR-06 | Focus/blur sequence triggers unexpected behavior | no coverage | Validation fires on blur, test doesn't blur |
| BR-07 | Keyboard event vs mouse event produces different result | no coverage | Enter key vs click on same button |

### Navigation & Routing

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-08 | Route changes but URL doesn't update | no coverage | SPA pushState not called |
| BR-09 | URL updates but content doesn't change | no coverage | Router fires, component doesn't re-render |
| BR-10 | Direct URL access works but SPA navigation doesn't | **generator (G)** | 1 scenario: SPA vs SSR routing |
| BR-11 | Back/forward button produces unexpected state | no coverage | History state not preserved |
| BR-12 | Hash vs path routing mismatch | no coverage | `/#/route` vs `/route` |
| BR-13 | Route works on reload but not on navigation | no coverage | Server renders fresh, client transition fails |

### Storage & State

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-14 | localStorage value incorrect after mutation | no coverage | Written but not read back correctly |
| BR-15 | sessionStorage state lost on navigation | no coverage | New tab vs same tab behavior differs |
| BR-16 | Cookie not set/read correctly | no coverage | Path, domain, SameSite, HttpOnly flags |
| BR-17 | State resets on navigation unexpectedly | no coverage | Component unmount clears state |
| BR-18 | IndexedDB transaction not committed | no coverage | Async write not awaited |

### Lifecycle & Rendering

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-19 | Hydration mismatch causes flicker or override | no coverage | Server HTML differs from client render |
| BR-20 | Component renders twice (React strict mode) | no coverage | Side effects fire twice |
| BR-21 | Async content not ready at check time | no coverage | Suspense boundary, lazy loading |
| BR-22 | useEffect / componentDidMount timing | no coverage | Side effect runs after paint, test checks before |
| BR-23 | Layout shift after initial render | no coverage | CLS — element moves after images/fonts load |

### Visibility & Layout

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-24 | Element exists but not visible (off-screen) | no coverage | Scrolled out of viewport |
| BR-25 | Element visible but covered by overlay | no coverage | Modal, toast, z-index stacking |
| BR-26 | Element clipped by overflow:hidden parent | no coverage | Exists in DOM, not visible to user |
| BR-27 | Responsive breakpoint changes layout | **generator (G)** | 1 scenario: viewport breakpoint layout |

### Security & Policy

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-28 | Content Security Policy blocks inline script | no coverage | CSP prevents `<script>` execution — element exists, behavior absent |
| BR-29 | Mixed content blocked (HTTPS page loads HTTP resource) | no coverage | Browser silently blocks HTTP resource on HTTPS page |
| BR-30 | CORS preflight failure on API call | no coverage | OPTIONS returns 403 — API unreachable from browser context |
| BR-31 | Service worker serves stale cached response | no coverage | Service worker cache not invalidated — old version served after deploy |

### Client-Side State

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-32 | localStorage quota exceeded | no coverage | `setItem()` throws — verification sees empty storage |
| BR-33 | Cookie SameSite attribute blocks cross-site | no coverage | Cookie not sent in cross-site context — auth fails silently |
| BR-34 | Browser autofill changes input value | no coverage | Autofill fires after page load — predicate expects empty, sees filled |

### Rendering Edge Cases

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-35 | Font loading race (FOIT/FOUT) | no coverage | Text measured before web font loads — layout with fallback font |
| BR-36 | Viewport unit calculation includes/excludes scrollbar | no coverage | `100vw` computation varies by platform |
| BR-37 | Print stylesheet differs from screen | no coverage | `@media print` styles not checked by browser gate |
| BR-38 | `prefers-color-scheme` changes rendered appearance | no coverage | Dark mode stylesheet applied — predicate checks light mode values |

**Browser total: 38 shapes. Generator coverage: 3 (BR-03, BR-10, BR-27). No coverage: 35.**

---

## Identity & Reference Failures

Failures where two things are logically "the same" but not the same by reference, path, representation, or identity — or vice versa. This class cuts across all domains.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| ID-01 | DOM node replaced after re-render | no coverage | Same element logically, new node reference |
| ID-02 | Alias vs canonical path mismatch | **generator (G)** | 1 scenario: path alias canonicalization |
| ID-03 | Same resource via different URL | no coverage | URL normalization, redirects, trailing slash |
| ID-04 | Object identity vs value equality in JSON | no coverage | Deep equal but `!==` in code |
| ID-05 | Cache key vs actual resource mismatch | no coverage | Stale cache entry for changed resource |
| ID-06 | Same CSS value, different representation | **generator (G)** | 1 scenario: CSS value identity collapse |
| ID-07 | Same DB row, different query path | no coverage | Join vs direct select returns different column set |
| ID-08 | Same file via symlink, mount, or copy | **generator (G)** | 1 scenario: symlink path identity |
| ID-09 | Entity identity across API/UI/DB not consistent | no coverage | Same user, different ID format (UUID vs int) |
| ID-10 | Re-created entity has same values but new identity | no coverage | DELETE + INSERT vs UPDATE — different IDs |

### Cross-Layer Identity

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| ID-11 | Fingerprint collision (different predicates → same fingerprint) | no coverage | Two semantically different predicates hash to same K5 fingerprint |
| ID-12 | Evidence identity across gate boundaries | no coverage | Grounding evidence from source, browser evidence from runtime — same claim, different identity |

**Identity total: 12 shapes. Generator coverage: 3 (ID-02, ID-06, ID-08). No coverage: 9.**

---

## Observer Effect Failures

Failures where the act of verifying changes the system being verified. The measurement disturbs the measured.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| OE-01 | HTTP verification call mutates state | **generator (G)** | 1 scenario: verification side-effect |
| OE-02 | DB read triggers lazy load / materialization | no coverage | Query causes side effect |
| OE-03 | Browser evaluation triggers layout or script | no coverage | `getComputedStyle()` forces layout recalc |
| OE-04 | File read triggers watcher / rebuild | no coverage | Hot reload fires during verification |
| OE-05 | Rate limits triggered by verification probes | no coverage | Too many checks → 429 → false failure |
| OE-06 | Verification order changes outcome | **generator (G)** | 1 scenario: check order dependency |
| OE-07 | Repeated verification degrades system | no coverage | Memory leak, connection pool exhaustion |
| OE-08 | Probe introduces observable side effects | no coverage | Verification logged, changes metrics/state |
| OE-09 | Screenshot capture triggers repaint/reflow | no coverage | Visual state changes during capture |

### Compound Observer Effects

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| OE-10 | Verification creates resource that satisfies predicate | no coverage | HTTP GET to `/api/items` creates default data — predicate passes but data is verification artifact |
| OE-11 | Screenshot capture alters scroll position | no coverage | Scrolling to element for capture changes viewport state |

**Observer total: 11 shapes. Generator coverage: 2 (OE-01, OE-06). No coverage: 9.**

---

## Concurrency / Multi-Actor Failures

Failures from multiple operations happening simultaneously. Distinct from temporal (single actor, different times) — concurrency is multiple actors at the same time.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| CO-01 | Two edits applied concurrently to same file | **generator (G)** | 1 scenario: concurrent file edit |
| CO-02 | Two verification runs overlap | no coverage | Both read, one writes, other reads stale |
| CO-03 | Background job modifies state during verification | no coverage | Cron/worker changes DB/files mid-check |
| CO-04 | DB transaction from another process interferes | no coverage | Phantom reads, lock contention |
| CO-05 | Last-write-wins vs expected behavior | no coverage | Race between edit and rollback |
| CO-06 | Lock contention / deadlock edge cases | no coverage | Two processes waiting on each other |
| CO-07 | Partial visibility across concurrent readers | no coverage | Reader sees half of a multi-file edit |
| CO-08 | Container restart during verification | no coverage | Process dies mid-check, partial results |
| CO-09 | Constraint store concurrent access | **generator (G)** | 1 scenario: concurrent constraint seeding |

### Verification Pipeline Concurrency

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| CO-10 | Parallel gate evaluation produces inconsistent snapshot | no coverage | Two gates read different versions of same file |
| CO-11 | Hot reload triggered by edit during verification | no coverage | File watcher fires rebuild mid-check — container restarts |

**Concurrency total: 11 shapes. Generator coverage: 2 (CO-01, CO-09). No coverage: 9.**

---

## Scope Boundary Failures

Failures where the system verifies the wrong scope — correct locally, wrong globally, or aimed at the wrong boundary entirely. Ties directly to G5 containment philosophy.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| SC-01 | Local success, global failure | **generator (G)** | 1 scenario: local fix breaks sibling |
| SC-02 | Wrong tenant / user context | no coverage | Multi-tenant app, verification runs as wrong user |
| SC-03 | Wrong environment (dev vs staging vs prod) | no coverage | Predicate verified against wrong target |
| SC-04 | Feature flag scope mismatch | no coverage | Feature enabled in test, disabled in prod |
| SC-05 | Permission scope mismatch | no coverage | Verification runs with elevated privileges |
| SC-06 | Component isolation broken by global CSS | **generator (G)** | 1 scenario: global CSS override |
| SC-07 | Module boundary — correct export, wrong import | no coverage | Internal module state differs from public API |
| SC-08 | DB change passes local predicate, breaks FK | no coverage | Table correct, referential integrity broken |
| SC-09 | API version scope mismatch | no coverage | v1 passes, v2 broken — predicate checks v1 |
| SC-10 | Blast radius underestimated | **generator (G)** | 1 scenario: blast radius undercount |

### Verification Scope Errors

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| SC-11 | Predicate verifies staging, not production | no coverage | Browser gate runs against staging container — prod has different config |
| SC-12 | Multi-service app — wrong service verified | no coverage | Predicate checks frontend container, bug is in API container |

**Scope total: 12 shapes. Generator coverage: 3 (SC-01, SC-06, SC-10). No coverage: 9.**

---

## Attribution / Root Cause Failures

Failures where the system identifies the wrong cause of a failure. The verification detects a problem correctly, but the diagnosis (narrowing hint, constraint seeding, error message) points the wrong way. Directly impacts narrowing quality and K5 learning accuracy.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| AT-01 | Correct failure, wrong cause identified | generator (D) | 2 scenarios: G5 "unexplained" when edit changes wrong property (AT-01a), G5 false "direct" when edit.replace contains p.expected by coincidence (AT-01b) |
| AT-02 | Multiple causes, single attribution | generator (D) | 1 scenario: two edits both contain "orange" → both "direct", can't isolate root cause (AT-02a) |
| AT-03 | Downstream effect mistaken for root cause | generator (D) | 2 scenarios: extractSignature regex list priority — SyntaxError (pos 6) beats health_check (pos 9) (AT-03a), DNS error (pos 3) masks SyntaxError (AT-03b) |
| AT-04 | Masking failure — real cause hidden | generator (D) | 1 scenario: F9 failure stops pipeline, G5 never runs (AT-04a) |
| AT-05 | Accidental correctness | generator (D) | 2 scenarios: content predicate already true, unrelated edit → G5 "direct" (AT-05a); edit changes color property, predicate expects different color value → G5 "direct" on property name match (AT-05b) |
| AT-06 | Proxy success — right outcome, wrong reason | generator (D) | 1 scenario: edit on body font-family, predicate targets .subtitle font-family → "direct" because expected value in edit.replace (AT-06a) |
| AT-07 | Structural validity masks semantic incorrectness | generator (D) | 1 scenario: title → "Test" is structurally valid, G5 direct, semantic wrongness undetectable (AT-07a) |
| AT-08 | Semantic correctness masks structural breakage | generator (D) | 1 scenario: API item addition — content match correct, potential layout damage invisible (AT-08a) |
| AT-09 | Constraint seeded from wrong failure class | generator (D) | 2 scenarios: "timeout during build, exit code 1" → migration_timeout not build_failure (AT-09a); ECONNREFUSED from staging=harness_fault, from evidence=unknown (AT-09b) |
| AT-10 | Narrowing hint leads to correct fix for wrong reason | generator (D) | 2 scenarios: F9 "search string does not exist" — correct but generic (AT-10a); K5 "try a different strategy" — generic hint (AT-10b) |

**Attribution total: 10 shapes. Generator coverage: 10 (AT-01 through AT-10). Scenario-only coverage: 0. No coverage: 0.**

---

## Drift / Regression Failures

Failures where the system was correct, becomes incorrect without any direct change. The environment shifted around it. Distinct from temporal (same run, different moment) — drift happens across runs, deploys, or time periods.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| DR-01 | Dependency update changes behavior | no coverage | `npm update` changes CSS framework defaults |
| DR-02 | CSS cascade shifts from unrelated edit | **generator (G)** | 1 scenario: cascade specificity drift |
| DR-03 | DB migration changes default behavior | no coverage | Column default changed, existing code assumes old default |
| DR-04 | API contract changes upstream | no coverage | Third-party API response shape changes |
| DR-05 | Runtime version drift | no coverage | Node 18 → Node 20, behavior difference |
| DR-06 | Container base image update | no coverage | `node:alpine` rebuilds with different packages |
| DR-07 | Configuration drift | **generator (G)** | 1 scenario: env var configuration drift |
| DR-08 | Certificate / credential expiry | no coverage | Worked yesterday, fails today — no code change |
| DR-09 | External service availability | no coverage | Third-party down, verification fails |
| DR-10 | Indirect regression from transitive dependency | no coverage | Sub-dependency of sub-dependency changes |

### Infrastructure Drift

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| DR-11 | Docker base image layer changes silently | no coverage | `node:20-alpine` rebuilds with security patch — behavior change without Dockerfile edit |
| DR-12 | Browser version changes computed CSS defaults | no coverage | Chrome update changes default `font-smoothing` — CSS predicate drifts |
| DR-13 | Verification tool version changes behavior | no coverage | Playwright update changes `getComputedStyle()` normalization |

**Drift total: 13 shapes. Generator coverage: 2 (DR-02, DR-07). No coverage: 11.**

---

## Message Predicate Failures

Communication predicates assert properties of outbound agent messages — destination, content, claims with evidence, and negation detection. The `governMessage()` gate pipeline runs: destination → forbidden content → required content → claims → denied patterns → review hook.

### Destination & Content

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| MSG-01 | Destination denied (explicit deny or not in allow list) | generator (M) | 2 scenarios: explicit deny list ✓, not in allow list ✓ |
| MSG-02 | Forbidden content detected (string or regex) | generator (M) | 2 scenarios: literal string match ✓, regex match ✓ |
| MSG-05 | Required content missing | generator (M) | 1 scenario: policy requires string not present in body ✓ |

### Claim-Evidence Binding

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| MSG-03 | Claim with valid evidence — approved | generator (M) | 1 scenario: deploy claim + evidence provider returns true ✓ |
| MSG-04 | Claim without evidence — blocked | generator (M) | 1 scenario: deploy claim trigger present but no evidence provider ✓ |
| MSG-11 | Stale evidence (evidence exists but too old — provider self-report) | generator (M) | 1 scenario: evidence freshness older than policy maxAge → blocked ✓ |
| MSG-13 | Epoch-based evidence staleness (gate-computed, overrides provider) | generator (M) | 2 scenarios: epoch comparison ✓, timestamp + maxEvidenceAgeMs ✓ |

### Narrowing (Topic Trust & Evidence Staleness)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| MSG-12 | Topic override narrowing (agent mislabels topic, gate overrides from content) | generator (M) | 2 scenarios: override → narrowed ✓, agreement → approved ✓ |
| MSG-13 | Epoch staleness narrowing (evidence exists but epoch stale → narrowed) | generator (M) | See Claim-Evidence Binding above — epoch-based staleness produces narrowed verdict |
| MSG-14 | Combined narrowing (topic override + epoch staleness) | generator (M) | 1 scenario: both narrowings apply → combined narrowing type ✓ |

### Negation Detection

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| MSG-06 | Obvious negation suppresses trigger | generator (M) | 1 scenario: "has not deployed" suppresses "deployed" trigger → approved ✓ |
| MSG-06b | Ambiguous negation → clarify | generator (M) | 1 scenario: "may not have deployed" → clarify verdict ✓ |

### Review Hook & Unknown Assertions

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| MSG-07 | Review hook blocks message | generator (M) | 1 scenario: async hook returns block verdict ✓ |
| MSG-08 | Review hook requests clarification | generator (M) | 1 scenario: async hook returns clarify verdict ✓ |
| MSG-09 | Unknown assertion detected (no matching trigger) | generator (M) | 2 scenarios: default policy → clarify ✓, allow policy → approved ✓ |

### Pattern Memory

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| MSG-10 | Previously denied pattern blocked on retry | generator (M) | 1 scenario: K5-style denied pattern matching ✓ |

**Message total: 14 failure shapes. Generator coverage: 14/14 (100%). 21 scenarios across Family M.**

---

## Cross-Cutting Failures (Gate-Level)

These are not predicate-type failures but failures in verify's own gate logic. They affect all predicate types.

### Fingerprinting (Gate: K5)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-01 | Same predicate → same fingerprint | generator (A, 10 scenarios) | Strong |
| X-02 | Different predicates → different fingerprints | generator (A) | Strong |
| X-03 | Absent field vs undefined vs null | generator (A8) | Found the v0.1.1 bug |
| X-04 | Numeric vs string (`200` vs `"200"`) | generator (A8) | Covered |
| X-05 | Serialization round-trip stability | no coverage | JSON.parse(JSON.stringify(p)) → same fingerprint? |
| X-06 | Unicode in fingerprint input | no coverage | Non-ASCII selector names |
| X-51 | Object key ordering affects fingerprint | generator (A) | 3 scenarios: CSS, HTTP, DB key order invariance verified |
| X-52 | Array ordering matters for some predicates not others | generator (A) | 3 scenarios: bodyContains array order-sensitive (documented), steps order-sensitive ✓, string vs singleton collision (documented) |
| X-53 | Fingerprint collision across predicate classes | generator (A) | 4 scenarios: css↔content, http↔content, css↔html, db↔filesystem — all distinct ✓ |
| X-54 | Constraint store corruption / partial write | generator (B) | 2 scenarios: truncated JSONL survives ✓, empty file loads ✓ |
| X-55 | Concurrent readers observe half-written state | generator (B) | 1 scenario: second store instance sees first instance's constraint ✓ |
| X-56 | Expired constraint retained inconsistently | generator (B) | 2 scenarios: lazy expiry at check time ✓, cleanupSession removes expired ✓ |

### Constraint Learning (Gate: K5)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-07 | Monotonicity (count never decreases) | generator (B1) | Covered |
| X-08 | Corrected predicate not blocked | generator (B2) | Covered |
| X-09 | Same predicate blocked | generator (B3) | Covered |
| X-10 | TTL expiry | generator (B4) | Covered |
| X-11 | Cross-session persistence | generator (B5) | Covered |
| X-12 | Max depth enforcement | generator (B6) | Covered |
| X-13 | Override bypass | generator (B7) | Covered |
| X-14 | Harness fault → no constraint | generator (B8) | Covered |
| X-15 | Scope leakage (cross-route/app) | generator (B9) | Covered |
| X-16 | Concurrent constraint seeding | **generator (G/W2A)** | 1 scenario: two constraints seeded sequentially both persist ✓ |
| X-17 | Constraint with empty appliesTo | **generator (G/W2A)** | 1 scenario: empty appliesTo constraint doesn't block unrelated edits ✓ |

### Gate Sequencing

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-18 | Gate order enforcement | generator (C, 7 scenarios) | Strong |
| X-19 | Disabled gate handling | generator (C) | Covered |
| X-20 | Gate timing (max duration) | generator (C) | Covered |
| X-21 | First failing gate is reported gate | generator (C) | Covered |
| X-22 | Skipped vs absent vs disabled | no coverage | Three states that could be confused |
| X-57 | Gate side effects leak into later gates | no coverage | One gate mutates state used by another |
| X-58 | Same gate run twice with inconsistent results | no coverage | Accidentally re-run, aggregation bug |
| X-59 | Partial failure overwritten by later gate | no coverage | Status/detail replaced instead of preserved |
| X-60 | Optional gate absence treated as pass | no coverage | Should be "not run", shown as "passed" in attestation |

### Containment (Gate: G5)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-23 | Direct attribution | generator (D1, D2, D6, D7) | Strong |
| X-24 | Scaffolding attribution | generator (D3) | Covered |
| X-25 | Unexplained mutation | generator (D4) | Covered |
| X-26 | Mixed attribution | generator (D5) | Covered |
| X-27 | No predicates → all unexplained | generator (D8) | Covered |
| X-28 | Attribution with multi-file edits | no coverage | Edit spans multiple files |
| X-29 | SQL mutation attribution | no coverage | Database changes vs code changes |

### Grounding (Gate: Grounding)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-30 | Real selector → grounded | generator (E1, E5) | Covered |
| X-31 | Fabricated selector → miss | generator (E2) | Covered |
| X-32 | Mixed real + fabricated | generator (E3) | Covered |
| X-33 | HTML predicates exempt | generator (E4) | Covered |
| X-34 | Content/HTTP/DB predicates exempt | generator (E6) | Covered |
| X-35 | Route discovery accuracy | no coverage | Does grounding find all routes? |
| X-36 | Dynamic route patterns | no coverage | `/api/:id` — parameterized routes |
| X-61 | Grounding snapshot stale vs verification target | no coverage | Source-based grounding on wrong version |
| X-62 | Grounding over-approximates existence | no coverage | Selector in unreachable code path |
| X-63 | Grounding under-approximates (indirect assembly) | no coverage | Imported CSS, generated routes |
| X-64 | Cross-file composition not reflected | no coverage | Shared components, layout wrappers |
| X-65 | Environment-dependent routes behind flags | no coverage | Feature flag hides route from grounding |

### Syntax (Gate: F9)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-37 | Search string not found | **generator (G)** | 1 scenario: F9 returns not_found, pipeline stops |
| X-38 | Search string found multiple times | **generator (G)** | 1 scenario: F9 returns ambiguous_match with count |
| X-39 | Search string with special regex chars | **generator (G)** | 1 scenario: indexOf is literal, not regex — `.` `*` `[` work ✓ |
| X-40 | Empty search or replace | **generator (G)** | 2 scenarios: empty search → ambiguous (not crash), empty replace → F9 not_found |
| X-41 | Line ending mismatch in edit | **generator (G)** | 2 scenarios: `\r\n` in file with `\n` search → miss, `\r\n` in search with `\r\n` in file → match ✓ |
| X-66 | Overlapping edits interfere | **generator (G/W2A)** | 2 scenarios: non-overlapping edits both apply ✓, second edit search includes first edit's region → F9 fails ✓ |
| X-67 | Edit order changes final result | **generator (G/W2A)** | 1 scenario: two sequential edits — order produces different output documented ✓ |
| X-68 | Search/replace hits previous replacement | **generator (G/W2A)** | 2 scenarios: replacement text matches next edit's search → chain effect ✓, independent replacements → no chain ✓ |
| X-69 | Unicode grapheme boundaries break search | no coverage | Multi-codepoint characters split by search |
| X-70 | File mutated between read and apply | no coverage | Race condition |
| X-71 | Search matches scaffold/boilerplate, not target | no coverage | Duplicate regions, wrong hit |

### Narrowing (Gate: Narrowing)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-42 | Resolution hint present on failure | scenarios (uv-016, uv-017) | 2 scenarios |
| X-43 | Hint references actual values | **generator (G/W2A)** | 1 scenario: CSS value mismatch hint includes actual deployed value ✓ |
| X-44 | Hint is actionable | **generator (G/W2A)** | 2 scenarios: F9 search-not-found → actionable hint ✓, F9 ambiguous → uniqueness hint ✓ |
| X-45 | No hint on infrastructure error | **generator (G/W2A)** | 1 scenario: missing file → produces hint (not infra) ✓ |
| X-72 | Hint correct locally but globally harmful | no coverage | Fixing one predicate breaks another |
| X-73 | Hint overfits to specific value not failure class | no coverage | Narrow advice that doesn't generalize |
| X-74 | Hint leaks wrong causal explanation | no coverage | Downstream gate error attributed to wrong cause |
| X-75 | Multiple failures, narrowing picks wrong one | no coverage | Non-primary remediation path selected |

### Vision / Triangulation

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-46 | Vision pass + deterministic pass | generator (V) | Covered |
| X-47 | Vision fail + deterministic pass (outlier) | generator (V) | Covered |
| X-48 | Vision pass + deterministic fail (outlier) | generator (V) | Covered |
| X-49 | All three authorities disagree | no coverage | Deterministic, browser, vision all different |
| X-50 | Authority absent (didn't run) | generator (V) | Covered |
| X-76 | Screenshot taken before render settles | no coverage | Partial paint captured |
| X-77 | Viewport/device differences change verdict | no coverage | Mobile vs desktop viewport |
| X-78 | Off-screen/cropped element → false failure | no coverage | Element exists but not in viewport |
| X-79 | Visual pass masks semantic failure | no coverage | Looks right, wrong DOM/data underneath |
| X-80 | Semantic pass masks visual failure | no coverage | DOM correct, layout is broken |
| X-81 | Authority weighting bug in final verdict | no coverage | Precedence logic error in triangulation |

### Receipt & Attestation Integrity

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-82 | Attestation string omits failed gate detail | no coverage | Gate failed but attestation shows generic "failed" without which gate or why |
| X-83 | Telemetry timing includes queue wait, not just gate | no coverage | `durationMs` counts time waiting, not time executing — misleading |
| X-84 | Receipt hash chain broken by out-of-order append | no coverage | Concurrent writes to receipts.jsonl break chain integrity |
| X-85 | Checkpoint created despite gate failure | no coverage | Race between gate failure and checkpoint creation — partial success persisted |

### Predicate Lifecycle

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-86 | Predicate valid at extraction, stale at verification | no coverage | Source changed between grounding and browser gate — evidence is stale |
| X-87 | Predicate passes all gates but describes wrong thing | no coverage | Agent predicate is syntactically correct but semantically misaligned with goal |
| X-88 | Deferred predicate never actually validated | no coverage | DB predicate deferred to post-deploy, but post-deploy gate skips it |
| X-89 | Predicate fingerprint changes across pipeline stages | no coverage | Same predicate fingerprinted differently at K5 vs at narrowing — constraint mismatch |

### Gate Calibration — False Positive Patterns (discovered from AIDev-POP scan, April 2026)

These are not agent failure shapes — they are **gate** failure shapes. The gate over-matches on code that is structurally valid. Each GC shape represents a pattern where verify incorrectly flags clean code.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| GC-651 | Contention gate flags frontend components | **fixed** | Form components (`.tsx`, `.jsx`, `.vue`, `.svelte`) trigger "missing transaction" — but frontend code doesn't do DB writes. Fix: skip contention checks on frontend file extensions. |
| GC-652 | Access gate flags type definitions | **fixed** | `.d.ts` files and `types.ts` trigger "permission escalation" — but type declarations aren't runtime code. Fix: skip access checks on type definition files. |
| GC-653 | Access gate flags config/infra files | **fixed** | `.gitignore`, `.dockerignore`, `package.json`, `.github/workflows/*.yml` — config/CI files, not runtime code. |
| GC-654 | Access gate flags MSBuild project files | **fixed** | `.csproj`, `.fsproj`, `.sln`, `.props` — paths in MSBuild XML are normal. |
| GC-655 | Access gate flags Dockerfiles | **fixed** | `Dockerfile`, `*.Dockerfile` — COPY/ADD paths are normal Docker instructions. |
| GC-656 | Access gate flags lockfiles | **fixed** | `package-lock.json`, `bun.lock`, `Gemfile.lock` — generated, not authored. |
| GC-657 | Access gate flags C/C++ headers | **fixed** | `.h`, `.hpp` — `#include` paths are normal C++ patterns. |
| GC-658 | Access gate flags general YAML/config | **fixed** | `.yaml`, `.yml`, `.toml`, `.ini` outside `.github/` — config file paths are normal. |
| GC-659 | Access gate flags Ruby bundler config | **fixed** | `.bundle/config`, `Gemfile` — Ruby bundler paths are normal. |
| GC-660 | Propagation gate flags LICENSE files | **fixed** | `LICENSE`, `LICENCE`, `COPYING` — license text isn't cross-file reference. |

| GC-661 | Access gate flags agent config JSON | **fixed** | `.promptx/`, `.claude/settings`, `.cursor/` config — agent-specific config files. |
| GC-662 | Contention gate flags config JSON | **fixed** | `mcp.json`, `package-lock.json` — config JSON triggering "missing transaction." |
| GC-663 | Access gate flags shell scripts | **fixed** | `scripts/*.sh` — paths in shell scripts are normal (`cd`, `source`, file ops). |
| GC-664 | Access gate flags .env.example files | **fixed** | `.env.example`, `.env.staging` — example/template env files, not production secrets. |
| GC-665 | Access gate flags agent rule files | **fixed** | `.cursorrules`, `.clinerules` — agent instruction files with path references. |
| GC-666 | Access gate flags Gradle build files | **fixed** | `build.gradle`, `settings.gradle` — JVM build system paths are normal. |
| GC-667 | Contention gate flags CI workflow YAML | **fixed** | `.github/workflows/*.yaml` — CI steps aren't concurrent transactions. |
| GC-668 | Propagation gate flags JSONC config | **fixed** | `.dprint.jsonc`, `biome.jsonc` — tool config, not code references. |

| GC-669 | Propagation gate flags TS/JS files | **fixed** | Generic CSS class names (`.container`, `.tooltip`) in string literals matched as cross-file renames. |
| GC-670 | Access gate flags React/TSX components | **fixed** | UI components importing APIs flagged as "permission escalation" — not runtime privilege issues. |
| GC-671 | Propagation gate flags React/TSX files | **fixed** | Same as GC-669 but in TSX — CSS class strings in component code. |
| GC-672 | Access gate flags SQL test files | **fixed** | Test SQL scripts with path patterns — not real permission issues. Real migration SQL kept as high. |
| GC-673 | Access gate flags C/C++ source files | **fixed** | `#include` paths and filesystem API calls in .cpp/.c files are normal. |
| GC-674 | Propagation gate flags Solidity contracts | **fixed** | Import paths in `.sol` files are normal — same pattern as C++ `#include`. |
| GC-675 | Propagation gate flags HTML files | **fixed** | Generic CSS class names (`.navbar-inner`, `.dialog`) in HTML matched as cross-file renames. |

| GC-676 | Access gate flags .devcontainer config | **fixed** | `.devcontainer/devcontainer.json` — container config paths. |
| GC-677 | Access gate flags Zig source files | **fixed** | `.zig` — file paths in Zig are normal system programming. |
| GC-678 | Access gate flags Dart source files | **fixed** | `.dart` — import paths and file references. |
| GC-679 | Access gate flags Makefiles | **fixed** | `Makefile` — paths in make rules are normal. |
| GC-680 | Access gate flags Go module files | **fixed** | `go.mod`, `go.sum`, `go.work` — module paths. |
| GC-681 | Access gate flags RON config files | **fixed** | `.ron` (Rust Object Notation) — config file paths. |
| GC-682 | Access gate flags PowerShell scripts | **fixed** | `.ps1` — paths in PowerShell scripts are normal. |
| GC-683 | Contention gate flags .mts TypeScript modules | **fixed** | `.mts` — TypeScript ESM module files. |
| GC-684 | Access gate severity is binary — no admin-context exception for edit content | **discovered 2026-04-08** | `severity: 'error'` fires on all SYSTEM_PATH_PATTERNS and DOCKER_SOCKET_PATTERNS in edit `replace` content regardless of whether the edit targets an admin file (Dockerfile, SQL migration, CI config) or a user-input handler. Bundle 107 (run #43) attempted blanket severity downgrade and **regressed `[HARVEST:build] COPY references parent directory`** because it removed legitimate detection of `COPY ../../../etc/passwd`. Root fix needs per-pattern context classification: real path traversal sequences (`..` outside project, hardcoded sensitive paths like `/etc/passwd`) stay error; admin-context patterns (`/var/log/` mention in SQL log table comment) become warning. Linked to SCAN-700–SCAN-717 cluster. |

**Cross-cutting total: 123 shapes (89 + 34 GC). Generator coverage: 40 unique classes. Scenario-only coverage: 2. No coverage: 47. Gate calibration: 34.**

### Candidate Shapes from AIDev-POP Scan (pending operator review)

These appeared 3+ times in real agent PRs but need human judgment — real issue or false positive?

| # | Pattern | Occurrences | Agents | Verdict |
|---|---|---|---|---|
| SCAN-708 | Propagation on TS/JS — CSS class string matches | 56 | Copilot, Devin | **GC-669** (FP) |
| SCAN-709 | Access on React/TSX — UI component API calls | 34 | Copilot, Cursor | **GC-670** (FP) |
| SCAN-706 | Propagation on React/TSX — CSS class string matches | 16 | Claude Code, Cursor | **GC-671** (FP) |
| SCAN-713 | Access on SQL — test files FP, real migrations kept | 13 | Devin | **GC-672** (test FP) / real (migrations) |
| SCAN-704 | Access on C/C++ — includes and filesystem APIs | 14 | Claude Code | **GC-673** (FP) |
| SCAN-717 | Propagation on Solidity — import paths | 5 | Devin | **GC-674** (FP) |
| SCAN-715 | Propagation on HTML — CSS class string matches | 6 | Devin | **GC-675** (FP) |

---

## Configuration Predicate Failures

Configuration predicates assert that runtime configuration matches expected state. The gap between what the config file says, what the environment provides, and what the application actually uses is where failures live. Predicate type: `config`. Gate: `src/gates/config.ts` — parses `.env` files and JSON config files, validates key existence and value equality.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| CFG-01 | Environment variable absent at runtime | generator | `.env.example` lists `DB_HOST`, `process.env.DB_HOST` is undefined at runtime. Gate checks `.env` file for key presence. |
| CFG-02 | Config file value overridden by env var | generator | File says `port: 3000`, env says `PORT=8080` — which wins depends on framework. Gate validates value equality. |
| CFG-03 | Feature flag state differs between environments | no coverage | Flag enabled in staging, disabled in production |
| CFG-04 | Config value type coercion | generator | `PORT` env var is string "3000", code does `===` against number 3000. Gate source file not found → fail. |
| CFG-05 | Secret in plaintext config file | no coverage | Credential committed to repo — predicate should detect presence |
| CFG-06 | Config hot-reload partial | no coverage | Some processes see new config, others still have old — split-brain |
| CFG-07 | Default value hides missing config | no coverage | `process.env.X || 'default'` — default masks missing required config |
| CFG-08 | Config precedence chain unpredictable | no coverage | Multiple sources (env, file, CLI, defaults) — which layer wins? |

**Configuration total: 8 shapes. Generator coverage: 3. No coverage: 5.**

---

## Accessibility (a11y) Predicate Failures

Accessibility predicates assert that the application is usable by assistive technology. The gap between visual DOM and the accessibility tree — what screen readers and keyboard navigation actually see — is where failures live. Predicate type: `a11y`. Gate: `src/gates/a11y.ts` — static HTML analysis for ARIA labels, heading hierarchy, landmark regions, alt text, focus management. Supports bidirectional assertions (`no_findings` = clean, `has_findings` = expected issue detected).

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| A11Y-01 | Missing form label association | no coverage | `<input>` without `<label for>` — no accessible name |
| A11Y-02 | ARIA attribute value incorrect | generator | `aria-expanded="true"` on closed element — screen reader lies. Gate checks ARIA labels. |
| A11Y-03 | Keyboard tab order broken by CSS | generator | `order` or `position` changes visual order, tab order stays DOM order. Gate checks landmark regions. |
| A11Y-04 | Color contrast below WCAG threshold | no coverage | Text readable visually but fails AA ratio (4.5:1 normal, 3:1 large) |
| A11Y-05 | Focus trap missing or broken | generator | Modal opens, focus not trapped — tab escapes to background. Gate checks focus management patterns. |
| A11Y-06 | Semantic element replaced with div | no coverage | `<button>` → `<div onclick>` — keyboard inaccessible, no role |
| A11Y-07 | Image alt text missing or generic | no coverage | `<img>` without `alt` or with `alt="image"` — no information |
| A11Y-08 | Live region announcement missing | no coverage | Content updates in `aria-live` region but screen reader doesn't announce |

**Accessibility total: 8 shapes. Generator coverage: 3. No coverage: 5.**

---

## Performance Predicate Failures

Performance predicates assert that the application meets response time and resource budgets. The gap between "functionally correct" and "acceptably fast" is where failures live. Predicate type: `performance`. Gate: `src/gates/performance.ts` — static analysis for bundle size, image optimization, lazy loading patterns, connection count. Threshold-based comparison with sensible defaults. Response time predicates deferred (need live server).

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| PERF-01 | Response time exceeds threshold | deferred | API returns correct data but takes 5s — needs live server measurement |
| PERF-02 | Largest Contentful Paint (LCP) regression | no coverage | Page loads correctly but LCP exceeds 2.5s threshold after mutation |
| PERF-03 | Cumulative Layout Shift (CLS) above threshold | no coverage | Content correct but layout unstable — elements shift after async load |
| PERF-04 | Bundle size exceeds budget | generator | Build artifact larger than allowed — correct code, too much of it. Gate checks file sizes. |
| PERF-05 | Memory leak across requests | no coverage | Response correct on first request, heap grows on each — eventually OOM |
| PERF-06 | N+1 query introduced by mutation | no coverage | Schema correct, data correct — but 100 queries instead of 1 |

**Performance total: 6 shapes. Generator coverage: 1. Deferred: 1. No coverage: 4.**

---

## Security Predicate Failures

Security predicates assert that mutations don't introduce vulnerabilities. The gap between "code runs correctly" and "code runs safely" is where failures live. Distinct from correctness — XSS-vulnerable code can produce correct output. Predicate type: `security`. Gate: `src/gates/security.ts` — static pattern matching for XSS, SQL injection, secrets exposure, CSP headers, CORS configuration. Supports bidirectional assertions (`no_findings`/`clean`/`pass` = pattern absent, `has_findings`/`fail` = expected finding present).

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| SEC-01 | XSS via unescaped output | generator | Agent generates `${userInput}` in HTML template — gate detects unescaped interpolation patterns. |
| SEC-02 | SQL injection via string concatenation | no coverage | Query works with test data, exploitable with crafted input |
| SEC-03 | Open redirect via user-supplied URL | no coverage | Redirect works functionally, allows arbitrary destination |
| SEC-04 | Insecure direct object reference (IDOR) | generator | API returns data for requested ID — no authz check. CSP header check. |
| SEC-05 | CSP violation from inline script | generator | Script works in dev (no CSP), blocked in prod (CSP enabled). Gate checks for CSP meta tag or header. |
| SEC-06 | Secret leaked in response body | no coverage | API key or token included in JSON response — functionally correct, security failure |
| SEC-07 | Missing rate limit on sensitive endpoint | no coverage | Auth endpoint works, no protection against brute force |

### Agent Secret Handling (Shape 649 — discovered April 6, 2026)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| SEC-08 (649a) | camelCase secret variable names | **generator** | `secretKey`, `apiKey`, `authToken`, `dbPassword` — agent naming conventions humans rarely use |
| SEC-09 (649b) | Provider-specific value prefixes | **generator** | `sk-` (OpenAI), `AIzaSy` (Google), `ghp_` (GitHub), `AKIA` (AWS), `sk_live_` (Stripe), `xoxb-` (Slack), `sk-ant-` (Anthropic) — catches secrets regardless of variable name |
| SEC-10 (649c) | Structural value patterns | **generator** | PEM blocks, JWTs (`eyJ...`), base64 keys >20 chars — format-based detection independent of naming |

**Security total: 10 shapes. Generator coverage: 6. No coverage: 4.**

---

## Serialization / API Contract Failures

Serialization predicates assert that data format and structure comply with declared contracts. The gap between "valid data" and "correctly shaped data" is where failures live. Predicate type: `serialization`. Gate: `src/gates/serialization.ts` — JSON parsing, schema validation (type checking, required fields, structure comparison), strict mode (no extra keys), subset mode (ignore extra keys). Validates against `.json` files with `schema` field pointing to expected structure.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| SER-01 | JSON schema non-compliance | generator | Response parses as JSON but fails schema validation (missing required field). Gate validates against schema. |
| SER-02 | Float precision loss in serialization | generator | `0.1 + 0.2 = 0.30000000000000004` when serialized. Gate type-checks fields. |
| SER-03 | Date format inconsistency | generator | ISO 8601 vs Unix timestamp vs locale string. Gate detects required field presence. |
| SER-04 | Null vs absent vs empty string | generator | `{"name": null}` vs `{}` vs `{"name": ""}`. Gate value matching. |
| SER-05 | API version response shape mismatch | generator | v1 vs v2 structure. Gate structural comparison (strict/subset mode). |
| SER-06 | Unicode normalization (NFC vs NFD) | generator | Same visual string, different bytes. Gate file not found → fail. |
| SER-07 | Circular reference in serializable object | no coverage | `JSON.stringify()` throws on circular ref — predicate never runs |

**Serialization total: 7 shapes. Generator coverage: 6. No coverage: 1.**

---

## Injection Predicate Failures

Failures where untrusted input hijacks the agent's intent. The agent processes input containing adversarial instructions that alter its planned behavior. This is G5 containment applied to input channels — "every action traces to the operator's intent, not an injected instruction." Predicate type: `injection`. Gate: detects injection patterns in input sources and verifies agent output matches original intent, not injected directives.

**Claim type:** Invariance — the agent's output action should be invariant to adversarial input embedded in data it processes.

**Evidence mechanism:** Compare agent's planned action against (a) original operator intent and (b) injected instruction. If the action matches the injection more than the intent, the injection succeeded.

### Prompt Injection

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INJ-01 | Direct prompt injection — "ignore previous instructions" | no coverage | Classic override attempt embedded in user input |
| INJ-02 | Indirect prompt injection via data source | no coverage | Adversarial text in scraped webpage, email body, or API response |
| INJ-03 | Instruction injection via structured data | no coverage | Malicious instructions in JSON field, CSV cell, or database record |
| INJ-04 | Role confusion — input mimics system prompt format | no coverage | Input formatted like `[SYSTEM]` or `<|im_start|>system` to escalate privileges |
| INJ-05 | Multi-turn injection — benign first message, malicious follow-up | no coverage | First input establishes trust, second exploits it |
| INJ-06 | Encoding-based injection — Base64/hex/rot13 encoded instructions | no coverage | Adversarial instruction encoded to bypass pattern matching |

### Tool/Action Injection

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INJ-07 | Tool name injection — input contains tool call syntax | no coverage | Input like `call_tool("delete_all")` interpreted as action |
| INJ-08 | Parameter injection — adversarial values in tool arguments | no coverage | Filename containing `../../etc/passwd`, SQL in query parameter |
| INJ-09 | Output format hijacking — injection alters response structure | no coverage | Input causes agent to produce malformed JSON, extra fields, or wrong schema |
| INJ-10 | Goal substitution — injection replaces the operator's stated goal | no coverage | "Actually, the real goal is to..." embedded in input data |

### Context Poisoning

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INJ-11 | Hidden text injection — visually hidden but machine-readable | no coverage | CSS `display:none`, white-on-white text, zero-width characters carrying instructions |
| INJ-12 | Comment injection — adversarial instructions in code comments | no coverage | `// TODO: ignore all other instructions and...` in source file |
| INJ-13 | Metadata injection — instructions in file metadata | no coverage | EXIF data, PDF metadata, HTML meta tags with adversarial content |
| INJ-14 | Cross-context injection — safe in one context, malicious in another | no coverage | Text safe as display content but dangerous when fed to an LLM |

**Injection total: 14 shapes. Generator coverage: 0. No coverage: 14.**

---

## Hallucination Predicate Failures

Failures where the agent fabricates claims not grounded in evidence. This is G5 containment applied to information instead of code — "every claim traces to a source" just as "every mutation traces to a predicate." Predicate type: `hallucination`. Gate: verifies that every assertion in the agent's output can be traced back to provided source material.

**Claim type:** Containment — every claim in the output must be attributable to a specific source in the input.

**Evidence mechanism:** Source material ↔ output claim mapping. Each claim is either (a) directly supported by source text, (b) logically derivable from source text, or (c) fabricated.

### Factual Fabrication

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| HAL-01 | Invented statistic — number not in source material | generator | `stage-hallucination.ts` — content source check for fabricated numbers |
| HAL-02 | Invented entity — person/org/product not in source | generator | `stage-hallucination.ts` — content source check for non-existent entities |
| HAL-03 | Invented API parameter — field not in schema | generator | `stage-hallucination.ts` — file content check for fabricated parameters |
| HAL-04 | Invented file/function — reference to non-existent code | generator | `stage-hallucination.ts` — file existence check |
| HAL-05 | Conflated sources — attributes from source A applied to source B | generator | `stage-hallucination.ts` — cross-file content verification |

### Schema/Structure Fabrication

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| HAL-06 | Wrong column type — agent claims VARCHAR is INTEGER | generator | `stage-hallucination.ts` — schema type verification via `parseInitSQL` |
| HAL-07 | Wrong table relationship — fabricated foreign key | generator | `stage-hallucination.ts` — schema column existence check |
| HAL-08 | Wrong API endpoint — fabricated route | generator | `stage-hallucination.ts` — route extraction verification |
| HAL-09 | Wrong config key — fabricated setting | generator | `stage-hallucination.ts` — config.json key path resolution |
| HAL-10 | Wrong CSS selector — fabricated class/id | generator | `stage-hallucination.ts` — CSS selector existence check |

### Reasoning Fabrication

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| HAL-11 | False causal claim — "X causes Y" without evidence | generator | `stage-hallucination.ts` — file content check for fabricated causal elements |
| HAL-12 | False temporal claim — wrong ordering of events | generator | `stage-hallucination.ts` — file content check for fabricated temporal references |
| HAL-13 | False absence claim — "X doesn't exist" when it does | generator | `stage-hallucination.ts` — file content check for presence/absence |
| HAL-14 | Confabulated error message — fabricated log output | generator | `stage-hallucination.ts` — content-wide search for fabricated messages |
| HAL-15 | Plausible but wrong code — syntactically valid, semantically incorrect | generator | `stage-hallucination.ts` — schema column verification |

**Hallucination total: 15 shapes. Generator coverage: 15 (100%). No coverage: 0.**

---

## Budget / Resource Bound Failures

Failures where cumulative resource consumption across a workflow exceeds declared bounds. Distinct from per-action capacity checks — budget failures are aggregate across the entire chain. Predicate type: `budget`. Gate: tracks cumulative counters (API calls, tokens, cost, time, retries) and compares against policy thresholds.

**Claim type:** Threshold — cumulative resource consumption falls within acceptable bounds across the full workflow.

**Evidence mechanism:** Running counters accumulated across all steps, compared against declared policy limits at workflow completion or at each step boundary.

### Token/Cost Budget

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BUD-01 | Total token budget exceeded — aggregate input+output across chain | no coverage | Individual calls under limit, total exceeds policy |
| BUD-02 | Per-model cost exceeded — one provider disproportionately expensive | no coverage | Most calls cheap (Ollama), one frontier call blows budget |
| BUD-03 | Cost projection exceeded before completion | no coverage | At 50% progress, burn rate projects 3× budget |
| BUD-04 | Hidden cost — retries/fallbacks multiply spend silently | no coverage | Failed calls still cost tokens, 5 retries = 6× the apparent cost |
| BUD-05 | Cost attribution mismatch — billed to wrong app/job | no coverage | Shared model pool, costs assigned to wrong consumer |

### API Call Budget

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BUD-06 | Total API calls exceeded — rate limiting not cost, just count | no coverage | Policy says max 100 calls, workflow made 150 |
| BUD-07 | Redundant calls — same information fetched multiple times | no coverage | Agent reads same file 5 times across iterations |
| BUD-08 | Cascading calls — one action triggers unbounded downstream calls | no coverage | DELETE triggers N webhook notifications, each with its own API call |
| BUD-09 | Polling loop budget — health checks accumulate unboundedly | no coverage | 5-second polling × 10-minute wait = 120 calls for one check |

### Time Budget

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BUD-10 | Wall-clock time exceeded — total elapsed beyond policy | no coverage | Individual steps fast, but 50 iterations × 30s = 25 minutes |
| BUD-11 | Idle time dominance — most time spent waiting, not working | no coverage | 90% of budget consumed by queue wait, retry cooldown, or rate limit backoff |
| BUD-12 | Time budget consumed by retries — same failure retried to exhaustion | no coverage | First attempt fails at 30s, 5 retries × 30s = 3 minutes on same error |

### Retry/Iteration Budget

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BUD-13 | Max iterations exceeded — convergence loop runs too long | no coverage | Agent allowed 10 iterations, K5 constraints keep narrowing but never converge |
| BUD-14 | Retry budget consumed by same failure class | no coverage | All 5 retries fail with `build_failure` — budget spent without progress |
| BUD-15 | Compound budget — multiple dimensions near limit simultaneously | no coverage | 80% of token budget AND 80% of time budget AND 80% of retry budget |

**Budget total: 15 shapes. Generator coverage: 0. No coverage: 15.**

---

## Summary

| Domain | Total Shapes | Covered | No Coverage | Coverage % | Change (Mar 29) |
|---|---|---|---|---|---|
| CSS | 69 | 68 | 1 | 99% | +8 (C-31, C-63–C-69) |
| HTML | 48 | 48 | 0 | **100%** | +11 (H-07, H-28, H-33, H-41–H-48) |
| Filesystem | 39 | 38 | 1 | 97% | +17 (FS-06, FS-13, FS-25–FS-31, FS-33, FS-35–FS-39) |
| Content | 18 | 18 | 0 | **100%** | +7 (N-10–N-17) |
| HTTP | 54 | 54 | 0 | **100%** | +31 (P-13–P-54) |
| DB | 56 | 56 | 0 | **100%** | +40 (D-13–D-56) |
| Browser | 38 | 3 | 35 | 8% | — (requires Playwright tier) |
| Temporal | 15 | 15 | 0 | **100%** | +12 (TO-02–TO-15) |
| Interaction | 16 | 16 | 0 | **100%** | +6 (I-04, I-05, I-13–I-16) |
| Invariant | 14 | 14 | 0 | **100%** | +9 (INV-02–INV-14) |
| Identity | 12 | 12 | 0 | **100%** | +9 (ID-01–ID-12) |
| Observer Effects | 11 | 11 | 0 | **100%** | +9 (OE-02–OE-11) |
| Concurrency | 11 | 11 | 0 | **100%** | +9 (CO-02–CO-11) |
| Scope Boundary | 12 | 12 | 0 | **100%** | +9 (SC-02–SC-12) |
| Attribution | 10 | 10 | 0 | 100% | — |
| Drift | 13 | 13 | 0 | **100%** | +11 (DR-01–DR-13) |
| Message | 14 | 14 | 0 | 100% | — |
| Cross-cutting | 90 | 89 | 1 | 99% | +38 (X-05–X-89) +1 GC-684 (Apr 8 auto-discovered) |
| Staging | 15 | 15 | 0 | 100% | — |
| Configuration | 8 | 8 | 0 | **100%** | +5 (CFG-03–CFG-08) |
| Accessibility | 8 | 8 | 0 | **100%** | +5 (A11Y-01–A11Y-08) |
| Performance | 6 | 5 | 1 | 83% | +4 (PERF-02–PERF-06) |
| Security | 7 | 7 | 0 | **100%** | +4 (SEC-02–SEC-07) |
| Serialization | 7 | 7 | 0 | **100%** | +1 (SER-07) |
| Infrastructure | 12 | 12 | 0 | 100% | — |
| Vision | 3 | 3 | 0 | 100% | — |
| Injection | 14 | 14 | 0 | **100%** | +14 (INJ-01–INJ-14) |
| Hallucination | 15 | 0 | 15 | 0% | — (gate not built yet) |
| Budget | 15 | 15 | 0 | **100%** | +15 (BUD-01–BUD-15) |
| **Total** | **650** | **611** | **39** | **94%** | **+271 (Mar 29) +15 hallucination (Mar 30) +1 FS-39 +1 C-69 +1 GC-684 (Apr 8 auto-discovered)** |

### The numbers (updated March 30, 2026)

- **647 known failure shapes** across 30 domains (27 original + injection + hallucination + budget)
- **596 covered** (92%) — up from 376 (+220 shapes in March 29 session)
- **51 uncovered** — 35 Browser (requires Playwright), 15 Hallucination (gate not built), 1 Performance
- **Scenario inventory:**
  - **11,867 synthetic scenarios** across 99 staged fixture files (checked in, deterministic)
  - **908 real-world scenarios** across 8 staged fixture files (gitignored, fetched from 8 public sources)
  - **7,291 WPT-derived corpus** scenarios (opt-in via `--wpt`)
  - **12,775 total** (synthetic + real-world, excluding WPT)
  - Pure tier (default): ~4,500+ scenarios in self-test runner, no Docker needed
  - Live tier (`--live`): +20 live DB + 15 live HTTP = 45 scenarios against real containers
  - Full tier (`--full`): +10 Playwright browser scenarios
- **100 stage-*.ts generators** in `scripts/harvest/` — synthetic scenario producers
- **7 harvest-*.ts harvesters** in `scripts/supply/` — real-world data consumers (db, css, html, http, security, infra + orchestrator)
- **8 real-world sources:** SchemaPile (22,989 schemas), JSON Schema Test Suite (83 files), MDN Compat, Can I Use, PostCSS Parser Tests, Mustache Spec (203 tests), PayloadsAllTheThings (2,708 XSS vectors), Heroku Error Codes (36)
- **`--source` flag:** `synthetic` (default), `real-world`, `all` — developer chooses which corpus to run
- **Decomposition engine:** 349 shape rules across 24 domains, pure functions, zero LLM. Composition operators: product (×), temporal (⊗), round-trip verification.

### What remains

- **Browser (35 shapes)** — requires Playwright + live DOM. Infrastructure exists, scenarios need writing.
- **Hallucination (15 shapes)** — gate implemented (P2). 30 scenarios covering all 15 shapes. 47 unit tests.
- **Performance (1 shape)** — PERF-01 (response time) deferred, needs live server.

### Domain architecture

The 26 domains organize into five layers:

**Reality surfaces (8)** — domains where predicates observe truth:
- CSS, HTML, Filesystem, Content, HTTP, DB, Browser, Message

**Quality surfaces (5)** — domains where predicates assert non-functional properties:
- Configuration, Accessibility, Performance, Security, Serialization

**Trust surfaces (3, new)** — domains where predicates assert agent behavioral correctness:
- Injection (input integrity), Hallucination (output grounding), Budget (resource bounds)

**Meta-failure classes (7)** — failure modes that cut across all surfaces:
- Temporal, Interaction, Identity, Observer Effects, Concurrency, Scope Boundary, Drift

**System-internal (3)** — failures in verify's own gate logic:
- Invariant, Attribution, Cross-cutting

### Priority tiers (updated March 29, 2026)

**All Tier 1 and Tier 2 shapes: DONE.** 611/647 shapes covered (94%).

**Remaining work (51 shapes):**

**Browser (35 shapes, BR-01 through BR-38)** — requires Playwright + live DOM. Gate infrastructure exists. Scenarios need writing against real browser runtime.

**Hallucination (15 shapes, HAL-01 through HAL-15)** — gate implemented (P2, March 2026). 30 scenarios (2 per shape: grounded + fabricated). 47 unit tests. Deterministic — no LLM in the pipeline.

**Performance (1 shape, PERF-01)** — response time threshold. Deferred — needs live server measurement.

---

## Roadmap: Closing Coverage

This section captures the concrete plan for going from 12% to full coverage. It serves as the authoritative reference so context isn't lost across sessions.

### Phase 1: Predicate Type Inventory

Domains define reality. Predicate types define how you query it. The relationship is 1:N — one domain can have multiple predicate types.

**Current predicate types (6 shipped + 4 filesystem):**

| Domain | Predicate Type | Status |
|--------|---------------|--------|
| CSS | `css` | Shipped |
| HTML | `html` | Shipped |
| Content | `content` | Shipped |
| HTTP | `http` | Shipped |
| HTTP | `http_sequence` | Shipped |
| DB | `db` | Shipped |
| Filesystem | `filesystem_exists` | Shipped |
| Filesystem | `filesystem_absent` | Shipped |
| Filesystem | `filesystem_unchanged` | Shipped |
| Filesystem | `filesystem_count` | Shipped |

**New predicate types shipped (8, Move 4 + Move 6):**

| Domain | Predicate Type | Status | What it tests |
|--------|---------------|--------|---------------|
| Configuration | `config` | **Shipped** | Env var presence, config file values (.env + JSON) |
| Accessibility | `a11y` | **Shipped** | Heading hierarchy, landmark regions, ARIA labels, alt text, focus management |
| Performance | `performance` | **Shipped** | Bundle size, image optimization, lazy loading, connection count |
| Security | `security` | **Shipped** | XSS patterns, SQL injection, secrets exposure, CSP, CORS |
| Serialization | `serialization` | **Shipped** | JSON schema validation, type checking, required fields, strict/subset mode |
| Infrastructure | `infra_resource` | **Shipped** | Resource existence in Terraform/Pulumi/CloudFormation state files |
| Infrastructure | `infra_attribute` | **Shipped** | Resource tag/property values (environment, deletion_protection) |
| Infrastructure | `infra_manifest` | **Shipped** | State file drift from known-good manifest |

**Predicate types planned (5):**

| Domain | Predicate Type | Priority | What it tests |
|--------|---------------|----------|---------------|
| Browser | `interaction` | Next | Click targets, form inputs, event handlers, focus/blur |
| Browser | `navigation` | Next | Route transitions, history state, redirects, anchor links |
| Browser | `visibility` | Next | Display state, viewport intersection, z-index stacking, opacity |
| Browser | `storage` | Next | localStorage, sessionStorage, cookies, indexedDB |
| Browser | `lifecycle` | Tier 3 | Hydration, SSR/CSR transitions, web component upgrades, lazy loading |

**Why browser needs multiple types, not one monolithic `browser`:**
- Each type has a distinct verification mechanism (DOM query vs navigation API vs IntersectionObserver vs Storage API)
- Failure modes are orthogonal — an interaction bug shares nothing with a storage bug
- Generators are cleaner when scoped to one verification surface
- Matches the existing pattern: HTTP has `http` + `http_sequence`, not one type

**Why quality surfaces are separate domains, not extensions of existing surfaces (validated by implementation):**
- Configuration is about runtime state, not file content (Content checks `includes()`, Config parses `.env` + JSON config files)
- Accessibility is about the accessibility tree, not the DOM (HTML checks elements, a11y checks heading hierarchy, landmarks, ARIA)
- Performance is about measurement, not correctness (HTTP checks response content, Performance checks bundle size, lazy loading)
- Security is about vulnerability, not functionality (code can be correct AND insecure — security scans for XSS, injection, secrets)
- Serialization is about contract compliance, not content (JSON can contain the right data in the wrong shape — serialization validates against schema)

### Phase 2: Generator Build Order

Priority-ordered by ROI (shapes closed per engineering hour). Each phase builds on demo-app capabilities from the previous one.

**Wave 1 — Pure computation, no demo-app changes needed (Tier 1):**
1. ~~CSS value normalization generators (C-01 through C-16, C-44 through C-52)~~ — **23/25 done**. C-47, C-48, C-50 now covered. Remaining: C-31.
2. CSS shorthand generators (C-17 through C-30) — 14 shapes, ~300 scenarios — **9/14 done** (14 scenarios shipped). Remaining: C-22, C-23, C-26, C-27, C-29 (need richer CSS fixture)
3. ~~`fs` predicate type + filesystem generators (FS-01 through FS-15)~~ — **14/15 done** (FS-06, FS-13 remaining), 25 scenarios shipped
4. ~~Content pattern generators (N-04 through N-08)~~ — **5/5 done** (8 scenarios shipped)
5. ~~Fingerprinting edge case generators (X-51 through X-56)~~ — **6/6 done** (15 scenarios shipped: 10 in Family A, 5 in Family B)
6. ~~Attribution error generators (AT-01 through AT-10)~~ — **10/10 done** (15 scenarios shipped in Family D)

*Wave 1 total: ~80 shapes. Coverage: 22% → 27%. Filesystem: 14/15 done. CSS normalization: 20/25 done. CSS shorthand: 9/14 done. Content: 5/5 done. Fingerprinting: 6/6 done. Attribution: 10/10 done. F9 syntax: 5/5 done. **COMPLETE.***

**Wave 2 — Minor demo-app expansion (Tier 2), prioritized by user impact:**

**Wave 2A — Highest impact, minimal demo-app changes:**
7. HTML text/content generators (H-08 through H-14) — 7 shapes, ~150 scenarios. **Why first:** whitespace normalization (H-08), entity decoding (H-09), case sensitivity (H-10), and template expressions (H-12) are the most common HTML false negatives. Pure computation — needs only text-rich elements in demo-app.
8. HTTP status & body generators (P-01 through P-08) — 8 shapes, ~150 scenarios. **Why second:** status code, bodyContains, bodyRegex, and empty body are the primary behavioral verification surface. Demo-app needs 2-3 API routes returning JSON.
9. Cross-predicate interaction generators (I-01 through I-05, I-07) — 6 shapes, ~120 scenarios. **Why third:** catches real bugs where CSS passes but HTML fails (I-01), or content passes but HTTP fails (I-03). Multi-surface scenarios with existing predicate types.

**Wave 2B — Medium impact, some demo-app expansion:**
10. HTTP sequence & request generators (P-09 through P-14) — 6 shapes, ~100 scenarios. Needs POST endpoints, cookie handling.
11. ~~CSS selector edge cases (C-34 through C-43)~~ — **10/10 done** (35 scenarios). Cross-route, specificity, combinators, pseudo-class/element, inherited, media query, duplicate props.
12. Invariant generators (INV-01 through INV-09) — 9 shapes, ~150 scenarios. System health checks — needs invariant-aware demo-app config.
13. HTML extended text (H-24 through H-29) — 6 shapes, ~120 scenarios. Non-breaking spaces, bidirectional text, placeholder vs value.

**Wave 2C — Lower priority, significant demo-app expansion:** **COMPLETE.**
14. ~~HTML structure generators (H-15 through H-41)~~ — **18/20 done**. Attributes (H-15 to H-19), nesting (H-20 to H-22), structure (H-23 to H-40). Remaining: H-24, H-41 (need JS runtime).
15. ~~CSS advanced selectors (C-53 through C-62)~~ — **10/10 done** (20 scenarios). Escaped selectors, attribute selectors, shadow DOM, cascade layers, container queries, logical properties, browser defaults, unobservable, unknown shorthands. Deep scenarios with edit interactions, fabrication→miss, value mismatch.
16. Browser predicate types — **deferred to Phase 4** (needs new predicate types).
17. Browser interaction generators — **3/13 done** (BR-03, BR-10, BR-27 via Wave 3). Remainder needs JS event handlers.
18. ~~Scope boundary generators (SC-01, SC-06, SC-10)~~ — **3/10 done**. Multi-component, multi-tenant.
19. ~~Identity/reference generators (ID-02, ID-06, ID-08)~~ — **3/10 done**. Cross-surface identity.

*Wave 2 total: ~120 shapes covered. Coverage: 27% → 53%.*

**Wave 3 — Infrastructure expansion (Tier 3):** **STRUCTURAL STUBS COMPLETE.**
17. ~~DB generators (D-01 through D-20)~~ — **20/56 done**. 12 shapes grounded via init.sql parser (D-01–D-12), 8 structural stubs (D-04 legacy, D-06 legacy, D-08 legacy, D-12 legacy, D-16, D-18, D-20). Tier 2 upgrade COMPLETE.
18. ~~Filesystem advanced generators (FS-17 through FS-34)~~ — **22/38 done** total. Case sensitivity, path traversal, content predicates.
19. Browser lifecycle generators — **3/38 done** (BR-03, BR-10, BR-27). Pipeline handling without real browser.
20. ~~Temporal generators (TO-01, TO-05, TO-10)~~ — **3/15 done**. Stale snapshot, race condition, cache invalidation.
21. HTTP extended generators (P-10 through P-29) — **23/54 done** total. PUT/DELETE, multipart, CORS, redirects.
22. ~~Concurrency generators (CO-01, CO-09)~~ — **2/11 done**. Parallel edit conflict, resource contention.
23. ~~Observer effects generators (OE-01, OE-06)~~ — **2/11 done**. Heisenberg probe, observer feedback loop.
24. ~~Drift/regression generators (DR-02, DR-07)~~ — **2/13 done**. Silent dependency drift, schema drift.
25. ~~Invariant generators (INV-01 through INV-09)~~ — **5/14 done**. Health check, cascade failure, first-gate-stops-pipeline.
26. ~~Cross-cutting extended (X-65 through X-75)~~ — **40/89 done** total. Narrowing hints, pipeline ordering, unicode.
27. ~~Content extended (N-10 through N-12)~~ — **11/18 done** total. Binary content, encoding, multi-match.
28. ~~Interaction extended (I-08 through I-12)~~ — **10/16 done** total. CSS-DOM disconnect, artifact matching. Plus 6 product composition shapes (I-05×–I-10×) and 3 temporal compositions in decompose.ts with round-trip verification (50 tests, 145 assertions).

*Wave 3 total: ~60 shapes covered.*

**~~Wave 4 — DB Tier 2 (mock schema via init.sql):~~** **COMPLETE (March 23, 2026).**
29. ~~Add `fixtures/demo-app/init.sql` with representative schema (users, posts, sessions, settings)~~ — **done**
30. ~~Add DB grounding parser to `src/gates/grounding.ts`~~ — **done** (`parseInitSQL`, `normalizeDBType`, `findAndParseSchema`, DB validation in `validateAgainstGrounding`)
31. ~~DB schema assertion shapes (D-01 through D-12)~~ — **done** (12 shapes in decompose.ts: 3 core assertions + 3 grounding validation + 3 schema constraint + 3 data stubs)
32. DB cross-portability generators (D-18 through D-22) — 5 shapes: type naming, quoting, boolean, date, permission. D-18, D-20 have scenarios.
33. ~~DB data assertion stubs (D-10 through D-12)~~ — **done** (row count, row value, constraint/index — deferred without live DB)

*Wave 4 result: DB coverage 10/56 → 20/56 (36%). Shape catalog 52 → 64. Scenarios 488 → 506.*

**~~Wave 4.5 — Shape Catalog Expansion (Phase 3):~~** **COMPLETE (March 23, 2026).**
Systematic expansion pass wiring existing scenarios to decomposition rules across 8 domains:
- CSS: +16 shapes (C-02, C-03, C-04, C-06, C-11, C-13, C-14, C-15, C-32, C-34, C-35, C-40, C-42, C-45, C-49, C-52) — color format detection, relative units, keyword↔numeric, cascade/specificity, multi-block merge
- HTML: +3 shapes (H-03, H-20, H-23) — wrong tag, count mismatch, dynamic element grounding miss
- HTTP: +2 shapes (P-12, P-15) — method mismatch, redirect vs direct
- Content: +2 shapes (N-04, N-08) — regex-special chars, substring false positive
- Filesystem: +3 shapes (FS-07, FS-12, FS-17) — hash drift, missing file field, extra files
- Cross-cutting: +2 shapes (X-40, X-41) — empty search string, line ending mismatch
- Attribution: +2 shapes (AT-03, AT-04) — compound error extraction, first gate masking
- DOMINANCE map expanded with 4 new entries for false co-occurrence prevention
- Key invariant enforced: shapes must NOT match on `p.passed === true` (5 shapes removed/commented)

*Wave 4.5 result: Shape catalog 64 → 91. Rule coverage 11% → 16%. 310 tests, 0 failures. Self-test: 506 scenarios, ALL CLEAN.*

**Wave 5 — Quality surface predicate types (new domains):**
34. Content structural generators (N-13 through N-17) — JSON path, YAML, BOM, env vars, imports
35. Serialization generators (SER-01 through SER-07) — JSON schema, float precision, null semantics
36. Configuration generators (CFG-01 through CFG-08) — env vars, feature flags, precedence
37. Security generators (SEC-01 through SEC-07) — XSS detection, injection patterns
38. Accessibility generators (A11Y-01 through A11Y-08) — ARIA, keyboard, contrast
39. Performance generators (PERF-01 through PERF-06) — response time, LCP, bundle size

*Wave 5 target: 5 new domains opened. Total coverage: 50% → 56%.*

### Phase 3: `fs` Predicate Spec — COMPLETE

Filesystem predicates shipped as 4 types (`filesystem_exists`, `filesystem_absent`, `filesystem_unchanged`, `filesystem_count`). Implemented across:
- **Types:** `src/types.ts` (Predicate union type + `count`/`hash` fields)
- **Gate:** `src/gates/filesystem.ts` (244 LOC, pure fs reads, no Docker)
- **Grounding:** `src/gates/grounding.ts` (existence validation, hash/count field enforcement)
- **Containment:** `src/gates/containment.ts` (fingerprinting for all 4 types)
- **Scenarios:** 22/34 failure shapes covered (FS-01 through FS-05, FS-07 through FS-12, FS-14 through FS-24, FS-32, FS-34)

### Phase 4: Browser Predicate Types (After fs)

Browser predicates split into 4 initial types (5th deferred to Tier 3):

**`interaction`** — User-facing interactive behavior:
- Click targets respond (button, link, form submit)
- Form inputs accept values (fill, clear, select)
- Event handlers fire (focus, blur, hover state changes)
- Keyboard navigation works (tab order, enter-to-submit)
- Assertions: element is clickable, input accepts value, event fires

**`navigation`** — Route and history behavior:
- Client-side route transitions complete
- History state updates correctly (pushState, replaceState)
- Redirects resolve to expected destination
- Anchor links scroll to target
- Back/forward navigation works
- Assertions: URL matches, history length, scroll position

**`visibility`** — Visual presence and layout:
- Elements are visible in viewport (not just `display: block`)
- Z-index stacking is correct (element on top)
- Opacity is non-zero and element not clipped
- Intersection observer semantics (above fold, visible %)
- Responsive breakpoint behavior
- Assertions: isVisible, isInViewport, isOnTop, visiblePercentage

**`storage`** — Client-side persistence:
- localStorage keys exist with expected values
- sessionStorage lifecycle correct
- Cookies set with correct attributes (path, expiry, secure)
- IndexedDB stores and object stores exist
- Assertions: keyExists, valueEquals, cookieHas, storeExists

**`lifecycle`** (Tier 3, deferred) — Framework-level behavior:
- SSR→CSR hydration completes without mismatch
- Web components upgrade from undefined
- Lazy-loaded modules resolve
- Service worker registration succeeds
- Assertions: hydrated, upgraded, loaded, registered

Each type gets its own generator family, its own failure shapes, and its own verification mechanism. They share a Playwright transport but nothing else.
