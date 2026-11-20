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
    return { cat, lang: q.hl, title, source: source || "Google News", url: tag(b, "link"), date: new Date(tag(b, "pubDate") || Date.now()).toISOString() };
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
const SIXTY_PICK = { worldwide: 5, africa: 5, congo: 5 }; // Today's video feed: 15 stories, about 2 minutes
// A headline Google News cut short ends with "…" or a dangling small word ("…lever près de")
function cut(t) { return /(\u2026|\.\.\.)\s*$/.test(t) || /\s(de|du|des|la|le|les|l'|d'|à|au|aux|et|en|pour|près|sur|par|avec|dans|un|une|of|the|to|a|an|and|for|in|on|with|at|by|from|as)$/i.test(t.trim()); }
function fullTitle(h, cand) {           // use a longer title from Bing or the article if it continues ours
  if (!cand || !cut(h.title)) return;
  const a = h.title.replace(/(\u2026|\.\.\.)\s*$/, "").trim().toLowerCase().slice(0, 40), c = decode(cand).replace(/\s+[-|–]\s+[^-|–]{2,40}$/, "").trim();
  if (c.toLowerCase().startsWith(a) && c.length > h.title.length && !cut(c)) h.title = c;
}
function rulesSummary(markets, fx, headlines) {
  const out = { en: [], fr: [] }, lists = [];
  for (const [cat, n] of Object.entries(SIXTY_PICK)) {
    const lab = cfg.news.find(x => x.cat === cat) || { label_en: cat, label_fr: cat };
    lists.push(headlines.filter(h => h.cat === cat && !cut(h.title)).slice(0, n).map(h => ({ lab, h })));
  }
  // Interleave sections so the feed is mixed: Worldwide, Africa, Congo, Markets, ... then the second round
  for (let r = 0; lists.some(l => l[r]); r++) for (const l of lists) if (l[r]) {
    const { lab, h } = l[r];
    const it = { level: "", cat: h.cat, owner: lab.label_en, title: h.title, detail: "", source: h.source, date: h.date, impact: "", url: h.url, img: h.img || null };
    out.en.push(it); out.fr.push({ ...it, owner: lab.label_fr });
  }
  return out;
}

async function aiSummary(markets, fx, headlines) {
  const pool = headlines.map((h, i) => ({ i, cat: h.cat, title: h.title, source: h.source, date: h.date.slice(0, 10) }))
                        .filter(h => h.cat in SIXTY_PICK);
  if (!pool.length) return null;
  const labels = Object.fromEntries(cfg.news.map(n => [n.cat, { en: n.label_en, fr: n.label_fr }]));
  const prompt = `You edit "Overnight in 60 seconds", the top of a morning news brief read by the CFO of ${cfg.company}, a beverage manufacturer in ${cfg.city}, Republic of Congo.

From the headlines below, pick the 15 most important news stories of the last 24 hours for a 2-minute video news feed: 5 from "worldwide", 5 from "africa" (West and Central Africa) and 5 from "congo" (Republic of Congo and CEMAC). Prefer major political, economic and security news over minor or promotional items; skip duplicates. Order them as a mixed feed: the most important story first, and never two stories from the same category in a row.
For each give: cat (worldwide|africa|congo), level ("high" or "med"), title (clear, max 14 words, rewritten from the headline), detail (one sentence saying what happened, using only what the headline says; never invent facts or numbers), impact (one short sentence on why it matters for a Congolese company, or "" if it doesn't), source_index (the headline's i).
Return JSON only: {"en":[15 items],"fr":[the same 15 items in natural French]}.

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
    json[lang] = json[lang].slice(0, 15).map(x => {
      const h = Number.isInteger(x.source_index) ? headlines[x.source_index] : null;
      const cat = (h && h.cat) || x.cat;
      return { level: x.level === "high" ? "high" : "med", cat, source: h ? h.source : "", date: h ? h.date : null, img: h ? h.img || null : null, owner: (labels[cat] || {})[lang] || "", title: String(x.title || ""),
               detail: String(x.detail || ""), impact: String(x.impact || ""), url: h ? h.url : null };
    });
  }
  return json;
}

/* ---------- Photos for Today's cards (Bing News thumbnail, upgraded to the article's own og:image when possible) ---------- */
const STOP = new Set("the a an of to in on for and or with at by from as is are be its de la le les des du et en au aux un une pour par sur dans à".split(" "));
const words = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(" ").filter(w => w.length > 2 && !STOP.has(w));
async function fetchText(url, ms = 7000) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "Accept-Language": "en,fr;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(r.status + " " + url);
  return (await r.text()).slice(0, 400000);
}
function ogImage(html, base) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/i);
  const c = m && m[0].match(/content=["']([^"']+)["']/i);
  if (!c) return null;
  try { const u = new URL(decode(c[1]), base); return /^https:/.test(u.href) && !/logo|placeholder|default/i.test(u.pathname) ? u.href : null; } catch { return null; }
}
const why = {};
async function photoFor(h) {
  const mkt = h.lang === "fr" ? "fr-FR" : "en-US", want = new Set(words(h.title)), all = h.title.split(" ");
  for (const q of [all.slice(0, 12).join(" "), [...want].slice(0, 5).join(" "), all.slice(0, 7).join(" ") + " " + h.source]) {
    let xml;
    try { xml = await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&mkt=${mkt}`); }
    catch (e) { why[e.message.slice(0, 3)] = (why[e.message.slice(0, 3)] || 0) + 1; continue; }
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map(m => m[1]);
    if (!items.length) { why.empty = (why.empty || 0) + 1; continue; }
    for (const b of items) {
      const got = new Set(words(tag(b, "title"))); const hit = [...got].filter(w => want.has(w)).length;
      if (hit < 3 && hit / Math.max(1, Math.min(want.size, got.size)) < 0.5) continue;   // must be the same story
      fullTitle(h, tag(b, "title"));
      const thumb = (b.match(/<News:Image>([\s\S]*?)<\/News:Image>/i) || [])[1];
      let article = null; try { article = new URL(decode(tag(b, "link"))).searchParams.get("url"); } catch {}
      if (article) { try { const html = await fetchText(article, 6000); const ot = (html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i) || [""])[0].match(/content=["']([^"']+)/i); if (ot) fullTitle(h, ot[1]); const og = ogImage(html, article); if (og) return og; } catch {} }
      if (thumb) return decode(thumb) + "&w=900&h=1200&c=7&rs=1";
    }
    why.nomatch = (why.nomatch || 0) + 1;
  }
  return null;
}
async function addPhotos(list) {
  const queue = [...list]; let n = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) { const h = queue.shift(); try { const img = await photoFor(h); if (img) { h.img = img; n++; } } catch (e) {} }
  }));
  log.push(`photos: ${n}/${list.length} ${JSON.stringify(why)}`);
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
const OTD_GRIM = /\b(kill(s|ed|ing|ers?)?|murder(s|ed|ers?)?|massacres?|massacred|bomb(s|ed|ing|ings|ers?)?|terror(ist|ists|ism)?|attack(s|ed)?|shoot(s|ing|ings)?|shot down|shot dead|assassinat(ed|ion)|executions?|genocide|hostages?|raped?|suicide|tu[ée]s?|tu[ée]es|meurtres?|assassin[ée]?|assassinat|attentats?|massacr[ée]s?|fusill[ée]s?|bombard(ement|é|e)|g[ée]nocide|otages?|ex[ée]cut[ée]s?)(?![a-zà-ÿ])/i;
function pickEvents(list) {
  return list.filter(e => e.year && e.text && !OTD_GRIM.test(e.text))
    .map(e => ({ year: e.year, text: e.text, url: e.pages?.[0]?.content_urls?.desktop?.page || null, img: (e.pages || []).map(p => (p.originalimage && p.originalimage.width <= 1800 ? p.originalimage.source : p.thumbnail?.source)).find(Boolean) || null, score: OTD_BOOST.test(e.text) ? 1 : 0 }))
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
if (!MOCK) await addPhotos(cfg.news.flatMap(n => headlines.filter(h => h.cat === n.cat).slice(0, 6)));

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
