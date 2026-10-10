// «Кого войдём?» — выбор пространства при запуске и по кнопке аватара: рабочий профиль Project или игровой профиль Steam.
// Выбор запускает плавный переход (карточка вырастает, остальные уходят, экран под ней меняется на лету).
// Рабочие вкладки не трогаем: игры живут в своей оболочке (games-space.js) и в рабочее меню не попадают.

import { state } from "./state.js";
import { apiGet, apiPost, mediaUrl, ensureMediaToken, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { initials2 } from "./games-core.js";
import { enterGames, resetGames } from "./games-space.js";
import { linkSteam } from "./steam-link.js";

const ON_START_KEY = "project-chooser-on-start";
const LAST_KEY = "project-last-space";
const ANIM_MS = 420;

let space = "work";            // work | games
let open = false;
let cache = null;              // последний /games/me
let focusIdx = 0;

const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
const wait = ms => new Promise(r => setTimeout(r, reduced() ? 0 : ms)); // DevSkim: ignore DS172411 — функция, не строка
const onStart = () => { try { return localStorage.getItem(ON_START_KEY) !== "0"; } catch (_) { return true; } };
const setOnStart = v => { try { localStorage.setItem(ON_START_KEY, v ? "1" : "0"); } catch (_) { /* не запомнится */ } };

export const currentSpace = () => space;

function ensure() {
  let el = $("#space-chooser");
  if (el) return el;
  el = document.createElement("div");
  el.id = "space-chooser";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Кого войдём?");
  document.body.appendChild(el);
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", onKey);
  return el;
}

function avatarHtml(src, name) {
  return `<i class="sp-ava">${src ? `<img src="${esc(src)}" alt="" draggable="false">` : `<span>${esc(initials2(name))}</span>`}</i>`;
}

function render() {
  const el = ensure();
  const accs = (cache && cache.accounts) || [];
  const cards = [
    `<button type="button" class="sp-card${space === "work" ? " cur" : ""}" data-sp="work"><span class="sp-glow"></span>${avatarHtml("", state.name)}<b>${esc(state.name || "Project")}</b><small>Project · рабочий режим</small></button>`,
    ...accs.map(a => `<button type="button" class="sp-card steam${space === "games" && cache.steamid === a.steamid ? " cur" : ""}" data-sp="games" data-sid="${esc(a.steamid)}"><span class="sp-glow"></span>${avatarHtml(a.avatar ? mediaUrl("/img_proxy", { url: a.avatar }) : "", a.name)}<b>${esc(a.name || a.steamid)}</b><small>Steam · игры</small></button>`),
    `<button type="button" class="sp-card add" data-sp-add><span class="sp-plus">+</span><b>Добавить Steam</b><small>вход через сайт Steam</small></button>`,
  ];
  el.innerHTML = `
    <div class="sp-bg"></div>
    <div class="sp-inner">
      <h1>Кого войдём?</h1>
      <div class="sp-cards" id="sp-cards">${cards.join("")}</div>
      <label class="sp-foot"><input type="checkbox" id="sp-onstart"${onStart() ? " checked" : ""}> Показывать при запуске</label>
    </div>`;
  const list = [...el.querySelectorAll(".sp-card")];
  focusIdx = Math.max(0, list.findIndex(c => c.classList.contains("cur")));
  list[focusIdx] && list[focusIdx].focus({ preventScroll: true });
}

async function fetchMe() {
  await ensureMediaToken();
  try { cache = await apiGet("/games/me"); } catch (_) { cache = cache || { accounts: [], steamid: null }; }
}

export async function openChooser() {
  if (open || !state.token) return;
  open = true;
  const el = ensure();
  el.classList.remove("closing", "picking");
  el.hidden = false;
  render();                        // сразу — карточка Project уже есть, Steam-профили подтянутся следом
  requestAnimationFrame(() => el.classList.add("show"));
  await fetchMe();
  if (open) render();
}

async function closeChooser() {
  const el = $("#space-chooser");
  if (!el || !open) return;
  open = false;
  el.classList.add("closing");
  el.classList.remove("show");
  await wait(ANIM_MS);
  el.hidden = true;
  el.classList.remove("closing", "picking");
}

function showSpace(name) {
  space = name;
  document.body.dataset.space = name;
  try { localStorage.setItem(LAST_KEY, name); } catch (_) { /* не запомнится */ }
  const app = $("#app-screen"), gm = $("#games-screen");
  if (app) app.hidden = name !== "work";
  if (gm) { gm.hidden = name !== "games"; gm.classList.toggle("sp-enter", name === "games"); }
  if (name === "work" && app) { app.classList.remove("sp-enter"); void app.offsetWidth; app.classList.add("sp-enter"); }
}

async function pick(card) {
  const el = $("#space-chooser");
  if (!el || el.classList.contains("picking")) return;
  const target = card.dataset.sp;
  if (target === "games") {
    card.classList.add("busy");
    try {
      if (card.dataset.sid && cache.steamid !== card.dataset.sid) { await apiPost("/games/steam/select", { steamid: card.dataset.sid }); await fetchMe(); }
    } catch (e) { card.classList.remove("busy"); toast(e.message, "error"); return; }
    card.classList.remove("busy");
  }
  el.classList.add("picking");
  card.classList.add("picked");
  await wait(ANIM_MS * 0.55);       // карточка вырастает, остальные уходят
  if (target === "games") { await enterGames(cache); showSpace("games"); }   // оболочка создаётся в enterGames — показываем после
  else { showSpace("work"); }
  await closeChooser();
}

async function addSteam(card) {
  card.classList.add("busy");
  card.querySelector("small").textContent = "ждём подтверждения Steam…";
  try {
    cache = await linkSteam();
    toast("Steam привязан.", "success");
    render();
  } catch (e) { toast(e.message, "error"); render(); }
}

function onClick(e) {
  const t = e.target;
  if (t.closest("#sp-onstart")) { setOnStart(t.closest("#sp-onstart").checked); return; }
  const add = t.closest("[data-sp-add]");
  if (add) { addSteam(add); return; }
  const card = t.closest("[data-sp]");
  if (card) pick(card);
}

function onKey(e) {
  const list = [...document.querySelectorAll("#space-chooser .sp-card")];
  if (!list.length) return;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    focusIdx = (focusIdx + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
    list[focusIdx].focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeChooser();                 // остаёмся в текущем пространстве
  }
}

/** Вызывается после входа/восстановления сессии: показать выбор, если он включён. */
export function maybeShowChooserOnStart() {
  showSpace("work");
  if (onStart()) openChooser();
}

/** Выход из аккаунта Project: игровое пространство и выбор сбрасываются. */
export function resetSpaces() {
  space = "work";
  cache = null;
  open = false;
  document.body.dataset.space = "work";
  const el = $("#space-chooser"); if (el) { el.hidden = true; el.className = ""; el.innerHTML = ""; }
  const gm = $("#games-screen"); if (gm) gm.hidden = true;
  resetGames();
}

document.addEventListener("project:open-chooser", openChooser);
document.addEventListener("click", e => {
  if (e.target.closest("#me-switch")) { const m = $("#me-menu"); if (m) m.hidden = true; openChooser(); }
});
