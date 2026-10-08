// Страница «Релизы» (Nyaa): живая подборка из публичной RSS-ленты прямо во
// вкладке — не нужно заходить на сайт. Категории, фильтр доверенных,
// поиск, сортировка, «запомнить запрос», выбор строк и копирование magnet /
// ссылок / названий пачкой. Программа ничего не скачивает: сохраняется
// только маленький .torrent и только по кнопке. Сеть — Rust (nyaa.rs),
// разбор — nyaa-core.js. Вкладка только для админов, как и Nyaa в боте.

import { invoke, openExternal, pickOutputFile } from "./tauri.js";
import { toast } from "./api.js";
import { $, esc } from "./utils.js";
import {
  CATEGORIES, FILTERS, parseNyaaRss, magnetLink, sortItems, relTime, fmtDate,
  splitTitle, categoryKind, summarize, fmtBytes, torrentFileName,
} from "./nyaa-core.js";

const KEY = "project-nyaa";
const QUICK_CATS = [["2_1", "Аудио без потерь"], ["1_2", "Аниме · англ. субтитры"], ["1_4", "Аниме · raw"], ["1_3", "Аниме · другие языки"], ["0_0", "Всё"]];
const SORTS = [["date", "Новые"], ["seeders", "Раздают"], ["downloads", "Скачивают"], ["size", "Размер"]];
const KIND_ICON = { anime: "🎬", audio: "♪", video: "▶", other: "•" };

function loadPrefs() {
  const d = { cat: "2_1", filter: "0", q: "", sort: "date", saved: [] };
  try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch (_) { return d; }
}
const prefs = loadPrefs();
const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) { /* не запомнится */ } };

let items = [];
let loading = false;
let error = "";
let fetchedAt = 0;
const selected = new Set();

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  torrent: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  magnet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v7a7 7 0 0 0 14 0V4h-4v7a3 3 0 0 1-6 0V4zM5 7h4M15 7h4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 16V6a2 2 0 0 1 2-2h8"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H10l-5 4z"/></svg>',
};

function view() {
  return sortItems(items, prefs.sort, "desc");
}

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
    <div class="ny-row${it.trusted ? " tr" : ""}${it.remake ? " rm" : ""}${selected.has(it.id) ? " sel" : ""}" data-id="${it.id}">
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
        <button type="button" class="ny-ib" data-a="mag" title="Копировать magnet" aria-label="Копировать magnet">${ICONS.magnet}</button>
        <button type="button" class="ny-ib" data-a="tor" title="Сохранить .torrent" aria-label="Сохранить .torrent">${ICONS.torrent}</button>
        <button type="button" class="ny-ib" data-a="cp" title="Копировать название" aria-label="Копировать название">${ICONS.copy}</button>
        <button type="button" class="ny-ib" data-a="open" title="Открыть страницу на Nyaa" aria-label="Открыть страницу на Nyaa">${ICONS.open}</button>
      </div>
    </div>`;
}

function skeleton() {
  return Array.from({ length: 8 }, () => `<div class="ny-row sk"><span class="ny-kind"></span><div class="ny-main"><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div></div>`).join("");
}

function listHtml() {
  if (loading && !items.length) return skeleton();
  if (error && !items.length) {
    return `<div class="ny-empty"><b>Не получилось загрузить</b><p>${esc(error)}</p><button type="button" class="btn primary" id="ny-retry">Повторить</button><p class="ny-hint">Если Nyaa у вас открывается только через VPN, включите его и повторите.</p></div>`;
  }
  const list = view();
  if (!list.length) return `<div class="ny-empty"><b>Ничего не найдено</b><p>Попробуйте другое слово или категорию.</p></div>`;
  const maxSeed = Math.max(...list.map(i => i.seeders), 1);
  const now = Date.now();
  return list.map(i => rowHtml(i, maxSeed, now)).join("");
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
        <p>Свежие раздачи из публичной ленты — не нужно заходить на сайт. Копируйте magnet и ссылки пачкой или сохраняйте .torrent.</p></div>
      <div class="ny-stats" id="ny-stats"></div>
    </header>
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
      <button type="button" class="ny-ib wide" id="ny-refresh" title="Обновить список" aria-label="Обновить список">${ICONS.refresh}</button>
    </div>
    <div class="ny-saved" id="ny-saved"></div>
    <div class="ny-sel-all"><label><input type="checkbox" id="ny-all"> выбрать всё в списке</label><span id="ny-upd"></span></div>
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
}

function paintList() {
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
  const refresh = $("#ny-refresh");
  refresh?.classList.add("spin");
  paintList();
  try {
    const xml = await invoke("nyaa_rss", { query: prefs.q, category: prefs.cat, filter: prefs.filter });
    items = parseNyaaRss(xml);
    fetchedAt = Date.now();
    selected.clear();
  } catch (e) {
    error = String(e && e.message ? e.message : e);
    items = [];
  }
  loading = false;
  refresh?.classList.remove("spin");
  paintList();
}

async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg, "success"); }
  catch (_) { toast("Не удалось скопировать.", "error"); }
}

const byId = id => items.find(i => i.id === id);

async function saveTorrent(it) {
  const out = await pickOutputFile(torrentFileName(it), [{ name: "Torrent", extensions: ["torrent"] }]);
  if (!out) return;
  try { await invoke("nyaa_save_torrent", { id: it.id, path: out }); toast("Файл .torrent сохранён.", "success"); }
  catch (e) { toast(`Не удалось сохранить: ${e}`, "error"); }
}

function bulk(kind) {
  const list = view().filter(i => selected.has(i.id));
  if (kind === "clear") { selected.clear(); paintList(); return; }
  if (!list.length) return;
  if (kind === "mag") copy(list.map(magnetLink).filter(Boolean).join("\n"), `Скопировано magnet: ${list.length}`);
  else if (kind === "titles") copy(list.map(i => i.title).join("\n"), `Скопировано названий: ${list.length}`);
  else if (kind === "links") copy(list.map(i => i.pageUrl).join("\n"), `Скопировано ссылок: ${list.length}`);
}

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
  root.addEventListener("click", e => {
    const cat = e.target.closest("[data-cat]");
    if (cat) { prefs.cat = cat.dataset.cat; savePrefs(); paintStatic(); load(); return; }
    const f = e.target.closest("[data-filter]");
    if (f) { prefs.filter = f.dataset.filter; savePrefs(); paintStatic(); load(); return; }
    const s = e.target.closest("[data-sort]");
    if (s) { prefs.sort = s.dataset.sort; savePrefs(); paintStatic(); paintList(); return; }
    const sv = e.target.closest("[data-saved]");
    if (sv) { const x = prefs.saved[Number(sv.dataset.saved)]; if (x) { prefs.q = x.q; prefs.cat = x.cat; q.value = x.q; savePrefs(); paintStatic(); load(); } return; }
    const sd = e.target.closest("[data-saved-del]");
    if (sd) { prefs.saved.splice(Number(sd.dataset.savedDel), 1); savePrefs(); paintStatic(); return; }
    if (e.target.closest("#ny-retry")) { load(); return; }
    const b = e.target.closest("[data-bulk]");
    if (b) { bulk(b.dataset.bulk); return; }
    const row = e.target.closest(".ny-row[data-id]");
    if (!row) return;
    const it = byId(Number(row.dataset.id));
    if (!it) return;
    const a = e.target.closest("[data-a]");
    if (a) {
      if (a.dataset.a === "mag") copy(magnetLink(it), "Magnet скопирован.");
      else if (a.dataset.a === "tor") saveTorrent(it);
      else if (a.dataset.a === "cp") copy(it.title, "Название скопировано.");
      else if (a.dataset.a === "open") openExternal(it.pageUrl).catch(() => toast("Не удалось открыть ссылку.", "error"));
      return;
    }
    if (e.target.closest(".ny-ck") || !e.target.closest("button, a")) {
      if (selected.has(it.id)) selected.delete(it.id); else selected.add(it.id);
      row.classList.toggle("sel", selected.has(it.id));
      const cb = row.querySelector("input[type=checkbox]"); if (cb) cb.checked = selected.has(it.id);
      const bar = $("#ny-bar"); bar.innerHTML = barHtml(); bar.hidden = !selected.size;
      const all = $("#ny-all"); if (all) all.checked = view().every(i => selected.has(i.id));
    }
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
