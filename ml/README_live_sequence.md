# experiment_live_sequence.py — GRU „next goal în 10'" (EXPERIMENT)

Model secvențial (GRU + embeddings) care prezice, la fiecare minut T dintr-un meci live,
**următorul gol în (T, T+10']** pe 3 clase `{gazde înscriu, oaspeți înscriu, niciun gol}`.
E **doar cercetare** — NU înlocuiește heuristica Poisson live validată
(`api/utils/live-score.js`), NU atinge motorul de scoring/ML/crontab.

### v1 = FĂRĂ MOMENTUM (focalizat 2024-2026)
`live_stats` (momentum) acoperă <0.5% din backfill (712/154k) → **scos complet** la v1.
Feature-uri DINAMICE (12, toate din `match_events`): `minute, half2_flag, goalless_flag,
home_goals, away_goals, goal_diff, total_goals, min_since_last_goal, reds_home, reds_away,
subs_home, subs_away`. STATICE (4): `home_elo, away_elo, elo_diff, league_tier` +
embeddings învățate (echipă gazdă/oaspete/ligă).

- **POOL** = **BACKFILL**: `fixtures_history ∩ match_events(goluri)` cu rezultat final +
  season, focalizat pe sezoanele `2024,2025,2026` (`CONFIG.focus_seasons`).
  `elo_history`/`leagues.tier` = LEFT JOIN fallback (1500 / tier 3).
- **Baseline** = port fidel `calcNextGoalWindow(f,10)` din `live-score.js` (fără momentum →
  ramura form-fallback), recalculat pe aceleași stări de eval + colaps binar gol/niciun.
- **Split temporal**: TRAIN = 2024 + 2025, TEST = **2026** (`CONFIG.test_seasons=[2026]`);
  VAL = ultima felie temporală din train (≈ 2025 târziu) pt temperature scaling. Un fixture =
  un sezon ⇒ zero leakage. Encoders + scaler fit **doar pe train**.
- **Scală / RAM**: extract INCREMENTAL pe disc (memmap, NU ține tot în RAM — VPS 2GB),
  secvențe **float16**, puncte de decizie **rărite la pas 6'** (`minute_stride`).
  Estimat 2024-2026: **76,6k fixturi × 14 T ≈ 1,07M eșantioane ≈ ~0,83 GB** (țintă 0,5-1 GB).
  Pas 9' (`minute_stride=9`) → ~0,69M eșantioane ≈ ~0,55 GB.

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

Datasetul = **DIRECTOR** de `.npy` (X_seq fp16 prin memmap) + `meta.json`, NU `.npz`.

### 1) SMOKE pe VPS (dovadă cap-coadă, CPU, subset mic) — o singură linie fiecare
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --extract --limit 60 --seasons 2025 --out ml/live_seq_smoke
```
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --smoke --data ml/live_seq_smoke --ckpt ml/live_seq_smoke.pt --report ml/live_seq_smoke_eval.txt
```

### 2) EXTRACT 2024-2026 pe VPS — PE SEZOANE (RAM mic), apoi MERGE în ordine cronologică:
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --extract --seasons 2024 --out ml/live_seq_2024
```
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --extract --seasons 2025 --out ml/live_seq_2025
```
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --extract --seasons 2026 --out ml/live_seq_2026
```
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --merge --inputs ml/live_seq_2024 ml/live_seq_2025 ml/live_seq_2026 --out ml/live_seq_full
```
ORDINEA `--inputs` = cronologică (2024→2025→2026), ca train-ul să rămână ordonat temporal.
Urci pe Colab DOAR directorul `ml/live_seq_full/` — **fără DB**.

### 3) TRAIN + EVAL pe Colab GPU (sau orice mașină cu torch; device-agnostic cuda/cpu)
```
python3 ml/experiment_live_sequence.py --train --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```
`--train` face și eval la final. Re-evaluare separată dintr-un checkpoint:
```
python3 ml/experiment_live_sequence.py --eval --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```

## Ce salvează
- **director dataset** (`X_seq.npy` fp16 `[N,30,12]`, `X_len`, `X_static [N,4]`,
  `home_team_id/away_team_id/league_id`, `y` int8, `baseline [N,3]`, `season`, `fixture_id`,
  `minute`) + `meta.json` (config + feature names + distribuție clase + flag momentum).
- `*.pt` — model + temperatura + encoders (team/league→idx) + scaler (mean/std).
- `*_eval.txt` — tabel **Brier model vs baseline** (multiclass + binar) + reliability diagram.

## Parametri
Toți sus în `CONFIG` (`label_window_min=10`, `t_min/t_max`, `minute_stride=6`, `seq_cap=30`,
`focus_seasons=[2024,2025,2026]`, `test_seasons=[2026]`, `seq_dtype=float16`, embeddings,
GRU hidden/layers, epoci, lr, `min_team_freq` pt UNK).

## Dependență nouă (raportată explicit)
`torch` (NU era în stack-ul ML sklearn). Izolat în `/root/seqvenv` — **nu** atinge mediul
appului/PM2. `numpy`/`psycopg2-binary` există deja în `ml/requirements.txt`.
