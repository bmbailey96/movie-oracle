import * as cheerio from "cheerio";
import OpenAI from "openai";

const TMDB = "https://api.themoviedb.org/3";
const TMDB_KEY = process.env.TMDB_API_KEY;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!r.ok) return "";
  return await r.text();
}

// ----- RATINGS -----
async function readRatings(user) {
  const results = [];
  for (let p = 1; p <= 6; p++) {
    const html = await fetchText(`https://letterboxd.com/${user}/films/ratings/page/${p}/`);
    if (!html) break;
    const $ = cheerio.load(html);

    $("li.film-detail").each((_, li) => {
      const name = $(li).find(".headline-2 a").first().text().trim();
      const yr = $(li).find(".headline-2 .metadata").text().trim().match(/\d{4}/)?.[0];
      const classes = ($(li).find(".rating").attr("class") || "");
      const m = classes.match(/rated-(\d+)/);
      const stars = m ? (parseInt(m[1], 10) / 10) : 0;
      if (name) results.push({ name, year: yr, stars });
    });

    $("ul.poster-list li").each((_, li) => {
      const a = $(li).find("a").first();
      const name = a.attr("data-film-name") || a.attr("aria-label") || "";
      const yr = a.attr("data-film-release-year") || "";
      const ratingEl = $(li).find("span.rating").attr("class") || $(li).attr("class") || "";
      const m = ratingEl.match(/rated-(\d+)/);
      const stars = m ? (parseInt(m[1], 10) / 10) : 0;
      if (name) results.push({ name, year: yr, stars });
    });

    if ($("li.film-detail").length === 0 && $("ul.poster-list li").length === 0) break;
  }
  const key = (r) => `${r.name}~${r.year}~${r.stars}`;
  const map = new Map(results.map(r => [key(r), r]));
  return Array.from(map.values());
}

// ----- DIARY RSS -----
async function readDiaryRSS(user) {
  const xml = await fetchText(`https://letterboxd.com/${user}/rss`);
  if (!xml) return [];
  const items = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map(m => m[1]).slice(1);
  const out = [];
  for (const t of items.slice(0, 200)) {
    const m = t.match(/(.+?) \((\d{4})\)/);
    if (m) out.push({ name: m[1], year: m[2] });
  }
  return out;
}

// ----- DIARY HTML FALLBACK -----
async function readDiaryHTML(user) {
  const out = [];
  for (let p = 1; p <= 5; p++) {
    const url = p === 1
      ? `https://letterboxd.com/${user}/films/diary/`
      : `https://letterboxd.com/${user}/films/diary/page/${p}/`;
    const html = await fetchText(url);
    if (!html) break;
    const $ = cheerio.load(html);
    $(".diary-entry-title a").each((_, a) => {
      const name = $(a).text().trim();
      const year = ($(a).next(".diary-entry-year").text().trim().match(/\d{4}/) || [null])[0];
      if (name) out.push({ name, year });
    });
    if ($(".diary-entry-title a").length === 0) break;
  }
  const map = new Map(out.map(f => [`${f.name}~${f.year}`, f]));
  return Array.from(map.values());
}

// ----- WATCHLIST -----
async function readWatchlist(user) {
  const out = [];
  for (let p = 1; p <= 5; p++) {
    const url = p === 1
      ? `https://letterboxd.com/${user}/watchlist/`
      : `https://letterboxd.com/${user}/watchlist/page/${p}/`;
    const html = await fetchText(url);
    if (!html) break;
    const $ = cheerio.load(html);
    const posters = $("ul.poster-list li div.poster a, ul.poster-list li a").toArray();
    if (!posters.length && p === 1) break;
    for (const a of posters) {
      const name = $(a).attr("data-film-name") || $(a).attr("aria-label") || "";
      const year = $(a).attr("data-film-release-year") || "";
      if (name) out.push({ name, year });
    }
    if (posters.length < 18) break;
  }
  const map = new Map(out.map(f => [`${f.name}~${f.year}`, f]));
  return Array.from(map.values());
}

// ----- TMDb -----
async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return {};
  return await r.json();
}
async function tmdbSearch(title, year) {
  const data = await tmdb("/search/movie", year ? { query: title, year } : { query: title });
  return (data.results || [])[0];
}
async function tmdbDetails(id) {
  const [d, kw, cr] = await Promise.all([
    tmdb(`/movie/${id}`, { language: "en-US" }),
    tmdb(`/movie/${id}/keywords`),
    tmdb(`/movie/${id}/credits`)
  ]);
  d.keywords_full = kw.keywords || [];
  d.credits = cr || {};
  return d;
}
async function tmdbProviders(id, region = "US") {
  const data = await tmdb(`/movie/${id}/watch/providers`);
  const r = (data.results || {})[region] || {};
  const names = [];
  for (const k of ["flatrate","ads","rent","buy"]) {
    for (const it of (r[k] || [])) names.push(k === "flatrate" ? it.provider_name : `${it.provider_name} (${k})`);
  }
  return [...new Set(names)];
}

// ----- AI -----
function makeFingerprint(meta) {
  const genres = (meta.genres || []).map(g => g.name).join(" ");
  const kw = (meta.keywords_full || []).map(k => k.name).join(" ");
  const cast = (meta.credits?.cast || []).slice(0,8).map(c => c.name).join(" ");
  const crew = (meta.credits?.crew || []).filter(c => ["Director","Writer"].includes(c.job)).map(c => c.name).join(" ");
  const overview = meta.overview || "";
  return `${meta.title} ${genres} ${kw} ${cast} ${crew} ${overview}`.toLowerCase();
}
async function embed(texts) {
  const resp = await openai.embeddings.create({ model: "text-embedding-3-small", input: texts });
  return resp.data.map(d => d.embedding);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

// ----- MAIN API HANDLER -----
export default async function handler(req, res) {
  try {
    const { user, mode = "watchlist", onlyFlatrate = true } = req.body || {};
    if (!user) return res.status(400).send("Need a username.");

    // read ratings + diary (RSS, then HTML fallback)
    let ratings = await readRatings(user).catch(()=>[]);
    let diary = await readDiaryRSS(user).catch(()=>[]);
    if (!diary.length) diary = await readDiaryHTML(user).catch(()=>[]);
    const watchlist = await readWatchlist(user).catch(()=>[]);

    if (!ratings.length && !diary.length && !watchlist.length) {
      return res.status(400).send("Could not read any data for this username (check spelling or privacy).");
    }

    // for simplicity: just show how many we found
    const info = `Ratings: ${ratings.length} | Diary: ${diary.length} | Watchlist: ${watchlist.length}`;
    return res.status(200).send(info);

  } catch (e) {
    return res.status(500).send(`Error: ${e.message}`);
  }
}
