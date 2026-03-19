# Verify Improvement Playbook

How verify gets smarter over time. The mental model, the pipeline, the daily rhythm.

## The One-Liner

Verify makes agents converge faster by learning from their mistakes. The constraints file is the product. The improve loop is the factory. Campaigns are the fuel.

## The Two Circles

Verify has two concentric loops that never mix during runtime.

### Outer Circle: Real-World Usage (Campaigns)

This is where agents run real tasks against real apps through verify's gates.

- An agent (Cursor, Aider, Claude Code, Sovereign, or a custom agent) proposes edits
- `verify()` gates every edit (F9 -> K5 -> G5 -> Staging -> Browser -> HTTP)
- On failure: narrowing hints tell the agent what to try next
- On repeated failure: K5 blocks known-bad patterns automatically
- Each attempt shrinks the solution space until the agent converges or exhausts

The "intelligence" here is the agent's LLM. It's creative, unpredictable, sometimes wrong. Verify doesn't care which model it is. It just gates the output.

### Inner Circle: Self-Hardening (The Improve Loop)

This is verify's own quality assurance system. It runs offline, after failures have been collected.

- 56+ deterministic scenarios test verify's behavior against known invariants
- When a scenario is dirty (verify violates an invariant), the loop proposes fixes
- Fixes are validated in subprocess isolation with holdout protection
- Human reviews and applies accepted patches

The loop is mostly deterministic. The only LLM call is for fix-candidate generation when the deterministic triage can't map the bug to an exact function.

### The Key Separation

The outer circle discovers problems in the real world.
The inner circle turns those problems into permanent improvements to verify.
They never run at the same time. Failures are just data (JSONL) that flows between them.

## What Makes This Recursive Self-Improvement

The output of the system improves the system itself:

```
verify gates code -> failures reveal verify bugs -> loop fixes verify -> verify gates better
```

This is structurally recursive. But it has hard limits that prevent runaway:

- **Frozen constitution** - the harness, oracle, and scenarios never change by the loop
- **Bounded surface** - the loop can only edit 7 source files, never its own tests
- **Human veto** - accepted patches are printed, not auto-applied
- **Subprocess isolation** - candidates validated in a copy, never the live codebase
- **Holdout protection** - 30% of clean scenarios catch overfitting

The loop is demand-driven, not continuous. No dirty scenarios = nothing to fix. It runs when there's real signal to learn from.

## The Three Tiers (How Users Benefit)

### Tier 1: Local Learning (Free, Automatic)
Every `verify()` call that fails creates a constraint in `.verify/constraints.json`. The next attempt is automatically smarter because K5 blocks the pattern that just failed. This happens inside a single session with zero config.

### Tier 2: Team Learning (Free, Commit the File)
`git commit .verify/constraints.json` shares one project's learning with the whole team. New developer clones the repo, their agent already knows what doesn't work. The file contains failure patterns, not secrets.

### Tier 3: Universal Feed (Paid, Future)
Curated constraints from nightly loop runs across many apps. A fresh install starts with 500+ constraints instead of zero. The pitch: "Your agent's first attempt is as smart as everyone's hundredth."

## Why This Matters for the Industry

2025 was the speed year (agents write code fast). 2026 is the quality year (agents need to write code *correctly*).

Every agent today is stateless. Every attempt starts from zero. Verify gives every agent a memory - not an LLM memory that hallucinates, but a deterministic memory that mechanically blocks known-bad patterns.

A mediocre model behind a thick constraint layer outperforms a frontier model with no constraints. Intelligence without memory repeats mistakes. Memory without intelligence prevents them.

Over enough time, the constraint set becomes so comprehensive that the only moves left are correct ones. From the outside, an agent that never fails is indistinguishable from one that's infinitely smart.

## The Fault Ledger (The Bridge)

The fault ledger (`src/store/fault-ledger.ts`) bridges the two circles. It captures real-world gate faults and tracks them from discovery to encoding.

### Entry Flow

```
Campaign runs -> verify produces result + cross-check probes run
    |
    v
FaultLedger.recordFromResult(result, { app, goal, crossCheck })
    |
    v  (auto-classifies)
.verify/faults.jsonl
```

### Auto-Classification Rules

When verify says PASS:
- Health probe returns 500 -> `false_positive` (high confidence)
- Browser probe fails -> `false_positive` (high confidence)
- All probes pass -> `correct` (high confidence)

When verify says FAIL:
- All cross-check probes pass -> `false_negative` (medium confidence)
- Cross-check probes also fail -> `agent_fault` (high confidence)

Internal contradictions (success but gate failed, all gates passed but success is false) are always verify bugs regardless of probe results.

No cross-check evidence -> `ambiguous` (low confidence, needs human review)

### Fault Classifications

| Classification | Meaning | Action |
|---------------|---------|--------|
| `false_positive` | Verify said PASS but app is broken | Encode as scenario |
| `false_negative` | Verify said FAIL but edit was correct | Encode as scenario |
| `bad_hint` | Narrowing sent agent in wrong direction | Encode as scenario |
| `correct` | Verify judged correctly | No action needed |
| `agent_fault` | Agent was wrong, verify was right | No action needed |
| `ambiguous` | Can't determine automatically | Human reviews |

### CLI Commands

```bash
npx @sovereign-labs/verify faults inbox      # Unencoded verify bugs (the morning inbox)
npx @sovereign-labs/verify faults review     # Ambiguous entries needing human eyes
npx @sovereign-labs/verify faults summary    # Statistics overview
npx @sovereign-labs/verify faults list       # All entries (--filter=X, --app=X)
npx @sovereign-labs/verify faults log        # Manual entry (--app, --goal, --class, --reason)
npx @sovereign-labs/verify faults classify   # Override classification (<id> --class=X --reason=Y)
npx @sovereign-labs/verify faults link       # Connect fault to scenario (<id> --scenario=A11)
```

## The Daily Rhythm

### Evening: Chaos Runs

Campaigns fire diverse goals through verify's gates. Goals can be:
- Manual (you submit through sovereign_submit)
- Automated (chaos engine generates goals from grounding context)
- Real usage (end users running verify on their projects)

Every outcome is auto-logged to the fault ledger with cross-check probes.

### Morning: Triage + Encode

```bash
# 1. Check the inbox (~2 minutes)
npx @sovereign-labs/verify faults inbox

# 2. Review ambiguous entries (~3 minutes)
npx @sovereign-labs/verify faults review
npx @sovereign-labs/verify faults classify <id> --class=agent_fault --reason="K5 was right"

# 3. Encode verify bugs as scenarios (~15-30 min, or paste inbox to Claude)
#    Write scenarios in scenario-generator.ts
npx @sovereign-labs/verify faults link <id> --scenario=C8

# 4. Run self-test — new scenarios should be dirty (~2 seconds)
npx @sovereign-labs/verify self-test

# 5. Run improve — loop proposes fixes (~3 minutes)
bun run packages/verify/scripts/self-test.ts --improve --llm=gemini --api-key=$KEY

# 6. Review patches, apply good ones, re-run self-test
npx @sovereign-labs/verify self-test   # should be all clean now
```

### What Accelerates Failure Discovery

The bottleneck is always discovery, not fixing. Three levers:

1. **More goals per night** - Nightly campaign with 10-20 diverse goals. Cost: ~$0.50-2.00/night on Gemini.
2. **More apps** - Different architectures stress different gates. Use GitHub import to bring in React, Python, multi-service apps.
3. **Adversarial goals** - Deliberately probe gate boundaries: CSS with !important, 15-file edits, unicode selectors, 10-step HTTP sequences.

### The Chaos Engine (Future)

A push-button goal generator in the Sovereign platform:
1. Reads grounding context for each app (routes, CSS, HTML, schema)
2. LLM generates 10-20 diverse goals with target predicates
3. Fires them as a campaign
4. Morning report: X passed, Y failed (agent fault), Z failed (gate fault)
5. Gate faults auto-logged to fault ledger

The diversity of target apps matters as much as goal diversity. A chaos engine firing creative goals against one app will eventually plateau. The same engine against 20 different apps surfaces new failure classes for much longer.

## The Pipeline (Complete)

```
Chaos Engine (generates diverse goals)
    |
Sovereign Campaign (fires via sovereign_submit)
    |
Verify Gates (F9 -> K5 -> G5 -> Staging -> Browser -> HTTP)
    |
recordFromResult() auto-classifies via cross-check probes
    |
.verify/faults.jsonl (the fault ledger)
    |
faults inbox (unencoded verify bugs)
    |
Scenario Encoding (human + Claude today, LLM auto-encode future)
    |
faults link (marks fault as encoded)
    |
self-test (new scenarios are dirty)
    |
Improve Loop (nightly guard on all scenarios)
    |
Patches reviewed + applied
    |
Verify is stronger -> back to top
```

### What Exists Today

| Piece | Status |
|-------|--------|
| Verify gates | Shipped (v0.2.0 on npm) |
| Self-test harness | Shipped (56 scenarios, 7 families) |
| Improve loop | Built, tested on intentional regression |
| Fault ledger | Built, wired into CLI |
| constraints.json | Works for end users today |
| Chaos engine | Not built (future) |
| Auto scenario encoding | Not built (future) |
| Universal constraint feed | Not built (future) |

### What's Proprietary (Stays In-House)

- `scripts/harness/improve.ts` - improve loop orchestrator
- `scripts/harness/improve-triage.ts` - deterministic triage rules
- `scripts/harness/improve-prompts.ts` - LLM diagnosis + candidate generation
- `scripts/harness/improve-subprocess.ts` - subprocess validation + holdout
- `scripts/harness/improve-report.ts` - improve result formatting
- `scripts/harness/llm-providers.ts` - Gemini/Anthropic/Ollama wrappers

The loop is the factory. The constraints file is the product. Open source the engine, keep the factory, sell the output.

## Key Analogies

- **Campaigns** = the geologist (finds new minerals)
- **You** = the taxonomist (classifies what was found)
- **Fault ledger** = the field notebook (permanent record of discoveries)
- **Scenarios** = the museum collection (encoded knowledge)
- **Improve loop** = the museum guard (nothing in the collection goes missing)
- **constraints.json** = the product (what users actually buy/use)

## The Long Game

The labs are making models smarter.
We’re making failure impossible.

Both look like “it just works.”

The difference is: their gains reset with context.
Ours compound with every mistake that never happens again.

Constraints aren’t intelligence.
They’re the systematic removal of stupidity.

And when enough stupidity is removed, what’s left behaves like true intelligence.


                     +-----------------------------------+
                     |          Outer Circle             |
                     |     Real-World Campaigns          |
                     |   (Creative / Agent LLM here)     |
                     +-----------------------------------+
                                    │
                                    ▼
                        [Agent proposes code edit]
                                    │
                                    ▼
                        [verify gates the edit]
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
          PASS (apply)        FAIL (log)            Bad hint
               │                    │                    │
               └────────────────────┼────────────────────┘
                                    │
                                    ▼
                    recordFromResult() ← AUTOMATED
                    (auto-classifies via cross-check probes)
                                    │
                                    ▼
                         .verify/faults.jsonl
                                    │
                                    ▼
                            faults inbox
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
               agent_fault     ambiguous      verify bug
               (auto-filtered)  (YOU review)  (auto or YOU)
                    │               │               │
                    ▼               ▼               ▼
                  ignore        classify       encode scenario
                                                    │
                                    ┌───────────────┘
                                    │  ← YOU + CLAUDE (today)
                                    │  ← LLM auto-encode (future)
                                    ▼
                     +-----------------------------------+
                     |          Inner Circle             |
                     |   Autoresearch Loop (--improve)   |
                     +-----------------------------------+
                                    │
                                    ▼
                        Run self-test (dirty?)
                                    │
                                    ▼
                         Triage → LLM candidates
                                    │
                                    ▼
                      Subprocess validation + holdout
                                    │
                                    ▼
                          Verdict + patches
                                    │
                                    ▼
                        Human review → Apply
                                    │
                                    ▼
                      Verify is now stronger
                                    │
                                    └──────────────┐
                                                   ▼
                              Back to Outer Circle (next day)

