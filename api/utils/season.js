// api/utils/season.js — Helper PARTAJAT de sezon DINAMIC per ligă.
// Înlocuiește formula globală europeană (getMonth()>=6 ? year : year-1) care
// dădea 2025 în mai 2026 → ligile pe an calendaristic (Brazil 71, MLS 253,
// Norway 103) nu primeau niciodată sezonul curent.
//
// Sursa adevărului: /leagues?id={id} → seasons[].current==true → year.
// Cache per league_id pe durata procesului (un singur fetch/ligă/rulare).
// Fallback (API down): formula veche, cu AVERTISMENT în log.
//
// Folosit DOAR de scripturile de COLECTARE. NU atinge enrich/scoring.

import { fetchApiFootball } from './fetch-api.js';
import { query } from '../db.js';

// Formula europeană veche — păstrată DOAR ca fallback de ultimă instanță.
export function fallbackSeason() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
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
