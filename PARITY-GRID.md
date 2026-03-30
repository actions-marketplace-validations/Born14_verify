# Verify Parity Grid

**The map of reality.** FAILURE-TAXONOMY.md is the dictionary. This is the map.

## The Law

> Verify has parity when every (agent capability × failure class) intersection
> is represented by at least one grounded, reproducible failure shape backed
> by a generator that simulates real-world failure mechanics.

A shape without a generator that reproduces the actual failure mechanism (timing, cross-surface chain, environment divergence, denial, exhaustion, collision) does not count toward parity.

## The Three Questions of Agent Failure

Verify was built around: **"Did the agent do the right thing?"**
That naturally covers Selection, Mutation, and Convergence.

True parity requires: **"Did the world react the way you expected?"**
That requires Temporal, Propagation, and State Assumption coverage.

Complete parity requires: **"Was the world even available to act on?"**
That requires Access, Capacity, and Contention coverage.

---

## Capability Axis (8 — what agents actually do)

| # | Capability | What It Means | Verify Domains |
|---|-----------|---------------|---------------|
| 1 | **Filesystem Edits** | Create, modify, delete files and directories | Filesystem, Content, F9 Syntax |
| 2 | **HTTP Calls** | Send requests, validate responses, API interaction | HTTP, Serialization |
| 3 | **Browser Interaction** | DOM manipulation, CSS changes, rendered state | Browser, CSS, HTML |
| 4 | **Database Operations** | Schema changes, migrations, data queries | DB |
| 5 | **CLI/Process Execution** | Run commands, manage services, build pipelines | Infrastructure, Staging, Configuration |
| 6 | **Multi-Step Workflows** | Coordinated actions across surfaces | Interaction, Invariant, Message |
| 7 | **Verification/Observation** | Checking own work, evidence gathering | Attribution, Vision/Triangulation, Observer Effects |
| 8 | **Configuration/State** | Env vars, feature flags, security, a11y, perf | Config, Security, A11y, Performance |

## Failure Class Axis (10 — invariant across all capabilities)

| # | Failure Class | What It Means | Generator Requirement |
|---|-------------|---------------|----------------------|
| A | **Selection** | Wrong target chosen | Static mock sufficient |
| B | **Mutation** | Change didn't apply correctly | Static mock sufficient |
| C | **State Assumption** | Wrong belief about current reality | Must simulate environment divergence |
| D | **Temporal** | Ordering, timing, readiness | Must simulate delay, async, incomplete readiness |
| E | **Propagation** | Change didn't cascade across layers | Must simulate multi-surface chain |
| F | **Observation** | Verification itself is wrong | Must simulate observer effects |
| G | **Convergence** | Repeating failed patterns | Must simulate learning loop |
| H | **Access** | Agent lacks permission to act on correct target | Must simulate permission denial, auth failure, or privilege boundary |
| I | **Capacity** | Environment runs out of a resource the agent needs | Must simulate resource exhaustion (memory, disk, rate limits, quotas) |
| J | **Contention** | Multiple actors collide on the same resource | Must simulate concurrent access, race conditions, or lock conflicts |

---

## The Grid

**Legend:** ✓ = strong (dedicated gate logic), ◐ = partial (scenarios only, no gate)

| Capability ↓ / Failure → | A: Selection | B: Mutation | C: State | D: Temporal | E: Propagation | F: Observation | G: Convergence | H: Access | I: Capacity | J: Contention |
|--------------------------|:-----------:|:-----------:|:--------:|:-----------:|:--------------:|:--------------:|:--------------:|:---------:|:-----------:|:-------------:|
| **1. Filesystem** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **2. HTTP** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **3. Browser** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **4. Database** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **5. CLI/Process** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **6. Multi-Step** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **7. Verify/Observe** | ✓ | N/A | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **8. Config/State** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Summary

| Failure Class | Capabilities Covered | Status | Gate |
|--------------|---------------------|--------|------|
| A: Selection | 8/8 | **STRONG** | Grounding gate |
| B: Mutation | 7/8 | **STRONG** | F9 syntax + staging |
| G: Convergence | 8/8 | **ELITE** | K5 constraint store |
| F: Observation | 8/8 | **STRONG** | Observation gate — reflow triggers, screenshot side effects, schema introspection artifacts, health probe overhead, config hot-reload, lazy initialization |
| C: State Assumption | 8/8 | **STRONG** | State gate — file existence, selector presence, schema/env/dep assumptions |
| D: Temporal | 8/8 | **STRONG** | Temporal gate — port mismatch, config divergence, rebuild triggers, cross-file references, migration ordering |
| E: Propagation | 8/8 | **STRONG** | Propagation gate — CSS orphans, route staleness, schema-query mismatch, env divergence, import paths |
| H: Access | 8/8 | **STRONG** | Access gate — path traversal, privileged ports, permission escalation, cross-origin, env escalation |
| I: Capacity | 8/8 | **STRONG** | Capacity gate — unbounded queries, missing pagination, memory accumulation, disk growth, connection exhaustion |
| J: Contention | 8/8 | **STRONG** | Contention gate — race conditions, shared mutable state, missing transactions, file locks, cache stampede |

**Current parity: 100% cell coverage (80/80 cells, 0 blind spots)**
**Strong cells: 80/80 | Partial cells: 0/80**
**Total scenarios: 18,391 (11,959 synthetic + 6,432 real-world) | Staged files: 115 (102 synthetic + 13 real-world) | Min depth: 30/file**
**Total gates: 26 (18 original + 7 cross-cutting failure class gates + hallucination)**

---

## Completed Cells (Phases 1–3)

### Cell 1: Temporal × Database (D×4)

**Why first:** Agents constantly run migrations then immediately query. The most common silent failure in agent-driven DB work.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| TD-01 | Connection pool serves stale schema after migration | Simulate: run DDL → query via pooled connection → get old column set. Requires timing between schema change and pool refresh. |
| TD-02 | Read-after-write returns old data (replication lag) | Simulate: INSERT → immediate SELECT → empty result. Requires async delay between write and read visibility. |
| TD-03 | Auto-increment not visible after migration | Simulate: CREATE TABLE with SERIAL → query nextval → get unexpected value. Requires sequence state timing. |

**Definition of Done:** Generator executes DDL, then queries with configurable delay, and asserts stale/fresh result based on timing.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (14 scenarios, 14 clean)

---

### Cell 2: Temporal × Browser (D×3)

**Why second:** DOM settlement failures cause the most false negatives in browser gate verification.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| TB-01 | DOM not settled when CSS evaluated | Simulate: page load → immediate getComputedStyle → UA default value instead of authored. Requires check-before-settle timing. |
| TB-02 | Async content not rendered at check time | Simulate: page with lazy-loaded component → check before load completes → element not found. Requires async boundary simulation. |
| TB-03 | CSS transition midpoint captured | Simulate: trigger transition → sample during animation → intermediate value. Requires mid-transition observation. |

**Definition of Done:** Generator starts browser, evaluates predicate at controlled timing offset, asserts timing-dependent result.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (12 scenarios, 12 clean)

---

### Cell 3: Temporal × Filesystem (D×1)

**Why third:** File edit → immediate check is the most basic agent pattern, and it fails on slow I/O.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| TF-01 | File written but not flushed when checked | Simulate: write file → immediate hash check → stale content. Requires write-without-flush timing. |
| TF-02 | Source edited but build artifact stale | Simulate: edit source.css → check dist/bundle.css → old content. Requires build pipeline delay. |
| TF-03 | Container volume mount not synced | Simulate: host edit → container read → old content. Requires mount propagation delay. |

**Definition of Done:** Generator performs write, then reads at controlled timing, asserts stale content detection.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (15 scenarios, 15 clean)

---

### Cell 4: Temporal × HTTP (D×2)

**Why fourth:** Server startup race is the #1 cause of staging failures in verify already.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| TH-01 | Server started but not accepting connections | Simulate: process started → immediate HTTP request → ECONNREFUSED. Requires startup delay simulation. |
| TH-02 | Response cached by proxy after deploy | Simulate: deploy new code → HTTP GET → stale cached response. Requires cache layer simulation. |

**Definition of Done:** Generator starts server process, sends request at controlled delay offset, asserts connection/staleness failure.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (14 scenarios, 14 clean)

---

### Cell 5: Temporal × CLI/Process (D×5)

**Why fifth:** Config reload failures are invisible — process appears healthy but running old behavior.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| TC-01 | Process restart not complete when checked | Simulate: send SIGTERM → immediate health check → connection refused or partial state. Requires restart timing. |
| TC-02 | Config change not picked up by running process | Simulate: edit config file → check process behavior → old config values used. Requires process-without-restart simulation. |

**Definition of Done:** Generator modifies config/restarts process, probes at controlled timing, asserts old-behavior detection.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (11 scenarios, 11 clean)

---

### Cell 6: Propagation × HTTP (E×2)

**Why sixth:** The DB→API→UI chain is where most multi-layer agent failures originate.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| PH-01 | DB schema changed but API returns old shape | Simulate: add column to DB → GET /api/items → response missing new field. Requires DB change + API layer that doesn't pick it up. |
| PH-02 | API contract changed but frontend not updated | Simulate: change API response structure → frontend renders → missing/wrong data. Requires cross-service chain. |
| PH-03 | Env var changed but process serves old config | Simulate: update .env → HTTP request → response reflects old value. Requires config-without-restart chain. |

**Definition of Done:** Generator performs upstream change, then verifies downstream consumer sees stale/mismatched data through the full chain.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (14 scenarios: 7 pure, 7 live)

---

### Cell 7: Propagation × Filesystem (E×1)

**Why seventh:** Source→build→artifact chain fails constantly with bundled apps.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| PF-01 | Source correct but build artifact differs | Simulate: edit config.json port → check .env/Dockerfile → old value. Cross-file propagation gap. |
| PF-02 | File edit doesn't trigger rebuild | Simulate: rename API route in server.js → nav link still references old route. Edit doesn't cascade to related references. |

**Definition of Done:** Generator edits source, checks downstream artifact/runtime, asserts propagation failure detection.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (15 scenarios, 15 pure)

---

### Cell 8: Propagation × Browser (E×3)

**Why eighth:** CSS↔JS coupling is a common agent blind spot.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| PB-01 | CSS class renamed but HTML still uses old name | Simulate: rename .nav-link → .menu-link in CSS → HTML class="nav-link" unmatched. CSS↔HTML cross-reference. |
| PB-02 | HTML structure changed but selectors target old structure | Simulate: change h1 to h2 → CSS/selector targeting h1 finds nothing. DOM+selector cross-reference. |
| PB-03 | API response changed but frontend renders stale state | Simulate: rename API item → homepage HTML still hardcodes old name. API→UI propagation gap. |

**Definition of Done:** Generator performs upstream change, then checks downstream behavioral impact through cross-surface chain.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (15 scenarios: 9 pure, 6 Playwright)

---

### Cell 9: State Assumption × Config (C×5, C×8)

**Why ninth:** Agents assume their target environment matches their mental model. It usually doesn't.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| SA-01 | Feature flag differs by environment — staging config enables features that prod disables (or vice versa) | Environment-split check: config.staging.json darkMode=true but config.prod.json darkMode=false. Agent grounded on staging, deploys to prod — wrong feature set. |
| SA-02 | Default value masks missing config — fallback silently produces degraded behavior | Remove config value, code fallback takes over: PORT removed from .env, || 3000 masks absence. SECRET_KEY removed, hardcoded default is insecure. |
| SA-03 | Config precedence unpredictable — same value in multiple sources, which wins? | Multi-source disagreement: port in config.json vs .env vs docker-compose vs server.js fallback. DB host in config.json vs DATABASE_URL in .env. |

**Definition of Done:** Generator creates environment divergence, then verifies predicate catches (or misses) the mismatch.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (23 scenarios: 8 SA-01, 6 SA-02, 9 SA-03)

---

### Cell 10: State Assumption × Database (C×4)

**Why tenth:** Agents assume the DB they're looking at is the one they're deploying to.

| Shape | Description | Generator Pattern |
|-------|------------|-------------------|
| SD-01 | Wrong database identity — grounding source and execution target disagree on which DB | Agent inspects one schema/config surface but the actual database is a different one. Not "stale cache" (temporal) — the agent is pointing at the WRONG DATABASE entirely. No amount of waiting resolves this. |
| SD-02 | Data assumed present — table exists (CREATE TABLE) but has zero rows (no INSERT) | Check init.sql for INSERT statements. Agent assumes schema existence implies data existence. |
| SD-03 | Migration targets wrong DB — config.json and .env disagree on database name/host/port | Change DB name in config.json, check .env DATABASE_URL — two truth sources for connection. |

**Definition of Done:** Generator creates state assumption mismatch, then verifies predicate catches the incorrect belief.

**Status:** ☑ Shapes defined ☑ Generator exists ☑ Scenario validated (20 scenarios: 6 SD-01, 7 SD-02, 7 SD-03)

### Phase 4: Access × Tier 1 (H×1, H×2, H×4, H×5) — 66 scenarios

**Key distinction:** Access failures are about PERMISSION, not BELIEF. The agent knows the right target but can't touch it.

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| H×1 Filesystem | HF-01 (permission denied), HF-02 (path traversal), HF-03 (ownership mismatch) | 18 | `stage-access-fs.ts` |
| H×2 HTTP | HH-01 (auth 401/403), HH-02 (CORS rejection), HH-03 (rate limit pre-denial) | 16 | `stage-access-http.ts` |
| H×4 Database | HD-01 (missing GRANT), HD-02 (connection denied), HD-03 (schema restriction) | 16 | `stage-access-db.ts` |
| H×5 CLI/Process | HC-01 (sudo required), HC-02 (Docker socket denied), HC-03 (SSH key rejected) | 16 | `stage-access-cli.ts` |

### Phase 4: Capacity × Tier 1 (I×1, I×2, I×4, I×5) — 64 scenarios

**Key distinction:** Capacity failures are about EXHAUSTION, not wrong target or wrong timing. The agent does the right thing but the environment can't accommodate it.

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| I×1 Filesystem | IF-01 (disk full/bloat), IF-02 (inode exhaustion), IF-03 (file size limits) | 17 | `stage-capacity-fs.ts` |
| I×2 HTTP | IH-01 (rate limit 429), IH-02 (connection pool exhaustion), IH-03 (payload too large) | 15 | `stage-capacity-http.ts` |
| I×4 Database | ID-01 (connection pool mismatch), ID-02 (max_connections hit), ID-03 (table bloat) | 15 | `stage-capacity-db.ts` |
| I×5 CLI/Process | IC-01 (OOM killed), IC-02 (PID limit), IC-03 (ulimit exhaustion) | 17 | `stage-capacity-cli.ts` |

### Phase 4: Contention × Tier 1 (J×1, J×4, J×5) — 51 scenarios

**Key distinction:** Contention failures are about COLLISION between concurrent actors. Two things trying to use the same resource at the same time.

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| J×1 Filesystem | JF-01 (concurrent edit), JF-02 (lock conflict), JF-03 (merge conflict) | 18 | `stage-contention-fs.ts` |
| J×4 Database | JD-01 (deadlock/conflicting constraints), JD-02 (concurrent migration), JD-03 (lock timeout) | 16 | `stage-contention-db.ts` |
| J×5 CLI/Process | JC-01 (port conflict), JC-02 (stale PID), JC-03 (container name conflict) | 17 | `stage-contention-cli.ts` |

---

## Phase 5: Full Parity (all 30 remaining cells filled)

All blind cells eliminated in a single sweep. Each cell has 3 shapes and 15-18 scenarios backed by a generator that simulates the actual failure mechanism.

### Temporal × remaining (D×6, D×7, D×8) — 49 scenarios

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| D×6 Multi-Step | DM-01 (step 2 reads step 1 before commit), DM-02 (webhook fires before operation completes), DM-03 (pipeline stage assumes prior stage finished) | 17 | `stage-temporal-multistep.ts` |
| D×7 Verify/Observe | DV-01 (evidence collected before deploy settles), DV-02 (screenshot taken during CSS transition), DV-03 (schema check before migration completes) | 16 | `stage-temporal-verify.ts` |
| D×8 Config/State | DC-01 (TTL expired credential used), DC-02 (config hot-reload not yet applied), DC-03 (feature flag cache stale) | 16 | `stage-temporal-config.ts` |

### Propagation × remaining (E×4, E×5, E×6, E×7, E×8) — 82 scenarios

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| E×4 Database | PD-01 (schema change not reflected in query), PD-02 (FK constraint blocks cascade), PD-03 (index not covering new column) | 16 | `stage-propagation-db.ts` |
| E×5 CLI/Process | PC-01 (build output not in deploy artifact), PC-02 (env var change not in restart), PC-03 (dependency update not in lockfile) | 17 | `stage-propagation-cli.ts` |
| E×6 Multi-Step | PM-01 (step 1 output format changed, step 2 parser stale), PM-02 (rollback doesn't cascade across steps), PM-03 (shared state modified by step N, step N+1 assumes original) | 16 | `stage-propagation-multistep.ts` |
| E×7 Verify/Observe | PV-01 (verification checks pre-transform state), PV-02 (observer reads cached not live state), PV-03 (probe result propagates stale value to dashboard) | 15 | `stage-propagation-verify.ts` |
| E×8 Config/State | PE-01 (env var updated but config.json still has old value), PE-02 (docker-compose env doesn't match .env), PE-03 (secrets manager updated but app reads cached value) | 18 | `stage-propagation-config.ts` |

### State Assumption × remaining (C×1, C×2, C×3, C×6) — 63 scenarios

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| C×1 Filesystem | SF-01 (wrong directory targeted), SF-02 (stale snapshot of file), SF-03 (symlink points to wrong location) | 16 | `stage-state-fs.ts` |
| C×2 HTTP | SH-01 (wrong endpoint assumed), SH-02 (response shape differs from assumption), SH-03 (base URL mismatch between environments) | 16 | `stage-state-http.ts` |
| C×3 Browser | SB-01 (wrong viewport size assumed), SB-02 (dark mode active when light assumed), SB-03 (user agent differs from assumed) | 15 | `stage-state-browser.ts` |
| C×6 Multi-Step | SM-01 (step 2 assumes step 1 output format), SM-02 (shared state modified between steps), SM-03 (step assumes clean environment but prior step left artifacts) | 16 | `stage-state-multistep.ts` |

### Observation × all (F×3, F×4, F×5, F×8) — 60 scenarios

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| F×3 Browser | FB-01 (getComputedStyle/offsetHeight forces reflow), FB-02 (screenshot triggers lazy-load/repaint), FB-03 (scrollIntoView/focus changes visual state) | 15 | `stage-observation-browser.ts` |
| F×4 Database | FD-01 (schema introspection artifacts), FD-02 (SELECT side effects via triggers), FD-03 (connection count inflation) | 15 | `stage-observation-db.ts` |
| F×5 CLI/Process | FC-01 (health probe overhead/restart), FC-02 (log read triggers rotation), FC-03 (disk measurement inflation) | 15 | `stage-observation-cli.ts` |
| F×8 Config/State | FG-01 (config read triggers hot-reload via mtime), FG-02 (env var read triggers lazy init), FG-03 (secret access logs audit trail) | 15 | `stage-observation-config.ts` |

### Access × remaining (H×3, H×6, H×7, H×8) — 61 scenarios

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| H×3 Browser | HB-01 (CSP blocks inline script), HB-02 (CORS blocks cross-origin fetch), HB-03 (iframe sandbox restricts navigation) | 16 | `stage-access-browser.ts` |
| H×6 Multi-Step | HM-01 (step 1 runs as user, step 2 needs admin), HM-02 (step 1 reads table, step 2 needs DDL privilege), HM-03 (config edit needs root, predicate check needs restart privilege) | 15 | `stage-access-multistep.ts` |
| H×7 Verify/Observe | HV-01 (health endpoint gated behind auth), HV-02 (metrics port not exposed), HV-03 (schema introspection needs elevated DB role) | 15 | `stage-access-verify.ts` |
| H×8 Config/State | HK-01 (.env file restricted permissions), HK-02 (secrets manager ACL denies read), HK-03 (KMS key policy blocks decrypt) | 15 | `stage-access-config.ts` |

### Capacity × remaining (I×3, I×6, I×7, I×8) — 60 scenarios

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| I×3 Browser | IB-01 (DOM node limit exceeded), IB-02 (localStorage quota full), IB-03 (browser memory limit reached) | 15 | `stage-capacity-browser.ts` |
| I×6 Multi-Step | IM-01 (cumulative timeout budget exceeded), IM-02 (resource leak across steps), IM-03 (parallel step fan-out hits connection limit) | 15 | `stage-capacity-multistep.ts` |
| I×7 Verify/Observe | IV-01 (log volume overwhelms parser), IV-02 (metrics cardinality explosion), IV-03 (snapshot size exceeds storage quota) | 15 | `stage-capacity-verify.ts` |
| I×8 Config/State | IK-01 (.env exceeds shell arg limit), IK-02 (config file exceeds parser buffer), IK-03 (secrets count exceeds provider quota) | 15 | `stage-capacity-config.ts` |

### Contention × remaining (J×2, J×3, J×6, J×7, J×8) — 87 scenarios

| Cell | Shapes | Scenarios | Generator |
|------|--------|-----------|-----------|
| J×2 HTTP | JH-01 (concurrent deploys to same endpoint), JH-02 (session collision from parallel requests), JH-03 (API version conflict between concurrent consumers) | 17 | `stage-contention-http.ts` |
| J×3 Browser | JB-01 (two tests sharing browser instance), JB-02 (shared cookie jar conflict), JB-03 (concurrent localStorage writes) | 17 | `stage-contention-browser.ts` |
| J×6 Multi-Step | JM-01 (workflow A step 2 conflicts with workflow B step 1), JM-02 (shared temp directory collision), JM-03 (concurrent pipeline writes to same artifact) | 18 | `stage-contention-multistep.ts` |
| J×7 Verify/Observe | JV-01 (two verifiers read conflicting snapshots), JV-02 (verification reads during concurrent write), JV-03 (observer and mutator race on same resource) | 17 | `stage-contention-verify.ts` |
| J×8 Config/State | JK-01 (two processes write .env simultaneously), JK-02 (concurrent config merge conflict), JK-03 (feature flag toggle during read) | 18 | `stage-contention-config.ts` |

---

## Definition of Done (per shape)

A shape counts toward parity when ALL of the following are true:

1. **Shape defined** — Named, described, mapped to grid cell
2. **Generator exists** — Produces scenario(s) that simulate real failure mechanics
3. **Generator simulates reality** — Temporal shapes use timing/delay. Propagation shapes use multi-surface chains. State shapes use environment divergence. Access shapes use permission denial. Capacity shapes use resource exhaustion. Contention shapes use concurrent actors. Static mocks do NOT count for D/E/C/H/I/J cells.
4. **Scenario validated** — Self-test runner executes scenario, asserts correct verdict
5. **Gate wired** — Existing gate(s) can detect the failure (or new gate identified if needed)

---

## The Rule

> Every new shape must answer: **Which capability × failure class cell does this fill?**
>
> If it doesn't fill a blind cell → don't add it.
>
> If the generator doesn't simulate the actual failure mechanism → it doesn't count.

---

## Phase 6: Cross-Cutting Gate Depth

Six new gates added to the pipeline, each covering a failure CLASS across all 8 capabilities.
These gates run after G5 (containment) and before the domain-specific gates (filesystem, infrastructure, etc.).

### Pipeline Position

```
Grounding → F9 → K5 → G5 →
  Access → Temporal → Propagation → State → Capacity → Contention → Observation →
  Filesystem → Infrastructure → Serialization → Config → Security → A11y → Performance →
  [Staging → Browser → HTTP → Invariants] → Vision → Triangulation → Narrowing
```

### Gate: Access (`src/gates/access.ts`)

Detects privilege boundary violations across all capability surfaces.

| Detector | Severity | What It Catches |
|----------|----------|-----------------|
| path_traversal | error | `../`, `/etc/`, `/proc/`, system path references in edits |
| privileged_port | warning | Ports below 1024 |
| permission_escalation | error/warning | `sudo`, `chown`, `chmod 777`, Docker socket, `--privileged`, `USER root` |
| cross_origin | warning | CORS wildcards (`Access-Control-Allow-Origin: *`) |
| environment_escalation | error/warning | Production credentials in non-production configs |

### Gate: Temporal (`src/gates/temporal.ts`)

Detects cross-file staleness — when an edit changes one surface but leaves dependent surfaces stale.

| Detector | Severity | What It Catches |
|----------|----------|-----------------|
| port_mismatch | error | PORT in source disagrees with Dockerfile EXPOSE or compose mapping (only when both files edited) |
| config_divergence | warning | Env var changed but hardcoded default in source still references old value |
| missing_rebuild | error | Dependency file (package.json, requirements.txt) changed without Docker build trigger |
| cross_file_reference | warning | Renamed identifier still referenced by old name in other files |
| migration_ordering | error | Migration references table from nonexistent prior migration |

### Gate: Propagation (`src/gates/propagation.ts`)

Detects cascade breaks — when a change doesn't propagate across all dependent layers.

| Detector | Severity | What It Catches |
|----------|----------|-----------------|
| css_class_orphan | error | CSS class renamed/removed in stylesheet but still referenced in HTML/JS |
| route_staleness | warning | Route path changed in server but stale reference in client/links |
| schema_query_mismatch | error | Column/table renamed in schema but old name used in queries |
| env_key_divergence | warning | Env var renamed in .env but old key referenced in source |
| import_path_broken | error | File renamed but old import path still used elsewhere |

### Gate: State (`src/gates/state.ts`)

Detects false assumptions about the current state of reality.

| Detector | Severity | What It Catches |
|----------|----------|-----------------|
| file_existence | error | Edit targets a file that doesn't exist in stageDir |
| selector_presence | warning | CSS predicate references a selector not present in source files |
| schema_assumption | warning | SQL references tables not defined in schema/migration files |
| env_assumption | warning | Code references `process.env.VAR` not defined in any .env file |
| dependency_assumption | warning | `require()`/`import` references module not in package.json |

### Gate: Capacity (`src/gates/capacity.ts`)

Detects patterns that would exhaust system resources under load.

| Detector | Severity | What It Catches |
|----------|----------|-----------------|
| unbounded_query | error | `SELECT * FROM` without LIMIT/TOP/FETCH FIRST |
| missing_pagination | warning | Route handler returns DB results without pagination |
| memory_accumulation | warning | Global arrays/maps growing without bounds |
| disk_growth | warning | File writes in loops/intervals without rotation |
| connection_exhaustion | warning | DB/Redis connections opened per-request without release |

### Gate: Contention (`src/gates/contention.ts`)

Detects race conditions and resource conflicts under concurrent access.

| Detector | Severity | What It Catches |
|----------|----------|-----------------|
| race_condition | error | Read-modify-write without atomicity (transaction/lock/mutex) |
| shared_mutable_state | warning | Module-level mutable state modified in request handlers |
| missing_transaction | error | Multiple related SQL statements without transaction wrapping |
| file_lock_absent | warning | File read+write on same path without locking |
| cache_stampede | warning | Cache miss → expensive fallback without stampede protection |

### Gate: Observation (`src/gates/observation.ts`)

Detects observer effects — when the act of VERIFYING or OBSERVING changes the system being observed. **Advisory gate** — always passes, reports effects for transparency.

| Detector | Domain | What It Catches |
|----------|--------|-----------------|
| browser_observation | Browser | `getComputedStyle`, `getBoundingClientRect`, `scrollIntoView`, `offsetWidth/Height`, `IntersectionObserver`, `MutationObserver`, `ResizeObserver`, screenshot capture |
| database_observation | Database | `pg_stat_statements`, `EXPLAIN ANALYZE`, `information_schema` queries, `SELECT FOR UPDATE/SHARE`, triggers on SELECT, `pg_stat_activity`, advisory locks |
| cli_observation | CLI/Process | HEALTHCHECK with restart, `docker stats`, `wget/curl` health probes, temp file creation, `systemctl status`, `journalctl` rotation, `df/du` measurement, log read-and-clear |
| config_observation | Config | `fs.watch`/`chokidar` on config files, env var with fallback chains, `dotenv.config()`, secret access audit, config version bumps, feature flag analytics, HMR, auto-reload |
| cross_source_mismatch | All | File A declares a side-effect (e.g., trigger, watcher) but file B being checked has no awareness of that side effect |

---

## Metrics

| Metric | v0.5.2 (Phase 3) | v0.6.0 (Phase 5) | v0.6.1 (Phase 6) | v0.6.2 (Phase 7) | **Current** | Change |
|--------|------------------|-------------------|-------------------|-------------------|-------------|--------|
| Strong cells | 23/80 | 23/80 | 76/80 | 80/80 | **80/80** | — |
| Partial cells | 16/80 | 57/80 | 4/80 | 0/80 | **0/80** | — |
| Blind cells | 41/80 | 0/80 | 0/80 | 0/80 | **0/80** | — |
| Cell coverage | 49% | 100% | 100% | 100% | **100%** | — |
| Total gates | 18 | 18 | 24 | 25 | **25** | — |
| Staged scenario files | 21 | 68 | 68 | 69 | **70** | +1 |
| Scenarios (staged) | ~1,794 | 2,422 | 2,422 | 2,437 | **9,875** | +7,438 |
| Non-WPT staged | — | — | — | ~1,776 | **2,584** | +808 |
| Min depth (non-WPT) | — | — | — | 6 | **30** | +24 |
| Generators + bolsters | 21 | 68 | 68 | 69 | **73** | +4 |

### Operation Bolster (March 27, 2026)

Systematic depth expansion: every non-WPT staged fixture file brought to 30+ scenarios minimum.

**Before:** 70 non-WPT files ranged from 6 to 174 scenarios. 26 files had ≤15 ("thin"), 34 had 16-29 ("adequate"). Non-WPT total: 1,776.

**After:** All 70 non-WPT files at exactly 30+ scenarios. Non-WPT total: 2,584 (+808 scenarios, +46%).

**Method:**
- `scripts/harvest/bolster-thin.ts` — Deep custom expansion for 26 thinnest files. 8 domain-specific bolster functions (temporal, propagation, state, access, capacity, contention, observation families) + generic grid expander. New shape families: TC-06 (runtime config), TB-07 (CSS specificity), TH-06 (error handling), TD-07 (foreign keys), PH-07 (template/API gap), PERF-SINGLE (edge cases).
- `scripts/harvest/bolster-adequate.ts` — Family-specific + generic expansion for 34 adequate-tier files. 5 family-specific bolsters + 15 cross-file consistency templates + 22 edit-based inconsistency templates.
- Both scripts are idempotent: `loadFixture()` strips prior `-bolster-` IDs before regenerating. Safe to re-run.

**Verification:** 346 tests, 21,322 assertions, 0 failures after bolstering.

---

## Relationship to FAILURE-TAXONOMY.md

**PARITY-GRID.md** (this file) is the **map of reality** — defines what must be covered.

**FAILURE-TAXONOMY.md** is the **dictionary** — defines individual shapes, their status, and technical details.

Every shape in FAILURE-TAXONOMY.md should reference its grid cell. Every grid cell should reference its shapes in FAILURE-TAXONOMY.md. The grid drives priorities; the taxonomy provides depth.
