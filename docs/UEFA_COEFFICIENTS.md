# Coeficienți UEFA de club — integrare (feat/uefa-coefficients)

Scop: coeficientul UEFA de club (forță pe 5 sezoane) ca măsură OBIECTIVĂ cross-ligă
pentru predicții pe meciuri europene (CL/EL/ECL), unde echipele vin din ligi diferite
(ex. Kauno Žalgiris LTU vs Drita Gjilan KOS).

## PAS 1 — Sursa datelor
- **API-Football: NU** oferă coeficienți UEFA de club (nu există `/coefficients`;
  doar `/standings` per ligă = clasament intern, nu forță cross-ligă).
- **Ales: kassiesa.net** — cel mai structurat/canonic (HTML static, istoric complet
  al tuturor cluburilor cu coeficient numeric). Fallback: footballseeding.com.
  uefa.com oficial e JS-heavy → evitat.
- ⚠ În sandbox-ul de dezvoltare, kassiesa/footballseeding/uefa.com/api-sports sunt
  **blocate de politica de egress (403)** — doar GitHub/registries sunt permise.
  Pe **VPS** (server normal) sunt accesibile → fetch-ul + popularea + validarea
  parserului se fac pe VPS (runbook mai jos). Structura HTML se confirmă cu `--dump`.

## PAS 2 — Stocare + mapare nume↔team_id
- Tabelă `uefa_club_coefficients` (vezi `scripts/create-tables.sql`): team_id
  (nullable, mapat), team_name (din sursă), country, coefficient, rank, season,
  match_score, updated_at. `UNIQUE(season, team_name)` → upsert idempotent.
- **Mapare** (`scripts/fetch-uefa-coefficients.js`): override manual → gate pe ȚARĂ
  → fuzzy `0.6·Dice(bigrame) + 0.4·Jaccard(tokeni)`. Praguri: **auto ≥0.62**,
  review 0.45–0.62, nemapat <0.45 (team_id NULL, dar rândul se păstrează cu score).
- **Dezambiguizare**: normalizarea elimină doar tokenii generici (fc/fk/cf/…), NU
  numele de ORAȘ → „Kauno Žalgiris" ↔ „Kauno Zalgiris" (Kaunas) se separă corect de
  „FK Žalgiris" (Vilnius). Verificat în test offline (Kaunas≠Vilnius, Drita→KF Drita).
- **Cazuri ambigue** → `scripts/uefa-name-overrides.json` (`"nume sursă": team_id`),
  completat după primul `--dry-run --report`.

## PAS 3 — Refresh automat
`scripts/setup-crontab.sh`: `0 7 * * 5` (vineri 07:00, după rundele Marți/Miercuri/Joi).
Aplicat la deploy — fără editare manuală crontab.

## PAS 4 — Integrare în predicție (2 opțiuni — DE DECIS, neimplementat)

### Opțiunea A — FEATURE ML (recomandat) ✅
Adaugă în `ml_features`: `home_uefa_coef`, `away_uefa_coef`, `uefa_coef_diff`
(+ eventual `uefa_coef_ratio`). Modelul învață singur ponderea.
- **Pro**: nu atinge NIMIC imutabil (Poisson/λ/NGP intacte); modelul decide dacă/cât
  contează; măsurabil before/after pe Brier (regula ML „o schimbare pe rând");
  degradare grațioasă (coef NULL → feature 0/median, modelul tratează absența).
- **Contra**: necesită backfill istoric (coef pe sezoanele trecute — kassiesa are
  istoric) + retrain; efect vizibil doar după antrenare.

### Opțiunea B — AJUSTARE POISSON directă
Boost pe λ pentru echipa cu coeficient mai mare (ex. `λ *= f(coef_diff)`).
- **Pro**: rapid, fără retrain, efect imediat pe meciurile europene.
- **Contra**: **atinge zona imutabilă** (λ/Poisson) — INTERZIS fără decizie separată
  (CLAUDE.md); brut (ponderea aleasă manual, necalibrată); risc de dublă-numărare cu
  team-strength existent (score7). Fragil pe echipe fără istoric european (coef 0).

### Recomandare
**A (feature ML)**. Respectă zidul imutabilelor, lasă modelul să calibreze forța
cross-ligă din date, e măsurabil temporal, și se pretează la scope-ul „doar meciuri
europene" (coef NULL pe restul → feature neutru). B ar trebui considerat doar dacă
se dorește un efect imediat ÎNAINTE de un retrain, și doar cu aprobare explicită pe
imutabile + calibrare pe Brier.

**Scope**: DOAR CL/EL/ECL. Echipe fără istoric european → coef NULL → fallback la
logica actuală (feature neutru în A; niciun boost în B).

## Runbook (VPS)
```
cd /root/scannerv2 && git pull
# 1) Creează tabela (dacă nu există) — idempotent:
psql "$POSTGRES_URL" -f scripts/create-tables.sql   # sau doar blocul uefa_club_coefficients
# 2) Calibrează parserul (vezi structura reală a paginii):
node scripts/fetch-uefa-coefficients.js --dump=20
# 3) Dry-run — parsare + mapare, FĂRĂ scriere, cu raport de review:
node scripts/fetch-uefa-coefficients.js --dry-run --report
#    (completează scripts/uefa-name-overrides.json pt cazurile „review"/nemapate)
# 4) Rulare reală (scrie DB):
node scripts/fetch-uefa-coefficients.js
```
### Verificare (SQL)
```
psql "$POSTGRES_URL" -c "SELECT COUNT(*) total, COUNT(team_id) mapate, COUNT(*)-COUNT(team_id) nemapate FROM uefa_club_coefficients;"
psql "$POSTGRES_URL" -c "SELECT rank, team_name, country, coefficient, team_id FROM uefa_club_coefficients ORDER BY coefficient DESC NULLS LAST LIMIT 20;"
psql "$POSTGRES_URL" -c "SELECT team_name, country, team_id, match_score FROM uefa_club_coefficients WHERE team_name ILIKE '%zalgiris%' OR team_name ILIKE '%drita%';"
```
