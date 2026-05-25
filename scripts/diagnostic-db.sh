#!/bin/bash
# Diagnostic complet: date colectate vs folosite in predictie
PSQL="PGPASSWORD=Firenze225854 psql -U alohascan -d elefant -h 127.0.0.1 -c"

echo ""
echo "══════════════════════════════════════════════════════"
echo " ALOHASCAN — DIAGNOSTIC DATE → PREDICTIE"
echo "══════════════════════════════════════════════════════"

echo ""
echo "── 1. TOATE TABELELE (randuri) ──────────────────────"
eval $PSQL "SELECT relname AS tabel, n_live_tup AS randuri FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"

echo ""
echo "── 2. COLOANE coach_stats ───────────────────────────"
eval $PSQL "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='coach_stats' ORDER BY ordinal_position;"

echo ""
echo "── 3. COLOANE referee_stats ─────────────────────────"
eval $PSQL "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='referee_stats' ORDER BY ordinal_position;"

echo ""
echo "── 4. INJURIES ──────────────────────────────────────"
eval $PSQL "SELECT COUNT(*) AS total, COUNT(CASE WHEN updated_at > NOW()-INTERVAL '7 days' THEN 1 END) AS recente_7z, MAX(updated_at) AS ultima FROM injuries;"

echo ""
echo "── 5. VENUES — altitude completat? ─────────────────"
eval $PSQL "SELECT COUNT(*) AS total, COUNT(CASE WHEN altitude_m>0 THEN 1 END) AS cu_altitudine, COUNT(CASE WHEN altitude_m IS NULL THEN 1 END) AS null_altitude, COUNT(CASE WHEN surface IS NOT NULL THEN 1 END) AS cu_suprafata FROM venues;"

echo ""
echo "── 6. TEAMS_STATS — coloane ─────────────────────────"
eval $PSQL "SELECT column_name FROM information_schema.columns WHERE table_name='teams_stats' ORDER BY ordinal_position;"

echo ""
echo "── 7. TEAMS_STATS — sample ──────────────────────────"
eval $PSQL "SELECT team_id, league_id, avg_goals_for, avg_goals_against, clean_sheets_total, played_total FROM teams_stats LIMIT 3;"

echo ""
echo "── 8. COACH_STATS — sample complet ──────────────────"
eval $PSQL "SELECT * FROM coach_stats LIMIT 3;"

echo ""
echo "── 9. REFEREE_STATS — coloane noi ───────────────────"
eval $PSQL "SELECT referee_name, total_matches, home_win_rate, card_bias_score FROM referee_stats WHERE home_win_rate IS NOT NULL LIMIT 5;"

echo ""
echo "── 10. ODDS — fixtures cu cote ──────────────────────"
eval $PSQL "SELECT COUNT(DISTINCT fixture_id) AS fixtures_cu_cote, COUNT(*) AS total_randuri, MAX(updated_at) AS ultima_cota FROM odds;"

echo ""
echo "── 11. FORM_STATS — sample ──────────────────────────"
eval $PSQL "SELECT team_id, last5_home, last5_away, avg_scored_home, avg_conceded_home FROM form_stats ORDER BY updated_at DESC LIMIT 5;"

echo ""
echo "── 12. COACHES JOIN coach_stats ─────────────────────"
eval $PSQL "SELECT c.team_id, c.name, cs.win_rate, cs.goals_for_avg, cs.goals_against_avg FROM coaches c JOIN coach_stats cs ON cs.coach_id=c.coach_id LIMIT 5;"

echo ""
echo "── 13. PREMATCH_DATA — pe tipuri ────────────────────"
eval $PSQL "SELECT data_type, COUNT(DISTINCT fixture_id) AS fixtures FROM prematch_data GROUP BY data_type ORDER BY fixtures DESC;"

echo ""
echo "══════════════════════════════════════════════════════"
echo " DONE"
echo "══════════════════════════════════════════════════════"
