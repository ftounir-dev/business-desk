// Business Desk — regression checks.
//   node scripts/checks.mjs          → rule tests (the concrete errors reported on 21 Nov 2026)
//   node scripts/checks.mjs --brief  → also checks data/brief.json as published
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetHeadlineOk, sectionOk, isRepCongo, readScore, sameStory, actorSwap } from "./rules.mjs";

let fail = 0, pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("FAIL  " + msg); } };

/* 1. Markets: headlines attached to prices */
ok(!assetHeadlineOk("gold", "Petrol, sugar, rice prices fall in Kabul", "bev"), "gold must not show the Kabul retail-price story");
ok(!assetHeadlineOk("silver", "Petrol, sugar, rice prices fall in Kabul", "markets"), "silver must not show the Kabul retail-price story");
ok(!assetHeadlineOk("gold", "Gold prices fall in Karachi as demand weakens", "markets"), "local retail gold price is not a world market driver");
ok(assetHeadlineOk("gold", "Gold slips as dollar firms ahead of Fed decision", "markets"), "a real gold headline is kept");
ok(!assetHeadlineOk("brent", "Palm oil exports from Malaysia rise", "markets"), "palm oil is not crude oil");
ok(assetHeadlineOk("brent", "Oil shipped through Hormuz falls as Iranian strikes increase", "worldwide"), "a crude headline is kept");
ok(!assetHeadlineOk("silver", "Team wins silver medal at African Games", "worldwide"), "silver medal is not silver");

/* 2. News sections */
ok(!sectionOk("bev", "Pakistan Weekly Inflation Falls 0.65% as Tomato Prices Drop 30%"), "Beverages: Pakistani inflation / tomato prices excluded");
ok(!sectionOk("bev", "Sugar prices soar across India, reaching near seventy rupees in major cities"), "Beverages: Indian retail sugar prices excluded");
ok(!sectionOk("bev", "Petrol, sugar, rice prices fall in Kabul"), "Beverages: Kabul retail prices excluded");
ok(!sectionOk("bev", "Sugarcane price: Savadi seeks lasting fix for farmer-mill price dispute row"), "Beverages: local cane-price dispute excluded");
ok(sectionOk("bev", "Coca-Cola bottler opens new PET line in Nigeria"), "Beverages: bottling/PET kept");
ok(sectionOk("bev", "EU deposit return rules push brands toward rPET bottles"), "Beverages: rPET regulation kept");
ok(sectionOk("bev", "Raw sugar futures hit three-month high on Brazil output worries"), "Beverages: world sugar market kept");
ok(!sectionOk("cfo", "60 100 dollars découverts sur un voyageur à Godomey"), "CFO: cash found on a traveller excluded");
ok(!sectionOk("cfo", "Police seize $2 million in counterfeit notes"), "CFO: crime excluded");
ok(sectionOk("cfo", "UEMOA : Le risque souverain pèse sur 37,6% des actifs bancaires"), "CFO: banking risk kept");
ok(sectionOk("cfo", "Cameroun : les SVT boudent les émissions obligataires du Trésor"), "CFO: Treasury bond market kept");

/* 3. Events: Republic of Congo vs DRC */
ok(!isRepCongo("Joseph-Désiré Mobutu seizes power in the Democratic Republic of the Congo and becomes President"), "Mobutu (DRC) is not Republic of Congo");
ok(!isRepCongo("Patrice Lumumba becomes Prime Minister of the Congo"), "Lumumba (DRC) is not Republic of Congo");
ok(isRepCongo("Denis Sassou-Nguesso, président de la République du Congo."), "Sassou-Nguesso is Republic of Congo");
ok(isRepCongo("The Republic of the Congo gains independence from France, with Fulbert Youlou as president"), "Brazzaville independence kept");

/* 5. Edition: summary belongs to its article; no actor swap */
ok(sameStory("CEMAC funds accumulate 925 billion FCFA in Treasury securities", "Cemac : les fonds d'investissement accumulent 925 milliards FCFA de titres publics; 925 billion"), "summary/article match detected");
ok(!sameStory("Paris air freight volumes rise", "Guinea will appreciate fuel price increase in 2027"), "unrelated summary rejected");
ok(actorSwap("CEMAC investment funds accumulate 925 billion FCFA in Treasury securities", "Local banks face higher sovereign exposure"), "funds → banks swap detected");
ok(!actorSwap("UEMOA sovereign risk weighs on 37.6% of bank assets", "Banks face higher sovereign exposure"), "banks → banks is fine");

/* 6. Read */
ok(readScore({ title: "South Africa's ANC nears coalition deal in Johannesburg" }, 1) < readScore({ title: "Delivering the agentic supply chain" }, 1), "Read: politics ranks below supply chain");
ok(readScore({ title: "Zipline appoints veteran of retreating Uber to spearhead massive African expansion" }, 1) < readScore({ title: "Consumers fret about inflation as execs fixate on interest rates" }, 1), "Read: appointment ranks below finance");

/* Published data */
if (process.argv.includes("--brief")) {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const B = JSON.parse(await fs.readFile(path.join(ROOT, "data", "brief.json"), "utf8"));
  for (const m of B.markets || []) if (m.why && m.why.source) ok(assetHeadlineOk(m.id, m.why.en, null), `markets: ${m.id} headline "${m.why.en}"`);
  for (const n of B.news || []) if (n.cat === "bev" || n.cat === "cfo") ok(sectionOk(n.cat, n.title + " " + ((n.t && n.t.en) || "")), `news ${n.cat}: "${n.title}"`);
  for (const lang of ["en", "fr"]) for (const e of ((B.on_this_day || {})[lang] || {}).congo || []) ok(isRepCongo(e.text), `events congo (${lang}): "${e.text.slice(0, 80)}"`);
  for (const a of B.agenda || []) { ok(!!a.url && !!a.source, `agenda "${a.en}" has a source`); ok(a.status === "confirmed" || a.status === "tentative", `agenda "${a.en}" has a status`); ok(!!(a.institution && a.country), `agenda "${a.en}" has institution and country`); ok(!!(a.date || a.month), `agenda "${a.en}" has a date or month`); }
  for (const r of B.static_rates || []) if (r.group === "pack") { ok(!/usa|united states|americas|brazil|australia/i.test(r.name + " " + (r.region || "")), `packaging excludes Americas/Australia: ${r.name}`); ok(!!(r.period && r.basis && r.grade && r.source), `packaging ${r.id} has period, basis, grade, source`); }
  const S = (B.summary || {}).en || [];
  for (const x of S) { ok(String(x.detail || "").trim().toLowerCase() !== String(x.title || "").trim().toLowerCase(), `edition: summary repeats headline "${x.title}"`); ok(!actorSwap(x.title + " " + x.detail, x.impact), `edition: actor swap in "${x.title}"`); }
}
console.log(`checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
