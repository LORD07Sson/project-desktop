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
export function makeMonitor({ type, q, cat = "0_0" }, now = Date.now()) {
  const text = String(q || "").trim();
  if (!text) return null;
  const t = type === "user" ? "user" : "query";
  if (t === "user" && !/^[A-Za-z0-9_.-]{1,40}$/.test(text)) return null;
  return { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, type: t, q: text, cat: t === "user" ? "0_0" : cat, on: true, new: 0 };
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
