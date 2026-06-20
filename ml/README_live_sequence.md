# experiment_live_sequence.py — GRU „next goal în 10'" (EXPERIMENT)

Model secvențial (GRU + embeddings) care prezice, la fiecare minut T dintr-un meci live,
**următorul gol în (T, T+10']** pe 3 clase `{gazde înscriu, oaspeți înscriu, niciun gol}`.
E **doar cercetare** — NU înlocuiește heuristica Poisson live validată
(`api/utils/live-score.js`), NU atinge motorul de scoring/ML/crontab.

- **Baseline** = portul fidel al `calcNextGoalWindow(f, 10)` din `live-score.js`, recalculat
  pe exact aceleași stări de eval (apples-to-apples), plus colaps binar „gol vs niciun gol".
- **Date** (toate reale, ZERO cote — respectă zidul anti-cote):
  POOL-ul = **BACKFILL**: `fixtures_history ∩ match_events(goluri)` (NU `fixtures`, care
  are doar ~2508 rânduri live/recent → ar da max 27). `match_events`
  (goluri/cartonașe/schimbări → scor-în-timp + etichete), `elo_history`/`leagues.tier` =
  LEFT JOIN cu fallback (1500 / tier 3).
  `live_stats` (xG/șuturi/SOT/atacuri periculoase/posesie/cornere) = **momentum OPȚIONAL**
  (LEFT JOIN, NULL-safe — NU mai e filtru; doar ~921 fixturi îl au).
- **Anti-leakage**: split pe **sezon** (vechi=train, recent=test); un fixture e într-un singur
  sezon ⇒ niciodată în ambele split-uri. Encoders + scaler fit **doar pe train**. Temperature
  scaling pe ultima felie temporală din train.

## Fluxul: EXTRACT pe VPS → TRAIN pe Colab GPU → EVAL

### 0) Venv izolat pe VPS (torch CPU) — o singură dată
```
python3 -m venv /root/seqvenv && /root/seqvenv/bin/pip install -U pip numpy psycopg2-binary && /root/seqvenv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
```

### 0b) NUMĂRUL REAL al pool-ului (fără dataset/torch, doar psycopg2) — o singură linie
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --count
```
(Scoate: fixturi eligibile pe backfill, ~eșantioane, distribuție pe sezon, câte au momentum/elo.)

### 1) SMOKE pe VPS (dovadă cap-coadă, CPU, subset mic) — o singură linie fiecare
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --extract --limit 60 --out ml/live_seq_smoke.npz
```
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --smoke --data ml/live_seq_smoke.npz --ckpt ml/live_seq_smoke.pt --report ml/live_seq_smoke_eval.txt
```

### 2) EXTRACT complet pe VPS (pt Colab). Dacă RAM-ul (2GB) e strâns, extrage pe sezoane + merge:
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --extract --seasons 2023,2024 --out ml/live_seq_2324.npz
```
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --extract --seasons 2025,2026 --out ml/live_seq_2526.npz
```
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --merge --inputs ml/live_seq_2324.npz ml/live_seq_2526.npz --out ml/live_seq_full.npz
```
(Sau, dacă încape, un singur `--extract --out ml/live_seq_full.npz` fără `--seasons`.)
Urci pe Colab DOAR `ml/live_seq_full.npz` (+ `_meta.json`) — **fără DB**.

### 3) TRAIN + EVAL pe Colab GPU (sau pe orice mașină cu torch; device-agnostic cuda/cpu)
```
python3 ml/experiment_live_sequence.py --train --data ml/live_seq_full.npz --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```
`--train` face și eval la final. Pt re-evaluare separată dintr-un checkpoint:
```
python3 ml/experiment_live_sequence.py --eval --data ml/live_seq_full.npz --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```

## Ce salvează
- `*.npz` — dataset portabil: `X_seq [N,seq_cap,31]`, `X_len`, `X_static [N,4]`,
  `home_team_id/away_team_id/league_id`, `y`, `baseline [N,3]`, `season`, `fixture_id`, `minute`.
- `*_meta.json` — config + numele feature-urilor + distribuția claselor.
- `*.pt` — model + temperatura + encoders (team/league→idx) + scaler (mean/std).
- `*_eval.txt` — tabel **Brier model vs baseline** (multiclass + binar) + reliability diagram.

## Parametri
Toți sus în `CONFIG` (fereastră 10', `t_min/t_max/minute_stride`, `seq_cap=30`, dim embeddings,
GRU hidden/layers, epoci, lr, `min_team_freq` pt UNK, `test_seasons`/`test_frac` pt split).

## Dependență nouă (raportată explicit)
`torch` (NU era în stack-ul ML sklearn). Izolat în `/root/seqvenv` — **nu** atinge mediul
appului/PM2. `numpy`/`psycopg2-binary` există deja în `ml/requirements.txt`.
