export default async function handler(req, res) {
  const fdKey = process.env.FOOTBALL_DATA_KEY;
  const afKey = process.env.API_FOOTBALL_KEY;
  const bsdKey = process.env.BSD_KEY;

  const [fdRes, afRes, bsdRes] = await Promise.allSettled([
    fdKey
      ? fetch('https://api.football-data.org/v4/matches?status=LIVE', { headers: { 'X-Auth-Token': fdKey } }).then(r => r.json())
      : Promise.resolve({}),
    afKey
      ? fetch('https://v3.football.api-sports.io/fixtures?live=all', { headers: { 'x-apisports-key': afKey } }).then(r => r.json())
      : Promise.resolve({}),
    bsdKey
      ? fetch('https://sports.bzzoiro.com/api/live/', { headers: { 'Authorization': 'Token ' + bsdKey } }).then(r => r.json())
      : Promise.resolve({})
  ]);

  // Parse football-data.org
  const fdMatches = (fdRes.status === 'fulfilled' && !fdRes.value.errorCode && Array.isArray(fdRes.value.matches))
    ? fdRes.value.matches.map(m => ({
        _src: 'fd',
        fixture: { status: { elapsed: m.minute || 0 } },
        league: { id: m.competition.id, name: m.competition.name, f: m.competition.code || '?', logo: m.competition.emblem || '' },
        teams: {
          home: { name: m.homeTeam.shortName || m.homeTeam.name, logo: m.homeTeam.crest || '' },
          away: { name: m.awayTeam.shortName || m.awayTeam.name, logo: m.awayTeam.crest || '' }
        },
        goals: {
          home: m.score.fullTime.home ?? m.score.halfTime.home ?? 0,
          away: m.score.fullTime.away ?? m.score.halfTime.away ?? 0
        },
        statistics: []
      }))
    : [];

  // Parse api-sports.io (includes live statistics)
  const afMatches = (afRes.status === 'fulfilled' && Array.isArray(afRes.value.response))
    ? afRes.value.response : [];

  // Parse BSD
  const bsdRaw = bsdRes.status === 'fulfilled' ? bsdRes.value : {};
  const bsdList = Array.isArray(bsdRaw) ? bsdRaw : (bsdRaw.results || bsdRaw.matches || bsdRaw.response || []);
  const bsdMatches = bsdList.flatMap(m => {
    const hn = m.home_team?.name || m.homeTeam?.name || m.home?.name || '';
    const an = m.away_team?.name || m.awayTeam?.name || m.away?.name || '';
    if (!hn || !an) return [];
    return [{
      _src: 'bsd',
      fixture: { status: { elapsed: m.minute || m.elapsed || m.time || 0 } },
      league: {
        id: m.league?.id || m.competition?.id || 0,
        name: m.league?.name || m.competition?.name || '-',
        f: m.league?.code || m.competition?.code || '🌐',
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
      statistics: []
    }];
  });

  const combined = [];
  const seen = new Set();

  // 1. api-sports.io — prioritate maximă: are statistici live (xG, șuturi, atacuri)
  afMatches.forEach(m => {
    const key = (m.teams?.home?.name || '') + '|' + (m.teams?.away?.name || '');
    if (key === '|') return;
    if (!seen.has(key)) { seen.add(key); combined.push(m); }
  });

  // 2. football-data.org — adaugă meciuri unice (top ligi, real-time, fără statistici)
  fdMatches.forEach(m => {
    const key = m.teams.home.name + '|' + m.teams.away.name;
    if (!seen.has(key)) { seen.add(key); combined.push(m); }
  });

  // 3. BSD — acoperire suplimentară pentru meciuri rămase
  bsdMatches.forEach(m => {
    const key = m.teams.home.name + '|' + m.teams.away.name;
    if (!seen.has(key)) { seen.add(key); combined.push(m); }
  });

  res.status(200).json({ response: combined });
}
