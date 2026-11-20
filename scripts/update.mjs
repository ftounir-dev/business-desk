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
function rulesSummary(markets, fx, headlines) {
  const out = { en: [], fr: [] };
  const usd = markets.find(m => m.id === "eurusd");
  if (usd) {
    const up = usd.change_pct < 0; // EUR/USD down = dollar up = USD bills dearer
    out.en.push({ level: Math.abs(usd.change_pct) > 0.5 ? "high" : "med", owner: "Treasury",
      title: `USD/XAF at ${fx.usdxaf.toFixed(1)} (${up ? "dollar firmer" : "dollar softer"})`,
      detail: `EUR/USD ${usd.value.toFixed(4)}, ${usd.change_pct >= 0 ? "+" : ""}${usd.change_pct.toFixed(2)}% on the day.`,
      impact: Math.abs(usd.change_pct) < 0.3 ? "Little change on the day. EUR invoices carry no FX risk under the peg; only USD bills move." : up ? "USD invoices cost more in XAF today. EUR invoices carry no FX risk under the peg." : "USD invoices are cheaper in XAF today; a good moment to settle USD bills." });
    out.fr.push({ level: out.en[0].level, owner: "Trésorerie",
      title: `USD/XAF à ${fx.usdxaf.toFixed(1).replace(".", ",")} (${up ? "dollar plus fort" : "dollar plus faible"})`,
      detail: `EUR/USD ${usd.value.toFixed(4).replace(".", ",")}, ${usd.change_pct >= 0 ? "+" : ""}${usd.change_pct.toFixed(2).replace(".", ",")} % sur la journée.`,
      impact: Math.abs(usd.change_pct) < 0.3 ? "Peu de variation. Les factures en EUR ne portent aucun risque de change ; seules les factures USD bougent." : up ? "Les factures en USD coûtent plus cher en XAF. Les factures en EUR ne portent aucun risque de change." : "Les factures en USD sont moins chères en XAF : bon moment pour les régler." });
  }
  const movers = markets.filter(m => m.cost === 1).sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 3);
  for (const m of movers) {
    const bad = m.change_pct > 0;
    out.en.push({ level: Math.abs(m.change_pct) > 2 ? "high" : "med", owner: m.id === "brent" ? "Operations" : "Procurement",
      title: `${m.name} ${bad ? "up" : "down"} ${Math.abs(m.change_pct).toFixed(2)}% to ${m.value.toFixed(m.dp)} ${m.unit.split(" ·")[0]}`,
      detail: `Last close ${m.date}.`,
      impact: Math.abs(m.change_pct) < 0.5 ? "Small move; no action needed today." : bad ? "Cost pressure on ITE inputs; check supplier price clauses." : "Cost relief; consider fixing prices for the coming quarter." });
    out.fr.push({ level: out.en[out.en.length - 1].level, owner: m.id === "brent" ? "Exploitation" : "Achats",
      title: `${m.name} ${bad ? "en hausse" : "en baisse"} de ${Math.abs(m.change_pct).toFixed(2).replace(".", ",")} % à ${m.value.toFixed(m.dp).replace(".", ",")}`,
      detail: `Dernière clôture ${m.date}.`,
      impact: Math.abs(m.change_pct) < 0.5 ? "Faible variation ; pas d'action nécessaire aujourd'hui." : bad ? "Pression sur les coûts d'ITE ; vérifier les clauses de prix fournisseurs." : "Allègement des coûts ; envisager de fixer les prix du trimestre." });
  }
  const c = headlines.find(h => h.cat === "congo");
  if (c) {
    out.en.push({ level: "med", owner: "Finance", title: c.title, detail: c.source, impact: "Read the source for tax or payment implications.", url: c.url });
    out.fr.push({ level: "med", owner: "Finance", title: c.title, detail: c.source, impact: "Lire la source pour les implications fiscales ou de paiement.", url: c.url });
  }
  return out;
}

async function aiSummary(markets, fx, headlines) {
  const data = { company: cfg.company, eur_xaf_peg: cfg.eur_xaf_peg, usd_xaf: +fx.usdxaf.toFixed(2),
    markets: markets.map(m => ({ name: m.name, value: m.value, unit: m.unit, change_pct: +m.change_pct.toFixed(2), date: m.date })),
    static_rates: cfg.static_rates, headlines: headlines.map((h, i) => ({ i, cat: h.cat, title: h.title, source: h.source, date: h.date.slice(0, 10) })) };
  const prompt = `You write the 09:00 morning brief for the CFO of ${cfg.company}, a beverage and FMCG manufacturer in ${cfg.city}, Republic of Congo (mineral water, juices, soft drinks, malt drinks, energy drinks, snacks, vinegar). Its region is West and Central Africa (CEMAC, UEMOA, Nigeria, Ghana, DRC), which matters for demand, competitors, regional FX and policy. Inputs: sugar, PET preforms, aluminium cans/closures, concentrates, malt, diesel. The XAF is pegged to the EUR at 655.957, so only non-EUR invoices carry FX risk.

Using ONLY the data below, pick the 5 developments that matter most to ITE's costs, cash, financing or tax position today. For each, give: level ("high"|"med"|"low"), owner (Treasury, Procurement, Operations, Tax, Finance), title (max 16 words), detail (one sentence, with numbers from the data), impact (one or two sentences: what it means for ITE and what to consider doing), and source_index (the headline index i it rests on, or null if it rests on market data).
Do not invent facts or numbers not in the data. Return JSON only: {"en":[...5 items],"fr":[...the same 5 items in natural business French, owners in French]}.

DATA:
${JSON.stringify(data)}`;

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
      return { level: ["high", "med", "low"].includes(x.level) ? x.level : "med", owner: String(x.owner || ""), title: String(x.title || ""),
               detail: String(x.detail || ""), impact: String(x.impact || ""), url: h ? h.url : null };
    });
  }
  return json;
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

let summary = null, summaryMode = "rules";
try { summary = await aiSummary(markets, fx, headlines); if (summary) summaryMode = "ai"; } catch (e) { log.push("ai: " + e.message); }
if (!summary) summary = rulesSummary(markets, fx, headlines);

const brief = {
  generated_at: new Date().toISOString(), summary_mode: summaryMode, peg: cfg.eur_xaf_peg, fx,
  markets, static_rates: cfg.static_rates, agenda: cfg.agenda,
  categories: cfg.news.map(n => ({ id: n.cat, en: n.label_en, fr: n.label_fr })),
  summary, news: headlines.map((h, i) => ({ id: "n" + i + "-" + h.date.slice(0, 10), ...h })), log
};
await fs.mkdir(path.join(ROOT, "data"), { recursive: true });
await fs.writeFile(path.join(ROOT, "data", "brief.json"), JSON.stringify(brief, null, 1));
console.log(`brief.json written: ${markets.length} markets, ${headlines.length} headlines, summary=${summaryMode}`);
if (log.length) console.log("warnings:\n" + log.join("\n"));
