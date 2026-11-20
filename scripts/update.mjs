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
/* ---------- Importance score: keeps the big stories, drops the filler ---------- */
const SRC_TOP = /\b(reuters|bloomberg|financial times|ft\.com|the economist|wall street journal|wsj|associated press|ap news|afp|bbc|cnbc|nikkei|le monde|les echos|jeune afrique|agence ecofin|ecofin|rfi|the africa report|african business|business insider africa|semafor|la tribune|france 24|tv5monde|imf|banque mondiale|world bank|beac|bceao|sika finance|financial afrik|investir au cameroun|ecomatin|la nouvelle tribune|forbes afrique|capital finance)\b/i;
const SRC_LOW = /\b(blog|wordpress|medium|tv\b|web tv|radio|news24\.cd|benin web)\b/i;
const KEY_UP = /\b(beac|cemac|cémac|réserves?|reserves|souverain\w*|sovereign|bancaires?|bourse|brvm|stock|fonds|funds?|rachat|takeover|bceao|uemoa|imf|fmi|world bank|banque mondiale|afdb|bad|bdeac|eurobonds?|bonds?|obligat\w*|debt|dette|budget|loi de finances|inflation|interest rates?|taux|central bank|banque centrale|fed|ecb|bce|gdp|pib|growth|croissance|recession|récession|oil|pétrole|brent|opec|opep|gas|gaz|dollar|euro|fcfa|cfa|devise|currency|exchange rate|tariffs?|droits de douane|sanctions|default|défaut|downgrade|rating|notation|moody'?s|fitch|s&p|banks?|banques?|bank\w*|treasury|trésor|liquidity|liquidité|investment|investissement|ipo|merger|fusion|acquisition|election|élection|coup|government|gouvernement|minist\w*|president|président|strike|grève|shortage|pénurie|prices?|prix)\b/i;
const KEY_DOWN = /\b(football|soccer|basket\w*|can 20\d\d|ligue 1|match|sport\w*|concert|music|musique|festival|film|cinéma|miss|beauty|beauté|celebrity|célébrit\w*|horoscope|recipe|recette|fashion|mode|wedding|mariage|anniversary|anniversaire|célèbrent|celebrates?|award|prix d'excellence|gala|coconut|noix de coco|church|église|pilgrim\w*|obituary|nécrologie|lottery|loto)\b/i;
function importance(h) {
  let s = 1;
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
const SIXTY_PICK = { worldwide: 6, africa: 5, congo: 5, cfo: 4 }; // Today's video feed: 20 stories, about 2.5 minutes
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
  const prompt = `You edit "Overnight in 60 seconds", the top of a morning news brief read by Rayan, a finance executive in ${cfg.city}, Republic of Congo.

From the headlines below, pick the 20 most important news stories of the last 24 hours for a video news feed: 6 from "worldwide" (mostly economy, finance and banking), 5 from "africa" (West and Central Africa), 5 from "congo" (Republic of Congo and CEMAC) and 4 from "cfo" (treasury, FX, rates, BEAC). Prefer major political, economic and security news over minor or promotional items; skip duplicates. Order them as a mixed feed: the most important story first, and never two stories from the same category in a row.
Score every candidate's importance from 1 (filler) to 5 (market-moving); never pick a story scoring below 3 (sport, culture, ceremonies, anniversaries, PR, minor local items), even if a section then has fewer stories.
For each give: cat (worldwide|africa|congo|cfo), score (3-5), level ("high" if score 5, else "med"), title (clear, max 14 words, rewritten from the headline), detail (one sentence saying what happened, using only what the headline says; never invent facts or numbers), impact (one short sentence on why it matters for a finance executive in Congo, or "" if it doesn't), source_index (the headline's i).
Also write "takeaway": one line (max 22 words) that sums up the day for Rayan, mixing the biggest story with the key market move (oil, dollar, CFA), in English and French.
Return JSON only: {"takeaway":{"en":"...","fr":"..."},"en":[up to 20 items],"fr":[the same items in natural French]}.

MARKETS: ${JSON.stringify(markets.filter(m => ["usdxaf","brent","gold","eurusd"].includes(m.id)).map(m => ({ name: m.name, value: +m.value.toFixed(2), change_pct: +(m.change_pct || 0).toFixed(2) })))}

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
    json[lang] = json[lang].slice(0, 20).map(x => {
      const h = Number.isInteger(x.source_index) ? headlines[x.source_index] : null;
      const cat = (h && h.cat) || x.cat;
      return { level: x.level === "high" || x.score >= 5 ? "high" : "med", score: Number(x.score) || null, cat, source: h ? h.source : "", date: h ? h.date : null, img: h ? h.img || null : null, owner: (labels[cat] || {})[lang] || "", title: String(x.title || ""),
               detail: String(x.detail || ""), impact: String(x.impact || ""), url: h ? h.url : null };
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
  const all = [], seen = new Set();
  const generic = /^(business|finance|economics|the world (ahead|this week)|briefing|leaders|letters|podcast|video|newsletter)\b/i;
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
  if (!pick || !process.env.ANTHROPIC_API_KEY) return null;
  const prompt = `A finance executive in Brazzaville, Republic of Congo, will read this article today: "${pick.title}" (${pick.source}). Using only the title, write JSON {"en":{"why":"..."},"fr":{"title":"...","why":"..."}} where "why" is one or two sentences on what a CFO can take from it, without inventing facts, and fr.title is a French translation of the title.`;
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
for (const n of cfg.news) {
  let got = await news(n);
  // Never leave a section empty: if a source failed, keep the last good stories for that section
  if (got.length < 3) {
    const old = (prevBrief.news || []).filter(h => h.cat === n.cat && !got.some(g => g.title === h.title));
    if (old.length) { got = [...got, ...old].slice(0, cfg.news_per_category || 8); log.push(`reused ${old.length} earlier ${n.cat} stories`); }
  }
  headlines.push(...got);
  if (!MOCK) await new Promise(res => setTimeout(res, 800));   // space out Google News requests
}
const seen = new Set();
headlines = headlines.filter(h => { const k = h.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
if (!MOCK) await addPhotos(cfg.news.flatMap(n => headlines.filter(h => h.cat === n.cat).slice(0, 6)));

const otd = await onThisDay();
// The briefing (Play video + article of the day) is rebuilt every 8 hours; news and markets every run.
let old = {};
try { old = JSON.parse(await fs.readFile(path.join(ROOT, "data", "brief.json"), "utf8")); } catch {}
const BRIEF_EVERY_H = 8, forced = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const briefAge = old.summary_at ? (Date.now() - new Date(old.summary_at)) / 36e5 : 99;
const keepBrief = !forced && briefAge < BRIEF_EVERY_H - 0.5 && (old.summary?.en || []).length >= 10;
if (keepBrief) log.push(`briefing kept (${briefAge.toFixed(1)} h old)`);
const read = keepBrief && old.read ? old.read : await reads();
if (read && !keepBrief) { try { const w = await aiRead(read.pick); if (w) read.pick.ai = w; } catch (e) { log.push("ai read: " + e.message); } }
if (read && !keepBrief && !MOCK) await addPhotos([read.pick, ...read.more]);
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
}

const brief = {
  generated_at: new Date().toISOString(), summary_at: summaryAt, summary_mode: summaryMode, peg: cfg.eur_xaf_peg, fx,
  markets, static_rates: cfg.static_rates, agenda: cfg.agenda,
  categories: cfg.news.map(n => ({ id: n.cat, en: n.label_en, fr: n.label_fr })),
  summary, takeaway, on_this_day: otd, read, news: headlines.map((h, i) => ({ id: "n" + i + "-" + h.date.slice(0, 10), ...h })), log
};
await fs.mkdir(path.join(ROOT, "data"), { recursive: true });
await fs.writeFile(path.join(ROOT, "data", "brief.json"), JSON.stringify(brief, null, 1));
console.log(`brief.json written: ${markets.length} markets, ${headlines.length} headlines, summary=${summaryMode}`);
if (log.length) console.log("warnings:\n" + log.join("\n"));
