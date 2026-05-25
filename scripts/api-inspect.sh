#!/bin/bash
# Inspectie completa endpoints API-Football pentru diagnostic
# Salveaza sample responses in /tmp/api-inspect/
# Cost: ~14 API calls
#
# Usage: bash scripts/api-inspect.sh

set -e
mkdir -p /tmp/api-inspect

KEY="${API_FOOTBALL_KEY:-$(grep API_FOOTBALL_KEY /root/scannerv2/.env 2>/dev/null | cut -d= -f2 | tr -d '\"')}"
if [ -z "$KEY" ]; then
  echo "ERROR: API_FOOTBALL_KEY nu e setat"
  exit 1
fi
BASE="https://v3.football.api-sports.io"
H="x-apisports-key: $KEY"

# Folosim Premier League 2024, Manchester United team_id 33, un fixture id real
LEAGUE=39        # Premier League
SEASON=2024
TEAM=33          # Manchester United
# Iau primul fixture FT din DB
FIXTURE=$(psql -U alohascan elefant -t -A -c "SELECT fixture_id FROM fixtures_history WHERE status_short='FT' AND home_goals IS NOT NULL ORDER BY match_date DESC LIMIT 1" 2>/dev/null || echo "215662")

echo "Folosesc: league=$LEAGUE season=$SEASON team=$TEAM fixture=$FIXTURE"
echo "Output: /tmp/api-inspect/*.json"
echo ""

fetch() {
  local name="$1"
  local path="$2"
  echo "  → $name ($path)"
  curl -s -H "$H" "$BASE$path" > "/tmp/api-inspect/$name.json"
  local count=$(grep -o '"results"[[:space:]]*:[[:space:]]*[0-9]*' "/tmp/api-inspect/$name.json" | head -1 | grep -o '[0-9]*$')
  local errors=$(grep -o '"errors"[[:space:]]*:[[:space:]]*[^,}]*' "/tmp/api-inspect/$name.json" | head -1)
  echo "     results=$count errors=$errors"
}

echo "=== ENDPOINT-uri CRITICE (lipsite din colectori) ==="
fetch "venues"            "/venues?id=556"
fetch "teams_statistics"  "/teams/statistics?team=$TEAM&league=$LEAGUE&season=$SEASON"
fetch "predictions"       "/predictions?fixture=$FIXTURE"
fetch "coachs"            "/coachs?team=$TEAM"
fetch "transfers"         "/transfers?team=$TEAM"
fetch "sidelined"         "/sidelined?team=$TEAM"
fetch "trophies"          "/trophies?coach=156"
fetch "top_scorers"       "/players/topscorers?league=$LEAGUE&season=$SEASON"
fetch "top_assists"       "/players/topassists?league=$LEAGUE&season=$SEASON"
fetch "squads"            "/players/squads?team=$TEAM"
fetch "fixtures_rounds"   "/fixtures/rounds?league=$LEAGUE&season=$SEASON&current=true"

echo ""
echo "=== ENDPOINT-uri DEJA folosite (verificare structura) ==="
fetch "injuries"          "/injuries?fixture=$FIXTURE"
fetch "odds_live"         "/odds/live?fixture=$FIXTURE"
fetch "fixtures_lineups"  "/fixtures/lineups?fixture=$FIXTURE"

echo ""
echo "DONE. Fisiere salvate in /tmp/api-inspect/"
ls -la /tmp/api-inspect/
echo ""
echo "Pentru a vedea continutul, ruleaza:"
echo "  tar czf /tmp/api-inspect.tgz -C /tmp api-inspect"
echo "  apoi trimite-mi /tmp/api-inspect.tgz (sau spune-mi sa-l procesez de aici)"
