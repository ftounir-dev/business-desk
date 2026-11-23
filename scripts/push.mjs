// Business Desk — phone notifications (Web Push, works on iPhone when the app is on the Home Screen).
//   node scripts/push.mjs           → collect new subscriptions, then notify if a new edition was published
//   node scripts/push.mjs --failed  → tell the phone the morning build failed and will retry
// Subscriptions arrive through a private ntfy topic (the app posts them there) and are stored
// encrypted in data/push.enc, so the public repository never shows them.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const PRIV = process.env.VAPID_PRIVATE_KEY, PUB = cfg.push && cfg.push.vapid_public, TOPIC = cfg.push && cfg.push.sub_topic;
if (!PRIV || !PUB || !TOPIC) { console.log("push: not set up (VAPID_PRIVATE_KEY secret or config.push missing)"); process.exit(0); }
webpush.setVapidDetails(cfg.app_url || "https://ftounir-dev.github.io/business-desk/", PUB, PRIV);

const FILE = path.join(ROOT, "data", "push.enc"), KEY = crypto.createHash("sha256").update("bd-push:" + PRIV).digest();
const load = async () => { try { const b = Buffer.from(await fs.readFile(FILE, "utf8"), "base64"), d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString()); } catch { return { subs: [], sent: null, seen: [] }; } };
const save = async s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv), e = Buffer.concat([c.update(JSON.stringify(s)), c.final()]);
  await fs.writeFile(FILE, Buffer.concat([iv, c.getAuthTag(), e]).toString("base64")); };

const S = await load(); S.seen = S.seen || [];
// 1. New subscriptions posted by the app (ntfy keeps messages for 12 hours; this runs every hour)
try {
  const r = await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=24h`, { signal: AbortSignal.timeout(15000) });
  for (const line of (await r.text()).split("\n")) {
    if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.event !== "message" || S.seen.includes(m.id)) continue; S.seen.push(m.id);
    let sub; try { sub = JSON.parse(m.message); } catch { continue; }
    if (!sub || !/^https:\/\/[^/]*(push\.apple\.com|googleapis\.com|mozilla\.com|windows\.com)\//.test(sub.endpoint || "") || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) continue;
    S.subs = [sub, ...S.subs.filter(x => x.endpoint !== sub.endpoint)].slice(0, 4);
    console.log("push: new subscription");
  }
  S.seen = S.seen.slice(-200);
} catch (e) { console.log("push: could not read subscriptions: " + e.message); }

// 2. What to send
const B = JSON.parse(await fs.readFile(path.join(ROOT, "data", "brief.json"), "utf8"));
let note = null;
if (process.argv.includes("--failed")) {
  const h = new Date().getUTCHours();
  if (h >= 4 && h < 7) note = { title: "Morning Brief delayed", body: "The update failed. It will retry automatically within the hour.", url: cfg.app_url, tag: "bd-fail" };
} else if (B.summary_at && B.summary_at !== S.sent && (B.summary && B.summary.en || []).length) {
  const ed = B.edition === "morning" ? "Morning Brief" : "Evening edition", top = B.summary.en[0];
  note = { title: `${ed} ready · ${B.summary.en.length} stories`, body: (B.takeaway && B.takeaway.en) || top.title, url: cfg.app_url, tag: "bd-edition" };
  if (S.sent) S.sent = B.summary_at; else { S.sent = B.summary_at; note = null; }   // first run after setup: remember, don't spam
}
if (note && S.subs.length) {
  const keep = [];
  for (const sub of S.subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(note), { TTL: 6 * 3600, urgency: "normal" }); keep.push(sub); console.log("push: sent"); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) console.log("push: removed an expired subscription"); else { keep.push(sub); console.log("push: send failed " + (e.statusCode || e.message)); } }
  }
  S.subs = keep;
}
await save(S);
