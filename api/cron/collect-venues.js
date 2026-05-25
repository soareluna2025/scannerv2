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

// Geocodare oras/tara → lat/lng via Open-Meteo Geocoding (acelasi provider ca weather+elevation)
// Fara cheie API, fara rate limit strict (vs Nominatim care blocheaza IP-uri)
async function geocodeCity(city, country) {
  if (!city) return null;
  try {
    const q = encodeURIComponent(city);
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=5&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await res.json();
    if (!d.results?.length) return null;
    // Incearca sa potriveasca tara daca avem mai multe rezultate
    let result = d.results[0];
    if (country && d.results.length > 1) {
      const match = d.results.find(r =>
        r.country?.toLowerCase() === country.toLowerCase() ||
        r.country_code?.toLowerCase() === country.slice(0, 2).toLowerCase()
      );
      if (match) result = match;
    }
    return { lat: result.latitude, lng: result.longitude };
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

    // Grupeaza venues pe oras unic
    const cityGroups = new Map();
    for (const r of toProcess) {
      const key = `${r.city}|${r.country ?? ''}`;
      if (!cityGroups.has(key)) cityGroups.set(key, []);
      cityGroups.get(key).push(r);
    }
    console.log(`[collect-venues] ${toProcess.length} venues, ${cityGroups.size} orase unice`);

    const collected = [];

    // Per oras unic: geocodare (1 apel Nominatim) + elevation (1 apel) + UPDATE imediat toate venues din oras
    for (const [key, venues] of cityGroups) {
      const [city, country] = key.split('|');
      const coords = await geocodeCity(city, country);
      await sleep(150); // Open-Meteo geocoding — fara rate limit strict

      if (!coords) {
        console.warn(`[collect-venues] geocodare esec: ${city} (${country})`);
        continue;
      }

      const { lat, lng } = coords;
      const elevArr = await getAltitudeBatch([{ lat, lng }]);
      const altitude = elevArr[0] ?? 0;
      const climate = climateZone(lat);

      for (const v of venues) {
        try {
          await query(`
            UPDATE venues
            SET latitude = $1, longitude = $2, altitude_m = $3, climate_zone = $4, updated_at = NOW()
            WHERE venue_id = $5
          `, [lat, lng, altitude, climate, v.vid]);
          collected.push({ id: v.vid, city, altitude });
        } catch (e) {
          console.warn(`[collect-venues] UPDATE esec venue ${v.vid}:`, e.message);
        }
      }
      console.log(`[collect-venues] ${city}: alt=${altitude}m → ${venues.length} venues actualizate`);
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
      estimated_minutes: Math.ceil((Math.min(LIMIT, pending[0]?.n || LIMIT) * 0.5 * 1.1) / 60) + 1,
      message: 'Procesare in background. Verifica cron_logs sau venues WHERE altitude_m IS NOT NULL.',
    });

    // Fire-and-forget: proceseaza in background fara sa blocheze raspunsul
    setImmediate(() => processVenues(LIMIT).catch(e => console.error('[collect-venues]', e.message)));
  } catch (e) {
    console.error('[collect-venues]', e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
}
