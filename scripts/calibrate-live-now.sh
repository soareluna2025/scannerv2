#!/bin/bash
# Trigger manual pentru cron-ul calibrare LIVE.
# Scaneaza max 5000 fixtures FT din ultimele 365 zile, extrage match_events
# pentru fiecare si construieste calibration_live (per minute_bucket x score x market).
# Durata estimata: ~30-90 secunde.
#
# Usage: bash scripts/calibrate-live-now.sh

echo "Rulez calibrate-live (poate dura ~1 min)..."
echo ""
curl -s --max-time 180 http://localhost:3000/api/cron/calibrate-live \
  | python3 -m json.tool 2>/dev/null \
  || curl -s --max-time 180 http://localhost:3000/api/cron/calibrate-live
echo ""
echo "Done."
