// Business Desk: builds data/brief.json from live prices, news and an optional AI summary.
// Runs on GitHub Actions (Node 20+). No npm packages needed.
// Env: ANTHROPIC_API_KEY, or free GEMINI_API_KEY / GROQ_API_KEY, or (OPENAI_API_KEY + OPENAI_MODEL). Optional: ANTHROPIC_MODEL. MOCK_DIR for offline tests.
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
  // Retry politely when a source rate-limits us (429) or hiccups (5xx)
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": kind === "json" ? "application/json" : "application/rss+xml,text/xml" } });
    if (r.ok) return kind === "json" ? r.json() : r.text();
    if (attempt < 2 && (r.status === 429 || r.status >= 500)) { await new Promise(res => setTimeout(res, 5000 * (attempt + 1))); continue; }
    throw new Error(`${r.status} ${url}`);
  }
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
// Tidy a headline: drop source tags, shouting prefixes and stray spacing
function cleanTitle(t, source) {
  t = String(t || "").replace(/\s+/g, " ").trim();
  if (source) for (const sep of [" - ", " | ", " – ", " — "]) if (t.toLowerCase().endsWith((sep + source).toLowerCase())) t = t.slice(0, -(sep.length + source.length));
  t = t.replace(/\s[|–—-]\s[^|–—-]{2,30}\.(com|fr|net|org|info|cg|cm|ci|sn|africa)$/i, "");
  t = t.replace(/^(EXCLUSIVE|EXCLUSIF|BREAKING|URGENT|VIDEO|VIDÉO|PHOTOS?|LIVE|DIRECT|UPDATE \d+|ANALYSIS|ANALYSE|INTERVIEW|ENTRETIEN|OPINION|TRIBUNE)\s*[:\-–|]\s*/i, "");
  t = t.replace(/^\((VIDEO|VIDÉO|PHOTOS?|AUDIO)\)\s*/i, "").replace(/\s+([,.])/g, "$1");
  if (t === t.toUpperCase() && /[A-Z]{4}/.test(t)) t = t.charAt(0) + t.slice(1).toLowerCase();   // ALL CAPS headline
  return t.trim();
}
function cleanDesc(d, title) {
  d = decode(String(d || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  d = d.replace(/^By [A-Z][\w.'-]+(?: [A-Z][\w.'-]+){0,3}\s+(?=[A-Z]{2,})/, "").replace(/^[A-ZÀ-Ý][A-ZÀ-Ý .,'’-]{1,40}(?:,\s*\w{3,9}\.?\s*\d{1,2})?\s*\([^)]{2,30}\)\s*[-–—]\s*/, "");
  if (!d || d.length < 40) return null;
  const tw = title.toLowerCase().slice(0, 40);
  if (d.toLowerCase().startsWith(tw)) return null;                         // just repeats the headline
  if (/cookie|subscribe|abonnez|javascript|sign up|newsletter|all rights reserved/i.test(d)) return null;
  if (d.length > 230) d = d.slice(0, 230).replace(/\s+\S*$/, "") + "…";
  return d;
}
async function newsQuery(cat, q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q.q + " when:" + cfg.news_max_age_days + "d")}&hl=${q.hl}&gl=${q.gl}&ceid=${q.gl}:${q.hl}`;
  const xml = await get(url, "xml");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]).map(b => {
    let title = tag(b, "title");
    const source = tag(b, "source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    title = cleanTitle(title, source);
    return { cat, lang: q.hl, title, source: source || "Google News", url: tag(b, "link"), date: new Date(tag(b, "pubDate") || Date.now()).toISOString() };
  }).filter(x => x.title && x.url);
}
/* ---------- Importance score: keeps the big stories, drops the filler ---------- */
const SRC_TOP = /\b(reuters|bloomberg|financial times|ft\.com|the economist|wall street journal|wsj|associated press|ap news|afp|bbc|cnbc|nikkei|le monde|les echos|jeune afrique|agence ecofin|ecofin|rfi|the africa report|african business|business insider africa|semafor|la tribune|france 24|tv5monde|imf|banque mondiale|world bank|beac|bceao|sika finance|financial afrik|investir au cameroun|ecomatin|la nouvelle tribune|forbes afrique|capital finance)\b/i;
const SRC_LOW = /\b(blog|wordpress|medium|tv\b|web tv|radio|news24\.cd|benin web)\b/i;
const KEY_UP = /\b(beac|cemac|cémac|réserves?|reserves|souverain\w*|sovereign|bancaires?|bourse|brvm|stock|fonds|funds?|rachat|takeover|bceao|uemoa|imf|fmi|world bank|banque mondiale|afdb|bad|bdeac|eurobonds?|bonds?|obligat\w*|debt|dette|budget|loi de finances|inflation|interest rates?|taux|central bank|banque centrale|fed|ecb|bce|gdp|pib|growth|croissance|recession|récession|oil|pétrole|brent|opec|opep|gas|gaz|dollar|euro|fcfa|cfa|devise|currency|exchange rate|tariffs?|droits de douane|sanctions|default|défaut|downgrade|rating|notation|moody'?s|fitch|s&p|banks?|banques?|bank\w*|treasury|trésor|liquidity|liquidité|investment|investissement|ipo|merger|fusion|acquisition|election|élection|coup|government|gouvernement|minist\w*|president|président|strike|grève|shortage|pénurie|prices?|prix)\b/i;
const KEY_DOWN = /\b(football|soccer|basket\w*|can 20\d\d|ligue 1|match|sport\w*|concert|music|musique|festival|film|cinéma|miss|beauty|beauté|celebrity|célébrit\w*|horoscope|recipe|recette|fashion|mode|wedding|mariage|anniversary|anniversaire|célèbrent|celebrates?|award|prix d'excellence|gala|coconut|noix de coco|church|église|pilgrim\w*|obituary|nécrologie|lottery|loto)\b/i;
const FOLLOW_RE = (cfg.follow || []).length ? new RegExp("\\b(" + cfg.follow.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i") : null;
function importance(h) {
  let s = 1;
  if (FOLLOW_RE && FOLLOW_RE.test(h.title)) s += 1;                 // topics Rayan follows
  if (SRC_TOP.test(h.source)) s += 1.5; else if (SRC_LOW.test(h.source)) s -= 0.5;
  const up = (h.title.match(new RegExp(KEY_UP.source, "gi")) || []).length;
  s += Math.min(2, up * 0.7);
  if (KEY_DOWN.test(h.title)) s -= 2;
  if (cut(h.title)) s -= 0.3;
  const ageH = (Date.now() - new Date(h.date)) / 36e5;
  s -= Math.min(1.5, Math.max(0, ageH - 12) / 24);       // fresher is better, gently
  return Math.round(Math.max(0, Math.min(5, s)) * 10) / 10;
}
async function news(n) {
  const all = [];
  for (const q of n.queries) {
    try { all.push(...await newsQuery(n.cat, q)); } catch (e) { log.push(`news ${n.cat} (${q.hl}): ${e.message}`); }
  }
  all.forEach(h => h.score = importance(h));
  const keep = all.filter(h => h.score >= 1.5);                 // drop the filler when there is enough real news
  const pool = keep.length >= 5 ? keep : all;
  return pool.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, cfg.news_per_category);
}

/* ---------- Summary: AI if a key is set, rules otherwise ---------- */
const SIXTY_PICK = { worldwide: 3, africa: 2, congo: 2, cfo: 1 }; // the edition: 8 stories, about 4 minutes
// A headline Google News cut short ends with "…" or a dangling small word ("…lever près de")
function cut(t) { return /(\u2026|\.\.\.)\s*$/.test(t) || /\s(de|du|des|la|le|les|l'|d'|à|au|aux|et|en|pour|près|sur|par|avec|dans|un|une|of|the|to|a|an|and|for|in|on|with|at|by|from|as)$/i.test(t.trim()); }
function fullTitle(h, cand) {           // use a longer title from Bing or the article if it continues ours
  if (!cand || !cut(h.title)) return;
  const a = h.title.replace(/(\u2026|\.\.\.)\s*$/, "").trim().toLowerCase().slice(0, 40), c = decode(cand).replace(/\s+[-|–]\s+[^-|–]{2,40}$/, "").trim();
  if (c.toLowerCase().startsWith(a) && c.length > h.title.length && !cut(c)) h.title = c;
}
function rulesSummary(markets, fx, headlines) {
  // A short, fresh briefing: rank by importance, freshness, a real summary and a hard number
  const ageH = h => (Date.now() - new Date(h.date)) / 36e5;
  const rank = h => (h.score || 0) + (h.desc ? 1 : 0) + (ageH(h) < 24 ? 1 : ageH(h) > 48 ? -2 : 0) + (/\d/.test(h.title) ? 0.5 : 0) + (h.cat === "worldwide" ? 0.3 : 0);
  const pool = headlines.filter(h => h.cat in SIXTY_PICK && !cut(h.title)).sort((a, b) => rank(b) - rank(a));
  const pick = [], per = {};
  const take = (max, n) => { for (const h of pool) { if (pick.length >= n) break; if (pick.includes(h) || (per[h.cat] || 0) >= max) continue; pick.push(h); per[h.cat] = (per[h.cat] || 0) + 1; } };
  take(1, Object.keys(SIXTY_PICK).length);                    // one per section first: the top 3 come from here
  take(3, Object.values(SIXTY_PICK).reduce((a, b) => a + b, 0));   // then the rest, at most 3 per section
  const out = { en: [], fr: [] };
  pick.forEach((h, k) => {
    const lab = cfg.news.find(x => x.cat === h.cat) || { label_en: h.cat, label_fr: h.cat };
    const it = { level: k < 3 ? "high" : "", cat: h.cat, owner: lab.label_en, title: (h.t && h.t.en) || h.title, detail: (h.d && h.d.en) || "", source: h.source, date: h.date, impact: "", url: h.url, img: h.img || null };
    out.en.push(it); out.fr.push({ ...it, owner: lab.label_fr, title: (h.t && h.t.fr) || h.title, detail: (h.d && h.d.fr) || "" });
    (out.ar = out.ar || []).push({ ...it, owner: lab.label_ar || lab.label_en, title: (h.t && h.t.ar) || it.title, detail: (h.d && h.d.ar) || it.detail });
  });
  return out;
}

/* v34: one AI caller for every provider. Free options: Gemini (Google AI Studio) or Groq. */
function aiProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) return "openai";
  return null;
}
async function llm(prompt, maxTokens = 3000) {
  const p = aiProvider(); if (!p) return null;
  if (p === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(120e3),
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }) });
    if (!r.ok) throw new Error("Anthropic " + r.status + " " + (await r.text()).slice(0, 300));
    return (await r.json()).content?.map(c => c.text || "").join("");
  }
  const C = {
    gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: process.env.GEMINI_API_KEY, models: [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-flash-lite-latest"] },
    groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: process.env.GROQ_API_KEY, models: [process.env.GROQ_MODEL, "openai/gpt-oss-120b", "llama-3.3-70b-versatile"] },
    openai: { url: "https://api.openai.com/v1/chat/completions", key: process.env.OPENAI_API_KEY, models: [process.env.OPENAI_MODEL] }
  }[p];
  let last = "";
  for (const model of C.models.filter(Boolean)) {
    for (const extra of p === "gemini" ? [{ reasoning_effort: "low" }, {}] : [{}]) {   // less "thinking" = faster answers
      let r;
      try {
        r = await fetch(C.url, { method: "POST", signal: AbortSignal.timeout(240e3),
          headers: { "authorization": "Bearer " + C.key, "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: maxTokens, ...extra, messages: [{ role: "user", content: prompt }] }) });
      } catch (e) { last = `${model}: ${e.message}`; log.push("ai try " + last); break; }   // timeout: move on to the next model
      if (r.ok) { const t = (await r.json()).choices?.[0]?.message?.content; if (t) { log.push(`ai: ${p} ${model}`); return t; } last = model + " empty"; log.push("ai try " + last); break; }
      last = `${model} ${r.status} ${(await r.text()).slice(0, 160).replace(/\s+/g, " ")}`; log.push("ai try " + last);
      if (r.status === 401 || r.status === 403) throw new Error(p + " " + last);   // bad key
      if (r.status !== 400) break;   // 400 may be the reasoning option: retry once without it
    }
  }
  throw new Error(p + " " + last);
}
async function aiSummary(markets, fx, headlines) {
  const pool = headlines.map((h, i) => ({ i, cat: h.cat, title: h.title, source: h.source, date: h.date.slice(0, 10) }))
                        .filter(h => h.cat in SIXTY_PICK);
  if (!pool.length) return null;
  const labels = Object.fromEntries(cfg.news.map(n => [n.cat, { en: n.label_en, fr: n.label_fr }]));
  const prompt = `You edit "Overnight in 60 seconds", the top of a morning news brief read by Rayan, a finance executive in ${cfg.city}, Republic of Congo.

From the headlines below, pick the 20 most important news stories of the last 24 hours for a video news feed: 6 from "worldwide" (mostly economy, finance and banking), 5 from "africa" (West and Central Africa), 5 from "congo" (Republic of Congo and CEMAC) and 4 from "cfo" (treasury, FX, rates, BEAC). Prefer major political, economic and security news over minor or promotional items; skip duplicates. Order them as a mixed feed: the most important story first, and never two stories from the same category in a row.
Score every candidate's importance from 1 (filler) to 5 (market-moving); never pick a story scoring below 3 (sport, culture, ceremonies, anniversaries, PR, minor local items), even if a section then has fewer stories.
For each give: cat (worldwide|africa|congo|cfo), score (3-5), level ("high" if score 5, else "med"), title (clear, max 14 words, rewritten from the headline), detail (one sentence saying what happened, using only what the headline says; never invent facts or numbers), impact ("Impact": one short factual sentence on the consequence for markets, prices, rates, budgets or the region, only if the headline supports it; otherwise ""; never speculate, never mention any company that is not in the story), source_index (the headline's i).
Also write "takeaway": one line (max 22 words) that sums up the day for Rayan, mixing the biggest story with the key market move (oil, dollar, CFA), in English and French.
Pick 8 stories: put the 3 most important first (one per section where possible), prefer the last 24 hours, and prefer stories with a hard number (rate, amount, %).
Return JSON only: {"takeaway":{"en":"...","fr":"..."},"en":[8 items],"fr":[the same items in natural French]}.

MARKETS: ${JSON.stringify(markets.filter(m => ["usdxaf","brent","gold","eurusd"].includes(m.id)).map(m => ({ name: m.name, value: +m.value.toFixed(2), change_pct: +(m.change_pct || 0).toFixed(2) })))}

HEADLINES:
${JSON.stringify(pool)}`;

  const text = await llm(prompt, 6000);
  if (!text) return null;

  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  for (const lang of ["en", "fr"]) {
    if (!Array.isArray(json[lang]) || json[lang].length === 0) throw new Error("AI output missing " + lang);
    json[lang] = json[lang].slice(0, 20).map(x => {
      const h = Number.isInteger(x.source_index) ? headlines[x.source_index] : null;
      const cat = (h && h.cat) || x.cat;
      return { level: x.level === "high" || x.score >= 5 ? "high" : "med", score: Number(x.score) || null, cat, source: h ? h.source : "", date: h ? h.date : null, img: h ? h.img || null : null, owner: (labels[cat] || {})[lang] || "", title: String(x.title || ""),
               detail: String(x.detail || ""), impact: String(x.impact || "").replace(/^\s*(?:impact(?: pour [^:]{0,30})?|الأثر|التأثير|الأثر المتوقع)\s*[:：]\s*/i, ""), url: h ? h.url : null };
    });
  }
  if (!json.takeaway || !json.takeaway.en) json.takeaway = null;
  return json;
}
function rulesTakeaway(markets, summary) {
  const M = id => markets.find(m => m.id === id), p = m => m && typeof m.change_pct === "number" ? (m.change_pct > 0 ? "+" : m.change_pct < 0 ? "−" : "") + Math.abs(m.change_pct).toFixed(1) + "%" : null;
  const b = M("brent"), u = M("usdxaf"), g = M("gold");
  const mk = [b && p(b) && "Brent " + p(b), u && p(u) && "USD/XAF " + p(u), g && p(g) && "gold " + p(g)].filter(Boolean).join(", ");
  const top = (summary.en || [])[0], topFr = (summary.fr || [])[0];
  return { en: (mk ? "Markets: " + mk + "." : "") + (top ? " Top story: " + top.title : ""), fr: (mk ? "Marchés : " + mk.replace("gold", "or").replace(/\./g, ",") + "." : "") + (topFr ? " À la une : " + topFr.title : "") };
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
/* v33: real photos. Google News links are redirects: decode them to the publisher's page and read its cover photo (og:image). */
let GN = {}, photoDeadline = 0;
const bump = k => { why[k] = (why[k] || 0) + 1; };
async function gnDecode(u) {
  const id = (u.match(/\/articles\/([^?#]+)/) || [])[1]; if (!id) return null;
  let sg, ts, html = "";
  for (const base of ["https://news.google.com/articles/", "https://news.google.com/rss/articles/"]) {
    try { html = await fetchText(base + id + "?hl=en-US&gl=US&ceid=US:en", 8000); } catch (e) { continue; }
    sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1]; ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    if (sg && ts) break;
  }
  if (!sg || !ts) { bump("gnsig"); if (!why.gnpage) why.gnpage = ((html.match(/<title>([^<]{0,60})/i) || [])[1] || html.slice(0, 60)).replace(/\s+/g, " "); return null; }
  const req = [[["Fbv4je", JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]), null, "generic"]]];
  const r = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", { method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" },
    body: "f.req=" + encodeURIComponent(JSON.stringify(req)) });
  const t = await r.text(), part = t.split("\n\n")[1]; if (!part) { bump("gnresp"); return null; }
  const inner = JSON.parse(JSON.parse(part)[0][2]); const art = inner && inner[1];
  return typeof art === "string" && /^https?:/.test(art) ? art : null;
}
async function publisherPhoto(h) {
  if (!/news\.google\.com\/rss\/articles\//.test(h.url || "")) return null;
  const art = await gnDecode(h.url); if (!art) return null;
  const html = await fetchText(art, 7000);
  const od = (html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]*>/i) || [""])[0].match(/content=["']([^"']+)/i);
  const dd = od && cleanDesc(od[1], h.title); if (dd && (!h.desc || dd.length > h.desc.length)) h.desc = dd;
  return ogImage(html, art);
}
async function photoFor(h) {
  const c = GN[h.url];
  if (c && c.img) { bump("cached"); return c.img.replace(/^http:\/\/www\.bing\.com/, "https://www.bing.com"); }
  if (!c || c.v !== 2 || Date.now() - c.at > 6 * 36e5) {
    if (Date.now() < photoDeadline) {
      try { const img = await publisherPhoto(h); if (img) { bump("publisher"); return img; } } catch (e) { bump("gnerr"); }
    }
  }
  let alt = null;
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
      const bsrc = tag(b, "News:Source").toLowerCase().replace(/[^a-z0-9]/g, ""), hsrc = (h.source || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/com$/, "");
      if (!bsrc || !hsrc || !(bsrc.includes(hsrc.slice(0, 8)) || hsrc.includes(bsrc.slice(0, 8)))) {   // another outlet's photo of the same story: keep only as a last resort
        why.othersrc = (why.othersrc || 0) + 1;
        const th = (b.match(/<News:Image>([\s\S]*?)<\/News:Image>/i) || [])[1];
        if (!alt && th && hit >= 4 && hit / Math.max(1, Math.min(want.size, got.size)) >= 0.6) alt = decode(th).replace(/^http:/, "https:") + "&w=900&h=1200&c=7&rs=1";
        continue; }
      fullTitle(h, tag(b, "title"));
      if (!h.desc) h.desc = cleanDesc(tag(b, "description"), h.title);
      const thumb = (b.match(/<News:Image>([\s\S]*?)<\/News:Image>/i) || [])[1];
      let article = null; try { article = new URL(decode(tag(b, "link"))).searchParams.get("url"); } catch {}
      if (article) { try { const html = await fetchText(article, 6000); const ot = (html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i) || [""])[0].match(/content=["']([^"']+)/i); if (ot) fullTitle(h, ot[1]);
        const od = (html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]*>/i) || [""])[0].match(/content=["']([^"']+)/i);
        const dd = od && cleanDesc(od[1], h.title); if (dd && (!h.desc || dd.length > h.desc.length)) h.desc = dd;
        const og = ogImage(html, article); if (og) return og; } catch {} }
      if (thumb) return decode(thumb).replace(/^http:/, "https:") + "&w=900&h=1200&c=7&rs=1";
    }
    why.nomatch = (why.nomatch || 0) + 1;
  }
  if (alt) bump("sameStoryOtherOutlet");
  return alt;
}
async function addPhotos(list) {
  const queue = [...list]; let n = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) { const h = queue.shift(); try { const img = await photoFor(h); if (img) { h.img = img; n++; } if (h.url) GN[h.url] = { v: 2, img: img || null, at: img && GN[h.url] && GN[h.url].img === img ? GN[h.url].at : Date.now() }; } catch (e) {} }
  }));
  log.push(`photos: ${n}/${list.length} ${JSON.stringify(why)}`);
}

/* ---------- Read: article of the day ---------- */
async function reads() {
  const rc = cfg.reads; if (!rc) return null;
  const all = [], seen = new Set();
  const generic = /^(business|finance|economics|the world (ahead|this week)|briefing|leaders|letters|podcast|video|newsletter)\b|check out this job|\bjobs? at\b|we('| a)re hiring|apply now|job opening|offre d'emploi|\brecrute\b|webinar|sponsored|partner content/i;
  for (const s of rc.sources) {
    const hl = s.hl || "en", gl = s.gl || "US";
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(s.q + " when:" + rc.max_age_days + "d")}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl}`;
    try {
      const xml = await get(url, "xml");
      [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, rc.per_source + 2).forEach(m => {
        let title = decode(tag(m[1], "title")); const src = tag(m[1], "source") || s.name;
        if (title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
        title = title.replace(/\s+[-|]\s+(Harvard Business Review|The Economist|Financial Times|FT|McKinsey.*|MIT Sloan.*|Knowledge at Wharton|CFO\.com|CFO Dive|BCG|Deloitte.*|IMF.*|Project Syndicate|The Africa Report.*|Jeune Afrique)$/i, "").trim();
        const key = title.toLowerCase().slice(0, 60);
        if (!title || !tag(m[1], "link") || title.split(/\s+/).length < 4 || generic.test(title) || cut(title) || seen.has(key)) return;
        seen.add(key);
        all.push({ title, source: s.name, lang: hl, paywall: !!s.paywall, url: tag(m[1], "link"), date: new Date(tag(m[1], "pubDate") || Date.now()).toISOString() });
      });
    } catch (e) { log.push(`read ${s.name}: ${e.message}`); }
  }
  if (!all.length) return null;
  const boost = new RegExp(rc.boost.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const ageDays = a => (Date.now() - new Date(a.date)) / 864e5;
  const score = a => (a.title.match(boost) || []).length * 2 + (a.paywall ? 0 : 0.5) + Math.max(0, 3 - ageDays(a) / 2);
  const ranked = all.sort((a, b) => score(b) - score(a) || b.date.localeCompare(a.date));
  const pick = ranked[0], rest = ranked.slice(1), more = [], per = {};
  for (const a of rest) { if (more.length >= (rc.more || 12)) break; if ((per[a.source] || 0) < 2) { more.push(a); per[a.source] = (per[a.source] || 0) + 1; } }
  return { pick, more };
}
async function aiRead(pick) {
  if (!pick || !aiProvider()) return null;
  const prompt = `A finance executive in Brazzaville, Republic of Congo, will read this article today: "${pick.title}" (${pick.source}). Using only the title, write JSON {"en":{"why":"..."},"fr":{"title":"...","why":"..."}} where "why" is one or two sentences on what a CFO can take from it, without inventing facts, and fr.title is a French translation of the title.`;
  const t = await llm(prompt, 1200); if (!t) return null;
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
// Worldwide = today's selected events. Congo and Lebanon = the best moments within ±3 days
// (Wikipedia has too few for one date), preferring events over births/deaths and today over other days.
const OTD_CG = /congo|brazzaville|pointe-noire|sassou|lissouba|ngouabi|massamba|youlou|kolélas|kolelas/i;
const OTD_CG_STRONG = /brazzaville|pointe-noire|r[ée]publique du congo|republic of (the )?congo|congo-brazzaville|sassou|lissouba|ngouabi|massamba|youlou|kol[ée]las/i;
const OTD_CG_NOT = /d[ée]mocratique|democratic|kinshasa|za[iï]re|l[ée]opoldville|katanga|belgian congo|congo belge|\brdc\b|\bdrc\b|kabila|lumumba|mobutu|tshisekedi|kasa[iï]/i;
const OTD_LB = /\b(leban\w*|liban\w*|beirut|beyrouth|baalbek|byblos|hezbollah|fairuz|maronite)\b/i;
async function onThisDay() {
  const now = new Date(), days = [];
  for (let off = -3; off <= 3; off++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + off)); days.push([off, String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")]); }
  const raw = { en: [], fr: [] }, world = {};
  for (const lang of ["en", "fr"]) for (const [off, mm, dd] of days) {
    try {
      const j = await get(`https://${lang}.wikipedia.org/api/rest_v1/feed/onthisday/all/${mm}/${dd}`);
      if (off === 0) world[lang] = pickEvents((j.selected && j.selected.length ? j.selected : j.events) || []);
      const add = (arr, kind) => (arr || []).forEach(e => e.text && e.year && raw[lang].push({ year: e.year, text: e.text, kind, off, md: mm + "-" + dd, url: e.pages?.[0]?.content_urls?.desktop?.page || null }));
      add(j.selected, "event"); add(j.events, "event"); add(j.births, "born"); add(j.deaths, "died");
    } catch (e) { log.push(`on this day ${lang} ${mm}/${dd}: ${e.message}`); }
  }
  const pick = (lang, re, strong, not) => {
    const ok = x => re.test(x.text) && !OTD_GRIM.test(x.text) && !/kidnap|hijack|enl[èe]v/i.test(x.text) && !(not && not.test(x.text) && !(strong && strong.test(x.text))) && (x.kind === "event" || !strong || strong.test(x.text));
    let L = raw[lang].filter(ok); if (L.length < 2) L = L.concat(raw[lang === "en" ? "fr" : "en"].filter(ok));
    const sc = x => (x.kind === "event" ? 3 : 0) + (3 - Math.abs(x.off)) + (strong && strong.test(x.text) ? 3 : 0);
    const seen = new Set();
    return L.sort((a, b) => sc(b) - sc(a)).filter(x => { const k = x.md + x.year + x.kind; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 3).sort((a, b) => a.off - b.off || b.year - a.year).map(({ off, ...x }) => x);
  };
  const out = {};
  for (const lang of ["en", "fr"]) out[lang] = { world: world[lang] || [], congo: pick(lang, OTD_CG, OTD_CG_STRONG, OTD_CG_NOT), lebanon: pick(lang, OTD_LB, null, null) };
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

let prevBrief = {};
try { prevBrief = JSON.parse(await fs.readFile(path.join(ROOT, "data", "brief.json"), "utf8")); } catch {}
let headlines = [];
const health = { sections: {}, markets_ok: 0, markets_total: 0 };
for (const n of cfg.news) {
  let got = await news(n);
  const fresh = got.length;
  // Never leave a section empty: if a source failed, keep the last good stories for that section
  if (got.length < 3) {
    const old = (prevBrief.news || []).filter(h => h.cat === n.cat && !got.some(g => g.title === h.title));
    if (old.length) { got = [...got, ...old].slice(0, cfg.news_per_category || 8); log.push(`reused ${old.length} earlier ${n.cat} stories`); }
  }
  // A section is "fresh" when its feed answered and its newest story is under 36 hours old
  const newest = got.reduce((m, h) => h.date > m ? h.date : m, "");
  health.sections[n.cat] = { fresh, total: got.length, ok: fresh >= 3 && newest && (Date.now() - new Date(newest)) / 36e5 < 36 };
  headlines.push(...got);
  if (!MOCK) await new Promise(res => setTimeout(res, 800));   // space out Google News requests
}
const seen = new Set();
headlines = headlines.filter(h => { const k = h.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
GN = prevBrief.gn_cache || {}; photoDeadline = Date.now() + 150e3;
if (!MOCK) await addPhotos(headlines.filter(h => !h.img));

/* ---------- Both languages: every headline and summary in English and French ---------- */
let gBlocked = false, mmLeft = 30;
async function gTranslate(chunk, sl, tl) {
  const q = encodeURIComponent(chunk.join("\n"));
  const urls = [
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${q}`,
    `https://translate.google.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${q}`,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&q=${q}`
  ];
  for (const [k, u] of urls.entries()) {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, signal: AbortSignal.timeout(10000) });
        if (r.status === 429) { await new Promise(res => setTimeout(res, 2500 * (a + 1))); continue; }
        if (!r.ok) break;
        const j = await r.json();
        const txt = k < 2 ? j[0].map(x => x[0]).join("") : (Array.isArray(j[0]) ? j[0][0] : j[0]);
        const lines = String(txt).split("\n");
        if (lines.length === chunk.length) return lines.map(l => l.trim());
        break;
      } catch { break; }
    }
  }
  return null;
}
async function mmTranslate(text, sl, tl) {        // MyMemory fallback, one short text at a time
  if (mmLeft-- <= 0 || text.length > 480) return null;
  try {
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|${tl}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const t = j && j.responseStatus == 200 && j.responseData && j.responseData.translatedText;
    return t && !/MYMEMORY WARNING|QUERY LENGTH/i.test(t) ? decode(t) : null;
  } catch { return null; }
}
async function translateBatch(texts, sl, tl) {
  const out = new Array(texts.length).fill(null);
  let i = 0;
  while (i < texts.length) {
    const start = i, chunk = []; let len = 0;
    while (i < texts.length && (len + texts[i].length < 1500 || !chunk.length)) { chunk.push(texts[i]); len += texts[i].length + 1; i++; }
    const got = gBlocked ? null : await gTranslate(chunk, sl, tl);
    if (got) got.forEach((l, k) => out[start + k] = l);
    else {
      if (!gBlocked) log.push("translate: Google unavailable, using MyMemory");
      gBlocked = true;
      for (let k = 0; k < chunk.length; k++) if (chunk[k].length > 3) out[start + k] = await mmTranslate(chunk[k], sl, tl);
    }
    if (!MOCK) await new Promise(res => setTimeout(res, 400));
  }
  return out;
}
const isFrench = s => /[àâçéèêëîïôûùüœ]|\b(le|la|les|des|du|une|et|pour|dans|sur|avec|aux|au|est|sont)\b/i.test(s);
async function bilingual(list) {
  if (MOCK) return;
  // Reuse translations from the previous run: most headlines stay the same from one hour to the next
  const prevT = new Map((prevBrief.news || []).filter(h => h.t).map(h => [h.title, h]));
  let n = 0, reused = 0;
  for (const h of list) { const p = prevT.get(h.title); if (p && p.t && p.t.ar && Object.values(p.t).some(v => v !== h.title)) { h.t = p.t; if (p.d) h.d = p.d; reused++; } }
  // Translate the stories people actually see first (top 6 of each section), then the rest
  const order = cfg.news.flatMap(c => list.filter(h => h.cat === c.cat)).sort((a, b) => (list.filter(x => x.cat === a.cat).indexOf(a) < 6 ? 0 : 1) - (list.filter(x => x.cat === b.cat).indexOf(b) < 6 ? 0 : 1));
  for (const [sl, tl] of [["en", "fr"], ["fr", "en"]]) {
    const items = order.filter(h => !h.t && (isFrench(h.title) ? "fr" : "en") === sl);
    const texts = items.flatMap(h => [h.title, h.desc || ""]).map(x => x || ".");
    const tr = await translateBatch(texts, sl, tl);
    items.forEach((h, k) => {
      const tt = tr[2 * k], td = h.desc ? tr[2 * k + 1] : null;
      h.t = { [sl]: h.title, [tl]: tt && tt.length > 3 ? cleanTitle(tt) : h.title };
      if (h.desc) h.d = { [sl]: h.desc, [tl]: td && td.length > 10 ? td : h.desc };
      if (tt) n++;
    });
  }
  // Arabic, from the English version
  const needAr = list.filter(h => h.t && !h.t.ar);
  if (needAr.length) {
    const tr = await translateBatch(needAr.flatMap(h => [h.t.en || h.title, (h.d && h.d.en) || h.desc || "."]), "en", "ar");
    needAr.forEach((h, k) => { const tt = tr[2 * k], td = tr[2 * k + 1]; h.t.ar = tt && tt.length > 3 ? tt : (h.t.en || h.title); if (h.d || h.desc) { h.d = h.d || { en: h.desc }; h.d.ar = td && td.length > 10 ? td : (h.d.en || h.desc); } });
  }
  log.push(`translated ${n} new, reused ${reused}, of ${list.length}`);
}
await bilingual(headlines);

/* ---------- One story per event, filed under the right region ---------- */
const CEMAC_RE = /\b(congo|congolais\w*|congo-brazzaville|brazzaville|pointe-noire|république du congo|republic of (the )?congo|sassou|cemac|cémac|beac|bdeac|cosumaf|bvmac|cameroun|cameroon|gabon|gabonais\w*|tchad|chad|centrafri\w*|central african republic|guinée équatoriale|equatorial guinea|douala|yaoundé|libreville|n'djamena|malabo|bangui)\b/i;
const OTHER_AFR_RE = /\b(uemoa|waemu|bceao|brvm|ecowas|cedeao|sénégal\w*|senegal\w*|côte d['’]ivoire|ivory coast|ivoirien\w*|mali|burkina( faso)?|niger|bénin|benin|togo|guinée|guinea|nigeria\w*|ghana\w*|kenya\w*|rdc|drc|kinshasa|abidjan|dakar|lagos|accra|nairobi|maroc|morocco|egypt\w*|égypte|afrique du sud|south africa|ethiopia|éthiopie)\b/i;
const txtOf = h => [h.title, h.t && h.t.en, h.t && h.t.fr].filter(Boolean).join(" ");
let moved = 0;
for (const h of headlines) {
  const tx = txtOf(h), drc = /\b(rdc|drc|kinshasa|démocratique|democratic)\b/i.test(tx) && !/brazzaville|cemac|cémac|beac/i.test(tx);
  const cem = CEMAC_RE.test(tx) && !drc, oth = OTHER_AFR_RE.test(tx) || drc;
  if (h.cat === "congo" && !cem) { h.cat = "africa"; moved++; }   // not about Congo or CEMAC: file under Africa
  else if (h.cat === "africa" && cem && !oth) { h.cat = "congo"; moved++; }
}
const toks = h => { const w = words((h.t && h.t.en) || h.title); return { set: new Set(w), nums: new Set(w.filter(x => /\d/.test(x))) }; };
const kept = [], tk = [];
let dups = 0;
for (const h of [...headlines].sort((a, b) => (b.score || 0) - (a.score || 0) || b.date.localeCompare(a.date))) {
  const a = toks(h);
  const dupOf = tk.findIndex(b => {
    const common = [...a.set].filter(x => b.set.has(x)).length, small = Math.min(a.set.size, b.set.size);
    const sharedNum = [...a.nums].some(x => b.nums.has(x) && x.length > 1);
    return small >= 3 && (common / small >= 0.6 || (sharedNum && common >= 3));
  });
  if (dupOf >= 0) { dups++; continue; }
  kept.push(h); tk.push(a);
}
headlines = headlines.filter(h => kept.includes(h));
log.push(`dedupe: ${dups} duplicates removed, ${moved} re-filed by region`);

/* ---------- Markets: one line on why each price moved, from today's headlines ---------- */
const MK_KEYS = {
  usdxaf: /\b(dollar|greenback|euro|fed|federal reserve|ecb|bce|treasur(y|ies)|yields?|rendements?|forex|currenc(y|ies)|devises?|taux de change|rate cuts?|rate hikes?|baisse des taux|hausse des taux)\b/i,
  eurusd: /\b(dollar|greenback|euro|fed|federal reserve|ecb|bce|treasur(y|ies)|yields?|forex|currenc(y|ies)|devises?|rate cuts?|rate hikes?)\b/i,
  brent: /\b(oil|crude|brent|wti|opec\+?|opep|barrels?|barils?|pétrole|petrol|brut)\b/i,
  wti: /\b(oil|crude|brent|wti|opec\+?|opep|barrels?|barils?|pétrole|brut|shale)\b/i,
  gold: /\b(gold|bullion|precious metals?|safe[- ]haven|l'or|cours de l'or|métaux précieux|valeur refuge)\b/i,
  silver: /\b(silver|precious metals?|argent métal|métaux précieux|gold)\b/i,
  sugar: /\b(sugar|sucre)\b/i
};
for (const m of markets) {
  const re = MK_KEYS[m.id]; if (!re || typeof m.change_pct !== "number") continue;
  if (Math.abs(m.change_pct) < 0.2) { m.why = { en: "Little change since the previous close.", fr: "Peu de variation depuis la clôture précédente.", ar: "تغيّر طفيف منذ الإغلاق السابق." }; continue; }
  const cand = headlines.filter(h => re.test(h.title) || (h.t && re.test(h.t.en || "")) || (h.d && re.test((h.d.en || "") + " " + (h.d.fr || ""))))
    .map(h => ({ h, s: (h.score || 0) + (re.test(h.title) || (h.t && re.test(h.t.en || "")) ? 1.5 : 0) + (h.cat === "markets" ? 1 : 0) - Math.max(0, (Date.now() - new Date(h.date)) / 36e5 - 24) / 12 }))
    .sort((a, b) => b.s - a.s);
  const best = cand[0] && cand[0].h;
  if (best) { m.why = { en: (best.t && best.t.en) || best.title, fr: (best.t && best.t.fr) || best.title, ar: (best.t && best.t.ar) || (best.t && best.t.en) || best.title, source: best.source, url: best.url }; continue; }
  // No headline: explain the move by what moved with it
  const PEERS = { gold: ["silver", "eurusd"], silver: ["gold"], brent: ["wti"], wti: ["brent"], sugar: ["brent"], eurusd: ["gold"], usdxaf: ["eurusd"] };
  const pc = x => (x > 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "%";
  const peers = (PEERS[m.id] || []).map(id => markets.find(x => x.id === id)).filter(x => x && typeof x.change_pct === "number");
  const up = m.change_pct > 0, same = peers.filter(p => Math.sign(p.change_pct) === Math.sign(m.change_pct) && Math.abs(p.change_pct) >= 0.2);
  const frName = { Gold: "l'or", Silver: "l'argent", Brent: "le Brent", "Crude Oil WTI": "le WTI", "EUR/USD": "l'EUR/USD", Sugar: "le sucre" };
  m.why = same.length
    ? { en: `${up ? "Up" : "Down"} ${pc(m.change_pct).slice(1)}, moving with ${same.map(p => p.name + " (" + pc(p.change_pct) + ")").join(" and ")}: a broad ${up ? "rally" : "sell-off"} rather than one-off news.`,
        fr: `${up ? "En hausse" : "En baisse"} de ${pc(m.change_pct).slice(1).replace(".", ",")}, comme ${same.map(p => (frName[p.name] || p.name) + " (" + pc(p.change_pct).replace(".", ",") + ")").join(" et ")} : un mouvement d'ensemble plutôt qu'une nouvelle isolée.` }
    : { en: `${up ? "Up" : "Down"} ${pc(m.change_pct).slice(1)} with no single headline behind it yet.`, fr: `${up ? "En hausse" : "En baisse"} de ${pc(m.change_pct).slice(1).replace(".", ",")}, sans actualité précise pour l'instant.` };
  if (!m.why.ar) m.why.ar = same.length ? `${up ? "ارتفاع" : "انخفاض"} ${pc(m.change_pct).slice(1)} بالتوازي مع ${same.map(p => p.name + " (" + pc(p.change_pct) + ")").join(" و")}: حركة عامة وليست خبرًا منفردًا.` : `${up ? "ارتفاع" : "انخفاض"} ${pc(m.change_pct).slice(1)} دون خبر محدد حتى الآن.`;
}

const otd = await onThisDay();
if (otd && otd.en && !MOCK) {
  const groups = Object.keys(otd.en), flat = groups.flatMap(g => otd.en[g] || []);
  const tr = flat.length ? await translateBatch(flat.map(x => x.text || "."), "en", "ar") : [];
  let k = 0; otd.ar = {};
  for (const g of groups) otd.ar[g] = (otd.en[g] || []).map(x => ({ ...x, text: tr[k++] || x.text }));
}
// The briefing (Play video + article of the day) is rebuilt every 8 hours; news and markets every run.
let old = {};
try { old = JSON.parse(await fs.readFile(path.join(ROOT, "data", "brief.json"), "utf8")); } catch {}
const BRIEF_EVERY_H = 8, forced = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
// Two editions a day: a new one from 06:00 UTC (07:00 Brazzaville) and from 17:00 UTC (18:00)
const slotStart = (() => { const d = new Date(), h = d.getUTCHours(), s = new Date(d); s.setUTCMinutes(0, 0, 0);
  if (h >= 17) s.setUTCHours(17); else if (h >= 6) s.setUTCHours(6); else { s.setUTCDate(s.getUTCDate() - 1); s.setUTCHours(17); } return s; })();
const edition = slotStart.getUTCHours() === 6 ? "morning" : "evening";
const briefAge = old.summary_at ? (Date.now() - new Date(old.summary_at)) / 36e5 : 99;
const keepBrief = !forced && old.summary_at && new Date(old.summary_at) >= slotStart && (old.summary?.en || []).length >= 5;
if (keepBrief) log.push(`edition kept (${briefAge.toFixed(1)} h old)`);
const read = keepBrief && old.read ? old.read : await reads();
if (read && !keepBrief) { try { const w = await aiRead(read.pick); if (w) read.pick.ai = w; } catch (e) { log.push("ai read: " + e.message); } }
if (read && !keepBrief && !MOCK) await addPhotos([read.pick, ...read.more]);
if (read && !keepBrief && !MOCK) {                     // reading list in both languages
  const all = [read.pick, ...read.more];
  for (const [sl, tl] of [["en", "fr"], ["fr", "en"]]) {
    const items = all.filter(a => (isFrench(a.title) ? "fr" : "en") === sl);
    const tr = await translateBatch(items.map(a => a.title), sl, tl);
    items.forEach((a, k) => { a.t = { [sl]: a.title, [tl]: tr[k] && tr[k].length > 3 ? cleanTitle(tr[k]) : a.title }; });
  }
  const trA = await translateBatch(all.map(a => (a.t && a.t.en) || a.title), "en", "ar");
  all.forEach((a, k) => { a.t = a.t || {}; a.t.ar = trA[k] || a.t.en || a.title; });
}
if (read && !keepBrief) {                      // keep the last week of "article of the day" picks
  try {
    const prev = JSON.parse(await fs.readFile(path.join(ROOT, "data", "brief.json"), "utf8")).read || {};
    const k = a => a.title.toLowerCase().slice(0, 60);
    read.history = [prev.pick, ...(prev.history || [])].filter(a => a && a.title && k(a) !== k(read.pick))
      .filter((a, i, l) => l.findIndex(b => k(b) === k(a)) === i).slice(0, 7).map(({ ai, ...a }) => a);
  } catch { read.history = []; }
}

let summary = null, summaryMode = "rules", summaryAt = new Date().toISOString();
let takeaway = null;
if (keepBrief) { summary = old.summary; summaryMode = old.summary_mode || "ai"; summaryAt = old.summary_at; takeaway = old.takeaway || null; }
else {
  try { summary = await aiSummary(markets, fx, headlines); if (summary) summaryMode = "ai"; } catch (e) { log.push("ai: " + e.message); }
  if (summary && summary.takeaway) takeaway = summary.takeaway;
  if (summary) delete summary.takeaway;
  if (!summary) summary = rulesSummary(markets, fx, headlines);
  if (!takeaway) takeaway = rulesTakeaway(markets, summary);
  if (summary && summary.en && !summary.ar && !MOCK) {
    const E = summary.en, tr = await translateBatch(E.flatMap(x => [x.title || ".", x.detail || ".", x.impact || "."]), "en", "ar");
    summary.ar = E.map((x, k) => ({ ...x, title: tr[3 * k] || x.title, detail: x.detail ? (tr[3 * k + 1] || x.detail) : "", impact: x.impact ? (tr[3 * k + 2] || x.impact) : "" }));
  }
  // Market context: a story about oil, gold, the dollar... gets today's move for that market
  const fmtP = (x, fr) => (x > 0 ? "+" : "−") + Math.abs(x).toFixed(1).replace(".", fr ? "," : ".") + (fr ? " %" : "%");
  for (const lang of ["en", "fr", "ar"]) (summary[lang] || []).forEach((it, k) => {
    const en = (summary.en[k] || it).title + " " + ((summary.en[k] || it).detail || "");
    const m = markets.find(m => MK_KEYS[m.id] && typeof m.change_pct === "number" && Math.abs(m.change_pct) >= 0.2 && MK_KEYS[m.id].test(en));
    if (m && lang === "ar") { it.ctx = `${{ Gold: "الذهب", Silver: "الفضة", Brent: "برنت", "Crude Oil WTI": "خام WTI", "EUR/USD": "اليورو/الدولار", "USD/XAF": "الدولار/الفرنك" }[m.name] || m.name} ${fmtP(m.change_pct)} عند آخر إغلاق`; return; }
    if (m) it.ctx = lang === "fr" ? `${m.name === "Gold" ? "Or" : m.name === "Silver" ? "Argent" : m.name} ${fmtP(m.change_pct, true)} à la dernière clôture` : `${m.name} ${fmtP(m.change_pct)} at the last close`;
  });
}

/* ---------- v35: the Morning Brief written by AI — explained, not just headlines ---------- */
async function aiPodcast(edition) {
  if (!aiProvider()) return null;
  const now = new Date(), ago = h => (Date.now() - new Date(h.date)) / 36e5;
  const mk = ["brent", "gold", "usdxaf", "eurusd"].map(id => markets.find(m => m.id === id)).filter(m => m && typeof m.change_pct === "number").map(m => {
    const s = m.series || [], first = s.length ? s[0][1] : null;
    return { name: m.id === "usdxaf" ? "US dollar in CFA francs (USD/XAF)" : m.name, last: +m.value.toFixed(2), day_change_pct: +m.change_pct.toFixed(2), month_change_pct: first ? +((m.value / first - 1) * 100).toFixed(1) : null };
  });
  const st = headlines.filter(h => ago(h) < 48).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 30)
    .map(h => ({ section: h.cat, title: (h.t && h.t.en) || h.title, detail: String((h.d && h.d.en) || h.desc || "").slice(0, 300), hours_ago: Math.round(ago(h)) }));
  const ag = (cfg.agenda || []).filter(a => { const d = (new Date(a.date) - now) / 864e5; return d > -1 && d < 8; }).slice(0, 3).map(a => ({ date: a.date, what: a.en }));
  const prompt = `You write and voice "The Morning Brief", a spoken audio briefing for Rayan, a finance executive in ${cfg.city}, Republic of Congo (CEMAC, CFA franc pegged to the euro, oil-exporting economy). It is the ${edition} edition, ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.

Write a script of about 600 words in English (about 4 minutes spoken), then the same script in natural French and in Modern Standard Arabic. Spoken style: short clear sentences, warm and professional, like a radio economics correspondent. Plain text only: no markdown, no bullet symbols, no emojis, no URLs.

Structure, as segments:
1. "intro": greet Rayan (Good ${edition === "morning" ? "morning" : "evening"}), say the date, one sentence on the big theme of the day.
2. "markets": Brent oil, gold, and the dollar against the CFA franc. For each: the move, WHY it moved (use the headlines below; if they do not explain it, say what traders are weighing in general terms, without inventing specific events or figures), and WHAT IT MEANS for the world economy and for Central Africa (for example: oil revenue for Congo's budget, fuel and import costs, inflation, the euro-dollar rate for CFA importers). 120 to 170 words.
3. Five "point" segments: the five most important stories for Rayan, mixing world, Africa and Congo/CEMAC. For each: what happened, why it happened, and why it matters (consequences for markets, prices, rates, budgets or the region). 60 to 90 words each. Start each with a short spoken label such as "First, in Congo," or "Second, in global markets,".
4. "number": the number of the day, a striking figure from the stories, and what it tells us. 30 to 50 words.
5. "watch": what to watch next${ag.length ? " (use the agenda)" : ""}. 25 to 50 words.
6. "outro": one short sign-off.

Strict rules: NEVER mention news outlets, agencies, newspapers, websites, journalists or "according to" sources. Use only facts and numbers present in the data below; never invent numbers, quotes or events. Say numbers the way a presenter would ("one point two percent", not "1.2%") in each language. Do not mention any company that is not in the stories.

Return JSON only: {"en":[{"k":"intro","text":"..."},...],"fr":[...],"ar":[...]} with the same segments in the same order in all three languages.

MARKETS: ${JSON.stringify(mk)}
STORIES: ${JSON.stringify(st)}
AGENDA: ${JSON.stringify(ag)}`;
  const t = await llm(prompt, 12000); if (!t) return null;
  const J = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  const ok = ["intro", "markets", "point", "number", "watch", "outro"];
  const P = { id: Date.now().toString(36), edition, ai: true };
  for (const lang of ["en", "fr", "ar"]) {
    const S = (J[lang] || []).map(x => ({ k: ok.includes(x.k) ? x.k : "point", text: String(x.text || "").replace(/[*#_`]/g, "").replace(/\s+/g, " ").trim() })).filter(x => x.text.length > 10);
    if (S.length < 5) { if (lang === "ar" && P.en) { const tr = await translateBatch(P.en.map(x => x.text), "en", "ar"); P.ar = P.en.map((x, i) => ({ k: x.k, text: tr[i] || x.text })); P.mins_ar = P.mins_en; continue; } throw new Error("podcast " + lang + " too short"); }
    P[lang] = S;
    P["mins_" + lang] = Math.max(1, Math.round(S.reduce((a, x) => a + x.text.split(/\s+/).length, 0) / (lang === "ar" ? 120 : 150)));
  }
  return P;
}

/* ---------- The Morning Brief: a short spoken rundown, independent from the edition ---------- */
let podcast = keepBrief && old.podcast ? old.podcast : null;
if (!podcast && !MOCK) {
  try { podcast = await aiPodcast(edition); if (podcast) log.push(`podcast: AI, ${podcast.en.length} parts, ~${podcast.mins_en} min`); }
  catch (e) { log.push("podcast ai: " + e.message); podcast = null; }
}
if (!podcast) {
  const L3 = { en: "en", fr: "fr", ar: "ar" }, now = new Date();
  const day = { en: now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }), fr: now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }), ar: now.toLocaleDateString("ar", { weekday: "long", day: "numeric", month: "long", numberingSystem: "latn" }) };
  const ev = edition === "morning";
  const M = id => markets.find(m => m.id === id && typeof m.change_pct === "number");
  const mv = (m, lang) => { if (!m) return null; const p = Math.abs(m.change_pct).toFixed(1); const up = m.change_pct > 0;
    const nm = { en: { brent: "Brent crude", gold: "Gold", eurusd: "The euro", usdxaf: "The dollar" }, fr: { brent: "Le Brent", gold: "L'or", eurusd: "L'euro", usdxaf: "Le dollar" }, ar: { brent: "خام برنت", gold: "الذهب", eurusd: "اليورو", usdxaf: "الدولار" } }[lang][m.id];
    if (Math.abs(m.change_pct) < 0.2) return { en: `${nm} is flat.`, fr: `${nm} est stable.`, ar: `${nm} مستقر.` }[lang];
    return { en: `${nm} is ${up ? "up" : "down"} ${p} percent.`, fr: `${nm} ${up ? "gagne" : "perd"} ${p.replace(".", ",")} pour cent.`, ar: `${nm} ${up ? "يرتفع" : "ينخفض"} ${p} بالمئة.` }[lang]; };
  const why = () => "";
  // five points: the strongest stories from five different sections, fresh first
  const ageH = h => (Date.now() - new Date(h.date)) / 36e5, used = new Set(), pts = [];
  const pool = headlines.filter(h => h.cat !== "markets");
  for (const h of [...pool].filter(h => ageH(h) < 36).sort((a, b) => (b.score || 0) - (a.score || 0))) { if (pts.length >= 5) break; if (used.has(h.cat)) continue; used.add(h.cat); pts.push(h); }
  for (const h of [...pool].sort((a, b) => (b.score || 0) - (a.score || 0))) { if (pts.length >= 5) break; if (!pts.includes(h)) pts.push(h); }
  const first = (t) => { t = String(t || "").replace(/\s+/g, " ").trim(); const m = t.match(/^(.{40,220}?[.!?])(\s|$)/); return m ? m[1] : (t.length > 200 ? "" : t); };
  // add the first sentence of the summary only when it is clearly about the same story
  const kw = t => new Set(words(t || ""));
  const point = (h, lang) => { const ti = ((h.t && h.t[lang]) || h.title).replace(/\s*[:|–—]\s*/g, lang === "ar" ? "، " : ", ").replace(/[.…]+$/, "") + ".";
    const dEn = (h.d && h.d.en) || h.desc || "", a = kw((h.t && h.t.en) || h.title), b = kw(dEn), common = [...a].filter(x => b.has(x)).length;
    const d = common >= 3 ? first(String((h.d && h.d[lang]) || "").replace(/^By [A-Z][\w.'-]+(?: [A-Z][\w.'-]+){0,3}\s+/, "").replace(/^[A-Z][A-Za-z .,'-]{1,40}\s*\([^)]{2,30}\)\s*[-–—]\s*/, "").replace(/^[A-Z][a-z]+ \d{1,2} \([^)]+\)\s*[-–—]\s*/, "").replace(/^(?:[A-Z][a-z]{2,8}\.? )?\d{1,2}\s*\([^)]+\)\s*[-–—]\s*/, "")) : "";
    return d && !d.toLowerCase().startsWith(ti.slice(0, 25).toLowerCase()) ? ti + " " + d : ti; };
  // number of the day: the biggest money figure in the headlines
  const figRe = /(?:US\$|\$|€|USD\s?)?\d[\d.,]*\s?(?:%|bn|billion|milliards?|trillion|millions?)(?:\s?(?:FCFA|XAF|USD|dollars?|euros?))?/i;
  const fh = headlines.filter(h => !pts.includes(h) && ageH(h) < 48).sort((a, b) => (b.score || 0) - (a.score || 0)).find(h => figRe.test(h.title)) || pts.find(h => figRe.test(h.title));
  const ag = (cfg.agenda || []).filter(a => { const d = (new Date(a.date) - now) / 864e5; return d > -1 && d < 8; }).slice(0, 3);
  podcast = { id: Date.now().toString(36), edition };
  for (const lang of ["en", "fr", "ar"]) {
    const S = [];
    S.push({ k: "intro", text: { en: `Good ${ev ? "morning" : "evening"} Rayan. It's ${day.en}. Here is your Business Desk brief.`, fr: `${ev ? "Bonjour" : "Bonsoir"} Rayan. Nous sommes le ${day.fr}. Voici votre brief Business Desk.`, ar: `${ev ? "صباح الخير" : "مساء الخير"} يا ريان. اليوم ${day.ar}. إليك موجز Business Desk.` }[lang] });
    const mk = ["brent", "gold", "usdxaf"].map(id => M(id)).filter(Boolean);
    if (mk.length) S.push({ k: "markets", text: { en: "First, the markets. ", fr: "D'abord, les marchés. ", ar: "أولًا، الأسواق. " }[lang] + mk.map(m => mv(m, lang) + why(m, lang)).join(" ") });
    const ord = { en: ["First", "Second", "Third", "Fourth", "Finally"], fr: ["Premier point", "Deuxième point", "Troisième point", "Quatrième point", "Enfin"], ar: ["أولًا", "ثانيًا", "ثالثًا", "رابعًا", "وأخيرًا"] }[lang];
    const secName = (c) => ((cfg.news.find(n => n.cat === c) || {})["label_" + lang]) || { worldwide: { ar: "العالم" }, africa: { ar: "أفريقيا" }, congo: { ar: "الكونغو وCEMAC" }, markets: { ar: "الأسواق" }, bev: { ar: "المشروبات والتغليف" }, cfo: { ar: "المالية والخزينة" }, lebanon: { ar: "لبنان" } }[c]?.[lang] || c;
    S.push({ k: "lead", text: { en: "Now, five things to know.", fr: "Maintenant, cinq choses à savoir.", ar: "والآن، خمسة أمور يجب معرفتها." }[lang] });
    pts.forEach((h, i) => S.push({ k: "point", cat: h.cat, url: h.url, text: `${ord[i]}${lang === "ar" ? "،" : ","} ${secName(h.cat)}. ${point(h, lang)}` }));
    if (fh) { const f = fh.title.match(figRe)[0]; S.push({ k: "number", text: { en: `The number of the day: ${f}. `, fr: `Le chiffre du jour : ${f}. `, ar: `رقم اليوم: ${f}. ` }[lang] + ((fh.t && fh.t[lang]) || fh.title).replace(/[.…]+$/, "") + "." }); }
    if (ag.length) S.push({ k: "watch", text: { en: "What to watch: ", fr: "À surveiller : ", ar: "ما يجب متابعته: " }[lang] + ag.map(a => { const d = new Date(a.date).toLocaleDateString(lang === "ar" ? "ar" : lang === "fr" ? "fr-FR" : "en-GB", { weekday: "long", day: "numeric", month: "long", numberingSystem: "latn" }); return `${a[lang] || a.en}, ${d}`; }).join(lang === "ar" ? "؛ " : "; ") + "." });
    S.push({ k: "outro", text: { en: "That's your brief. The full edition is in the app. Have a good day.", fr: "C'est tout pour ce brief. L'édition complète est dans l'application. Bonne journée.", ar: "هذا هو موجزك. العدد الكامل في التطبيق. يومًا موفقًا." }[lang] });
    podcast[lang] = S;
    const nWords = S.reduce((a, x) => a + x.text.split(/\s+/).length, 0);
    podcast["mins_" + lang] = Math.max(1, Math.round(nWords / 150));
  }
  log.push(`podcast: ${pts.length} points, ${podcast.mins_en} min`);
}

const brief = {
  health: (() => { health.markets_total = markets.length; health.markets_ok = markets.filter(m => m.date && (Date.now() - new Date(m.date)) / 864e5 < 5).length;
    health.translate = !gBlocked ? "google" : mmLeft < 30 ? "fallback" : "off"; health.static_days = Math.max(...(cfg.static_rates || []).map(r => r.date ? (Date.now() - new Date(r.date)) / 864e5 : 0), 0) | 0; return health; })(),
  generated_at: new Date().toISOString(), follow: cfg.follow || [], alerts: cfg.ntfy_topic ? "https://ntfy.sh/" + cfg.ntfy_topic : null, summary_at: summaryAt, edition: keepBrief ? (old.edition || edition) : edition, summary_mode: summaryMode, peg: cfg.eur_xaf_peg, fx,
  markets, static_rates: cfg.static_rates, agenda: cfg.agenda,
  categories: cfg.news.map(n => ({ id: n.cat, en: n.label_en, fr: n.label_fr, ar: n.label_ar || { worldwide: "العالم", africa: "أفريقيا", congo: "الكونغو وCEMAC", markets: "الأسواق", bev: "المشروبات والتغليف", cfo: "المالية والخزينة", lebanon: "لبنان" }[n.cat] || n.label_en })),
  summary, takeaway, podcast, on_this_day: otd, read, news: headlines.map((h, i) => ({ id: "n" + i + "-" + h.date.slice(0, 10), ...h })), log,
  gn_cache: Object.fromEntries(headlines.filter(h => h.url && GN[h.url]).map(h => [h.url, GN[h.url]]))
};
await fs.mkdir(path.join(ROOT, "data"), { recursive: true });
await fs.writeFile(path.join(ROOT, "data", "brief.json"), JSON.stringify(brief, null, 1));
console.log(`brief.json written: ${markets.length} markets, ${headlines.length} headlines, summary=${summaryMode}`);
// Phone alert when a new edition is ready (ntfy app, free)
if (!keepBrief && !MOCK && cfg.ntfy_topic && (summary.en || []).length) {
  const top = summary.en[0], name = edition === "morning" ? "Morning edition" : "Evening edition";
  try {
    const r = await fetch("https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ topic: cfg.ntfy_topic, title: `${name} ready · ${summary.en.length} stories`, message: top.title, click: cfg.app_url || "https://ftounir-dev.github.io/business-desk/", tags: ["newspaper"] }) });
    console.log("alert sent: " + r.status);
  } catch (e) { console.log("alert failed: " + e.message); }
}
if (log.length) console.log("warnings:\n" + log.join("\n"));
