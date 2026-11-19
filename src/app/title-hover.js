
import { apiGet, mediaUrl } from "./api.js";
import { esc } from "./utils.js";

const HOVER_DELAY_MS = 320;
const HIDE_DELAY_MS = 120;
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

let popoverEl = null;
let showTimer = null;
let hideTimer = null;
let currentId = null;

function imgProxy(url) {
  return url ? mediaUrl("/img_proxy", { url }) : "";
}

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement("div");
  popoverEl.className = "title-popover";
  popoverEl.hidden = true;
  document.body.appendChild(popoverEl);
  popoverEl.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  popoverEl.addEventListener("mouseleave", scheduleHide);
  return popoverEl;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (popoverEl) popoverEl.classList.remove("shown");
    currentId = null;
  }, HIDE_DELAY_MS);
}

function renderPopover(anchor, d) {
  const det = d.details && !Array.isArray(d.details) ? d.details : null;
  const poster = imgProxy(d.poster_url);
  const epLine = det && det.episodes_total
    ? (det.episodes_aired != null ? `${det.episodes_aired} из ${det.episodes_total} эп.` : `${det.episodes_total} эп.`)
    : "";
  const statusLine = det ? [det.kind_label, det.status_label].filter(Boolean).join(", ") : "";

  const pop = ensurePopover();
  pop.innerHTML = `
    ${poster ? `<img class="tp-poster" src="${poster}" alt="">` : `<div class="tp-poster tp-poster-ph">🎬</div>`}
    <div class="tp-body">
      <div class="tp-name">${esc(d.name)}</div>
      ${epLine ? `<div class="tp-line">${esc(epLine)}</div>` : ""}
      ${statusLine ? `<div class="tp-line tp-dim">${esc(statusLine)}</div>` : ""}
    </div>
  `;
  pop.hidden = false;
  pop.classList.remove("shown");
  const rect = anchorBox(anchor);
  const popRect = pop.getBoundingClientRect();
  let left = rect.right + 12;
  let side = "right";
  if (left + popRect.width > window.innerWidth - 8) { left = rect.left - popRect.width - 12; side = "left"; }
  if (left < 8) left = 8;
  let top = rect.top + rect.height / 2 - popRect.height / 2;
  top = Math.min(Math.max(8, top), window.innerHeight - popRect.height - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.dataset.side = side;
  requestAnimationFrame(() => pop.classList.add("shown"));
}

function anchorBox(anchor) {
  const candidates = [anchor.querySelector(".tt-title, .vote-hero-poster"), anchor, ...anchor.children];
  for (const el of candidates) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  return anchor.getBoundingClientRect();
}

async function loadAndShow(anchor, titleId) {
  const hit = cache.get(titleId);
  let data = hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.data : null;
  if (!data) {
    try {
      data = await apiGet(`/public/titles/${titleId}`);
      cache.set(titleId, { at: Date.now(), data });
    } catch (_) {
      return;
    }
  }
  if (currentId !== titleId) return;
  if (!anchor.isConnected) return;
  renderPopover(anchor, data);
}

export function clearTitleHoverCache() {
  cache.clear();
}

document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-open-title-detail]");
  if (!el) return;
  if (el.closest(".vote-card")) return;
  const titleId = el.dataset.openTitleDetail;
  if (!titleId) return;
  clearTimeout(hideTimer);
  if (currentId === titleId) return;
  clearTimeout(showTimer);
  currentId = titleId;
  showTimer = setTimeout(() => {
    if (currentId === titleId) loadAndShow(el, titleId);
  }, HOVER_DELAY_MS);
});

document.addEventListener("mouseout", e => {
  if (!e.target.closest("[data-open-title-detail]")) return;
  clearTimeout(showTimer);
  scheduleHide();
});
