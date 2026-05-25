-- =============================================================================
-- ALOHASCAN — DIAGNOSTIC COMPLET: CE? CAND? CUM? UNDE?
-- Rulare: bash scripts/diagnostic-db.sh
-- =============================================================================

\echo ''
\echo '╔══════════════════════════════════════════════════════════════════════╗'
\echo '║         ALOHASCAN — DIAGNOSTIC COMPLET DATE → PREDICTIE             ║'
\echo '╚══════════════════════════════════════════════════════════════════════╝'

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  A. INFRASTRUCTURA — TOATE TABELELE'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── A1. Randuri + marime per tabel'
SELECT
  relname                                          AS tabel,
  n_live_tup                                       AS randuri,
  pg_size_pretty(pg_total_relation_size(relid))    AS marime
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

\echo ''
\echo '── A2. Ultima actualizare reala per tabel'
SELECT 'player_stats'     AS tabel, MAX(created_at)::date  AS ultima_data FROM player_stats
UNION ALL
SELECT 'fixtures_history',           MAX(match_date)::date               FROM fixtures_history
UNION ALL
SELECT 'match_stats',                MAX(created_at)::date               FROM match_stats
UNION ALL
SELECT 'match_events',               MAX(created_at)::date               FROM match_events
UNION ALL
SELECT 'form_stats',                 MAX(updated_at)::date               FROM form_stats
UNION ALL
SELECT 'odds',                       MAX(updated_at)::date               FROM odds
UNION ALL
SELECT 'referee_stats',              MAX(updated_at)::date               FROM referee_stats
UNION ALL
SELECT 'coach_stats',                MAX(updated_at)::date               FROM coach_stats
UNION ALL
SELECT 'teams_stats',                MAX(updated_at)::date               FROM teams_stats
UNION ALL
SELECT 'standings',                  MAX(updated_at)::date               FROM standings
UNION ALL
SELECT 'h2h',                        MAX(updated_at)::date               FROM h2h
UNION ALL
SELECT 'injuries',                   MAX(updated_at)::date               FROM injuries
ORDER BY ultima_data DESC NULLS LAST;

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  B. CRON JOBS — CAND A RULAT FIECARE?'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── B1. Sumar per job'
SELECT
  job_name,
  COUNT(*)                                              AS total_rulari,
  MAX(ran_at)::timestamp(0)                             AS ultima_rulare,
  COUNT(*) FILTER (WHERE status = 'success')            AS succese,
  COUNT(*) FILTER (WHERE status != 'success')           AS erori,
  MAX(fixtures_processed)                               AS max_procesate
FROM cron_logs
GROUP BY job_name
ORDER BY ultima_rulare DESC;

\echo ''
\echo '── B2. Ultimele 15 rulari'
SELECT job_name, ran_at::timestamp(0) AS cand, status, fixtures_processed
FROM cron_logs
ORDER BY ran_at DESC
LIMIT 15;

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  C. MECIURI — CE AVEM SI CE NE LIPSESTE'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── C1. Fixtures viitoare (NS) urmatoarele 7 zile'
SELECT
  COUNT(*)                                                          AS total_ns,
  COUNT(*) FILTER (WHERE match_date::date = CURRENT_DATE)           AS azi,
  MIN(match_date)::timestamp(0)                                     AS primul,
  MAX(match_date)::timestamp(0)                                     AS ultimul
FROM fixtures
WHERE status_short = 'NS'
  AND match_date BETWEEN NOW() AND NOW() + INTERVAL '7 days';

\echo ''
\echo '── C2. Coverage date per fixture (urmatoarele 3 zile)'
SELECT
  COUNT(DISTINCT f.fixture_id)                                           AS total_fixtures,
  COUNT(DISTINCT o.fixture_id)                                           AS cu_odds,
  COUNT(DISTINCT pd_h2h.fixture_id)                                      AS cu_h2h_prematch,
  COUNT(DISTINCT pd_inj.fixture_id)                                      AS cu_injuries_prematch,
  COUNT(DISTINCT pd_pred.fixture_id)                                     AS cu_predictions_api,
  COUNT(DISTINCT pd_lin.fixture_id)                                      AS cu_lineups_prematch,
  COUNT(DISTINCT i.fixture_id)                                           AS cu_injuries_db,
  COUNT(DISTINCT pd_coach.fixture_id)                                    AS cu_coaches_prematch
FROM fixtures f
LEFT JOIN odds o                 ON o.fixture_id = f.fixture_id
LEFT JOIN prematch_data pd_h2h   ON pd_h2h.fixture_id  = f.fixture_id AND pd_h2h.data_type  = 'h2h'
LEFT JOIN prematch_data pd_inj   ON pd_inj.fixture_id  = f.fixture_id AND pd_inj.data_type  = 'injuries'
LEFT JOIN prematch_data pd_pred  ON pd_pred.fixture_id = f.fixture_id AND pd_pred.data_type = 'predictions'
LEFT JOIN prematch_data pd_lin   ON pd_lin.fixture_id  = f.fixture_id AND pd_lin.data_type  = 'lineups'
LEFT JOIN prematch_data pd_coach ON pd_coach.fixture_id= f.fixture_id AND pd_coach.data_type= 'coaches'
LEFT JOIN injuries i             ON i.fixture_id = f.fixture_id
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '3 days';

\echo ''
\echo '── C3. fixtures_history — acoperire pe luni (ultimele 12 luni)'
SELECT
  DATE_TRUNC('month', match_date)::date                                   AS luna,
  COUNT(*)                                                                AS meciuri,
  COUNT(*) FILTER (WHERE referee IS NOT NULL AND referee != '')           AS cu_arbitru
FROM fixtures_history
GROUP BY luna
ORDER BY luna DESC
LIMIT 12;

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  D. CALITATEA DATELOR — NULL RATES SI COMPLETITUDINE'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── D1. coach_stats — coloane existente in DB'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'coach_stats'
ORDER BY ordinal_position;

\echo ''
\echo '── D2. coach_stats — coloana style exista? (enrich.js o cere!)'
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='coach_stats' AND column_name='style')
  THEN 'DA — style exista'
  ELSE 'NU — style LIPSESTE — enrich.js esueaza silentios pe fiecare meci!'
END AS status_style;

\echo ''
\echo '── D3. coach_stats — coloana tenure_days exista?'
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='coach_stats' AND column_name='tenure_days')
  THEN 'DA — tenure_days exista'
  ELSE 'NU — tenure_days LIPSESTE'
END AS status_tenure;

\echo ''
\echo '── D4. coach_stats — null rates coloane cheie'
SELECT
  COUNT(*)                              AS total,
  COUNT(win_rate)                       AS cu_win_rate,
  COUNT(goals_for_avg)                  AS cu_goals_for_avg,
  COUNT(clean_sheet_rate)               AS cu_clean_sheet_rate,
  COUNT(over25_rate)                    AS cu_over25_rate
FROM coach_stats;

\echo ''
\echo '── D5. referee_stats — coloane existente'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'referee_stats'
ORDER BY ordinal_position;

\echo ''
\echo '── D6. referee_stats — coloana avg_yellow_cards exista? (enrich.js o cere!)'
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='referee_stats' AND column_name='avg_yellow_cards')
  THEN 'DA — avg_yellow_cards exista'
  ELSE 'NU — avg_yellow_cards LIPSESTE — enrich.js citeste NULL!'
END AS status_avg_yellow;

\echo ''
\echo '── D7. referee_stats — coloane extinse populate?'
SELECT
  COUNT(*)                            AS total_arbitri,
  COUNT(home_win_rate)                AS cu_home_win_rate,
  COUNT(card_bias_score)              AS cu_card_bias,
  COUNT(pct_over_3_5_cards)           AS cu_pct_cards,
  COUNT(avg_yellow_h1)                AS cu_avg_yellow_h1,
  ROUND(AVG(home_win_rate)::numeric, 2) AS medie_home_wr,
  ROUND(AVG(card_bias_score)::numeric,2) AS medie_bias
FROM referee_stats;

\echo ''
\echo '── D8. venues — altitudine si suprafata'
SELECT
  COUNT(*)                                            AS total_venues,
  COUNT(*) FILTER (WHERE altitude_m > 0)              AS cu_altitudine_reala,
  COUNT(*) FILTER (WHERE altitude_m = 0)              AS altitude_zero,
  COUNT(*) FILTER (WHERE altitude_m IS NULL)          AS altitude_null,
  COUNT(*) FILTER (WHERE surface IS NOT NULL)         AS cu_suprafata,
  MAX(altitude_m)                                     AS max_altitudine
FROM venues;

\echo ''
\echo '── D9. injuries — coverage'
SELECT
  COUNT(DISTINCT fixture_id)                                          AS fixtures_cu_injuries,
  COUNT(*)                                                            AS total_randuri,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days')     AS recente_7z,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '30 days')    AS recente_30z,
  MAX(updated_at)::timestamp(0)                                       AS ultima_actualizare
FROM injuries;

\echo ''
\echo '── D10. odds — freshness si acoperire'
SELECT
  COUNT(DISTINCT fixture_id)                                          AS fixtures_cu_cote,
  COUNT(DISTINCT bookmaker_id)                                        AS bookmakers,
  COUNT(DISTINCT bet_name)                                            AS tipuri_piete,
  MAX(updated_at)::timestamp(0)                                       AS ultima_cota,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '24 hours')   AS actualizate_azi
FROM odds;

\echo ''
\echo '── D11. form_stats — acoperire si freshness'
SELECT
  COUNT(*)                                                            AS total,
  COUNT(avg_scored_home)                                              AS cu_avg_scored,
  COUNT(last5_home)                                                   AS cu_last5,
  MAX(updated_at)::timestamp(0)                                       AS ultima_actualizare,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days')     AS recente_7z
FROM form_stats;

\echo ''
\echo '── D12. teams_stats — coloane si calitate'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'teams_stats'
ORDER BY ordinal_position;

SELECT
  COUNT(*)                                          AS total_perechi,
  COUNT(DISTINCT team_id)                           AS echipe_unice,
  COUNT(DISTINCT league_id)                         AS ligi_unice,
  COUNT(avg_goals_for)                              AS cu_avg_goals,
  ROUND(AVG(avg_goals_for)::numeric, 2)             AS medie_goluri_for,
  ROUND(AVG(avg_goals_against)::numeric, 2)         AS medie_goluri_ag
FROM teams_stats;

\echo ''
\echo '── D13. standings — freshness'
SELECT
  COUNT(*)                                                         AS total_randuri,
  COUNT(DISTINCT league_id)                                        AS ligi,
  MAX(updated_at)::timestamp(0)                                    AS ultima_actualizare,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days')  AS recente_7z
FROM standings;

\echo ''
\echo '── D14. h2h — acoperire si recenta'
SELECT
  COUNT(*)                                                            AS total_meciuri_h2h,
  COUNT(DISTINCT home_team_id::text || '-' || away_team_id::text)    AS perechi_unice,
  MIN(match_date)::date                                               AS cel_mai_vechi,
  MAX(match_date)::date                                               AS cel_mai_recent,
  COUNT(*) FILTER (WHERE match_date > NOW() - INTERVAL '1 year')     AS ultimul_an
FROM h2h;

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  E. PREMATCH_DATA — CE COLECTAM SI CE NU FOLOSIM'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── E1. Tipuri date colectate in prematch_data'
SELECT
  data_type,
  COUNT(DISTINCT fixture_id)       AS fixtures,
  COUNT(*)                         AS total_randuri,
  MAX(collected_at)::timestamp(0)  AS ultima_colectare
FROM prematch_data
GROUP BY data_type
ORDER BY fixtures DESC;

\echo ''
\echo '── E2. Predictions API — sample (ce ne da API-Football gratis)'
SELECT fixture_id, LEFT(payload::text, 500) AS sample
FROM prematch_data
WHERE data_type = 'predictions'
ORDER BY collected_at DESC
LIMIT 2;

\echo ''
\echo '── E3. Fixtures cu cele mai multe tipuri de date prematch'
SELECT
  fixture_id,
  COUNT(DISTINCT data_type)                              AS tipuri_date,
  string_agg(data_type, ', ' ORDER BY data_type)        AS ce_are
FROM prematch_data
GROUP BY fixture_id
ORDER BY tipuri_date DESC
LIMIT 5;

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  F. LANTUL DE DATE — FUNCTIONEAZA JOIN-URILE?'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── F1. coaches → coach_stats JOIN'
SELECT
  COUNT(*)                                    AS total_coaches,
  COUNT(cs.coach_id)                          AS cu_coach_stats,
  COUNT(*) - COUNT(cs.coach_id)               AS fara_stats
FROM coaches c
LEFT JOIN coach_stats cs ON cs.coach_id = c.coach_id;

\echo ''
\echo '── F2. Sample antrenori cu stats (JOIN OK?)'
SELECT c.name, c.team_id, cs.win_rate, cs.goals_for_avg, cs.goals_against_avg
FROM coaches c
JOIN coach_stats cs ON cs.coach_id = c.coach_id
WHERE cs.win_rate IS NOT NULL
LIMIT 5;

\echo ''
\echo '── F3. fixtures → referee_stats JOIN (meciuri urmatoarea saptamana)'
SELECT
  COUNT(DISTINCT f.fixture_id)                                            AS total_fixtures,
  COUNT(DISTINCT f.fixture_id) FILTER (WHERE rs.referee_name IS NOT NULL) AS cu_arbitru_in_stats,
  COUNT(DISTINCT f.fixture_id) FILTER (WHERE f.referee IS NULL OR f.referee = '') AS fara_arbitru
FROM fixtures f
LEFT JOIN referee_stats rs ON rs.referee_name = f.referee
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '7 days';

\echo ''
\echo '── F4. fixtures → teams_stats JOIN (urmatoarele 3 zile)'
SELECT
  COUNT(DISTINCT f.fixture_id)                                              AS total_fixtures,
  COUNT(DISTINCT f.fixture_id) FILTER (WHERE ts_h.team_id IS NOT NULL)     AS cu_home_stats,
  COUNT(DISTINCT f.fixture_id) FILTER (WHERE ts_a.team_id IS NOT NULL)     AS cu_away_stats
FROM fixtures f
LEFT JOIN teams_stats ts_h ON ts_h.team_id = f.home_team_id AND ts_h.league_id = f.league_id
LEFT JOIN teams_stats ts_a ON ts_a.team_id = f.away_team_id AND ts_a.league_id = f.league_id
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '3 days';

\echo ''
\echo '── F5. fixtures → form_stats JOIN (urmatoarele 3 zile)'
SELECT
  COUNT(DISTINCT f.fixture_id)                                              AS total_fixtures,
  COUNT(DISTINCT f.fixture_id) FILTER (WHERE fs_h.team_id IS NOT NULL)     AS cu_home_form,
  COUNT(DISTINCT f.fixture_id) FILTER (WHERE fs_a.team_id IS NOT NULL)     AS cu_away_form
FROM fixtures f
LEFT JOIN form_stats fs_h ON fs_h.team_id = f.home_team_id
LEFT JOIN form_stats fs_a ON fs_a.team_id = f.away_team_id
WHERE f.status_short = 'NS'
  AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '3 days';

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  G. PLAYER_STATS — BACKFILL SI CALITATE'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── G1. Acoperire temporala (ultimele 12 luni)'
SELECT
  DATE_TRUNC('month', created_at)::date   AS luna,
  COUNT(*)                                AS randuri,
  COUNT(DISTINCT team_id)                 AS echipe
FROM player_stats
GROUP BY luna
ORDER BY luna DESC
LIMIT 12;

\echo ''
\echo '── G2. Calitate date (null rates)'
SELECT
  COUNT(*)                                        AS total,
  COUNT(rating)                                   AS cu_rating,
  COUNT(goals)                                    AS cu_goals,
  COUNT(pass_accuracy)                            AS cu_pass_acc,
  COUNT(shots_on_target)                          AS cu_sot,
  ROUND(AVG(rating)::numeric, 2)                  AS medie_rating,
  COUNT(*) FILTER (WHERE rating IS NULL)          AS null_rating
FROM player_stats;

\echo ''
\echo '── G3. Top 10 echipe dupa volum'
SELECT team_id, COUNT(*) AS randuri, MAX(created_at)::date AS ultima
FROM player_stats
GROUP BY team_id
ORDER BY randuri DESC
LIMIT 10;

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  H. LIVE SYSTEM — CE SE INTAMPLA ACUM'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── H1. Meciuri live (match_snapshots, ultimele 3h)'
SELECT
  COUNT(DISTINCT fixture_id)      AS fixtures_live,
  MAX(captured_at)::timestamp(0)  AS ultima_captura
FROM match_snapshots
WHERE captured_at > NOW() - INTERVAL '3 hours';

\echo ''
\echo '── H2. Alerte NGP (ultimele 24h)'
SELECT
  alert_type,
  COUNT(*)                                            AS total,
  COUNT(*) FILTER (WHERE telegram_ok)                 AS trimise_telegram
FROM alerts
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY alert_type;

\echo ''
\echo '── H3. Live stats recenta'
SELECT
  COUNT(DISTINCT fixture_id)       AS fixtures_cu_stats,
  MAX(recorded_at)::timestamp(0)   AS ultima_inregistrare
FROM live_stats
WHERE recorded_at > NOW() - INTERVAL '3 hours';

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  I. PREDICTIONS — CALITATE SI BRIER SCORE'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── I1. Predictii generale'
SELECT
  COUNT(*)                                                    AS total_predictii,
  COUNT(result_over15)                                        AS cu_rezultat_verificat,
  COUNT(*) - COUNT(result_over15)                             AS neverificate,
  COUNT(*) FILTER (WHERE result_over15 = true)                AS over15_reale,
  COUNT(*) FILTER (WHERE over15_prob > 65)                    AS predictii_confident,
  MAX(predicted_at)::date                                     AS ultima_predictie
FROM predictions;

\echo ''
\echo '── I2. Brier Score real calculat'
SELECT
  COUNT(*)                                                         AS sample_size,
  ROUND(AVG(
    POWER((CASE WHEN result_over15 THEN 1.0 ELSE 0.0 END)
          - (over15_prob / 100.0), 2)
  )::numeric, 4)                                                   AS brier_over15
FROM predictions
WHERE result_over15 IS NOT NULL
  AND over15_prob IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════
\echo ''
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  J. REZUMAT FINAL — STATUS SURSE DATE'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

\echo ''
\echo '── J1. OK / PROBLEMA per sursa'
SELECT sursa, status FROM (
  SELECT 1 AS ord, 'player_stats (Team Strength)' AS sursa,
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(*) || ' randuri' ELSE 'GOL — PROBLEMA!' END AS status
  FROM player_stats
  UNION ALL
  SELECT 2, 'form_stats (Layer 2 forma)',
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(*) || ' randuri' ELSE 'GOL — PROBLEMA!' END
  FROM form_stats
  UNION ALL
  SELECT 3, 'h2h (Layer 3)',
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(*) || ' randuri' ELSE 'GOL — PROBLEMA!' END
  FROM h2h
  UNION ALL
  SELECT 4, 'referee_stats (impact arbitru)',
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(*) || ' arbitri' ELSE 'GOL — PROBLEMA!' END
  FROM referee_stats
  UNION ALL
  SELECT 5, 'coach_stats (impact antrenor)',
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(*) || ' antrenori' ELSE 'GOL — PROBLEMA!' END
  FROM coach_stats
  UNION ALL
  SELECT 6, 'teams_stats (lambda sezon)',
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(*) || ' perechi' ELSE 'GOL — PROBLEMA!' END
  FROM teams_stats
  UNION ALL
  SELECT 7, 'odds (EV + Kelly)',
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(DISTINCT fixture_id) || ' fixtures' ELSE 'GOL — PROBLEMA!' END
  FROM odds
  UNION ALL
  SELECT 8, 'injuries (penalizare jucatori)',
    CASE WHEN COUNT(*) > 0 THEN 'OK — ' || COUNT(DISTINCT fixture_id) || ' fixtures' ELSE 'GOL — verifica!' END
  FROM injuries
  UNION ALL
  SELECT 9, 'prematch predictions API (NECITIT in enrich!)',
    CASE WHEN COUNT(*) > 0 THEN 'DATE EXIST — ' || COUNT(DISTINCT fixture_id) || ' fix dar IGNORATE!'
         ELSE 'GOL' END
  FROM prematch_data WHERE data_type = 'predictions'
  UNION ALL
  SELECT 10, 'venues altitude (impact altitudine)',
    CASE WHEN COUNT(*) > 0 THEN 'PROBLEMA — ' || COUNT(*) || ' venues cu altitude=0!'
         ELSE 'OK' END
  FROM venues WHERE COALESCE(altitude_m, 0) = 0
  UNION ALL
  SELECT 11, 'standings (NECITIT in enrich!)',
    CASE WHEN COUNT(*) > 0 THEN 'DATE EXIST — ' || COUNT(*) || ' randuri dar IGNORATE in predictie!'
         ELSE 'GOL' END
  FROM standings
) x ORDER BY ord;

\echo ''
\echo '╔══════════════════════════════════════════════════════════════════════╗'
\echo '║                   DIAGNOSTIC COMPLET — DONE                         ║'
\echo '╚══════════════════════════════════════════════════════════════════════╝'
