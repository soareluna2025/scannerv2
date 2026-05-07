const cache = new Map();
const TTL = 10 * 60 * 1000; // 10 minutes

function mapWeatherCode(code) {
  if (code <= 1)  return 'sunny';
  if (code <= 48) return 'cloudy';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  return 'rain'; // 80-99
}

function probImpact(condition) {
  switch (condition) {
    case 'rain':   return -10;
    case 'snow':   return -12;
    case 'cloudy': return -3;
    default:       return 0;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { city, country } = req.query;
  if (!city) return res.status(400).json({ error: 'Parametru city este necesar' });

  const cacheKey = `${city}|${country || ''}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    // Step 1: Geocode
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();

    const results = geoData.results;
    if (!results || !results.length) {
      return res.status(404).json({ error: `City not found: ${city}` });
    }

    const { latitude, longitude, name } = results[0];

    // Step 2: Weather
    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,precipitation,wind_speed_10m,weather_code&timezone=auto`;
    const wxRes = await fetch(wxUrl);
    const wxData = await wxRes.json();

    const current = wxData.current;
    if (!current) {
      return res.status(502).json({ error: 'Weather data unavailable' });
    }

    const weatherCode = current.weather_code ?? 0;
    const condition   = mapWeatherCode(weatherCode);
    const impact      = probImpact(condition);

    const data = {
      city:        name || city,
      temperature: current.temperature_2m ?? null,
      precipitation: current.precipitation ?? 0,
      wind:        current.wind_speed_10m ?? 0,
      weatherCode,
      condition,
      probImpact:  impact,
    };

    cache.set(cacheKey, { ts: now, data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
