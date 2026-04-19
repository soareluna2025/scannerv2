export default async function handler(req, res) {
  const API_KEY = process.env.API_KEY;

  try {
    const r = await fetch(
      "https://api-football.com/v3/fixtures?live=all",
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
