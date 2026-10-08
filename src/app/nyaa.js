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
import { toast, API_BASE } from "./api.js";
import { $, esc } from "./utils.js";
import {
  CATEGORIES, FILTERS, parseNyaaRss, magnetLink, sortItems, relTime, fmtDate,
  splitTitle, categoryKind, summarize, fmtBytes, torrentFileName,
  parseView, buildServices, classifyCheck, normalizeMirror, hostOf, NYAA_MIRRORS,
  applyFilters, activeFilterCount, normalizeFilters, DEFAULT_FILTERS, splitWords, mergePages, rangeIds,
} from "./nyaa-core.js";

const KEY = "project-nyaa";
const QUICK_CATS = [["2_1", "Аудио без потерь"], ["1_2", "Аниме · англ. субтитры"], ["1_4", "Аниме · raw"], ["1_3", "Аниме · другие языки"], ["0_0", "Всё"]];
const SORTS = [["date", "Новые"], ["seeders", "Раздают"], ["downloads", "Скачивают"], ["size", "Размер"]];
const KIND_ICON = { anime: "🎬", audio: "♪", video: "▶", other: "•" };

function loadPrefs() {
  const d = { cat: "2_1", filter: "0", q: "", sort: "date", saved: [], base: NYAA_MIRRORS[0], custom: [], filters: { ...DEFAULT_FILTERS }, presets: [] };
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
const selected = new Set();
let checks = {};           // url → результат net_check
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
  plug: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>',
};

const view = () => sortItems(applyFilters(items, prefs.filters, { seen }), prefs.sort, "desc");
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

function rowHtml(it, maxSeed, now) {
  const { group, tags } = splitTitle(it.title);
  const kind = categoryKind(it.categoryId);
  const health = maxSeed ? Math.max(4, Math.round(it.seeders / maxSeed * 100)) : 0;
  return `
    <div class="ny-row${it.trusted ? " tr" : ""}${it.remake ? " rm" : ""}${selected.has(it.id) ? " sel" : ""}${seen.has(it.id) ? " seen" : ""}" data-id="${it.id}">
      <label class="ny-ck"><input type="checkbox" ${selected.has(it.id) ? "checked" : ""} aria-label="Выбрать"></label>
      <span class="ny-kind k-${kind}" title="${esc(it.category)}">${KIND_ICON[kind]}</span>
      <div class="ny-main">
        <div class="ny-title">${group ? `<em>${esc(group)}</em>` : ""}${esc(group ? it.title.replace(/^\s*\[[^\]]*\]\s*/, "") : it.title)}</div>
        <div class="ny-tags">${tags.map(t => `<i>${esc(t)}</i>`).join("")}${it.remake ? `<i class="warn">ремейк</i>` : ""}${it.trusted ? `<i class="ok">доверенный</i>` : ""}${it.comments ? `<span class="ny-cm">${ICONS.comment}${it.comments}</span>` : ""}</div>
      </div>
      <div class="ny-meta"><b>${esc(it.size)}</b><span title="${esc(fmtDate(it.date))}">${esc(relTime(it.date, now))}</span></div>
      <div class="ny-health" title="раздают · качают · скачали">
        <div class="ny-bar-bg"><u style="width:${health}%"></u></div>
        <div class="ny-nums"><span class="se">↑ ${it.seeders}</span><span class="le">↓ ${it.leechers}</span><span class="dl">✓ ${it.downloads}</span></div>
      </div>
      <div class="ny-act">
        <button type="button" class="ny-ib" data-a="info" title="Страница раздачи (двойной щелчок)" aria-label="Страница раздачи">${ICONS.info}</button>
        <button type="button" class="ny-ib" data-a="mag" title="Копировать magnet" aria-label="Копировать magnet">${ICONS.magnet}</button>
        <button type="button" class="ny-ib" data-a="tor" title="Сохранить .torrent" aria-label="Сохранить .torrent">${ICONS.torrent}</button>
        <button type="button" class="ny-ib" data-a="open" title="Открыть страницу в браузере" aria-label="Открыть в браузере">${ICONS.open}</button>
      </div>
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
  return list.map(i => rowHtml(i, maxSeed, now)).join("")
    + `<div class="ny-more-wrap">${hidden ? `<span class="ny-hint">фильтры скрывают ${hidden}</span>` : ""}${hasMore ? `<button type="button" class="btn" data-more>${moreBusy ? "Загружаю…" : "Показать ещё"}</button>` : `<span class="ny-hint">это всё, что отдал сайт</span>`}</div>`;
}

function barHtml() {
  if (!selected.size) return "";
  return `
    <span class="ny-bar-count"><b>${selected.size}</b> выбрано</span>
    <button type="button" class="btn primary" data-bulk="mag">${ICONS.magnet} Копировать magnet</button>
    <button type="button" class="btn" data-bulk="titles">${ICONS.copy} Названия</button>
    <button type="button" class="btn" data-bulk="links">${ICONS.open} Ссылки на страницы</button>
    <button type="button" class="btn ghost" data-bulk="clear">Сбросить</button>`;
}

function shellHtml() {
  return `
  <div class="ny">
    <header class="ny-hero">
      <div class="ny-hero-t"><span class="kd-label">Релизы</span><h2>Nyaa</h2>
        <p>Свежие раздачи из публичной ленты — не нужно заходить на сайт. Двойной щелчок по строке открывает страницу раздачи: описание, картинки, файлы.</p>
        <button type="button" class="ny-src-btn" data-open-sources>${ICONS.plug}<span id="ny-src-host"></span><i id="ny-src-dot"></i></button></div>
      <div class="ny-stats" id="ny-stats"></div>
    </header>
    <section class="ny-sources" id="ny-sources" hidden></section>
    <div class="ny-search">
      <span class="ny-search-ic">${ICONS.search}</span>
      <input id="ny-q" type="text" placeholder="Название, группа, 1080p…" value="${esc(prefs.q)}" spellcheck="false" autocomplete="off">
      <button type="button" class="btn ghost" id="ny-save" title="Запомнить запрос и категорию">${ICONS.star} Запомнить</button>
      <button type="button" class="btn primary" id="ny-go">Найти</button>
    </div>
    <div class="ny-cats" id="ny-cats"></div>
    <div class="ny-ctl">
      <div class="ny-seg" id="ny-filter"></div>
      <span class="ny-sp"></span>
      <div class="ny-seg" id="ny-sort"></div>
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
  $("#ny-saved").innerHTML = prefs.saved.length
    ? `<span class="ny-saved-l">Мои запросы</span>` + prefs.saved.map((s, i) => `<span class="ny-chip"><button type="button" data-saved="${i}">${esc(s.q || "без слов")} <small>${esc((QUICK_CATS.concat(CATEGORIES).find(c => c[0] === s.cat) || [0, s.cat])[1])}</small></button><button type="button" class="x" data-saved-del="${i}" aria-label="Убрать">×</button></span>`).join("")
    : "";
  paintSourceChip();
  paintFilters();
}

function paintSourceChip() {
  const host = $("#ny-src-host"), dot = $("#ny-src-dot");
  if (!host) return;
  host.textContent = hostOf(prefs.base);
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
}

async function load() {
  loading = true; error = "";
  $("#ny-refresh")?.classList.add("spin");
  paintList();
  try {
    const xml = await invoke("nyaa_rss", { base: prefs.base, query: prefs.q, category: prefs.cat, filter: prefs.filter, page: 1 });
    items = parseNyaaRss(xml);
    page = 1;
    hasMore = items.length >= 50;
    fetchedAt = Date.now();
    selected.clear();
  } catch (e) {
    error = String(e && e.message ? e.message : e);
    items = [];
  }
  loading = false;
  $("#ny-refresh")?.classList.remove("spin");
  paintList();
}

async function loadMore() {
  if (moreBusy || !hasMore) return;
  moreBusy = true; paintList();
  try {
    const xml = await invoke("nyaa_rss", { base: prefs.base, query: prefs.q, category: prefs.cat, filter: prefs.filter, page: page + 1 });
    const next = parseNyaaRss(xml);
    const before = items.length;
    items = mergePages(items, next);
    page += 1;
    hasMore = next.length >= 50 && items.length > before;
  } catch (e) { toast(`Не удалось загрузить дальше: ${e}`, "error"); }
  moreBusy = false;
  paintList();
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
  try { await invoke("nyaa_save_torrent", { base: prefs.base, id: it.id, path: out }); toast("Файл .torrent сохранён.", "success"); }
  catch (e) { toast(`Не удалось сохранить: ${e}`, "error"); }
}

function bulk(kind) {
  const list = view().filter(i => selected.has(i.id));
  if (kind === "clear") { selected.clear(); paintList(); return; }
  if (!list.length) return;
  list.forEach(i => touch(i.id));
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

// ---------- источники и зеркала ----------
function sourcesHtml() {
  const services = buildServices(prefs.custom, serverOrigin());
  return `
    <div class="ny-src-head"><div><b>Источники и зеркала</b><span>Проверка связи с этого компьютера. Если сайт переехал, выберите рабочее зеркало.</span></div>
      <div><button type="button" class="btn primary" id="ny-check-all">${checking ? "Проверяю…" : "Проверить всё"}</button><button type="button" class="ny-ib wide" data-close-sources title="Закрыть" aria-label="Закрыть">${ICONS.close}</button></div></div>
    <div class="ny-src-grid">${services.map(sv => `
      <div class="ny-svc">
        <div class="ny-svc-h"><b>${esc(sv.name)}</b><span>${esc(sv.note)}</span></div>
        ${sv.mirrors.map(m => {
          const c = classifyCheck(checks[m]);
          const active = sv.apply && m === prefs.base;
          const custom = sv.id === "nyaa" && prefs.custom.includes(m);
          return `<div class="ny-mir${active ? " act" : ""}"><i class="${c.level}"></i><div><b>${esc(hostOf(m))}</b><span>${esc(c.text)}</span></div>
            ${sv.apply ? (active ? `<em>используется</em>` : `<button type="button" class="btn ghost" data-use="${esc(m)}">Использовать</button>`) : ""}
            ${custom ? `<button type="button" class="ny-ib" data-mir-del="${esc(m)}" title="Убрать зеркало" aria-label="Убрать зеркало">${ICONS.close}</button>` : ""}
            <button type="button" class="ny-ib" data-check="${esc(m)}" title="Проверить" aria-label="Проверить">${ICONS.refresh}</button></div>`;
        }).join("")}
        ${sv.id === "nyaa" ? `<div class="ny-mir-add"><input id="ny-mir-in" type="text" placeholder="Своё зеркало, например nyaa.example" spellcheck="false"><button type="button" class="btn" id="ny-mir-add">Добавить</button></div>` : ""}
        ${!sv.apply && sv.id !== "server" ? `<p class="ny-hint">Режим «Смотреть» берёт эти данные через сервер студии: здесь видно, доступен ли сайт с вашего компьютера.</p>` : ""}
      </div>`).join("")}</div>`;
}

function paintSources() {
  const box = $("#ny-sources");
  if (!box || box.hidden) return;
  box.innerHTML = sourcesHtml();
  paintSourceChip();
}

async function runChecks(urls) {
  checking = true; paintSources();
  try {
    const res = await invoke("net_check", { urls });
    res.forEach(r => { checks[r.url] = r; });
  } catch (e) { toast(`Проверка не удалась: ${e}`, "error"); }
  checking = false; paintSources();
}

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
    detail.view = parseView(await invoke("nyaa_view", { base: prefs.base, id: it.id }));
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

function drawerBodyHtml(d) {
  const v = d.view;
  if (d.state === "loading") return `<div class="ny-d-load"><div class="ny-sk w80"></div><div class="ny-sk w40"></div><div class="ny-sk w80"></div></div>`;
  if (d.state === "error") return `<div class="ny-empty"><b>Страница не открылась</b><p>${esc(d.err)}</p><button type="button" class="btn primary" data-d-retry>Повторить</button></div>`;
  const tabs = `<div class="ny-d-tabs"><button type="button" class="${d.tab === "desc" ? "on" : ""}" data-d-tab="desc">Описание</button><button type="button" class="${d.tab === "files" ? "on" : ""}" data-d-tab="files">Файлы${v.files.length ? ` · ${v.files.length}` : ""}</button></div>`;
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
        <button type="button" class="btn ghost" data-d-a="open">${ICONS.open} В браузере</button>
      </div>
      <div class="ny-d-grid">${grid.map(([k, val]) => `<div><span>${esc(k)}</span><b>${esc(String(val))}</b></div>`).join("")}
        ${hash ? `<div class="wide"><span>Info hash</span><b class="mono">${esc(hash)}</b></div>` : ""}</div>
      <div class="ny-d-body" id="ny-d-body">${drawerBodyHtml(d)}</div>
      ${d.lightbox != null ? lightboxHtml(d) : ""}
    </aside>`;
}

function lightboxHtml(d) {
  const url = d.view.images[d.lightbox];
  const src = d.imgs[url];
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
    if (t.closest("[data-lb-close]")) { detail.lightbox = null; paintDrawer(); return; }
    if (t.closest("[data-d-close]")) { closeDetail(); return; }
    if (detail) {
      const it = detail.item;
      const tab = t.closest("[data-d-tab]");
      if (tab) { detail.tab = tab.dataset.dTab; $("#ny-d-body").innerHTML = drawerBodyHtml(detail); return; }
      const lb = t.closest("[data-lb]");
      if (lb) { detail.lightbox = Number(lb.dataset.lb); paintDrawer(); return; }
      const io = t.closest("[data-img-open]");
      if (io) { openExternal(io.dataset.imgOpen).catch(() => toast("Не удалось открыть ссылку.", "error")); return; }
      if (t.closest("[data-d-retry]")) { openDetail(it); return; }
      const da = t.closest("[data-d-a]");
      if (da) {
        const a = da.dataset.dA;
        const hash = (detail.view && detail.view.fields["info hash"]) || it.hash;
        if (a === "mag") copy(detail.view && detail.view.magnet ? detail.view.magnet : magnetLink({ ...it, hash }), "Magnet скопирован.");
        else if (a === "tor") saveTorrent(it);
        else if (a === "cp") copy(it.title, "Название скопировано.");
        else if (a === "open") openExternal(pageUrl(it)).catch(() => toast("Не удалось открыть ссылку.", "error"));
        return;
      }
    }
    // источники
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
      if (a.dataset.a === "mag") copy(magnetLink(it), "Magnet скопирован.");
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

export async function loadNyaa() {
  const body = $("#nyaa-body");
  if (!body) return true;
  if (!body.querySelector(".ny")) {
    body.innerHTML = shellHtml();
    paintStatic();
    wire(body.querySelector(".ny"));
  }
  // Свежий список при открытии вкладки, но не чаще раза в 2 минуты.
  if (!items.length || Date.now() - fetchedAt > 120_000) await load();
  else paintList();
  return !error;
}
