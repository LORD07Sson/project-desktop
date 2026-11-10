// Меню шапки. Разделы — строкой меню (#tabstrip: «Работа», «Тайтлы»,
// «Команда», «Ещё»), справа — «Инструменты» (QC, ffmpeg, тема, обновить,
// клавиши, настройки) и профиль (аватар → «Мой профиль» / «Выйти»).
// Пункты внутри меню — те же .tab-btn[data-tab], #open-qc, #refresh-btn,
// #logout-btn и т.д., их обработчики живут в своих модулях; здесь только
// открыть/закрыть меню и клавиатура.
//
// Поведение строки меню как в настольных ОС: пока одно меню открыто,
// наведение на соседнее слово сразу открывает его; ←/→ — соседнее меню,
// ↑/↓/Home/End и первая буква — по пунктам, Esc — закрыть, F10 — фокус
// на строку меню.

import { state } from "./state.js";
import { $, $all, esc } from "./utils.js";
import { loadAvatars } from "./profile.js";

const MENUS = $all(".tb-menu-wrap").map(wrap => ({
  wrap,
  btn: wrap.querySelector(":scope > button[aria-haspopup]"),
  menu: wrap.querySelector(":scope > .tb-menu"),
  bar: wrap.classList.contains("mb-wrap"),
})).filter(m => m.btn && m.menu);

const reducedMotion = () => document.documentElement.dataset.motion === "off"
  || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Пункт виден, если его не убрали правами: hidden, [data-perm-hidden] или CSS роли «участник».
const isShown = el => !el.hidden && globalThis.getComputedStyle?.(el)?.display !== "none";
const itemsOf = m => [...m.menu.querySelectorAll(".tb-mi:not([disabled])")].filter(isShown);
const barMenus = () => MENUS.filter(m => m.bar && !m.wrap.hidden);
const openMenu = () => MENUS.find(m => !m.menu.hidden && !m.menu.classList.contains("mb-closing"));

function hide(m, instant) {
  const { menu, btn } = m;
  if (menu.hidden) return;
  btn.setAttribute("aria-expanded", "false");
  m.wrap.classList.remove("mb-open");
  if (instant || reducedMotion() || !m.bar) { menu.classList.remove("mb-closing"); menu.hidden = true; return; }
  // Короткое растворение (как в референсе: ~110 мс), потом hidden.
  menu.classList.add("mb-closing");
  clearTimeout(m.t);
  m.t = setTimeout(() => { menu.classList.remove("mb-closing"); if (btn.getAttribute("aria-expanded") === "false") menu.hidden = true; }, 120);
}

function closeAll(except, instant) {
  MENUS.forEach(m => { if (m !== except) hide(m, instant); });
}

function show(m, focus) {
  // Переход между соседними меню строки — без анимации ухода, иначе два меню на миг висят вместе.
  closeAll(m, true);
  clearTimeout(m.t);
  m.menu.classList.remove("mb-closing");
  itemsOf(m).forEach((it, i) => it.style.setProperty("--i", i));
  m.menu.hidden = false;
  m.btn.setAttribute("aria-expanded", "true");
  m.wrap.classList.add("mb-open");
  const items = itemsOf(m);
  if (focus === "first") items[0]?.focus({ preventScroll: true });
  else if (focus === "last") items[items.length - 1]?.focus({ preventScroll: true });
}

// Соседнее меню строки (по кругу), пропуская скрытые правами.
function neighbour(m, dir) {
  const bar = barMenus();
  const i = bar.indexOf(m);
  return i < 0 ? null : bar[(i + dir + bar.length) % bar.length];
}

MENUS.forEach(m => {
  const { btn, menu } = m;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    if (menu.hidden || menu.classList.contains("mb-closing")) show(m, e.detail === 0 ? "first" : null);
    else hide(m);
  });
  // Пока какое-то меню строки открыто — наведение переключает меню без клика.
  if (m.bar) btn.addEventListener("pointerenter", () => {
    const cur = openMenu();
    if (cur && cur !== m && cur.bar) { show(m); btn.focus({ preventScroll: true }); }
  });
  btn.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || ((e.key === "Enter" || e.key === " ") && m.bar)) { e.preventDefault(); show(m, "first"); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); show(m, "last"); return; }
    if (!m.bar) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = neighbour(m, e.key === "ArrowRight" ? 1 : -1);
      if (!n) return;
      if (openMenu()) show(n);
      n.btn.focus();
    }
    if (e.key === "Escape" && openMenu()) { e.stopPropagation(); closeAll(); }
  });

  // Пункт выбран — меню закрываем; сам клик дальше обработает модуль кнопки.
  menu.addEventListener("click", e => {
    if (!e.target.closest(".tb-mi")) return;
    closeAll(null, true);
    if (m.bar) { btn.classList.remove("mb-picked"); void btn.offsetWidth; btn.classList.add("mb-picked"); }
  });
  // Подсветка следует за мышью, а стрелки продолжают с того же пункта.
  menu.addEventListener("pointermove", e => {
    const it = e.target.closest(".tb-mi");
    if (it && document.activeElement !== it && !it.disabled) it.focus({ preventScroll: true });
  });
  menu.addEventListener("keydown", e => {
    const items = itemsOf(m);
    const i = items.indexOf(document.activeElement);
    const go = j => { e.preventDefault(); items[(j + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") return go(i + 1);
    if (e.key === "ArrowUp") return go(i < 0 ? -1 : i - 1);
    if (e.key === "Home") return go(0);
    if (e.key === "End") return go(-1);
    if (e.key === "Escape") { e.stopPropagation(); hide(m); btn.focus(); return; }
    if (e.key === "Tab") { hide(m, true); return; }
    if (m.bar && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const n = neighbour(m, e.key === "ArrowRight" ? 1 : -1);
      if (n) { show(n, "first"); }
      return;
    }
    // Первая буква — к следующему пункту на эту букву.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const label = it => (it.querySelector(".tab-lbl, span:not(.tab-ic)")?.textContent || it.textContent).trim().toLowerCase();
      for (let s = 1; s <= items.length; s++) {
        const it = items[(i + s) % items.length];
        if (label(it).startsWith(k)) { e.preventDefault(); it.focus(); return; }
      }
    }
  });
});

document.addEventListener("click", e => { if (!e.target.closest(".tb-menu-wrap")) closeAll(); });
window.addEventListener("blur", () => closeAll(null, true));
// F10 — фокус на первое слово строки меню (без открытия), как в настольных программах.
document.addEventListener("keydown", e => {
  if (e.key !== "F10" || e.ctrlKey || e.altKey || e.metaKey || $("#titlebar-apps")?.hidden) return;
  e.preventDefault();
  barMenus()[0]?.btn.focus();
});

$("#me-profile")?.addEventListener("click", () => {
  import("./tabs.js").then(m => m.switchTab("profile"));
});

// «Настройки» в меню «Ещё» — та же кнопка, что в «Инструментах».
$("#more-settings")?.addEventListener("click", () => $("#open-settings")?.click());

// Подсказка Ctrl+N справа у пункта — по тому же порядку .tab-btn, что и
// сочетание в shortcuts-help.js.
$all(".tab-btn").forEach((b, i) => {
  if (i < 9 && b.closest("#tabstrip")) b.insertAdjacentHTML("beforeend", `<kbd class="mb-kbd" aria-hidden="true">Ctrl ${i + 1}</kbd>`);
});

// Состояние слов строки меню:
// - меню, где права не оставили ни одного пункта, прячется целиком;
// - слово подсвечено, если открыт один из его разделов;
// - точка на слове, пока внутри есть непустой бейдж (лента, профиль, чат).
function syncBar() {
  for (const m of MENUS) {
    if (m.bar) {
      const empty = !itemsOf(m).length;
      // Разделитель без видимых пунктов с одной из сторон (права всё убрали) — прячем.
      for (const sep of m.menu.querySelectorAll(".tb-sep")) {
        const side = dir => { for (let el = sep[dir]; el && !el.classList.contains("tb-sep"); el = el[dir]) if (el.classList.contains("tb-mi") && isShown(el)) return true; return false; };
        const need = side("previousElementSibling") && side("nextElementSibling");
        if (sep.hidden === need) sep.hidden = !need;
      }
      if (m.wrap.hidden !== empty) m.wrap.hidden = empty;
      const active = !!m.menu.querySelector(".tab-btn.active");
      if (m.btn.classList.contains("active") !== active) m.btn.classList.toggle("active", active);
    }
    const dot = !!m.menu.querySelector(".tab-badge:not([hidden])");
    if (m.btn.classList.contains("has-badge") !== dot) m.btn.classList.toggle("has-badge", dot);
  }
}
let syncQueued = false;
const queueSync = () => { if (!syncQueued) { syncQueued = true; setTimeout(() => { syncQueued = false; syncBar(); }); /* не rAF: в свёрнутом окне он стоит */ } };
const bar = $("#tabstrip");
if (bar) {
  new MutationObserver(queueSync).observe(bar, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "data-perm-hidden", "data-perm-show", "style"] });
  // Роль/права/доступ к Релизам приходят атрибутами на <html> (perm-visibility, auth).
  new MutationObserver(queueSync).observe(document.documentElement, { attributes: true });
  syncBar();
}

// Аватар и имя в меню профиля. Зовётся из setDisplayName (auth.js):
// имя приходит не сразу — после /me.
export function setTitlebarIdentity(name) {
  const av = $("#me-avatar");
  const head = $("#me-head");
  if (!av || !head) return;
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  if (av.getAttribute("data-avatar-for") !== String(state.telegramId || "")) {
    av.removeAttribute("data-avatar-loaded");
    av.textContent = initial;
    av.setAttribute("data-avatar-for", state.telegramId || "");
  } else if (!av.querySelector("img")) {
    av.textContent = initial;
  }
  head.innerHTML = `<b>${esc(name || "Без имени")}</b><span>${state.isAdmin ? "Администратор команды" : "Участник команды"}</span>`;
  loadAvatars(av.parentNode);
}
