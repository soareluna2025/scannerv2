#!/bin/bash
# Trigger manual: colectare venues (max 200 per rulare)
# Cost API: ~200 calls (max)
#
# Usage: bash scripts/collect-venues-now.sh

echo "Pornesc collect-venues (max 200 venues/rulare, durata ~30s)..."
echo ""
curl -s --max-time 120 "http://localhost:3000/api/cron/collect-venues?limit=200" \
  | python3 -m json.tool 2>/dev/null \
  || curl -s --max-time 120 "http://localhost:3000/api/cron/collect-venues?limit=200"
echo ""
echo "Done."
