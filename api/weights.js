// Centralized model weights cache — load from DB, refresh hourly
import { query } from './db.js';

let _cache = {};          // { 'MODULE::context_key::weight_name': value }
let _lastLoad = 0;
const TTL = 3_600_000;    // 1 hour

export async function loadModelWeights() {
  try {
    const { rows } = await query(
      'SELECT module, context_key, weight_name, weight_value, default_value FROM model_weights'
    );
    _cache = {};
    for (const r of rows) {
      _cache[`${r.module}::${r.context_key}::${r.weight_name}`] = Number(r.weight_value);
      // also store default
      _cache[`${r.module}::${r.context_key}::${r.weight_name}::default`] = Number(r.default_value);
    }
    _lastLoad = Date.now();
  } catch (e) {
    console.error('[weights] load error:', e.message);
  }
}

export function getWeight(module, contextKey, weightName, fallback = null) {
  // Refresh if stale (non-blocking)
  if (Date.now() - _lastLoad > TTL) loadModelWeights().catch(() => {});

  // Try specific context first, then global
  const specific = _cache[`${module}::${contextKey}::${weightName}`];
  if (specific != null) return specific;
  const global   = _cache[`${module}::global::${weightName}`];
  if (global  != null) return global;
  return fallback;
}

export function getDefaultWeight(module, weightName) {
  return _cache[`${module}::global::${weightName}::default`] ?? null;
}
