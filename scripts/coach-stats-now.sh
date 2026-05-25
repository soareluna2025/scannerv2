#!/bin/bash
echo "Pornesc coach-stats agregare (durata ~60s)..."
curl -s --max-time 300 "http://localhost:3000/api/cron/coach-stats" \
  | python3 -m json.tool 2>/dev/null \
  || curl -s --max-time 300 "http://localhost:3000/api/cron/coach-stats"
echo ""; echo "Done."
