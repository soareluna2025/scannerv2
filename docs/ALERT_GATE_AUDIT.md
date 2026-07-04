# Audit poartă alertă — unificare pe `resolveThreshold` (fix/alert-gate-unification)

> Scop: verifică dacă vreo cale din `api/` decide o **alertă** / „peste prag" pe
> NGP / OVER15 / CONFIDENCE **fără** a trece prin `resolveThreshold()` (poarta
> adaptivă). Fiecare loc din grep are un verdict. Data audit: 04.07.2026.

Grep-uri rulate (toate în `api/ --include=*.js`):
`score_at_alert`, `outcome_ngp`, `ngpAlertScore`, `threshold_used`,
`resolveThreshold`, `> 70`, `>= 70`.

---

## 1. Punctul 1 din misiune — `collect-daily.js` NU are poartă de alertă

**Premisa misiunii** era că `collect-daily` „ocolește adaptive threshold" și scrie
`score_at_alert`/`outcome_ngp` sub prag. **La nivel de cod, premisa NU se confirmă.**

Grep pe `api/cron/collect-daily.js` pentru
`score_at_alert | outcome_ngp | ngpAlert | > 70 | >= 70 | resolveThreshold | threshold`
→ **0 potriviri**. `collect-daily.js` este un **pur writer de predicții**
(`INSERT INTO predictions ...` cu `source='collect-daily'`), setând DOAR:
`lambda_home/away/total`, `over15/25/gg_prob`, `home/draw/away_win_prob`.
**Nu decide nicio alertă și nu atinge `score_at_alert`/`outcome_ngp`.**

**De unde vine atunci `score_at_alert` pe rândurile `source='collect-daily'`?**
Din `scanner.js:699` — `INSERT INTO predictions ... ON CONFLICT (fixture_id) DO UPDATE`.
Cheia e `fixture_id`: când scanner-ul live ridică o alertă NGP pe un fixture pe care
`collect-daily` l-a inserat deja, `ON CONFLICT` **ștampilează** `score_at_alert` +
`outcome_ngp='PENDING'` peste rândul existent. Deci ștampila vine de la scanner, iar
**scanner-ul e deja gated adaptiv** (`scanner.js:694` — `if (ng > _ngThr ...)`, cu
`_ngThr` din `resolveThreshold` la `:670`).

**Concluzie punct 1: NO-OP justificat.** A forța o poartă `resolveThreshold` în
`collect-daily` ar fi cod mort (nu există decizie de alertă acolo). Singurul writer de
`score_at_alert` este `scanner.js:699`, deja sub poarta adaptivă. Conform regulii
„NU LUCRA ORB", nu s-a fabricat o poartă fantomă.

---

## 2. Punctul 2 din misiune — `logPrediction` din scanner (REZOLVAT)

`scanner.js` — blocul `logPrediction` (`:713-740`) este **în interiorul** porții
adaptive (`if (ng > _ngThr || mk.over15 > _o15Thr)` la `:672`). Singura problemă:
câmpul `threshold_used` era **`70` hardcodat**, deci `prediction_log` raporta un prag
fals când poarta adaptivă folosea alt prag (ex. liga 929, prag 95).

**Fix aplicat** (`scanner.js:737`):
```js
// înainte:
threshold_used: 70,
// după:
threshold_used: Math.round(_logModule === 'NGP' ? _ngThr : _o15Thr),
```
`_ngThr`/`_o15Thr` sunt pragurile REALE rezolvate la `:670-671`. Acum
`prediction_log.threshold_used` reflectă exact pragul care a decis alerta.
Zero schimbare de business în afara acestui câmp; poarta însăși era deja unificată.

---

## 3. Inventar side-door (toate locurile cu verdict)

| Locație | Ce face | Verdict |
|---|---|---|
| `scanner.js:670-671` | `resolveThreshold('NGP'/'OVER15', ...)` | **UNIFICAT** — poarta canonică |
| `scanner.js:672` | `if (ng > _ngThr \|\| mk.over15 > _o15Thr)` | **UNIFICAT** — decizia de alertă pe praguri adaptive |
| `scanner.js:694` | `if (ng > _ngThr && !ngpAlertScore)` — gate INSERT `score_at_alert` | **UNIFICAT** — sub `_ngThr` adaptiv |
| `scanner.js:699-707` | INSERT/ON CONFLICT `score_at_alert`/`outcome_ngp` | **UNIFICAT** — singurul writer, sub poarta de la `:694` |
| `scanner.js:737` | `threshold_used` în `logPrediction` | **REZOLVAT** (punct 2) — prag real |
| `scanner.js:414-445` | `resolveNGPOutcomes` — UPDATE `outcome_ngp` WIN/LOSS | **Legitim** — rezolvare rezultat post-alertă (gol după alertă), NU o poartă de prag |
| `generator.js:322-343` | „Ponturile Zilei": OFF→query static `(70,70)`; SHADOW→log divergență, păstrează static; ON→`getAdaptiveThreshold` per rând | **UNIFICAT** — rutare adaptivă flag-gated |
| `enrich.js:2065` | `logPrediction OVER15 threshold_used:65` | **Legitim / out-of-scope** — logging EXHAUSTIV prematch (nu decizie de alertă); vezi nota ▼ |
| `enrich.js:2083` | `logPrediction GG threshold_used:60` | **Legitim / out-of-scope** — idem (GG oricum exclus din `ELIGIBLE_MODULES`) |
| `enrich.js:2094` | `logPrediction CONFIDENCE threshold_used:70` | **Legitim / out-of-scope** — idem |
| `enrich.js:1737` | `else if (topScore > 70) injuryPenalty=10` | **Legitim** — prag de penalizare accidentări, fără legătură cu alerte |
| `admin.js:867` | `AND p.over15_prob >= 70` (query raport) | **Legitim** — metrică de raportare, nu poartă de alertă |
| `admin.js:905` | `else if (winRate >= 70)` (sugestie text) | **Legitim** — etichetă UI |
| `model-accuracy.js:35,94` | `WHEN confidence >= 70 THEN 'mid'` | **Legitim** — bucketing pt raport acuratețe |
| `adaptive-threshold.js:36,43` | `AND weight_value > 70` (RAISE-ONLY) | **Legitim** — chiar motorul adaptiv (garda „doar ridicări") |
| `live-score.js:83,103,121` | `mn >= 70 → remXg *= 1.2` etc. | **Imutabil** — boost pe minut în formula NGP, NU prag de alertă |
| `ngp-calibration.js:63` | `(mn >= 70) ? 1.2` | **Imutabil** — idem, internă formulă NGP |
| `log-prediction.js:10,28` | INSERT `threshold_used` (persistă valoarea primită) | **Legitim** — sink pasiv; valoarea vine de la apelant |

**Concluzie punct 3:** singura poartă de **alertă** live pe NGP/OVER15 este în
`scanner.js` și e complet unificată pe `resolveThreshold`. `generator.js` (Ponturile
Zilei, prematch) e la fel unificat pe `getAdaptiveThreshold`. Restul potrivirilor sunt
rapoarte, metrici, rezolvare de rezultat, sau internele formulei NGP — niciuna nu decide
o alertă.

### Notă — `enrich.js` `threshold_used` static (65/60/70)
`enrich.js` loghează în `prediction_log` **fiecare** meci îmbogățit (nu doar cele „peste
prag") — e material de calibrare pentru self-learning, NU o decizie de alertă. `threshold_used`
acolo e o **etichetă de referință statică** a modulului (baseline), iar `learning-analysis`
compară `predicted_value` vs rezultat indiferent de ea. Nu e un side-door de alertă.
Aliniera lui la `resolveThreshold` (care ar necesita `fixture_id`+`predicted_value` per apel)
ar schimba semantica loggingului prematch → **în afara scopului** acestei misiuni
(„zero schimbări business în afara porții"). Semnalat aici pentru o decizie viitoare, dacă
se dorește ca eticheta prematch să reflecte și ea pragul adaptiv.

---

## 4. Test mock — `resolveThreshold`

Rulat cu o reimplementare fidelă a `resolveThreshold` (fără DB), 3 scenarii:

| Scenariu | Input | Rezultat | Verdict |
|---|---|---|---|
| ON, prag adaptiv 95, OVER15 pred 71 | `resolveThreshold('OVER15', 929, 70, 71)` cu adaptiv=95 | prag=95 → `71 > 95` = **false** | ✅ nu marchează la 71 (respins corect) |
| OFF (default) | `resolveThreshold(..., 70, 71)` mode=OFF | prag=**70**, zero query | ✅ byte-identic cu azi |
| ON, adaptiv null (fallback) | `resolveThreshold('NGP', L, 70, x)` adaptiv=null | prag=**70** | ✅ fallback static legitim |

`node --check api/cron/scanner.js` → OK. Comportamentul cu `ADAPTIVE_THRESHOLD=OFF`
rămâne identic (poarta cade pe 70 static, fără interogări).
