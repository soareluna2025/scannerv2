import { query } from './db.js';

const weatherCache = new Map(); // `${lat2},${lon2}` → { ts, data }
const CACHE_TTL    = 1_800_000; // 30 min

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
  const lat = venue ? Number(venue.latitude)  || 0 : 0;
  const lon = venue ? Number(venue.longitude) || 0 : 0;

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
