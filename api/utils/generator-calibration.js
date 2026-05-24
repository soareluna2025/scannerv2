// Generator Calibration Layer
//
// Bazat pe backtest 1000 meciuri istorice (24.05.2026, scripts/generator-backtest.js)
// Pentru fiecare piață, mapează scor brut din g2Score → probabilitate reală măsurată.
//
// Format: { [market_key]: [{ from, to, real }] }
// Lookup: găsește bucket-ul în care cade scorul brut, returnează 'real'.
//
// Markets validated (sample suficient n=1000):
//   home, away, gg, goals_total_0.5/1.5/2.5, goals_home_0.5/1.5,
//   goals_away_0.5/1.5
// Markets neacoperite (n=7): cards/corners — pass-through.

const CALIBRATION = {
  // Gazde marchează — formula SUBESTIMEAZĂ la high (oportunitate!)
  home: [
    { from: 0,  to: 20, real: 5 },
    { from: 20, to: 30, real: 5 },     // 0% measured, conservative
    { from: 30, to: 40, real: 8 },     // 0% measured, conservative
    { from: 40, to: 50, real: 26 },
    { from: 50, to: 60, real: 58 },    // ✓ calibrat
    { from: 60, to: 70, real: 78 },    // +12pp boost
    { from: 70, to: 80, real: 81 },
    { from: 80, to: 90, real: 96 },    // 🎁 +11pp BOOST mare
    { from: 90, to: 101, real: 100 },
  ],
  // Oaspeți marchează — calibrare bună la high, anomalii la mid
  away: [
    { from: 0,  to: 30, real: 15 },
    { from: 30, to: 40, real: 16 },    // -19pp discount
    { from: 40, to: 50, real: 43 },
    { from: 50, to: 60, real: 58 },
    { from: 60, to: 70, real: 70 },
    { from: 70, to: 80, real: 77 },
    { from: 80, to: 90, real: 87 },
    { from: 90, to: 101, real: 100 },
  ],
  // GG — formula degenerează la 80%+ (cap aplicat)
  gg: [
    { from: 0,  to: 20, real: 5 },
    { from: 20, to: 30, real: 5 },
    { from: 30, to: 40, real: 22 },
    { from: 40, to: 50, real: 40 },
    { from: 50, to: 60, real: 54 },
    { from: 60, to: 70, real: 61 },
    { from: 70, to: 80, real: 80 },    // ✓ sweet spot
    { from: 80, to: 101, real: 70 },   // CAP — formula minte peste 80
  ],
  // Over 0.5 total — formula EXCELENTĂ (Brier 0.115), pass-through cu micro-fix
  'goals_total_0.5': [
    { from: 0,  to: 50, real: 30 },
    { from: 50, to: 60, real: 40 },
    { from: 60, to: 70, real: 52 },
    { from: 70, to: 80, real: 81 },
    { from: 80, to: 90, real: 90 },
    { from: 90, to: 101, real: 87 },   // micro-discount
  ],
  // Over 1.5 total — bună, subestimează la high
  'goals_total_1.5': [
    { from: 0,  to: 30, real: 10 },
    { from: 30, to: 40, real: 15 },
    { from: 40, to: 50, real: 49 },
    { from: 50, to: 60, real: 64 },
    { from: 60, to: 70, real: 73 },
    { from: 70, to: 80, real: 81 },
    { from: 80, to: 90, real: 95 },    // BOOST
    { from: 90, to: 101, real: 100 },
  ],
  // Over 2.5 total — bine calibrată
  'goals_total_2.5': [
    { from: 0,  to: 30, real: 18 },
    { from: 30, to: 40, real: 29 },
    { from: 40, to: 50, real: 40 },
    { from: 50, to: 60, real: 61 },
    { from: 60, to: 70, real: 76 },
    { from: 70, to: 80, real: 73 },
    { from: 80, to: 90, real: 89 },
    { from: 90, to: 101, real: 87 },
  ],
  // Over 0.5 gazde — bine calibrată
  'goals_home_0.5': [
    { from: 0,  to: 40, real: 5 },
    { from: 40, to: 50, real: 8 },
    { from: 50, to: 60, real: 27 },
    { from: 60, to: 70, real: 58 },
    { from: 70, to: 80, real: 75 },
    { from: 80, to: 90, real: 81 },
    { from: 90, to: 101, real: 96 },
  ],
  // Over 1.5 gazde
  'goals_home_1.5': [
    { from: 0,  to: 20, real: 5 },
    { from: 20, to: 30, real: 8 },
    { from: 30, to: 40, real: 26 },
    { from: 40, to: 50, real: 43 },
  ],
  // Over 0.5 oaspeți — formula SUPRAESTIMEAZĂ sistematic
  'goals_away_0.5': [
    { from: 0,  to: 30, real: 10 },
    { from: 30, to: 40, real: 10 },    // -25pp discount mare
    { from: 40, to: 50, real: 10 },    // -35pp discount HUGE
    { from: 50, to: 60, real: 42 },
    { from: 60, to: 70, real: 57 },
    { from: 70, to: 80, real: 70 },
    { from: 80, to: 90, real: 75 },    // cap
    { from: 90, to: 101, real: 87 },
  ],
  // Over 1.5 oaspeți — boost la high
  'goals_away_1.5': [
    { from: 0,  to: 10, real: 3 },
    { from: 10, to: 20, real: 5 },
    { from: 20, to: 30, real: 10 },
  ],
};

/**
 * Returnează probabilitatea reală pentru un scor brut.
 * @param {string} category - cat din G2 (home, away, gg, goals, cards, corners)
 * @param {string|null} sub - sub-categorie pentru goals/cards/corners (home, away, total)
 * @param {number|null} threshold - pragul pentru goals/cards/corners (0.5, 1.5, etc.)
 * @param {number} rawScore - scorul brut returnat de g2Score (0-100)
 * @returns {number} probabilitate calibrată 0-100
 */
export function calibrateGenerator(category, sub, threshold, rawScore) {
  if (typeof rawScore !== 'number' || isNaN(rawScore)) return 0;

  let key;
  if (category === 'home' || category === 'away' || category === 'gg') {
    key = category;
  } else if (category === 'goals') {
    const subStr = sub || 'total';
    const thrStr = (threshold || 0.5).toString();
    key = `goals_${subStr}_${thrStr}`;
  } else {
    // cards/corners — pass-through (sample insuficient pentru calibrare)
    return rawScore;
  }

  const table = CALIBRATION[key];
  if (!table) return rawScore;  // unknown combo

  for (const bucket of table) {
    if (rawScore >= bucket.from && rawScore < bucket.to) {
      return bucket.real;
    }
  }
  // fallback dacă scor în afara range-urilor definite
  return rawScore;
}

/**
 * Returnează un emoji/badge indicator pentru calitatea calibrării.
 * Util pentru UI: afișează ✓ pentru piețele calibrate, ⓘ pentru pass-through.
 */
export function calibrationQuality(category) {
  if (category === 'home' || category === 'away' || category === 'gg' || category === 'goals') {
    return 'calibrated';
  }
  return 'untested';  // cards, corners
}
