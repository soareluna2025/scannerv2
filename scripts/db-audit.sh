#!/usr/bin/env bash
# ================================================================
#  AlohaScan — DB Audit Script
#  Rulează direct pe VPS: bash /root/scannerv2/scripts/db-audit.sh
# ================================================================
set -euo pipefail

ENV_FILE="/root/scannerv2/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "EROARE: $ENV_FILE nu există. Rulează după deploy." >&2
  exit 1
fi

POSTGRES_URL=$(grep '^POSTGRES_URL=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$POSTGRES_URL" ]; then
  echo "EROARE: POSTGRES_URL lipsește din .env" >&2
  exit 1
fi

PGPASSWORD=$(echo "$POSTGRES_URL" | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|')
PGUSER=$(echo "$POSTGRES_URL" | sed 's|.*://\([^:]*\):.*|\1|')
PGHOST=$(echo "$POSTGRES_URL" | sed 's|.*@\([^:/]*\).*|\1|')
PGPORT=$(echo "$POSTGRES_URL" | sed 's|.*:\([0-9]*\)/.*|\1|')
PGDATABASE=$(echo "$POSTGRES_URL" | sed 's|.*/\([^?]*\).*|\1|')

export PGPASSWORD PGUSER PGHOST PGPORT PGDATABASE

psql_cmd() {
  psql -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE" -c "$1" 2>/dev/null
}

psql_quiet() {
  psql -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE" -t -A -c "$1" 2>/dev/null
}

echo "================================================================"
echo " AlohaScan — AUDIT DB PostgreSQL"
echo " Data: $(date '+%d.%m.%Y %H:%M')"
echo " DB: $PGDATABASE @ $PGHOST:$PGPORT"
echo "================================================================"
echo ""

# ────────────────────────────────────────────────────────────────
echo "═══ PASUL 1: INVENTAR — tabele, rânduri, dimensiune ═══════"
echo ""

psql_cmd "
SELECT
  relname                     AS tabel,
  n_live_tup                  AS randuri_estimate,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS dimensiune
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;
"

echo ""
echo "── Total tabele:"
psql_cmd "SELECT COUNT(*) AS total_tabele FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"

echo ""
echo "── Dimensiune totală DB:"
psql_cmd "SELECT pg_size_pretty(pg_database_size('$PGDATABASE')) AS dimensiune_totala;"

echo ""

# ────────────────────────────────────────────────────────────────
echo "═══ PASUL 2: CALITATEA DATELOR ════════════════════════════"
echo ""

echo "── fixtures (meciuri):"
psql_cmd "
SELECT
  COUNT(*) AS total,
  COUNT(CASE WHEN status_short='FT' THEN 1 END) AS finished,
  COUNT(CASE WHEN status_short IN ('1H','2H','HT','ET','BT','P','SUSP','INT','LIVE') THEN 1 END) AS live_acum,
  COUNT(CASE WHEN status_short IN ('NS','TBD') THEN 1 END) AS programate,
  MIN(match_date)::date AS primul_meci,
  MAX(match_date)::date AS ultimul_meci,
  COUNT(DISTINCT league_id) AS ligi_distincte
FROM fixtures;
"

echo ""
echo "── fixtures_history (meciuri terminate):"
psql_cmd "
SELECT
  COUNT(*) AS total,
  COUNT(referee) AS cu_arbitru,
  COUNT(*) - COUNT(referee) AS fara_arbitru,
  COUNT(DISTINCT league_id) AS ligi,
  MIN(match_date)::date AS de_la,
  MAX(match_date)::date AS pana_la
FROM fixtures_history;
"

echo ""
echo "── form_stats (forma echipelor):"
psql_cmd "
SELECT
  COUNT(*) AS total_inregistrari,
  COUNT(DISTINCT team_id) AS echipe_distincte,
  COUNT(DISTINCT league_id) AS ligi_distincte,
  COUNT(CASE WHEN avg_scored_home IS NOT NULL THEN 1 END) AS cu_avg_home,
  COUNT(CASE WHEN avg_scored_away IS NOT NULL THEN 1 END) AS cu_avg_away,
  MAX(updated_at)::date AS ultima_actualizare
FROM form_stats;
"

echo ""
echo "── standings (clasamente):"
psql_cmd "
SELECT
  COUNT(*) AS total_inregistrari,
  COUNT(DISTINCT league_id) AS ligi,
  COUNT(DISTINCT season) AS sezoane,
  COUNT(DISTINCT team_id) AS echipe,
  MAX(updated_at)::date AS ultima_actualizare
FROM standings;
"

echo ""
echo "── h2h (meciuri directe):"
psql_cmd "
SELECT
  COUNT(*) AS total_inregistrari,
  COUNT(DISTINCT LEAST(team1_id, team2_id) || '-' || GREATEST(team1_id, team2_id)) AS perechi_distincte,
  MIN(match_date)::date AS de_la,
  MAX(match_date)::date AS pana_la
FROM h2h;
"

echo ""
echo "── player_stats (statistici jucători per meci):"
psql_cmd "
SELECT
  COUNT(*) AS total_inregistrari,
  COUNT(DISTINCT player_id) AS jucatori_unici,
  COUNT(DISTINCT fixture_id) AS meciuri_acoperite,
  COUNT(DISTINCT team_id) AS echipe,
  COUNT(CASE WHEN rating IS NOT NULL THEN 1 END) AS cu_rating,
  COUNT(CASE WHEN pass_accuracy IS NOT NULL THEN 1 END) AS cu_pass_acc,
  ROUND(AVG(rating),2) AS avg_rating,
  MAX(created_at)::date AS ultima_adaugare
FROM player_stats;
"

echo ""
echo "── predictions (predicții Poisson):"
psql_cmd "
SELECT
  COUNT(*) AS total,
  COUNT(CASE WHEN result_over15 IS NOT NULL THEN 1 END) AS cu_rezultat,
  COUNT(CASE WHEN result_over15 = TRUE THEN 1 END) AS over15_da,
  COUNT(CASE WHEN result_over15 = FALSE THEN 1 END) AS over15_nu,
  ROUND(AVG(confidence),1) AS avg_confidence,
  ROUND(AVG(over15_prob),1) AS avg_over15_prob,
  MAX(created_at)::date AS ultima_predictie
FROM predictions;
"

echo ""
echo "── odds (cote bookmaker):"
psql_cmd "
SELECT
  COUNT(*) AS total_inregistrari,
  COUNT(DISTINCT fixture_id) AS meciuri_cu_cote,
  COUNT(DISTINCT bookmaker_id) AS bookmakers,
  COUNT(DISTINCT bet_id) AS tipuri_pariu,
  MAX(collected_at)::date AS ultima_colectare
FROM odds;
"

echo ""
echo "── prematch_data (date pre-meci):"
psql_cmd "
SELECT
  COUNT(*) AS total_inregistrari,
  COUNT(DISTINCT fixture_id) AS meciuri,
  MAX(stage) AS max_stage,
  COUNT(DISTINCT data_type) AS tipuri_date,
  MAX(collected_at)::date AS ultima_colectare
FROM prematch_data;
"

echo ""
echo "── league_stats (statistici ligi):"
psql_cmd "
SELECT
  COUNT(*) AS ligi_cu_stats,
  COUNT(CASE WHEN total_matches >= 10 THEN 1 END) AS ligi_cu_sample_ok,
  ROUND(AVG(avg_goals_per_match),2) AS avg_goluri_global,
  ROUND(AVG(pct_over_15),1) AS avg_pct_over15,
  MAX(updated_at)::date AS ultima_actualizare
FROM league_stats;
"

echo ""
echo "── referee_stats (statistici arbitri):"
psql_cmd "
SELECT
  COUNT(*) AS arbitri_cu_stats,
  COUNT(CASE WHEN total_matches >= 5 THEN 1 END) AS cu_sample_ok,
  ROUND(AVG(avg_goals),2) AS avg_goluri_per_meci,
  ROUND(AVG(avg_yellow_cards),2) AS avg_galbene,
  MAX(updated_at)::date AS ultima_actualizare
FROM referee_stats;
"

echo ""
echo "── alerts (alerte NGP/over15):"
psql_cmd "
SELECT
  COUNT(*) AS total_alerte,
  COUNT(CASE WHEN telegram_ok=TRUE THEN 1 END) AS trimise_telegram,
  COUNT(CASE WHEN telegram_ok=FALSE THEN 1 END) AS neterminate,
  COUNT(DISTINCT alert_type) AS tipuri,
  MAX(sent_at)::date AS ultima_alerta
FROM alerts;
"

echo ""
echo "── cron_logs (log-uri job-uri automate):"
psql_cmd "
SELECT
  job_name,
  COUNT(*) AS rulari,
  COUNT(CASE WHEN status='ok' THEN 1 END) AS ok,
  COUNT(CASE WHEN status='error' THEN 1 END) AS erori,
  MAX(ran_at)::date AS ultima_rulare,
  ROUND(AVG(duration_ms)) AS avg_ms
FROM cron_logs
GROUP BY job_name
ORDER BY MAX(ran_at) DESC;
"

echo ""
echo "── backfill_progress (progres backfill jucători):"
psql_cmd "
SELECT
  status,
  COUNT(*) AS ligi,
  SUM(fixtures_processed) AS fixtures_total,
  SUM(players_upserted) AS jucatori_total
FROM backfill_progress
GROUP BY status
ORDER BY COUNT(*) DESC;
"

echo ""

# ────────────────────────────────────────────────────────────────
echo "═══ PASUL 3: DUPLICATE ════════════════════════════════════"
echo ""

echo "── Duplicate player_stats (player_id + fixture_id):"
psql_cmd "
SELECT COUNT(*) AS perechi_duplicate
FROM (
  SELECT player_id, fixture_id, COUNT(*) AS cnt
  FROM player_stats
  GROUP BY player_id, fixture_id
  HAVING COUNT(*) > 1
) x;
"

echo ""
echo "── Duplicate fixtures (fixture_id duplicat în fixtures):"
psql_cmd "
SELECT COUNT(*) AS fixture_id_duplicate
FROM (
  SELECT fixture_id, COUNT(*) AS cnt
  FROM fixtures
  GROUP BY fixture_id
  HAVING COUNT(*) > 1
) x;
"

echo ""
echo "── Duplicate predictions (fixture_id):"
psql_cmd "
SELECT COUNT(*) AS predictii_duplicate
FROM (
  SELECT fixture_id, COUNT(*) AS cnt
  FROM predictions
  GROUP BY fixture_id
  HAVING COUNT(*) > 1
) x;
"

echo ""
echo "── Duplicate form_stats (team + league + season):"
psql_cmd "
SELECT COUNT(*) AS form_duplicate
FROM (
  SELECT team_id, league_id, season, COUNT(*) AS cnt
  FROM form_stats
  GROUP BY team_id, league_id, season
  HAVING COUNT(*) > 1
) x;
"

echo ""
echo "── Duplicate standings (league + season + team):"
psql_cmd "
SELECT COUNT(*) AS standings_duplicate
FROM (
  SELECT league_id, season, team_id, COUNT(*) AS cnt
  FROM standings
  GROUP BY league_id, season, team_id
  HAVING COUNT(*) > 1
) x;
"

echo ""

# ────────────────────────────────────────────────────────────────
echo "═══ PASUL 4: CE POATE FOLOSI APLICAȚIA ACUM ══════════════"
echo ""

echo "── Poisson (form_stats cu avg_scored+conceded pe ambele fronturi):"
psql_cmd "
SELECT COUNT(*) AS echipe_gata_poisson
FROM form_stats
WHERE avg_scored_home IS NOT NULL
  AND avg_conceded_home IS NOT NULL
  AND avg_scored_away IS NOT NULL
  AND avg_conceded_away IS NOT NULL;
"

echo ""
echo "── H2H (meciuri directe disponibile — min 3 per pereche):"
psql_cmd "
SELECT COUNT(*) AS perechi_cu_min3_meciuri
FROM (
  SELECT LEAST(team1_id, team2_id) AS t1,
         GREATEST(team1_id, team2_id) AS t2,
         COUNT(*) AS cnt
  FROM h2h
  GROUP BY 1, 2
  HAVING COUNT(*) >= 3
) x;
"

echo ""
echo "── Layer 7 Strength (echipe cu player_stats suficient — min 11 jucatori):"
psql_cmd "
SELECT COUNT(DISTINCT team_id) AS echipe_cu_strength
FROM (
  SELECT team_id, COUNT(DISTINCT player_id) AS cnt
  FROM player_stats
  GROUP BY team_id
  HAVING COUNT(DISTINCT player_id) >= 11
) x;
"

echo ""
echo "── League Stats (ligi cu sample suficient — min 20 meciuri):"
psql_cmd "
SELECT COUNT(*) AS ligi_cu_stats_ok
FROM league_stats
WHERE total_matches >= 20;
"

echo ""
echo "── Referee Stats (arbitri cu sample suficient — min 5 meciuri):"
psql_cmd "
SELECT COUNT(*) AS arbitri_cu_stats_ok
FROM referee_stats
WHERE total_matches >= 5;
"

echo ""
echo "── Odds disponibile azi (fixture_id din fixtures NS/programate):"
psql_cmd "
SELECT COUNT(DISTINCT o.fixture_id) AS meciuri_cu_cote_azi
FROM odds o
JOIN fixtures f ON f.fixture_id = o.fixture_id
WHERE f.match_date >= CURRENT_DATE
  AND f.match_date < CURRENT_DATE + INTERVAL '3 days'
  AND f.status_short = 'NS';
"

echo ""
echo "── Prediction log (predicții înregistrate cu outcome):"
psql_cmd "
SELECT
  module,
  COUNT(*) AS total,
  COUNT(CASE WHEN outcome='WIN' THEN 1 END) AS win,
  COUNT(CASE WHEN outcome='LOSS' THEN 1 END) AS loss,
  COUNT(CASE WHEN outcome='PENDING' THEN 1 END) AS pending,
  ROUND(
    100.0 * COUNT(CASE WHEN outcome='WIN' THEN 1 END)
    / NULLIF(COUNT(CASE WHEN outcome IN ('WIN','LOSS') THEN 1 END), 0),
  1) AS win_rate_pct
FROM prediction_log
GROUP BY module
ORDER BY total DESC;
"

echo ""

# ────────────────────────────────────────────────────────────────
echo "═══ PASUL 5: CE LIPSEȘTE ══════════════════════════════════"
echo ""

echo "── Meciuri FT din fixtures_history fără player_stats:"
psql_cmd "
SELECT COUNT(*) AS meciuri_fara_stats
FROM fixtures_history fh
WHERE NOT EXISTS (
  SELECT 1 FROM player_stats ps
  WHERE ps.fixture_id = fh.fixture_id
);
"

echo ""
echo "── Meciuri FT din fixtures fără form_stats pentru echipe:"
psql_cmd "
SELECT COUNT(DISTINCT f.fixture_id) AS meciuri_fara_form
FROM fixtures f
WHERE f.status_short = 'NS'
  AND (
    NOT EXISTS (SELECT 1 FROM form_stats fs WHERE fs.team_id = f.home_team_id)
    OR
    NOT EXISTS (SELECT 1 FROM form_stats fs WHERE fs.team_id = f.away_team_id)
  )
  AND f.match_date >= CURRENT_DATE;
"

echo ""
echo "── Meciuri NS azi fără h2h (nicio pereche de meciuri directe):"
psql_cmd "
SELECT COUNT(*) AS meciuri_fara_h2h
FROM fixtures f
WHERE f.status_short = 'NS'
  AND f.match_date >= CURRENT_DATE
  AND f.match_date < CURRENT_DATE + INTERVAL '3 days'
  AND NOT EXISTS (
    SELECT 1 FROM h2h h
    WHERE (h.team1_id = f.home_team_id AND h.team2_id = f.away_team_id)
       OR (h.team1_id = f.away_team_id AND h.team2_id = f.home_team_id)
  );
"

echo ""
echo "── Meciuri NS azi fără cote:"
psql_cmd "
SELECT COUNT(*) AS meciuri_fara_cote
FROM fixtures f
WHERE f.status_short = 'NS'
  AND f.match_date >= CURRENT_DATE
  AND f.match_date < CURRENT_DATE + INTERVAL '3 days'
  AND NOT EXISTS (
    SELECT 1 FROM odds o WHERE o.fixture_id = f.fixture_id
  );
"

echo ""
echo "── Ligi cu meciuri dar fără league_stats:"
psql_cmd "
SELECT COUNT(DISTINCT f.league_id) AS ligi_fara_stats
FROM fixtures_history f
WHERE NOT EXISTS (
  SELECT 1 FROM league_stats ls WHERE ls.league_id = f.league_id
);
"

echo ""
echo "── Meciuri FT cu arbitru dar fără referee_stats:"
psql_cmd "
SELECT COUNT(DISTINCT fh.referee) AS arbitri_fara_stats
FROM fixtures_history fh
WHERE fh.referee IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM referee_stats rs WHERE rs.referee_name = fh.referee
  );
"

echo ""
echo "── Tabele goale (0 rânduri):"
psql_cmd "
SELECT relname AS tabel, n_live_tup AS randuri
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.n_live_tup = 0
ORDER BY relname;
"

echo ""

# ────────────────────────────────────────────────────────────────
echo "═══ PASUL 6: REZUMAT RAPID ════════════════════════════════"
echo ""

FIXTURES_TOTAL=$(psql_quiet "SELECT COUNT(*) FROM fixtures")
FIXTURES_HISTORY=$(psql_quiet "SELECT COUNT(*) FROM fixtures_history")
PLAYER_STATS=$(psql_quiet "SELECT COUNT(*) FROM player_stats")
FORM_STATS=$(psql_quiet "SELECT COUNT(*) FROM form_stats")
H2H_RECORDS=$(psql_quiet "SELECT COUNT(*) FROM h2h")
PREDICTIONS=$(psql_quiet "SELECT COUNT(*) FROM predictions")
PREDICTIONS_RESOLVED=$(psql_quiet "SELECT COUNT(*) FROM predictions WHERE result_over15 IS NOT NULL")
LEAGUE_STATS=$(psql_quiet "SELECT COUNT(*) FROM league_stats WHERE total_matches >= 20")
REF_STATS=$(psql_quiet "SELECT COUNT(*) FROM referee_stats WHERE total_matches >= 5")
ODDS_RECORDS=$(psql_quiet "SELECT COUNT(*) FROM odds")
PLAYER_TEAMS=$(psql_quiet "SELECT COUNT(DISTINCT team_id) FROM (SELECT team_id, COUNT(DISTINCT player_id) cnt FROM player_stats GROUP BY team_id HAVING COUNT(DISTINCT player_id)>=11) x")

echo "REZUMAT:"
echo "  fixtures (toate):           $FIXTURES_TOTAL"
echo "  fixtures_history (FT):      $FIXTURES_HISTORY"
echo "  player_stats (rânduri):     $PLAYER_STATS"
echo "  form_stats (rânduri):       $FORM_STATS"
echo "  h2h (rânduri):              $H2H_RECORDS"
echo "  predictions (total):        $PREDICTIONS  (rezolvate: $PREDICTIONS_RESOLVED)"
echo "  league_stats (≥20 meciuri): $LEAGUE_STATS"
echo "  referee_stats (≥5 meciuri): $REF_STATS"
echo "  odds (rânduri):             $ODDS_RECORDS"
echo "  echipe cu Layer7 (≥11 juc): $PLAYER_TEAMS"
echo ""
echo "================================================================"
echo " Audit finalizat: $(date '+%d.%m.%Y %H:%M')"
echo "================================================================"
