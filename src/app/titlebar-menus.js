// Меню шапки: «Ещё» (редкие разделы), «Инструменты» (QC, ffmpeg, тема,
// обновить, клавиши, настройки) и профиль (аватар → «Мой профиль» / «Выйти»). Сами кнопки внутри меню
// — те же #open-qc, #refresh-btn, #logout-btn и т.д., их обработчики
// живут в своих модулях; здесь только открыть/закрыть меню.

import { state } from "./state.js";
import { $, esc } from "./utils.js";
import { loadAvatars } from "./profile.js";

const MENUS = [
  { wrap: "#more-wrap", btn: "#more-btn", menu: "#more-menu" },
  { wrap: "#tools-wrap", btn: "#tools-btn", menu: "#tools-menu" },
  { wrap: "#me-wrap", btn: "#me-btn", menu: "#me-menu" },
];

function closeAll(except) {
  MENUS.forEach(m => {
    if (m === except) return;
    const menu = $(m.menu);
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $(m.btn).setAttribute("aria-expanded", "false");
    }
  });
}

MENUS.forEach(m => {
  const btn = $(m.btn);
  const menu = $(m.menu);
  if (!btn || !menu) return;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    closeAll(m);
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector(".tb-mi")?.focus({ preventScroll: true });
  });
  // Пункт выбран — меню закрываем; сам клик дальше обработает модуль кнопки.
  menu.addEventListener("click", e => { if (e.target.closest(".tb-mi")) closeAll(); });
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll(".tb-mi:not([disabled])")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === "Escape") { e.stopPropagation(); closeAll(); btn.focus(); }
  });
});

document.addEventListener("click", e => { if (!e.target.closest(".tb-menu-wrap")) closeAll(); });
window.addEventListener("blur", () => closeAll());

$("#me-profile")?.addEventListener("click", () => {
  import("./tabs.js").then(m => m.switchTab("profile"));
});

// «Настройки» в меню «Ещё» — та же кнопка, что в «Инструментах».
$("#more-settings")?.addEventListener("click", () => $("#open-settings")?.click());

// Счётчики новых событий (лента, профиль) висят на пунктах меню «Ещё»,
// а меню закрыто — поэтому на самой кнопке «Ещё» загорается точка,
// пока внутри есть хоть один непустой бейдж.
const moreMenu = $("#more-menu");
if (moreMenu) {
  const syncDot = () => $("#more-btn")?.classList.toggle("has-badge",
    !!moreMenu.querySelector(".tab-badge:not([hidden])"));
  new MutationObserver(syncDot).observe(moreMenu, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
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
