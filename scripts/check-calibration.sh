#!/bin/bash
# Verifica continutul curent al calibrarii (pre-meci + live).
#
# Usage: bash scripts/check-calibration.sh

echo "=== /api/calibration (endpoint public) ==="
curl -s http://localhost:3000/api/calibration \
  | python3 -m json.tool 2>/dev/null \
  || curl -s http://localhost:3000/api/calibration
echo ""
