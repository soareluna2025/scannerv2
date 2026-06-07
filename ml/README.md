# AlohaScan — ML training

Antrenează un model ML (Logistic Regression + Gradient Boosting) pe predicțiile
istorice din tabela `predictions` (features score1-7 + ELO + poziție clasament +
probabilități, labels rezolvate), pentru piața **Home Win**. Raportează Brier vs
modelul actual și exportă coeficienții LR ca JSON pentru consum în Node.js.

## Cerințe de date
Tabela `predictions` trebuie să aibă rânduri cu:
- `result_winner IS NOT NULL` (predicții rezolvate)
- `home_elo IS NOT NULL` (rulează întâi `build-elo` + `backfill-ml-features.sql`)
- `score1/score2 IS NOT NULL`

Recomandat minim **2000+** predicții complete pentru un model util.

## Securitate — conexiune DB din mediu (FĂRĂ parolă în cod)
Setează una dintre variante înainte de rulare:

```bash
export POSTGRES_URL="postgresql://alohascan:PAROLA@127.0.0.1:5432/elefant"
# SAU
export PGUSER=alohascan PGDATABASE=elefant PGHOST=127.0.0.1 PGPASSWORD=PAROLA
```

> Nu pune parola în fișiere comise în repo. Scriptul o citește din mediu.

## Rulare

```bash
pip install -r ml/requirements.txt
python ml/train_model.py
```

## Output (în `ml/`, neversionat)
- `model_lr_win.pkl` — Logistic Regression
- `model_gb_win.pkl` — Gradient Boosting
- `scaler_win.pkl` — StandardScaler
- `model_weights.json` — coeficienți LR + scaler mean/scale + Brier scores
  (pentru a aplica modelul direct în Node.js fără Python)

## Note
- `sample_weight = exp(-0.001 * days_old)` — predicțiile recente cântăresc mai mult.
- Compară `brier_lr` / `brier_gb` cu `brier_actual` (modelul curent `home_win_prob`):
  ML aduce valoare DOAR dacă Brier-ul scade.
- Modelul NU intră automat în scoring — exportul JSON e pentru integrare ulterioară
  (sesiune dedicată, post-scoring, fără a atinge `score1-7` / `calcConfidence*`).
