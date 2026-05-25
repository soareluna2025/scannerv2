#!/bin/bash
# Quick helper pentru NGP backtest (evita iPhone URL wrapping).
# Usage:
#   bash scripts/ngp-backtest-quick.sh             # rest-of-match, 2000 meciuri
#   bash scripts/ngp-backtest-quick.sh 1000        # custom limit
#   bash scripts/ngp-backtest-quick.sh 1000 15     # next 15 min outcome

set -e

LIMIT=${1:-2000}
WINDOW=${2:-0}

cd /root/scannerv2 || exit 1

set -a
source /root/scannerv2/.env
set +a

if [ "$WINDOW" -gt 0 ]; then
  echo "🎯 NGP Backtest (next $WINDOW min) — limit=$LIMIT meciuri ..."
  node scripts/ngp-backtest.js --limit "$LIMIT" --window "$WINDOW"
else
  echo "🎯 NGP Backtest (rest of match) — limit=$LIMIT meciuri ..."
  node scripts/ngp-backtest.js --limit "$LIMIT"
fi
