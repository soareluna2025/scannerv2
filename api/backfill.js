// api/backfill.js — Season-first backfill (2026→2022)
// Per-fixture: statistics + events + players
// Persistent state in app_settings (resume after VPS restart)

import { query } from './db.js';
import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { calcPlayerScore } from './calc-utils.js';
import { fetchApiFootball } from './utils/fetch-api.js';
import { isAllowedLeague } from './utils/league-filter.js';

const SEASONS    = [2026, 2025, 2024, 2023, 2022];
const LEAGUE_IDS = [...ALLOWED_LEAGUE_IDS];
const BASE_URL   = 'https://v3.football.api-sports.io';
const DELAY_MS   = 250;
const STOP_AT    = 280_000; // Plan 300k/zi — buffer 20k pentru live scanner
