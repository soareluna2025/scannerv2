#!/bin/bash
# ============================================================================
#  backfill-team-logos.sh — completează `teams` (one-time, ZERO apeluri API).
#  1) Inserează echipele referite în fixtures/fixtures_history dar lipsă din teams.
#  2) Completează logo NULL cu URL-ul CDN STANDARD API-Football, construit din
#     team_id (același pattern ca logo-urile existente — e un șir, nu un apel API).
#  Echipele al căror logo CDN dă 404 sunt acoperite în UI de fallback-ul cu inițiale.
#  Credențiale din .env. Rulare:  bash scripts/backfill-team-logos.sh
# ============================================================================
APP_DIR="/root/scannerv2"
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi
P(){ psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off -tAc "$1"; }

echo "BACKFILL TEAM LOGOS — $(date '+%Y-%m-%d %H:%M:%S')"

echo "── Stare inițială ──"
echo "  teams total:        $(P "SELECT count(*) FROM teams")"
echo "  teams fără logo:     $(P "SELECT count(*) FROM teams WHERE logo IS NULL OR btrim(logo)=''")"
REF_MISSING=$(P "
  WITH refs AS (
    SELECT home_team_id AS id FROM fixtures WHERE home_team_id IS NOT NULL
    UNION SELECT away_team_id FROM fixtures WHERE away_team_id IS NOT NULL
    UNION SELECT home_team_id FROM fixtures_history WHERE home_team_id IS NOT NULL
    UNION SELECT away_team_id FROM fixtures_history WHERE away_team_id IS NOT NULL)
  SELECT count(*) FROM refs r WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.team_id=r.id)")
echo "  echipe referite dar LIPSĂ din teams: ${REF_MISSING}"

# 1) Inserează echipele lipsă (nume din fixtures, logo = CDN standard).
INS=$(P "
  WITH refs AS (
    SELECT home_team_id AS id, MAX(home_team_name) AS name FROM fixtures WHERE home_team_id IS NOT NULL GROUP BY 1
    UNION SELECT away_team_id, MAX(away_team_name) FROM fixtures WHERE away_team_id IS NOT NULL GROUP BY 1
    UNION SELECT home_team_id, MAX(home_team_name) FROM fixtures_history WHERE home_team_id IS NOT NULL GROUP BY 1
    UNION SELECT away_team_id, MAX(away_team_name) FROM fixtures_history WHERE away_team_id IS NOT NULL GROUP BY 1)
  INSERT INTO teams (team_id, name, logo, updated_at)
  SELECT r.id, MAX(r.name),
         'https://media.api-sports.io/football/teams/'||r.id||'.png', NOW()
    FROM refs r
   WHERE r.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.team_id=r.id)
   GROUP BY r.id
  ON CONFLICT (team_id) DO NOTHING
  RETURNING 1")
echo "── 1) Echipe inserate (lipsă): $(echo "$INS" | grep -c 1)"

# 2) Completează logo NULL/empty cu URL-ul CDN standard.
UPD=$(P "
  UPDATE teams
     SET logo='https://media.api-sports.io/football/teams/'||team_id||'.png', updated_at=NOW()
   WHERE logo IS NULL OR btrim(logo)=''
  RETURNING 1")
echo "── 2) Logo-uri completate (erau NULL): $(echo "$UPD" | grep -c 1)"

echo "── Stare finală ──"
echo "  teams total:        $(P "SELECT count(*) FROM teams")"
echo "  teams fără logo:     $(P "SELECT count(*) FROM teams WHERE logo IS NULL OR btrim(logo)=''")"
echo ""
echo "Notă: toate logo-urile folosesc CDN-ul API-Football (teams/<id>.png). Cele care"
echo "      dau 404 (echipă necunoscută CDN-ului) apar în UI cu inițiale (fallback)."
echo "GATA."
