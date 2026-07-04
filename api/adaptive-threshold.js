// api/adaptive-threshold.js — poartă de selecție adaptivă per (modul, ligă).
// Flag-gated: ADAPTIVE_THRESHOLD = OFF (default) / SHADOW / ON.
//   OFF    — nimic (poarta rămâne pragul static 70). Nicio interogare în plus.
//   SHADOW — decizia rămâne pe static; divergențele se loghează în adaptive_shadow_log.
//   ON     — poarta folosește pragul învățat (getAdaptiveThreshold ?? static).
//
// Sursa pragului: model_weights (module, 'league_<id>', 'threshold'), scris de
// learning-analysis.js (P4c). Se ACCEPTĂ doar dacă e robust: confidence_level='HIGH'
// ȘI sample_size>=50; altfel null → caller cade pe fallback-ul static.
//
// GG e HARD-EXCLUS (calibrare inversată — vezi learning-analysis.js P3).
import { query } from './db.js';

export const ELIGIBLE_MODULES = new Set(['NGP', 'OVER15', 'CONFIDENCE']);

const TTL = 3_600_000; // 1h — model_weights se schimbă doar la cronul 03:30
const _cache = new Map(); // `${module}::league_${id}` → { val, ts }

export function getMode() {
  const m = String(process.env.ADAPTIVE_THRESHOLD || 'OFF').toUpperCase();
  return (m === 'SHADOW' || m === 'ON') ? m : 'OFF';
}

// Pragul adaptiv pentru (modul, ligă) sau null dacă nu e eligibil / nu e robust.
export async function getAdaptiveThreshold(module, leagueId) {
  if (!ELIGIBLE_MODULES.has(module) || leagueId == null) return null;
  const key = `${module}::league_${leagueId}`;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < TTL) return hit.val;
  let val = null;
  try {
    const { rows } = await query(
      `SELECT weight_value FROM model_weights
       WHERE module=$1 AND context_key=$2 AND weight_name='threshold'
         AND confidence_level='HIGH' AND sample_size>=50
       LIMIT 1`,
      [module, `league_${leagueId}`]
    );
    if (rows[0] && rows[0].weight_value != null) val = Number(rows[0].weight_value);
  } catch (_) { val = null; }
  _cache.set(key, { val, ts: Date.now() });
  return val;
}

// ── Shadow logging (SHADOW mode) — doar divergențele static vs adaptiv ─────────
let _shadowEnsured = false;
async function ensureShadowTable() {
  if (_shadowEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS adaptive_shadow_log (
      id                SERIAL PRIMARY KEY,
      fixture_id        INT,
      module            TEXT,
      league_id         INT,
      static_thr        NUMERIC,
      adaptive_thr      NUMERIC,
      predicted_value   NUMERIC,
      static_decision   BOOLEAN,
      adaptive_decision BOOLEAN,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_adaptive_shadow_fx_mod
                 ON adaptive_shadow_log(fixture_id, module)`);
    _shadowEnsured = true;
  } catch (_) { /* best-effort */ }
}

export async function logShadowDivergence(o) {
  try {
    await ensureShadowTable();
    await query(
      `INSERT INTO adaptive_shadow_log
         (fixture_id, module, league_id, static_thr, adaptive_thr,
          predicted_value, static_decision, adaptive_decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (fixture_id, module) DO NOTHING`,
      [o.fixture_id, o.module, o.league_id ?? null, o.static_thr, o.adaptive_thr,
       o.predicted_value, o.static_decision, o.adaptive_decision]
    );
  } catch (_) { /* best-effort */ }
}

// Helper compus pt caller: întoarce pragul efectiv + loghează shadow dacă diferă.
// static_thr = fallback-ul hardcodat (ex. 70). value = predicted_value real.
// Întoarce pragul de folosit pt DECIZIE conform modului:
//   OFF → static; SHADOW → static (dar loghează divergența); ON → adaptive ?? static.
export async function resolveThreshold(module, leagueId, staticThr, predictedValue, fixtureId) {
  const mode = getMode();
  if (mode === 'OFF') return staticThr;
  const adaptive = await getAdaptiveThreshold(module, leagueId);
  if (adaptive == null) return staticThr;
  if (mode === 'SHADOW') {
    const sDec = predictedValue >= staticThr;
    const aDec = predictedValue >= adaptive;
    if (sDec !== aDec && fixtureId != null) {
      await logShadowDivergence({
        fixture_id: fixtureId, module, league_id: leagueId,
        static_thr: staticThr, adaptive_thr: adaptive, predicted_value: predictedValue,
        static_decision: sDec, adaptive_decision: aDec,
      });
    }
    return staticThr; // decizia rămâne pe static în SHADOW
  }
  return adaptive; // ON
}
