# @sovereign-labs/verify

**Your agent just got better.**

26 gates check your agent's work. On failure, it learns what went wrong and doesn't repeat it. On success, you have proof it worked.

Works with any agent. Coding agents, file system agents, infrastructure agents, or your own.

## What it does

```typescript
import { verify } from '@sovereign-labs/verify';

const result = await verify(edits, predicates, { appDir: './my-app' });
// result.success → true/false
// result.attestation → human-readable summary
// result.narrowing → what to try next (on failure)
```

Your agent says "change the color to red." Verify checks:

1. **Can the edit be applied?** Does the search string exist in the file?
2. **Is the edit safe?** No XSS, no SQL injection, no leaked secrets, no broken accessibility.
3. **Did the edit work?** CSS selector has the right value. HTTP endpoint returns 200. Database column exists.
4. **Did the edit break anything else?** Health checks pass. File integrity holds. Config is consistent.

26 checks run in sequence. First failure stops the pipeline and tells you exactly what went wrong.

On **failure**: returns the problem + what to try next.
On **repeat failure**: learns from mistakes — attempt N+1 won't repeat attempt N's error.

## Multi-agent

Multiple agents editing the same codebase? Verify them in sequence — each agent sees the filesystem the previous agent left behind.

```typescript
import { verifyBatch } from '@sovereign-labs/verify';

const result = await verifyBatch([
  { agent: 'planner', edits: [...], predicates: [...] },
  { agent: 'coder', edits: [...], predicates: [...] },
], { appDir: './my-app', stopOnFailure: true });

// result.success → all agents passed
// result.agentResults[0].agent → 'planner'
// result.agentResults[1].result.success → false if coder's edits conflict
```

If Agent A changes a file and Agent B tries to edit the same region, the syntax gate catches the conflict. If Agent A's changes invalidate Agent B's predicates, the grounding gate catches it. No new infrastructure — the existing 26 gates handle multi-agent conflicts naturally.

## Beyond code edits

The checks are domain-agnostic. Today it verifies code edits, but the same pipeline works for:
- **File system agents** — move, rename, organize files
- **Infrastructure agents** — don't delete the production database
- **Communication agents** — message the right channel, no forbidden content
- **Document agents** — don't overwrite the wrong cells

**Built-in checks:** CSS, HTML, content patterns, HTTP endpoints, database schema, file existence, infrastructure state, JSON structure, config values, security scans, accessibility, performance budgets, hallucination detection, and more.

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
  // VERIFY PASSED
  // Gates: F9✓ K5✓ G5✓ Staging✓ Browser✓ HTTP✓
} else {
  console.log(result.narrowing);
  // { resolutionHint: "...", constraints: [...], bannedFingerprints: [...] }
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
      // context.grounding: CSS, HTML, routes, DB schema — the app's ground truth
      // context.narrowing: what failed last time and why
      // context.failureShapes: taxonomy IDs (e.g., 'C-05', 'F9-02')
      // context.convergence: is the loop making progress?

      return {
        edits: [{ file: 'style.css', search: 'blue', replace: 'orange' }],
        predicates: [{ type: 'css', selector: '.btn', property: 'color', expected: 'orange' }],
      };
    },
  },

  // Optional: human approval before each verify() run
  onApproval: async (plan, context) => {
    console.log(`Attempt ${context.attempt}: ${plan.edits.length} edits`);
    return true; // false to abort
  },

  // Optional: observe progress without blocking
  onAttempt: (attempt, result) => {
    console.log(`Attempt ${attempt}: ${result.success ? 'PASS' : 'FAIL'}`);
  },
});

if (result.success) {
  console.log(`Converged in ${result.attempts} attempt(s)`);
  console.log(result.receipt.attestation);
} else {
  console.log(`Stopped: ${result.stopReason}`);
  // 'exhausted' — all attempts used, was making progress
  // 'stuck' — shape repetition or gate cycles detected
  // 'empty_plan_stall' — agent returned empty edits 3x
  // 'approval_aborted' — human rejected the plan
}
```

**Three exit paths:**
- **converged** — goal succeeded, edits verified
- **exhausted** — max attempts used but was making progress (more attempts might help)
- **stuck** — loop detected no progress (same shapes repeating, same gates failing, constraints growing but not helping)

**What the agent sees on retry** (`GovernContext`):
- `grounding` — CSS rules, HTML elements, routes, DB schema from the app
- `priorResult` — the previous `verify()` result (gates, narrowing, attestation)
- `narrowing` — resolution hints, banned fingerprints, pattern recall
- `failureShapes` — taxonomy shape IDs from `decomposeFailure()` (e.g., `C-05: named color vs computed RGB`)
- `constraints` — active K5 constraints (what's banned and why)
- `convergence` — shape progression, gate progression, empty plan count, progress summary

**Convergence detection** (ported from Sovereign's battle-tested agent loop):
- Shape repetition — same failure shapes across attempts means no new information
- Gate cycles — same gates failing the same way
- Empty plan stall — agent returning 0 edits repeatedly
- Constraint saturation — constraints growing but shapes unchanged (narrowing isn't helping)

**Fault ledger:** Every failure is automatically recorded to `.verify/faults.jsonl`. Unclassified failures (where the taxonomy has no matching shape) are flagged on `result.receipt.unclassifiedFailures`. Run `npx @sovereign-labs/verify faults` to inspect gaps.

### 3. As a CLI

```bash
# Initialize config
npx @sovereign-labs/verify init

# Run verification from a spec file
npx @sovereign-labs/verify check

# Pipe git diff directly
git diff | npx @sovereign-labs/verify check --diff

# Scan grounding context (what CSS/HTML/routes exist)
npx @sovereign-labs/verify ground

# Check Docker + Playwright availability
npx @sovereign-labs/verify doctor
```

### 4. As an MCP server

Add to your agent's MCP config:

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

16 tools exposed across 4 categories:

- `verify_ground` — Scan app for CSS rules, HTML elements, routes, schema
- `verify_read` — Read a source file
- `verify_submit` — Submit edits + predicates through the full gate pipeline

## Full Documentation

- **[REFERENCE.md](REFERENCE.md)** — Gates, predicates, configuration, CLI, fault management, scenario authoring
- **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)** — System architecture, the 8-stage autonomous loop, design decisions
- **[GLOSSARY.md](GLOSSARY.md)** — Terms and definitions


## License

MIT
