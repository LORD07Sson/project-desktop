// Игровое пространство («Кого войдём?» → профиль Steam): отдельная оболочка со своими разделами —
// Магазин, Скидки, Желаемое, Библиотека, Настройки. Данные — только с нашего сервера (/api/games/*),
// который берёт их у официальных точек Steam. Игры запускаются из СВОЕЙ библиотеки через steam://run/<id>,
// то есть лицензионной копией через клиент Steam.

import { apiGet, apiPost, apiDelete, mediaUrl, ensureMediaToken, toast, openSheet, dismissSheet, dialogSkeletonHtml } from "./api.js";
import { openExternal } from "./tauri.js";
import { $, esc } from "./utils.js";
import { alertText, sortWishlist, sortLibrary, badgesOf, achSummary, statLabel, friendState, xpProgress, reviewSummary, wishStatus, wishFilter, seriesChart, pointAt, fmtCompact, dayLabel, chunk, addDays, mondayOf, isoWeek, monthWeeks, rollingWeeks, monthTab, nextMonths, priceView, fmtHours, isSteamLaunchUrl, initials2, imageCandidates, hueOf, fmtNum, shortDate, deltaView, miniLine, groupByDate, untilText, pctText } from "./games-core.js";
import { linkSteam } from "./steam-link.js";
import { galleryHtml, mountGallery } from "./games-media.js";
import { tabsHtml, panelHtml, STAB_SHOWN } from "./games-tabs.js";
import { createHero } from "./games-hero.js";
import { notifyDesktop, notifyKinds, setNotifyKind } from "./desktop-notify.js";

const TABS = [["store", "Магазин"], ["charts", "Чарты"], ["rel", "Релизы"], ["deals", "Скидки"], ["wish", "Желаемое"], ["lib", "Библиотека"], ["profile", "Профиль"], ["set", "Настройки"]];

let me = null;                 // ответ /games/me
let lib = null;                // { steamid, items, ids:Set }
let tab = "store";
let deals = { min: 10, maxprice: 0, minpct: 0, sort: "discount", tag: 0, q: "", items: [], total: 0, all: 0, seq: 0 };
let wishMode = "all", wishQ = "";
let searchTimer = 0, searchSeq = 0;
let libFilter = "";
let wishSort = "close", libSort = "recent", libUnplayed = false;
let libFamily = false;
let tagList = null;
let dealsTimer = 0, wishTimer = 0;
const POLL_KEY = "project_games_poll";
const pollMs = () => { try { return Math.max(60000, Number(localStorage.getItem(POLL_KEY)) || 120000); } catch (_) { return 120000; } };
let chartTab = "overview";
const CHART_TABS = [["overview", "Сводка"], ["online", "Онлайн сейчас"], ["trending", "Тренды"], ["releases", "Новые релизы"], ["upcoming", "Скоро выйдут"], ["changes", "Изменения цен"]];

const gmSheet = (html, variant) => { const o = openSheet(html, variant); o.classList.add("gm-show"); return o; };
const img = url => (url ? mediaUrl("/img_proxy", { url }) : "");

// Обложка с запасными адресами: если картинка не открылась, пробуем следующий адрес, а в конце рисуем заглушку с инициалами.
function picHtml(appid, primary, name, cls = "gm-img", extra = "") {
  const list = imageCandidates(appid, primary);
  const src = list.length ? img(list[0]) : "";
  return `<div class="${cls}${src ? "" : " noimg"}" style="--h:${hueOf(name)}" data-ini="${esc(initials2(name))}">${src ? `<img loading="lazy" src="${esc(src)}" data-id="${Number(appid) || 0}" data-n="0" data-p="${esc(primary || "")}" alt="">` : ""}${extra}</div>`;
}
const activeAcc = () => (me && (me.accounts || []).find(a => a.steamid === me.steamid)) || null;

function ensureShell() {
  let el = $("#games-screen");
  if (el) return el;
  el = document.createElement("div");
  el.id = "games-screen";
  el.hidden = true;
  el.innerHTML = `
    <header class="gm-top">
      <button type="button" class="gm-who" id="gm-who" title="Сменить профиль"></button>
      <nav class="gm-nav" id="gm-nav" aria-label="Игры">${TABS.map(([k, l]) => `<button type="button" data-gtab="${k}">${l}</button>`).join("")}</nav>
      <button type="button" class="gm-beta" id="gm-beta" title="Что значит Beta">Beta</button>
      <form class="gm-search" id="gm-search" autocomplete="off"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input id="gm-q" type="text" placeholder="Найти игру" spellcheck="false" list="gm-sug"><datalist id="gm-sug"></datalist></form>
    </header>
    <main class="gm-body" id="gm-body"></main>`;
  $("#app-screen").after(el);
  el.addEventListener("click", onClick);
  $("#gm-search").addEventListener("submit", e => { e.preventDefault(); runSearch(); });
  $("#gm-q").addEventListener("input", () => { suggestTimer = clearTimeout(suggestTimer) || setTimeout(loadSuggest, 200); }); // DevSkim: ignore DS172411 — функция, не строка
  $("#gm-q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 450); }); // DevSkim: ignore DS172411 — функция, не строка
  return el;
}

function paintWho() {
  const a = activeAcc();
  const av = a && a.avatar ? `<img src="${esc(img(a.avatar))}" alt="">` : `<span>${esc(initials2(a && a.name))}</span>`;
  $("#gm-who").innerHTML = `<i class="gm-ava">${av}</i><span class="gm-who-t"><b>${esc((a && a.name) || "Steam")}</b><small>Игры · сменить профиль</small></span><svg class="gm-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
}

export function gamesVisible() { const el = $("#games-screen"); return !!el && !el.hidden; }

/** Открывает игровую оболочку для профиля (me — ответ /games/me). Показывает/скрывает экраны сам spaces.js. */
// Предупреждение о бета-версии: при входе в «Игры», пока не отмечено «больше не показывать». Кнопка Beta в шапке открывает его снова.
const BETA_KEY = "project-games-beta-ok";
let betaShown = false;
function maybeWarnBeta(force = false) {
  let skip = false;
  try { skip = localStorage.getItem(BETA_KEY) === "1"; } catch (_) { /* покажем окно */ }
  if (!force && (betaShown || skip)) return;
  betaShown = true;
  const ov = gmSheet(`
    <div class="nda">
      <span class="kd-label">Бета-версия</span>
      <h2>Игры (Beta)</h2>
      <p>Привет! Я впервые работаю с ИИ-помощником для программирования, и примерно половину этого раздела он сделал сам: получилось что-то вроде «50 на 50».</p>
      <p>Сразу скажу честно: не всё здесь так идеально, как хотелось бы. Я развиваю раздел по мере возможностей, поэтому, пожалуйста, не ругайте меня. Идеально с первого раза не бывает: работа может идти годами, с множеством правок и ошибок. Будем дорабатывать, как умеем.</p>
      <p>Если заметите ошибку или у вас есть идея, напишите администратору. Рады всем!</p>
      <label class="ny-beta-ck"><input type="checkbox" id="gm-beta-skip"> Больше не показывать</label>
      <div class="nda-actions"><button class="btn primary" id="gm-beta-ok">Понятно</button></div>
    </div>`);
  ov.classList.add("gm-beta-ov");
  ov.querySelector("#gm-beta-ok").addEventListener("click", () => {
    if (ov.querySelector("#gm-beta-skip").checked) { try { localStorage.setItem(BETA_KEY, "1"); } catch (_) { /* покажем снова */ } }
    dismissSheet(ov);
  });
}

export async function enterGames(me0) {
  ensureShell();
  await ensureMediaToken();      // без токена mediaUrl() отдаёт пустой адрес и картинки не появятся
  me = me0;
  paintWho();
  lib = null;
  switchG(tab);
  loadLibrary().catch(() => {});
  startAlertPolling();
  maybeWarnBeta();
}

// Уведомления о цене: сервер проверяет желаемое раз в 30 минут и копит записи; здесь забираем новые.
// Окно в фокусе — тост, иначе системная всплывашка (правила «не мешать» — в notifyDesktop). Прочитанное помечаем.
let alertTimer = 0;
async function pollAlerts() {
  try {
    const r = await apiGet("/games/alerts?unseen=1");
    const items = (r && r.items) || [];
    if (!items.length) return;
    for (const a of items.slice(0, 5)) {
      const t = alertText(a);
      if (document.hasFocus()) toast(`${t.title}. ${t.body}`, "success"); else notifyDesktop(t.title, t.body, "price");
    }
    await apiPost("/games/alerts/seen", { ids: items.map(a => a.id) });
    if (tab === "wish" && gamesVisible()) paintWish();
  } catch (_) { /* сеть или сервер недоступны — попробуем в следующий раз */ }
}
function startAlertPolling() {
  if (alertTimer) return;
  pollAlerts();
  alertTimer = setInterval(pollAlerts, pollMs()); // DevSkim: ignore DS172411 — функция, не строка
}
function restartAlertPolling() { clearInterval(alertTimer); alertTimer = 0; startAlertPolling(); }

export function resetGames() {
  me = null; lib = null; tab = "store"; storeHome = null; storeBrowse = null; storeCal = null; heroCtl.stop();
  const b = $("#gm-body"); if (b) b.innerHTML = "";
}

async function loadLibrary(force) {
  if (!me || !me.steamid) { lib = null; return null; }
  if (lib && lib.steamid === me.steamid && lib.family === libFamily && !force) return lib;
  const r = await apiGet("/games/library", { steamid: me.steamid, family: libFamily ? 1 : 0 });
  lib = { steamid: r.steamid, family: libFamily, items: r.items || [], ids: new Set((r.items || []).map(g => g.appid)) };
  return lib;
}

// ---------- разделы ----------
function switchG(name) {
  tab = name;
  heroCtl.stop();
  clearInterval(relCycle);
  $("#gm-nav").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.gtab === name));
  const q = $("#gm-q");
  if (q && name !== "store") q.value = "";
  ({ store: paintStore, charts: paintCharts, deals: paintDeals, wish: paintWish, lib: paintLib, rel: paintReleases, profile: paintProfile, set: paintSettings }[name] || paintStore)();
}

const skeleton = (n = 10) => `<div class="gm-grid">${Array.from({ length: n }, () => `<div class="gm-card sk"><div class="gm-img"><span class="ny-sk blk"></span></div><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div>`).join("")}</div>`;
const empty = (title, text, btn = "") => `<div class="gm-empty"><b>${esc(title)}</b><p>${esc(text)}</p>${btn}</div>`;
const errBox = e => empty("Не получилось загрузить", e && e.message ? e.message : String(e), `<button type="button" class="btn" data-gretry>Повторить</button>`);

function cardHtml(g, extra = "") {
  const v = priceView(g.price);
  const owned = lib && lib.ids.has(g.appid);
  return `<button type="button" class="gm-card${owned ? " owned" : ""}" data-app="${g.appid}" data-name="${esc(g.name)}">
    ${picHtml(g.appid, g.image, g.name, "gm-img", `${v.badge ? `<i class="gm-badge">${v.badge}</i>` : ""}${owned ? `<i class="gm-own" title="Есть в вашей библиотеке">✓</i>` : ""}${g.wishlisted ? `<i class="gm-heart" title="В желаемом">♥</i>` : ""}`)}
    <div class="gm-t">${esc(g.name)}</div>
    <div class="gm-pr">${g.price == null && g.label ? `<b>${esc(g.label)}</b>` : `${v.old ? `<s>${esc(v.old)}</s>` : ""}<b class="${v.sale ? "sale" : ""}">${esc(v.now)}</b>`}${g.pct && g.reviews >= 50 ? `<small class="gm-rv" title="${fmtNum(g.reviews)} отзывов">👍 ${g.pct}%</small>` : ""}</div>${extra}</button>`;
}

let storeHome = null, storeBrowse = null, storeCal = null;

function railSection(title, items, more = "") {
  if (!items || !items.length) return "";
  return `<section class="gm-sec"><h3>${esc(title)}${more}</h3><div class="gm-railw"><button type="button" class="gm-rail-b l" data-rail="-1" aria-label="Назад">‹</button><div class="gm-rail">${items.map(g => cardHtml(g)).join("")}</div><button type="button" class="gm-rail-b r" data-rail="1" aria-label="Вперёд">›</button></div></section>`;
}


// Герой главной: арт с логотипом, карточка цвета арта, миниатюры и точки (логика — в games-hero.js).
const heroCtl = createHero({
  img, hueOf,
  owned: id => !!(lib && lib.ids && lib.ids.has(Number(id))),
  friends: async ids => (me && me.steamid ? apiGet("/games/store/hero-friends", { ids: ids.join(",") }) : { items: {} }),
  active: () => tab === "store",
});
const heroHtml = list => heroCtl.html(list);

// Карусели-страницы (скидки, календарь): дорожка с переключением страниц, стрелки и точки.
const pagerIdx = {};
function pagerGo(key, to) {
  const root = document.querySelector(`[data-pg="${key}"]`);
  if (!root) return;
  const n = root.querySelectorAll(".gm-pg-page").length;
  const i = Math.max(0, Math.min(n - 1, to));
  pagerIdx[key] = i;
  root.querySelector(".gm-pg-track").style.transform = `translateX(-${i * 100}%)`;
  root.querySelectorAll("[data-pgdot]").forEach((el, j) => el.classList.toggle("on", j === i));
  root.querySelectorAll("[data-pgnav]").forEach(el => { el.disabled = (Number(el.dataset.pgnav.split(":")[1]) < 0 && i === 0) || (Number(el.dataset.pgnav.split(":")[1]) > 0 && i === n - 1); });
}
const pagerHtml = (key, pages, cls = "") => `<div class="gm-pg-wrap"><button type="button" class="gm-fh-nav l" data-pgnav="${key}:-1" aria-label="Назад" disabled>‹</button><div class="gm-pg-view"><div class="gm-pg-track">${pages.map(p => `<div class="gm-pg-page ${cls}">${p}</div>`).join("")}</div></div><button type="button" class="gm-fh-nav r" data-pgnav="${key}:1" aria-label="Вперёд"${pages.length < 2 ? " disabled" : ""}>›</button></div>`
  + (pages.length > 1 ? `<div class="gm-fh-dots">${pages.map((_, i) => `<button type="button" class="${i === 0 ? "on" : ""}" data-pgdot="${key}:${i}" aria-label="Страница ${i + 1}"></button>`).join("")}</div>` : "");

function dealsPagerHtml(h) {
  const items = h.deals || [];
  if (!items.length) return "";
  const card = g => { const v = priceView(g.price); return `<button type="button" class="gm-dcard" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.image, g.name, "gm-img gm-dimg", `${lib && lib.ids.has(g.appid) ? `<i class="gm-own" title="Есть в вашей библиотеке">✓</i>` : ""}`)}<div class="gm-dprice"><span class="gm-dn">${esc(g.name)}</span><span class="gm-dp2"><i class="gm-badge sm">${v.badge}</i><span>${v.old ? `<s>${esc(v.old)}</s>` : ""}<b>${esc(v.now)}</b></span></span></div></button>`; };
  const pages = chunk(items, 8).map(pg => pg.map(card).join(""));
  return `<section class="gm-sec gm-pg" data-pg="deals"><h3>Скидки и акции<button type="button" class="ny-link" data-gtab-go="deals">Все ${fmtNum(h.deals_total)} →</button></h3>${pagerHtml("deals", pages, "gm-dgrid")}</section>`;
}

function calendarHtml(days) {
  const col = d => {
    const lb = dayLabel(d.date);
    const its = d.items.map((it, k) => `<button type="button" class="gm-cd-it" data-app="${it.appid}" data-name="${esc(it.name)}">${picHtml(it.appid, it.image, it.name, "gm-img gm-cap", `${it.wishlisted ? `<i class="gm-flag wl">В ЖЕЛАЕМОМ</i>` : it.owned ? `<i class="gm-flag own">В БИБЛИОТЕКЕ</i>` : ""}${k === d.items.length - 1 && d.count > d.items.length ? `<span class="gm-cd-pill" data-rday="${d.date}">и ещё ${d.count - d.items.length}</span>` : ""}`)}</button>`).join("");
    return `<div class="gm-cd"><div class="gm-cd-h"><b>${lb.dow}</b><span>${lb.date}</span></div>${its}</div>`;
  };
  const pages = chunk(days, 5).map(pg => pg.map(col).join(""));
  return `<section class="gm-cal gm-pg" data-pg="cal"><div class="gm-cal-h"><div><span class="gm-newb">НОВОЕ</span><b>Ваш личный календарь</b><small>Персональный список новых и готовящихся к выходу игр: то, что вы ждёте, идёт первым</small></div><div class="gm-cal-r">${adultLabel()}<button type="button" class="btn sm" data-rgo="list">Показать больше</button></div></div>${pagerHtml("cal", pages, "gm-cal-cols")}</section>`;
}

async function loadCalendar() {
  try { if (!storeCal) storeCal = (await apiGet("/games/store/calendar", { adult: adultParam() })).days || []; } catch (_) { return; }
  const box = $("#gm-cal");
  if (!box || !storeCal.length || tab !== "store" || storeBrowse) return;
  box.innerHTML = calendarHtml(storeCal);
}

const genreChips = () => `<div class="gm-chips">${storeBrowse ? `<button type="button" class="gm-chip" data-sback>← Магазин</button>` : ""}${[[0, 0, "Популярное"]].filter(() => false).join("")}<button type="button" class="gm-chip${storeBrowse && storeBrowse.soon ? " on" : ""}" data-sbrowse="soon">Скоро выйдут</button><button type="button" class="gm-chip${storeBrowse && storeBrowse.discount && !storeBrowse.tag ? " on" : ""}" data-sbrowse="sale">Со скидкой</button>${(tagList || []).map(t => `<button type="button" class="gm-chip${storeBrowse && storeBrowse.tag === t.id ? " on" : ""}" data-sbrowse="${t.id}" data-sname="${esc(t.name)}">${esc(t.name)}</button>`).join("")}</div>`;

async function paintStore() {
  heroCtl.stop();
  const body = $("#gm-body");
  const q = $("#gm-q").value.trim();
  if (q.length >= 2) return runSearch();
  if (storeBrowse) return paintBrowse();
  body.innerHTML = skeleton();
  try {
    if (!tagList) { try { tagList = (await apiGet("/games/tags")).items || []; } catch (_) { tagList = []; } }
    if (!storeHome) storeHome = await apiGet("/games/store/home");
    if (tab !== "store" || $("#gm-q").value.trim().length >= 2 || storeBrowse) return;
    const h = storeHome;
    const sec = h.sections || [];
    const rows = sec.map(x => railSection(x.title, x.items, x.go ? `<button type="button" class="ny-link" data-gtab-go="${x.go}">все →</button>` : "")).join("");
    body.innerHTML = `<div class="gm-sh">` + heroHtml(h.hero) + genreChips() + dealsPagerHtml(h) + `<section class="gm-stabs" id="gm-stabs"></section><div id="gm-cal"></div><div id="gm-foryou"></div>` + (rows || empty("Пусто", "Steam не вернул подборки.")) + `</div>`;
    heroCtl.start();
    loadStabs();
    loadForYou();
    loadCalendar();
  } catch (e) { body.innerHTML = errBox(e); }
}

// Вкладки витрины («Популярные новинки», «Лидеры продаж», …): список слева, подробности выбранной игры справа.
const stab = { tab: "new", cache: {}, items: [], free: true, owned: false, more: false, sel: 0 };
const stabKey = () => `${stab.tab}|${adultOn() ? 1 : 0}|${stab.free ? 1 : 0}|${stab.owned ? 1 : 0}`;

function paintStabs() {
  const box = $("#gm-stabs");
  if (box) box.innerHTML = tabsHtml(stab, stab.items, picHtml, img);
}

async function loadStabs() {
  const box = $("#gm-stabs");
  if (!box || tab !== "store" || storeBrowse) return;
  const key = stabKey();
  stab.items = stab.cache[key] || [];
  if (!stab.cache[key]) {
    box.innerHTML = tabsHtml(stab, [], picHtml, img).replace(/<div class="gm-stabs-empty">[^]*?<\/div>/, `<div class="gm-stabs-empty"><span class="ny-spin"></span> Загружаю…</div>`);
    try {
      const r = await apiGet("/games/store/tabs", { tab: stab.tab, adult: adultParam(), free: stab.free ? 1 : 0, owned: stab.owned ? 1 : 0 });
      stab.cache[key] = r.items || [];
    } catch (e) { if ($("#gm-stabs") === box) box.innerHTML = errBox(e); return; }
    if (stabKey() !== key || $("#gm-stabs") !== box) return;     // за время запроса переключили вкладку
    stab.items = stab.cache[key];
  }
  paintStabs();
}

async function loadForYou() {
  if (!me || !me.steamid) return;
  try {
    const r = await apiGet("/games/store/foryou");
    const box = $("#gm-foryou");
    if (!box || !r.items || !r.items.length) return;
    box.innerHTML = railSection("Для вас", r.items, `<small class="gm-because">по вашим играм: ${esc((r.because || []).join(", "))}${r.tags && r.tags.length ? ` · ${esc(r.tags.join(", "))}` : ""}</small>`);
  } catch (_) { /* подборка необязательна */ }
}

async function paintBrowse(more = false) {
  const body = $("#gm-body");
  const b = storeBrowse;
  if (!more) body.innerHTML = genreChips() + skeleton(12);
  try {
    const r = await apiGet("/games/browse", { tag: b.tag || "", sort: b.sort, discount: b.discount || "", soon: b.soon ? 1 : "", start: more ? b.items.length : 0 });
    if (tab !== "store" || storeBrowse !== b) return;
    b.items = more ? b.items.concat(r.items) : r.items;
    b.total = r.total;
    const seg = [["popular", "Популярное"], ["new", "Новое"]].map(([k, l]) => `<button type="button" class="${b.sort === k ? "on" : ""}" data-ssort="${k}">${l}</button>`).join("");
    const dis = [[0, "Все"], [30, "Скидки от −30%"], [50, "от −50%"]].map(([k, l]) => `<button type="button" class="${(b.discount || 0) === k ? "on" : ""}" data-sdisc="${k}">${l}</button>`).join("");
    body.innerHTML = genreChips() + `<div class="gm-bar"><strong class="gm-bt">${esc(b.name)}</strong><span class="gm-count">${fmtNum(b.total)} игр</span><span class="ny-sp"></span><div class="ny-seg">${seg}</div><div class="ny-seg">${dis}</div></div>`
      + (b.items.length ? `<div class="gm-grid">${b.items.map(g => cardHtml(g)).join("")}</div>` : empty("Ничего не найдено", "Попробуйте другой фильтр."))
      + (b.items.length < b.total ? `<div class="gm-moreb"><button type="button" class="btn" data-smore>Показать ещё</button></div>` : "");
  } catch (e) { body.innerHTML = genreChips() + errBox(e); }
}

function openBrowse(patch) {
  storeBrowse = { tag: 0, name: "Каталог", sort: "popular", discount: 0, soon: 0, items: [], total: 0, ...(storeBrowse || {}), ...patch };
  paintBrowse();
}

let suggestTimer = 0;
// Подсказки названий: сервер ищет по полному списку игр Steam (IStoreService/GetAppList), без запросов в магазин.
async function loadSuggest() {
  const q = $("#gm-q").value.trim();
  const dl = $("#gm-sug");
  if (!dl || q.length < 2) { if (dl) dl.innerHTML = ""; return; }
  try {
    const r = await apiGet("/games/suggest", { q });
    if ($("#gm-q").value.trim() === q) dl.innerHTML = r.items.map(i => `<option value="${esc(i.name)}"></option>`).join("");
  } catch (_) { /* подсказки необязательны */ }
}

async function runSearch() {
  const q = $("#gm-q").value.trim();
  if (tab !== "store") { $("#gm-nav").querySelector('[data-gtab="store"]').click(); return; }
  if (q.length < 2) { paintStore(); return; }
  const my = ++searchSeq;
  const body = $("#gm-body");
  body.innerHTML = skeleton(8);
  try {
    const r = await apiGet("/games/search", { q });
    if (my !== searchSeq) return;
    body.innerHTML = r.items.length ? `<section class="gm-sec"><h3>Результаты: ${esc(q)}</h3><div class="gm-grid">${r.items.map(g => cardHtml(g)).join("")}</div></section>` : empty("Ничего не найдено", "Попробуйте другое название.");
  } catch (e) { if (my === searchSeq) body.innerHTML = errBox(e); }
}

// ---------- чарты (как на SteamDB: онлайн, тренды, релизы, скоро, изменения цен) ----------
const tableSkeleton = (n = 12) => `<div class="gm-tbl" style="--cols:36px 100px minmax(0,1fr) 120px 120px">${Array.from({ length: n }, () => `<div class="gm-tr sk"><span class="ny-sk w40"></span><span class="ny-sk blk2"></span><span class="ny-sk w80"></span><span class="ny-sk w60"></span><span class="ny-sk w60"></span></div>`).join("")}</div>`;
const trow = (g, cells, rank = "") => `<div class="gm-tr" data-app="${g.appid}" data-name="${esc(g.name)}"><span class="gm-rk">${rank}</span>${picHtml(g.appid, g.image, g.name, "gm-img gm-tth")}<span class="gm-tn">${esc(g.name)}</span>${cells}</div>`;
const thead = labels => `<div class="gm-tr gm-th">${labels.map(l => `<span>${l}</span>`).join("")}</div>`;
const priceCell = p => { const v = priceView(p); return `<span class="gm-tc gm-pr">${v.badge ? `<i class="gm-badge sm">${v.badge}</i>` : ""}<b class="${v.sale ? "sale" : ""}">${p ? esc(v.now) : "Бесплатно"}</b></span>`; };

async function chartOverview() {
  const [on, tr] = await Promise.all([apiGet("/games/charts/online"), apiGet("/games/charts/trending").catch(() => ({ items: [] }))]);
  const upd = $("#gm-upd"); if (upd) upd.textContent = `обновлено ${new Date(on.updated * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  const left = `<section class="gm-panel"><h3 class="gm-ph">Самые играемые<button type="button" class="gm-more-l" data-ctab="online">все →</button></h3><div class="gm-tbl sm" style="--cols:28px 76px minmax(0,1fr) 96px 96px">${thead(["#", "", "Игра", "Сейчас", "Пик за 24 ч"])}${on.items.slice(0, 15).map((g, i) => trow(g, `<span class="gm-tc gm-green">${fmtNum(g.now)}</span><span class="gm-tc">${fmtNum(g.peak)}</span>`, i + 1)).join("")}</div></section>`;
  const right = `<section class="gm-panel"><h3 class="gm-ph">В тренде<button type="button" class="gm-more-l" data-ctab="trending">все →</button></h3>${tr.items.length ? `<div class="gm-tbl sm" style="--cols:28px 76px minmax(0,1fr) 100px 90px">${thead(["#", "", "Игра", "7 дней", "Сейчас"])}${tr.items.slice(0, 15).map((g, i) => {
    const path = miniLine(g.spark);
    return trow(g, `<span class="gm-tc">${path ? `<svg class="gm-mini" viewBox="0 0 90 24"><path d="${path}"/></svg>` : `<small class="ny-hint">${esc(deltaView(g.delta, g.new).text)}</small>`}</span><span class="gm-tc gm-green">${fmtNum(g.now)}</span>`, i + 1);
  }).join("")}</div>` : empty("Пока нет данных", "Steam не вернул недельный рейтинг.")}</section>`;
  return `<div class="gm-two">${left}${right}</div>`;
}

async function chartOnline() {
  const r = await apiGet("/games/charts/online");
  const upd = $("#gm-upd"); if (upd) upd.textContent = `обновлено ${new Date(r.updated * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  return `<div class="gm-tbl" style="--cols:36px 100px minmax(0,1fr) 130px 130px">${thead(["#", "", "Игра", "Онлайн сейчас", "Пик за 24 ч"])}${r.items.map((g, i) => trow(g, `<span class="gm-tc gm-green">${fmtNum(g.now)}</span><span class="gm-tc">${fmtNum(g.peak)}</span>`, i + 1)).join("")}</div>`;
}

async function chartTrending() {
  const r = await apiGet("/games/charts/trending");
  if (!r.items.length) return empty("Пока нет данных", "Steam не вернул недельный рейтинг.");
  return `<p class="ny-hint gm-note">Рост места в недельном рейтинге по онлайну. Линия справа появится, когда мы накопим историю онлайна игры.</p><div class="gm-tbl" style="--cols:36px 100px minmax(0,1fr) 90px 110px 120px">${thead(["#", "", "Игра", "Рост", "7 дней", "Онлайн сейчас"])}${r.items.map((g, i) => {
    const d = deltaView(g.delta, g.new);
    const path = miniLine(g.spark);
    return trow(g, `<span class="gm-tc gm-d ${d.cls}">${d.text}</span><span class="gm-tc">${path ? `<svg class="gm-mini" viewBox="0 0 90 24"><path d="${path}"/></svg>` : ""}</span><span class="gm-tc gm-green">${fmtNum(g.now)}</span>`, i + 1);
  }).join("")}</div>`;
}

async function chartReleases() {
  const r = await apiGet("/games/charts/releases");
  const pop = r.popular.length ? `<div class="gm-tbl" style="--cols:100px minmax(0,1fr) 100px 120px">${thead(["", "Популярные релизы", "Онлайн", "Цена"])}${r.popular.map(g => trow(g, `<span class="gm-tc gm-green">${fmtNum(g.now)}</span>${priceCell(g.price)}`)).join("")}</div>` : empty("Нет данных", "");
  const hot = r.hot.length ? `<div class="gm-tbl" style="--cols:100px minmax(0,1fr) 90px 120px">${thead(["", "Горячие релизы", "Рейтинг", "Цена"])}${r.hot.map(g => trow(g, `<span class="gm-tc gm-green">${g.pct}%</span>${priceCell(g.price)}`)).join("")}</div>` : empty("Нет данных", "");
  return `<p class="ny-hint gm-note">Игры, вышедшие за последние 90 дней. Рейтинг — доля положительных отзывов (от 50 отзывов).</p><div class="gm-two">${pop}${hot}</div>`;
}

async function chartUpcoming() {
  const r = await apiGet("/games/charts/upcoming");
  const groups = groupByDate(r.items);
  if (!groups.length) return empty("Пусто", "Steam не вернул ближайшие релизы.");
  return groups.map(gr => `<section class="gm-sec"><h3>${gr.ts ? esc(shortDate(gr.ts)) : "Дата не объявлена"}${gr.ts ? `<small class="gm-until">${esc(untilText(gr.ts))}</small>` : ""}</h3><div class="gm-grid gm-grid-sm">${gr.items.map(g => `<button type="button" class="gm-card" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div>${g.label && !g.date ? `<div class="gm-pr"><small>${esc(g.label)}</small></div>` : ""}</button>`).join("")}</div></section>`).join("");
}

async function chartChanges() {
  const r = await apiGet("/games/charts/price-changes");
  if (!r.items.length) return empty("Пока нет изменений", "Мы фиксируем цену игр, которые вы открывали или добавили в желаемое. Когда цена изменится, она появится здесь.");
  return `<div class="gm-tbl" style="--cols:100px minmax(0,1fr) 120px 120px 90px">${thead(["", "Игра", "Было", "Стало", "Когда"])}${r.items.map(g => {
    const down = g.now < g.was;
    return trow(g, `<span class="gm-tc"><s>${esc(priceView({ final: g.was, initial: g.was, discount: 0, currency: g.currency }).now)}</s></span><span class="gm-tc gm-d ${down ? "up" : "down"}">${esc(priceView({ final: g.now, initial: g.now, discount: 0, currency: g.currency }).now)}</span><span class="gm-tc ny-hint">${esc(shortDate(g.ts))}</span>`);
  }).join("")}</div>`;
}

async function paintCharts() {
  const body = $("#gm-body");
  const seg = CHART_TABS.map(([k, l]) => `<button type="button" class="${chartTab === k ? "on" : ""}" data-ctab="${k}">${l}</button>`).join("");
  body.innerHTML = `<div class="gm-bar"><div class="ny-seg">${seg}</div><span class="ny-sp"></span><span class="gm-count" id="gm-upd"></span></div><div id="gm-chart">${tableSkeleton()}</div>`;
  const my = chartTab;
  try {
    const html = await ({ overview: chartOverview, online: chartOnline, trending: chartTrending, releases: chartReleases, upcoming: chartUpcoming, changes: chartChanges }[chartTab])();
    const box = $("#gm-chart");
    if (tab === "charts" && my === chartTab && box) box.innerHTML = html;
  } catch (e) { const box = $("#gm-chart"); if (box) box.innerHTML = errBox(e); }
}

const DEALS_PAGE = 48;

function dealsBarHtml() {
  const d = deals;
  const chips = [[10, "от −10%"], [25, "от −25%"], [50, "от −50%"], [75, "от −75%"], [90, "от −90%"], [100, "Бесплатно"]].map(([n, l]) => `<button type="button" class="${d.min === n ? "on" : ""}" data-dmin="${n}">${l}</button>`).join("");
  const rev = [[0, "Любые отзывы"], [70, "от 70%"], [85, "от 85%"], [95, "от 95%"]].map(([n, l]) => `<option value="${n}"${d.minpct === n ? " selected" : ""}>${l}</option>`).join("");
  const sorts = [["discount", "по скидке"], ["price", "дешевле сначала"], ["price_desc", "дороже сначала"], ["reviews", "по отзывам"], ["popular", "популярные"], ["name", "по названию"]].map(([k, l]) => `<option value="${k}"${d.sort === k ? " selected" : ""}>${l}</option>`).join("");
  const tags = `<option value="0">Любой жанр</option>` + (tagList || []).map(t => `<option value="${t.id}"${d.tag === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  return `<div class="gm-bar gm-dbar"><div class="ny-seg">${chips}</div><span class="ny-sp"></span>
    <input id="gm-dq" class="gm-lf" type="text" placeholder="Поиск среди скидок" value="${esc(d.q)}" spellcheck="false">
    <input id="gm-dmax" class="gm-lf gm-num" type="number" min="0" step="1" placeholder="Цена до" value="${d.maxprice || ""}">
    <select id="gm-drev" title="Доля положительных отзывов">${rev}</select><select id="gm-dtag">${tags}</select><select id="gm-dsort">${sorts}</select></div>`;
}

function dealsResultHtml() {
  const d = deals;
  if (!d.items.length) return empty("Ничего не найдено", "Ослабьте фильтры: снимите порог цены или отзывов.");
  return `<p class="gm-dcount">Найдено ${fmtNum(d.total)} из ${fmtNum(d.all)} игр со скидкой</p><div class="gm-grid">${d.items.map(g => cardHtml(g)).join("")}</div>`
    + (d.items.length < d.total ? `<div class="gm-moreb"><button type="button" class="btn" data-dmore>Показать ещё ${Math.min(DEALS_PAGE, d.total - d.items.length)}</button></div>` : "");
}

async function loadDeals(more = false) {
  const d = deals, my = ++d.seq;
  const r = await apiGet("/games/deals", { min: d.min, maxprice: d.maxprice || "", minpct: d.minpct || "", sort: d.sort, tag: d.tag || "", q: d.q, start: more ? d.items.length : 0, limit: DEALS_PAGE });
  if (my !== d.seq) return false;
  d.items = more ? d.items.concat(r.items) : r.items;
  d.total = r.total; d.all = r.all;
  return true;
}

async function refreshDeals(more = false) {
  const box = $("#gm-dres");
  if (!box) return;
  if (!more) box.innerHTML = skeleton(12);
  try {
    if (!(await loadDeals(more)) || tab !== "deals") return;
    const cur = $("#gm-dres");
    if (cur) cur.innerHTML = dealsResultHtml();
  } catch (e) { const cur = $("#gm-dres"); if (cur) cur.innerHTML = errBox(e); }
}

async function paintDeals() {
  const body = $("#gm-body");
  if (!tagList) { try { tagList = (await apiGet("/games/tags")).items || []; } catch (_) { tagList = []; } }
  if (tab !== "deals") return;
  body.innerHTML = dealsBarHtml() + `<div id="gm-dres"></div>`;
  refreshDeals();
}

let wishData = null;

function wishRowHtml(w) {
  const st = wishStatus(w);
  const cur = (w.price && w.price.currency) || "";
  const v = priceView(w.price);
  const priceHtml = w.price && w.price.final > 0
    ? `<div class="gm-wp">${v.badge ? `<i class="gm-badge sm">${v.badge}</i>` : ""}${v.old ? `<s>${esc(v.old)}</s>` : ""}<b class="${v.sale ? "sale" : ""}">${esc(v.now)}</b></div>`
    : `<div class="gm-wp none"><b>—</b></div>`;
  return `<div class="gm-wcard${w.hit ? " hit" : ""}" data-app="${w.appid}" data-name="${esc(w.name)}">
    ${picHtml(w.appid, w.image, w.name, "gm-img gm-wimg")}
    <div class="gm-wbody">
      <div class="gm-wtop"><b class="gm-wname">${esc(w.name)}</b><button type="button" class="ny-ib" data-wish-del="${w.appid}" title="Убрать из желаемого" aria-label="Убрать из желаемого"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gm-wmid"><span class="gm-st ${st.kind}">${esc(st.text)}</span>${w.lowest ? `<small class="ny-hint">минимум ${esc(priceView({ final: w.lowest, initial: w.lowest, discount: 0, currency: cur }).now)}</small>` : ""}${w.pct && w.reviews >= 50 ? `<small class="ny-hint">👍 ${w.pct}%</small>` : ""}${priceHtml}</div>
      <div class="gm-wctl"><label>Следить: цена до<input type="number" class="gm-wt" min="0" step="0.01" value="${w.target != null ? w.target : ""}" placeholder="${esc(cur || "—")}" data-w="${w.appid}"></label><label>или скидка от<input type="number" class="gm-wd" min="1" max="95" step="1" value="${w.target_discount != null ? w.target_discount : ""}" placeholder="%" data-w="${w.appid}"></label></div>
    </div></div>`;
}

function wishListHtml() {
  const r = wishData;
  const list = sortWishlist(wishFilter(r.items, wishMode, wishQ), wishSort);
  return list.length ? `<div class="gm-wgrid">${list.map(wishRowHtml).join("")}</div>` : empty("Ничего не найдено", "Смените фильтр или очистите поиск.");
}

function wishBarHtml() {
  const r = wishData;
  const now = Date.now() / 1000;
  const cnt = m => wishFilter(r.items, m, "", now).length;
  const modes = [["all", "Все"], ["sale", "Со скидкой"], ["hit", "Цель достигнута"], ["soon", "Не вышли"], ["noprice", "Без цены"]].map(([k, l]) => `<button type="button" class="${wishMode === k ? "on" : ""}" data-wmode="${k}">${l} <small>${cnt(k)}</small></button>`).join("");
  const sorts = [["close", "ближе к цели"], ["discount", "по скидке"], ["name", "по названию"]].map(([k, l]) => `<option value="${k}"${wishSort === k ? " selected" : ""}>${l}</option>`).join("");
  const syncErr = r.sync && r.sync.error;
  return `<div class="gm-bar"><span class="gm-count">${r.items.length} в списке</span>${r.steam ? `<span class="gm-sync" title="Желаемое из Steam подтягивается автоматически раз в 30 минут">⟳ синхронизируется со Steam</span><button type="button" class="btn sm" data-wl-steam>Обновить</button>` : ""}${syncErr ? `<span class="ny-hint">${esc(syncErr)}</span>` : ""}<span class="ny-sp"></span>
    <input id="gm-wq" class="gm-lf" type="text" placeholder="Поиск по списку" value="${esc(wishQ)}" spellcheck="false"><label class="gm-sort">Сортировка <select id="gm-wsort">${sorts}</select></label></div>
    <div class="gm-bar gm-wmodes"><div class="ny-seg">${modes}</div></div>`;
}

async function paintWish() {
  const body = $("#gm-body");
  body.innerHTML = skeleton(6);
  try {
    const r = await apiGet("/games/wishlist");
    if (tab !== "wish") return;
    wishData = r;
    const syncErr = r.sync && r.sync.error;
    if (!r.items.length) {
      body.innerHTML = r.steam
        ? empty(syncErr ? "Не получилось прочитать желаемое из Steam" : "В желаемом пока ничего нет", syncErr || "Добавьте игру в желаемое в Steam — она появится здесь сама, и мы начнём следить за ценой. Также можно открыть любую игру и нажать «В желаемое».", `<button type="button" class="btn primary" data-wl-steam>Синхронизировать сейчас</button>`)
        : empty("Список желаемого пуст", "Привяжите Steam — желаемое подтянется само. Или откройте игру и нажмите «В желаемое», чтобы следить за ценой.", `<button type="button" class="btn primary" data-gadd>Привязать Steam</button>`);
      return;
    }
    body.innerHTML = `<div id="gm-wbar">${wishBarHtml()}</div><div id="gm-wlist">${wishListHtml()}</div>`;
  } catch (e) { body.innerHTML = errBox(e); }
}

// Быстрая цель прямо в карточке желаемого: сохраняется при выходе из поля.
async function saveWishTarget(card) {
  const appid = Number(card.dataset.app);
  const t = card.querySelector(".gm-wt").value, d = card.querySelector(".gm-wd").value;
  try {
    await apiPost("/games/wishlist", { appid, name: card.dataset.name, target: t || null, target_discount: d || null });
    const w = wishData && wishData.items.find(x => x.appid === appid);
    if (w) { w.target = t ? Number(t) : null; w.target_discount = d ? Number(d) : null; w.hit = !!(w.price && ((w.target && w.price.final <= w.target) || (w.target_discount && w.price.discount >= w.target_discount))); }
    toast("Цель сохранена: сообщим, когда цена дойдёт.", "success");
  } catch (e) { toast(e.message || "Не удалось сохранить.", "error"); }
}

// ---------- Релизы: календарь и список по неделям (по образцу SteamDB) ----------
const relToday = () => new Date().toISOString().slice(0, 10);
let rel = { view: "cal", month: "roll", week: null, only: "all", kind: "all", q: "", range: null };
let relTimer = 0, relCycle = 0;
const relCells = new Map();      // дата → игры дня, между которыми листает клетка календаря
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MON_SHORT = ["янв.", "фев.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сен.", "окт.", "ноя.", "дек."];
const cycleOn = () => { try { return localStorage.getItem("project-games-cycle") === "1"; } catch (_) { return false; } };   // по умолчанию вручную: наведите на полоску
const adultOn = () => { try { return localStorage.getItem("project-games-adult") === "1"; } catch (_) { return false; } };
const adultParam = () => (adultOn() ? 1 : "");
const persOn = () => { try { return localStorage.getItem("project-games-pers") === "1"; } catch (_) { return false; } };
const persParam = () => (persOn() ? 1 : "");
const persLabel = () => `<label class="gm-cyc gm-adult" title="В клетках и списке выше стоят игры, похожие на то, во что вы играете"><input type="checkbox" data-pers${persOn() ? " checked" : ""}> Под мой вкус</label>`;
const adultLabel = () => `<label class="gm-cyc gm-adult" title="Игры с пометкой «для взрослых» скрыты, пока не включите"><input type="checkbox" data-adult${adultOn() ? " checked" : ""}> Показывать игры для взрослых (18+)</label>`;
const monthLong = ym => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

function relBarHtml() {
  const today = relToday();
  const views = [["cal", "Календарь"], ["list", "Список"]].map(([k, l]) => `<button type="button" class="${rel.view === k ? "on" : ""}" data-rview="${k}">${l}</button>`).join("");
  let extra = "";
  if (rel.view === "cal") {
    const tabs = [["roll", "Ближайшие недели"], ...nextMonths(today, 9).map(m => [m, monthTab(m)])];
    extra = `<div class="gm-chips gm-rtabs">${tabs.map(([k, l]) => `<button type="button" class="gm-chip${rel.month === k ? " on" : ""}" data-rmonth="${k}">${l}</button>`).join("")}</div>`;
  } else {
    const lab = d => `${Number(d.slice(8))} ${MON_SHORT[Number(d.slice(5, 7)) - 1]}`;
    const kinds = [["all", "Все"], ["up", "Предстоящие"], ["done", "Вышедшие"]].map(([k, l]) => `<button type="button" class="${rel.kind === k ? "on" : ""}" data-rkind="${k}">${l}</button>`).join("");
    const nav = rel.range
      ? `<b class="gm-rwk">${esc(rel.range.label)}</b><button type="button" class="btn sm" data-rweek="0">К неделям</button>`
      : `<button type="button" class="btn sm" data-rweek="-1">‹ Неделя ${isoWeek(addDays(rel.week, -7))}</button><b class="gm-rwk">Неделя ${isoWeek(rel.week)} · ${lab(rel.week)} — ${lab(addDays(rel.week, 6))}</b><button type="button" class="btn sm" data-rweek="1">Неделя ${isoWeek(addDays(rel.week, 7))} ›</button><button type="button" class="btn sm ghost" data-rweek="0">Сегодня</button>`;
    extra = `<div class="gm-bar gm-rweek">${nav}<span class="ny-sp"></span><div class="ny-seg">${kinds}</div>
      <input id="gm-rq" class="gm-lf" type="text" placeholder="Поиск по названию" value="${esc(rel.q)}" spellcheck="false"><select id="gm-ronly"><option value="all"${rel.only === "all" ? " selected" : ""}>Все игры</option><option value="wish"${rel.only === "wish" ? " selected" : ""}>Только из желаемого</option><option value="owned"${rel.only === "owned" ? " selected" : ""}>Только из библиотеки</option></select>${persLabel()}${adultLabel()}</div>`;
  }
  return `<div class="gm-bar"><div class="ny-seg">${views}</div><span class="ny-sp"></span><span class="ny-hint gm-rnote">Даты берутся из Steam: точную дату выхода объявляют не все игры</span></div>${extra}`;
}

async function paintReleases() {
  clearInterval(relCycle);
  const body = $("#gm-body");
  if (!rel.week) rel.week = mondayOf(relToday());
  body.innerHTML = `<div id="gm-rbar">${relBarHtml()}</div><div id="gm-rbody">${skeleton(7)}</div>`;
  await (rel.view === "cal" ? paintRelCal() : paintRelList());
}

// Клетки календаря листают игры дня (как «Automatically cycle games» у SteamDB): каждые ~4 секунды со сдвигом по клеткам.
function relCycleStart() {
  clearInterval(relCycle);
  if (!cycleOn()) return;
  let tick = 0;
  relCycle = setInterval(() => { // DevSkim: ignore DS172411 — функция, не строка
    if (tab !== "rel" || rel.view !== "cal") { clearInterval(relCycle); return; }
    tick++;
    let n = 0;
    document.querySelectorAll(".gm-rc-cell[data-date]").forEach(cell => {
      const items = relCells.get(cell.dataset.date);
      if (!items || items.length < 2 || (n++ + tick) % 3 !== 0) return;
      const i = (Number(cell.dataset.i || 0) + 1) % items.length;
      cell.dataset.i = String(i);
      relPaintCell(cell, items, i);
    });
  }, 2000);
}

function relPaintCell(cell, items, i) {
  const it = items[i];
  const flag = it.wishlisted ? `<i class="gm-star" title="В желаемом">★</i>` : it.owned ? `<i class="gm-flag own">В БИБЛИОТЕКЕ</i>` : "";
  const btn = cell.querySelector(".gm-rc-it");
  btn.dataset.app = it.appid; btn.dataset.name = it.name; btn.title = it.name;
  btn.innerHTML = picHtml(it.appid, it.port, it.name, "gm-img gm-port", flag);
  cell.querySelectorAll(".gm-pips i").forEach((p, k) => p.classList.toggle("cur", k === i));
}

async function paintRelCal() {
  const today = relToday();
  const weeks = rel.month === "roll" ? rollingWeeks(addDays(today, -7), 7) : monthWeeks(rel.month);
  const from = weeks[0][0], to = weeks[weeks.length - 1][6];
  try {
    const r = await apiGet("/games/releases/calendar", { from, to, adult: adultParam(), pers: persParam() });
    const box = $("#gm-rbody");
    if (tab !== "rel" || rel.view !== "cal" || !box) return;
    const by = new Map((r.days || []).map(d => [d.date, d]));
    relCells.clear();
    const cell = date => {
      const d = by.get(date);
      const out = rel.month !== "roll" && date.slice(0, 7) !== rel.month;
      const dn = Number(date.slice(8));
      if (d) relCells.set(date, d.items);
      const pips = d ? `<span class="gm-pips" title="Наведите на полоску, чтобы увидеть игру. Выходов в этот день: ${d.count}">${[0, 1, 2, 3, 4].map(i => `<i${i < d.items.length ? ` data-pip="${date}:${i}" title="${esc(d.items[i].name)}"` : ""} class="${i < d.items.length ? (d.items[i].hot ? "hot" : "on") : ""}${i === 0 ? " cur" : ""}"></i>`).join("")}</span>` : "";
      const head = `<div class="gm-rc-h"><button type="button" class="gm-rc-day" data-rday="${date}" title="Все выходы дня">${dn}${dn === 1 ? ` ${MON_SHORT[Number(date.slice(5, 7)) - 1]}` : ""}</button>${pips}${d && d.count > d.items.length ? `<button type="button" class="gm-rc-more" data-rday="${date}">+${d.count - d.items.length}</button>` : ""}</div>`;
      const first = d ? d.items[0] : null;
      const flag = first && first.wishlisted ? `<i class="gm-star" title="В желаемом">★</i>` : first && first.owned ? `<i class="gm-flag own">В БИБЛИОТЕКЕ</i>` : "";
      const body = first ? `<button type="button" class="gm-rc-it" data-app="${first.appid}" data-name="${esc(first.name)}" title="${esc(first.name)}">${picHtml(first.appid, first.port, first.name, "gm-img gm-port", flag)}</button>` : `<div class="gm-rc-empty"></div>`;
      return `<div class="gm-rc-cell${date === today ? " today" : ""}${out ? " out" : ""}"${d ? ` data-date="${date}" data-i="0"` : ""}>${head}${body}</div>`;
    };
    const months = rel.month === "roll" ? [...new Set(weeks.flat().map(d => d.slice(0, 7)))].filter(m => m >= today.slice(0, 7)) : [rel.month];
    const und = months.map(ym => {
      const u = (r.undated || {})[ym];
      if (!u || !u.items.length) return "";
      return `<section class="gm-rund"><h3>Выходы в ${esc(monthLong(ym))} без точного дня <small class="ny-hint">всего ${fmtNum(u.total)}, показаны самые ожидаемые</small></h3><div class="gm-rund-g">${u.items.map(g => `<button type="button" class="gm-card" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.cap, g.name, "gm-img", g.wishlisted ? `<i class="gm-heart" title="В желаемом">♥</i>` : "")}<div class="gm-t">${esc(g.name)}</div></button>`).join("")}</div><div class="gm-moreb"><button type="button" class="btn sm" data-rmonthlist="${ym}">Все выходы: ${esc(monthLong(ym))}</button></div></section>`;
    }).join("");
    box.innerHTML = `<div class="gm-rc"><div class="gm-rc-wd"><span>Нед.</span>${WD.map(w => `<span>${w}</span>`).join("")}</div>${weeks.map(w => `<div class="gm-rc-row"><button type="button" class="gm-rc-wk" data-rwkdate="${w[0]}" title="Выходы этой недели списком">${isoWeek(w[0])}</button>${w.map(cell).join("")}</div>`).join("")}</div>
      <div class="gm-rcact"><button type="button" class="btn sm" data-rrange="up">Все предстоящие выходы</button><button type="button" class="btn sm" data-rrange="done">Недавно вышедшие</button><label class="gm-cyc"><input type="checkbox" id="gm-cyc"${cycleOn() ? " checked" : ""}> Автоматически листать игры</label>${persLabel()}${adultLabel()}</div>
      ${und}
      <ul class="gm-rleg"><li>В каждой клетке самая ожидаемая игра дня. Наведите мышь на полоску в шапке клетки, чтобы увидеть следующую игру (до пяти). Зелёные полоски — самые популярные.</li><li>★ — игра из вашего желаемого. Игры для взрослых скрыты, пока не включена галочка 18+.</li><li>Нажмите на число дня, чтобы увидеть все выходы дня, или на номер недели — выходы недели списком.</li><li>Прошедшие дни показывают только самые популярные вышедшие игры (Steam не отдаёт полный список).</li></ul>`;
    relCycleStart();
  } catch (e) { const box = $("#gm-rbody"); if (box) box.innerHTML = errBox(e); }
}

const expectBar = rank => { const w = Math.max(6, Math.round(100 - Math.log10(Math.max(1, rank)) * 20)); return `<span class="gm-exp"><i style="width:${w}%"></i></span><small class="ny-hint">топ-${fmtNum(rank)}</small>`; };

async function paintRelList() {
  const from = rel.range ? rel.range.from : rel.week;
  const to = rel.range ? rel.range.to : addDays(rel.week, 6);
  try {
    const r = await apiGet("/games/releases", { from, to, q: rel.q, only: rel.only === "all" ? "" : rel.only, kind: rel.kind === "all" ? "" : rel.kind, adult: adultParam(), pers: persParam() });
    const box = $("#gm-rbody");
    if (tab !== "rel" || rel.view !== "list" || !box) return;
    const rows = r.items.map(g => {
      const lb = dayLabel(g.day);
      const flag = g.wishlisted ? `<i class="gm-star sm" title="В желаемом">★</i>` : g.owned ? `<i class="gm-own2" title="В библиотеке">✓</i>` : "";
      const rating = g.pct != null && g.reviews >= 10 ? `<span class="gm-tc"><b class="${g.pct >= 70 ? "gm-green" : g.pct >= 40 ? "" : "gm-red"}">${g.pct}%</b><small class="ny-hint">${fmtNum(g.reviews)}</small></span>` : `<span class="gm-tc ny-hint">—</span>`;
      return `<div class="gm-tr" data-app="${g.appid}" data-name="${esc(g.name)}"><span class="gm-rk">${flag}</span>${picHtml(g.appid, g.cap, g.name, "gm-img gm-tth")}<span class="gm-tn"><b>${esc(g.name)}</b>${g.tags && g.tags.length ? `<small class="ny-hint">${esc(g.tags.join(" · "))}</small>` : ""}</span>${g.price ? priceCell(g.price) : `<span class="gm-tc ny-hint">—</span>`}${rating}<span class="gm-tc"><b>${lb.date}</b><small class="ny-hint">${g.released ? "вышла" : lb.dow}</small></span><span class="gm-tc">${g.released ? (g.online != null ? `<b class="gm-green">${fmtNum(g.online)}</b>` : "—") : "—"}</span><span class="gm-tc gm-exp-c">${expectBar(g.rank)}</span></div>`;
    }).join("");
    const title = rel.range ? rel.range.label : `Выходы на неделе ${isoWeek(rel.week)}`;
    box.innerHTML = `<div class="gm-rl-hero"><h2>${esc(title)}</h2><p>${fmtNum(r.total)} ${r.total === 1 ? "игра" : "игр"} с объявленной датой${r.total >= 400 ? " (показаны первые 400)" : ""}</p></div>`
      + (rows ? `<div class="gm-tbl gm-rl" style="--cols:30px 110px minmax(0,1fr) 120px 100px 90px 90px 150px">${thead(["", "", "Игра", "Цена", "Рейтинг", "Выход", "Онлайн", "Ожидание"])}${rows}</div>` : empty("Ничего не найдено", "Смените период или сбросьте фильтры."));
  } catch (e) { const box = $("#gm-rbody"); if (box) box.innerHTML = errBox(e); }
}

async function openRelDay(date) {
  const ov = gmSheet(dialogSkeletonHtml(5), "wide");
  const lb = dayLabel(date);
  try {
    const r = await apiGet("/games/releases", { from: date, to: date, adult: adultParam() });
    ov.querySelector(".sheet").innerHTML = `<h2>Выходы ${lb.dow}, ${lb.date}: ${fmtNum(r.total)}</h2><div class="gm-list gm-impl">${r.items.map(g => `<div class="gm-row" data-rd-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.cap, g.name, "gm-img gm-rimg")}<div class="gm-row-t"><b>${esc(g.name)}</b><small>${esc((g.tags || []).join(" · "))}</small></div>${g.wishlisted ? `<i class="gm-star sm">★</i>` : ""}${g.price ? priceCell(g.price) : "<span></span>"}</div>`).join("")}</div><div class="gm-d-act"><button type="button" class="btn ghost" data-d-close>Закрыть</button></div>`;
  } catch (e) { ov.querySelector(".sheet").innerHTML = `${errBox(e)}<div class="gm-d-act"><button type="button" class="btn" data-d-close>Закрыть</button></div>`; }
  ov.addEventListener("click", ev => {
    if (ev.target.closest("[data-d-close]")) { dismissSheet(ov); return; }
    const row = ev.target.closest("[data-rd-app]");
    if (row) { dismissSheet(ov); openDetail(Number(row.dataset.rdApp), row.dataset.name || ""); }
  });
}

async function paintLib() {
  const body = $("#gm-body");
  if (!me || !me.steamid) { body.innerHTML = empty("Steam не привязан", "Привяжите аккаунт, чтобы увидеть свои игры и запускать их отсюда.", `<button type="button" class="btn primary" data-gadd>Привязать Steam</button>`); return; }
  body.innerHTML = skeleton(8);
  try {
    const l = await loadLibrary(true);
    if (tab !== "lib") return;
    const f = libFilter.toLowerCase();
    const items = sortLibrary(l.items.filter(g => !f || String(g.name).toLowerCase().includes(f)), libSort, libUnplayed);
    const lsorts = [["recent", "недавние"], ["hours", "по часам"], ["name", "по названию"]].map(([k, n]) => `<option value="${k}"${libSort === k ? " selected" : ""}>${n}</option>`).join("");
    body.innerHTML = `<div class="gm-bar"><span class="gm-count">${items.length === l.items.length ? l.items.length : `${items.length} из ${l.items.length}`} игр</span><div class="ny-seg"><button type="button" class="${libUnplayed ? "on" : ""}" data-lunplayed>Не запускал</button><button type="button" data-lrandom title="Случайная игра из списка">🎲 Случайная</button><button type="button" class="${libFamily ? "on" : ""}" data-lfamily title="Показать и игры, которыми с вами делятся по семейному доступу">Семейная</button></div><label class="gm-sort">Сортировка <select id="gm-lsort">${lsorts}</select></label><span class="ny-sp"></span><input id="gm-lf" class="gm-lf" type="text" placeholder="Фильтр по названию" value="${esc(libFilter)}" spellcheck="false"></div>`
      + (items.length ? `<div class="gm-grid">${items.map(g => `<div class="gm-card lib" data-app="${g.appid}" data-name="${esc(g.name)}" role="button" tabindex="0">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div><div class="gm-pr"><small title="${g.hours_deck ? `На Steam Deck: ${esc(fmtHours(g.hours_deck))}` : ""}">${esc(fmtHours(g.hours))}${g.hours_deck ? " · 🎮" : ""}</small><button type="button" class="btn primary sm" data-launch="${g.appid}">Запустить</button></div></div>`).join("")}</div>` : empty("Ничего не найдено", "Библиотека пуста или фильтр слишком строгий."));
  } catch (e) { body.innerHTML = errBox(e); }
}

function paintSettings() {
  const body = $("#gm-body");
  if (!me) { body.innerHTML = ""; return; }
  const cc = Object.entries(me.countries || {}).map(([k, n]) => `<option value="${k}"${k === me.cc ? " selected" : ""}>${esc(n)} (${k})</option>`).join("");
  const accs = (me.accounts || []).map(a => `<div class="gm-acc${a.steamid === me.steamid ? " on" : ""}"><i class="gm-ava">${a.avatar ? `<img src="${esc(img(a.avatar))}" alt="">` : `<span>${esc(initials2(a.name))}</span>`}</i><div><b>${esc(a.name || a.steamid)}</b><small>${a.steamid === me.steamid ? "активный" : a.steamid}</small></div><span class="ny-sp"></span>${a.steamid === me.steamid ? "" : `<button type="button" class="btn sm" data-gsel="${a.steamid}">Сделать активным</button>`}<button type="button" class="btn ghost sm" data-gunlink="${a.steamid}">Отвязать</button></div>`).join("");
  body.innerHTML = `<div class="gm-set">
    <section><h3>Страна цен</h3><p class="ny-hint">От страны зависят цена и валюта в магазине Steam. У каждого профиля своя.</p><select id="gm-cc">${cc}</select></section>
    <section><h3>Аккаунты Steam</h3>${accs || `<p class="ny-hint">Пока ни одного.</p>`}<button type="button" class="btn primary" data-gadd>Привязать аккаунт Steam</button>
      <p class="ny-hint">Вход идёт через сайт Steam, пароль в Project не вводится. Чтобы видеть библиотеку, в Steam → «Настройки конфиденциальности» → «Сведения об играх» поставьте «Открытый».${me.steam_key ? "" : " На сервере не задан ключ Steam Web API — библиотека недоступна."}</p></section>
    <section><h3>Уведомления о цене</h3><p class="ny-hint">Сервер проверяет «Желаемое» каждые 30 минут и пишет в Telegram. Здесь — как часто программа забирает их себе.</p>
      <label class="gm-sort"><input type="checkbox" id="gm-npr"${notifyKinds().price === false ? "" : " checked"}> всплывашки Windows о ценах</label>
      <label class="gm-sort">Проверять раз в <select id="gm-poll">${[[60000, "минуту"], [120000, "2 минуты"], [300000, "5 минут"], [900000, "15 минут"]].map(([v, l]) => `<option value="${v}"${pollMs() === v ? " selected" : ""}>${l}</option>`).join("")}</select></label></section>
    <section><h3>Список желаемого</h3><p class="ny-hint">Резервная копия или перенос на другой аккаунт.</p><div class="gm-d-act"><button type="button" class="btn" data-wl-export>Скопировать список</button><button type="button" class="btn" data-wl-import>Импортировать…</button></div></section>
    <section><h3>Состояние сервера</h3><div id="gm-status"><small class="ny-hint">Загружаю…</small></div></section>
  </div>`;
  loadStatus();
}

// ---------- карточка игры ----------
async function openDetail(appid, name) {
  const ov = gmSheet(dialogSkeletonHtml(7), "wide");
  ov.classList.add("gm-ov");
  try {
    const d = await apiGet(`/games/app/${appid}`);
    ov.__d = d;
    const l = lib && lib.ids.has(appid);
    const v = d.free ? { now: "Бесплатно", old: "", badge: "", sale: false } : priceView(d.price);
    const cur = d.price && d.price.currency;
    const plat = Object.entries({ windows: "Windows", mac: "macOS", linux: "Linux" }).filter(([k]) => d.platforms && d.platforms[k]).map(([, n]) => n).join(" · ");
    const types = { game: "Игра", dlc: "DLC", demo: "Демо", mod: "Мод", music: "Саундтрек", advertising: "Реклама" };
    const row = (k, val) => (val ? `<tr><th>${k}</th><td>${val}</td></tr>` : "");
    ov.querySelector(".sheet").innerHTML = `
      <div class="gm-dp">
        <div class="gm-dp-bar">
          <div class="gm-dp-title"><b>${esc(d.name)}</b><small>${esc((d.developers || []).join(", "))}${d.release ? ` · ${esc(d.release)}` : ""}</small></div>
          <div class="gm-dp-acts">
            ${l ? `<button type="button" class="btn primary" data-launch="${appid}">Запустить</button>` : ""}
            <button type="button" class="btn${l ? "" : " primary"}" data-d-wish="${appid}" data-name="${esc(d.name)}" data-on="${d.wishlisted ? 1 : 0}">${d.wishlisted ? "♥ В желаемом" : "♡ В желаемое"}</button>
            <input type="number" class="gm-target" id="gm-target" min="0" step="0.01" placeholder="Цель, ${esc(cur || "цена")}" value="${d.target != null ? d.target : ""}" title="Сообщить, когда цена упадёт до…">
            <input type="number" class="gm-target" id="gm-tdisc" min="1" max="95" step="1" placeholder="Скидка, %" value="${d.target_discount != null ? d.target_discount : ""}" title="Или когда скидка дойдёт до…">
            <button type="button" class="btn ghost" data-d-store="${esc(d.store)}">Steam</button>
            <button type="button" class="btn ghost gm-x" data-d-close aria-label="Закрыть">✕</button>
          </div>
        </div>
        <div class="gm-dp-top">
          <div class="gm-dp-left">
            <table class="gm-info"><tbody>
              ${row("App ID", `<span class="gm-copy" data-copy="${appid}" title="Скопировать">${appid}</span>`)}
              ${row("Тип", esc(types[d.type] || d.type || ""))}
              ${row("Разработчик", esc((d.developers || []).join(", ")))}
              ${row("Издатель", esc((d.publishers || []).join(", ")))}
              ${row("Системы", esc(plat))}
              ${row("Дата выхода", esc(d.release || ""))}
              ${row("Возраст", d.age && Number(d.age) > 0 ? `${esc(d.age)}+` : "")}
              ${row("Metacritic", d.metacritic ? `<b class="${d.metacritic >= 75 ? "gm-green" : ""}">${d.metacritic}</b>` : "")}
              ${row("Жанры", esc((d.genres || []).join(", ")))}
              ${row("Языки", esc(d.languages || ""))}
              ${row("Следят у нас", d.watchers ? fmtNum(d.watchers) : "")}
            </tbody></table>
            <div class="gm-links">${d.website ? `<button type="button" class="btn sm" data-d-store="${esc(d.website)}">Сайт игры</button>` : ""}<button type="button" class="btn sm" data-d-store="${esc(`https://steamdb.info/app/${appid}/`)}">SteamDB</button><button type="button" class="btn sm" data-d-store="${esc(`https://www.protondb.com/app/${appid}`)}">ProtonDB</button></div>
          </div>
          <div class="gm-dp-right">
            ${galleryHtml(d, img) || picHtml(appid, d.image, d.name, "gm-img gm-d-img")}
            <div class="gm-boxes">
              <div class="gm-box" id="gm-rate"><b>—</b><small>отзывы</small></div>
              <div class="gm-box now"><b id="gm-now">—</b><small>играют сейчас</small></div>
              <div class="gm-box pr"><b class="${v.sale ? "sale" : ""}">${esc(v.now)}</b><small>${v.old ? `<s>${esc(v.old)}</s> ${v.badge}` : d.at_lowest && !d.free ? "исторический минимум" : "цена"}</small></div>
            </div>
            <div class="gm-d-badges" id="gm-badges">${badgesOf(d, null).map(b => `<i class="gm-tag ${b.cls}">${esc(b.text)}</i>`).join("")}</div>
            <p class="gm-d-desc">${esc(d.description || "")}</p>
          </div>
        </div>
        <div class="gm-dp-cols">
          <section class="gm-dp-sec"><h3>Онлайн</h3>
            <div class="gm-online" id="gm-online">
              <div class="gm-online-h"><span class="ny-hint" id="gm-rank"></span><div class="ny-seg">${[["48h", "48 ч"], ["7d", "1 нед."], ["30d", "1 мес."], ["90d", "3 мес."], ["all", "Всё"]].map(([k, t]) => `<button type="button" data-orange="${k}">${t}</button>`).join("")}</div></div>
              <div class="gm-online-s"></div><div class="gm-chartbox gm-online-c"></div>
            </div>
          </section>
          <section class="gm-dp-sec"><h3>Данные магазина</h3>
            <div class="gm-store" id="gm-store">
              <div><b>${d.recommendations ? fmtNum(d.recommendations) : "—"}</b><small>рекомендаций</small></div>
              <div><b>${d.dlc ? fmtNum(d.dlc) : "0"}</b><small>DLC</small></div>
              <div><b>${d.watchers ? fmtNum(d.watchers) : "0"}</b><small>следят у нас</small></div>
              <div><b>${d.sales || 0}</b><small>скидок за наблюдение</small></div>
            </div>
          </section>
        </div>
        ${d.free ? "" : `<section class="gm-dp-sec"><h3>История цены</h3><div class="gm-online gm-hist">
          <div class="gm-online-h gm-ph2"><div class="gm-pstats" id="gm-pstats"></div><div class="ny-seg">${[[30, "30 дн."], [90, "3 мес."], [365, "Год"], [0, "Всё"]].map(([k, t]) => `<button type="button" data-prange="${k}">${t}</button>`).join("")}</div></div>
          <div class="gm-chartbox" id="gm-pchart"></div>
          <div class="gm-plist" id="gm-plist"></div>
          <p class="ny-hint gm-hnote">Steam не хранит историю цен, поэтому мы ведём её сами: цены популярных игр записываются каждые 6 часов, а у желаемого — каждые 30 минут и при каждом просмотре.</p>
        </div>
        <div class="gm-reg" id="gm-reg"><button type="button" class="btn" data-regions="${appid}">Цены по странам</button></div></section>`}
        <section class="gm-dp-sec"><h3>Игроки по месяцам</h3><div id="gm-monthly"><div class="gm-reg-load"><span class="ny-spin"></span> Считаю…</div></div></section>
        <section class="gm-dp-sec gm-more"><div class="ny-seg gm-mtabs"><button type="button" data-more="reviews">Отзывы</button><button type="button" data-more="news">Анонсы</button><button type="button" data-more="patch">Патчноуты</button>${me && me.steamid ? `<button type="button" data-more="ach">Достижения</button><button type="button" data-more="stats">Статистика</button>` : ""}</div><div id="gm-more-body"></div></section>
      </div>`;
  } catch (e) {
    ov.querySelector(".sheet").innerHTML = `${errBox(e)}<div class="gm-d-act"><button type="button" class="btn" data-d-close>Закрыть</button></div>`;
    ov.addEventListener("click", ev => { if (ev.target.closest("[data-d-close]")) dismissSheet(ov); });
    return;
  }
  const stopGal = mountGallery(ov, ov.__d, img);                   // трейлер замолкает, когда карточку закрыли
  const galT = setInterval(() => { if (!ov.isConnected) { stopGal(); clearInterval(galT); } }, 800); // DevSkim: ignore DS172411 — функция, не строка
  ov.addEventListener("gm-gal-web", () => openExternal(ov.__d.store));
  paintPriceStats(ov);
  paintPriceChart(ov, 0);
  paintPriceList(ov);
  loadOnline(ov, appid, "48h");
  ov.__ot = setInterval(() => { if (!ov.isConnected) { clearInterval(ov.__ot); return; } loadOnline(ov, appid, ov.__orange || "48h", true); }, 60000); // DevSkim: ignore DS172411 — функция, не строка
  loadExtra(ov, appid);
  loadMonthly(ov, appid);
  loadMore(ov, appid, "reviews");
  ov.addEventListener("click", async e => {
    const t = e.target;
    const mb = t.closest("[data-more]");
    if (mb) { loadMore(ov, appid, mb.dataset.more); return; }
    const nm = t.closest("[data-newsmore]");
    if (nm) { loadMoreNews(ov, appid, nm); return; }
    if (t.closest("[data-d-close]")) { dismissSheet(ov); return; }
    const cp = t.closest("[data-copy]");
    if (cp) { navigator.clipboard.writeText(cp.dataset.copy).then(() => toast("Скопировано.", "success")).catch(() => {}); return; }
    const rb = t.closest("[data-regions]");
    if (rb) { loadRegions(ov, appid); return; }
    const pr = t.closest("[data-prange]");
    if (pr) { paintPriceChart(ov, Number(pr.dataset.prange)); return; }
    const rg = t.closest("[data-orange]");
    if (rg) { loadOnline(ov, appid, rg.dataset.orange); return; }
    const st = t.closest("[data-d-store]");
    if (st) { openExternal(st.dataset.dStore).catch(() => toast("Не удалось открыть ссылку.", "error")); return; }
    const w = t.closest("[data-d-wish]");
    if (w) {
      try {
        if (w.dataset.on === "1") { await apiDelete(`/games/wishlist/${appid}`); w.dataset.on = "0"; w.textContent = "♡ В желаемое"; toast("Убрано из желаемого.", "success"); }
        else { await apiPost("/games/wishlist", { appid, name: w.dataset.name || name, target: ($("#gm-target") || {}).value || null, target_discount: ($("#gm-tdisc") || {}).value || null }); w.dataset.on = "1"; w.textContent = "♥ В желаемом"; toast("Добавлено в желаемое.", "success"); }
        if (tab === "wish") paintWish();
      } catch (err) { toast(err.message, "error"); }
    }
  });
}


const pad2 = n => String(n).padStart(2, "0");
const fmtDM = ts => { const d = new Date(ts * 1000); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`; };
const fmtHM = ts => { const d = new Date(ts * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDMHM = ts => `${fmtDM(ts)} ${fmtHM(ts)}`;

// SVG с осями, сеткой, зонами скидок, линией и слоем наведения; подсказку рисует attachHover.
function chartSvg(g, kind, fmtTick, fmtX) {
  return `<svg viewBox="0 0 ${g.w} ${g.h}" class="gm-svg ${kind}" preserveAspectRatio="xMidYMid meet" role="img">
    ${g.yTicks.map(t => `<line class="gl" x1="${g.plot.l}" x2="${g.plot.r}" y1="${t.y}" y2="${t.y}"/><text class="yl" x="${g.plot.l - 8}" y="${t.y + 4}" text-anchor="end">${esc(fmtTick(t.v))}</text>`).join("")}
    ${g.zones.map(z => `<rect class="z" x="${z.x}" y="${g.plot.t}" width="${z.w}" height="${g.plot.b - g.plot.t}"/>`).join("")}
    <path class="a" d="${g.area}"/><path class="l" d="${g.line}"/>
    ${g.pts.length === 1 ? `<circle class="one" cx="${g.pts[0].x}" cy="${g.pts[0].y}" r="5"/>` : ""}
    ${g.xTicks.map((t, i) => `<text class="xl" x="${t.x}" y="${g.h - 6}" text-anchor="${i === 0 ? "start" : i === 3 ? "end" : "middle"}">${esc(fmtX(t.ts))}</text>`).join("")}
    <line class="cross" x1="0" x2="0" y1="${g.plot.t}" y2="${g.plot.b}" hidden/><circle class="dot" r="4.5" cx="0" cy="0" hidden/>
  </svg><div class="gm-tip" hidden></div>`;
}

function attachHover(box, g, step, fmtTip) {
  const svg = box.querySelector("svg"), tip = box.querySelector(".gm-tip");
  if (!svg || !tip) return;
  const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
  const hide = () => { tip.hidden = true; cross.setAttribute("hidden", ""); dot.setAttribute("hidden", ""); };
  svg.addEventListener("mousemove", e => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * g.w;
    if (px < g.plot.l || px > g.plot.r) { hide(); return; }
    const p = pointAt(g.pts, px, step);
    if (!p) { hide(); return; }
    const cx = step ? px : p.x;
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); dot.setAttribute("cx", step ? Math.max(p.x, Math.min(px, g.plot.r)) : p.x); dot.setAttribute("cy", p.y);
    cross.removeAttribute("hidden"); dot.removeAttribute("hidden");
    const ts = g.t0 + ((cx - g.plot.l) / (g.plot.r - g.plot.l)) * (g.t1 - g.t0);
    tip.innerHTML = fmtTip(p, ts);
    tip.hidden = false;
    const left = (cx / g.w) * r.width;
    tip.style.left = `${Math.min(Math.max(left, 74), r.width - 74)}px`;
  });
  svg.addEventListener("mouseleave", hide);
}

function paintPriceStats(ov) {
  const d = ov.__d, el = ov.querySelector("#gm-pstats");
  if (!el) return;
  const h = (d.history || []).slice().sort((a, b) => a.ts - b.ts);
  const cur = d.price && d.price.currency;
  const m = n => priceView({ final: n, initial: n, discount: 0, currency: cur }).now;
  if (!h.length) { el.innerHTML = `<span class="ny-hint">Наблюдаем с сегодня</span>`; return; }
  const prices = h.map(p => p.price), lo = Math.min(...prices), hi = Math.max(...prices);
  const now = Date.now() / 1000;
  let avg = 0, span = 0;
  h.forEach((p, i) => { const dt = (i + 1 < h.length ? h[i + 1].ts : now) - p.ts; avg += p.price * dt; span += dt; });
  avg = span > 0 ? avg / span : h[h.length - 1].price;
  const loAt = h.find(p => p.price === lo);
  const curP = d.price ? d.price.final : h[h.length - 1].price;
  const vsMax = hi > 0 ? Math.round((1 - curP / hi) * 100) : 0;
  el.innerHTML = `<div><small>Сейчас</small><b>${esc(m(curP))}</b></div><div><small>Минимум${loAt ? ` · ${esc(fmtDM(loAt.ts))}` : ""}</small><b class="gm-green">${esc(m(lo))}</b></div><div><small>Максимум</small><b>${esc(m(hi))}</b></div><div><small>Средняя</small><b>${esc(m(avg))}</b></div><div><small>Дешевле максимума</small><b class="${vsMax > 0 ? "gm-green" : ""}">${vsMax > 0 ? `−${vsMax}%` : "нет"}</b></div><div><small>Наблюдаем</small><b>${d.tracking_since ? esc(shortDate(d.tracking_since)) : "с сегодня"}</b></div>`;
}

function paintPriceChart(ov, range) {
  const d = ov.__d, box = ov.querySelector("#gm-pchart");
  if (!box) return;
  ov.querySelectorAll("[data-prange]").forEach(b => b.classList.toggle("on", Number(b.dataset.prange) === range));
  const hist = (d.history || []).slice().sort((a, b) => a.ts - b.ts);
  const now = Date.now() / 1000;
  let pts = hist;
  if (range > 0) {
    const cut = now - range * 86400, before = hist.filter(p => p.ts < cut), keep = hist.filter(p => p.ts >= cut);
    pts = before.length ? [{ ...before[before.length - 1], ts: cut }, ...keep] : keep;
  }
  if (!pts.length) { box.innerHTML = `<small class="ny-hint">Данных пока нет: цена записывается раз в 6 часов и при каждом просмотре.</small>`; return; }
  const cur = d.price && d.price.currency;
  const m = n => priceView({ final: n, initial: n, discount: 0, currency: cur }).now;
  const g = seriesChart(pts.map(p => ({ ts: p.ts, v: p.price, d: p.discount })), { step: true, now, h: 190 });
  box.innerHTML = chartSvg(g, "price", v => fmtNum(Math.round(v)), fmtDM);
  attachHover(box, g, true, (p, ts) => `<b>${esc(m(p.v))}</b>${p.d > 0 ? ` <i class="gm-badge sm">−${p.d}%</i>` : ""}<small>${esc(fmtDM(ts))}</small>`);
  const flatMsg = new Set(pts.map(p => p.price)).size === 1 ? `<small class="ny-hint gm-flat">Цена не менялась за выбранный период.</small>` : "";
  box.insertAdjacentHTML("beforeend", flatMsg);
}

function paintPriceList(ov) {
  const d = ov.__d, el = ov.querySelector("#gm-plist");
  if (!el) return;
  const h = (d.history || []).slice().sort((a, b) => b.ts - a.ts);
  if (h.length < 2) { el.innerHTML = ""; return; }
  const cur = d.price && d.price.currency;
  const m = n => priceView({ final: n, initial: n, discount: 0, currency: cur }).now;
  el.innerHTML = `<h4>Последние изменения цены</h4>${h.slice(0, 7).map((p, i) => {
    const prev = h[i + 1];
    const down = prev && p.price < prev.price;
    return `<div class="gm-prow"><span>${esc(shortDate(p.ts))}</span><span>${prev ? `<s>${esc(m(prev.price))}</s> → ` : ""}<b>${esc(m(p.price))}</b></span><span class="${prev ? (down ? "gm-green" : "gm-red") : ""}">${prev ? `${down ? "−" : "+"}${Math.abs(Math.round(((p.price - prev.price) / prev.price) * 100))}%` : "первая запись"}</span>${p.discount > 0 ? `<i class="gm-badge sm">−${p.discount}%</i>` : "<i></i>"}</div>`;
  }).join("")}`;
}

async function loadMonthly(ov, appid) {
  const box = ov.querySelector("#gm-monthly");
  if (!box) return;
  try {
    const r = await apiGet(`/games/app/${appid}/monthly`);
    if (!r.items.length) { box.innerHTML = `<small class="ny-hint">Данных пока нет: онлайн копится с момента, когда игра попала в наблюдение.</small>`; return; }
    box.innerHTML = `<div class="gm-mt"><div class="gm-mt-h"><span>Месяц</span><span>Пик</span><span>Прирост</span><span>%</span><span>Среднее</span></div>${r.items.map(m => {
      const g = m.gain, up = g > 0;
      return `<div class="gm-mt-r"><span>${esc(new Date(m.month + "-01T12:00:00").toLocaleDateString("ru-RU", { month: "long", year: "numeric" }))}</span><span>${fmtNum(m.peak)}</span><span class="${g == null ? "" : up ? "gm-green" : "gm-red"}">${g == null ? "—" : `${up ? "+" : "−"}${fmtNum(Math.abs(g))}`}</span><span class="${g == null ? "" : up ? "gm-green" : "gm-red"}">${m.gain_pct == null ? "—" : `${up ? "+" : "−"}${Math.abs(m.gain_pct)}%`}</span><span>${fmtNum(m.avg)}</span></div>`;
    }).join("")}</div>${r.since ? `<p class="ny-hint gm-hnote">Данные ведём с ${esc(shortDate(Date.parse(r.since + "T12:00:00Z") / 1000))}: Steam не отдаёт историю онлайна задним числом.</p>` : ""}`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить.")}</small>`; }
}

// Метки из ProtonDB и Steam Deck подгружаются отдельно: внешние источники медленнее самой карточки.
async function loadExtra(ov, appid) {
  try {
    const x = await apiGet(`/games/app/${appid}/extra`);
    const box = ov.querySelector("#gm-badges");
    if (!box) return;
    box.innerHTML = badgesOf(ov.__d || {}, x).map(b => `<i class="gm-tag ${b.cls}">${esc(b.text)}</i>`).join("")
      + (x.tags || []).slice(0, 8).map(n => `<i class="gm-tag t">${esc(n)}</i>`).join("");
  } catch (_) { /* метки необязательны */ }
}

const newsHtml = items => items.map(n => `<div class="gm-news"><b>${esc(n.title)}</b><small class="ny-hint">${esc(shortDate(n.ts))}${n.label ? ` · ${esc(n.label)}` : ""}</small><p>${esc(n.text)}</p>${n.url ? `<button type="button" class="btn ghost sm" data-d-store="${esc(n.url)}">Читать</button>` : ""}</div>`).join("");
const newsMoreBtn = (r, kind) => (r.more && r.items.length ? `<div class="gm-moreb"><button type="button" class="btn" data-newsmore="${kind}" data-before="${r.items[r.items.length - 1].ts}">Ещё</button></div>` : "");

async function loadMoreNews(ov, appid, btn) {
  const wrap = btn.closest(".gm-moreb");
  btn.disabled = true;
  try {
    const r = await apiGet(`/games/app/${appid}/news`, { kind: btn.dataset.newsmore === "patch" ? "patch" : "all", before: Number(btn.dataset.before) - 1 });
    wrap.insertAdjacentHTML("beforebegin", newsHtml(r.items));
    if (r.more && r.items.length) { btn.dataset.before = String(r.items[r.items.length - 1].ts); btn.disabled = false; } else wrap.remove();
  } catch (e) { btn.disabled = false; toast(e.message || "Не удалось загрузить.", "error"); }
}

async function loadMore(ov, appid, kind) {
  const box = ov.querySelector("#gm-more-body");
  if (!box) return;
  ov.querySelectorAll("[data-more]").forEach(b => b.classList.toggle("on", b.dataset.more === kind));
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Загружаю…</div>`;
  try {
    if (kind === "reviews") {
      const r = await apiGet(`/games/app/${appid}/reviews`);
      const sm = reviewSummary(r);
      const rate = ov.querySelector("#gm-rate");
      if (rate && sm) { rate.className = `gm-box ${sm.pct >= 70 ? "ok" : sm.pct >= 40 ? "mid" : "bad"}`; rate.innerHTML = `<b>${sm.pct}%</b><small>${fmtNum(r.total)} отзывов</small>`; }
      box.innerHTML = (sm ? `<p class="gm-ach-s"><b>${esc(sm.text)}</b></p>` : "") + (r.items.length ? r.items.map(x => `<div class="gm-news gm-rev ${x.up ? "up" : "down"}"><b>${x.up ? "👍 Рекомендует" : "👎 Не рекомендует"}</b><small class="ny-hint">${esc(x.name || "")} · ${fmtNum(x.hours)} ч в игре · ${esc(shortDate(x.ts))}</small><p>${esc(x.text)}</p></div>`).join("") : `<small class="ny-hint">Отзывов на русском пока нет.</small>`);
    } else if (kind === "stats") {
      const r = await apiGet(`/games/app/${appid}/stats`, { steamid: me && me.steamid });
      box.innerHTML = r.items.length ? `<div class="gm-statg">${r.items.map(x => `<div><small>${esc(statLabel(x.name))}</small><b>${esc(fmtNum(x.value))}</b></div>`).join("")}</div>` : `<small class="ny-hint">${r.available === false ? "Статистика недоступна: у игры её нет или закрыты сведения об играх." : "Данных нет."}</small>`;
    } else if (kind === "news" || kind === "patch") {
      const r = await apiGet(`/games/app/${appid}/news`, { kind: kind === "patch" ? "patch" : "all" });
      box.innerHTML = r.items.length ? newsHtml(r.items) + newsMoreBtn(r, kind) : `<small class="ny-hint">${kind === "patch" ? "Патчноутов нет." : "Новостей нет."}</small>`;
    } else {
      const r = await apiGet(`/games/app/${appid}/achievements`, { steamid: me && me.steamid });
      if (!r.total) { box.innerHTML = `<small class="ny-hint">У этой игры нет достижений.</small>`; return; }
      box.innerHTML = `<p class="gm-ach-s"><b>${esc(achSummary(r))}</b>${r.available ? "" : ` <small class="ny-hint">— ваш профиль или сведения об играх закрыты, показан только процент получивших</small>`}</p>`
        + r.items.slice(0, 60).map(a => `<div class="gm-ach${a.achieved ? " on" : ""}"><i>${a.icon ? `<img loading="lazy" src="${esc(img(a.icon))}" alt="">` : ""}</i><div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div><span class="ny-hint">${a.percent}%</span></div>`).join("");
    }
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить.")}</small>`; }
}

async function paintProfile() {
  const body = $("#gm-body");
  if (!me || !me.steamid) { body.innerHTML = empty("Steam не привязан", "Привяжите аккаунт, чтобы увидеть профиль.", `<button type="button" class="btn primary" data-gadd>Привязать Steam</button>`); return; }
  body.innerHTML = skeleton(4);
  try {
    const p = await apiGet("/games/profile", { steamid: me.steamid });
    if (tab !== "profile") return;
    const t = p.total || {};
    const row = g => `<button type="button" class="gm-card lib" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div><div class="gm-pr"><small>${g.hours2w != null ? `${esc(fmtHours(g.hours2w))} за 2 недели · ` : ""}${esc(fmtHours(g.hours))} всего</small></div></button>`;
    body.innerHTML = `<div class="gm-prof"><i class="gm-ava big">${p.avatar ? `<img src="${esc(img(p.avatar))}" alt="">` : `<span>${esc(initials2(p.name))}</span>`}</i>
      <div><h2>${esc(p.name || "Steam")}</h2><small class="ny-hint">${p.level != null ? `Уровень ${p.level}` : "Уровень скрыт"}${p.visible === false ? " · профиль закрыт" : ""}</small></div></div>
      <div class="gm-online-s gm-prof-s"><div><small>Игр</small><b>${fmtNum(t.games)}</b></div><div><small>Часов всего</small><b>${fmtNum(t.hours)}</b></div><div><small>Не запускал</small><b>${fmtNum(t.unplayed)}</b></div></div>
      ${xpHtml(p.badges)}
      <form class="gm-look" id="gm-look" autocomplete="off"><input id="gm-lookq" type="text" placeholder="Посмотреть другой профиль: ссылка, имя или SteamID64" spellcheck="false"><button type="submit" class="btn sm">Найти</button></form>
      <div id="gm-look-res"></div>
      ${(p.recent || []).length ? `<h3 class="gm-h3">Недавно играли</h3><div class="gm-grid">${p.recent.map(row).join("")}</div>` : ""}
      ${(p.top || []).length ? `<h3 class="gm-h3">Больше всего часов</h3><div class="gm-grid">${p.top.map(row).join("")}</div>` : ""}
      <h3 class="gm-h3">Друзья</h3><div id="gm-friends"><button type="button" class="btn" data-friends>Показать друзей</button></div>
      ${!(p.recent || []).length && !(p.top || []).length ? empty("Данных нет", "Откройте «Сведения об играх» в настройках конфиденциальности Steam.") : ""}`;
  } catch (e) { body.innerHTML = errBox(e); }
}

function xpHtml(b) {
  if (!b) return "";
  const x = xpProgress(b);
  return `<div class="gm-xp"><span>Опыт ${fmtNum(b.xp)} · значков ${fmtNum(b.count)}</span>${x ? `<i class="gm-xpbar"><b style="width:${x.pct}%"></b></i><small class="ny-hint">до следующего уровня ${fmtNum(x.left)}</small>` : ""}</div>`;
}

async function loadFriends() {
  const box = $("#gm-friends");
  if (!box) return;
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Загружаю друзей…</div>`;
  try {
    const r = await apiGet("/games/friends", { steamid: me.steamid });
    box.innerHTML = `<div class="gm-flist">${r.items.map(f => { const st = friendState(f); return `<div class="gm-friend ${st.cls}"><i class="gm-ava">${f.avatar ? `<img src="${esc(img(f.avatar))}" alt="">` : `<span>${esc(initials2(f.name))}</span>`}</i><div><b>${esc(f.name || f.steamid)}</b><small>${esc(st.text)}</small></div></div>`; }).join("")}</div>`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить друзей.")}</small>`; }
}

async function lookupProfile(q) {
  const box = $("#gm-look-res");
  if (!box) return;
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Ищу профиль…</div>`;
  try {
    const p = await apiGet("/games/profile/lookup", { q });
    const t = p.total || {};
    box.innerHTML = `<div class="gm-prof gm-look-card"><i class="gm-ava big">${p.avatar ? `<img src="${esc(img(p.avatar))}" alt="">` : `<span>${esc(initials2(p.name))}</span>`}</i><div><h3>${esc(p.name || "Steam")}</h3><small class="ny-hint">${p.level != null ? `Уровень ${p.level}` : ""}${t.games != null ? ` · ${fmtNum(t.games)} игр · ${fmtNum(t.hours)} ч` : " · библиотека закрыта"}</small></div></div>${(p.top || []).length ? `<div class="gm-grid">${p.top.map(g => `<button type="button" class="gm-card lib" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div><div class="gm-pr"><small>${esc(fmtHours(g.hours))}</small></div></button>`).join("")}</div>` : ""}`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Профиль не найден.")}</small>`; }
}

async function syncSteamWishlist() {
  if (!me || !me.steamid) { toast("Сначала привяжите Steam.", "error"); return; }
  try {
    const r = await apiPost("/games/wishlist/sync");
    if (r && r.error) toast(r.error, "error");
    else toast(r && (r.added || r.removed) ? `Синхронизировано: добавлено ${r.added}, убрано ${r.removed}.` : "Список уже актуален.", "success");
    if (tab === "wish") paintWish();
  } catch (e) { toast(e.message || "Не удалось синхронизировать.", "error"); }
}

async function exportWishlist() {
  try {
    const r = await apiGet("/games/wishlist/export");
    await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
    toast(`Список скопирован (${r.items.length}). Вставьте его в файл или отправьте себе.`, "success");
  } catch (e) { toast(e.message || "Не удалось скопировать.", "error"); }
}

function importWishlist() {
  const ov = gmSheet(`<h2>Импорт желаемого</h2><p class="ny-hint">Вставьте JSON, полученный через «Скопировать список». Уже имеющиеся игры не затираются.</p><textarea id="gm-imp" class="gm-imp" rows="8" spellcheck="false"></textarea><div class="gm-d-act"><button type="button" class="btn primary" data-imp-go>Импортировать</button><button type="button" class="btn ghost" data-d-close>Закрыть</button></div>`);
  ov.addEventListener("click", async e => {
    if (e.target.closest("[data-d-close]")) { dismissSheet(ov); return; }
    if (!e.target.closest("[data-imp-go]")) return;
    try {
      const data = JSON.parse(ov.querySelector("#gm-imp").value);
      const r = await apiPost("/games/wishlist/import", { items: Array.isArray(data) ? data : data.items });
      dismissSheet(ov);
      toast(`Импортировано: ${r.imported}.`, "success");
      if (tab === "wish") paintWish();
    } catch (err) { toast(err instanceof SyntaxError ? "Это не похоже на экспорт списка (нужен JSON)." : err.message, "error"); }
  });
}

async function loadStatus() {
  const box = $("#gm-status");
  if (!box) return;
  try {
    const r = await apiGet("/games/status");
    const when = ts => (ts ? new Date(ts * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "ещё не было");
    box.innerHTML = `<small class="ny-hint">Проверка желаемого: ${esc(when(r.last_wishlist_check))} · сбор цен: ${esc(when(r.last_crawl))} · копия базы: ${esc(r.last_backup || "ещё не было")}<br>Точек цены: ${fmtNum(r.price_points)} · точек онлайна: ${fmtNum(r.players_points)} · уведомлений отправлено: ${fmtNum(r.alerts_total)} · ключ Steam: ${r.steam_key ? "есть" : "нет"}</small>`;
  } catch (_) { box.innerHTML = ""; }
}

async function loadRegions(ov, appid) {
  const box = ov.querySelector("#gm-reg");
  if (!box) return;
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Запрашиваю цены по странам…</div>`;
  try {
    const r = await apiGet(`/games/app/${appid}/regions`);
    if (!r.items.length) { box.innerHTML = `<small class="ny-hint">Цены по странам недоступны.</small>`; return; }
    const cheapest = r.items.find(x => x.usd != null);
    box.innerHTML = `<div class="gm-regt">
      <div class="gm-regh"><b>Цены по странам</b><small class="ny-hint">${r.rates ? `в пересчёте на ${esc(r.my_currency || "вашу валюту")} по курсу` : "курсы валют недоступны — сравнение приблизительное"}</small></div>
      ${r.items.map(x => {
        const d = pctText(x.vs_mine);
        const mine = x.cc === r.my_cc;
        const conv = x.conv != null && x.currency !== r.my_currency ? `≈ ${esc(priceView({ final: x.conv, initial: x.conv, discount: 0, currency: r.my_currency }).now)}` : "";
        return `<div class="gm-regr${mine ? " mine" : ""}${cheapest && x.cc === cheapest.cc ? " best" : ""}"><span>${esc(x.name)}${mine ? ` <i>ваша</i>` : ""}${cheapest && x.cc === cheapest.cc ? ` <i class="b">дешевле всего</i>` : ""}</span><span class="gm-tc">${x.discount ? `<i class="gm-badge sm">−${x.discount}%</i>` : ""}<b>${esc(priceView(x).now)}</b></span><span class="gm-tc ny-hint">${conv}</span><span class="gm-tc gm-d ${d.cls}">${esc(d.text)}</span></div>`;
      }).join("")}
    </div>`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить цены по странам.")}</small>`; }
}

async function loadOnline(ov, appid, range, quiet = false) {
  const box = ov.querySelector("#gm-online");
  if (!box) return;
  ov.__orange = range;
  box.querySelectorAll("[data-orange]").forEach(b => b.classList.toggle("on", b.dataset.orange === range));
  const st = box.querySelector(".gm-online-s"), ch = box.querySelector(".gm-online-c");
  if (!quiet) ch.innerHTML = `<span class="ny-sk blk"></span>`;
  try {
    const r = await apiGet(`/games/app/${appid}/charts`, { range });
    if (!ov.isConnected) return;
    const now = ov.querySelector("#gm-now"); if (now) now.textContent = fmtNum(r.now);
    const rk = ov.querySelector("#gm-rank"); if (rk) rk.textContent = r.rank ? `№${r.rank} по онлайну сейчас` : "";
    st.innerHTML = `<div><small>Сейчас</small><b class="gm-green">${fmtNum(r.now)}</b></div><div><small>Пик за 24 ч</small><b>${fmtNum(r.peak24)}</b></div><div><small>Среднее за 24 ч</small><b>${fmtNum(r.avg24)}</b></div><div><small>Пик у нас${r.since ? ` с ${esc(shortDate(r.since))}` : ""}</small><b>${fmtNum(r.peak_all)}</b></div>`;
    const short = range === "48h" || range === "7d";
    const g = r.points && r.points.length ? seriesChart(r.points.map(p => ({ ts: p.ts, v: p.n })), { step: false, h: 190 }) : null;
    if (!g) { ch.innerHTML = `<small class="ny-hint">Точек пока нет. Они записываются каждые 5 минут (у открытой игры — каждые 2), график появится сам.</small>`; return; }
    ch.innerHTML = chartSvg(g, "online", fmtCompact, ts => (range === "48h" ? fmtDMHM(ts) : short ? fmtDM(ts) : fmtDM(ts)));
    attachHover(ch, g, false, (p) => `<b>${fmtNum(p.v)}</b><small>${esc(fmtDMHM(p.ts))}</small>`);
    if (r.points.length < 3) ch.insertAdjacentHTML("beforeend", `<small class="ny-hint gm-flat">Записано точек: ${r.points.length}. Следующие появятся через 2–5 минут, график обновляется сам.</small>`);
  } catch (e) { if (!quiet) ch.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить онлайн.")}</small>`; }
}

async function launch(appid) {
  try {
    const r = await apiGet(`/games/launch/${appid}`, { steamid: me && me.steamid });
    if (!isSteamLaunchUrl(r.url)) throw new Error("Сервер вернул неожиданный адрес запуска.");
    await openExternal(r.url);
    toast("Запускаю через Steam…", "success");
  } catch (e) { toast(e.message || "Не удалось запустить игру.", "error"); }
}

async function refreshMe() {
  me = await apiGet("/games/me");
  lib = null;
  paintWho();
}

// ---------- события ----------
async function onClick(e) {
  const t = e.target;
  const g = t.closest("[data-gtab]");
  if (g) { switchG(g.dataset.gtab); return; }
  const go = t.closest("[data-gtab-go]");
  if (go) { switchG(go.dataset.gtabGo); return; }
  if (t.closest("#gm-beta")) { maybeWarnBeta(true); return; }
  if (t.closest("#gm-who")) { document.dispatchEvent(new CustomEvent("project:open-chooser")); return; }
  if (t.closest("[data-gretry]")) { storeHome = null; switchG(tab); return; }
  const ct = t.closest("[data-ctab]");
  if (ct) { chartTab = ct.dataset.ctab; paintCharts(); return; }
  const lb = t.closest("[data-launch]");
  if (lb) { e.stopPropagation(); launch(Number(lb.dataset.launch)); return; }
  const del = t.closest("[data-wish-del]");
  if (del) { e.stopPropagation(); try { await apiDelete(`/games/wishlist/${del.dataset.wishDel}`); paintWish(); } catch (err) { toast(err.message, "error"); } return; }
  if (t.closest("[data-lunplayed]")) { libUnplayed = !libUnplayed; paintLib(); return; }
  if (t.closest("[data-lfamily]")) { libFamily = !libFamily; paintLib(); return; }
  if (t.closest("[data-lrandom]")) {
    const pool = sortLibrary((lib && lib.items) || [], "recent", libUnplayed);
    if (!pool.length) { toast("В библиотеке пусто.", "error"); return; }
    const g = pool[Math.floor(Math.random() * pool.length)];
    openDetail(g.appid, g.name || "");
    return;
  }
  if (t.closest("[data-wl-steam]")) { syncSteamWishlist(); return; }
  if (t.closest("[data-friends]")) { loadFriends(); return; }
  if (t.closest("[data-wl-export]")) { exportWishlist(); return; }
  if (t.closest("[data-wl-import]")) { importWishlist(); return; }
  if (t.closest("[data-rgo]")) { rel.view = "list"; rel.range = null; rel.kind = "up"; rel.week = mondayOf(relToday()); switchG("rel"); return; }
  const stb = t.closest("[data-stab]");
  if (stb) { stab.tab = stb.dataset.stab; stab.more = false; stab.sel = 0; loadStabs(); return; }
  if (t.closest("[data-smore]")) { stab.more = !stab.more; paintStabs(); return; }
  const rv = t.closest("[data-rview]");
  if (rv) { rel.view = rv.dataset.rview; paintReleases(); return; }
  const rm = t.closest("[data-rmonth]");
  if (rm) { rel.month = rm.dataset.rmonth; paintReleases(); return; }
  const rk = t.closest("[data-rkind]");
  if (rk) { rel.kind = rk.dataset.rkind; paintReleases(); return; }
  const rwk = t.closest("[data-rweek]");
  if (rwk) { const n = Number(rwk.dataset.rweek); rel.range = null; rel.week = n === 0 ? mondayOf(relToday()) : addDays(rel.week, n * 7); paintReleases(); return; }
  const rwd = t.closest("[data-rwkdate]");
  if (rwd) { rel.view = "list"; rel.range = null; rel.week = rwd.dataset.rwkdate; rel.kind = "all"; paintReleases(); return; }
  const rr = t.closest("[data-rrange]");
  if (rr) {
    const td = relToday();
    rel.view = "list";
    rel.range = rr.dataset.rrange === "up" ? { from: td, to: addDays(td, 60), label: "Все предстоящие выходы на 60 дней" } : { from: addDays(td, -21), to: td, label: "Недавно вышедшие (21 день)" };
    rel.kind = rr.dataset.rrange === "up" ? "up" : "done";
    paintReleases();
    return;
  }
  const rml = t.closest("[data-rmonthlist]");
  if (rml) { const ym = rml.dataset.rmonthlist; const [y, m] = ym.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); rel.view = "list"; rel.kind = "all"; rel.range = { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}`, label: `Все выходы: ${monthLong(ym)}` }; paintReleases(); return; }
  const rd = t.closest("[data-rday]");
  if (rd) { e.stopPropagation(); openRelDay(rd.dataset.rday); return; }
  const sb = t.closest("[data-sbrowse]");
  if (sb) {
    const k = sb.dataset.sbrowse;
    if (k === "soon") openBrowse({ tag: 0, name: "Скоро выйдут", soon: 1, discount: 0, sort: "popular", items: [] });
    else if (k === "sale") openBrowse({ tag: 0, name: "Со скидкой", soon: 0, discount: 30, sort: "popular", items: [] });
    else openBrowse({ tag: Number(k), name: sb.dataset.sname || "Жанр", soon: 0, discount: 0, items: [] });
    return;
  }
  if (t.closest("[data-sback]")) { storeBrowse = null; paintStore(); return; }
  if (t.closest("[data-smore]")) { paintBrowse(true); return; }
  const ss = t.closest("[data-ssort]");
  if (ss) { openBrowse({ sort: ss.dataset.ssort, items: [] }); return; }
  const sd = t.closest("[data-sdisc]");
  if (sd) { openBrowse({ discount: Number(sd.dataset.sdisc), items: [] }); return; }
  const rl = t.closest("[data-rail]");
  if (rl) { const rail = rl.parentElement.querySelector(".gm-rail"); if (rail) rail.scrollBy({ left: Number(rl.dataset.rail) * rail.clientWidth * 0.85, behavior: "smooth" }); return; }
  const hd = t.closest("[data-shero]");
  if (hd) { heroCtl.go(Number(hd.dataset.shero)); heroCtl.start(); return; }
  const pn = t.closest("[data-pgnav]");
  if (pn) { const [k, d] = pn.dataset.pgnav.split(":"); pagerGo(k, (pagerIdx[k] || 0) + Number(d)); return; }
  const pd = t.closest("[data-pgdot]");
  if (pd) { const [k, i] = pd.dataset.pgdot.split(":"); pagerGo(k, Number(i)); return; }
  const dm = t.closest("[data-dmin]");
  if (dm) { deals.min = Number(dm.dataset.dmin); const bar = $("#gm-dbar") || document.querySelector(".gm-dbar"); if (bar) bar.querySelectorAll("[data-dmin]").forEach(b => b.classList.toggle("on", b === dm)); refreshDeals(); return; }
  if (t.closest("[data-dmore]")) { refreshDeals(true); return; }
  const wm = t.closest("[data-wmode]");
  if (wm) { wishMode = wm.dataset.wmode; $("#gm-wbar").innerHTML = wishBarHtml(); $("#gm-wlist").innerHTML = wishListHtml(); return; }
  if (t.closest("[data-gadd]")) {
    toast("Откроется сайт Steam — подтвердите вход, затем вернитесь сюда.");
    try { me = await linkSteam(); lib = null; paintWho(); toast("Steam привязан.", "success"); switchG(tab); } catch (err) { toast(err.message, "error"); }
    return;
  }
  const sel = t.closest("[data-gsel]");
  if (sel) { try { await apiPost("/games/steam/select", { steamid: sel.dataset.gsel }); await refreshMe(); switchG("set"); } catch (err) { toast(err.message, "error"); } return; }
  const un = t.closest("[data-gunlink]");
  if (un) { try { await apiPost("/games/steam/unlink", { steamid: un.dataset.gunlink }); await refreshMe(); switchG("set"); toast("Аккаунт отвязан.", "success"); } catch (err) { toast(err.message, "error"); } return; }
  const card = t.closest("[data-app]");
  if (card && !t.closest("button[data-launch], [data-wish-del], .gm-wctl, [data-sbrowse], [data-rday], [data-rwkdate]")) openDetail(Number(card.dataset.app), card.dataset.name || "");
}

// Картинка не открылась → следующий запасной адрес; адреса кончились → заглушка с инициалами.
document.addEventListener("error", e => {
  const im = e.target;
  if (!im || im.tagName !== "IMG" || !im.dataset || !im.dataset.id || !im.closest("#games-screen, .gm-ov")) return;
  const list = imageCandidates(im.dataset.id, im.dataset.p);
  const n = Number(im.dataset.n || 0) + 1;
  if (n < list.length) { im.dataset.n = String(n); im.src = img(list[n]); return; }
  const box = im.parentElement;
  im.remove();
  if (box) box.classList.add("noimg");
}, true);

document.addEventListener("change", async e => {
  if (!gamesVisible()) return;
  if (e.target.id === "gm-dsort") { deals.sort = e.target.value; refreshDeals(); }
  if (e.target.id === "gm-dtag") { deals.tag = Number(e.target.value); refreshDeals(); }
  if (e.target.id === "gm-drev") { deals.minpct = Number(e.target.value); refreshDeals(); }
  if (e.target.dataset && e.target.dataset.pers !== undefined) {
    try { localStorage.setItem("project-games-pers", e.target.checked ? "1" : "0"); } catch (_) { /* не критично */ }
    if (tab === "rel") paintReleases();
  }
  if (e.target.dataset && e.target.dataset.sopt) {
    stab[e.target.dataset.sopt] = e.target.checked;
    stab.sel = 0;
    loadStabs();
    return;
  }
  if (e.target.dataset && e.target.dataset.adult !== undefined) {
    try { localStorage.setItem("project-games-adult", e.target.checked ? "1" : "0"); } catch (_) { /* не критично */ }
    storeCal = null;
    stab.cache = {};
    if (tab === "rel") paintReleases(); else if (tab === "store") { const box = $("#gm-cal"); if (box) { box.innerHTML = ""; loadCalendar(); } loadStabs(); }
  }
  if (e.target.id === "gm-cyc") { try { localStorage.setItem("project-games-cycle", e.target.checked ? "1" : "0"); } catch (_) { /* не критично */ } relCycleStart(); }
  if (e.target.id === "gm-ronly") { rel.only = e.target.value; paintReleases(); }
  if (e.target.id === "gm-wsort") { wishSort = e.target.value; if (wishData && $("#gm-wlist")) $("#gm-wlist").innerHTML = wishListHtml(); }
  if (e.target.classList && (e.target.classList.contains("gm-wt") || e.target.classList.contains("gm-wd"))) saveWishTarget(e.target.closest(".gm-wcard"));
  if (e.target.id === "gm-lsort") { libSort = e.target.value; paintLib(); }
  if (e.target.id === "gm-poll") { try { localStorage.setItem(POLL_KEY, e.target.value); } catch (_) { /* не критично */ } restartAlertPolling(); toast("Частота проверки сохранена.", "success"); }
  if (e.target.id === "gm-npr") { setNotifyKind("price", e.target.checked); }
  if (e.target.id === "gm-cc") {
    try { await apiPost("/games/me", { cc: e.target.value }); me.cc = e.target.value; storeHome = null; storeBrowse = null; storeCal = null; deals.items = []; toast("Страна цен сохранена.", "success"); } catch (err) { toast(err.message, "error"); }
  }
});
document.addEventListener("mouseover", e => {
  const trow = e.target.closest && e.target.closest("[data-trow]");
  if (trow && gamesVisible()) {
    const i = Number(trow.dataset.trow), list = trow.closest("[data-slist]"), box = $("#gm-stabs");
    const shown = stab.more ? stab.items : stab.items.slice(0, STAB_SHOWN);
    if (list && box && stab.sel !== i && shown[i]) {
      stab.sel = i;
      list.querySelectorAll(".gm-sr").forEach((b, k) => b.classList.toggle("on", k === i));
      const panel = box.querySelector("[data-spanel]");
      if (panel) panel.innerHTML = panelHtml(shown[i], img);
    }
    return;
  }
  const pip = e.target.closest && e.target.closest("[data-pip]");
  if (pip && gamesVisible()) {
    const [d, i] = pip.dataset.pip.split(":");
    const cell = pip.closest(".gm-rc-cell"), items = relCells.get(d);
    if (cell && items && items[Number(i)] && cell.dataset.i !== i) { cell.dataset.i = i; relPaintCell(cell, items, Number(i)); }
    return;
  }
});
document.addEventListener("submit", e => {
  if (gamesVisible() && e.target.id === "gm-look") { e.preventDefault(); const q = $("#gm-lookq").value.trim(); if (q.length >= 2) lookupProfile(q); }
});
document.addEventListener("input", e => {
  if (gamesVisible() && e.target.id === "gm-rq") { clearTimeout(relTimer); rel.q = e.target.value; relTimer = setTimeout(() => paintRelList(), 300); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-dq") { clearTimeout(dealsTimer); deals.q = e.target.value; dealsTimer = setTimeout(() => refreshDeals(), 300); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-dmax") { clearTimeout(dealsTimer); deals.maxprice = Number(e.target.value) || 0; dealsTimer = setTimeout(() => refreshDeals(), 400); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-wq") { clearTimeout(wishTimer); wishQ = e.target.value; wishTimer = setTimeout(() => { if (wishData && $("#gm-wlist")) { $("#gm-wlist").innerHTML = wishListHtml(); } }, 200); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-lf") { libFilter = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(paintLib, 250); } // DevSkim: ignore DS172411 — функция, не строка
});
