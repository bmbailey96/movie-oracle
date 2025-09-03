// pages/api/trakt-user.js
const TRAKT = "https://api.trakt.tv";

async function get(path, token) {
  const r = await fetch(`${TRAKT}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": process.env.TRAKT_CLIENT_ID,
      "Authorization": `Bearer ${token}`
    },
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}

export default async function handler(req, res) {
  try {
    const { user, token } = req.method === "GET" ? req.query : (req.body || {});
    if (!user) return res.status(400).json({ error: "Missing user" });
    if (!token) return res.status(400).json({ error: "Missing token" });

    // Ratings (movies) – each item has .movie with ids.imdb/tmdb, and a .rating (1–10)
    const ratings = await get(`/users/${user}/ratings/movies`, token).catch(()=>[]);
    // History (watched movies)
    const history = await get(`/users/${user}/history/movies`, token).catch(()=>[]);
    // Watchlist (movies)
    const watchlist = await get(`/users/${user}/watchlist/movies`, token).catch(()=>[]);

    return res.status(200).json({ ratings, history, watchlist });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
