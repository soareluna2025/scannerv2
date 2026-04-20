export default async function handler(req, res) {
  const fdKey = process.env.FOOTBALL_DATA_KEY;
  const afKey = process.env.API_FOOTBALL_KEY;
  const combined = [];

  // football-data.org - real-time, top 12 competitions
  if (fdKey) {
    try {
      const r = await fetch('https://api.football-data.org/v4/matches?status=LIVE', {
        headers: { 'X-Auth-Token': fdKey }
      });
      const data = await r.json();
      if (!data.errorCode && Array.isArray(data.matches)) {
        data.matches.forEach(m => {
          combined.push({
            _src: 'fd',
            fixture: { status: { elapsed: m.minute || 0 } },
            league: { id: m.competition.id, name: m.competition.name, f: m.competition.code || '?', logo: m.competition.emblem || '' },
            teams: {
              home: { name: m.homeTeam.shortName || m.homeTeam.name, logo: m.homeTeam.crest || '' },
              away: { name: m.awayTeam.shortName || m.awayTeam.name, logo: m.awayTeam.crest || '' }
            },
            goals: {
              home: m.score.fullTime.home !== null ? m.score.fullTime.home : 0,
              away: m.score.fullTime.away !== null ? m.score.fullTime.away : 0
            },
            statistics: []
          });
        });
      }
    } catch (e) {}
  }

  // api-sports.io - 88 leagues (with delay for free tier)
  if (afKey) {
    try {
      const r = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
        headers: { 'x-apisports-key': afKey }
      });
      const data = await r.json();
      if (Array.isArray(data.response)) {
        // Add only matches not already covered by football-data.org
        const fdNames = new Set(combined.map(m => m.teams.home.name + '|' + m.teams.away.name));
        data.response.forEach(m => {
          const key = (m.teams?.home?.name || '') + '|' + (m.teams?.away?.name || '');
          if (!fdNames.has(key)) combined.push(m);
        });
      }
    } catch (e) {}
  }

  // sports.bzzoiro.com (BSD) - real-time live scores
  const bsdKey = process.env.BSD_KEY;
  if (bsdKey) {
    try {
      const r = await fetch('https://sports.bzzoiro.com/api/live/', {
        headers: { 'Authorization': 'Token ' + bsdKey }
      });
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.results || data.matches || data.response || []);
      const existingNames = new Set(combined.map(m => m.teams.home.name + '|' + m.teams.away.name));
      list.forEach(m => {
        const hn = m.home_team?.name || m.homeTeam?.name || m.home?.name || '';
        const an = m.away_team?.name || m.awayTeam?.name || m.away?.name || '';
        if (!hn || !an) return;
        const key = hn + '|' + an;
        if (existingNames.has(key)) return;
        existingNames.add(key);
        combined.push({
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
        });
      });
    } catch (e) {}
  }

  res.status(200).json({ response: combined });
}
