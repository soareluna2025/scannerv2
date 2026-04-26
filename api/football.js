export default async function handler(req, res) {
  const fdKey = process.env.FOOTBALL_DATA_KEY;
  const afKey = process.env.API_FOOTBALL_KEY;

  // Fetch both simultaneously — BSD removed (unreliable, no verifiable live status)
  const [fdRes, afRes] = await Promise.allSettled([
    fdKey
      ? fetch('https://api.football-data.org/v4/matches?status=LIVE', {
          headers: { 'X-Auth-Token': fdKey }
        }).then(r => r.json())
      : Promise.resolve({}),
    afKey
      ? fetch('https://v3.football.api-sports.io/fixtures?live=all', {
          headers: { 'x-apisports-key': afKey }
        }).then(r => r.json())
      : Promise.resolve({})
  ]);

  function norm(n) { return (n || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // --- football-data.org: real-time, top leagues ---
  const FD_LIVE  = new Set(['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT']);
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
          status: { short: FD_SHORT[m.status] || m.status, elapsed: m.minute || 0 }
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
        statistics: [], events: [], lineups: []
      }))
  : [];

  // --- api-sports.io: statistics + wider league coverage ---
  // Free tier has ~15 min delay — require elapsed >= 1 to reduce stale finished matches
  const AF_LIVE = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
  const afMatches = (
    afRes.status === 'fulfilled' &&
    Array.isArray(afRes.value.response)
  ) ? afRes.value.response.filter(m => {
        const sh      = m.fixture?.status?.short || '';
        const elapsed = m.fixture?.status?.elapsed || 0;
        return AF_LIVE.has(sh) && elapsed >= 1;
      })
  : [];

  // Build af lookup by normalized team names
  const afByNorm = new Map();
  afMatches.forEach(m => {
    const hn = norm(m.teams?.home?.name || '');
    const an = norm(m.teams?.away?.name || '');
    if (hn && an) afByNorm.set(hn + '|' + an, m);
  });

  const combined = [];
  const seen = new Set();

  // 1. fd matches (real-time) — merge af statistics when same match found
  fdMatches.forEach(m => {
    const key = norm(m.teams.home.name) + '|' + norm(m.teams.away.name);
    if (seen.has(key)) return;
    seen.add(key);

    const af = afByNorm.get(key);
    if (af) {
      if (af.statistics?.length) m.statistics = af.statistics;
      if (af.events?.length)     m.events     = af.events;
      if (af.lineups?.length)    m.lineups    = af.lineups;
      if (af.teams?.home?.id)    m.teams.home.id = af.teams.home.id;
      if (af.teams?.away?.id)    m.teams.away.id = af.teams.away.id;
      if (!m.fixture.status.elapsed && af.fixture?.status?.elapsed) {
        m.fixture.status.elapsed = af.fixture.status.elapsed;
      }
    }
    combined.push(m);
  });

  // 2. af-only matches (leagues not covered by fd) — must have statistics to be trustworthy
  afMatches.forEach(m => {
    const key = norm(m.teams?.home?.name || '') + '|' + norm(m.teams?.away?.name || '');
    if (key === '|' || seen.has(key)) return;
    // Only include af-only matches if they have statistics — proof the match is genuinely in progress
    if (!m.statistics?.length) return;
    seen.add(key);
    combined.push(m);
  });

  res.status(200).json({ response: combined });
}
