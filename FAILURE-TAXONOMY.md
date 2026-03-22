# Verify Failure Taxonomy

The training curriculum for verify's scenario generators. Each failure shape is a known way that a predicate can produce wrong results — either passing when it should fail, or failing when it should pass. Every shape is a generator target.

**Why this matters:** Verify gets better by closing failure classes, not by bigger models. Each generator produces 20-50 scenarios from one failure shape. This taxonomy is the map of what's been closed and what's still open.

**Coverage formula:** `(shapes with generators / total known shapes) = coverage %`

---

## CSS Predicate Failures

CSS predicates assert computed style properties on DOM elements. The gap between authored CSS (source code) and computed CSS (browser reality) is where most failures live.

### Value Resolution

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| C-01 | Named color ↔ hex equivalence | scenarios only (uv-011, uv-013) | `red` vs `#ff0000`, 148 named colors |
| C-02 | RGB ↔ hex equivalence | no coverage | `rgb(255,0,0)` vs `#ff0000` |
| C-03 | HSL ↔ hex/rgb equivalence | no coverage | `hsl(0,100%,50%)` vs `#ff0000` |
| C-04 | RGBA with alpha=1 ↔ RGB | no coverage | `rgba(255,0,0,1)` vs `rgb(255,0,0)` |
| C-05 | HSLA with alpha=1 ↔ HSL | no coverage | Same pattern |
| C-06 | Whitespace in values | no coverage | `rgb( 255, 0, 0 )` vs `rgb(255,0,0)` |
| C-07 | Casing in values | no coverage | `Red` vs `red`, `#FF0000` vs `#ff0000` |
| C-08 | Zero equivalences | no coverage | `0` vs `0px` vs `0em` vs `0%` vs `0rem` |
| C-09 | `calc()` expressions | no coverage | `calc(100% - 20px)` — can't compare statically |
| C-10 | CSS custom properties (`var()`) | no coverage | `var(--primary)` resolves to a value at runtime |
| C-11 | `auto`, `inherit`, `initial`, `unset` keywords | no coverage | Keyword vs computed value |
| C-12 | `!important` override | no coverage | Same property, different specificity |
| C-13 | Unit equivalence (relative) | no coverage | `1em` vs `16px` (depends on context) |
| C-14 | Percentage values | no coverage | `50%` vs `500px` on 1000px container |
| C-15 | Multiple values on one property | no coverage | `transition: color 0.3s, opacity 0.5s` |
| C-16 | Browser-specific prefixes | no coverage | `-webkit-transform` vs `transform` |
| C-44 | Fractional rounding differences | no coverage | `33.3333%` vs `33.33px` — rounding at computed boundary |
| C-45 | `normal` keyword resolution | no coverage | `line-height: normal`, `font-weight: normal`, `letter-spacing: normal` |
| C-46 | Font family normalization | no coverage | Quoted vs unquoted, fallback stack, platform substitution |
| C-47 | Transform matrix equivalence | no coverage | `translateX(10px)` vs `matrix(1, 0, 0, 1, 10, 0)` |
| C-48 | Filter/backdrop-filter normalization | no coverage | Order and computed serialization differences |
| C-49 | Color space differences (modern syntax) | no coverage | `rgb(255 0 0 / 1)` vs `rgb(255, 0, 0)` |
| C-50 | CSS variable fallback path | no coverage | `var(--x, red)` where `--x` missing or invalid |
| C-51 | Invalid value silently dropped | no coverage | Property reverts to inherited/initial — no error |
| C-52 | Unit conversion with root-relative context | no coverage | `rem` depends on root `font-size`, not local context |

### Shorthand Resolution

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| C-17 | `border` → `border-width/style/color` | scenarios only (uv-012, uv-015) | Directional: border-top, border-right, etc. |
| C-18 | `margin` → directional components | no coverage | `margin: 10px 20px` → top/right/bottom/left |
| C-19 | `padding` → directional components | no coverage | Same pattern as margin |
| C-20 | `background` → longhand components | no coverage | `background: url() center/cover no-repeat #fff` |
| C-21 | `font` → size/weight/family/style | no coverage | `font: bold 16px/1.5 Arial` |
| C-22 | `flex` → grow/shrink/basis | no coverage | `flex: 1 0 auto` |
| C-23 | `grid` shorthand family | no coverage | `grid-template`, `grid-area`, etc. |
| C-24 | `animation` → name/duration/timing/etc. | no coverage | 8 longhand properties |
| C-25 | `transition` → property/duration/timing/delay | no coverage | 4 longhand properties |
| C-26 | `list-style` → type/position/image | no coverage | 3 longhand properties |
| C-27 | `text-decoration` → line/color/style/thickness | no coverage | 4 longhand properties |
| C-28 | `outline` → width/style/color | no coverage | 3 longhand properties |
| C-29 | `overflow` → overflow-x/overflow-y | no coverage | 2 longhand properties |
| C-30 | Shorthand component ordering ambiguity | no coverage | `border: 1px solid red` — which token is which? |

### Selector Matching

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| C-31 | Fabricated selector (grounding miss) | generator (E2) + scenarios (uv-001, uv-004) | Well covered |
| C-32 | Property not found on valid selector | scenario only (uv-002) | Single scenario |
| C-33 | Value mismatch (expected ≠ actual) | scenario only (uv-009) | Single scenario |
| C-34 | Cross-route selector ambiguity | no coverage | Same selector, different values on different routes |
| C-35 | Specificity/cascade conflict | no coverage | `.class` vs `#id` vs inline |
| C-36 | Multi-selector rules | no coverage | `.a, .b { color: red }` — match on .a or .b? |
| C-37 | Selector combinators | no coverage | `.parent > .child` vs `.parent .child` vs `.parent + .sibling` |
| C-38 | Pseudo-class selectors | no coverage | `:hover`, `:focus`, `:nth-child()`, `:first-of-type` |
| C-39 | Pseudo-element selectors | no coverage | `::before`, `::after`, `::placeholder` |
| C-40 | Inherited vs computed values | no coverage | `color` inherited from parent vs set directly |
| C-41 | Media query scoped styles | no coverage | Style only applies at certain viewport widths |
| C-42 | Multiple style blocks with same selector | scenario covered in verify | `extractCSS()` merges — but edge cases remain |
| C-43 | Duplicate properties in same block | no coverage | Later declaration wins (cascade) |
| C-53 | Escaped selectors and special characters | no coverage | IDs/classes containing `:` `.` spaces, unicode escapes |
| C-54 | Attribute selectors | no coverage | `[data-id="5"]`, prefix/suffix/contains selectors |
| C-55 | Shadow DOM boundary | no coverage | Selector exists but standard query path can't reach it |
| C-56 | Style source precedence mismatch | no coverage | Inline style vs stylesheet vs user-agent vs inherited |
| C-57 | Cascade layers (`@layer`) | no coverage | Layer ordering introduces new precedence |
| C-58 | Container query scoped styles | no coverage | `@container` changes which styles apply |
| C-59 | Logical properties | no coverage | `margin-inline-start` vs physical sides under writing modes |
| C-60 | Browser default styles mistaken for success | no coverage | User-agent stylesheet value matches expected — not authored |
| C-61 | Property not observable via getComputedStyle | no coverage | Exists in source, not returned by browser API |
| C-62 | Longhand/shorthand beyond known families | no coverage | Computed returns only longhand for properties not in SHORTHAND_MAP |

**CSS total: 62 shapes. Generator coverage: 1. Scenario-only coverage: 7. No coverage: 54.**

---

## HTML Predicate Failures

HTML predicates assert element existence, text content, and structure. The gap between source HTML and parsed DOM is where failures live.

### Element Matching

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-01 | Element not found (wrong tag) | scenarios (uv-003, uv-010) | 2 scenarios |
| H-02 | Wrong text content | scenario (uv-006) | Single scenario |
| H-03 | Element exists but wrong tag type | no coverage | Predicate says `<h2>`, reality is `<h3>` |
| H-04 | Multiple matching elements | no coverage | 3 `<li>` elements — which one does predicate mean? |
| H-05 | Nested element text extraction | no coverage | `<p>Hello <strong>world</strong></p>` — text is what? |
| H-06 | Self-closing tag variants | no coverage | `<br/>` vs `<br>` vs `<br />` |
| H-07 | SVG/foreign namespace elements | no coverage | `<svg:rect>` vs `<rect>` |

### Text Content

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-08 | Whitespace in text content | no coverage | `\n  Hello  \n` vs `Hello` (trim? normalize?) |
| H-09 | HTML entities vs literal | no coverage | `&amp;` vs `&`, `&lt;` vs `<`, `&#39;` vs `'` |
| H-10 | Case sensitivity in text matching | no coverage | "Hello" vs "hello" — exact or case-insensitive? |
| H-11 | Unicode normalization | no coverage | NFC vs NFD, combined vs decomposed characters |
| H-12 | Template expression in source | no coverage | `${variable}` — literal text vs dynamic content |
| H-13 | Text across child elements | no coverage | Concatenated textContent of all children |
| H-14 | Invisible text (display:none content) | no coverage | Element exists but isn't visible |
| H-24 | textContent vs innerText mismatch | no coverage | Hidden content, whitespace collapsing, CSS visibility all differ |
| H-25 | Comment nodes in text extraction | no coverage | `<!-- comment -->` affecting text parsing assumptions |
| H-26 | Script/style tag text counted as content | no coverage | Accidentally matching `<script>` or `<style>` text |
| H-27 | Non-breaking spaces and special whitespace | no coverage | `&nbsp;`, `\u00A0`, zero-width chars |
| H-28 | Bidirectional text / RTL markers | no coverage | `\u200F`, `\u200E` affecting text equality |
| H-29 | Placeholder vs actual form value | no coverage | `placeholder="Name"` vs `value` property |

### Attributes

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-15 | Boolean attributes | no coverage | `disabled` vs `disabled="disabled"` vs `disabled=""` |
| H-16 | Class attribute matching | no coverage | `class="foo bar"` — order matters? Substring vs exact? |
| H-17 | Data attributes | no coverage | `data-id="5"` — string vs number |
| H-18 | URL attributes (href, src) | no coverage | Relative vs absolute, trailing slash |
| H-19 | ARIA attributes | no coverage | `aria-label`, `role` — accessibility predicates |
| H-30 | DOM property vs HTML attribute mismatch | no coverage | `checked`, `selected`, `value`, `disabled` runtime state |
| H-31 | Boolean state differs from serialized source | no coverage | Runtime `checked=true` but source has no `checked` attr |

### Structure

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| H-20 | Element count (cardinality) | no coverage | "3 list items" — how many `<li>` exist? |
| H-21 | Element ordering | no coverage | First `<li>` vs last `<li>` |
| H-22 | Nesting depth | no coverage | Element inside wrong parent |
| H-23 | Dynamic/JS-rendered content | no coverage | Content added by JavaScript, not in source HTML |
| H-32 | Hidden but accessible text (or vice versa) | no coverage | `aria-label` on hidden element |
| H-33 | Slotting / shadow DOM content projection | no coverage | `<slot>` content not reachable by standard selectors |
| H-34 | Duplicate IDs causing ambiguous selection | no coverage | `getElementById` returns first, not intended |
| H-35 | Fragment parsing differences | no coverage | Same HTML parsed differently by container context |
| H-36 | Malformed HTML autocorrection | no coverage | Parser fixes broken HTML — structure changes |
| H-37 | Template/inert content (`<template>`) | no coverage | Miscounted as live DOM |
| H-38 | Parent/ancestor requirement not enforced | no coverage | Element exists but not inside expected container |
| H-39 | Sibling relationship assertion | no coverage | Ordering-dependent UIs, `+`/`~` selectors |
| H-40 | Landmark/semantic structure mismatch | no coverage | `<main>`, `<nav>`, heading hierarchy (h1→h2→h3) |
| H-41 | Hydration mismatch (source vs runtime DOM) | no coverage | Server-rendered HTML differs from client-hydrated DOM |

**HTML total: 41 shapes. Generator coverage: 0. Scenario-only coverage: 3. No coverage: 38.**

---

## Filesystem Predicate Failures

Filesystem predicates assert file existence, structure, and state. The most deterministic domain — no interpretation, no rendering, no probability. Promoted from a subsection of Content because filesystem truth is fundamentally different from content-pattern truth.

### Existence & Presence

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-01 | File should exist but doesn't | no coverage | Missing after failed edit |
| FS-02 | File should not exist but does | no coverage | Leftover artifact |
| FS-03 | Directory vs file mismatch | no coverage | Expected file, found directory (or vice versa) |
| FS-04 | Wrong path resolution (relative vs absolute) | no coverage | `./src/file.js` vs `/app/src/file.js` |
| FS-05 | Symlink resolution | no coverage | File exists but is symlink to elsewhere |
| FS-06 | Symlink cycle or traversal edge case | no coverage | Infinite loop or `../../../` escape |

### Content Integrity

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-07 | Content mismatch (exact) | no coverage | File content differs from expected byte-for-byte |
| FS-08 | Encoding mismatch (UTF-8 vs other) | no coverage | BOM prefix, Latin-1, etc. |
| FS-09 | Line ending differences (CRLF/LF) | no coverage | Pattern uses `\n`, file has `\r\n` |
| FS-10 | Binary vs text misinterpretation | no coverage | Content predicate against `.png` or `.wasm` |
| FS-11 | NUL bytes in text-like files | no coverage | Corrupted or binary-mixed content |
| FS-12 | Partial write / truncated file | no coverage | Observed during verification mid-write |
| FS-13 | Compressed or encoded content | no coverage | `.gz`, `.br` treated as plain text |
| FS-14 | Empty file (0 bytes) | no coverage | File exists but has no content |
| FS-15 | Minified files | no coverage | Pattern exists but no whitespace landmarks |

### Structural / Count

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-16 | Wrong number of files | no coverage | Expected N files in directory, found M |
| FS-17 | Unexpected extra files | no coverage | Build artifacts, temp files mixed in |
| FS-18 | Missing expected files in set | no coverage | 3 of 5 migration files present |
| FS-19 | Generated/build artifact matched instead of source | no coverage | `dist/bundle.js` vs `src/index.js` |

### Path & Resolution

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-20 | Case sensitivity across OSes | no coverage | macOS/Windows case-insensitive, Linux case-sensitive |
| FS-21 | Unicode normalization in filenames | no coverage | NFC vs NFD in path components |
| FS-22 | Glob expansion mismatch | no coverage | `*.js` includes or excludes `.mjs`? |
| FS-23 | Path traversal normalization | no coverage | `src/../src/file.js` vs `src/file.js` |

### Permissions & Access

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| FS-24 | File exists but unreadable | no coverage | Permission denied vs file missing conflation |
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
| FS-32 | Same content, different hash method | no coverage | SHA-256 vs MD5, trailing newline |
| FS-33 | Same logical file, different path reference | no coverage | Alias, mount, symlink — same bytes |
| FS-34 | Duplicate files causing ambiguity | no coverage | Same filename in different directories |

**Filesystem total: 34 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 34.**

---

## Content Predicate Failures

Content predicates assert that patterns exist inside files. Distinct from filesystem (which is about structure/state) — content is about meaning within files.

### Pattern Matching

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| N-01 | Pattern not found in file | scenario (uv-007) | Single scenario |
| N-02 | File doesn't exist | scenario (uv-008) | Single scenario |
| N-03 | Pattern found in wrong file | no coverage | User specifies wrong `file` field |
| N-04 | Regex vs literal matching | no coverage | `.` matches any char in regex, literal dot in string |
| N-05 | Multi-line pattern matching | no coverage | Pattern spans line boundary |
| N-06 | Pattern in comment vs code | no coverage | `// TODO: add login` matches "add login" but it's a comment |
| N-07 | Case sensitivity | no coverage | `require('Express')` vs `require('express')` |
| N-08 | Partial match vs full match | no coverage | Pattern "color" matches "background-color" |
| N-26 | Duplicate pattern count ambiguity | no coverage | Pattern exists multiple times — predicate assumes one meaningful occurrence |

### Semantic Edge Cases

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| N-09 | Template syntax as literal | no coverage | `{{ variable }}`, `<%= erb %>` — pattern or template? |
| N-10 | Very large files (performance) | no coverage | Scanning 10MB file |
| N-11 | Pattern in generated scaffold | no coverage | Matches boilerplate, not user-authored code |
| N-12 | Concatenated/bundled content | no coverage | Pattern exists in bundle but not in source module |

**Content total: 13 shapes. Generator coverage: 0. Scenario-only coverage: 2. No coverage: 11.**

---

## HTTP Predicate Failures

HTTP predicates assert status codes, body content, and request/response behavior. The gap between expected and actual HTTP behavior is where failures live.

### Status & Body

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| P-01 | Status code mismatch | generator (A1, fingerprint) + scenario (uv-005 body) | A1 tests fingerprints, not the gate itself |
| P-02 | Body content missing (bodyContains) | scenario (uv-005) | Single scenario |
| P-03 | bodyContains array — all must match | no coverage | Array semantics, partial match |
| P-04 | bodyRegex edge cases | no coverage | Greedy vs lazy, multiline flag, special chars |
| P-05 | Empty response body | no coverage | 204 No Content, or empty 200 |
| P-06 | Wrong Content-Type | no coverage | JSON body but `text/html` header |
| P-07 | JSON structure assertion | no coverage | Key exists but wrong type or nesting |
| P-08 | Response body encoding | no coverage | UTF-8 vs Latin-1, gzip |
| P-23 | bodyContains succeeds on error page | no coverage | Token exists in error shell, not intended data — classic false positive |
| P-24 | JSON key ordering differences | no coverage | Exact-body checks broken by serialization order |
| P-25 | Numeric/string/null distinctions in JSON | no coverage | `"5"` vs `5` vs `null` |
| P-26 | Duplicate keys / malformed JSON | no coverage | Non-spec-compliant JSON edge cases |
| P-27 | Charset mismatch (headers vs body) | no coverage | Content-Type says UTF-8, body is Latin-1 |
| P-28 | Compression auto-decoding differences | no coverage | gzip/br handled inconsistently across clients |
| P-29 | HTML and JSON both contain expected token | no coverage | Coincidental match across content types |

### Request Handling

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| P-09 | Sequence ordering (http_sequence) | no coverage | POST creates → GET verifies — order matters |
| P-10 | Request body interpolation | no coverage | `{{jobId}}` in nested objects, arrays |
| P-11 | Query parameter handling | no coverage | `/api?page=2` — parameter parsing |
| P-12 | Request method mismatch | no coverage | GET when should be POST |
| P-13 | Request headers | no coverage | Authorization, custom headers |
| P-14 | Cookie handling | no coverage | Set-Cookie in response, cookie jar |
| P-30 | Idempotency mismatch | no coverage | Replaying request changes server state |
| P-31 | Sequence step dependency leakage | no coverage | Step 2 passes only because of unrelated prior state |
| P-32 | Cross-request variable collision | no coverage | Interpolation namespace collision across steps |
| P-33 | Auth state leakage between tests | no coverage | Cookie/header reuse across scenarios |
| P-34 | Method override behavior | no coverage | `X-HTTP-Method-Override` alters semantics |
| P-35 | Query param order normalization | no coverage | `?a=1&b=2` vs `?b=2&a=1` |
| P-36 | Repeated query keys / array encoding | no coverage | `?id=1&id=2` — array or last-wins? |
| P-37 | Multipart/form-data parsing | no coverage | File upload body handling |
| P-38 | HEAD/OPTIONS differing from GET/POST | no coverage | Status/headers same but no body |

### Network & Protocol

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| P-15 | Redirect handling (301/302) | no coverage | Follow vs not follow |
| P-16 | Timeout vs error distinction | no coverage | Connection timeout vs server error |
| P-17 | CORS headers | no coverage | Preflight, Access-Control-* |
| P-18 | HTTPS/TLS certificate issues | no coverage | Self-signed, expired |
| P-19 | Chunked/streaming responses | no coverage | Response arrives in pieces |
| P-20 | Rate limiting (429) | no coverage | Repeated checks trigger rate limit |
| P-21 | Relative vs absolute URL | no coverage | `/api/items` vs `http://localhost:3000/api/items` |
| P-22 | Trailing slash sensitivity | no coverage | `/api/items` vs `/api/items/` |
| P-39 | DNS resolution differences | no coverage | `localhost` vs container network name vs `127.0.0.1` |
| P-40 | Port-binding race during staging | no coverage | Port not ready when predicate runs |
| P-41 | Retry turns infra failure into false success | no coverage | Flaky endpoint works on retry by coincidence |
| P-42 | Proxy/load balancer alters response | no coverage | Injected headers/body from infrastructure |
| P-43 | HTTP/1.1 vs HTTP/2 behavioral mismatch | no coverage | Protocol-level differences |
| P-44 | Localized content via Accept-Language | no coverage | Same endpoint, different response by locale |
| P-45 | CSRF protection blocks mutation route | no coverage | Realistic flow requires CSRF token |

**HTTP total: 45 shapes. Generator coverage: 1 (fingerprint only). Scenario-only coverage: 1. No coverage: 43.**

---

## DB Predicate Failures

DB predicates assert schema structure and data state. The gap between expected schema and actual database state is where failures live.

### Schema Assertions

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| D-01 | Table doesn't exist | no coverage | Can't test on demo-app (no DB) |
| D-02 | Column doesn't exist | no coverage | Same |
| D-03 | Column type mismatch | no coverage | `varchar` vs `text`, `int` vs `bigint` |
| D-04 | Case sensitivity in names | no coverage | Postgres lowercases unquoted, MySQL depends on OS |
| D-05 | Schema after migration drift | no coverage | Schema changed between checkpoint and now |
| D-06 | Index existence | no coverage | Performance index present/absent |
| D-07 | Constraint existence | no coverage | Foreign key, unique, check constraints |
| D-08 | Constraint names | no coverage | Named vs auto-generated constraint names |
| D-09 | Default values on columns | no coverage | `DEFAULT now()` vs no default |
| D-10 | Enum / custom types | no coverage | Postgres enums, MySQL enums — different behavior |
| D-11 | View existence | no coverage | Views vs tables — same query surface, different nature |
| D-12 | Nullable vs NOT NULL | no coverage | Column allows NULL or not |
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
| D-16 | Empty table vs missing table | no coverage | Table exists with 0 rows vs table doesn't exist |
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
| D-18 | Postgres vs MySQL type naming | no coverage | `serial` vs `auto_increment` |
| D-19 | Identifier quoting | no coverage | `"table"` (Postgres) vs `` `table` `` (MySQL) |
| D-20 | Boolean representation | no coverage | `true`/`false` vs `1`/`0` |
| D-21 | Date/timestamp formats | no coverage | ISO 8601 vs database-native format |
| D-22 | Permission / ownership | no coverage | Schema visible but not queryable |
| D-43 | SQLite vs Postgres behavior | no coverage | Lightweight fixtures use different engine |
| D-44 | Reserved keyword identifiers | no coverage | `user`, `order`, `table` as column names |
| D-45 | Locale/collation affecting sort or equality | no coverage | Locale-dependent comparison results |
| D-46 | Permission model differs for introspection vs query | no coverage | Can read schema but not data (or vice versa) |

**DB total: 46 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 46.**

---

## Temporal / Stateful Failures

Failures where the same predicate produces different results depending on WHEN it's evaluated. Most other categories assume static snapshot comparison — temporal failures break that assumption.

### Settlement & Timing

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| TO-01 | State not yet settled when evaluated | no coverage | CSS/HTML/HTTP all suffer — async init not complete |
| TO-02 | Predicate passes transiently, regresses after async | no coverage | Initial state correct, background work overwrites |
| TO-03 | Retry changes outcome without code change | no coverage | Creates flaky verification — non-determinism |
| TO-04 | Two predicates observe different app states | no coverage | HTML sees pre-hydration, CSS sees post-hydration |
| TO-06 | Debounce/throttle timing causes false negative | no coverage | User-visible effect delayed past check window |
| TO-07 | Animation/transition midpoint sampled | no coverage | Captured between states, not at final state |

### Cache & Staleness

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| TO-05 | Cached state causes stale result after edit | no coverage | Browser cache, CDN cache, server cache |
| TO-08 | Eventual consistency in DB/API | no coverage | Read-after-write returns stale data |
| TO-09 | Background job not finished before check | no coverage | Async worker still processing when predicate runs |

### Environment-Dependent Time

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| TO-10 | Time-dependent logic changes outcome | no coverage | Wall clock, timezone, locale affect result |

**Temporal total: 10 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 10.**

---

## Cross-Predicate Interaction Failures

Failures that only manifest when multiple predicate types are evaluated against the same system. Individual predicates pass in isolation but contradict each other or miss systemic issues.

### Cross-Surface Contradictions

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| I-01 | CSS passes, HTML fails — same selector wrong element | no coverage | Selector matches but structural target is wrong |
| I-02 | HTML passes on source, CSS fails in browser | no coverage | Hydration changes which styles apply |
| I-03 | Content passes (source changed), HTTP fails (behavior didn't) | no coverage | File edited but runtime not rebuilt/restarted |
| I-04 | HTTP passes, DB fails (response cached/mocked) | no coverage | API returns stale data |
| I-05 | DB passes, HTTP fails (serialization changed) | no coverage | Schema correct but JSON shape differs |
| I-06 | CSS edit fixes style but breaks HTML structure | no coverage | Collateral damage across domains |
| I-07 | One edit satisfies predicate A, violates predicate B | no coverage | Intra-goal conflict — predicates contradict |
| I-08 | Grounding says exists, runtime never renders | no coverage | Selector in source but behind feature flag or conditional |
| I-09 | Vision agrees with browser, deterministic disagrees | no coverage | Normalization bug in deterministic path |
| I-10 | Deterministic passes on source, browser fails (JS mutation) | no coverage | Runtime JavaScript changes the DOM |
| I-11 | Filesystem passes on artifact, source unchanged | no coverage | Generated file matched instead of source |
| I-12 | Multi-step workflow passes per step, invariant fails | no coverage | Each step correct in isolation, system broken holistically |

**Interaction total: 12 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 12.**

---

## Invariant / System Health Failures

Invariants are system-scoped checks that must hold after EVERY mutation. Unlike predicates (goal-scoped), invariants verify the system didn't break. This domain is underweighted in the taxonomy relative to its gate position.

### Health Endpoint

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INV-01 | Health green but core route broken | no coverage | `/health` returns 200, homepage is 500 |
| INV-02 | Health red due to unrelated transient | no coverage | Temporary network glitch, not mutation damage |
| INV-03 | Health passes before side effect manifests | no coverage | Mutation damage is delayed |

### Scope & Coverage

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| INV-04 | Invariant checks wrong service/container | no coverage | Checking db health when app is broken |
| INV-05 | Command output parsing mismatch | no coverage | `pg_isready` output format changes |
| INV-06 | Invariant status cached/stale | no coverage | Previous result returned instead of fresh check |
| INV-07 | One invariant masks another | no coverage | First passes, second not run due to budget |
| INV-08 | Scope too broad — false negatives | no coverage | Check passes for safe local edits that actually broke something |
| INV-09 | Scope too narrow — misses blast radius | no coverage | Check doesn't cover affected subsystem |

**Invariant total: 9 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 9.**

---

## Browser Runtime Failures

Browser is a stateful runtime environment, not just CSS + HTML. These failures live in the behavioral layer — event handling, navigation, storage, lifecycle — that falls through the cracks between CSS (style truth) and HTML (structure truth). The browser domain captures: "does the app actually work?"

### Interaction & Events

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-01 | Click handler doesn't fire | no coverage | Button exists, event listener not attached |
| BR-02 | Wrong event type (click vs submit vs change) | no coverage | Form submits on enter but test clicks button |
| BR-03 | Element exists but not clickable | no coverage | Overlapping element, `pointer-events: none`, disabled |
| BR-04 | Event fires but state change doesn't propagate | no coverage | Handler runs, DOM not updated |
| BR-05 | Double-click / rapid-fire creates unexpected state | no coverage | Debounce missing, duplicate submission |
| BR-06 | Focus/blur sequence triggers unexpected behavior | no coverage | Validation fires on blur, test doesn't blur |
| BR-07 | Keyboard event vs mouse event produces different result | no coverage | Enter key vs click on same button |

### Navigation & Routing

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| BR-08 | Route changes but URL doesn't update | no coverage | SPA pushState not called |
| BR-09 | URL updates but content doesn't change | no coverage | Router fires, component doesn't re-render |
| BR-10 | Direct URL access works but SPA navigation doesn't | no coverage | Server-side routing vs client-side routing |
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
| BR-27 | Responsive breakpoint changes layout | no coverage | Viewport width changes which elements render |

**Browser total: 27 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 27.**

---

## Identity & Reference Failures

Failures where two things are logically "the same" but not the same by reference, path, representation, or identity — or vice versa. This class cuts across all domains.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| ID-01 | DOM node replaced after re-render | no coverage | Same element logically, new node reference |
| ID-02 | Alias vs canonical path mismatch | no coverage | `./src/../src/file.js` vs `./src/file.js` |
| ID-03 | Same resource via different URL | no coverage | URL normalization, redirects, trailing slash |
| ID-04 | Object identity vs value equality in JSON | no coverage | Deep equal but `!==` in code |
| ID-05 | Cache key vs actual resource mismatch | no coverage | Stale cache entry for changed resource |
| ID-06 | Same CSS value, different representation | no coverage | `red` vs `#ff0000` vs `rgb(255,0,0)` — identity collapse |
| ID-07 | Same DB row, different query path | no coverage | Join vs direct select returns different column set |
| ID-08 | Same file via symlink, mount, or copy | no coverage | Content identical, path identity differs |
| ID-09 | Entity identity across API/UI/DB not consistent | no coverage | Same user, different ID format (UUID vs int) |
| ID-10 | Re-created entity has same values but new identity | no coverage | DELETE + INSERT vs UPDATE — different IDs |

**Identity total: 10 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 10.**

---

## Observer Effect Failures

Failures where the act of verifying changes the system being verified. The measurement disturbs the measured.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| OE-01 | HTTP verification call mutates state | no coverage | Non-idempotent endpoint (POST, DELETE) |
| OE-02 | DB read triggers lazy load / materialization | no coverage | Query causes side effect |
| OE-03 | Browser evaluation triggers layout or script | no coverage | `getComputedStyle()` forces layout recalc |
| OE-04 | File read triggers watcher / rebuild | no coverage | Hot reload fires during verification |
| OE-05 | Rate limits triggered by verification probes | no coverage | Too many checks → 429 → false failure |
| OE-06 | Verification order changes outcome | no coverage | Check A before B succeeds; B before A fails |
| OE-07 | Repeated verification degrades system | no coverage | Memory leak, connection pool exhaustion |
| OE-08 | Probe introduces observable side effects | no coverage | Verification logged, changes metrics/state |
| OE-09 | Screenshot capture triggers repaint/reflow | no coverage | Visual state changes during capture |

**Observer total: 9 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 9.**

---

## Concurrency / Multi-Actor Failures

Failures from multiple operations happening simultaneously. Distinct from temporal (single actor, different times) — concurrency is multiple actors at the same time.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| CO-01 | Two edits applied concurrently to same file | no coverage | Interleaved writes produce corrupt state |
| CO-02 | Two verification runs overlap | no coverage | Both read, one writes, other reads stale |
| CO-03 | Background job modifies state during verification | no coverage | Cron/worker changes DB/files mid-check |
| CO-04 | DB transaction from another process interferes | no coverage | Phantom reads, lock contention |
| CO-05 | Last-write-wins vs expected behavior | no coverage | Race between edit and rollback |
| CO-06 | Lock contention / deadlock edge cases | no coverage | Two processes waiting on each other |
| CO-07 | Partial visibility across concurrent readers | no coverage | Reader sees half of a multi-file edit |
| CO-08 | Container restart during verification | no coverage | Process dies mid-check, partial results |
| CO-09 | Constraint store concurrent access | no coverage | Two scenarios seeding constraints simultaneously |

**Concurrency total: 9 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 9.**

---

## Scope Boundary Failures

Failures where the system verifies the wrong scope — correct locally, wrong globally, or aimed at the wrong boundary entirely. Ties directly to G5 containment philosophy.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| SC-01 | Local success, global failure | no coverage | CSS fix works for target but breaks sibling |
| SC-02 | Wrong tenant / user context | no coverage | Multi-tenant app, verification runs as wrong user |
| SC-03 | Wrong environment (dev vs staging vs prod) | no coverage | Predicate verified against wrong target |
| SC-04 | Feature flag scope mismatch | no coverage | Feature enabled in test, disabled in prod |
| SC-05 | Permission scope mismatch | no coverage | Verification runs with elevated privileges |
| SC-06 | Component isolation broken by global CSS | no coverage | Scoped component, global stylesheet override |
| SC-07 | Module boundary — correct export, wrong import | no coverage | Internal module state differs from public API |
| SC-08 | DB change passes local predicate, breaks FK | no coverage | Table correct, referential integrity broken |
| SC-09 | API version scope mismatch | no coverage | v1 passes, v2 broken — predicate checks v1 |
| SC-10 | Blast radius underestimated | no coverage | Edit touches 1 file, affects 10 consumers |

**Scope total: 10 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 10.**

---

## Attribution / Root Cause Failures

Failures where the system identifies the wrong cause of a failure. The verification detects a problem correctly, but the diagnosis (narrowing hint, constraint seeding, error message) points the wrong way. Directly impacts narrowing quality and K5 learning accuracy.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| AT-01 | Correct failure, wrong cause identified | no coverage | CSS fails → blamed on selector, actually cascade |
| AT-02 | Multiple causes, single attribution | no coverage | Two bugs, narrowing picks one |
| AT-03 | Downstream effect mistaken for root cause | no coverage | Deploy failure blamed on code, actually infra |
| AT-04 | Masking failure — real cause hidden | no coverage | First error swallowed, second error reported |
| AT-05 | Accidental correctness | no coverage | Predicate passes by coincidence, not causation |
| AT-06 | Proxy success — right outcome, wrong reason | no coverage | CSS matches but inherited, not authored |
| AT-07 | Structural validity masks semantic incorrectness | no coverage | HTML valid but accessibility broken |
| AT-08 | Semantic correctness masks structural breakage | no coverage | Logic right but layout destroyed |
| AT-09 | Constraint seeded from wrong failure class | no coverage | K5 learns wrong lesson from misattributed failure |
| AT-10 | Narrowing hint leads to correct fix for wrong reason | no coverage | Agent fixes symptom, not disease |

**Attribution total: 10 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 10.**

---

## Drift / Regression Failures

Failures where the system was correct, becomes incorrect without any direct change. The environment shifted around it. Distinct from temporal (same run, different moment) — drift happens across runs, deploys, or time periods.

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| DR-01 | Dependency update changes behavior | no coverage | `npm update` changes CSS framework defaults |
| DR-02 | CSS cascade shifts from unrelated edit | no coverage | New rule higher in specificity added elsewhere |
| DR-03 | DB migration changes default behavior | no coverage | Column default changed, existing code assumes old default |
| DR-04 | API contract changes upstream | no coverage | Third-party API response shape changes |
| DR-05 | Runtime version drift | no coverage | Node 18 → Node 20, behavior difference |
| DR-06 | Container base image update | no coverage | `node:alpine` rebuilds with different packages |
| DR-07 | Configuration drift | no coverage | Environment variable changed between deploys |
| DR-08 | Certificate / credential expiry | no coverage | Worked yesterday, fails today — no code change |
| DR-09 | External service availability | no coverage | Third-party down, verification fails |
| DR-10 | Indirect regression from transitive dependency | no coverage | Sub-dependency of sub-dependency changes |

**Drift total: 10 shapes. Generator coverage: 0. Scenario-only coverage: 0. No coverage: 10.**

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
| X-51 | Object key ordering affects fingerprint | no coverage | Semantically identical, different key order |
| X-52 | Array ordering matters for some predicates not others | no coverage | False dedupe or false split |
| X-53 | Fingerprint collision across predicate classes | no coverage | Same field names, different types → same fingerprint |
| X-54 | Constraint store corruption / partial write | no coverage | Half-written memory file |
| X-55 | Concurrent readers observe half-written state | no coverage | Race between read and write |
| X-56 | Expired constraint retained inconsistently | no coverage | Filtered in one code path, retained in another |

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
| X-16 | Concurrent constraint seeding | no coverage | Two failures seeding simultaneously |
| X-17 | Constraint with empty appliesTo | no coverage | Does it match everything or nothing? |

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
| X-37 | Search string not found | no coverage | Edit can't be applied |
| X-38 | Search string found multiple times | no coverage | Ambiguous edit |
| X-39 | Search string with special regex chars | no coverage | `.` `*` `[` in search |
| X-40 | Empty search or replace | no coverage | Edge case |
| X-41 | Line ending mismatch in edit | no coverage | Edit has `\n`, file has `\r\n` |
| X-66 | Overlapping edits interfere | no coverage | Two edits affect same region |
| X-67 | Edit order changes final result | no coverage | Non-commutative edit sequence |
| X-68 | Search/replace hits previous replacement | no coverage | Substring of prior replacement matches |
| X-69 | Unicode grapheme boundaries break search | no coverage | Multi-codepoint characters split by search |
| X-70 | File mutated between read and apply | no coverage | Race condition |
| X-71 | Search matches scaffold/boilerplate, not target | no coverage | Duplicate regions, wrong hit |

### Narrowing (Gate: Narrowing)

| # | Failure Shape | Status | Notes |
|---|---|---|---|
| X-42 | Resolution hint present on failure | scenarios (uv-016, uv-017) | 2 scenarios |
| X-43 | Hint references actual values | no coverage | Hint says "actual is X" — is X correct? |
| X-44 | Hint is actionable | no coverage | Can an agent use the hint to fix the issue? |
| X-45 | No hint on infrastructure error | no coverage | Harness fault should not produce hints |
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

**Cross-cutting total: 81 shapes. Generator coverage: 35. Scenario-only coverage: 2. No coverage: 44.**

---

## Summary

| Domain | Total Shapes | Generator | Scenario Only | No Coverage | Coverage % |
|---|---|---|---|---|---|
| CSS | 62 | 1 | 7 | 54 | 13% |
| HTML | 41 | 0 | 3 | 38 | 7% |
| Filesystem | 34 | 0 | 0 | 34 | 0% |
| Content | 13 | 0 | 2 | 11 | 15% |
| HTTP | 45 | 1 | 1 | 43 | 4% |
| DB | 46 | 0 | 0 | 46 | 0% |
| Browser | 27 | 0 | 0 | 27 | 0% |
| Temporal | 10 | 0 | 0 | 10 | 0% |
| Interaction | 12 | 0 | 0 | 12 | 0% |
| Invariant | 9 | 0 | 0 | 9 | 0% |
| Identity | 10 | 0 | 0 | 10 | 0% |
| Observer Effects | 9 | 0 | 0 | 9 | 0% |
| Concurrency | 9 | 0 | 0 | 9 | 0% |
| Scope Boundary | 10 | 0 | 0 | 10 | 0% |
| Attribution | 10 | 0 | 0 | 10 | 0% |
| Drift | 10 | 0 | 0 | 10 | 0% |
| Cross-cutting | 81 | 35 | 2 | 44 | 46% |
| **Total** | **438** | **37** | **15** | **386** | **12%** |

### The numbers

- **438 known failure shapes** across 17 domains
- **37 have generators** (all in cross-cutting gate tests)
- **15 have individual scenarios** (no generator)
- **386 have zero coverage** (88% of the known taxonomy)
- **Current scenario count: 97** (80 built-in + 17 universal)

### What full coverage looks like

If every shape gets a generator producing ~25 scenarios average:
- 386 uncovered shapes × 25 = **~9,650 new scenarios**
- Plus existing 97 = **~9,750 total**
- Self-test runtime at 2ms/scenario: **~19.5 seconds**

That's the ceiling with today's known taxonomy. Chaos will discover shapes not on this list, so the real number is higher.

### Domain architecture

The 17 domains organize into three layers:

**Reality surfaces (7)** — domains where predicates observe truth:
- CSS, HTML, Filesystem, Content, HTTP, DB, Browser

**Meta-failure classes (7)** — failure modes that cut across all surfaces:
- Temporal, Interaction, Identity, Observer Effects, Concurrency, Scope Boundary, Drift

**System-internal (3)** — failures in verify's own gate logic:
- Invariant, Attribution, Cross-cutting

### Priority tiers

**Tier 1 — High ROI, testable on demo-app today:**
- CSS value normalization (C-01 through C-16, C-44 through C-52) — ~25 shapes, ~600 scenarios
- CSS shorthand family (C-17 through C-30) — ~14 shapes, ~300 scenarios
- HTML text/content matching (H-08 through H-14, H-24 through H-29) — ~13 shapes, ~300 scenarios
- F9 syntax validation (X-37 through X-41, X-66 through X-71) — ~11 shapes, ~250 scenarios
- Content pattern matching (N-04 through N-08) — ~5 shapes, ~100 scenarios
- Filesystem basics (FS-01 through FS-15) — ~15 shapes, ~300 scenarios
- Fingerprinting edge cases (X-51 through X-56) — ~6 shapes, ~150 scenarios
- Attribution errors (AT-01 through AT-10) — ~10 shapes, ~200 scenarios

**Tier 2 — Needs minor demo-app expansion:**
- CSS selector edge cases (C-34 through C-43, C-53 through C-62) — needs 2+ routes, shadow DOM
- HTTP body/request (P-01 through P-38) — needs richer API
- HTML structure (H-15 through H-41) — needs richer HTML
- Invariant shapes (INV-01 through INV-09) — needs invariant-aware demo-app
- Cross-predicate interactions (I-01 through I-12) — needs multi-surface demo
- Browser interaction/navigation (BR-01 through BR-13) — needs JS runtime
- Scope boundary shapes (SC-01 through SC-10) — needs multi-component demo
- Identity/reference shapes (ID-01 through ID-10) — needs cross-surface verification

**Tier 3 — Needs DB fixture or real infrastructure:**
- All 46 DB shapes (D-01 through D-46) — needs demo-app with DB
- HTTP network (P-39 through P-45) — needs real server/proxy
- Temporal shapes (TO-01 through TO-10) — needs async/dynamic runtime
- Browser lifecycle (BR-19 through BR-27) — needs hydration/SPA framework
- Concurrency shapes (CO-01 through CO-09) — needs multi-process environment
- Observer effects (OE-01 through OE-09) — needs stateful production-like setup
- Drift/regression (DR-01 through DR-10) — needs multi-deploy history
- Dynamic content (H-23, H-41) — needs JS runtime / hydration

---

## Roadmap: Closing Coverage

This section captures the concrete plan for going from 12% to full coverage. It serves as the authoritative reference so context isn't lost across sessions.

### Phase 1: New Predicate Types

Domains define reality. Predicate types define how you query it. The relationship is 1:N — one domain can have multiple predicate types.

**Current predicate types (6):**

| Domain | Predicate Type | Status |
|--------|---------------|--------|
| CSS | `css` | Shipped |
| HTML | `html` | Shipped |
| Content | `content` | Shipped |
| HTTP | `http` | Shipped |
| HTTP | `http_sequence` | Shipped |
| DB | `db` | Shipped |

**New predicate types to add (6):**

| Domain | Predicate Type | Priority | What it tests |
|--------|---------------|----------|---------------|
| Filesystem | `fs` | **Next** | File exists, permissions, size, content hash, symlinks, encoding |
| Browser | `interaction` | After fs | Click targets, form inputs, event handlers, focus/blur |
| Browser | `navigation` | After fs | Route transitions, history state, redirects, anchor links |
| Browser | `visibility` | After fs | Display state, viewport intersection, z-index stacking, opacity |
| Browser | `storage` | After fs | localStorage, sessionStorage, cookies, indexedDB |
| Browser | `lifecycle` | Tier 3 | Hydration, SSR/CSR transitions, web component upgrades, lazy loading |

**Why browser needs multiple types, not one monolithic `browser`:**
- Each type has a distinct verification mechanism (DOM query vs navigation API vs IntersectionObserver vs Storage API)
- Failure modes are orthogonal — an interaction bug shares nothing with a storage bug
- Generators are cleaner when scoped to one verification surface
- Matches the existing pattern: HTTP has `http` + `http_sequence`, not one type

### Phase 2: Generator Build Order

Priority-ordered by ROI (shapes closed per engineering hour). Each phase builds on demo-app capabilities from the previous one.

**Wave 1 — Pure computation, no demo-app changes needed (Tier 1):**
1. CSS value normalization generators (C-01 through C-16, C-44 through C-52) — 25 shapes, ~600 scenarios
2. CSS shorthand generators (C-17 through C-30) — 14 shapes, ~300 scenarios
3. `fs` predicate type + filesystem generators (FS-01 through FS-15) — 15 shapes, ~300 scenarios
4. Content pattern generators (N-04 through N-08) — 5 shapes, ~100 scenarios
5. Fingerprinting edge case generators (X-51 through X-56) — 6 shapes, ~150 scenarios
6. Attribution error generators (AT-01 through AT-10) — 10 shapes, ~200 scenarios

*Wave 1 total: ~75 shapes, ~1,650 scenarios. Coverage: 12% → 29%*

**Wave 2 — Minor demo-app expansion (Tier 2):**
7. HTML text/content generators (H-08 through H-14, H-24 through H-29) — 13 shapes, ~300 scenarios
8. HTML structure generators (H-15 through H-41) — needs richer HTML in demo-app
9. HTTP body/request generators (P-01 through P-38) — needs richer API routes
10. CSS selector edge cases (C-34 through C-62) — needs 2+ routes, pseudo-elements
11. `interaction` + `navigation` + `visibility` + `storage` predicate types
12. Browser interaction generators (BR-01 through BR-13) — needs JS event handlers in demo-app
13. Cross-predicate interaction generators (I-01 through I-12) — needs multi-surface demo
14. Invariant generators (INV-01 through INV-09) — needs invariant-aware demo-app
15. Scope boundary generators (SC-01 through SC-10) — needs multi-component demo
16. Identity/reference generators (ID-01 through ID-10) — needs cross-surface verification

*Wave 2 total: ~150 shapes, ~3,500 scenarios. Coverage: 29% → 63%*

**Wave 3 — Infrastructure expansion (Tier 3):**
17. DB generators (D-01 through D-46) — needs demo-app with DB fixture
18. Filesystem advanced generators (FS-16 through FS-34) — needs symlinks, permissions
19. `lifecycle` predicate type + browser lifecycle generators (BR-19 through BR-27)
20. Temporal generators (TO-01 through TO-10) — needs async/dynamic runtime
21. HTTP network generators (P-39 through P-45) — needs real server/proxy
22. Concurrency generators (CO-01 through CO-09) — needs multi-process environment
23. Observer effects generators (OE-01 through OE-09) — needs stateful setup
24. Drift/regression generators (DR-01 through DR-10) — needs multi-deploy history

*Wave 3 total: ~161 shapes, ~4,000 scenarios. Coverage: 63% → 100%*

### Phase 3: `fs` Predicate Spec (Immediate Next)

The filesystem is the most deterministic reality surface — no browser, no network, no timing. Design the `fs` predicate type first because:
- **Strongest K5 learning signal** — binary pass/fail, no normalization ambiguity
- **Zero infrastructure** — works on any OS, no Docker, no browser
- **Perfect grounding** — file system is the ground truth, not a proxy for it
- **Fast verification** — `stat()`, `readFile()`, `readdir()` are sub-millisecond
- **Broadest applicability** — every app has files; not every app has a browser or DB

Spec design happens in the next session. Target: `packages/verify/src/predicates/fs.ts` with types in `src/types.ts`.

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
