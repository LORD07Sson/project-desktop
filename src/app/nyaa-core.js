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

// ---------- фильтры списка ----------

export const DEFAULT_FILTERS = {
  hideDead: false,       // 0 раздающих
  minSeeders: 0,
  block: [],             // скрыть, если в названии есть любое из слов
  require: [],           // показать только с одним из слов
  sizeMinMiB: 0, sizeMaxMiB: 0,   // 0 — не ограничено
  completedOp: "any",    // any | gt | lt | eq
  completedVal: 0,
  age: "all",            // all | 24h | 7d | 30d | 90d | 365d
  hideSeen: false,
};

const AGE_MS = { "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3, "90d": 90 * 86400e3, "365d": 365 * 86400e3 };
const toNum = v => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : 0; };
export const splitWords = text => String(text || "").split(/[,\n;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);

export function normalizeFilters(f = {}) {
  const d = DEFAULT_FILTERS;
  return {
    hideDead: !!f.hideDead,
    minSeeders: Math.floor(toNum(f.minSeeders)),
    block: Array.isArray(f.block) ? f.block.map(String).filter(Boolean) : d.block,
    require: Array.isArray(f.require) ? f.require.map(String).filter(Boolean) : d.require,
    sizeMinMiB: toNum(f.sizeMinMiB), sizeMaxMiB: toNum(f.sizeMaxMiB),
    completedOp: ["gt", "lt", "eq"].includes(f.completedOp) ? f.completedOp : "any",
    completedVal: Math.floor(toNum(f.completedVal)),
    age: AGE_MS[f.age] ? f.age : "all",
    hideSeen: !!f.hideSeen,
  };
}

/** Сколько условий фильтра сейчас включено (для значка на кнопке). */
export function activeFilterCount(f) {
  const n = normalizeFilters(f);
  return [n.hideDead, n.minSeeders > 0, n.block.length > 0, n.require.length > 0, n.sizeMinMiB > 0 || n.sizeMaxMiB > 0,
    n.completedOp !== "any", n.age !== "all", n.hideSeen].filter(Boolean).length;
}

/** Применяет фильтры к списку. seen — множество id, которые уже открывали/сохраняли. */
export function applyFilters(items, filters, { now = Date.now(), seen = new Set() } = {}) {
  const f = normalizeFilters(filters);
  const block = f.block.map(w => w.toLowerCase());
  const req = f.require.map(w => w.toLowerCase());
  return items.filter(it => {
    const t = it.title.toLowerCase();
    if (f.hideDead && it.seeders === 0) return false;
    if (it.seeders < f.minSeeders) return false;
    if (block.some(w => t.includes(w))) return false;
    if (req.length && !req.some(w => t.includes(w))) return false;
    const mib = it.sizeBytes / 1048576;
    if (f.sizeMinMiB && mib < f.sizeMinMiB) return false;
    if (f.sizeMaxMiB && mib > f.sizeMaxMiB) return false;
    if (f.completedOp === "gt" && !(it.downloads > f.completedVal)) return false;
    if (f.completedOp === "lt" && !(it.downloads < f.completedVal)) return false;
    if (f.completedOp === "eq" && it.downloads !== f.completedVal) return false;
    if (f.age !== "all" && it.date && now - it.date > AGE_MS[f.age]) return false;
    if (f.hideSeen && seen.has(it.id)) return false;
    return true;
  });
}

/** Склейка страниц: новые записи добавляются, повторы по id отбрасываются. */
export function mergePages(current, next) {
  const have = new Set(current.map(i => i.id));
  return current.concat(next.filter(i => !have.has(i.id)));
}

/** Диапазон выбора при Shift+щелчке: id между якорем и целью в текущем порядке списка. */
export function rangeIds(ids, anchorId, targetId) {
  const a = ids.indexOf(anchorId), b = ids.indexOf(targetId);
  if (a === -1 || b === -1) return [targetId];
  const [from, to] = a < b ? [a, b] : [b, a];
  return ids.slice(from, to + 1);
}

// ---------- страница раздачи ----------

const BLOCK = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "PRE", "BLOCKQUOTE", "UL", "OL", "TABLE"]);

function textOf(node, out) {
  for (const n of node.childNodes) {
    if (n.nodeType === 3) out.push(n.nodeValue);
    else if (n.nodeType === 1) {
      if (n.tagName === "BR") out.push("\n");
      else if (n.tagName === "SCRIPT" || n.tagName === "STYLE" || n.tagName === "IMG") continue;
      else { textOf(n, out); if (BLOCK.has(n.tagName)) out.push("\n"); }
    }
  }
}

function cleanText(s) {
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * HTML страницы /view/{id} → { title, fields, date, magnet, description, images, files }.
 * Текст описания берётся как простой текст (разметка с чужого сайта в программу
 * не вставляется), картинки — только https. parser — конструктор DOMParser
 * (в браузере по умолчанию свой, в тестах передаётся из jsdom).
 */
export function parseView(html, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(String(html || ""), "text/html");
  const fields = {};
  let ts = 0;
  doc.querySelectorAll(".panel-body .col-md-1").forEach(lab => {
    const key = lab.textContent.replace(":", "").trim().toLowerCase();
    const val = lab.nextElementSibling;
    if (!key || !val) return;
    fields[key] = val.textContent.replace(/\s+/g, " ").trim();
    if (key === "date") ts = Number(val.getAttribute("data-timestamp")) * 1000 || 0;
  });
  const desc = doc.querySelector("#torrent-description");
  const parts = [];
  if (desc) textOf(desc, parts);
  const images = [];
  if (desc) {
    desc.querySelectorAll("img").forEach(img => {
      const src = (img.getAttribute("src") || "").trim();
      if (/^https:\/\//i.test(src) && !images.includes(src)) images.push(src);
    });
  }
  const files = [];
  doc.querySelectorAll(".torrent-file-list li").forEach(li => {
    if (li.querySelector("ul")) return;
    const t = li.textContent.replace(/\s+/g, " ").trim();
    if (t) files.push(t);
  });
  const magnetA = doc.querySelector('a[href^="magnet:"]');
  return {
    title: (doc.querySelector(".panel-title") || { textContent: "" }).textContent.trim(),
    fields,
    date: ts,
    magnet: magnetA ? magnetA.getAttribute("href") : "",
    description: cleanText(parts.join("")).slice(0, 5000),
    images: images.slice(0, 12),
    files: files.slice(0, 300),
  };
}

// ---------- зеркала и проверка связи ----------

export const NYAA_MIRRORS = ["https://nyaa.si", "https://nyaa.land"];

/** Службы для проверки; apply — переключается ли зеркало в самой странице. */
export function buildServices(nyaaCustom = [], serverOrigin = "") {
  const services = [
    { id: "nyaa", name: "Nyaa", note: "список раздач и страницы", apply: true, mirrors: [...new Set([...NYAA_MIRRORS, ...nyaaCustom])] },
    { id: "shikimori", name: "Shikimori", note: "каталог и постеры в режиме «Смотреть» идут через сервер студии", apply: false, mirrors: ["https://shikimori.one", "https://shikimori.io", "https://shikimori.me"] },
    { id: "anilist", name: "AniList", note: "описания, баннеры, расписание эфира", apply: false, mirrors: ["https://graphql.anilist.co", "https://anilist.co"] },
    { id: "jikan", name: "MyAnimeList (Jikan)", note: "оценки и опенинги", apply: false, mirrors: ["https://api.jikan.moe"] },
  ];
  if (serverOrigin) services.push({ id: "server", name: "Сервер студии", note: "задачи, файлы, чат", apply: false, mirrors: [serverOrigin] });
  return services;
}

/** Результат проверки → { level: ok|slow|warn|bad, text }. */
export function classifyCheck(r) {
  if (!r) return { level: "idle", text: "не проверено" };
  if (r.error) return { level: "bad", text: r.error };
  if (!r.ok) return { level: "bad", text: `ошибка сервера ${r.status}` };
  if (r.status >= 400) return { level: "warn", text: `отвечает (${r.status}), но может не пускать` };
  if (r.ms > 1500) return { level: "slow", text: `медленно · ${r.ms} мс` };
  return { level: "ok", text: `доступен · ${r.ms} мс` };
}

/** Привести введённое пользователем к виду https://host (или null). */
export function normalizeMirror(value) {
  let v = String(value || "").trim();
  if (!v) return null;
  if (!/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
    return `https://${u.host}`;
  } catch (_) { return null; }
}

export const hostOf = base => { try { return new URL(base).host; } catch (_) { return String(base); } };

/** Безопасное имя файла .torrent из названия раздачи. */
export function torrentFileName(item) {
  const base = String(item.title || `nyaa-${item.id}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${base || `nyaa-${item.id}`}.torrent`;
}
