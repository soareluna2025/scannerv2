# 📊 AUDIT LAMBDA POISSON — Raport detaliat

## 1️⃣ `calc-utils.js` — Funcții Poisson

### Conținut relevant lambda

`calc-utils.js` **NU calculează lambda**. Doar primește lambdaHome și lambdaAway gata calculate și produce matricea 6×6 de probabilități scoruri.

```js
// Linia 12-17: PMF Poisson
function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

// Linia 19-43: Matrice 6×6 cu Poisson INDEPENDENT (fără correlation)
export function calcPoisson6x6(lambdaHome, lambdaAway) {
  let probHomeWin = 0, probDraw = 0, probAwayWin = 0;
  let probOver15 = 0, probOver25 = 0, probGG = 0;

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const p = poissonProb(lambdaHome, i) * poissonProb(lambdaAway, j);
      if (i > j) probHomeWin += p;
      else if (i === j) probDraw += p;
      else probAwayWin += p;
      if (i + j >= 2) probOver15 += p;
      if (i + j >= 3) probOver25 += p;
      if (i > 0 && j > 0) probGG += p;
    }
  }
  // ... normalizare la 100%
}
```

**Date intrare:** `lambdaHome`, `lambdaAway` (scalari).
**Formula:** Poisson INDEPENDENT — `P(i,j) = P(i|λH) × P(j|λA)`. **Nu** există corelație între echipe (Dixon-Coles tau = 0).
**Output:** homeWin%, draw%, awayWin%, over15Prob%, over25Prob%, ggProb%.

---

## 2️⃣ `enrich.js` — Sursa și calculul lambda

### A. De unde vin `homeAvgScored` etc.

```js
// Linia 422-439: getFormFromDB(teamId)
async function getFormFromDB(teamId) {
  const r = await query(
    `SELECT home_team_id, away_team_id, home_goals, away_goals
     FROM fixtures_history
     WHERE (home_team_id = $1 OR away_team_id = $1)
       AND status_short = 'FT'
       AND home_goals IS NOT NULL
     ORDER BY match_date DESC
     LIMIT 10`,
    [teamId]
  );
  return r.rows.map(row => ({
    teams: { home: { id: row.home_team_id }, away: { id: row.away_team_id } },
    goals: { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
  }));
}
```

| Întrebare | Răspuns |
|---|---|
| **Tabel sursă** | `fixtures_history` |
| **Filtru** | `status_short = 'FT'` + `home_goals IS NOT NULL` |
| **Câte meciuri** | **`LIMIT 10`** (ultimele 10 meciuri ale echipei) |
| **Tip meciuri** | **MIXATE** acasă + deplasare (filtru `home_team_id=$1 OR away_team_id=$1`) |
| **Sortare** | `ORDER BY match_date DESC` |

### B. Calculul mediei (în `calcPoisson`)

```js
// Linia 104-118: calcPoisson()
function calcPoisson(hGames, aGames, h2h, hId, aId, elapsedParam, hgParam, agParam, sothParam, sotaParam, lgHome = 1.2, lgAway = 1.2) {
  const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : 0;
  // ...

  // Linia 108-111: extragere perspectivă corectă H/A
  const homeAvgScored   = avg(hGames, m => (m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0);
  const homeAvgConceded = avg(hGames, m => (m.teams?.home?.id === hId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgScored   = avg(aGames, m => (m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgConceded = avg(aGames, m => (m.teams?.away?.id === aId ? m.goals?.home : m.goals?.away) ?? 0);

  // Linia 113-118: CROSS-PRODUCT lambda (Nivel 2 Poisson)
  let lambdaHome = hGames.length && aGames.length
    ? (homeAvgScored + awayAvgConceded) / 2
    : lgHome;
  let lambdaAway = hGames.length && aGames.length
    ? (awayAvgScored + homeAvgConceded) / 2
    : lgAway;
```

| Întrebare | Răspuns |
|---|---|
| **Tip mediană** | **SIMPLĂ** (`Σgoals / N`), nu ponderată |
| **Temporal decay** | ❌ **ABSENT** (toate cele 10 meciuri cântăresc egal — meciul de acum 90 zile = meciul de ieri) |
| **Attack/Defense Strength (Maher/Dixon-Coles)** | ❌ **ABSENT** ca formulă pură |
| **Normalizare față de media ligii** | ⚠️ **DOAR ca fallback** (`lgHome=1.2` default, `lgAway=1.2` default) când `hGames=0`. NU normalizat permanent. |

### C. Ajustări ulterioare lambda în enrich.js

După calcul cross-product, lambda mai suferă 3 ajustări secvențiale:

#### Ajustare #1 — `teams_stats` override (linia 751-774, doar dacă form insuficient)
```js
if (formInsufficient && (tsH || tsA)) {
  result.lambdaHome = +((tsHScored + tsAConceded) / 2).toFixed(2);
  result.lambdaAway = +((tsAScored + tsHConceded) / 2).toFixed(2);
  // ...recalcul Poisson 6×6
}
```
**Sursă:** `teams_stats.avg_goals_for`, `avg_goals_against` (sezonal).

#### Ajustare #2 — `standings` blend 60/40 (linia 776-790, Hybrid V2)
```js
if (!formInsufficient && stnH && stnA) {
  const stnLambdaH = (stnH.avgScored + stnA.avgConceded) / 2;
  const stnLambdaA = (stnA.avgScored + stnH.avgConceded) / 2;
  result.lambdaHome = +(result.lambdaHome * 0.6 + stnLambdaH * 0.4).toFixed(2);
  result.lambdaAway = +(result.lambdaAway * 0.6 + stnLambdaA * 0.4).toFixed(2);
}
```
**Sursă:** `standings.goals_for / played`, `goals_against / played` (sezonal complet).
**Greutate:** 60% form recent, 40% medie sezonală.

#### Ajustare #3 — Top scorer factor ±15% (linia 793-804)
```js
if (lgid && (topScorerFactorH !== 1.0 || topScorerFactorA !== 1.0)) {
  result.lambdaHome = +(result.lambdaHome * topScorerFactorH).toFixed(2);
  result.lambdaAway = +(result.lambdaAway * topScorerFactorA).toFixed(2);
}
```
**Sursă:** `top_scorers` tabel; ratio `MAX(goals)` echipă / `AVG(goals)` ligă. Clamped la `[0.85, 1.15]`.
**Aproximare primitivă** de Attack Strength.

#### Ajustare #4 — Dynamic lambda LIVE (linia 94-128, doar pentru meciuri live)
```js
function calcDynamicLambda(lambdaBase, elapsed, currentGoals, sot) {
  const minutesLeft = Math.max(1, 90 - elapsed);
  const fraction = minutesLeft / 90;
  const shotRate = (sot / Math.max(elapsed, 1)) * 90;
  const intensityFactor = 1 + Math.min(shotRate / 25, 0.4);
  const lambdaRemaining = lambdaBase * fraction * intensityFactor;
  return { lambda: currentGoals + lambdaRemaining, dynamic: true };
}
```
**Sursă:** SOT (Shots on Target) acumulat live.
**Efect:** reduce lambda proporțional cu timpul rămas + intensitate.

#### Ajustare #5 — Venue altitude + surface (linia 806-831)
```js
if (altM > 2500)       { over15Prob ×= 0.78; over25Prob ×= 0.70; }
else if (altM > 2000)  { over15Prob ×= 0.88; over25Prob ×= 0.82; }
else if (altM > 1500)  { over15Prob ×= 0.94; over25Prob ×= 0.90; }
if (surface === 'artificial') over25Prob ×= 1.05;
```
**Atenție:** aplicat pe `over15Prob`/`over25Prob` (probabilități), NU pe lambda direct. **Inconsistent arhitectural.**

#### Ajustare #6 — Coach impact (linia 833-847)
```js
const o15 = sqrt(homeImp.over15 * awayImp.over15);  // mediană geometrică
result.over15Prob *= o15;
result.over25Prob *= o25;
result.ggProb     *= ggm;
```
**Same:** pe probabilități, nu pe lambda.

#### Ajustare #7 — Referee impact (linia 850-868)
```js
result.homeWin    *= refImp.homeWin;
result.over25Prob *= refImp.over25;
if (refereeStats.referee_style === 'open')   result.over25Prob += 5;
```
**Same:** pe probabilități, nu pe lambda.

---

## 3️⃣ RAPORT FINAL

### Ce nivel de Poisson folosim ACUM

**Nivel 2 (Cross-Product Poisson)** — implementare corectă a formulei cu separare perspective home/away, dar:
- **fără temporal decay** (Dixon-Coles 1997)
- **fără Attack/Defense Strength normalizare** strictă (Maher 1982)
- **fără tau correction** pentru low-scoring (0-0, 1-0, 0-1, 1-1) — Dixon-Coles complet

```
NIVELURI:
─────────────────────────────────────────────────
Nivel 1 — Basic Poisson:    λH=avgHome, λA=avgAway     ❌ NU
Nivel 2 — Cross-Product:    λH=(hAtt+aDef)/2           ✅ DA  ← acum aici
Nivel 3 — Maher (1982):     λH=lgAvg×hAttStr×aDefStr   ⚠️ PARȚIAL
Nivel 4 — Dixon-Coles (97): + tau corr + time decay    ❌ NU
```

### Ce LIPSEȘTE complet

| Feature | Linia | Notă |
|---|---|---|
| **Temporal decay** (`φ^(t-ti)`) | nicio implementare | Meciuri de acum 90 zile = la fel de relevante ca cele de ieri |
| **Attack Strength normalizat** | absent | Ar fi: `hAttStr = avgScoredHome / leagueAvgHomeGoals` |
| **Defense Strength normalizat** | absent | Ar fi: `aDefStr = avgConcededAway / leagueAvgAwayGoals` |
| **Dixon-Coles tau correction** | absent în `calc-utils.js:19-43` | Corecție low-scoring (1-1, 0-0, 1-0, 0-1) |
| **Home Advantage explicit** | absent | Maher: `λH = lgHome × hAtt × aDef × γ` unde γ ≈ 1.3 |
| **Ratings tip ELO pentru lambda** | absent (ELO există în `elo.js` dar afectează doar `simulate.js`) | Nu se aplică în pipeline-ul enrich.js principal |
| **Filtrare H/A separat** la fetch | absent în `getFormFromDB` | Trage ULTIMELE 10 mixate H+A. Pentru cross-product CORECT ar trebui ultimele 10 ALE GAZDEI **ACASĂ** + ultimele 10 ALE OASPETELUI **ÎN DEPLASARE** |

### Ce EXISTĂ parțial

| Feature | Locație | Stare |
|---|---|---|
| **Cross-product lambda** | `enrich.js:113-118` | ✅ COMPLET |
| **Standings blend 60/40** | `enrich.js:776-790` | ⚠️ Aproximare grosolană de Maher (NU normalizat la liga avg) |
| **Top Scorer factor** | `enrich.js:179-194, 793-804` | ⚠️ Primitiv Attack Strength (±15%) |
| **Fallback teams_stats** | `enrich.js:751-774` | ⚠️ Sezonal, dar doar dacă form insuficient |
| **Fallback league_stats** | `enrich.js:746-747` | ⚠️ Doar `lgHome=1.2/lgAway=1.2` hardcoded când absent |
| **Dynamic lambda live** | `enrich.js:94-102` | ✅ COMPLET pentru live |
| **Layer 7 — Player Intelligence** | `enrich.js:206-267` | ✅ Afectează `confidenceScore`, NU lambda |

### Linii exacte unde se poate ÎMBUNĂTĂȚI

#### 🔴 PRIORITATE 1 — Maher Attack/Defense Strength (Nivel 3)

**Locație fix:** `enrich.js:104-161` (funcția `calcPoisson`)

**Modificare necesară:**
```js
// ACUM (linia 113-118):
let lambdaHome = (homeAvgScored + awayAvgConceded) / 2;
let lambdaAway = (awayAvgScored + homeAvgConceded) / 2;

// MAHER 1982 ar fi:
const lgHomeAvg = leagueStats?.avg_home_goals || 1.5;
const lgAwayAvg = leagueStats?.avg_away_goals || 1.1;
const hAttStr = homeAvgScored   / lgHomeAvg;     // 1.0 = liga avg
const aDefStr = awayAvgConceded / lgHomeAvg;     // 1.0 = liga avg
const aAttStr = awayAvgScored   / lgAwayAvg;
const hDefStr = homeAvgConceded / lgAwayAvg;
const homeAdvantage = 1.3; // bonus tipic acasă

let lambdaHome = lgHomeAvg * hAttStr * aDefStr * homeAdvantage;
let lambdaAway = lgAwayAvg * aAttStr * hDefStr;
```

**Beneficii:** elimină bias liga (un meci Liga 1 vs Liga 2 are baseline diferit) + introduce Home Advantage explicit.

#### 🟡 PRIORITATE 2 — Temporal decay (Dixon-Coles)

**Locație fix:** `enrich.js:422-439` (`getFormFromDB`) + `enrich.js:108-111` (`calcPoisson`)

**Modificare:**
```sql
-- Adaugă match_date în SELECT
SELECT home_team_id, away_team_id, home_goals, away_goals, match_date
FROM fixtures_history
```

```js
// În calcPoisson(), media ponderată:
const phi = 0.0065; // half-life ~107 zile (Dixon-Coles 1997)
const now = Date.now();
const weighted = (arr, valueFn) => {
  let sumW = 0, sumWV = 0;
  for (const m of arr) {
    const ageDays = (now - new Date(m.match_date).getTime()) / 86_400_000;
    const w = Math.exp(-phi * ageDays);
    sumW  += w;
    sumWV += w * valueFn(m);
  }
  return sumW > 0 ? sumWV / sumW : 0;
};
const homeAvgScored = weighted(hGames, m => ((m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0));
```

**Beneficii:** meciuri recente cântăresc mai mult → reflectă forma reală.

#### 🟡 PRIORITATE 3 — Filtrare H/A separat la fetch

**Locație fix:** `enrich.js:422-439` (`getFormFromDB`)

**Modificare:** 2 funcții separate `getHomeFormHome(teamId)` și `getAwayFormAway(teamId)`:
```sql
-- getHomeFormHome (doar meciurile acasă):
SELECT * FROM fixtures_history
WHERE home_team_id = $1 AND status_short = 'FT'
ORDER BY match_date DESC LIMIT 10

-- getAwayFormAway (doar meciurile în deplasare):
SELECT * FROM fixtures_history
WHERE away_team_id = $1 AND status_short = 'FT'
ORDER BY match_date DESC LIMIT 10
```

**Beneficii:** elimină perspective mixate H+A, datele sunt curate pentru cross-product.

#### 🟢 PRIORITATE 4 — Dixon-Coles tau correction

**Locație fix:** `calc-utils.js:19-43` (`calcPoisson6x6`)

**Modificare:** după calculul `p = poissonProb(λH,i) × poissonProb(λA,j)`, aplică corecție pentru `(i,j) ∈ {(0,0),(1,0),(0,1),(1,1)}`:
```js
function tauDC(i, j, lH, lA, rho = -0.10) {
  if (i === 0 && j === 0) return 1 - lH*lA*rho;
  if (i === 0 && j === 1) return 1 + lH*rho;
  if (i === 1 && j === 0) return 1 + lA*rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}
// În loop: p = poissonProb(λH,i) * poissonProb(λA,j) * tauDC(i,j,λH,λA);
```

**Beneficii:** corectează underestimation a meciurilor low-scoring (real-world: 0-0, 1-0, 0-1 apar mai des decât Poisson independent prezice).

---

## 🎯 SUMAR EXECUTIV

| Aspect | Stare actuală | Linia exactă | Îmbunătățire posibilă |
|---|---|---|---|
| Nivel Poisson | **Nivel 2 + extensii ad-hoc** | `enrich.js:113-118` | → Nivel 3 (Maher) → Nivel 4 (Dixon-Coles) |
| Sample size | 10 meciuri | `enrich.js:432` | OK, dar fără separare H/A |
| Mediană | Simplă (egală) | `enrich.js:108-111` | → ponderată cu time decay |
| Temporal decay | ❌ ABSENT | nicio implementare | adaugă φ=0.0065 |
| Attack/Def Strength | ⚠️ aproximat prin standings blend | `enrich.js:776-790` | → normalizare explicită vs `league_stats.avg_home_goals` |
| Home Advantage | ❌ NU explicit | implicit prin form mixed | → γ=1.3 explicit |
| Dixon-Coles tau | ❌ ABSENT | `calc-utils.js:19-43` | adaugă corecție low-scoring |
| Cross-product perspective | ✅ COMPLET | `enrich.js:108-111` | OK |
| Dynamic live lambda | ✅ COMPLET | `enrich.js:94-102` | OK |

**Concluzie:** modelul actual e **solid pentru Nivel 2** (cross-product corect). Saltul către Nivel 3 (Maher) + temporal decay ar reduce Brier-ul cu estimat 10-20% (pe baza literaturii). Faza 4 calibrare din `ROADMAP_CALIBRARE.md` (~5 noiembrie 2026) e momentul potrivit pentru această reformă.
