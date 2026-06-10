// api/ml-predict.js — inferență ML în Node.js din coeficienții Logistic Regression
// exportați de ml/train_model.py în ml/model_export.json. AFIȘARE SUPLIMENTARĂ:
// NU atinge scoring-ul (calcConfidence*/score1-7). Silent-fail dacă exportul lipsește.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_PATH = path.join(__dirname, '..', 'ml', 'model_export.json');
const LIVE_MODEL_PATH = path.join(__dirname, '..', 'ml', 'model_live_export.json');

let _models;          // undefined = neîncărcat, null = lipsă, obiect = încărcat
let _loadedAt = 0;
const RELOAD_MS = 10 * 60 * 1000;   // recitește exportul la 10 min (re-antrenări)

let _liveModel = null;   // null = lipsă/neîncărcat, obiect = încărcat
let _liveModelTs = 0;    // mtimeMs al fișierului încărcat
let _liveCheckedAt = 0;  // ultima verificare (throttle la RELOAD_MS)

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

// Modelul LIVE (model_live_export.json). Reîncărcare pe mtime, throttle RELOAD_MS.
// Silent-fail: fișier lipsă → null → integrarea live e dezactivată complet.
function loadLiveModel() {
  const now = Date.now();
  if (now - _liveCheckedAt < RELOAD_MS) return _liveModel;
  _liveCheckedAt = now;
  try {
    const mt = fs.statSync(LIVE_MODEL_PATH).mtimeMs;
    if (mt !== _liveModelTs) {                    // fișierul s-a schimbat → reîncarcă
      _liveModel = JSON.parse(fs.readFileSync(LIVE_MODEL_PATH, 'utf8'));
      _liveModelTs = mt;
    }
  } catch (_) {
    _liveModel = null;   // export inexistent → live ML indisponibil
    _liveModelTs = 0;
  }
  return _liveModel;
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
    // Medii istorice (match_stats) + arbitru — enrich.js le va furniza; lipsă
    // (null/undefined) → lrProb substituie scaler_mean (contribuție 0 = base
    // rate). NU pune default-uri hardcodate aici: ele ≠ scaler_mean și ar
    // împinge greșit logit-ul pe echipe fără date istorice.
    home_sot_avg: en.homeSotAvg,
    away_sot_avg: en.awaySotAvg,
    home_corners_avg: en.homeCornersAvg,
    away_corners_avg: en.awayCornersAvg,
    home_xg_avg: en.homeXgAvg,
    away_xg_avg: en.awayXgAvg,
    home_yc_avg: en.homeYcAvg,
    away_yc_avg: en.awayYcAvg,
    home_rc_avg: en.homeRcAvg,
    away_rc_avg: en.awayRcAvg,
    home_fouls_avg: en.homeFoulsAvg,
    away_fouls_avg: en.awayFoulsAvg,
    ref_pct_over25: en.refPctOver25,
    ref_style_open: en.refStyleOpen,
    // Features noi (rolling 100): insidebox/posesie medii + goluri R1/R2 + substituiri.
    home_insidebox_avg: en.homeInsideboxAvg,
    away_insidebox_avg: en.awayInsideboxAvg,
    home_possession_avg: en.homePossessionAvg,
    away_possession_avg: en.awayPossessionAvg,
    home_goals_r1_avg: en.homeGoalsR1Avg,
    away_goals_r1_avg: en.awayGoalsR1Avg,
    home_goals_r2_avg: en.homeGoalsR2Avg,
    away_goals_r2_avg: en.awayGoalsR2Avg,
    home_subs_avg: en.homeSubsAvg,
    away_subs_avg: en.awaySubsAvg,
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

// Softmax multinomial pentru modelele LIVE v2 cu 3 clase (result_r1/result_final/
// next_goal_r1/next_goal_r2). model.lr_coef = matrice (n_clase × n_feat),
// lr_intercept = vector (n_clase), classes = etichete. Feature lipsă/NaN →
// scaler_mean (z=0, neutru) — exact ca lrProb. Întoarce { [clasă]: prob_int }
// (0-100, sumă ≈ 100). NU modifică lrProb existent.
function lrProbMulti(model, feat) {
  const { features, lr_coef, lr_intercept, scaler_mean, scaler_scale, classes } = model;
  if (!Array.isArray(features) || !Array.isArray(lr_coef) || !Array.isArray(classes)) return null;
  if (!Array.isArray(scaler_mean) || !Array.isArray(scaler_scale) || !classes.length) return null;
  // standardizează vectorul o singură dată (împărtășit între clase)
  const z = new Array(features.length);
  for (let i = 0; i < features.length; i++) {
    const mean = Number(scaler_mean[i]) || 0;
    let raw = feat[features[i]];
    if (raw == null || !Number.isFinite(raw)) raw = mean;   // neutru
    const sc = Number(scaler_scale[i]) || 1;
    z[i] = (raw - mean) / (sc === 0 ? 1 : sc);
  }
  const logits = new Array(classes.length);
  for (let c = 0; c < classes.length; c++) {
    const coefRow = Array.isArray(lr_coef[c]) ? lr_coef[c] : [];
    let lg = Number(Array.isArray(lr_intercept) ? lr_intercept[c] : lr_intercept) || 0;
    for (let i = 0; i < features.length; i++) lg += (Number(coefRow[i]) || 0) * z[i];
    logits[c] = lg;
  }
  const mx = Math.max(...logits);          // softmax stabil numeric
  let sum = 0;
  const exps = logits.map((l) => { const e = Math.exp(l - mx); sum += e; return e; });
  const out = {};
  for (let c = 0; c < classes.length; c++) out[classes[c]] = Math.round((exps[c] / (sum || 1)) * 100);
  return out;
}

// Vectorul de 31 features pentru modelele LIVE — ORDINE IDENTICĂ cu
// ml/train_live.py FEATURES. ELO: enrichData prioritar, fallback la eloData.
function buildLiveFeatures(en, lc, elo) {
  en = en || {}; lc = lc || {}; elo = elo || {};
  const bd = en.breakdown || {};
  const ls = lc.liveStats || {};
  const f = {};
  f.minute = lc.elapsed || 0;
  f.predicted_value = en.over15Prob || 50;
  f.ngp_value = en.ngp || 50;
  f.layer1_score = bd.poisson || 50;
  f.layer2_score = bd.forma || 50;
  f.layer3_score = bd.h2h || 50;
  f.layer4_score = bd.live || 0;
  f.layer5_score = 0;
  f.layer6_score = bd.consistenta || 50;
  f.layer7_score = bd.putereEchipe || 50;
  f.lambda_home = en.lambdaHome || 1.5;
  f.lambda_away = en.lambdaAway || 1.2;
  f.home_goals = lc.homeGoals || 0;
  f.away_goals = lc.awayGoals || 0;
  f.home_sot = ls.shots_on_target_home || 0;
  f.away_sot = ls.shots_on_target_away || 0;
  f.home_shots = ls.shots_home || 0;
  f.away_shots = ls.shots_away || 0;
  f.home_possession = ls.possession_home || 50;
  f.away_possession = ls.possession_away || 50;
  f.home_corners = ls.corners_home || 0;
  f.away_corners = ls.corners_away || 0;
  f.home_da = 0;
  f.away_da = 0;
  f.home_elo = en.homeElo || elo.home_elo || 1500;
  f.away_elo = en.awayElo || elo.away_elo || 1500;
  f.elo_diff_ml = en.eloDiffUsed || elo.elo_diff || 0;
  f.elapsed_norm = (lc.elapsed || 0) / 90;
  f.minutes_remaining = Math.max(0, 90 - (lc.elapsed || 0)) / 90;
  f.goal_diff = (lc.homeGoals || 0) - (lc.awayGoals || 0);
  f.total_goals_now = (lc.homeGoals || 0) + (lc.awayGoals || 0);
  return f;
}

// Mapare model live → cheie de piață afișată în UI.
const LIVE_MARKET_MAP = [
  ['live_ngp',    'live_any_goal',       'Mai cad goluri?'],
  ['live_over15', 'live_over15_updated', 'Over 1.5 se întâmplă?'],
];

// Rulează modelele LIVE — DOAR în repriză (status 1H/2H). Altfel / lipsă model → {}.
function predictLiveMarkets(enrichData, liveCtx, eloData) {
  try {
    const lc = liveCtx || {};
    if (!liveCtx || (lc.status !== '1H' && lc.status !== '2H')) return {};
    const lm = loadLiveModel();
    if (!lm || typeof lm !== 'object') return {};
    const feat = buildLiveFeatures(enrichData, lc, eloData);
    const out = {};
    for (const [srcKey, mktKey, desc] of LIVE_MARKET_MAP) {
      const m = lm[srcKey];
      if (!m) continue;                       // model lipsă din export → skip silențios
      const prob = lrProb(m, feat);
      if (prob == null) continue;
      out[mktKey] = { prob, desc, live: true, brierLr: m.brier_lr ?? null, nSamples: m.n_samples ?? null };
    }
    return out;
  } catch (_) { return {}; }
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

    // ── Modele LIVE (model_live_export.json) — doar în repriză (1H/2H) ──
    if (liveCtx && (lc.status === '1H' || lc.status === '2H')) {
      const liveMk = predictLiveMarkets(enrichData, lc, eloData);
      Object.assign(markets, liveMk);
      const lo = liveMk.live_over15_updated;
      if (lo && lo.prob != null) {
        // Suprascrie over0.5/1.5 ale reprizei curente cu predicția live actualizată,
        // dar NU peste piețele deja decise (fulfilled/final = fapt).
        const over = (k) => { const mk = markets[k]; if (mk && !mk.fulfilled && !mk.final) mk.prob = lo.prob; };
        if (lc.status === '1H') { over('ht_over05'); over('ht_over15'); }
        else if (lc.status === '2H') { over('r2_over05'); over('r2_over15'); }
      }
    }

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

// ════════════════════════════════════════════════════════════════════════════
//  MODEL LIVE v2 (ml/train_live_v2.py → ml/model_live_export.json) — SEPARAT.
//  Integrare ADITIVĂ: NU atinge buildFeatures/lrProb/predictAllMarkets, NU
//  atinge buildLiveFeatures/predictLiveMarkets (v1) de mai sus. Funcții noi cu
//  sufix V2 ca să nu suprascrie nimic existent. Refolosește lrProb + lrProbMulti.
// ════════════════════════════════════════════════════════════════════════════

// Cele 41 features din ml/train_live_v2.py FEATURES — nume + ORDINE IDENTICE
// (16 base din liveState + 25 pre-meci din payload enrich `en` și ELO `elo`).
// liveState = { elapsed, home_goals, away_goals, home_yc, away_yc, home_rc,
//   away_rc, home_subs, away_subs }. Cele 25 pre-meci: lipsă → null → înlocuite
// cu mediana din export (vezi predictLiveMarketsV2). Ordinea = contract cu training.
function buildLiveFeaturesV2(liveState, en, elo) {
  const s = liveState || {}; en = en || {}; elo = elo || {};
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const nn = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const elapsed = n(s.elapsed);
  const hg = n(s.home_goals), ag = n(s.away_goals);
  const hyc = n(s.home_yc), ayc = n(s.away_yc);
  const hrc = n(s.home_rc), arc = n(s.away_rc);
  const hsub = n(s.home_subs), asub = n(s.away_subs);
  return {
    // ── 16 base (din snapshot live) ──
    elapsed_norm: Math.min(1, elapsed / 90),
    is_r2: elapsed > 45 ? 1 : 0,
    home_goals_now: hg,
    away_goals_now: ag,
    goal_diff: hg - ag,
    goals_total_now: hg + ag,
    home_yc_now: hyc,
    away_yc_now: ayc,
    home_rc_now: hrc,
    away_rc_now: arc,
    total_yc_now: hyc + ayc,
    total_rc_now: hrc + arc,
    home_subs_now: hsub,
    away_subs_now: asub,
    minutes_remaining: Math.max(0, 90 - elapsed),
    score_state: hg > ag ? 1 : (ag > hg ? -1 : 0),
    // ── 25 pre-meci (ordine EXACTĂ ca NEW_FEATURES din train_live_v2.py) ──
    // A) ml_features (18) — din payload enrich
    home_yc_avg: nn(en.homeYcAvg), away_yc_avg: nn(en.awayYcAvg),
    home_fouls_avg: nn(en.homeFoulsAvg), away_fouls_avg: nn(en.awayFoulsAvg),
    home_corners_avg: nn(en.homeCornersAvg), away_corners_avg: nn(en.awayCornersAvg),
    home_possession_avg: nn(en.homePossessionAvg), away_possession_avg: nn(en.awayPossessionAvg),
    home_sot_avg: nn(en.homeSotAvg), away_sot_avg: nn(en.awaySotAvg),
    home_xg_avg: nn(en.homeXgAvg), away_xg_avg: nn(en.awayXgAvg),
    home_goals_r1_avg: nn(en.homeGoalsR1Avg), away_goals_r1_avg: nn(en.awayGoalsR1Avg),
    home_goals_r2_avg: nn(en.homeGoalsR2Avg), away_goals_r2_avg: nn(en.awayGoalsR2Avg),
    home_subs_avg: nn(en.homeSubsAvg), away_subs_avg: nn(en.awaySubsAvg),
    // B) elo_history (3) — din eloResult (sau payload)
    home_elo: nn(elo.home_elo != null ? elo.home_elo : en.homeElo),
    away_elo: nn(elo.away_elo != null ? elo.away_elo : en.awayElo),
    elo_diff: nn(elo.elo_diff != null ? elo.elo_diff : en.eloDiffUsed),
    // C) standings (2) — poziție normalizată din payload
    home_position_norm: nn(en.homePositionNorm), away_position_norm: nn(en.awayPositionNorm),
    // D) referee_stats (2) — din payload
    ref_yc_avg: nn(en.refYcAvg), ref_style_open: nn(en.refStyleOpen),
  };
}

// Rulează TOATE cele 31 piețe din model_live_export.json pe starea live curentă.
//   • binare        → lrProb existent           → out[key] = procent (0-100)
//   • 3 clase (au .classes) → lrProbMulti        → out[key] = { [clasă]: procent }
// CRUCIAL — praguri deja atinse de scorul curent = 100% AUTOMAT (fapt, nu model).
// Silent-fail: model lipsă/eroare → {} (integrarea live e dezactivată curat).
export function predictLiveMarketsV2(liveState, enrichData, eloData) {
  try {
    const lm = loadLiveModel();
    if (!lm || typeof lm !== 'object') return {};
    const feat = buildLiveFeaturesV2(liveState, enrichData, eloData);
    // Feature absent (null/NaN) → mediana din export (exact ca fillna(median) la
    // antrenare). Acoperă cele 25 pre-meci când payload-ul nu le are.
    const med = lm._feature_medians || {};
    for (const k of Object.keys(med)) {
      if (feat[k] == null || !Number.isFinite(feat[k])) feat[k] = med[k];
    }
    const out = {};
    for (const key of Object.keys(lm)) {
      if (key.charCodeAt(0) === 95) continue;   // chei meta (_feature_medians/_coverage)
      const m = lm[key];
      if (!m || !Array.isArray(m.features)) continue;
      if (Array.isArray(m.classes) && m.classes.length > 0) {
        const probs = lrProbMulti(m, feat);   // piață cu 3 clase
        if (probs) out[key] = probs;
      } else {
        const p = lrProb(m, feat);             // piață binară (ACELAȘI lrProb)
        if (p != null) out[key] = p;
      }
    }
    // ── Praguri deja depășite de scorul curent → 100% (NU din model) ──
    const s = liveState || {};
    const hg = Number(s.home_goals) || 0, ag = Number(s.away_goals) || 0, tg = hg + ag;
    const cardsNow = (Number(s.home_yc) || 0) + (Number(s.away_yc) || 0)
                   + (Number(s.home_rc) || 0) + (Number(s.away_rc) || 0);
    const hit = (k, cond) => { if (cond && k in out) out[k] = 100; };
    // goluri total
    hit('goals_r1_over05', tg >= 1); hit('goals_r1_over15', tg >= 2); hit('goals_r1_over25', tg >= 3);
    hit('goals_total_over15', tg >= 2); hit('goals_total_over25', tg >= 3);
    hit('goals_total_over35', tg >= 4); hit('goals_total_over45', tg >= 5);
    // goluri per echipă
    hit('home_goals_r1_over05', hg >= 1); hit('home_goals_r1_over15', hg >= 2); hit('home_goals_r1_over25', hg >= 3);
    hit('away_goals_r1_over05', ag >= 1); hit('away_goals_r1_over15', ag >= 2); hit('away_goals_r1_over25', ag >= 3);
    // BTTS (ambele au marcat = fapt, valabil R1 și final)
    hit('btts_r1', hg > 0 && ag > 0); hit('btts_final', hg > 0 && ag > 0);
    // cartonașe (total galbene+roșii curent)
    hit('cards_r1_over15', cardsNow >= 2); hit('cards_r1_over25', cardsNow >= 3); hit('cards_r1_over35', cardsNow >= 4);
    hit('cards_total_over35', cardsNow >= 4); hit('cards_total_over45', cardsNow >= 5); hit('cards_total_over55', cardsNow >= 6);
    // Notă: piețele R2-split (goals_r2_*, home/away_goals_r2_*) NU pot fi marcate
    // ca atinse din scorul total fără scorul HT → rămân pe predicția modelului.
    return out;
  } catch (_) { return {}; }
}
