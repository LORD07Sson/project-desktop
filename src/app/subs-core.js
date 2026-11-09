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

/** Реплики из текста WebVTT: [{ start, end, text }], по времени начала. */
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
