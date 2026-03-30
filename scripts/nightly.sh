#!/bin/bash
# Verify Autonomous Hardening Loop — Lenovo Nightly
# Runs at 3 AM UTC via systemd timer, or manually: bash scripts/nightly.sh
#
# This is the real nightly — full Docker environment, live tier, all 26 gates.
# GitHub Actions CI is the backup (no Docker = staging gate skipped).

set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
export GEMINI_API_KEY="$(grep GEMINI_API_KEY "$HOME/sovereign/.env" | cut -d= -f2)"
export GEMINI_MODEL="gemini-2.5-flash"

LOG_DIR="data/nightly-logs"
mkdir -p "$LOG_DIR"
DATE=$(date -u +%Y-%m-%d)
LOG="$LOG_DIR/nightly-${DATE}.log"

echo "═══ Verify Nightly — ${DATE} ═══" | tee "$LOG"
echo "Host: $(hostname)" | tee -a "$LOG"
echo "Docker: $(docker --version 2>/dev/null || echo 'not available')" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# Stage 1: SUPPLY — generate new scenario fuel
echo "[Stage 1] Supply chain..." | tee -a "$LOG"
bun scripts/supply/fuzz.ts --max-variants=50 2>&1 | tee -a "$LOG" || true
bun scripts/supply/harvest.ts --max-scenarios=100 2>&1 | tee -a "$LOG" || true
timeout 300 bun scripts/harvest/curriculum-agent.ts --adversarial --provider=gemini --max=10 2>&1 | tee -a "$LOG" || true

# Stage 2: BASELINE — full self-test with Docker (live tier)
echo "" | tee -a "$LOG"
echo "[Stage 2] Baseline self-test (live tier)..." | tee -a "$LOG"
bun run src/cli.ts self-test --live --source=all 2>&1 | tee -a "$LOG"
BASELINE_EXIT=$?

# Stage 3: IMPROVE — fix failures automatically
echo "" | tee -a "$LOG"
echo "[Stage 3] Improve loop..." | tee -a "$LOG"
bun run src/cli.ts improve --llm=gemini --max-candidates=3 2>&1 | tee -a "$LOG" || true

# Stage 8: DISCOVER + CONFIRM — find and confirm new shapes
echo "" | tee -a "$LOG"
echo "[Stage 8] Discover + confirm shapes..." | tee -a "$LOG"
bun scripts/harness/discover-shapes.ts --confirm 2>&1 | tee -a "$LOG" || true

# Summary
echo "" | tee -a "$LOG"
echo "═══ Nightly Complete — $(date -u +%Y-%m-%dT%H:%M:%SZ) ═══" | tee -a "$LOG"
echo "Log: $LOG" | tee -a "$LOG"
echo "Exit: baseline=$BASELINE_EXIT" | tee -a "$LOG"
