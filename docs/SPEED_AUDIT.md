# SPEED_AUDIT.md — Audit viteză lanț LIVE (scanner 10s → enrich → WS → UI)

> Analiză din cod (read-only). TOP 10 recomandări ordonate după (impact / efort).
> Fiecare: problemă · dovadă (file:line) · soluție · risc. ZERO modificări în
> sesiunea asta — doar plan.

## Context măsurat (din docs/DB_HEALTH.txt)
- `predictions`: ~877k seq scans, ~37 mld tuple citite → query-uri fără index pe hot path.
- `app_settings`: 763k rânduri (vezi SCHEMA.md §3).
- Pool PG `max=25` (`api/db.js:5`). WebSocket cu `perMessageDeflate` ON, level 3
  (`server.js:209-216`). Enrich are cache 60s live / 600s static (`enrich.js:16-18`).

---

## TOP 10 (impact↓ / efort)

### 1. enrich recalculează LATERAL-uri grele deja MATERIALIZATE în ml_features  — IMPACT MARE / EFORT MIC-MEDIU
- **Problemă:** la fiecare /api/enrich (cache miss la 60s pe meci live), se rulează
  `getMatchStatsAvg` ×2 și `getMatchEventsAvg` ×2 — LATERAL + AVG/GROUP BY peste
  ultimele 100 de meciuri per echipă. Exact aceste valori sunt DEJA precalculate în
  tabela `ml_features` (rolling-100, point-in-time) de `build-ml-features.js`.
- **Dovadă:** `api/enrich.js:1149` (getMatchStatsAvg), `:1177` (getMatchEventsAvg),
  apelate în Promise.all ~`:1229-1232`; sursa identică = `api/cron/build-ml-features.js`
  (LATERAL msh/msa/meh/mea). Tabela `ml_features` are PK `fixture_id`.
- **Soluție:** în enrich, dacă `fid` are rând în `ml_features`, citește de acolo
  (1 SELECT pe PK) în loc de 4 LATERAL-uri grele; fallback la LATERAL doar dacă
  lipsește. Reduce ~4 query-uri grele → 1 indexat per enrich.
- **Risc:** mic — valorile sunt aceleași (sursă canonică comună). Doar pentru meciuri
  fără rând ml_features (rezerve) rămâne calea veche.

### 2. Indecși lipsă pe `predictions` (877k seq scans pe hot queries)  — IMPACT MARE / EFORT MIC
- **Problemă:** query-uri pe `predictions` filtrate fără `fixture_id` → seq scan pe
  877k rânduri (resolve rezultate, analytics, admin).
- **Dovadă:** `api/update-results.js:132` (`WHERE result_over15 IS NULL AND match_date<NOW()`),
  `api/cron/backfill-predictions.js:142` (`WHERE result_winner IS NOT NULL`),
  `api/model-accuracy.js:49` (`WHERE result_over15 IS NOT NULL`),
  `api/cron/learning-analysis.js` (`league_id + result_over15`), `api/admin.js` (league_name).
- **Soluție:** indecși parțiali/compuși:
  `CREATE INDEX CONCURRENTLY idx_pred_unresolved ON predictions(match_date) WHERE result_over15 IS NULL;`
  `... idx_pred_result_winner ON predictions(result_winner) WHERE result_winner IS NOT NULL;`
  `... idx_pred_league_res ON predictions(league_id, result_over15);`
- **Risc:** mic — index parțial e ieftin la scriere; CONCURRENTLY = fără lock.

### 3. app_settings 763k — cleanup lipsă pe `no_data:players:%`  — IMPACT MARE / EFORT MIC
- **Problemă:** markerul `no_data:players:<team>:<season>` nu e curățat niciodată →
  acumulare; tabel „setări" devine hot-churn (1.396 autovacuum).
- **Dovadă:** `api/cron/backfill-players.js:152` (scrie), `api/cron/cleanup-settings.js:22-31`
  (curăță doar `h2h_refresh:%` + `no_data:%` >90z — dar pattern-ul se rescrie).
- **Soluție:** extinde cleanup-settings.js (DELETE `no_data:players:%` integral +
  fereastră 30z pe restul `no_data:%`); one-time `DELETE ... WHERE key LIKE 'no_data:%'`.
  Pe termen lung: tabel checkpoint dedicat. (Detalii în SCHEMA.md §3.)
- **Risc:** mic — markerii sunt skip-cache regenerabili (pierdere zero).

### 4. enrich: cache separat „fix-după-kickoff" cu TTL lung  — IMPACT MARE / EFORT MEDIU
- **Problemă:** blocul de date care NU se schimbă în timpul meciului (ml_features,
  ELO, H2H istoric, form, league/referee/standings) e recalculat la fiecare miss de
  60s. Doar scorul/minutul/live_stats se schimbă intra-meci.
- **Dovadă:** `api/enrich.js:16-18` (un singur cache, TTL 60s live), Promise.all
  `:1229-1259` reface TOT la fiecare miss.
- **Soluție:** două nivele — cache „static per fixture" (ml_features/ELO/H2H/form/…)
  cu TTL lung (până la FT) + recalcul doar al părții live (live_stats/scor/minut/ML).
  Reduce drastic query-urile pe meciuri lungi.
- **Risc:** mediu — trebuie izolat clar ce e „static după kickoff" vs „live"; nu
  atinge scoring (doar caching).

### 5. Scanner: getFormGoals = N×2 query-uri/tick (atenuat de formCache)  — IMPACT MEDIU / EFORT MEDIU
- **Problemă:** per tick (2s), per meci live, per echipă → 2 query-uri formă; ~80
  query-uri/2s la 20 meciuri (mitigat de `formCache` TTL 3600s, dar miss pe echipe noi).
- **Dovadă:** `api/cron/scanner.js:447` (apel per echipă), `getFormGoals` ~`:97-121`;
  cache `:74-76`.
- **Soluție:** batch — un singur query `WHERE team_id IN (toate echipele live)` per
  tick, populează formCache odată. Elimină N+1.
- **Risc:** mediu — rescriere localizată a prefetch-ului; nu atinge scoringul.

### 6. WebSocket: payload DELTA tot trimite obiectul complet al meciului  — IMPACT MEDIU / EFORT MEDIU
- **Problemă:** la delta se trimite obiectul meci ~2-3KB, deși s-au schimbat doar
  4 câmpuri (scor/elapsed/status/_ng). Compresia ajută (~−60%) dar CPU+bandă rămân.
- **Dovadă:** `api/cron/scanner.js:697-721` (diff pe 4 câmpuri, dar trimite `m` întreg),
  `server.js:239-245` (`wsBroadcast` JSON.stringify integral).
- **Soluție:** payload delta minimal `{fixture_id, hg, ag, elapsed, status, _ng}`
  (~200B); UI face merge pe snapshot-ul local. Full snapshot rămâne la 5 min.
- **Risc:** mediu — UI trebuie să știe să fuzioneze delta (modificare client).

### 7. ml-predict: recalcul la fiecare tick chiar cu stare neschimbată  — IMPACT MIC-MEDIU / EFORT MEDIU
- **Problemă:** `predictAllMarkets`/`predictLiveMarketsV2` se rerulează la fiecare
  enrich chiar dacă (scor, minut-bucket, cartonașe) sunt identice. Inferența e ieftină
  (~0.5ms) dar redundantă × multe meciuri.
- **Dovadă:** `api/ml-predict.js:244`, `:380` (stateless, fără memoizare); apelate din
  `api/enrich.js:1884` și `:1935`.
- **Soluție:** memoizare pe cheie `(fixture_id, hg, ag, floor(elapsed/5), cards)` →
  returnează predicția cache-uită dacă starea nu s-a schimbat.
- **Risc:** mic — pură optimizare; cheia de stare e exactă (ML depinde doar de ea + features fixe).

### 8. Schema drift: 3 tabele noi lipsesc din create-tables.sql  — IMPACT MEDIU / EFORT MIC
- **Problemă:** `fixture_positions`, `stats_api_checked`, `bulk_referee_checked` sunt
  folosite de ml/scripts dar create doar ad-hoc → la un rebuild de schemă dispar.
- **Dovadă:** absente în `scripts/create-tables.sql`; create în
  `scripts/backfill-positions.py`, `backfill-stats-api.py`, `backfill-referee-bulk.py`.
- **Soluție:** adaugă `CREATE TABLE IF NOT EXISTS` pentru cele 3 în create-tables.sql.
- **Risc:** mic — idempotent.

### 9. Tabel ZOMBI `bookmakers` (+ `h`) — curățenie schemă  — IMPACT MIC / EFORT MIC
- **Problemă:** `bookmakers` definit dar nefolosit ca tabel (refs = JSON din API);
  `h` apare în schemă, suspect.
- **Dovadă:** `scripts/create-tables.sql:522` (`bookmakers`); zero query SQL pe el.
- **Soluție:** confirmă cu schema-stats.sh (0 rânduri/0 refs) apoi `DROP TABLE`
  într-o fază viitoare. NU acum.
- **Risc:** mic — doar după confirmare 0 rânduri.

### 10. Retenție pentru tabele cu creștere necontrolată  — IMPACT MEDIU / EFORT MIC
- **Problemă:** `cron_logs` (28 scriitori), `live_stats`/`match_snapshots` (10s),
  `app_settings` cresc fără limită → bloat + indecși umflați.
- **Dovadă:** `api/cron/scanner.js` (scrie live_stats/match_snapshots la fiecare tick);
  toate cron-urile scriu cron_logs.
- **Soluție:** job de retenție (ex. `DELETE FROM cron_logs WHERE ran_at < NOW()-INTERVAL '30 days'`;
  `live_stats`/`match_snapshots` pentru meciuri FT mai vechi de N zile). Rulat în
  cleanup-settings sau un cron nou.
- **Risc:** mic — datele vechi nu-s pe hot path.

---

## Cu ce aș începe (ordine pragmatică)
1. **#2 indecși predictions** (efort minim, oprește seq scan-urile imediat).
2. **#3 cleanup app_settings** (one-time DELETE + patch cleanup — câștig instant pe 763k).
3. **#1 enrich citește ml_features** (cel mai mare câștig pe latența live; sursă deja existentă).
4. **#4 cache static-după-kickoff** (consolidează #1 pe tot blocul fix).
5. Restul (#5–#10) după ce hot-path-ul live e degrevat.
