import * as cheerio from "cheerio";
import OpenAI from "openai";

const TMDB = "https://api.themoviedb.org/3";
const TMDB_KEY = process.env.TMDB_API_KEY;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- helpers ---
async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} ${r.status}`);
  return await r.text();
}

// Letterboxd public data (no login): diary RSS, ratings pages, watchlist pages
async function readDiaryRSS(user) {
  const xml = await fetchText(`https://letterboxd.com/${user}/rss`);
  const items = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map(m => m[1]).slice(1); // skip feed title
  const out = [];
  for (const t of items.slice(0, 400)) {
    const m = t.match(/(.+?) \((\d{4})\)/);
    if (m) out.push({ name: m[1], year: m[2] });
  }
  return out;
}

async function readRatings(user) {
  const results = [];
  for (let p = 1; p <= 4; p++) {
    const html = await fetchText(`https://letterboxd.com/${user}/films/ratings/page/${p}/`).catch(()=> "");
    if (!html) break;
    const $ = cheerio.load(html);
    const items = $("li.film-detail").toArray();
    if (items.length === 0) break;
    for (const li of items) {
      const name = $(li).find(".headline-2 a").first().text().trim();
      const yr = $(li).find(".headline-2 .metadata").text().trim().match(/\d{4}/)?.[0];
      const classes = ($(li).find(".rating").attr("class") || "");
      const m = classes.match(/rated-(\d+)/);
      const stars = m ? (parseInt(m[1], 10) / 10) : 0;
      if (name) results.push({ name, year: yr, stars });
    }
  }
  return results;
}

async function readWatchlist(user) {
  const out = [];
  for (let p = 1; p <= 3; p++) {
    const url = p === 1
      ? `https://letterboxd.com/${user}/watchlist/`
      : `https://letterboxd.com/${user}/watchlist/page/${p}/`;
    const html = await fetchText(url).catch(()=> "");
    if (!html) break;
    const $ = cheerio.load(html);
    const posters = $("ul.poster-list li div.poster a").toArray();
    if (!posters.length) break;
    for (const a of posters) {
      const name = $(a).attr("data-film-name") || $(a).attr("aria-label") || "";
      const year = $(a).attr("data-film-release-year") || "";
      if (name) out.push({ name, year });
    }
  }
  return out;
}

// TMDb helpers
async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`TMDb ${path} ${r.status}`);
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
  d.keywords_full = (kw.keywords || []);
  d.credits = cr || {};
  return d;
}
async function tmdbRecsFromLiked(likedIds, maxPer = 5) {
  const out = [];
  for (const id of likedIds.slice(0, 20)) {
    const data = await tmdb(`/movie/${id}/recommendations`, { page: 1 });
    for (const it of (data.results || []).slice(0, maxPer)) out.push(it.id);
  }
  return [...new Set(out)];
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

// AI embeddings
function makeFingerprint(meta) {
  const genres = (meta.genres || []).map(g => g.name).join(" ");
  const kw = (meta.keywords_full || []).map(k => k.name).join(" ");
  const cast = (meta.credits?.cast || []).slice(0,8).map(c => c.name).join(" ");
  const crew = (meta.credits?.crew || []).filter(c => ["Director","Writer"].includes(c.job)).map(c => c.name).join(" ");
  const overview = meta.overview || "";
  return `${meta.title} ${genres} ${kw} ${cast} ${crew} ${overview}`.toLowerCase();
}
async function embed(texts) {
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts
  });
  return resp.data.map(d => d.embedding);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

// API route
export default async function handler(req, res) {
  try {
    const { user, mode = "watchlist", onlyFlatrate = true } = req.body || {};
    if (!user) return res.status(400).send("Need a username.");
    if (!TMDB_KEY || !process.env.OPENAI_API_KEY) return res.status(500).send("Server missing API keys.");

    // 1) ingest taste
    const [ratings, diary] = await Promise.all([
      readRatings(user).catch(()=>[]),
      readDiaryRSS(user).catch(()=>[])
    ]);
    if (!ratings.length && !diary.length) return res.status(400).send("Could not read your ratings/diary (check username or privacy).");

    // liked seeds from ratings (≥4★)
    const liked = ratings.filter(r => r.stars >= 4).slice(0, 200);
    const likedIds = [];
    for (const r of liked.slice(0, 60)) {
      const hit = await tmdbSearch(r.name, r.year);
      if (hit?.id) likedIds.push(hit.id);
    }

    // 2) candidates (watchlist, or graph recs from liked)
    let candidates = [];
    if (mode === "watchlist") {
      const wl = await readWatchlist(user);
      if (!wl.length) return res.status(400).send("Watchlist not accessible (set it to public or try AI mode).");
      for (const w of wl.slice(0, 400)) {
        const hit = await tmdbSearch(w.name, w.year);
        if (hit?.id) {
          const meta = await tmdbDetails(hit.id);
          candidates.push({ id: hit.id, meta });
        }
      }
    } else {
      const recIds = await tmdbRecsFromLiked(likedIds, 5);
      for (const id of recIds.slice(0, 400)) {
        const meta = await tmdbDetails(id);
        candidates.push({ id, meta });
      }
      // if still empty, fall back to a few popular neighbors (rare)
      if (!candidates.length) {
        const pop = await tmdb("/movie/popular", { page: 1 });
        for (const it of (pop.results || []).slice(0, 60)) {
          const meta = await tmdbDetails(it.id);
          candidates.push({ id: it.id, meta });
        }
      }
    }

    if (!candidates.length) return res.status(400).send("No candidates found.");

    // 3) embed taste and candidates
    const tasteSeeds = [];
    for (const r of liked.slice(0, 40)) {
      const hit = await tmdbSearch(r.name, r.year);
      if (!hit) continue;
      const meta = await tmdbDetails(hit.id);
      tasteSeeds.push(makeFingerprint(meta));
    }
    if (!tasteSeeds.length) {
      for (const d of diary.slice(0, 40)) {
        const hit = await tmdbSearch(d.name, d.year);
        if (!hit) continue;
        const meta = await tmdbDetails(hit.id);
        tasteSeeds.push(makeFingerprint(meta));
      }
    }
    if (!tasteSeeds.length) return res.status(400).send("Not enough taste signals (rate a few films ≥4★).");

    const [userVecs, candVecs] = await Promise.all([
      embed(tasteSeeds),
      embed(candidates.map(c => makeFingerprint(c.meta)))
    ]);
    const userAvg = userVecs[0].map((_, i) => userVecs.reduce((s, v) => s + v[i], 0) / userVecs.length);

    // score + bias
    function overlapBonus(meta) {
      let bonus = 0;
      const bag = tasteSeeds.join(" ").toLowerCase();
      const directors = (meta.credits?.crew || []).filter(c => c.job === "Director").map(c => c.name);
      const cast = (meta.credits?.cast || []).slice(0, 8).map(c => c.name);
      for (const d of directors) if (bag.includes(d.toLowerCase())) bonus += 0.08;
      for (const a of cast) if (bag.includes(a.toLowerCase())) bonus += 0.02;
      return bonus;
    }
    function mainstreamPenalty(meta) {
      const votes = meta.vote_count || 0;
      const pop = meta.popularity || 0;
      return Math.max(0, Math.min(0.25, (votes/50000)*0.25 + (pop/200)*0.1));
    }

    const scored = candidates.map((c, i) => {
      const sim = cosine(userAvg, candVecs[i]);
      const score = sim + overlapBonus(c.meta) - mainstreamPenalty(c.meta);
      return { ...c, score };
    }).sort((a,b) => b.score - a.score);

    // 4) providers + filter for flatrate if requested
    const enriched = [];
    for (const s of scored.slice(0, 80)) {
      const providers = await tmdbProviders(s.id, "US");
      const show = onlyFlatrate ? providers.some(p => !/\(|rent|buy/i.test(p)) : true;
      enriched.push({ ...s, providers, show });
    }
    const visible = enriched.filter(x => x.show);
    const top = visible[0] || enriched[0];
    const alts = visible.slice(1, 8);

    function title(meta) { return `${meta.title} (${(meta.release_date || "").slice(0,4)})`; }
    const pill = p => `<span style="display:inline-block;margin-right:6px;padding:3px 8px;border:1px solid #333;border-radius:999px;font-size:12px">${p}</span>`;

    const html = `
      <div style="border:1px solid #272727;border-radius:12px;padding:14px;margin:12px 0"><b>Top Pick</b><br/>→ ${title(top.meta)}<br/>
      <span style="opacity:.8">Where to watch:</span> ${top.providers?.length ? top.providers.map(pill).join(" ") : "—"}</div>
      <div style="border:1px solid #272727;border-radius:12px;padding:14px;margin:12px 0"><b>Alternates</b><br/>
        ${alts.map((a,i)=> `<div style="opacity:.9">${i+1}. ${title(a.meta)} ${a.providers?.length? a.providers.map(pill).join(" "):""}</div>`).join("")}
      </div>
      <div style="opacity:.6;font-size:12px">We learn from your real ratings (≥4★ weighted), diary, and watchlist. Graph recs keep things adjacent to what you actually like, not just “popular”.</div>
    `;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch (e) {
    return res.status(500).send(`Error: ${e.message}`);
  }
}
