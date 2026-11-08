// Nyaa/игры, вынесено из games-space.js: чарты (как на SteamDB: онлайн, тренды, релизы, скоро, изменения цен).
import { apiGet, apiPost, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { sortWishlist, wishStatus, wishFilter, priceView, fmtNum, shortDate, deltaView, miniLine, groupByDate, untilText } from "./games-core.js";
import { sessionStatus, steamApi } from "./steam-session.js";
import { wishCategoryIndex } from "./steam-personal.js";
import { CHART_TABS, cardHtml, chartTab, deals, empty, errBox, me, picHtml, setTagList, setWishCats, skeleton, spCtx, tab, tagList, wishCat, wishCats, wishMode, wishQ, wishSort } from "./games-space.js";

// ---------- чарты (как на SteamDB: онлайн, тренды, релизы, скоро, изменения цен) ----------
const tableSkeleton = (n = 12) => `<div class="gm-tbl" style="--cols:36px 100px minmax(0,1fr) 120px 120px">${Array.from({ length: n }, () => `<div class="gm-tr sk"><span class="ny-sk w40"></span><span class="ny-sk blk2"></span><span class="ny-sk w80"></span><span class="ny-sk w60"></span><span class="ny-sk w60"></span></div>`).join("")}</div>`;
const trow = (g, cells, rank = "") => `<div class="gm-tr" data-app="${g.appid}" data-name="${esc(g.name)}"><span class="gm-rk">${rank}</span>${picHtml(g.appid, g.image, g.name, "gm-img gm-tth")}<span class="gm-tn">${esc(g.name)}</span>${cells}</div>`;
export const thead = labels => `<div class="gm-tr gm-th">${labels.map(l => `<span>${l}</span>`).join("")}</div>`;
export const priceCell = p => { const v = priceView(p); return `<span class="gm-tc gm-pr">${v.badge ? `<i class="gm-badge sm">${v.badge}</i>` : ""}<b class="${v.sale ? "sale" : ""}">${p ? esc(v.now) : "Бесплатно"}</b></span>`; };

async function chartOverview() {
  const [on, tr] = await Promise.all([apiGet("/games/charts/online"), apiGet("/games/charts/trending").catch(() => ({ items: [] }))]);
  const upd = $("#gm-upd"); if (upd) upd.textContent = `обновлено ${new Date(on.updated * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  const left = `<section class="gm-panel"><h3 class="gm-ph">Самые играемые<button type="button" class="gm-more-l" data-ctab="online">все →</button></h3><div class="gm-tbl sm" style="--cols:28px 76px minmax(0,1fr) 96px 96px">${thead(["#", "", "Игра", "Сейчас", "Пик за 24 ч"])}${on.items.slice(0, 15).map((g, i) => trow(g, `<span class="gm-tc gm-green">${fmtNum(g.now)}</span><span class="gm-tc">${fmtNum(g.peak)}</span>`, i + 1)).join("")}</div></section>`;
  const right = `<section class="gm-panel"><h3 class="gm-ph">В тренде<button type="button" class="gm-more-l" data-ctab="trending">все →</button></h3>${tr.items.length ? `<div class="gm-tbl sm" style="--cols:28px 76px minmax(0,1fr) 100px 90px">${thead(["#", "", "Игра", "7 дней", "Сейчас"])}${tr.items.slice(0, 15).map((g, i) => {
    const path = miniLine(g.spark);
    return trow(g, `<span class="gm-tc">${path ? `<svg class="gm-mini" viewBox="0 0 90 24"><path d="${path}"/></svg>` : `<small class="ny-hint">${esc(deltaView(g.delta, g.new).text)}</small>`}</span><span class="gm-tc gm-green">${fmtNum(g.now)}</span>`, i + 1);
  }).join("")}</div>` : empty("Пока нет данных", "Steam не вернул недельный рейтинг.")}</section>`;
  return `<div class="gm-two">${left}${right}</div>`;
}

async function chartOnline() {
  const r = await apiGet("/games/charts/online");
  const upd = $("#gm-upd"); if (upd) upd.textContent = `обновлено ${new Date(r.updated * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  return `<div class="gm-tbl" style="--cols:36px 100px minmax(0,1fr) 130px 130px">${thead(["#", "", "Игра", "Онлайн сейчас", "Пик за 24 ч"])}${r.items.map((g, i) => trow(g, `<span class="gm-tc gm-green">${fmtNum(g.now)}</span><span class="gm-tc">${fmtNum(g.peak)}</span>`, i + 1)).join("")}</div>`;
}

async function chartTrending() {
  const r = await apiGet("/games/charts/trending");
  if (!r.items.length) return empty("Пока нет данных", "Steam не вернул недельный рейтинг.");
  return `<p class="ny-hint gm-note">Рост места в недельном рейтинге по онлайну. Линия справа появится, когда мы накопим историю онлайна игры.</p><div class="gm-tbl" style="--cols:36px 100px minmax(0,1fr) 90px 110px 120px">${thead(["#", "", "Игра", "Рост", "7 дней", "Онлайн сейчас"])}${r.items.map((g, i) => {
    const d = deltaView(g.delta, g.new);
    const path = miniLine(g.spark);
    return trow(g, `<span class="gm-tc gm-d ${d.cls}">${d.text}</span><span class="gm-tc">${path ? `<svg class="gm-mini" viewBox="0 0 90 24"><path d="${path}"/></svg>` : ""}</span><span class="gm-tc gm-green">${fmtNum(g.now)}</span>`, i + 1);
  }).join("")}</div>`;
}

async function chartReleases() {
  const r = await apiGet("/games/charts/releases");
  const pop = r.popular.length ? `<div class="gm-tbl" style="--cols:100px minmax(0,1fr) 100px 120px">${thead(["", "Популярные релизы", "Онлайн", "Цена"])}${r.popular.map(g => trow(g, `<span class="gm-tc gm-green">${fmtNum(g.now)}</span>${priceCell(g.price)}`)).join("")}</div>` : empty("Нет данных", "");
  const hot = r.hot.length ? `<div class="gm-tbl" style="--cols:100px minmax(0,1fr) 90px 120px">${thead(["", "Горячие релизы", "Рейтинг", "Цена"])}${r.hot.map(g => trow(g, `<span class="gm-tc gm-green">${g.pct}%</span>${priceCell(g.price)}`)).join("")}</div>` : empty("Нет данных", "");
  return `<p class="ny-hint gm-note">Игры, вышедшие за последние 90 дней. Рейтинг — доля положительных отзывов (от 50 отзывов).</p><div class="gm-two">${pop}${hot}</div>`;
}

async function chartUpcoming() {
  const r = await apiGet("/games/charts/upcoming");
  const groups = groupByDate(r.items);
  if (!groups.length) return empty("Пусто", "Steam не вернул ближайшие релизы.");
  return groups.map(gr => `<section class="gm-sec"><h3>${gr.ts ? esc(shortDate(gr.ts)) : "Дата не объявлена"}${gr.ts ? `<small class="gm-until">${esc(untilText(gr.ts))}</small>` : ""}</h3><div class="gm-grid gm-grid-sm">${gr.items.map(g => `<button type="button" class="gm-card" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div>${g.label && !g.date ? `<div class="gm-pr"><small>${esc(g.label)}</small></div>` : ""}</button>`).join("")}</div></section>`).join("");
}

async function chartChanges() {
  const r = await apiGet("/games/charts/price-changes");
  if (!r.items.length) return empty("Пока нет изменений", "Мы фиксируем цену игр, которые вы открывали или добавили в желаемое. Когда цена изменится, она появится здесь.");
  return `<div class="gm-tbl gm-price-history">${thead(["#", "", "Игра", "Было", "Стало", "Когда"])}${r.items.map(g => {
    const down = g.now < g.was;
    const fallbackInitial = g.discount > 0 ? g.now * 100 / (100 - g.discount) : g.now;
    const current = priceView({
      final: g.now,
      initial: g.initial != null && Number.isFinite(Number(g.initial)) ? Number(g.initial) : fallbackInitial,
      discount: Number(g.discount) || 0,
      currency: g.currency,
    });
    const changeColor = down ? "gm-green" : "gm-red";
    return trow(g, `<span class="gm-tc ny-hint">${esc(priceView({ final: g.was, initial: g.was, discount: 0, currency: g.currency }).now)}</span><span class="gm-tc gm-price-history-current">${current.badge ? `<i class="gm-badge sm">${current.badge}</i>` : ""}<b class="${changeColor}">${esc(current.now)}</b>${current.old ? `<s>${esc(current.old)}</s>` : ""}</span><span class="gm-tc ny-hint">${esc(shortDate(g.ts))}</span>`);
  }).join("")}</div>`;
}

export async function paintCharts() {
  const body = $("#gm-body");
  const seg = CHART_TABS.map(([k, l]) => `<button type="button" class="${chartTab === k ? "on" : ""}" data-ctab="${k}">${l}</button>`).join("");
  body.innerHTML = `<div class="gm-bar"><div class="ny-seg">${seg}</div><span class="ny-sp"></span><span class="gm-count" id="gm-upd"></span></div><div id="gm-chart">${tableSkeleton()}</div>`;
  const my = chartTab;
  try {
    const html = await ({ overview: chartOverview, online: chartOnline, trending: chartTrending, releases: chartReleases, upcoming: chartUpcoming, changes: chartChanges }[chartTab])();
    const box = $("#gm-chart");
    if (tab === "charts" && my === chartTab && box) box.innerHTML = html;
  } catch (e) { const box = $("#gm-chart"); if (box) box.innerHTML = errBox(e); }
}

const DEALS_PAGE = 48;

function dealsBarHtml() {
  const d = deals;
  const chips = [[10, 24, "−10–24%"], [25, 49, "−25–49%"], [50, 74, "−50–74%"], [75, 89, "−75–89%"], [90, 99, "−90–99%"], [100, 100, "Бесплатно"]].map(([n, max, l]) => `<button type="button" class="${d.min === n ? "on" : ""}" data-dmin="${n}" data-dmax="${max}">${l}</button>`).join("");
  const rev = [[0, "Любые отзывы"], [70, "от 70%"], [85, "от 85%"], [95, "от 95%"]].map(([n, l]) => `<option value="${n}"${d.minpct === n ? " selected" : ""}>${l}</option>`).join("");
  const sorts = [["discount", "по скидке"], ["price", "дешевле сначала"], ["price_desc", "дороже сначала"], ["reviews", "по отзывам"], ["popular", "популярные"], ["name", "по названию"]].map(([k, l]) => `<option value="${k}"${d.sort === k ? " selected" : ""}>${l}</option>`).join("");
  const tags = `<option value="0">Любой жанр</option>` + (tagList || []).map(t => `<option value="${t.id}"${d.tag === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  return `<div class="gm-bar gm-dbar"><div class="ny-seg">${chips}</div><span class="ny-sp"></span>
    <input id="gm-dq" class="gm-lf" type="text" placeholder="Поиск среди скидок" value="${esc(d.q)}" spellcheck="false">
    <input id="gm-dmax" class="gm-lf gm-num" type="number" min="0" step="1" placeholder="Цена до" value="${d.maxprice || ""}">
    <select id="gm-drev" title="Доля положительных отзывов">${rev}</select><select id="gm-dtag">${tags}</select><select id="gm-dsort">${sorts}</select></div>`;
}

function dealsResultHtml() {
  const d = deals;
  if (!d.items.length) return empty("Ничего не найдено", "Ослабьте фильтры: снимите порог цены или отзывов.");
  return `<p class="gm-dcount">Найдено ${fmtNum(d.total)} из ${fmtNum(d.all)} игр со скидкой</p><div class="gm-grid">${d.items.map(g => cardHtml(g)).join("")}</div>`
    + (d.items.length < d.total ? `<div class="gm-moreb"><button type="button" class="btn" data-dmore>Показать ещё ${Math.min(DEALS_PAGE, d.total - d.items.length)}</button></div>` : "");
}

async function loadDeals(more = false) {
  const d = deals, my = ++d.seq;
  const r = await apiGet("/games/deals", { min: d.min, max: d.max, maxprice: d.maxprice || "", minpct: d.minpct || "", sort: d.sort, tag: d.tag || "", q: d.q, start: more ? d.items.length : 0, limit: DEALS_PAGE });
  if (my !== d.seq) return false;
  d.items = more ? d.items.concat(r.items) : r.items;
  d.total = r.total; d.all = r.all;
  return true;
}

export async function refreshDeals(more = false) {
  const box = $("#gm-dres");
  if (!box) return;
  if (!more) box.innerHTML = skeleton(12);
  try {
    if (!(await loadDeals(more)) || tab !== "deals") return;
    const cur = $("#gm-dres");
    if (cur) cur.innerHTML = dealsResultHtml();
  } catch (e) { const cur = $("#gm-dres"); if (cur) cur.innerHTML = errBox(e); }
}

export async function paintDeals() {
  const body = $("#gm-body");
  if (!tagList) { try { setTagList( (await apiGet("/games/tags")).items || []); } catch (_) { setTagList( []); } }
  if (tab !== "deals") return;
  body.innerHTML = dealsBarHtml() + `<div id="gm-dres"></div>`;
  refreshDeals();
}

export let wishData = null;

function wishRowHtml(w) {
  const st = wishStatus(w);
  const cur = (w.price && w.price.currency) || "";
  const v = priceView(w.price);
  const priceHtml = w.price && w.price.final > 0
    ? `<div class="gm-wp">${v.badge ? `<i class="gm-badge sm">${v.badge}</i>` : ""}${v.old ? `<s>${esc(v.old)}</s>` : ""}<b class="${v.sale ? "sale" : ""}">${esc(v.now)}</b></div>`
    : `<div class="gm-wp none"><b>—</b></div>`;
  return `<div class="gm-wcard${w.hit ? " hit" : ""}" data-app="${w.appid}" data-name="${esc(w.name)}">
    ${picHtml(w.appid, w.image, w.name, "gm-img gm-wimg")}
    <div class="gm-wbody">
      <div class="gm-wtop"><b class="gm-wname">${esc(w.name)}</b><button type="button" class="ny-ib" data-wish-del="${w.appid}" title="Убрать из желаемого" aria-label="Убрать из желаемого"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="gm-wmid"><span class="gm-st ${st.kind}">${esc(st.text)}</span>${w.lowest ? `<small class="ny-hint">минимум ${esc(priceView({ final: w.lowest, initial: w.lowest, discount: 0, currency: cur }).now)}</small>` : ""}${w.pct && w.reviews >= 50 ? `<small class="ny-hint">👍 ${w.pct}%</small>` : ""}${priceHtml}</div>
      <div class="gm-wctl"><label>Следить: цена до<input type="number" class="gm-wt" min="0" step="0.01" value="${w.target != null ? w.target : ""}" placeholder="${esc(cur || "—")}" data-w="${w.appid}"></label><label>или скидка от<input type="number" class="gm-wd" min="1" max="95" step="1" value="${w.target_discount != null ? w.target_discount : ""}" placeholder="%" data-w="${w.appid}"></label></div>
    </div></div>`;
}

export function wishListHtml() {
  const r = wishData;
  let list = sortWishlist(wishFilter(r.items, wishMode, wishQ), wishSort);
  if (wishCat && wishCats) list = list.filter(w => { const s = wishCats.map.get(w.appid); return s && s.has(wishCat); });
  return list.length ? `<div class="gm-wgrid">${list.map(wishRowHtml).join("")}</div>` : empty("Ничего не найдено", "Смените фильтр или очистите поиск.");
}

export function wishBarHtml() {
  const r = wishData;
  const now = Date.now() / 1000;
  const cnt = m => wishFilter(r.items, m, "", now).length;
  const modes = [["all", "Все"], ["sale", "Со скидкой"], ["hit", "Цель достигнута"], ["soon", "Не вышли"], ["noprice", "Без цены"]].map(([k, l]) => `<button type="button" class="${wishMode === k ? "on" : ""}" data-wmode="${k}">${l} <small>${cnt(k)}</small></button>`).join("");
  const sorts = [["close", "ближе к цели"], ["discount", "по скидке"], ["name", "по названию"]].map(([k, l]) => `<option value="${k}"${wishSort === k ? " selected" : ""}>${l}</option>`).join("");
  const syncErr = r.sync && r.sync.error;
  return `<div class="gm-bar"><span class="gm-count">${r.items.length} в списке</span>${r.steam ? `<span class="gm-sync" title="Желаемое из Steam подтягивается автоматически раз в 30 минут">⟳ синхронизируется со Steam</span><button type="button" class="btn sm" data-wl-steam>Обновить</button>` : ""}${syncErr ? `<span class="ny-hint">${esc(syncErr)}</span>` : ""}<span class="ny-sp"></span>
    <input id="gm-wq" class="gm-lf" type="text" placeholder="Поиск по списку" value="${esc(wishQ)}" spellcheck="false"><label class="gm-sort">Сортировка <select id="gm-wsort">${sorts}</select></label></div>
    <div class="gm-bar gm-wmodes"><div class="ny-seg">${modes}</div></div>${wishCatsHtml()}`;
}

// Категории желаемого из Steam (только при входе): названия — из GetWishlistCategories, принадлежность игр — из GetWishlistSortedFiltered.
function wishCatsHtml() {
  if (!wishCats || !wishCats.cats.length) return "";
  const chips = [["", "Все категории"], ...wishCats.cats.map(c => [c.id, c.name])].map(([id, l]) => `<button type="button" class="${wishCat === id ? "on" : ""}" data-wcat="${esc(id)}">${esc(l)}</button>`).join("");
  return `<div class="gm-bar gm-wmodes"><div class="ny-seg">${chips}</div></div>`;
}

async function loadWishCats() {
  setWishCats( null);
  let st = null;
  try { st = await sessionStatus(); } catch (_) { return; }
  if (!st || !st.signed_in || !me || !me.steamid) return;
  const call = (i, m, p) => steamApi(i, m, p).then(r => (r.status === 200 ? r.body : null)).catch(() => null);
  const [c, l] = await Promise.all([
    call("IWishlistService", "GetWishlistCategories", {}),
    call("IWishlistService", "GetWishlistSortedFiltered", { steamid: me.steamid, context: spCtx((me && me.cc) || "US"), data_request: {}, sort_order: 0, start_index: 0, page_size: 500 }),
  ]);
  setWishCats( wishCategoryIndex(c, l));
  if (tab === "wish" && $("#gm-wbar")) $("#gm-wbar").innerHTML = wishBarHtml();
}

export async function paintWish() {
  const body = $("#gm-body");
  body.innerHTML = skeleton(6);
  try {
    const r = await apiGet("/games/wishlist");
    if (tab !== "wish") return;
    wishData = r;
    const syncErr = r.sync && r.sync.error;
    if (!r.items.length) {
      body.innerHTML = r.steam
        ? empty(syncErr ? "Не получилось прочитать желаемое из Steam" : "В желаемом пока ничего нет", syncErr || "Добавьте игру в желаемое в Steam — она появится здесь сама, и мы начнём следить за ценой. Также можно открыть любую игру и нажать «В желаемое».", `<button type="button" class="btn primary" data-wl-steam>Синхронизировать сейчас</button>`)
        : empty("Список желаемого пуст", "Привяжите Steam — желаемое подтянется само. Или откройте игру и нажмите «В желаемое», чтобы следить за ценой.", `<button type="button" class="btn primary" data-gadd>Привязать Steam</button>`);
      return;
    }
    body.innerHTML = `<div id="gm-wbar">${wishBarHtml()}</div><div id="gm-wlist">${wishListHtml()}</div>`;
    loadWishCats();
  } catch (e) { body.innerHTML = errBox(e); }
}

// Быстрая цель прямо в карточке желаемого: сохраняется при выходе из поля.
export async function saveWishTarget(card) {
  const appid = Number(card.dataset.app);
  const t = card.querySelector(".gm-wt").value, d = card.querySelector(".gm-wd").value;
  try {
    await apiPost("/games/wishlist", { appid, name: card.dataset.name, target: t || null, target_discount: d || null });
    const w = wishData && wishData.items.find(x => x.appid === appid);
    if (w) { w.target = t ? Number(t) : null; w.target_discount = d ? Number(d) : null; w.hit = !!(w.price && ((w.target && w.price.final <= w.target) || (w.target_discount && w.price.discount >= w.target_discount))); }
    toast("Цель сохранена: сообщим, когда цена дойдёт.", "success");
  } catch (e) { toast(e.message || "Не удалось сохранить.", "error"); }
}

