# REGULI CLAUDE — AlohaScan Scanner V2

> Acest fișier = CONSTITUȚIA proiectului: DOAR reguli vii și pointeri (țintă ≤250 linii).
> Istoric decizii/sesiuni: vezi `CHANGELOG.md` și `SESSION_CONTEXT.txt`.
> Sursa adevărului tehnic = CODUL; documentația de mai jos îl rezumă, nu îl înlocuiește.

---

## FORMAT RĂSPUNS OBLIGATORIU
Pune TOT răspunsul tău într-un SINGUR bloc de cod (triple backticks), astfel încât
să apară butonul de copy în colțul dreapta-sus. Nu scrie NIMIC în afara acelui bloc.
Regula se aplică TUTUROR răspunsurilor, în TOATE sesiunile — inclusiv rapoartelor
finale, rezumatelor și mesajelor scurte. Fără excepții.

---

## COD INTANGIBIL — NU MODIFICA NICIODATĂ
Interzise oricărui agent, indiferent de context:
- `calcConfidencePreMatch()` — funcția și greutățile layerelor
- `calcConfidenceLive()` — funcția și greutățile layerelor
- `score2` (formula cu apărare), `score3` (H2H combo cu h2hGG)
- `score6` (convergență stdDev), `score7` (match-up real)
- Lambda Poisson (formulele de rată de goluri)
- Monte Carlo `simCount = 10000` din `api/monte-carlo.js`

Modifică DOAR logica `score4` (live-only) și `getLiveStatsFromDB()`.

---

## REGULI DE LIVRARE ȘI MEDIU

- **La începutul sesiunii sincronizează-te cu main-ul REAL** (`git fetch`; lucrezi pe
  `origin/main` la zi). Orice afirmație despre starea repo-ului se verifică cu `ls`/`grep`
  ÎNAINTE de a fi scrisă în documentație.
- **Livrare DIRECT PE MAIN** (commit + push). Push pe main declanșează auto-deploy
  (GitHub Actions → SSH pe VPS → `git reset --hard origin/main` + `npm install` +
  `pm2 restart alohascan`). Branch `claude/...` DOAR la cererea explicită a userului.
- **Când se lucrează pe branch** (cerere explicită): instrucțiunile pentru VPS folosesc
  EXCLUSIV `git checkout origin/<branch> -- <fișier>` — NICIODATĂ comutare de branch pe VPS.
- **`/root/scannerv2` pe VPS = PRODUCȚIA VIE**: PM2 servește din el; deploy-ul face
  `git reset --hard` pe MAIN la fiecare push. Nimic local pe VPS nu supraviețuiește deploy-ului.
- **Experimente / scripturi noi** scriu output DOAR în `ml/` sau `/tmp` — nu modifică
  fișiere de producție.
- **Dependențe noi** (npm/pip): raportate EXPLICIT în răspuns, niciodată instalate tacit.
- **PM2**: doar `pm2 restart alohascan` (fallback `pm2 start ecosystem.config.cjs && pm2 save`).
  INTERZIS `pkill`/`killall`. Nu lăsa niciodată daemonul oprit.
- **Crontab**: gestionat EXCLUSIV prin `scripts/setup-crontab.sh` (sursă CANONICĂ), aplicat
  la FIECARE deploy (`deploy.yml`). NU se editează manual pe VPS — modificările manuale dispar
  la următorul deploy. Orice schimbare de crontab = modificare în `scripts/setup-crontab.sh` +
  push. (Rulare/diagnostic: `scripts/run-cron.sh` + panoul admin „STATUS CRON-URI".)
- **Verifică sintaxa** cu `node --check <fișier.js>` (sau `python3 -m py_compile`) după
  orice editare, înainte de commit.
- **Secrete**: NU committa NICIODATĂ chei, token-uri, parole sau `.env`. Verifică
  `git diff` înainte de commit dacă ai dubii.
- **După ORICE task finalizat**: actualizează `SESSION_CONTEXT.txt` secțiunea 12
  (format: `[ZZ.LL HH:MM] - CE S-A FĂCUT | Commit: hash`) și push.

---

## REGULĂ COMENZI PENTRU USER (Termius / iPhone)

REGULĂ COMENZI PENTRU USER: Vlad rulează de pe iPhone prin Termius și poate
lipi/executa DOAR comenzi pe O SINGURĂ LINIE. Orice comandă de shell pe care i-o
dai lui să o ruleze manual TREBUIE să fie pe o singură linie — FĂRĂ blocuri
multi-linie, FĂRĂ heredoc (cat <<'EOF' ... EOF), fără secvențe pe mai multe
rânduri. Pentru orice script multi-pas: scrie-l TU în repo (`scripts/`), commit +
push, iar userul îl rulează cu o singură linie (ex: `cd /root/scannerv2 && git
pull && bash scripts/nume.sh`). Comenzile pe care le rulează Code însuși în
propriul shell nu sunt afectate de regulă.

---

## REGULI ML (permanente)

- **ZIDUL ANTI-COTE**: nicio coloană derivată din cote (`odd`, `odds`, `cota`, `price`,
  `implied`, `book*`, `bet365`, `pinnacle`) NU intră NICIODATĂ ca feature în modelele ML.
  Cotele trăiesc EXCLUSIV în stratul de decizie (EV) și ca benchmark CLV. Acest zid
  protejează edge-ul și e NENEGOCIABIL.
- **Antrenări pe VPS (2GB RAM)**: numpy `float32`, procesare SECVENȚIALĂ (nu tot setul
  în pandas deodată), print de progres + `[mem]` RSS.
- **Meciuri youth / feminine / amicale (league_id=10)**: NU intră în antrenare/features —
  verifică filtrarea la build.
- **Orice schimbare de feature/parametru ML** = o schimbare PE RÂND, măsurată before/after
  pe Brier, out-of-sample TEMPORAL.

---

## REGULI GENERALE

- **Backfill**: NU mai există `STOP_AT` (eliminat în FIX2). Backfill-ul se oprește DOAR la
  comanda STOP sau la finalizarea naturală a tuturor fixture-urilor. Limita reală a planului
  = **300.000/zi** (`API_PLAN_LIMIT` în `api/backfill.js`, folosit DOAR pentru afișare).
  La „bump plan API" se ajustează setarea `backfill_api_limit` (DB), nu cod.
- **Dacă userul cere „Faza X", „calibrare globală", „aplicăm/verificare/rollback Faza X"** →
  CITEȘTE `ROADMAP_CALIBRARE.md` ÎNAINTE de orice modificare (plan în 5 faze, trigger-uri
  Brier/sample size/durată, modificările de cod exacte + procedura de rollback).
- **Filtre de ligi**: DOAR prin `isAllowedLeague()` / `isAllowedMatch()` din
  `api/utils/league-filter.js`. NU duplica logica WOMEN/YOUTH/LOWER_DIV în alte fișiere.
  Whitelist: maxim Liga 1 + Liga 2 + Cupă per țară; zero tier 3+; potrivire pe ID **și** nume.
- **Apeluri API-Football**: DOAR prin `fetchApiFootball()` din `api/utils/fetch-api.js`
  (retry 429 cu backoff 30s/60s/120s + autentificare). NU folosi `fetch()` direct pentru
  `v3.football.api-sports.io`.

### Buget API zilnic (plan 300.000/zi — upgrade 27.05.2026)
- Scanner live: rezervă ~50.000/zi  ·  Backfill: maxim ~100.000/zi
- Cron-uri (prematch-enrichment, collect-daily/finished, referee-stats): ~50.000/zi
- Disponibil ad-hoc / UI: ~100.000/zi

---

## STACK

- **Runtime:** Node.js ESM (`/snap/bin/node`)  ·  **Server:** Express (`server.js`), port 3000
- **DB:** PostgreSQL local pe VPS (`db: elefant`, `user: alohascan`). **NU Supabase** —
  ignoră orice referință veche.
- **Process manager:** PM2 (`ecosystem.config.cjs`, max_memory 1200M)
- **Deploy:** `git push origin main` → GitHub Actions (`deploy.yml`) → SSH pe VPS →
  `git reset --hard origin/main` + `npm install` + `pm2 restart alohascan`
- **API date:** API-Football v3 (api-sports.io)  ·  **AI:** Claude API (`api/agent.js`)  ·
  **Notificări:** Telegram Bot API (`api/telegram.js`)

---

# AlohaScan — Documentație tehnică (rezumat; sursa = codul)

## Ce face aplicația
Scanner de pariuri sportive care: (1) afișează meciuri LIVE și PRE-MECI din ~165 ligi;
(2) calculează probabilități Poisson; (3) un scor de încredere pe 7 straturi;
(4) identifică pariuri cu EV > 0; (5) marchează „Safe Bets"; (6) colectează statistici
jucători pentru puterea echipelor.

## Surse de date

| Endpoint | Sursă | Utilizare |
|----------|-------|-----------|
| `api/football.js` | API-Football | Meciuri LIVE |
| `api/today.js` | API-Football | Meciuri PRE-MECI (azi + 2 zile) |
| `api/enrich.js` | API-Football | Analiză completă per meci |
| `api/match.js` | API-Football | Detalii meci (formații, jucători, evenimente) |
| `api/meteo.js` | Open-Meteo (gratuit) | Condiții meteo per stadion |
| `api/players.js` | API-Football + PostgreSQL | Statistici jucători |
| `api/agent.js` | Claude API | Analiză AI la cerere |
| `api/telegram.js` | Telegram Bot API | Notificări alerte NGP |
| `api/cron/scanner.js` | intern | Scanner live (WebSocket, snapshots NGP/markets) |
| `api/cron/collect-daily.js` | API-Football + PG | standings, teams, form_stats |
| `api/cron/collect-finished.js` | API-Football + PG | stats jucători meciuri FT |
| `api/cron/prematch-enrichment.js` | API-Football + PG | date prematch în 7 etape |
| `api/cron/league-stats.js` / `referee-stats.js` | PG | statistici per ligă / arbitru |

## Filtre
1. **Ligă (whitelist)** — `api/leagues.js`; aplicat în `today.js` și `football.js`.
2. **Feminin** — `/women|feminin|femenin|ladies|female|w league|nwsl|wsl/i`.
3. **Safe Bets (pre-meci)** — cumulativ: `confidenceScore > 75`, `1.30 ≤ bestCota ≤ 1.50`,
   `bestEV > 0`.

## Calcule principale (`api/enrich.js` dacă nu se specifică altfel)

**A. Poisson 6×6** — `calcPoisson6x6(λHome, λAway)` → homeWin/draw/awayWin (norm. 100%),
over15Prob, over25Prob, ggProb.
```
λHome = (homeAvgScored + awayAvgConceded) / 2
λAway = (awayAvgScored + homeAvgConceded) / 2     (din ultimele 10 acasă/deplasare)
λ dinamic (live): minLeft=90-elapsed; shotRate=(SOT/elapsed)*90;
  intensity=1+min(shotRate/25,0.4); λRem=λBase*(minLeft/90)*intensity; λDyn=currentGoals+λRem
```

**B. Expected Value (EV)** — `calcEV(matrix, oddsRaw, bankroll)`
```
impliedProb = 1/cota; totalImplied = impliedHome+impliedDraw+impliedAway
evHome = (homeWin/100) - (impliedHome/totalImplied)
evOver15 = (over15Prob/100) - (1/cotaOver15)
```
> Kelly Criterion: ELIMINAT complet din aplicație (vezi CHANGELOG). Nu există staking
> automat; EV e folosit doar ca semnal de valoare.

**C. Confidence Score (pre-meci, 7 straturi)** — greutăți SFINTE (sursa = codul):
`score1` Poisson **.30** · `score2` Formă **.25** · `score7` Putere echipă **.25** ·
`score3` H2H **.15** · `score6` Convergență **.05**.  `score4` = LIVE-only (intensity+NGP,
gated pe `elapsed>0`, decay după minutul 75).

**D. Team Strength** — `getTeamStrengths(hId,aId)`, ultimele 110 din `player_stats`:
```
teamStrength = (avgRating/10*100)*0.35 + min(100,goalsPerGame*35)*0.25
             + avgPassAcc*0.20 + min(100,avgSOT*12)*0.10 + min(100,topScorer*20)*0.10
```

**E. Player Score** — `api/players.js` → `calcPlayerScore()`:
```
playerScore = ratingNorm*0.35 + goalsScore*0.20 + assistScore*0.15
            + passScore*0.20 + shotScore*0.10
```

**F. NGP — Next Goal Probability (LIVE)** — `api/utils/live-score.js` → `calcNextGoal(f)`,
folosit de `api/cron/scanner.js`. Frontend afișează `m._ng` din WebSocket.
```
remXg=(txg/mn)*(90-mn); fallback txg=0: formGoals*2.5*remFrac;
mn>=70:*1.2; mn>=80:*1.15; prob=1-exp(-max(remXg,0.05)); ng=round(min(97,max(3,prob*100)))
```
Alertă Telegram când NGP > pragul setat de utilizator.

**G. Meteo Impact** — `api/meteo.js`: ploaie → Over2.5 −10%; ninsoare → −12% (cache 10 min).

## Bază de date (PostgreSQL local)
Schema reală: `scripts/create-tables.sql` (**44+ tabele**). Hartă cine-scrie/cine-citește:
vezi `docs/SCHEMA.md` (harta tabelelor), `docs/API_DATA_MAP.md` (fluxul API→DB),
`docs/ADMIN_AUDIT.md`, `docs/SPEED_AUDIT.md`.
Tabele cheie: `fixtures`, `fixtures_history`, `live_stats`, `match_snapshots`, `alerts`,
`odds`, `predictions`, `standings`, `form_stats`, `player_stats`, `prematch_data`,
`league_stats`, `referee_stats`, `elo_ratings`/`elo_history`, `backfill_progress`.

## Variabile de mediu (GitHub Secrets → `.env` pe VPS)
`API_FOOTBALL_KEY`, `POSTGRES_URL` (`postgresql://alohascan:***@localhost:5432/elefant`),
`ANTHROPIC_API_KEY`, `XAI_API_KEY` (rezervă), `ADMIN_API_KEY` (generat la deploy).
`.env` se rescrie la fiecare deploy via `deploy.yml`; nu se commitază niciodată.

---

## Pointeri documentație
- `SESSION_CONTEXT.txt` — istoric, stare DB, probleme cunoscute, task-uri în curs (citește la start).
- `ARHITECT.md` — arhitectură completă, formule, contracte de tip, bugtracker live.
- `ROADMAP_CALIBRARE.md` — planul de calibrare în 5 faze.
- `CHANGELOG.md` — istoric decizii/sprint-uri/sesiuni (datat).
- `scripts/create-tables.sql` — schema DB sursă de adevăr.
