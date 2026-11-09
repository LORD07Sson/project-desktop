// Разбор WebVTT для плеера «Смотреть». Теги и сущности убираем: на экран текст идёт как обычный текст.

const TIME = "((?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3})";
const TIMING = new RegExp(`^\\s*${TIME}\\s*-->\\s*${TIME}`);
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&quot;": '"', "&#39;": "'" };

function seconds(stamp) {
  return stamp.replace(",", ".").split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
}

function plain(line) {
  return line.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|nbsp|quot|#39);/g, m => ENTITIES[m]).trim();
}

/** Реплики из .ass/.ssa: теги оформления убираем, векторные рисунки и повторы слоёв пропускаем. */
export function parseAss(ass) {
  let fields = null;
  const seen = new Set();
  const cues = [];
  for (const line of String(ass || "").replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\[/.test(line)) { fields = null; continue; }
    if (/^Format\s*:/i.test(line) && /\bText\b/i.test(line)) { fields = line.slice(line.indexOf(":") + 1).split(",").map(f => f.trim().toLowerCase()); continue; }
    if (!fields || !/^Dialogue\s*:/i.test(line)) continue;
    const parts = line.slice(line.indexOf(":") + 1).split(",");
    const raw = parts.slice(fields.indexOf("text")).join(",");
    if (/\\p[1-9]/.test(raw)) continue;
    const text = raw.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").split("\n").map(l => l.trim()).filter(Boolean).join("\n");
    const start = seconds(parts[fields.indexOf("start")].trim()), end = seconds(parts[fields.indexOf("end")].trim());
    const key = `${start}|${end}|${text}`;
    if (!text || !(end > start) || seen.has(key)) continue;
    seen.add(key);
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Реплики из файла субтитров по его имени. */
export function parseSubsFile(name, text) {
  return /\.(ass|ssa)$/i.test(name || "") ? parseAss(text) : parseVtt(text);
}

/** Текст файла: UTF-8, а старые субтитры — Windows-1251. */
export function decodeSubs(bytes) {
  const { TextDecoder: Decoder } = globalThis;
  try { return new Decoder("utf-8", { fatal: true }).decode(bytes); } catch (_) { return new Decoder("windows-1251").decode(bytes); }
}

/** Реплики из текста WebVTT или SRT: [{ start, end, text }], по времени начала. */
export function parseVtt(vtt) {
  const cues = [];
  for (const block of String(vtt || "").replace(/^﻿/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex(l => TIMING.test(l));
    if (at < 0 || at > 1) continue;
    const [, from, to] = lines[at].match(TIMING);
    const text = lines.slice(at + 1).map(plain).filter(Boolean).join("\n");
    const start = seconds(from), end = seconds(to);
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}
