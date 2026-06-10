#!/bin/bash
# ============================================================================
#  diag-coverage.sh — DIAGNOSTIC READ-ONLY pentru hrănirea vectorilor ML live.
#  Credențiale DB EXCLUSIV din /root/scannerv2/.env (POSTGRES_URL). Zero scriere.
#  Rulare:  bash scripts/diag-coverage.sh
# ============================================================================
APP_DIR="/root/scannerv2"
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi
Q() { echo ""; echo "── $1 ──"; psql "${PGURL}" -X -v ON_ERROR_STOP=0 -c "$2" 2>&1 || echo "  (eroare, continuă)"; }

echo "DIAGNOSTIC COVERAGE — $(date '+%Y-%m-%d %H:%M:%S')"

Q "1a. fixtures_history cu referee NOT NULL" \
  "SELECT COUNT(*) FILTER (WHERE referee IS NOT NULL AND btrim(referee)<>'') AS cu_referee,
          COUNT(*) AS total FROM fixtures_history;"
Q "1b. Sample 10 nume arbitri (atenție sufix ', Country')" \
  "SELECT DISTINCT referee FROM fixtures_history
    WHERE referee IS NOT NULL AND btrim(referee)<>'' ORDER BY referee LIMIT 10;"

Q "2. referee_stats — rânduri + perioadă" \
  "SELECT COUNT(*) AS randuri, MIN(updated_at) AS cel_mai_vechi, MAX(updated_at) AS cel_mai_nou
     FROM referee_stats;"

Q "3. fixtures_history cu/fără statistici de meci (match_stats), pe an" \
  "SELECT EXTRACT(YEAR FROM fh.match_date)::int AS an,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM match_stats ms WHERE ms.fixture_id=fh.fixture_id)) AS cu_stats,
          COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM match_stats ms WHERE ms.fixture_id=fh.fixture_id)) AS fara_stats
     FROM fixtures_history fh
    WHERE fh.match_date >= '2023-01-01' AND fh.status_short='FT'
    GROUP BY 1 ORDER BY 1;"

Q "4. (league_id, season) distincte: fixtures_history vs standings" \
  "SELECT
     (SELECT COUNT(*) FROM (SELECT DISTINCT league_id, season FROM fixtures_history WHERE match_date>='2023-01-01') a) AS ls_history,
     (SELECT COUNT(*) FROM (SELECT DISTINCT league_id, season FROM standings) b) AS ls_standings;"

Q "5. fixtures din fereastra live (2023+) cu/fără rând în ml_features" \
  "SELECT COUNT(*) AS fixturi_2023plus,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM ml_features mf WHERE mf.fixture_id=fh.fixture_id)) AS cu_ml_features,
          COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ml_features mf WHERE mf.fixture_id=fh.fixture_id)) AS fara_ml_features
     FROM fixtures_history fh
    WHERE fh.match_date >= '2023-01-01'
      AND fh.home_team_id IS NOT NULL AND fh.away_team_id IS NOT NULL
      AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL;"

echo ""; echo "DIAGNOSTIC COMPLET."
