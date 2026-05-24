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

export { NGP_MAX_DISPLAY };
