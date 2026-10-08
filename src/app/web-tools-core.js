// Разбор данных для «Лент и текстов»: LRC (тексты песен), RSS/Atom и
// курс валют ЦБ. Чистые функции без DOM — проверяются node-тестом.

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

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = re.exec(block);
  return m ? decodeEntities(m[1]) : "";
}

/** RSS 2.0 и Atom → [{ title, link, date, extra: { size, seeders, ... } }]. */
export function parseFeed(xml) {
  const src = String(xml || "");
  const blocks = [...src.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(m => m[2]);
  return blocks.map(b => {
    let link = tag(b, "link");
    if (!link) {
      const m = /<link[^>]*href=["']([^"']+)["']/i.exec(b);
      link = m ? decodeEntities(m[1]) : "";
    }
    const extra = {};
    for (const key of ["size", "seeders", "leechers", "downloads", "category"]) {
      const v = tag(b, `nyaa:${key}`);
      if (v) extra[key] = v;
    }
    return {
      title: tag(b, "title"),
      link,
      date: tag(b, "pubDate") || tag(b, "updated") || tag(b, "published"),
      extra,
    };
  }).filter(e => e.title);
}

/** Только строгая проверка адреса ленты: https и непустой хост. */
export function isFeedUrl(value) {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch { return false; }
}

/** JSON ЦБ (cbr-xml-daily) → [{ code, name, value, change }] с нужными кодами. */
export function parseCbr(json, codes = ["USD", "EUR", "KZT", "CNY", "JPY"]) {
  const v = (json && json.Valute) || {};
  return codes.filter(c => v[c]).map(c => {
    const x = v[c];
    const per = x.Nominal || 1;
    return {
      code: c, name: x.Name, value: x.Value / per,
      change: (x.Value - x.Previous) / per,
    };
  });
}

/** Название релиза «[Группа] Название - 09 [1080p][HEVC]» → { group, episode, resolution, codec, source }. */
export function parseRelease(title) {
  const t = String(title || "");
  const group = (/^\s*\[([^\]]{1,40})\]/.exec(t) || [])[1] || "";
  const resolution = (/(?:^|[^\d])(2160|1440|1080|720|576|480)\s*p/i.exec(t) || [])[1];
  const codec = (/\b(HEVC|x265|H\.?265|AV1|x264|H\.?264|AVC)\b/i.exec(t) || [])[1] || "";
  const source = (/\b(BD(?:Rip)?|Blu-?ray|WEB(?:-?DL|Rip)?|HDTV|DVD)\b/i.exec(t) || [])[1] || "";
  // Номер серии: « - 09», «E09», «ep09», «#09» — но не год и не разрешение.
  const ep = /(?:\s-\s|\bE(?:p(?:isode)?)?\s?|#)(\d{1,3})(?:v\d)?\b(?!\s*p)/i.exec(t);
  return {
    group,
    episode: ep ? Number(ep[1]) : null,
    resolution: resolution ? `${resolution}p` : "",
    codec: codec.replace(/^x265$|^h\.?265$/i, "HEVC").replace(/^x264$|^h\.?264$/i, "AVC"),
    source,
  };
}

/** Все слова фильтра (через пробел) есть в заголовке; пустой фильтр = подходит всё. */
export function matchesWatch(title, filter) {
  const words = String(filter || "").toLowerCase().split(/\s+/).filter(Boolean);
  const t = String(title || "").toLowerCase();
  return words.every(w => t.includes(w));
}

/** Записи, которых нет в seen (по ссылке, а без неё — по заголовку), подходящие под фильтр. */
export function freshItems(items, seen, filter) {
  const key = i => i.link || i.title;
  return items.filter(i => !seen.has(key(i)) && matchesWatch(i.title, filter));
}
