# RAPORT COMPLET — INSPECȚIA GENERALĂ A APLICAȚIEI (AlohaScan Scanner V2)

> Document-adevăr, READ-ONLY. Zero modificări de cod. Generat din inspecția codului pe
> `origin/main` la zi (commit de referință: `9bdbee1`). Toate căile de fix sunt PROPUNERI,
> nu aplicate. Faptele runtime (stări live, conținut DB) sunt marcate **DE VERIFICAT PE VPS**
> cu comanda exactă — nu sunt presupuse.
>
> Cifre inventar: **8 ecrane** principale (+ modal meci cu 7 taburi, pagină echipă 4 taburi,
> hub World Cup 5 taburi, admin ~27 carduri) · **~84 endpoint-uri/handlere** (25 api + 3
> backfill + 27 admin + 28 cron + WS) · **23 probleme** (🔴 7 · 🟠 11 · 🟡 5).

---

## SECȚIUNEA 1 — ECRANELE (frontend)

Shell global: bottom-nav 5 butoane (`index.html:393-414`, `setTab()` `app-state.js:179-207`),
ceas 1s (`app-state.js:164`), bară „Acuratețe model" (`/api/model-accuracy`, refresh 10 min,
`app-state.js:81`), badge-uri learning-leagues (refresh 5 min, `app-state.js:52`), WebSocket
unic (`app-ui.js:25-90`), pull-to-refresh (`app-state.js:857-948`), service worker PWA
(`app-live.js:1485-1491`).

### 1.1 LIVE (`tab-live`, `index.html:71-82`)
- **Afișează:** chips filtru scor + listă meciuri grupate pe ligă (`renderMatches` `app-ui.js:332-390`,
  card `buildCardHtml` `app-ui.js:176-243`: NGP, Over 0.5/1.5/2.5/3.5, H:D:A, λ, confidence),
  card WC featured sus (`app-ui.js:3367-3390`), bară statistici (`app-ui.js:160-169`).
- **Endpoint-uri:** `GET /api/football` (`app-ui.js:142`) + WebSocket `LIVE_UPDATE`/`LIVE_DELTA`
  (`app-ui.js:39-79`) + `/api/enrich` lazy din modal.
- **PROSPEȚIME:** WS = canal principal, cadență server ~2-3s; heartbeat 25s (`app-ui.js:35-37`);
  fallback REST 30s SĂRIT cât timp WS a trimis mesaj în ultimele 60s (`app-ui.js:113-116`).
  **Verdict: REAL-TIME ✅ pe scor/minut/NGP** — DAR vezi ruptura FT (P02/P03).
- **Bug-uri:** LIVE_DELTA nu elimină niciodată meciuri (`app-ui.js:66-74`) → FT atârnă (P02);
  `renderMatches` nu filtrează status terminal (`app-ui.js:332-341`); over-markets pe card =
  recalcul JS din λ euristic (`app-state.js:248-258`), divergent de enrich (P12); `trackWR`
  marchează LOSS orice meci dispărut din `ST.ms` (`app-state.js:796-798`, P11); NGP „—" maschează
  și 0% real (`app-ui.js:209`, P21).

### 1.2 PRE-MECI (`tab-pre`, `index.html:84-115`)
- **Afișează:** date-picker −3..+3 (`app-ui.js:843-863`), listă azi (`renderPM` `app-ui.js:699-816`),
  „Top Oportunități" calibrat (`app-ui.js:510-685`), vizualizare zile trecute (`app-ui.js:865-1076`).
- **Endpoint-uri:** `GET /api/today` (`app-ui.js:448`), `/api/enrich` în batch-uri de 5 (max 100,
  `app-ui.js:483-495`), `/api/matches-history?date=` pentru alte zile (`app-ui.js:871`).
- **PROSPEȚIME:** auto-refresh **30s** DOAR pe ziua curentă cu listă nevidă (`app-live.js:942-962`);
  alte zile NU se refreshează (gardat). **Verdict: ÎNTÂRZIAT ⚠️ ~30s** (acceptabil pre-meci).
  Notă: `today.js:53` trimite `Cache-Control s-maxage=120` → până la 2 min stale via proxy (P14).
- **Bug-uri:** corners/cards în Top-Opps cu fallback-uri magice nebacktestate (`app-ui.js:617-625`,
  P23); `over15Prob||0` poate randa „0%" pentru câmp lipsă (`app-ui.js:748`).

### 1.3 AGENT (`tab-agent`, `index.html:124-144`)
- **Afișează:** rând statistici + chat. **Endpoint:** `POST /api/agent` (Claude, `app-live.js:60`).
- **PROSPEȚIME:** **STALE prin design** — fără timer; statistici = snapshot la deschiderea tabului
  (`app-state.js:193`). **Verdict: ÎNTÂRZIAT ⚠️** (snapshot static, se învechește cât citești).
- **Bug:** Win Rate din `trackWR` localStorage → moștenește defectul „dispărut = LOSS".

### 1.4 PREFERATE (`tab-fav`, `index.html:117-122`)
- **Afișează:** carduri live + viitoare din localStorage (`renderFavs` `app-live.js:870-934`).
- **PROSPEȚIME:** re-render **30s** când tabul e activ (`app-live.js:961`); favoritele live citesc
  din `ST.ms` indirect. **Verdict: ÎNTÂRZIAT ⚠️ ~30s**.
- **Bug:** favorit a cărui meci a părăsit `ST.ms` afișează snapshot vechi de la salvare (`app-live.js:897-903`).

### 1.5 GENEREAZĂ (`gen2-ov`, S1–S7, `index.html:218-390`)
- **Afișează:** wizard (mod→categorie→sub→TOP10→detaliu→Simulator→Bilet). Scoring g2Score
  (`app-live.js:209-403`), live-adjust (`app-live.js:410-494`), Simulator Monte-Carlo, Bilet Compus.
- **Endpoint-uri:** `/api/generator?mode=` (`app-live.js:188`), `?action=accumulator` (`app-live.js:736`),
  `/api/simulate` (`app-live.js:1045`).
- **PROSPEȚIME:** **STALE prin design** — ZERO timere; fetch o singură dată per intrare în piață;
  live-adjust calculat doar la render. **Verdict: ÎNTÂRZIAT ⚠️/STALE** (nu se actualizează live).
- **Bug-uri:** contor animat fake decuplat de simularea reală (`app-live.js:1033-1042`, P20);
  scoring complet reimplementat în JS, paralel cu serverul (Secțiunea 5/A4).

### 1.6 MODAL DETALIU MECI (`md-overlay`, `index.html:149-168`)
Taburi: **SUMAR(0) FORMAȚII(1) JUCĂTORI(2) FORMĂ(3) CLASAMENT(4) STATISTICI(5) 🤖 ML(6)**.
**NU există tab H2H separat** — H2H trăiește în FORMĂ(3) și SUMAR(0) (`buildH2HMatchDetail`).
- **Endpoint-uri:** `GET /api/match?id=&h=&a=` (`app-ui.js:1121`) + `/api/enrich` overlay.
- **PROSPEȚIME modal:** auto-refresh **10s DOAR pentru meciuri LIVE** (`_mdRefreshTimer`,
  `app-ui.js:1155-1166`); meciuri ne-live = fetch o dată. **Verdict: REAL-TIME ✅ (live, 10s)**.

| Tab | Renderer | Sursă date | Prospețime | Bug-uri (file:line) |
|-----|----------|-----------|-----------|---------------------|
| SUMAR | `app-ui.js:2006-2668` | enrich + venue-weather | 10s live | „Probabilitate marcare" live multiplică factori euristici, oscilează între refresh-uri (`app-ui.js:1917`); NGP modal re-derivă `_ng` (P09) |
| FORMAȚII | `app-ui.js:2670-2722` | `d.lineups` | 10s live | rating după id; lipsă → fără rating |
| JUCĂTORI | `app-ui.js:2738-2776` | `d.players` | 10s live | jucători fără rating/goluri săriți |
| FORMĂ | `app-ui.js:2888-2939` | `d.enrich` | 10s live | H2H gardat corect pe `h2hSample>0` |
| CLASAMENT | `app-ui.js:2989-3096` | `/api/standings-data` | **cache fără TTL** (`app-ui.js:1186`) | season fallback pre-iulie (`app-ui.js:2996`); stale în sesiune (P16) |
| STATISTICI | `app-ui.js:1218-1276` | `d.matchStats` | 10s live | possession/pass% fără normalizare (`app-ui.js:1257`) |
| 🤖 ML | `app-ui.js:1373-1786` | `d.mlPredictions`/`d.mlLive` | 10s live | norm3 normalizează doar când toate 3 clase prezente (`app-ui.js:1417`); restul respectă Ziua 3 |

### 1.7 PAGINĂ ECHIPĂ (`tp-overlay`, `index.html:170-186`)
Taburi JUCĂTORI/FORMĂ/CLASAMENT/STATISTICI. **Endpoint:** `GET /api/team` (`app-ui.js:3133`).
**PROSPEȚIME:** fără timer — fetch o dată. **Verdict: STALE prin design** (referință, OK).

### 1.8 HUB WORLD CUP (`wc-overlay`, `index.html:188-205`)
Taburi (rescrise la deschidere `app-ui.js:3400-3405`): GRUPE/MECIURI/CALIFICĂRI/BRACKET/PONTUL.
- **Endpoint-uri:** `GET /api/worldcup` (`app-ui.js:3420`, o dată), `/api/worldcup-qualifiers`
  (`app-ui.js:3588`, cache).
- **PROSPEȚIME:** **STALE ❌** — fără timer; date scrise cel mult 1/zi (vezi P01/P05/P13).
- **Bug-uri:** ordine taburi inconsistentă `index.html:196-200` vs `app-ui.js:3400-3405` (P18);
  „N LIVE" pe `league.id===1` hardcodat (`app-ui.js:3379`); afiliat placeholder (`app-ui.js:3294`, P22).

### 1.9 ADMIN PANEL (`admin.html`, ~27 carduri → `/api/admin/*`, auth `X-Api-Key`)
Carduri principale (toate fetch on-demand, fără timere): Status sistem (`:1464`), DB-stats (`:1533`),
API-usage + trend (`:1581`, `:2496`), Live-matches (`:1622`), Cron-status/health (`:1706`,`:1690`),
Erori (`:1728`), Trigger-cron (`:1648`), Optimizare DB (`admin.js:470`), **Stabilizare completă DB**
(`:2077`, lanț `STABILIZE_STEPS` `admin.js:500-501`), Win-rate patterns (`:2217`), Calibrare (`:2296`),
Leagues-insights (`:2599`), Scanner state/toggle (`:2458`,`:2476`), DB-cleanup (`:2578`), vs-API (`:2642`).
- **Verdict prospețime:** on-demand (proaspăt la apăsare).
- **Bug 🔴:** `admin.html:2369` cheamă `/api/admin/bets-aggregate` care **NU există** în `api/admin.js`
  → card 404 (P04). 3 endpoint-uri admin definite dar neapelate (prediction-accuracy/access-log/
  learning-stats) — moarte.

---

## SECȚIUNEA 2 — CICLUL DE VIAȚĂ AL UNUI MECI (firul roșu)

| Fază | Cine detectează | Tabele scrise | Ecrane reflectă | CÂND |
|------|-----------------|---------------|-----------------|------|
| **NS** (programat) | `collect-daily.js:35-111` (06:00) + `today.js:197-236` (la cerere) | `fixtures`, `teams`, `predictions` (Poisson, `collect-daily.js:175-262`) | PRE-MECI | zilnic 06:00 + ad-hoc |
| pre-kickoff | `prematch-enrichment.js` (*/5) | `prematch_data` (7 etape) | enrich modal | la 5 min |
| **KICKOFF→LIVE** | `scanner.js` `scanLive10s` la **2s** (`scanner.js:902`) | `match_snapshots` (~2s), `live_stats` (10s) | LIVE (WS) + `/api/football` | ~2s |
| **GOL/eveniment** | diff goals (`scanner.js:547`) → fetch events | `match_snapshots`, `alerts`, `predictions`(PENDING) | LIVE_DELTA push | ~2s |
| **HT** | status='HT' (PAUSED) | snapshot îngheț acceptat | label „Pauză" | ~2s |
| **FT/AET/PEN** | `scanLive10s` vede DONE (`scanner.js:501`) | `fixtures_history`(FT), `form_stats`; `liveCache` ȘTERS | **RUPTURĂ** (vezi mai jos) | ~2s în DB |
| **post-meci** | `collect-finished.js`(23:00), `update-results.js`(02:00), `build-elo`(Lun) | `player_stats`,`match_stats`,`predictions`(rezolvate),`elo_history` | admin/istoric | zilnic/săptămânal |

**RUPTURI marcate:**
- **#A2 (= bug a):** la FT scanner face `continue` înainte de broadcast (`scanner.js:501-512`) →
  meciul nu mai e în delta, dar LIVE_DELTA n-are semnal de removal (`scanner.js:731-732`,
  `server.js:255-261`) iar frontend doar adaugă/actualizează (`app-ui.js:66-74`). Dispare abia la
  următorul FULL broadcast (la 5 min) sau reload REST.
- **#A3:** tabela `fixtures` rămâne `status_short='NS'`/goluri NULL după FT pentru meciuri de ligă
  (nimeni nu o trece pe FT din live); sursa corectă FT = `fixtures_history`. Endpoint-urile care
  citesc din `fixtures` (ex. `worldcup.js`) văd date învechite.

### Cele 3 simptome raportate AZI — cauze exacte

**(a) Meciurile terminate apar încă LIVE.** ROOT CAUSE: protocol WS fără removal + `renderMatches`
nu filtrează status terminal (`app-ui.js:66-74`, `:332-341`; `scanner.js:501-512`,`:731-732`).
Agravant: **freeze-state** (`freeze-state.js:11-12`) — un meci pe care API-Football îl retrimite ca
live cu minut BLOCAT rămâne vizibil până la `FREEZE_MS=10min` (observed, **se pierde la restart PM2**)
sau `STALE_DRIFT_MS=75min` (drift, restart-proof) sau 90s prune-by-absence. **Fereastră reală:
≤5 min normal, până la ~75 min după un restart PM2.** Suspect secundar: enrichCache STATIC 10 min
(`enrich.js:18`) + enrichCache football 5 min (`football.js:40`).

**(b) Grupele/scorurile World Cup nu se actualizează.** ROOT CAUSE triplu:
- **B1 scoruri:** writer-ul WC `collectWorldCupSchedule` (`collect-daily.js:144-164`) **NU scrie
  `home_goals`/`away_goals`** → `fixtures` WC mereu NULL → `worldcup.js:42,72` → scor gol. Scannerul
  live NU atinge `fixtures` (doar snapshots/live_stats).
- **B2 grupe:** standings WC se scriu prin bucla principală (`collect-daily.js:300-376`, league=1 în
  whitelist `leagues.js:384`) DAR `worldcup.js:12` cere hardcodat `WC_SEASON=2026`; dacă
  `seasonForLeague(1)` scrie alt an → „Grupe indisponibile". **Frecvență: 1/zi (06:00).**
- **B3 calificări:** `collect-wc-qualifiers` **NU e în crontab** (`setup-crontab.sh`; fișierul însuși
  zice „rulare manuală", `collect-wc-qualifiers.js:5`) → nu se reîmprospătează automat.

**(c) Lista meciurilor WC e haotică.** ROOT CAUSE: atribuire euristică meci→grupă
(`worldcup-qualifiers.js:126` `teamGroup.get(home)||teamGroup.get(away)`) — `fixtures_history` n-are
`group_name` (`:6-7`), fallback la pseudo-grupa 'Clasament' (`:112`), iar meciurile neatribuibile sunt
**sărite silențios** (`:127 if(!g) continue`). Secundar: în `worldcup.js` lipsește tie-break la
`match_date` egal și ordinea logică a rundelor knockout (`brMap` păstrează ordinea de inserție,
`worldcup.js:155-168`); `day` UTC mută meciurile de seară pe ziua următoare (`worldcup.js:64-65`).

**DE VERIFICAT PE VPS (b/c):**
```
psql -U alohascan -d elefant -c "SELECT season,count(*) FROM standings WHERE league_id=1 GROUP BY season;"
psql -U alohascan -d elefant -c "SELECT status_short,count(*),count(home_goals) FROM fixtures WHERE league_id=1 GROUP BY status_short;"
curl -s localhost:3000/api/worldcup | jq '{groups:(.groups|length), scored:[.matches[]|select(.homeGoals!=null)]|length}'
```

---

## SECȚIUNEA 3 — BACKEND COMPLET (inventar + verdict)

Mount: `apiFiles` `server.js:51-70`, `cronFiles` `server.js:73-98`, admin `server.js:101`, backfill
`:114/127/137`, static/SPA `:33/37/148`, WS `:223-261`, scanner pornit la boot `:204`.

**API (25):** ACTIVE — football, today, enrich, match, agent, update-results, health-check, simulate,
generator, standings-data, venue-weather, learning-leagues, calibration, matches-history,
model-accuracy, team, worldcup, worldcup-qualifiers. **MOARTE** — `/api/players`, `/api/db-stats`
(UI folosește `/api/admin/db-stats`), `/api/backfill-stats` (UI folosește `/api/backfill/status`),
`/api/debug-live`. **RUTĂ MOARTĂ, COD VIU** — `/api/elo`, `/api/monte-carlo`, `/api/match-momentum`
(fără apel HTTP, dar funcțiile importate de `simulate.js:1-3` → fișierele NU se șterg).

**Admin (27):** majoritar ACTIVE. MOARTE (definite, neapelate de `admin.html`): `prediction-accuracy`
(`admin.js:605`), `access-log` (`:640`), `learning-stats` (`:645`). CONSUMATOR FĂRĂ PRODUCĂTOR:
`admin.html:2369 → /api/admin/bets-aggregate` inexistent (**404**).

**Cron (28):** ACTIVE (în crontab) — prematch-enrichment, cazarma-router, auto-predict,
build-ml-features, collect-squads, collect-finished, collect-daily, collect-top-scorers,
collect-players-season, league-stats, coach-stats, referee-stats, collect-venues, collect-coaches,
learning-analysis, recalibrate-tables, calibrate-live, build-elo, collect-national-history,
cleanup-settings + `/api/update-results`. RULATE DOAR DIN STABILIZARE/admin (nu în crontab):
referee-extended, build-ml-features(și aici), train-model/train-live (wrappere; antrenarea reală =
Python `ml/train_*.py` în crontab). **MOARTE/NEPROGRAMATE:** `backfill-pass-shots` (fără caller),
`collect-wc-qualifiers` (relevant pentru bug b3). MANUALE din admin: backfill-players, extract-team,
optimize-db.

---

## SECȚIUNEA 4 — FLUXURI DE DATE & CACHE-URI (19 straturi)

| # | Cache | file:line | TTL | Invalidare | Risc stale |
|---|-------|-----------|-----|-----------|-----------|
| 1 | enrichCache (enrich.js) | `enrich.js:16-18` | LIVE 60s / STATIC 600s | TTL + FIFO>200 | **MARE** (FT „static" servit ≤10 min) |
| 2 | _avgStats/_avgEvents | `enrich.js:26-27` | zilnic UTC | prune zi | mic |
| 3 | _h2hCache | `enrich.js:28-30` | 3h | TTL + >2000 | mic |
| 4 | _injuriesCache | `enrich.js:896-897` | 30min | TTL | lineup-uri ≤30min vechi |
| 5 | enrichCache (football.js) | `football.js:39-40` | 5min | TTL + >200; `no-store` HTTP | **MARE** (payload live servit ≤5min) |
| 6 | weights | `weights.js:4-6` | 1h | refresh non-blocking | schimbare greutate ≤1h |
| 7 | weatherCache | `venue-weather.js:3-4` | 30min | TTL | meteo ≤30min |
| 8 | formCache (scanner) | `scanner.js:74-75` | 1h | TTL | mic |
| 9 | liveCache | `scanner.js:32` | delete la DONE; prune 90s | absență 90s | meci „fantomă" ≤90s |
| 10 | _lastBroadcastSnap | `scanner.js:34` | FULL la 5min / DELTA la schimbare | — | **FT fără delta până la FULL (≤5min)** |
| 11 | prematchCache | `scanner.js:33` | 60min | — | compozit ≤60min |
| 12 | **freeze-state** | `freeze-state.js:11-12` | observed 10min / drift 75min | unfreeze la avans minut | **PRIME SUSPECT „FT pare live"** |
| 13 | _pmEnrich | `app-ui.js:396` | refetch>60s | golit la reload | 60s |
| 14 | _genLiveEnrich | `app-live.js:73` | refetch>60s | — | 60s |
| 16 | _standingsCache | `app-ui.js:1186` | **fără TTL** | sesiune | clasament stale în sesiune |
| 17 | _venueWeatherCache | `app-ui.js:1187` | **fără TTL** | sesiune | mic (per fixture) |
| 18 | _mevCache | `app-state.js:610` | manual la închidere card | — | — |
| 19 | WS client watchdog | `app-ui.js:113-114` | 60s | — | declanșează REST fallback |

**Prospețime per tabel:** `match_snapshots` ~2s · `live_stats` 10s · `fixtures` zilnic 06:00 + ad-hoc ·
`fixtures_history` real-time la FT (scanner) · `predictions` enrich/colectare + rezolvare 2-10s/02:00 ·
`standings` zilnic 06:00 · `league_stats` zilnic 04:00 · `prematch_data` */5 · **`elo_history`
SĂPTĂMÂNAL (Lun 06:00)** — cel mai rar.

**DE VERIFICAT PE VPS:** `crontab -l` (poate diferi de `setup-crontab.sh`); `pm2 logs alohascan | grep -E 'FREEZE|prune'`;
`psql -c "SELECT 'snap',max(updated_at) FROM match_snapshots UNION ALL SELECT 'elo',max(created_at) FROM elo_history UNION ALL SELECT 'stand',max(updated_at) FROM standings;"`

---

## SECȚIUNEA 5 — INTEGRITATE & COERENȚĂ

**A. Aceeași informație, surse diferite (risc contradicție pe ecran):**
- **1X2** — 4 surse: enrich Poisson (`app-ui.js:224,761,2481`; `app-live.js:915`); inverse-Poisson din
  cotele tastate care SUPRASCRIE în SUMAR (`app-state.js:736-748,719`); ML `result_final` normalizat
  (`app-ui.js:1519-1538`); Monte-Carlo (`app-live.js:1102-1104`). + badge ELO (`app-ui.js:2158-2160`).
- **Scor live** — 3 obiecte: `/api/football` `ST.ms` (~2s WS), `/api/match` `d.fixture.goals` (10s
  modal), `/api/matches-history` (`app-ui.js:1027`), `/api/simulate` (`app-live.js:1082`) → card vs
  modal pot diverge momentan.
- **NGP** — card `m._ng` WS (`app-ui.js:209`) vs modal re-derivat+recalibrat (`app-ui.js:2359-2362`,
  re-derivă chiar `_ng`-ul copiat la `:2356`) vs ML „următorul gol" model separat (`app-ui.js:1577`).
- **Over1.5/2.5/GG** — până la 5 surse (calcScore JS card / enrich / Top-Opps calibrat / ML market /
  MC calibrat / pattern-adjusted) — `app-ui.js:215-218` vs `:226` vs `:591-602` vs `:1523-1535`;
  `app-live.js:1132-1162`; `app-state.js:525-569`.

**B. Calcule divergente (același concept, formulă diferită):** Poisson reimplementat în JS în ≥6 locuri
(`app-state.js:210-220,449-489`; `app-live.js:198-208,410-494`; `app-ui.js:532-537,1827,1917`); NGP
recalibrat în JS (`app-state.js:331-350`); scoring generator paralel cu serverul (`app-live.js:209-403`).
✅ Monte-Carlo NU e reimplementat (10k server-side `app-live.js:1045`; literalii „10000" sunt doar UI).

**C. NULL/lipsă → 0%/NaN/gol în UI:**
- 🔴 **NaN%** — `over25Prob`/`ggProb` via `Math.round` fără `||0`, gardate doar de `over15Prob!=null`
  (`app-ui.js:2452,2453,2463,2464`).
- 🟠 **null%** — `draw`/`awayWin` randate când doar `homeWin!=null` (`app-ui.js:224,761`; `app-live.js:915`).
- 🟠 **undefined%** — over-markets card `mk.over05/15/25/35` fără gardă per-cheie (`app-ui.js:215-218`).
- 🟡 **„0%" înșelător** — `over15Prob||0` (`app-ui.js:748`), `cardsOver35||0` etc. (nu NaN, dar fals 0).

---

## SECȚIUNEA 6 — REGISTRUL PROBLEMELOR

| ID | Sev | Ecran/zonă | Descriere | Cauză (file:line) | Efort |
|----|-----|-----------|-----------|-------------------|-------|
| P01 | 🔴 | World Cup | Scoruri WC mereu NULL în UI | writer-ul WC nu scrie goluri `collect-daily.js:144-164` → `worldcup.js:42,72` | M |
| P02 | 🔴 | LIVE | Meci FT rămâne afișat ca live (WS) | LIVE_DELTA fără removal `app-ui.js:66-74`; `renderMatches` fără filtru status `:332-341`; `scanner.js:731-732` | M |
| P03 | 🔴 | LIVE | FT „blocat" persistă 10–75 min | `freeze-state.js:11-12` (observed pierdut la restart PM2) | M |
| P04 | 🔴 | Admin | Card cheamă endpoint inexistent (404) | `admin.html:2369 → /api/admin/bets-aggregate` nedefinit | S |
| P05 | 🔴 | World Cup | Calificările nu se actualizează automat | `collect-wc-qualifiers` neprogramat în `setup-crontab.sh` (`:5`) | S |
| P06 | 🔴 | LIVE/modal | NaN%/null%/undefined% în UI | `app-ui.js:2452-2464`, `:224,761`, `:215-218`; `app-live.js:915` | S |
| P07 | 🔴 | World Cup | „Grupe indisponibile" pe mismatch season | `worldcup.js:12` WC_SEASON=2026 vs `seasonForLeague(1)` — **DE VERIFICAT PE VPS** | S |
| P08 | 🟠 | global | Același 1X2/NGP/Over% din motoare diferite per view | Secțiunea 5/B (multe locuri) | L |
| P09 | 🟠 | modal SUMAR | NGP card ≠ NGP modal (re-derivare) | `app-ui.js:2356-2362` | M |
| P10 | 🟠 | World Cup | Listă WC dezordonată | atribuire euristică `worldcup-qualifiers.js:126`, skip silent `:127`; lipsă tie-break `worldcup.js` | M |
| P11 | 🟠 | LIVE/Agent | Win-rate local corupt („dispărut = LOSS") | `app-state.js:796-798` | S |
| P12 | 🟠 | LIVE card | Over-markets din λ euristic, divergent de enrich | `app-state.js:248-258` | M |
| P13 | 🟠 | World Cup | Tot WC se reîmprospătează ≤1/zi | `collect-daily.js` 06:00; scanner nu atinge `fixtures` | M |
| P14 | 🟠 | PRE-MECI | Listă pre-meci ≤2 min stale via proxy | `today.js:53` s-maxage=120 | S |
| P15 | 🟠 | ELO/ML | `elo_history` doar săptămânal → feature ELO lag ≤7 zile | `build-elo` crontab Lun (`setup-crontab.sh:57`) | M |
| P16 | 🟠 | modal CLASAMENT | Clasament cache fără TTL, stale în sesiune | `app-ui.js:1186,3007-3023` | S |
| P17 | 🟠 | LIVE | enrichCache poate servi payload calculat cât era live | `enrich.js:18`, `football.js:40` | S |
| P18 | 🟠 | World Cup | Ordine taburi inconsistentă markup vs runtime | `index.html:196-200` vs `app-ui.js:3400-3405` | S |
| P19 | 🟡 | Backend | Endpoint-uri/cron moarte | players, db-stats, backfill-stats, debug-live, elo/monte-carlo/match-momentum (rută), admin ×3, backfill-pass-shots | S |
| P20 | 🟡 | Generator | Contor MC fake decuplat de simulare | `app-live.js:1033-1042` | S |
| P21 | 🟡 | LIVE card | NGP „—" maschează 0% real | `app-ui.js:209` | S |
| P22 | 🟡 | World Cup | URL afiliat placeholder | `app-ui.js:3294` | S |
| P23 | 🟡 | PRE-MECI | Corners/cards Top-Opps cu fallback-uri nebacktestate | `app-ui.js:617-625` | M |

**Efort:** S = mic (<1h) · M = mediu (câteva ore) · L = mare (refactor).

---

## NOTE DE ONESTITATE
- Toate faptele de mai sus provin din inspecția codului pe `origin/main`. Stările runtime
  (ce e efectiv live acum, conținut DB, crontab instalat) sunt marcate **DE VERIFICAT PE VPS**
  cu comanda exactă — nu sunt presupuse.
- Zero modificări de cod. Zero fix-uri. Acesta e DOAR raport. Înainte de orice fix la scanner/NGP
  respectă „COD INTANGIBIL" din `CLAUDE.md` (calcConfidence*, score1-7, lambda, Monte Carlo 10k).
- Acoperire: Secțiunile 1, 2, 6 — complete. Secțiunile 3, 4, 5 — complete pentru zonele inspectate
  (frontend `public/js/*`, `api/*`, `api/cron/*`, `server.js`, `admin.html`, crontab). Nu au fost
  rulate procese; nu s-a citit DB-ul live.
