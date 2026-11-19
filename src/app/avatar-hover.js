
import { apiGet } from "./api.js";
import { esc } from "./utils.js";

const HOVER_DELAY_MS = 320;
const HIDE_DELAY_MS = 120;
const cache = new Map();

let popoverEl = null;
let showTimer = null;
let hideTimer = null;
let currentId = null;

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement("div");
  popoverEl.className = "avatar-popover";
  popoverEl.hidden = true;
  document.body.appendChild(popoverEl);
  popoverEl.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  popoverEl.addEventListener("mouseleave", scheduleHide);
  return popoverEl;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (popoverEl) popoverEl.hidden = true;
    currentId = null;
  }, HIDE_DELAY_MS);
}

function renderPopover(anchor, d) {
  const pop = ensurePopover();
  pop.innerHTML = `
    <div class="ap-name">${esc(d.display_name || d.name)}${d.is_online ? ' <span class="ap-online" title="в сети"></span>' : ""}</div>
    <div class="ap-role">${esc(d.role || "без роли")}</div>
    <div class="ap-stat">${d.assigned ?? 0} на руках · ${d.completed_total ?? 0} закрыто${d.overdue ? ` · <span class="ap-warn">${d.overdue} просрочено</span>` : ""}</div>
  `;
  pop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

async function loadAndShow(anchor, telegramId) {
  let data = cache.get(telegramId);
  if (!data) {
    try {
      data = await apiGet(`/user/${telegramId}`);
      cache.set(telegramId, data);
    } catch (_) {
      return;
    }
  }
  if (currentId !== telegramId) return;
  if (!anchor.isConnected) return;
  renderPopover(anchor, data);
}

document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-avatar-for]");
  if (!el || el.classList.contains("xl") || !el.dataset.avatarFor) return;
  if (el.closest(".tb-menu-wrap")?.querySelector(".tb-menu:not([hidden])")) return;
  clearTimeout(hideTimer);
  if (currentId === el.dataset.avatarFor) return;
  clearTimeout(showTimer);
  currentId = el.dataset.avatarFor;
  const telegramId = el.dataset.avatarFor;
  showTimer = setTimeout(() => {
    if (currentId === telegramId) loadAndShow(el, telegramId);
  }, HOVER_DELAY_MS);
});

document.addEventListener("mouseout", e => {
  if (!e.target.closest("[data-avatar-for]")) return;
  clearTimeout(showTimer);
  scheduleHide();
});

document.addEventListener("pointerdown", () => {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (popoverEl) popoverEl.hidden = true;
  currentId = null;
}, true);
