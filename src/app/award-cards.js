// Коллекция наград карточками-марками. Данные — те же badges из /api/me,
// что рисует профиль плитками (profile_api._user_badges): своего бэкенда
// нет. Открывается кликом по плитке достижения в профиле (сразу в фокус
// этой карточки) или из командной палитры.
//
// Движение (разбор референса, см. заметки сессии):
//  - hover: карточка приподнимается и наклоняется к курсору, соседние
//    обесцвечиваются, над карточкой всплывает моно-чип с номером;
//  - клик: фон темнеет ~300 мс, карточка FLIP-ом летит из своего места
//    в центр, выпрямляясь (~520 мс, ease-out), в фокусе следует за
//    курсором ±8° и гоняет блик; выход — обратный путь ~360 мс.
// prefers-reduced-motion: без наклонов и полётов, только смена прозрачности.

import { apiGet } from "./api.js";
import { esc, BADGE_RARITY_ORDER } from "./utils.js";

// Арт персонажей — официальный фанкит Arknights (arknights.global/fankit),
// фигуры вырезаны без фона (rembg, isnet-anime). Подобран по смыслу награды:
// «Первый отчёт» — героиня в начале пути, «Дирижёр» — командир и т.д.
const ART_FILES = import.meta.glob("../assets/award-art/*.webp", { eager: true, query: "?url", import: "default" });
const art = (slug, hi) => ART_FILES[`../assets/award-art/${slug}${hi ? "@4k" : ""}.webp`] || "";
const ART_BY_LABEL = {
  "Первый отчёт": "first-report",
  "Ноль просрочек": "zero-overdue",
  "Без просрочек за месяц": "clean-month",
  "90%+ вовремя": "on-time-90",
  "10+ закрыто": "closed-10",
  "50+ закрыто": "closed-50",
  "Лучший за неделю": "best-week",
  "Первая роспись": "first-prep",
  "10 субтитров": "subs-10",
  "Дирижёр: 25 назначений": "conductor",
  "25 серий подготовлено": "series-25",
};
// Ручные награды (custom) и будущие без своего арта — общий портрет.
// В сетке — лёгкая версия (720 px), в крупном фокусе — 4K (до 2160 px).
const artFor = (b, hi) => art(ART_BY_LABEL[b.label] || "custom", hi);

const RARITY = {
  common: "Обычная",
  rare: "Редкая",
  epic: "Эпическая",
  legendary: "Легендарная",
  custom: "Особая",
};
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE_IN = "cubic-bezier(.16,.84,.24,1)";
const EASE_OUT = "cubic-bezier(.5,0,.75,0)";

let root = null;

function cardId(b, i) {
  const code = { common: "C", rare: "R", epic: "E", legendary: "L", custom: "X" }[b.rarity] || "C";
  return `KDR-${code}-${String(i + 1).padStart(3, "0")}`;
}

function cardHtml(b, i) {
  const r = RARITY[b.rarity] ? b.rarity : "common";
  const has = b.target ? Math.max(0, Math.min(b.target, b.current || 0)) : null;
  const pct = b.target ? Math.round((has / b.target) * 100) : 0;
  // Лёгкий веер: у каждой карточки свой постоянный наклон −4…+4°.
  const tilt = ((i * 37) % 9) - 4;
  const foot = b.unlocked
    ? `<span class="ac-state">получено</span>`
    : `<span class="ac-state">${b.target ? `${has} / ${b.target}` : "закрыто"}</span>${b.target ? `<span class="ac-bar"><i style="width:${pct}%"></i></span>` : ""}`;
  return `
    <button type="button" class="ac-card r-${r}${b.unlocked ? " won" : " locked"}${b.is_nearest ? " near" : ""}"
      data-i="${i}" style="--rot:${tilt}deg" aria-label="${esc(b.label)} — ${RARITY[r]}${b.unlocked ? ", получено" : ""}">
      <span class="ac-chip">${cardId(b, i)} • ${b.unlocked ? "ПОЛУЧЕНО" : "В ПРОЦЕССЕ"}</span>
      <span class="ac-stamp">
        <span class="ac-face">
          ${artFor(b) ? `<span class="ac-field"><img class="ac-char" src="${artFor(b)}" data-hi="${artFor(b, true)}" alt="" draggable="false" loading="lazy"></span>` : ""}
          <span class="ac-top"><span class="ac-rar">${RARITY[r]}</span><span class="ac-no">${String(i + 1).padStart(3, "0")}</span></span>
          <span class="ac-art${artFor(b) ? " has-char" : ""}"><span class="ac-ic">${esc(b.icon || "★")}</span></span>
          <span class="ac-lb">${esc(b.label)}</span>
          <span class="ac-foot">${foot}</span>
          <span class="ac-glit" aria-hidden="true"></span>
          <span class="ac-sheen" aria-hidden="true"></span>
        </span>
      </span>
    </button>`;
}

function sortBadges(list) {
  return list.slice().sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0)
    || (BADGE_RARITY_ORDER[a.rarity] ?? 9) - (BADGE_RARITY_ORDER[b.rarity] ?? 9));
}

/** Открыть коллекцию; focusLabel — сразу показать эту карточку крупно. */
export async function openAwardCollection(focusLabel) {
  if (root) return;
  root = document.createElement("div");
  root.className = "ac-overlay";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Коллекция наград");
  root.innerHTML = `<div class="ac-panel"><div class="ac-head"><h2>Коллекция наград</h2><span class="ac-count"></span><button type="button" class="ac-close" aria-label="Закрыть">✕</button></div><div class="ac-grid"><div class="ac-empty">Загрузка…</div></div></div><div class="ac-focus" hidden></div>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root && root.classList.add("in"));

  let me;
  try { me = await apiGet("/me"); } catch (_) { me = null; }
  if (!root) return;
  const list = sortBadges((me && me.badges) || []);
  const grid = root.querySelector(".ac-grid");
  if (!list.length) { grid.innerHTML = `<div class="ac-empty">Наград пока нет</div>`; }
  else grid.innerHTML = list.map(cardHtml).join("");
  root.querySelector(".ac-count").textContent = list.length ? `${list.filter(b => b.unlocked).length} из ${list.length}` : "";
  wire(root, list);
  if (focusLabel) {
    const i = list.findIndex(b => b.label === focusLabel);
    if (i >= 0) requestAnimationFrame(() => focusCard(grid.querySelector(`.ac-card[data-i="${i}"]`)));
  }
}

function closeCollection() {
  if (!root) return;
  const el = root;
  root = null;
  document.removeEventListener("keydown", onKey, true);
  el.classList.remove("in");
  setTimeout(() => el.remove(), reduced() ? 0 : 260);
}

let focused = null; // { card, clone }

function onKey(e) {
  if (e.key !== "Escape" || !root) return;
  e.stopPropagation();
  e.preventDefault();
  if (focused) unfocus(); else closeCollection();
}

function tiltTo(el, e, max) {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  el.style.setProperty("--ry", `${(x * max * 2).toFixed(2)}deg`);
  el.style.setProperty("--rx", `${(-y * max * 2).toFixed(2)}deg`);
  el.style.setProperty("--mx", `${((x + 0.5) * 100).toFixed(1)}%`);
  el.style.setProperty("--my", `${((y + 0.5) * 100).toFixed(1)}%`);
  el.style.setProperty("--tx", (x * 2).toFixed(3));
  el.style.setProperty("--ty", (y * 2).toFixed(3));
}

function resetTilt(el) {
  for (const p of ["--rx", "--ry", "--mx", "--my", "--tx", "--ty"]) el.style.removeProperty(p);
}

function wire(host, list) {
  document.addEventListener("keydown", onKey, true);
  host.querySelector(".ac-close").addEventListener("click", closeCollection);
  host.addEventListener("mousedown", (e) => { if (e.target === host) closeCollection(); });
  wireGrid(host.querySelector(".ac-grid"), (c) => { if (list[c.dataset.i]) focusCard(c); });
}

// Наклон/подсветка/клик для любой сетки карточек — и в оверлее, и в профиле.
function wireGrid(grid, onPick) {
  grid.addEventListener("pointermove", (e) => {
    const c = e.target.closest(".ac-card");
    if (!c || reduced()) return;
    tiltTo(c, e, 7);
  });
  grid.addEventListener("pointerover", (e) => {
    const c = e.target.closest(".ac-card");
    grid.classList.toggle("hovering", !!c);
    if (c) c.classList.add("hot");
  });
  grid.addEventListener("pointerout", (e) => {
    const c = e.target.closest(".ac-card");
    if (c && !c.contains(e.relatedTarget)) { c.classList.remove("hot"); resetTilt(c); }
    if (!grid.contains(e.relatedTarget) || !e.relatedTarget?.closest?.(".ac-card")) grid.classList.remove("hovering");
  });
  grid.addEventListener("click", (e) => {
    const c = e.target.closest(".ac-card");
    if (c) onPick(c);
  });
}

// Раздел «Награды» в профиле: плитки .pf-badges (их рисует profile.js)
// заменяем этими же марками, не трогая разметку профиля. Режим
// разработчика (кнопки отзыва ручных наград) оставляем на плитках.
let inlineBusy = false;
async function upgradeProfileBadges() {
  const box = document.querySelector(".pf-badges:not([data-ac])");
  if (!box || inlineBusy || box.querySelector("[data-revoke-badge]")) return;
  inlineBusy = true;
  box.dataset.ac = "1";
  let me;
  try { me = await apiGet("/me"); } catch (_) { me = null; }
  inlineBusy = false;
  const list = sortBadges((me && me.badges) || []);
  if (!list.length || !box.isConnected) return;
  const grid = document.createElement("div");
  grid.className = "ac-grid ac-inline";
  grid.innerHTML = list.map(cardHtml).join("");
  box.before(grid);
  box.style.display = "none"; // плитки остаются в разметке (их проверяет profile-qc-test), карточки — вместо них на экране
  wireGrid(grid, (c) => openAwardCollection(list[c.dataset.i]?.label));
}
new MutationObserver(() => { if (document.querySelector(".pf-badges:not([data-ac])")) upgradeProfileBadges(); })
  .observe(document.body, { childList: true, subtree: true });

function focusCard(card) {
  if (!card || focused || !root) return;
  const layer = root.querySelector(".ac-focus");
  const from = card.querySelector(".ac-stamp").getBoundingClientRect();
  const clone = card.querySelector(".ac-stamp").cloneNode(true);
  clone.classList.add("ac-big");
  card.classList.forEach(c => { if (c.startsWith("r-") || c === "won" || c === "locked") clone.classList.add(c); });
  const hiImg = clone.querySelector(".ac-char[data-hi]");
  if (hiImg && hiImg.dataset.hi) {
    // 4K подменяем, только когда догрузилась, — без мигания пустым полем.
    const pre = new Image();
    pre.onload = () => { hiImg.src = pre.src; };
    pre.src = hiImg.dataset.hi;
  }
  layer.innerHTML = "";
  layer.appendChild(clone);
  layer.hidden = false;
  card.classList.add("lifted");
  focused = { card, clone };
  const to = clone.getBoundingClientRect();
  const rot = getComputedStyle(card).getPropertyValue("--rot").trim() || "0deg";
  requestAnimationFrame(() => layer.classList.add("on"));
  if (!reduced()) {
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const s = from.width / to.width;
    clone.animate([
      { transform: `translate(${dx}px,${dy}px) scale(${s}) rotate(${rot})` },
      { transform: "none" },
    ], { duration: 520, easing: EASE_IN });
  }
  layer.onpointermove = (e) => { if (!reduced()) tiltTo(clone, e, 12); };
  layer.onclick = unfocus;
}

function unfocus() {
  if (!focused || !root) return;
  const { card, clone } = focused;
  const layer = root.querySelector(".ac-focus");
  focused = null;
  layer.onpointermove = null;
  layer.onclick = null;
  layer.classList.remove("on");
  const done = () => { layer.hidden = true; layer.innerHTML = ""; card.classList.remove("lifted"); };
  if (reduced()) { done(); return; }
  const from = clone.getBoundingClientRect();
  const to = card.querySelector(".ac-stamp").getBoundingClientRect();
  const rot = getComputedStyle(card).getPropertyValue("--rot").trim() || "0deg";
  resetTilt(clone);
  const a = clone.animate([
    { transform: "none" },
    { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px,${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(${to.width / from.width}) rotate(${rot})` },
  ], { duration: 360, easing: EASE_OUT, fill: "forwards" });
  a.onfinish = done;
}

// Плитка достижения в профиле → коллекция с этой карточкой в фокусе.
// Делегирование, чтобы не трогать разметку профиля.
document.addEventListener("click", (e) => {
  const tile = e.target.closest?.(".pf-badge");
  if (!tile || e.target.closest("button")) return;
  openAwardCollection(tile.getAttribute("title") || "");
});
