# AlohaScan - Documentație Completă

## Ce face aplicația

AlohaScan este un scanner de pariuri sportive care:
1. Afișează meciuri LIVE și PRE-MECI din ~139 ligi globale
2. Calculează probabilități Poisson pentru fiecare meci
3. Calculează un scor de încredere pe 7 straturi
4. Identifică pariuri cu valoare pozitivă (EV > 0)
5. Marchează „Safe Bets" — oportunități cu risc scăzut
6. Colectează statistici jucători pentru calculul puterii echipelor

---

## Surse de date

| Endpoint | Sursă | Utilizare |
|----------|-------|-----------|
| `api/football.js` | API-Football + football-data.org | Meciuri LIVE |
| `api/today.js` | API-Football | Meciuri PRE-MECI (azi + 2 zile) |
| `api/enrich.js` | API-Football | Analiză completă per meci |
| `api/match.js` | API-Football | Detalii meci (formații, jucători, evenimente) |
| `api/meteo.js` | Open-Meteo (gratuit, fără cheie) | Condiții meteo per stadion |
| `api/stats.js` | Supabase | Istoricul predicțiilor + clasamente ligi |
| `api/players.js` | API-Football + Supabase | Statistici jucători (backfill + collect) |
| `api/agent.js` | Claude API (Anthropic) | Analiză AI la cerere |
| `api/telegram.js` | Telegram Bot API | Notificări alerte NGP |
| `api/update-results.js` | Supabase | Actualizare rezultate predicții |
| `api/cron/scan.js` | intern | Cron zilnic 00:00 |
| `api/cron/collect-finished.js` | API-Football + Supabase | Cron zilnic 23:00 — colectare stats jucători |

---

## Filtre aplicate

### 1. Filtru de ligă (whitelist)
Fișier: `api/leagues.js`

Regula: **maxim Liga 1 + Liga 2 + Cupă per țară**. Nicio ligă 3 sau mai joasă.

- ~139 ligi active din Europa, Americas, Asia, Africa + competiții internaționale
- Aplicat în: `today.js` (pre-meci) și `football.js` (live, doar sursa API-Football)
- Sursa football-data.org nu se filtrează prin whitelist (acoperă doar top 12-14 ligi europene)

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
Calculat din ultimele 10 meciuri acasă ale gazdei și ultimele 10 în deplasare ale oaspeților.

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
| 2. Formă recentă | `(homeAvg + awayAvg) / 3.5 * 100` | 20% | 18% |
| 3. H2H | `h2hOver15` (% meciuri directe cu >1.5 goluri) | 15% | 13% |
| 4. Live / xG | `xg*25 + sot*3 + da*0.5` | 15% | 13% |
| 5. EV piață 1.30-1.50 | `ev * 300` (capped 100) | 15% | 13% |
| 6. Consistență | `(straturi>60 / 5) * 100` | 10% | 8% |
| 7. Puterea echipei | `(homeStrength + awayStrength) / 2` | — | 15% |

Stratul 7 se activează doar dacă există date în `player_stats` (Supabase). Dacă nu există, se folosesc greutățile din coloana „fără str.".

### D. Team Strength (Puterea echipei)

Fișier: `api/enrich.js` → `getTeamStrengths(hId, aId, sbUrl, sbKey)`

Citește ultimele 110 înregistrări per echipă din tabelul `player_stats` din Supabase.

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

Calculat în frontend (`index.html`) pentru meciurile live.

```
ngp = SOT * 4.5
    + (Shots off Goal) * 1.5
    + (Dangerous Attacks) * 0.3
    + (Corners) * 2.0
    + (Goals scored) * 8
    - (elapsed / 90) * 15   ← penalizare timp scurs
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

## Structura bazei de date (Supabase)

### `predictions`
Salvată automat la fiecare analiză de meci.
Câmpuri: `fixture_id`, `home_team`, `away_team`, `league_name`, `match_date`, `lambda_home/away/total`, `over15_prob`, `over25_prob`, `gg_prob`, `home/away_score_rate`, `h2h_over15`, `confidence`, `result_over15` (actualizat de cron).

### `player_stats`
Colectată prin backfill și cron zilnic 23:00.
Câmpuri: `player_id`, `fixture_id`, `team_id`, `team_name`, `player_name`, `rating`, `goals`, `assists`, `pass_accuracy`, `shots_on_target`, `minutes_played`, `player_score`.
Constrângere unică: `(player_id, fixture_id)`.

### `backfill_progress`
Urmărește progresul backfill-ului per ligă.
Câmpuri: `league_id` (PK), `status` (pending/running/done/error), `fixtures_processed`, `players_upserted`, `last_run`.

### `cron_logs`
Log automat după fiecare rulare cron.
Câmpuri: `job_name`, `ran_at`, `fixtures_processed`, `players_upserted`, `status`, `error_msg`.

---

## Cron Jobs (Vercel)

| Path | Orar | Ce face |
|------|------|---------|
| `/api/cron/scan` | 00:00 zilnic | Scan general |
| `/api/update-results` | 02:00 zilnic | Actualizează `result_over15` în predictions |
| `/api/cron/collect-finished` | 23:00 zilnic | Colectează stats jucători pentru meciurile FT din ziua curentă |

---

## Limite Vercel Hobby Plan

- **Max 12 funcții serverless** — avem 11 active
- **Cron jobs:** doar zilnice (nu orare)
- **Timeout funcție:** 10 secunde

### Funcții active (11/12)
1. `api/agent.js`
2. `api/cron/collect-finished.js`
3. `api/cron/scan.js`
4. `api/enrich.js`
5. `api/football.js`
6. `api/match.js`
7. `api/players.js`
8. `api/stats.js`
9. `api/telegram.js`
10. `api/today.js`
11. `api/update-results.js`

`api/leagues.js` — **nu contează** ca funcție (exportă doar o constantă, nu un handler).

---

## Stack tehnic

- **Frontend:** Vanilla JS, CSS inline în `index.html` (~1950 linii)
- **Backend:** Vercel Serverless Functions (`api/*.js`, format ESM)
- **Baza de date:** Supabase (PostgreSQL) via REST API
- **Deploy:** push pe `main` → GitHub Actions → Vercel REST API → producție

## Variabile de mediu (Vercel)

| Variabilă | Utilizare |
|-----------|-----------|
| `API_FOOTBALL_KEY` | API-Football v3 (api-sports.io) |
| `FOOTBALL_DATA_KEY` | football-data.org |
| `SUPABASE_URL` | URL proiect Supabase |
| `SUPABASE_KEY` | Service role key Supabase |
| `ANTHROPIC_API_KEY` | Claude API (agent AI) |
| `TELEGRAM_BOT_TOKEN` | Bot Telegram notificări |
| `TELEGRAM_CHAT_ID` | Chat ID destinatar Telegram |
