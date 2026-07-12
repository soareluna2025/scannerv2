#!/bin/bash
# ============================================================================
#  h2h-gapfill.sh — umple GAP-ul din h2h pentru meciurile whitelist FT terminate
#  ÎNAINTE ca robinetul incremental din collect-finished.js să existe.
#
#  Context: până la fix-ul anomaliilor, h2h primea rânduri DOAR din backfill.js
#  (istoric). Meciurile terminate zi-de-zi după ultimul backfill (> 2026-06-28)
#  NU au ajuns niciodată în h2h. Acest script le recuperează O SINGURĂ DATĂ.
#
#  Sursă = fixtures_history (deja plătit; ZERO apeluri API). Whitelist = api/leagues.js
#  (sursă unică, regenerată aici prin export-allowed-leagues.mjs → zero listă duplicată).
#  Idempotent: NOT EXISTS + ON CONFLICT DO NOTHING → poate fi rulat de câte ori vrei.
#
#  Rulează O SINGURĂ DATĂ pe VPS, DUPĂ deploy (o singură linie în Termius):
#     cd /root/scannerv2 && bash scripts/h2h-gapfill.sh
# ============================================================================
set -e
APP_DIR="/root/scannerv2"
cd "${APP_DIR}"

# .env → POSTGRES_URL (conexiune DB locală).
set -a
. "${APP_DIR}/.env"
set +a
if [ -z "${POSTGRES_URL}" ]; then
  echo "EROARE: POSTGRES_URL lipsește din ${APP_DIR}/.env — abort." >&2
  exit 1
fi

# Whitelist din SURSA UNICĂ (api/leagues.js) → ml/allowed_leagues.json → listă IN(...).
node scripts/export-allowed-leagues.mjs
LEAGUES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('ml/allowed_leagues.json','utf8')).join(','))")
if [ -z "${LEAGUES}" ]; then
  echo "EROARE: lista whitelist e goală — abort (nu inserez fără filtru de ligă)." >&2
  exit 1
fi

echo "[h2h-gapfill] whitelist=$(echo "${LEAGUES}" | tr ',' '\n' | wc -l) ligi | inserez gap-ul h2h (match_date > 2026-06-28)..."

psql "${POSTGRES_URL}" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO h2h
  (team1_id, team2_id, fixture_id, home_team_id, away_team_id,
   match_date, home_goals, away_goals, league_id, season)
SELECT LEAST(fh.home_team_id, fh.away_team_id),
       GREATEST(fh.home_team_id, fh.away_team_id),
       fh.fixture_id, fh.home_team_id, fh.away_team_id,
       fh.match_date, fh.home_goals, fh.away_goals, fh.league_id, fh.season
  FROM fixtures_history fh
 WHERE fh.status_short IN ('FT','AET','PEN')
   AND fh.home_team_id IS NOT NULL AND fh.away_team_id IS NOT NULL
   AND fh.home_team_id <> fh.away_team_id
   AND fh.home_goals IS NOT NULL
   AND fh.match_date > '2026-06-28'
   AND fh.league_id IN (${LEAGUES})
   AND NOT EXISTS (SELECT 1 FROM h2h h WHERE h.fixture_id = fh.fixture_id)
ON CONFLICT (team1_id, team2_id, fixture_id) DO NOTHING;
SQL

echo "[h2h-gapfill] gata. Verifică: psql \"\$POSTGRES_URL\" -c \"SELECT max(match_date) FROM h2h;\""
