// NGP Calibration Layer
//
// Bazat pe backtest pe 531 meciuri × 95.658 snapshot-uri (rulat 24.05.2026)
// Formula V1_sotDerived. Calibrare măsurată pe bucket-uri 10pp.
//
// Date observate (raw → real):
//   raw 70-80% → real 84.7%   (slight underestimate, OK)
//   raw 80-90% → real 83.9%   (calibrat aproape perfect)
//   raw 90-100% → real 80.8%  (SUPRAESTIMARE de 14pp — periculos pentru pariere)
//
// Strategie: pass-through pentru raw ≤ 80 (zonă necritică), compresie progresivă
// pentru 80-100 (forțare către max realist ~83). NU vom mai afișa niciodată
// peste ~83% — peste pragul ăsta, datele istorice nu confirmă încrederea.

const NGP_MAX_DISPLAY = 83;

/**
 * Calibrează NGP brut pe baza datelor istorice măsurate.
 * @param {number} raw - valoarea brută calculată de calcNextGoal (3-97)
 * @returns {number} valoarea calibrată (3-83)
 */
export function calibrateNgp(raw) {
  if (typeof raw !== 'number' || isNaN(raw)) return 0;
  if (raw < 80) return raw;
  // 80-90: liniar către 83 (compresie ușoară)
  if (raw < 90) return Math.round(80 + (raw - 80) * 0.3);
  // 90-100: hard cap la 83
  return NGP_MAX_DISPLAY;
}

// ── [FEATURE_NGP_TIMEDECAY] Strat de serving flag-gated (default OFF) ──────────
// NU modifică calibrateNgp de mai sus (folosit și de api/football.js). Sunt helpere
// noi, PURE, apelate de scanner DOAR când flag-ul e ON și fixture-ul e în shadow.

/**
 * Selector shadow determinist pentru rollout gradual.
 * Același fixture_id întoarce MEREU același rezultat (necesar pt reproductibilitate).
 * Distribuție uniformă reală: id % 100 < procent (≈10% pt default).
 * @param {number} fixtureId
 * @param {number} shadowPercentage  (1-100, default 10)
 * @returns {boolean}
 */
export function isShadowFixture(fixtureId, shadowPercentage = 10) {
  const id = Number(fixtureId);
  if (!Number.isFinite(id)) return false;
  return (Math.abs(id) % 100) < shadowPercentage;
}

/**
 * Calibrare NGP cu time-decay (de-boost principial) — varianta din experimentul
 * ml/fix_ngp_timedecay.py (a). calcNextGoal aplică boost pe remXg: ×1.2 la 70-79',
 * ×1.15 la ≥80' → supra-încredere târziu. Aici INVERSĂM exact acel boost:
 *   p = raw/100 ; remXg = -ln(1-p) ; remXg' = remXg / boost ; p' = 1-exp(-remXg').
 * Apoi trecem rezultatul prin calibrateNgp existent (păstrează pragul de siguranță 83
 * și pass-through-ul <80). Sub minutul 70 nu există boost → comportament ca producția.
 * @param {number} raw      - NGP brut din calcNextGoal (3-97)
 * @param {number} elapsed  - minute jucate (f.mn)
 * @returns {number} NGP de-boostat, calibrat (0-83)
 */
export function calibrateNgpWithTimedecay(raw, elapsed) {
  if (typeof raw !== 'number' || isNaN(raw)) return 0;
  const mn = Number(elapsed) || 0;
  const boost = (mn >= 80) ? 1.15 : (mn >= 70) ? 1.2 : 1.0;
  if (boost === 1.0) return calibrateNgp(raw);           // fără boost de inversat
  const p = Math.max(0, Math.min(0.999999, raw / 100));
  const remXgBoosted = -Math.log(1 - p);
  const pDeBoosted   = 1 - Math.exp(-(remXgBoosted / boost));
  return calibrateNgp(Math.round(pDeBoosted * 100));
}

export { NGP_MAX_DISPLAY };
