// Режим «Смотреть» — витрина поверх приложения. Кнопка «Смотреть» в
// шапке раскрывает его кругом из себя, «← Студия» / Esc сворачивают.
//
// Что на экране (2.0):
//  - баннер во всю ширину: кадры серий (или баннер AniList) с наездом
//    камеры; слева метка «в нашей озвучке», название, оценка/год/жанры,
//    «Продолжить · N серия» из памяти плеера и живой отсчёт до серии;
//    справа очередь следующих слайдов с полоской до смены;
//  - вся витрина подкрашивается цветом обложки текущего слайда (--amb),
//    а палитра (фон, акцент) — из цветовой темы приложения;
//  - «Продолжить просмотр», «Топ-10 сезона», расписание по дням (живой отсчёт), плитки
//    настроений, «В тренде», онгоинги, анонсы;
//  - карточка при наведении, поиск-прожектор («/»), «Мне повезёт»,
//    «Подробнее» с похожими, «Мой список».
//
// Данные — /api/watch/home (каталог Shikimori + AniList, тайтлы студии),
// подробности — /api/watch/anime/{shiki_id}. Картинки — через свой сервер
// (/api/img_proxy): CSP приложения пускает только его.

import { state } from "./state.js";
import { apiGet, toast, forceMediaToken } from "./api.js";
import { $, esc } from "./utils.js";
import { imgProxy, hdPosterAttrs } from "./title-page.js";

const KIND = { tv: "Сериал", movie: "Фильм", ova: "OVA", ona: "ONA", special: "Спешл", tv_special: "Спешл" };
const HERO_MS = 9000;
const FRAME_MS = 3000;
const TABS = [["home", "Главная"], ["week", "Расписание"], ["list", "Мой список"], ["studio", "Наша озвучка"]];
const MOODS = [
  ["Экшен", "🔥 Экшен", "#ff6a2b"], ["Фэнтези", "✨ Фэнтези", "#9b7bff"],
  ["Комедия", "😂 Комедия", "#ffd84a"], ["Романтика", "💗 Романтика", "#ff6fae"], ["Драма", "🎭 Драма", "#6fb6ff"],
  ["Повседневность", "☕ Уют", "#9be38a"], ["Приключения", "🧭 Приключения", "#4fd8c4"],
  ["Детектив", "🔎 Детектив", "#c8a2ff"], ["Сверхъестественное", "👻 Мистика", "#a0e0ff"],
];
const I = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let data = null;
let loading = null;
let tab = "home";
let mood = "";
let weekDay = 0;
let heroIdx = 0;
let heroTimer = null;
let frameTimer = null;
let tickTimer = null;
let popTimer = null;
let byId = new Map();

// ---------- «Мой список» ----------
function listKey() { return `project_watch_list_${state.telegramId || "anon"}`; }
function myList() {
  try { return JSON.parse(localStorage.getItem(listKey()) || "[]"); } catch (_) { return []; }
}
function inList(key) { return myList().includes(key); }
function toggleList(key) {
  const list = myList();
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1); else list.unshift(key);
  try { localStorage.setItem(listKey(), JSON.stringify(list)); } catch (_) { /* не критично */ }
  return i < 0;
}

// ---------- данные ----------
const byScore = arr => arr.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
function studioByShiki() {
  const m = new Map();
  for (const s of data.studio) if (s.shiki_id) m.set(s.shiki_id, s);
  return m;
}
const heroPics = t => (t.frames && t.frames.length ? t.frames : t.banner ? [t.banner] : []);
function heroes() {
  return byScore(data.catalog.filter(t => t.hero && heroPics(t).length));
}
async function load() {
  if (data) return data;
  if (!loading) {
    loading = apiGet("/watch/home").then(d => {
      data = { catalog: d.catalog || [], studio: d.studio || [] };
      byId = new Map(data.catalog.map(t => [t.id, t]));
      return data;
    }).finally(() => { loading = null; });
  }
  return loading;
}
// «Продолжить просмотр» — из памяти плеера (player-anime.js), свежие сверху.
function continueItems() {
  const prefix = `project_player_${state.telegramId || "anon"}_`;
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const m = JSON.parse(localStorage.getItem(k) || "{}");
      const last = m.last;
      if (!last || !last.duration || !last.time || last.duration - last.time < 60) continue;
      out.push({ shikiId: Number(k.slice(prefix.length)), title: m.title, ...last });
    }
  } catch (_) { /* не критично */ }
  return out.sort((a, b) => b.at - a.at).slice(0, 12);
}
const continueFor = id => continueItems().find(c => c.shikiId === id);
function untilText(sec) {
  if (sec <= 0) return "уже вышла";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  if (d) return `через ${d} д ${h} ч`;
  if (h) return `через ${h} ч ${String(m).padStart(2, "0")} мин`;
  return `через ${m}:${String(s).padStart(2, "0")}`;
}

// ---------- плитки ----------
function tileHtml(t, opt = {}) {
  const dub = studioByShiki().get(t.id);
  const badge = opt.badge ?? (dub ? "Озвучка Project" : t.group === "anons" ? "Анонс" : t.group === "ongoing" ? "Онгоинг" : "");
  const meta = opt.meta ?? [KIND[t.kind], t.episodes ? `${t.episodes} эп.` : ""].filter(Boolean).join(" · ");
  return `
    <button type="button" class="wm-tile" data-wm-open="s:${t.id}" data-wm-pop="${t.id}" style="--tc:${esc(t.color || "#ffb444")}">
      <span class="wm-pic"><img src="${imgProxy(t.cover)}" alt="" loading="lazy">
        ${t.score ? `<span class="wm-score">★ ${t.score.toFixed(1)}</span>` : ""}
        ${badge ? `<span class="wm-badge${dub || opt.hot ? " hot" : ""}">${esc(badge)}</span>` : ""}
      </span>
      <span class="wm-name">${opt.hl || esc(t.name)}</span>
      <span class="wm-meta">${esc(meta)}</span>
    </button>`;
}
function studioTileHtml(s) {
  const pct = s.episodes_total ? Math.round((s.episodes_done / s.episodes_total) * 100) : 0;
  const meta = s.episodes_total
    ? (s.current_label ? `${s.current_label} в работе · ${s.current_pct}%` : "все серии готовы")
    : "серии ещё не заведены";
  return `
    <button type="button" class="wm-tile" data-wm-open="t:${s.title_id}">
      <span class="wm-pic">${s.poster_url ? `<img ${hdPosterAttrs(s.title_id, s.poster_url, 180)} alt="" loading="lazy">` : `<span class="wm-ph"></span>`}
        <span class="wm-badge hot">Project</span>
        ${s.episodes_total ? `<span class="wm-ring" style="--p:${pct}"><span>${pct}%</span></span>` : ""}
      </span>
      <span class="wm-name">${esc(s.name)}</span>
      <span class="wm-meta">${esc(meta)}</span>
    </button>`;
}
function rowHtml(title, inner, { tag = "", note = "", id = "" } = {}) {
  if (!inner) return "";
  return `
    <section class="wm-row wm-reveal"${id ? ` data-wm-sec="${id}"` : ""}>
      <div class="wm-row-h"><h2>${esc(title)}</h2>${tag ? `<span class="wm-tag">${esc(tag)}</span>` : ""}${note ? `<small>${esc(note)}</small>` : ""}</div>
      <div class="wm-strip-wrap">
        <button type="button" class="wm-arrow l" data-wm-scroll="-1" aria-label="Назад">${I.left}</button>
        <div class="wm-strip">${inner}</div>
        <button type="button" class="wm-arrow r" data-wm-scroll="1" aria-label="Дальше">${I.right}</button>
      </div>
    </section>`;
}
function gridHtml(title, tiles, empty) {
  return `
    <section class="wm-row wm-gridsec">
      <div class="wm-row-h"><h2>${esc(title)}</h2><small>${tiles.length || ""}</small></div>
      ${tiles.length ? `<div class="wm-grid">${tiles.join("")}</div>` : `<div class="wm-empty">${esc(empty)}</div>`}
    </section>`;
}
function continueHtml() {
  const items = continueItems();
  if (!items.length) return "";
  return rowHtml("Продолжить просмотр", items.map(c => {
    const t = byId.get(c.shikiId);
    const pic = t ? (t.banner || (t.frames && t.frames[1]) || t.cover) : null;
    const left = Math.max(1, Math.round((c.duration - c.time) / 60));
    const name = c.title || (t && t.name) || "Тайтл";
    return `
      <button type="button" class="wm-cont" data-wm-play="${c.shikiId}" data-wm-name="${esc(name)}">
        <span class="wm-shot"${pic ? ` style="background-image:url('${imgProxy(pic)}')"` : ""}>
          <span class="wm-pp">${I.play}</span>
          <span class="wm-cinfo"><b>${esc(c.label || "Серия")}</b><span>осталось ${left} мин</span></span>
          <span class="wm-bar"><i style="width:${Math.round((c.time / c.duration) * 100)}%"></i></span>
        </span>
        <span class="wm-cname">${esc(name)}</span>
      </button>`;
  }).join(""), { note: "с того места, где остановились" });
}

function weekDays() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return [...Array(7)].map((_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const from = d.getTime() / 1000;
    const eps = data.catalog.filter(t => t.next_at >= from && t.next_at < from + 86400).sort((a, b) => a.next_at - b.next_at);
    return { d, eps };
  });
}
function schedHtml(eps) {
  if (!eps.length) return `<div class="wm-none">В этот день новых серий нет.</div>`;
  const now = Date.now() / 1000;
  const dubs = studioByShiki();
  return eps.map(t => {
    const dub = dubs.get(t.id);
    return `
      <button type="button" class="wm-air${dub ? " dub" : ""}" data-wm-open="s:${t.id}" data-wm-pop="${t.id}">
        <time>${new Date(t.next_at * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time>
        <img src="${imgProxy(t.cover)}" alt="" loading="lazy">
        <span class="wm-sn"><b>${esc(t.name)}</b><span>${t.next_ep} серия${dub ? " · Project" : ""}</span></span>
        <span class="wm-cd${t.next_at - now < 6 * 3600 ? " soon" : ""}" data-wm-at="${t.next_at}">${untilText(t.next_at - now)}</span>
      </button>`;
  }).join("");
}
function weekHtml() {
  const names = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const days = weekDays();
  weekDay = Math.min(weekDay, days.length - 1);
  return `
    <div class="wm-days">${days.map(({ d, eps }, i) => `
      <button type="button" data-wm-day="${i}" class="${i === weekDay ? "on" : ""}">${i === 0 ? "Сегодня" : i === 1 ? "Завтра" : names[d.getDay()]}<small>${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")} · ${eps.length}</small></button>`).join("")}
    </div>
    <div class="wm-sched" data-wm-sched>${schedHtml(days[weekDay].eps)}</div>`;
}
function weekSectionHtml(title) {
  return `<section class="wm-row wm-reveal" data-wm-sec="week"><div class="wm-row-h"><h2>${esc(title)}</h2><small>время ваше, отсчёт живой</small></div><div class="wm-weekwrap">${weekHtml()}</div></section>`;
}
// Плитки настроений: жанр + постер самого популярного тайтла этого жанра.
function moodsHtml() {
  const pop = data.catalog.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  // Разные постеры: самый популярный тайтл жанра, который ещё не занят
  // другой плиткой (иначе «Ван-Пис» был бы почти на всех).
  const used = new Set();
  const tiles = MOODS.map(([g, label, c]) => {
    const t = pop.find(x => !used.has(x.id) && (x.genres || []).includes(g)) || pop.find(x => (x.genres || []).includes(g));
    if (t) used.add(t.id);
    if (!t) return "";
    return `<button type="button" class="wm-mood${g === mood ? " on" : ""}" data-wm-mood="${esc(g)}" style="--g:${c}"><img src="${imgProxy(t.cover)}" alt="" loading="lazy"><span>${label}</span></button>`;
  }).join("");
  return tiles ? `<section class="wm-row wm-reveal"><div class="wm-row-h"><h2>По настроению</h2>${mood ? `<button type="button" class="wm-reset" data-wm-mood="">сбросить</button>` : ""}</div><div class="wm-moods">${tiles}</div></section>` : "";
}
function moodRowsHtml() {
  const cat = data.catalog;
  const f = arr => (mood ? arr.filter(t => (t.genres || []).includes(mood)) : arr);
  const trending = f(cat.filter(t => t.group !== "anons").sort((a, b) => (b.popularity || 0) - (a.popularity || 0))).slice(0, 18);
  return `
    <div class="wm-moodrows">
      ${rowHtml(mood ? `Под настроение: ${MOODS.find(m => m[0] === mood)?.[1] || mood}` : "В тренде", trending.map(t => tileHtml(t)).join("")) || `<div class="wm-empty">Под это настроение ничего не нашлось — попробуйте другое.</div>`}
      ${rowHtml("Онгоинги сезона", f(byScore(cat.filter(t => t.group === "ongoing"))).map(t => tileHtml(t)).join(""))}
      ${rowHtml("Скоро выйдет", f(cat.filter(t => t.group === "anons")).map(t => tileHtml(t, { meta: t.aired_on ? `с ${new Date(t.aired_on).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}` : "дата уточняется" })).join(""), { note: "анонсы" })}
    </div>`;
}
function homeHtml() {
  const top10 = byScore(data.catalog.filter(t => t.group !== "anons")).slice(0, 10);
  return `
    ${heroHtml()}
    <div class="wm-rows">
      ${continueHtml()}
      ${rowHtml("Топ-10 сезона", top10.map((t, i) => `<div class="wm-top"><span class="wm-num">${i + 1}</span>${tileHtml(t, { badge: studioByShiki().get(t.id) ? "Project" : "", hot: true })}</div>`).join(""), { note: "по оценкам Shikimori" })}
      ${weekSectionHtml("Расписание")}
      <div data-wm-moodbox>${moodsHtml()}</div>
      ${moodRowsHtml()}
    </div>`;
}

// ---------- живой баннер ----------
function heroHtml() {
  const list = heroes();
  if (!list.length) return "";
  heroIdx = Math.min(heroIdx, list.length - 1);
  return `
    <div class="wm-hero" id="wm-hero">
      ${list.map((t, i) => `
        <div class="wm-slide${i === heroIdx ? " on" : ""}" data-wm-slide="${i}">
          <div class="wm-frames">${heroPics(t).map((f, k) => `<div class="wm-frame${k === 0 ? " on" : ""}" style="background-image:url('${imgProxy(f)}');--kx:${k % 2 ? "-2%" : "2%"};--ky:${k % 3 ? "1.5%" : "-1.5%"}"></div>`).join("")}</div>
        </div>`).join("")}
      <div class="wm-grain"></div>
      <div class="wm-htext" id="wm-htext"></div>
      <div class="wm-rail">${list.map((t, i) => {
        const pics = heroPics(t);
        return `<button type="button" data-wm-hero="${i}" class="${i === heroIdx ? "on" : ""}"><span class="wm-qth" style="background-image:url('${imgProxy(t.banner || pics[1] || pics[0])}')"></span><span class="wm-qn">${esc(t.name)}</span><span class="wm-qp"><i></i></span></button>`;
      }).join("")}</div>
    </div>`;
}
function nextText(t) {
  const left = t.next_at - Date.now() / 1000;
  return left > 0 ? `${t.next_ep} серия через ${untilText(left).replace(/^через /, "")}` : `${t.next_ep} серия уже вышла`;
}
function heroTextHtml(t) {
  const now = Date.now() / 1000;
  const dub = studioByShiki().get(t.id);
  const cont = continueFor(t.id);
  const live = t.next_at && t.next_at - now < 7 * 86400 ? `<div class="wm-next" data-wm-live><i></i><span>${esc(nextText(t))}</span></div>` : "";
  const words = esc(t.name).split(" ").map((w, i) => `<span class="w" style="animation-delay:${i * 70}ms">${w}</span>`).join(" ");
  const key = `s:${t.id}`;
  const meta = [
    t.score ? `<span class="sc">★ ${t.score.toFixed(2)}</span>` : "",
    t.aired_on ? `<span>${t.aired_on.slice(0, 4)}</span>` : "",
    KIND[t.kind] ? `<span>${KIND[t.kind]}</span>` : "",
    t.episodes || t.episodes_aired ? `<span>${t.episodes || t.episodes_aired} эп.</span>` : "",
    (t.genres || []).length ? `<span>${esc(t.genres.slice(0, 2).join(" · "))}</span>` : "",
  ].filter(Boolean).join("<i></i>");
  return `
    ${dub ? `<span class="wm-eyebrow"><b>Project</b>в нашей озвучке</span>` : `<span class="wm-eyebrow">${t.group === "anons" ? "Скоро" : "Сейчас в сезоне"}</span>`}
    <h1 title="${esc(t.name)}">${words}</h1>
    <div class="wm-hmeta">${meta}</div>
    ${t.description ? `<p>${esc(t.description)}</p>` : ""}
    <div class="wm-acts">
      <button type="button" class="wm-play" data-wm-play="${t.id}">${I.play}${cont ? `Продолжить${cont.label ? ` · ${esc(cont.label)}` : ""}` : "Смотреть"}</button>
      <button type="button" class="wm-ghost" data-wm-open="${key}">${I.info}Подробнее</button>
      <button type="button" class="wm-round big${inList(key) ? " on" : ""}" data-wm-list="${key}" title="В список">${inList(key) ? I.check : I.plus}</button>
    </div>
    ${live}`;
}
function showHero(i, r) {
  const list = heroes();
  if (!list.length) return;
  heroIdx = (i + list.length) % list.length;
  const t = list[heroIdx];
  r.querySelectorAll("[data-wm-slide]").forEach(s => {
    const on = Number(s.dataset.wmSlide) === heroIdx;
    s.classList.toggle("on", on);
    if (on) s.querySelectorAll(".wm-frame").forEach((f, k) => f.classList.toggle("on", k === 0));
  });
  r.querySelectorAll("[data-wm-hero]").forEach(b => {
    b.classList.remove("on");
    void b.offsetWidth;
    b.classList.toggle("on", Number(b.dataset.wmHero) === heroIdx);
  });
  const text = r.querySelector("#wm-htext");
  if (text) {
    text.innerHTML = heroTextHtml(t);
    wireActions(text);
  }
  if (t.color) r.style.setProperty("--amb", t.color);
  else r.style.removeProperty("--amb");
  window.clearInterval(frameTimer);
  window.clearInterval(heroTimer);
  if (reduceMotion()) return;
  let f = 0;
  frameTimer = window.setInterval(() => {
    const hero = r.querySelector("#wm-hero");
    if (!hero || r.hidden || hero.matches(":hover")) return;
    const frames = r.querySelectorAll(`[data-wm-slide="${heroIdx}"] .wm-frame`);
    if (!frames.length) return;
    f = (f + 1) % frames.length;
    frames.forEach((el, k) => el.classList.toggle("on", k === f));
  }, FRAME_MS);
  heroTimer = window.setInterval(() => {
    const hero = r.querySelector("#wm-hero");
    if (!hero || !hero.isConnected || r.hidden) { window.clearInterval(heroTimer); return; }
    if (!hero.matches(":hover") && !document.hidden) showHero(heroIdx + 1, r);
  }, HERO_MS);
}
function wireHero(r) {
  const hero = r.querySelector("#wm-hero");
  if (!hero) return;
  hero.querySelectorAll("[data-wm-hero]").forEach(b => b.addEventListener("click", () => showHero(Number(b.dataset.wmHero), r)));
  if (reduceMotion()) return;
  hero.addEventListener("pointermove", e => {
    const box = hero.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width - 0.5, y = (e.clientY - box.top) / box.height - 0.5;
    hero.style.setProperty("--px", `${-x * 26}px`);
    hero.style.setProperty("--py", `${-y * 18}px`);
  });
}

// ---------- отрисовка ----------
function bodyHtml() {
  const studioTiles = data.studio.map(studioTileHtml);
  if (tab === "list") {
    const tiles = myList().map(k => {
      if (k.startsWith("t:")) { const s = data.studio.find(x => `t:${x.title_id}` === k); return s && studioTileHtml(s); }
      const t = byId.get(Number(k.slice(2))); return t && tileHtml(t);
    }).filter(Boolean);
    return `<div class="wm-pad"></div>${gridHtml("Мой список", tiles, "Пока пусто — жмите «+ В список» на баннере или в карточке.")}`;
  }
  if (tab === "studio") return `<div class="wm-pad"></div>${gridHtml("Наша озвучка", studioTiles, "В сезонах команды пока нет тайтлов.")}`;
  if (tab === "week") return `<div class="wm-pad"></div>${weekSectionHtml("Расписание на неделю")}`;
  return homeHtml();
}
function renderBody(r) {
  hidePop();
  const body = r.querySelector("#wm-body");
  body.innerHTML = bodyHtml();
  wireActions(body);
  wireHero(r);
  if (body.querySelector("#wm-hero")) showHero(heroIdx, r);
  else { window.clearInterval(heroTimer); window.clearInterval(frameTimer); }
  wireMoods(body, r);
  body.querySelectorAll("[data-wm-day]").forEach(b => b.addEventListener("click", () => {
    weekDay = Number(b.dataset.wmDay);
    const sec = b.closest(".wm-weekwrap");
    sec.querySelectorAll("[data-wm-day]").forEach(x => x.classList.toggle("on", x === b));
    const sched = sec.querySelector("[data-wm-sched]");
    sched.innerHTML = schedHtml(weekDays()[weekDay].eps);
    sched.classList.remove("swap");
    void sched.offsetWidth;
    sched.classList.add("swap");
    wireActions(sched);
  }));
  observeReveal(r);
}
// Плитка настроения: выбрать — ряды ниже подбираются под жанр, ещё раз
// (или «сбросить») — снова «В тренде».
function wireMoods(scope, r) {
  scope.querySelectorAll("[data-wm-mood]").forEach(b => b.addEventListener("click", () => {
    const body = r.querySelector("#wm-body");
    mood = b.dataset.wmMood === mood ? "" : b.dataset.wmMood;
    const tmp = document.createElement("div");
    tmp.innerHTML = moodRowsHtml();
    const fresh = tmp.firstElementChild;
    body.querySelector(".wm-moodrows").replaceWith(fresh);
    const box = body.querySelector("[data-wm-moodbox]");
    box.innerHTML = moodsHtml();
    box.querySelector(".wm-reveal")?.classList.add("in");
    wireMoods(box, r);
    fresh.classList.add("swap");
    wireActions(fresh);
    observeReveal(r);
  }));
}
let io = null;
function observeReveal(r) {
  io?.disconnect();
  const scroller = r.querySelector("#wm-scroll");
  io = new window.IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }), { root: scroller, threshold: 0.1 });
  r.querySelectorAll(".wm-reveal:not(.in)").forEach(el => (reduceMotion() ? el.classList.add("in") : io.observe(el)));
}

// ---------- действия ----------
function root() { return $("#watch-mode"); }
async function play(shikiId, name) {
  hidePop();
  document.querySelector(".wm-modal")?.remove();
  const t = byId.get(shikiId);
  const { openAnimePlayer } = await import("./player-anime.js");
  openAnimePlayer({ shikiId, name: name || (t ? t.name : "") });
}
function wireActions(scope) {
  scope.querySelectorAll("[data-wm-play]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    play(Number(b.dataset.wmPlay), b.dataset.wmName);
  }));
  scope.querySelectorAll("[data-wm-list]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    const key = b.dataset.wmList;
    const added = toggleList(key);
    document.querySelectorAll(`[data-wm-list="${key}"]`).forEach(x => {
      x.classList.toggle("on", added);
      x.innerHTML = x.classList.contains("wm-round") ? (added ? I.check : I.plus) : (added ? `${I.check}В списке` : `${I.plus}В список`);
    });
    toast(added ? "Добавлено в «Мой список»." : "Убрано из «Моего списка».");
  }));
  scope.querySelectorAll("[data-wm-open]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    openItem(b.dataset.wmOpen);
  }));
  scope.querySelectorAll("[data-wm-scroll]").forEach(b => b.addEventListener("click", () => {
    const strip = b.parentElement.querySelector(".wm-strip");
    strip.scrollBy({ left: Number(b.dataset.wmScroll) * strip.clientWidth * 0.8, behavior: "smooth" });
  }));
  scope.querySelectorAll("[data-wm-pop]").forEach(el => {
    el.addEventListener("pointerenter", () => { window.clearTimeout(popTimer); popTimer = window.setTimeout(() => showPop(el), 480); });
    el.addEventListener("pointerleave", () => { window.clearTimeout(popTimer); popTimer = window.setTimeout(hidePop, 140); });
  });
}

// ---------- карточка при наведении ----------
function showPop(el) {
  const t = byId.get(Number(el.dataset.wmPop));
  const r = root();
  if (!t || !r || r.hidden || !el.isConnected) return;
  let pop = r.querySelector(".wm-pop");
  if (!pop) {
    pop = document.createElement("div");
    pop.className = "wm-pop";
    r.appendChild(pop);
    pop.addEventListener("pointerenter", () => window.clearTimeout(popTimer));
    pop.addEventListener("pointerleave", () => { popTimer = window.setTimeout(hidePop, 140); });
  }
  const key = `s:${t.id}`;
  const pic = (t.frames && t.frames[0]) || t.banner || t.cover;
  pop.style.setProperty("--tc", t.color || "#ffb444");
  pop.innerHTML = `
    <div class="wm-ph" style="background-image:url('${imgProxy(pic)}')"></div>
    <div class="wm-pb">
      <h3>${esc(t.name)}</h3>
      <div class="wm-chips">${t.score ? `<span class="wm-chip score">★ ${t.score.toFixed(1)}</span>` : ""}${(t.genres || []).slice(0, 3).map(g => `<span class="wm-chip">${esc(g)}</span>`).join("")}</div>
      <p data-wm-pdesc>${t.description ? esc(t.description) : ""}</p>
      <div class="wm-pa">
        <button type="button" class="wm-round w" data-wm-play="${t.id}" title="Смотреть">${I.play}</button>
        <button type="button" class="wm-round${inList(key) ? " on" : ""}" data-wm-list="${key}" title="В список">${inList(key) ? I.check : I.plus}</button>
        <button type="button" class="wm-round" data-wm-open="${key}" title="Подробнее">${I.info}</button>
      </div>
    </div>`;
  const box = el.getBoundingClientRect();
  const host = r.getBoundingClientRect();
  const left = Math.min(host.width - 356, Math.max(16, box.left - host.left + box.width / 2 - 170));
  const top = Math.min(host.height - 390, Math.max(60, box.top - host.top - 30));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  wireActions(pop);
  pop.classList.add("on");
  if (!t.description) fillDescription(t, pop.querySelector("[data-wm-pdesc]"));
}
function hidePop() {
  root()?.querySelector(".wm-pop")?.classList.remove("on");
}
async function fillDescription(t, el) {
  try {
    const d = await apiGet(`/watch/anime/${t.id}`);
    t.description = (d.details && d.details.description) || "";
    t.studio = t.studio || (d.details && d.details.studio) || null;
    if (el && el.isConnected) el.textContent = t.description || "Описания пока нет.";
  } catch (_) {
    if (el && el.isConnected) el.textContent = "";
  }
}

// ---------- подробнее ----------
async function openItem(key) {
  hidePop();
  if (key.startsWith("t:")) {
    const { openTitleDetail } = await import("./titles.js");
    openTitleDetail(Number(key.slice(2)));
    return;
  }
  const id = Number(key.slice(2));
  const t = byId.get(id);
  if (!t) return;
  const dub = studioByShiki().get(id);
  if (dub) {
    const { openTitleDetail } = await import("./titles.js");
    openTitleDetail(dub.title_id);
    return;
  }
  document.querySelector(".wm-modal")?.remove();
  const similar = byScore(data.catalog.filter(x => x.id !== id && (x.genres || []).some(g => (t.genres || []).includes(g)))).slice(0, 10);
  const now = Date.now() / 1000;
  const modal = document.createElement("div");
  modal.className = "wm-modal";
  modal.innerHTML = `
    <div class="wm-sheet" role="dialog" aria-label="${esc(t.name)}">
      <div class="wm-sban"><div class="wm-kb" style="background-image:url('${imgProxy((t.frames && t.frames[1]) || t.banner || t.cover)}')"></div><button type="button" class="wm-round wm-x" data-wm-close aria-label="Закрыть">✕</button></div>
      <div class="wm-sin">
        <img src="${imgProxy(t.cover)}" alt="">
        <div>
          <h3>${esc(t.name)}</h3>
          <div class="wm-en">${esc(t.name_en || "")}</div>
          <div class="wm-chips">${t.score ? `<span class="wm-chip score">★ ${t.score.toFixed(1)}</span>` : ""}${KIND[t.kind] ? `<span class="wm-chip">${KIND[t.kind]}</span>` : ""}<span class="wm-chip" data-wm-studio${t.studio ? "" : " hidden"}>${esc(t.studio || "")}</span>${t.episodes ? `<span class="wm-chip">${t.episodes_aired ? `${t.episodes_aired} / ` : ""}${t.episodes} эп.</span>` : ""}${t.next_at ? `<span class="wm-chip live"><i></i>${t.next_ep} серия ${untilText(t.next_at - now)}</span>` : ""}</div>
          <p data-wm-desc>${t.description ? esc(t.description) : `<span class="tt-loading"></span>`}</p>
          <div class="wm-acts">
            <button type="button" class="wm-play" data-wm-play="${t.id}">${I.play}Смотреть</button>
            <button type="button" class="wm-ghost${inList(key) ? " on" : ""}" data-wm-list="${key}">${inList(key) ? `${I.check}В списке` : `${I.plus}В список`}</button>
          </div>
        </div>
      </div>
      ${similar.length ? `<div class="wm-similar"><h4>Похожее</h4><div class="wm-strip">${similar.map(x => tileHtml(x)).join("")}</div></div>` : ""}
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add("on"));
  const close = () => { modal.classList.remove("on"); window.setTimeout(() => modal.remove(), 300); };
  modal.addEventListener("click", e => { if (e.target === modal || e.target.closest("[data-wm-close]")) close(); });
  modal._close = close;
  wireActions(modal);
  modal.querySelectorAll("[data-wm-pop]").forEach(el => el.removeAttribute("data-wm-pop"));
  if (!t.description || !t.studio) {
    await fillDescription(t, modal.querySelector("[data-wm-desc]"));
    const st = modal.querySelector("[data-wm-studio]");
    if (st && t.studio) { st.textContent = t.studio; st.hidden = false; }
  }
}

// ---------- поиск-прожектор ----------
let spotSel = 0;
let spotFound = [];
function highlight(name, q) {
  const i = name.toLowerCase().indexOf(q);
  return i < 0 ? esc(name) : `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + q.length))}</mark>${esc(name.slice(i + q.length))}`;
}
function openSpot() {
  const r = root();
  if (!r || !data) return;
  let spot = r.querySelector(".wm-spot");
  if (!spot) {
    spot = document.createElement("div");
    spot.className = "wm-spot";
    spot.innerHTML = `
      <div class="wm-spot-box">
        <label class="wm-spot-in">${I.search}<input data-wm-q placeholder="Название, жанр или студия…" autocomplete="off"></label>
        <div class="wm-spot-res" data-wm-res></div>
        <div class="wm-spot-hint">стрелки — выбор · Enter — открыть · Esc — закрыть</div>
      </div>`;
    r.appendChild(spot);
    spot.addEventListener("click", e => { if (e.target === spot) closeSpot(); });
    const input = spot.querySelector("[data-wm-q]");
    input.addEventListener("input", runSpot);
    input.addEventListener("keydown", e => {
      const res = spot.querySelector("[data-wm-res]");
      const cols = Math.max(1, Math.round(res.clientWidth / 134));
      const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      const shown = Math.min(spotFound.length, 24);
      if (move) {
        e.preventDefault();
        spotSel = Math.max(0, Math.min(shown - 1, spotSel + move));
        res.querySelectorAll(".wm-tile").forEach((el, i) => el.classList.toggle("sel", i === spotSel));
        res.querySelectorAll(".wm-tile")[spotSel]?.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "Enter" && spotFound[spotSel]) { closeSpot(); openItem(`s:${spotFound[spotSel].id}`); }
    });
  }
  spot.querySelector("[data-wm-q]").value = "";
  runSpot();
  spot.classList.add("on");
  window.setTimeout(() => spot.querySelector("[data-wm-q]").focus(), 40);
}
function runSpot() {
  const spot = root().querySelector(".wm-spot");
  const q = spot.querySelector("[data-wm-q]").value.trim().toLowerCase();
  spotFound = q
    ? data.catalog.filter(t => `${t.name} ${t.name_en || ""} ${(t.genres || []).join(" ")} ${t.studio || ""}`.toLowerCase().includes(q))
    : byScore(data.catalog).slice(0, 12);
  spotSel = 0;
  const res = spot.querySelector("[data-wm-res]");
  res.innerHTML = spotFound.slice(0, 24).map(t => tileHtml(t, { hl: q ? highlight(t.name, q) : null })).join("") || `<div class="wm-empty">Ничего не нашлось.</div>`;
  res.querySelectorAll(".wm-tile").forEach((el, i) => {
    el.classList.toggle("sel", i === spotSel);
    el.removeAttribute("data-wm-pop");
    el.addEventListener("click", e => { e.stopPropagation(); closeSpot(); openItem(el.dataset.wmOpen); });
  });
}
function closeSpot() { root()?.querySelector(".wm-spot")?.classList.remove("on"); }

// ---------- мне повезёт ----------
function lucky() {
  const r = root();
  if (!r || !data) return;
  const pool = byScore(data.catalog.filter(t => t.score)).slice(0, 30);
  if (!pool.length) return;
  const win = pool[Math.floor(Math.random() * pool.length)];
  let slot = r.querySelector(".wm-slot");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "wm-slot";
    slot.innerHTML = `<div><div class="wm-reel" data-wm-reel></div><div class="wm-slot-title" data-wm-slot-title></div></div>`;
    r.appendChild(slot);
  }
  slot.classList.add("on");
  const reel = slot.querySelector("[data-wm-reel]");
  const title = slot.querySelector("[data-wm-slot-title]");
  const any = () => pool[Math.floor(Math.random() * pool.length)];
  const total = reduceMotion() ? 1 : 22;
  let n = 0;
  const spin = () => {
    const last = n === total - 1;
    const pick = last ? win : any();
    reel.innerHTML = `<div class="wm-card side" style="background-image:url('${imgProxy(any().cover)}')"></div><div class="wm-card${last ? " win" : ""}" style="background-image:url('${imgProxy(pick.cover)}')"></div><div class="wm-card side" style="background-image:url('${imgProxy(any().cover)}')"></div>`;
    title.textContent = last ? `🎉 ${pick.name}` : "";
    n += 1;
    if (n < total) window.setTimeout(spin, 40 + n * n * 0.9);
    else window.setTimeout(() => { slot.classList.remove("on"); openItem(`s:${win.id}`); }, 1200);
  };
  spin();
}

// ---------- вкладки ----------
function movePill(r) {
  const on = r.querySelector(".wm-tabs .on");
  const pill = r.querySelector(".wm-pill");
  if (on && pill) { pill.style.left = `${on.offsetLeft}px`; pill.style.width = `${on.offsetWidth}px`; }
}
function shellHtml() {
  return `
    <div class="wm-scroll" id="wm-scroll">
      <nav class="wm-nav" id="wm-nav">
        <div class="wm-brand"><i></i>Project <span>Смотреть</span></div>
        <div class="wm-tabs"><span class="wm-pill"></span>${TABS.map(([k, label]) => `<button type="button" data-wm-tab="${k}" class="${k === tab ? "on" : ""}">${label}</button>`).join("")}</div>
        <span class="wm-sp"></span>
        <button type="button" class="wm-search" data-wm-spot>${I.search}<span>Найти тайтл</span><kbd>/</kbd></button>
        <button type="button" class="wm-lucky" data-wm-lucky>🎲 Мне повезёт</button>
        <button type="button" class="wm-back" id="wm-back">← Команда</button>
      </nav>
      <div id="wm-body"><div class="wm-loading"><span></span>Загружаю каталог…</div></div>
    </div>`;
}
function wireShell(r) {
  r.querySelector("#wm-back").addEventListener("click", closeWatchMode);
  r.querySelector("[data-wm-spot]").addEventListener("click", openSpot);
  r.querySelector("[data-wm-lucky]").addEventListener("click", lucky);
  r.querySelectorAll("[data-wm-tab]").forEach(b => b.addEventListener("click", () => {
    tab = b.dataset.wmTab;
    r.querySelectorAll("[data-wm-tab]").forEach(x => x.classList.toggle("on", x === b));
    movePill(r);
    if (data) renderBody(r);
    r.querySelector("#wm-scroll").scrollTo({ top: 0, behavior: "smooth" });
  }));
  const scroll = r.querySelector("#wm-scroll");
  const nav = r.querySelector("#wm-nav");
  scroll.addEventListener("scroll", () => { hidePop(); nav.classList.toggle("solid", scroll.scrollTop > 30); }, { passive: true });
  requestAnimationFrame(() => movePill(r));
}

// живые отсчёты до серий
function tick() {
  const r = root();
  if (!r || r.hidden || !data) return;
  const now = Date.now() / 1000;
  r.querySelectorAll("[data-wm-at]").forEach(el => {
    const left = Number(el.dataset.wmAt) - now;
    if (left < 6 * 3600) { el.textContent = untilText(left); el.classList.add("soon"); }
  });
  const live = r.querySelector("[data-wm-live] span");
  const t = heroes()[heroIdx];
  if (live && t && t.next_at) live.textContent = nextText(t);
}

// ---------- открыть / закрыть ----------
function circleAround(el, r) {
  const a = el.getBoundingClientRect();
  const box = r.getBoundingClientRect();
  const cx = a.left + a.width / 2 - box.left;
  const cy = a.top + a.height / 2 - box.top;
  return { cx, cy, radius: Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy)) };
}
let opening = false;
export async function openWatchMode(fromEl) {
  const r = root();
  if (!r || opening || !r.hidden) return;
  opening = true;
  tab = "home";
  r.innerHTML = shellHtml();
  r.hidden = false;
  document.body.classList.add("watch-open");
  wireShell(r);
  const { cx, cy, radius } = circleAround(fromEl || $("#open-watch"), r);
  const app = $("#app-screen");
  if (!reduceMotion()) {
    const ease = "cubic-bezier(.65,0,.15,1)";
    r.animate([{ clipPath: `circle(0px at ${cx}px ${cy}px)` }, { clipPath: `circle(${radius}px at ${cx}px ${cy}px)` }], { duration: 850, easing: ease });
    if (app) app.animate([{ transform: "none", filter: "none" }, { transform: "scale(.94)", filter: "blur(6px)" }], { duration: 850, easing: ease });
    r.querySelector("#wm-nav").animate([{ opacity: 0, transform: "translateY(-16px)" }, { opacity: 1, transform: "none" }], { duration: 650, delay: 400, fill: "backwards", easing: "cubic-bezier(.22,.9,.3,1)" });
  }
  window.setTimeout(() => { opening = false; }, 850);
  window.clearInterval(tickTimer);
  tickTimer = window.setInterval(tick, 1000);
  try {
    // Свежий токен картинок до отрисовки: фоны — CSS, а не <img>, и сами
    // повторить запрос после 401 не умеют.
    await Promise.all([load(), forceMediaToken()]);
  } catch (e) {
    r.querySelector("#wm-body").innerHTML = `<div class="wm-pad"></div><div class="wm-empty">Не удалось загрузить каталог: ${esc(e.message)}</div>`;
    return;
  }
  if (r.hidden) return;
  renderBody(r);
  if (!reduceMotion()) {
    r.querySelector("#wm-hero")?.animate([{ transform: "scale(1.12)", filter: "brightness(1.5) blur(6px)" }, { transform: "none", filter: "none" }], { duration: 1200, easing: "cubic-bezier(.22,.9,.3,1)" });
  }
}

export function closeWatchMode() {
  const r = root();
  if (!r || r.hidden) return;
  window.clearInterval(heroTimer);
  window.clearInterval(frameTimer);
  window.clearInterval(tickTimer);
  io?.disconnect();
  document.querySelector(".wm-modal")?.remove();
  const done = () => { r.hidden = true; r.innerHTML = ""; r.style.removeProperty("--amb"); document.body.classList.remove("watch-open"); };
  if (reduceMotion()) { done(); return; }
  const { cx, cy, radius } = circleAround($("#open-watch") || r, r);
  const ease = "cubic-bezier(.65,0,.15,1)";
  const app = $("#app-screen");
  if (app) app.animate([{ transform: "scale(.94)", filter: "blur(6px)" }, { transform: "none", filter: "none" }], { duration: 750, easing: ease });
  r.animate([{ clipPath: `circle(${radius}px at ${cx}px ${cy}px)` }, { clipPath: `circle(0px at ${cx}px ${cy}px)` }], { duration: 750, easing: ease }).onfinish = done;
}

// Esc закрывает верхнее: прожектор → барабан → «Подробнее» → окна → сам режим.
// «/» открывает поиск. Плеер (.ap-root) обрабатывает свои клавиши сам.
document.addEventListener("keydown", e => {
  const r = root();
  if (!r || r.hidden || document.querySelector(".ap-root")) return;
  const tag = (e.target && e.target.tagName) || "";
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && !document.querySelector(".overlay")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openSpot();
    return;
  }
  if (e.key !== "Escape") return;
  if (r.querySelector(".wm-spot.on")) { e.stopImmediatePropagation(); closeSpot(); return; }
  if (r.querySelector(".wm-slot.on")) { e.stopImmediatePropagation(); return; }
  const modal = document.querySelector(".wm-modal");
  if (modal) { e.stopImmediatePropagation(); if (modal._close) modal._close(); else modal.remove(); return; }
  if (document.querySelector(".overlay")) return;
  e.stopImmediatePropagation();
  closeWatchMode();
}, true);

$("#open-watch")?.addEventListener("click", e => openWatchMode(e.currentTarget));
