// Разбор текстов песен (LRC). Чистые функции без DOM — проверяются node-тестом.

/** «[01:23.45] строка» → [{ at: секунды, text }]; строки без времени — at: null. */
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d{1,2}(?:[.,]\d+)?)\]/g)];
    const line = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!stamps.length) {
      if (line) out.push({ at: null, text: line });
      continue;
    }
    for (const m of stamps) {
      out.push({ at: Number(m[1]) * 60 + Number(m[2].replace(",", ".")), text: line });
    }
  }
  return out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** Индекс активной строки для момента t (последняя с at <= t), или -1. */
export function activeLrcIndex(lines, t) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].at != null && lines[i].at <= t) idx = i; else if (lines[i].at != null) break;
  }
  return idx;
}
