// Nyaa: разбор RSS-ленты поиска, magnet-ссылки, сортировка и сводка.
// Чистые функции без DOM и Tauri — проверяются node-тестом.

export const CATEGORIES = [
  ["0_0", "Все категории"],
  ["1_0", "Аниме — все"],
  ["1_2", "Аниме — английские субтитры"],
  ["1_3", "Аниме — другие языки"],
  ["1_4", "Аниме — без перевода (raw)"],
  ["1_1", "Аниме — клипы (AMV)"],
  ["2_0", "Аудио — все"],
  ["2_1", "Аудио — без потерь"],
  ["2_2", "Аудио — с потерями"],
  ["4_0", "Фильмы и сериалы — все"],
  ["4_1", "Фильмы — английский"],
  ["4_3", "Фильмы — не английский"],
  ["4_4", "Фильмы — без перевода"],
];
export const FILTERS = [["0", "Без фильтра"], ["1", "Без ремейков"], ["2", "Только доверенные"]];

const TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

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

const UNITS = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
/** «73.6 MiB» → байты (0, если не разобрать). */
export function sizeToBytes(text) {
  const m = /^([\d.,]+)\s*([KMGT]?i?B)$/i.exec(String(text || "").trim());
  if (!m) return 0;
  return Math.round(Number(m[1].replace(",", ".")) * (UNITS[m[2].toLowerCase()] || 0));
}

const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/** RSS Nyaa → [{ id, title, hash, size, sizeBytes, date, seeders, leechers, downloads, category, comments, trusted, remake, pageUrl }]. */
export function parseNyaaRss(xml) {
  const blocks = [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  return blocks.map(b => {
    const guid = tag(b, "guid");
    const id = num((/\/view\/(\d+)/.exec(guid) || [])[1]);
    const size = tag(b, "nyaa:size");
    const ts = Date.parse(tag(b, "pubDate"));
    return {
      id,
      title: tag(b, "title"),
      hash: tag(b, "nyaa:infoHash").toLowerCase(),
      size,
      sizeBytes: sizeToBytes(size),
      date: Number.isFinite(ts) ? ts : 0,
      seeders: num(tag(b, "nyaa:seeders")),
      leechers: num(tag(b, "nyaa:leechers")),
      downloads: num(tag(b, "nyaa:downloads")),
      category: tag(b, "nyaa:category"),
      categoryId: tag(b, "nyaa:categoryId"),
      comments: num(tag(b, "nyaa:comments")),
      trusted: /^yes$/i.test(tag(b, "nyaa:trusted")),
      remake: /^yes$/i.test(tag(b, "nyaa:remake")),
      pageUrl: guid,
    };
  }).filter(i => i.id && i.title);
}

export function magnetLink(item) {
  if (!item.hash) return "";
  const tr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${item.hash}&dn=${encodeURIComponent(item.title)}${tr}`;
}

export const SORT_KEYS = { date: "date", size: "sizeBytes", seeders: "seeders", leechers: "leechers", downloads: "downloads" };

export function sortItems(items, key, dir = "desc") {
  const field = SORT_KEYS[key] || "date";
  const sign = dir === "asc" ? 1 : -1;
  return items.slice().sort((a, b) => sign * (a[field] - b[field]) || b.date - a.date);
}

/** Дата для таблицы: «2026-10-08 17:39» по местному времени. */
export function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** «5 мин назад», «3 ч назад», «вчера», «4 дн. назад», иначе дата. */
export function relTime(ts, now = Date.now()) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "только что";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d === 1) return "вчера";
  if (d < 14) return `${d} дн. назад`;
  return fmtDate(ts).slice(0, 10);
}

const TAG_WORDS = /^(FLAC|MP3|AAC|OPUS|WAV|ALAC|HEVC|AVC|AV1|x26[45]|H\.?26[45]|BD(?:Rip)?|Blu-?ray|WEB(?:-?DL|Rip)?|HDTV|DVD|10-?bit|8-?bit|Hi10P|\d{3,4}p|\d+\s?kHz(?:\/\d+\s?bit)?|\d+\s?bit|\d+\s?kbps|Dual[- ]Audio|Multi[- ]?Subs?|Batch|Remux|RAW)$/i;

/** Название → { group, tags } : «[JMAX] … [FLAC 48kHz]» → группа JMAX, метки FLAC и 48kHz. */
export function splitTitle(title) {
  const t = String(title || "");
  const group = (/^\s*\[([^\]]{1,40})\]/.exec(t) || [])[1] || "";
  const tags = [];
  for (const m of t.matchAll(/[[(]([^\])]{1,40})[\])]/g)) {
    for (const part of m[1].split(/[\s,]+/)) {
      if (TAG_WORDS.test(part) && !tags.includes(part)) tags.push(part);
    }
  }
  const res = /(?:^|[^\d])(2160|1440|1080|720|576|480)\s*p\b/i.exec(t);
  if (res && !tags.some(x => x.toLowerCase() === `${res[1]}p`)) tags.push(`${res[1]}p`);
  return { group, tags: tags.slice(0, 5) };
}

/** Вид категории для значка: anime / audio / video / other. */
export function categoryKind(categoryId) {
  const head = String(categoryId || "").split("_")[0];
  return { 1: "anime", 2: "audio", 4: "video" }[head] || "other";
}

/** Сводка по списку для шапки страницы. */
export function summarize(items) {
  const bytes = items.reduce((s, i) => s + i.sizeBytes, 0);
  const top = items.reduce((b, i) => (!b || i.seeders > b.seeders ? i : b), null);
  return { count: items.length, bytes, topSeeders: top ? top.seeders : 0, trusted: items.filter(i => i.trusted).length };
}

export function fmtBytes(b) {
  if (!b) return "0 Б";
  const u = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Безопасное имя файла .torrent из названия раздачи. */
export function torrentFileName(item) {
  const base = String(item.title || `nyaa-${item.id}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${base || `nyaa-${item.id}`}.torrent`;
}
