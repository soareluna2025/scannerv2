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

// Tabele actualizate dupa h2h backfill (24.05.2026 v2):
// Formula este acum BIMODALA — prediceri sub 50% = real 0%, peste 70% = real 100%.
// Brier scores au scazut cu 20-52% pe toate pietele dupa popularea h2h.
const CALIBRATION = {
  // Gazde marchează — formula PRACTIC PERFECTA (Brier 0.095)
  // Sub 50% real 0%, peste 70% real 100%. Cliff la 60-70%.
  home: [
    { from: 0,  to: 50, real: 0 },     // model spune nu = real nu
    { from: 50, to: 60, real: 2 },     // n=116, actual 1.7%
    { from: 60, to: 70, real: 81 },    // n=32, actual 81.3% — cliff zone
    { from: 70, to: 101, real: 100 },  // 700+ samples, toate 100%
  ],
  // Oaspeți marchează — Brier 0.113, identic bimodal
  away: [
    { from: 0,  to: 50, real: 1 },
    { from: 50, to: 60, real: 12 },    // n=126, actual 11.9%
    { from: 60, to: 70, real: 93 },    // n=124, actual 92.7%
    { from: 70, to: 101, real: 100 },  // toate 100%
  ],
  // GG — Brier 0.107, cliff la 50-60
  gg: [
    { from: 0,  to: 50, real: 0 },     // toate buckets 0-50: real 0%
    { from: 50, to: 60, real: 67 },    // n=72, actual 66.7%
    { from: 60, to: 70, real: 99 },    // n=153, actual 99.3%
    { from: 70, to: 101, real: 100 },  // toate 100%
  ],
  // Over 0.5 total — Brier 0.079, aproape perfect
  'goals_total_0.5': [
    { from: 0,  to: 50, real: 25 },
    { from: 50, to: 60, real: 39 },
    { from: 60, to: 70, real: 58 },    // n=176
    { from: 70, to: 80, real: 60 },    // n=37 unreliable, mediez catre 80+
    { from: 80, to: 101, real: 100 },  // 733 samples toate 100%
  ],
  // Over 1.5 total — Brier 0.127
  'goals_total_1.5': [
    { from: 0,  to: 30, real: 0 },
    { from: 30, to: 40, real: 28 },
    { from: 40, to: 50, real: 43 },
    { from: 50, to: 60, real: 43 },    // n=150
    { from: 60, to: 70, real: 68 },    // n=99
    { from: 70, to: 101, real: 100 },  // 520 samples toate 100%
  ],
  // Over 2.5 total — Brier 0.114
  'goals_total_2.5': [
    { from: 0,  to: 40, real: 0 },
    { from: 40, to: 50, real: 7 },
    { from: 50, to: 60, real: 62 },    // cliff
    { from: 60, to: 70, real: 98 },
    { from: 70, to: 101, real: 100 },
  ],
  // Over 0.5 gazde — Brier 0.132, calibrat gradual
  'goals_home_0.5': [
    { from: 0,  to: 30, real: 0 },
    { from: 30, to: 40, real: 20 },
    { from: 40, to: 50, real: 12 },
    { from: 50, to: 60, real: 34 },
    { from: 60, to: 70, real: 29 },    // unusual dip
    { from: 70, to: 80, real: 83 },
    { from: 80, to: 90, real: 93 },
    { from: 90, to: 101, real: 99 },
  ],
  // Over 1.5 gazde — Brier 0.163
  'goals_home_1.5': [
    { from: 0,  to: 20, real: 0 },
    { from: 20, to: 30, real: 10 },
    { from: 30, to: 40, real: 15 },
    { from: 40, to: 50, real: 22 },
    { from: 50, to: 60, real: 66 },    // cliff
    { from: 60, to: 70, real: 76 },
    { from: 70, to: 80, real: 85 },
    { from: 80, to: 101, real: 97 },
  ],
  // Over 0.5 oaspeți — Brier 0.170 (gradual)
  'goals_away_0.5': [
    { from: 0,  to: 30, real: 0 },
    { from: 30, to: 40, real: 12 },
    { from: 40, to: 50, real: 27 },
    { from: 50, to: 60, real: 26 },
    { from: 60, to: 70, real: 38 },
    { from: 70, to: 80, real: 77 },
    { from: 80, to: 90, real: 87 },
    { from: 90, to: 101, real: 95 },
  ],
  // Over 1.5 oaspeți — Brier 0.164
  'goals_away_1.5': [
    { from: 0,  to: 20, real: 0 },
    { from: 20, to: 30, real: 4 },
    { from: 30, to: 40, real: 13 },
    { from: 40, to: 50, real: 24 },
    { from: 50, to: 60, real: 45 },
    { from: 60, to: 70, real: 66 },
    { from: 70, to: 80, real: 89 },
    { from: 80, to: 101, real: 100 },
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
