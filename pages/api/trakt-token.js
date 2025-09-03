// pages/api/trakt-token.js
export default async function handler(req, res) {
  try {
    const { pin } = req.method === "GET" ? req.query : (req.body || {});
    if (!pin) return res.status(400).json({ error: "Missing pin" });
    const cid = process.env.TRAKT_CLIENT_ID;
    const cs = process.env.TRAKT_CLIENT_SECRET;
    if (!cid || !cs) return res.status(500).json({ error: "Missing Trakt env vars" });
    const r = await fetch("https://api.trakt.tv/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pin,
        client_id: cid,
        client_secret: cs,
        redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
        grant_type: "authorization_code"
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data?.error || "PIN exchange failed", details: data });
    // return token; store client-side in localStorage for now
    return res.status(200).json({ access_token: data.access_token, refresh_token: data.refresh_token, created_at: data.created_at, expires_in: data.expires_in });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
