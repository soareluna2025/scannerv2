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

### 2b) TRANSFER VPS → Colab (bundle dataset + script, fără auth) — o singură linie fiecare
Empachetează datasetul ȘI scriptul (Colab nu mai are nevoie de DB / git):
```
cd /root/scannerv2 && tar czf /tmp/live_seq_bundle.tgz -C /root/scannerv2 ml/live_seq_full ml/experiment_live_sequence.py && ls -lh /tmp/live_seq_bundle.tgz
```
Urcă pe un host public fără cont (dă un URL — match stats, fără secrete):
```
curl --upload-file /tmp/live_seq_bundle.tgz https://transfer.sh/live_seq_bundle.tgz ; echo
```
Pe Colab (sau prin notebook): `!wget -O bundle.tgz "<URL>" && tar xzf bundle.tgz`.

**Alternativă Google Drive (iPhone):** descarci `/tmp/live_seq_bundle.tgz` prin Termius/SFTP,
îl urci în Drive din Files, apoi în Colab `drive.mount(...)` + `!tar xzf .../live_seq_bundle.tgz`.

### 3) TRAIN + EVAL pe Colab GPU — notebook gata: `ml/colab_live_sequence.ipynb`
Deschide notebook-ul în Colab (Runtime → GPU), pune URL-ul de la `transfer.sh`, rulează celulele.
Sau direct (device cuda automat):
```
python3 ml/experiment_live_sequence.py --train --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```
`--train` face și eval la final (model vs base-rate + Poisson). Re-eval separat:
```
python3 ml/experiment_live_sequence.py --eval --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```

### 3b) MOD RAPID pe CPU (VPS 1-2 vCPU, fără GPU) — `--fast`
Corectitudinea rămâne identică (split temporal, temperature scaling, eval cu baseline-uri).
Defaults `--fast`: GRU hidden **64** / **1** strat (embeddings păstrate), batch **1024**,
**early stopping** pe val Brier (patience **2**, max **12** epoci, restaurează best model),
`torch.set_num_threads(toate core-urile)`. Scalerul e vectorizat pe chunk-uri (rapid).
Opțional `--train-sample` (subsample STRATIFICAT pe clasă×sezon; **testul 2026 rămâne ÎNTREG**).

Run rapid pe VPS (o singură linie; ~400k train stratificat):
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --train --fast --train-sample 400000 --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```
Tot setul de train (fără subsample), tot rapid:
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --train --fast --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```
Eval separat (rebuild-uiește automat modelul mic din checkpoint):
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --eval --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval.txt
```

### 4) BASELINE-uri în eval (setul fără momentum)
- **(a) base-rate marginal** din train — pragul minim absolut; modelul TREBUIE să-l bată.
- **(b) Poisson no-xG** — clasic, din golurile-de-până-acum + minutul curent (shrink Bayesian
  spre prior de fotbal 2.7 goluri/90), competing-Poisson → 3 clase. **Ținta reală de bătut.**
- **(c) OPȚIONAL, PE VPS** (are nevoie de `live_stats`): head-to-head vs heuristica REALĂ
  `calcNextGoalWindow(10)` cu xG live, doar pe sub-setul de test 2026 care are snapshot:
```
cd /root/scannerv2 && /root/seqvenv/bin/python ml/experiment_live_sequence.py --eval-livesubset --data ml/live_seq_full --ckpt ml/live_seq.pt --report ml/live_seq_eval_c.txt
```
Raportul scoate Brier **multiclass + binar** (colaps any-goal) + ECE + reliability, model vs fiecare baseline.

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
