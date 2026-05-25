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
import { fetchApiFootball } from '../utils/fetch-api.js';

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
async function getAltitude(lat, lng) {
  if (!lat || !lng) return null;
  try {
    const url = `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lng}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await res.json();
    const m = d.results?.[0]?.elevation;
    return typeof m === 'number' ? Math.round(m) : null;
  } catch (e) {
    return null;
  }
}

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

// Colecteaza un singur venue: API-Football + Nominatim geocodare + Open-Elevation altitudine
async function collectOne(venueId) {
  try {
    const res = await fetchApiFootball(`/venues?id=${venueId}`);
    const d = await res.json();
    const v = d.response?.[0];
    if (!v) return null;

    // Geocodeaza orasul → lat/lng (necesare pentru Open-Elevation)
    // Respecta rate limit Nominatim: apelantul trebuie sa adauge sleep(1100) dupa fiecare apel
    const coords = await geocodeCity(v.city, v.country);
    const lat = coords?.lat ?? null;
    const lng = coords?.lng ?? null;

    let altitude = null;
    if (lat != null && lng != null) altitude = await getAltitude(lat, lng);
    const climate = climateZone(lat);

    await query(`
      INSERT INTO venues (venue_id, name, address, city, country, capacity, surface, image,
                          latitude, longitude, altitude_m, climate_zone, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (venue_id) DO UPDATE SET
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        city = EXCLUDED.city,
        country = EXCLUDED.country,
        capacity = EXCLUDED.capacity,
        surface = EXCLUDED.surface,
        image = EXCLUDED.image,
        latitude  = COALESCE(EXCLUDED.latitude,  venues.latitude),
        longitude = COALESCE(EXCLUDED.longitude, venues.longitude),
        altitude_m = COALESCE(EXCLUDED.altitude_m, venues.altitude_m),
        climate_zone = COALESCE(EXCLUDED.climate_zone, venues.climate_zone),
        updated_at = NOW()
    `, [
      v.id, v.name || null, v.address || null, v.city || null, v.country || null,
      v.capacity || null, v.surface || null, v.image || null,
      lat, lng, altitude, climate,
    ]);
    return { id: v.id, name: v.name, city: v.city, lat, lng, altitude };
  } catch (e) {
    console.warn(`[collect-venues] venue ${venueId}:`, e.message);
    return null;
  }
}

export default async function handler(req, res) {
  try {
    await ensureColumns();
    // Limit per rulare ca sa nu epuizam quota
    const LIMIT = parseInt(req.query?.limit || '200', 10);

    // Prioritate 1: venues existente fara altitude (necesita geocodare + OpenElevation)
    // Prioritate 2: venue_id-uri noi (nu exista in venues)
    const { rows: noAlt } = await query(`
      SELECT venue_id AS vid FROM venues
      WHERE altitude_m IS NULL AND city IS NOT NULL
      ORDER BY venue_id
      LIMIT $1
    `, [LIMIT]).catch(() => ({ rows: [] }));

    const { rows: missing } = noAlt.length < LIMIT ? await query(`
      SELECT DISTINCT vid FROM (
        SELECT venue_id AS vid FROM teams WHERE venue_id IS NOT NULL
        UNION
        SELECT venue_id AS vid FROM fixtures WHERE venue_id IS NOT NULL
      ) sources
      WHERE vid NOT IN (SELECT venue_id FROM venues)
      LIMIT $1
    `, [LIMIT - noAlt.length]).catch(() => ({ rows: [] })) : { rows: [] };

    const toProcess = [...noAlt, ...missing];
    const collected = [];

    // Strategie 1: direct venue_id known — cu sleep pentru Nominatim (max 1 req/s)
    for (const r of toProcess) {
      const out = await collectOne(r.vid);
      if (out) collected.push(out);
      await sleep(1100); // Nominatim rate limit: 1 req/s
    }

    // Strategie 2 (fallback): folosim /teams?id=X care returneaza ATAT team cat si venue
    if (collected.length === 0) {
      const { rows: teams } = await query(`
        SELECT team_id, name FROM teams
        WHERE venue_id IS NULL
        ORDER BY team_id
        LIMIT $1
      `, [LIMIT]).catch(() => ({ rows: [] }));
      console.log(`[collect-venues] fallback: ${teams.length} teams fara venue_id`);
      for (const t of teams) {
        try {
          const r = await fetchApiFootball(`/teams?id=${t.team_id}`);
          const d = await r.json();
          const item = d.response?.[0];
          const v = item?.venue;
          if (!v || !v.id) continue;
          // UPDATE teams.venue_id pentru viitor
          await query(`UPDATE teams SET venue_id = $1 WHERE team_id = $2`, [v.id, t.team_id]).catch(() => {});
          const climate = climateZone(null);
          await query(`
            INSERT INTO venues (venue_id, name, address, city, country, capacity, surface, image, climate_zone, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (venue_id) DO UPDATE SET
              name = EXCLUDED.name, city = EXCLUDED.city, capacity = EXCLUDED.capacity,
              surface = EXCLUDED.surface, updated_at = NOW()
          `, [v.id, v.name || null, v.address || null, v.city || null, item.team?.country || null,
              v.capacity || null, v.surface || null, v.image || null, climate]).catch(() => {});
          collected.push({ id: v.id, name: v.name, city: v.city, team: t.name });
          await new Promise(r => setTimeout(r, 100));
        } catch (e) { /* skip */ }
      }
    }

    await query(`
      INSERT INTO cron_logs (job_name, ran_at, status, fixtures_processed)
      VALUES ('collect-venues', NOW(), 'success', $1)
    `, [collected.length]).catch(() => {});

    const { rows: totalRows } = await query(`SELECT COUNT(*)::int AS n FROM venues`).catch(() => ({ rows: [{ n: 0 }] }));

    return res.status(200).json({
      ok: true,
      missing_count: missing.length,
      collected: collected.length,
      total_venues_in_db: totalRows[0]?.n || 0,
      sample: collected.slice(0, 5),
    });
  } catch (e) {
    console.error('[collect-venues]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
