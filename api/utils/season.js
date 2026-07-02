// api/utils/season.js — Helper PARTAJAT de sezon DINAMIC per ligă.
// Înlocuiește formula globală europeană (getMonth()>=6 ? year : year-1) care
// dădea 2025 în mai 2026 → ligile pe an calendaristic (Brazil 71, MLS 253,
// Norway 103) nu primeau niciodată sezonul curent.
//
// Sursa adevărului: /leagues?id={id} → seasons[].current==true → year.
// Cache per league_id pe durata procesului (un singur fetch/ligă/rulare).
// Fallback (API down): formula veche, cu AVERTISMENT în log.
//
// Calea DINAMICĂ (seasonForLeague/seasonForTeam, cu API) = scripturi de COLECTARE.
// Calea STATICĂ (seasonForDate) = helper partajat pt calculul anului (enrich/
// standings/league-stats). NICIUNA nu atinge scoring-ul (score1-7/Lambda/MonteCarlo).

import { fetchApiFootball } from './fetch-api.js';
import { query } from '../db.js';

// Sezon STATIC unificat pentru o dată dată. Cutoff pe AUGUST (getMonth()>=7 →
// anul curent; altfel anul-1): majoritatea ligilor europene încep în august, iar
// ligile pe an calendaristic sunt tratate de calea DINAMICĂ (seasonForLeague).
// Sursă UNICĂ de adevăr pt calculul static al anului de sezon — folosită și de
// enrich.js / standings-data.js / league-stats.js ca să NU mai diveargă cutoff-ul.
export function seasonForDate(date = new Date()) {
  const d = (date instanceof Date) ? date : new Date(date);
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

// Formula europeană — fallback de ultimă instanță al căii dinamice. Delegă la
// seasonForDate (cutoff august unificat) ca să nu existe două cutoff-uri diferite.
export function fallbackSeason() {
  return seasonForDate();
}

const _leagueSeasonCache = new Map(); // league_id → year
const _teamLeagueCache   = new Map(); // team_id   → league_id

// Sezon CURENT pentru o ligă (dinamic). Cache pe proces.
export async function seasonForLeague(leagueId) {
  if (leagueId == null) return fallbackSeason();
  const key = Number(leagueId);
  if (_leagueSeasonCache.has(key)) return _leagueSeasonCache.get(key);
  let season;
  try {
    const r = await fetchApiFootball(`/leagues?id=${key}`);
    const d = await r.json();
    const lg = (d.response || [])[0];
    const cur = (lg?.seasons || []).find(s => s.current === true);
    season = cur ? cur.year
      : (lg?.seasons || []).reduce((mx, s) => Math.max(mx, s.year || 0), 0) || null;
    if (!season) {
      season = fallbackSeason();
      console.warn(`[season] liga ${key}: niciun seasons.current din API → fallback ${season}`);
    }
  } catch (e) {
    season = fallbackSeason();
    console.warn(`[season] liga ${key}: API eroare (${e.message}) → fallback ${season}`);
  }
  _leagueSeasonCache.set(key, season);
  return season;
}

// Liga „principală" a unei echipe (pentru scripturile care iterează pe team_id).
// Sursa: standings (sezonul cel mai recent) → fallback fixtures recente.
async function leagueForTeam(teamId) {
  if (teamId == null) return null;
  const key = Number(teamId);
  if (_teamLeagueCache.has(key)) return _teamLeagueCache.get(key);
  let leagueId = null;
  try {
    const r = await query(
      `SELECT league_id FROM standings WHERE team_id=$1
       ORDER BY season DESC LIMIT 1`, [key]);
    leagueId = r.rows[0]?.league_id ?? null;
    if (leagueId == null) {
      const f = await query(
        `SELECT league_id FROM fixtures
         WHERE (home_team_id=$1 OR away_team_id=$1) AND league_id IS NOT NULL
         ORDER BY match_date DESC LIMIT 1`, [key]);
      leagueId = f.rows[0]?.league_id ?? null;
    }
  } catch (_) { leagueId = null; }
  _teamLeagueCache.set(key, leagueId);
  return leagueId;
}

// Sezon CURENT pentru o echipă (rezolvă liga ei → sezonul dinamic al ligii).
export async function seasonForTeam(teamId) {
  const lid = await leagueForTeam(teamId);
  if (lid == null) {
    const fb = fallbackSeason();
    console.warn(`[season] team ${teamId}: ligă necunoscută → fallback ${fb}`);
    return fb;
  }
  return seasonForLeague(lid);
}
