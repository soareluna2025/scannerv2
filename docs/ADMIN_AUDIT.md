# ADMIN_AUDIT.md — Inventar Admin Panel + Cron-uri (audit din cod, 2026-06)

> Read-only. Buttons din `admin.html`, endpoint-uri din `api/admin.js` +
> `api/cron/*`, crontab canonic din `scripts/setup-crontab.sh`. Pentru cifre
> runtime (rulări/durate/zombi confirmați) → `scripts/admin-audit.sh` pe VPS.
> Total: **33 fișiere cron**, **24 endpoint-uri admin**, **~30 handlere buton**,
> **26 linii crontab**, **17 pași STABILIZARE**, **16 joburi în trigger-cron**.

---

## A) BUTOANELE din admin panel

| Buton (handler) | Endpoint | Ce face | Risc | Verdict |
|---|---|---|---|---|
| onAuthClick | (X-Api-Key local) | login admin | inofensiv | ESENȚIAL |
| refresh | mai multe GET | reîncarcă dashboard-urile | inofensiv | UTIL |
| runHealthCheck | /api/admin/status | uptime/DB/env | inofensiv | UTIL |
| toggleScanner | /api/admin/scanner-toggle | pauză/reia scanner live | atinge live | UTIL |
| startStabilize | /api/admin/stabilize | rulează 17 cron-uri secvențial | **periculos** (cotă/DB, ~40-50min) | ESENȚIAL |
| optimizeDb | /api/admin/optimize-db | VACUUM ANALYZE tabele mari | atinge DB (sigur) | UTIL |
| triggerCron | /api/admin/trigger-cron | rulează 1 job din 16 (fire-and-forget) | depinde de job | ESENȚIAL |
| triggerCalibration ×2 | /api/cron/recalibrate-tables + calibrate-live | recalibrează | atinge DB | REDUNDANT (=2 din trigger-cron) |
| clearErrors ×3 | DELETE /api/admin/clear-errors | golește erorile din cron_logs | atinge date (log) | UTIL |
| loadDbCleanupPreview | /api/admin/db-cleanup-preview | preview curățare | inofensiv | UTIL |
| dbCleanup ×2 | POST /api/admin/db-cleanup | curăță date vechi | **atinge date** | UTIL (cu preview) |
| startBF / stopBF | /api/backfill/start \| stop | backfill istoric (API) | atinge date/cotă API | UTIL |
| startBP / stopBP / resetBP | /api/cron/backfill-players (start/stop/reset) | backfill jucători | atinge date/cotă | UTIL |
| extractTeam | /api/cron/extract-team | colectează o echipă țintit | atinge date/cotă | UTIL |
| searchTeam / selectTeam | /api/admin/team-search + team-season | căutare/inspecție echipă | inofensiv (read) | UTIL |
| loadApiTrend | /api/admin/api-trend | consum API pe zile | read | UTIL |
| loadBetsAggregate | /api/admin/bets-aggregate | agregare pariuri | read | REDUNDANT? (1 din multe tab-uri analytics) |
| loadCalibration | /api/admin/calibration | tabele calibrare | read | UTIL |
| loadLeaguesInsights | /api/admin/leagues-insights | insight per ligă | read | UTIL |
| loadVsApi | /api/admin/vs-api | comparație predicții vs API | read | UTIL |
| loadWinRatePatterns | /api/admin/win-rate-patterns | tipare win-rate | read | UTIL |
| scrollTo / splashTap | — | pur UI | inofensiv | ESENȚIAL(UI) |

**Suprapuneri butoane:**
- `triggerCalibration` ×2 dublează `trigger-cron(recalibrate-tables)` și
  `trigger-cron(calibrate-live)` → REDUNDANT.
- `startBF`/`startBP`/`extractTeam` sunt 3 unelte de backfill cu scopuri parțial
  suprapuse (toate aduc date istorice prin API).
- `dbCleanup` + `optimizeDb` + cron `cleanup-settings` ating toate „curățenia DB".
- 6 butoane `load*` sunt tab-uri de analytics read-only (consolidabile într-un
  singur dashboard cu sub-tab-uri).

---

## B) ENDPOINT-URILE api/cron/* (33) — cine le apelează

| Cron | Ce face | Apelat de | Verdict |
|---|---|---|---|
| scanner | scanner live (setInterval 2/10/3600s) | server.js startScanner (intern) | ESENȚIAL |
| scan | scanner „vechi" (* * * * *) | trigger-cron (manual); ÎNLOCUIT de scanner | 🧟 SUSPECT (legacy) |
| prematch-enrichment | date pre-meci 7 etape | crontab */5 + trigger-cron | ESENȚIAL |
| cazarma-router | router colectare (orchestrează squads/scorers/pass-shots/players-season) | crontab */5 | ESENȚIAL (meta) |
| auto-predict | predicții Poisson meciuri NS | crontab 00:30 + stabilize + trigger-cron | ESENȚIAL |
| update-results (api/) | result_over15/.../winner | crontab 02:00 + stabilize + trigger-cron | ESENȚIAL |
| build-ml-features | feature store ml_features | crontab 03:00 + stabilize | ESENȚIAL |
| collect-finished | stats/players/odds meciuri FT | crontab 23:00 + stabilize + trigger-cron | ESENȚIAL |
| collect-daily | standings/teams/form | crontab 06:00 + stabilize + trigger-cron | ESENȚIAL |
| collect-squads | loturi | crontab 02:05 + stabilize + cazarma-router | UTIL |
| collect-top-scorers | golgheteri | crontab 01:00 + cazarma-router | UTIL |
| collect-players-season | stats jucători/sezon | crontab 01:30 + cazarma-router | UTIL |
| league-stats | statistici per ligă | crontab 04:00 + stabilize + trigger-cron | ESENȚIAL |
| coach-stats | statistici antrenori | crontab 04:00 + stabilize + trigger-cron | UTIL |
| collect-coaches | antrenori | crontab 03:45 + stabilize + trigger-cron | UTIL |
| collect-venues | stadioane | crontab 03:30 + stabilize + trigger-cron | UTIL |
| referee-stats | statistici arbitri | crontab 04:30 + stabilize + trigger-cron | ESENȚIAL |
| referee-extended | arbitri extins | stabilize + trigger-cron | UTIL (suprapune referee-stats) |
| recalibrate-tables | calibrare Brier | crontab Duminică + stabilize + trigger-cron | ESENȚIAL |
| calibrate-live | calibrare praguri live | crontab Duminică + stabilize + trigger-cron | UTIL |
| learning-analysis | model_weights | crontab 03:30 + stabilize + trigger-cron | ESENȚIAL |
| build-elo | reconstruiește elo_history | crontab Luni | ESENȚIAL |
| collect-national-history | istoric naționale | crontab Luni | UTIL (sezonier) |
| backfill-stats-cron | backfill stats istorice | crontab ×3/zi | UTIL |
| cleanup-settings | curăță app_settings/api_markers | crontab lunar | ESENȚIAL |
| train-model | re-antrenare ML pre-meci | crontab 05:30 + stabilize | ESENȚIAL |
| train-live | re-antrenare ML live | crontab 06:30 + stabilize | ESENȚIAL |
| optimize-db | VACUUM ANALYZE | buton admin optimizeDb | UTIL |
| backfill-players | backfill jucători | butoane admin BP | UTIL (manual) |
| backfill-pass-shots | backfill pase/șuturi | cazarma-router | UTIL |
| extract-team | colectare echipă țintit | buton admin | UTIL (manual) |
| backfill-predictions | backfill predicții istorice | **nimeni** (nici crontab, nici admin) | 🧟 SUSPECT |
| collect-team-stats | stats per echipă | **nimeni** automat | 🧟 SUSPECT |
| collect-wc-qualifiers | preliminarii CM | **nimeni** automat | 🧟 SUSPECT (sezonier) |

**Candidați ZOMBI (de confirmat runtime cu admin-audit.sh):** `scan` (înlocuit de
scanner), `backfill-predictions`, `collect-team-stats`, `collect-wc-qualifiers`.

---

## C) HARTA SUPRAPUNERILOR (ce s-ar putea CONSOLIDA)

| Grup | Membri | Suprapunere | Consolidare propusă |
|---|---|---|---|
| Scanner | scanner (intern) + scan (rută) | scan e versiunea veche | scoate `scan` din ALLOWED_JOBS/cronFiles |
| Calibrare | trigger-cron(recalibrate/calibrate) + butoanele triggerCalibration ×2 | dublură 1:1 | șterge butoanele triggerCalibration |
| Backfill | backfill (BF) + backfill-players (BP) + extract-team + backfill-pass-shots + backfill-predictions | toate aduc date istorice | grupare sub un singur card „Backfill" cu sub-acțiuni |
| Curățenie DB | dbCleanup + optimizeDb + cron cleanup-settings | toate fac maintenance | un singur buton „Întreținere DB" (preview→cleanup→vacuum) |
| Arbitri | referee-stats + referee-extended | extended e superset parțial | evaluează contopirea în referee-stats |
| Colectare orchestrată | cazarma-router INCLUDE squads/top-scorers/players-season/pass-shots | cron-uri separate ȘI prin router | nu rula separat ce face deja cazarma-router |
| Antrenori | collect-coaches → coach-stats | lanț (collect apoi compute) | păstrează lanțul, dar un singur trigger |
| ML | build-ml-features → train-model → train-live | lanț | un singur trigger „Re-antrenare ML" |
| Analytics tab-uri | 6 butoane load* (api-trend/bets/calibration/leagues/vs-api/win-rate) | 6 fetch-uri separate | un dashboard cu sub-tab-uri (lazy load) |

---

## RECOMANDĂRI

### 1. Reorganizare STABILIZARE: RAPIDĂ vs COMPLETĂ
Cei 17 pași actuali amestecă „zilnic indispensabil" cu „greu/rar". Propunere:

**STABILIZARE RAPIDĂ (~25-30 min)** — datele proaspete → predicții fresh, fără API greu/antrenare:
`collect-finished → collect-daily → update-results → league-stats → referee-stats
→ build-ml-features → learning-analysis → recalibrate-tables → auto-predict`
(8 pași: brut→rezultate→agregat→features→calibrare→predicții.)

**STABILIZARE COMPLETĂ (~2-3h, situații speciale)** — tot ce e RAPID + greu/rar:
`+ collect-coaches → coach-stats → collect-venues → collect-squads →
referee-extended → calibrate-live → train-model → train-live`
(antrenarea ML + colectările lente API; rulează la nevoie, nu zilnic.)

### 2. Listă de TĂIAT/CONSOLIDAT (ordonată după siguranță)
1. **100% sigur:** șterge butoanele `triggerCalibration` ×2 (dublură exactă a
   trigger-cron). 0 risc.
2. **Sigur după confirmare runtime (admin-audit.sh):** dezactivează rutele
   `scan`, `backfill-predictions`, `collect-team-stats`, `collect-wc-qualifiers`
   dacă 0 rulări în 30 zile.
3. **Consolidare medie:** grupează cele 6 tab-uri analytics `load*` într-un singur
   dashboard cu sub-tab-uri lazy.
4. **Consolidare medie:** un singur card „Backfill" (BF/BP/extract) + un singur
   card „Întreținere DB" (cleanup preview→exec→vacuum).
5. **Evaluare:** contopirea `referee-extended` în `referee-stats`.

### 3. Ce LIPSEȘTE din admin (max 3)
1. **Buton „Re-antrenare ML"** explicit (build-ml-features→train-model→train-live
   secvențial) cu durată/Brier afișat — acum e îngropat în STABILIZARE.
2. **Indicator „cotă API azi"** vizibil permanent (din /api-usage) + alertă la prag,
   ca să nu pornești backfill-uri care ard cota.
3. **Buton „Migrare/Cleanup app_settings"** (rulează migrate-app-settings + arată
   nr. rânduri) — întreținerea nouă din Faza A, acum doar din shell.
