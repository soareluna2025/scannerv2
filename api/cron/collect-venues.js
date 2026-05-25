// Cron: colectare venues + altitudine
// Apelat din admin sau scheduled (saptamanal e suficient).
//
// Workflow:
// 1. Asigura coloanele altitude_m + climate_zone in venues
// 2. Identifica venue_id-uri unice din fixtures fara venue.altitude_m populat
// 3. Pentru fiecare: GET /venues?id=X de la API-Football
// 4. Daca venue are lat/long -> GET de la Open-Elevation pentru altitude
// 5. UPSERT in tabela venues
//
// Trigger: GET /api/cron/collect-venues
// Cron: 0 4 * * 0 (duminica 04:00, saptamanal)
// Cost API: ~1 call/venue (max 3000 venues total = ~3k calls one-time)

import { query } from '../db.js';

async function ensureColumns() {
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS altitude_m INT`).catch(() => {});
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS climate_zone TEXT`).catch(() => {});
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
}

// Geocodare oras/tara → lat/lng via Nominatim (OSM, gratuit, fara cheie, max 1 req/s)
async function geocodeCity(city, country) {
  if (!city) return null;
  try {
    const q = encodeURIComponent(`${city}${country ? ', ' + country : ''}`);
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AlohaScan/1.0 (soareluna2025@protonmail.com)' },
      signal: AbortSignal.timeout(8000),
    });
    const d = await res.json();
    if (!Array.isArray(d) || !d.length) return null;
    return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch (_) { return null; }
}

// Lookup altitude prin Open-Elevation (gratuit, fara cheie)
// Climate zone simplu pe baza de latitudine
function climateZone(lat) {
  if (lat == null) return null;
  const abs = Math.abs(lat);
  if (abs < 23.5) return 'tropical';
  if (abs < 35)   return 'subtropical';
  if (abs < 50)   return 'temperate';
  if (abs < 66.5) return 'cold';
  return 'polar';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Elevation batch: Open-Meteo accepta pana la 100 perechi lat/lng intr-un singur request
async function getAltitudeBatch(coords) {
  if (!coords.length) return [];
  try {
    const lats = coords.map(c => c.lat).join(',');
    const lngs = coords.map(c => c.lng).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const d = await res.json();
    return Array.isArray(d.elevation) ? d.elevation.map(e => typeof e === 'number' ? Math.round(e) : 0) : coords.map(() => 0);
  } catch (_) {
    return coords.map(() => 0);
  }
}

async function processVenues(LIMIT) {
    const { rows: toProcess } = await query(`
      SELECT venue_id AS vid, city, country FROM venues
      WHERE altitude_m IS NULL AND city IS NOT NULL
      ORDER BY venue_id
      LIMIT $1
    `, [LIMIT]).catch(() => ({ rows: [] }));

    if (!toProcess.length) {
      console.log('[collect-venues] nimic de procesat');
      return;
    }

    // Pas 1: geocodare unica per oras (nu per venue) — economiseste apeluri Nominatim
    const cityCache = new Map(); // "city|country" → {lat, lng} | null
    const uniqueCities = [...new Set(toProcess.map(r => `${r.city}|${r.country ?? ''}`))];
    console.log(`[collect-venues] ${toProcess.length} venues, ${uniqueCities.length} orase unice`);

    for (const key of uniqueCities) {
      const [city, country] = key.split('|');
      const coords = await geocodeCity(city, country);
      cityCache.set(key, coords);
      await sleep(1100); // Nominatim rate limit: 1 req/s
    }

    // Pas 2: elevation batch pentru toate coordonatele obtinute (un singur request API)
    const withCoords = toProcess
      .map(r => ({ ...r, coords: cityCache.get(`${r.city}|${r.country ?? ''}`) }))
      .filter(r => r.coords);

    const elevations = await getAltitudeBatch(withCoords.map(r => r.coords));

    // Pas 3: UPDATE batch in DB
    const collected = [];
    for (let i = 0; i < withCoords.length; i++) {
      const r = withCoords[i];
      const { lat, lng } = r.coords;
      const altitude = elevations[i] ?? 0;
      const climate = climateZone(lat);
      try {
        await query(`
          UPDATE venues
          SET latitude = $1, longitude = $2, altitude_m = $3, climate_zone = $4, updated_at = NOW()
          WHERE venue_id = $5
        `, [lat, lng, altitude, climate, r.vid]);
        collected.push({ id: r.vid, city: r.city, lat, altitude });
      } catch (e) {
        console.warn(`[collect-venues] UPDATE esec venue ${r.vid}:`, e.message);
      }
    }
    console.log(`[collect-venues] done: ${collected.length}/${toProcess.length} venues procesate`);

    await query(`
      INSERT INTO cron_logs (job_name, ran_at, status, fixtures_processed)
      VALUES ('collect-venues', NOW(), 'success', $1)
    `, [collected.length]).catch(() => {});

    console.log(`[collect-venues] done: ${collected.length} venues procesate`);
}

export default async function handler(req, res) {
  try {
    await ensureColumns();
    const LIMIT = parseInt(req.query?.limit || '500', 10);

    const { rows: pending } = await query(`
      SELECT COUNT(*)::int AS n FROM venues WHERE altitude_m IS NULL AND city IS NOT NULL
    `).catch(() => ({ rows: [{ n: 0 }] }));

    const { rows: totalRows } = await query(`SELECT COUNT(*)::int AS n FROM venues`).catch(() => ({ rows: [{ n: 0 }] }));
    const { rows: doneRows } = await query(`SELECT COUNT(*)::int AS n FROM venues WHERE altitude_m IS NOT NULL`).catch(() => ({ rows: [{ n: 0 }] }));

    // Raspunde imediat — procesarea dureaza minute, nu secunde
    res.status(202).json({
      ok: true,
      status: 'started',
      limit: LIMIT,
      pending_before: pending[0]?.n || 0,
      done_before: doneRows[0]?.n || 0,
      total_venues_in_db: totalRows[0]?.n || 0,
      estimated_minutes: Math.ceil((Math.min(LIMIT, pending[0]?.n || LIMIT) * 10) / 60),
      message: 'Procesare in background. Verifica cron_logs sau venues WHERE altitude_m IS NOT NULL.',
    });

    // Fire-and-forget: proceseaza in background fara sa blocheze raspunsul
    setImmediate(() => processVenues(LIMIT).catch(e => console.error('[collect-venues]', e.message)));
  } catch (e) {
    console.error('[collect-venues]', e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
}
