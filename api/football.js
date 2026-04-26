export default async function handler(req, res) {
  const fdKey  = process.env.FOOTBALL_DATA_KEY;
  const afKey  = process.env.API_FOOTBALL_KEY;
  const bsdKey = process.env.BSD_KEY;

  // Fetch all three simultaneously, independent failures
  const [fdRes, afRes, bsdRes] = await Promise.allSettled([
    fdKey
      ? fetch('https://api.football-data.org/v4/matches?status=LIVE', {
          headers: { 'X-Auth-Token': fdKey }
        }).then(r => r.json())
      : Promise.resolve({}),
    afKey
      ? fetch('https://v3.football.api-sports.io/fixtures?live=all', {
          headers: { 'x-apisports-key': afKey }
        }).then(r => r.json())
      : Promise.resolve({}),
    bsdKey
      ? fetch('https://sports.bzzoiro.com/api/live/', {
          headers: { 'Authorization': 'Token ' + bsdKey }
        }).then(r => r.json())
      : Promise.resolve({})
  ]);

  // Normalize team name for deduplication (handles "Man Utd" vs "Manchester United")
  function norm(n) { return (n || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Live statuses for api-sports.io
  const AF_LIVE = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);

  // --- Parse football-data.org (real-time scores, top 12 leagues) ---
  // Only IN_PLAY and PAUSED are actual live statuses in this API
  const FD_LIVE = new Set(['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT']);
  const FD_SHORT = { IN_PLAY: '1H', PAUSED: 'HT', EXTRA_TIME: 'ET', PENALTY_SHOOTOUT: 'P' };

  const fdMatches = (
    fdRes.status === 'fulfilled' &&
    !fdRes.value.errorCode &&
    Array.isArray(fdRes.value.matches)
  ) ? fdRes.value.matches
      .filter(m => FD_LIVE.has(m.status))
      .map(m => ({
        _src: 'fd',
        fixture: {
          id: m.id,
          status: {
            short:   FD_SHORT[m.status] || m.status,
            elapsed: m.minute || 0
          }
        },
        league: {
          id:   m.competition.id,
          name: m.competition.name,
          f:    m.competition.code || '?',
          logo: m.competition.emblem || ''
        },
        teams: {
          home: { name: m.homeTeam.shortName || m.homeTeam.name, logo: m.homeTeam.crest || '' },
          away: { name: m.awayTeam.shortName || m.awayTeam.name, logo: m.awayTeam.crest || '' }
        },
        goals: {
          home: m.score.fullTime.home ?? m.score.halfTime.home ?? 0,
          away: m.score.fullTime.away ?? m.score.halfTime.away ?? 0
        },
        statistics: [],
        events: [],
        lineups: []
      }))
  : [];

  // --- Parse api-sports.io (statistics + 88 leagues) ---
  // ?live=all should already return only live matches; validate status.short as extra guard
  const afMatches = (
    afRes.status === 'fulfilled' &&
    Array.isArray(afRes.value.response)
  ) ? afRes.value.response.filter(m => {
        const sh = m.fixture?.status?.short || '';
        return AF_LIVE.has(sh);
      })
  : [];

  // --- Parse BSD (additional coverage) ---
  // BSD has no status field we can rely on — require elapsed > 0 as proof the match is live
  const bsdRaw  = bsdRes.status === 'fulfilled' ? bsdRes.value : {};
  const bsdList = Array.isArray(bsdRaw) ? bsdRaw : (bsdRaw.results || bsdRaw.matches || bsdRaw.response || []);
  const bsdMatches = bsdList.flatMap(m => {
    const hn = m.home_team?.name || m.homeTeam?.name || m.home?.name || '';
    const an = m.away_team?.name || m.awayTeam?.name || m.away?.name || '';
    if (!hn || !an) return [];
    const elapsed = m.minute || m.elapsed || m.time || 0;
    // Only include BSD matches that have elapsed time — proof they are in progress
    if (!elapsed || elapsed <= 0) return [];
    return [{
      _src: 'bsd',
      fixture: { status: { short: '1H', elapsed } },
      league: {
        id:   m.league?.id   || m.competition?.id   || 0,
        name: m.league?.name || m.competition?.name || '-',
        f:    m.league?.code || m.competition?.code || '🌐',
        logo: m.league?.logo || m.competition?.emblem || ''
      },
      teams: {
        home: { name: hn, logo: m.home_team?.logo || m.homeTeam?.crest || '' },
        away: { name: an, logo: m.away_team?.logo || m.awayTeam?.crest || '' }
      },
      goals: {
        home: m.home_score ?? m.score?.home ?? m.goals?.home ?? 0,
        away: m.away_score ?? m.score?.away ?? m.goals?.away ?? 0
      },
      statistics: [],
      events: [],
      lineups: []
    }];
  });

  // --- Build af lookup by normalized name (for merging statistics into fd matches) ---
  const afByNorm = new Map();
  afMatches.forEach(m => {
    const hn = norm(m.teams?.home?.name || '');
    const an = norm(m.teams?.away?.name || '');
    if (hn && an) afByNorm.set(hn + '|' + an, m);
  });

  const combined = [];
  const seen = new Set(); // normalized keys

  // 1. fd matches (real-time score) — merge af statistics if same match found
  fdMatches.forEach(m => {
    const key = norm(m.teams.home.name) + '|' + norm(m.teams.away.name);
    if (seen.has(key)) return;
    seen.add(key);

    const af = afByNorm.get(key);
    if (af) {
      // Keep fd's real-time score/minute; take af's statistics, events, lineups, team IDs
      if (af.statistics?.length)  m.statistics = af.statistics;
      if (af.events?.length)      m.events     = af.events;
      if (af.lineups?.length)     m.lineups    = af.lineups;
      if (af.teams?.home?.id)     m.teams.home.id = af.teams.home.id;
      if (af.teams?.away?.id)     m.teams.away.id = af.teams.away.id;
      // Use af's elapsed if fd has none
      if (!m.fixture.status.elapsed && af.fixture?.status?.elapsed) {
        m.fixture.status.elapsed = af.fixture.status.elapsed;
      }
    }
    combined.push(m);
  });

  // 2. af matches not already covered by fd (unique leagues, with statistics)
  afMatches.forEach(m => {
    const key = norm(m.teams?.home?.name || '') + '|' + norm(m.teams?.away?.name || '');
    if (key === '|') return;
    if (!seen.has(key)) { seen.add(key); combined.push(m); }
  });

  // 3. BSD matches not in fd or af (additional global coverage)
  bsdMatches.forEach(m => {
    const key = norm(m.teams.home.name) + '|' + norm(m.teams.away.name);
    if (!seen.has(key)) { seen.add(key); combined.push(m); }
  });

  res.status(200).json({ response: combined });
}
