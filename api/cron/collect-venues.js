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

// Colecteaza un singur venue: API-Football + Open-Elevation
async function collectOne(venueId) {
  try {
    const res = await fetchApiFootball(`/venues?id=${venueId}`);
    const d = await res.json();
    const v = d.response?.[0];
    if (!v) return null;
    // Coordinatele nu vin din /venues — vor fi NULL deocamdata
    // (Open-Elevation necesita lat/lng dar nu avem; lasam null pentru viitor)
    const lat = null, lng = null;
    let altitude = null;
    if (lat != null && lng != null) altitude = await getAltitude(lat, lng);
    const climate = climateZone(lat);
    await query(`
      INSERT INTO venues (venue_id, name, address, city, country, capacity, surface, image, altitude_m, climate_zone, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (venue_id) DO UPDATE SET
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        city = EXCLUDED.city,
        country = EXCLUDED.country,
        capacity = EXCLUDED.capacity,
        surface = EXCLUDED.surface,
        image = EXCLUDED.image,
        altitude_m = COALESCE(EXCLUDED.altitude_m, venues.altitude_m),
        climate_zone = COALESCE(EXCLUDED.climate_zone, venues.climate_zone),
        updated_at = NOW()
    `, [
      v.id, v.name || null, v.address || null, v.city || null, v.country || null,
      v.capacity || null, v.surface || null, v.image || null,
      altitude, climate,
    ]);
    return { id: v.id, name: v.name, city: v.city, altitude };
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

    // Identifica venue_id-uri din fixtures fara intrare in venues
    const { rows: missing } = await query(`
      SELECT DISTINCT venue_id AS vid
      FROM fixtures
      WHERE venue_id IS NOT NULL
        AND venue_id NOT IN (SELECT venue_id FROM venues)
      LIMIT $1
    `, [LIMIT]).catch(() => ({ rows: [] }));

    const collected = [];
    for (const r of missing) {
      const out = await collectOne(r.vid);
      if (out) collected.push(out);
      // Mini pauza intre call-uri
      await new Promise(r => setTimeout(r, 100));
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
