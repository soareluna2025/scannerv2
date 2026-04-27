export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);
if (req.method === ‘OPTIONS’) return res.status(200).end();

var endpoint = req.query.endpoint || ‘’;
var key = process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY || ‘’;

if (!endpoint) return res.status(400).json({ error: ‘Missing endpoint’ });
if (!key) return res.status(500).json({ error: ‘API key not configured on server’ });

var params = [];
for (var k in req.query) {
if (k !== ‘endpoint’ && k !== ‘key’) params.push(k + ‘=’ + encodeURIComponent(req.query[k]));
}

var url = ‘https://v3.football.api-sports.io/’ + endpoint;
if (params.length > 0) url += ‘?’ + params.join(’&’);

try {
var response = await fetch(url, {
headers: { ‘x-apisports-key’: key }
});
var data = await response.json();
return res.status(200).json(data);
} catch (err) {
return res.status(500).json({ error: err.message });
}
}
