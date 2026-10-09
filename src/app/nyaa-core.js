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
  // Описание на Nyaa — сырой markdown, который сайт рисует скриптом: ![alt](https://…) и [текст](https://…).
  let description = cleanText(parts.join(""));
  description = description.replace(/!\[[^\]]*\]\((https:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g, (_, u) => { if (!images.includes(u)) images.push(u); return ""; });
  description = cleanText(description.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => (t.trim() === u ? u : `${t} (${u})`)));
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
    description: description.slice(0, 5000),
    images: images.slice(0, 12),
    files: files.slice(0, 300),
  };
}

// ---------- зеркала и проверка связи ----------

export const NYAA_MIRRORS = ["https://nyaa.si", "https://nya.iss.one", "https://nyaa.ink", "https://nyaa.land", "https://nyaa.digital", "https://ny.iss.one"];

/** Службы для проверки; apply — переключается ли зеркало в самой странице. */
export function buildServices(nyaaCustom = [], serverOrigin = "") {
  const services = [
    { id: "nyaa", name: "Nyaa", note: "список раздач и страницы", apply: true, mirrors: [...new Set([...NYAA_MIRRORS, ...nyaaCustom])] },
    { id: "shikimori", name: "Shikimori", note: "каталог и постеры в режиме «Смотреть» идут через сервер студии", apply: false, mirrors: ["https://shikimori.one", "https://shikimori.io", "https://shikimori.me"] },
    { id: "anilist", name: "AniList", note: "описания, баннеры, расписание эфира", apply: false, mirrors: ["https://graphql.anilist.co", "https://anilist.co"] },
    { id: "jikan", name: "MyAnimeList (Jikan)", note: "оценки и опенинги", apply: false, mirrors: ["https://api.jikan.moe"] },
    { id: "sources", name: "Источники раздачи", note: "SeaDex, AnimeTosho, nekoBT, Tsukihime на вкладке «Источники»", apply: false, mirrors: ["https://releases.moe", "https://feed.animetosho.org", "https://nekobt.to", "https://api.tsukihime.org"] },
  ];
  if (serverOrigin) services.push({ id: "server", name: "Сервер студии", note: "задачи, файлы, чат", apply: false, mirrors: [serverOrigin] });
  return services;
}

/** Результат проверки → { level: ok|slow|warn|bad, text }. */
// У адресов API без пути (graphql.…, api.…) ответ 404 на простой GET — норма: ручки открываются запросом POST или с путём.
const isApiHost = url => { try { return /^(graphql|api)\./.test(new URL(url).hostname); } catch (_) { return false; } };

export function classifyCheck(r) {
  if (!r) return { level: "idle", text: "не проверено" };
  if (r.error) return { level: "bad", text: r.error };
  if (!r.ok) return { level: "bad", text: `ошибка сервера ${r.status}` };
  if (r.status === 404 && isApiHost(r.url)) return { level: r.ms > 1500 ? "slow" : "ok", text: `API отвечает · ${r.ms} мс` };
  if (r.status >= 400) return { level: "warn", text: `отвечает (${r.status}), но может не пускать` };
  if (r.ms > 1500) return { level: "slow", text: `медленно · ${r.ms} мс` };
  return { level: "ok", text: `доступен · ${r.ms} мс` };
}

/** Самое быстрое рабочее зеркало из списка (по результатам проверки), или null. */
export function fastestMirror(mirrors, checks) {
  let best = null;
  for (const m of mirrors) {
    const r = checks[m];
    if (!r || r.error || !r.ok || r.status >= 400) continue;
    if (!best || r.ms < checks[best].ms) best = m;
  }
  return best;
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

// ---------- внешние источники по info hash ----------

export const isHash40 = h => /^[a-f0-9]{40}$/i.test(String(h || ""));

const q = encodeURIComponent;
export const sourceUrls = hash => {
  const h = String(hash).toLowerCase();
  return {
    seadexTorrent: `https://releases.moe/api/collections/torrents/records?filter=${q(`infoHash="${h}"`)}&perPage=1&skipTotal=true`,
    seadexEntry: `https://releases.moe/api/collections/entries/records?filter=${q(`trs.infoHash?="${h}"`)}&expand=trs&skipTotal=true`,
    animetosho: `https://feed.animetosho.org/json?show=torrent&btih=${q(h)}`,
    nekobtSearch: `https://nekobt.to/api/v1/torrents/search?query=${q(h)}`,
    tsukihime: `https://api.tsukihime.org/v1/torrents/btih/${q(h)}`,
  };
};

const safeJson = text => { try { return JSON.parse(text); } catch (_) { return null; } };

/** SeaDex: лучший / запасной релиз и ссылка на запись. */
export function parseSeadex(torrentText, entryText) {
  const t = safeJson(torrentText), e = safeJson(entryText);
  const tr = t && Array.isArray(t.items) ? t.items[0] : null;
  const entry = e && Array.isArray(e.items) ? e.items[0] : null;
  const found = !!(tr || entry);
  let best = tr ? !!tr.isBest : null;
  if (best === null && entry && entry.expand && Array.isArray(entry.expand.trs)) {
    const hit = entry.expand.trs[0];
    best = hit ? !!hit.isBest : null;
  }
  return { found, best, link: entry && entry.alID ? `https://releases.moe/${entry.alID}` : "" };
}

/** AnimeTosho (старый JSON): ссылка на страницу и число файлов. */
export function parseAnimetosho(text) {
  const j = safeJson(text);
  if (!j || j.error) return { found: false };
  let suffix = "";
  if (j.nyaa_id) suffix = `n${j.nyaa_id}`;
  else if (j.anidex_id) suffix = `d${j.anidex_id}`;
  else if (j.tosho_id) suffix = `${j.tosho_id}`;
  else if (j.nekobt_id) suffix = `k${j.nekobt_id}`;
  if (!suffix) return { found: false };
  return { found: true, link: `https://animetosho.org/view/${suffix}`, title: j.title || "", files: Array.isArray(j.files) ? j.files.length : 0 };
}

const LANG = /^[A-Za-z-]{2,8}$/;
const langList = v => (Array.isArray(v) ? v : String(v || "").split(",")).map(x => String(x).trim()).filter(x => LANG.test(x)).join(", ");

export function parseNekoSearch(text) {
  const j = safeJson(text);
  if (!j || j.error || !j.data || !j.data.infohash_match) return null;
  const id = String(j.data.infohash_match);
  return /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : null;
}

export function parseNekoTorrent(text) {
  const j = safeJson(text);
  const d = j && !j.error ? j.data : null;
  if (!d) return { found: false };
  const flags = [d.batch && "batch", d.hardsub && "hardsub", d.mtl && "MTL", d.otl && "OTL"].filter(Boolean);
  const group = Array.isArray(d.groups) ? d.groups[0] : null;
  return {
    found: true,
    link: `https://nekobt.to/torrents/${q(String(d.id))}`,
    title: String(d.title || ""),
    uploader: d.uploader ? String(d.uploader.display_name || d.uploader.username || "") : "",
    group: group ? String(group.display_name || group.name || "") : "",
    swarm: `${d.seeders ?? "?"} раздают · ${d.leechers ?? "?"} качают · ${d.completed ?? "?"} скачали`,
    size: Number.isFinite(Number(d.filesize)) ? fmtBytesEn(Number(d.filesize)) : "",
    audio: langList(d.audio_lang), subs: langList(d.sub_lang), flags,
  };
}

export function parseTsukihime(text) {
  const j = safeJson(text);
  if (!j || j.id == null) return { found: false };
  const anime = j.anime ? [j.anime.title, j.anime.english_title && `(${j.anime.english_title})`].filter(Boolean).join(" ") : "";
  return {
    found: true,
    link: `https://tsukihime.org/view/${q(String(j.id))}`,
    title: String(j.name || ""), anime,
    group: j.group ? String(j.group.name || "") : "",
    episode: j.episode_no != null && j.episode_no !== "" ? String(j.episode_no) : "",
    // у свежей раздачи Tsukihime ещё не посчитал размер и файлы: нули не показываем
    size: Number(j.totalsize) > 0 ? fmtBytesEn(Number(j.totalsize)) : "",
    files: Number(j.filecount) > 0 ? String(j.filecount) : "",
    audio: langList(j.audiolangs), subs: langList(j.sublangs),
  };
}

function fmtBytesEn(b) {
  const u = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ---------- «Похожее» через AniList ----------

/** Название раздачи → строка для поиска тайтла (без группы, качества, номера серии и скобок). */
export function cleanTitleForSearch(title) {
  let t = String(title || "");
  t = t.replace(/^\s*\[[^\]]*\]\s*/, "");                 // [Группа]
  t = t.replace(/[[(][^\])]*[\])]/g, " ");                 // любые скобки: [FLAC], (1080p), [ABCD1234]
  t = t.replace(/\.(mkv|mp4|avi|flac|mp3|zip|rar|7z)$/i, " ");
  t = t.replace(/\b(\d{3,4}p|HEVC|x26[45]|AVC|AV1|FLAC|BD(?:Rip)?|WEB(?:-?DL|Rip)?|Batch|Remux|Dual[- ]Audio|Multi[- ]?Subs?)\b/gi, " ");
  t = t.replace(/\s-\s*\d{1,3}(v\d)?\b.*$/i, " ");        // « - 09»
  t = t.replace(/\bS\d{1,2}E\d{1,3}\b.*$/i, " ");          // S02E05
  return t.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export const SIMILAR_QUERY = `query($s:String){Media(search:$s,type:ANIME){id siteUrl format seasonYear averageScore genres title{romaji english native} coverImage{medium}
relations{edges{relationType node{id siteUrl format averageScore title{romaji english} coverImage{medium}}}}
recommendations(perPage:8,sort:RATING_DESC){nodes{mediaRecommendation{id siteUrl format averageScore title{romaji english} coverImage{medium}}}}}}`;

export const COVER_QUERY = `query($s:String){Media(search:$s,type:ANIME){id coverImage{medium}}}`;

/** Обложка из ответа AniList: https-адрес или пустая строка, если тайтл не нашёлся. */
export function parseCover(text) {
  try {
    const u = JSON.parse(text).data.Media.coverImage.medium;
    return /^https:\/\//.test(u || "") ? u : "";
  } catch (_) { return ""; }
}

/** Ключ обложки: название тайтла без группы, серии и тегов. */
export const coverKey = title => {
  const r = parseRelease(title);
  const base = r.episode != null && r.show ? r.show : cleanTitleForSearch(title);
  return String(base || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
};

const REL = { SEQUEL: "Продолжение", PREQUEL: "Предыстория", SIDE_STORY: "Побочная история", SPIN_OFF: "Спин-офф", PARENT: "Основной тайтл", ALTERNATIVE: "Альтернатива", ADAPTATION: "Первоисточник", SUMMARY: "Пересказ", OTHER: "Связано" };

const media = n => n && n.id ? ({
  id: n.id, url: String(n.siteUrl || ""), format: n.format || "", score: n.averageScore || 0,
  title: String((n.title && (n.title.english || n.title.romaji)) || ""), romaji: String((n.title && n.title.romaji) || ""),
  cover: n.coverImage && /^https:\/\//.test(n.coverImage.medium || "") ? n.coverImage.medium : "",
}) : null;

export function parseSimilar(text) {
  const j = safeJson(text);
  const m = j && j.data ? j.data.Media : null;
  if (!m) return { found: false };
  const related = ((m.relations && m.relations.edges) || [])
    .filter(e => e.node && e.node.id && ["SEQUEL", "PREQUEL", "SIDE_STORY", "SPIN_OFF", "PARENT", "ALTERNATIVE", "SUMMARY"].includes(e.relationType))
    .map(e => ({ ...media(e.node), relation: REL[e.relationType] || REL.OTHER }));
  const recs = ((m.recommendations && m.recommendations.nodes) || []).map(n => media(n && n.mediaRecommendation)).filter(Boolean);
  return { found: true, self: media(m), year: m.seasonYear || "", genres: (m.genres || []).slice(0, 6), related, recs };
}

// ---------- слежение ----------

export const MONITOR_SEEN_MAX = 400;

/** Новое слежение: type — query (запрос) или user (загрузчик). */
export function makeMonitor({ type, q, cat = "0_0", rule = null }, now = Date.now()) {
  const text = String(q || "").trim();
  if (!text) return null;
  const t = type === "user" ? "user" : "query";
  if (t === "user" && !/^[A-Za-z0-9_.-]{1,40}$/.test(text)) return null;
  return { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, type: t, q: text, cat: t === "user" ? "0_0" : cat, on: true, new: 0, ...(rule ? { rule, got: [] } : {}) };
}

export const monitorTitle = m => (m.type === "user" ? `Загрузчик ${m.q}` : m.q);

/**
 * Сравнивает свежий список с уже виденным. Первая проверка (m.seen нет) только
 * запоминает: уведомлять о «новом» там, где всё новое, было бы шумом.
 */
export function diffMonitor(items, m) {
  const ids = items.map(i => i.id);
  if (!Array.isArray(m.seen)) return { fresh: [], seen: ids.slice(0, MONITOR_SEEN_MAX) };
  const have = new Set(m.seen);
  const fresh = items.filter(i => !have.has(i.id));
  const seen = [...ids, ...m.seen.filter(id => !ids.includes(id))].slice(0, MONITOR_SEEN_MAX);
  return { fresh, seen };
}

/** Название клиента для подписей. */
export const CLIENT_NAMES = { qbittorrent: "qBittorrent", transmission: "Transmission", deluge: "Deluge" };
export const CLIENT_PORTS = { qbittorrent: 8080, transmission: 9091, deluge: 8112 };

/** Безопасное имя файла .torrent из названия раздачи. */
export function torrentFileName(item) {
  const base = String(item.title || `nyaa-${item.id}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${base || `nyaa-${item.id}`}.torrent`;
}

// ---------- Релизы 2.0: группировка по аниме и правила слежения ----------

const normShow = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Разбор названия раздачи: аниме, сезон, серия, группа, качество, кодек.
 * episode = null, если это не серия (пачка, OST, неразобранное название).
 */
export function parseRelease(title, folder = "") {
  let t = String(title || "");
  const group = (/^\s*\[([^\]]{1,40})\]/.exec(t) || [])[1] || "";
  // Несколько скобок в начале («[Группа] [Перевод] Название»): убираем все ведущие.
  let body = t.replace(/^(?:\s*\[[^\]]*\])+\s*/, "");
  const res = (/(?:^|[^\d])(2160|1440|1080|720|576|480)\s*p\b/i.exec(t) || [])[1];
  const codec = /\b(hevc|x265|h\.?265)\b/i.test(t) ? "hevc" : /\b(avc|x264|h\.?264)\b/i.test(t) ? "avc" : /\bav1\b/i.test(t) ? "av1" : "";
  const hasSE = /\bS\d{1,2}\s*E\d{1,3}\b/i.test(body);
  // «01-12» — диапазон серий, если первое число меньше второго и перед ним не стоит слово «сезон/часть».
  const range = [...body.matchAll(/(?<!\w)(?:(S(?:eason)?|Part|Cour)\s*)?(\d{1,3})\s*[-~]\s*(\d{1,3})\s*(?=\[|\(|$)/gi)].some(r => !r[1] && +r[2] < +r[3]);
  const batch = !hasSE && (range || /\b(batch|complete|bd\s*box|season\s*\d+\s*\()/i.test(body));
  let season = 1, episode = null, version = 1, show = body;
  const ver = v => { if (v) version = +v; };
  let m = /^(.*?)[\s._-]*\bS(\d{1,2})\s*E(\d{1,3})(?:v(\d))?\b/i.exec(body);
  if (m) { show = m[1]; season = +m[2]; episode = +m[3]; ver(m[4]); }
  else if ((m = /^(.*?)\s+S(\d{1,2})\s+-\s+(\d{1,3})(?:v(\d))?(?=\s|\[|\(|$)/i.exec(body))) { show = m[1]; season = +m[2]; episode = +m[3]; ver(m[4]); }
  else if ((m = /^(.*?)\s+-\s+(\d{1,3})(?:v(\d))?(?=\s|\[|\(|$)/.exec(body))) { show = m[1]; episode = +m[2]; ver(m[3]); }
  else if ((m = /^(.*?)\s*第\s*(\d{1,3})\s*話/.exec(body))) { show = m[1]; episode = +m[2]; }
  else if ((m = /^(.*?)\s+(?:E|EP|Ep|Episode|#)\s*(\d{1,3})(?:v(\d))?\b/.exec(body))) { show = m[1]; episode = +m[2]; ver(m[3]); }
  // Старый стиль без дефиса: «Название 03 [1080p]» — номер сразу перед тегами.
  else if ((m = /^(.*?[^\d\s])\s+(\d{1,2})(?:v(\d))?\s*(?=[[(])/.exec(body)) && !/\b(S(?:eason)?|Part|Cour|Vol(?:ume)?)\s*$/i.test(m[1]) && +m[2] > 0) { show = m[1]; episode = +m[2]; ver(m[3]); }
  const sm = /^(.*?)[\s._-]+(?:S(?:eason)?\s*(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+Season|Season\s*(\d{1,2})|(?:Part|Cour)\s*(\d{1,2}))\s*$/i.exec(show);
  if (sm) { show = sm[1]; season = +(sm[2] || sm[3] || sm[4] || sm[5]); }
  // Сезон из названия папки, если в названии файла его нет.
  if (season === 1 && folder) {
    const fm = /(?:\bS(?:eason)?\s*(\d{1,2})\b|(\d{1,2})(?:st|nd|rd|th)\s+Season)/i.exec(String(folder));
    if (fm) season = +(fm[1] || fm[2]);
  }
  show = show.replace(/\s*[[(][^\])]*[\])]\s*/g, " ").replace(/[\s._]+$/, "").trim();
  if (!show && folder) show = String(folder).replace(/[[(][^\])]*[\])]/g, " ").replace(/\b(Season|S)\s*\d+\b/gi, "").trim();
  if (batch) episode = null;
  return { show, key: `${normShow(show)}|${season}`, season, episode, version, group, res: res ? `${res}p` : "", codec };
}

const RES_RANK = { "2160p": 5, "1440p": 4, "1080p": 3, "720p": 2, "576p": 1, "480p": 0 };

/** Оценка раздачи по правилу {groups[], res, noHevc}: чем больше, тем лучше; null — не подходит. */
export function ruleScore(item, rule = {}) {
  const r = item._rel || parseRelease(item.title);
  const groups = (rule.groups || []).map(g => g.toLowerCase());
  let score = 0;
  if (groups.length) {
    const gi = groups.indexOf((r.group || "").toLowerCase());
    if (gi < 0) return null;
    score += (groups.length - gi) * 1000;
  }
  if (rule.res) {
    if (r.res !== rule.res) return null;
    score += 500;
  } else score += (RES_RANK[r.res] ?? 1) * 100;
  if (rule.noHevc && r.codec === "hevc") score -= 300;
  if (item._sd === "best") score += 2000; else if (item._sd === "alt") score += 800;
  return score + Math.min(item.seeders || 0, 99) / 100;
}

/** Лучшая раздача на каждую серию (по правилу, иначе по качеству и раздающим). */
export function bestPerEpisode(items, rule = {}) {
  const best = new Map();
  for (const it of items) {
    const r = it._rel || (it._rel = parseRelease(it.title));
    if (r.episode == null) continue;
    const sc = ruleScore(it, rule);
    if (sc == null) continue;
    const cur = best.get(r.episode);
    if (!cur || sc > cur.sc) best.set(r.episode, { it, sc });
  }
  return [...best.entries()].sort((a, b) => b[0] - a[0]).map(([ep, v]) => ({ episode: ep, item: v.it }));
}

/**
 * Группировка списка: серии одного аниме и сезона собираются в одну карточку.
 * Раздачи без номера серии остаются отдельными строками. Порядок — по первому появлению.
 */
export function groupReleases(list, rule = {}) {
  const out = [];
  const byKey = new Map();
  for (const it of list) {
    const r = it._rel || (it._rel = parseRelease(it.title));
    if (r.episode == null || !r.show) { out.push({ kind: "item", item: it }); continue; }
    let g = byKey.get(r.key);
    if (!g) { g = { kind: "group", key: r.key, title: r.show, season: r.season, items: [] }; byKey.set(r.key, g); out.push(g); }
    g.items.push(it);
  }
  return out.map(g => {
    if (g.kind !== "group") return g;
    if (g.items.length < 2) return { kind: "item", item: g.items[0] };
    const groups = new Set(g.items.map(i => i._rel.group).filter(Boolean));
    return { ...g, groups: groups.size, episodes: bestPerEpisode(g.items, rule), best: g.items.slice().sort((a, b) => (ruleScore(b, rule) ?? -1) - (ruleScore(a, rule) ?? -1))[0] };
  });
}

/** Ключ серии для памяти «уже отправлено/скачано». */
export const episodeKey = it => { const r = it._rel || parseRelease(it.title); return r.episode == null ? "" : `${r.key}|${r.episode}`; };

/** Разбор правила из полей формы: группы через запятую, качество, без HEVC, действие. */
export function makeRule({ groups = "", res = "", noHevc = false, auto = false } = {}) {
  const gl = [...new Set(String(groups).split(/[,;]+/).map(s => s.trim()).filter(Boolean))].slice(0, 6);
  const r = ["2160p", "1080p", "720p", "480p"].includes(res) ? res : "";
  if (!gl.length && !r && !noHevc && !auto) return null;
  return { groups: gl, res: r, noHevc: !!noHevc, auto: !!auto };
}

export const ruleText = rule => !rule ? "" : [
  rule.groups.length ? rule.groups.join(" → ") : "любая группа", rule.res || "", rule.noHevc ? "не HEVC" : "", rule.auto ? "в клиент автоматически" : "",
].filter(Boolean).join(" · ");

/**
 * Свежие раздачи для слежения с правилом: подходящие по правилу, по одной лучшей
 * на серию, без серий, уже полученных раньше (m.got — ключи серий).
 */
export function freshForRule(fresh, m) {
  if (!m.rule) return fresh;
  const got = new Set(m.got || []);
  return bestPerEpisode(fresh, m.rule).map(x => x.item).filter(it => { const k = episodeKey(it); return !k || !got.has(k); });
}

// ---------- SeaDex по списку, AnimeTosho (субтитры, кадры), ссылки на тайтл, вкладки ----------

/** Один запрос SeaDex на весь список: адрес по info hash'ам (до 75). */
export function seadexListUrl(hashes) {
  const hs = [...new Set(hashes.map(h => String(h || "").toLowerCase()).filter(isHash40))].slice(0, 75);
  if (!hs.length) return "";
  const filter = hs.map(h => `infoHash="${h}"`).join("||");
  return `https://releases.moe/api/collections/torrents/records?filter=${encodeURIComponent(filter)}&perPage=75&skipTotal=true`;
}

/** Ответ SeaDex по списку → Map hash → "best" | "alt". */
export function parseSeadexList(text) {
  const out = new Map();
  const j = safeJson(text);
  if (!j || !Array.isArray(j.items)) return out;
  for (const t of j.items) {
    const h = String(t.infoHash || "").toLowerCase();
    if (isHash40(h)) out.set(h, t.isBest ? "best" : "alt");
  }
  return out;
}

/**
 * AnimeTosho (show=torrent): файлы раздачи с дорожками субтитров, числом шрифтов и
 * отметками времени кадров. Ответ без файлов — found: false.
 */
export function parseToshoTorrent(text) {
  const j = safeJson(text);
  if (!j || !Array.isArray(j.files) || !j.files.length) return { found: false, files: [] };
  const files = j.files.slice(0, 40).map(f => {
    const att = Array.isArray(f.attachments) ? f.attachments : [];
    return {
      id: Number(f.id) || 0,
      name: String(f.filename || ""),
      size: Number(f.size) || 0,
      subs: att.filter(a => a.type === "subtitle" && a.id).map(a => ({
        id: Number(a.id), num: Number(a.info && a.info.tracknum) || 0, codec: String((a.info && a.info.codec) || "").toUpperCase(), lang: String((a.info && a.info.lang) || "und"),
        def: !!(a.info && a.info.default), forced: !!(a.info && a.info.forced), size: Number(a.size) || 0,
      })),
      fonts: att.filter(a => a.type === "other" && a.info && /font/i.test(String(a.info.mime || ""))).length,
      shots: Array.isArray(f.vidframe_timestamps) ? f.vidframe_timestamps.map(Number).filter(n => Number.isFinite(n) && n >= 0).slice(0, 12) : [],
    };
  });
  return { found: true, files, anidb: Number(j.anidb_aid) || 0 };
}

const pad2 = n => String(n).padStart(2, "0");
const clock = ms => `${Math.floor(ms / 3600000)}:${pad2(Math.floor(ms / 60000) % 60)}:${pad2(Math.floor(ms / 1000) % 60)}`;
const assTime = s => { const m = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(s); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4].padEnd(3, "0") : 0; };

/** Реплики субтитров (ASS/SSA/SRT) для просмотра: [{ at, text }], теги и стили убраны. */
// Убирает разметку вида <i>…</i> из реплики посимвольно (без регулярных выражений для HTML):
// текст всё равно выводится только через экранирование.
function dropMarkup(str) {
  let out = "", depth = 0;
  for (const ch of String(str)) {
    if (ch === "<") depth++;
    else if (ch === ">" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

export function parseSubtitle(text, codec = "") {
  const src = String(text || "").replace(/^﻿/, "").replace(/\r/g, "");
  const out = [];
  if (/ASS|SSA/i.test(codec) || /^\[Script Info\]/m.test(src)) {
    let textCol = 9, startCol = 1, ready = false;
    for (const line of src.split("\n")) {
      const f = /^Format:\s*(.*)$/i.exec(line);
      if (f && !ready && /Text/i.test(f[1]) && /Start/i.test(f[1])) {
        const cols = f[1].split(",").map(c => c.trim().toLowerCase());
        textCol = cols.indexOf("text"); startCol = cols.indexOf("start"); ready = true; continue;
      }
      const d = /^Dialogue:\s*(.*)$/i.exec(line);
      if (!d) continue;
      const parts = d[1].split(",");
      const body = parts.slice(textCol).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, " / ").replace(/\\h/g, " ").trim();
      if (body) out.push({ at: assTime(parts[startCol] || ""), text: body });
      if (out.length >= 4000) break;
    }
  } else {
    for (const block of src.split(/\n{2,}/)) {
      const ls = block.split("\n").filter(Boolean);
      const ti = ls.findIndex(l => l.includes("-->"));
      if (ti < 0) continue;
      const body = dropMarkup(ls.slice(ti + 1).join(" / ")).trim();
      if (body) out.push({ at: assTime(ls[ti].split("-->")[0].trim()), text: body });
      if (out.length >= 4000) break;
    }
  }
  return out.sort((a, b) => a.at - b.at).map(x => ({ ...x, clock: clock(x.at) }));
}

/** Ссылки на тайтл из названия раздачи: поиск на AniList, MyAnimeList, AniDB, NekoBT. */
export function titleLinks(title) {
  const q = cleanTitleForSearch(title);
  if (!q) return [];
  const e = encodeURIComponent(q);
  return [
    { label: "AniList", url: `https://anilist.co/search/anime?search=${e}` },
    { label: "MyAnimeList", url: `https://myanimelist.net/anime.php?q=${e}&cat=anime` },
    { label: "AniDB", url: `https://anidb.net/search/anime/?adb.search=${e}&do.search=1` },
    { label: "NekoBT", url: `https://nekobt.to/search?query=${e}` },
  ];
}

export const DETAIL_TABS = [["desc", "Описание"], ["files", "Файлы"], ["src", "Источники"], ["tosho", "Субтитры и кадры"], ["sim", "Похожее"]];

/** Порядок и видимость вкладок страницы раздачи по сохранённым настройкам. */
export function normalizeTabs(saved) {
  const ids = DETAIL_TABS.map(t => t[0]);
  const order = [...new Set((saved && Array.isArray(saved.order) ? saved.order : []).filter(i => ids.includes(i)))];
  ids.forEach(i => { if (!order.includes(i)) order.push(i); });
  const hidden = (saved && Array.isArray(saved.hidden) ? saved.hidden : []).filter(i => ids.includes(i) && i !== "desc");
  return { order, hidden };
}

/** Tsukihime по btih: номера торрента и файлов, точные ссылки на тайтл (AniList, MAL, AniDB). */
export function parseTsukiFull(text) {
  const j = safeJson(text);
  if (!j || !j.id) return { found: false, files: [], ids: {} };
  const a = j.anime || {};
  return {
    found: true, tid: Number(j.id) || 0,
    files: (Array.isArray(j.files) ? j.files : []).slice(0, 40).map(f => ({ id: Number(f.id) || 0, name: String(f.filename || "") })),
    ids: { anilist: Number(a.anilist) || 0, mal: Number(a.mal) || 0, anidb: Number(a.anidb) || 0 },
  };
}

/** Точные ссылки по номерам из Tsukihime; пустой список, если номеров нет. */
export function exactLinks(ids) {
  const out = [];
  if (ids && ids.anilist) out.push({ label: "AniList", url: `https://anilist.co/anime/${ids.anilist}` });
  if (ids && ids.mal) out.push({ label: "MyAnimeList", url: `https://myanimelist.net/anime/${ids.mal}` });
  if (ids && ids.anidb) out.push({ label: "AniDB", url: `https://anidb.net/anime/${ids.anidb}` });
  return out;
}

/** MediaInfo из ответа Tsukihime по файлу. */
export function parseMediainfo(text) {
  const j = safeJson(text);
  const m = j && (j.mediainfo || (j.info && j.info.mediainfo));
  return typeof m === "string" ? m.trim().slice(0, 60000) : "";
}

const escH = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HL_CAP = 100000;

/**
 * Подсветка исходного текста субтитров (ASS/SRT): HTML, уже экранированный.
 * Длинные файлы выше порога остаются без подсветки.
 */
export function highlightSubtitle(raw) {
  const text = String(raw || "");
  if (text.length > HL_CAP) return escH(text.slice(0, 400000));
  return text.split("\n").map(line => {
    const l = line.replace(/\r$/, "");
    if (/^\[[^\]]+\]\s*$/.test(l)) return `<span class="hl-sec">${escH(l)}</span>`;
    const m = /^(Dialogue|Comment|Style|Format|Title|ScriptType|PlayRes[XY]):(.*)$/i.exec(l);
    if (m) return `<span class="hl-key">${escH(m[1])}:</span>${escH(m[2]).replace(/\{[^}]*\}/g, t => `<span class="hl-tag">${t}</span>`)}`;
    if (/^\d+$/.test(l.trim())) return `<span class="hl-num">${escH(l)}</span>`;
    if (l.includes("-->")) return `<span class="hl-time">${escH(l)}</span>`;
    return escH(l).replace(/&lt;[^&]*?&gt;/g, t => `<span class="hl-tag">${t}</span>`);
  }).join("\n");
}

/** Дорожка субтитров по умолчанию для кадров: первая не форсированная, ASS/SSA с номером дорожки. */
export function defaultShotTrack(subs) {
  const s = (subs || []).find(x => x.num && !x.forced && /ASS|SSA/i.test(x.codec));
  return s ? s.num : 0;
}

/** Ключи серий из имён файлов медиатеки ({ name, folder }): по ним раздачам ставится «уже есть». */
export function libraryKeys(files) {
  const keys = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    const r = parseRelease(String(f.name || "").replace(/\.[A-Za-z0-9]{2,4}$/, ""), String(f.folder || ""));
    if (r.episode != null && r.show) keys.add(`${r.key}|${r.episode}`);
  }
  return keys;
}
