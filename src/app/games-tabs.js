// Блок вкладок витрины, как на главной Steam: слева список игр, справа панель с отзывами, метками и скриншотами выбранной игры.
// Чистая разметка без сети: данные приходят с /games/store/tabs.

import { priceView, fmtNum } from "./games-core.js";

export const STABS = [["new", "Популярные новинки"], ["top", "Лидеры продаж"], ["soon", "Популярные будущие новинки"], ["spec", "Скидки"], ["free", "Популярные бесплатные игры"]];
export const STAB_SHOWN = 10;

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Цветовой класс итога отзывов: положительные синие, смешанные жёлтые, отрицательные красные. */
export function reviewTone(pct, count) {
  if (!count) return "none";
  return pct >= 70 ? "pos" : pct >= 40 ? "mix" : "neg";
}

/** Правая часть строки: скидка, старая и новая цена либо «Бесплатно». Для ещё не вышедших без цены ничего не показываем. */
export function rowPriceHtml(it) {
  if (it.free) return `<span class="gm-st-pr"><b>Бесплатно</b></span>`;
  if (!it.price) return "";
  const v = priceView(it.price);
  return `<span class="gm-st-pr">${v.sale ? `<i class="gm-st-disc">${esc(v.badge)}</i><s>${esc(v.old)}</s>` : ""}<b>${esc(v.now)}</b></span>`;
}

export function rowsHtml(items, sel, pic) {
  return items.map((it, i) => `<button type="button" class="gm-sr${i === sel ? " on" : ""}${it.owned ? " own" : ""}" data-trow="${i}" data-app="${it.appid}" data-name="${esc(it.name)}">
    ${pic(it.appid, it.cap, it.name, "gm-img gm-st-img")}
    <span class="gm-st-body"><b>${esc(it.name)}</b><small class="gm-st-tags">${esc((it.tags || []).slice(0, 4).join(", "))}</small><small class="gm-st-when">${esc(it.when || "")}</small></span>
    ${rowPriceHtml(it)}
  </button>`).join("");
}

export function panelHtml(it, img) {
  if (!it) return "";
  const tone = reviewTone(it.pct, it.reviews);
  const rev = tone === "none"
    ? `<span class="gm-tp-rv none">Нет обзоров</span>`
    : `<span class="gm-tp-rv ${tone}">${esc(it.label || "")}</span> <small>(${fmtNum(it.reviews)})</small>`;
  return `<h4>${esc(it.name)}</h4>
    <div class="gm-tp-r"><small>Все обзоры пользователей</small><div>${rev}</div></div>
    <div class="gm-tp-tags">${(it.tags || []).slice(0, 5).map(t => `<i>${esc(t)}</i>`).join("")}</div>
    <div class="gm-tp-shots">${(it.shots || []).slice(0, 3).map(u => `<img loading="lazy" src="${esc(img(u))}" alt="">`).join("")}</div>`;
}

export function tabsHtml(state, items, pic, img) {
  const head = STABS.map(([k, t]) => `<button type="button" data-stab="${k}" class="${state.tab === k ? "on" : ""}">${t}</button>`).join("");
  const opts = state.tab === "top"
    ? `<div class="gm-stabs-opt"><label><input type="checkbox" data-sopt="free"${state.free ? " checked" : ""}> Включать бесплатные продукты</label><label><input type="checkbox" data-sopt="owned"${state.owned ? " checked" : ""}> Включать продукты из моей библиотеки</label></div>`
    : "";
  const shown = state.more ? items : items.slice(0, STAB_SHOWN);
  const sel = Math.min(state.sel || 0, Math.max(shown.length - 1, 0));
  const body = shown.length
    ? `<div class="gm-stabs-grid"><div class="gm-stabs-list" data-slist>${rowsHtml(shown, sel, pic)}</div><aside class="gm-tp" data-spanel>${panelHtml(shown[sel], img)}</aside></div>
       ${items.length > STAB_SHOWN ? `<div class="gm-stabs-more"><button type="button" class="btn sm" data-smore>${state.more ? "Свернуть" : `Показать ещё ${items.length - STAB_SHOWN}`}</button></div>` : ""}`
    : `<div class="gm-stabs-empty">Здесь пока ничего нет.</div>`;
  return `<div class="gm-stabs-h">${head}</div>${opts}${body}`;
}
