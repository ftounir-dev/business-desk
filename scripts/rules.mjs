// Business Desk — content rules shared by the update script and the regression checks.
// Each rule decides whether a story or event belongs where the app shows it.

/* ---------- Markets: a headline is attached to a price only when it is directly about that asset ---------- */
export const ASSET = {
  usdxaf: { yes: /\b(dollar|greenback|fed|federal reserve|ecb|bce|euro|forex|currenc(y|ies)|devises?|taux de change|fcfa|cfa franc)\b/i },
  eurusd: { yes: /\b(dollar|greenback|euro|fed|federal reserve|ecb|bce|forex|currenc(y|ies)|devises?)\b/i },
  brent: { yes: /\b(oil|crude|brent|wti|opec\+?|opep|barrels?|barils?|pétrole|brut)\b/i, no: /\b(palm|olive|cooking|vegetable|edible|essential|motor|oil paint)\s+oil\b|\boil (painting|spill cleanup)\b/i },
  wti: { yes: /\b(oil|crude|brent|wti|opec\+?|opep|barrels?|barils?|pétrole|brut|shale)\b/i, no: /\b(palm|olive|cooking|vegetable|edible|essential|motor)\s+oil\b/i },
  gold: { yes: /\b(gold|bullion|precious metals?|cours de l'or|l'or\b|métaux précieux)\b/i, no: /\b(gold(en)?\s+(medal|cup|coast|globe|standard of care)|goldman|golden)\b/i },
  silver: { yes: /\b(silver|precious metals?|métaux précieux)\b/i, no: /\b(silver\s+(medal|screen|lining|jubilee)|silverware)\b/i },
  sugar: { yes: /\b(sugar|sucre)\b/i, no: /\b(per kg|\/kg|rupees?|\brs\.?\s?\d|kabul|retail|consumers?|blood sugar|diabetes)\b/i }
};
// Local retail price round-ups ("Petrol, sugar, rice prices fall in Kabul") never explain a world market move.
export const RETAIL_ROUNDUP = /\b(prices? (fall|rise|drop|increase|soar)s? in [A-Z][a-z]+|per kg|\/kg|weekly inflation|kirana|bazaar|retail prices?|market rates? today|daily market price)\b/i;
export function assetHeadlineOk(id, title, cat) {
  const a = ASSET[id]; if (!a || !title) return false;
  if (cat && !["markets", "worldwide", "cfo"].includes(cat)) return false;   // only market-facing sections
  if (!a.yes.test(title)) return false;                                     // the asset must be in the headline itself
  if (a.no && a.no.test(title)) return false;
  if (RETAIL_ROUNDUP.test(title)) return false;
  return true;
}

/* ---------- News sections: what each section must be about, and what never belongs ---------- */
export const SECTION = {
  bev: {
    must: /\b(beverages?|drinks?|soft[- ]drinks?|carbonated|bottl\w*|brewer\w*|brewery|breweries|beer|bière|brasserie\w*|juices?|jus|mineral water|eau minérale|bottled water|energy drinks?|malt|soda|boissons?|PET|rPET|preforms?|packag\w*|emballage\w*|plastics?|plastiques?|resin|résine|polymers?|aluminium cans?|aluminum cans?|canettes?|cans\b|closures?|bouchons?|labels?|coca-cola|pepsi\w*|heineken|diageo|castel|ab inbev|carlsberg|nestl[ée]|danone|red bull|monster beverage|bralima|brasco|sabc|guinness|concentrates?|flavou?rs?|sweeteners?|sugar (futures|exports?|production|output|market|mills?|industry)|raw sugar|white sugar|sucre (brut|blanc)|ice futures|deposit return|extended producer responsibility|EPR\b|single-use plastic)\b/i,
    exclude: /\b(tomato\w*|onions?|vegetables?|kabul|weekly inflation|per kg|\/kg|rupees?|\brs\.?\s?\d|retail prices?|kirana|daily market price|farmers?[- ]mill|sugarcane price|cane price|crushing season row|price hike: no relief)\b/i
  },
  cfo: {
    must: /\b(treasury|trésor(erie)?|cash|liquidit\w*|working capital|fonds de roulement|banks?|banques?|bancaires?|banking|financ\w*|loans?|prêts?|crédits?|credit|bonds?|obligat\w*|eurobonds?|sukuk|debt|dette|tax\w*|fiscal\w*|impôts?|tva|vat|ifrs|ohada|syscohada|audit\w*|accounting|comptab\w*|payments?|paiements?|mobile money|fintech|interest rates?|taux|rates?|beac|bceao|cobac|cemac|uemoa|capital|cfo|daf|factoring|affacturage|leasing|crédit-bail|budget|exchange rate|currency|devises?|fx\b|hedg\w*|couverture|insurance|assurance|controls?|contrôle interne|compliance|conformité|anti-money|blanchiment|trade finance|letters? of credit|lettre de crédit|ipo|bourse|bvmac|brvm|listing|dividend\w*|reserves?|réserves?)\b/i,
    exclude: /\b(découverts? sur un voyageur|discovered on a traveller|found on a traveler|voyageur|traveller|traveler|smuggl\w*|contrebande|saisi[es]?|seized|seizure|arrested|arrêtés?|interpell\w*|police|gendarmerie|trafiquants?|braquage|robbery|stolen|volés?|kidnap\w*|enlèvement|murder|meurtre|faux billets|counterfeit notes|drug|drogue)\b/i
  }
};
export function sectionOk(cat, text) {
  const s = SECTION[cat]; if (!s) return true;
  return s.must.test(text) && !s.exclude.test(text);
}

/* ---------- Events: Republic of Congo history must not include the DRC ---------- */
const DRC_PHRASES = /democratic republic of (the )?congo|r[ée]publique d[ée]mocratique du congo|congo[- ]kinshasa|belgian congo|congo belge|congo free state|[ée]tat ind[ée]pendant du congo/gi;
export const CG_STRONG = /brazzaville|pointe-noire|r[ée]publique du congo|republic of (the )?congo|congo-brazzaville|sassou|lissouba|ngouabi|massamba|youlou|kol[ée]las|moyen-congo|middle congo/i;
export const CG_NOT = /d[ée]mocratique|democratic|kinshasa|za[iï]re|l[ée]opoldville|katanga|belgian congo|congo belge|\brdc\b|\bdrc\b|kabila|lumumba|mobutu|tshisekedi|kasa[iï]|tshombe|kasavubu/i;
export function isRepCongo(text) {
  if (!/congo|brazzaville|pointe-noire|sassou|lissouba|ngouabi|massamba|youlou|kol[ée]las/i.test(text)) return false;
  const rest = text.replace(DRC_PHRASES, " ");                 // "Democratic Republic of the Congo" must not count as "Republic of the Congo"
  if (CG_NOT.test(text) && !CG_STRONG.test(rest)) return false;
  if (/mobutu|lumumba|kabila|tshisekedi|zaïre|zaire|kinshasa|l[ée]opoldville/i.test(text) && !/brazzaville|sassou|lissouba|ngouabi|massamba|youlou/i.test(text)) return false;
  return true;
}

/* ---------- Read: substantive reading first, routine politics and appointments last ---------- */
export const READ_UP = /\b(cfo|finance|financial|cash|capital|cost|pricing|inflation|currency|treasury|risk|supply chain|margins?|budget|investment|working capital|forecast\w*|planning|productivity|operations|manufactur\w*|procurement|sourcing|inventory|logistics|strategy|strategic|pricing power|M&A|acquisition|capital allocation|controls?|audit|tax|IFRS|payments?|banking|credit|debt|interest rates?|AI\b|automation|leadership|management|decision|lessons?|how to|why|framework|playbook|guide|trésorerie|financement|stratégie|gestion|industrie|chaîne d'approvisionnement|paiements?)\b/gi;
export const READ_DOWN = /\b(appoints?|appointed|names? (new )?(ceo|cfo|chair)|hires|nomm[ée]e?s?|mayor|maire|election\w*|élection\w*|coalition|campaign|congress|parliament|senate|democracy|démocratie|party|parti|minister resigns|sues|sued|lawsuit|faces hot seat|interim ceo|stock rout|shareholders sue|obituary|dies at)\b/gi;
export function readScore(a, ageDays) {
  const up = (a.title.match(READ_UP) || []).length, down = (a.title.match(READ_DOWN) || []).length;
  const lesson = /\b(how|why|lessons?|guide|framework|playbook|what .* (can|should) learn)\b/i.test(a.title);
  return up * 1.5 - down * (lesson ? 1 : 3) + (a.desc ? 1 : 0) + (a.paywall ? 0 : 0.3) + Math.max(0, 3 - ageDays / 2);
}

/* ---------- Edition: a summary must belong to its own article ---------- */
const STOP = new Set("the a an of to in on for and or with at by from as is are be its it this that de la le les des du et en au aux un une pour par sur dans à après avant plus new says said will has have was were".split(" "));
export const kw = s => new Set(String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(" ").filter(w => w.length > 2 && !STOP.has(w)));
export function sameStory(a, b) { const A = kw(a), B = kw(b); let c = 0; for (const w of A) if (B.has(w)) c++; return c >= 2 || (c >= 1 && Math.min(A.size, B.size) <= 3); }
// "Investment funds" and "banks" are different actors: an implication may not swap one for the other.
export function actorSwap(source, impact) {
  const s = String(source || "").toLowerCase(), i = String(impact || "").toLowerCase();
  const funds = /\b(funds?|fonds|ucits|opcvm|asset managers?|investment fund)\b/, banks = /\b(banks?|banques?|bancaires?|banking)\b/;
  return funds.test(s) && !banks.test(s) && banks.test(i);
}
