#!/bin/bash
# Test rapid pentru endpoint /api/admin/win-rate-patterns
# Folosit cand UI-ul afiseaza HTTP 500 ca sa vedem raw eroarea.
#
# Usage:
#   bash scripts/test-win-rate.sh           # default 30 zile NGP
#   bash scripts/test-win-rate.sh 7 OVER15

set -e

DAYS=${1:-30}
MODULE=${2:-NGP}

KEY=$(grep ADMIN_API_KEY /root/scannerv2/.env 2>/dev/null | cut -d= -f2)
if [ -z "$KEY" ]; then
  echo "ADMIN_API_KEY lipseste din /root/scannerv2/.env"
  exit 1
fi

echo "Test: /api/admin/win-rate-patterns days=$DAYS module=$MODULE"
echo ""

curl -s -H "X-Api-Key: $KEY" \
  "http://localhost:3000/api/admin/win-rate-patterns?days=${DAYS}&module=${MODULE}&minSamples=5" \
  | python3 -m json.tool 2>/dev/null || curl -s -H "X-Api-Key: $KEY" \
  "http://localhost:3000/api/admin/win-rate-patterns?days=${DAYS}&module=${MODULE}&minSamples=5"
echo ""
