# REGULI CLAUDE — AlohaScan Scanner V2

> Acest fișier conține regulile fixe pentru sesiunile Claude pe acest repo.
> Documentația tehnică completă a aplicației urmează după aceste reguli.

---

## FORMAT RĂSPUNS OBLIGATORIU
Pune TOT răspunsul tău într-un singur bloc de cod (triple backticks)
astfel încât să apară butonul de copy în colțul dreapta-sus.
Nu scrie NIMIC în afara acelui bloc. Fără excepții.

---

## COD INTANGIBIL — NU MODIFICA NICIODATĂ
Acestea sunt interzise oricărui agent, indiferent de context:
- calcConfidencePreMatch() — funcția și greutățile layerelor
- calcConfidenceLive() — funcția și greutățile layerelor
- score2 (formula cu apărare)
- score3 (H2H combo cu h2hGG)
- score6 (convergență stdDev)
- score7 (match-up real)
Modifică DOAR logica score4 și getLiveStatsFromDB().

---

## SPRINT-URI COMPLETATE (Mai 2026)

### Sprint 4A — Shrinkage Bayesian în calcPoisson (commit 96f70e7)
N_SHRINK = 5. Când echipa are puține meciuri, lambda se blendează
cu media reală a ligii din league_stats. Zero valori hardcodate.

### Sprint 4B — Calibrare per-profil ligă (commit 7cee89c)
calibration_tables are acum PK compus (module, league_group).
Grupuri: low (<2.3 goluri/meci), mid (2.3-3.0), high (>3.0).
Minimum 500 predicții per grup pentru calibrare proprie.

### Sprint 4C — g2Score folosește predictions ca rawScore (commit 14cef08)
Frontend g2Score() folosește over15_prob/over25_prob/gg_prob
din tabela predictions în loc să recalculeze din form data.
Fallback la calculul vechi dacă predictions lipsesc.

### Sprint 4D — Clamp scoruri extreme în calcPoisson (commit 4e0dc81)
Meciuri cu total goluri > 5 sunt clampate proporțional la 5.
Ex: 0-6 devine 0-5.0 în calcul. Elimină outlier inflation.

### Sprint Live — getLiveStatsFromDB() real (commit 4d81457)
Citește din live_stats: elapsed, xg, sot, da, ngp_home, ngp_away.
score4 = intensity*0.6 + NGP*0.4, cu decay după minutul 75.
Pre-meci neafectat (gated pe elapsedNum > 0).

### Whitelist cleanup (commit e429e9c + 51bdd78)
19 ID-uri greșite eliminate. Romania fixat: 283/284/285.
Serbia: 286/287. Indonesia: 274.
Regula: maxim Liga 1 + Liga 2 + Cupă per țară, zero tier 3+.

---

## 1. REGULI GENERALE

- **După ORICE task finalizat**, actualizează `SESSION_CONTEXT.txt` secțiunea 12 cu ce s-a făcut (format: `[ZZ.LL HH:MM] - CE S-A FĂCUT | Commit: hash`) și push.
- **NU modifica niciodată** valoarea `10.000` simulări Monte Carlo din `api/monte-carlo.js` (parametrul `nSims` / `iterations`).
- **NU committa niciodată** chei, token-uri, parole sau fișiere `.env`. Verifică `git diff` înainte de commit dacă ai dubii.
- **Întotdeauna commit + push pe `main`** după orice modificare finalizată — push-ul pe main declanșează auto-deploy via GitHub Actions.
- **Dacă userul cere „Faza X", „calibrare globală", „aplicăm calibrare", „verificare Faza X" sau „rollback Faza X"** → CITEȘTE `ROADMAP_CALIBRARE.md` ÎNAINTE de a începe orice modificare. Fișierul conține planul în 5 faze, trigger-urile (Brier scor, sample size, durată stabilă), modificările exacte de cod și procedura de rollback.
- **Dacă userul cere „bump plan API" sau „abonament nou X k"** → ajustează `STOP_AT` în `api/backfill.js` la `(plan - 20k)` ca buffer pentru live scanner.
- **`STOP_AT` curent în `api/backfill.js` = 280.000** — valoare corectă pentru planul 300k (300k - 20k buffer). NU modifica fără cerere explicită.

## 1B. REGULI OPERAȚIONALE VPS

### REGULĂ CRITICĂ — GESTIUNE PROCESE PE VPS
- **NU rula NICIODATĂ** `killall node`, `pkill node`, `pkill -f node` sau `pm2 kill` pe VPS. Aceste comenzi omoară daemon-ul PM2 și lasă aplicația moartă fără supraveghere → 502 Bad Gateway.
- Pentru repornirea aplicației folosește **DOAR**: `pm2 restart alohascan`.
- Dacă e absolut necesar un clean restart complet, secvența se termină **OBLIGATORIU** cu `pm2 start ecosystem.config.cjs && pm2 save`, urmat de verificarea `pm2 status` care **TREBUIE** să arate procesul `online` înainte de a încheia sesiunea.
- **Nu lăsa NICIODATĂ** daemon-ul PM2 oprit la finalul unei sesiuni.

## 2. STACK

- **Runtime:** Node.js ESM (`/snap/bin/node`)
- **DB:** PostgreSQL local pe VPS (`db: elefant`, `user: alohascan`)
- **NU Supabase** — ignoră orice referință veche în cod sau documentație
- **Deploy:** `git push origin main` → GitHub Actions (`deploy.yml`) → SSH pe VPS → `git reset --hard + npm install + pm2 restart alohascan`

## 3. WORKFLOW STANDARD

1. **Citește `SESSION_CONTEXT.txt`** la începutul oricărei sesiuni noi — conține istoric, stare DB, probleme cunoscute, task-uri în curs.
2. **Citește `ARHITECT.md`** la începutul oricărei sesiuni noi — conține arhitectura completă, formulele, contractele de tip, regulile absolute și bugtracker-ul live. OBLIGATORIU înainte de orice modificare de cod.
3. **Lucrează pe branch `claude/...`** (ex. `claude/session-context-review-MNZ8Y`), apoi merge în `main` și push.
4. **Verifică sintaxa** cu `node --check <fișier.js>` după orice editare de fișier JavaScript, înainte de commit.

## 4. ARHITECTURĂ

- **Filtre de ligi**: DOAR prin `isAllowedLeague()` / `isAllowedMatch()` din `api/utils/league-filter.js`. NU duplica logica WOMEN_TERMS / YOUTH_TERMS / LOWER_DIV_TERMS în alte fișiere.
- **Apeluri API-Football**: DOAR prin `fetchApiFootball()` din `api/utils/fetch-api.js` — gestionează retry 429 cu backoff (30s/60s/120s) și autentificare. NU folosi `fetch()` direct pentru `v3.football.api-sports.io`.
- **Limitele API zilnice** (plan 300.000/zi — upgrade 27.05.2026):
  - **Scanner live**: rezervă **50.000/zi** (buget țintă)
  - **Backfill**: maxim **100.000/zi** (STOP_AT = 280k total cumulativ)
  - **Cron-uri**: ~50.000/zi (prematch-enrichment, collect-daily, collect-finished, referee-stats)
  - **Disponibil ad-hoc / UI**: ~100.000/zi

---

# AlohaScan - Documentație Completă

## Ce face aplicația

AlohaScan este un scanner de pariuri sportive care:
1. Afișează meciuri LIVE și PRE-MECI din ~165 ligi globale
2. Calculează probabilități Poisson pentru fiecare meci
3. Calculează un scor de încredere pe 7 straturi
4. Identifică pariuri cu valoare pozitivă (EV > 0)
5. Marchează „Safe Bets‟ — oportunități cu risc scăzut
6. Colectează statistici jucători pentru calculul puterii echipelor

---

## Stack tehnic

- **Runtime:** Node.js (ESM modules) via `/snap/bin/node`
- **Server:** Express.js (`server.js`) — port 3000
- **Baza de date:** PostgreSQL local pe VPS (`db: elefant`, `user: alohascan`)
- **Process manager:** PM2 (`ecosystem.config.cjs`, max_memory 1200M)
- **Deploy:** GitHub Actions → `deploy.yml` → SSH pe VPS → `git fetch + reset --hard + pm2 restart alohascan`
- **API date:** API-Football v3 (api-sports.io)
- **AI:** Claude API (Anthropic) — `api/agent.js`
- **Notificări:** Telegram Bot API — `api/telegram.js`

---

## Surse de date

| Endpoint | Sursă | Utilizare |
|----------|-------|-----------|
| `api/football.js` | API-Football | Meciuri LIVE |
| `api/today.js` | API-Football | Meciuri PRE-MECI (azi + 2 zile) |
| `api/enrich.js` | API-Football | Analiză completă per meci |
| `api/match.js` | API-Football | Detalii meci (formații, jucători, evenimente) |
| `api/meteo.js` | Open-Meteo (gratuit, fără cheie) | Condiții meteo per stadion |
| `api/players.js` | API-Football + PostgreSQL | Statistici jucători (backfill + collect) |
| `api/agent.js` | Claude API (Anthropic) | Analiză AI la cerere |
| `api/telegram.js` | Telegram Bot API | Notificări alerte NGP |
| `api/update-results.js` | PostgreSQL | Actualizare rezultate predicții |
| `api/cron/scan.js` | intern | Scanner live continuu |
| `api/cron/scanner.js` | intern | Scanner live alternativ (WebSocket) |
| `api/cron/collect-daily.js` | API-Football + PostgreSQL | Cron 06:00 — standings, teams, form_stats |
| `api/cron/collect-finished.js` | API-Football + PostgreSQL | Cron 23:00 — stats jucători meciuri FT |
| `api/cron/prematch-enrichment.js` | API-Football + PostgreSQL | Cron */5min — date prematch per stadiu |
| `api/cron/league-stats.js` | PostgreSQL | Cron 04:00 — statistici per ligă |
| `api/cron/referee-stats.js` | API-Football + PostgreSQL | Cron 04:00 — statistici per arbitru |

---

## Filtre aplicate

### 1. Filtru de ligă (whitelist)
Fișier: `api/leagues.js`

Regula: **maxim Liga 1 + Liga 2 + Cupă per țară**. Nicio ligă 3 sau mai joasă.

- ~165 ligi active din Europa, Americas, Asia, Africa + competiții internaționale
- Aplicat în: `today.js` (pre-meci) și `football.js` (live)

### 2. Filtru feminin
```
/women|feminin|femenin|ladies|female|w league|nwsl|wsl/i
```
Aplicat în: `today.js` și `football.js` — elimină toate competițiile feminine.

### 3. Filtru Safe Bets (PRE-MECI)
Condiții cumulative:
- `confidenceScore > 75`
- `bestCota >= 1.30` și `bestCota <= 1.50`
- `bestEV > 0` (valoare pozitivă)

---

## Calculele principale

### A. Poisson 6×6

Fișier: `api/enrich.js` → `calcPoisson6x6(lambdaHome, lambdaAway)`

Calculează probabilitatea fiecărui scor posibil (0-0 până la 5-5) și derivă:
- `homeWin`, `draw`, `awayWin` (normalizate la 100%)
- `over15Prob` — probabilitate peste 1.5 goluri
- `over25Prob` — probabilitate peste 2.5 goluri
- `ggProb` — probabilitate ambele marchează

**Lambda (rata de goluri așteptate):**
```
lambdaHome = (homeAvgScored + awayAvgConceded) / 2
lambdaAway = (awayAvgScored + homeAvgConceded) / 2
```
Calculat din ultimele 10 meciuri acasă ale gazdei și ultimele 10 în deplasare ale oaspetilor.

**Lambda dinamic (în timpul meciului):**
```
minutesLeft = 90 - elapsed
shotRate = (SOT / elapsed) * 90
intensityFactor = 1 + min(shotRate / 25, 0.4)
lambdaRemaining = lambdaBase * (minutesLeft/90) * intensityFactor
lambdaDynamic = currentGoals + lambdaRemaining
```

### B. Expected Value (EV)

Fișier: `api/enrich.js` → `calcEV(matrix, oddsRaw, bankroll)`

```
impliedProb = 1 / cota
totalImplied = impliedHome + impliedDraw + impliedAway
evHome = (homeWin/100) - (impliedHome / totalImplied)
evOver15 = (over15Prob/100) - (1 / cotaOver15)
```

**Kelly Criterion:**
```
kelly = min(bankroll * edge * 0.5, bankroll * 0.04)
```
Aplicat doar dacă edge > 4%.

### C. Confidence Score (7 straturi)

Fișier: `api/enrich.js` → `calcConfidence(result, oddsRaw, liveStats, teamStrengths)`

| Strat | Sursă | Greutate (fără str.) | Greutate (cu str.) |
|-------|-------|----------------------|---------------------|
| 1. Poisson | `over15Prob` | 25% | 20% |
| 2. Formă recentă | `form_stats` din PostgreSQL | 20% | 18% |
| 3. H2H | `h2hOver15` (% meciuri directe cu >1.5 goluri) | 15% | 13% |
| 4. Live / xG | `xg*25 + sot*3 + da*0.5` | 15% | 13% |
| 5. EV piață 1.30-1.50 | `ev * 300` (capped 100) | 15% | 13% |
| 6. Consistență | `(straturi>60 / 5) * 100` | 10% | 8% |
| 7. Puterea echipei | `(homeStrength + awayStrength) / 2` | — | 15% |

Stratul 7 se activează dacă există date în `player_stats`. Dacă nu există, se folosesc greutățile din coloana „fără str.‟.

### D. Team Strength (Puterea echipei)

Fișier: `api/enrich.js` → `getTeamStrengths(hId, aId)`

Citește ultimele 110 înregistrări per echipă din tabelul `player_stats` din PostgreSQL.

```
avgRating    = media ratingurilor jucătorilor (scala 0-10)
goalsPerGame = total goluri / număr jucători
avgPassAcc   = media acurateței paselor (%)
avgSOT       = media suturi pe poartă
topScorer    = max goluri unui singur jucător

teamStrength = (avgRating/10*100)*0.35
             + min(100, goalsPerGame*35)*0.25
             + avgPassAcc*0.20
             + min(100, avgSOT*12)*0.10
             + min(100, topScorer*20)*0.10
```

### E. Player Score (per jucător)

Fișier: `api/players.js` → `calcPlayerScore()`

```
ratingNorm  = rating ? (rating/10*100) : 50
goalsScore  = min(100, goals*25)
assistScore = min(100, assists*20)
passScore   = passAccuracy (0-100%)
shotScore   = min(100, sot*15)

playerScore = ratingNorm*0.35 + goalsScore*0.20
            + assistScore*0.15 + passScore*0.20 + shotScore*0.10
```

### F. NGP — Next Goal Probability (LIVE)

Calculat în `api/utils/live-score.js` → `calcNextGoal(f)`, folosit de
`api/cron/scan.js` și `api/cron/scanner.js`. Frontend `index.html`
afișează direct `m._ng` din WebSocket (zero recalcul local).

```
NGP: remXg = (txg/mn)*(90-mn); fallback txg=0: formGoals*2.5*remFrac;
     mn>=70: *1.2; mn>=80: *1.15; prob=1-exp(-max(remXg,0.05));
     ng=round(min(97,max(3,prob*100)))
```
Normalizat 0-100%. Alertă Telegram când NGP > pragul setat de utilizator.

### G. Meteo Impact

Fișier: `api/meteo.js`

```
rain  → Over 2.5 prob -10%
snow  → Over 2.5 prob -12%
```
Afișat în detaliile meciului. Cache 10 minute în memorie.

---

## Structura bazei de date (PostgreSQL local)

Schema completă: `scripts/create-tables.sql` (36 tabele)

### Tabele principale

| Tabel | Descriere |
|-------|-----------|
| `fixtures` | Meciuri programate și live |
| `fixtures_history` | Meciuri terminate (cu referee) |
| `live_stats` | Statistici live per minut (home/away separate) |
| `alerts` | Alerte NGP/over15 (alert_type, ngp_value, telegram_ok) |
| `odds` | Cote normalizate (fixture_id, bookmaker_id, bet_id, value_name) |
| `predictions` | Predicții Poisson per meci |
| `standings` | Clasamente per ligă/sezon/echipă |
| `form_stats` | Forma recentă echipe (last5_home, last5_away, avg_scored/conceded) |
| `player_stats` | Statistici jucători per meci |
| `prematch_data` | Date pre-meci colectate în 7 etape |
| `prematch_enrichment_log` | Log etape prematch per fixture |
| `league_stats` | Statistici agregate per ligă (goluri, cărți, cornere) |
| `referee_stats` | Statistici per arbitru (stil, medie goluri/cărți) |
| `cron_logs` | Log rulări cron |
| `backfill_progress` | Progres backfill per ligă |

---

## Cron Jobs (VPS crontab)

| Path | Orar | Ce face |
|------|------|---------|
| `/api/cron/prematch-enrichment` | `*/5 * * * *` | Date prematch în 7 etape pre-kickoff |
| `/api/update-results` | `0 2 * * *` | Actualizează `result_over15` în predictions |
| `/api/backfill/start` | `0 3 * * *` | Backfill date istorice jucători |
| `/api/cron/collect-daily` | `0 6 * * *` | Standings, teams, form_stats |
| `/api/cron/league-stats` | `0 4 * * *` | Statistici per ligă din fixtures_history |
| `/api/cron/referee-stats` | `0 4 * * *` | Statistici per arbitru din fixtures_history |
| `/api/cron/collect-finished` | `0 23 * * *` | Stats jucători meciuri FT din ziua curentă |

---

## Variabile de mediu (GitHub Secrets → .env pe VPS)

| Variabilă | Utilizare |
|-----------|-----------|
| `API_FOOTBALL_KEY` | API-Football v3 (api-sports.io) |
| `POSTGRES_URL` | `postgresql://alohascan:***@localhost:5432/elefant` |
| `ANTHROPIC_API_KEY` | Claude API (Anthropic) |
| `XAI_API_KEY` | xAI API (rezervă) |
| `ADMIN_API_KEY` | Cheie acces admin dashboard (generat automat la deploy) |

Fișierul `.env` se rescrie la fiecare deploy via `deploy.yml`. Nu se commitază niciodată în repo.

---

# FILTRU LIGI — REGULĂ PERMANENTĂ (citește înainte de a adăuga/depana ligi)

## FILTRU LIGI — AND între ID și NUME (regulă critică)
O ligă/meci e colectat ȘI afișat DOAR dacă trece DOUĂ porți, în **AND**:
1. **ID** în `ALLOWED_LEAGUE_IDS` (`api/leagues.js`), **ȘI**
2. **NUME curat** — fără termeni din blocklist-ul din `api/utils/league-filter.js`
   (`WOMEN_TERMS`, `YOUTH_TERMS`, `LOWER_DIV_TERMS`), verificat de
   `isAllowedLeague()` / `isAllowedMatch()`.

⚠ A adăuga o ligă în `ALLOWED_LEAGUE_IDS` e **NECESAR dar NU suficient**: dacă NUMELE
ligii conține un keyword interzis (ex. `'reserve'`, `'serie c'`, `'serie d'`,
`'amateur'`, `'women'`, `'u20'`, `'sub-20'`, `'tercera'`, `'division 3'`, `'futsal'`,
`'friendly'` etc.), liga e filtrată **TĂCUT** — atât la colectare (`collect-daily`) cât
și la afișare (`football.js`, `today.js`, `generator.js`, `scanner.js`).

## FORCE_ALLOW_IDS — bypass țintit al filtrului de NUME
Set în `api/utils/league-filter.js`: ID-urile de aici trec PESTE verificările
`YOUTH_TERMS` și `LOWER_DIV_TERMS`, DAR:
- **NU** ocolesc whitelist-ul de ID (tot trebuie să fie în `ALLOWED_LEAGUE_IDS`);
- **NU** ocolesc filtrul FEMININ (`WOMEN_TERMS` rămâne activ, verificat ÎNAINTEA bypass-ului).

Curent: `FORCE_ALLOW_IDS = { 75 Serie C Brazilia, 76 Serie D Brazilia, 906 Reserve
League Argentina }` — adăugate fiindcă termenii generici `'serie c'`/`'serie d'`/
`'reserve'` le prindeau deși-s ligi dorite. Commit `5e1c146`.

## PROCEDURĂ la adăugarea de ligi noi (de urmat MEREU)
1. Adaugă ID-ul în `ALLOWED_LEAGUE_IDS`.
2. VERIFICĂ numele ligii contra blocklist-ului (`WOMEN`/`YOUTH`/`LOWER_DIV`).
3. Dacă numele conține un keyword dar vrei liga → adaugă ID-ul în `FORCE_ALLOW_IDS`.
4. Rulează `collect-daily` ca să se populeze fixturile (altfel rămân 0 în DB).

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SESIUNE 04.06.2026 — AUDIT SISTEM PREDICȚII + PLAN ML
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

> NOTĂ SECURITATE: parola DB a fost REDACTATĂ (`***`) în comenzile de mai jos —
> conform regulii „NU committa niciodată chei/parole". Folosește parola reală local.

## 1. CE AM DISCUTAT

Am analizat 3 opțiuni de dezvoltare a aplicației la nivel superior:

OPȚIUNEA 1 — Expected Goals (xG) real din date istorice
  Calcul xG real din match_stats (poziție șut, tip acțiune)
  Impact estimat: -15-25% Brier

OPȚIUNEA 2 — Machine Learning pe predicții istorice (ALEASĂ)
  Logistic Regression pe score1-score7 pentru greutăți optime per ligă
  Impact estimat: -10-35% Brier

OPȚIUNEA 3 — Momentum Engine Real-Time
  Urmărire dinamică presiune ultimele 10 minute
  Impact estimat: NGP mai precis

DECIZIE: Am ales Opțiunea 2 (ML pe predicții istorice).
Documentată complet în planuri_viitor_app.txt (commit e131ac9).

## 2. AUDIT COD — CE A GĂSIT CLAUDE CODE (sandbox, read-only)

UNDE SE SCRIU PREDICȚIILE:
  api/enrich.js:1523       → INSERT principal (confidence + probabilități)
                              ON CONFLICT DO UPDATE WHERE result_over15 IS NULL
  api/match.js:510         → INSERT secundar (fără confidence, fără api_*_pct)
                              ON CONFLICT DO UPDATE fără guard pe result
  api/cron/auto-predict.js → NU scrie direct, cheamă /api/enrich per fixture NS
                              Cron 00:30 zilnic, LIMIT 500, sleep 300ms/fixture
  api/update-results.js    → UPDATE (nu INSERT), populează result_over15/25/gg/winner
                              Cron 02:00 zilnic, set-based din fixtures_history

CE NU SE SALVEAZĂ (problemă identificată):
  breakdown per layer (score1-score7) — calculat în enrich.js:553 dar ARUNCAT
  h2h_sample — nu e persistat
  league_group — nu e persistat
  Aceste coloane NU existau în tabela predictions.

UNDE SE CITESC PREDICȚIILE:
  learning-analysis.js  → citește prediction_log (win-rate, threshold, lambda_multiplier)
                          CALIBRARE STATISTICĂ, nu ML real
  recalibrate-tables.js → bucketizează per module/league_group, calculează Brier
  weights.js            → cache model_weights TTL 1h, fallback specific→global
  enrich.js:1203        → folosește DOAR lambda_multiplier din model_weights
                          greutățile score1-7 sunt FIXE în cod, NU din DB

CONCLUZIE COD: sistem de calibrare statistică funcțional, dar fără ML real.
  Infrastructura există (model_weights, learning-analysis, calibration_tables).
  Lipsesc features per predicție (score1-7 în DB).

## 3. AUDIT VPS — COMENZI RULATE + REZULTATE

### 3A. Starea predicțiilor
COMANDĂ:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT COUNT(*) as total, COUNT(result_over15) as cu_rezultat, \
  COUNT(*) FILTER (WHERE result_over15 IS NULL) as pending, \
  COUNT(*) FILTER (WHERE result_over15 = TRUE) as castigat, \
  COUNT(*) FILTER (WHERE result_over15 = FALSE) as pierdut FROM predictions;"

REZULTAT:
  total=15675 | cu_rezultat=15522 | pending=153 | castigat=11891 | pierdut=3631
  Rata Over 1.5 reală: 76.6%

### 3B. Brier Score real
COMANDĂ:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT COUNT(*) as sample, ROUND(AVG(POWER((over15_prob/100.0) - \
  CASE WHEN result_over15 THEN 1 ELSE 0 END, 2))::numeric, 4) as brier_score \
  FROM predictions WHERE result_over15 IS NOT NULL;"

REZULTAT:
  sample=15522 | brier_score=0.1511
  NOTE: La auditul 25.05.2026 era 0.195 pe 622 predicții.
        Acum pe 15.522 predicții = 0.1511 → îmbunătățire 22% față de audit anterior.
        Model BUN (industria: sub 0.20 = bun, sub 0.15 = foarte bun).

### 3C. Coloane existente în predictions
COMANDĂ:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT column_name, data_type FROM information_schema.columns \
  WHERE table_name = 'predictions' ORDER BY ordinal_position;"

REZULTAT (coloane confirmate):
  EXISTĂ: id, fixture_id, home_team, away_team, league_name, league_id,
          match_date, lambda_home, lambda_away, lambda_total,
          over15_prob, over25_prob, gg_prob, home_win_prob, draw_prob,
          away_win_prob, home_score_rate, away_score_rate, h2h_over15,
          confidence, best_ev, best_cota, best_bet,
          result_over15, result_over25, result_gg, result_1x2, result_winner,
          score_at_alert, outcome_ngp,
          api_home_pct, api_draw_pct, api_away_pct,
          created_at, updated_at

  NU EXISTĂ: score1, score2, score3, score4, score6, score7,
             breakdown, h2h_sample, league_group, source

### 3D. Predicții per zi (ultimele 14 zile)
COMANDĂ:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT DATE(updated_at) as zi, COUNT(*) as predictii FROM predictions \
  WHERE updated_at >= NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1 DESC;"

REZULTAT:
  2026-06-03: 153  | 2026-06-02: 25   | 2026-06-01: 36
  2026-05-31: 156  | 2026-05-30: 170  | 2026-05-29: 26
  2026-05-28: 59   | 2026-05-27: 2    | 2026-05-26: 13815 (backfill bulk)
  2026-05-25: 657  | 2026-05-24: 49   | 2026-05-23: 50
  NOTE: 26.05 = backfill masiv 13.815 predicții. Zilele normale: 25-170/zi.

### 3E. prediction_log pe module
COMANDĂ:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT module, outcome, COUNT(*) as total FROM prediction_log \
  GROUP BY module, outcome ORDER BY module, outcome;"

REZULTAT:
  CONFIDENCE: WIN=6150  | LOSS=3490  | PENDING=447   → win rate 63.8%
  GG:         WIN=5055  | LOSS=4584  | PENDING=447   → win rate 52.5%
  NGP:        WIN=192889 | LOSS=33062 | PENDING=18295 → win rate 85.3%
  OVER15:     WIN=195992 | LOSS=10528 | PENDING=18192 → win rate 94.9%

### 3F. model_weights (structură reală)
COMANDĂ structură:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT column_name, data_type FROM information_schema.columns \
  WHERE table_name = 'model_weights' ORDER BY ordinal_position;"

COLOANE REALE: id, module, context_key, weight_name, weight_value,
               default_value, sample_size, win_rate, confidence_level, last_updated
NOTE: coloana se numește weight_value (NU value cum era în documentație veche)

COMANDĂ date:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT module, weight_name, weight_value, context_key, win_rate, \
  sample_size, last_updated FROM model_weights ORDER BY module, weight_name;"

REZULTAT (extras relevant):
  CONFIDENCE layer weights (actualizate 03.06 la 03:43 — learning engine ACTIV):
    layer1_weight: 0.2212 | layer2_weight: 0.2010 | layer3_weight: 0.1594
    layer4_weight: 0.2214 | layer5_weight: 0.0671 | layer6_weight: 0.1100
    layer7_weight: 0.0199

  CONFIDENCE threshold per ligă (exemple):
    league_113: threshold=50, win_rate=89.70, sample=165
    league_116: threshold=50, win_rate=79.80, sample=163
    league_79:  threshold=50, win_rate=100.00, sample=27
    league_276: threshold=95, win_rate=24.40, sample=316
    league_61:  threshold=95, win_rate=9.60, sample=52

  CARDS: referee_multiplier=1.0, threshold=65 (global)

### 3G. calibration_tables
COMANDĂ:
  PGPASSWORD=*** psql -U alohascan -d elefant -h 127.0.0.1 -c \
  "SELECT module, league_group, sample_size, brier_score, generated_at \
  FROM calibration_tables ORDER BY module, league_group;"

REZULTAT:
  GG global:           sample=15502 | brier=0.218 | generat 03.06 06:29
  GG high:             sample=6474  | brier=0.210
  GG low:              sample=1737  | brier=0.221
  GG mid:              sample=7017  | brier=0.222
  goals_total_0.5 global: sample=15502 | brier=0.151
  goals_total_0.5 high:   sample=6474  | brier=0.125 ← EXCELENT
  goals_total_0.5 low:    sample=1737  | brier=0.201
  goals_total_0.5 mid:    sample=7017  | brier=0.162
  goals_total_1.5 global: sample=15502 | brier=0.151
  goals_total_1.5 high:   sample=6474  | brier=0.125 ← EXCELENT
  goals_total_1.5 low:    sample=1737  | brier=0.201
  goals_total_1.5 mid:    sample=7017  | brier=0.162
  goals_total_2.5 global: sample=14306 | brier=0.183
  goals_total_2.5 high:   sample=6183  | brier=0.178
  goals_total_2.5 low:    sample=1545  | brier=0.177
  goals_total_2.5 mid:    sample=6304  | brier=0.189

## 4. CONCLUZII SESIUNE

STARE SISTEM LA 04.06.2026:
  ✅ 15.522 predicții verificate (suficient pentru ML)
  ✅ Brier Score 0.1511 — model BUN, îmbunătățit 22% față de audit 25.05
  ✅ Learning engine activ — actualizat zilnic la 03:43
  ✅ Calibrare per ligă funcțională (high/mid/low)
  ✅ model_weights populat și folosit (lambda_multiplier per ligă)
  ❌ score1-score7 NU sunt salvate în predictions (features ML lipsesc)
  ❌ breakdown calculat dar aruncat după fiecare predicție

ACȚIUNI FĂCUTE ÎN ACEASTĂ SESIUNE:
  1. Creat planuri_viitor_app.txt (commit e131ac9) — plan complet ML
  2. Audit complet sistem predicții (cod + DB live)
  3. Prompt trimis la Claude Code pentru:
     - Migrare DB: add-prediction-features.sql (score1-7 + h2h_sample + league_group)
     - Extindere INSERT în api/enrich.js să salveze breakdown-ul complet

NEXT STEPS (când revii):
  1. Verifică că migrarea add-prediction-features.sql s-a aplicat pe VPS
  2. Verifică că predicțiile noi au score1-7 populate (query: SELECT score1,score2,score3 FROM predictions ORDER BY updated_at DESC LIMIT 5)
  3. Lasă sistemul să acumuleze predicții cu features complete (2-4 săptămâni)
  4. Când ai 2000+ predicții cu score1-7 → implementează Logistic Regression
