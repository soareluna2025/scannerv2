#!/bin/bash
# Ruleaza update-results de N ori pentru a curăța backlog-ul pending
URL="http://localhost:3000/api/update-results"
RUNDE=${1:-4}

echo "=== Curatare backlog predictions (${RUNDE} runde x 200/run) ==="
for i in $(seq 1 $RUNDE); do
  echo ""
  echo "--- Runda $i ---"
  curl -s "$URL"
  echo ""
  if [ $i -lt $RUNDE ]; then sleep 5; fi
done
echo ""
echo "=== Verificare finala ==="
export PGPASSWORD=Firenze225854
psql -U alohascan -d elefant -tAc "SELECT 'pending_expirate: ' || COUNT(*) FROM predictions WHERE result_over15 IS NULL AND match_date < NOW();" 2>/dev/null
psql -U alohascan -d elefant -tAc "SELECT 'cu_rezultat: ' || COUNT(*) FROM predictions WHERE result_over15 IS NOT NULL;" 2>/dev/null
psql -U alohascan -d elefant -tAc "SELECT 'prediction_log rezolvate: ' || COUNT(*) FROM prediction_log WHERE outcome IN ('WIN','LOSS');" 2>/dev/null
