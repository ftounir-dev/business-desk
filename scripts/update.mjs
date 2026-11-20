// Business Desk: builds data/brief.json from live prices, news and an optional AI summary.
// Runs on GitHub Actions (Node 20+). No npm packages needed.
// Env: ANTHROPIC_API_KEY or (OPENAI_API_KEY + OPENAI_MODEL). Optional: ANTHROPIC_MODEL. MOCK_DIR for offline tests.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const MOCK = process.env.MOCK_DIR;
const UA = "Mozilla/5.0 (BusinessDesk; +https://github.com)";
const log = [];

async function get(url, kind = "json") {
  if (MOCK) {
    const key = url.replace(/[^a-z0-9]+/gi, "_").slice(0, 120);
    const f = path.join(MOCK, key + (kind === "json" ? ".json" : ".xml"));
    const t = await fs.readFile(f, "utf8");
    return kind === "json" ? JSON.parse(t) : t;
  }
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": kind === "json" ? "application/json" : "application/rss+xml,text/xml" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return kind === "json" ? r.json() : r.text();
}

/* ---------- Prices (Yahoo Finance chart endpoint, daily closes, last month) ---------- */
async function price(m) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.ticker)}?range=1mo&interval=1d`;
  const j = await get(url);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error("no data " + m.ticker);
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const series = ts.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), closes[i]])
                   .filter(p => typeof p[1] === "number");
  if (series.length < 2) throw new Error("short series " + m.ticker);
  const last = series[series.length - 1], prev = series[series.length - 2];
  return {
    id: m.id, group: m.group, name: m.name, unit: m.unit, dp: m.dp, cost: m.cost,
    value: last[1], prev: prev[1], date: last[0],
    change_pct: (last[1] / prev[1] - 1) * 100,
    series: series.slice(-22),
    source: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(m.ticker)}`
  };
}

/* ---------- News (Google News RSS search) ---------- */
function decode(s) {
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}
async function newsQuery(cat, q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q.q + " when:" + cfg.news_max_age_days + "d")}&hl=${q.hl}&gl=${q.gl}&ceid=${q.gl}:${q.hl}`;
  const xml = await get(url, "xml");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]).map(b => {
    let title = tag(b, "title");
    const source = tag(b, "source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    return { cat, title, source: source || "Google News", url: tag(b, "link"), date: new Date(tag(b, "pubDate") || Date.now()).toISOString() };
  }).filter(x => x.title && x.url);
}
async function news(n) {
  const all = [];
  for (const q of n.queries) {
    try { all.push(...await newsQuery(n.cat, q)); } catch (e) { log.push(`news ${n.cat} (${q.hl}): ${e.message}`); }
  }
  return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, cfg.news_per_category);
}

/* ---------- Summary: AI if a key is set, rules otherwise ---------- */
const SIXTY_PICK = { worldwide: 2, congo: 2, lebanon: 1 }; // "Overnight in 60 seconds" draws only on these sections
function rulesSummary(markets, fx, headlines) {
  const out = { en: [], fr: [] };
  for (const [cat, n] of Object.entries(SIXTY_PICK)) {
    const lab = cfg.news.find(x => x.cat === cat) || { label_en: cat, label_fr: cat };
    headlines.filter(h => h.cat === cat).slice(0, n).forEach(h => {
      const it = { level: "", owner: lab.label_en, title: h.title, detail: h.source, impact: "", url: h.url };
      out.en.push(it); out.fr.push({ ...it, owner: lab.label_fr });
    });
  }
  return out;
}

async function aiSummary(markets, fx, headlines) {
  const pool = headlines.map((h, i) => ({ i, cat: h.cat, title: h.title, source: h.source, date: h.date.slice(0, 10) }))
                        .filter(h => h.cat in SIXTY_PICK);
  if (!pool.length) return null;
  const labels = Object.fromEntries(cfg.news.map(n => [n.cat, { en: n.label_en, fr: n.label_fr }]));
  const prompt = `You edit "Overnight in 60 seconds", the top of a morning news brief read by the CFO of ${cfg.company}, a beverage manufacturer in ${cfg.city}, Republic of Congo.

From the headlines below, pick the 5 most important news stories of the last day: about 2 from "worldwide", 2 from "congo" (Republic of Congo and CEMAC) and 1 from "lebanon". Prefer major political, economic and security news over minor or promotional items; skip duplicates.
For each give: cat (worldwide|congo|lebanon), level ("high" or "med"), title (clear, max 14 words, rewritten from the headline), detail (one sentence saying what happened, using only what the headline says; never invent facts or numbers), impact (one short sentence on why it matters for a Congolese company, or "" if it doesn't), source_index (the headline's i).
Return JSON only: {"en":[5 items],"fr":[the same 5 items in natural French]}.

HEADLINES:
${JSON.stringify(pool)}`;

  let text;
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
    });
    if (!r.ok) throw new Error("Anthropic " + r.status + " " + (await r.text()).slice(0, 300));
    text = (await r.json()).content?.map(c => c.text || "").join("");
  } else if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "authorization": "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] })
    });
    if (!r.ok) throw new Error("OpenAI " + r.status + " " + (await r.text()).slice(0, 300));
    text = (await r.json()).choices?.[0]?.message?.content;
  } else return null;

  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  for (const lang of ["en", "fr"]) {
    if (!Array.isArray(json[lang]) || json[lang].length === 0) throw new Error("AI output missing " + lang);
    json[lang] = json[lang].slice(0, 5).map(x => {
      const h = Number.isInteger(x.source_index) ? headlines[x.source_index] : null;
      const cat = (h && h.cat) || x.cat;
      return { level: x.level === "high" ? "high" : "med", owner: (labels[cat] || {})[lang] || "", title: String(x.title || ""),
               detail: String(x.detail || ""), impact: String(x.impact || ""), url: h ? h.url : null };
    });
  }
  return json;
}

/* ---------- Read: article of the day ---------- */
async function reads() {
  const rc = cfg.reads; if (!rc) return null;
  const all = [];
  for (const s of rc.sources) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(s.q + " when:" + rc.max_age_days + "d")}&hl=en&gl=US&ceid=US:en`;
    try {
      const xml = await get(url, "xml");
      [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, rc.per_source).forEach(m => {
        let title = tag(m[1], "title"); const src = tag(m[1], "source") || s.name;
        if (title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
        if (title && tag(m[1], "link")) all.push({ title, source: s.name, url: tag(m[1], "link"), date: new Date(tag(m[1], "pubDate") || Date.now()).toISOString() });
      });
    } catch (e) { log.push(`read ${s.name}: ${e.message}`); }
  }
  if (!all.length) return null;
  const boost = new RegExp(rc.boost.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const score = a => (a.title.match(boost) || []).length;
  const ranked = all.sort((a, b) => score(b) - score(a) || b.date.localeCompare(a.date));
  const pick = ranked[0], rest = ranked.slice(1), more = [], used = new Set();
  for (const a of rest) if (!used.has(a.source) && a.source !== pick.source) { more.push(a); used.add(a.source); }
  for (const a of rest) if (more.length < 8 && !more.includes(a)) more.push(a);
  return { pick, more: more.slice(0, 8) };
}
async function aiRead(pick) {
  if (!pick || !process.env.ANTHROPIC_API_KEY) return null;
  const prompt = `A CFO of a beverage manufacturer in Brazzaville, Republic of Congo, will read this article today: "${pick.title}" (${pick.source}). Using only the title, write JSON {"en":{"why":"..."},"fr":{"title":"...","why":"..."}} where "why" is one or two sentences on what a CFO can take from it, without inventing facts, and fr.title is a French translation of the title.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 600, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error("Anthropic " + r.status);
  const t = (await r.json()).content?.map(c => c.text || "").join("");
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

/* ---------- On this day (Wikipedia) ---------- */
const OTD_BOOST = /congo|brazzaville|kinshasa|lebanon|liban|beirut|beyrouth|africa|afrique|cameroon|cameroun|gabon|nigeria|senegal|sénégal|ivory coast|côte d'ivoire/i;
function pickEvents(list) {
  return list.filter(e => e.year && e.text)
    .map(e => ({ year: e.year, text: e.text, url: e.pages?.[0]?.content_urls?.desktop?.page || null, score: OTD_BOOST.test(e.text) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || b.year - a.year).slice(0, 4)
    .sort((a, b) => b.year - a.year).map(({ score, ...e }) => e);
}
async function onThisDay() {
  const now = new Date(), mm = String(now.getUTCMonth() + 1).padStart(2, "0"), dd = String(now.getUTCDate()).padStart(2, "0");
  const out = {};
  for (const lang of ["en", "fr"]) {
    try { out[lang] = pickEvents((await get(`https://${lang}.wikipedia.org/api/rest_v1/feed/onthisday/selected/${mm}/${dd}`)).selected || []); }
    catch (e) { log.push(`on this day ${lang}: ${e.message}`); }
  }
  return out;
}

/* ---------- Main ---------- */
const markets = [];
for (const m of cfg.markets) {
  try { markets.push(await price(m)); } catch (e) { log.push("price " + m.id + ": " + e.message); }
}
const eurusd = markets.find(m => m.id === "eurusd");
if (!eurusd) { console.error("EUR/USD unavailable; keeping previous brief.", log); process.exit(1); }
const fx = { eurusd: eurusd.value, usdxaf: cfg.eur_xaf_peg / eurusd.value, usdxaf_prev: cfg.eur_xaf_peg / eurusd.prev, date: eurusd.date };
markets.unshift({ id: "usdxaf", group: "fx", name: "USD/XAF", unit: "XAF per USD", dp: 1, cost: 1, value: fx.usdxaf, prev: fx.usdxaf_prev,
  date: fx.date, change_pct: (fx.usdxaf / fx.usdxaf_prev - 1) * 100,
  series: eurusd.series.map(([d, v]) => [d, cfg.eur_xaf_peg / v]), source: "655.957 ÷ EUR/USD", url: eurusd.url });

let headlines = [];
for (const n of cfg.news) {
  headlines.push(...await news(n));
}
const seen = new Set();
headlines = headlines.filter(h => { const k = h.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });

const otd = await onThisDay();
const read = await reads();
if (read) { try { const w = await aiRead(read.pick); if (w) read.pick.ai = w; } catch (e) { log.push("ai read: " + e.message); } }

let summary = null, summaryMode = "rules";
try { summary = await aiSummary(markets, fx, headlines); if (summary) summaryMode = "ai"; } catch (e) { log.push("ai: " + e.message); }
if (!summary) summary = rulesSummary(markets, fx, headlines);

const brief = {
  generated_at: new Date().toISOString(), summary_mode: summaryMode, peg: cfg.eur_xaf_peg, fx,
  markets, static_rates: cfg.static_rates, agenda: cfg.agenda,
  categories: cfg.news.map(n => ({ id: n.cat, en: n.label_en, fr: n.label_fr })),
  summary, on_this_day: otd, read, news: headlines.map((h, i) => ({ id: "n" + i + "-" + h.date.slice(0, 10), ...h })), log
};
await fs.mkdir(path.join(ROOT, "data"), { recursive: true });
await fs.writeFile(path.join(ROOT, "data", "brief.json"), JSON.stringify(brief, null, 1));
console.log(`brief.json written: ${markets.length} markets, ${headlines.length} headlines, summary=${summaryMode}`);
if (log.length) console.log("warnings:\n" + log.join("\n"));
