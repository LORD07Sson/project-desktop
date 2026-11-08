// Игровое пространство («Кого войдём?» → профиль Steam): отдельная оболочка со своими разделами —
// Магазин, Скидки, Желаемое, Библиотека, Настройки. Данные — только с нашего сервера (/api/games/*),
// который берёт их у официальных точек Steam. Игры запускаются из СВОЕЙ библиотеки через steam://run/<id>,
// то есть лицензионной копией через клиент Steam.

import { apiGet, apiPost, apiDelete, mediaUrl, ensureMediaToken, forceMediaToken, toast, openSheet, dismissSheet, dialogSkeletonHtml } from "./api.js";

import { $, esc } from "./utils.js";
import { alertText, sortLibrary, dayLabel, chunk, addDays, mondayOf, priceView, initials2, imageCandidates, hueOf, fmtNum } from "./games-core.js";
import { linkSteam } from "./steam-link.js";


import { tabsHtml, panelHtml, STAB_SHOWN } from "./games-tabs.js";
import { createHero } from "./games-hero.js";

import { watchBoxHtml, notifPanelHtml, unreadCount } from "./games-watch.js";
import { sessionStatus, beginQr, pollQr, signOutSteam, steamApi } from "./steam-session.js";
import { cardsFrom, accountPanelHtml, bannerCards, equippedItems } from "./steam-personal.js";
import { sessionHtml, sessionCompactHtml, qrSheetHtml, qrExpiredHtml } from "./steam-session-ui.js";
import { notifyDesktop, setNotifyKind } from "./desktop-notify.js";
import { paintCharts, paintDeals, paintWish, refreshDeals, saveWishTarget, wishBarHtml, wishData, wishListHtml } from "./games-charts.js";
import { adultLabel, adultOn, adultParam, monthLong, openRelDay, paintLib, paintRelList, paintReleases, paintSettings, rel, relCells, relCycle, relCycleStart, relPaintCell, relTimer, relToday, setRelTimer } from "./games-releases.js";
import { exportWishlist, importWishlist, launch, loadFriends, lookupProfile, openDetail, paintProfile, refreshMe, syncSteamWishlist } from "./games-card.js";
export { openDetail } from "./games-card.js";

const TABS = [["store", "Магазин"], ["charts", "Чарты"], ["rel", "Релизы"], ["deals", "Скидки"], ["wish", "Желаемое"], ["lib", "Библиотека"], ["profile", "Профиль"], ["set", "Настройки"]];

export let me = null;                 // ответ /games/me
export let lib = null;                // { steamid, items, ids:Set }
export let tab = "store";
export let deals = { min: 10, max: 24, maxprice: 0, minpct: 0, sort: "discount", tag: 0, q: "", items: [], total: 0, all: 0, seq: 0 };
export let wishMode = "all", wishQ = "", wishCat = "", wishCats = null;
let searchTimer = 0, searchSeq = 0;
export let libFilter = "";
export let wishSort = "close", libSort = "recent", libUnplayed = false;
export let libFamily = false;
export let tagList = null;
let dealsTimer = 0, wishTimer = 0;
const POLL_KEY = "project_games_poll";
export const pollMs = () => { try { return Math.max(60000, Number(localStorage.getItem(POLL_KEY)) || 120000); } catch (_) { return 120000; } };
export let chartTab = "overview";
export const CHART_TABS = [["overview", "Сводка"], ["online", "Онлайн сейчас"], ["trending", "Тренды"], ["releases", "Новые релизы"], ["upcoming", "Скоро выйдут"], ["changes", "Изменения цен"]];

export const gmSheet = (html, variant) => { const o = openSheet(html, variant); o.classList.add("gm-show"); return o; };
export const img = url => (url ? mediaUrl("/img_proxy", { url }) : "");

// Обложка с запасными адресами: если картинка не открылась, пробуем следующий адрес, а в конце рисуем заглушку с инициалами.
export function picHtml(appid, primary, name, cls = "gm-img", extra = "") {
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
    <div class="gm-backdrop" aria-hidden="true"><i></i><i></i></div>
    <header class="gm-top">
      <button type="button" class="gm-who" id="gm-who" title="Сменить профиль"></button>
      <nav class="gm-nav" id="gm-nav" aria-label="Игры">${TABS.map(([k, l]) => `<button type="button" data-gtab="${k}">${l}</button>`).join("")}</nav>
      <button type="button" class="gm-bell" id="gm-bell" title="Уведомления игр" aria-label="Уведомления игр"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20a2 2 0 0 0 4 0"/></svg><i id="gm-bell-n" hidden></i></button>
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

export function paintWho() {
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
const ALERTS_OPEN_KEY = "project-games-alerts-open";
const alertsOpenAt = () => { try { return Number(localStorage.getItem(ALERTS_OPEN_KEY)) || 0; } catch (_) { return 0; } };
let alertList = [];
function paintBell() {
  const n = $("#gm-bell-n");
  if (!n) return;
  const c = unreadCount(alertList, alertsOpenAt());
  n.textContent = c > 99 ? "99+" : String(c);
  n.hidden = !c;
}
async function pollAlerts() {
  try {
    const all = await apiGet("/games/alerts");
    alertList = (all && all.items) || [];
    paintBell();
    const items = alertList.filter(a => !a.seen);
    if (!items.length) return;
    for (const a of items.slice(0, 5)) {
      const t = alertText(a);
      if (document.hasFocus()) toast(`${t.title}. ${t.body}`, "success"); else notifyDesktop(t.title, t.body, a.kind === "update" || a.kind === "release" ? "gupdate" : "price");
    }
    await apiPost("/games/alerts/seen", { ids: items.map(a => a.id) });
    if (tab === "wish" && gamesVisible()) paintWish();
  } catch (_) { /* сеть или сервер недоступны — попробуем в следующий раз */ }
}
let watchData = null;
async function loadWatch() {
  try { watchData = await apiGet("/games/watch"); } catch (_) { watchData = watchData || { items: [], wishlist: [] }; }
  return watchData;
}

async function openNotifPanel() {
  const at = alertsOpenAt();
  const ov = gmSheet(dialogSkeletonHtml(4));
  try {
    const [w] = await Promise.all([loadWatch(), pollAlerts()]);
    if (!ov.isConnected) return;
    ov.querySelector(".sheet").innerHTML = notifPanelHtml({ alerts: alertList, watch: w.items || [] }, at, img);
    try { localStorage.setItem(ALERTS_OPEN_KEY, String(Math.floor(Date.now() / 1000))); } catch (_) { /* счётчик не запомнится */ }
    paintBell();
  } catch (e) { if (ov.isConnected) ov.querySelector(".sheet").innerHTML = errBox(e); }
  ov.addEventListener("click", ev => {
    const d = ev.target.closest("[data-watch-del]");
    if (d) {
      apiDelete(`/games/watch/${d.dataset.watchDel}`).then(() => { if (watchData) watchData.items = watchData.items.filter(x => String(x.appid) !== d.dataset.watchDel); d.closest(".gm-nw").remove(); }).catch(err => toast(err.message || "Не удалось.", "error"));
      return;
    }
    if (ev.target.closest("[data-d-close]")) { dismissSheet(ov); return; }
    const a = ev.target.closest("[data-app]");
    if (a) { dismissSheet(ov); openDetail(Number(a.dataset.app), a.dataset.name); }
  });
}

async function saveWatch(box) {
  const appid = Number(box.dataset.watchApp);
  const updates = !!box.querySelector("[data-w-upd]").checked, relEl = box.querySelector("[data-w-rel]");
  const release = relEl ? !!relEl.checked : false;
  try {
    await apiPost(`/games/watch/${appid}`, { name: (box.closest(".gm-ov") && box.closest(".gm-ov").__d && box.closest(".gm-ov").__d.name) || "", updates, release });
    await loadWatch();
    toast(updates || release ? "Следим: сообщим в «Уведомлениях»." : "Больше не следим.", "success");
  } catch (e) { toast(e.message || "Не удалось сохранить.", "error"); }
}

export async function loadWatchBox(ov, appid) {
  const box = ov.querySelector("#gm-watchbox");
  if (!box) return;
  const w = await loadWatch();
  if (!ov.isConnected || ov.querySelector("#gm-watchbox") !== box) return;
  const st = (w.items || []).find(x => x.appid === appid) || null;
  const d = ov.__d || {};
  box.innerHTML = watchBoxHtml(appid, st, { released: !d.coming_soon, inWishlist: !!d.wishlisted || (w.wishlist || []).includes(appid) });
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

export async function loadLibrary(force) {
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

export const skeleton = (n = 10) => `<div class="gm-grid">${Array.from({ length: n }, () => `<div class="gm-card sk"><div class="gm-img"><span class="ny-sk blk"></span></div><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div>`).join("")}</div>`;
export const empty = (title, text, btn = "") => `<div class="gm-empty"><b>${esc(title)}</b><p>${esc(text)}</p>${btn}</div>`;
export const errBox = e => empty("Не получилось загрузить", e && e.message ? e.message : String(e), `<button type="button" class="btn" data-gretry>Повторить</button>`);

export function cardHtml(g, extra = "") {
  const v = priceView(g.price);
  const owned = lib && lib.ids.has(g.appid);
  return `<button type="button" class="gm-card${owned ? " owned" : ""}" data-app="${g.appid}" data-name="${esc(g.name)}">
    ${picHtml(g.appid, g.image, g.name, "gm-img", `${v.badge ? `<i class="gm-badge">${v.badge}</i>` : ""}${owned ? `<i class="gm-own" title="Есть в вашей библиотеке">✓</i>` : ""}${g.wishlisted ? `<i class="gm-heart" title="В желаемом">♥</i>` : ""}`)}
    <div class="gm-t">${esc(g.name)}</div>
    <div class="gm-pr">${g.price == null && g.label ? `<b>${esc(g.label)}</b>` : `${v.old ? `<s>${esc(v.old)}</s>` : ""}<b class="${v.sale ? "sale" : ""}">${esc(v.now)}</b>`}${g.pct && g.reviews >= 50 ? `<small class="gm-rv" title="${fmtNum(g.reviews)} отзывов">👍 ${g.pct}%</small>` : ""}</div>${extra}</button>`;
}

let storeHome = null, storeBrowse = null, storeCal = null;
const STORE_TTL = 60000;       // главная живая: при открытии вкладки данные старше минуты берём заново
let storeAt = 0;

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
    if (!storeHome || Date.now() - storeAt > STORE_TTL) {
      const had = !!storeHome;
      storeHome = await apiGet("/games/store/home");
      storeAt = Date.now();
      if (had) { stab.cache = {}; storeCal = null; loadLibrary(true).catch(() => { /* отметки «в библиотеке» не критичны */ }); }
    }
    if (tab !== "store" || $("#gm-q").value.trim().length >= 2 || storeBrowse) return;
    const h = storeHome;
    if (h.personalHero === undefined) {                       // привязан Steam: герой по кластерам вкусов и личной оценке Steam (сервер, кэш час)
      h.personalHero = [];
      if (me && me.steamid) { try { h.personalHero = (await apiGet("/games/store/hero")).items || []; } catch (_) { /* останется общий герой */ } }
      if (tab !== "store" || $("#gm-q").value.trim().length >= 2 || storeBrowse) return;
    }
    const sec = h.sections || [];
    const rows = sec.map(x => railSection(x.title, x.items, x.go ? `<button type="button" class="ny-link" data-gtab-go="${x.go}">все →</button>` : "")).join("");
    body.innerHTML = `<div class="gm-sh">` + heroHtml(h.personalHero.length ? h.personalHero : h.hero) + genreChips() + dealsPagerHtml(h) + `<section class="gm-stabs" id="gm-stabs"></section><div id="gm-cal"></div><div id="gm-foryou"></div><div id="gm-mysteam"></div>` + (rows || empty("Пусто", "Steam не вернул подборки.")) + `</div>`;
    heroCtl.start();
    loadStabs();
    loadForYou();
    loadMySteam();
    loadCalendar();
  } catch (e) { body.innerHTML = errBox(e); }
}

// Валюта цен региона: Steam в этих ответах код валюты не присылает, берём её из уже загруженных цен витрины.
const spCur = () => { for (const x of (storeHome && storeHome.sections) || []) for (const g of x.items || []) if (g.price && g.price.currency) return g.price.currency; return "USD"; };
export const spCtx = cc => ({ language: "russian", country_code: cc });
async function discoveryQueue(cc) {
  const r = await steamApi("IStoreService", "GetDiscoveryQueue", { queue_type: 0, country_code: cc, rebuild_queue: false, context: spCtx(cc), data_request: { include_basic_info: true, include_assets: true } });
  return r.status === 200 ? cardsFrom(r.body, "store_items", spCur()) : [];
}
async function steamBanners(cc) {
  const r = await steamApi("IMarketingMessagesService", "GetMarketingMessagesForUser", { include_seen_messages: true, country_code: cc, elanguage: 0, context: spCtx(cc), data_request: { include_basic_info: true, include_assets: true, include_all_purchase_options: true } });
  return r.status === 200 ? bannerCards(r.body, spCur()) : [];
}
async function wishlistOnSale(cc) {
  const r = await steamApi("IWishlistService", "GetWishlistItemsOnSale", { context: spCtx(cc), data_request: { include_basic_info: true, include_assets: true } });
  return r.status === 200 ? cardsFrom(r.body, "items", spCur()) : [];
}

// Личные подборки по токену входа (только если вход выполнен): желаемое со скидкой и очередь открытий Steam.
async function loadMySteam() {
  let st = null;
  try { st = await sessionStatus(); } catch (_) { return; }
  if (!st || !st.signed_in) return;
  const cc = (me && me.cc) || "US";
  const [sale, queue, banners] = await Promise.all([wishlistOnSale(cc).catch(() => []), discoveryQueue(cc).catch(() => []), steamBanners(cc).catch(() => [])]);
  const box = $("#gm-mysteam");
  if (!box || tab !== "store" || storeBrowse) return;
  box.innerHTML = railSection("Steam рекомендует вам", banners) + railSection("Желаемое со скидкой", sale) + railSection("Очередь открытий Steam", queue);
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

// ---------- расширенные возможности Steam: вход по QR, токен только на этом компьютере (Rust: steam_session.rs) ----------
export async function paintSession() {
  const box = $("#gm-sess-body");
  if (!box) return;
  let st = null;
  try { st = await sessionStatus(); } catch (_) { /* не в приложении на компьютере */ }
  const now = $("#gm-sess-body");
  if (now) {
    const html = now.dataset.compact ? sessionCompactHtml(st) : sessionHtml(st);
    now.innerHTML = html;
    if (now.parentElement && now.dataset.compact) now.parentElement.hidden = !html;     // в профиле, когда вход уже есть, блока нет
  }
  if (st && st.signed_in && $("#gm-acct")) loadAccountPanel();
  else { const a = $("#gm-acct"); if (a) a.innerHTML = ""; }
}

// Сводка аккаунта по токену: уведомления, карточки и предметы оформления профиля (три запроса чтения).
async function loadAccountPanel() {
  const call = (i, m, p) => steamApi(i, m, p).then(r => (r.status === 200 ? r.body : null)).catch(() => null);
  const [notes, cards, items, loyalty, equipped] = await Promise.all([
    call("ISteamNotificationService", "GetSteamNotifications", { include_hidden: false, language: 0, include_confirmation_count: true, include_pinned_counts: true, include_read: false, count_only: true }),
    call("IQuestService", "GetNumTradingCardsEarned", { steamid: me && me.steamid }),
    call("IPlayerService", "GetProfileItemsOwned", { language: "russian" }),
    call("ILoyaltyRewardsService", "GetSummary", { steamid: me && me.steamid }),
    call("IPlayerService", "GetProfileItemsEquipped", { steamid: me && me.steamid, language: "russian" }),
  ]);
  const box = $("#gm-acct");
  if (box && tab === "profile") box.innerHTML = accountPanelHtml({ notes, cards: cards && cards.num_trading_cards, items, points: loyalty && loyalty.summary && loyalty.summary.points, equipped: equippedItems(equipped) }, img);
}

async function openQrLogin() {
  let start;
  try { start = await beginQr(); } catch (e) { toast(`Не удалось начать вход: ${e && e.message ? e.message : e}`, "error"); return; }
  const ov = gmSheet(qrSheetHtml(start.url, "pending"));
  let clientId = start.client_id, url = start.url, status = "pending";
  const sheet = () => ov.querySelector(".sheet");
  const tick = async () => {
    if (!ov.isConnected) return;                                   // окно закрыли — опрос заканчивается
    try {
      const r = await pollQr(clientId, start.request_id);
      if (!ov.isConnected) return;
      if (r.status === "approved") { dismissSheet(ov); toast("Расширенные возможности Steam включены.", "success"); paintSession(); return; }
      if (r.status === "expired") { sheet().innerHTML = qrExpiredHtml(); return; }
      if (r.client_id) clientId = r.client_id;
      if (r.url && r.url !== url) { url = r.url; status = r.status; sheet().innerHTML = qrSheetHtml(url, status); }
      else if (r.status !== status) { status = r.status; sheet().innerHTML = qrSheetHtml(url, status); }
    } catch (e) { if (ov.isConnected) sheet().innerHTML = `<h2>Вход в Steam</h2>${errBox(e)}<div class="gm-d-act"><button type="button" class="btn" data-d-close>Закрыть</button></div>`; return; }
    setTimeout(tick, start.interval * 1000); // DevSkim: ignore DS172411 — функция, не строка
  };
  setTimeout(tick, start.interval * 1000); // DevSkim: ignore DS172411 — функция, не строка
  ov.addEventListener("click", ev => {
    if (ev.target.closest("[data-d-close]")) dismissSheet(ov);
    else if (ev.target.closest("[data-sess-in]")) { dismissSheet(ov); openQrLogin(); }
  });
}

// ---------- события ----------
async function onClick(e) {
  const t = e.target;
  const g = t.closest("[data-gtab]");
  if (g) { switchG(g.dataset.gtab); return; }
  const go = t.closest("[data-gtab-go]");
  if (go) { switchG(go.dataset.gtabGo); return; }
  if (t.closest("#gm-beta")) { maybeWarnBeta(true); return; }
  if (t.closest("#gm-bell")) { openNotifPanel(); return; }
  if (t.closest("#gm-who")) { document.dispatchEvent(new CustomEvent("project:open-chooser")); return; }
  if (t.closest("[data-gretry]")) { storeHome = null; switchG(tab); return; }
  const ct = t.closest("[data-ctab]");
  if (ct) { chartTab = ct.dataset.ctab; paintCharts(); return; }
  const lb = t.closest("[data-launch]");
  if (lb) { e.stopPropagation(); launch(Number(lb.dataset.launch), lb); return; }
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
  if (dm) { deals.min = Number(dm.dataset.dmin); deals.max = Number(dm.dataset.dmax); const bar = $("#gm-dbar") || document.querySelector(".gm-dbar"); if (bar) bar.querySelectorAll("[data-dmin]").forEach(b => b.classList.toggle("on", b === dm)); refreshDeals(); return; }
  if (t.closest("[data-dmore]")) { refreshDeals(true); return; }
  const wc = t.closest("[data-wcat]");
  if (wc) { wishCat = wc.dataset.wcat; $("#gm-wbar").innerHTML = wishBarHtml(); $("#gm-wlist").innerHTML = wishListHtml(); return; }
  const wm = t.closest("[data-wmode]");
  if (wm) { wishMode = wm.dataset.wmode; $("#gm-wbar").innerHTML = wishBarHtml(); $("#gm-wlist").innerHTML = wishListHtml(); return; }
  if (t.closest("[data-gadd]")) {
    toast("Откроется сайт Steam — подтвердите вход, затем вернитесь сюда.");
    try { me = await linkSteam(); lib = null; paintWho(); toast("Steam привязан.", "success"); switchG(tab); } catch (err) { toast(err.message, "error"); }
    return;
  }
  const sel = t.closest("[data-gsel]");
  if (sel) { try { await apiPost("/games/steam/select", { steamid: sel.dataset.gsel }); await refreshMe(); switchG("set"); } catch (err) { toast(err.message, "error"); } return; }
  if (t.closest("[data-sess-in]")) { openQrLogin(); return; }
  const sto = t.closest("[data-sess-out]");
  if (sto) { try { await signOutSteam(); toast("Вход стёрт: токена на этом компьютере больше нет.", "success"); } catch (e) { toast(e && e.message ? e.message : String(e), "error"); } paintSession(); return; }
  const un = t.closest("[data-gunlink]");
  if (un) { try { await apiPost("/games/steam/unlink", { steamid: un.dataset.gunlink }); await refreshMe(); switchG("set"); toast("Аккаунт отвязан.", "success"); } catch (err) { toast(err.message, "error"); } return; }
  const card = t.closest("[data-app]");
  if (card && !t.closest("button[data-launch], [data-wish-del], .gm-wctl, [data-sbrowse], [data-rday], [data-rwkdate]")) openDetail(Number(card.dataset.app), card.dataset.name || "");
}

// Картинка не открылась → следующий запасной адрес; адреса кончились → заглушка с инициалами.
document.addEventListener("error", async e => {
  const im = e.target;
  // Скриншоты в превью витрины: один повтор через несколько секунд (сервер мог на миг не достучаться
  // до Steam), не вышло — убираем кадр, а не оставляем рамку со значком «битой» картинки.
  if (im && im.tagName === "IMG" && im.parentElement && im.parentElement.classList.contains("gm-tp-shots")) {
    if (im.dataset.shotRetry !== "1") {
      im.dataset.shotRetry = "1";
      const src = im.src;
      setTimeout(() => { if (im.isConnected) { im.src = ""; im.src = src; } }, 4000);
    } else im.remove();
    return;
  }
  if (!im || im.tagName !== "IMG" || !im.dataset || !im.dataset.id || !im.closest("#games-screen, .gm-ov")) return;
  const list = imageCandidates(im.dataset.id, im.dataset.p);
  const current = Number(im.dataset.n || 0);
  // Steam thumbnails are lazy-loaded. Their short-lived media token may
  // expire before an off-screen image is requested, so refresh once and
  // retry the same valid Steam asset before moving to alternate URLs.
  if (im.dataset.mtRetry !== "1") {
    im.dataset.mtRetry = "1";
    await forceMediaToken();
    if (!im.isConnected) return;
    im.src = img(list[current]);
    return;
  }
  const n = current + 1;
  if (n < list.length) { im.dataset.n = String(n); im.src = img(list[n]); return; }
  const box = im.parentElement;
  im.remove();
  if (box) box.classList.add("noimg");
}, true);

document.addEventListener("change", async e => {
  const wb = e.target.closest && e.target.closest("[data-watch-app]");
  if (wb) { saveWatch(wb); return; }
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
let awayAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { awayAt = Date.now(); return; }
  if (!gamesVisible() || !awayAt || Date.now() - awayAt < 5 * 60000) return;
  awayAt = 0;
  const ae = document.activeElement;
  if (document.querySelector(".gm-ov") || (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;   // карточка игры сама живая, ввод не прерываем
  if (tab === "store" && (storeBrowse || ($("#gm-q") && $("#gm-q").value.trim().length >= 2))) return;
  switchG(tab);
});
document.addEventListener("submit", e => {
  if (gamesVisible() && e.target.id === "gm-look") { e.preventDefault(); const q = $("#gm-lookq").value.trim(); if (q.length >= 2) lookupProfile(q); }
});
document.addEventListener("input", e => {
  if (gamesVisible() && e.target.id === "gm-rq") { clearTimeout(relTimer); rel.q = e.target.value; setRelTimer( setTimeout(() => paintRelList(), 300)); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-dq") { clearTimeout(dealsTimer); deals.q = e.target.value; dealsTimer = setTimeout(() => refreshDeals(), 300); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-dmax") { clearTimeout(dealsTimer); deals.maxprice = Number(e.target.value) || 0; dealsTimer = setTimeout(() => refreshDeals(), 400); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-wq") { clearTimeout(wishTimer); wishQ = e.target.value; wishTimer = setTimeout(() => { if (wishData && $("#gm-wlist")) { $("#gm-wlist").innerHTML = wishListHtml(); } }, 200); } // DevSkim: ignore DS172411 — функция, не строка
  if (gamesVisible() && e.target.id === "gm-lf") { libFilter = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(paintLib, 250); } // DevSkim: ignore DS172411 — функция, не строка
});

export function setMe(value) { me = value; return value; }
export function setLib(value) { lib = value; return value; }
export function setWishCats(value) { wishCats = value; return value; }
export function setTagList(value) { tagList = value; return value; }
