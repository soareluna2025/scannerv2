# SCHEMA.md — Harta tabelelor AlohaScan (audit din cod, 2026-06)

> Generat din analiza CODULUI (CREATE TABLE, query-uri INSERT/UPDATE/SELECT).
> Verdict: **ACTIV** (scris+citit) · **RAR** (folosit ocazional) · **🧟 ZOMBI**
> (definit dar nereferit ca tabel SQL) · **⚠ DRIFT** (folosit de cod, dar lipsește
> din `scripts/create-tables.sql` → s-ar pierde la un rebuild de schemă).
> Frecvență: `10s/2s` (hot live) · `cron` (orar/zilnic) · `1x` (backfill one-time).

## 1. Tabel per tabel

| Tabel | Rol (o frază) | Scrie | Citește | Freq | Verdict |
|-------|---------------|-------|---------|------|---------|
| fixtures | Meciuri programate+live (sursă centrală) | scanner, today, collect-daily, prematch-enrichment, backfill, extract-team | 35+ fișiere | 10s + cron | ACTIV |
| fixtures_history | Meciuri terminate (FT) + referee | scanner, backfill, collect-national-history, referee-stats, extract-team | 22+ fișiere (enrich, train_*, build-ml-features) | cron + 1x | ACTIV |
| predictions | Predicții Poisson/ML per meci | enrich, scanner, match, update-results, collect-daily, backfill-predictions | 18+ (admin, learning-analysis, model-accuracy, train_model) | per-enrich + cron | ACTIV (hot) |
| live_stats | Statistici live per minut (xg/sot/pose) | scan, scanner | enrich, match, db-stats, worldcup, ngp-backtest | **10s** | ACTIV (hot) |
| match_snapshots | Snapshot live per scan (NGP/outcome) | scan, scanner | admin, db-stats, football | **2s** | ACTIV (hot) |
| alerts | Alerte NGP/over15 (telegram_ok) | scan, scanner | scan, scanner, db-stats | 10s | ACTIV |
| match_events | Goluri/cartonașe/subst per meci | backfill, collect-finished, (API-backfill) | enrich, build-ml-features, calibrate-live, referee-*, train_live_v2 | cron + 1x | ACTIV |
| match_stats | Statistici totale per echipă/meci | backfill, collect-finished, backfill-stats(-api) | enrich, build-ml-features, league-stats, referee-stats, match | cron + 1x | ACTIV |
| ml_features | Feature store ML (rolling-100 medii) | build-ml-features, backfill-ml-features | build-ml-features, **train_model, train_live_v2** | cron | ACTIV |
| elo_history | ELO snapshot pre-meci per fixture | build-elo | enrich, match, backfill-predictions, train_live_v2 | cron | ACTIV |
| elo_ratings | ELO curent per echipă | build-elo, collect-finished | enrich, match, elo, collect-finished | cron | ACTIV |
| elo_applied | Marcaj fixture cu ELO aplicat | build-elo, collect-finished | build-elo, collect-finished | cron | ACTIV |
| h2h | Istoric H2H per pereche echipe | backfill, backfill-stats, scan | enrich, match, generator, simulate, admin | cron + 1x | ACTIV |
| odds | Cote normalizate per meci | collect-finished | match, simulate | cron | ACTIV |
| standings | Clasamente ligă/sezon/echipă | collect-daily, collect-wc-qualifiers, extract-team | enrich, team, standings-data, worldcup*, season | cron | ACTIV |
| form_stats | Forma recentă echipe | collect-daily, scanner | collect-daily, generator, simulate, backfill-predictions | cron | ACTIV |
| league_stats | Statistici agregate per ligă | league-stats | enrich, match, generator, recalibrate-tables, backfill-predictions | cron | ACTIV |
| referee_stats | Statistici per arbitru | referee-stats, referee-extended, (backfill-referee-stats) | enrich, generator, simulate, admin | cron | ACTIV |
| leagues | Catalog ligi | collect-daily | today, admin, auto-predict, league-stats, team, generator | cron | ACTIV |
| teams | Catalog echipe | collect-daily, collect-team-stats, extract-team | enrich, match, today, team, generator | cron | ACTIV |
| teams_stats | Statistici sezon per echipă | collect-team-stats, extract-team | enrich, generator, match | cron | ACTIV |
| players | Jucători | backfill-players, collect-players-season, cazarma-router | enrich, team, admin | cron + 1x | ACTIV |
| player_stats | Statistici jucători per meci | backfill, collect-finished, players | enrich, team, match, simulate, admin, scanner | cron + 1x | ACTIV |
| players_season | Statistici jucători pe sezon | backfill-players, collect-players-season, cazarma-router | enrich, team, admin | cron | ACTIV |
| squads | Loturi echipe | collect-squads, cazarma-router | enrich, admin | cron | ACTIV |
| top_scorers | Golgheteri per ligă | collect-top-scorers, cazarma-router | enrich, admin | cron | ACTIV |
| top_assists | Pasatori per ligă | collect-top-scorers, cazarma-router | enrich | cron | RAR (1 reader) |
| injuries | Accidentări per meci | enrich | enrich, generator, simulate | per-enrich | ACTIV |
| coaches | Antrenori | collect-coaches | coach-stats, enrich | cron | ACTIV |
| coach_career | Carieră antrenori | collect-coaches | coach-stats | cron | RAR |
| coach_stats | Statistici antrenori | coach-stats | enrich | cron | RAR (1 reader) |
| venues | Stadioane | collect-venues | enrich, generator, venue-weather | cron | ACTIV |
| prematch_data | Date pre-meci (7 etape, inclusiv odds JSON) | prematch-enrichment | enrich, match, scan, scanner | cron(*/5) | ACTIV |
| prematch_enrichment_log | Log etape prematch | prematch-enrichment | prematch-enrichment | cron | RAR (self) |
| pre_match_snapshots | Snapshot pre-meci pt back-testing | enrich, update-results | admin, health-check | per-enrich | ACTIV |
| prediction_log | Log predicții (WIN/LOSS/PENDING per modul) | log-prediction, update-results | admin, learning-analysis | per-enrich + cron | ACTIV |
| model_weights | Greutăți model calibrate | learning-analysis | enrich(weights), simulate, admin, weights | cron | ACTIV |
| calibration_tables | Calibrare Brier per modul/grup | recalibrate-tables | admin, calibration | cron | ACTIV |
| calibration_live | Calibrare praguri live | calibrate-live | admin, calibration | cron | ACTIV |
| cron_logs | Log rulări cron | ~28 cron-uri + admin | admin, db-stats, health-check | toate cron-urile | ACTIV |
| backfill_progress | Progres backfill jucători | backfill, players | backfill, players, health-check | 1x | ACTIV |
| app_settings | Key/value: stare backfill + cache „no_data"/„h2h_refresh" | backfill, backfill-players, extract-team, cleanup-settings | idem + health-check | per-fixture (vezi §2) | ACTIV ⚠ BLOAT |
| **app_settings** | — | — | — | — | **763k rânduri — vezi §2** |
| **ml_features** | — (materializat) | — | enrich AR TREBUI să-l citească live (nu o face — vezi SPEED_AUDIT) | — | ACTIV |
| **fixture_positions** | Poziție istorică point-in-time (feature ML live) | backfill-positions | **train_live_v2** | 1x | ⚠ DRIFT |
| **stats_api_checked** | Checkpoint API backfill (anti-ardere cotă) | backfill-stats-api | backfill-stats-api | 1x | ⚠ DRIFT |
| **bulk_referee_checked** | Checkpoint backfill referee per ligă-sezon | backfill-referee-bulk | backfill-referee-bulk | 1x | ⚠ DRIFT |
| bookmakers | Catalog case de pariuri (definit în schemă) | — | — (refs din cod = JSON `item.bookmakers`, NU tabelul) | — | 🧟 ZOMBI |
| `h` | Tabel suspect (apare în create-tables.sql) | ? | ? | — | 🧟 VERIFICĂ |

## 2. Zombii / drift / „doar se scrie"

- **🧟 ZOMBI real:** `bookmakers` — definit în `scripts/create-tables.sql:522`, dar
  toate referințele `bookmakers` din cod sunt câmpuri JSON din răspunsul API
  (`item.bookmakers`), NU interogări pe tabel. Candidat la ștergere.
- **🧟 VERIFICĂ:** `h` — apare în lista CREATE TABLE; confirmă cu schema-stats.sh
  (probabil tabel-fantomă dintr-un typo). Candidat la ștergere dacă 0 rânduri/0 refs.
- **⚠ DRIFT (NU zombi):** `fixture_positions`, `stats_api_checked`,
  `bulk_referee_checked` — folosite de `ml/train_live_v2.py` și de scripturile de
  backfill, dar **lipsesc din `scripts/create-tables.sql`** (sunt create ad-hoc de
  scripturi pe VPS). Risc: la un rebuild curat de schemă dispar. **Recomandare:**
  adaugă-le în create-tables.sql (CREATE TABLE IF NOT EXISTS).
- **„doar se scrie, rar citit" (candidați review, NU arhivare urgentă):**
  `top_assists`, `coach_stats`, `coach_career`, `prematch_enrichment_log` — câte
  1 singur consumator (sau self). Nu-s zombi, dar ROI-ul colectării lor e mic.
- **Creștere necontrolată (retenție lipsă):** `cron_logs` (28 scriitori),
  `live_stats`/`match_snapshots` (10s), `app_settings` (vezi mai jos). Au nevoie de
  politici de retenție.

## 3. INVESTIGAȚIE app_settings (763.000 rânduri, 1.396 autovacuum-uri)

**Definiție:** `api/backfill.js:90` — `CREATE TABLE app_settings(key PK, value, updated_at)`.
Recreat idempotent și în `backfill-players.js:30`, `extract-team.js:21`.

**Scriitori (cheie | frecvență | citit înapoi):**

| Sursă (file:line) | Cheie/pattern | Frecvență | Cardinalitate | Citit |
|---|---|---|---|---|
| backfill.js:119-121 | `backfill_*_idx` | per-fixture (resume) | SINGLETON | da |
| backfill.js:132-176 | `backfill_api_*` | la 10–20 calls | SINGLETON | da |
| backfill.js:201 | `no_data:stats:<fid>` | per-fixture fără stats | **ÎNALTĂ** | nu* |
| backfill.js:261 | `no_data:events:<fid>` | per-fixture fără events | **ÎNALTĂ** | nu* |
| backfill.js:292 | `no_data:players:<fid>` | per-fixture fără players | **ÎNALTĂ** | nu* |
| backfill.js:384,409 | `h2h_refresh:<t1>:<t2>` | per pereche echipe | ÎNALTĂ | da |
| backfill-players.js:152 | `no_data:players:<teamId>:<season>` | per (echipă,sezon) | **ÎNALTĂ** | da |
| extract-team.js:26 | `extract_team_status` | per update | SINGLETON | da |

\* citite ca „skip cache" la următorul backfill (există → sari API-ul).

**Cauza-rădăcină a celor 763k rânduri:**
1. **`no_data:players:<teamId>:<season>`** (backfill-players.js:152) — **NU e curățat
   NICIODATĂ** de `cleanup-settings.js` (acela șterge doar `h2h_refresh:%` integral
   și `no_data:%` mai vechi de 90 zile, dar pattern-ul se rescrie). Acumulare
   indefinită (~mii echipe × sezoane).
2. **`no_data:stats|events|players:<fid>`** (per-fixture) — păstrate 90 zile; cu
   ~100k+ fixturi backfill-uite × 3 prefixe → sute de mii de markeri „stale".
3. `h2h_refresh:%` — șters lunar integral (cleanup-settings.js:22), nu e sursă
   permanentă, dar produce spike-uri temporare.

**De ce 1.396 autovacuum-uri:** tabel cu PK pe `key` + UPSERT-uri foarte dese
(per-fixture) → multe tuple moarte → autovacuum se declanșează des. E un tabel
„hot churn" deghizat în „setări".

**Recomandare (impact estimat: −90% rânduri, tabel ~70k → ~5k):**
- Mută markerii „no_data" într-un tabel propriu dedicat checkpoint
  (`api_no_data(fixture_id|team_id, kind, season, checked_at)`) cu retenție clară,
  SAU
- Minim: extinde `cleanup-settings.js` să șteargă ȘI `no_data:players:%` (toate, nu
  doar <90z) + scurtează fereastra la 30 zile pe toate `no_data:%`.
- One-time acum: `DELETE FROM app_settings WHERE key LIKE 'no_data:%'` (markerii se
  rescriu la nevoie — pierdere zero, doar re-verifică API-ul pentru cele relipsă).
- Păstrează DOAR cheile singleton `backfill_*` + `extract_team_status` ca „setări".

Distribuția reală a cheilor: vezi `scripts/schema-stats.sh` (top 20 prefixe).
