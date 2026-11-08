// Nyaa/игры, вынесено из games-space.js: карточка игры.
import { apiGet, apiPost, apiDelete, toast, dismissSheet, dialogSkeletonHtml } from "./api.js";
import { openExternal } from "./tauri.js";
import { $, esc } from "./utils.js";
import { badgesOf, achSummary, statLabel, friendState, xpProgress, reviewSummary, seriesChart, pointAt, fmtCompact, priceView, fmtHours, isSteamLaunchUrl, initials2, fmtNum, shortDate, pctText } from "./games-core.js";
import { mountGallery } from "./games-media.js";
import { detailPageHtml, detailPriceHtml, detailMediaIndex, mountDetailNavigation, selectDetailView, requirementsHtml, languagesHtml, depotsHtml, reviewCardsHtml } from "./games-detail.js";
import { buildHtml, fmtBytes, lowestText } from "./games-build.js";
import { empty, errBox, gmSheet, img, lib, loadWatchBox, me, paintSession, paintWho, picHtml, setLib, setMe, skeleton, tab } from "./games-space.js";
import { paintWish, priceCell } from "./games-charts.js";

// ---------- карточка игры ----------
const priceBoxHtml = detailPriceHtml;

// Рейтинг в рамке «отзывы»: общий для первой загрузки и для обновления.
function paintRate(ov, r) {
  const sm = reviewSummary(r), rate = ov.querySelector("#gm-rate");
  if (rate && sm) { rate.className = `gm-box ${sm.pct >= 70 ? "ok" : sm.pct >= 40 ? "mid" : "bad"}`; rate.innerHTML = `<b>${sm.pct}%</b><small>${fmtNum(r.total)} отзывов</small>`; }
  return sm;
}

// Открытая страница игры живёт: раз в минуту обновляются цена, «исторический минимум», история цены, раз в пять минут — рейтинг.
async function refreshDetail(ov, appid, withRating) {
  try {
    const d = await apiGet(`/games/app/${appid}`);
    if (!ov.isConnected) return;
    ov.__d = { ...(ov.__d || {}), ...d };
    const box = ov.querySelector(".gm-box.pr");
    if (box) box.outerHTML = priceBoxHtml(ov.__d);
    const act = ov.querySelector("[data-prange].on");
    paintPriceStats(ov);
    paintPriceChart(ov, act ? Number(act.dataset.prange) : 0);
    paintPriceList(ov);
  } catch (_) { /* следующая попытка через минуту */ }
  if (!withRating || !ov.isConnected) return;
  try { const r = await apiGet(`/games/app/${appid}/reviews`); if (ov.isConnected) paintRate(ov, r); } catch (_) { /* рейтинг обновится позже */ }
}

export async function openDetail(appid, name) {
  const previousFocus = document.activeElement;
  const ov = gmSheet(dialogSkeletonHtml(7), "wide");
  ov.classList.add("gm-ov", "gm-detail-v5");
  ov.addEventListener("click", e => { if (e.target.closest("[data-d-close]")) dismissSheet(ov); });
  try {
    const d = await apiGet(`/games/app/${appid}`);
    if (!ov.isConnected) return;
    ov.__d = d;
    ov.querySelector(".sheet").innerHTML = detailPageHtml(d, { appid, owned: !!(lib && lib.ids.has(appid)), hasSteam: !!(me && me.steamid), image: img, picture: picHtml });
  } catch (e) {
    if (!ov.isConnected) return;
    ov.querySelector(".sheet").innerHTML = `${errBox(e)}<div class="gm-d-act"><button type="button" class="btn" data-d-close>Закрыть</button></div>`;
    return;
  }
  const stopGal = mountGallery(ov, ov.__d, img, { initialIndex: detailMediaIndex(ov.__d) });
  const stopNavigation = mountDetailNavigation(ov, previousFocus);
  ov.addEventListener("sheet-dismissed", () => { stopGal(); stopNavigation(); clearInterval(ov.__ot); }, { once: true });
  ov.addEventListener("gm-gal-web", () => openExternal(ov.__d.store));
  paintPriceStats(ov);
  paintPriceChart(ov, 0);
  paintPriceList(ov);
  loadOnline(ov, appid, "48h");
  ov.__tick = 0;
  ov.__ot = setInterval(() => { // DevSkim: ignore DS172411 — функция, не строка
    if (!ov.isConnected) { clearInterval(ov.__ot); return; }
    loadOnline(ov, appid, ov.__orange || "48h", true);
    refreshDetail(ov, appid, ++ov.__tick % 5 === 0);
  }, 60000);
  loadExtra(ov, appid);
  loadMonthly(ov, appid);
  loadBuild(ov, appid);
  loadTechnicalSections(ov, appid);
  loadWatchBox(ov, appid);
  loadMore(ov, appid, "reviews");
  ov.addEventListener("click", async e => {
    const t = e.target;
    const sectionNav = t.closest("[data-d-section]");
    if (sectionNav) {
      const key = sectionNav.dataset.dSection;
      if (key === "patches") await loadMore(ov, appid, "patch");
      if (key === "achievements") await loadMore(ov, appid, "ach");
      selectDetailView(ov, key);
      return;
    }
    const relatedApp = t.closest("[data-related-app]");
    if (relatedApp) { const nextId = Number(relatedApp.dataset.relatedApp); const nextName = relatedApp.dataset.name || ""; dismissSheet(ov); openDetail(nextId, nextName); return; }
    const lb = t.closest("[data-launch]");
    if (lb) { e.stopPropagation(); launch(Number(lb.dataset.launch), lb); return; }
    const mb = t.closest("[data-more]");
    if (mb) { loadMore(ov, appid, mb.dataset.more); return; }
    const nm = t.closest("[data-newsmore]");
    if (nm) { loadMoreNews(ov, appid, nm); return; }
    if (t.closest("[data-d-close]")) return;
    const cp = t.closest("[data-copy]");
    if (cp) { navigator.clipboard.writeText(cp.dataset.copy).then(() => toast("Скопировано.", "success")).catch(() => {}); return; }
    const rb = t.closest("[data-regions]");
    if (rb) { loadRegions(ov, appid); return; }
    const rh = t.closest("[data-rhistory]");
    if (rh) { loadRegionHistory(ov, appid, rh.dataset.rhistory, rh.dataset.rname || ""); return; }
    const pr = t.closest("[data-prange]");
    if (pr) { paintPriceChart(ov, Number(pr.dataset.prange)); return; }
    const rg = t.closest("[data-orange]");
    if (rg) { loadOnline(ov, appid, rg.dataset.orange); return; }
    const st = t.closest("[data-d-store]");
    if (st) { openExternal(st.dataset.dStore).catch(() => toast("Не удалось открыть ссылку.", "error")); return; }
    const saveTarget = t.closest("[data-save-target]");
    if (saveTarget) {
      const target = ov.querySelector("#gm-target"), discount = ov.querySelector("#gm-tdisc");
      if (!target.reportValidity() || !discount.reportValidity()) return;
      saveTarget.disabled = true;
      try {
        await apiPost("/games/wishlist", { appid, name: ov.__d.name || name, target: target.value || null, target_discount: discount.value || null });
        ov.__d.wishlisted = true;
        ov.__d.target = target.value ? Number(target.value) : null;
        ov.__d.target_discount = discount.value ? Number(discount.value) : null;
        const wish = ov.querySelector("[data-d-wish]");
        wish.dataset.on = "1"; wish.textContent = "♥ В желаемом"; wish.setAttribute("aria-pressed", "true");
        loadWatchBox(ov, appid);
        toast("Цель сохранена. Игра в желаемом.", "success");
      } catch (err) { toast(err.message, "error"); }
      finally { if (saveTarget.isConnected) saveTarget.disabled = false; }
      return;
    }
    const w = t.closest("[data-d-wish]");
    if (w) {
      if (w.disabled) return;
      w.disabled = true;
      try {
        if (w.dataset.on === "1") { await apiDelete(`/games/wishlist/${appid}`); w.dataset.on = "0"; w.textContent = "♡ В желаемое"; toast("Убрано из желаемого.", "success"); }
        else { await apiPost("/games/wishlist", { appid, name: w.dataset.name || name, target: (ov.querySelector("#gm-target") || {}).value || null, target_discount: (ov.querySelector("#gm-tdisc") || {}).value || null }); w.dataset.on = "1"; w.textContent = "♥ В желаемом"; toast("Добавлено в желаемое.", "success"); }
        ov.__d.wishlisted = w.dataset.on === "1";
        w.setAttribute("aria-pressed", String(ov.__d.wishlisted));
        loadWatchBox(ov, appid);
        if (tab === "wish") paintWish();
      } catch (err) { toast(err.message, "error"); }
      finally { if (w.isConnected) w.disabled = false; }
    }
  });
}


const pad2 = n => String(n).padStart(2, "0");
const fmtDM = ts => { const d = new Date(ts * 1000); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`; };
const fmtHM = ts => { const d = new Date(ts * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDMHM = ts => `${fmtDM(ts)} ${fmtHM(ts)}`;

// SVG с осями, сеткой, зонами скидок, линией и слоем наведения; подсказку рисует attachHover.
function chartSvg(g, kind, fmtTick, fmtX) {
  return `<svg viewBox="0 0 ${g.w} ${g.h}" class="gm-svg ${kind}" preserveAspectRatio="xMidYMid meet" role="img">
    ${g.yTicks.map(t => `<line class="gl" x1="${g.plot.l}" x2="${g.plot.r}" y1="${t.y}" y2="${t.y}"/><text class="yl" x="${g.plot.l - 8}" y="${t.y + 4}" text-anchor="end">${esc(fmtTick(t.v))}</text>`).join("")}
    ${g.zones.map(z => `<rect class="z" x="${z.x}" y="${g.plot.t}" width="${z.w}" height="${g.plot.b - g.plot.t}"/>`).join("")}
    <path class="a" d="${g.area}"/><path class="l" d="${g.line}"/>
    ${g.pts.length === 1 ? `<circle class="one" cx="${g.pts[0].x}" cy="${g.pts[0].y}" r="5"/>` : ""}
    ${g.xTicks.map((t, i) => `<text class="xl" x="${t.x}" y="${g.h - 6}" text-anchor="${i === 0 ? "start" : i === 3 ? "end" : "middle"}">${esc(fmtX(t.ts))}</text>`).join("")}
    <line class="cross" x1="0" x2="0" y1="${g.plot.t}" y2="${g.plot.b}" hidden/><circle class="dot" r="4.5" cx="0" cy="0" hidden/>
  </svg><div class="gm-tip" hidden></div>`;
}

function attachHover(box, g, step, fmtTip) {
  const svg = box.querySelector("svg"), tip = box.querySelector(".gm-tip");
  if (!svg || !tip) return;
  const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
  const hide = () => { tip.hidden = true; cross.setAttribute("hidden", ""); dot.setAttribute("hidden", ""); };
  svg.addEventListener("mousemove", e => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * g.w;
    if (px < g.plot.l || px > g.plot.r) { hide(); return; }
    const p = pointAt(g.pts, px, step);
    if (!p) { hide(); return; }
    const cx = step ? px : p.x;
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); dot.setAttribute("cx", step ? Math.max(p.x, Math.min(px, g.plot.r)) : p.x); dot.setAttribute("cy", p.y);
    cross.removeAttribute("hidden"); dot.removeAttribute("hidden");
    const ts = g.t0 + ((cx - g.plot.l) / (g.plot.r - g.plot.l)) * (g.t1 - g.t0);
    tip.innerHTML = fmtTip(p, ts);
    tip.hidden = false;
    const left = (cx / g.w) * r.width;
    tip.style.left = `${Math.min(Math.max(left, 74), r.width - 74)}px`;
  });
  svg.addEventListener("mouseleave", hide);
}

function paintPriceStats(ov) {
  const d = ov.__d, el = ov.querySelector("#gm-pstats");
  if (!el) return;
  const h = (d.history || []).slice().sort((a, b) => a.ts - b.ts);
  const cur = d.price && d.price.currency;
  const m = n => priceView({ final: n, initial: n, discount: 0, currency: cur }).now;
  if (!h.length) { el.innerHTML = `<span class="ny-hint">Наблюдаем с сегодня</span>`; return; }
  const prices = h.map(p => p.price), lo = Math.min(...prices), hi = Math.max(...prices);
  const now = Date.now() / 1000;
  let avg = 0, span = 0;
  h.forEach((p, i) => { const dt = (i + 1 < h.length ? h[i + 1].ts : now) - p.ts; avg += p.price * dt; span += dt; });
  avg = span > 0 ? avg / span : h[h.length - 1].price;
  const loAt = h.find(p => p.price === lo);
  const curP = d.price ? d.price.final : h[h.length - 1].price;
  const vsMax = hi > 0 ? Math.round((1 - curP / hi) * 100) : 0;
  el.innerHTML = `<div><small>Сейчас</small><b>${esc(m(curP))}</b></div><div><small>Минимум${loAt ? ` · ${esc(fmtDM(loAt.ts))}` : ""}</small><b class="gm-green">${esc(m(lo))}</b></div><div><small>Максимум</small><b>${esc(m(hi))}</b></div><div><small>Средняя</small><b>${esc(m(avg))}</b></div><div><small>Дешевле максимума</small><b class="${vsMax > 0 ? "gm-green" : ""}">${vsMax > 0 ? `−${vsMax}%` : "нет"}</b></div><div><small>Наблюдаем</small><b>${d.tracking_since ? esc(shortDate(d.tracking_since)) : "с сегодня"}</b></div>`;
}

function paintPriceChart(ov, range) {
  const d = ov.__d, box = ov.querySelector("#gm-pchart");
  if (!box) return;
  ov.querySelectorAll("[data-prange]").forEach(b => b.classList.toggle("on", Number(b.dataset.prange) === range));
  const hist = (d.history || []).slice().sort((a, b) => a.ts - b.ts);
  const now = Date.now() / 1000;
  let pts = hist;
  if (range > 0) {
    const cut = now - range * 86400, before = hist.filter(p => p.ts < cut), keep = hist.filter(p => p.ts >= cut);
    pts = before.length ? [{ ...before[before.length - 1], ts: cut }, ...keep] : keep;
  }
  if (!pts.length) { box.innerHTML = `<small class="ny-hint">Данных пока нет: цена записывается раз в 2 часа и при каждом просмотре.</small>`; return; }
  const cur = d.price && d.price.currency;
  const m = n => priceView({ final: n, initial: n, discount: 0, currency: cur }).now;
  const g = seriesChart(pts.map(p => ({ ts: p.ts, v: p.price, d: p.discount })), { step: true, now, w: 760, h: 270 });
  box.innerHTML = chartSvg(g, "price", v => fmtNum(Math.round(v)), fmtDM);
  attachHover(box, g, true, (p, ts) => `<b>${esc(m(p.v))}</b>${p.d > 0 ? ` <i class="gm-badge sm">−${p.d}%</i>` : ""}<small>${esc(fmtDM(ts))}</small>`);
  const flatMsg = new Set(pts.map(p => p.price)).size === 1 ? `<small class="ny-hint gm-flat">Цена не менялась за выбранный период.</small>` : "";
  box.insertAdjacentHTML("beforeend", flatMsg);
}

function paintPriceList(ov) {
  const d = ov.__d, el = ov.querySelector("#gm-plist");
  if (!el) return;
  const h = (d.history || []).slice().sort((a, b) => b.ts - a.ts);
  if (h.length < 2) { el.innerHTML = ""; return; }
  const cur = d.price && d.price.currency;
  const m = n => priceView({ final: n, initial: n, discount: 0, currency: cur }).now;
  el.innerHTML = `<h4>Последние изменения цены</h4>${h.slice(0, 7).map((p, i) => {
    const prev = h[i + 1];
    const down = prev && p.price < prev.price;
    return `<div class="gm-prow"><span>${esc(shortDate(p.ts))}</span><span>${prev ? `<s>${esc(m(prev.price))}</s> → ` : ""}<b>${esc(m(p.price))}</b></span><span class="${prev ? (down ? "gm-green" : "gm-red") : ""}">${prev ? `${down ? "−" : "+"}${Math.abs(Math.round(((p.price - prev.price) / prev.price) * 100))}%` : "первая запись"}</span>${p.discount > 0 ? `<i class="gm-badge sm">−${p.discount}%</i>` : "<i></i>"}</div>`;
  }).join("")}`;
}

async function loadMonthly(ov, appid) {
  const box = ov.querySelector("#gm-monthly");
  if (!box) return;
  try {
    const r = await apiGet(`/games/app/${appid}/monthly`);
    if (!r.items.length) { box.innerHTML = `<small class="ny-hint">Данных пока нет: онлайн копится с момента, когда игра попала в наблюдение.</small>`; return; }
    box.innerHTML = `<div class="gm-mt"><div class="gm-mt-h"><span>Месяц</span><span>Пик</span><span>Прирост</span><span>%</span><span>Среднее</span></div>${r.items.map(m => {
      const g = m.gain, up = g > 0;
      return `<div class="gm-mt-r"><span>${esc(new Date(m.month + "-01T12:00:00").toLocaleDateString("ru-RU", { month: "long", year: "numeric" }))}</span><span>${fmtNum(m.peak)}</span><span class="${g == null ? "" : up ? "gm-green" : "gm-red"}">${g == null ? "—" : `${up ? "+" : "−"}${fmtNum(Math.abs(g))}`}</span><span class="${g == null ? "" : up ? "gm-green" : "gm-red"}">${m.gain_pct == null ? "—" : `${up ? "+" : "−"}${Math.abs(m.gain_pct)}%`}</span><span>${fmtNum(m.avg)}</span></div>`;
    }).join("")}</div>${r.since ? `<p class="ny-hint gm-hnote">Данные ведём с ${esc(shortDate(Date.parse(r.since + "T12:00:00Z") / 1000))}: Steam не отдаёт историю онлайна задним числом.</p>` : ""}`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить.")}</small>`; }
}

// Метки из ProtonDB и Steam Deck подгружаются отдельно: внешние источники медленнее самой карточки.
async function loadBuild(ov, appid) {
  const box = ov.querySelector("#gm-build");
  if (!box) return;
  try {
    const b = await apiGet(`/games/app/${appid}/build`);
    if (ov.isConnected && ov.querySelector("#gm-build") === box) box.innerHTML = buildHtml(b);
  } catch (_) { if (ov.isConnected) box.innerHTML = buildHtml(null); }
}

function steamText(value) {
  return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function loadTechnicalSections(ov, appid) {
  const techBox = ov.querySelector("#gm-tech-meta");
  const depotBox = ov.querySelector("#gm-depots");
  const configBox = ov.querySelector("#gm-config");
  const cloudBox = ov.querySelector("#gm-cloud");
  const relatedBox = ov.querySelector("#gm-related");
  const dlcBox = ov.querySelector("#gm-dlcs");
  const packageBox = ov.querySelector("#gm-packages");
  const d = ov.__d || {};
  if (packageBox) {
    packageBox.innerHTML = (d.packages || []).length
      ? `<div class="gm-tech-list">${d.packages.map(p => {
        const final = p.price_minor == null ? null : Number(p.price_minor) / 100;
        const initial = p.initial_price_minor == null ? final : Number(p.initial_price_minor) / 100;
        const discount = Number(p.discount_percent) || (final != null && initial > final ? Math.round((1 - final / initial) * 100) : 0);
        const view = final == null ? null : final === 0 ? { now: "Бесплатно", old: "", badge: "" } : priceView({ final, initial: initial == null ? final : initial, discount, currency: p.currency || d.price && d.price.currency });
        return `<div class="gm-tech-row"><span><b>${esc(p.name || p.group || "Пакет Steam")}</b><small>Package ID · ${p.id}</small></span><span class="gm-package-price">${view ? `${view.old ? `<s>${esc(view.old)}</s>` : ""}<b>${esc(view.now)}</b>${view.badge ? `<i class="gm-badge sm">${esc(view.badge)}</i>` : ""}` : `<small class="ny-hint">Цена недоступна</small>`}</span><button type="button" class="btn sm" data-d-store="https://steamdb.info/sub/${p.id}/">Подробнее</button></div>`;
      }).join("")}</div>`
      : `<small class="ny-hint">Steam Store не вернул варианты покупки для этого приложения.</small><button type="button" class="btn sm" data-d-store="https://steamdb.info/app/${appid}/subs/">Все пакеты в SteamDB</button>`;
  }
  const loading = `<div class="gm-reg-load"><span class="ny-spin"></span> Загружаю публичные данные Steam…</div>`;
  [techBox, depotBox, configBox, cloudBox, relatedBox, dlcBox].forEach(box => { if (box) box.innerHTML = loading; });
  const [techResult, relatedResult] = await Promise.allSettled([
    apiGet(`/games/app/${appid}/technical`), apiGet(`/games/app/${appid}/related`),
  ]);
  if (!ov.isConnected) return;
  const tech = techResult.status === "fulfilled" ? techResult.value : null;
  const related = relatedResult.status === "fulfilled" ? relatedResult.value : null;
  if (techBox) {
    const releaseStates = { released: "Вышла", prerelease: "Ранний доступ", prerelease_unavailable: "Предварительный доступ", coming_soon: "Скоро выйдет" };
    techBox.innerHTML = tech && tech.available
      ? `<div class="gm-tech-grid"><div><small>Последнее изменение Steam</small><b>${tech.change ? fmtNum(tech.change) : "—"}</b></div><div><small>Публичная сборка</small><b>${esc(tech.branch && tech.branch.buildid || "—")}</b></div><div><small>Обновлена</small><b>${tech.branch && tech.branch.updated ? esc(shortDate(tech.branch.updated)) : "—"}</b></div><div><small>Архитектура</small><b>${esc(tech.arch || "—")}</b></div>${tech.franchises && tech.franchises.length ? `<div><small>Франшиза</small><b>${esc(tech.franchises.join(", "))}</b></div>` : ""}${tech.release_state ? `<div><small>Статус выпуска</small><b>${esc(releaseStates[tech.release_state] || tech.release_state)}</b></div>` : ""}</div>`
      : `<small class="ny-hint">Расширенные метаданные временно недоступны. Основные сведения доступны в разделе «Обзор».</small>`;
  }
  if (depotBox) {
    const depots = tech && tech.depots || [];
    depotBox.innerHTML = depots.length
      ? depotsHtml(depots)
      : `<small class="ny-hint">Steam не вернул сводные данные о публичных депо.</small><button type="button" class="btn sm" data-d-store="https://steamdb.info/app/${appid}/depots/">Депо в SteamDB</button>`;
  }
  if (configBox) {
    const p = d.platforms || {};
    const systems = Object.entries({ windows: "Windows", mac: "macOS", linux: "Linux" }).filter(([k]) => p[k]).map(([, v]) => v);
    const langs = tech && tech.languages && tech.languages.length ? tech.languages : d.language_support || [];
    const controller = String(tech && tech.controller || d.controller_support || "").toLowerCase();
    const controllerLabel = ({ full: "Полная поддержка", partial: "Частичная поддержка" })[controller] || (tech && tech.controller || d.controller_support || "Не указана");
    const req = d.requirements || {};
    configBox.innerHTML = `<div class="gm-tech-grid gm-config-grid"><div class="gm-config-fact"><small>Поддерживаемые системы</small><b>${esc(systems.join(" · ") || tech && tech.os || "Не указаны")}</b></div><div class="gm-config-fact"><small>Поддержка контроллера</small><b>${esc(controllerLabel)}</b></div><div class="gm-config-fact"><small>Папка установки</small><b><code>${esc(tech && tech.install_dir || "—")}</code></b></div><div class="gm-config-req"><small>Минимальные требования</small>${requirementsHtml(steamText(req.min))}</div><div class="gm-config-req"><small>Рекомендуемые требования</small>${requirementsHtml(steamText(req.rec))}</div></div>`
      + languagesHtml(langs);
  }
  if (cloudBox) {
    const cloud = tech && tech.cloud;
    cloudBox.innerHTML = cloud && cloud.available && cloud.enabled
      ? `<div class="gm-tech-grid"><div><small>Steam Cloud</small><b class="gm-green">Поддерживается</b></div><div><small>Лимит файлов</small><b>${cloud.max_files ? fmtNum(cloud.max_files) : "—"}</b></div><div><small>Квота</small><b>${cloud.quota ? esc(fmtBytes(cloud.quota)) : "—"}</b></div></div><div class="gm-tech-list">${(cloud.paths || []).map(x => `<div class="gm-tech-row"><span><b>${esc(x.path)}</b><small>${esc(x.root || "Steam Cloud")}${x.recursive ? " · включая вложенные папки" : ""}</small></span><small>${esc(x.pattern || "*")}</small></div>`).join("")}</div><p class="ny-hint gm-hnote">Это настройки синхронизации игры. Личные файлы сохранений не читаются.</p>`
      : cloud && cloud.available
        ? `<div class="gm-tech-grid"><div><small>Steam Cloud</small><b>Не заявлен</b></div></div><small class="ny-hint">Для этого приложения Steam не опубликовал правила облачных сохранений.</small>`
      : `<div class="gm-tech-grid"><div><small>Steam Cloud</small><b>Нет данных</b></div></div><small class="ny-hint">Steam не предоставил настройки облачных сохранений для этой игры.</small>`;
  }
  const card = item => item.unavailable
    ? `<button type="button" class="gm-card gm-related" data-d-store="https://steamdb.info/app/${item.appid}/">${picHtml(item.appid, item.image, item.name || "DLC", "gm-img")}<div class="gm-t">${esc(item.name || `App ${item.appid}`)}</div><div class="gm-pr"><small>Скрытый в Steam Store · ID ${item.appid}</small><b>Открыть SteamDB</b></div></button>`
    : `<button type="button" class="gm-card gm-related" data-related-app="${item.appid}" data-name="${esc(item.name || "")}">${picHtml(item.appid, item.image, item.name || "Steam", "gm-img") }<div class="gm-t">${esc(item.name || `App ${item.appid}`)}</div><div class="gm-pr"><small>${esc(item.type || "Игра")}</small>${item.price ? priceCell(item.price) : item.free ? `<b>Бесплатно</b>` : ""}</div></button>`;
  if (related) {
    const count = ov.querySelector("#gm-dlc-count");
    if (count) count.textContent = fmtNum(related.dlc_total ?? (related.dlcs || []).length);
    if (dlcBox) dlcBox.innerHTML = related.dlcs && related.dlcs.length
      ? `<div class="gm-grid gm-related-grid">${related.dlcs.map(card).join("")}</div>${related.truncated ? `<small class="ny-hint">Показаны первые ${related.dlcs.length} из ${related.dlc_total} дополнений.</small>` : ""}`
      : `<small class="ny-hint">Store API не вернул список DLC для этой игры.</small><button type="button" class="btn sm" data-d-store="https://steamdb.info/app/${appid}/dlc/">Список DLC в SteamDB</button>`;
    if (relatedBox) relatedBox.innerHTML = `${related.parent ? `<h4>Основная игра</h4><div class="gm-grid gm-related-grid">${card(related.parent)}</div>` : ""}${related.demos && related.demos.length ? `<h4>Демо-версии</h4><div class="gm-grid gm-related-grid">${related.demos.map(card).join("")}</div>` : ""}${!related.parent && !(related.demos || []).length ? `<small class="ny-hint">Связанные приложения Steam не предоставил.</small>` : ""}`;
  } else {
    if (dlcBox) dlcBox.innerHTML = `<small class="ny-hint">Steam временно не вернул список DLC.</small><button type="button" class="btn sm" data-d-store="https://steamdb.info/app/${appid}/dlc/">Список DLC в SteamDB</button>`;
    if (relatedBox) relatedBox.innerHTML = `<small class="ny-hint">Steam временно не вернул связанные приложения.</small><button type="button" class="btn sm" data-d-store="https://steamdb.info/app/${appid}/">Открыть SteamDB</button>`;
  }
}

async function loadExtra(ov, appid) {
  try {
    const x = await apiGet(`/games/app/${appid}/extra`);
    const box = ov.querySelector("#gm-badges");
    if (!box) return;
    box.innerHTML = badgesOf(ov.__d || {}, x).map(b => `<i class="gm-tag ${b.cls}">${esc(b.text)}</i>`).join("");
    const tags = ov.querySelector("#gm-tags");
    if (tags) tags.innerHTML = (x.tags || []).length
      ? x.tags.map(n => `<i class="gm-tag t">${esc(n)}</i>`).join("")
      : `<small class="ny-hint">Теги Steam недоступны.</small>`;
  } catch (_) {
    const tags = ov.querySelector("#gm-tags");
    if (tags && ov.isConnected) tags.innerHTML = '<small class="ny-hint">Теги временно недоступны.</small>';
  }
}

const newsHtml = items => items.map(n => `<div class="gm-news"><b>${esc(n.title)}</b><small class="ny-hint">${esc(shortDate(n.ts))}${n.label ? ` · ${esc(n.label)}` : ""}</small><p>${esc(n.text)}</p>${n.url ? `<button type="button" class="btn ghost sm" data-d-store="${esc(n.url)}">Читать</button>` : ""}</div>`).join("");
const newsMoreBtn = (r, kind) => (r.more && r.items.length ? `<div class="gm-moreb"><button type="button" class="btn" data-newsmore="${kind}" data-before="${r.items[r.items.length - 1].ts}">Ещё</button></div>` : "");

async function loadMoreNews(ov, appid, btn) {
  const wrap = btn.closest(".gm-moreb");
  btn.disabled = true;
  try {
    const r = await apiGet(`/games/app/${appid}/news`, { kind: btn.dataset.newsmore === "patch" ? "patch" : "all", before: Number(btn.dataset.before) - 1 });
    if (!wrap.isConnected) return;
    wrap.insertAdjacentHTML("beforebegin", newsHtml(r.items));
    if (r.more && r.items.length) { btn.dataset.before = String(r.items[r.items.length - 1].ts); btn.disabled = false; } else wrap.remove();
  } catch (e) { btn.disabled = false; toast(e.message || "Не удалось загрузить.", "error"); }
}

async function loadMore(ov, appid, kind) {
  const seq = ov.__moreSeq = (ov.__moreSeq || 0) + 1;
  const current = () => ov.isConnected && seq === ov.__moreSeq;
  const box = ov.querySelector("#gm-more-body");
  if (!box) return;
  ov.querySelectorAll("[data-more]").forEach(b => b.classList.toggle("on", b.dataset.more === kind));
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Загружаю…</div>`;
  try {
    if (kind === "reviews") {
      const r = await apiGet(`/games/app/${appid}/reviews`);
      if (!current()) return;
      const sm = paintRate(ov, r);
      box.innerHTML = (sm ? `<div class="gd-review-summary"><div><b>${sm.pct}<span>%</span></b><small>рекомендуют</small></div><div><p>${esc(sm.text)}</p><div class="gd-rating-track" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, sm.pct))}%"></i></div><small>Отзывы игроков Steam</small></div></div>` : "") + (r.items.length ? reviewCardsHtml(r.items) : `<small class="ny-hint">Отзывов на русском пока нет.</small>`);
    } else if (kind === "stats") {
      const r = await apiGet(`/games/app/${appid}/stats`, { steamid: me && me.steamid });
      if (!current()) return;
      box.innerHTML = r.items.length ? `<div class="gm-statg">${r.items.map(x => `<div><small>${esc(statLabel(x.name))}</small><b>${esc(fmtNum(x.value))}</b></div>`).join("")}</div>` : `<small class="ny-hint">${r.available === false ? "Статистика недоступна: у игры её нет или закрыты сведения об играх." : "Данных нет."}</small>`;
    } else if (kind === "news" || kind === "patch") {
      const r = await apiGet(`/games/app/${appid}/news`, { kind: kind === "patch" ? "patch" : "all" });
      if (!current()) return;
      box.innerHTML = r.items.length ? newsHtml(r.items) + newsMoreBtn(r, kind) : `<small class="ny-hint">${kind === "patch" ? "Патчноутов нет." : "Новостей нет."}</small>`;
    } else {
      const r = await apiGet(`/games/app/${appid}/achievements`, { steamid: me && me.steamid });
      if (!current()) return;
      if (!r.total) { box.innerHTML = `<small class="ny-hint">У этой игры нет достижений.</small>`; return; }
      box.innerHTML = `<p class="gm-ach-s"><b>${esc(r.available ? achSummary(r) : `${fmtNum(r.total)} достижений`)}</b>${r.available ? "" : ` <small class="ny-hint">— показан общий процент игроков, получивших каждое достижение</small>`}</p>`
        + r.items.slice(0, 60).map(a => `<div class="gm-ach${a.achieved ? " on" : ""}"><i>${a.icon ? `<img loading="lazy" src="${esc(img(a.icon))}" alt="">` : ""}</i><div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div><span class="ny-hint">${a.percent}%</span></div>`).join("");
    }
  } catch (e) { if (!current()) return; box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить.")}</small>`; }
}

export async function paintProfile() {
  const body = $("#gm-body");
  if (!me || !me.steamid) { body.innerHTML = empty("Steam не привязан", "Привяжите аккаунт, чтобы увидеть профиль.", `<button type="button" class="btn primary" data-gadd>Привязать Steam</button>`); return; }
  body.innerHTML = skeleton(4);
  try {
    const p = await apiGet("/games/profile", { steamid: me.steamid });
    if (tab !== "profile") return;
    const t = p.total || {};
    const row = g => `<button type="button" class="gm-card lib" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div><div class="gm-pr"><small>${g.hours2w != null ? `${esc(fmtHours(g.hours2w))} за 2 недели · ` : ""}${esc(fmtHours(g.hours))} всего</small></div></button>`;
    body.innerHTML = `<div class="gm-prof"><i class="gm-ava big">${p.avatar ? `<img src="${esc(img(p.avatar))}" alt="">` : `<span>${esc(initials2(p.name))}</span>`}</i>
      <div><h2>${esc(p.name || "Steam")}</h2><small class="ny-hint">${p.level != null ? `Уровень ${p.level}` : "Уровень скрыт"}${p.visible === false ? " · профиль закрыт" : ""}</small></div></div>
      <div class="gm-online-s gm-prof-s"><div><small>Игр</small><b>${fmtNum(t.games)}</b></div><div><small>Часов всего</small><b>${fmtNum(t.hours)}</b></div><div><small>Не запускал</small><b>${fmtNum(t.unplayed)}</b></div></div>
      <section class="gm-sesscard" hidden><div id="gm-sess-body" data-compact="1"></div></section>
      <div id="gm-acct"></div>
      ${xpHtml(p.badges)}
      <form class="gm-look" id="gm-look" autocomplete="off"><input id="gm-lookq" type="text" placeholder="Посмотреть другой профиль: ссылка, имя или SteamID64" spellcheck="false"><button type="submit" class="btn sm">Найти</button></form>
      <div id="gm-look-res"></div>
      ${(p.recent || []).length ? `<h3 class="gm-h3">Недавно играли</h3><div class="gm-grid">${p.recent.map(row).join("")}</div>` : ""}
      ${(p.top || []).length ? `<h3 class="gm-h3">Больше всего часов</h3><div class="gm-grid">${p.top.map(row).join("")}</div>` : ""}
      <h3 class="gm-h3">Друзья</h3><div id="gm-friends"><button type="button" class="btn" data-friends>Показать друзей</button></div>
      ${!(p.recent || []).length && !(p.top || []).length ? empty("Данных нет", "Откройте «Сведения об играх» в настройках конфиденциальности Steam.") : ""}`;
    paintSession();
  } catch (e) { body.innerHTML = errBox(e); }
}

function xpHtml(b) {
  if (!b) return "";
  const x = xpProgress(b);
  return `<div class="gm-xp"><span>Опыт ${fmtNum(b.xp)} · значков ${fmtNum(b.count)}</span>${x ? `<i class="gm-xpbar"><b style="width:${x.pct}%"></b></i><small class="ny-hint">до следующего уровня ${fmtNum(x.left)}</small>` : ""}</div>`;
}

export async function loadFriends() {
  const box = $("#gm-friends");
  if (!box) return;
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Загружаю друзей…</div>`;
  try {
    const r = await apiGet("/games/friends", { steamid: me.steamid });
    box.innerHTML = `<div class="gm-flist">${r.items.map(f => { const st = friendState(f); return `<div class="gm-friend ${st.cls}"><i class="gm-ava">${f.avatar ? `<img src="${esc(img(f.avatar))}" alt="">` : `<span>${esc(initials2(f.name))}</span>`}</i><div><b>${esc(f.name || f.steamid)}</b><small>${esc(st.text)}</small></div></div>`; }).join("")}</div>`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить друзей.")}</small>`; }
}

export async function lookupProfile(q) {
  const box = $("#gm-look-res");
  if (!box) return;
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Ищу профиль…</div>`;
  try {
    const p = await apiGet("/games/profile/lookup", { q });
    const t = p.total || {};
    box.innerHTML = `<div class="gm-prof gm-look-card"><i class="gm-ava big">${p.avatar ? `<img src="${esc(img(p.avatar))}" alt="">` : `<span>${esc(initials2(p.name))}</span>`}</i><div><h3>${esc(p.name || "Steam")}</h3><small class="ny-hint">${p.level != null ? `Уровень ${p.level}` : ""}${t.games != null ? ` · ${fmtNum(t.games)} игр · ${fmtNum(t.hours)} ч` : " · библиотека закрыта"}</small></div></div>${(p.top || []).length ? `<div class="gm-grid">${p.top.map(g => `<button type="button" class="gm-card lib" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div><div class="gm-pr"><small>${esc(fmtHours(g.hours))}</small></div></button>`).join("")}</div>` : ""}`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Профиль не найден.")}</small>`; }
}

export async function syncSteamWishlist() {
  if (!me || !me.steamid) { toast("Сначала привяжите Steam.", "error"); return; }
  try {
    const r = await apiPost("/games/wishlist/sync");
    if (r && r.error) toast(r.error, "error");
    else toast(r && (r.added || r.removed) ? `Синхронизировано: добавлено ${r.added}, убрано ${r.removed}.` : "Список уже актуален.", "success");
    if (tab === "wish") paintWish();
  } catch (e) { toast(e.message || "Не удалось синхронизировать.", "error"); }
}

export async function exportWishlist() {
  try {
    const r = await apiGet("/games/wishlist/export");
    await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
    toast(`Список скопирован (${r.items.length}). Вставьте его в файл или отправьте себе.`, "success");
  } catch (e) { toast(e.message || "Не удалось скопировать.", "error"); }
}

export function importWishlist() {
  const ov = gmSheet(`<h2>Импорт желаемого</h2><p class="ny-hint">Вставьте JSON, полученный через «Скопировать список». Уже имеющиеся игры не затираются.</p><textarea id="gm-imp" class="gm-imp" rows="8" spellcheck="false"></textarea><div class="gm-d-act"><button type="button" class="btn primary" data-imp-go>Импортировать</button><button type="button" class="btn ghost" data-d-close>Закрыть</button></div>`);
  ov.addEventListener("click", async e => {
    if (e.target.closest("[data-d-close]")) { dismissSheet(ov); return; }
    if (!e.target.closest("[data-imp-go]")) return;
    try {
      const data = JSON.parse(ov.querySelector("#gm-imp").value);
      const r = await apiPost("/games/wishlist/import", { items: Array.isArray(data) ? data : data.items });
      dismissSheet(ov);
      toast(`Импортировано: ${r.imported}.`, "success");
      if (tab === "wish") paintWish();
    } catch (err) { toast(err instanceof SyntaxError ? "Это не похоже на экспорт списка (нужен JSON)." : err.message, "error"); }
  });
}

export async function loadStatus() {
  const box = $("#gm-status");
  if (!box) return;
  try {
    const r = await apiGet("/games/status");
    const when = ts => (ts ? new Date(ts * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "ещё не было");
    box.innerHTML = `<small class="ny-hint">Проверка желаемого: ${esc(when(r.last_wishlist_check))} · сбор цен: ${esc(when(r.last_crawl))} · сборки игр: ${esc(when(r.last_build_check))} · цены по странам: ${esc(when(r.last_regions))} · копия базы: ${esc(r.last_backup || "ещё не было")}<br>Точек цены: ${fmtNum(r.price_points)} · точек онлайна: ${fmtNum(r.players_points)} · записей обновлений: ${fmtNum(r.builds_total)} · уведомлений отправлено: ${fmtNum(r.alerts_total)} · ключ Steam: ${r.steam_key ? "есть" : "нет"}</small>`;
  } catch (_) { box.innerHTML = ""; }
}

async function loadRegions(ov, appid) {
  const box = ov.querySelector("#gm-reg");
  if (!box) return;
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Запрашиваю цены по странам…</div>`;
  try {
    const r = await apiGet(`/games/app/${appid}/regions`);
    if (!r.items.length) { box.innerHTML = `<small class="ny-hint">Цены по странам недоступны.</small>`; return; }
    const cheapest = r.items.find(x => x.usd != null);
    box.innerHTML = `<div class="gm-regt">
      <div class="gm-regh"><b>Цены по странам</b><small class="ny-hint">${r.rates ? `в пересчёте на ${esc(r.my_currency || "вашу валюту")} по курсу` : "курсы валют недоступны — сравнение приблизительное"}</small></div>
      <div class="gm-regr head"><span>Страна</span><span class="gm-tc">Цена</span><span class="gm-tc">В вашей валюте</span><span class="gm-tc">Минимум у нас</span><span class="gm-tc">Разница</span></div>
      ${r.items.map(x => {
        const d = pctText(x.vs_mine);
        const mine = x.cc === r.my_cc;
        const conv = x.conv != null && x.currency !== r.my_currency ? `≈ ${esc(priceView({ final: x.conv, initial: x.conv, discount: 0, currency: r.my_currency }).now)}` : "";
        const lastChecked = x.last_checked ? `Проверено ${fmtDMHM(x.last_checked)}` : "Ещё не проверялась";
        return `<div class="gm-regr${mine ? " mine" : ""}${cheapest && x.cc === cheapest.cc ? " best" : ""}"><span><button type="button" class="gm-rhist-btn" data-rhistory="${esc(x.cc)}" data-rname="${esc(x.name)}">${esc(x.name)} · история ${x.history_count || 0}</button>${mine ? ` <i>ваша</i>` : ""}${cheapest && x.cc === cheapest.cc ? ` <i class="b">дешевле всего</i>` : ""}<small class="gm-rchecked ny-hint">${esc(lastChecked)}</small></span><span class="gm-tc">${x.discount ? `<i class="gm-badge sm">−${x.discount}%</i>` : ""}<b>${esc(priceView(x).now)}</b></span><span class="gm-tc ny-hint">${conv}</span><span class="gm-tc ny-hint">${esc(lowestText(x, p => priceView(p).now))}</span><span class="gm-tc gm-d ${d.cls}">${esc(d.text)}</span></div>`;
      }).join("")}
    </div><div class="gm-rhist-detail" id="gm-rhist-detail" hidden></div>`;
  } catch (e) { box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить цены по странам.")}</small>`; }
}

async function loadRegionHistory(ov, appid, cc, country) {
  const box = ov.querySelector("#gm-rhist-detail");
  if (!box) return;
  if (!box.hidden && box.dataset.cc === cc) { box.hidden = true; return; }
  box.hidden = false;
  box.dataset.cc = cc;
  box.innerHTML = `<div class="gm-reg-load"><span class="ny-spin"></span> Загружаю историю ${esc(country)}…</div>`;
  try {
    const r = await apiGet(`/games/app/${appid}/region-history`, { cc });
    if (!ov.isConnected || box.dataset.cc !== cc) return;
    const when = ts => ts ? fmtDMHM(ts) : "—";
    const rows = (r.items || []).slice().reverse();
    const money = p => priceView({ final: p.final, initial: p.initial, discount: p.discount, currency: p.currency }).now;
    box.innerHTML = `<div class="gm-rhist-head"><b>${esc(r.country)} · история цены</b><span class="ny-hint">Наблюдаем с ${esc(when(r.since))} · последнее изменение ${esc(when(r.last_change))} · проверено ${esc(when(r.last_checked))}</span></div><small class="ny-hint">Время изменения — когда сервер заметил новую цену; Steam не сообщает точный момент её смены.</small>${rows.length ? `<div class="gm-rhist-list">${rows.slice(0, 20).map((p, i) => {
      const prev = rows[i + 1];
      const down = prev && p.final < prev.final;
      const change = prev ? (prev.final ? `${down ? "−" : "+"}${Math.abs(Math.round((p.final - prev.final) / prev.final * 100))}%` : "изменена") : "первая запись";
      return `<div class="gm-rhist-row"><time>${esc(when(p.ts))}</time><span>${prev ? `${esc(money(prev))} → ` : ""}<b>${esc(money(p))}</b></span><span class="${prev ? (down ? "gm-green" : "gm-red") : "ny-hint"}">${change}</span>${p.discount ? `<i class="gm-badge sm">−${p.discount}%</i>` : "<i></i>"}</div>`;
    }).join("")}</div>${r.count > 20 ? `<small class="ny-hint">Показаны последние 20 из ${fmtNum(r.count)} изменений.</small>` : ""}` : `<small class="ny-hint">Пока нет сохранённых изменений цены для этой страны. Проверки и история начнут накапливаться автоматически.</small>`}`;
  } catch (e) {
    if (box.dataset.cc === cc) box.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить историю страны.")}</small>`;
  }
}

async function loadOnline(ov, appid, range, quiet = false) {
  const box = ov.querySelector("#gm-online");
  if (!box) return;
  ov.__orange = range;
  box.querySelectorAll("[data-orange]").forEach(b => b.classList.toggle("on", b.dataset.orange === range));
  const st = box.querySelector(".gm-online-s"), ch = box.querySelector(".gm-online-c");
  if (!quiet) ch.innerHTML = `<span class="ny-sk blk"></span>`;
  try {
    const r = await apiGet(`/games/app/${appid}/charts`, { range });
    if (!ov.isConnected || ov.__orange !== range) return;
    const now = ov.querySelector("#gm-now"); if (now) now.textContent = fmtNum(r.now);
    const rk = ov.querySelector("#gm-rank"); if (rk) rk.textContent = r.rank ? `№${r.rank} по онлайну сейчас` : "";
    st.innerHTML = `<div><small>Сейчас</small><b class="gm-green">${fmtNum(r.now)}</b></div><div><small>Пик за 24 ч</small><b>${fmtNum(r.peak24)}</b></div><div><small>Среднее за 24 ч</small><b>${fmtNum(r.avg24)}</b></div><div><small>Пик у нас${r.since ? ` с ${esc(shortDate(r.since))}` : ""}</small><b>${fmtNum(r.peak_all)}</b></div>`;
    const short = range === "48h" || range === "7d";
    const g = r.points && r.points.length ? seriesChart(r.points.map(p => ({ ts: p.ts, v: p.n })), { step: false, w: 760, h: 270 }) : null;
    if (!g) { ch.innerHTML = `<small class="ny-hint">Точек пока нет. Они записываются каждые 5 минут (у открытой игры — каждые 2), график появится сам.</small>`; return; }
    ch.innerHTML = chartSvg(g, "online", fmtCompact, ts => (range === "48h" ? fmtDMHM(ts) : short ? fmtDM(ts) : fmtDM(ts)));
    attachHover(ch, g, false, (p) => `<b>${fmtNum(p.v)}</b><small>${esc(fmtDMHM(p.ts))}</small>`);
    if (r.points.length < 3) ch.insertAdjacentHTML("beforeend", `<small class="ny-hint gm-flat">Записано точек: ${r.points.length}. Следующие появятся через 2–5 минут, график обновляется сам.</small>`);
  } catch (e) { if (!quiet && ov.isConnected && ov.__orange === range) ch.innerHTML = `<small class="ny-hint">${esc(e.message || "Не удалось загрузить онлайн.")}</small>`; }
}

export async function launch(appid, button) {
  if (button && button.disabled) return;
  const label = button && button.textContent;
  if (button) { button.disabled = true; button.textContent = "Открываю…"; }
  try {
    const r = await apiGet(`/games/launch/${appid}`, { steamid: me && me.steamid });
    if (!isSteamLaunchUrl(r.url)) throw new Error("Сервер вернул неожиданный адрес запуска.");
    await openExternal(r.url);
    toast("Запускаю через Steam…", "success");
  } catch (e) { toast(e && e.message ? e.message : String(e || "Не удалось запустить игру."), "error"); }
  finally { if (button && button.isConnected) { button.disabled = false; button.textContent = label; } }
}

export async function refreshMe() {
  setMe( await apiGet("/games/me"));
  setLib( null);
  paintWho();
}

