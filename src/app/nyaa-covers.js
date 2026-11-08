// Nyaa/игры, вынесено из nyaa.js: обложки вместо значков.
import { invoke } from "./tauri.js";
import { apiGet } from "./api.js";
import { esc } from "./utils.js";
import { relTime, fmtDate, splitTitle, categoryKind, parseView, hostOf, dayLabel, groupReleases, episodeKey, COVER_QUERY, parseCover, coverKey, coverAltKeys, coverSearchTerms, pickCoverCandidate, COVER_BATCH, coverBatchRequest, parseCoverBatch } from "./nyaa-core.js";
import { ICONS, KIND_ICON, error, fetchPic, hasMore, haveIt, items, loading, moreBusy, nyaaView, openGroups, prefs, reportTarget, sdOf, seen, selected, sentEps, stale, view } from "./nyaa.js";

// ---------- обложки вместо значков ----------
// Обложка берётся с AniList по названию тайтла (одна на аниме, не на каждую раздачу) и держится
// в памяти; в localStorage лежит только адрес картинки. Не нашлась — остаётся значок.
const COVERS_KEY = "project-nyaa-covers-hd";   // адреса баннеров/больших постеров (прежние — 100×150)
try { localStorage.removeItem("project-nyaa-covers"); } catch (_) { /* нет — и ладно */ }
export const coverUrls = (() => { try { return JSON.parse(localStorage.getItem(COVERS_KEY) || "{}"); } catch (_) { return {}; } })();
export const coverData = new Map();   // ключ → data-URL
const coverBusy = new Set();
const saveCovers = () => {
  const keys = Object.keys(coverUrls);
  if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete coverUrls[k]);
  try { localStorage.setItem(COVERS_KEY, JSON.stringify(coverUrls)); } catch (_) { /* не запомнится */ }
};

// У раздач без аниме-обложки (музыка, OST) аватар — первая картинка из описания раздачи.
const THUMBS_KEY = "project-nyaa-thumbs";
export const thumbUrls = (() => { try { return JSON.parse(localStorage.getItem(THUMBS_KEY) || "{}"); } catch (_) { return {}; } })();
export const thumbData = new Map();   // id → data-URL
const saveThumbs = () => {
  const keys = Object.keys(thumbUrls);
  if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(k => delete thumbUrls[k]);
  try { localStorage.setItem(THUMBS_KEY, JSON.stringify(thumbUrls)); } catch (_) { /* не запомнится */ }
};

const thumbFailAt = new Map();   // id → когда последний раз не получилось (повтор не чаще раза в минуту)

async function fetchThumb(it) {
  const id = it.id;
  if (coverBusy.has(`t${id}`) || thumbData.has(id)) return;
  if (Date.now() - (thumbFailAt.get(id) || 0) < 60_000) return;
  coverBusy.add(`t${id}`);
  try {
    let url = thumbUrls[id];
    if (url === undefined) {
      url = parseView(await nyaaView({ base: prefs.base, id })).images[0] || "";
      thumbUrls[id] = url; saveThumbs();
    }
    if (url) {
      thumbData.set(id, await fetchPic(url));
      document.querySelectorAll(".ny-kind[data-tid]").forEach(el => {
        if (el.dataset.tid !== String(id) || el.querySelector("img")) return;
        el.classList.add("has-cover"); el.innerHTML = `<img src="${esc(thumbData.get(id))}" alt="">`;
      });
    }
  } catch (_) { thumbFailAt.set(id, Date.now()); }
  coverBusy.delete(`t${id}`);
}

// Фон шапки страницы раздачи — обложка/баннер самого тайтла, если уже загружена.
export function headCover(it) { const key = coverKey(it.title); return (key && coverData.get(key)) || thumbData.get(it.id) || ""; }
// Описание с nyaa — markdown: заголовки, жирный, курсив, ссылки, списки — в простую разметку (после esc).
export function descHtml(md) {
  return esc(md).split(/\n/).map(l => {
    const h = l.match(/^\s*#{1,6}\s*(.*)$/);
    let t = (h ? h[1] : l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\s)\*(\S.*?)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, a, u) => `<a data-ext="${u}">${a}</a>`);
    if (!h && /^\s*[-*]\s+/.test(l)) t = "• " + t.replace(/^\s*[-*]\s+/, "");
    return h ? `<b class="ny-desc-h">${t}</b>` : t;
  }).join("<br>");
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

// Старое «» (до этой правки) считаем просроченным.
const MISS_TTL = 3 * 24 * 3600_000;
// «miss3:» — промахи с тех пор, как есть запасные каталоги и картинка из описания раздачи; старые перепроверяем
const missedRecently = v => typeof v === "string" && v.startsWith("miss3:") && Date.now() - Number(v.slice(6)) < MISS_TTL;
const hasUrl = v => typeof v === "string" && v.startsWith("https://");

// Если AniList не знает тайтл: Kitsu, MyAnimeList и Shikimori через сервер, а в конце — первая картинка из описания раздачи.
async function coverFallback(key, sample) {
  const terms = coverSearchTerms(key, sample && sample.title);
  for (const q of terms) {
    try {
      const d = await apiGet("/nyaa/cover-search", { q });
      const url = pickCoverCandidate(terms, d.items);
      if (url) return url;
    } catch (_) { break; }
  }
  if (!sample) return "";
  return parseView(await nyaaView({ base: prefs.base, id: sample.id })).images[0] || "";
}

// Готовые обложки живут на диске уменьшенными: при запуске список сразу с картинками, без скачивания заново.
const COVER_DB = "project-nyaa-cover-cache-hd2";   // баннеры до 1280px и большие постеры (раньше 100×150 — на всю строку выходили мылом)
try { ["project-nyaa-cover-cache", "project-nyaa-cover-cache-hd"].forEach(n => indexedDB.deleteDatabase(n)); } catch (_) { /* старого кэша может не быть */ }
const COVER_SIZE = 420;
const COVER_DB_LIMIT = 400;
let coverDb = null;

function openCoverDb() {
  if (coverDb) return coverDb;
  coverDb = new Promise(resolve => {
    try {
      const req = indexedDB.open(COVER_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("covers");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return coverDb;
}

let coverCacheLoaded = null;
function loadCoverCache() {
  if (coverCacheLoaded) return coverCacheLoaded;
  coverCacheLoaded = openCoverDb().then(db => new Promise(resolve => {
    if (!db) { resolve(); return; }
    const store = db.transaction("covers").objectStore("covers");
    const keys = store.getAllKeys();
    const values = store.getAll();
    values.onsuccess = () => {
      keys.result.forEach((k, i) => { if (!coverData.has(k)) coverData.set(k, values.result[i]); });
      if (keys.result.length > COVER_DB_LIMIT) {
        const del = db.transaction("covers", "readwrite").objectStore("covers");
        keys.result.slice(0, keys.result.length - COVER_DB_LIMIT).forEach(k => del.delete(k));
      }
      resolve();
    };
    values.onerror = () => resolve();
  }));
  return coverCacheLoaded;
}

function shrinkCover(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, COVER_SIZE / Math.min(img.naturalWidth, img.naturalHeight), 1280 / img.naturalWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/webp", 0.8));
      } catch (_) { resolve(src); }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

async function storeCover(key, src) {
  const db = await openCoverDb();
  if (!db) return;
  try { db.transaction("covers", "readwrite").objectStore("covers").put(src, key); } catch (_) { /* просто скачаем в следующий раз */ }
}

async function aniListBatch(terms) {
  const { query, variables } = coverBatchRequest(terms);
  const urls = parseCoverBatch(await invoke("anilist_query", { query, variables }), terms.length);
  if (!urls) throw new Error("AniList не ответил");
  return urls;
}

// Пачка: сначала по основным названиям, ненайденные — по запасным. Возвращает ненайденные ключи.
async function resolveCoverChunk(chunk, altsOf) {
  const urls = await aniListBatch(chunk);
  chunk.forEach((k, i) => { if (urls[i]) coverUrls[k] = urls[i]; });
  let misses = chunk.filter(k => !hasUrl(coverUrls[k]));
  const altOwner = new Map();
  for (const k of misses) for (const alt of (altsOf.get(k) || []).slice(0, 2)) if (!altOwner.has(alt) && altOwner.size < COVER_BATCH) altOwner.set(alt, k);
  if (altOwner.size) {
    const terms = [...altOwner.keys()];
    const found = await aniListBatch(terms);
    terms.forEach((t, i) => { const k = altOwner.get(t); if (found[i] && !hasUrl(coverUrls[k])) coverUrls[k] = found[i]; });
    misses = misses.filter(k => !hasUrl(coverUrls[k]));
  }
  saveCovers();
  return misses;
}

async function fetchCover(key, alts = [], sample = null) {
  if (coverBusy.has(key) || coverData.has(key)) return;
  coverBusy.add(key);
  try {
    let url = coverUrls[key];
    if (!hasUrl(url) && !missedRecently(url)) {
      url = "";
      // по основному названию, потом по запасным из скобок («(Nezumi-kun no Chokki (TV))»)
      for (const s of sample && sample.batched ? [] : [key, ...alts]) {
        url = parseCover(await invoke("anilist_query", { query: COVER_QUERY, variables: { s } }));
        if (url) break;
      }
      if (!url) url = await coverFallback(key, sample);
      coverUrls[key] = url || `miss3:${Date.now()}`; saveCovers();
    }
    if (hasUrl(url)) {
      const small = await shrinkCover(await fetchPic(url));
      coverData.set(key, small);
      paintCover(key);
      storeCover(key, small);
    }
  } catch (_) { /* нет связи: попробуем при следующей отрисовке */ }
  coverBusy.delete(key);
}

let coverQueueOn = false;
export async function loadListCovers() {
  if (coverQueueOn) return;
  coverQueueOn = true;
  try {
    await loadCoverCache();
    for (const el of document.querySelectorAll(".ny-kind[data-ck]")) if (el.dataset.ck) paintCover(el.dataset.ck);
    const vis = view();
    const isAudio = i => categoryKind(i.categoryId) === "audio";
    const altsOf = new Map();
    const sampleOf = new Map();
    for (const i of vis) if (!isAudio(i)) { const k = coverKey(i.title); if (k && !altsOf.has(k)) { altsOf.set(k, coverAltKeys(i.title)); sampleOf.set(k, i); } }
    const keys = [...altsOf.keys()].filter(k => !coverData.has(k) && !missedRecently(coverUrls[k]));
    const thumbs = vis.filter(i => isAudio(i) && !thumbData.has(i.id) && thumbUrls[i.id] !== "").slice(0, 30);
    // Адрес уже известен — это просто скачать картинку, потоков больше. Поиск идёт пачками сверху списка, а по запасным каталогам — в конце и бережнее.
    const pool = (list, size) => {
      let next = 0;
      const worker = async () => { while (next < list.length) await list[next++](); };
      return Array.from({ length: size }, worker);
    };
    const download = k => () => fetchCover(k);
    const lookups = async () => {
      const unknown = keys.filter(k => !hasUrl(coverUrls[k]));
      const misses = [];
      try {
        for (let i = 0; i < unknown.length; i += COVER_BATCH) {
          const chunk = unknown.slice(i, i + COVER_BATCH);
          misses.push(...await resolveCoverChunk(chunk, altsOf));
          await Promise.all(pool(chunk.filter(k => hasUrl(coverUrls[k])).map(download), 8));
        }
      } catch (_) { /* лимит или нет связи: продолжим при следующей отрисовке */ }
      const jobs = [
        ...misses.map(k => () => fetchCover(k, [], { ...sampleOf.get(k), batched: true })),
        ...thumbs.map(i => () => fetchThumb(i)),
      ];
      await Promise.all(pool(jobs, 3));
    };
    await Promise.all([...pool(keys.filter(k => hasUrl(coverUrls[k])).map(download), 8), lookups()]);
  } finally { coverQueueOn = false; }
}

function rowHtml(it, maxSeed, now) {
  const { group, tags } = splitTitle(it.title);
  const kind = categoryKind(it.categoryId);
  const health = maxSeed ? Math.max(4, Math.round(it.seeders / maxSeed * 100)) : 0;
  return `
    <div class="ny-row${it.trusted ? " tr" : ""}${it.remake ? " rm" : ""}${selected.has(it.id) ? " sel" : ""}${seen.has(it.id) ? " seen" : ""}${haveIt(it) ? " have" : ""}${sdOf(it) ? ` sd-${sdOf(it)}` : ""}" data-id="${it.id}">
      <label class="ny-ck"><input type="checkbox" ${selected.has(it.id) ? "checked" : ""} aria-label="Выбрать"></label>
      ${kindHtml(it, kind)}
      <div class="ny-main">
        <div class="ny-title">${group ? `<em>${esc(group)}</em>` : ""}${esc(group ? it.title.replace(/^\s*\[[^\]]*\]\s*/, "") : it.title)}</div>
        <div class="ny-tags">${tags.map(t => `<i>${esc(t)}</i>`).join("")}${it.remake ? `<i class="warn">ремейк</i>` : ""}${haveIt(it) ? `<i class="have-i" title="Эта серия уже есть в вашей медиатеке">уже есть</i>` : ""}${sdOf(it) === "best" ? `<i class="sd-b" title="Лучший релиз по SeaDex">SeaDex ★</i>` : sdOf(it) === "alt" ? `<i class="sd-a" title="Хорошая альтернатива по SeaDex">SeaDex</i>` : ""}${it.trusted ? `<i class="ok" title="Доверенный загрузчик">${ICONS.check}</i>` : ""}${it.comments ? `<span class="ny-cm">${ICONS.comment}${it.comments}</span>` : ""}</div>
      </div>
      <div class="ny-meta"><b>${esc(it.size)}</b><span title="${esc(fmtDate(it.date))}">${esc(relTime(it.date, now))}</span></div>
      <div class="ny-health" title="раздают · качают · скачали">
        <div class="ny-bar-bg"><u style="width:${health}%"></u></div>
        <div class="ny-nums"><span class="se">↑ ${it.seeders}</span><span class="le">↓ ${it.leechers}</span><span class="dl">✓ ${it.downloads}</span></div>
      </div>
      <div class="ny-act">
        <button type="button" class="ny-ib" data-a="send" title="Отправить в торрент-клиент" aria-label="Отправить в торрент-клиент">${ICONS.send}</button>
        ${reportTarget ? `<button type="button" class="ny-ib ny-srv" data-a="srv" title="Скачать на сервер и прикрепить к отчёту ${esc(reportTarget.publicId)}" aria-label="Скачать на сервер">☁</button><button type="button" class="ny-ib ny-srv" data-a="mine" title="Скачать на этот компьютер (торрент-клиент): видео останется у вас, на сервере будут только субтитры и звук" aria-label="Скачать у себя">💻</button>` : ""}
        <button type="button" class="ny-ib" data-a="menu" title="Ещё действия" aria-label="Ещё действия" aria-haspopup="menu">${ICONS.more}</button>
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

// Заголовки дней между строками: «Сегодня», «Вчера», «8 октября» — только при сортировке по дате.
function rowsByDay(list, maxSeed, now) {
  if (prefs.sort !== "date") return list.map(i => rowHtml(i, maxSeed, now)).join("");
  let last = "";
  return list.map(i => {
    const lbl = dayLabel(i.date, now);
    const head = lbl !== last ? `<div class="ny-day">${esc(lbl)}</div>` : "";
    last = lbl;
    return head + rowHtml(i, maxSeed, now);
  }).join("");
}

function skeleton() {
  return Array.from({ length: 8 }, () => `<div class="ny-row sk"><span class="ny-kind"></span><div class="ny-main"><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div></div>`).join("");
}

export function listHtml() {
  if (loading && !items.length) return skeleton();
  if (error && !items.length) {
    return `<div class="ny-empty"><b>Не получилось загрузить с ${esc(hostOf(prefs.base))}</b><p>${esc(error)}</p>
      <div class="ny-empty-act"><button type="button" class="btn primary" id="ny-retry">Повторить</button><button type="button" class="btn" data-open-sources>Проверить зеркала</button></div>
      <p class="ny-hint">Если сайт переехал или заблокирован — выберите другое зеркало в «Источниках». Если открывается только через VPN, включите его.</p></div>`;
  }
  const list = view();
  const hidden = items.length - list.length;
  if (!list.length) {
    return `<div class="ny-empty"><b>${items.length ? "Всё скрыто фильтрами" : "Ничего не найдено"}</b><p>${items.length ? `Фильтры прячут ${hidden} из ${items.length}.${prefs.onlySeadex ? " Включён «SeaDex»: в этом списке нет раздач из базы SeaDex." : ""}${prefs.hideDone ? " Включено «Скрыть отправленное»." : ""}` : "Попробуйте другое слово или категорию."}</p>${prefs.onlySeadex ? `<button type="button" class="btn" data-toggle="onlySeadex">Выключить «SeaDex»</button>` : ""}${items.length ? `<button type="button" class="btn" data-flt-reset>Сбросить фильтры</button>` : ""}${hasMore ? `<div class="ny-more-wrap"><button type="button" class="btn primary" data-more>Показать ещё</button></div>` : ""}</div>`;
  }
  const maxSeed = Math.max(...list.map(i => i.seeders), 1);
  const now = Date.now();
  const body = prefs.group ? groupReleases(list).map(g => g.kind === "item" ? rowHtml(g.item, maxSeed, now) : groupHtml(g, maxSeed, now)).join("") : rowsByDay(list, maxSeed, now);
  const sortBtn = (k, label, cls = "") => `<button type="button" class="ny-sorth${prefs.sort === k ? " on" : ""} ${cls}" data-sort="${k}" aria-label="Сортировать: ${label}">${label}${prefs.sort === k ? " ↓" : ""}</button>`;
  // Каждая колонка — своя ячейка сетки, той же, что у .ny-row (размер, дата, ↑, ↓, ✓ — по отдельности),
  // чтобы подпись стояла ровно над своими цифрами.
  return `<div class="ny-head"><span></span><span></span><span>Название</span>${sortBtn("size", "Размер", "r")}${sortBtn("date", "Дата", "r")}${sortBtn("seeders", "Раздают", "r")}<span class="ny-h2 r">Качают</span>${sortBtn("downloads", "Скачали", "r")}<span></span></div>`
    + (stale ? `<div class="ny-stale">Сайт не отвечает — показаны сохранённые данные (${esc(relTime(stale))}). <button type="button" class="ny-link" id="ny-retry">Обновить</button></div>` : "")
    + body
    + `<div class="ny-more-wrap">${hidden ? `<span class="ny-hint">фильтры скрывают ${hidden}</span>` : ""}${hasMore ? `<button type="button" class="btn" data-more>${moreBusy ? "Загружаю…" : "Показать ещё"}</button>` : `<span class="ny-hint">это всё, что отдал сайт</span>`}</div>`;
}

export function barHtml() {
  if (!selected.size) return "";
  return `
    <span class="ny-bar-count"><b>${selected.size}</b> выбрано</span>
    <button type="button" class="btn primary" data-bulk="mag">${ICONS.magnet} Копировать magnet</button>
    <button type="button" class="btn" data-bulk="send">${ICONS.send} В торрент-клиент</button>
    <button type="button" class="btn" data-bulk="sys" title="Открыть magnet в системном торрент-клиенте">${ICONS.magnet} В системный клиент</button>
    <button type="button" class="btn" data-bulk="titles">${ICONS.copy} Названия</button>
    <button type="button" class="btn" data-bulk="links">${ICONS.open} Ссылки на страницы</button>
    <button type="button" class="btn ghost" data-bulk="clear">Сбросить</button>`;
}

export function shellHtml() {
  return `
  <div class="ny">
    <header class="ny-hero">
      <div class="ny-hero-t"><h2>Nyaa <span class="ny-beta">Beta</span></h2>
        <p>Свежие раздачи из публичной ленты. Щелчок по строке открывает страницу раздачи: описание, картинки, файлы.</p></div>
      <div class="ny-stats" id="ny-stats"></div>
    </header>
    <section class="ny-sources" id="ny-sources" hidden></section>
    <section class="ny-sources" id="ny-client" hidden></section>
    <section class="ny-sources" id="ny-monitors" hidden></section>
    <section class="ny-sources" id="ny-library" hidden></section>
    <div class="ny-layout">
      <aside class="ny-side" aria-label="Категории и инструменты">
        <div class="ny-side-g"><div class="ny-side-h">Категории</div><div class="ny-cats" id="ny-cats"></div></div>
        <div class="ny-side-g"><div class="ny-side-h">Показывать</div><div class="ny-seg" id="ny-filter"></div></div>
        <div class="ny-side-g ny-saved-g"><div class="ny-side-h">Мои запросы</div><div class="ny-saved" id="ny-saved"></div></div>
        <div class="ny-side-g"><div class="ny-side-h">Инструменты</div>
          <button type="button" class="ny-side-btn" data-open-sources>${ICONS.plug}<span id="ny-src-host"></span><i id="ny-src-dot"></i></button>
          <button type="button" class="ny-side-btn" data-open-client>${ICONS.send}<span id="ny-client-lbl">Торрент-клиент</span></button>
          <button type="button" class="ny-side-btn" data-open-library>${ICONS.folder || ICONS.open}<span id="ny-lib-lbl">Медиатека</span></button>
          <button type="button" class="ny-side-btn" data-open-monitors>${ICONS.bell}<span>Слежение</span><b id="ny-mon-n" class="ny-badge"></b></button>
        </div>
      </aside>
      <main class="ny-main-col">
        <div class="ny-search">
          <span class="ny-search-ic">${ICONS.search}</span>
          <input id="ny-q" type="text" placeholder="Название, группа, 1080p…" value="${esc(prefs.q)}" spellcheck="false" autocomplete="off">
          <button type="button" class="btn ghost" id="ny-save" title="Запомнить запрос и категорию">${ICONS.star} Запомнить</button>
          <button type="button" class="btn ghost" data-watch-query title="Следить за этим запросом и сообщать о новых раздачах">${ICONS.bell} Следить</button>
          <button type="button" class="btn primary" id="ny-go">Найти</button>
        </div>
        <div class="ny-ctl">
          <div class="ny-seg" id="ny-view"></div>
          <span class="ny-sp"></span>
          <button type="button" class="ny-flt-btn" id="ny-flt-btn" aria-expanded="false">${ICONS.filter}<span>Фильтры</span><b id="ny-flt-n"></b></button>
          <button type="button" class="ny-ib wide" id="ny-refresh" title="Обновить список" aria-label="Обновить список">${ICONS.refresh}</button>
        </div>
        <section class="ny-filters" id="ny-filters" hidden></section>
        <div class="ny-status" id="ny-status" data-open-sources title="Нажмите, чтобы открыть «Источники и зеркала»"></div>
        <div class="ny-sel-all"><label><input type="checkbox" id="ny-all"> выбрать всё</label><button type="button" class="ny-link" id="ny-invert">инвертировать</button></div>
        <div class="ny-list" id="ny-list"></div>
        <div class="ny-bar" id="ny-bar" hidden></div>
      </main>
    </div>
  </div>`;
}

export function seg(items2, current, attr) {
  return items2.map(([k, l]) => `<button type="button" class="${k === current ? "on" : ""}" ${attr}="${esc(k)}">${esc(l)}</button>`).join("");
}

