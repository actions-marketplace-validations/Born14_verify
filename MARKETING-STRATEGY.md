# Verify Marketing Strategy

## The Problem

Verify is silent by design. When it works, the user sees nothing. When it
catches a failure, the agent just tries again and converges. The user never
knows they were one edit away from a broken deploy. This is the correct UX
but it makes marketing nearly impossible through traditional "look what my
product does" approaches.

The existing demos (liar, world, drift) are technically accurate but feel
staged. They show synthetic failures in a sandbox. Nobody watches them and
thinks "I need this." They think "neat" and move on.

## The Insight

People don't buy verification. They buy the absence of fear. The target
emotion isn't "wow, cool gates" -- it's "I almost shipped that?"

Every developer using AI agents has a quiet dread: the agent said done, I
merged it, and something was wrong that I didn't catch until production. That
fear is the entry point. Not the gates. Not the architecture. The fear.

---

## Strategy: "What Shipped"

### Concept

Instead of showing verify catching things, show what happens when there's
no verify. Make the pain visceral and specific. Then position verify as the
thing that makes that pain stop.

### Execution

#### 1. The Receipts (Weekly content series)

A recurring series called "The Receipt" or "What Your Agent Actually Did."

Each post is a single, real scenario from your 18,391 test corpus. Format:

```
The agent said: "Updated the login form styling"
The agent actually did:
  - Changed a CSS selector that doesn't exist in the DOM
  - The form renders with no styling
  - Users see a broken page

Verify gate that catches this: Grounding (target must exist in reality)
Time to catch: 0ms
```

Why this works:
- It's short. One scenario per post. People read the whole thing.
- It's relatable. Every developer has seen exactly this.
- It positions verify without selling verify. The scenario IS the pitch.
- You have 18,391 of these. You never run out of content.
- The punchline is always the same: one line, one gate, instant.

#### 2. The Live Gauntlet (Event / stream format)

Let people submit real agent tasks. Run the agent live. Show the verify
output in real time. Not a scripted demo -- a live trial.

Format: "Bring Your Worst Prompt"
- Audience submits a coding task
- An AI agent attempts it
- Verify runs on every edit
- The audience sees what verify caught (or didn't)

Why this works:
- It's unscripted. You can't fake it. That's the credibility.
- When verify catches something live, the audience felt the stakes.
- When verify passes everything, that's also impressive -- it means the
  agent actually did its job and verify confirmed it.
- The format itself IS the proof. You're betting your product in public.

#### 3. The Silent Scoreboard (Dashboard / badge)

A public, real-time counter:

```
Edits verified: 247,891
Failures caught before deploy: 12,403
Gates that caught them: Grounding (34%), Syntax (22%), Containment (18%)...
```

This can be:
- A badge in repos that use verify (like code coverage badges)
- A public dashboard page
- A number that ticks up in real time on your site

Why this works:
- Social proof without testimonials
- The number going up IS the marketing
- Other developers see the badge in repos and wonder what it is
- It answers "does this actually work?" with a live number

#### 4. The Postmortem That Didn't Happen (Long-form content)

Write detailed "almost-postmortems." Stories structured exactly like a
real incident postmortem, but the twist is: verify caught it before deploy.

Format:
```
Incident: Agent modified database migration to drop column
Severity: Would have been P0 (data loss in production)
Root cause: Agent had stale schema, generated migration against wrong state
Detection: Verify gate 14 (Infrastructure) flagged destructive migration
Time to detection: <1 second
Actual impact: None. Edit was rejected. Agent retried with fresh schema.

What would have happened without verify:
- Migration runs in CI
- Column dropped in staging (no data, passes)
- Column dropped in production (user data lost)
- 3 AM page, 4 hour recovery, public incident report
```

Why this works:
- Developers READ postmortems. It's a content format they already consume.
- The twist ("this didn't actually happen") is memorable.
- It demonstrates specific gate behavior without being a product tour.
- It's shareable -- people forward postmortems to their teams.

#### 5. The Integration Play (Distribution, not marketing)

The highest-leverage move isn't content. It's being where agents already run.

- **Cursor / Windsurf / Copilot users**: MCP server integration means
  verify can sit in their existing workflow. The marketing IS the
  integration -- "add this one line to your MCP config."
- **CI/CD**: A GitHub Action that runs verify on every AI-generated PR.
  The badge shows up on every PR. That's distribution.
- **Agent framework authors**: Offer verify as a built-in option for
  LangChain, CrewAI, AutoGen, etc. Their users discover verify through
  the framework.

This isn't marketing content. It's surface area. Every integration is a
channel that markets itself.

---

## What NOT To Do

- **Don't lead with "26 gates."** Nobody cares about the number. They care
  about the outcome.
- **Don't lead with architecture.** HOW-IT-WORKS.md is incredible
  documentation. It is terrible marketing. Save it for after they're sold.
- **Don't do generic "my product works" social posts.** You identified this
  yourself. It's noise.
- **Don't compare to competitors.** There aren't direct ones. Comparing to
  linters or CI tools shrinks what verify is.
- **Don't oversell.** Verify isn't perfect and you know it. "We catch most
  of the failures most of the time" is more credible than "we catch
  everything." Developers smell bullshit instantly.

---

## Messaging Hierarchy

**Level 1 (Hook):** "Your agent said done. Was it?"
**Level 2 (Problem):** Three ways agents silently break your code.
**Level 3 (Solution):** 26 gates. First failure stops. You fix forward.
**Level 4 (Proof):** 18,391 scenarios. Self-improving nightly.
**Level 5 (Action):** `npx @sovereign-labs/verify init`

Only go one level deeper when they're ready. Most content should live at
Level 1 and Level 2. The README already does Level 3-5 well.

---

## Strategy Zero: The Benchmark (Before Everything Else)

Nothing in this document matters until you have numbers. Real numbers.
Not internal test scenarios. Not synthetic passes. A head-to-head
comparison that anyone can reproduce.

### The Benchmark

Same LLM. Same coding tasks. Two paths:
- **Path A (Raw):** Agent produces edits, apply them directly, check if the goal was achieved
- **Path B (Governed):** Agent runs through verify's govern() loop, check if the goal was achieved

The judge is **independent of verify** — it checks ground truth by reading
files, running syntax checks, and validating content predicates. No verify
gate code in the evaluation. This prevents circular reasoning.

### What It Measures

```
                          Raw Agent    With Verify
Goals achieved:             12            18
Goals failed:                6             2
Success rate:             60.0%         90.0%
Avg attempts:              1.0            2.1
```

And the head-to-head breakdown:
- **verify_saved**: Raw failed, governed succeeded (verify made the difference)
- **both_succeeded**: Both worked (verify didn't hurt)
- **both_failed**: Neither worked (verify didn't help here)
- **verify_regression**: Raw worked, governed failed (verify made it worse)

### How To Run It

```bash
# With Gemini (cheapest)
GEMINI_API_KEY=... npx tsx scripts/benchmark/benchmark.ts \
  --app=fixtures/demo-app --tasks=20 --llm=gemini --verbose

# With Claude
ANTHROPIC_API_KEY=... npx tsx scripts/benchmark/benchmark.ts \
  --app=fixtures/demo-app --tasks=20 --llm=claude --verbose

# With your own app
npx tsx scripts/benchmark/benchmark.ts \
  --app=/path/to/your/app --tasks=30 --llm=gemini --verbose

# Reuse same tasks for fair comparison across models
npx tsx scripts/benchmark/benchmark.ts \
  --tasks-file=.verify/benchmark/tasks-xxx.json --llm=claude
```

### Why This Comes First

1. **For yourself**: You said it — without proof, this is a research project.
   Run the benchmark. If the numbers are good, you know. If they're not,
   you know what to fix before going public.

2. **For credibility**: "Verify improved agent success rate by 34% across
   20 coding tasks" is worth more than any demo, receipt, or postmortem.
   It's reproducible. Anyone can run it.

3. **For content**: The benchmark results BECOME the content. The numbers
   are the receipts. The per-task breakdown is the demo. The regressions
   (if any) are the honesty that builds trust.

4. **For iteration**: Run it weekly. Track the numbers over time. When you
   improve verify, the benchmark proves the improvement is real.

### The Honest Outcomes

If the numbers are good: lead with them everywhere. "34% improvement."
That's the tweet, the README badge, the conference talk title.

If the numbers are mixed: that's still honest. "Verify helped on 8/20 tasks,
was neutral on 10, regressed on 2. Here's what we're fixing." Developers
respect transparency more than perfection.

If the numbers are bad: you saved yourself from shipping marketing for a
product that doesn't work yet. Fix verify first. Run the benchmark again.

---

## Priority Order (Updated)

0. **The Benchmark** -- Run it NOW. Before any content, any posts, any
   marketing. Get the numbers. Everything else depends on what they say.

1. **The Receipts** -- Start after the benchmark. Use REAL benchmark
   results, not internal scenarios. "Task 7: agent said done, file didn't
   exist. Verify caught it, agent retried, goal achieved."

2. **The Postmortem That Didn't Happen** -- Write 3, using real benchmark
   failures as source material.

3. **CI/CD GitHub Action + Badge** -- Build the distribution channel.
   The badge shows the benchmark improvement number.

4. **The Live Gauntlet** -- Schedule one. The benchmark gives you
   confidence to do this live because you've already seen the numbers.

5. **The Silent Scoreboard** -- Build after you have enough usage data.

---

## The One Thing To Remember

Verify's silence is the product. Don't fight it. Market the silence itself.

"Nothing happened. That's the point."
