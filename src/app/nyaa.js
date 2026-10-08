// Страница «Релизы» (Nyaa): живая подборка из публичной RSS-ленты прямо во
// вкладке — не нужно заходить на сайт. Категории, фильтр доверенных,
// поиск, сортировка, «запомнить запрос», выбор строк и копирование magnet /
// ссылок / названий пачкой. Двойной щелчок (или кнопка ⓘ) открывает
// страницу раздачи внутри программы: данные, описание, картинки, файлы.
// «Источники» — смена зеркала Nyaa и проверка связи с Nyaa, Shikimori,
// AniList, Jikan и сервером студии. Программа ничего не скачивает: только
// маленький .torrent по кнопке. Сеть — Rust (nyaa.rs), разбор — nyaa-core.js.
// Вкладка только для админов, как и Nyaa в боте.

import { invoke, openExternal, pickOutputFile } from "./tauri.js";
import { toast, API_BASE, apiBlob, openSheet } from "./api.js";
import { state } from "./state.js";
import { notifyDesktop } from "./desktop-notify.js";
import { $, esc } from "./utils.js";
import {
  CATEGORIES, FILTERS, parseNyaaRss, magnetLink, sortItems, relTime, fmtDate,
  splitTitle, categoryKind, summarize, fmtBytes, torrentFileName,
  parseView, buildServices, classifyCheck, normalizeMirror, hostOf, fastestMirror, NYAA_MIRRORS,
  applyFilters, activeFilterCount, normalizeFilters, DEFAULT_FILTERS, splitWords, mergePages, rangeIds,
  makeMonitor, monitorTitle, diffMonitor, CLIENT_NAMES, CLIENT_PORTS,
  isHash40, sourceUrls, parseSeadex, parseAnimetosho, parseNekoSearch, parseNekoTorrent, parseTsukihime,
  cleanTitleForSearch, parseSimilar, SIMILAR_QUERY,
  groupReleases, episodeKey, makeRule, ruleText, freshForRule, COVER_QUERY, parseCover, coverKey,
  seadexListUrl, parseSeadexList, parseToshoTorrent, parseSubtitle, titleLinks, DETAIL_TABS, normalizeTabs,
  parseTsukiFull, exactLinks, parseMediainfo, highlightSubtitle, defaultShotTrack,
} from "./nyaa-core.js";

const KEY = "project-nyaa";
const QUICK_CATS = [["2_1", "Аудио без потерь"], ["1_2", "Аниме · англ. субтитры"], ["1_4", "Аниме · raw"], ["1_3", "Аниме · другие языки"], ["0_0", "Всё"]];
const SORTS = [["date", "Новые"], ["seeders", "Раздают"], ["downloads", "Скачивают"], ["size", "Размер"]];
const KIND_ICON = { anime: "🎬", audio: "♪", video: "▶", other: "•" };

function loadPrefs() {
  const d = { cat: "2_1", filter: "0", q: "", sort: "date", saved: [], base: NYAA_MIRRORS[0], custom: [], filters: { ...DEFAULT_FILTERS }, presets: [], monitors: [], route: {}, group: false, hideDone: false, onlySeadex: false, tabs: {} };
  try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch (_) { return d; }
}
const prefs = loadPrefs();
prefs.filters = normalizeFilters(prefs.filters);

// «Уже смотрел»: раздачи, которые открывали, копировали или сохраняли.
const SEEN_KEY = "project-nyaa-seen";
const seen = (() => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); } catch (_) { return new Set(); } })();
const markSeen = id => {
  if (seen.has(id)) return;
  seen.add(id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-3000))); } catch (_) { /* не запомнится */ }
};
// Серии, которые уже отправлены в клиент: по ним ставится пометка и работает «скрыть скачанное».
const EPS_KEY = "project-nyaa-eps";
const sentEps = (() => { try { return new Set(JSON.parse(localStorage.getItem(EPS_KEY) || "[]")); } catch (_) { return new Set(); } })();
const markSent = list => {
  list.forEach(i => { const k = episodeKey(i); if (k) sentEps.add(k); });
  try { localStorage.setItem(EPS_KEY, JSON.stringify([...sentEps].slice(-2000))); } catch (_) { /* не запомнится */ }
};
const openGroups = new Set();

// Кэш последней ленты: если сайт не отвечает, показываем её с пометкой, сколько данным минут.
const CACHE_KEY = "project-nyaa-cache";
const cacheId = () => [prefs.base, prefs.q, prefs.cat, prefs.filter].join("|");
const cacheSave = xml => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ id: cacheId(), at: Date.now(), xml })); } catch (_) { /* не поместилось */ } };
const cacheLoad = () => {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); return c && c.id === cacheId() && Date.now() - c.at < 24 * 3600e3 ? c : null; } catch (_) { return null; }
};
let stale = 0;               // метка времени кэша, если показываем старые данные

const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) { /* не запомнится */ } };

let items = [];
let loading = false;
let error = "";
let fetchedAt = 0;
let page = 1;
let hasMore = false;
let moreBusy = false;
let filtersOpen = false;
let anchorId = null;
let client = null;          // настройки торрент-клиента (без пароля)
let clientDraft = null;
const selected = new Set();
let checks = {};           // url → результат проверки по выбранному для сервиса соединению
let localChecks = {};      // url → проверка с этого компьютера
let serverChecks = {};     // url → проверка с сервера студии (через его туннель WireGuard)
let checking = false;
let detail = null;         // { item, state, view, err, tab, imgs, lightbox }

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  torrent: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  magnet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v7a7 7 0 0 0 14 0V4h-4v7a3 3 0 0 1-6 0V4zM5 7h4M15 7h4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 16V6a2 2 0 0 1 2-2h8"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H10l-5 4z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6 8v6l-4-2v-4z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-4 16-4.5-6.5zM11.5 13.5 20 4"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"/></svg>',
  plug: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>',
};

// SeaDex: «лучший» (синий) и «запасной» (оранжевый) релизы по info hash, одним запросом на список.
const sdMap = new Map();
const sdOf = it => sdMap.get(String(it.hash || "").toLowerCase()) || "";
const view = () => {
  items.forEach(i => { i._sd = sdOf(i); });
  let l = sortItems(applyFilters(items, prefs.filters, { seen }), prefs.sort, "desc");
  if (prefs.hideDone) l = l.filter(i => { const k = episodeKey(i); return !k || !sentEps.has(k); });
  if (prefs.onlySeadex) l = l.filter(i => i._sd);
  return l;
};

async function loadSeadexList() {
  const url = seadexListUrl(items.filter(i => !sdMap.has(String(i.hash || "").toLowerCase())).map(i => i.hash));
  if (!url) return;
  try {
    const found = parseSeadexList(await metaGet(url));
    items.forEach(i => { const h = String(i.hash || "").toLowerCase(); if (h && !sdMap.has(h)) sdMap.set(h, found.get(h) || ""); });
    paintList();
  } catch (_) { /* SeaDex недоступен — метки просто не показываются */ }
}
const serverOrigin = () => { try { return new URL(API_BASE).origin; } catch (_) { return ""; } };

function statsHtml(list) {
  if (!list.length) return "";
  const s = summarize(list);
  return `
    <div class="ny-stat"><b>${s.count}</b><span>раздач</span></div>
    <div class="ny-stat"><b>${esc(fmtBytes(s.bytes))}</b><span>всего</span></div>
    <div class="ny-stat"><b>${s.topSeeders}</b><span>макс. раздающих</span></div>
    <div class="ny-stat"><b>${s.trusted}</b><span>доверенных</span></div>`;
}

// ---------- обложки вместо значков ----------
// Обложка берётся с AniList по названию тайтла (одна на аниме, не на каждую раздачу) и держится
// в памяти; в localStorage лежит только адрес картинки. Не нашлась — остаётся значок.
const COVERS_KEY = "project-nyaa-covers";
const coverUrls = (() => { try { return JSON.parse(localStorage.getItem(COVERS_KEY) || "{}"); } catch (_) { return {}; } })();
const coverData = new Map();   // ключ → data-URL
const coverBusy = new Set();
const saveCovers = () => {
  const keys = Object.keys(coverUrls);
  if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete coverUrls[k]);
  try { localStorage.setItem(COVERS_KEY, JSON.stringify(coverUrls)); } catch (_) { /* не запомнится */ }
};

// У раздач без аниме-обложки (музыка, OST) аватар — первая картинка из описания раздачи.
const THUMBS_KEY = "project-nyaa-thumbs";
const thumbUrls = (() => { try { return JSON.parse(localStorage.getItem(THUMBS_KEY) || "{}"); } catch (_) { return {}; } })();
const thumbData = new Map();   // id → data-URL
const saveThumbs = () => {
  const keys = Object.keys(thumbUrls);
  if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(k => delete thumbUrls[k]);
  try { localStorage.setItem(THUMBS_KEY, JSON.stringify(thumbUrls)); } catch (_) { /* не запомнится */ }
};

async function fetchThumb(it) {
  const id = it.id;
  if (coverBusy.has(`t${id}`) || thumbData.has(id)) return;
  coverBusy.add(`t${id}`);
  try {
    let url = thumbUrls[id];
    if (url === undefined) {
      url = parseView(await nyaaView({ base: prefs.base, id })).images[0] || "";
      thumbUrls[id] = url; saveThumbs();
    }
    if (url) {
      thumbData.set(id, await invoke("fetch_image", { url }));
      document.querySelectorAll(".ny-kind[data-tid]").forEach(el => {
        if (el.dataset.tid !== String(id) || el.querySelector("img")) return;
        el.classList.add("has-cover"); el.innerHTML = `<img src="${esc(thumbData.get(id))}" alt="">`;
      });
    }
  } catch (_) { /* нет связи: попробуем позже */ }
  coverBusy.delete(`t${id}`);
}

function kindHtml(it, kind) {
  const key = coverKey(it.title);
  const src = thumbData.get(it.id) || (key && kind === "anime" && coverData.get(key)) || (kind !== "audio" && key && coverData.get(key));
  return `<span class="ny-kind k-${kind}${src ? " has-cover" : ""}" data-ck="${esc(key)}" data-tid="${esc(it.id)}" title="${esc(it.category)}">${src ? `<img src="${esc(src)}" alt="">` : KIND_ICON[kind]}</span>`;
}

function paintCover(key) {
  const src = coverData.get(key);
  if (!src) return;
  document.querySelectorAll(".ny-kind[data-ck]").forEach(el => {
    if (el.dataset.ck !== key || el.querySelector("img") || el.classList.contains("k-audio")) return;
    el.classList.add("has-cover"); el.innerHTML = `<img src="${esc(src)}" alt="">`;
  });
}

async function fetchCover(key) {
  if (coverBusy.has(key) || coverData.has(key)) return;
  coverBusy.add(key);
  try {
    let url = coverUrls[key];
    if (url === undefined) {
      url = parseCover(await invoke("anilist_query", { query: COVER_QUERY, variables: { s: key } }));
      coverUrls[key] = url; saveCovers();
    }
    if (url) { coverData.set(key, await invoke("fetch_image", { url })); paintCover(key); }
  } catch (_) { /* нет связи: попробуем при следующей отрисовке */ }
  coverBusy.delete(key);
}

let coverQueueOn = false;
async function loadListCovers() {
  if (coverQueueOn) return;
  coverQueueOn = true;
  try {
    const vis = view().slice(0, 60);
    const isAudio = i => categoryKind(i.categoryId) === "audio";
    const keys = [...new Set(vis.filter(i => !isAudio(i)).map(i => coverKey(i.title)).filter(k => k && !coverData.has(k) && coverUrls[k] !== ""))].slice(0, 30);
    const thumbs = vis.filter(i => isAudio(i) && !thumbData.has(i.id) && thumbUrls[i.id] !== "").slice(0, 30);
    const jobs = [...keys.map(k => () => fetchCover(k)), ...thumbs.map(i => () => fetchThumb(i))];
    let next = 0;
    const worker = async () => { while (next < jobs.length) await jobs[next++](); };
    await Promise.all([worker(), worker()]);
  } finally { coverQueueOn = false; }
}

function rowHtml(it, maxSeed, now) {
  const { group, tags } = splitTitle(it.title);
  const kind = categoryKind(it.categoryId);
  const health = maxSeed ? Math.max(4, Math.round(it.seeders / maxSeed * 100)) : 0;
  return `
    <div class="ny-row${it.trusted ? " tr" : ""}${it.remake ? " rm" : ""}${selected.has(it.id) ? " sel" : ""}${seen.has(it.id) ? " seen" : ""}${sdOf(it) ? ` sd-${sdOf(it)}` : ""}" data-id="${it.id}">
      <label class="ny-ck"><input type="checkbox" ${selected.has(it.id) ? "checked" : ""} aria-label="Выбрать"></label>
      ${kindHtml(it, kind)}
      <div class="ny-main">
        <div class="ny-title">${group ? `<em>${esc(group)}</em>` : ""}${esc(group ? it.title.replace(/^\s*\[[^\]]*\]\s*/, "") : it.title)}</div>
        <div class="ny-tags">${tags.map(t => `<i>${esc(t)}</i>`).join("")}${it.remake ? `<i class="warn">ремейк</i>` : ""}${sdOf(it) === "best" ? `<i class="sd-b" title="Лучший релиз по SeaDex">SeaDex ★</i>` : sdOf(it) === "alt" ? `<i class="sd-a" title="Хорошая альтернатива по SeaDex">SeaDex</i>` : ""}${it.trusted ? `<i class="ok">доверенный</i>` : ""}${it.comments ? `<span class="ny-cm">${ICONS.comment}${it.comments}</span>` : ""}</div>
      </div>
      <div class="ny-meta"><b>${esc(it.size)}</b><span title="${esc(fmtDate(it.date))}">${esc(relTime(it.date, now))}</span></div>
      <div class="ny-health" title="раздают · качают · скачали">
        <div class="ny-bar-bg"><u style="width:${health}%"></u></div>
        <div class="ny-nums"><span class="se">↑ ${it.seeders}</span><span class="le">↓ ${it.leechers}</span><span class="dl">✓ ${it.downloads}</span></div>
      </div>
      <div class="ny-act">
        <button type="button" class="ny-ib" data-a="info" title="Страница раздачи (двойной щелчок)" aria-label="Страница раздачи">${ICONS.info}</button>
        <button type="button" class="ny-ib" data-a="send" title="Отправить в торрент-клиент" aria-label="Отправить в торрент-клиент">${ICONS.send}</button>
        <button type="button" class="ny-ib" data-a="mag" title="Копировать magnet" aria-label="Копировать magnet">${ICONS.magnet}</button>
        <button type="button" class="ny-ib" data-a="tor" title="Сохранить .torrent" aria-label="Сохранить .torrent">${ICONS.torrent}</button>
        <button type="button" class="ny-ib" data-a="open" title="Открыть страницу в браузере" aria-label="Открыть в браузере">${ICONS.open}</button>
      </div>
    </div>`;
}

// Карточка аниме: серии одного сезона вместе, внутри — лучшая раздача на каждую серию.
function groupHtml(g, maxSeed, now) {
  const open = openGroups.has(g.key);
  const fresh = g.episodes.filter(e => !sentEps.has(episodeKey(e.item))).length;
  return `<div class="ny-grp${open ? " open" : ""}" data-gkey="${esc(g.key)}">
    <div class="ny-grp-h" data-grp-toggle="${esc(g.key)}"><span class="ny-grp-ar">${open ? "▾" : "▸"}</span>
      <div class="ny-grp-t"><b>${esc(g.title)}${g.season > 1 ? ` · сезон ${g.season}` : ""}</b><span>${g.items.length} раздач · ${g.groups || 1} групп · серий: ${g.episodes.length}</span></div>
      ${fresh ? `<i class="ny-grp-new">${fresh} ${fresh === 1 ? "новая" : "новых"}</i>` : `<i class="ny-grp-done">всё отправлено</i>`}
      <button type="button" class="btn ghost" data-grp-send="${esc(g.key)}" title="Отправить в торрент-клиент лучшие раздачи неотправленных серий">${ICONS.send} Все новые</button></div>
    ${open ? `<div class="ny-grp-b">${g.episodes.map(e => `<div class="ny-ep${sentEps.has(episodeKey(e.item)) ? " done" : ""}"><span class="ny-ep-n">E${String(e.episode).padStart(2, "0")}</span>${rowHtml(e.item, maxSeed, now)}</div>`).join("")}</div>` : ""}
  </div>`;
}

function skeleton() {
  return Array.from({ length: 8 }, () => `<div class="ny-row sk"><span class="ny-kind"></span><div class="ny-main"><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div></div>`).join("");
}

function listHtml() {
  if (loading && !items.length) return skeleton();
  if (error && !items.length) {
    return `<div class="ny-empty"><b>Не получилось загрузить с ${esc(hostOf(prefs.base))}</b><p>${esc(error)}</p>
      <div class="ny-empty-act"><button type="button" class="btn primary" id="ny-retry">Повторить</button><button type="button" class="btn" data-open-sources>Проверить зеркала</button></div>
      <p class="ny-hint">Если сайт переехал или заблокирован — выберите другое зеркало в «Источниках». Если открывается только через VPN, включите его.</p></div>`;
  }
  const list = view();
  const hidden = items.length - list.length;
  if (!list.length) {
    return `<div class="ny-empty"><b>${items.length ? "Всё скрыто фильтрами" : "Ничего не найдено"}</b><p>${items.length ? `Фильтры прячут ${hidden} из ${items.length}.` : "Попробуйте другое слово или категорию."}</p>${items.length ? `<button type="button" class="btn" data-flt-reset>Сбросить фильтры</button>` : ""}${hasMore ? `<div class="ny-more-wrap"><button type="button" class="btn primary" data-more>Показать ещё</button></div>` : ""}</div>`;
  }
  const maxSeed = Math.max(...list.map(i => i.seeders), 1);
  const now = Date.now();
  const body = prefs.group ? groupReleases(list).map(g => g.kind === "item" ? rowHtml(g.item, maxSeed, now) : groupHtml(g, maxSeed, now)).join("") : list.map(i => rowHtml(i, maxSeed, now)).join("");
  return (stale ? `<div class="ny-stale">Сайт не отвечает — показаны сохранённые данные (${esc(relTime(stale))}). <button type="button" class="ny-link" id="ny-retry">Обновить</button></div>` : "")
    + body
    + `<div class="ny-more-wrap">${hidden ? `<span class="ny-hint">фильтры скрывают ${hidden}</span>` : ""}${hasMore ? `<button type="button" class="btn" data-more>${moreBusy ? "Загружаю…" : "Показать ещё"}</button>` : `<span class="ny-hint">это всё, что отдал сайт</span>`}</div>`;
}

function barHtml() {
  if (!selected.size) return "";
  return `
    <span class="ny-bar-count"><b>${selected.size}</b> выбрано</span>
    <button type="button" class="btn primary" data-bulk="mag">${ICONS.magnet} Копировать magnet</button>
    <button type="button" class="btn" data-bulk="send">${ICONS.send} В торрент-клиент</button>
    <button type="button" class="btn" data-bulk="titles">${ICONS.copy} Названия</button>
    <button type="button" class="btn" data-bulk="links">${ICONS.open} Ссылки на страницы</button>
    <button type="button" class="btn ghost" data-bulk="clear">Сбросить</button>`;
}

function shellHtml() {
  return `
  <div class="ny">
    <header class="ny-hero">
      <div class="ny-hero-t"><span class="kd-label">Релизы · бета</span><h2>Nyaa <span class="ny-beta">Beta</span></h2>
        <p>Свежие раздачи из публичной ленты — не нужно заходить на сайт. Двойной щелчок по строке открывает страницу раздачи: описание, картинки, файлы.</p>
        <button type="button" class="ny-src-btn" data-open-sources>${ICONS.plug}<span id="ny-src-host"></span><i id="ny-src-dot"></i></button>
        <div class="ny-hero-btns">
          <button type="button" class="ny-src-btn" data-open-client>${ICONS.send}<span id="ny-client-lbl">Торрент-клиент</span></button>
          <button type="button" class="ny-src-btn" data-open-monitors>${ICONS.bell}<span>Слежение</span><b id="ny-mon-n" class="ny-badge"></b></button>
        </div></div>
      <div class="ny-stats" id="ny-stats"></div>
    </header>
    <section class="ny-sources" id="ny-sources" hidden></section>
    <section class="ny-sources" id="ny-client" hidden></section>
    <section class="ny-sources" id="ny-monitors" hidden></section>
    <div class="ny-search">
      <span class="ny-search-ic">${ICONS.search}</span>
      <input id="ny-q" type="text" placeholder="Название, группа, 1080p…" value="${esc(prefs.q)}" spellcheck="false" autocomplete="off">
      <button type="button" class="btn ghost" id="ny-save" title="Запомнить запрос и категорию">${ICONS.star} Запомнить</button>
      <button type="button" class="btn ghost" data-watch-query title="Следить за этим запросом и сообщать о новых раздачах">${ICONS.bell} Следить</button>
      <button type="button" class="btn primary" id="ny-go">Найти</button>
    </div>
    <div class="ny-cats" id="ny-cats"></div>
    <div class="ny-ctl">
      <div class="ny-seg" id="ny-filter"></div>
      <span class="ny-sp"></span>
      <div class="ny-seg" id="ny-sort"></div>
      <div class="ny-seg" id="ny-view"></div>
      <button type="button" class="ny-flt-btn" id="ny-flt-btn" aria-expanded="false">${ICONS.filter}<span>Фильтры</span><b id="ny-flt-n"></b></button>
      <button type="button" class="ny-ib wide" id="ny-refresh" title="Обновить список" aria-label="Обновить список">${ICONS.refresh}</button>
    </div>
    <section class="ny-filters" id="ny-filters" hidden></section>
    <div class="ny-saved" id="ny-saved"></div>
    <div class="ny-sel-all"><label><input type="checkbox" id="ny-all"> выбрать всё в списке</label><button type="button" class="ny-link" id="ny-invert">инвертировать</button><span class="ny-hint">Shift + щелчок — выбрать диапазон</span><span class="ny-sp"></span><span id="ny-upd"></span></div>
    <div class="ny-list" id="ny-list"></div>
    <div class="ny-bar" id="ny-bar" hidden></div>
  </div>`;
}

function seg(items2, current, attr) {
  return items2.map(([k, l]) => `<button type="button" class="${k === current ? "on" : ""}" ${attr}="${esc(k)}">${esc(l)}</button>`).join("");
}

function paintStatic() {
  $("#ny-cats").innerHTML = QUICK_CATS.map(([k, l]) => `<button type="button" class="ny-cat${k === prefs.cat ? " on" : ""}" data-cat="${k}">${esc(l)}</button>`).join("")
    + `<select id="ny-cat-more" aria-label="Другие категории"><option value="">Ещё категории…</option>${CATEGORIES.filter(([k]) => !QUICK_CATS.some(q => q[0] === k)).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select>`;
  $("#ny-filter").innerHTML = seg(FILTERS, prefs.filter, "data-filter");
  $("#ny-sort").innerHTML = seg(SORTS, prefs.sort, "data-sort");
  $("#ny-view").innerHTML = `<button type="button" class="${prefs.group ? "on" : ""}" data-toggle="group" title="Серии одного аниме в одной карточке">Группировать</button><button type="button" class="${prefs.hideDone ? "on" : ""}" data-toggle="hideDone" title="Скрыть серии, которые уже отправлены в клиент">Скрыть отправленное</button><button type="button" class="${prefs.onlySeadex ? "on" : ""}" data-toggle="onlySeadex" title="Только раздачи из SeaDex (лучшие и запасные релизы)">SeaDex</button>`;
  $("#ny-saved").innerHTML = prefs.saved.length
    ? `<span class="ny-saved-l">Мои запросы</span>` + prefs.saved.map((s, i) => `<span class="ny-chip"><button type="button" data-saved="${i}">${esc(s.q || "без слов")} <small>${esc((QUICK_CATS.concat(CATEGORIES).find(c => c[0] === s.cat) || [0, s.cat])[1])}</small></button><button type="button" class="x" data-saved-del="${i}" aria-label="Убрать">×</button></span>`).join("")
    : "";
  paintSourceChip();
  paintFilters();
}

function paintSourceChip() {
  const host = $("#ny-src-host"), dot = $("#ny-src-dot");
  if (!host) return;
  host.textContent = hostOf(prefs.base) + (viaServer ? " · через сервер" : "");
  dot.className = classifyCheck(checks[prefs.base]).level;
}

function paintFilterBadge() {
  const n = activeFilterCount(prefs.filters);
  const b = $("#ny-flt-n");
  if (b) b.textContent = n ? String(n) : "";
  $("#ny-flt-btn")?.classList.toggle("on", n > 0 || filtersOpen);
}

function paintList() {
  paintFilterBadge();
  const list = view();
  $("#ny-list").innerHTML = listHtml();
  $("#ny-stats").innerHTML = statsHtml(list);
  const bar = $("#ny-bar");
  bar.innerHTML = barHtml();
  bar.hidden = !selected.size;
  const all = $("#ny-all");
  if (all) all.checked = !!list.length && list.every(i => selected.has(i.id));
  const upd = $("#ny-upd");
  if (upd) upd.textContent = fetchedAt ? `обновлено ${relTime(fetchedAt)}` : "";
  loadListCovers();
}

async function load() {
  loading = true; error = "";
  $("#ny-refresh")?.classList.add("spin");
  paintList();
  try {
    const xml = await nyaaRss({ base: prefs.base, query: prefs.q, category: prefs.cat, filter: prefs.filter, page: 1 });
    items = parseNyaaRss(xml);
    page = 1;
    hasMore = items.length >= 50;
    fetchedAt = Date.now();
    stale = 0;
    cacheSave(xml);
    selected.clear();
  } catch (e) {
    const c = cacheLoad();
    if (c) {
      items = parseNyaaRss(c.xml); page = 1; hasMore = false; fetchedAt = c.at; stale = c.at; selected.clear();
    } else {
      error = friendlyError(e);
      items = [];
    }
  }
  loading = false;
  $("#ny-refresh")?.classList.remove("spin");
  paintList();
  loadSeadexList();
}

function paintClientMsg(text) {
  const el = $("#ny-client-msg");
  if (el) el.textContent = text;
}

// Страница загрузчика: те же раздачи, но только его.
async function loadUser(name) {
  loading = true; error = ""; paintList();
  try {
    items = parseNyaaRss(await nyaaRss({ base: prefs.base, query: "", category: "0_0", filter: "0", page: 1, user: name }));
    page = 1; hasMore = false; fetchedAt = Date.now(); selected.clear();
  } catch (e) { error = String(e && e.message ? e.message : e); items = []; }
  loading = false; paintList();
}

async function loadMore() {
  if (moreBusy || !hasMore) return;
  moreBusy = true; paintList();
  try {
    const xml = await nyaaRss({ base: prefs.base, query: prefs.q, category: prefs.cat, filter: prefs.filter, page: page + 1 });
    const next = parseNyaaRss(xml);
    const before = items.length;
    items = mergePages(items, next);
    page += 1;
    hasMore = next.length >= 50 && items.length > before;
  } catch (e) { toast(`Не удалось загрузить дальше: ${e}`, "error"); }
  moreBusy = false;
  paintList();
  loadSeadexList();
}

// Отметить раздачу «просмотренной» (открывали, копировали magnet, сохраняли .torrent).
function touch(id) {
  markSeen(id);
  document.querySelector(`.ny-row[data-id="${id}"]`)?.classList.add("seen");
}

async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg, "success"); }
  catch (_) { toast("Не удалось копировать.", "error"); }
}

const byId = id => items.find(i => i.id === id);
const pageUrl = it => `${prefs.base}/view/${it.id}`;

async function saveTorrent(it) {
  const out = await pickOutputFile(torrentFileName(it), [{ name: "Torrent", extensions: ["torrent"] }]);
  if (!out) return;
  try { await nyaaSaveTorrent(prefs.base, it.id, out); toast("Файл .torrent сохранён.", "success"); }
  catch (e) { toast(`Не удалось сохранить: ${e}`, "error"); }
}

function bulk(kind) {
  const list = view().filter(i => selected.has(i.id));
  if (kind === "clear") { selected.clear(); paintList(); return; }
  if (!list.length) return;
  list.forEach(i => touch(i.id));
  if (kind === "send") { sendToClient(list); return; }
  if (kind === "mag") copy(list.map(magnetLink).filter(Boolean).join("\n"), `Скопировано magnet: ${list.length}`);
  else if (kind === "titles") copy(list.map(i => i.title).join("\n"), `Скопировано названий: ${list.length}`);
  else if (kind === "links") copy(list.map(pageUrl).join("\n"), `Скопировано ссылок: ${list.length}`);
}

// ---------- фильтры ----------
const AGES = [["all", "за всё время"], ["24h", "за 24 часа"], ["7d", "за неделю"], ["30d", "за месяц"], ["90d", "за 3 месяца"], ["365d", "за год"]];
const OPS = [["any", "любое число"], ["gt", "больше"], ["lt", "меньше"], ["eq", "ровно"]];

function filtersHtml() {
  const f = prefs.filters;
  const val = v => (v ? esc(String(v)) : "");
  return `
    <div class="ny-f-grid">
      <label class="ny-chk"><input type="checkbox" data-f="hideDead" ${f.hideDead ? "checked" : ""}> Скрыть без раздающих</label>
      <label class="ny-chk"><input type="checkbox" data-f="hideSeen" ${f.hideSeen ? "checked" : ""}> Скрыть уже просмотренные</label>
      <label class="ny-fld"><span>Мин. раздающих</span><input type="number" min="0" data-f="minSeeders" value="${val(f.minSeeders)}" placeholder="0"></label>
      <label class="ny-fld"><span>Размер, МиБ</span><div class="ny-pair"><input type="number" min="0" data-f="sizeMinMiB" value="${val(f.sizeMinMiB)}" placeholder="от"><input type="number" min="0" data-f="sizeMaxMiB" value="${val(f.sizeMaxMiB)}" placeholder="до"></div></label>
      <label class="ny-fld"><span>Скачали</span><div class="ny-pair"><select data-f="completedOp">${OPS.map(([k, l]) => `<option value="${k}" ${f.completedOp === k ? "selected" : ""}>${l}</option>`).join("")}</select><input type="number" min="0" data-f="completedVal" value="${val(f.completedVal)}" placeholder="0"></div></label>
      <label class="ny-fld"><span>Загружено</span><select data-f="age">${AGES.map(([k, l]) => `<option value="${k}" ${f.age === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="ny-fld wide"><span>Скрыть, если в названии есть (через запятую)</span><input type="text" data-f="block" value="${esc(f.block.join(", "))}" placeholder="например: raw, mp3, remake" spellcheck="false"></label>
      <label class="ny-fld wide"><span>Показать только со словами (через запятую)</span><input type="text" data-f="require" value="${esc(f.require.join(", "))}" placeholder="например: flac, 1080p" spellcheck="false"></label>
    </div>
    <div class="ny-f-presets">
      <span class="ny-saved-l">Наборы</span>
      ${prefs.presets.map((p, i) => `<span class="ny-chip"><button type="button" data-preset="${i}">${esc(p.name)}</button><button type="button" class="x" data-preset-del="${i}" aria-label="Убрать">×</button></span>`).join("")}
      <input type="text" id="ny-preset-name" placeholder="Название набора" maxlength="30">
      <button type="button" class="btn" id="ny-preset-save">Сохранить набор</button>
      <button type="button" class="btn ghost" data-flt-reset>Сбросить всё</button>
    </div>`;
}

function paintFilters() {
  const box = $("#ny-filters");
  if (!box) return;
  box.hidden = !filtersOpen;
  if (filtersOpen) box.innerHTML = filtersHtml();
  paintFilterBadge();
}

function readFilters() {
  const g = k => document.querySelector(`#ny-filters [data-f="${k}"]`);
  return normalizeFilters({
    hideDead: g("hideDead").checked, hideSeen: g("hideSeen").checked,
    minSeeders: g("minSeeders").value, sizeMinMiB: g("sizeMinMiB").value, sizeMaxMiB: g("sizeMaxMiB").value,
    completedOp: g("completedOp").value, completedVal: g("completedVal").value, age: g("age").value,
    block: splitWords(g("block").value), require: splitWords(g("require").value),
  });
}

function resetFilters() {
  prefs.filters = { ...DEFAULT_FILTERS };
  savePrefs(); paintFilters(); paintList();
}

// ---------- торрент-клиент ----------
function paintClientLabel() {
  const l = $("#ny-client-lbl");
  if (l) l.textContent = client ? CLIENT_NAMES[client.kind] || "Торрент-клиент" : "Торрент-клиент";
}

function clientHtml(msg = "") {
  const c = clientDraft || client || { kind: "qbittorrent", url: "", user: "", category: "", tags: "", paused: false, has_pass: false };
  const hasPass = client && client.kind === c.kind && client.user === c.user && client.has_pass;
  return `
    <div class="ny-src-head"><div><b>Торрент-клиент</b><span>Отправка magnet в ваш клиент через его веб-интерфейс. Пароль хранится в защищённом хранилище Windows.</span></div>
      <div><button type="button" class="ny-ib wide" data-close-panel title="Закрыть" aria-label="Закрыть">${ICONS.close}</button></div></div>
    <div class="ny-f-grid">
      <label class="ny-fld"><span>Клиент</span><select data-c="kind">${Object.entries(CLIENT_NAMES).map(([k, n]) => `<option value="${k}" ${c.kind === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="ny-fld"><span>Адрес веб-интерфейса</span><input type="text" data-c="url" value="${esc(c.url)}" placeholder="http://127.0.0.1:${CLIENT_PORTS[c.kind]}" spellcheck="false"></label>
      <label class="ny-fld"><span>Логин</span><input type="text" data-c="user" value="${esc(c.user)}" spellcheck="false" autocomplete="off"></label>
      <label class="ny-fld"><span>Пароль</span><input type="password" data-c="pass" value="" placeholder="${hasPass ? "сохранён — оставьте пустым" : "пароль"}" autocomplete="new-password"></label>
      ${c.kind === "qbittorrent" ? `<label class="ny-fld"><span>Категория (необязательно)</span><input type="text" data-c="category" value="${esc(c.category)}"></label><label class="ny-fld"><span>Теги (через запятую)</span><input type="text" data-c="tags" value="${esc(c.tags)}"></label>` : ""}
      <label class="ny-chk wide-row"><input type="checkbox" data-c="paused" ${c.paused ? "checked" : ""}> Добавлять на паузе</label>
    </div>
    <div class="ny-f-presets"><button type="button" class="btn" data-client-test>Проверить</button><button type="button" class="btn primary" data-client-save>Сохранить</button>${client ? `<button type="button" class="btn ghost" data-client-clear>Забыть клиент</button>` : ""}<span class="ny-client-msg" id="ny-client-msg">${esc(msg)}</span></div>`;
}

function readClientForm() {
  const g = k => document.querySelector(`#ny-client [data-c="${k}"]`);
  return {
    kind: g("kind").value, url: g("url").value.trim(), user: g("user").value.trim(), pass: g("pass").value,
    category: g("category") ? g("category").value.trim() : "", tags: g("tags") ? g("tags").value.trim() : "",
    paused: g("paused").checked,
  };
}

function paintClient(msg = "") {
  const box = $("#ny-client");
  if (!box || box.hidden) return;
  box.innerHTML = clientHtml(msg);
}

function openPanel(id) {
  ["ny-sources", "ny-client", "ny-monitors"].forEach(x => { const el = $(`#${x}`); if (el) el.hidden = x !== id; });
  const box = $(`#${id}`);
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function sendToClient(list) {
  if (!client) { openPanel("ny-client"); clientDraft = null; paintClient("Сначала настройте клиент."); toast("Сначала настройте торрент-клиент."); return; }
  const magnets = list.map(magnetLink).filter(Boolean);
  if (!magnets.length) { toast("У раздачи нет magnet-ссылки.", "error"); return; }
  try {
    const n = await invoke("tc_add", { magnets });
    list.forEach(i => touch(i.id));
    markSent(list); paintList();
    toast(`Отправлено в ${CLIENT_NAMES[client.kind]}: ${n}.`, "success");
  } catch (e) { toast(`Не удалось отправить: ${e}`, "error"); }
}

// ---------- слежение ----------
const MON_EVERY_MS = 30 * 60 * 1000;
let monitorsBusy = false;

function newTotal() { return prefs.monitors.reduce((s, m) => s + (m.new || 0), 0); }

function paintMonitorBadge() {
  const b = $("#ny-mon-n");
  if (!b) return;
  const n = newTotal();
  b.textContent = n ? String(n) : "";
}

function monitorsHtml() {
  const cats = CATEGORIES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  return `
    <div class="ny-src-head"><div><b>Слежение</b><span>Программа раз в 30 минут (пока открыта) проверяет запросы и загрузчиков и сообщает о новых раздачах.</span></div>
      <div><button type="button" class="btn" data-mon-check>${monitorsBusy ? "Проверяю…" : "Проверить сейчас"}</button><button type="button" class="ny-ib wide" data-close-panel title="Закрыть" aria-label="Закрыть">${ICONS.close}</button></div></div>
    <div class="ny-mons">${prefs.monitors.length ? prefs.monitors.map(m => `
      <div class="ny-mon${m.new ? " has-new" : ""}">
        <label class="ny-chk"><input type="checkbox" data-mon-toggle="${esc(m.id)}" ${m.on ? "checked" : ""}></label>
        <div class="ny-mon-t"><b>${esc(monitorTitle(m))}</b><span>${m.type === "user" ? "загрузчик" : esc((CATEGORIES.find(c => c[0] === m.cat) || [0, m.cat])[1])}${m.rule ? ` · ${esc(ruleText(m.rule))}` : ""}${m.new ? ` · новых: ${m.new}` : ""}</span></div>
        <button type="button" class="btn ghost" data-mon-open="${esc(m.id)}">Открыть</button>
        <button type="button" class="ny-ib" data-mon-del="${esc(m.id)}" title="Убрать" aria-label="Убрать">${ICONS.close}</button>
      </div>`).join("") : `<div class="wt-empty">Пока ничего не отслеживается.</div>`}</div>
    <div class="ny-mon-add">
      <select id="ny-mon-type"><option value="query">Запрос</option><option value="user">Загрузчик</option></select>
      <input type="text" id="ny-mon-q" placeholder="слова запроса или имя загрузчика" spellcheck="false">
      <select id="ny-mon-cat">${cats}</select>
      <button type="button" class="btn primary" data-mon-add>Добавить</button>
    </div>
    <div class="ny-mon-rule"><b>Правило (по желанию)</b>
      <input type="text" id="ny-mon-groups" placeholder="группы по приоритету: Erai-raws, VARYG" spellcheck="false">
      <select id="ny-mon-res"><option value="">любое качество</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="2160p">2160p</option></select>
      <label><input type="checkbox" id="ny-mon-nohevc"> не HEVC</label>
      <label><input type="checkbox" id="ny-mon-auto"> сразу в торрент-клиент</label>
      <span class="ny-hint">С правилом уведомление приходит только о подходящих раздачах, по одной лучшей на серию — без дублей разных кодеков.</span></div>`;
}

function paintMonitors() {
  const box = $("#ny-monitors");
  paintMonitorBadge();
  if (!box || box.hidden) return;
  box.innerHTML = monitorsHtml();
}

async function checkMonitor(m, quiet) {
  const xml = await nyaaRss({
    base: prefs.base, query: m.type === "query" ? m.q : "", category: m.cat, filter: "0", page: 1, user: m.type === "user" ? m.q : null,
  });
  const { fresh: raw, seen: nextSeen } = diffMonitor(parseNyaaRss(xml), m);
  m.seen = nextSeen;
  const fresh = freshForRule(raw, m);
  if (fresh.length) {
    m.new = (m.new || 0) + fresh.length;
    if (m.rule) m.got = [...new Set([...(m.got || []), ...fresh.map(episodeKey).filter(Boolean)])].slice(-300);
    if (m.rule && m.rule.auto && client && !quiet) {
      try { await invoke("tc_add", { magnets: fresh.map(magnetLink).filter(Boolean) }); markSent(fresh); fresh.forEach(i => touch(i.id)); } catch (_) { /* уведомление ниже скажет о новом */ }
    }
    if (!quiet) {
      const text = `${monitorTitle(m)}: ${fresh[0].title}${fresh.length > 1 ? ` и ещё ${fresh.length - 1}` : ""}`;
      toast(`Новое на Nyaa — ${text}`, "success");
      notifyDesktop("Новое на Nyaa", text);
    }
  }
}

async function checkMonitors(manual = false) {
  if (monitorsBusy || !prefs.monitors.some(m => m.on)) { if (manual) toast("Нечего проверять."); return; }
  monitorsBusy = true; paintMonitors();
  let failed = 0;
  for (const m of prefs.monitors.filter(x => x.on)) {
    try { await checkMonitor(m, false); } catch (_) { failed++; }
  }
  savePrefs();
  monitorsBusy = false; paintMonitors();
  if (manual) toast(failed ? `Не удалось проверить: ${failed}` : "Проверка завершена.", failed ? "error" : "success");
}

async function addMonitor({ type, q, cat, rule = null }) {
  const m = makeMonitor({ type, q, cat: cat || prefs.cat, rule });
  if (!m) { toast(type === "user" ? "Имя загрузчика: латинские буквы, цифры, _ - ." : "Введите слова для слежения.", "error"); return; }
  if (prefs.monitors.some(x => x.type === m.type && x.q.toLowerCase() === m.q.toLowerCase() && x.cat === m.cat)) { toast("Такое слежение уже есть."); return; }
  prefs.monitors = [...prefs.monitors, m].slice(-12);
  savePrefs(); paintMonitors();
  try { await checkMonitor(m, true); savePrefs(); toast(`Слежу: ${monitorTitle(m)}.`, "success"); }
  catch (e) { toast(`Добавлено, но проверить не удалось: ${e}`, "error"); }
  paintMonitors();
}

function startMonitoring() {
  const tick = () => { if (state.token && state.isAdmin) checkMonitors(false); };
  setTimeout(tick, 25_000);
  setInterval(tick, MON_EVERY_MS);
}
startMonitoring();

// Фоновое обновление ленты: раз в 5 минут, если страница открыта, ничего не грузится и поиск не набирается.
setInterval(() => {
  if (!$("#ny-list") || loading || moreBusy || document.hidden || detail) return;
  const q = $("#ny-q");
  if (q && document.activeElement === q) return;
  load();
}, 5 * 60 * 1000);

// ---------- выбор соединения для каждого сервиса ----------
// auto — сначала этот компьютер, если связи нет — сервер (WireGuard); pc — только этот компьютер;
// server — всегда через сервер студии.
const ROUTES = [["auto", "Авто"], ["pc", "Мой компьютер"], ["server", "Сервер (WireGuard)"]];
const routeOf = id => (prefs.route && ["pc", "server"].includes(prefs.route[id])) ? prefs.route[id] : "auto";
const serviceOfUrl = url => {
  const h = hostOf(url);
  const sv = buildServices(prefs.custom, serverOrigin()).find(s => s.mirrors.some(m => hostOf(m) === h));
  return sv ? sv.id : "";
};
// сам сервер студии проверяется только отсюда: его адрес для проверки «с сервера» недопустим (свой порт)
const routeOfUrl = url => { const id = serviceOfUrl(url); return id === "server" ? "pc" : routeOf(id); };

// Результат проверки по выбранному соединению сервиса.
function applyChecks() {
  new Set([...Object.keys(serverChecks), ...Object.keys(localChecks)]).forEach(u => {
    const mode = routeOfUrl(u);
    const r = mode === "pc" ? localChecks[u] : mode === "server" ? serverChecks[u] : (serverChecks[u] || localChecks[u]);
    if (r) checks[u] = r;
  });
}

// ---------- источники и зеркала ----------
function sourcesHtml() {
  const services = buildServices(prefs.custom, serverOrigin());
  return `
    <div class="ny-src-head"><div><b>Источники и зеркала</b><span>Для каждого сервиса выберите, как подключаться: с этого компьютера или через сервер студии (WireGuard). По этому выбору идёт и проверка, и сами запросы.</span></div>
      <div><button type="button" class="btn primary" id="ny-check-all">${checking ? "Проверяю…" : "Проверить всё"}</button><button type="button" class="ny-ib wide" data-close-sources title="Закрыть" aria-label="Закрыть">${ICONS.close}</button></div></div>
    <div class="ny-src-grid">${services.map(sv => `
      <div class="ny-svc">
        <div class="ny-svc-h"><b>${esc(sv.name)}</b><span>${esc(sv.note)}</span></div>
        ${sv.id === "server" ? "" : `<div class="ny-route" role="group" aria-label="Соединение">${ROUTES.map(([k, t]) => `<button type="button" class="${routeOf(sv.id) === k ? "on" : ""}" data-route="${sv.id}:${k}">${t}</button>`).join("")}</div>`}
        ${sv.mirrors.map(m => {
          const c = classifyCheck(checks[m]);
          const active = sv.apply && m === prefs.base;
          const custom = sv.id === "nyaa" && prefs.custom.includes(m);
          return `<div class="ny-mir${active ? " act" : ""}"><i class="${c.level}"></i><div><b>${esc(hostOf(m))}</b><span>${esc(c.text)}${closedHere(m) ? " · у вас напрямую закрыт" : ""}</span></div>
            ${sv.apply ? (active ? `<em>используется</em>` : `<button type="button" class="btn ghost" data-use="${esc(m)}">Использовать</button>`) : ""}
            ${custom ? `<button type="button" class="ny-ib" data-mir-del="${esc(m)}" title="Убрать зеркало" aria-label="Убрать зеркало">${ICONS.close}</button>` : ""}
            <button type="button" class="ny-ib" data-check="${esc(m)}" title="Проверить" aria-label="Проверить">${ICONS.refresh}</button></div>`;
        }).join("")}
        ${sv.id === "nyaa" ? fastHint(sv.mirrors) : ""}
        ${sv.id === "nyaa" ? `<div class="ny-mir-add"><input id="ny-mir-in" type="text" placeholder="Своё зеркало, например nyaa.example" spellcheck="false"><button type="button" class="btn" id="ny-mir-add">Добавить</button></div>` : ""}
        ${!sv.apply && sv.id !== "server" ? `<p class="ny-hint">Режим «Смотреть» всегда берёт эти данные через сервер студии; выбор влияет на проверку и на запросы из «Релизов».</p>` : ""}
      </div>`).join("")}</div>`;
}

// Подсказка «есть быстрее / текущее не отвечает» по результатам проверки.
function fastHint(mirrors) {
  const fast = fastestMirror(mirrors, checks);
  const cur = checks[prefs.base];
  if (!fast || fast === prefs.base) return "";
  const curBad = cur && (cur.error || !cur.ok || cur.status >= 400);
  if (!curBad && !(cur && cur.ms > checks[fast].ms * 1.6 + 100)) return "";
  return `<div class="ny-fast">${curBad ? "Текущее зеркало не отвечает." : "Есть быстрее."} <b>${esc(hostOf(fast))}</b> · ${checks[fast].ms} мс <button type="button" class="btn" data-use="${esc(fast)}">Переключиться</button></div>`;
}

function paintSources() {
  const box = $("#ny-sources");
  if (!box || box.hidden) return;
  box.innerHTML = sourcesHtml();
  paintSourceChip();
}

// Главная проверка идёт с сервера студии: «Релизы» и «Смотреть» ходят через него (у него туннель
// WireGuard), так что важно, виден ли сайт ему. Параллельно проверяется и этот компьютер — только
// для пометки «у вас закрыт». Если сервер недоступен, остаётся проверка с компьютера.
async function runChecks(urls) {
  checking = true; paintSources();
  const q = new URLSearchParams(); urls.forEach(u => q.append("u", u));
  const [srv, loc] = await Promise.allSettled([
    apiBlob(`/net/check?${q}`).then(b => b.text()).then(JSON.parse),
    invoke("net_check", { urls }),
  ]);
  if (loc.status === "fulfilled") loc.value.forEach(r => { localChecks[r.url] = r; });
  if (srv.status === "fulfilled" && Array.isArray(srv.value)) srv.value.forEach(r => { serverChecks[r.url] = r; });
  else urls.forEach(u => {
    if (routeOfUrl(u) === "server") serverChecks[u] = { url: u, ok: false, status: 0, ms: 0, error: "сервер студии недоступен" };
  });
  if (srv.status !== "fulfilled" && loc.status !== "fulfilled") toast(`Проверка не удалась: ${loc.reason}`, "error");
  applyChecks();
  checking = false; paintSources();
}

// «У вас закрыт»: серверу сайт виден, а с этого компьютера — нет.
const closedHere = m => {
  const s = serverChecks[m], l = localChecks[m];
  return routeOfUrl(m) !== "pc" && s && s.ok && l && (l.error || !l.ok);
};

function allMirrorUrls() {
  return buildServices(prefs.custom, serverOrigin()).flatMap(s => s.mirrors);
}

function openSources() {
  const box = $("#ny-sources");
  box.hidden = false; paintSources();
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  runChecks(allMirrorUrls());
}

// ---------- страница раздачи ----------
async function openDetail(it) {
  touch(it.id);
  detail = { item: it, state: "loading", view: null, err: "", tab: "desc", imgs: {}, lightbox: null };
  paintDrawer();
  try {
    detail.view = parseView(await nyaaView({ base: prefs.base, id: it.id }));
    detail.state = "ok";
  } catch (e) {
    detail.state = "error"; detail.err = String(e && e.message ? e.message : e);
  }
  if (!detail || detail.item !== it) return;
  paintDrawer();
  if (detail.state === "ok") loadImages(detail);
}

async function loadImages(d) {
  const urls = d.view.images.slice();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try { d.imgs[url] = await invoke("fetch_image", { url }); }
      catch (_) { d.imgs[url] = "err"; }
      if (detail === d) paintGallery();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function fieldRows(it, v) {
  const f = v ? v.fields : {};
  const rows = [
    ["Категория", f.category || it.category],
    ["Дата", v && v.date ? fmtDate(v.date) : fmtDate(it.date)],
    ["Размер", f["file size"] || it.size],
    ["Раздают", f.seeders || it.seeders],
    ["Качают", f.leechers || it.leechers],
    ["Скачали", f.completed || it.downloads],
    ["Загрузил", f.submitter || ""],
    ["Информация", f.information || ""],
  ];
  return rows.filter(r => r[1] !== "" && r[1] != null);
}

function galleryHtml(d) {
  const imgs = d.view.images;
  if (!imgs.length) return "";
  return `<div class="ny-gal" id="ny-gal">${imgs.map((u, i) => {
    const s = d.imgs[u];
    if (!s) return `<div class="ny-img sk" data-i="${i}"></div>`;
    if (s === "err") return `<button type="button" class="ny-img bad" data-img-open="${esc(u)}" title="Открыть в браузере">картинка не загрузилась ↗</button>`;
    return `<button type="button" class="ny-img" data-lb="${i}"><img src="${esc(s)}" alt="Картинка из описания"></button>`;
  }).join("")}</div>`;
}

// ---------- внешние источники (SeaDex, AnimeTosho, nekoBT, Tsukihime) ----------
// Сначала напрямую с этого компьютера; если сайт не отвечает (закрыт у провайдера) —
// через сервер студии (/api/meta/relay), у которого другая сеть. Ответ «404» от сайта —
// это «в базе нет», а не поломка, поэтому дальше он не пробуется.
const isNotFound = e => /ответил 404/.test(String(e && e.message ? e.message : e));
const isNoConnection = e => /Не удалось загрузить|error sending request|timed out|connect/i.test(String(e && e.message ? e.message : e));

async function metaGet(url) {
  const mode = routeOf("sources");
  const viaRelay = async () => {
    const wrapped = JSON.parse(await (await apiBlob(`/meta/relay?url=${encodeURIComponent(url)}`)).text());
    if (wrapped.status === 404) throw new Error("Сайт ответил 404");
    if (wrapped.status !== 200) throw new Error(`Сайт ответил ${wrapped.status}`);
    return String(wrapped.body || "");
  };
  if (mode === "server") return viaRelay();
  try { return await invoke("meta_get", { url }); }
  catch (e) {
    if (mode === "pc" || isNotFound(e) || !isNoConnection(e)) throw e;
    let wrapped;
    try { wrapped = JSON.parse(await (await apiBlob(`/meta/relay?url=${encodeURIComponent(url)}`)).text()); }
    catch (_) { throw e; }                      // на сервере ручки нет или он недоступен — показываем исходную ошибку
    if (wrapped.status === 404) throw new Error("Сайт ответил 404");
    if (wrapped.status !== 200) throw new Error(`Сайт ответил ${wrapped.status}`);
    return String(wrapped.body || "");
  }
}

// ---------- Nyaa напрямую или через сервер студии ----------
// Nyaa закрыт у части провайдеров и стран. У сервера есть туннель WireGuard, через который
// он Nyaa видит, поэтому при отсутствии связи с компьютера запрос уходит на сервер
// (/api/nyaa/relay) — это работает для всех участников, без VPN у каждого.
let viaServer = false;

async function relayJson(params) {
  const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v != null)));
  return JSON.parse(await (await apiBlob(`/nyaa/relay?${q}`)).text());
}

async function nyaaDirectOrRelay(direct, relayParams, pick) {
  const mode = routeOf("nyaa");
  if (mode === "server") {
    const w = await relayJson(relayParams);
    if (w.status !== 200) throw new Error(`Сайт ответил ${w.status}`);
    viaServer = true; paintSourceChip();
    return pick(w);
  }
  try { return await direct(); }
  catch (e) {
    if (mode === "pc" || isNotFound(e) || !isNoConnection(e)) throw e;
    let w;
    try { w = await relayJson(relayParams); } catch (_) { throw e; }   // ручки нет / сервер недоступен — исходная ошибка
    if (w.status !== 200) throw new Error(`Сайт ответил ${w.status}`);
    viaServer = true; paintSourceChip();
    return pick(w);
  }
}

const nyaaRss = a => nyaaDirectOrRelay(() => invoke("nyaa_rss", a),
  { kind: "rss", base: a.base, q: a.query, c: a.category, f: a.filter, p: a.page || 1, u: a.user || "" }, w => String(w.body || ""));
const nyaaView = a => nyaaDirectOrRelay(() => invoke("nyaa_view", a),
  { kind: "view", base: a.base, id: a.id }, w => String(w.body || ""));

async function nyaaSaveTorrent(base, id, path) {
  const mode = routeOf("nyaa");
  const viaRelay = async rethrow => {
    let w;
    try { w = await relayJson({ kind: "torrent", base, id }); } catch (_) { if (rethrow) throw rethrow; throw _; }
    if (w.status !== 200) throw new Error(`Сайт ответил ${w.status}`);
    const bin = atob(w.b64 || "");
    await invoke("write_bytes_file", { path, bytes: Array.from(bin, ch => ch.charCodeAt(0)) });
    viaServer = true; paintSourceChip();
  };
  if (mode === "server") return viaRelay();
  try { return await invoke("nyaa_save_torrent", { base, id, path }); }
  catch (e) {
    if (mode === "pc" || !isNoConnection(e)) throw e;
    return viaRelay(e);
  }
}

// Понятное объяснение вместо технического текста ошибки.
function friendlyError(e) {
  const m = String(e && e.message ? e.message : e);
  if (/401|403|Cloudflare|forbidden/i.test(m)) return `Сайт не пускает приложение (${m.slice(0, 80)}). Попробуйте другое зеркало.`;
  if (/ответил 5\d\d|50[0-4]/.test(m)) return "Сайт сейчас перегружен или чинится. Подождите минуту и нажмите «Повторить».";
  if (isNoConnection({ message: m })) {
    const mode = routeOf("nyaa");
    return mode === "pc" ? "Нет связи с сайтом напрямую. В «Источниках» переключите Nyaa на «Авто» или «Сервер (WireGuard)»."
      : mode === "server" ? "Сервер студии тоже не достучался до сайта. Попробуйте другое зеркало."
      : "Нет связи ни напрямую, ни через сервер студии. Попробуйте другое зеркало в «Источниках».";
  }
  return m.slice(0, 160);
}

const shortErr = e => {
  const m = String(e && e.message ? e.message : e);
  return isNoConnection({ message: m }) ? "нет связи с сайтом" : m.slice(0, 120);
};
const SRC_NAMES = { seadex: "SeaDex", at: "AnimeTosho", neko: "nekoBT", tsuki: "Tsukihime" };

function hashOf(d) { return ((d.view && d.view.fields["info hash"]) || d.item.hash || "").toLowerCase(); }

async function loadSources(d) {
  if (d.src) return;
  const hash = hashOf(d);
  d.src = { seadex: { s: "loading" }, at: { s: "loading" }, neko: { s: "loading" }, tsuki: { s: "loading" } };
  const set = (k, v) => { d.src[k] = v; if (detail === d && d.tab === "src") $("#ny-d-body").innerHTML = drawerBodyHtml(d); };
  if (!isHash40(hash)) { Object.keys(d.src).forEach(k => { d.src[k] = { s: "none" }; }); return; }
  const u = sourceUrls(hash);
  const fail = e => (isNotFound(e) ? { s: "none" } : { s: "err", err: shortErr(e), full: String(e && e.message ? e.message : e) });
  const task = async (k, fn) => { try { set(k, await fn()); } catch (e) { set(k, fail(e)); } };
  task("seadex", async () => {
    const [a, b] = await Promise.allSettled([metaGet(u.seadexTorrent), metaGet(u.seadexEntry)]);
    if (a.status === "rejected" && b.status === "rejected") throw a.reason;
    const r = parseSeadex(a.status === "fulfilled" ? a.value : "", b.status === "fulfilled" ? b.value : "");
    return r.found ? { s: "ok", ...r } : { s: "none" };
  });
  task("at", async () => { const r = parseAnimetosho(await metaGet(u.animetosho)); return r.found ? { s: "ok", ...r } : { s: "none" }; });
  task("neko", async () => {
    const id = parseNekoSearch(await metaGet(u.nekobtSearch));
    if (!id) return { s: "none" };
    const r = parseNekoTorrent(await metaGet(`https://nekobt.to/api/v1/torrents/${encodeURIComponent(id)}`));
    return r.found ? { s: "ok", ...r } : { s: "none" };
  });
  task("tsuki", async () => { const r = parseTsukihime(await metaGet(u.tsukihime)); return r.found ? { s: "ok", ...r } : { s: "none" }; });
}

// ---------- AnimeTosho: субтитры и кадры ----------
const DATA_SHOT = b64 => `data:image/png;base64,${b64}`;
async function toshoRelay(params) {
  const q = new URLSearchParams(params);
  try { return JSON.parse(await (await apiBlob(`/tosho/relay?${q}`)).text()); }
  catch (e) { throw new Error(/404|Not Found/i.test(String(e && e.message ? e.message : e)) ? "Нужно обновить сервер студии (нет ручки AnimeTosho)." : shortErr(e)); }
}

async function loadTosho(d) {
  if (d.tosho) return;
  d.tosho = { state: "loading", files: [], shots: {}, sub: null };
  const paint = () => { if (detail === d && d.tab === "tosho") $("#ny-d-body").innerHTML = drawerBodyHtml(d); };
  const hash = hashOf(d);
  if (!isHash40(hash)) { d.tosho.state = "none"; paint(); return; }
  // Tsukihime даёт точные номера тайтла (ссылки) и MediaInfo файла; не мешает AnimeTosho, если недоступен.
  metaGet(sourceUrls(hash).tsukihime).then(txt => {
    const r = parseTsukiFull(txt);
    if (!r.found) return;
    d.tosho.tsuki = r; d.exact = exactLinks(r.ids);
    if (detail === d) paintDrawer();
  }).catch(() => {});
  try {
    const r = parseToshoTorrent(await metaGet(sourceUrls(hash).animetosho));
    d.tosho.files = r.files; d.tosho.state = r.found ? "ok" : "none";
    if (r.found) d.tosho.track = defaultShotTrack(r.files[0].subs);
  } catch (e) { d.tosho.state = isNotFound(e) ? "none" : "err"; d.tosho.err = shortErr(e); }
  paint();
  if (d.tosho.state === "ok") loadShots(d, paint);
}

async function loadMediainfo(d) {
  const t = d.tosho;
  if (!t || !t.tsuki || !t.tsuki.files.length || t.info) return;
  const f = t.tsuki.files[0];
  t.info = { state: "loading", text: "" };
  $("#ny-d-body").innerHTML = drawerBodyHtml(d);
  try {
    t.info.text = parseMediainfo(await metaGet(`https://api.tsukihime.org/v1/torrents/${t.tsuki.tid}/file/${f.id}`));
    t.info.state = t.info.text ? "ok" : "none";
  } catch (e) { t.info.state = "err"; t.info.err = shortErr(e); }
  if (detail === d && d.tab === "tosho") $("#ny-d-body").innerHTML = drawerBodyHtml(d);
}

async function loadShots(d, paint) {
  const f = d.tosho.files[0];
  if (!f || !f.id) return;
  const stamps = f.shots.slice(0, 6);
  const track = d.tosho.track || 0;
  d.tosho.shots = {}; d.tosho.shotErr = "";
  let next = 0;
  const worker = async () => {
    while (next < stamps.length) {
      const ts = stamps[next++];
      try {
        const w = await toshoRelay({ kind: "shot", fid: f.id, ts, s: track });
        if (d.tosho.track !== track) return;
        if (w.status === 200 && w.b64) d.tosho.shots[ts] = DATA_SHOT(w.b64);
      } catch (e) { d.tosho.shotErr = String(e.message || e); }
      paint();
    }
  };
  await Promise.all([worker(), worker()]);
}

async function openSubtitle(d, subId) {
  const file = d.tosho.files.find(f => f.subs.some(s => s.id === subId));
  const sub = file && file.subs.find(s => s.id === subId);
  if (!sub) return;
  d.tosho.sub = { id: subId, sub, state: "loading", lines: [], raw: "", q: "" };
  $("#ny-d-body").innerHTML = drawerBodyHtml(d);
  try {
    const w = await toshoRelay({ kind: "sub", aid: subId });
    if (w.status !== 200) throw new Error(`Сайт ответил ${w.status}`);
    d.tosho.sub.raw = String(w.body || "");
    d.tosho.sub.lines = parseSubtitle(d.tosho.sub.raw, sub.codec);
    d.tosho.sub.state = "ok";
  } catch (e) { d.tosho.sub.state = "err"; d.tosho.sub.err = String(e.message || e); }
  if (detail === d && d.tab === "tosho") $("#ny-d-body").innerHTML = drawerBodyHtml(d);
}

async function saveSubtitle(d) {
  const s = d.tosho && d.tosho.sub;
  if (!s || s.state !== "ok") return;
  const ext = (s.sub.codec || "srt").toLowerCase();
  const out = await pickOutputFile(`${(d.item.title || "subtitle").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.${s.sub.lang}.${ext}`, [{ name: "Субтитры", extensions: [ext] }]);
  if (!out) return;
  try { await invoke("write_text_file", { path: out, content: s.raw }); toast("Субтитры сохранены.", "success"); }
  catch (e) { toast(`Не удалось сохранить: ${e}`, "error"); }
}

function toshoTabHtml(d) {
  if (!d.tosho) setTimeout(() => loadTosho(d), 0);
  const t = d.tosho || { state: "loading" };
  if (t.state === "loading") return `<div class="ny-d-load"><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div>`;
  if (t.state === "err") return `<div class="ny-empty"><b>AnimeTosho не отвечает</b><p>${esc(t.err || "")}</p></div>`;
  if (t.state === "none") return `<div class="ny-empty"><b>Этой раздачи нет на AnimeTosho</b><p>Субтитры и кадры берутся оттуда, если сайт успел разобрать файл.</p></div>`;
  const f0 = t.files[0];
  const burn = f0.subs.filter(s => s.num);
  const trackSel = burn.length ? `<div class="ny-shot-track"><span>Субтитры на кадрах:</span><select id="ny-shot-track"><option value="0">без субтитров</option>${burn.map(s => `<option value="${s.num}"${t.track === s.num ? " selected" : ""}>Дорожка ${s.num} · ${esc(s.lang)} · ${esc(s.codec || "—")}${s.forced ? " · форсированные" : ""}</option>`).join("")}</select></div>` : "";
  const shots = trackSel + (Object.keys(t.shots).length || f0.shots.length
    ? `<div class="ny-shots">${f0.shots.slice(0, 6).map(ts => t.shots[ts] ? `<button type="button" class="ny-shot" data-shot="${ts}"><img src="${esc(t.shots[ts])}" alt="Кадр"></button>` : `<div class="ny-shot sk"></div>`).join("")}</div>${t.shotErr ? `<p class="ny-hint">${esc(t.shotErr)}</p>` : ""}`
    : `<p class="ny-hint">Кадров у файла нет.</p>`);
  const LANG_OK = ["en", "eng", "enm", "und"];
  const only = prefs.subLangs !== false;
  const subs = `<label class="ny-sub-filter"><input type="checkbox" data-sub-langs ${only ? "checked" : ""}> только английские и без языка</label>` + t.files.slice(0, 6).map(f => `<div class="ny-tosho-file"><b>${esc(f.name)}</b><span>${esc(fmtBytes(f.size))}${f.fonts ? ` · шрифтов: ${f.fonts}` : ""}</span>
    ${f.subs.length ? f.subs.filter(s => !only || LANG_OK.includes(s.lang.toLowerCase())).map(s => `<div class="ny-sub-row"><span class="ny-sub-lang">${esc(s.lang)}</span><span>${esc(s.codec || "—")}${s.def ? " · по умолчанию" : ""}${s.forced ? " · форсированные" : ""} · ${esc(fmtBytes(s.size))}</span><button type="button" class="btn ghost" data-sub-open="${s.id}">Смотреть</button></div>`).join("") || `<span class="ny-hint">Нет дорожек под фильтр языка.</span>` : `<span class="ny-hint">Дорожек субтитров нет.</span>`}</div>`).join("");
  const sv = t.sub;
  const viewer = !sv ? "" : sv.state === "loading" ? `<div class="ny-d-load"><div class="ny-sk w80"></div></div>`
    : sv.state === "err" ? `<p class="ny-hint">${esc(sv.err)}</p>`
    : `<div class="ny-sub-view"><div class="ny-sub-bar"><input type="text" id="ny-sub-q" placeholder="Найти в субтитрах" value="${esc(sv.q)}" spellcheck="false"><button type="button" class="btn" data-sub-find>Найти</button><button type="button" class="btn ghost" data-sub-raw>${sv.raw_on ? "Реплики" : "Исходный текст"}</button><button type="button" class="btn ghost" data-sub-save>Сохранить файл</button><button type="button" class="ny-ib" data-sub-close aria-label="Закрыть">${ICONS.close}</button></div>
      ${sv.raw_on ? `<pre class="ny-sub-raw">${highlightSubtitle(sv.raw)}</pre>` : `<div class="ny-sub-lines">${(sv.q ? sv.lines.filter(l => l.text.toLowerCase().includes(sv.q.toLowerCase())) : sv.lines).slice(0, 600).map(l => `<div><time>${esc(l.clock)}</time><span>${esc(l.text)}</span></div>`).join("") || `<p class="ny-hint">Ничего не найдено.</p>`}</div>`}
      <p class="ny-hint">Реплик: ${sv.lines.length}${sv.lines.length > 600 && !sv.q ? " (показаны первые 600)" : ""}</p></div>`;
  const info = !t.tsuki || !t.tsuki.files.length ? "" : !t.info ? `<button type="button" class="btn ghost" data-fileinfo>Показать FileInfo (MediaInfo)</button>`
    : t.info.state === "loading" ? `<div class="ny-d-load"><div class="ny-sk w80"></div></div>`
    : t.info.state === "ok" ? `<pre class="ny-fileinfo">${esc(t.info.text)}</pre>` : `<p class="ny-hint">${esc(t.info.err || "MediaInfo недоступен.")}</p>`;
  return `<h4 class="ny-sec">Кадры</h4>${shots}<h4 class="ny-sec">Субтитры и вложения</h4>${subs}${viewer}${info ? `<h4 class="ny-sec">FileInfo</h4>${info}` : ""}`;
}

function srcLines(k, r) {
  const L = [];
  const add = (label, v) => { if (v) L.push(`<div><span>${esc(label)}</span><b>${esc(String(v))}</b></div>`); };
  if (k === "seadex") add("Оценка", r.best === true ? "лучший релиз" : r.best === false ? "запасной вариант" : "есть в базе");
  if (k === "at") { add("Название", r.title); add("Файлов", r.files || ""); }
  if (k === "neko") { add("Название", r.title); add("Загрузил", r.uploader); add("Группа", r.group); add("Раздача", r.swarm); add("Размер", r.size); add("Звук", r.audio); add("Субтитры", r.subs); add("Метки", (r.flags || []).join(", ")); }
  if (k === "tsuki") { add("Название", r.title); add("Тайтл", r.anime); add("Группа", r.group); add("Серия", r.episode); add("Размер", r.size); add("Файлов", r.files); add("Звук", r.audio); add("Субтитры", r.subs); }
  return L.join("");
}

function sourcesTabHtml(d) {
  loadSources(d);
  const src = d.src || {};
  return `<div class="ny-srcs">${Object.keys(SRC_NAMES).map(k => {
    const r = src[k] || { s: "loading" };
    const badge = r.s === "loading" ? `<em class="load">проверяю…</em>` : r.s === "ok" ? `<em class="ok">${k === "seadex" ? (r.best === true ? "лучший" : r.best === false ? "запасной" : "найдено") : "найдено"}</em>` : r.s === "none" ? `<em>нет в базе</em>` : `<em class="bad" title="${esc(r.full || r.err || "")}">недоступен</em>`;
    return `<div class="ny-src-card"><div class="ny-src-top"><b>${SRC_NAMES[k]}</b>${badge}</div>
      ${r.s === "ok" ? `<div class="ny-src-lines">${srcLines(k, r)}</div>${r.link ? `<button type="button" class="btn ghost" data-ext="${esc(r.link)}">${ICONS.open} Открыть</button>` : ""}` : r.s === "err" ? `<p class="ny-hint">${esc(r.err)}. Возможно, сайт закрыт у вашего провайдера: включите VPN (WireGuard) и откройте вкладку заново.</p>` : ""}
    </div>`;
  }).join("")}</div>
  <p class="ny-hint">Данные запрашиваются по info hash раздачи и только когда вы открыли эту вкладку.</p>`;
}

// ---------- «Похожее» (AniList) ----------
async function loadSimilar(d, text) {
  d.sim = { q: text, state: "loading", data: null, covers: {}, err: "" };
  if ($("#ny-d-body") && d.tab === "sim") $("#ny-d-body").innerHTML = drawerBodyHtml(d);
  try {
    const raw = await invoke("anilist_query", { query: SIMILAR_QUERY, variables: { s: text } });
    d.sim.data = parseSimilar(raw);
    d.sim.state = d.sim.data.found ? "ok" : "none";
  } catch (e) { d.sim.state = "err"; d.sim.err = String(e && e.message ? e.message : e); }
  if (detail === d && d.tab === "sim") $("#ny-d-body").innerHTML = drawerBodyHtml(d);
  if (d.sim.state === "ok") loadCovers(d);
}

async function loadCovers(d) {
  const all = [d.sim.data.self, ...d.sim.data.related, ...d.sim.data.recs].filter(Boolean).map(m => m.cover).filter(Boolean);
  const urls = [...new Set(all)].slice(0, 16);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try { d.sim.covers[url] = await invoke("fetch_image", { url }); } catch (_) { d.sim.covers[url] = "err"; }
      if (detail === d && d.tab === "sim") paintSimCovers(d);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function paintSimCovers(d) {
  document.querySelectorAll("#ny-d-body [data-cover]").forEach(el => {
    const src = d.sim.covers[el.dataset.cover];
    if (src && src !== "err" && !el.querySelector("img")) el.innerHTML = `<img src="${esc(src)}" alt="">`;
  });
}

function simCard(m, extra = "") {
  return `<div class="ny-sim-card"><button type="button" class="ny-sim-cover" data-cover="${esc(m.cover)}" data-ext="${esc(m.url)}" title="Открыть на AniList"></button>
    <div><b>${esc(m.title || m.romaji)}</b><span>${esc([extra, m.format, m.score ? `★ ${(m.score / 10).toFixed(1)}` : ""].filter(Boolean).join(" · "))}</span>
    <button type="button" class="ny-link" data-sim-nyaa="${esc(m.romaji || m.title)}">искать на Nyaa</button></div></div>`;
}

function similarTabHtml(d) {
  if (!d.sim) setTimeout(() => loadSimilar(d, cleanTitleForSearch(d.view ? d.view.title : d.item.title)), 0);
  const sim = d.sim || { q: cleanTitleForSearch(d.view ? d.view.title : d.item.title), state: "loading" };
  const form = `<div class="ny-sim-form"><input type="text" id="ny-sim-q" value="${esc(sim.q)}" placeholder="Название тайтла" spellcheck="false"><button type="button" class="btn" data-sim-go>Найти</button></div>`;
  if (sim.state === "loading") return form + `<div class="ny-d-load"><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div>`;
  if (sim.state === "err") return form + `<div class="ny-empty"><p>${esc(sim.err)}</p></div>`;
  if (sim.state === "none") return form + `<div class="ny-empty"><b>Тайтл не нашёлся</b><p>Поправьте название в строке выше: латиницей часто находится лучше.</p></div>`;
  const data = sim.data;
  return form + `<div class="ny-sim-self">${simCard(data.self, data.year ? String(data.year) : "")}<div class="ny-tags">${data.genres.map(g => `<i>${esc(g)}</i>`).join("")}</div></div>`
    + (data.related.length ? `<h4 class="ny-sim-h">Связанное</h4><div class="ny-sim-grid">${data.related.map(m => simCard(m, m.relation)).join("")}</div>` : "")
    + (data.recs.length ? `<h4 class="ny-sim-h">Рекомендуют</h4><div class="ny-sim-grid">${data.recs.map(m => simCard(m)).join("")}</div>` : "");
}

function uploaderOf(d) {
  const name = d.view && d.view.fields ? d.view.fields.submitter : "";
  return name && !/^anonymous$/i.test(name) && /^[A-Za-z0-9_.-]{1,40}$/.test(name) ? name : "";
}

function drawerBodyHtml(d) {
  const v = d.view;
  if (d.state === "loading") return `<div class="ny-d-load"><div class="ny-sk w80"></div><div class="ny-sk w40"></div><div class="ny-sk w80"></div></div>`;
  if (d.state === "error") return `<div class="ny-empty"><b>Страница не открылась</b><p>${esc(d.err)}</p><button type="button" class="btn primary" data-d-retry>Повторить</button></div>`;
  const tc = normalizeTabs(prefs.tabs);
  if (tc.hidden.includes(d.tab)) d.tab = "desc";
  const label = (id, l) => (id === "files" && v.files.length ? `${l} · ${v.files.length}` : l);
  const tabs = `<div class="ny-d-tabs">${tc.order.filter(id => !tc.hidden.includes(id)).map(id => `<button type="button" class="${d.tab === id ? "on" : ""}" data-d-tab="${id}">${esc(label(id, DETAIL_TABS.find(x => x[0] === id)[1]))}</button>`).join("")}<button type="button" class="ny-ib ny-tabs-cfg" data-tabs-cfg title="Какие вкладки показывать и в каком порядке" aria-label="Настроить вкладки">⚙</button></div>`
    + (d.tabsCfg ? `<div class="ny-tabs-pop">${tc.order.map((id, i) => `<div><label><input type="checkbox" data-tab-vis="${id}" ${tc.hidden.includes(id) ? "" : "checked"} ${id === "desc" ? "disabled" : ""}> ${esc(DETAIL_TABS.find(x => x[0] === id)[1])}</label><button type="button" class="ny-ib" data-tab-move="${id}:-1" ${i === 0 ? "disabled" : ""} aria-label="Выше">↑</button><button type="button" class="ny-ib" data-tab-move="${id}:1" ${i === tc.order.length - 1 ? "disabled" : ""} aria-label="Ниже">↓</button></div>`).join("")}</div>` : "");
  if (d.tab === "src") return tabs + sourcesTabHtml(d);
  if (d.tab === "tosho") return tabs + toshoTabHtml(d);
  if (d.tab === "sim") return tabs + similarTabHtml(d);
  if (d.tab === "files") {
    return tabs + (v.files.length ? `<ul class="ny-files">${v.files.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : `<div class="ny-empty"><p>Список файлов не указан.</p></div>`);
  }
  return tabs + galleryHtml(d)
    + (v.description ? `<div class="ny-desc">${esc(v.description).replace(/\n/g, "<br>")}</div>` : (v.images.length ? "" : `<div class="ny-empty"><p>У раздачи нет описания и картинок.</p></div>`));
}

function drawerHtml() {
  const d = detail, it = d.item;
  const v = d.view;
  const grid = fieldRows(it, v);
  const hash = (v && v.fields["info hash"]) || it.hash;
  return `
    <div class="ny-scrim" data-d-close></div>
    <aside class="ny-drawer" role="dialog" aria-label="Страница раздачи">
      <header class="ny-d-head">
        <div><span class="kd-label">Раздача №${it.id}</span><h3>${esc((v && v.title) || it.title)}</h3></div>
        <button type="button" class="ny-ib wide" data-d-close title="Закрыть (Esc)" aria-label="Закрыть">${ICONS.close}</button>
      </header>
      <div class="ny-d-acts">
        <button type="button" class="btn primary" data-d-a="mag">${ICONS.magnet} Magnet</button>
        <button type="button" class="btn" data-d-a="tor">${ICONS.torrent} Скачать .torrent</button>
        <button type="button" class="btn" data-d-a="cp">${ICONS.copy} Название</button>
        <button type="button" class="btn" data-d-a="send">${ICONS.send} В торрент-клиент</button>
        <button type="button" class="btn ghost" data-d-a="open">${ICONS.open} В браузере</button>
        ${uploaderOf(d) ? `<button type="button" class="btn ghost" data-d-a="watch">${ICONS.bell} Следить за ${esc(uploaderOf(d))}</button>` : ""}
      </div>
      <div class="ny-d-links">${((d.exact && d.exact.length ? d.exact : titleLinks((v && v.title) || it.title))).concat([{ label: "NekoBT", url: titleLinks(it.title).find(x => x.label === "NekoBT")?.url || "" }].filter(x => x.url && d.exact && d.exact.length)).map(l => `<button type="button" class="ny-link" data-ext="${esc(l.url)}">${esc(l.label)} ↗</button>`).join("")}</div>
      <div class="ny-d-grid">${grid.map(([k, val]) => `<div><span>${esc(k)}</span><b>${esc(String(val))}</b></div>`).join("")}
        ${hash ? `<div class="wide"><span>Info hash</span><b class="mono">${esc(hash)}</b></div>` : ""}</div>
      <div class="ny-d-body" id="ny-d-body">${drawerBodyHtml(d)}</div>
      ${d.lightbox != null || d.lbSrc ? lightboxHtml(d) : ""}
    </aside>`;
}

function lightboxHtml(d) {
  const url = d.lightbox != null ? d.view.images[d.lightbox] : "";
  const src = d.lbSrc || d.imgs[url];
  return `<div class="ny-lb" data-lb-close><img src="${esc(src)}" alt="Картинка"><button type="button" class="ny-ib wide" data-lb-close aria-label="Закрыть">${ICONS.close}</button></div>`;
}

// Страница раздачи монтируется прямо в body: во вкладке у предков бывают
// анимации с transform, из-за которых fixed считался бы от вкладки, а не окна.
function drawerEl() {
  let host = $("#ny-drawer");
  if (!host) {
    host = document.createElement("div");
    host.id = "ny-drawer"; host.className = "ny-drawer-host"; host.hidden = true;
    document.body.appendChild(host);
    host.addEventListener("change", e => {
      if (e.target.id !== "ny-shot-track" || !detail || !detail.tosho) return;
      detail.tosho.track = Number(e.target.value) || 0;
      detail.tosho.shots = {};
      $("#ny-d-body").innerHTML = drawerBodyHtml(detail);
      loadShots(detail, () => { if (detail && detail.tab === "tosho") $("#ny-d-body").innerHTML = drawerBodyHtml(detail); });
    });
  }
  return host;
}

function paintDrawer() {
  const host = drawerEl();
  host.hidden = !detail;
  host.innerHTML = detail ? drawerHtml() : "";
  document.body.classList.toggle("ny-drawer-open", !!detail);
}

function paintGallery() {
  const g = $("#ny-gal");
  if (!g || !detail || detail.tab !== "desc") return;
  g.outerHTML = galleryHtml(detail);
}

function closeDetail() { detail = null; paintDrawer(); }

document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !detail) return;
  if (detail.lightbox != null) { detail.lightbox = null; paintDrawer(); } else closeDetail();
});

function wire(root) {
  const q = root.querySelector("#ny-q");
  const go = () => { prefs.q = q.value.trim(); savePrefs(); load(); };
  root.querySelector("#ny-go").addEventListener("click", go);
  q.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  root.querySelector("#ny-refresh").addEventListener("click", load);
  root.querySelector("#ny-save").addEventListener("click", () => {
    const entry = { q: q.value.trim(), cat: prefs.cat };
    if (prefs.saved.some(s => s.q === entry.q && s.cat === entry.cat)) { toast("Такой запрос уже сохранён."); return; }
    prefs.saved = [...prefs.saved, entry].slice(-8);
    savePrefs(); paintStatic(); toast("Запрос сохранён.", "success");
  });
  root.addEventListener("dblclick", e => {
    const row = e.target.closest(".ny-row[data-id]");
    if (!row || e.target.closest("button, input")) return;
    const it = byId(Number(row.dataset.id));
    if (it) openDetail(it);
  });
  const onClick = e => {
    const t = e.target;
    if (t.closest("[data-more]")) { loadMore(); return; }
    if (t.closest("[data-close-panel]")) { ["ny-client", "ny-monitors"].forEach(x => { $(`#${x}`).hidden = true; }); return; }
    if (t.closest("[data-open-client]")) { clientDraft = null; openPanel("ny-client"); paintClient(); return; }
    if (t.closest("[data-client-test]")) {
      clientDraft = readClientForm();
      paintClientMsg("Проверяю…");
      invoke("tc_test", { cfg: clientDraft }).then(v => paintClientMsg(`Подключено: ${v}`), err => paintClientMsg(String(err)));
      return;
    }
    if (t.closest("[data-client-save]")) {
      const cfg = readClientForm();
      invoke("tc_save", { cfg }).then(async () => {
        client = await invoke("tc_load"); clientDraft = null; paintClientLabel(); paintClient("Сохранено."); toast("Клиент сохранён.", "success");
      }, err => paintClientMsg(String(err)));
      return;
    }
    if (t.closest("[data-client-clear]")) {
      invoke("tc_clear").then(() => { client = null; clientDraft = null; paintClientLabel(); paintClient("Клиент забыт."); });
      return;
    }
    if (t.closest("[data-open-monitors]")) { openPanel("ny-monitors"); paintMonitors(); return; }
    if (t.closest("[data-mon-check]")) { checkMonitors(true); return; }
    if (t.closest("[data-mon-add]")) {
      const rule = makeRule({ groups: $("#ny-mon-groups").value, res: $("#ny-mon-res").value, noHevc: $("#ny-mon-nohevc").checked, auto: $("#ny-mon-auto").checked });
      if (rule && rule.auto && !client) { toast("Сначала настройте торрент-клиент: правило отправляет серии в него."); return; }
      addMonitor({ type: $("#ny-mon-type").value, q: $("#ny-mon-q").value, cat: $("#ny-mon-cat").value, rule });
      return;
    }
    const tg = t.closest("[data-toggle]");
    if (tg) { prefs[tg.dataset.toggle] = !prefs[tg.dataset.toggle]; savePrefs(); paintStatic(); paintList(); return; }
    const gt = t.closest("[data-grp-toggle]");
    if (gt && !t.closest("[data-grp-send]")) { const k = gt.dataset.grpToggle; if (openGroups.has(k)) openGroups.delete(k); else openGroups.add(k); paintList(); return; }
    const gs = t.closest("[data-grp-send]");
    if (gs) {
      const g = groupReleases(view()).find(x => x.kind === "group" && x.key === gs.dataset.grpSend);
      const todo = g ? g.episodes.map(e => e.item).filter(i => !sentEps.has(episodeKey(i))) : [];
      if (!todo.length) { toast("Новых серий нет."); return; }
      sendToClient(todo); return;
    }
    if (t.closest("[data-watch-query]")) { addMonitor({ type: "query", q: $("#ny-q").value, cat: prefs.cat }); return; }
    const mo = t.closest("[data-mon-open]");
    if (mo) {
      const m = prefs.monitors.find(x => x.id === mo.dataset.monOpen);
      if (m) {
        m.new = 0;
        if (m.type === "query") { prefs.q = m.q; prefs.cat = m.cat; $("#ny-q").value = m.q; savePrefs(); paintStatic(); load(); }
        else { prefs.q = ""; prefs.cat = "0_0"; $("#ny-q").value = ""; savePrefs(); paintStatic(); loadUser(m.q); }
        paintMonitors();
      }
      return;
    }
    const md = t.closest("[data-mon-del]");
    if (md) { prefs.monitors = prefs.monitors.filter(x => x.id !== md.dataset.monDel); savePrefs(); paintMonitors(); return; }
    if (t.closest("[data-flt-reset]")) { resetFilters(); return; }
    if (t.closest("#ny-flt-btn")) { filtersOpen = !filtersOpen; paintFilters(); return; }
    const ps = t.closest("[data-preset]");
    if (ps) { const x = prefs.presets[Number(ps.dataset.preset)]; if (x) { prefs.filters = normalizeFilters(x.filters); savePrefs(); paintFilters(); paintList(); } return; }
    const pd = t.closest("[data-preset-del]");
    if (pd) { prefs.presets.splice(Number(pd.dataset.presetDel), 1); savePrefs(); paintFilters(); return; }
    if (t.closest("#ny-preset-save")) {
      const name = $("#ny-preset-name").value.trim();
      if (!name) { toast("Назовите набор.", "error"); return; }
      prefs.presets = prefs.presets.filter(p => p.name !== name).concat({ name, filters: prefs.filters }).slice(-10);
      savePrefs(); paintFilters(); toast("Набор сохранён.", "success"); return;
    }
    if (t.closest("#ny-invert")) {
      view().forEach(i => { if (selected.has(i.id)) selected.delete(i.id); else selected.add(i.id); });
      paintList(); return;
    }
    // страница раздачи
    if (t.closest("[data-lb-close]")) { detail.lightbox = null; detail.lbSrc = null; paintDrawer(); return; }
    if (t.closest("[data-d-close]")) { closeDetail(); return; }
    if (detail) {
      const it = detail.item;
      const tab = t.closest("[data-d-tab]");
      if (tab) {
        detail.tab = tab.dataset.dTab;
        $("#ny-d-body").innerHTML = drawerBodyHtml(detail);
        document.querySelectorAll("#ny-drawer [data-d-tab]").forEach(b => b.classList.toggle("on", b === tab));
        if (detail.tab === "sim" && detail.sim && detail.sim.state === "ok") paintSimCovers(detail);
        return;
      }
      if (t.closest("[data-tabs-cfg]")) { detail.tabsCfg = !detail.tabsCfg; $("#ny-d-body").innerHTML = drawerBodyHtml(detail); return; }
      const tv = t.closest("[data-tab-vis]");
      if (tv) {
        const c = normalizeTabs(prefs.tabs);
        prefs.tabs = { order: c.order, hidden: tv.checked ? c.hidden.filter(i => i !== tv.dataset.tabVis) : [...c.hidden, tv.dataset.tabVis] };
        savePrefs(); $("#ny-d-body").innerHTML = drawerBodyHtml(detail); return;
      }
      const tm = t.closest("[data-tab-move]");
      if (tm) {
        const [id, dir] = tm.dataset.tabMove.split(":");
        const c = normalizeTabs(prefs.tabs);
        const i = c.order.indexOf(id), j = i + Number(dir);
        if (j >= 0 && j < c.order.length) { [c.order[i], c.order[j]] = [c.order[j], c.order[i]]; prefs.tabs = c; savePrefs(); $("#ny-d-body").innerHTML = drawerBodyHtml(detail); }
        return;
      }
      const sh = t.closest("[data-shot]");
      if (sh && detail.tosho) { detail.lbSrc = detail.tosho.shots[sh.dataset.shot]; paintDrawer(); return; }
      if (t.closest("[data-fileinfo]")) { loadMediainfo(detail); return; }
      if (t.closest("[data-sub-langs]")) { prefs.subLangs = !(prefs.subLangs !== false); savePrefs(); $("#ny-d-body").innerHTML = drawerBodyHtml(detail); return; }
      if (t.closest("[data-sub-raw]") && detail.tosho && detail.tosho.sub) { detail.tosho.sub.raw_on = !detail.tosho.sub.raw_on; $("#ny-d-body").innerHTML = drawerBodyHtml(detail); return; }
      const so = t.closest("[data-sub-open]");
      if (so) { openSubtitle(detail, Number(so.dataset.subOpen)); return; }
      if (t.closest("[data-sub-find]") && detail.tosho && detail.tosho.sub) { detail.tosho.sub.q = $("#ny-sub-q").value.trim(); $("#ny-d-body").innerHTML = drawerBodyHtml(detail); return; }
      if (t.closest("[data-sub-save]")) { saveSubtitle(detail); return; }
      if (t.closest("[data-sub-close]") && detail.tosho) { detail.tosho.sub = null; $("#ny-d-body").innerHTML = drawerBodyHtml(detail); return; }
      const ext = t.closest("[data-ext]");
      if (ext) { openExternal(ext.dataset.ext).catch(() => toast("Не удалось открыть ссылку.", "error")); return; }
      if (t.closest("[data-sim-go]")) { loadSimilar(detail, $("#ny-sim-q").value.trim() || detail.sim.q); return; }
      const sn = t.closest("[data-sim-nyaa]");
      if (sn) {
        prefs.q = sn.dataset.simNyaa; prefs.cat = "0_0"; savePrefs(); const qi = $("#ny-q"); if (qi) qi.value = prefs.q;
        closeDetail(); paintStatic(); load(); return;
      }
      const lb = t.closest("[data-lb]");
      if (lb) { detail.lightbox = Number(lb.dataset.lb); paintDrawer(); return; }
      const io = t.closest("[data-img-open]");
      if (io) { openExternal(io.dataset.imgOpen).catch(() => toast("Не удалось открыть ссылку.", "error")); return; }
      if (t.closest("[data-d-retry]")) { openDetail(it); return; }
      const da = t.closest("[data-d-a]");
      if (da) {
        const a = da.dataset.dA;
        const hash = (detail.view && detail.view.fields["info hash"]) || it.hash;
        if (a === "send") { sendToClient([{ ...it, hash }]); return; }
        if (a === "watch") { addMonitor({ type: "user", q: uploaderOf(detail) }); return; }
        if (a === "mag") copy(detail.view && detail.view.magnet ? detail.view.magnet : magnetLink({ ...it, hash }), "Magnet скопирован.");
        else if (a === "tor") saveTorrent(it);
        else if (a === "cp") copy(it.title, "Название скопировано.");
        else if (a === "open") openExternal(pageUrl(it)).catch(() => toast("Не удалось открыть ссылку.", "error"));
        return;
      }
    }
    // источники
    const rt = t.closest("[data-route]");
    if (rt) {
      const [sid, mode] = rt.dataset.route.split(":");
      prefs.route = { ...prefs.route, [sid]: mode };
      savePrefs(); viaServer = false; applyChecks(); paintSources();
      if (sid === "nyaa") { items = []; load(); }
      return;
    }
    if (t.closest("[data-open-sources]")) { openSources(); return; }
    if (t.closest("[data-close-sources]")) { $("#ny-sources").hidden = true; return; }
    if (t.closest("#ny-check-all")) { runChecks(allMirrorUrls()); return; }
    const chk = t.closest("[data-check]");
    if (chk) { runChecks([chk.dataset.check]); return; }
    const use = t.closest("[data-use]");
    if (use) { prefs.base = use.dataset.use; savePrefs(); items = []; paintSources(); load(); toast(`Теперь используется ${hostOf(prefs.base)}.`, "success"); return; }
    const del = t.closest("[data-mir-del]");
    if (del) {
      prefs.custom = prefs.custom.filter(m => m !== del.dataset.mirDel);
      if (prefs.base === del.dataset.mirDel) prefs.base = NYAA_MIRRORS[0];
      savePrefs(); paintSources(); return;
    }
    if (t.closest("#ny-mir-add")) {
      const m = normalizeMirror($("#ny-mir-in").value);
      if (!m) { toast("Введите адрес сайта, например nyaa.example.", "error"); return; }
      if (!NYAA_MIRRORS.includes(m) && !prefs.custom.includes(m)) prefs.custom = [...prefs.custom, m].slice(-6);
      savePrefs(); paintSources(); runChecks([m]); return;
    }
    // список
    const cat = t.closest("[data-cat]");
    if (cat) { prefs.cat = cat.dataset.cat; savePrefs(); paintStatic(); load(); return; }
    const f = t.closest("[data-filter]");
    if (f) { prefs.filter = f.dataset.filter; savePrefs(); paintStatic(); load(); return; }
    const s = t.closest("[data-sort]");
    if (s) { prefs.sort = s.dataset.sort; savePrefs(); paintStatic(); paintList(); return; }
    const sv = t.closest("[data-saved]");
    if (sv) { const x = prefs.saved[Number(sv.dataset.saved)]; if (x) { prefs.q = x.q; prefs.cat = x.cat; q.value = x.q; savePrefs(); paintStatic(); load(); } return; }
    const sd = t.closest("[data-saved-del]");
    if (sd) { prefs.saved.splice(Number(sd.dataset.savedDel), 1); savePrefs(); paintStatic(); return; }
    if (t.closest("#ny-retry")) { load(); return; }
    const b = t.closest("[data-bulk]");
    if (b) { bulk(b.dataset.bulk); return; }
    const row = t.closest(".ny-row[data-id]");
    if (!row) return;
    const it = byId(Number(row.dataset.id));
    if (!it) return;
    const a = t.closest("[data-a]");
    if (a) {
      touch(it.id);
      if (a.dataset.a === "send") sendToClient([it]);
      else if (a.dataset.a === "mag") copy(magnetLink(it), "Magnet скопирован.");
      else if (a.dataset.a === "tor") saveTorrent(it);
      else if (a.dataset.a === "info") openDetail(it);
      else if (a.dataset.a === "open") openExternal(pageUrl(it)).catch(() => toast("Не удалось открыть ссылку.", "error"));
      return;
    }
    if (t.closest(".ny-ck") || !t.closest("button, a")) {
      if (e.shiftKey && anchorId != null && anchorId !== it.id) {
        rangeIds(view().map(i => i.id), anchorId, it.id).forEach(id => selected.add(id));
        anchorId = it.id;
        paintList();
        return;
      }
      anchorId = it.id;
      if (selected.has(it.id)) selected.delete(it.id); else selected.add(it.id);
      row.classList.toggle("sel", selected.has(it.id));
      const cb = row.querySelector("input[type=checkbox]"); if (cb) cb.checked = selected.has(it.id);
      const bar = $("#ny-bar"); bar.innerHTML = barHtml(); bar.hidden = !selected.size;
      const all = $("#ny-all"); if (all) all.checked = view().every(i => selected.has(i.id));
    }
  };
  root.addEventListener("click", onClick);
  root.querySelector("#ny-client").addEventListener("change", e => {
    if (e.target.dataset.c !== "kind") return;
    clientDraft = { ...readClientForm(), url: "" };
    paintClient();
  });
  root.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.id === "ny-mon-q") $("[data-mon-add]").click();
  });
  const onFilterInput = () => { prefs.filters = readFilters(); savePrefs(); paintList(); };
  root.querySelector("#ny-filters").addEventListener("input", e => { if (e.target.dataset.f) onFilterInput(); });
  root.querySelector("#ny-filters").addEventListener("change", e => { if (e.target.dataset.f) onFilterInput(); });
  drawerEl().addEventListener("click", onClick);
  root.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.id === "ny-mir-in") $("#ny-mir-add").click();
  });
  root.querySelector("#ny-cats").addEventListener("change", e => {
    if (e.target.id !== "ny-cat-more" || !e.target.value) return;
    prefs.cat = e.target.value; savePrefs(); paintStatic(); load();
  });
  root.querySelector("#ny-all").addEventListener("change", e => {
    const list = view();
    if (e.target.checked) list.forEach(i => selected.add(i.id)); else list.forEach(i => selected.delete(i.id));
    paintList();
  });
}

// Предупреждение о бета-версии: при открытии вкладки, пока не отмечено «больше не показывать».
const BETA_KEY = "project-nyaa-beta-ok";
let betaShown = false;
function maybeWarnBeta() {
  let skip = false;
  try { skip = localStorage.getItem(BETA_KEY) === "1"; } catch (_) { /* покажем окно */ }
  if (betaShown || skip) return;
  betaShown = true;
  const overlay = openSheet(`
    <div class="nda">
      <span class="kd-label">Бета-версия</span>
      <h2>Nyaa (Beta)</h2>
      <p>Раздел «Релизы» ещё тестируется: что-то может работать нестабильно, а сайты — быть недоступными у вашего провайдера.</p>
      <p>Программа сама ничего не скачивает: она показывает ленту, копирует magnet и по вашей кнопке отправляет раздачи в ваш торрент-клиент. Скачивайте только то, что вам разрешено законом и правами на материал.</p>
      <p>Если что-то работает неправильно, сообщите администратору.</p>
      <label class="ny-beta-ck"><input type="checkbox" id="ny-beta-skip"> Больше не показывать</label>
      <div class="nda-actions"><button class="btn primary" id="ny-beta-ok">Понятно</button></div>
    </div>`);
  overlay.querySelector("#ny-beta-ok").addEventListener("click", () => {
    if (overlay.querySelector("#ny-beta-skip").checked) { try { localStorage.setItem(BETA_KEY, "1"); } catch (_) { /* покажем снова */ } }
    overlay.remove();
  });
}

export async function loadNyaa() {
  const body = $("#nyaa-body");
  if (!body) return true;
  maybeWarnBeta();
  if (!body.querySelector(".ny")) {
    body.innerHTML = shellHtml();
    paintStatic();
    wire(body.querySelector(".ny"));
    paintMonitorBadge();
  }
  if (client === null) invoke("tc_load").then(c => { client = c || null; paintClientLabel(); }).catch(() => {});
  // Свежий список при открытии вкладки, но не чаще раза в 2 минуты.
  if (!items.length || Date.now() - fetchedAt > 120_000) await load();
  else paintList();
  return !error;
}
