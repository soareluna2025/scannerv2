#!/bin/bash
echo "Pornesc referee-extended (calcul home_wr + cards markets per arbitru)..."
curl -s --max-time 180 "http://localhost:3000/api/cron/referee-extended" \
  | python3 -m json.tool 2>/dev/null \
  || curl -s --max-time 180 "http://localhost:3000/api/cron/referee-extended"
echo ""; echo "Done."
