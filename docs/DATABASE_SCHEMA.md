# 📊 DATABASE_SCHEMA.md — AlohaScan V2 (PostgreSQL `elefant`)

> **OBLIGATORIU**: Claude Code citește acest fișier la fiecare sesiune nouă,
> ÎNAINTE de orice modificare ce atinge baza de date.
> DB: `elefant` · user: `alohascan` · host: `127.0.0.1:5432` (local pe VPS).
> Sursă: audit live (`information_schema` + `pg_indexes`) + `scripts/create-tables.sql`.
> Ultimă actualizare: 07.06.2026.

---

## ⚠ NOTE DE INTEGRITATE A AUDITULUI

- **Numărul de rânduri (PASUL 1)** NU a fost inclus în paste-ul de audit → coloana
  „Rânduri" e marcată `⧗ PASUL 1` acolo unde nu o cunosc. Valorile cu `~` provin din
  audituri anterioare (04.06) și sunt orientative. Regenerează exact cu query-ul din
  secțiunea **„Cum regenerezi acest fișier"**.
- **Foreign keys (PASUL 4)**: schema NU definește constrângeri `FOREIGN KEY` explicite.
  Toate relațiile sunt **LOGICE** (join pe `fixture_id` / `team_id` / `league_id` /
  `player_id`), neimpuse de DB. (De aceea integritatea referențială e responsabilitatea
  codului, nu a Postgres.)
- Unde schema LIVE diferă de `create-tables.sql` (coloane adăugate prin migrări), am
  documentat **versiunea LIVE** (sursa de adevăr).

---

## 🗂 CUPRINS PE CATEGORII

| Categorie | Tabele |
|-----------|--------|
| **CORE** | fixtures, fixtures_history, predictions, live_stats |
| **ELO** | elo_ratings, elo_history, elo_applied |
| **STATS** | match_stats, match_events, player_stats, players_season, form_stats, teams_stats |
| **STANDINGS** | standings, top_scorers, top_assists |
| **CONFIG** | leagues, teams, venues, coaches, coach_career, coach_stats, squads, bookmakers, bets |
| **CALIBRARE / ML** | model_weights, calibration_tables, calibration_live, league_patterns |
| **SNAPSHOTS** | match_snapshots, pre_match_snapshots, prematch_data, prematch_enrichment_log |
| **LOGS** | prediction_log, cron_logs, fixture_status_log, backfill_progress |
| **ALTELE** | h2h, referee_stats, league_stats, odds, live_odds, bets, alerts, injuries, sidelined, transfers, trophies, venue_weather |

---

# 🟢 CORE

## `fixtures`
**Scop:** meciuri programate și live (sursa principală curentă, rescrisă continuu de scanner/croncuri).
**Coloane principale:** `fixture_id` INT **PK**, `league_id` INT, `season` INT, `round` TEXT,
`home_team_id`/`away_team_id` INT, `home_team_name`/`away_team_name` TEXT, `venue_id` INT,
`status_short`/`status_long` TEXT, `match_date` TIMESTAMPTZ, `home_goals`/`away_goals` INT,
`home_ht`/`away_ht` INT, `referee` TEXT, `created_at`/`updated_at` TIMESTAMPTZ.
**Index:** PK(fixture_id); idx_fixtures_match_date(match_date); idx_fixtures_league_status(league_id,status_short);
idx_fixtures_status_date(status_short,match_date); idx_fixtures_home_team; idx_fixtures_away_team.
**Rânduri:** ⧗ PASUL 1.
**Relații:** → leagues(league_id), teams(home/away_team_id), venues(venue_id). Sursă pt match_*, odds, predictions.

## `fixtures_history` ★
**Scop:** meciuri TERMINATE (FT). Sursa de adevăr pt labels (rezultat final + HT) — folosit de ELO, ML, calibrare.
**Coloane principale:** `id` SERIAL PK, `fixture_id` INT **UNIQUE**, `league_id` INT, `season` INT,
`home_team_id`/`away_team_id` INT, `home_team_name`/`away_team_name` TEXT,
`home_goals`/`away_goals` INT, `home_ht`/`away_ht` INT, `status_short` TEXT, `match_date` TIMESTAMPTZ, `referee` TEXT.
**Index:** PK(id); UNIQUE(fixture_id); idx_fh_match_date; idx_fh_league_status; idx_fh_home_team; idx_fh_away_team;
idx_fh_home_status_date(home_team_id,status_short,match_date DESC); idx_fh_away_status_date(...).
**Rânduri:** ⧗ PASUL 1 (mii–zeci de mii).
**Relații:** ⋈ predictions, live_stats, match_stats, match_events, elo_history (toate pe fixture_id).
**⚠ NU conține** cartonașe/cornere/posesie — acelea-s în `match_stats`.

## `predictions` ★ (tabela ML pre-meci)
**Scop:** o predicție Poisson + confidence + features ML per fixture (UNIQUE fixture_id). Sursa de antrenare ML pre-meci.
**Coloane principale (LIVE, extinsă față de create-tables.sql):**
`id` SERIAL PK, `fixture_id` INT **UNIQUE**, `home_team`/`away_team`/`league_name` TEXT, `league_id` INT, `match_date` TIMESTAMPTZ,
`lambda_home`/`lambda_away`/`lambda_total` NUMERIC, `over15_prob`/`over25_prob`/`gg_prob` NUMERIC,
`home_win_prob`/`draw_prob`/`away_win_prob` NUMERIC, `home_score_rate`/`away_score_rate` NUMERIC,
`h2h_over15` NUMERIC, `confidence` NUMERIC, `best_ev`/`best_cota` NUMERIC, `best_bet` TEXT,
`result_over15`/`result_over25`/`result_gg` BOOL, `result_1x2`/`result_winner` TEXT,
`score_at_alert` TEXT, `outcome_ngp` TEXT, `api_home_pct`/`api_draw_pct`/`api_away_pct` NUMERIC, `source` TEXT,
**features ML:** `score1`,`score2`,`score3`,`score4`,`score6`,`score7` NUMERIC, `h2h_sample` INT, `league_group` TEXT,
**ELO:** `elo_adjusted` BOOL, `elo_diff_used`/`home_elo`/`away_elo`/`elo_diff_ml`/`home_win_prob_elo` NUMERIC,
**poziție:** `home_position`/`away_position` INT, `home_position_norm`/`away_position_norm` NUMERIC,
`created_at`/`updated_at` TIMESTAMPTZ.
**Index:** PK(id); UNIQUE(fixture_id).
**Rânduri:** ~15.675 (audit 04.06; ~15.522 cu rezultat) — ⧗ confirmă PASUL 1.
**Relații:** ⋈ fixtures_history (labels), elo_history (ELO). Scris de `enrich.js`/`match.js`; labels de `update-results.js`.
**Note:** `score5` lipsește intenționat (layerele folosite: 1,2,3,4,6,7). Coloana de greutăți e în `model_weights`.

## `live_stats` ★ (snapshot-uri live)
**Scop:** statistici live per minut (APPEND-ONLY, ~223 snapshot-uri/fixture). Bază pt scanner NGP + viitor ML live.
**Coloane:** `id` SERIAL PK, `fixture_id` INT, `elapsed` INT, `home_goals`/`away_goals` INT,
`home_sot`/`away_sot` INT, `home_shots`/`away_shots` INT, `home_possession`/`away_possession` INT,
`home_corners`/`away_corners` INT, `home_da`/`away_da` INT (dangerous attacks),
`home_xg`/`away_xg` NUMERIC(5,2), `ngp_home`/`ngp_away` NUMERIC(5,2) (doar scanner.js), `recorded_at` TIMESTAMPTZ.
**Index:** PK(id); idx_live_stats_fixture(fixture_id); idx_live_stats_recorded(recorded_at);
idx_live_stats_fixture_id(fixture_id, recorded_at DESC).
**Rânduri:** ~180.425 pe ~810 fixture-uri cu rezultat final (audit 07.06).
**Relații:** ⋈ fixtures_history (pe fixture_id) pt labels. **NU are** team_id/league_id/cartonașe.
**Scris de:** `api/cron/scan.js` (fără ngp), `api/cron/scanner.js` (cu ngp).

---

# 🔵 ELO

## `elo_ratings`
**Scop:** ELO curent per (echipă, ligă). Reconstruit săptămânal de cron `build-elo`; update incremental la collect-finished.
**Coloane:** `team_id` INT, `league_id` INT, `elo` NUMERIC(8,2) DEFAULT 1500, `games` INT, `updated_at` TIMESTAMPTZ. **PK(team_id, league_id)**.
**Index:** PK(team_id,league_id); idx_elo_team; idx_elo_league.
**Rânduri:** ⧗ PASUL 1. **Relații:** team_id→teams, league_id→leagues. Fallback ELO pt meciuri viitoare.

## `elo_history` ★
**Scop:** ELO POINT-IN-TIME — snapshot pre-meci al ambelor echipe (fără lookahead). Sursa ELO pt backtest/ML valid.
**Coloane:** `fixture_id` INT **PK**, `home_team_id`/`away_team_id` INT, `home_elo`/`away_elo`/`elo_diff` NUMERIC(8,2), `home_win_prob` NUMERIC(5,4).
**Index:** PK(fixture_id); idx_elo_history_fixture.
**Rânduri:** ⧗ PASUL 1. **Relații:** ⋈ fixtures_history, predictions (pe fixture_id). Scris de `build-elo` în replay cronologic.

## `elo_applied`
**Scop:** guard de idempotență — un meci aplicat o singură dată în ELO incremental între reconstrucții.
**Coloane:** `fixture_id` INT **PK**. **Index:** PK(fixture_id). **Rânduri:** ⧗ PASUL 1.
**Relații:** fixture_id→fixtures_history. Golit la rebuild complet de `build-elo`.

---

# 🟣 STATS

## `match_stats` ★
**Scop:** statistici FINALE per echipă/meci (WIDE, 2 rânduri/fixture). SINGURA sursă persistentă de cartonașe/cornere/faulturi/xG istorice.
**Coloane:** `id` SERIAL PK, `fixture_id` INT, `team_id` INT, `team_name` TEXT, `shots_on_goal`,`shots_total`,`blocked_shots`,
`shots_insidebox`,`shots_outsidebox`,`fouls`,`corner_kicks`,`offsides`,`ball_possession`,`yellow_cards`,`red_cards`,
`goalkeeper_saves`,`total_passes`,`passes_accurate`,`pass_percentage` INT, `expected_goals` NUMERIC, `created_at`. **UNIQUE(fixture_id, team_id)**.
**Index:** PK(id); UNIQUE(fixture_id,team_id).
**Rânduri:** ⧗ PASUL 1. **Relații:** ⋈ fixtures_history (fixture_id + team_id↔home/away_team_id).

## `match_events`
**Scop:** evenimente per meci (goluri, cartonașe, schimbări). Folosit pt HT calculat fallback și cronologie.
**Coloane:** `id` SERIAL PK, `fixture_id` INT, `elapsed`/`elapsed_extra` INT, `team_id`/`player_id`/`assist_id` INT,
`team_name`/`player_name`/`assist_name` TEXT, `type` TEXT (Goal/Card/subst), `detail` TEXT, `comments` TEXT, `created_at`.
**Index:** PK(id); idx_match_events_fixture(fixture_id).
**Rânduri:** ⧗ PASUL 1. **Relații:** fixture_id→fixtures_history; type='Goal' & detail≠'Own Goal' → HT calc în ML.

## `player_stats`
**Scop:** statistici per jucător per meci. Bază pt team strength (layer 7) + player score.
**Coloane:** `id` PK, `player_id`,`fixture_id`,`team_id` INT, `player_name`/`position` TEXT, `rating` NUMERIC,
`minutes_played`,`goals`,`assists`,`shots_total`,`shots_on_target` INT, `pass_accuracy` NUMERIC, `passes_total`,`key_passes`,
`dribbles_success`,`tackles`,`interceptions`,`yellow_cards`,`red_cards` INT, `player_score` NUMERIC, `created_at`. **UNIQUE(player_id, fixture_id)**.
**Index:** PK(id); UNIQUE(player_id,fixture_id); idx_player_stats_team; idx_player_stats_fixture.
**Rânduri:** ⧗ PASUL 1. **Relații:** fixture_id→fixtures_history; team_id→teams.

## `players_season`
**Scop:** agregate sezoniere per jucător (din backfill/collect).
**Coloane:** `id` PK, `player_id`,`team_id`,`league_id`,`season` INT, `player_name`/`nationality`/`position` TEXT, `age` INT,
`appearances`,`lineups`,`minutes`,`goals`,`assists`,`yellow_cards`,`red_cards` INT, `rating`,`pass_accuracy` NUMERIC, `shots_on_target` INT, `updated_at`. **UNIQUE(player_id, league_id, season)**.
**Index:** PK(id); UNIQUE(player_id,league_id,season). **Rânduri:** ⧗ PASUL 1.

## `form_stats`
**Scop:** forma recentă (last5) + medii goluri per echipă/ligă/sezon. Folosit la lambda Poisson + layer 2.
**Coloane:** `id` PK, `team_id`,`league_id`,`season` INT, `last5_home`/`last5_away` TEXT,
`avg_scored_home`,`avg_conceded_home`,`avg_scored_away`,`avg_conceded_away` NUMERIC, `updated_at`. **UNIQUE(team_id, league_id, season)**.
**Index:** PK(id); UNIQUE(team_id,league_id,season). **Rânduri:** ⧗ PASUL 1. **Scris de:** collect-daily.

## `teams_stats`
**Scop:** statistici agregate echipă/ligă/sezon (played/wins/goals/clean sheets, home/away/total).
**Coloane principale:** `id` PK, `team_id`,`league_id`,`season` INT, `form` TEXT, played/wins/draws/loses (home/away/total),
goals_for/against (home/away/total), `avg_goals_for`/`avg_goals_against` NUMERIC, clean_sheets (home/away/total), `updated_at`. **UNIQUE(team_id, league_id, season)**.
**Index:** PK(id); UNIQUE(team_id,league_id,season). **Rânduri:** ⧗ PASUL 1.

---

# 🟠 STANDINGS

## `standings`
**Scop:** clasament per ligă/sezon/echipă. Sursa pt poziția normalizată (feature ML).
**Coloane:** `id` PK, `league_id`,`season`,`rank`,`team_id` INT, `team_name`/`team_logo` TEXT, `points`,`goals_diff` INT,
`group_name`/`form`/`status`/`description` TEXT, `played`,`win`,`draw`,`lose`,`goals_for`,`goals_against` INT, `updated_at`. **UNIQUE(league_id, season, team_id)**.
**Index:** PK(id); UNIQUE(league_id,season,team_id). **Rânduri:** ⧗ PASUL 1.

## `top_scorers`
**Scop:** golgheteri per ligă/sezon.
**Coloane:** `id` PK, `league_id`,`season`,`player_id` INT, `player_name`/`team_name` TEXT, `team_id` INT, `goals`,`assists`,`penalties`,`appearances` INT, `updated_at`. **UNIQUE(league_id, season, player_id)**.
**Index:** PK(id); UNIQUE(league_id,season,player_id). **Rânduri:** ⧗ PASUL 1.

## `top_assists`
**Scop:** pasatori decisivi per ligă/sezon. **Coloane:** ca top_scorers, cu `assists`,`goals`,`appearances`. **UNIQUE(league_id, season, player_id)**.
**Index:** PK(id); UNIQUE(league_id,season,player_id). **Rânduri:** ⧗ PASUL 1.

---

# ⚙️ CONFIG

## `leagues`
**Scop:** dicționar ligi (whitelist + metadate). 165+ ligi seed-uite în create-tables.sql.
**Coloane:** `league_id` INT **PK**, `name`/`country` TEXT, `tier` INT, `timezone` TEXT, `active_hours_start`/`active_hours_end` INT, `active` BOOL, `logo`/`flag` TEXT, `created_at`/`updated_at`.
**Index:** PK(league_id). **Rânduri:** ~165+. **Note:** filtrul real de afișare e în cod (`api/leagues.js` + `league-filter.js`), nu DOAR aici.

## `teams`
**Scop:** dicționar echipe. **Coloane:** `team_id` INT **PK**, `name`/`code`/`country` TEXT, `founded` INT, `national` BOOL, `logo` TEXT, `venue_id` INT, `created_at`/`updated_at`.
**Index:** PK(team_id). **Rânduri:** ⧗ PASUL 1.

## `venues`
**Scop:** stadioane (geo pt meteo). **Coloane:** `venue_id` INT **PK**, `name`/`address`/`city`/`country`/`surface`/`image` TEXT, `capacity` INT, `latitude`/`longitude` NUMERIC, `altitude_m` INT, `climate_zone` TEXT, `created_at`/`updated_at`.
**Index:** PK(venue_id). **Rânduri:** ⧗ PASUL 1.

## `coaches` / `coach_career` / `coach_stats`
**Scop:** antrenori, istoricul carierei și statistici agregate.
- `coaches`: `id` PK, `coach_id`,`team_id` INT, nume/naționalitate, `career_start`/`career_end` DATE. **UNIQUE(coach_id, team_id)**.
- `coach_career`: `id` PK, `coach_id`,`team_id` INT, `team_name`, `start_date`/`end_date` DATE. **UNIQUE(coach_id, team_id, start_date)**; idx_coach_career_coach.
- `coach_stats`: `coach_id` INT **PK**, matches/wins/draws/losses, `win_rate`,`avg_goals_for/against`,`clean_sheet_rate`,`style`,`tenure_days`,`current_team_id`,`last_match_date`.
**Rânduri:** ⧗ PASUL 1.

## `squads`
**Scop:** loturi per echipă/sezon. **Coloane:** `id` PK, `team_id`,`season`,`player_id` INT, `player_name`/`position`/`photo` TEXT, `number`,`age` INT, `updated_at`. **UNIQUE(team_id, season, player_id)**.
**Index:** PK(id); UNIQUE(team_id,season,player_id). **Rânduri:** ⧗ PASUL 1.

## `bookmakers` / `bets`
**Scop:** dicționare pt cote. `bookmakers`: `bookmaker_id` PK, `name`, `active`. `bets`: `bet_id` PK, `name`, `description`.
**Rânduri:** ⧗ PASUL 1.

---

# 🧮 CALIBRARE / ML

## `model_weights` ★
**Scop:** greutăți/threshold-uri învățate per modul+context (NGP, OVER15/25, GG, CONFIDENCE layer1-7, CARDS, CORNERS, GENERATOR). Actualizat de learning engine.
**Coloane:** `id` PK, `module` TEXT, `context_key` TEXT (ex. 'global' / 'league_<id>'), `weight_name` TEXT, `weight_value` NUMERIC(8,4), `default_value` NUMERIC(8,4), `sample_size` INT, `win_rate` NUMERIC, `confidence_level` TEXT, `last_updated`. **UNIQUE(module, context_key, weight_name)**.
**Index:** PK(id); UNIQUE(module,context_key,weight_name). **Rânduri:** ⧗ PASUL 1.
**⚠ Nume coloană = `weight_value`** (NU `value`). Folosit la runtime DOAR `lambda_multiplier`; greutățile layerelor 1-7 sunt fixe în cod.

## `calibration_tables`
**Scop:** bucketizare probabilități per (modul, league_group) cu Brier. **PK compus (module, league_group)**.
**Coloane:** `module` TEXT, `league_group` TEXT DEFAULT 'global', `buckets` JSONB, `sample_size` INT, `brier_score` NUMERIC(5,3), `generated_at`.
**Index:** PK(module,league_group). **Rânduri:** ⧗ PASUL 1. **Grupuri:** low/mid/high (după goluri/meci).

## `calibration_live`
**Scop:** calibrare live per (minute_bucket, score_state, market). **Coloane:** `id` PK, `minute_bucket` TEXT, `score_state` TEXT, `market` TEXT, `n_samples` INT, `real_pct` NUMERIC, `generated_at`. **UNIQUE(minute_bucket, score_state, market)**.
**Index:** PK(id); UNIQUE(minute_bucket,score_state,market). **Rânduri:** ⧗ PASUL 1.

## `league_patterns`
**Scop:** pattern-uri agregate per ligă (avg ng/over15/goals/cards/corners). **Coloane:** `league_id` INT **PK**, `sample_size` INT, `avg_ng`/`avg_over15`/`avg_goals`/`avg_cards`/`avg_corners`/`over15_pct`/`gg_pct` NUMERIC, `updated_at`.
**Index:** PK(league_id). **Rânduri:** ⧗ PASUL 1.

---

# 📸 SNAPSHOTS

## `match_snapshots`
**Scop:** snapshot la momentul alertei NGP + rezultat final (pt backtest NGP). UNIQUE pe fixture_id.
**Coloane (LIVE):** `id` SERIAL PK, `fixture_id` INT (UNIQUE: match_snapshots_fixture_uq), `league_id` INT, `home_team`/`away_team`/`status_short` TEXT,
`minute` INT, `home_goals`/`away_goals` INT, `ng` INT, `over15` INT, `outcome` TEXT DEFAULT 'LIVE', `final_home`/`final_away` INT, `resolved_at`, `created_at`, `ng_15min` INT.
**Index:** PK(id); UNIQUE(fixture_id); idx_match_snapshots_league; idx_match_snapshots_outcome; idx_match_snapshots_league_outcome.
**Rânduri:** ⧗ PASUL 1.

## `pre_match_snapshots`
**Scop:** snapshot complet pre-meci (formă, h2h, lambda, cote, meteo). **Coloane:** `id` PK, `fixture_id` INT UNIQUE, `home_team_id`/`away_team_id` INT, `home_form`/`away_form` TEXT, avg_scored/conceded NUMERIC, `h2h_summary` JSONB, `lambda_home`/`lambda_away`, over15/25/gg_prob, `confidence`, `odds_snapshot` JSONB, `weather` JSONB, `outcome` TEXT, `composite_score` NUMERIC, `created_at`.
**Index:** PK(id); UNIQUE(fixture_id). **Rânduri:** ⧗ PASUL 1.

## `prematch_data`
**Scop:** date prematch colectate în 7 etape (payload JSONB per stadiu). **PK compus (fixture_id, stage, data_type)**.
**Coloane:** `fixture_id` INT, `stage` INT, `data_type` VARCHAR(50), `payload` JSONB, `collected_at`.
**Index:** PK(fixture_id,stage,data_type); idx_prematch_data_fixture. **Rânduri:** ⧗ PASUL 1.

## `prematch_enrichment_log`
**Scop:** log etape prematch per fixture. **Coloane:** `fixture_id` INT, `stage` INT, `executed_at`. **PK(fixture_id, stage)**.
**Index:** PK(fixture_id,stage). **Rânduri:** ⧗ PASUL 1.

---

# 📋 LOGS

## `prediction_log`
**Scop:** log granular per predicție/modul cu layer1-7, threshold, outcome (WIN/LOSS/PENDING). Bază pt learning-analysis.
**Coloane:** `id` PK, `fixture_id`/`league_id` INT, nume echipe/ligă, `match_date`, `minute` INT, `score_at_prediction` TEXT, `venue_surface`/`referee_name` TEXT, `module` TEXT, `predicted_value`/`threshold_used` NUMERIC, `lambda_home`/`lambda_away`, `ngp_value`, `layer1_score`..`layer7_score` NUMERIC, `injuries_home`/`injuries_away` INT, `outcome` TEXT DEFAULT 'PENDING', `actual_value`, `created_at`, `resolved_at`.
**Index:** PK(id); idx_predlog_module; idx_predlog_league; idx_predlog_fixture (+ outcome/created în create-tables).
**Rânduri:** ⧗ PASUL 1 (sute de mii — NGP/OVER15 domină).

## `cron_logs`
**Scop:** log rulări cron. **Coloane:** `id` PK, `job_name` TEXT, `ran_at`, `fixtures_processed`/`players_upserted` INT, `status` TEXT, `error_msg` TEXT, `duration_ms` INT.
**Index:** PK(id); idx_cron_logs_job(job_name, ran_at DESC). **Rânduri:** ⧗ PASUL 1.

## `fixture_status_log`
**Scop:** istoricul tranzițiilor de status per fixture. **Coloane:** `id` PK, `fixture_id` INT, `status_short`/`status_long` TEXT, `elapsed`/`home_goals`/`away_goals` INT, `recorded_at`.
**Index:** PK(id); idx_fixture_status_fixture. **Rânduri:** ⧗ PASUL 1.

## `backfill_progress`
**Scop:** progres backfill per ligă. **Coloane:** `league_id` INT **PK**, `status` TEXT, `fixtures_processed`/`players_upserted` INT, `last_run`, `error_msg`.
**Index:** PK(league_id). **Rânduri:** ⧗ PASUL 1.

---

# 📦 ALTELE

## `h2h`
**Scop:** istoric întâlniri directe (head-to-head) per pereche de echipe. **Coloane:** `id` PK, `team1_id`/`team2_id`/`fixture_id` INT, `home_team_id`/`away_team_id` INT, `home_goals`/`away_goals` INT, `match_date`, `league_id`/`season` INT. **UNIQUE(team1_id, team2_id, fixture_id)**.
**Index:** PK(id); UNIQUE(team1,team2,fixture); idx_h2h_teams(team1_id,team2_id). **Rânduri:** ⧗ PASUL 1.

## `referee_stats`
**Scop:** profil arbitri (cartonașe/faulturi/goluri medii, stil, bias). **Coloane (LIVE, extinsă):** `referee_name` VARCHAR(200) **PK**, `total_matches` INT, `avg_yellow_cards`/`avg_red_cards`/`avg_penalties`/`avg_fouls`/`avg_corners`/`avg_goals` NUMERIC, `pct_over_25`/`pct_gg`/`pct_btts` NUMERIC, `referee_style` VARCHAR, `home_win_rate`/`away_win_rate`/`draw_rate`, `pct_over_3_5_cards`/`pct_over_4_5_cards`, `avg_yellow_h1`/`avg_yellow_h2`, `card_bias_score` NUMERIC, `updated_at`.
**Index:** PK(referee_name). **Rânduri:** ⧗ PASUL 1.

## `league_stats`
**Scop:** statistici agregate per ligă (goluri/cărți/cornere, % over). **Coloane:** `league_id` INT **PK**, `league_name`, `season` INT, `total_matches` INT, `avg_goals_per_match`/`avg_home_goals`/`avg_away_goals`, `pct_over_05..35`, `pct_gg`/`pct_btts`, `avg_yellow_cards`/`avg_red_cards`/`avg_corners`, `league_type` VARCHAR, `updated_at`.
**Index:** PK(league_id). **Rânduri:** ⧗ PASUL 1.

## `odds` / `live_odds`
**Scop:** cote normalizate (pre-meci / live). `odds`: `id` PK, `fixture_id`, `bookmaker_id`/`bookmaker_name`, `bet_id`/`bet_name`, `value_name`, `value_odd` NUMERIC, `collected_at`. **UNIQUE(fixture_id, bookmaker_id, bet_id, value_name)**; idx_odds_fixture.
`live_odds`: `id` PK, `fixture_id`, `elapsed`, `bookmaker_id`, `bet_id`, `value_name`, `value_odd`, `recorded_at`; idx_live_odds_fixture.
**Rânduri:** ⧗ PASUL 1.

## `alerts`
**Scop:** alerte NGP/over15 trimise (Telegram). **Coloane:** `id` PK, `fixture_id` INT, `alert_type` TEXT, `message` TEXT, `ngp_value`/`threshold` NUMERIC, `sent_at`, `telegram_ok` BOOL.
**Index:** PK(id); idx_alerts_fixture; idx_alerts_sent. **Rânduri:** ⧗ PASUL 1.

## `injuries` / `sidelined`
**Scop:** accidentări per fixture (`injuries`: UNIQUE(fixture_id, player_id)) și indisponibilități per jucător (`sidelined`).
**Rânduri:** ⧗ PASUL 1.

## `transfers` / `trophies`
**Scop:** transferuri jucători și palmares echipe (metadate UI). **Rânduri:** ⧗ PASUL 1.

## `venue_weather` (LIVE, neîn create-tables.sql)
**Scop:** meteo + impact estimat per fixture (over25/corners/cards delta). **Coloane:** `fixture_id` INT **PK**, `venue_city`/`venue_lat`/`venue_lng`, `match_date`, `temperature`/`feels_like`/`precipitation`/`wind_speed` NUMERIC, `wind_direction`/`humidity`/`weather_code` INT, `weather_condition`/`weather_impact` VARCHAR, `impact_over25_delta`/`impact_corners_delta`/`impact_cards_delta` NUMERIC, `fetched_at`.
**Index:** PK(fixture_id). **Rânduri:** ⧗ PASUL 1.

> **Tabele LIVE extra (în DB, dar nu în create-tables.sql):** `app_settings` (PK key),
> `cazarma_centrala` (router intern: idx pe sursa/procesat). Documentează-le la nevoie.

---

## 🔗 HARTA RELAȚIILOR (logice — fără FK impus)

```
leagues(league_id) ──< fixtures / fixtures_history / standings / league_stats / league_patterns
teams(team_id)     ──< fixtures(home/away) / elo_ratings / form_stats / teams_stats / player_stats
venues(venue_id)   ──< fixtures / teams

fixtures_history(fixture_id) ─┬─< predictions      (1:1)  → labels ML pre-meci
                              ├─< live_stats        (1:N) → snapshot-uri live (ML live)
                              ├─< match_stats       (1:2) → cartonașe/cornere/xG finale
                              ├─< match_events      (1:N) → goluri/cartonașe (HT calc)
                              ├─< elo_history       (1:1) → ELO point-in-time
                              └─< match_snapshots / pre_match_snapshots (1:1)

predictions(fixture_id) ⋈ elo_history(fixture_id)   → features ELO
model_weights ──(runtime)── enrich.js / scan.js     → greutăți/threshold per modul
```

---

## 🔁 CUM REGENEREZI ACEST FIȘIER (rulează pe VPS)

```bash
cd /root/scannerv2
export $(grep -E '^(POSTGRES_URL|PGPASSWORD|PGUSER|PGDATABASE|PGHOST)=' .env | xargs)
PSQL="psql -U alohascan -d elefant -h 127.0.0.1"
# PASUL 1 — rânduri (lipsă în auditul curent → completează coloana „Rânduri"):
$PSQL -c "SELECT relname AS tabel, n_live_tup AS randuri
  FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"
# PASUL 4 — FK (așteptat: 0 rânduri, relațiile sunt logice):
$PSQL -c "SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
  WHERE tc.constraint_type='FOREIGN KEY';"
```

> Când ai outputul PASUL 1, înlocuiește marcajele `⧗ PASUL 1` cu numerele reale.
