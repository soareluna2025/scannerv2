// api/utils/gg-calibration.js — STRAT de calibrare isotonic DEASUPRA ggProb servit.
// Flag-gated: GG_CALIBRATION = OFF (default) / ON.
//   OFF (sau lipsă)         → identitate (returnează valoarea brută, ZERO schimbare).
//   ON + gg_calibration.json validat → transformă ggProb prin tabelul isotonic.
// NU atinge Poisson/λ/Maher (imutabile) — doar o mapare monotonă a probabilității finale.
//
// Tabelul (ml/gg_calibration.json) e generat de ml/gg_calibrate_isotonic.py (cron 06:50).
// SELF-GUARD dublu: se aplică DOAR dacă flag ON ȘI json.validated===true (fit-ul refuză
// validarea dacă Brier-ul pe test nu se îmbunătățește).
import { readFileSync } from 'fs';

const CAL_PATH = new URL('../../ml/gg_calibration.json', import.meta.url);
const TTL = 3_600_000; // reîncarcă tabelul o dată/oră (refresh zilnic de cron, fără restart)
let _cal = null, _loadedAt = 0;

function load() {
  try {
    const raw = JSON.parse(readFileSync(CAL_PATH, 'utf8'));
    _cal = (Array.isArray(raw.x) && Array.isArray(raw.y) &&
            raw.x.length === raw.y.length && raw.x.length >= 2) ? raw : null;
  } catch (_) { _cal = null; }
  _loadedAt = Date.now();
}

// Interpolare liniară pe grila x (ascendentă, 0..1) → y calibrat.
function interp(cal, p) {
  const { x, y } = cal;
  if (p <= x[0]) return y[0];
  if (p >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] <= p) lo = mid; else hi = mid; }
  const span = (x[hi] - x[lo]) || 1;
  const t = (p - x[lo]) / span;
  return y[lo] + t * (y[hi] - y[lo]);
}

// Întoarce ggProb calibrat (0-100) sau valoarea brută (identitate) când OFF/nevalidat.
export function calibrateGg(rawPct) {
  if (rawPct == null || process.env.GG_CALIBRATION !== 'ON') return rawPct;  // OFF → identitate, zero cost
  if (!_cal || (Date.now() - _loadedAt) > TTL) load();
  if (!_cal || _cal.validated !== true) return rawPct;                       // nevalidat → identitate
  const p = Math.max(0, Math.min(1, Number(rawPct) / 100));
  const out = Math.round(Math.max(0, Math.min(1, interp(_cal, p))) * 100);
  return Number.isFinite(out) ? out : rawPct;
}
