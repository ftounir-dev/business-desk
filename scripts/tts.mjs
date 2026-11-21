// Business Desk — turns the Morning Brief script into real audio (MP3) in English, French and Arabic.
// Uses Microsoft Edge's free neural voices. If anything fails, the app falls back to the phone's own voice.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(ROOT, "data", "brief.json");
const B = JSON.parse(await fs.readFile(file, "utf8"));
const P = B.podcast;
if (!P || !P.id) { console.log("tts: no podcast"); process.exit(0); }
const VOICES = { en: "en-GB-RyanNeural", fr: "fr-FR-HenriNeural", ar: "ar-LB-RamiNeural" };
P.audio = P.audio || {};
for (const lang of ["en", "fr", "ar"]) {
  const segs = (P[lang] || []).map(s => s.text).filter(Boolean);
  const out = path.join(ROOT, "data", `brief-${lang}.mp3`);
  if (!segs.length) continue;
  if (P.audio[lang] && P.audio[lang].includes(P.id)) { console.log(`tts ${lang}: already done`); continue; }
  try {
    const bufs = [];
    for (const text of segs) {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(VOICES[lang], OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text.replace(/[<>&]/g, " "), { rate: lang === "ar" ? "-5%" : "+0%" });
      const chunks = [];
      await new Promise((res, rej) => { audioStream.on("data", c => chunks.push(c)); audioStream.on("end", res); audioStream.on("close", res); audioStream.on("error", rej); setTimeout(() => rej(new Error("timeout")), 45000); });
      tts.close();
      bufs.push(Buffer.concat(chunks));
    }
    const all = Buffer.concat(bufs);
    if (all.length < 5000) throw new Error("audio too short");
    await fs.writeFile(out, all);
    P.audio[lang] = `data/brief-${lang}.mp3?v=${P.id}`;
    P.audio_secs = P.audio_secs || {}; P.audio_secs[lang] = Math.round(all.length / 6000);   // 48 kbit/s
    console.log(`tts ${lang}: ${Math.round(all.length / 1024)} KB`);
  } catch (e) { console.log(`tts ${lang} failed: ${e.message}`); delete P.audio[lang]; }
}
await fs.writeFile(file, JSON.stringify(B, null, 1));
