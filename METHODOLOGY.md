# AIDev-POP Scan Methodology

## Reproducibility

Anyone can reproduce these results. Download the dataset, run the scanner, get the same numbers.

```bash
# 1. Clone verify
git clone https://github.com/Born14/verify.git
cd verify
bun install

# 2. Download AIDev-POP dataset from HuggingFace
mkdir -p data/aidev-pop
# Download these two files from https://huggingface.co/datasets/hao-li/AIDev
#   pr_commit_details.parquet (485 MB) — patches for every file changed in every PR
#   pull_request.parquet (16 MB) — PR metadata (title, agent, repo, state)

# 3. Convert parquet to JSONL (requires Python + pandas + pyarrow)
python -c "
import pandas as pd, json
df = pd.read_parquet('data/aidev-pop/pr_commit_details.parquet',
     columns=['sha','pr_id','filename','status','additions','deletions','changes','patch'])
with open('data/aidev-pop/pr_commit_details.jsonl','w') as f:
    for _, row in df.iterrows():
        f.write(json.dumps(row.to_dict(), default=str) + '\n')
"
python -c "
import pandas as pd, json
df = pd.read_parquet('data/aidev-pop/pull_request.parquet',
     columns=['id','number','title','body','agent','user','state','created_at','repo_url','html_url'])
with open('data/aidev-pop/pull_request.jsonl','w') as f:
    for _, row in df.iterrows():
        f.write(json.dumps(row.to_dict(), default=str) + '\n')
"

# 4. Run the scan (per agent, 500 PRs per batch)
bun scripts/scan/batch-scanner.ts --agent=Devin --batch=1 --size=500
bun scripts/scan/batch-scanner.ts --agent=Copilot --batch=1 --size=500
# ... continue for all batches

# 5. Compile the wiki
bun scripts/scan/wiki-compiler.ts
```

## Dataset

**AIDev-POP** — a subset of the AIDev dataset containing pull requests from repositories with 100+ GitHub stars.

| Field | Value |
|-------|-------|
| Source | [hao-li/AIDev on HuggingFace](https://huggingface.co/datasets/hao-li/AIDev) |
| Total PRs | 33,596 (33,056 with parseable patches) |
| Repositories | 2,807+ |
| Star threshold | 100+ |
| Time period | 2024-2026 |
| Agents | OpenAI Codex, Devin, GitHub Copilot, Cursor, Claude Code |

**Per-agent sample sizes:**

| Agent | PRs in dataset | PRs scanned | Avg edits per PR |
|-------|---------------|-------------|-----------------|
| OpenAI Codex | 21,799 | 21,764 | 21.7 |
| Devin | 4,827 | 4,800 | 69.5 |
| GitHub Copilot | 4,970 | 4,496 | 70.4 |
| Cursor | 1,541 | 1,539 | 50.6 |
| Claude Code | 459 | 457 | 111.8 |

PRs scanned < PRs in dataset due to: missing patches, empty diffs, or parse failures.

## Pipeline

```
PR patch (unified diff)
  → parseDiff()           — convert to Edit[] (search/replace pairs)
  → verify(edits, [], {   — run through gate pipeline
      gates: {
        grounding: false,   // disabled — needs real repo
        syntax: false,      // disabled — needs real files
        staging: false,     // disabled — needs Docker
        browser: false,     // disabled — needs Playwright
        http: false,        // disabled — needs running app
        invariants: false,  // disabled — needs running app
        vision: false,      // disabled — needs screenshots
      }
    })
  → classifier            — tag each finding as high/low/unknown
  → wiki compiler          — generate markdown reports
```

**No LLM calls.** The entire pipeline is deterministic. Cost: $0.

## Gates Enabled (10 of 26)

These gates analyze the diff content without needing the target repository:

| Gate | What it detects | How it works on diffs |
|------|----------------|----------------------|
| **Security** | Hardcoded secrets, SQL injection, XSS, eval | Scans edit replacement text for known patterns |
| **Containment (G5)** | Undeclared mutations | Checks if edits touch files beyond what predicates cover |
| **Access** | Path traversal, permission escalation | Scans for `fs.readFile(req.*)`, `chmod`, `sudo`, unsafe paths |
| **Temporal** | Cross-file staleness | Detects port/config changes without updating dependent files |
| **Propagation** | Stale cross-file references | Detects renamed identifiers referenced in unmodified files |
| **State** | Invalid state assumptions | Detects references to entities that don't exist in the diff |
| **Capacity** | Unbounded queries | Detects `SELECT *` without LIMIT, missing pagination patterns |
| **Contention** | Race conditions, missing transactions | Detects read-modify-write without atomicity, shared mutable state |
| **Observation** | Observer effects | Detects verification actions that modify system state |
| **Triangulation** | Cross-authority synthesis | Compares deterministic vs runtime verdicts |

## Gates Disabled (16 of 26)

These gates require the target repository, Docker, or a running application:

| Gate | Why disabled | What it would add |
|------|-------------|-------------------|
| Grounding | Needs repo source files | Fabricated selector/reference detection |
| F9 (Syntax) | Needs repo files for search string matching | Edit application validation |
| K5 (Constraints) | No prior failure history | Learned constraint enforcement |
| Staging | Needs Docker | Build/start verification |
| Browser | Needs Playwright | Runtime CSS/HTML validation |
| HTTP | Needs running app | Endpoint response validation |
| Invariants | Needs running app | Health check validation |
| Vision | Needs screenshots | Visual verification |
| + 8 domain gates | Various infrastructure requirements | Additional domain-specific checks |

Enabling grounding and F9 (requires cloning ~2,807 repos) would add fabricated reference detection — potentially doubling the finding rate.

## Confidence Classifier

Every finding is auto-tagged before reporting. The classifier is deterministic — no LLM, no randomness.

### High Confidence (reported as findings)

A finding is high confidence when it matches ALL of:
- The gate detects a known structural pattern (not just a keyword match)
- The file is backend/runtime code (not config, types, docs, or tests)
- The PR has fewer than 10 total findings (high density = noise)

Specific rules:
- Security findings in `.ts`, `.js`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.php` files
- Contention findings in backend code (race conditions, missing transactions)
- Access findings in backend code (not type definitions, not config files)
- Capacity findings involving SQL or backend code

### Low Confidence (filtered out — known false positive patterns)

| Shape ID | Pattern | Why it's a false positive |
|----------|---------|--------------------------|
| GC-651 | Contention gate on `.tsx/.jsx/.vue/.svelte` | Frontend components don't do DB writes |
| GC-652 | Access gate on `.d.ts` / `types.ts` | Type declarations aren't runtime code |
| GC-653 | Access gate on `.gitignore`, `package.json`, CI workflows | Config files, not runtime code |
| GC-654 | Access gate on `.csproj/.sln/.props` | MSBuild XML paths are normal |
| GC-655 | Access gate on `Dockerfile` | COPY/ADD paths are normal Docker instructions |
| GC-656 | Access gate on lockfiles | Generated files, not authored code |
| GC-657 | Access gate on `.h/.hpp` headers | `#include` paths are normal C++ patterns |
| GC-658 | Access gate on `.yaml/.yml/.toml` config | Config file paths are normal |
| GC-659 | Access gate on `.bundle/`, `Gemfile` | Ruby bundler paths are normal |
| GC-660 | Propagation gate on `LICENSE` files | License text isn't cross-file reference |
| GC-661 | Access gate on `.promptx/`, `.claude/`, `.cursor/` config | Agent config files |
| GC-662 | Contention gate on `mcp.json`, lockfiles | Config JSON, not transactions |
| GC-663 | Access gate on shell scripts | Script paths are normal |
| GC-664 | Access gate on `.env.example` | Template files, not production |
| GC-665 | Access gate on `.cursorrules` | Agent instruction files |
| GC-666 | Access gate on `build.gradle` | JVM build system paths |
| GC-667 | Contention gate on CI workflow YAML | CI steps aren't concurrent transactions |
| GC-668 | Propagation gate on `.jsonc` config | Tool config, not code references |

Additional low-confidence rules:
- Any finding in documentation files (`.md`, `.mdx`, `.rst`)
- Any finding in test files (`*test*`, `*spec*`, `__tests__/`)
- PRs with >10 findings from a single gate (over-matching)

### Unknown (pending review)

Findings that don't match any high or low pattern. These are accumulated across batches. When 3+ unknowns share the same gate + file-type pattern, they're auto-promoted to candidate shapes for operator review.

## What "Finding Rate" Means

**Raw finding rate:** Percentage of PRs where any gate fires (high + low + unknown).

**High-confidence finding rate:** Percentage of PRs with at least one high-confidence finding. **This is the published number.** It excludes all known false positive patterns.

**Normalized rate (per 1,000 edits):** Total findings divided by total edits × 1,000. Controls for PR size — agents that write bigger PRs mechanically trigger more gates.

## Limitations

1. **Diff-only analysis.** 16 of 26 gates are disabled. The grounding gate (fabricated references) and F9 (edit application) would require cloning each repository. The reported rates are a lower bound — enabling all gates would find more issues.

2. **No runtime verification.** Staging, browser, and HTTP gates require running the application. Behavioral bugs (the code compiles but doesn't work) are not detected.

3. **Classifier calibration.** The confidence classifier was calibrated on the first 1,000 PRs (Devin + Copilot). Later agents (Cursor, Claude Code, Codex) may have patterns not yet classified. 369 unknowns remain across all batches.

4. **Sample size variance.** Claude Code has 457 PRs; Codex has 21,764. Statistical confidence varies by agent. Claude Code's numbers should be interpreted with wider error bars.

5. **No predicate-based checking.** The scan runs `verify(edits, [], config)` — no predicates. Intent alignment (did the agent do what was asked?) is not measured. Only structural correctness.

6. **Static patterns.** The security, access, capacity, and contention gates use regex-based pattern matching. Sophisticated obfuscation or indirect patterns may be missed. The gates catch common agent patterns, not adversarial evasion.

## Reproducibility Guarantee

The scanner is deterministic. Given the same:
- AIDev-POP dataset files (parquet)
- Verify version (`git log --oneline -1`)
- Classifier rules (`scripts/scan/classifier.ts`)
- Batch parameters (`--agent=X --batch=N --size=500`)

The output is identical. No randomness, no LLM calls, no network dependencies.

---

*Methodology documented April 7, 2026. Scan executed April 6-7, 2026.*
*Scanner: `scripts/scan/batch-scanner.ts`. Classifier: `scripts/scan/classifier.ts`.*
*Dataset: [hao-li/AIDev](https://huggingface.co/datasets/hao-li/AIDev) (AIDev-POP subset).*
