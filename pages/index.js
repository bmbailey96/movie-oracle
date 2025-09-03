import { useState } from "react";

export default function Home() {
  const [user, setUser] = useState("");
  const [mode, setMode] = useState("watchlist"); // 'watchlist' or 'ai'
  const [onlyFlatrate, setOnlyFlatrate] = useState(true);
  const [result, setResult] = useState("Type your Letterboxd username and press Feed me.");

  async function go(e) {
    e.preventDefault();
    setResult("thinking… summoning the municipal oracle…");
    const r = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, mode, onlyFlatrate })
    });
    const text = await r.text();
    setResult(text);
  }

  const base = { padding:"10px 12px", borderRadius:10, border:"1px solid #333", background:"#141414", color:"#eaeaea" };

  return (
    <div style={{fontFamily:"system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background:"#0b0b0b", color:"#eaeaea", minHeight:"100vh", padding:18, maxWidth:720, margin:"0 auto"}}>
      <h1 style={{margin:"0 0 12px", fontSize:22}}>Movie Oracle</h1>
      <p style={{opacity:.85, marginTop:0}}>Enter your Letterboxd username. Choose Watchlist or AI Taste. Get one great pick + where to watch.</p>
      <form onSubmit={go} style={{display:"grid", gap:8, gridTemplateColumns:"1fr auto auto"}}>
        <input value={user} onChange={e=>setUser(e.target.value)} placeholder="Letterboxd username" required style={base}/>
        <select value={mode} onChange={e=>setMode(e.target.value)} style={base}>
          <option value="watchlist">From my Watchlist</option>
          <option value="ai">AI Taste Pick</option>
        </select>
        <button style={{...base, borderColor:"#1f6feb", background:"#1f6feb", cursor:"pointer"}}>Feed me</button>
        <label style={{gridColumn:"1 / -1", display:"flex", gap:8, alignItems:"center", fontSize:14, opacity:.85}}>
          <input type="checkbox" checked={onlyFlatrate} onChange={e=>setOnlyFlatrate(e.target.checked)}/>
          Only show picks included with a subscription (no rent/buy)
        </label>
      </form>

      <div style={{marginTop:12, border:"1px solid #272727", borderRadius:12, padding:14, whiteSpace:"pre-wrap"}} dangerouslySetInnerHTML={{__html: result}} />
      <p style={{opacity:.6, fontSize:12, marginTop:12}}>
        Tip: For Watchlist mode, set your Letterboxd Watchlist to public (Profile → Settings → Privacy). We only read public pages & RSS.
      </p>
    </div>
  );
}
