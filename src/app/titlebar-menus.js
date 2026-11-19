
import { state } from "./state.js";
import { $, $all, esc } from "./utils.js";
import { loadAvatars } from "./profile.js";

const reducedMotion = () => document.documentElement.dataset.motion === "off"
  || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const isShown = el => !el.hidden && globalThis.getComputedStyle?.(el)?.display !== "none";

const MENUS = $all(".tb-menu-wrap").map(wrap => ({
  wrap,
  btn: wrap.querySelector(":scope > button[aria-haspopup]"),
  menu: wrap.querySelector(":scope > .tb-menu"),
})).filter(m => m.btn && m.menu);

function closeMenus(except) {
  MENUS.forEach(m => {
    if (m === except || m.menu.hidden) return;
    m.menu.hidden = true;
    m.btn.setAttribute("aria-expanded", "false");
  });
}

MENUS.forEach(m => {
  const { btn, menu } = m;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    closeMenus(m);
    closeFan(true);
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector(".tb-mi")?.focus({ preventScroll: true });
  });
  menu.addEventListener("click", e => { if (e.target.closest(".tb-mi")) closeMenus(); });
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll(".tb-mi:not([disabled])")].filter(isShown);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === "Escape") { e.stopPropagation(); closeMenus(); btn.focus(); }
  });
});

document.addEventListener("click", e => { if (!e.target.closest(".tb-menu-wrap")) closeMenus(); });
window.addEventListener("blur", () => { closeMenus(); closeFan(true); });

const fan = $("#tabstrip.fan");
const fanBtn = $("#fan-btn");
const fanMenu = $("#fan-menu");
const scrim = $("#fan-scrim");
const STEP = 40;
const GAP = 10;
const TH_BOT = -6 * Math.PI / 180;
const TH_TOP = 15 * Math.PI / 180;
const PICK_MS = 420;
const CLOSE_MS = 140;
let fanTimer = 0;

const fanItems = () => fanMenu ? [...fanMenu.querySelectorAll(".fan-it")].filter(isShown) : [];
const fanOpen = () => !!fanMenu && !fanMenu.hidden && !fan.classList.contains("fan-closing");

function layoutFan() {
  const items = fanItems();
  if (!items.length) return;
  const groups = new Set(items.map(it => it.dataset.grp)).size - 1;
  const room = window.innerHeight - 120;
  const step = Math.min(STEP, (room - groups * GAP) / Math.max(1, items.length - 1));
  const ys = [];
  let y = 0, prev = items[0].dataset.grp;
  items.forEach(it => {
    if (it.dataset.grp !== prev) { y += GAP; prev = it.dataset.grp; }
    ys.push(y);
    y += step;
  });
  const H = Math.max(1, ys[ys.length - 1]);
  const R = H / (Math.sin(TH_TOP) - Math.sin(TH_BOT));
  items.forEach((it, i) => {
    const th = Math.asin(Math.sin(TH_BOT) + ys[i] / R);
    it.style.setProperty("--x", `${(-R * (Math.cos(th) - Math.cos(TH_TOP))).toFixed(1)}px`);
    it.style.setProperty("--y", `${(-ys[i]).toFixed(1)}px`);
    it.style.setProperty("--r", `${(th * 180 / Math.PI).toFixed(2)}deg`);
  });
}

const setTint = color => fan.style.setProperty("--fan-c", color);

function syncFanButton() {
  if (!fanBtn) return;
  const cur = fanMenu.querySelector(".tab-btn.active");
  if (!fanOpen()) setTint(cur?.style.getPropertyValue("--c") || "#ffd23f");
  const ic = cur?.querySelector(".tab-ic svg");
  const holder = $("#fan-btn-ic");
  if (ic && holder.dataset.tab !== cur.dataset.tab) {
    holder.innerHTML = ic.outerHTML;
    holder.dataset.tab = cur.dataset.tab;
    fanBtn.setAttribute("aria-label", `Разделы — сейчас «${cur.querySelector(".tab-lbl")?.textContent || ""}»`);
  }
  fanBtn.classList.toggle("has-badge", !!fanMenu.querySelector(".fan-it .tab-badge:not([hidden])"));
}

function resetFan() {
  fan.classList.remove("fan-open", "fan-closing", "fan-picking");
  fanMenu.querySelector(".fan-chosen")?.classList.remove("fan-chosen");
}

function openFan(focus) {
  if (!fan || fanOpen()) return;
  closeMenus();
  clearTimeout(fanTimer);
  resetFan();
  layoutFan();
  fanMenu.hidden = false;
  scrim.hidden = false;
  fanBtn.setAttribute("aria-expanded", "true");
  void fanMenu.offsetWidth;
  fan.classList.add("fan-open");
  const items = fanItems();
  const cur = items.find(it => it.classList.contains("active"));
  const target = focus === "last" ? items[items.length - 1] : cur || items[0];
  target?.focus({ preventScroll: true });
}

function closeFan(instant, picked) {
  if (!fan || fanMenu.hidden) return;
  clearTimeout(fanTimer);
  fanBtn.setAttribute("aria-expanded", "false");
  const done = () => {
    fanBtn.style.transition = "none";
    setTimeout(() => { fanBtn.style.transition = ""; }, 50);
    resetFan();
    fanMenu.hidden = true;
    scrim.hidden = true;
    syncFanButton();
  };
  if (picked) setTint(picked.style.getPropertyValue("--c"));
  if (instant || reducedMotion()) { done(); return; }
  if (picked) { picked.classList.add("fan-chosen"); fan.classList.add("fan-picking"); }
  fan.classList.add("fan-closing");
  fan.classList.remove("fan-open");
  fanTimer = setTimeout(done, picked ? PICK_MS : CLOSE_MS);
}

if (fan && fanBtn && fanMenu) {
  document.body.appendChild(fan);
  fanBtn.addEventListener("click", e => {
    e.stopPropagation();
    if (fanOpen()) closeFan(); else openFan();
  });
  fanBtn.addEventListener("keydown", e => {
    if (e.key === "ArrowUp") { e.preventDefault(); openFan(); }
  });
  scrim.addEventListener("click", () => { closeFan(); fanBtn.focus({ preventScroll: true }); });
  let replaying = false;
  fanMenu.addEventListener("click", e => {
    const it = e.target.closest(".fan-it");
    if (!it || replaying) return;
    if (reducedMotion()) { closeFan(true); fanBtn.focus({ preventScroll: true }); return; }
    e.stopImmediatePropagation();
    closeFan(false, it);
    fanBtn.focus({ preventScroll: true });
    setTimeout(() => { replaying = true; try { it.click(); } finally { replaying = false; } }, 40);
  }, true);
  const tintFrom = it => { if (it && fanOpen()) setTint(it.style.getPropertyValue("--c")); };
  fanMenu.addEventListener("focusin", e => tintFrom(e.target.closest(".fan-it")));
  fanMenu.addEventListener("pointermove", e => {
    const it = e.target.closest(".fan-it");
    if (!it) return;
    tintFrom(it);
    if (document.activeElement !== it) it.focus({ preventScroll: true });
  });
  fanMenu.addEventListener("keydown", e => {
    const items = fanItems();
    const i = items.indexOf(document.activeElement);
    const go = j => { e.preventDefault(); items[(j + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowUp") return go(i + 1);
    if (e.key === "ArrowDown") return go(i < 0 ? 0 : i - 1);
    if (e.key === "Home") return go(0);
    if (e.key === "End") return go(-1);
    if (e.key === "Escape") { e.stopPropagation(); closeFan(); fanBtn.focus({ preventScroll: true }); return; }
    if (e.key === "Tab") { closeFan(true); fanBtn.focus({ preventScroll: true }); e.preventDefault(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      for (let s = 1; s <= items.length; s++) {
        const it = items[(i + s) % items.length];
        if ((it.querySelector(".tab-lbl")?.textContent || "").trim().toLowerCase().startsWith(k)) { e.preventDefault(); it.focus(); return; }
      }
    }
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "F10" || e.ctrlKey || e.altKey || e.metaKey || $("#titlebar-apps")?.hidden) return;
    e.preventDefault();
    if (fanOpen()) closeFan(); else openFan();
  });
  window.addEventListener("resize", () => { if (fanOpen()) layoutFan(); });

  $all(".tab-btn").forEach((b, i) => {
    if (i < 9 && b.closest("#tabstrip")) b.insertAdjacentHTML("beforeend", `<kbd class="fan-kbd" aria-hidden="true">Ctrl ${i + 1}</kbd>`);
  });

  let queued = false;
  const queue = () => { if (!queued) { queued = true; setTimeout(() => { queued = false; syncFanButton(); if (fanOpen()) layoutFan(); }); } };
  new MutationObserver(queue).observe(fanMenu, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "data-perm-hidden", "data-perm-show"] });
  new MutationObserver(queue).observe(document.documentElement, { attributes: true, attributeFilter: ["data-role", "data-nyaa", "data-perm-reports"] });
  syncFanButton();
}

$("#me-profile")?.addEventListener("click", () => {
  import("./tabs.js").then(m => m.switchTab("profile"));
});

$("#more-settings")?.addEventListener("click", () => $("#open-settings")?.click());

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
