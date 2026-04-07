# @sovereign-labs/verify

[![npm](https://img.shields.io/npm/v/@sovereign-labs/verify)](https://www.npmjs.com/package/@sovereign-labs/verify)
[![GitHub Action](https://img.shields.io/badge/GitHub%20Action-Born14%2Fverify-blue)](https://github.com/Born14/verify)

**Your agent says "done." But do you know *how* it fails?**

Not whether it fails. *How.*

`verify()` runs your agent's edits against filesystem reality and tells you what the agent got wrong — the file, the line, the expected value, the actual value. No LLM in the verification path. The answer is not "probably."

Over time, these measurements accumulate into a reliability profile: how *this* agent fails on *this* codebase. What it hallucinates. Where it drops edits. Which patterns it repeats.

No other tool builds this model. Linters know your code has problems. Tests know your code produces wrong output. **Verify knows why the agent was wrong.**

**Using verify? We'd love to hear what you're building.** [Join the discussion](https://github.com/Born14/verify/discussions/40)

## See it in action

```bash
npx @sovereign-labs/verify demo
```

Three failure modes your current stack misses:

### The Agent Said Done

The agent claims it saved a file. It didn't. Verify checks the filesystem.

```
Without verify:
  Agent says: "Report saved successfully."
  $ ls reports/weekly.md
  ls: cannot access 'reports/weekly.md': No such file or directory

With verify:
  Trace 1: Agent claims completion without creating the file.
  [FAIL] Filesystem gate: reports/weekly.md does not exist.
  Trace 2: Injecting constraints and re-running. Agent creates the file.
  [PASS] All gates passed (12 checks)
```

### Wrong World Model

The agent writes valid CSS targeting a selector that doesn't exist. Verify knows what's actually in your code.

```
Without verify:
  $ grep '.profile-nav' server.js     # CSS rule exists
  $ grep -c 'class="profile-nav"'     # 0 — element doesn't exist

With verify:
  Trace 1: Agent uses selector .profile-nav
  [FAIL] Grounding: .profile-nav does not exist in source
  Trace 2: Agent uses a.nav-link — exists in reality.
  [PASS] All gates passed (12 checks)
```

### The Silent Drift

The agent completed the task. But it also quietly changed your config. Verify catches the undeclared mutation.

```
Without verify:
  $ diff config.json.orig config.json
  - "darkMode": true
  + "darkMode": false
  - "analytics": false
  + "analytics": true

With verify:
  Trace 1: Agent edits server.js and config.json.
  [FAIL] Containment: 2 undeclared file mutations detected
  Trace 2: Agent edits server.js only.
  [PASS] All gates passed (11 checks)
```

Run all three: `npx @sovereign-labs/verify demo --scenario=liar|world|drift`

## What it does

```typescript
import { verify } from '@sovereign-labs/verify';

const result = await verify(edits, predicates, { appDir: './my-app' });
// result.success → true/false
// result.attestation → human-readable summary
// result.narrowing → what to try next (on failure)
```

26 checks run in sequence. First failure stops the pipeline and tells you exactly what went wrong.

1. **Can the edit be applied?** Does the search string exist in the file?
2. **Is the edit safe?** No XSS, no SQL injection, no leaked secrets, no broken accessibility.
3. **Did the edit work?** CSS selector has the right value. HTTP endpoint returns 200. Database column exists. File was created.
4. **Did the edit break anything else?** Health checks pass. File integrity holds. Config is consistent.

On **failure**: returns the problem + what to try next.
On **repeat failure**: learns from mistakes — attempt N+1 won't repeat attempt N's error.

## Install

```bash
npm install @sovereign-labs/verify
# or
bun add @sovereign-labs/verify
```

## Quick Start

### 1. As a library

```typescript
import { verify } from '@sovereign-labs/verify';

const result = await verify(
  // Edits: search-and-replace mutations
  [
    { file: 'server.js', search: 'color: blue', replace: 'color: red' },
    { file: 'server.js', search: 'Hello', replace: 'Welcome' },
  ],
  // Predicates: what should be true after the edits
  [
    { type: 'css', selector: 'h1', property: 'color', expected: 'red' },
    { type: 'content', file: 'server.js', pattern: 'Welcome' },
    { type: 'http', path: '/health', method: 'GET', expect: { status: 200 } },
  ],
  // Config
  { appDir: './my-app' }
);

if (result.success) {
  console.log(result.attestation);
} else {
  console.log(result.narrowing.resolutionHint);
}
```

### 2. Convergence loop — `govern()`

`verify()` is a single pass. `govern()` wraps it in a convergence loop — ground reality, plan, verify, narrow, retry. The agent learns from every failure.

```typescript
import { govern } from '@sovereign-labs/verify';

const result = await govern({
  appDir: './my-app',
  goal: 'Change the button color to orange',
  maxAttempts: 3,

  // Your agent — one method: plan
  agent: {
    plan: async (goal, context) => {
      // context.grounding — CSS, HTML, routes, DB schema
      // context.narrowing — what failed last time and why
      // context.constraints — what's banned and why (K5)

      return {
        edits: [{ file: 'style.css', search: 'blue', replace: 'orange' }],
        predicates: [{ type: 'css', selector: '.btn', property: 'color', expected: 'orange' }],
      };
    },
  },
});

if (result.success) {
  console.log(`Converged in ${result.attempts} attempt(s)`);
} else {
  console.log(`Stopped: ${result.stopReason}`);
  // 'exhausted' | 'stuck' | 'empty_plan_stall' | 'approval_aborted'
}
```

### 3. As a CLI

```bash
npx @sovereign-labs/verify init          # Create .verify/check.json
npx @sovereign-labs/verify check         # Run verification
npx @sovereign-labs/verify demo          # See what it catches
npx @sovereign-labs/verify ground        # Scan CSS/HTML/routes
npx @sovereign-labs/verify self-test     # Run 2,800+ scenario harness
git diff | npx @sovereign-labs/verify check --diff   # Pipe git diff
```

### 4. As an MCP server

```json
{
  "mcpServers": {
    "verify": {
      "command": "npx",
      "args": ["@sovereign-labs/verify", "mcp"]
    }
  }
}
```

Tools: `verify_ground`, `verify_read`, `verify_submit`

## Multi-agent

Multiple agents editing the same codebase? Verify them in sequence — each agent sees the filesystem the previous agent left behind.

```typescript
import { verifyBatch } from '@sovereign-labs/verify';

const result = await verifyBatch([
  { agent: 'planner', edits: [...], predicates: [...] },
  { agent: 'coder', edits: [...], predicates: [...] },
], { appDir: './my-app', stopOnFailure: true });
```

If Agent A's changes invalidate Agent B's predicates, the grounding gate catches it. No new infrastructure — the existing gates handle multi-agent conflicts naturally.

## Beyond code edits

The checks are domain-agnostic:
- **File system agents** — move, rename, organize files
- **Infrastructure agents** — don't delete the production database
- **Communication agents** — message the right channel, no forbidden content
- **Document agents** — don't overwrite the wrong cells

## Real-world validation: 33,056 agent PRs scanned

We scanned every PR in the [AIDev-POP dataset](https://huggingface.co/datasets/hao-li/AIDev) — 33,056 real pull requests from 5 AI coding agents across 2,807 popular open-source repos. Deterministic pipeline, $0 cost, no LLM calls.

**High-confidence structural finding rates:**

| Agent | PRs | Finding Rate | Top Issue |
|-------|-----|-------------|-----------|
| Devin | 4,800 | 8.2% | Unbounded queries |
| Claude Code | 457 | 8.5% | Path/permission |
| Copilot | 4,496 | 4.8% | Path/permission |
| Cursor | 1,539 | 4.4% | Unbounded queries |
| Codex | 21,764 | 1.9% | Unbounded queries |

3.4% of all agent PRs have high-confidence structural issues that existing CI doesn't catch. See [METHODOLOGY.md](METHODOLOGY.md) for full details.

## GitHub Action

```yaml
- uses: Born14/verify@v0.8.2
```

Runs verify on every PR. Posts gate results as a comment. Three modes:
- **Structural** (default, free) — diff-only analysis, no API key needed
- **Intent** — extracts predicates from PR title/description (Gemini, OpenAI, or Anthropic)
- **Staging** — Docker build + runtime verification

## Full Documentation

- **[FAILURE-TAXONOMY.md](FAILURE-TAXONOMY.md)** — 675+ failure shapes across 30 domains. The classification of how agents fail.
- **[REFERENCE.md](REFERENCE.md)** — Gates, predicates, configuration, CLI, fault management
- **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)** — Architecture, the 8-stage autonomous loop
- **[METHODOLOGY.md](METHODOLOGY.md)** — AIDev-POP scan methodology and reproducibility
- **[PARITY-GRID.md](PARITY-GRID.md)** — 8×10 capability × failure class coverage matrix
- **[ASSESSMENT.md](ASSESSMENT.md)** — What verify is and isn't
- **[ROADMAP.md](ROADMAP.md)** — Current state and priorities
- **[GLOSSARY.md](GLOSSARY.md)** — Terms and definitions

## License

MIT
