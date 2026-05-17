// api/cron/weather.js
// Colectează meteo pentru meciurile NS din următoarele 24h via Open-Meteo (gratuit, fără key)
// Rulează la fiecare 3 ore: 0 */3 * * *

import { query } from '../db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function weatherCondition(code) {
  if (code === 0) return 'clear';
  if ([1, 2, 3].includes(code)) return 'cloudy';
  if ([51, 53, 55, 61, 63, 65].includes(code)) return 'rain';
  if ([71, 73, 75, 77].includes(code)) return 'snow';
  if ([80, 81, 82].includes(code)) return 'showers';
  if ([95, 96, 99].includes(code)) return 'storm';
  return 'cloudy';
}

function computeImpact(condition, windSpeed, temperature) {
  const wsp = windSpeed  ?? 0;
  const tmp = temperature ?? 15;

  let impact = 'neutral';
  if (['storm', 'snow'].includes(condition))                         impact = 'severe';
  else if (['rain', 'showers'].includes(condition) && wsp > 30)     impact = 'high';
  else if (['rain', 'showers'].includes(condition))                  impact = 'moderate';
  else if (tmp < 2)                                                  impact = 'cold';
  else if (tmp > 32)                                                 impact = 'hot';

  let over25 = 0;
  if      (condition === 'storm')                                       over25 = -15;
  else if (condition === 'snow')                                        over25 = -20;
  else if (['rain', 'showers'].includes(condition) && wsp > 30)        over25 = -10;
  else if (['rain', 'showers'].includes(condition))                     over25 = -5;
  else if (tmp < 2)                                                     over25 = -8;
  else if (tmp > 32)                                                    over25 = -5;
  else if (condition === 'clear')                                       over25 = 3;

  let corners = 0;
  if (['storm', 'snow'].includes(condition))                         corners = -20;
  else if (['rain', 'showers'].includes(condition) && wsp > 30)     corners = -15;
  else if (wsp > 40)                                                 corners = -10;

  let cards = 0;
  if (tmp < 5)               cards = 10;
  if (condition === 'storm') cards = 15;

  return { impact, over25, corners, cards };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const start = Date.now();

  try {
    // ── Creare tabele (idempotent) ────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS venue_weather (
        fixture_id           INTEGER PRIMARY KEY,
        venue_city           VARCHAR(200),
        venue_lat            DECIMAL(9,6),
        venue_lng            DECIMAL(9,6),
        match_date           TIMESTAMP,
        temperature          DECIMAL(5,2),
        feels_like           DECIMAL(5,2),
        precipitation        DECIMAL(5,2),
        wind_speed           DECIMAL(5,2),
        wind_direction       INTEGER,
        humidity             INTEGER,
        weather_code         INTEGER,
        weather_condition    VARCHAR(50),
        weather_impact       VARCHAR(20) DEFAULT 'neutral',
        impact_over25_delta  DECIMAL(5,2) DEFAULT 0,
        impact_corners_delta DECIMAL(5,2) DEFAULT 0,
        impact_cards_delta   DECIMAL(5,2) DEFAULT 0,
        fetched_at           TIMESTAMP DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS venues (
        venue_id   INTEGER PRIMARY KEY,
        venue_name VARCHAR(200),
        city       VARCHAR(200),
        country    VARCHAR(100),
        latitude   DECIMAL(9,6),
        longitude  DECIMAL(9,6),
        capacity   INTEGER,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Citește meciuri NS din următoarele 24h ────────────────────────────
    const now  = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const { rows: fixtures } = await query(`
      SELECT fixture_id, match_date
      FROM fixtures
      WHERE status_short = 'NS'
        AND match_date >= $1
        AND match_date <= $2
      ORDER BY match_date ASC
    `, [now.toISOString(), in24h.toISOString()]).catch(() => ({ rows: [] }));

    let processed = 0, skipped = 0, errors = 0;

    for (const fx of fixtures) {
      const fid = fx.fixture_id;

      // Skip dacă avem date meteo recente (< 3h)
      const { rows: ex } = await query(
        'SELECT fetched_at FROM venue_weather WHERE fixture_id = $1', [fid]
      ).catch(() => ({ rows: [] }));
      if (ex[0]?.fetched_at) {
        const ageH = (Date.now() - new Date(ex[0].fetched_at).getTime()) / 3_600_000;
        if (ageH < 3) { skipped++; continue; }
      }

      // ── Coordonate din venues table sau prematch_data ──────────────────
      let lat = null, lng = null, city = null;
      let venueId = null, venueName = null;

      // 1. Încearcă prematch_data → data_type='fixture'
      const { rows: pd } = await query(`
        SELECT payload FROM prematch_data
        WHERE fixture_id = $1 AND data_type = 'fixture'
        ORDER BY stage ASC
        LIMIT 1
      `, [fid]).catch(() => ({ rows: [] }));

      if (pd[0]?.payload) {
        const venue = pd[0].payload?.response?.[0]?.fixture?.venue;
        if (venue) {
          venueId   = venue.id   || null;
          venueName = venue.name || null;
          city      = venue.city || null;
        }
      }

      // 2. Dacă avem venue_id → caută coordonatele în venues table
      if (venueId) {
        const { rows: vr } = await query(
          'SELECT latitude, longitude, city FROM venues WHERE venue_id = $1 AND latitude IS NOT NULL',
          [venueId]
        ).catch(() => ({ rows: [] }));
        if (vr[0]?.latitude) {
          lat  = parseFloat(vr[0].latitude);
          lng  = parseFloat(vr[0].longitude);
          city = vr[0].city || city;
        }
      }

      // 3. Dacă nu avem coordonate → geocoding Open-Meteo
      if ((!lat || !lng) && city) {
        try {
          const geoR = await fetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
          );
          const geo  = await geoR.json();
          if (geo.results?.[0]) {
            lat = geo.results[0].latitude;
            lng = geo.results[0].longitude;

            // Salvează în venues pentru rulările viitoare
            if (venueId) {
              await query(`
                INSERT INTO venues (venue_id, venue_name, city, latitude, longitude, updated_at)
                VALUES ($1,$2,$3,$4,$5,NOW())
                ON CONFLICT (venue_id) DO UPDATE SET
                  latitude   = EXCLUDED.latitude,
                  longitude  = EXCLUDED.longitude,
                  updated_at = NOW()
              `, [venueId, venueName, city, lat, lng]).catch(() => {});
            }
          }
          await sleep(100);
        } catch (_) { await sleep(100); }
      }

      if (!lat || !lng) { skipped++; continue; }

      // ── Fetch Open-Meteo forecast ─────────────────────────────────────
      try {
        // Găsim ora meciului în UTC
        const matchHour = new Date(fx.match_date);
        matchHour.setMinutes(0, 0, 0, 0);
        const targetStr = matchHour.toISOString().slice(0, 16); // "2026-05-17T15:00"

        const forecastR = await fetch(
          `https://api.open-meteo.com/v1/forecast` +
          `?latitude=${lat}&longitude=${lng}` +
          `&hourly=temperature_2m,apparent_temperature,precipitation,` +
          `windspeed_10m,winddirection_10m,weathercode,relativehumidity_2m` +
          `&timezone=UTC&forecast_days=3`
        );
        const forecast = await forecastR.json();
        await sleep(100);

        const times = forecast.hourly?.time || [];
        let idx = times.findIndex(t => t >= targetStr);
        if (idx === -1) { skipped++; continue; }

        const temperature   = forecast.hourly.temperature_2m?.[idx]        ?? null;
        const feelsLike     = forecast.hourly.apparent_temperature?.[idx]   ?? null;
        const precipitation = forecast.hourly.precipitation?.[idx]          ?? null;
        const windSpeed     = forecast.hourly.windspeed_10m?.[idx]          ?? null;
        const windDir       = forecast.hourly.winddirection_10m?.[idx]      ?? null;
        const humidity      = forecast.hourly.relativehumidity_2m?.[idx]    ?? null;
        const weatherCode   = forecast.hourly.weathercode?.[idx]            ?? null;

        if (weatherCode == null) { skipped++; continue; }

        const condition = weatherCondition(weatherCode);
        const { impact, over25, corners, cards } = computeImpact(condition, windSpeed, temperature);

        await query(`
          INSERT INTO venue_weather
            (fixture_id, venue_city, venue_lat, venue_lng, match_date,
             temperature, feels_like, precipitation,
             wind_speed, wind_direction, humidity,
             weather_code, weather_condition, weather_impact,
             impact_over25_delta, impact_corners_delta, impact_cards_delta,
             fetched_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
          ON CONFLICT (fixture_id) DO UPDATE SET
            venue_city           = EXCLUDED.venue_city,
            venue_lat            = EXCLUDED.venue_lat,
            venue_lng            = EXCLUDED.venue_lng,
            temperature          = EXCLUDED.temperature,
            feels_like           = EXCLUDED.feels_like,
            precipitation        = EXCLUDED.precipitation,
            wind_speed           = EXCLUDED.wind_speed,
            wind_direction       = EXCLUDED.wind_direction,
            humidity             = EXCLUDED.humidity,
            weather_code         = EXCLUDED.weather_code,
            weather_condition    = EXCLUDED.weather_condition,
            weather_impact       = EXCLUDED.weather_impact,
            impact_over25_delta  = EXCLUDED.impact_over25_delta,
            impact_corners_delta = EXCLUDED.impact_corners_delta,
            impact_cards_delta   = EXCLUDED.impact_cards_delta,
            fetched_at           = NOW()
        `, [
          fid, city, lat, lng, fx.match_date,
          temperature, feelsLike, precipitation,
          windSpeed, windDir != null ? Math.round(windDir) : null, humidity != null ? Math.round(humidity) : null,
          weatherCode, condition, impact,
          over25, corners, cards,
        ]);

        processed++;
      } catch (_) { errors++; await sleep(100); }
    }

    return res.status(200).json({
      ok:             true,
      duration_ms:    Date.now() - start,
      total_fixtures: fixtures.length,
      processed,
      skipped,
      errors,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
