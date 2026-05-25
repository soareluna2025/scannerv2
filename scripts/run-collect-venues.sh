#!/bin/bash
# Populeaza altitude pentru venues via Nominatim + OpenElevation
# Rulare: bash scripts/run-collect-venues.sh [limit]
# Default: 200 per run. Cu 4604 venues fara altitude → ~23 rulari.
# Exemplu batch mare: bash scripts/run-collect-venues.sh 500

export PGPASSWORD=Firenze225854
PG() { psql -U alohascan -d elefant -h 127.0.0.1 -tA -c "$1" 2>/dev/null; }
APP="http://localhost:3000"
LIMIT="${1:-200}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  P6 — collect-venues  (limit=$LIMIT)"
echo "  Start: $(date '+%d.%m %H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

BEFORE=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
echo "  Venues cu altitude inainte: $BEFORE"
echo

# Fiecare venue = ~1s Nominatim + ~1s OpenElevation → LIMIT*2s timeout
TIMEOUT=$(( LIMIT * 3 + 30 ))
echo "  Rulare (timeout ${TIMEOUT}s, ~${LIMIT} venues × ~2s/venue)..."
echo

RESPONSE=$(curl -s --max-time $TIMEOUT "${APP}/api/cron/collect-venues?limit=${LIMIT}" 2>/dev/null)

if [ -z "$RESPONSE" ]; then
  echo "  ❌ Niciun raspuns (timeout sau app oprit)"
  exit 1
fi

echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f'  collected:        {d.get(\"collected\", 0)}')
    print(f'  total_in_db:      {d.get(\"total_venues_in_db\", \"?\")}')
    print(f'  missing_count:    {d.get(\"missing_count\", \"?\")}')
    sample = d.get('sample', [])
    if sample:
        print(f'  Sample:')
        for v in sample:
            alt = v.get('altitude')
            lat = v.get('lat')
            print(f'    {v.get(\"name\",\"?\")} ({v.get(\"city\",\"?\")}) — alt={alt}m lat={lat}')
    if not d.get('ok'):
        print(f'  Eroare: {d.get(\"error\",\"unknown\")}')
except Exception as e:
    print(f'  Parse error: {e}')
    print(f'  Raw: {sys.stdin.read()[:300]}')
" 2>/dev/null || echo "  Raw: ${RESPONSE:0:300}"

echo
AFTER=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NOT NULL")
REMAINING=$(PG "SELECT COUNT(*) FROM venues WHERE altitude_m IS NULL")
echo "  Venues cu altitude dupa:  $AFTER  (+$(( AFTER - BEFORE )))"
echo "  Ramas fara altitude:      $REMAINING"
echo "  Stop: $(date '+%d.%m %H:%M:%S')"
echo
if [ "${REMAINING:-0}" -gt 0 ] 2>/dev/null; then
  echo "  ⚠️  Mai raman $REMAINING venues. Ruleaza din nou: bash scripts/run-collect-venues.sh $LIMIT"
else
  echo "  ✅ Toate venues au altitude populat!"
fi
echo
