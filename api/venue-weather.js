import { query } from './db.js';

const weatherCache = new Map(); // `${lat2},${lon2}` → { ts, data }
const CACHE_TTL    = 1_800_000; // 30 min

// Fallback coordinates for cities when venue lat/lon is missing from DB
const CITY_COORDS = {
  // Europe - UK
  'london': { lat: 51.51, lon: -0.13 },
  'manchester': { lat: 53.48, lon: -2.24 },
  'liverpool': { lat: 53.41, lon: -2.98 },
  'birmingham': { lat: 52.48, lon: -1.90 },
  'leeds': { lat: 53.80, lon: -1.55 },
  'newcastle': { lat: 54.97, lon: -1.61 },
  'sheffield': { lat: 53.38, lon: -1.47 },
  'nottingham': { lat: 52.95, lon: -1.15 },
  'leicester': { lat: 52.64, lon: -1.13 },
  'southampton': { lat: 50.91, lon: -1.40 },
  'brighton': { lat: 50.83, lon: -0.14 },
  // France
  'paris': { lat: 48.86, lon: 2.35 },
  'marseille': { lat: 43.30, lon: 5.37 },
  'lyon': { lat: 45.75, lon: 4.84 },
  'toulouse': { lat: 43.60, lon: 1.44 },
  'nice': { lat: 43.70, lon: 7.25 },
  'nantes': { lat: 47.22, lon: -1.55 },
  'strasbourg': { lat: 48.58, lon: 7.75 },
  'bordeaux': { lat: 44.84, lon: -0.58 },
  'lille': { lat: 50.63, lon: 3.06 },
  'rennes': { lat: 48.11, lon: -1.68 },
  'reims': { lat: 49.26, lon: 4.03 },
  'lens': { lat: 50.43, lon: 2.83 },
  'monaco': { lat: 43.74, lon: 7.43 },
  // Spain
  'madrid': { lat: 40.42, lon: -3.70 },
  'barcelona': { lat: 41.39, lon: 2.16 },
  'seville': { lat: 37.39, lon: -5.99 },
  'sevilla': { lat: 37.39, lon: -5.99 },
  'valencia': { lat: 39.47, lon: -0.38 },
  'bilbao': { lat: 43.26, lon: -2.93 },
  'san sebastian': { lat: 43.32, lon: -1.98 },
  'getafe': { lat: 40.32, lon: -3.73 },
  'granada': { lat: 37.18, lon: -3.60 },
  'malaga': { lat: 36.72, lon: -4.42 },
  'cadiz': { lat: 36.53, lon: -6.30 },
  'alicante': { lat: 38.35, lon: -0.49 },
  'zaragoza': { lat: 41.65, lon: -0.88 },
  'valladolid': { lat: 41.65, lon: -4.72 },
  // Italy
  'milan': { lat: 45.46, lon: 9.19 },
  'rome': { lat: 41.90, lon: 12.50 },
  'naples': { lat: 40.85, lon: 14.27 },
  'napoli': { lat: 40.85, lon: 14.27 },
  'torino': { lat: 45.07, lon: 7.69 },
  'turin': { lat: 45.07, lon: 7.69 },
  'florence': { lat: 43.77, lon: 11.25 },
  'firenze': { lat: 43.77, lon: 11.25 },
  'bologna': { lat: 44.50, lon: 11.34 },
  'genoa': { lat: 44.41, lon: 8.93 },
  'genova': { lat: 44.41, lon: 8.93 },
  'verona': { lat: 45.44, lon: 11.00 },
  'udine': { lat: 46.06, lon: 13.24 },
  'bergamo': { lat: 45.70, lon: 9.67 },
  'parma': { lat: 44.80, lon: 10.33 },
  'cagliari': { lat: 39.22, lon: 9.11 },
  'palermo': { lat: 38.12, lon: 13.36 },
  // Germany
  'berlin': { lat: 52.52, lon: 13.40 },
  'munich': { lat: 48.14, lon: 11.58 },
  'münchen': { lat: 48.14, lon: 11.58 },
  'hamburg': { lat: 53.55, lon: 10.00 },
  'frankfurt': { lat: 50.11, lon: 8.68 },
  'dortmund': { lat: 51.51, lon: 7.47 },
  'düsseldorf': { lat: 51.22, lon: 6.78 },
  'dusseldorf': { lat: 51.22, lon: 6.78 },
  'köln': { lat: 50.94, lon: 6.96 },
  'cologne': { lat: 50.94, lon: 6.96 },
  'stuttgart': { lat: 48.78, lon: 9.18 },
  'leipzig': { lat: 51.34, lon: 12.37 },
  'bremen': { lat: 53.07, lon: 8.81 },
  'freiburg': { lat: 47.99, lon: 7.85 },
  'bochum': { lat: 51.48, lon: 7.22 },
  'augsburg': { lat: 48.37, lon: 10.90 },
  'wolfsburg': { lat: 52.43, lon: 10.79 },
  'leverkusen': { lat: 51.02, lon: 7.00 },
  'mainz': { lat: 49.99, lon: 8.27 },
  // Netherlands / Belgium
  'amsterdam': { lat: 52.37, lon: 4.90 },
  'rotterdam': { lat: 51.92, lon: 4.48 },
  'eindhoven': { lat: 51.44, lon: 5.48 },
  'utrecht': { lat: 52.09, lon: 5.12 },
  'brussels': { lat: 50.85, lon: 4.35 },
  'bruxelles': { lat: 50.85, lon: 4.35 },
  'bruges': { lat: 51.21, lon: 3.22 },
  'brugge': { lat: 51.21, lon: 3.22 },
  'gent': { lat: 51.05, lon: 3.72 },
  'anderlecht': { lat: 50.83, lon: 4.30 },
  'liege': { lat: 50.63, lon: 5.58 },
  // Portugal
  'lisbon': { lat: 38.72, lon: -9.14 },
  'lisboa': { lat: 38.72, lon: -9.14 },
  'porto': { lat: 41.15, lon: -8.61 },
  'braga': { lat: 41.54, lon: -8.43 },
  'setubal': { lat: 38.53, lon: -8.89 },
  // Austria / Switzerland
  'vienna': { lat: 48.21, lon: 16.37 },
  'wien': { lat: 48.21, lon: 16.37 },
  'salzburg': { lat: 47.80, lon: 13.04 },
  'zurich': { lat: 47.38, lon: 8.54 },
  'zürich': { lat: 47.38, lon: 8.54 },
  'basel': { lat: 47.56, lon: 7.59 },
  'bern': { lat: 46.95, lon: 7.45 },
  'geneva': { lat: 46.20, lon: 6.15 },
  // Scandinavia
  'copenhagen': { lat: 55.68, lon: 12.57 },
  'oslo': { lat: 59.91, lon: 10.75 },
  'stockholm': { lat: 59.33, lon: 18.07 },
  'gothenburg': { lat: 57.71, lon: 11.97 },
  'göteborg': { lat: 57.71, lon: 11.97 },
  'helsinki': { lat: 60.17, lon: 24.94 },
  // Eastern Europe
  'warsaw': { lat: 52.23, lon: 21.01 },
  'warszawa': { lat: 52.23, lon: 21.01 },
  'krakow': { lat: 50.06, lon: 19.94 },
  'kraków': { lat: 50.06, lon: 19.94 },
  'prague': { lat: 50.08, lon: 14.43 },
  'praha': { lat: 50.08, lon: 14.43 },
  'budapest': { lat: 47.50, lon: 19.04 },
  'bucharest': { lat: 44.43, lon: 26.10 },
  'bucurești': { lat: 44.43, lon: 26.10 },
  'sofia': { lat: 42.70, lon: 23.32 },
  'belgrade': { lat: 44.80, lon: 20.46 },
  'beograd': { lat: 44.80, lon: 20.46 },
  'zagreb': { lat: 45.81, lon: 15.98 },
  'athens': { lat: 37.98, lon: 23.73 },
  'thessaloniki': { lat: 40.64, lon: 22.94 },
  // Turkey
  'istanbul': { lat: 41.01, lon: 28.95 },
  'ankara': { lat: 39.92, lon: 32.85 },
  'izmir': { lat: 38.42, lon: 27.14 },
  // Eastern Europe & CIS
  'kyiv': { lat: 50.45, lon: 30.52 },
  'kiev': { lat: 50.45, lon: 30.52 },
  'moscow': { lat: 55.75, lon: 37.62 },
  'saint petersburg': { lat: 59.95, lon: 30.32 },
  'minsk': { lat: 53.90, lon: 27.57 },
  'riga': { lat: 56.95, lon: 24.11 },
  'vilnius': { lat: 54.69, lon: 25.28 },
  'tallinn': { lat: 59.44, lon: 24.75 },
  // Americas
  'new york': { lat: 40.71, lon: -74.01 },
  'los angeles': { lat: 34.05, lon: -118.24 },
  'chicago': { lat: 41.88, lon: -87.63 },
  'houston': { lat: 29.76, lon: -95.37 },
  'toronto': { lat: 43.65, lon: -79.38 },
  'montreal': { lat: 45.50, lon: -73.57 },
  'vancouver': { lat: 49.25, lon: -123.12 },
  'mexico city': { lat: 19.43, lon: -99.13 },
  'guadalajara': { lat: 20.66, lon: -103.35 },
  'buenos aires': { lat: -34.60, lon: -58.38 },
  'sao paulo': { lat: -23.55, lon: -46.63 },
  'são paulo': { lat: -23.55, lon: -46.63 },
  'rio de janeiro': { lat: -22.91, lon: -43.17 },
  'bogota': { lat: 4.71, lon: -74.07 },
  'bogotá': { lat: 4.71, lon: -74.07 },
  'lima': { lat: -12.04, lon: -77.04 },
  'santiago': { lat: -33.46, lon: -70.65 },
  'montevideo': { lat: -34.90, lon: -56.19 },
  'quito': { lat: -0.23, lon: -78.52 },
  // Asia & Middle East
  'tokyo': { lat: 35.69, lon: 139.69 },
  'osaka': { lat: 34.69, lon: 135.50 },
  'seoul': { lat: 37.57, lon: 126.98 },
  'beijing': { lat: 39.91, lon: 116.39 },
  'shanghai': { lat: 31.23, lon: 121.47 },
  'hong kong': { lat: 22.32, lon: 114.17 },
  'dubai': { lat: 25.20, lon: 55.27 },
  'doha': { lat: 25.29, lon: 51.53 },
  'riyadh': { lat: 24.69, lon: 46.72 },
  'abu dhabi': { lat: 24.47, lon: 54.37 },
  'tehran': { lat: 35.69, lon: 51.42 },
  'tel aviv': { lat: 32.08, lon: 34.78 },
  'mumbai': { lat: 19.08, lon: 72.88 },
  'delhi': { lat: 28.66, lon: 77.23 },
  'bangkok': { lat: 13.75, lon: 100.52 },
  'jakarta': { lat: -6.21, lon: 106.85 },
  'kuala lumpur': { lat: 3.14, lon: 101.69 },
  'singapore': { lat: 1.35, lon: 103.82 },
  // Africa
  'cairo': { lat: 30.06, lon: 31.25 },
  'casablanca': { lat: 33.59, lon: -7.62 },
  'nairobi': { lat: -1.29, lon: 36.82 },
  'johannesburg': { lat: -26.20, lon: 28.04 },
  'cape town': { lat: -33.93, lon: 18.42 },
  'accra': { lat: 5.56, lon: -0.20 },
  'lagos': { lat: 6.45, lon: 3.40 },
  'tunis': { lat: 36.82, lon: 10.17 },
  'algiers': { lat: 36.74, lon: 3.06 },
  'dakar': { lat: 14.72, lon: -17.47 },
};

function wDesc(code) {
  if (code === 0)  return 'Senin';
  if (code <=  2)  return 'Parțial noros';
  if (code <=  3)  return 'Înnorat';
  if (code <= 49)  return 'Ceață';
  if (code <= 57)  return 'Burniță';
  if (code <= 67)  return 'Ploaie';
  if (code <= 77)  return 'Ninsoare';
  if (code <= 82)  return 'Averse';
  return 'Furtună';
}
function wIcon(code) {
  if (code === 0)  return '☀️';
  if (code <=  2)  return '⛅';
  if (code <=  3)  return '☁️';
  if (code <= 49)  return '🌫️';
  if (code <= 57)  return '🌦️';
  if (code <= 67)  return '🌧️';
  if (code <= 77)  return '❄️';
  if (code <= 82)  return '🌧️';
  return '⛈️';
}

function influence(temp, precip, wind) {
  const notes = [];
  if (temp != null && temp < 5)   notes.push('❄️ Frig intens — poate afecta precizia și viteza jocului');
  if (precip > 5)                 notes.push('🌧️ Ploaie — afectează jocul aerian și viteza mingii, mai puține goluri');
  if (wind   > 40)                notes.push('💨 Vânt puternic — șuturile de la distanță și cornerele sunt afectate');
  if (temp != null && temp > 30)  notes.push('🔥 Căldură extremă — ritmul jocului poate scădea în repriza a doua');
  if (!notes.length)              notes.push('✅ Condiții meteo favorabile jocului');
  return notes;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { venue_id, dt } = req.query;
  const venueId = Number(venue_id) || 0;

  // ── Venue from DB ──────────────────────────────────────────────────────────
  let venue = null;
  if (venueId) {
    try {
      const r = await query(
        `SELECT venue_id, name, city, country, capacity, surface, latitude, longitude
         FROM venues WHERE venue_id=$1`,
        [venueId]
      );
      venue = r.rows[0] || null;
    } catch (_) {}
  }

  // ── Weather from Open-Meteo (no key needed) ────────────────────────────────
  let weather = null;
  let lat = venue ? Number(venue.latitude)  || 0 : 0;
  let lon = venue ? Number(venue.longitude) || 0 : 0;

  // Fallback: lookup by city name when coordinates missing from DB
  if ((!lat || !lon) && venue && venue.city) {
    const cityKey = venue.city.toLowerCase().trim();
    const coords = CITY_COORDS[cityKey];
    if (coords) { lat = coords.lat; lon = coords.lon; }
  }

  if (lat && lon && dt) {
    const ck = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = weatherCache.get(ck);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      weather = hit.data;
    } else {
      try {
        const matchDt = new Date(dt);
        const dateStr = matchDt.toISOString().slice(0, 10);
        const url =
          `https://api.open-meteo.com/v1/forecast` +
          `?latitude=${lat}&longitude=${lon}` +
          `&hourly=temperature_2m,precipitation,windspeed_10m,weathercode` +
          `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;

        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const d = await r.json();

        if (d.hourly) {
          const times = d.hourly.time || [];
          const matchH = matchDt.getHours(); // local hour (rough — close enough)
          let bestIdx = 0, bestDiff = Infinity;
          times.forEach((t, i) => {
            const h = parseInt(t.slice(11, 13), 10);
            const diff = Math.abs(h - matchH);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
          });

          const temp   = d.hourly.temperature_2m?.[bestIdx] ?? null;
          const precip = d.hourly.precipitation?.[bestIdx]  ?? 0;
          const wind   = d.hourly.windspeed_10m?.[bestIdx]  ?? 0;
          const code   = d.hourly.weathercode?.[bestIdx]    ?? 0;

          weather = {
            temperature:   temp,
            description:   wDesc(code),
            icon:          wIcon(code),
            wind:          Math.round(wind),
            precipitation: Math.round(precip * 10) / 10,
            influence:     influence(temp, precip, wind),
          };
          weatherCache.set(ck, { ts: Date.now(), data: weather });
        }
      } catch (_) {}
    }
  }

  res.status(200).json({ venue, weather });
}
