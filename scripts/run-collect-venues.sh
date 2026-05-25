#!/bin/bash
# Populeaza altitude pentru venues via Nominatim + OpenElevation
# Rulare: bash scripts/run-collect-venues.sh [limit]
# Default: 100 per run (~17 min procesare background). Cu 4604 venues → ~46 rulari.
# Procesare FIRE-AND-FORGET: scriptul porneste procesarea si monitorizeaza progresul din DB.

export PGPASSWORD=Firenze225854
PG() { psql -U alohascan -d elefant -h 127.0.0.1 -tA -c "$1" 2>/dev/null; }
APP="http://localhost:3000"
LIMIT="${1:-100}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  P6 — collect-venues  (limit=$LIMIT)"
echo "  Start: $(date '+%d.%m %H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

BEFORE=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
PENDING=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NULL AND city IS NOT NULL")
echo "  Venues cu altitude inainte: $BEFORE"
echo "  Venues de procesat (cu oras): $PENDING"
echo

# Porneste procesarea (raspunde imediat, proceseaza in background)
RESPONSE=$(curl -s --max-time 15 "${APP}/api/cron/collect-venues?limit=${LIMIT}" 2>/dev/null)

if [ -z "$RESPONSE" ]; then
  echo "  ❌ App-ul nu raspunde. Verifica: systemctl status alohascan"
  exit 1
fi

STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null)
EST_MIN=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('estimated_minutes','?'))" 2>/dev/null)

if [ "$STATUS" = "started" ]; then
  echo "  ✅ Procesare pornita in background (~${EST_MIN} minute estimat)"
  echo "  ⏳ Asteptam 30s pentru primele rezultate..."
  echo
else
  echo "  Raspuns: ${RESPONSE:0:200}"
fi

# Monitorizeaza progresul din 30 in 30 secunde
WAIT=30
ELAPSED=0
MAX_WAIT=$(( LIMIT * 12 ))  # ~12s per venue worst case
PREV=$BEFORE

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $WAIT
  ELAPSED=$(( ELAPSED + WAIT ))
  CURRENT=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
  ADDED=$(( CURRENT - PREV ))
  REMAINING=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NULL")
  echo "  [+${ELAPSED}s] Cu altitude: $CURRENT  (+${ADDED} fata de runda precedenta)  |  Ramas: $REMAINING"
  PREV=$CURRENT
  # Daca nu s-a adaugat nimic in 2 runde consecutive, probabil s-a terminat
  if [ "$ADDED" -eq 0 ] && [ $ELAPSED -gt 60 ]; then
    break
  fi
done

echo
AFTER=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
REMAINING_FINAL=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NULL")
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Venues cu altitude dupa:  $AFTER  (+$(( AFTER - BEFORE )) total adaugate)"
echo "  Ramas fara altitude:      $REMAINING_FINAL"
echo "  Stop: $(date '+%d.%m %H:%M:%S')"
echo
if [ "${REMAINING_FINAL:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ⚠️  Mai raman $REMAINING_FINAL venues. Ruleaza din nou: bash scripts/run-collect-venues.sh $LIMIT"
else
  echo "  ✅ Toate venues au altitude populat!"
fi
echo
