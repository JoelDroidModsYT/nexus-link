/**
 * Nexus Link · Estadísticas en tiempo real (Cloudflare Worker + D1)
 * Variables: binding D1 = DB  ·  variable de texto ALLOWED_USER = tu usuario de GitHub (ej. JoelDroidModsYT)
 * No guarda IP ni datos personales: solo contadores por día / juego / país.
 */
const EVENTS = ["view", "start", "ad1", "ad2", "dl"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra } });

const day = (d) => d.toISOString().slice(0, 10);

async function init(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS daily (day TEXT, g TEXT, e TEXT, cc TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (day, g, e, cc))"),
    db.prepare("CREATE TABLE IF NOT EXISTS minute (m INTEGER, g TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (m, g))"),
  ]);
}

async function isAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+/.test(auth)) return false;
  const r = await fetch("https://api.github.com/user", {
    headers: { Authorization: auth, "User-Agent": "nexus-link-stats", Accept: "application/vnd.github+json" },
  });
  if (!r.ok) return false;
  const u = await r.json();
  return String(u.login || "").toLowerCase() === String(env.ALLOWED_USER || "").toLowerCase();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const db = env.DB;
    ctx.waitUntil(init(db));

    // ---- Registrar evento ----
    if (url.pathname === "/hit" && request.method === "POST") {
      let b;
      try { b = JSON.parse(await request.text()); } catch { return json({ ok: false }, 400); }
      const g = String(b.g || "").toLowerCase();
      const e = String(b.e || "");
      if (!/^[a-z0-9-]{1,80}$/.test(g) || !EVENTS.includes(e)) return json({ ok: false }, 400);
      if (/bot|crawl|spider|headless|preview|facebookexternalhit/i.test(request.headers.get("User-Agent") || "")) return json({ ok: true, ignored: true });
      const cc = (request.cf && request.cf.country) || "XX";
      const now = new Date();
      await init(db);
      const stmts = [
        db.prepare("INSERT INTO daily (day,g,e,cc,n) VALUES (?,?,?,?,1) ON CONFLICT(day,g,e,cc) DO UPDATE SET n=n+1").bind(day(now), g, e, cc),
      ];
      if (e === "view") {
        const m = Math.floor(now.getTime() / 60000);
        stmts.push(db.prepare("INSERT INTO minute (m,g,n) VALUES (?,?,1) ON CONFLICT(m,g) DO UPDATE SET n=n+1").bind(m, g));
        if (Math.random() < 0.02) stmts.push(db.prepare("DELETE FROM minute WHERE m < ?").bind(m - 1440));
      }
      await db.batch(stmts);
      return json({ ok: true });
    }

    // ---- Totales públicos (para inicio.html) ----
    if (url.pathname === "/public" && request.method === "GET") {
      await init(db);
      const t = await db.prepare("SELECT e, SUM(n) n FROM daily GROUP BY e").all();
      const o = { view: 0, start: 0, ad1: 0, ad2: 0, dl: 0 };
      (t.results || []).forEach((r) => (o[r.e] = r.n));
      const gm = await db.prepare("SELECT COUNT(DISTINCT g) n FROM daily").first();
      const cm = await db.prepare("SELECT COUNT(DISTINCT cc) n FROM daily WHERE cc != 'XX'").first();
      return json({ views: o.view, downloads: o.dl, games: gm ? gm.n : 0, countries: cm ? cm.n : 0, updated: Date.now() }, 200, { "Cache-Control": "public, max-age=30" });
    }

    // ---- Estadísticas completas (solo tú, con tu token de GitHub) ----
    if (url.pathname === "/stats" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return json({ ok: false, error: "No autorizado" }, 401);
      await init(db);
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "14", 10)));
      const since = day(new Date(Date.now() - (days - 1) * 86400000));
      const today = day(new Date());
      const m = Math.floor(Date.now() / 60000);
      const [byGame, byDay, byCountry, now5, nowGames] = await Promise.all([
        db.prepare("SELECT g, e, SUM(n) n FROM daily GROUP BY g, e").all(),
        db.prepare("SELECT day, e, SUM(n) n FROM daily WHERE day >= ? GROUP BY day, e").bind(since).all(),
        db.prepare("SELECT cc, SUM(n) n FROM daily WHERE e='view' GROUP BY cc ORDER BY n DESC LIMIT 15").all(),
        db.prepare("SELECT COALESCE(SUM(n),0) n FROM minute WHERE m >= ?").bind(m - 4).first(),
        db.prepare("SELECT g, SUM(n) n FROM minute WHERE m >= ? GROUP BY g ORDER BY n DESC LIMIT 5").bind(m - 4).all(),
      ]);
      const todayRows = await db.prepare("SELECT e, SUM(n) n FROM daily WHERE day = ? GROUP BY e").bind(today).all();
      return json({
        ok: true, today,
        games: byGame.results || [], days: byDay.results || [], countries: byCountry.results || [],
        todayTotals: todayRows.results || [], now5: now5 ? now5.n : 0, nowGames: nowGames.results || [], updated: Date.now(),
      });
    }

    return json({ ok: true, service: "nexus-link-stats" });
  },
};
