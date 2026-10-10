// Уведомления игр и подписки «Следить»: разметка списка уведомлений и блока подписки на странице игры.
// Чистые функции без DOM и сети — проверяются в scripts/games-test.mjs.

import { alertText, shortDate } from "./games-core.js";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const ALERT_ICON = { target: "🎯", sale: "🔥", low: "📉", update: "🛠", release: "🚀" };

/** Сколько уведомлений новее отметки «последний раз открывали» (секунды). */
export function unreadCount(items, lastOpen) {
  return (items || []).filter(a => a && a.ts > (Number(lastOpen) || 0)).length;
}

/** Блок «Следить» на странице игры. st — запись подписки или null; inWishlist — игра в желаемом (тогда всё следится само). */
export function watchBoxHtml(appid, st, { released = true, inWishlist = false } = {}) {
  const upd = inWishlist || !!(st && st.updates);
  const rel = inWishlist || !!(st && st.release);
  const dis = inWishlist ? " disabled" : "";
  return `<div class="gm-watch" data-watch-app="${Number(appid)}">
    <b>Следить</b>
    <label><input type="checkbox" data-w-upd${upd ? " checked" : ""}${dis}> Обновления игры</label>
    ${released ? "" : `<label><input type="checkbox" data-w-rel${rel ? " checked" : ""}${dis}> Выход игры</label>`}
    <small class="ny-hint">${inWishlist ? "Игра в желаемом: цена, обновления и выход отслеживаются сами." : "Цену отслеживает «В желаемое» с целью. Сообщим внутри программы, в «Уведомлениях»."}</small>
  </div>`;
}

/** Список уведомлений и подписок для окна «Уведомления игр». */
export function notifPanelHtml({ alerts = [], watch = [] } = {}, lastOpen = 0, proxy = u => u) {
  const cover = (url, cls) => (url ? `<img class="${cls}" src="${esc(proxy(url))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "");
  const rows = alerts.slice(0, 40).map(a => {
    const t = alertText(a);
    const fresh = a.ts > (Number(lastOpen) || 0);
    return `<button type="button" class="gm-nt${fresh ? " fresh" : ""}" data-app="${Number(a.appid)}" data-name="${esc(a.name || "")}">
      <span class="gm-nc">${cover(a.image, "gm-nimg")}<i>${ALERT_ICON[a.kind] || "•"}</i></span><span><b>${esc(t.title)}</b><small>${esc(t.body)} · ${esc(shortDate(a.ts))}</small></span></button>`;
  }).join("");
  const w = watch.map(x => `<div class="gm-nw">${cover(x.image, "gm-nimg")}<span data-app="${Number(x.appid)}" data-name="${esc(x.name || "")}"><b>${esc(x.name || `app ${x.appid}`)}</b><small class="ny-hint">${[x.updates ? "обновления" : "", x.release ? "выход" : ""].filter(Boolean).join(" · ")}</small></span><button type="button" class="ny-ib" data-watch-del="${Number(x.appid)}" title="Не следить" aria-label="Не следить"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("");
  return `<h2>Уведомления игр</h2>
    <div class="gm-nlist">${rows || `<div class="gm-empty"><b>Пока ничего нового</b><p>Сообщим о скидках и цели из «Желаемого», об обновлениях и выходе игр, за которыми вы следите.</p></div>`}</div>
    <h3 class="gm-h3">Слежу за играми</h3>
    <div class="gm-nlist">${w || `<small class="ny-hint">Откройте игру и отметьте «Следить», чтобы узнавать об обновлениях и выходе. Игры из «Желаемого» отслеживаются сами.</small>`}</div>
    <div class="gm-d-act"><button type="button" class="btn" data-d-close>Закрыть</button></div>`;
}
