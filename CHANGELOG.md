# CHANGELOG — AlohaScan Scanner V2

> Istoric de decizii, sprint-uri și sesiuni. Mutat din `CLAUDE.md` (constituția conține
> doar reguli vii + pointeri). Vezi și `SESSION_CONTEXT.txt` pentru jurnalul detaliat.

---

## 2026-06-11 — CLAUDE.md V2 (constituție de reguli vii)
- Rescris `CLAUDE.md` ca regulament scurt (≤250 linii): reguli + pointeri, istoria mutată aici.
- **Kelly Criterion ELIMINAT** complet din aplicație — nu mai există staking automat
  (`min(bankroll*edge*0.5, bankroll*0.04)`). EV rămâne doar ca semnal de valoare.
  (Verificat: zero referințe `kelly` în `api/` și `index.html`.)
- Adăugate secțiuni noi de reguli: „REGULI DE LIVRARE ȘI MEDIU" și „REGULI ML (permanente)"
  (ZIDUL ANTI-COTE, antrenări memory-safe pe VPS 2GB, excludere youth/feminin/amicale,
  o schimbare ML pe rând măsurată before/after pe Brier out-of-sample).
- Corecții față de realitatea codului (sursa adevărului = codul):
  - **`STOP_AT` eliminat** (FIX2 în `api/backfill.js`): backfill se oprește DOAR la comanda
    STOP sau la finalizarea naturală. `API_PLAN_LIMIT = 300_000` e folosit DOAR pentru afișare.
    Regula veche „STOP_AT = 280.000" era moartă și a fost ștearsă.
  - **`api/cron/scan.js` este VIU** (371 linii, înregistrat în `cronFiles` din `server.js`,
    tunat recent — commit `f59416d`). Premisa „endpoint șters în 11.06" era falsă; referința
    a fost păstrată și corectată în tabelul de surse.
  - Tabelul static „Cron Jobs (VPS crontab)" înlocuit cu regula: crontab gestionat MANUAL
    de Vlad; referință `scripts/run-cron.sh` + panoul admin „STATUS CRON-URI"; nu se modifică
    crontab-ul (doar propuneri). (`scripts/setup-crontab.sh` din task NU există în repo.)
  - „36 tabele" → „44+ tabele"; schema reală: `scripts/create-tables.sql`
    (`docs/SCHEMA.md` planificată, încă necreată).
  - Tabelul vechi de greutăți Confidence (25/20/15…) înlocuit cu greutățile SFINTE actuale:
    score1 Poisson .30 · score2 Formă .25 · score7 Putere .25 · score3 H2H .15 ·
    score6 Convergență .05; score4 = live-only.
  - Eliminată contradicția de branch din Workflow („lucrează pe branch claude/…"): regula
    unică e acum livrare DIRECT pe MAIN (branch doar la cerere explicită; pe VPS, în acel caz,
    EXCLUSIV `git checkout origin/<branch> -- <fișier>`, niciodată comutare de branch).

---

## Mai 2026 — Sprint-uri completate

### Sprint 4A — Shrinkage Bayesian în calcPoisson (commit 96f70e7)
`N_SHRINK = 5`. Când echipa are puține meciuri, lambda se blendează cu media reală a ligii
din `league_stats`. Zero valori hardcodate.

### Sprint 4B — Calibrare per-profil ligă (commit 7cee89c)
`calibration_tables` are PK compus (`module`, `league_group`). Grupuri: low (<2.3 goluri/meci),
mid (2.3-3.0), high (>3.0). Minimum 500 predicții per grup pentru calibrare proprie.

### Sprint 4C — g2Score folosește predictions ca rawScore (commit 14cef08)
Frontend `g2Score()` folosește `over15_prob`/`over25_prob`/`gg_prob` din tabela `predictions`
în loc să recalculeze din form data. Fallback la calculul vechi dacă predictions lipsesc.

### Sprint 4D — Clamp scoruri extreme în calcPoisson (commit 4e0dc81)
Meciuri cu total goluri > 5 sunt clampate proporțional la 5 (ex: 0-6 → 0-5.0). Elimină
outlier inflation.

### Sprint Live — getLiveStatsFromDB() real (commit 4d81457)
Citește din `live_stats`: elapsed, xg, sot, da, ngp_home, ngp_away.
`score4 = intensity*0.6 + NGP*0.4`, cu decay după minutul 75. Pre-meci neafectat
(gated pe `elapsedNum > 0`).

### Whitelist cleanup (commit e429e9c + 51bdd78)
19 ID-uri greșite eliminate. Romania fixat: 283/284/285. Serbia: 286/287. Indonesia: 274.
Regula: maxim Liga 1 + Liga 2 + Cupă per țară, zero tier 3+.
