// Чистая логика «Переводчика» (без DOM и сети — её гоняют тесты):
// разбор субтитров на реплики, пакетная нарезка под лимит сервиса и
// обратная сборка файла с теми же тайм-кодами.

const TC = /(\d+):(\d{2}):(\d{2})[.,](\d{2,3})\s*-->/;
const ASS_DIALOGUE = /^(Dialogue:\s*(?:[^,]*,){9})(.*)$/;

const stripTags = t => t.replace(/\{[^}]*\}/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// -> { kind: "srt" | "vtt" | "ass" | "text", texts: string[], build(translated) }
// texts — реплики для перевода (по одной строке на реплику); build
// собирает исходный файл, подставив переводы на место текста.
export function prepareSubtitle(raw) {
  const src = String(raw || "").replace(/^﻿/, "");

  if (/^\s*\[Script Info\]/im.test(src) || /^Dialogue:/im.test(src)) {
    const lines = src.split(/\r?\n/);
    const idx = [];
    const texts = [];
    lines.forEach((l, i) => {
      const m = ASS_DIALOGUE.exec(l);
      if (m) {
        const t = stripTags(m[2].replace(/\\N|\\n/g, " "));
        if (t) { idx.push(i); texts.push(t); }
      }
    });
    return {
      kind: "ass", texts,
      build(tr) {
        const out = lines.slice();
        idx.forEach((li, k) => { const m = ASS_DIALOGUE.exec(lines[li]); out[li] = m[1] + (tr[k] ?? ""); });
        return out.join("\n");
      },
    };
  }

  if (TC.test(src)) {
    const kind = /^\s*WEBVTT/.test(src) ? "vtt" : "srt";
    const blocks = src.split(/(\r?\n\s*\r?\n)/); // сохраняем разделители
    const cues = [];
    const texts = [];
    blocks.forEach((b, i) => {
      if (i % 2) return;
      const rows = b.split(/\r?\n/);
      const at = rows.findIndex(r => TC.test(r));
      if (at < 0) return;
      const t = stripTags(rows.slice(at + 1).join(" "));
      if (t) { cues.push({ i, head: rows.slice(0, at + 1), tail: /\s*$/.exec(b)[0] }); texts.push(t); }
    });
    return {
      kind, texts,
      build(tr) {
        const out = blocks.slice();
        cues.forEach((c, k) => { out[c.i] = [...c.head, tr[k] ?? ""].join("\n") + c.tail; });
        return out.join("");
      },
    };
  }

  return { kind: "text", texts: [src], build: tr => tr[0] ?? "" };
}

// Нарезка реплик на пакеты не длиннее maxChars (знаков вместе с переводами
// строк). -> [[индексы реплик]]
export function makeBatches(texts, maxChars = 3800, maxItems = 60) {
  const batches = [];
  let cur = [], len = 0;
  texts.forEach((t, i) => {
    const add = t.length + 1;
    if (cur.length && (len + add > maxChars || cur.length >= maxItems)) { batches.push(cur); cur = []; len = 0; }
    cur.push(i); len += add;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

// Разбор ответа пакета обратно на реплики: сервис переводит каждую
// строку отдельно, но может склеить/разделить строки. null — число строк
// не сошлось, и пакет надо перевести реплика за репликой.
export function splitBatchResult(translated, expected) {
  const lines = String(translated || "").split(/\r?\n/);
  while (lines.length > expected && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length === expected ? lines.map(l => l.trim()) : null;
}
