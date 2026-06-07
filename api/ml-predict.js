// api/ml-predict.js — inferență ML în Node.js din coeficienții Logistic Regression
// exportați de ml/train_model.py în ml/model_export.json. AFIȘARE SUPLIMENTARĂ:
// NU atinge scoring-ul (calcConfidence*/score1-7). Silent-fail dacă exportul lipsește.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_PATH = path.join(__dirname, '..', 'ml', 'model_export.json');

let _models;          // undefined = neîncărcat, null = lipsă, obiect = încărcat
let _loadedAt = 0;
const RELOAD_MS = 10 * 60 * 1000;   // recitește exportul la 10 min (re-antrenări)

function loadModels() {
  const now = Date.now();
  if (_models !== undefined && (now - _loadedAt) < RELOAD_MS) return _models;
  try {
    _models = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8'));
  } catch (_) {
    _models = null;   // export inexistent → ML indisponibil (tab-ul nu apare)
  }
  _loadedAt = now;
  return _models;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Construiește harta de features din payload-ul enrich + ELO (+ context live).
function buildFeatures(en, elo, lc) {
  en = en || {}; elo = elo || {}; lc = lc || {};
  const bd = en.breakdown || {};
  const lh = num(en.lambdaHome) || 0, la = num(en.lambdaAway) || 0;
  const homeElo = num(elo.home_elo), awayElo = num(elo.away_elo);
  const hht = (lc.homeHT != null ? lc.homeHT : lc.home_ht);
  const aht = (lc.awayHT != null ? lc.awayHT : lc.away_ht);
  const goalsHt = (num(hht) != null && num(aht) != null) ? num(hht) + num(aht) : null;
  const ls = lc.liveStats || lc;   // statistici live reale (din API) prioritar
  // Conștiență temporală + scor curent (acum ACTIVE ca features în model).
  const _el = num(lc.elapsed);
  const _elLive = _el != null && _el > 0;
  const _hgCur = num(lc.homeGoals), _agCur = num(lc.awayGoals);
  return {
    score1: num(bd.poisson), score2: num(bd.forma), score3: num(bd.h2h),
    score6: num(bd.consistenta), score7: num(bd.putereEchipe),
    home_win_prob: num(en.homeWin), draw_prob: num(en.draw), away_win_prob: num(en.awayWin),
    over15_prob: num(en.over15Prob), over25_prob: num(en.over25Prob), gg_prob: num(en.ggProb),
    lambda_home: lh, lambda_away: la, lambda_sum: lh + la, lambda_ratio: la > 0 ? lh / la : 1,
    home_elo: homeElo, away_elo: awayElo, elo_diff_ml: num(elo.elo_diff),
    home_win_prob_elo: num(elo.home_win_prob),
    elo_sum: (homeElo != null && awayElo != null) ? homeElo + awayElo : null,
    home_position_norm: num(en.homePositionNorm), away_position_norm: num(en.awayPositionNorm),
    confidence: num(en.confidenceScore),
    // HT / stats R1 (live la pauză/R2; pre-meci → null → neutralizate)
    home_ht: num(hht), away_ht: num(aht), goals_ht: goalsHt,
    shots_home: num(ls.shots_home), shots_away: num(ls.shots_away),
    shots_on_target_home: num(ls.shots_on_target_home), shots_on_target_away: num(ls.shots_on_target_away),
    corners_home: num(ls.corners_home), corners_away: num(ls.corners_away),
    possession_home: num(ls.possession_home), possession_away: num(ls.possession_away),
    // Conștiență temporală + scor curent (ACTIVE ca features — vezi FEATURES_PREMATCH).
    // Pre-meci (fără liveCtx): elapsed_norm=0, minutes_remaining=1, goals=0.
    // Live: elapsed/90, (90-elapsed)/90 (normalizat), scorul curent din liveCtx.
    elapsed_norm: _elLive ? Math.min(1, _el / 90) : 0,
    minutes_remaining: _elLive ? Math.max(0, (90 - _el) / 90) : 1,
    goals_home_current: _hgCur != null ? _hgCur : 0,
    goals_away_current: _agCur != null ? _agCur : 0,
    goal_diff_current: (_hgCur != null && _agCur != null) ? _hgCur - _agCur : 0,
  };
}

// Probabilitate LR pe features scalate (mean/scale din export). Feature lipsă →
// se substituie media (valoare standardizată 0 = neutră, fără efect).
function lrProb(model, feat) {
  const { features, lr_coef, lr_intercept, scaler_mean, scaler_scale } = model;
  if (!Array.isArray(features) || !Array.isArray(lr_coef) || !Array.isArray(scaler_mean) || !Array.isArray(scaler_scale)) return null;
  let logit = Number(lr_intercept) || 0;
  for (let i = 0; i < features.length; i++) {
    const mean = Number(scaler_mean[i]) || 0;
    let raw = feat[features[i]];
    if (raw == null || !Number.isFinite(raw)) raw = mean;   // neutru
    const sc = Number(scaler_scale[i]) || 1;
    logit += (Number(lr_coef[i]) || 0) * ((raw - mean) / (sc === 0 ? 1 : sc));
  }
  const p = 1 / (1 + Math.exp(-logit));
  return Math.round(Math.max(0, Math.min(100, p * 100)));
}

// enrichData = payload din enrich.js; eloData = {home_elo,away_elo,elo_diff,home_win_prob}
// liveCtx (opțional) = {elapsed,status,homeGoals,awayGoals,homeHT,awayHT,isLive,isHT,minutesRemaining}
export function predictAllMarkets(enrichData, eloData, liveCtx) {
  try {
    const models = loadModels();
    if (!models || typeof models !== 'object') return null;
    const lc = liveCtx || {};
    const feat = buildFeatures(enrichData, eloData, lc);
    const htAvailable = (lc.homeHT != null && lc.awayHT != null);

    const markets = {};
    let count = 0, bestBrier = null, trainedOn = null;
    for (const key of Object.keys(models)) {
      try {
        const m = models[key];
        const prob = lrProb(m, feat);
        if (prob == null) continue;
        markets[key] = {
          prob,
          desc: m.description || key,
          brierGb: m.brier_gb ?? null,
          brierActual: m.brier_actual ?? null,
          mlWins: m.ml_wins ?? null,
          nSamples: m.n_samples ?? null,
        };
        if (m.brier_gb != null && (bestBrier == null || m.brier_gb < bestBrier)) bestBrier = m.brier_gb;
        if (m.n_samples && (!trainedOn || m.n_samples > trainedOn)) trainedOn = m.n_samples;
        count++;
      } catch (_) { /* skip piață */ }
    }
    if (!count) return null;

    // ── Context live: marchează piețele deja decise (fulfilled / final R1) ──
    applyLiveContext(markets, lc);

    return { markets, htAvailable, bestBrier, trainedOn, live: !!lc.isLive, status: lc.status || 'NS', elapsed: num(lc.elapsed) || 0 };
  } catch (_) { return null; }
}

// Marchează piețele deja îndeplinite (scor curent) + rezultatele finale R1
// (când meciul e în repriza 2 sau pauză). Mutează `markets` in-place.
export function applyLiveContext(markets, lc) {
  if (!markets || !lc) return markets;
  const hg = num(lc.homeGoals) || 0, ag = num(lc.awayGoals) || 0;
  const tg = hg + ag;
  const setF = (k, cond) => { if (markets[k] && cond) { markets[k].prob = 100; markets[k].fulfilled = true; } };
  setF('over05_total', tg >= 1);
  setF('over15_total', tg >= 2);
  setF('over25_total', tg >= 3);
  setF('btts_total', hg > 0 && ag > 0);
  setF('over05_home', hg >= 1);
  setF('over05_away', ag >= 1);

  // R1 terminată (status 2H / HT) și avem scorul HT → marchează piețele HT ca FINALE.
  if ((lc.status === '2H' || lc.status === 'HT' || lc.status === 'ET') && lc.homeHT != null && lc.awayHT != null) {
    const hh = num(lc.homeHT) || 0, ah = num(lc.awayHT) || 0, thh = hh + ah;
    const setFinal = (k, cond) => {
      if (markets[k]) { markets[k].final = true; markets[k].fulfilled = !!cond; markets[k].prob = cond ? 100 : 0; }
    };
    setFinal('ht_over05', thh >= 1);
    setFinal('ht_over15', thh >= 2);
    setFinal('ht_over25', thh >= 3);
    setFinal('ht_btts', hh > 0 && ah > 0);
    setFinal('ht_home', hh >= 1);
    setFinal('ht_away', ah >= 1);

    // Piețe R2 deja îndeplinite (golurile din repriza 2 = curent − HT).
    const hr2 = Math.max(0, hg - hh), ar2 = Math.max(0, ag - ah), gr2 = hr2 + ar2;
    setF('r2_over05', gr2 >= 1);
    setF('r2_over15', gr2 >= 2);
    setF('r2_over25', gr2 >= 3);
    setF('r2_btts', hr2 > 0 && ar2 > 0);
    setF('r2_home', hr2 >= 1);
    setF('r2_away', ar2 >= 1);
  }
  return markets;
}
