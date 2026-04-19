export default async function handler(req, res) {
  const API_KEY = process.env.API_FOOTBALL_KEY;

  try {
    const r = await fetch(
      "https://v3.football.api-sports.io/fixtures?live=all",
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    const data = await r.json();

    res.status(200).json(data);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
