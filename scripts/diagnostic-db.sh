#!/bin/bash
# =============================================================================
# ALOHASCAN — DIAGNOSTIC COMPLET: CE? CAND? CUM? UNDE?
# Rulare: bash scripts/diagnostic-db.sh 2>&1 | tee /tmp/diag-$(date +%Y%m%d-%H%M).txt
# =============================================================================
Q="PGPASSWORD=Firenze225854 psql -U alohascan -d elefant -h 127.0.0.1 -c"

hr() { echo ""; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }
h1() { hr; echo "  $1"; hr; }
h2() { echo ""; echo "  ── $1"; }

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║      ALOHASCAN — DIAGNOSTIC COMPLET  $(date '+%d.%m.%Y %H:%M')             ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"

# =============================================================================
h1 "A. INFRASTRUCTURA — TOATE TABELELE"
# =============================================================================

h2 "A1. Randuri + ultima actualizare per tabel"
eval $Q "
SELECT
  t.relname                          AS tabel,
  t.n_live_tup                       AS randuri,
  pg_size_pretty(pg_total_relation_size(t.relid)) AS marime,
  to_char(MAX(s.last_analyze), 'DD.MM HH24:MI') AS ultima_analiza
FROM pg_stat_user_tables t
LEFT JOIN pg_stat_user_tables s ON s.relid = t.relid
GROUP BY t.relid, t.relname, t.n_live_tup
ORDER BY t.n_live_tup DESC;"

h2 "A2. Ultima actualizare reala per tabel (din date)"
eval $Q "
SELECT 'player_stats'     AS tabel, MAX(created_at)::date AS ultima_data FROM player_stats
UNION ALL
SELECT 'fixtures_history', MAX(match_date)::date           FROM fixtures_history
UNION ALL
SELECT 'match_stats',      MAX(created_at)::date           FROM match_stats
UNION ALL
SELECT 'match_events',     MAX(created_at)::date           FROM match_events
UNION ALL
SELECT 'form_stats',       MAX(updated_at)::date           FROM form_stats
UNION ALL
SELECT 'odds',             MAX(updated_at)::date           FROM odds
UNION ALL
SELECT 'referee_stats',    MAX(updated_at)::date           FROM referee_stats
UNION ALL
SELECT 'coach_stats',      MAX(updated_at)::date           FROM coach_stats
UNION ALL
SELECT 'teams_stats',      MAX(updated_at)::date           FROM teams_stats
UNION ALL
SELECT 'standings',        MAX(updated_at)::date           FROM standings
UNION ALL
SELECT 'h2h',              MAX(updated_at)::date           FROM h2h
UNION ALL
SELECT 'injuries',         MAX(updated_at)::date           FROM injuries
ORDER BY ultima_data DESC NULLS LAST;"

# =============================================================================
h1 "B. CRON JOBS — CAND A RULAT FIECARE?"
# =============================================================================

h2 "B1. Ultimele rulari per job (succes/eroare)"
eval $Q "
SELECT
  job_name,
  COUNT(*)                                    AS total_rulari,
  MAX(ran_at)::timestamp(0)                   AS ultima_rulare,
  COUNT(CASE WHEN status='success' THEN 1 END) AS succese,
  COUNT(CASE WHEN status!='success' THEN 1 END) AS erori,
  MAX(fixtures_processed)                      AS max_procesate
FROM cron_logs
GROUP BY job_name
ORDER BY ultima_rulare DESC;"

h2 "B2. Ultimele 10 rulari (toate job-urile)"
eval $Q "
SELECT job_name, to_char(ran_at,'DD.MM HH24:MI') AS cand, status, fixtures_processed
FROM cron_logs
ORDER BY ran_at DESC
LIMIT 10;"

# =============================================================================
h1 "C. MECIURI — CE AVEM SI CE NE LIPSESTE"
# =============================================================================

h2 "C1. Fixtures viitoare (NS) — urmatoarele 7 zile"
eval $Q "
SELECT
  COUNT(*)                                           AS total_ns,
  COUNT(CASE WHEN match_date::date = CURRENT_DATE THEN 1 END) AS azi,
  MIN(match_date)::timestamp(0)                      AS primul,
  MAX(match_date)::timestamp(0)                      AS ultimul
FROM fixtures
WHERE status_short = 'NS'
  AND match_date BETWEEN NOW() AND NOW() + INTERVAL '7 days';"

h2 "C2. Coverage date per fixture (meciuri urmatoarele 3 zile)"
eval $Q "
SELECT
  COUNT(DISTINCT f.fixture_id)                                         AS total_fixtures,
  COUNT(DISTINCT o.fixture_id)                                         AS cu_odds,
  COUNT(DISTINCT pd_h2h.fixture_id)                                    AS cu_h2h_prematch,
  COUNT(DISTINCT pd_inj.fixture_id)                                    AS cu_injuries_prematch,
  COUNT(DISTINCT pd_pred.fixture_id)                                   AS cu_predictions_api,
  COUNT(DISTINCT pd_lin.fixture_id)                                    AS cu_lineups_prematch,
  COUNT(DISTINCT i.fixture_id)                                         AS cu_injuries_db,
  COUNT(DISTINCT pd_coach.fixture_id)                                  AS cu_coaches_prematch
FROM fixtures f
LEFT JOIN odds o                ON o.fixture_id = f.fixture_id
LEFT JOIN prematch_data pd_h2h  ON pd_h2h.fixture_id = f.fixture_id  AND pd_h2h.data_type = 'h2h'
LEFT JOIN prematch_data pd_inj  ON pd_inj.fixture_id = f.fixture_id  AND pd_inj.data_type = 'injuries'
LEFT JOIN prematch_data pd_pred ON pd_pred.fixture_id = f.fixture_id AND pd_pred.data_type = 'predictions'
LEFT JOIN prematch_data pd_lin  ON pd_lin.fixture_id = f.fixture_id  AND pd_lin.data_type = 'lineups'
LEFT JOIN prematch_data pd_coach ON pd_coach.fixture_id = f.fixture_id AND pd_coach.data_type = 'coaches'
LEFT JOIN injuries i            ON i.fixture_id = f.fixture_id
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '3 days';"

h2 "C3. Fixtures_history — acoperire temporala"
eval $Q "
SELECT
  DATE_TRUNC('month', match_date)::date AS luna,
  COUNT(*)                               AS meciuri,
  COUNT(CASE WHEN referee IS NOT NULL AND referee != '' THEN 1 END) AS cu_arbitru
FROM fixtures_history
GROUP BY luna
ORDER BY luna DESC
LIMIT 12;"

# =============================================================================
h1 "D. CALITATEA DATELOR — NULL RATES SI COMPLETITUDINE"
# =============================================================================

h2 "D1. coach_stats — coloane existente si null rate"
eval $Q "
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'coach_stats'
ORDER BY ordinal_position;"

eval $Q "
SELECT
  COUNT(*)                                                      AS total,
  COUNT(win_rate)                                               AS cu_win_rate,
  COUNT(goals_for_avg)                                          AS cu_goals_for_avg,
  COUNT(clean_sheet_rate)                                       AS cu_clean_sheet_rate,
  COUNT(CASE WHEN column_to_check IS NOT NULL THEN 1 END)       AS style_col_test
FROM coach_stats,
     (SELECT COUNT(*) AS column_to_check
      FROM information_schema.columns
      WHERE table_name='coach_stats' AND column_name='style') x;" 2>/dev/null || \
eval $Q "SELECT COUNT(*) AS total, COUNT(win_rate) AS cu_win_rate, COUNT(goals_for_avg) AS cu_goals_for FROM coach_stats;"

h2 "D2. coach_stats — coloana 'style' exista? (enrich.js o cere!)"
eval $Q "
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='coach_stats' AND column_name='style'
  ) THEN 'DA — style exista'
  ELSE 'NU — style LIPSESTE — enrich.js esueaza silentios!'
END AS status_coloana_style;"

h2 "D3. coach_stats — coloana 'tenure_days' exista?"
eval $Q "
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='coach_stats' AND column_name='tenure_days'
  ) THEN 'DA — tenure_days exista'
  ELSE 'NU — tenure_days LIPSESTE'
END AS status;"

h2 "D4. referee_stats — coloane extinse populate?"
eval $Q "
SELECT
  COUNT(*)                                       AS total_arbitri,
  COUNT(home_win_rate)                           AS cu_home_win_rate,
  COUNT(card_bias_score)                         AS cu_card_bias,
  COUNT(pct_over_3_5_cards)                      AS cu_pct_cards,
  COUNT(avg_yellow_h1)                           AS cu_avg_yellow_h1,
  ROUND(AVG(home_win_rate),2)                    AS medie_home_wr,
  ROUND(AVG(card_bias_score),2)                  AS medie_bias
FROM referee_stats;"

h2 "D5. referee_stats — coloana avg_yellow_cards exista? (enrich.js o cere!)"
eval $Q "
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='referee_stats' AND column_name='avg_yellow_cards'
  ) THEN 'DA — avg_yellow_cards exista'
  ELSE 'NU — avg_yellow_cards LIPSESTE — enrich.js citeste NULL!'
END AS status;"

h2 "D6. venues — altitudine si suprafata"
eval $Q "
SELECT
  COUNT(*)                                          AS total_venues,
  COUNT(CASE WHEN altitude_m > 0 THEN 1 END)        AS cu_altitudine_reala,
  COUNT(CASE WHEN altitude_m = 0 THEN 1 END)        AS altitude_zero,
  COUNT(CASE WHEN altitude_m IS NULL THEN 1 END)    AS altitude_null,
  COUNT(CASE WHEN surface IS NOT NULL THEN 1 END)   AS cu_suprafata,
  MAX(altitude_m)                                   AS max_altitudine
FROM venues;"

h2 "D7. injuries — coverage per fixture"
eval $Q "
SELECT
  COUNT(DISTINCT fixture_id)                                              AS fixtures_cu_injuries,
  COUNT(*)                                                               AS total_randuri,
  COUNT(CASE WHEN updated_at > NOW()-INTERVAL '7 days' THEN 1 END)       AS recente_7z,
  COUNT(CASE WHEN updated_at > NOW()-INTERVAL '30 days' THEN 1 END)      AS recente_30z,
  MAX(updated_at)::timestamp(0)                                          AS ultima_actualizare
FROM injuries;"

h2 "D8. odds — freshness si acoperire"
eval $Q "
SELECT
  COUNT(DISTINCT fixture_id)                                            AS fixtures_cu_cote,
  COUNT(DISTINCT bookmaker_id)                                          AS bookmakers,
  COUNT(DISTINCT bet_name)                                              AS tipuri_piete,
  MAX(updated_at)::timestamp(0)                                        AS ultima_cota,
  COUNT(CASE WHEN updated_at > NOW()-INTERVAL '24h' THEN 1 END)        AS actualizate_azi
FROM odds;"

h2 "D9. form_stats — acoperire si freshness"
eval $Q "
SELECT
  COUNT(*)                                                              AS total,
  COUNT(CASE WHEN avg_scored_home IS NOT NULL THEN 1 END)               AS cu_avg_scored,
  COUNT(CASE WHEN last5_home IS NOT NULL THEN 1 END)                    AS cu_last5,
  MAX(updated_at)::timestamp(0)                                        AS ultima_actualizare,
  COUNT(CASE WHEN updated_at > NOW()-INTERVAL '7 days' THEN 1 END)     AS recente_7z
FROM form_stats;"

h2 "D10. teams_stats — coloane si calitate"
eval $Q "
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name='teams_stats'
ORDER BY ordinal_position;"

eval $Q "
SELECT
  COUNT(*)                                          AS total_perechi,
  COUNT(DISTINCT team_id)                           AS echipe_unice,
  COUNT(DISTINCT league_id)                         AS ligi_unice,
  COUNT(CASE WHEN avg_goals_for IS NOT NULL THEN 1 END) AS cu_avg_goals,
  ROUND(AVG(avg_goals_for),2)                       AS medie_goluri_for,
  ROUND(AVG(avg_goals_against),2)                   AS medie_goluri_ag
FROM teams_stats;"

h2 "D11. standings — freshness"
eval $Q "
SELECT
  COUNT(*)                          AS total_randuri,
  COUNT(DISTINCT league_id)         AS ligi,
  MAX(updated_at)::timestamp(0)     AS ultima_actualizare,
  COUNT(CASE WHEN updated_at > NOW()-INTERVAL '7 days' THEN 1 END) AS recente_7z
FROM standings;"

h2 "D12. h2h — acoperire si recenta"
eval $Q "
SELECT
  COUNT(*)                          AS total_meciuri_h2h,
  COUNT(DISTINCT home_team_id || '-' || away_team_id) AS perechi_unice,
  MIN(match_date)::date             AS cel_mai_vechi,
  MAX(match_date)::date             AS cel_mai_recent,
  COUNT(CASE WHEN match_date > NOW()-INTERVAL '1 year' THEN 1 END) AS ultimul_an
FROM h2h;"

# =============================================================================
h1 "E. PREMATCH_DATA — CE COLECTAM SI CE NU FOLOSIM"
# =============================================================================

h2 "E1. Tipuri de date colectate in prematch_data"
eval $Q "
SELECT
  data_type,
  COUNT(DISTINCT fixture_id)        AS fixtures,
  COUNT(*)                          AS total_randuri,
  MAX(collected_at)::timestamp(0)   AS ultima_colectare
FROM prematch_data
GROUP BY data_type
ORDER BY fixtures DESC;"

h2 "E2. Predictions API — sample payload (ce ne da API-Football)"
eval $Q "
SELECT fixture_id, LEFT(payload::text, 400) AS sample_predictions
FROM prematch_data
WHERE data_type = 'predictions'
ORDER BY collected_at DESC
LIMIT 2;"

h2 "E3. Injuries prematch — sample"
eval $Q "
SELECT fixture_id, LEFT(payload::text, 300) AS sample_injuries
FROM prematch_data
WHERE data_type = 'injuries'
ORDER BY collected_at DESC
LIMIT 2;"

h2 "E4. Fixtures cu date complete prematch (toate stage-urile)"
eval $Q "
SELECT
  fixture_id,
  COUNT(DISTINCT data_type) AS tipuri_date,
  STRING_AGG(data_type, ', ' ORDER BY data_type) AS ce_are
FROM prematch_data
GROUP BY fixture_id
HAVING COUNT(DISTINCT data_type) >= 5
ORDER BY tipuri_date DESC
LIMIT 5;"

# =============================================================================
h1 "F. LANTUL DE DATE — FUNCTIONEAZA JOIN-URILE?"
# =============================================================================

h2 "F1. coaches → coach_stats JOIN (folosit de enrich.js)"
eval $Q "
SELECT
  COUNT(*) AS total_coaches,
  COUNT(cs.coach_id) AS cu_coach_stats,
  COUNT(*) - COUNT(cs.coach_id) AS fara_stats
FROM coaches c
LEFT JOIN coach_stats cs ON cs.coach_id = c.coach_id
LIMIT 1;"

h2 "F2. Sample: antrenori cu stats complete"
eval $Q "
SELECT c.name, c.team_id, cs.win_rate, cs.goals_for_avg, cs.goals_against_avg, cs.clean_sheet_rate
FROM coaches c
JOIN coach_stats cs ON cs.coach_id = c.coach_id
WHERE cs.win_rate IS NOT NULL
LIMIT 5;"

h2 "F3. fixtures → referee_stats JOIN (arbitri din meciuri viitoare)"
eval $Q "
SELECT
  COUNT(DISTINCT f.fixture_id)                          AS total_fixture,
  COUNT(DISTINCT f.fixture_id) FILTER
    (WHERE rs.referee_name IS NOT NULL)                 AS cu_arbitru_in_stats,
  COUNT(DISTINCT f.fixture_id) FILTER
    (WHERE f.referee IS NULL OR f.referee = '')         AS fara_arbitru_in_fixture
FROM fixtures f
LEFT JOIN referee_stats rs ON rs.referee_name = f.referee
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '7 days';"

h2 "F4. fixtures → teams_stats JOIN (echipe din meciuri viitoare)"
eval $Q "
SELECT
  COUNT(DISTINCT f.fixture_id)                AS total_fixtures,
  COUNT(DISTINCT f.fixture_id) FILTER
    (WHERE ts_h.team_id IS NOT NULL)           AS cu_home_team_stats,
  COUNT(DISTINCT f.fixture_id) FILTER
    (WHERE ts_a.team_id IS NOT NULL)           AS cu_away_team_stats
FROM fixtures f
LEFT JOIN teams_stats ts_h ON ts_h.team_id = f.home_team_id AND ts_h.league_id = f.league_id
LEFT JOIN teams_stats ts_a ON ts_a.team_id = f.away_team_id AND ts_a.league_id = f.league_id
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '3 days';"

h2 "F5. fixtures → form_stats JOIN (forma echipelor din meciuri viitoare)"
eval $Q "
SELECT
  COUNT(DISTINCT f.fixture_id)                AS total_fixtures,
  COUNT(DISTINCT f.fixture_id) FILTER
    (WHERE fs_h.team_id IS NOT NULL)           AS cu_home_form,
  COUNT(DISTINCT f.fixture_id) FILTER
    (WHERE fs_a.team_id IS NOT NULL)           AS cu_away_form
FROM fixtures f
LEFT JOIN form_stats fs_h ON fs_h.team_id = f.home_team_id
LEFT JOIN form_stats fs_a ON fs_a.team_id = f.away_team_id
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '3 days';"

# =============================================================================
h1 "G. PLAYER_STATS — BACKFILL SI CALITATE"
# =============================================================================

h2 "G1. Acoperire temporala player_stats"
eval $Q "
SELECT
  DATE_TRUNC('month', created_at)::date  AS luna,
  COUNT(*)                               AS randuri,
  COUNT(DISTINCT team_id)                AS echipe
FROM player_stats
GROUP BY luna
ORDER BY luna DESC
LIMIT 12;"

h2 "G2. Calitate date player_stats"
eval $Q "
SELECT
  COUNT(*)                                          AS total,
  COUNT(rating)                                     AS cu_rating,
  COUNT(goals)                                      AS cu_goals,
  COUNT(pass_accuracy)                              AS cu_pass_acc,
  COUNT(shots_on_target)                            AS cu_sot,
  ROUND(AVG(rating),2)                              AS medie_rating,
  COUNT(CASE WHEN rating IS NULL THEN 1 END)        AS null_rating
FROM player_stats;"

h2 "G3. Top echipe dupa volum player_stats (cele mai bine acoperite)"
eval $Q "
SELECT team_id, COUNT(*) AS randuri, MAX(created_at)::date AS ultima
FROM player_stats
GROUP BY team_id
ORDER BY randuri DESC
LIMIT 10;"

# =============================================================================
h1 "H. LIVE SYSTEM — CE SE INTAMPLA ACUM"
# =============================================================================

h2 "H1. Meciuri live active (match_snapshots)"
eval $Q "
SELECT
  COUNT(DISTINCT fixture_id)     AS fixtures_live,
  MAX(captured_at)::timestamp(0) AS ultima_captura,
  MIN(captured_at)::timestamp(0) AS prima_captura
FROM match_snapshots
WHERE captured_at > NOW() - INTERVAL '3 hours';"

h2 "H2. Alerte NGP recente (ultimele 24h)"
eval $Q "
SELECT alert_type, COUNT(*) AS total,
       COUNT(CASE WHEN telegram_ok THEN 1 END) AS trimise_telegram
FROM alerts
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY alert_type;"

h2 "H3. Live_stats — recenta"
eval $Q "
SELECT
  COUNT(DISTINCT fixture_id)     AS fixtures_cu_live_stats,
  MAX(recorded_at)::timestamp(0) AS ultima_inregistrare
FROM live_stats
WHERE recorded_at > NOW() - INTERVAL '3 hours';"

# =============================================================================
h1 "I. PREDICTIONS — CALITATE PREDICTII"
# =============================================================================

h2 "I1. Predictii — acoperire si rezultate cunoscute"
eval $Q "
SELECT
  COUNT(*)                                                  AS total_predictii,
  COUNT(result_over15)                                      AS cu_rezultat_cunoscut,
  COUNT(*) - COUNT(result_over15)                           AS fara_rezultat,
  COUNT(CASE WHEN result_over15 = true THEN 1 END)          AS over15_reale,
  COUNT(CASE WHEN over15_prob > 65 THEN 1 END)              AS predictii_confident,
  MAX(predicted_at)::date                                   AS ultima_predictie
FROM predictions;"

h2 "I2. Brier score estimat din predictii verificate"
eval $Q "
SELECT
  COUNT(*)                                          AS sample,
  ROUND(AVG(POWER(
    CASE WHEN result_over15 THEN 1.0 ELSE 0.0 END -
    (over15_prob / 100.0), 2))::numeric, 4)         AS brier_score_over15
FROM predictions
WHERE result_over15 IS NOT NULL
  AND over15_prob IS NOT NULL;"

# =============================================================================
h1 "J. REZUMAT FINAL — DIAGNOSTIC"
# =============================================================================

h2 "J1. DATE UTILE PENTRU PREDICTII — STATUS"
eval $Q "
SELECT
  'player_stats (getTeamStrengths)'   AS sursa,
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(*) || ' randuri'
       ELSE 'GOLA - PROBLEMA!' END    AS status
FROM player_stats
UNION ALL
SELECT 'form_stats (Layer 2)',
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(*) || ' randuri'
       ELSE 'GOL - PROBLEMA!' END FROM form_stats
UNION ALL
SELECT 'h2h (Layer 3)',
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(*) || ' randuri'
       ELSE 'GOL - PROBLEMA!' END FROM h2h
UNION ALL
SELECT 'referee_stats (impact arbitru)',
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(*) || ' arbitri'
       ELSE 'GOL - PROBLEMA!' END FROM referee_stats
UNION ALL
SELECT 'coach_stats (impact antrenor)',
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(*) || ' antrenori'
       ELSE 'GOL - PROBLEMA!' END FROM coach_stats
UNION ALL
SELECT 'teams_stats (lambda fallback)',
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(*) || ' perechi'
       ELSE 'GOL - PROBLEMA!' END FROM teams_stats
UNION ALL
SELECT 'odds (EV + Kelly)',
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(DISTINCT fixture_id) || ' fixtures'
       ELSE 'GOL - PROBLEMA!' END FROM odds
UNION ALL
SELECT 'injuries (penalizare)',
  CASE WHEN COUNT(*) > 0 THEN 'OK - ' || COUNT(DISTINCT fixture_id) || ' fixtures'
       ELSE 'GOL sau GOLA - verifica!' END FROM injuries
UNION ALL
SELECT 'prematch predictions API (nefolosit!)',
  CASE WHEN COUNT(*) > 0 THEN 'DATE EXIST - ' || COUNT(DISTINCT fixture_id) || ' fix dar NECITITE in enrich.js'
       ELSE 'GOL' END FROM prematch_data WHERE data_type='predictions'
UNION ALL
SELECT 'venues altitude (impact altitude)',
  CASE WHEN COUNT(*) > 0 THEN 'PROBLEMA - toate 0! OpenElevation nerulatat'
       ELSE 'OK' END FROM venues WHERE altitude_m = 0 OR altitude_m IS NULL;"

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║                    DIAGNOSTIC COMPLET - DONE                        ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Salveaza output cu:"
echo "  bash scripts/diagnostic-db.sh 2>&1 | tee /tmp/diag-\$(date +%Y%m%d-%H%M).txt"
echo ""
