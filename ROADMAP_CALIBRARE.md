# ROADMAP CALIBRARE GLOBALĂ — AlohaScan

> Acest fișier conține planul detaliat pentru extinderea calibrării empirice
> la TOATE locurile din aplicație. Citește acest fișier ÎNAINTE de a începe
> orice fază. Cifrele și datele sunt anchore — verifică starea curentă în
> Admin → Calibrare înainte de a aplica.

---

## CONTEXT

**De ce există acest plan**: modelul Poisson + calibrarea hardcoded inițială
sunt aplicate INCONSISTENT prin aplicație. În Top Opps vezi 84% Over 1.5
(calibrat), dar în card-ul Pre-meci vezi 76% pentru același meci/piață (raw).
Asta confuzeaza utilizatorul.

**Plan**: aplicăm calibrarea (g2Calibrate, liveCalibrate, NGP_CAL_REST)
peste tot, în 5 faze, cu trigger-uri bazate pe Brier scor și sample size.

**Strategia**: NU forțăm — așteptăm date suficiente să avem încredere în
calibrare. Auto-calibrarea (cron-uri săptămânale) îmbunătățește continuu
sample-ul fără intervenție umană.

---

## STARE LA DATA DE START (25 MAI 2026)

| Metric | Valoare |
|--------|---------|
| Predicții rezolvate | 573 |
| Brier Over 1.5 | 0.193 (⚠️ OK) |
| Brier GG | 0.253 (❌ slab) |
| Brier Over 2.5 | 0.260 (❌ slab) |
| LIVE buckets | 102 / 126 (81%) |
| Backfill complete | parțial — MLS Next Pro 70% |

---

## CALENDAR FAZE

### Faza 0 — Observare pasivă
- **Perioadă**: 25 mai → 20 iulie 2026 (~8 săptămâni)
- **Acțiune**: NICIUNA. Lasă cron-urile să acumuleze date.
- **Verificări săptămânale**: 8 iun, 22 iun, 6 iul, 20 iul
- **Target final**: sample 2000+, Brier Over 1.5 ≤ 0.16

### Faza 1 — NGP calibrat în LIVE card
- **Start estimat**: 20 iulie 2026
- **Trigger**: Brier ≤ 0.16 ȘI sample ≥ 2000 ȘI NGP_CAL_REST stabil
- **Frază magică user**: "Aplicăm Faza 1 — NGP calibrat în LIVE card"
- **Effort**: 1-2h cod
- **Risk**: scăzut
- **Impact**: VIZIBIL pe toate meciurile LIVE
- **Modificări concrete**:
  - `api/utils/live-score.js` → funcția `calcNextGoal()` aplică NGP_CAL_REST
  - Display: ceea ce afișează scanner-ul în card-ul LIVE → valoarea calibrată
  - Test pe Pre-meci: Top Opps vs LIVE list să fie consistent
- **Verificare succes**: 30 zile rulare fără regresii în Admin → Statistici Bilete

### Faza 2 — Pre-meci card list calibrat
- **Start estimat**: 20 august 2026
- **Trigger**: Brier ≤ 0.14 ȘI sample ≥ 3500 ȘI Faza 1 stabilă ≥ 30 zile
- **Frază magică user**: "Aplicăm Faza 2 — Pre-meci card calibrat"
- **Effort**: 2-3h cod
- **Risk**: mediu (afectează ranking implicit prin reorder)
- **Impact**: VIZIBIL pe toate pre-meciurile
- **Modificări concrete**:
  - `index.html` → funcția `renderPM()` aplică `g2Calibrate()` pe:
    - `ed.over15Prob` (Over 1.5)
    - `ed.ggProb` (GG)
    - `ed.homeWin`, `ed.draw`, `ed.awayWin` (1/X/2)
  - Inconsistența Top Opps 84% vs Card 76% se rezolvă

### Faza 3 — Detalii meci modal calibrate
- **Start estimat**: 25 septembrie 2026
- **Trigger**: Brier ≤ 0.13 ȘI sample ≥ 5000 ȘI Faza 2 stabilă ≥ 35 zile
- **Frază magică user**: "Aplicăm Faza 3 — Detalii meci calibrate"
- **Effort**: 3-4h cod (multe locuri în modal)
- **Risk**: mediu
- **Modificări concrete**:
  - `index.html` → `mdOpen()` și render-ul detalii (în jurul liniei 2280-2350)
  - Toate procentele din modal: Over 1.5, Over 2.5, GG, H/D/A, NGP, etc.
  - Recomandare bestBet recalculată cu cota calibrată
  - Adaugă etichete clare "calibrat (n=X)" vs "raw"

### Faza 4 — Confidence Score + EV global calibrate
- **Start estimat**: 5 noiembrie 2026
- **Trigger**: Brier ≤ 0.12 ȘI sample ≥ 7000 ȘI Faza 3 stabilă ≥ 40 zile
- **Frază magică user**: "Aplicăm Faza 4 — Confidence + EV global calibrat"
- **Effort**: 5-7h cod (CEL MAI COMPLEX)
- **Risk**: RIDICAT — afectează ranking principal + Safe Bets + Telegram alerts
- **PRECAUȚIE OBLIGATORIE**: backtest pe predicțiile vechi
  înainte de deploy. Compară Brier vechi vs nou.
- **Modificări concrete**:
  - `api/enrich.js` → `calcConfidence()` strat 1 (Poisson) calibrat
  - `api/enrich.js` → `calcEV()` folosește prob calibrată
  - Pragurile Safe Bets ajustate (confidence > 75 → confidence > 65 probabil)
  - `api/utils/live-score.js` → NGP alerts threshold ajustat

### Faza 5 — Smooth interpolation + confidence intervals
- **Start estimat**: 15 decembrie 2026
- **Trigger**: Toate fazele precedente stabile, Brier ≤ 0.11
- **Frază magică user**: "Aplicăm Faza 5 — Smooth interpolation"
- **Effort**: 4-5h cod
- **Risk**: scăzut (doar polish)
- **Modificări concrete**:
  - Funcție nouă `calibrateSmooth(prob, cat, sub, thr)` cu interpolare liniară
  - Elimină jump-urile la marginile bucket-urilor
  - Display: "76% (±3pp, n=420)" în loc de doar "76%"
  - Tooltip pe modal cu interval de încredere

---

## REGULI GENERALE

1. **Nu sări faze** — Faza 2 fără 30 zile de Faza 1 = risc de a nu identifica regresii
2. **Verifică Brier înainte** — dacă scorul a stagnat, investighează cauza
3. **Backtest la fiecare fază** după aplicare:
   - Compară ROI ÎNAINTE vs DUPĂ pe Bilete + ROI tab
   - Dacă ROI scade > 5% → rollback și investighează
4. **Sample size > Brier scor** — chiar dacă Brier e 0.12, dacă sample < 1000,
   nu te încrede orbește; folosește fallback la raw
5. **Documentează în SESSION_CONTEXT** după fiecare fază

---

## CUM SE FOLOSEȘTE ACEST FIȘIER

### User
- Spui: "Aplicăm Faza X" — eu citesc acest fișier și execut planul
- Spui: "Verificare Faza X" — eu confirm că trigger-urile sunt îndeplinite
- Spui: "Rollback Faza X" — eu revert la commit-ul ANTERIOR fazei

### Eu (Claude)
- La fiecare sesiune nouă unde se cere ceva legat de calibrare → citesc
- Trigger-urile (Brier, sample) se verifică prin GET /api/admin/calibration
- Înainte de a aplica → backup și branch claude/calibrare-faza-X

---

## CHECKLIST POST-FAZĂ

După fiecare fază aplicată, completează:

- [ ] Cod modificat conform planului
- [ ] Test sintaxă node --check + script tag check
- [ ] Commit pe main + push
- [ ] Deploy auto-confirmat (systemctl status)
- [ ] Screenshot Admin → Calibrare ÎNAINTE
- [ ] 7 zile de monitoring
- [ ] Screenshot Admin → Bilete & ROI DUPĂ
- [ ] Update SESSION_CONTEXT.txt cu rezultate
- [ ] Decide: continuă la următoarea fază sau așteaptă

---

## ROLLBACK PROCEDURE

Dacă o fază produce regresie:

```bash
cd scannerv2
git log --oneline -20    # găsește commit-ul ANTERIOR fazei
git revert <commit-faza-X>
git push origin main
# Auto-deploy reaplică versiunea veche
```

Sau pentru rollback rapid prin branch:
```bash
git checkout claude/pre-faza-X-backup
git push origin main --force-with-lease  # doar dacă user aprobă
```

---

## ULTIMA ACTUALIZARE: 25 mai 2026

Următorul checkpoint: **8 iunie 2026** — verificare progres Brier scor.
