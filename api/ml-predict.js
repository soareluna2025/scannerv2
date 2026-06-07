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

// Construiește harta de features din payload-ul enrich + ELO (+ HT/stats dacă există).
function buildFeatures(en, elo, ht) {
  en = en || {}; elo = elo || {}; ht = ht || {};
  const bd = en.breakdown || {};
  const lh = num(en.lambdaHome) || 0, la = num(en.lambdaAway) || 0;
  const homeElo = num(elo.home_elo), awayElo = num(elo.away_elo);
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
    // HT / stats R1 (doar live la pauză; pre-meci → null → neutralizate)
    home_ht: num(ht.home_ht), away_ht: num(ht.away_ht), goals_ht: num(ht.goals_ht),
    shots_home: num(ht.shots_home), shots_away: num(ht.shots_away),
    shots_on_target_home: num(ht.shots_on_target_home), shots_on_target_away: num(ht.shots_on_target_away),
    corners_home: num(ht.corners_home), corners_away: num(ht.corners_away),
    possession_home: num(ht.possession_home), possession_away: num(ht.possession_away),
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
// htData (opțional) = {home_ht,away_ht,goals_ht,shots_*,...} pentru piețele R2.
export function predictAllMarkets(enrichData, eloData, htData) {
  try {
    const models = loadModels();
    if (!models || typeof models !== 'object') return null;
    const feat = buildFeatures(enrichData, eloData, htData);
    const htAvailable = !!(htData && htData.home_ht != null && htData.away_ht != null);

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
    return { markets, htAvailable, bestBrier, trainedOn };
  } catch (_) { return null; }
}
