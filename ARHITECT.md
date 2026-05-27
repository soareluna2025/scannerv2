================================================================================
  ARHITECT.md — AlohaScan Scanner V2
  Creierul complet al aplicației. Citit OBLIGATORIU la fiecare sesiune nouă.
  Actualizat: 27.05.2026
================================================================================

Acest fișier conține tot ce trebuie să știu ca arhitect al sistemului:
fiecare decizie, fiecare formulă, de ce s-a ales fiecare soluție, ce nu
se atinge, ce e broken și ce urmează. Nu există scuza "nu știam".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 1 — SCOPUL APLICAȚIEI ȘI FILOSOFIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AlohaScan identifică meciuri de fotbal unde probabilitățile REALE ale
evenimentelor (Over 1.5, GG, victorie echipă) sunt SUPERIOARE probabilităților
implicite din cotele bookmaker-ilor. Aceasta se numește Expected Value pozitiv.

Filosofia centrală:
  - Nu prezice câștigătorul. Prezice unde e valoare față de piață.
  - O predicție corectă 60% dintr-un singur pariu nu e suficientă.
    Valoarea reală vine din zeci de pariuri cu EV > 0 constant.
  - Modelul Poisson e bun pentru goluri. Monte Carlo e bun pentru scoruri
    exacte. ELO e bun pentru tăria relativă. Le folosim pe toate împreună.
  - Datele live (SOT, xG) îmbunătățesc lambda dar nu înlocuiesc datele istorice.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 2 — HARTA FIȘIERELOR (ce face fiecare, precis)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.js
  Pornit de systemctl. Express pe port 3000. WebSocket pe același server HTTP.
  La startup: initBackfillProgress() → resumeOnStartup() → startScanner() → loadModelWeights()
  Rute: toate /api/* sunt lazy-loaded (import dinamic per request).
  WebSocket: wss pe același HTTP server; heartbeat ping/pong 30s;
  global.wsBroadcast() folosit de scanner.js; global.lastLiveData = ultima stare LIVE.

api/calc-utils.js — FUNCȚII MATEMATICE PURE, fără side effects
  calcPoisson6x6(lambdaHome, lambdaAway) → { homeWin, draw, awayWin, over15Prob, over25Prob, ggProb }
    Toate valorile sunt INTEGER (0-100), homeWin+draw+awayWin = 100 (normalizate).
  parseOddsItem(item) → { cotaHome, cotaDraw, cotaAway, cotaOver15, cotaGG } sau null
    item e format API-Football: { bookmakers:[{ bets:[{ name, values:[{value,odd}] }] }] }
  calcEV(matrix, oddsRaw) → { hasOdds, bestEV:NUMBER, bestBet, bestCota, evHome, evDraw,
                               evAway, evOver15, evGG, cotaHome, cotaDraw, cotaAway, ... }
    !! bestEV este NUMBER (0.43 = +43%), NU string. Formatarea se face în frontend.
    !! bestEV este null dacă nu există cote sau EV < 0 pentru toți candidații.
  calcPlayerScore(rating,goals,assists,passAcc,sot) → INTEGER 0-100

api/enrich.js — calculul principal per meci (Poisson + EV + Confidence + DB lookups)
  Handler HTTP: GET /api/enrich?h=&a=&fid=&lgid=&elapsed=&hg=&ag=&soth=&sota=&ref=&status_short=
  Batch 1 (paralel): form DB, h2h DB, odds DB, teamStrengths, injuries, matchStats,
                     leagueStats, refereeStats, venueInfo, standings, apiPred, topScorerFactor,
                     squadCount, lineupFactor
  Batch 2 (condițional): fallback API-Football DOAR dacă DB insuficient (<3 meciuri form)
  Lambda pipeline (în ordine, fiecare modifică result.lambdaHome/Away + recalculează matrix):
    1. calcPoisson() din form DB sau API
    2. teams_stats override dacă form insuficient
    3. standings blend (60% form + 40% medie sezon) Hybrid V2
    4. topScorerFactor (±15%)
    5. lineupFactor confirmat (±12%, necesită ≥7/11 starters cu date)
    6. injuryLambda penalty (star >80: ×0.88, >65: ×0.94, >45: ×0.97)
    7. model_weights lambda_multiplier per ligă din DB
    8. venue/altitude impact (>2500m: ×0.78/0.70, >2000m: ×0.88/0.82, >1500m: ×0.94/0.90)
    9. coachImpact (tenure + style: offensive/open/defensive/pragmatic)
    10. refereeImpact (home_win_rate bias + cardy_ref penalty)
  calcConfidence() returnează confidenceScore + breakdown + bestMarket + bestCota + bestEV
  !! bestEV din calcConfidence este STRING ("+43%") — BUG CRITIC #1 — NEFIXAT
  Fire-and-forget: fetchAndStoreInjuries, logPrediction (OVER15/GG/CONFIDENCE), INSERT predictions

api/match.js — detaliu complet meci (fixture + lineups + players + events + Poisson)
  Handler HTTP: GET /api/match?id=&h=&a=&br=
  Cache în memorie: live=1min, NS/FT=10min, max 100 entries
  Fetch MEREU din API: fixture, lineups, players, events
  Fetch CONDIȚIONAL (dacă DB insuficient): hForm, aForm, h2h, odds
  calcPoisson() local (funcție separată de enrich.js, cu aceeași logică)
  !! awayScoreRate: pct(aGames, m => (m.goals?.away ?? 0) > 0) — BUG #4 (ignoră when away plays home)
  !! homeForm/awayForm: opponent always taken from teams.away/home — BUG #10 (wrong for away games)
  !! INSERT predictions ON CONFLICT DO NOTHING — BUG #22 (nu actualizează predicții stale)
  Returnează: { fixture, lineups, players[], events[], enrich{} }
  !! enrich de la /api/match și enrich de la /api/enrich sunt OBIECTE DIFERITE cu câmpuri diferite

api/football.js — meciuri LIVE
  Handler HTTP: GET /api/football
  Sursă: fetch() DIRECT la /fixtures?live=all — BUG #2 (fără retry 429)
  fetchH2H() folosește de asemenea fetch() DIRECT — BUG #2
  NGP: citit din match_snapshots DB (scanner.js este sursa autoritară);
       fallback calc local DOAR pentru meciuri noi fără snapshot
  Returnează: { response: [matches filtrate...] }

api/today.js — meciuri PRE-MECI
  Handler HTTP: GET /api/today
  Sursă primară: PostgreSQL fixtures (fereastra now-2h → now+28h, status='NS', în whitelist)
  Fallback API: fetch() DIRECT — BUG #3 (fără retry 429)
  !! Filtru ligă redundant la linia 104 (meciurile deja filtrate în DB query)
  Side effect: upsertează meciuri NS din fallback API în fixtures table

api/calc-utils.js — deja descris mai sus

api/utils/fetch-api.js — SINGURUL LOC PERMIS pentru apeluri API-Football
  fetchApiFootball(url, options) → Response (cu .json() neapelat)
  Retry: 3 tentative. 429 → wait 30s (attempt 1), 60s (attempt 2). Alt error → 5s.
  !! football.js și today.js (calea de fallback) NU folosesc acest helper — BUG #2/#3

api/utils/live-score.js — calcule NGP/GG/Markets LIVE
  calcNextGoal(f) → INTEGER 3-97 (NGP pentru restul meciului)
  calcNextGoalWindow(f, windowMin=15) → INTEGER 3-60 (NGP pentru next N minute)
  calcGG(f) → INTEGER 5-95
  calcMarkets(f) → { over05, over15, over25, gg, home05, home15, away05, away15 }
  calcFeatures(m, fd) → obiect features extras din statistici live
  Calibrat prin backtest 24.05.2026: rate reale 27-45% pentru ng15 → cap la 60

api/utils/league-filter.js — SINGURUL LOC cu logica de filtrare
  WOMEN_TERMS (34), YOUTH_TERMS (24), LOWER_DIV_TERMS (38+)
  isAllowedLeague(name, id, allowedIds) → boolean
  isAllowedMatch(match, allowedIds) → boolean (include și check " W" la echipe)
  NU duplica aceste liste nicăieri altundeva.

api/utils/consensus-engine.js — alinierea Poisson nostru cu API-Football
  calcConsensus(result, apiPred) → { consensusScore, details, boost±5, signalCount }
  S1: direcție câștigător (H/D/A) — 0 sau 100
  S2: over/under direction din apiPred.predictions.under_over — 0 sau 100
  S3: lambda alignment — apiHomeGoals+apiAwayGoals vs result.lambdaTotal
  !! S3 compară mărimi structural diferite: API folosește last_5 goals.for.average
     (medie atac pur) vs noi folosim (homeAvgScored+awayAvgConceded)/2
     (cross-product). Divergența ±0.5-1.4 e normală structural, nu calibrare greșită.

api/utils/ngp-calibration.js — calibrare NGP (citit din ngp-calibration.js)

api/monte-carlo.js — Monte Carlo 10.000 simulări
  !! NU modifica niciodată simCount = 10.000 (regulă CLAUDE.md)
  runSimulation(lambdaHome, lambdaAway, simCount, currentHome, currentAway)
  Returnează: homeWin%, draw%, awayWin%, over05/15/25/35%, gg%, scoreDistribution,
              goalTiming (buckets 15min), scenarios { optimist, pessimist, surprise }

api/cron/scanner.js — procesul de background pornit de server.js
  startScanner() → 3 setInterval:
    scanLive10s() la 10s: fetch live + calcul NGP/markets + upsert match_snapshots
                         + alerts + resolveNGPOutcomes + league patterns
    scanLiveStats() la 60s: fetch statistics per meci activ → saveLiveStats
    scanPreMatch() la 60min: sync cache pre-meci din prematch_data DB
  !! scanLive10s folosește propriul fetchWithRetry (nu fetchApiFootball) — are retry 429

api/backfill.js — colectare date istorice 2022-2026
  STOP_AT = 280.000 (plan 300k — buffer 20k pentru scanner)
  Season-first: 2026 → 2022, per ligă din ALLOWED_LEAGUE_IDS
  Per fixture FT: collectStats + collectEvents + collectPlayers
  State persistent în app_settings (supraviețuiește restart VPS)
  getRealApiUsage() citește /status real la fiecare 10min

api/weights.js — cache greutăți model din DB
  loadModelWeights() la startup din tabel model_weights
  getWeight(module, contextKey, weightName) → specific → global → fallback
  Refresh automat la TTL 1h (non-blocking)

api/log-prediction.js — fire-and-forget INSERT în prediction_log
  Folosit de enrich.js (OVER15/GG/CONFIDENCE) și scanner.js (NGP/OVER15)

api/leagues.js — Set<number> ALLOWED_LEAGUE_IDS (228 ligi)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 3 — FORMULELE MATEMATICE (cu motivul fiecăreia)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A. POISSON 6×6 (calc-utils.js:18)

  De ce Poisson? Golurile într-un meci urmează distribuția Poisson — evenimente
  rare, independente, cu rată constantă. Validat empiric pentru fotbal.

  De ce 6×6? Scorurile peste 5-5 sunt extrem de rare (<0.1%). Trunchiem la 6.
  Proba trunchii = 36 combinații de scoruri posibile.

  lambdaHome = (homeAvgScored + awayAvgConceded) / 2
  lambdaAway = (awayAvgScored + homeAvgConceded) / 2

  De ce cross-product? Nu folosim doar atacul gazdei. Rata de gol a gazdei
  depinde și de cât de mult primește oaspetele. Mijlocia celor doi factori
  e mai precisă decât un singur factor.

  De ce ultimele 10 meciuri ACASĂ pentru gazdă și DEPLASARE pentru oaspete?
  Performanța home/away diferă semnificativ. Un club poate marca 2/meci acasă
  dar 0.8/meci deplasare. Folosind doar meciurile relevante, lambda e mai precis.

B. LAMBDA PIPELINE (enrich.js — 10 pași în ordine)

  Prioritatea datelor (de la cel mai specific la cel mai general):
  1. Form din ultimele 10 meciuri (cel mai relevant — recent și specific)
  2. teams_stats (medie sezon complet — mai mult context)
  3. standings blend (60/40 — balansează recency cu stabilitatea sezonului)
  4. topScorerFactor (jucătorul cheie influențează lambda ±15%)
  5. lineupFactor (formație confirmată ±12%)
  6. injuryLambda (star player lipsă = -6% până -12% lambda de atac)
  7. model_weights (auto-calibrare per ligă din learning-analysis)
  8. altitude/venue (meciuri la altitudine înaltă au mai puține goluri)
  9. coach style (antrenor ofensiv vs defensiv)
  10. referee (arbitru cu many-cards = mai puține goluri)

  De ce nu combinăm toți factorii simultan? Fiecare pas ajustează lambda
  incremental. Ordinea contează: forma recentă are prioritate față de
  media sezonului, care are prioritate față de statisticile ligii.

C. EXPECTED VALUE (calc-utils.js:67)

  evHome = (homeWin/100) - (impliedHome / totalImplied)

  De ce impartim impliedHome la totalImplied? Bookmaker-ii au "vig" (margine).
  Suma cotelor implicite e >100%. Normalizăm pentru a extrage probabilitățile
  reale ale bookmaker-ului, eliminând marja.

  EV > 0 înseamnă că modelul nostru crede că gazda câștigă mai des decât
  sugerează cota. Pe termen lung, EV > 0 e profitabil.

  Kelly Criterion: kelly = bankroll × edge × 0.5 (half-Kelly)
  De ce half-Kelly? Kelly complet maximizează creșterea logaritmică dar e
  volatil. Half-Kelly reduce riscul de drawdown semnificativ.

D. CONFIDENCE SCORE 8 STRATURI (enrich.js:358 — calcConfidence)

  Stratul       Greutate   Sursă                    Ce măsoară
  ─────────────────────────────────────────────────────────────────
  1. Poisson    0.20       over15Prob               Probabilitatea matematică
  2. Formă      0.18       homeAvg+awayAvg gol/meci Cât de ofensive sunt echipele
  3. H2H        0.10       h2hOver15 %              Istoricul direct al meciului
  4. Live xG    0.14       xg×25+sot×3+da×0.5       Presiunea ofensivă live
  5. EV market  0.08       best.ev×300              Alinierea cu piața
  6. Consis.    0.05       (straturi>60/5)×100      Cât de mulți factori confirmă
  7. TeamStr    0.18       player_stats strength     Calitatea individuală a jucătorilor
  8. Consensus  0.08       API Poisson alignment     Confirmarea predicției externe
  ─────────────────────────────────────────────────────────────────
  Total         1.00 (normalizat, straturi null excluse)

  De ce greutăți inegale? Testat empiric. Form + TeamStrength au cel mai mare
  predictor power. H2H și consistency au mai puțin.

  Penalizări runtime (aplicate DUPĂ weighted sum):
  - elapsed < 15min: × 0.85 (prea puțin timp pentru date semnificative)
  - 15-30min + SOT=0: × 0.80 (niciun șut după 15 min = meci defensiv)
  - ≥45min + SOT=0: - 20 (dacă la pauză nu s-a tras pe poartă, Over 1.5 improbabil)
  - yc ≥ 2: - 10 (cartonașe = meci mai lent, mai puțin ofensiv)
  - injuries (stars>85: -15, >70: -10, >50: -5, ≥3 accidentați: -3)
  - squads incomplete (<11: -10, <14: -5 per echipă)

E. TEAM STRENGTH (enrich.js:262 — getTeamStrengths)

  Din ultimele 110 rânduri player_stats per echipă:
    teamStrength = (avgRating/10*100)×0.35
                 + min(100, goalsPerGame×35)×0.25
                 + avgPassAcc×0.20
                 + min(100, avgSOT×12)×0.10
                 + min(100, topScorer×20)×0.10

  De ce 110 rânduri? ~10 meciuri × ~11 jucători = ~110. Suficient pentru
  statistici stabile fără a merge prea departe în trecut.

  Fallback: calcStrSeason() din players_season când player_stats insuficient (<10).
  Dacă ambele null → teamStrength = null → Layer 7 inactiv → greutate redistribuită.

F. NGP — Next Goal Probability (utils/live-score.js:75)

  remXg = (txg/mn) × (90-mn)    [rata xG actuală extrapolată la timp rămas]
  dacă txg=0: remXg = formGoals × 2.5 × remFrac   [fallback din forme istorice]
  dacă mn≥80: remXg × 1.15      [presiune de final de meci]
  dacă mn≥70: remXg × 1.20      [idem, mai mare]
  prob = 1 - exp(-max(remXg, 0.05))
  ng = round(max(3, min(97, prob×100)))

  Smoothing anti-oscilație în scanner.js: max ±5pp per ciclu (10s).
  Hide primele 10 minute (date insuficiente pentru certitudine).

G. MONTE CARLO (monte-carlo.js)
  10.000 simulări = echilibru precizie/performanță. Mai puțin = zgomot mare.
  Mai mult = inutil (eroarea scade cu √N, deci 40k e cu 2× mai precis dar 4× mai lent).
  !! NU modifica niciodată 10.000.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 4 — TIPURI CONTRACTUALE (ce returnează fiecare funcție)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

calcPoisson6x6(lH, lA) → {
  homeWin: number(0-100), draw: number, awayWin: number,  // sumă = 100
  over15Prob: number(0-100), over25Prob: number, ggProb: number
}

calcEV(matrix, oddsRaw) → {
  hasOdds: boolean,
  bestEV: number|null,    // !! NUMBER: 0.43 înseamnă +43%. NICIODATĂ string.
  bestBet: string|null,   // "Over 1.5", "GG", "1 (Gazde)", etc.
  bestCota: number|null,
  evHome: number|null, evDraw: number|null, evAway: number|null,
  evOver15: number|null, evGG: number|null,
  cotaHome: number|null, cotaDraw: number|null, cotaAway: number|null,
  cotaOver15: number|null, cotaGG: number|null
}

calcConfidence(result, oddsRaw, liveStats, teamStrengths, evData, apiPred) → {
  confidenceScore: number(5-100),
  breakdown: { poisson, forma, h2h, live, ev, consistenta, putereEchipe?, apiConsensus? },
  teamStrengthHome: number|null,
  teamStrengthAway: number|null,
  bestMarket: string|null,
  bestCota: number|null,
  bestEV: string|null    // !! STRING "+43%" — BUG CRITIC #1 — inconsistent cu calcEV
}

enrich.js handler returnează (payload final):
  { ...result, ...evData, ...confData, leagueStats, refereeStats }
  unde evData.bestEV = NUMBER și confData.bestEV = STRING
  Object.assign({ ...result, ...evData, ...confData }) → confData suprascrie evData
  Deci payload.bestEV = STRING — BUG CRITIC #1

match.js handler returnează: { fixture, lineups, players[], events[], enrich{} }
  enrich.bestEV = NUMBER (din calcEV direct, fără confData)

index.html primește AMBELE payloade și le combină:
  var en = Object.assign({}, enrichBase, cached)
  enrichBase = de la /api/enrich (bestEV STRING)
  cached = de la /api/match (bestEV NUMBER)
  !! Object.assign pune enrichBase primul, cached îl suprascrie
  Deci en.bestEV = NUMBER din match.js — TOTUȘI NaN în UI
  !! Dar la linia 1993: Object.assign({}, enrichBase, cached)
  cached suprascrie, deci en.bestEV = NUMBER din match.js... dar match.js
  folosește calcEV direct (NUMBER), deci UI ar trebui să funcționeze?
  Verificare necesară la fix.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 5 — REGULI ABSOLUTE (CE NU SE SCHIMBĂ NICIODATĂ)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Monte Carlo rămâne 10.000 simulări (api/monte-carlo.js simCount=10000)

2. STOP_AT în api/backfill.js = 280.000 (plan 300k - buffer 20k scanner)
   NU modifica fără cerere explicită utilizator.

3. bestEV este NUMBER în calc-utils.js:103 (0.43 = +43%)
   Formatarea "+43%" se face NUMAI în frontend, niciodată în backend.

4. Apeluri API-Football NUMAI prin fetchApiFootball() din api/utils/fetch-api.js
   EXCEPȚIE ACTUALĂ (bug): football.js și today.js (calea fallback) — de fixat.

5. Filtre ligi NUMAI prin isAllowedLeague()/isAllowedMatch() din api/utils/league-filter.js
   NU duplica WOMEN_TERMS, YOUTH_TERMS, LOWER_DIV_TERMS nicăieri altundeva.

6. calcPoisson6x6 din calc-utils.js — formula nu se schimbă fără backtesting.

7. Lambda cross-product: (homeAvgScored + awayAvgConceded) / 2 — NU suma simplă.

8. Greutățile Confidence Score (enrich.js:460-468) — schimbate NUMAI după
   backtest cu Brier score. Valori actuale validate.

9. NU commita chei, token-uri, .env în repo.

10. Deploy = git push origin main → GitHub Actions → auto-deploy pe VPS.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 6 — BUGTRACKER LIVE (toate bug-urile cunoscute cu status)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Format: [STATUS] #NR | Fișier:linie | Descriere scurtă

── CRITIC (5) ──────────────────────────────────────────────────────────────────

[x] #1 | api/enrich.js:402+425 | bestEV returnat ca STRING "+43%" în loc de NUMBER 0.43
        Cauza: `bestEV = '+' + Math.round(best.ev * 100) + '%'`
        Impact: NaN în 4 locuri UI; Safe Bet badge broken ("+43%" > 0 = false)
        Fix: `bestEV = best.ev;` (NUMBER), frontend formatează

[x] #2 | api/football.js:14-16,96 | fetch() direct la API-Football fără retry 429
        Cauza: codul scris înainte să existe fetchApiFootball()
        Impact: eșuare silențioasă la rate-limit
        Fix: import { fetchApiFootball } + înlocuiește toate fetch() cu ea

[x] #3 | api/today.js:146-147 | fetch() direct la API-Football fără retry 429
        Același ca #2 dar în calea de fallback din today.js
        Fix: același ca #2

[ ] #4 | api/match.js:135 | awayScoreRate calculat greșit
        Cauza: `pct(aGames, m => (m.goals?.away ?? 0) > 0)` — ignoră meciurile
               în care echipa oaspete a jucat acasă în datele istorice
        Fix: `pct(aGames, m => ((m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0) > 0)`

[ ] #5 | index.html:1993 | Object.assign({}, enrichBase, cached) — ordinea e inversată
        Cauza: enrichBase vine de la /api/enrich (cu bestEV STRING posibil),
               cached vine de la /api/match (cu bestEV NUMBER)
        Dar: în cod, enrichBase e primul argument, cached al doilea → cached SUPRASCRIE
             Deci dacă /api/match a rulat, bestEV e NUMBER → UI corect?
        Investigație necesară: când se apelează /api/enrich fără /api/match?
        Impact potențial: câmpuri calculate diferit între cele două endpoint-uri

── IMPORTANT (13) ──────────────────────────────────────────────────────────────

[x] #6  | api/enrich.js:441-442 | `teamStrengths.home || 50` — echipă cu scor 0 → 50
         Fix: `teamStrengths.home ?? 50`

[x] #7  | api/enrich.js:363-365 | `homeAvgScored || 1.2` — 0 goluri marcate → lambda 1.2
         Fix: `result.homeAvgScored ?? 1.2`

[ ] #8  | api/enrich.js:432-434 | Consistency score împarte la 5 fix chiar dacă score5=null
         Fix: `scores.filter(s => s !== null).length` ca divizor

[x] #9  | api/enrich.js:496 | `Math.round(null) = 0` → breakdown.ev = 0 fals
         Fix: `ev: score5 != null ? Math.round(score5) : null`

[ ] #10 | api/match.js:113-116 | homeForm opponent mereu teams.away.name
         Cauza: când hId a jucat în deplasare, adversarul e teams.home.name
         Fix: verificare `m.teams?.home?.id === hId`

[ ] #11 | api/match.js:139-140 | h2hOver15 și h2hGG fără ?? fallback
         Fix: adaugă `?? matrix.over15Prob` și `?? matrix.ggProb`

[ ] #12 | index.html:1643-1648 | Câmpuri greșite pentru league stats
         Cod folosește: `enr.league_avg_corners`, `enr.league_avg_yellow`
         Payload real are: `enr.leagueStats?.avg_corners`, `enr.leagueStats?.avg_yellow_cards`
         Impact: afișează mereu fallback hardcodat (9.5 și 4)

[x] #13 | index.html:2350 | `parseFloat(null).toFixed(2)` = "NaN / meci"
         Fix: `parseFloat(ls?.avg_goals_per_match || 0).toFixed(2)`

[ ] #14 | index.html:2643 | Season fallback: `getFullYear()-1` greșit din iulie 2026+
         Fix: logică corectă: `month < 7 ? year-1 : year` (sau citit din payload)

[ ] #15 | index.html:2693 | Standings coloring fals fără puncte
         Fix: adaugă guard `if (homePoints == null || awayPoints == null) return;`

[ ] #16 | api/enrich.js:460-468 | Layer weights diferite față de CLAUDE.md
         Cod real: 0.20, 0.18, 0.10, 0.14, 0.08, 0.05, 0.18, 0.08
         CLAUDE.md documentează: 25%, 20%, 15%, 15%, 15%, 10% (fără layer 7/8)
         Acțiune: actualizează CLAUDE.md să reflecte realitatea

[ ] #17 | api/enrich.js:366 | Layer 2 Formă folosește fixtures_history, NU form_stats
         CLAUDE.md spune că Layer 2 vine din form_stats
         Cod real: calcPoisson folosește hGames/aGames din fixtures_history
         Nu e neapărat greșit — form_stats e derivat din fixtures_history
         Acțiune: documentație de clarificat

[ ] #18 | api/utils/consensus-engine.js:45-46 | Lambda structurally incomparabil
         API: last_5.goals.for.average (medie atac pur per echipă, sumă 2 echipe)
         Noi: (homeAvgScored+awayAvgConceded)/2 × 2 (cross-product)
         Divergența ±0.5-1.4 e normală, nu indică eroare de calibrare

── COSMETIC (5) ────────────────────────────────────────────────────────────────

[x] #19 | index.html:1738 | "neanalzate" → "neanalizate"
[x] #20 | index.html:1807 | "Neanalzat" → "Neanalizat"
[ ] #21 | index.html:2984-2996 | `var rem5` declarat de 3 ori; `var xgH5/xgA5` ×2
[x] #22 | api/match.js:336 | ON CONFLICT DO NOTHING → predicții niciodată actualizate
         Fix: schimbă în ON CONFLICT DO UPDATE (ca în enrich.js)
[ ] #23 | api/today.js:104 | Filtru ligă redundant (deja filtrat în DB query la linia 31)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 7 — DECIZII ARHITECTURALE (de ce s-a ales fiecare soluție)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

D1: PostgreSQL în loc de Supabase
    Motivul: control total, fără limite de conexiuni, cost 0 suplimentar.
    Supabase era în versiunea 1 — tot codul Supabase a fost eliminat (17.05.2026).

D2: Scanner în-process (scanner.js) în loc de cron la fiecare minut
    Motivul: cron la 1min = ~10s delay mediu + overhead spawn process.
    In-process la 10s = real-time. Plus: state persistent în liveCache (în memorie).

D3: WebSocket pentru date live, polling pentru pre-meci
    Motivul: datele live se schimbă la 10-30s → WebSocket e mai eficient.
    Pre-meci nu se schimbă rapid → polling simplu.

D4: Delta broadcast (LIVE_DELTA) la fiecare scan, FULL la fiecare 5min
    Motivul: 90% din meciuri nu se schimbă la fiecare 10s.
    Trimitem doar ce s-a schimbat (goals|elapsed|ngp|sot|forte|redCards).

D5: DB-first pentru form/h2h/odds, API fallback
    Motivul: economie de apeluri API. DB are deja datele din backfill/cron.
    API este apelat NUMAI dacă DB are <3 meciuri (pragul minim pentru lambda).

D6: fetchApiFootball() ca single point of failure pentru API
    Motivul: gestionare centralizată 429 retry, autentificare, logging.
    Excepție actuală: football.js și today.js (calea fallback) — bug cunoscut.

D7: Lambda cross-product vs lambda simplu
    Motivul: lambdaHome = media DINTRE cât atacă gazda ȘI cât primește oaspetele.
    Simplu (doar homeAvgScored) ar ignora calitatea apărării oaspetelui.

D8: Confidence Score ca sumă ponderată din 8 straturi
    Motivul: niciun singur semnal nu e suficient de precis. Combinarea mai multor
    semnale independente reduce zgomotul și crește precizia.

D9: Backfill season-first (2026→2022, nu ligă-first)
    Motivul: datele recente (2025/2026) sunt mai valoroase pentru predicții.
    Dacă STOP_AT e atins, cel puțin avem datele cele mai recente.

D10: model_weights în DB (nu hardcodate)
     Motivul: learning-analysis.js le actualizează automat din backtesting.
     Greutățile se calibrează per ligă fără modificare de cod.

D11: Smoothing NGP ±5pp per ciclu
     Motivul: fără smoothing, NGP oscilează ±20pp la fiecare 10s (noise din API).
     Cu smoothing, utilizatorul vede o tendință clară.

D12: bestEV = NUMBER în calc-utils.js, formatare în frontend
     Motivul: backend-ul calculează, frontend-ul afișează.
     Formatând în backend, pierdem posibilitatea de a face comparații numerice.
     !! Această decizie a fost ÎNCĂLCATĂ în enrich.js:402 — bug critic #1.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 8 — FLUXUL COMPLET AL DATELOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INTRĂRI DATE:
  API-Football → backfill.js   → fixtures_history, match_stats, match_events, player_stats
  API-Football → collect-daily → standings, teams, leagues, form_stats
  API-Football → collect-finished → fixtures_history (FT), player_stats, match_stats, odds
  API-Football → referee-stats → fixtures_history (cu referee), referee_stats
  API-Football → prematch-enrichment → prematch_data (JSONB per stage/fixture)
  API-Football → scanner.js (10s) → match_snapshots, live_stats, alerts

CALCULE:
  fixtures_history → league-stats → league_stats (avg_goals, pct_over*, pct_gg)
  fixtures_history → collect-daily → form_stats (last5, avg_scored/conceded)
  fixtures_history → referee-stats → referee_stats (style, avg_yellow, etc.)
  prediction_log → learning-analysis → model_weights (calibrare per ligă)

CITIRE RUNTIME:
  fixtures (NS) → today.js → frontend (lista pre-meci)
  fixtures?live=all → football.js → frontend (lista live)
  form_stats+h2h+odds+player_stats+league_stats+referee_stats → enrich.js → Poisson+EV+Confidence
  API (fixture+lineups+players+events) + DB (form+h2h+odds) → match.js → detaliu meci
  prematch_data → scanner.js (scanPreMatch) → prematchCache în memorie
  match_snapshots → football.js → _ng injectat în meciuri live (NGP afișat)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 9 — STAREA DB (valori reale din audit 23.05.2026)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Valori din audit direct psql pe VPS (23.05.2026):
  player_stats      1.164.707 rânduri  (245 MB) — Layer 7 ACTIV
  fixtures_history     75.515 rânduri  ( 16 MB)
  match_stats          58.414 rânduri
  odds                343.510 rânduri
  form_stats            6.318 rânduri
  league_stats            606 rânduri
  referee_stats           198 rânduri
  h2h                   1.369 rânduri  (încă puțin — backfill în progres)
  standings             2.405 rânduri
  predictions             972 rânduri

Backfill progres la 23.05: 55.5% (633/1140 perechi ligă-sezon)
Plan API-Football: upgrade la 300.000/zi efectuat 27.05.2026
STOP_AT actualizat la 280.000 (300k - 20k buffer)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 10 — DIRECȚIA DE ÎMBUNĂTĂȚIRE A PREDICȚIILOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CE AVEM ȘI NU SE FOLOSEȘTE COMPLET:
  - players_season: populat de backfill, NICIODATĂ citit în runtime curent
    Potențial: player form sezon (rating, goals, assists) → îmbunătățire Layer 7
  - top_scorers: tabel populat, folosit PARȚIAL în enrich.js (topScorerFactor ±15%)
    Potențial: player props betting (număr goluri individuale)
  - squads: colectat în prematch_data, citit pentru squad completeness check
    Potențial: mai bun injury impact când combined cu players_season
  - h2h: 1.369 rânduri — relativ puțin față de 228 ligi × ~4 ani
    Problem: backfill colectează h2h NUMAI din scanner.js (meciuri FT live)
    Soluție: backfill explicit h2h via /fixtures/headtohead endpoint

CUM SE POATE CREȘTE PRECIZIA PREDICȚIILOR:
  1. Mai mult h2h → precizie Layer 3 H2H mai bună
  2. Completare players_season → fallback mai bun când player_stats insuficient
  3. live_odds tabel (odds drift semnal) — piața se mișcă cu informație
     Dacă cotele scad rapid → market knows something → semnal negativ EV
  4. Learning-analysis rulând de suficient timp → model_weights calibrate per ligă
     Ligile cu multe goluri (Eredivisie) să primească lambda_multiplier > 1
  5. Brier score tracking în prediction_log → feedback loop automat

PRECIZIE ACTUALĂ (estimată):
  Over 1.5: ~65-70% accuracy la confidence > 75 (neverificat empiric pe date mari)
  NGP: backtest 24.05.2026 → rate reale 27-45% pentru toate range-urile ng15

CE NU SE POATE ÎMBUNĂTĂȚI (limitări externe):
  - xG de calitate vine doar dacă API-Football furnizează date (nu toate meciurile)
  - H2H sub 5 meciuri → probabilitate statistică slabă
  - Echipe noi / promovate → date istorice insuficiente → lambda = average ligă

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 11 — CONSUMUL API ȘI LIMITE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Plan activ: 300.000/zi (de la 27.05.2026)

Estimare consum zilnic:
  Scanner live (background):
    scanLive10s: fixtures?live=all la 10s = 8.640/zi
    scanLiveStats: statistics per meci la 60s = N×1440 (20 meciuri = 28.800/zi)
    fetchWithRetry lineups+events = variabil ~5.000-10.000/zi
    TOTAL scanner: ~45.000-50.000/zi (rezervat)

  Cron-uri zilnice:
    prematch-enrichment (*/5): ~7.800-15.600/zi
    collect-finished (23:00): ~1.200-2.400/zi
    collect-daily (06:00): ~228/zi (1 per ligă)
    referee-stats (04:00): ~34/zi
    TOTAL cron: ~10.000-20.000/zi

  Backfill (03:00-limitare):
    STOP_AT = 280.000 (cumulativ, nu zilnic — înseamnă oprire când total atinge 280k)
    Efectiv per zi: ~50.000-100.000 (depinde de câte fixture-uri are liga curentă)

  Match detaliu (on-demand):
    match.js: 4 apeluri MEREU (fixture+lineups+players+events)
            + 3 condiționale (hForm, aForm, h2h, odds)
    La trafic normal: ~500-2.000/zi

  DISPONIBIL pentru backfill: 300k - 50k(scanner) - 20k(cron) = ~230k/zi
  Buffer de siguranță: STOP_AT la 280k garantează că nu depășim limita

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 12 — TABELE DB (structură, cine scrie, cine citește)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TABELE ACTIVE (date frecvent actualizate):

fixtures            → today.js(NS fallback API), collect-daily
                    ← today.js(primar), generator.js, scanner.js

fixtures_history    → backfill.js, collect-finished, referee-stats, scanner.js(FT)
                    ← enrich.js(form), match.js(form), simulate.js, league-stats,
                       referee-stats, learning-analysis, scanner.js(getFormGoals)
                    NOTĂ: sursa principală de date pentru toți algoritmii de formă

form_stats          → collect-daily.js (SQL batch din fixtures_history), scanner.js
                    ← generator.js (scoring algoritm)
                    NOTĂ: nu e citit direct de enrich.js/match.js (ei citesc fixtures_history)

player_stats        → backfill.js, collect-finished.js
                    ← enrich.js(getTeamStrengths Layer 7), simulate.js

match_stats         → collect-finished.js, backfill.js
                    ← enrich.js(xG din DB), league-stats.js, referee-stats.js

match_events        → collect-finished.js, backfill.js
                    ← referee-stats.js(penalties), league-stats.js

live_stats          → scanner.js(saveLiveStats la 60s)
                    ← match.js(getLiveStatsFromDB → dynamic lambda)

match_snapshots     → scanner.js(upsertSnapshot la fiecare 10s)
                    ← football.js(NGP injectat în răspuns)
                    NOTĂ: NU în create-tables.sql — creat de ensureTables() în scanner.js

odds                → collect-finished.js
                    ← enrich.js(getOddsFromDB), match.js, simulate.js

predictions         → enrich.js(INSERT/UPDATE), match.js(INSERT DO NOTHING), scanner.js
                    ← update-results.js(completare result_over15/result_gg),
                       db-stats.js(ngpWinRate)

alerts              → scanner.js(saveAlert la NGP>70 sau over15>70)
                    ← admin.js, health-check.js

prediction_log      → enrich.js, scanner.js (fire-and-forget)
                    ← learning-analysis.js (backtesting zilnic)

model_weights       → learning-analysis.js (actualizare zilnică din backtesting)
                    ← weights.js(getWeight), enrich.js(lambda_multiplier)

TABELE STATICE (populate de cron/backfill, citite de runtime):

standings           → collect-daily.js, backfill.js
                    ← enrich.js(getStandingsForTeam → blending Hybrid V2), simulate.js

teams               → collect-daily.js, backfill.js
                    ← today.js(logos), generator.js

leagues             → collect-daily.js
                    ← today.js, generator.js, league-stats.js

league_stats        → league-stats.js(cron 04:00)
                    ← enrich.js(lgHome/lgAway fallback lambda), generator.js

referee_stats       → referee-stats.js(cron 04:00)
                    ← enrich.js(style adjustment ±5), generator.js

teams_stats         → backfill.js(collect-team-stats), collect-team-stats.js
                    ← enrich.js(fallback lambda prioritate 2), match.js, generator.js

h2h                 → backfill.js, scanner.js(saveFormStats implicit)
                    ← enrich.js, match.js, simulate.js, generator.js

prematch_data       → prematch-enrichment.js(7 etape)
                    ← enrich.js(getVenueForFixture, getPrematchPredictions, getInjuriesFromDB),
                       scanner.js(scanPreMatch), generator.js(referee din payload)

injuries            → enrich.js(fetchAndStoreInjuries fire-and-forget), prematch-enrichment
                    ← enrich.js(getInjuriesFromDB), generator.js, simulate.js

venues              → collect-venues.js(cron)
                    ← enrich.js(getVenueForFixture → altitude/surface impact)

players_season      → backfill.js(collect-players-season)
                    ← enrich.js(getTeamStrengths fallback calcStrSeason), getLineupStrengthFactor

top_scorers         → collect-top-scorers.js(cron)
                    ← enrich.js(getTopScorerFactor ±15%)

squads              → collect-squads.js(prematch-enrichment stage 1)
                    ← enrich.js(getSquadCount → penalizare lot incomplet)

coach_stats         → coach-stats.js(cron), collect-coaches.js
                    ← enrich.js(getCoachImpact → over15/over25/gg multiplier)

pre_match_snapshots → enrich.js(INSERT la fiecare pre-meci)
                    ← update-results.js(UPDATE outcome WIN/LOSS), admin.js

backfill_progress   → backfill.js(initBackfillProgress, savePosition)
                    ← /api/backfill/status

app_settings        → backfill.js(setSetting — persistent state)
                    ← backfill.js(getSetting — resume după restart), server.js

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 13 — CRON JOBS (orar complet, ce rulează pe VPS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  */5 * * * *  → POST /api/cron/prematch-enrichment
                 7 etape date pre-meci (24h fereastră kickoff)
                 Stage-uri bazate pe ore rămase: 24h, 12h, 6h, 3h, 2h, 1h, 45min

  0 2 * * *    → GET /api/update-results
                 Completează result_over15/result_gg în predictions pentru meciuri FT
                 LIMIT 50, sleep 500ms între fiecare predicție

  0 3 * * *    → POST /api/backfill/start
                 Backfill date istorice 2026→2022 (resume din app_settings)
                 Se oprește la STOP_AT = 280.000 apeluri totale

  30 3 * * *   → bash /root/scripts/backup-db.sh
                 Dump 19 tabele gzip → push la soareluna2025/scannerv2-backups
                 Retenție 7 zile local + 7 zile GitHub

  0 4 * * *    → POST /api/cron/league-stats
                 Statistici agregate per ligă din fixtures_history + match_stats
                 ZERO apeluri API (pur SQL)

  0 4 * * *    → POST /api/cron/referee-stats
                 Statistici per arbitru + fetch 33 zile din API-Football

  30 3 * * *   → POST /api/cron/learning-analysis (C8)
                 Backtesting zilnic din prediction_log
                 5 pași: per-ligă, per-minut, per-scor, re-calibrare layere, log

  0 6 * * *    → POST /api/cron/collect-daily
                 standings + teams + leagues + form_stats
                 ~228 req (1 standings per ligă)

  0 23 * * *   → POST /api/cron/collect-finished
                 Player_stats + match_stats + match_events + odds pentru meciuri FT din azi

  BACKGROUND (NU în crontab — in-process via scanner.js):
    scanLive10s()    la  10 secunde
    scanLiveStats()  la  60 secunde
    scanPreMatch()   la  60 minute

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 14 — REGULI DE LUCRU PER SESIUNE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LA FIECARE SESIUNE NOUĂ:
  1. Citesc SESSION_CONTEXT.txt (secțiunea 12 = ce s-a făcut ultima dată)
  2. Citesc ARHITECT.md (aceasta) — verifică bugtracker și decizii
  3. Verific ROADMAP_CALIBRARE.md dacă task-ul implică calibrare/faze

ÎNAINTE DE ORICE MODIFICARE JS:
  - Verific tipurile contractuale din Secțiunea 4
  - Verific Secțiunea 5 (ce nu se atinge)
  - node --check <fișier.js> după fiecare editare

DUPĂ ORICE TASK FINALIZAT:
  - Actualizez BUGTRACKER din Secțiunea 6 (marchez [x] bug-urile rezolvate)
  - Actualizez SESSION_CONTEXT.txt secțiunea 12: [ZZ.LL HH:MM] - CE S-A FĂCUT | Commit: hash
  - commit + push pe branch-ul de lucru, merge în main

CÂND SCHIMB O FORMULĂ MATEMATICĂ:
  - Documentez în Secțiunea 3 de ce s-a schimbat
  - Adaug în Secțiunea 7 decizia arhitecturală
  - Verific dacă alte fișiere depind de output-ul schimbat

CÂND ADAUG UN NOU CÂMP LA UN ENDPOINT:
  - Documentez tipul exact (NUMBER, STRING, null?) în Secțiunea 4
  - Verifică ce face frontend-ul cu câmpul respectiv

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECȚIUNEA 15 — ISTORICUL MODIFICĂRILOR ACESTUI FIȘIER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[27.05.2026] — Creat. Audit complet al întregului codebase.
               23 bug-uri identificate (5 critic, 13 important, 5 cosmetic).
               Toate deciziile arhitecturale documentate.
               Tipuri contractuale pentru funcțiile cheie documentate.

================================================================================
