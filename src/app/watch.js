// Режим «Смотреть» — витрина в духе стриминга поверх приложения:
// большой баннер, ряды «В тренде / Озвучивает студия / Онгоинги /
// Скоро выйдет / Рекомендуем», жанры, поиск, «Мой список». Кнопка
// «Смотреть» в шапке плавно раскрывает режим кругом из себя, «← Студия»
// сворачивает обратно.
//
// Данные — /api/watch/home: каталог Shikimori (+ картинки AniList,
// кэш сервера 6 ч) и тайтлы из сезонов студии с ходом озвучки.
// Подробности тайтла каталога — /api/watch/anime/{shiki_id}; тайтл
// студии открывает обычную страницу тайтла. Своего плеера пока нет —
// «Смотреть» на тайтле только говорит об этом.

import { state } from "./state.js";
import { apiGet, toast, forceMediaToken } from "./api.js";
import { $, esc } from "./utils.js";
import { imgProxy, hdPosterAttrs } from "./title-page.js";

const KIND = { tv: "Сериал", movie: "Фильм", ova: "OVA", ona: "ONA", special: "Спешл", tv_special: "Спешл" };
const HERO_MS = 8000;
const NAV = [
  ["home", "Главная"], ["list", "Мой список"], ["ongoing", "Онгоинги"], ["anons", "Анонсы"], ["studio", "Озвучка студии"],
];
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let data = null;          // { catalog, studio }
let loading = null;
let view = "home";
let genre = "";
let query = "";
let heroIdx = 0;
let heroTimer = null;

// ---------- «Мой список» — личный, в localStorage ----------
function listKey() { return `project_watch_list_${state.telegramId || "anon"}`; }
function myList() {
  try { return JSON.parse(localStorage.getItem(listKey()) || "[]"); } catch (_) { return []; }
}
function toggleList(key) {
  const list = myList();
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1); else list.unshift(key);
  try { localStorage.setItem(listKey(), JSON.stringify(list)); } catch (_) { /* не критично */ }
  return i < 0;
}

// ---------- данные ----------
function byScore(arr) { return arr.slice().sort((a, b) => (b.score || 0) - (a.score || 0)); }
function studioByShiki() {
  const m = new Map();
  for (const s of data.studio) if (s.shiki_id) m.set(s.shiki_id, s);
  return m;
}
async function load() {
  if (data) return data;
  if (!loading) {
    loading = apiGet("/watch/home").then(d => {
      data = { catalog: d.catalog || [], studio: d.studio || [] };
      return data;
    }).finally(() => { loading = null; });
  }
  return loading;
}

// ---------- плитки и ряды ----------
function catalogTile(t, studioMap) {
  const dub = studioMap.get(t.id);
  const badge = dub ? "Озвучка Project" : t.group === "anons" ? "Анонс" : t.group === "ongoing" ? "Онгоинг" : "";
  const meta = [KIND[t.kind], t.episodes ? `${t.episodes} эп.` : ""].filter(Boolean).join(" · ");
  return `
    <button type="button" class="wm-tile" data-wm-open="s:${t.id}">
      <span class="wm-pic"><img src="${imgProxy(t.cover)}" alt="" loading="lazy">
        ${t.score ? `<span class="wm-score">★ ${t.score.toFixed(1)}</span>` : ""}
        ${badge ? `<span class="wm-badge${dub ? " hot" : ""}">${esc(badge)}</span>` : ""}
        <span class="wm-shade"></span>
      </span>
      <span class="wm-name">${esc(t.name)}</span>
      <span class="wm-meta">${esc(meta)}</span>
    </button>`;
}
function studioTile(s) {
  const pct = s.current_pct || 0;
  const sub = s.episodes_total
    ? (s.current_label ? `${s.current_label} · ${pct}%` : "все серии готовы")
    : "серии ещё не заведены";
  return `
    <button type="button" class="wm-tile dub" data-wm-open="t:${s.title_id}">
      <span class="wm-pic">${s.poster_url ? `<img ${hdPosterAttrs(s.title_id, s.poster_url, 180)} alt="" loading="lazy">` : `<span class="wm-ph"></span>`}
        <span class="wm-badge hot">Озвучка</span>
        <span class="wm-shade"></span>
        ${s.episodes_total ? `<span class="wm-prog"><i style="width:${pct}%"></i></span>` : ""}
      </span>
      <span class="wm-name">${esc(s.name)}</span>
      <span class="wm-meta">${esc(sub)}</span>
    </button>`;
}
function rowHtml(title, tiles, { tag = "", note = "" } = {}) {
  if (!tiles.length) return "";
  return `
    <section class="wm-row">
      <h2>${esc(title)}${tag ? `<span class="wm-tag">${esc(tag)}</span>` : ""}${note ? `<small>${esc(note)}</small>` : ""}</h2>
      <div class="wm-strip-wrap">
        <button type="button" class="wm-arrow l" data-wm-scroll="-1" aria-label="Назад"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div class="wm-strip">${tiles.join("")}</div>
        <button type="button" class="wm-arrow r" data-wm-scroll="1" aria-label="Дальше"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>
    </section>`;
}
function gridHtml(title, tiles, empty) {
  return `
    <section class="wm-row wm-gridsec">
      <h2>${esc(title)}<small>${tiles.length || ""}</small></h2>
      ${tiles.length ? `<div class="wm-grid">${tiles.join("")}</div>` : `<div class="wm-empty">${esc(empty)}</div>`}
    </section>`;
}

// ---------- баннер ----------
function heroes() {
  return byScore(data.catalog.filter(t => t.hero && t.banner)).slice(0, 5);
}
function heroTextHtml(t) {
  const studioMap = studioByShiki();
  const inList = myList().includes(`s:${t.id}`);
  const eyebrow = [
    t.score ? `<span class="wm-gold">★ ${t.score.toFixed(1)}</span>` : "",
    KIND[t.kind] || "", (t.aired_on || "").slice(0, 4),
    t.group === "ongoing" ? "Онгоинг" : (t.episodes ? `${t.episodes} эп.` : ""),
    studioMap.has(t.id) ? `<span class="wm-gold">Озвучивает Project</span>` : "",
  ].filter(Boolean);
  return `
    <div class="wm-eyebrow">${eyebrow.join("<i></i>")}</div>
    <h1 title="${esc(t.name)}">${esc(t.name)}</h1>
    ${t.description ? `<p>${esc(t.description)}</p>` : ""}
    ${t.genres && t.genres.length ? `<div class="wm-tags">${t.genres.map(g => `<span>${esc(g)}</span>`).join("")}</div>` : ""}
    <div class="wm-acts">
      <button type="button" class="wm-play" data-wm-play="${t.id}">${PLAY_ICON}Смотреть</button>
      <button type="button" class="wm-ghost" data-wm-open="s:${t.id}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>Подробнее</button>
      <button type="button" class="wm-ghost" data-wm-list="s:${t.id}">${inList ? "✓ В списке" : "+ В список"}</button>
    </div>`;
}
function heroHtml() {
  const list = heroes();
  if (!list.length) return "";
  heroIdx = Math.min(heroIdx, list.length - 1);
  return `
    <div class="wm-hero" id="wm-hero">
      ${list.map((t, i) => `
        <div class="wm-slide${i === heroIdx ? " on" : ""}" data-wm-slide="${i}">
          <div class="wm-bg${t.backdrop ? " frame" : ""}" style="background-image:url('${imgProxy(t.backdrop || t.banner)}')"></div>
          <div class="wm-cover" style="background-image:url('${imgProxy(t.cover)}')"></div>
        </div>`).join("")}
      <div class="wm-hero-text" id="wm-hero-text">${heroTextHtml(list[heroIdx])}</div>
      <div class="wm-dots">${list.map((t, i) => `<button type="button" data-wm-hero="${i}" class="${i === heroIdx ? "on" : ""}" aria-label="${esc(t.name)}"><i></i></button>`).join("")}</div>
    </div>`;
}
function showHero(i, root) {
  const list = heroes();
  if (!list.length) return;
  heroIdx = (i + list.length) % list.length;
  root.querySelectorAll("[data-wm-slide]").forEach(s => s.classList.toggle("on", Number(s.dataset.wmSlide) === heroIdx));
  root.querySelectorAll("[data-wm-hero]").forEach(b => {
    b.classList.remove("on");
    void b.offsetWidth; // перезапуск анимации полоски
    b.classList.toggle("on", Number(b.dataset.wmHero) === heroIdx);
  });
  const text = root.querySelector("#wm-hero-text");
  if (text) {
    text.innerHTML = heroTextHtml(list[heroIdx]);
    if (!reduceMotion()) text.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 650, easing: "cubic-bezier(.22,.9,.3,1)" });
    wireActions(text);
  }
  restartHeroTimer(root);
}
function restartHeroTimer(root) {
  window.clearInterval(heroTimer);
  if (reduceMotion()) return;
  heroTimer = window.setInterval(() => {
    const hero = root.querySelector("#wm-hero");
    if (!hero || !hero.isConnected || root.hidden) { window.clearInterval(heroTimer); return; }
    if (!hero.matches(":hover") && !document.hidden) showHero(heroIdx + 1, root);
  }, HERO_MS);
}

// ---------- страница ----------
function bodyHtml() {
  const studioMap = studioByShiki();
  const cat = data.catalog;
  const filterGenre = list => (genre ? list.filter(t => (t.genres || []).includes(genre)) : list);
  const tilesOf = list => list.map(t => catalogTile(t, studioMap));
  const studioTiles = data.studio.map(studioTile);

  if (query) {
    const q = query.toLowerCase();
    const found = cat.filter(t => `${t.name} ${t.name_en || ""}`.toLowerCase().includes(q));
    const foundStudio = data.studio.filter(s => s.name.toLowerCase().includes(q));
    return gridHtml(`Поиск: «${query}»`, [...foundStudio.map(studioTile), ...tilesOf(found)], "Ничего не нашлось.");
  }
  if (view === "list") {
    const keys = myList();
    const tiles = keys.map(k => {
      if (k.startsWith("t:")) { const s = data.studio.find(x => `t:${x.title_id}` === k); return s && studioTile(s); }
      const t = cat.find(x => `s:${x.id}` === k); return t && catalogTile(t, studioMap);
    }).filter(Boolean);
    return gridHtml("Мой список", tiles, "Пока пусто — нажмите «+ В список» на баннере или в карточке тайтла.");
  }
  if (view === "ongoing") return gridHtml("Онгоинги", tilesOf(byScore(cat.filter(t => t.group === "ongoing"))), "Нет данных.");
  if (view === "anons") return gridHtml("Анонсы", tilesOf(cat.filter(t => t.group === "anons")), "Нет данных.");
  if (view === "studio") return gridHtml("Озвучка студии", studioTiles, "В сезонах студии пока нет тайтлов.");

  const genres = [...new Set(cat.flatMap(t => t.genres || []))].slice(0, 14);
  const trending = byScore(cat.filter(t => t.group !== "anons")).slice(0, 18);
  return `
    ${heroHtml()}
    <div class="wm-rows">
      ${rowHtml("В тренде", tilesOf(filterGenre(trending)))}
      <div class="wm-genres">${["", ...genres].map(g => `<button type="button" data-wm-genre="${esc(g)}" class="${g === genre ? "on" : ""}">${g ? esc(g) : "Все жанры"}</button>`).join("")}</div>
      ${rowHtml("Озвучивает студия", studioTiles, { tag: "Project", note: studioTiles.length ? "" : "" })}
      ${rowHtml("Онгоинги сезона", tilesOf(filterGenre(byScore(cat.filter(t => t.group === "ongoing")))))}
      ${rowHtml("Скоро выйдет", tilesOf(filterGenre(cat.filter(t => t.group === "anons"))), { note: "анонсы" })}
      ${rowHtml("Рекомендуем", tilesOf(filterGenre(byScore(cat.filter(t => t.group === "latest")).reverse())))}
    </div>`;
}

function shellHtml() {
  return `
    <div class="wm-scroll" id="wm-scroll">
      <nav class="wm-nav" id="wm-nav">
        <div class="wm-brand"><i></i>Project <span>Смотреть</span></div>
        <ul>${NAV.map(([k, label]) => `<li><button type="button" data-wm-view="${k}" class="${k === view ? "on" : ""}">${label}</button></li>`).join("")}</ul>
        <span class="wm-sp"></span>
        <label class="wm-search"><input id="wm-q" placeholder="Найти тайтл…" value="${esc(query)}"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></label>
        <button type="button" class="wm-back" id="wm-back">← Студия</button>
      </nav>
      <div id="wm-body"><div class="wm-loading"><span></span>Загружаю каталог…</div></div>
    </div>`;
}

function renderBody(root) {
  const body = root.querySelector("#wm-body");
  body.innerHTML = bodyHtml();
  root.querySelectorAll("[data-wm-view]").forEach(b => b.classList.toggle("on", !query && b.dataset.wmView === view));
  wireActions(body);
  body.querySelectorAll("[data-wm-hero]").forEach(b => b.addEventListener("click", () => showHero(Number(b.dataset.wmHero), root)));
  body.querySelectorAll("[data-wm-genre]").forEach(b => b.addEventListener("click", () => { genre = b.dataset.wmGenre; renderBody(root); }));
  body.querySelectorAll("[data-wm-scroll]").forEach(b => b.addEventListener("click", () => {
    const strip = b.parentElement.querySelector(".wm-strip");
    strip.scrollBy({ left: Number(b.dataset.wmScroll) * strip.clientWidth * 0.8, behavior: "smooth" });
  }));
  if (body.querySelector("#wm-hero")) restartHeroTimer(root); else window.clearInterval(heroTimer);
}

function wireActions(scope) {
  scope.querySelectorAll("[data-wm-play]").forEach(b => b.addEventListener("click", async () => {
    const id = Number(b.dataset.wmPlay);
    const t = data && data.catalog.find(x => x.id === id);
    document.querySelector(".wm-modal")?.remove();
    const { openAnimePlayer } = await import("./player-anime.js");
    openAnimePlayer({ shikiId: id, name: t ? t.name : "" });
  }));
  scope.querySelectorAll("[data-wm-list]").forEach(b => b.addEventListener("click", () => {
    const added = toggleList(b.dataset.wmList);
    b.textContent = added ? "✓ В списке" : "+ В список";
    toast(added ? "Добавлено в «Мой список»." : "Убрано из «Моего списка».");
  }));
  scope.querySelectorAll("[data-wm-open]").forEach(b => b.addEventListener("click", () => openItem(b.dataset.wmOpen)));
}

// ---------- подробнее ----------
async function openItem(key) {
  if (key.startsWith("t:")) {
    const { openTitleDetail } = await import("./titles.js");
    openTitleDetail(Number(key.slice(2)));
    return;
  }
  const id = Number(key.slice(2));
  const t = data.catalog.find(x => x.id === id);
  if (!t) return;
  const dub = studioByShiki().get(id);
  if (dub) {
    const { openTitleDetail } = await import("./titles.js");
    openTitleDetail(dub.title_id);
    return;
  }
  const modal = document.createElement("div");
  modal.className = "wm-modal";
  modal.innerHTML = `
    <div class="wm-sheet" role="dialog" aria-label="${esc(t.name)}">
      <div class="wm-ban" style="background-image:url('${imgProxy(t.banner || t.cover)}')"><button type="button" class="wm-x" data-wm-close aria-label="Закрыть">✕</button></div>
      <div class="wm-in">
        <img src="${imgProxy(t.cover)}" alt="">
        <div>
          <h3>${esc(t.name)}</h3>
          <div class="wm-en">${esc(t.name_en || "")}</div>
          <div class="wm-eyebrow">${[t.score ? `<span class="wm-gold">★ ${t.score.toFixed(1)}</span>` : "", KIND[t.kind] || "", t.episodes ? `${t.episodes} эп.` : ""].filter(Boolean).join("<i></i>")}<span data-wm-studio></span></div>
          <p data-wm-desc>${t.description ? esc(t.description) : `<span class="tt-loading"></span>`}</p>
          <div class="wm-acts">
            <button type="button" class="wm-play" data-wm-play="${t.id}">${PLAY_ICON}Смотреть</button>
            <button type="button" class="wm-ghost" data-wm-list="s:${t.id}">${myList().includes(`s:${t.id}`) ? "✓ В списке" : "+ В список"}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add("on"));
  const close = () => { modal.classList.remove("on"); window.setTimeout(() => modal.remove(), 300); };
  modal.addEventListener("click", e => { if (e.target === modal || e.target.closest("[data-wm-close]")) close(); });
  modal.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  wireActions(modal);
  if (!t.description) {
    try {
      const d = await apiGet(`/watch/anime/${id}`);
      const det = d.details || {};
      t.description = det.description || "";
      const desc = modal.querySelector("[data-wm-desc]");
      if (desc) desc.textContent = det.description || "Описания пока нет.";
      const studio = modal.querySelector("[data-wm-studio]");
      if (studio && det.studio) studio.innerHTML = `<i></i>${esc(det.studio)}`;
    } catch (e) {
      const desc = modal.querySelector("[data-wm-desc]");
      if (desc) desc.textContent = `Не удалось загрузить описание: ${e.message}`;
    }
  }
}

// ---------- открыть / закрыть с переходом ----------
function circleAround(el, root) {
  const r = el.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  const cx = r.left + r.width / 2 - box.left;
  const cy = r.top + r.height / 2 - box.top;
  const radius = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy));
  return { cx, cy, radius };
}

let opening = false;
export async function openWatchMode(fromEl) {
  const root = $("#watch-mode");
  if (!root || opening || !root.hidden) return;
  opening = true;
  root.innerHTML = shellHtml();
  root.hidden = false;
  document.body.classList.add("watch-open");
  wireShell(root);
  const { cx, cy, radius } = circleAround(fromEl || $("#open-watch"), root);
  const app = $("#app-screen");
  if (!reduceMotion()) {
    const ease = "cubic-bezier(.65,0,.15,1)";
    root.animate([{ clipPath: `circle(0px at ${cx}px ${cy}px)` }, { clipPath: `circle(${radius}px at ${cx}px ${cy}px)` }], { duration: 850, easing: ease });
    if (app) app.animate([{ transform: "none", filter: "none" }, { transform: "scale(.94)", filter: "blur(6px)" }], { duration: 850, easing: ease });
    root.querySelector("#wm-nav").animate([{ opacity: 0, transform: "translateY(-16px)" }, { opacity: 1, transform: "none" }], { duration: 650, delay: 400, fill: "backwards", easing: "cubic-bezier(.22,.9,.3,1)" });
  }
  window.setTimeout(() => { opening = false; }, 850);
  try {
    // Свежий токен картинок до отрисовки: фоны баннера — CSS, а не <img>,
    // и сами повторить запрос после 401 не умеют.
    await Promise.all([load(), forceMediaToken()]);
  } catch (e) {
    root.querySelector("#wm-body").innerHTML = `<div class="wm-empty">Не удалось загрузить каталог: ${esc(e.message)}</div>`;
    return;
  }
  if (root.hidden) return;
  renderBody(root);
  if (!reduceMotion()) {
    root.querySelector("#wm-hero")?.animate([{ transform: "scale(1.12)", filter: "brightness(1.5) blur(6px)" }, { transform: "none", filter: "none" }], { duration: 1200, easing: "cubic-bezier(.22,.9,.3,1)" });
    root.querySelector(".wm-rows")?.animate([{ opacity: 0, transform: "translateY(50px)" }, { opacity: 1, transform: "none" }], { duration: 850, delay: 250, fill: "backwards", easing: "cubic-bezier(.22,.9,.3,1)" });
  }
}

export function closeWatchMode() {
  const root = $("#watch-mode");
  if (!root || root.hidden) return;
  window.clearInterval(heroTimer);
  const done = () => { root.hidden = true; root.innerHTML = ""; document.body.classList.remove("watch-open"); };
  if (reduceMotion()) { done(); return; }
  const { cx, cy, radius } = circleAround($("#open-watch") || root, root);
  const ease = "cubic-bezier(.65,0,.15,1)";
  const app = $("#app-screen");
  if (app) app.animate([{ transform: "scale(.94)", filter: "blur(6px)" }, { transform: "none", filter: "none" }], { duration: 750, easing: ease });
  root.animate([{ clipPath: `circle(${radius}px at ${cx}px ${cy}px)` }, { clipPath: `circle(0px at ${cx}px ${cy}px)` }], { duration: 750, easing: ease }).onfinish = done;
}

function wireShell(root) {
  root.querySelector("#wm-back").addEventListener("click", closeWatchMode);
  root.querySelectorAll("[data-wm-view]").forEach(b => b.addEventListener("click", () => {
    view = b.dataset.wmView;
    query = "";
    const q = root.querySelector("#wm-q");
    if (q) q.value = "";
    if (data) renderBody(root);
    root.querySelector("#wm-scroll").scrollTo({ top: 0, behavior: "smooth" });
  }));
  let t = null;
  root.querySelector("#wm-q").addEventListener("input", e => {
    window.clearTimeout(t);
    t = window.setTimeout(() => { query = e.target.value.trim(); if (data) renderBody(root); }, 200);
  });
  const scroll = root.querySelector("#wm-scroll");
  const nav = root.querySelector("#wm-nav");
  scroll.addEventListener("scroll", () => nav.classList.toggle("solid", scroll.scrollTop > 30), { passive: true });
}

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const root = $("#watch-mode");
  if (!root || root.hidden) return;
  if (document.querySelector(".overlay, .wm-modal, .ap-root")) return; // сначала закрываются окна поверх
  closeWatchMode();
});

$("#open-watch")?.addEventListener("click", e => openWatchMode(e.currentTarget));
