# Real-World Data Sources for Verify Harvesters

**Purpose:** Complement synthetic generators with real external data sources for discovery-grade testing.
**Date:** 2026-03-28 (scoping) / 2026-03-29 (Phase 1) / 2026-03-30 (Phase 2 partial)
**Status:** Phase 2 in progress — 13 sources live, 6,432 scenarios from real data.

---

## Executive Summary

Verify has two independent scenario sources, selectable at runtime via `--source`:

- **Synthetic** (11,867 scenarios, 99 staged fixtures) — Deterministic, checked-in, one-shape-per-scenario. Written by 100 `stage-*.ts` generators. The improve loop's holdout/validation split depends on this stability. Never changes unless a human edits a generator.
- **Real-world** (908+ scenarios, 8 staged fixtures) — Fetched nightly from public data sources, gitignored, regenerated from live data. Finds failure patterns humans wouldn't enumerate.

Synthetic = regression safety net. Real-world = discovery engine. Both run in the same pipeline.

```bash
bun run self-test                        # synthetic only (default)
bun run self-test --source=real-world    # real-world only
bun run self-test --source=all           # both
bun scripts/supply/harvest-real.ts       # fetch + generate real-world scenarios
```

### Phase 1 (implemented — March 29)

| Source | Harvester | Real Data | Scenarios |
|--------|-----------|-----------|-----------|
| SchemaPile | harvest-db | 22,989 PostgreSQL schemas | 2,000 |
| JSON Schema Test Suite | harvest-http | 83 validation test files | 1,000 |
| MDN Compat Data | harvest-css | Full browser compat DB | 101 |
| Can I Use | harvest-css | CSS feature support matrix | 33 |
| PostCSS Parser Tests | harvest-css | 24 CSS edge cases | 20 |
| Mustache Spec | harvest-html | 203 template tests | 228 |
| PayloadsAllTheThings | harvest-security | 2,708 XSS vectors | 95 |
| Heroku Error Codes | harvest-infra | 36 error codes | 47 |

### Phase 2 (implemented — March 30)

| Source | Harvester | Real Data | Scenarios |
|--------|-----------|-----------|-----------|
| html5lib-tests | harvest-html | 59 `.dat` parser conformance files | 1,200 |
| DOMPurify | harvest-security | 98 sanitization vectors (`.mjs`) | 500 |
| PostgreSQL regression | harvest-db | 10 SQL regression test files | 448 |
| HTTPWG structured fields | harvest-http | 8 RFC test vector files | 500 |
| docker/awesome-compose | harvest-infra | 40+ real compose files (YAML) | 260 |

### Remaining addressable sources: 85+
### Remaining fetchable test artifacts: 600,000+

---

## 1. CSS Harvester (`harvest-css`)

**Current state:** Hardcoded CSS property/value patterns
**Target state:** Real CSS test suites, parser fixtures, framework CSS, compatibility data

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **WPT CSS suite** | `git clone wpt.git` → `/css/` subtree | 5,000+ test files | Low |
| 2 | **PostCSS parser tests** | `git clone postcss-parser-tests` | 24 extreme edge cases | Trivial |
| 3 | **CSSTree fixtures** | `/fixtures/ast/selector/*.json` | 200+ JSON AST files | Low |
| 4 | **MDN compat data** | `npm install @mdn/browser-compat-data` or `curl unpkg.com` | 10,000+ property variants | Low |
| 5 | **Can I Use** | `curl raw.githubusercontent.com/Fyrd/caniuse/main/fulldata-json/data-2.0.json` | 1,000+ CSS features | Trivial |
| 6 | **W3C CSS Validator tests** | `git clone w3c/css-validator-testsuite` | 1,000+ property tests | Low |
| 7 | **Bootstrap 5.3 CDN** | `curl cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css` | 5,000+ rules | Trivial |
| 8 | **Normalize.css** | `curl raw.githubusercontent.com/necolas/normalize.css/master/normalize.css` | 100+ reset rules | Trivial |

**Key URLs:**
```bash
# PostCSS parser tests (extreme edge cases)
git clone https://github.com/postcss/postcss-parser-tests.git

# CSSTree AST fixtures
curl https://raw.githubusercontent.com/csstree/csstree/master/fixtures/ast/selector/AttributeSelector.json

# MDN compat data (entire CSS property database)
curl https://unpkg.com/@mdn/browser-compat-data/data.json

# Can I Use (feature support matrix)
curl https://raw.githubusercontent.com/Fyrd/caniuse/main/fulldata-json/data-2.0.json
```

---

## 2. HTTP Harvester (`harvest-http`)

**Current state:** Hardcoded status code / header patterns
**Target state:** Real OpenAPI specs, RFC test vectors, HTTP conformance suites

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **APIs.guru** | `git clone APIs-guru/openapi-directory` → `/specs/` | 2,529 API specs, 108K endpoints | Low |
| 2 | **HTTPWG structured field tests** | `git clone httpwg/structured-field-tests` | 1,000+ RFC test vectors | Low |
| 3 | **JSON Schema Test Suite** | `git clone json-schema-org/JSON-Schema-Test-Suite` → `/tests/draft2020-12/` | 2,000+ validation cases | Low |
| 4 | **GitHub REST API spec** | `git clone github/rest-api-description` | 500+ real endpoints | Low |
| 5 | **httpstat.us** | `curl https://httpstat.us/{code}` | 70+ status codes | Trivial |
| 6 | **h2spec** | `git clone summerwind/h2spec` | 100+ HTTP/2 protocol tests | Low |
| 7 | **Unicode normalization vectors** | `curl unicode.org/.../NormalizationTest.txt` | 25,000+ test cases | Trivial |

**Key URLs:**
```bash
# APIs.guru (2,529 real API definitions)
git clone https://github.com/APIs-guru/openapi-directory.git

# HTTPWG RFC test vectors
git clone https://github.com/httpwg/structured-field-tests.git

# JSON Schema official test suite
git clone https://github.com/json-schema-org/JSON-Schema-Test-Suite.git

# Live status code testing
curl https://httpstat.us/418
curl 'https://httpstat.us/200?sleep=5000'
```

---

## 3. DB Harvester (`harvest-db`)

**Current state:** Hardcoded SQL schema patterns
**Target state:** SchemaPile (22K real schemas), PostgreSQL regression tests, Spider dataset

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **SchemaPile (HuggingFace)** | Single HTTP → JSONL or Parquet | 22,989 pre-parsed schemas | Low |
| 2 | **PostgreSQL regression tests** | `curl` 56 SQL files from postgres/postgres | 56 files, every exotic PG feature | Low |
| 3 | **Spider DDL (HuggingFace)** | Parquet download | 166 cross-domain databases | Low |
| 4 | **Pagila + postgresDBSamples** | `curl` raw SQL files | 7 rich sample databases | Trivial |
| 5 | **pgTAP test suite** | `curl` 37 SQL files from theory/pgtap | 37 files (RLS, inheritance, materialized views) | Low |
| 6 | **Supabase migrations** | GitHub raw content | ~91 modern PG SQL files | Low |
| 7 | **SchemaPile raw SQL (Zenodo)** | 145MB tar.gz download | ~22K original DDL files | Medium |
| 8 | **BIRD-SQL** | HuggingFace parquet | 95 messy real-world databases | Low |
| 9 | **Prisma database-schema-examples** | `git clone --depth 1 https://github.com/prisma/database-schema-examples.git` — 40+ schemas across PG/MySQL/SQLite/MSSQL with cross-DB type mapping edge cases | 40+ cross-DB schemas | Low |
| 10 | **TypeORM test fixtures** | `git clone --depth 1 https://github.com/typeorm/typeorm.git` → `test/functional/` (relations, indices, unique constraints, cascade options, composite FKs) | 200+ constraint patterns | Medium |
| 11 | **Rein gem** (Rails constraint DSL) | `git clone --depth 1 https://github.com/nullobject/rein.git` — presence, uniqueness, inclusion, FK with cascade/restrict actions | 150+ constraint patterns | Medium |

**Key URLs:**
```bash
# SchemaPile — 22,989 real schemas, single request
curl -L "https://huggingface.co/datasets/trl-lab/schemapile/resolve/main/data.jsonl" -o schemapile.jsonl

# PostgreSQL official test suite (56 schema-relevant files)
curl -sL "https://raw.githubusercontent.com/postgres/postgres/master/src/test/regress/sql/create_table.sql"
curl -sL "https://raw.githubusercontent.com/postgres/postgres/master/src/test/regress/sql/foreign_key.sql"

# Spider DDL (166 cross-domain databases)
curl -L "https://huggingface.co/api/datasets/philikai/SQL_Spider_DDL/parquet/default/train/0.parquet" -o spider-ddl.parquet

# Pagila (richest single PG sample database)
curl "https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-schema.sql"
```

**SchemaPile JSON format** (pre-parsed, immediately usable):
```json
{
  "ID": "...", "TABLES": [{
    "TABLE_NAME": "users",
    "COLUMNS": [{"NAME": "id", "TYPE": "integer", "NULLABLE": false, "IS_PRIMARY": true}],
    "FOREIGN_KEYS": [{"ON_DELETE": "CASCADE", "ON_UPDATE": "NO ACTION"}],
    "CHECKS": [...], "INDEXES": [...]
  }]
}
```

---

## 4. Build/CI Harvester (`harvest-build`)

**Current state:** Hardcoded build error patterns
**Target state:** Real CI failure logs, academic bug datasets, bundler test suites

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **GitHub Issues Search API** | `curl` with error pattern queries | 770K+ issues with real error messages | Low |
| 2 | **GHALogs (Zenodo)** | 513K real GitHub Actions runs | 513,000 CI runs with logs | Medium |
| 3 | **SWE-bench (HuggingFace)** | Python datasets API | 2,294 real GitHub issues + patches | Low |
| 4 | **Heroku error codes** | `curl` single page | 37 codes = 37 scenario families | Trivial |
| 5 | **TypeScript compiler tests** | `git clone microsoft/TypeScript` → `/tests/cases/compiler/` | 1,000+ compiler error cases | Low |
| 6 | **Webpack test fixtures** | `git clone webpack/webpack` → `/test/fixtures/` | 500+ build error fixtures | Low |
| 7 | **npm/cli test suite** | `git clone npm/cli` → `/test/` | 600+ dependency resolution cases | Low |
| 8 | **Defects4J** | `git clone rjust/defects4j` | 854 real Java bugs with fix pairs | Medium |
| 9 | **"100 Docker Errors" (dev.to)** | `curl dev.to/api/articles/...` | 100 Docker errors | Trivial |

**Key URLs:**
```bash
# GitHub Issues — mine specific error patterns (no auth needed)
curl -s "https://api.github.com/search/issues?q=%22ECONNREFUSED%22+is:issue&per_page=100"
curl -s "https://api.github.com/search/issues?q=%22OOM+killed%22+is:issue&per_page=100"
curl -s "https://api.github.com/search/issues?q=%22health+check+failed%22+is:issue&per_page=100"

# SWE-bench (2,294 real issues with test patches)
# pip install datasets
# load_dataset('SWE-bench/SWE-bench_Lite')

# Heroku error codes (37 distinct failure modes)
curl -s "https://devcenter.heroku.com/articles/error-codes"

# 100 Docker errors via dev.to API
curl -s "https://dev.to/api/articles/prodevopsguytech/100-common-docker-errors-solutions-4le0"
```

---

## 5. Health Check Harvester (`harvest-health`)

**Current state:** Hardcoded health check patterns
**Target state:** Real Docker health checks, Heroku error codes, container orchestrator failure codes

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **rodrigobdz/docker-compose-healthchecks** | README YAML snippets | 5 services (pg, redis, ES, MinIO, mongo) | Trivial |
| 2 | **Heroku error codes** | H10 (crash), H12 (timeout), H20 (boot), R14 (OOM) | 37 codes | Trivial |
| 3 | **AWS ECS failure codes** | `curl` docs pages | ~50 container failure codes | Low |
| 4 | **docker-library/healthcheck** | Dedicated health check patterns repo | Docker official patterns | Low |
| 5 | **danluu/post-mortems** | `curl` README | ~150 real production failure entries | Trivial |
| 6 | **k8s.af failure stories** | `curl` from Codeberg | 59 real K8s failure entries | Trivial |

**Key URLs:**
```bash
# danluu/post-mortems (150+ real production failures)
curl -s "https://raw.githubusercontent.com/danluu/post-mortems/master/README.md"

# Kubernetes failure stories (59 real incidents)
curl -s "https://codeberg.org/hjacobs/kubernetes-failure-stories/raw/branch/master/README.md"
```

---

## 6. Infrastructure Harvester (`harvest-infra` / Docker/Config)

**Current state:** Hardcoded Dockerfile/compose patterns
**Target state:** Real compose files, Dockerfiles, Helm charts, K8s manifests

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **Haxxnet/Compose-Examples** | `api.github.com/.../contents/examples` → 158 dirs | 158 real-world compose files | Low |
| 2 | **docker/awesome-compose** | Git tree API → 40 example dirs | 39 compose + 35 Dockerfiles | Low |
| 3 | **hadolint test fixtures** | 67 Haskell test files with Dockerfile snippets | ~500-1000 Dockerfile fragments | Medium |
| 4 | **docker-library official images** | `api.github.com/orgs/docker-library/repos` | 142 image defs, ~500 Dockerfiles | Low |
| 5 | **bitnami/charts** | `api.github.com/.../contents/bitnami` | 133 Helm charts, ~2K K8s templates | Low |
| 6 | **kubernetes/examples** | Git tree API | 250 K8s YAML manifests | Low |
| 7 | **bitnami/containers** | `api.github.com/.../contents/bitnami` | ~330 container image Dockerfiles | Low |
| 8 | **nginx-proxy template** | `curl` single file | 1,200-line nginx.conf generator | Trivial |
| 9 | **moby/moby integration tests** | `git clone --depth 1 https://github.com/moby/moby.git` → `integration/build/`, `integration/container/`, `integration/network/` (build cache, OOM kill, DNS, health checks) | 500+ test cases | Medium |
| 10 | **kubeconform fixtures** | `curl https://raw.githubusercontent.com/yannh/kubeconform/master/fixtures/valid.yaml` + `invalid.yaml` (K8s manifest validation failures) | 50+ validation patterns | Trivial |
| 11 | **moby/buildkit cache tests** | `git clone --depth 1 https://github.com/moby/buildkit.git` → `cache/` (multi-stage COPY --from, ARG cache busting, .dockerignore invalidation) | 50+ cache edge cases | Medium |
| 12 | **Trivy test fixtures** | `git clone --depth 1 https://github.com/aquasecurity/trivy.git` → `integration/testdata/fixtures/` (CVE detection, misconfiguration, secret exposure) | 200+ security patterns | Medium |

**Key URLs:**
```bash
# Haxxnet — 158 real docker-compose files
curl -s "https://api.github.com/repos/Haxxnet/Compose-Examples/contents/examples" | jq '.[].name'

# Docker official awesome-compose
curl -s "https://raw.githubusercontent.com/docker/awesome-compose/master/react-express-mysql/compose.yaml"

# hadolint rules (67 anti-pattern test files)
curl -s "https://api.github.com/repos/hadolint/hadolint/contents/test/Hadolint/Rule" | jq '.[].name'

# nginx-proxy template (1,200-line production nginx.conf)
curl -s "https://raw.githubusercontent.com/nginx-proxy/nginx-proxy/main/nginx.tmpl"
```

---

## 7. E2E/Playwright Harvester (browser gate scenarios)

**Current state:** Hardcoded browser assertion patterns
**Target state:** Real Playwright/Cypress fixtures, Chromium flaky tests, academic flakiness datasets

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **WPT CSS computed-style tests** | `/css/` subtree (shared with CSS harvester) | 10,000+ test files | Low |
| 2 | **Playwright test assets** | `/tests/assets/` (53 HTML + 2 CSS) | Shadow DOM, animations, iframes | Low |
| 3 | **Chromium TestExpectations** | Single file from chromium.googlesource.com | 2,000+ entries (150-200 flaky) | Trivial |
| 4 | **Zenodo UI Flaky Tests** | Single ZIP download (607KB) | 235 classified flaky tests (Angular/Vue/React) | Trivial |
| 5 | **Zenodo DOM Events Flakiness** | Single XLSX download (133KB) | DOM event timing/propagation | Trivial |
| 6 | **Playwright GitHub issues** | API search for CSS/flaky bugs | ~50+ with reproductions | Low |
| 7 | **Puppeteer test assets** | `/test/assets/` (41 HTML + 3 CSS) | Shadow DOM, CSS coverage, frames | Low |
| 8 | **axe-core accessibility rules** | `git clone dequelabs/axe-core` | 150+ WCAG rules, 1000+ test cases | Low |

**Key URLs:**
```bash
# Chromium flaky test list (gold mine — cross-platform rendering failures)
curl "https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/web_tests/TestExpectations?format=TEXT" | base64 -d

# Zenodo UI Flaky Tests dataset (235 classified tests)
curl -L "https://zenodo.org/records/4456027/files/ui-flaky-test-dataset.zip?download=1" -o ui-flaky.zip

# Zenodo DOM Events Flakiness
curl -L "https://zenodo.org/api/records/13862284/files/dataset_pulic_DOM_Event.xlsx/content" -o dom-flaky.xlsx

# Playwright test fixtures
curl "https://raw.githubusercontent.com/microsoft/playwright/main/tests/assets/shadow.html"
```

---

## 8. Edit Harvester (`harvest-edit`)

**Current state:** Hardcoded search/replace patterns
**Target state:** Real code transformation datasets, refactoring pairs

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **SWE-bench** | Real issue → patch pairs | 2,294 real edit pairs | Low |
| 2 | **Defects4J** | Buggy → fixed version pairs | 854 real bug fix edits | Medium |
| 3 | **E2EGit dataset** | Git tags for regression/fix states | 6 regression/fix pairs | Low |
| 4 | **TypeScript compiler tests** | Test cases with expected vs actual | 1,000+ error/fix scenarios | Low |

---

## 9. Cascade Harvester (`harvest-cascade`)

**Current state:** Hardcoded CSS cascade patterns
**Target state:** WPT cascade tests, CSS specificity data

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **WPT `/css/cascade/`** | Cascade and specificity rule tests | 500+ test files | Low |
| 2 | **WPT `/css/selectors/`** | Selector specificity edge cases | 500+ test files | Low |
| 3 | **CSSTree selector fixtures** | `/fixtures/ast/selector/` JSON files | 50+ AST fixture files | Low |
| 4 | **W3C Interop 2026** | `@layer` cascade layers tests | 500+ bleeding-edge tests | Low |

---

## 10. OpenAPI Harvester (`harvest-openapi`)

**Current state:** Hardcoded OpenAPI schema patterns
**Target state:** Real API specs from APIs.guru, production API descriptions

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **APIs.guru** | 2,529 real OpenAPI specs | 108,837 real endpoints | Low |
| 2 | **GitHub REST API spec** | Production GitHub API definition | 500+ endpoints | Low |
| 3 | **DigitalOcean OpenAPI** | Cloud infrastructure API spec | 200+ endpoints | Low |
| 4 | **Figma REST API spec** | Design tool API spec | 50+ endpoints | Low |

---

## 11. CVE Harvester (`harvest-cve`)

**Current state:** Hardcoded vulnerability patterns
**Target state:** Real CVE data, XSS vectors, security test suites

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **OWASP XSS filter evasion** | Curated XSS attack vectors | 100+ vectors | Low |
| 2 | **html5sec.org vectors** | HTML5 security edge cases | 150+ vectors | Low |
| 3 | **NVD API** | `curl services.nvd.nist.gov/rest/json/cves/2.0` | 200K+ CVEs | Low |
| 4 | **Snyk vulnerability DB** | Public advisory data | 10K+ advisories | Medium |

---

## 12. HTML/Content Harvester (`harvest-html`)

**Current state:** Hardcoded HTML element patterns
**Target state:** html5lib parser tests, W3C validator suite, template engine fixtures, sanitization vectors

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **html5lib-tests** | `git clone --depth 1 https://github.com/html5lib/html5lib-tests.git` → `tree-construction/` (59 `.dat` files, 1,778 tests) + `tokenizer/` (14 `.test` JSON files) | 2,000+ parser conformance tests | Low |
| 2 | **W3C Nu HTML Validator** | `git clone --depth 1 https://github.com/validator/validator.git` → `tests/html/` (3,725 files) + `tests/html-aria/` (780) + `tests/html-svg/` (520) | 5,442 valid/invalid markup files | Low |
| 3 | **Mustache spec** | `git clone --depth 1 https://github.com/mustache/spec.git` → `specs/*.json` — perfect `{ template, data, expected }` format | 203 deterministic template tests | Trivial |
| 4 | **DOMPurify** | `git clone --depth 1 https://github.com/cure53/DOMPurify.git` → `test/fixtures/expect.mjs` (98 vectors: SVG injection, DOM clobbering, JS URI variants) | 200-400 sanitization scenarios | Low |
| 5 | **PayloadsAllTheThings XSS** | `git clone --depth 1 https://github.com/swisskyrepo/PayloadsAllTheThings.git` → `XSS Injection/Intruders/` (2,708 lines across 11 payload files) | 500-1,000 security vectors | Low |
| 6 | **axe-core** | `git clone --depth 1 https://github.com/dequelabs/axe-core.git` → `lib/rules/*.json` (105 rules) + `test/integration/full/` (319 HTML fixtures) | 300-500 accessibility scenarios | Medium |
| 7 | **Pug test cases** | `git clone --depth 1 https://github.com/pugjs/pug.git` → `packages/pug/test/cases/` (137 `.pug` → `.html` deterministic pairs + 22 anti-cases) | 150 template rendering tests | Low |
| 8 | **Handlebars.js** | `git clone --depth 1 https://github.com/handlebars-lang/handlebars.js.git` → `spec/` (379 test cases across 11 JS spec files) | 200-300 template tests | Medium |
| 9 | **W3C JSON-LD API** | `git clone --depth 1 https://github.com/w3c/json-ld-api.git` → `tests/html/` (51 HTML files with `<script type="application/ld+json">`) | 100-200 structured data extraction | Medium |
| 10 | **Schema.org examples** | `git clone --depth 1 https://github.com/schemaorg/schemaorg.git` → `data/examples.txt` (212 examples × 3 formats: Microdata, RDFa, JSON-LD) | 300-600 structured data scenarios | Medium |
| 11 | **W3C i18n tests** | `git clone --depth 1 https://github.com/w3c/i18n-tests.git` → `text-direction/`, `character-encoding/`, `html/` (RTL/LTR, combining marks, surrogate pairs, emoji) | 100+ i18n edge cases | Medium |
| 12 | **WPT Content-Security-Policy** | Already in WPT clone → `content-security-policy/` (CSP directive parsing, nonce/hash matching, violation reporting, frame-ancestors) | 200+ CSP test cases | Low |
| 13 | **OWASP CheatSheetSeries** | `git clone --depth 1 https://github.com/OWASP/CheatSheetSeries.git` → `cheatsheets/XSS_Filter_Evasion_Cheat_Sheet.md` (50+ evasion techniques with variants) | 100-200 filter evasion scenarios | Low |

**Total estimated yield: 5,100-8,200 scenarios from 14,500+ raw artifacts**

**Highest-yield quick wins:**
- Mustache spec — perfect JSON format, zero parsing needed, 203 exact input/output pairs
- Pug test cases — deterministic `.pug` → `.html` file pairs, trivially convertible
- html5lib `tree-construction/` — canonical parser tests, custom `.dat` format (well-documented)
- Nu Validator `tests/html/` — massive volume, naming convention encodes pass/fail (`-novalid.html`)

---

## 13. Cross-Cutting: Routing, Config & Infrastructure Edge Cases

**Applies to:** `harvest-http`, `harvest-health`, `harvest-infra`
**What:** Real-world routing bugs, config pitfalls, and infrastructure misconfigurations scraped from popular open-source projects and community forums. These don't fit a single harvester — they generate scenarios across multiple capabilities.

### Routing & Middleware Configs

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **sahat/hackathon-starter** (34.9k stars) | `curl https://raw.githubusercontent.com/sahat/hackathon-starter/master/app.js` — 62 Express routes with middleware ordering bugs, CSRF bypasses, auth gaps | 50-100 | Trivial |
| 2 | **Vercel edge-middleware examples** | `git clone --depth 1 https://github.com/vercel/examples.git` → `edge-middleware/` (34 TypeScript middleware examples: A/B testing, auth, geolocation, i18n, rate-limiting) | 100-200 | Low |
| 3 | **phanan/htaccess** (12k stars) | `curl https://raw.githubusercontent.com/phanan/htaccess/master/README.md` — 45 Apache rewrite/redirect snippets (redirect loops, trailing slash normalization, HTTPS forcing) | 40-80 | Trivial |
| 4 | **Express.js bug issues** | `curl "https://api.github.com/repos/expressjs/express/issues?labels=bug&state=all&per_page=100"` — hundreds of real route conflicts, middleware ordering bugs, parameter edge cases | 200-500 | Medium |
| 5 | **Next.js Middleware issues** | `curl "https://api.github.com/search/issues?q=repo:vercel/next.js+label:Middleware+is:issue&per_page=50"` — rewrite/redirect conflicts, RSC fetch failures, cookie handling divergence | 100-200 | Medium |

### CORS & Security Configs

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **expressjs/cors** (14k stars) | `curl https://raw.githubusercontent.com/expressjs/cors/master/README.md` — 6+ config patterns (wildcard + credentials = browser rejection, origin reflection = CVE) | 20-40 | Trivial |
| 2 | **Fiber CORS CVE** | `curl https://api.github.com/repos/gofiber/fiber/security/advisories` — CVE-2024-25124: `AllowOrigins: "*"` with credentials | 10-20 | Trivial |

### SSL/TLS & DNS Patterns

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **crt.sh** (Certificate Transparency) | `curl "https://crt.sh/?q=%.example.com&output=json&limit=100"` — real cert records with expiry, SAN mismatches, wildcard coverage | 100-300 | Low |
| 2 | **Let's Encrypt Community Forum** | `curl "https://community.letsencrypt.org/c/help/5.json?per_page=50"` — 30,922 help topics: challenge failures, firewall blocks, renewal errors, TLS handshake failures | 200-500 | Medium |

### Proxy & Reverse Proxy Configs

| Priority | Source | What to Fetch | Scenarios | Effort |
|----------|--------|---------------|-----------|--------|
| 1 | **trimstray/nginx-admins-handbook** (13.4k stars) | `curl https://raw.githubusercontent.com/trimstray/nginx-admins-handbook/master/README.md` — 70+ rules: trailing slash behavior, `$host` vs `$http_host`, proxy buffer overflow, WebSocket upgrade | 100-200 | Low |
| 2 | **nginx WebSocket proxy** | `curl https://raw.githubusercontent.com/nicokaiser/nginx-websocket-proxy/master/simple-wss.conf` — missing `proxy_http_version 1.1`, hop-by-hop header stripping, idle timeout kills | 20-40 | Trivial |
| 3 | **express-rate-limit** | `curl https://raw.githubusercontent.com/express-rate-limit/express-rate-limit/main/readme.md` — in-memory store loss on restart, trust proxy misconfiguration, distributed rate limiting gaps | 20-40 | Trivial |

**Total estimated yield: 960-2,220 additional scenarios across 3 harvesters**

---

## Implementation Priority

### Phase 1: Quick Wins (1-2 days each)
These require only `curl`, single file downloads, or shallow `git clone`:

1. **SchemaPile** → `harvest-db` (22,989 schemas, single HTTP request)
2. **PostCSS parser tests** → `harvest-css` (24 files, `git clone`)
3. **APIs.guru** → `harvest-openapi` + `harvest-http` (2,529 specs, `git clone`)
4. **Heroku error codes** → `harvest-health` (37 codes, single page scrape)
5. **Can I Use data** → `harvest-css` (single JSON file)
6. **Chromium TestExpectations** → E2E harvester (single file)
7. **MDN compat data** → `harvest-css` (`npm install` or single JSON)
8. **Mustache spec** → `harvest-html` (203 tests, perfect JSON `{ template, data, expected }`)
9. **Pug test cases** → `harvest-html` (137 deterministic `.pug` → `.html` pairs)
10. **PayloadsAllTheThings XSS** → `harvest-html` (2,708 security vectors, plain text)

### Phase 2: Medium Effort (3-5 days each)
These require git clones and parsing:

11. **PostgreSQL regression tests** → `harvest-db` (56 SQL files)
12. **HTTPWG structured fields** → `harvest-http` (1,000+ test vectors)
13. **Haxxnet/Compose-Examples** → `harvest-infra` (158 compose files)
14. **docker/awesome-compose** → `harvest-infra` (39 compose + 35 Dockerfiles)
15. **WPT CSS suite** → `harvest-css` + `harvest-cascade` (5,000+ tests)
16. **JSON Schema Test Suite** → `harvest-http` (2,000+ cases)
17. **html5lib-tests** → `harvest-html` (2,000+ parser conformance, custom `.dat` format)
18. **W3C Nu Validator** → `harvest-html` (5,442 HTML files, pass/fail by naming convention)
19. **DOMPurify + cure53** → `harvest-html` (98 sanitization vectors + fixtures)
20. **axe-core** → `harvest-html` (105 rules + 319 HTML accessibility fixtures)

27. **hackathon-starter routes** → `harvest-http` (62 Express routes, single `curl`)
28. **phanan/htaccess** → `harvest-http` (45 Apache rewrite snippets, single `curl`)
29. **expressjs/cors configs** → `harvest-http` (6+ CORS patterns + CVE, single `curl`)
30. **nginx-admins-handbook** → `harvest-infra` (70+ proxy rules, single `curl`)

### Phase 3: Deep Integration (1-2 weeks each)
These require dataset processing or API pagination:

21. **GHALogs (Zenodo)** → `harvest-build` (513K CI runs, 140GB)
22. **SWE-bench** → `harvest-edit` + `harvest-build` (2,294 issues, Python API)
23. **hadolint test fixtures** → `harvest-infra` (Haskell parsing required)
24. **Zenodo flaky test datasets** → E2E harvester (ZIP/XLSX parsing)
25. **Schema.org examples** → `harvest-html` (212 examples × 3 markup formats)
26. **W3C JSON-LD API** → `harvest-html` (51 HTML files with embedded structured data)
27. **Express.js bug issues** → `harvest-http` (GitHub API pagination, hundreds of real bugs)
28. **Let's Encrypt Forum** → `harvest-health` (Discourse API, 30K+ SSL error topics)
29. **crt.sh certificate data** → `harvest-health` (Certificate Transparency API, real cert edge cases)

---

## Success Metric

**Phase 1 (complete):** 8 sources live, 6 harvesters, 908+ real-world scenarios. Synthetic corpus unchanged (11,867 scenarios). `--source` flag enables developer choice.

**Phase 2 target:** 20 sources, ~5,000 real-world scenarios (html5lib, Nu Validator, DOMPurify, axe-core, APIs.guru, nginx configs).

**Phase 3 target:** 50,000+ real-world scenarios from academic datasets, structured data, GitHub issue mining.

**Architecture:**
```
scripts/supply/sources.ts          — Source registry (URLs, formats, harvester mapping)
scripts/supply/harvest-{domain}.ts — 6 format-specific harvesters (db, css, html, http, security, infra)
scripts/supply/harvest-real.ts     — Orchestrator (fetch → harvest → write)
.verify-cache/                     — Fetch cache (gitignored, 24h TTL)
fixtures/scenarios/real-world/     — Output (gitignored, regenerated nightly)
fixtures/scenarios/*-staged.json   — Synthetic (checked in, deterministic)
```

**33 remaining implementation items across Phases 2-3. 90+ addressable sources.**
