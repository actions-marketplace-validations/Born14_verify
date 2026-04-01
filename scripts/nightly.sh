#!/bin/bash
# Verify Autonomous Hardening Loop — Lenovo Nightly
# Runs at 3 AM UTC via systemd timer, or manually: bash scripts/nightly.sh
#
# Pipeline: Audit → Supply → Test → Triage → Improve → Discover
# Each stage feeds the next. The loop closes when discover proposes
# shapes that become scenarios that expose gate bugs that improve fixes.

set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
export GEMINI_API_KEY="$(grep GEMINI_API_KEY "$HOME/sovereign/.env" | cut -d= -f2)"

# Layer 8: Model rotation for improve loop (review always uses 3.1-pro)
DAY=$(date -u +%d)
MODELS=("gemini-2.5-flash" "gemini-2.5-pro" "gemini-3.1-pro-preview")
MODEL_INDEX=$((10#$DAY % 3))
export GEMINI_MODEL="${MODELS[$MODEL_INDEX]}"

LOG_DIR="data/nightly-logs"
mkdir -p "$LOG_DIR"
DATE=$(date -u +%Y-%m-%d)
LOG="$LOG_DIR/nightly-${DATE}.log"

echo "═══ Verify Nightly — ${DATE} ═══" | tee "$LOG"
echo "Host: $(hostname)" | tee -a "$LOG"
echo "Improve model: $GEMINI_MODEL" | tee -a "$LOG"
echo "Docker: $(docker --version 2>/dev/null || echo 'not available')" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# ─── Pre-flight: Audit coverage, fixtures, scenario quality ─────────────────

echo "[Audit] Coverage gaps..." | tee -a "$LOG"
bun scripts/harness/coverage-auditor.ts 2>&1 | tee -a "$LOG" || true

echo "" | tee -a "$LOG"
echo "[Audit] Fixture gaps..." | tee -a "$LOG"
bun scripts/harness/fixture-auditor.ts 2>&1 | tee -a "$LOG" || true

echo "" | tee -a "$LOG"
echo "[Audit] Scenario quality..." | tee -a "$LOG"
bun scripts/harness/scenario-quality.ts 2>&1 | tee -a "$LOG" || true

# ─── Stage 1: SUPPLY — generate new scenario fuel ───────────────────────────

echo "" | tee -a "$LOG"
echo "[Stage 1] Supply chain..." | tee -a "$LOG"
bun scripts/supply/fuzz.ts --max-variants=50 2>&1 | tee -a "$LOG" || true
bun scripts/supply/harvest.ts --max-scenarios=100 2>&1 | tee -a "$LOG" || true
timeout 300 bun scripts/harvest/curriculum-agent.ts --adversarial --provider=gemini --max=10 2>&1 | tee -a "$LOG" || true

# ─── Stage 2: BASELINE — full self-test with Docker (live tier) ─────────────

echo "" | tee -a "$LOG"
echo "[Stage 2] Baseline self-test (live tier)..." | tee -a "$LOG"
rm -f data/self-test-ledger.jsonl
bun run src/cli.ts self-test --live --source=all 2>&1 | tee -a "$LOG"
BASELINE_EXIT=$?

# ─── Post-flight: Triage dirty entries ──────────────────────────────────────

echo "" | tee -a "$LOG"
echo "[Triage] Auto-classifying faults..." | tee -a "$LOG"
bun scripts/harness/auto-triage.ts 2>&1 | tee -a "$LOG" || true

# ─── Stage 3: IMPROVE — fix gate_bugs automatically ────────────────────────

echo "" | tee -a "$LOG"
echo "[Stage 3] Improve loop..." | tee -a "$LOG"
bun run src/cli.ts improve --llm=gemini --max-candidates=3 2>&1 | tee -a "$LOG" || true

# ─── Stage 8: DISCOVER + CONFIRM — find new shapes (uses decomposition) ────

echo "" | tee -a "$LOG"
echo "[Stage 8] Discover + confirm shapes..." | tee -a "$LOG"
bun scripts/harness/discover-shapes.ts --confirm 2>&1 | tee -a "$LOG" || true

# ─── Summary ────────────────────────────────────────────────────────────────

echo "" | tee -a "$LOG"
echo "═══ Nightly Complete — $(date -u +%Y-%m-%dT%H:%M:%SZ) ═══" | tee -a "$LOG"
echo "Log: $LOG" | tee -a "$LOG"
echo "Exit: baseline=$BASELINE_EXIT" | tee -a "$LOG"
