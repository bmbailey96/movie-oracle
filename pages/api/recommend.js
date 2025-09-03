// pages/api/recommend.js — DIAGNOSTIC MODE (GET + POST)
// After we confirm visibility, we’ll switch back to the recommender.

import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";

function cleanUser(u="") {
  return (u || "").trim().replace(/^@/, "").replace(/^\/+|\/+$/g, "");
}

async function fetchRaw(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, cache: "no-store" });
    const text = await r.text();
    return { ok: r.ok, status: r.status, url, text };
  } catch (e) {
    return { ok: false, status: -1, url, text: String(e) };
  }
}

function snip(s, n=200) {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").slice(0, n);
  return t + (s.length > n ? "..." : "");
}

function countRatings(html) {
  const $ = cheerio.load(html);
  const a = $("li.film-detail").length;
  const b = $("ul.poster-list li").length;
  return a + b;
}
function countDiary(html) {
  const $ = cheerio.load(html);
  return $(".diary-entry-title a").length;
}
function countWatchlist(html) {
  const $ = cheerio.load(html);
  return $("ul.poster-list li div.poster a, ul.poster-list li a").length;
}

async function runDiagnostic(user) {
  const urls = {
    ratings1: `https://letterboxd.com/${user}/films/ratings/`,
    ratings2: `https://letterboxd.com/${user}/films/ratings/page/2/`,
    diaryRSS: `https://letterboxd.com/${user}/rss`,
    diaryHTML1: `https://letterboxd.com/${user}/films/diary/`,
    diaryHTML2: `https://letterboxd.com/${user}/films/diary/page/2/`,
    watchlist1: `https://letterboxd.com/${user}/watchlist/`,
    watchlist2: `https://letterboxd.com/${user}/watchlist/page/2/`
  };

  const results = {};
  for (const [k, u] of Object.entries(urls)) results[k] = await fetchRaw(u);

  const lines = [
    `User: ${user}`,
    "",
    "RATINGS:",
    `- page 1: status ${results.ratings1.status} | items: ${results.ratings1.ok ? countRatings(results.ratings1.text) : 0}`,
    `  snippet: ${snip(results.ratings1.text)}`,
    `- page 2: status ${results.ratings2.status} | items: ${results.ratings2.ok ? countRatings(results.ratings2.text) : 0}`,
    "",
    "DIARY:",
    `- RSS:    status ${results.diaryRSS.status}`,
    `  snippet: ${snip(results.diaryRSS.text)}`,
    `- HTML 1: status ${results.diaryHTML1.status} | items: ${results.diaryHTML1.ok ? countDiary(results.diaryHTML1.text) : 0}`,
    `  snippet: ${snip(results.diaryHTML1.text)}`,
    `- HTML 2: status ${results.diaryHTML2.status} | items: ${results.diaryHTML2.ok ? countDiary(results.diaryHTML2.text) : 0}`,
    "",
    "WATCHLIST:",
    `- page 1: status ${results.watchlist1.status} | items: ${results.watchlist1.ok ? countWatchlist(results.watchlist1.text) : 0}`,
    `  snippet: ${snip(results.watchlist1.text)}`,
    `- page 2: status ${results.watchlist2.status} | items: ${results.watchlist2.ok ? countWatchlist(results.watchlist2.text) : 0}`,
    "",
    "Interpretation:",
    "- If ratings pages show 404 here but open fine in an incognito browser, set Letterboxd Settings → Privacy → Display film ratings = Everyone.",
    "- If watchlist shows 404/0 here but you see it when logged in, set Watchlist = Public.",
    "- If everything here is 403/empty but opens fine in your browser, Letterboxd is blocking your Vercel server IP — I’ll give you a tiny proxy patch next."
  ].join("\n");

  return lines;
}

export default async function handler(req, res) {
  const method = req.method || "GET";
  try {
    // Accept both GET (query param) and POST (JSON body)
    const rawUser = method === "GET" ? req.query.user : (req.body?.user ?? "");
    const user = cleanUser(rawUser);
    if (!user) {
      res.setHeader("Content-Type","text/plain; charset=utf-8");
      return res.status(200).send("Usage:\nGET  /api/recommend?user=YOURNAME  → shows Letterboxd visibility report\nPOST /api/recommend {user, ...}    → (diagnostic mode right now)");
    }
    const diag = await runDiagnostic(user);
    res.setHeader("Content-Type","text/plain; charset=utf-8");
    return res.status(200).send(diag);
  } catch (e) {
    res.setHeader("Content-Type","text/plain; charset=utf-8");
    return res.status(500).send(`Error: ${e.message}`);
  }
}
