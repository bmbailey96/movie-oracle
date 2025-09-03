import * as cheerio from "cheerio";
import OpenAI from "openai";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const TMDB = "https://api.themoviedb.org/3";
const TMDB_KEY = process.env.TMDB_API_KEY;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- utils ----------
function cleanUser(u=""){ return (u||"").trim().replace(/^@/, "").replace(/^\/+|\/+$/g, ""); }
function uniq(arr){ return [...new Set(arr)]; }

// Try direct fetch; if page looks empty, fall back to a mirror that returns static HTML
async function fetchLB(url) {
  // 1) direct
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language":"en-US,en;q=0.9" }, cache:"no-store" });
    const text = await r.text();
    // if it’s clearly got content, return it
    if (r.ok && text && text.length > 500 && /<html/i.test(text)) return text;
  } catch(_) {}

  // 2) fallback mirror (read-only)
  // example: https://r.jina.ai/http://letterboxd.com/USER/films/ratings/
  try {
    const proxy = "https://r.jina.ai/http://" + url.replace(/^https?:\/\//,"");
    const r2 = await fetch(proxy, { headers: { "User-Agent": UA }, cache:"no-store" });
    const t2 = await r2.text();
    if (r2.ok && t2 && t2.length > 500) return t2;
  } catch(_){}

  return ""; // give up
}

// ---------- letterboxd readers (robust selectors + proxy fallback) ----------
async function readRatings(user) {
  const results = [];
  for (let p=1; p<=6; p++){
    const url = `https://letterboxd.com/${user}/films/ratings/page/${p}/`;
    const html = await fetchLB(url);
    if (!html) break;
    const $ = cheerio.load(html);

    // List layout
    $("li.film-detail").each((_, li)=>{
      const name = $(li).find(".headline-2 a").first().text().trim();
      const yr = $(li).find(".headline-2 .metadata").text().trim().match(/\d{4}/)?.[0];
      const classes = ($(li).find(".rating").attr("class")||"");
      const m = classes.match(/rated-(\d+)/);
      const stars = m ? (parseInt(m[1],10)/10) : 0;
      if (name) results.push({ name, year: yr, stars });
    });

    // Grid layout (posters)
    $("ul.poster-list li").each((_, li)=>{
      const a = $(li).find("a").first();
      const name = a.attr("data-film-name") || a.attr("aria-label") || "";
      const yr = a.attr("data-film-release-year") || "";
      const ratingEl = $(li).find("span.rating").attr("class") || $(li).attr("class") || "";
      const m = ratingEl.match(/rated-(\d+)/);
      const stars = m ? (parseInt(m[1],10)/10) : 0;
      if (name) results.push({ name, year: yr, stars });
    });

    if ($("li.film-detail").length===0 && $("ul.poster-list li").length===0) break;
  }
  const map = new Map(results.map(r=> [`${r.name}~${r.year}~${r.stars}`, r]));
  return Array.from(map.values());
}

async function readDiaryHTML(user){
  const out = [];
  for (let p=1; p<=5; p++){
    const url = p===1
      ? `https://letterboxd.com/${user}/films/diary/`
      : `https://letterboxd.com/${user}/films/diary/page/${p}/`;
    const html = await fetchLB(url);
    if (!html) break;
    const $ = cheerio.load(html);
    $(".diary-entry-title a").each((_, a)=>{
      const name = $(a).text().trim();
      const year = ($(a).next(".diary-entry-year").text().trim().match(/\d{4}/)||[null])[0];
      if (name) out.push({ name, year });
    });
    if ($(".diary-entry-title a").length===0) break;
  }
  const map = new Map(out.map(f=> [`${f.name}~${f.year}`, f]));
  return Array.from(map.values());
}

async function readWatchlist(user){
  const out = [];
  for (let p=1; p<=5; p++){
    const url = p===1
      ? `https://letterboxd.com/${user}/watchlist/`
      : `https://letterboxd.com/${user}/watchlist/page/${p}/`;
    const html = await fetchLB(url);
    if (!html) break;
    const $ = cheerio.load(html);
    const posters = $("ul.poster-list li div.poster a, ul.poster-list li a").toArray();
    if (!posters.length && p===1) break;
    for (const a of posters){
      const name = $(a).attr("data-film-name") || $(a).attr("aria-label") || "";
      const year = $(a).attr("data-film-release-year") || "";
      if (name) out.push({ name, year });
    }
    if (posters.length < 18) break;
  }
  const map = new Map(out.map(f=> [`${f.name}~${f.year}`, f]));
  return Array.from(map.values());
}

// ---------- TMDb ----------
async function tmdb(path, params = {}){
  const u = new URL(TMDB+path);
  u.searchParams.set("api_key", TMDB_KEY);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { cache:"no-store" });
  if (!r.ok) return {};
  return await r.json();
}
async function tmdbSearch(title, year){
  const data = await tmdb("/search/movie", year ? { query:title, year } : { query:title });
  return (data.results||[])[0];
}
async function tmdbDetails(id){
  const [d, kw, cr] = await Promise.all([
    tmdb(`/movie/${id}`, { language:"en-US" }),
    tmdb(`/movie/${id}/keywords`),
    tmdb(`/movie/${id}/credits`)
  ]);
  d.keywords_full = kw.keywords || [];
  d.credits = cr || {};
  return d;
}
async function tmdbRecsFromIds(ids, maxPer=5){
  const out=[];
  for (const id of ids.slice(0,20)){
    const data = await tmdb(`/movie/${id}/recommendations`, { page:1 });
    for (const it of (data.results||[]).slice(0, maxPer)) out.push(it.id);
  }
  return uniq(out);
}
async function tmdbProviders(id, region="US"){
  const data = await tmdb(`/movie/${id}/watch/providers`);
  const r = (data.results||{})[region] || {};
  const names=[];
  for (const k of ["flatrate","ads","rent","buy"]){
    for (const it of (r[k]||[])) names.push(k==="flatrate" ? it.provider_name : `${it.provider_name} (${k})`);
  }
  return uniq(names);
}

// ---------- AI taste ----------
function makeFingerprint(meta){
  const genres = (meta.genres||[]).map(g=>g.name).join(" ");
  const kw = (meta.keywords_full||[]).map(k=>k.name).join(" ");
  const cast = (meta.credits?.cast||[]).slice(0,8).map(c=>c.name).join(" ");
  const crew = (meta.credits?.crew||[]).filter(c=>["Director","Writer"].includes(c.job)).map(c=>c.name).join(" ");
  const overview = meta.overview || "";
  return `${meta.title} ${genres} ${kw} ${cast} ${crew} ${overview}`.toLowerCase();
}
async function embed(texts){
  const resp = await openai.embeddings.create({ model:"text-embedding-3-small", input:texts });
  return resp.data.map(d=> d.embedding);
}
function cosine(a,b){ let dot=0,na=0,nb=0; for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; } return dot/((Math.sqrt(na)*Math.sqrt(nb))||1); }

// ---------- main ----------
export default async function handler(req, res){
  try{
    const { user:rawUser, mode="watchlist", onlyFlatrate=true } = req.method==="GET" ? req.query : (req.body||{});
    const user = cleanUser(rawUser);
    if (!user) return res.status(400).send("Need a username.");
    if (!TMDB_KEY || !process.env.OPENAI_API_KEY) return res.status(500).send("Server missing API keys.");

    // Read all sources (with proxy fallback)
    const [ratings, diary, watchlist] = await Promise.all([
      readRatings(user).catch(()=>[]),
      readDiaryHTML(user).catch(()=>[]),
      readWatchlist(user).catch(()=>[])
    ]);

    if (!ratings.length && !diary.length && !watchlist.length){
      return res.status(400).send("Still couldn't read any public data for this username. Double-check spelling; if correct, Letterboxd may be fully blocking scraping for this profile.");
    }

    // build liked seeds from ratings ≥4★, else diary first page
    const liked = ratings.filter(r=> r.stars>=4).slice(0,200);
    const likedIds = [];
    for (const r of liked.slice(0,60)){
      const hit = await tmdbSearch(r.name, r.year);
      if (hit?.id) likedIds.push(hit.id);
    }

    let candidates = [];
    if (mode==="watchlist" && watchlist.length){
      for (const w of watchlist.slice(0,400)){
        const hit = await tmdbSearch(w.name, w.year);
        if (hit?.id){
          const meta = await tmdbDetails(hit.id);
          candidates.push({ id: hit.id, meta });
        }
      }
    } else {
      // AI mode: graph from liked; if no liked, seed from diary; else seed from watchlist
      let seedIds = likedIds;
      if (!seedIds.length && diary.length){
        for (const d of diary.slice(0,40)){
          const hit = await tmdbSearch(d.name, d.year);
          if (hit?.id) seedIds.push(hit.id);
        }
      }
      if (!seedIds.length && watchlist.length){
        for (const w of watchlist.slice(0,30)){
          const hit = await tmdbSearch(w.name, w.year);
          if (hit?.id) seedIds.push(hit.id);
        }
      }
      const recIds = await tmdbRecsFromIds(uniq(seedIds), 5);
      for (const id of recIds.slice(0,400)){
        const meta = await tmdbDetails(id);
        candidates.push({ id, meta });
      }
      if (!candidates.length){
        const pop = await tmdb("/movie/popular", { page:1 });
        for (const it of (pop.results||[]).slice(0,60)){
          const meta = await tmdbDetails(it.id);
          candidates.push({ id: it.id, meta });
        }
      }
    }

    if (!candidates.length) return res.status(400).send("No candidates available.");

    // taste seeds (embeddings)
    const tasteSeeds = [];
    if (likedIds.length){
      for (const id of likedIds.slice(0,40)){
        const meta = await tmdbDetails(id);
        tasteSeeds.push(makeFingerprint(meta));
      }
    }
    if (!tasteSeeds.length && diary.length){
      for (const d of diary.slice(0,40)){
        const hit = await tmdbSearch(d.name, d.year);
        if (!hit) continue;
        const meta = await tmdbDetails(hit.id);
        tasteSeeds.push(makeFingerprint(meta));
      }
    }
    if (!tasteSeeds.length && watchlist.length){
      for (const w of watchlist.slice(0,30)){
        const hit = await tmdbSearch(w.name, w.year);
        if (!hit) continue;
        const meta = await tmdbDetails(hit.id);
        tasteSeeds.push(makeFingerprint(meta));
      }
    }
    if (!tasteSeeds.length) return res.status(400).send("Not enough taste signals.");

    const [userVecs, candVecs] = await Promise.all([
      embed(tasteSeeds),
      embed(candidates.map(c=> makeFingerprint(c.meta)))
    ]);
    const userAvg = userVecs[0].map((_,i)=> userVecs.reduce((s,v)=> s+v[i], 0) / userVecs.length);

    function overlapBonus(meta){
      let bonus=0;
      const bag = tasteSeeds.join(" ").toLowerCase();
      const directors = (meta.credits?.crew||[]).filter(c=>c.job==="Director").map(c=>c.name);
      const cast = (meta.credits?.cast||[]).slice(0,8).map(c=>c.name);
      for (const d of directors) if (bag.includes(d.toLowerCase())) bonus += 0.08;
      for (const a of cast) if (bag.includes(a.toLowerCase())) bonus += 0.02;
      return bonus;
    }
    function mainstreamPenalty(meta){
      const votes = meta.vote_count || 0;
      const pop = meta.popularity || 0;
      return Math.max(0, Math.min(0.25, (votes/50000)*0.25 + (pop/200)*0.1));
    }

    const scored = candidates.map((c,i)=>{
      const sim = cosine(userAvg, candVecs[i]);
      const score = sim + overlapBonus(c.meta) - mainstreamPenalty(c.meta);
      return { ...c, score };
    }).sort((a,b)=> b.score - a.score);

    // providers + flatrate filter
    const enriched=[];
    for (const s of scored.slice(0,80)){
      const providers = await tmdbProviders(s.id, "US");
      const show = onlyFlatrate ? providers.some(p=> !/\(|rent|buy/i.test(p)) : true;
      enriched.push({ ...s, providers, show });
    }
    const visible = enriched.filter(x=> x.show);
    const top = visible[0] || enriched[0];
    const alts = visible.slice(1,8);

    function title(meta){ return `${meta.title} (${(meta.release_date||"").slice(0,4)})`; }
    const pill = p => `<span style="display:inline-block;margin-right:6px;padding:3px 8px;border:1px solid #333;border-radius:999px;font-size:12px">${p}</span>`;

    const html = `
      <div style="border:1px solid #272727;border-radius:12px;padding:14px;margin:12px 0"><b>Top Pick</b><br/>→ ${title(top.meta)}<br/>
      <span style="opacity:.8">Where to watch:</span> ${top.providers?.length ? top.providers.map(pill).join(" ") : "—"}</div>
      <div style="border:1px solid #272727;border-radius:12px;padding:14px;margin:12px 0"><b>Alternates</b><br/>
        ${alts.map((a,i)=> `<div style="opacity:.9">${i+1}. ${title(a.meta)} ${a.providers?.length? a.providers.map(pill).join(" "):""}</div>`).join("")}
      </div>
      <div style="opacity:.6;font-size:12px">Signals used — Ratings: ${ratings.length} • Diary: ${diary.length} • Watchlist: ${watchlist.length}</div>
    `;
    res.setHeader("Content-Type","text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch(e){
    return res.status(500).send(`Error: ${e.message}`);
  }
}
