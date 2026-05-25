#!/bin/bash
echo "Pornesc collect-coaches (max 200 echipe/rulare, ~30s)..."
curl -s --max-time 120 "http://localhost:3000/api/cron/collect-coaches?limit=200" \
  | python3 -m json.tool 2>/dev/null \
  || curl -s --max-time 120 "http://localhost:3000/api/cron/collect-coaches?limit=200"
echo ""; echo "Done."
