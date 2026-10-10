// Игровое пространство: чистые функции без DOM и сети (проверяются в scripts/games-test.mjs).
// Цены приходят с сервера уже в основных единицах: { final, initial, discount, currency }.

/** «2 880 ₸», «5,69 $», «Бесплатно»; без цены — «—». */
export function fmtPrice(p, locale = "ru-RU") {
  if (p == null) return "—";
  if (p === 0 || p.final === 0) return "Бесплатно";
  const cur = p.currency || "USD";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: cur, maximumFractionDigits: p.final % 1 ? 2 : 0 }).format(p.final);
  } catch (_) {
    return `${p.final} ${cur}`;
  }
}

/** Данные для плашки цены: текущая, старая (если скидка) и бейдж «−50 %». */
export function priceView(p, locale = "ru-RU") {
  if (!p) return { now: "—", old: "", badge: "", sale: false };
  const sale = p.discount > 0 && p.initial > p.final;
  return {
    now: fmtPrice(p, locale),
    old: sale ? fmtPrice({ ...p, final: p.initial }, locale) : "",
    badge: sale ? `−${p.discount}%` : "",
    sale,
  };
}

/** Фильтр и сортировка списка скидок: minDiscount — порог в процентах; mode: discount | price | name. */
export function filterDeals(items, { minDiscount = 0, maxPrice = null, mode = "discount", minPct = 0, minReviews = 0 } = {}) {
  let list = (items || []).filter(i => i.price && i.price.discount >= minDiscount);
  if (maxPrice != null) list = list.filter(i => i.price.final <= maxPrice);
  if (minPct) list = list.filter(i => (i.pct || 0) >= minPct);          // доля положительных отзывов
  if (minReviews) list = list.filter(i => (i.reviews || 0) >= minReviews);
  const by = {
    discount: (a, b) => b.price.discount - a.price.discount || a.price.final - b.price.final,
    price: (a, b) => a.price.final - b.price.final,
    name: (a, b) => String(a.name).localeCompare(String(b.name), "ru"),
  }[mode] || (() => 0);
  return list.slice().sort(by);
}

/**
 * Линия истории цены для SVG: points = [{ts, price}], размер w×h.
 * Цена между точками держится ступенькой (цена не «плывёт», а меняется скачком).
 */
export function sparkline(points, w = 300, h = 80, pad = 6) {
  const pts = (points || []).filter(p => Number.isFinite(p.price) && Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return null;
  const t0 = pts[0].ts, t1 = Math.max(pts[pts.length - 1].ts, Date.now() / 1000);
  const lo = Math.min(...pts.map(p => p.price)), hi = Math.max(...pts.map(p => p.price));
  const span = hi - lo || 1;
  const x = t => pad + ((t - t0) / ((t1 - t0) || 1)) * (w - pad * 2);
  const y = v => h - pad - ((v - lo) / span) * (h - pad * 2);
  let d = `M${x(pts[0].ts).toFixed(1)},${y(pts[0].price).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].ts).toFixed(1)} V${y(pts[i].price).toFixed(1)}`;
  d += ` H${x(t1).toFixed(1)}`;
  return { d, min: lo, max: hi, last: pts[pts.length - 1].price, count: pts.length };
}

/** Часы игры: «12 ч», «45 мин», «—». */
export function fmtHours(h) {
  if (!h) return "—";
  if (h < 1) return `${Math.round(h * 60)} мин`;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)} ч`;
}

/** Только допустимый адрес запуска игры из своей библиотеки Steam. */
export function isSteamLaunchUrl(url) {
  return /^steam:\/\/run\/\d{1,10}$/.test(String(url || ""));
}

/** Инициалы для карточки профиля без аватара. */
export function initials2(name) {
  const w = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return (w[0][0] + (w[1] ? w[1][0] : "")).toUpperCase();
}

/** Запасные адреса обложки на случай, если основной не открылся (у части игр шаблон без хеша не работает). */
export function imageCandidates(appid, primary) {
  const id = Number(appid);
  if (!Number.isInteger(id) || id <= 0) return primary ? [primary] : [];
  const list = [
    primary,
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${id}/library_hero.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${id}/library_600x900.jpg`,
  ].filter(Boolean);
  return [...new Set(list)];
}

/** Оттенок 0–359 по названию: заглушка без картинки у каждой игры своего цвета, но стабильно. */
export function hueOf(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** Число с пробелами между разрядами: 936814 → «936 814»; нет данных → «—». */
export function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return new Intl.NumberFormat("ru-RU").format(Number(n)).replace(/ | /g, " ");
}

/** Дата «14 окт. 2026» по метке времени (секунды). */
export function shortDate(ts, locale = "ru-RU") {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** Ссылка на изменение места в чарте: «▲121», «▼5», «NEW», «=». */
export function deltaView(delta, isNew) {
  if (isNew) return { text: "NEW", cls: "new" };
  if (!delta) return { text: "=", cls: "same" };
  return delta > 0 ? { text: `▲${delta}`, cls: "up" } : { text: `▼${-delta}`, cls: "down" };
}

/** Линия и заливка графика онлайна: points = [{ts, n}] → { line, area, min, max, t0, t1 } или null, если точек меньше двух. */
export function lineChart(points, w = 320, h = 110, pad = 4) {
  const pts = (points || []).filter(p => Number.isFinite(p.n) && Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return null;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
  const lo = Math.min(...pts.map(p => p.n)), hi = Math.max(...pts.map(p => p.n));
  const span = hi - lo || 1;
  const x = t => pad + ((t - t0) / ((t1 - t0) || 1)) * (w - pad * 2);
  const y = v => h - pad - ((v - lo) / span) * (h - pad * 2);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.n).toFixed(1)}`).join(" ");
  const area = `${line} L${x(t1).toFixed(1)},${h} L${x(t0).toFixed(1)},${h} Z`;
  return { line, area, min: lo, max: hi, t0, t1 };
}

/** Мини-график тренда по списку чисел (для таблицы): путь для svg w×h или "" при <3 точек. */
export function miniLine(values, w = 90, h = 24, pad = 2) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 3) return "";
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  return v.map((n, i) => `${i ? "L" : "M"}${(pad + (i / (v.length - 1)) * (w - pad * 2)).toFixed(1)},${(h - pad - ((n - lo) / span) * (h - pad * 2)).toFixed(1)}`).join(" ");
}

/** Группировка списка «скоро» по дням выхода: [{ key, ts, items }], без даты — в конце. */
export function groupByDate(items) {
  const map = new Map();
  for (const it of items || []) {
    const key = it.date ? new Date(it.date * 1000).toISOString().slice(0, 10) : "unknown";
    if (!map.has(key)) map.set(key, { key, ts: it.date || null, items: [] });
    map.get(key).items.push(it);
  }
  return [...map.values()].sort((a, b) => (a.ts === null) - (b.ts === null) || (a.ts || 0) - (b.ts || 0));
}

/** «сегодня», «завтра», «через 5 дн.» до метки времени. */
export function untilText(ts, now = Date.now() / 1000) {
  if (!ts) return "";
  const d = Math.ceil((ts - now) / 86400);
  if (d <= 0) return "сегодня";
  if (d === 1) return "завтра";
  return `через ${d} дн.`;
}

/**
 * График истории цены ступенями: points = [{ts, price, discount}]. Одна точка тоже рисуется (ровная линия до «сейчас»).
 * Возвращает { line, area, sales:[{x,w}], min, max, t0, t1 } или null, если точек нет. Участки со скидкой — в sales.
 */
export function priceChart(points, w = 320, h = 90, pad = 4, now = Date.now() / 1000) {
  const pts = (points || []).filter(p => Number.isFinite(p.price) && Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);
  if (!pts.length) return null;
  const t0 = pts[0].ts, t1 = Math.max(now, pts[pts.length - 1].ts + 1);
  const lo = Math.min(...pts.map(p => p.price)), hi = Math.max(...pts.map(p => p.price));
  const span = hi - lo || 1;
  const x = t => pad + ((t - t0) / ((t1 - t0) || 1)) * (w - pad * 2);
  const y = v => (hi === lo ? h / 2 : h - pad - ((v - lo) / span) * (h - pad * 2));
  let line = `M${x(pts[0].ts).toFixed(1)},${y(pts[0].price).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) line += ` H${x(pts[i].ts).toFixed(1)} V${y(pts[i].price).toFixed(1)}`;
  line += ` H${x(t1).toFixed(1)}`;
  const area = `${line} V${h} H${x(t0).toFixed(1)} Z`;
  const sales = [];
  pts.forEach((p, i) => {
    if (p.discount > 0) {
      const xs = x(p.ts), xe = x(i + 1 < pts.length ? pts[i + 1].ts : t1);
      sales.push({ x: +xs.toFixed(1), w: +Math.max(2, xe - xs).toFixed(1) });
    }
  });
  return { line, area, sales, min: lo, max: hi, t0, t1 };
}

/** Разница цены в процентах: «−36%», «+116%», «=»; нет данных — пусто. */
export function pctText(n) {
  if (n == null || !Number.isFinite(n)) return { text: "", cls: "same" };
  if (n === 0) return { text: "=", cls: "same" };
  return n < 0 ? { text: `−${Math.abs(n)}%`, cls: "up" } : { text: `+${n}%`, cls: "down" };
}

/** Текст всплывашки о цене: { title, body } по записи /games/alerts. */
export function alertText(a) {
  const now = fmtPrice(a.price);
  if (a.kind === "target") return { title: `${a.name || "Игра"}: цена достигла цели`, body: `Сейчас ${now}${a.price && a.price.discount > 0 ? ` (−${a.price.discount}%)` : ""}.` };
  return { title: `${a.name || "Игра"}: скидка −${(a.price && a.price.discount) || 0}%`, body: `Сейчас ${now}${a.price && a.price.discount > 0 ? `, было ${fmtPrice({ ...a.price, final: a.price.initial })}` : ""}.` };
}

/** Порядок «Желаемого»: close — сначала достигшие цели, потом ближайшие к ней; discount — по скидке; name — по названию. */
export function sortWishlist(items, mode = "close") {
  const ratio = w => {
    if (!w.price || w.price.final == null) return Infinity;
    if (w.hit) return -1;
    if (w.target) return w.price.final / w.target;
    return Infinity;
  };
  const by = {
    close: (a, b) => ratio(a) - ratio(b) || String(a.name).localeCompare(String(b.name), "ru"),
    discount: (a, b) => ((b.price && b.price.discount) || 0) - ((a.price && a.price.discount) || 0),
    name: (a, b) => String(a.name).localeCompare(String(b.name), "ru"),
  }[mode] || (() => 0);
  return (items || []).slice().sort(by);
}

/** Порядок библиотеки: recent (как отдал сервер), hours — по часам, name — по названию; unplayed — только с нулём часов. */
export function sortLibrary(items, mode = "recent", unplayed = false) {
  let list = (items || []).slice();
  if (unplayed) list = list.filter(g => !g.hours);
  const by = { hours: (a, b) => (b.hours || 0) - (a.hours || 0), name: (a, b) => String(a.name).localeCompare(String(b.name), "ru") }[mode];
  return by ? list.sort(by) : list;
}

/** Ближайшая распродажа: «Осенняя распродажа · примерно через 46 дн.» / «идёт сейчас». dates — YYYY-MM-DD. */
export function saleView(s, now = Date.now()) {
  if (!s) return "";
  const a = Date.parse(s.start + "T00:00:00Z"), b = Date.parse(s.end + "T23:59:59Z");
  if (now >= a && now <= b) return `${s.name} · идёт сейчас`;
  const d = Math.ceil((a - now) / 86400000);
  const when = d <= 0 ? "скоро" : d === 1 ? "завтра" : `через ${d} дн.`;
  return `${s.name} · ${s.approx ? "примерно " : ""}${when}`;
}

/** Метки совместимости для карточки игры: [{ text, cls }] из полей /games/app и /games/app/{id}/extra. */
export function badgesOf(d, extra) {
  const out = [];
  const tier = extra && extra.proton && extra.proton.tier;
  const tcls = { platinum: "ok", gold: "ok", silver: "mid", bronze: "mid", borked: "bad" };
  if (tier) out.push({ text: `ProtonDB: ${tier}`, cls: tcls[tier] || "mid" });
  const deck = extra && extra.deck;
  if (deck) out.push({ text: { verified: "Steam Deck: проверено", playable: "Steam Deck: играбельно", unsupported: "Steam Deck: не поддерживается" }[deck] || "Steam Deck", cls: deck === "verified" ? "ok" : deck === "playable" ? "mid" : "bad" });
  if (d.early_access) out.push({ text: "Ранний доступ", cls: "mid" });
  if (d.family_sharing) out.push({ text: "Семейный доступ", cls: "ok" });
  if (d.cards) out.push({ text: "Карточки", cls: "" });
  if (d.dlc) out.push({ text: `DLC: ${d.dlc}`, cls: "" });
  return out;
}

/** Строка прогресса достижений: «12 из 40 · 30%». */
export function achSummary(a) {
  if (!a || !a.total) return "";
  return `${a.done} из ${a.total} · ${Math.round((a.done / a.total) * 100)}%`;
}

/** «TF_PLAYER_KILLS» → «Player kills»: читаемое имя статистики игры. */
export function statLabel(name) {
  const w = String(name || "").replace(/^[A-Z]{1,4}_(?=[A-Z])/, "").replace(/[_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return w ? w[0].toUpperCase() + w.slice(1) : "—";
}

/** Состояние друга для списка: { text, cls } — «играет в X», «в сети», «не в сети». */
export function friendState(f) {
  if (f && f.game) return { text: `играет в ${f.game}`, cls: "play" };
  if (f && f.online) return { text: "в сети", cls: "on" };
  return { text: "не в сети", cls: "off" };
}

/** Опыт до следующего уровня Steam: { pct, left } по полям badges из /games/profile; нет данных — null. */
export function xpProgress(b) {
  if (!b || b.xp == null || b.xp_base == null || b.xp_to_next == null) return null;
  const span = b.xp - b.xp_base + b.xp_to_next;
  if (span <= 0) return null;
  return { pct: Math.max(0, Math.min(100, Math.round(((b.xp - b.xp_base) / span) * 100))), left: b.xp_to_next };
}

/** Итог отзывов: { pct, text } по полям /games/app/{id}/reviews; нет отзывов — null. */
export function reviewSummary(r) {
  const total = r && Number(r.total);
  if (!total) return null;
  const pct = Math.round((Number(r.positive || 0) / total) * 100);
  const word = total < 10 ? "мало отзывов" : pct >= 95 ? "крайне положительные" : pct >= 80 ? "очень положительные" : pct >= 70 ? "в основном положительные" : pct >= 40 ? "смешанные" : pct >= 20 ? "в основном отрицательные" : "крайне отрицательные";
  return { pct, text: `${word} · ${pct}% из ${new Intl.NumberFormat("ru-RU").format(total).replace(/ | /g, " ")}` };
}

/** Круглые значения для оси: до n+1 делений между lo и hi. */
export function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Короткая запись числа для подписей осей: 1 244 028 → «1,2 млн», 12 500 → «12,5 тыс.». */
export function fmtCompact(n) {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const num = (v, d) => String(+v.toFixed(d)).replace(".", ",");
  if (a >= 1e6) return `${num(n / 1e6, a >= 1e7 ? 0 : 1)} млн`;
  if (a >= 1e4) return `${num(n / 1e3, 0)} тыс.`;
  if (a >= 1e3) return `${num(n / 1e3, 1)} тыс.`;
  return num(n, 2);
}

/**
 * График ряда с осями: points = [{ts, v, d?}] → { line, area, yTicks:[{y,v}], xTicks:[{x,ts}], pts:[{x,y,ts,v,d}], zones:[{x,w}], lo, hi, t0, t1, plot }.
 * step — ступенчатая линия (цена держится до следующего изменения), zones — участки со скидкой (d > 0).
 */
export function seriesChart(points, o = {}) {
  const { w = 640, h = 170, padL = 56, padR = 12, padT = 12, padB = 24, step = false, now = Date.now() / 1000, zeroBase = false } = o;
  const pts = (points || []).filter(p => Number.isFinite(p.v) && Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);
  if (!pts.length) return null;
  const t0 = pts[0].ts;
  let t1 = step ? Math.max(now, pts[pts.length - 1].ts + 1) : pts[pts.length - 1].ts;
  if (t1 <= t0) t1 = t0 + 1;
  let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
  if (hi === lo) { const m = Math.abs(hi) || 1; hi += m * 0.15; lo = zeroBase ? 0 : Math.max(0, lo - m * 0.15); }
  else { const pad = (hi - lo) * 0.08; hi += pad; lo = zeroBase ? 0 : Math.max(0, lo - pad); }
  const iw = w - padL - padR, ih = h - padT - padB;
  const x = t => padL + ((t - t0) / (t1 - t0)) * iw;
  const y = v => padT + (1 - (v - lo) / (hi - lo)) * ih;
  const f = n => n.toFixed(1);
  let line = `M${f(x(pts[0].ts))},${f(y(pts[0].v))}`;
  for (let i = 1; i < pts.length; i++) line += step ? ` H${f(x(pts[i].ts))} V${f(y(pts[i].v))}` : ` L${f(x(pts[i].ts))},${f(y(pts[i].v))}`;
  if (step) line += ` H${f(x(t1))}`;
  const xEnd = step ? x(t1) : x(pts[pts.length - 1].ts);
  const area = `${line} V${f(padT + ih)} H${f(x(t0))} Z`;
  const zones = [];
  pts.forEach((p, i) => {
    if (p.d > 0) { const xs = x(p.ts), xe = x(i + 1 < pts.length ? pts[i + 1].ts : t1); zones.push({ x: +xs.toFixed(1), w: +Math.max(2, xe - xs).toFixed(1) }); }
  });
  const yTicks = niceTicks(lo, hi, 4).map(v => ({ y: +y(v).toFixed(1), v }));
  const xTicks = [0, 1, 2, 3].map(i => { const ts = t0 + ((t1 - t0) * i) / 3; return { x: +x(ts).toFixed(1), ts }; });
  return { line, area, yTicks, xTicks, zones, lo, hi, t0, t1, w, h, plot: { l: padL, r: w - padR, t: padT, b: padT + ih }, xEnd: +xEnd.toFixed(1),
    pts: pts.map(p => ({ x: +x(p.ts).toFixed(1), y: +y(p.v).toFixed(1), ts: p.ts, v: p.v, d: p.d || 0 })) };
}

/** Точка под курсором: у ступенчатого графика — последняя слева от курсора, у обычного — ближайшая. */
export function pointAt(pts, px, step = false) {
  if (!pts || !pts.length) return null;
  if (step) {
    let best = pts[0];
    for (const p of pts) { if (p.x <= px) best = p; else break; }
    return best;
  }
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.x - px) < Math.abs(best.x - px)) best = p;
  return best;
}

/** Статус игры в желаемом: { kind, text } — цель достигнута / скидка / цена / скоро / нет цены. */
export function wishStatus(w, now = Date.now() / 1000) {
  if (w.hit) return { kind: "hit", text: "цель достигнута" };
  const p = w.price;
  if (p && p.final > 0) return p.discount > 0 ? { kind: "sale", text: `скидка −${p.discount}%` } : { kind: "price", text: "без скидки" };
  if (w.rel && w.rel > now) return { kind: "soon", text: `выйдет ${shortDate(w.rel)}` };
  if (w.released === false) return { kind: "soon", text: "дата выхода не объявлена" };
  return { kind: "noprice", text: "нет цены в вашем регионе или бесплатная" };
}

/** Фильтр желаемого: all | sale | hit | soon | noprice и поиск по названию. */
export function wishFilter(items, mode = "all", q = "", now = Date.now() / 1000) {
  const ql = String(q || "").trim().toLowerCase();
  return (items || []).filter(w => {
    if (ql && !String(w.name || "").toLowerCase().includes(ql)) return false;
    if (mode === "all") return true;
    const st = wishStatus(w, now).kind;
    if (mode === "sale") return st === "sale" || st === "hit" && w.price && w.price.discount > 0;
    return st === mode;
  });
}

/** Подпись дня календаря: «2026-10-13» → { dow: "Вт", date: "13.10" } (без часовых поясов). */
export function dayLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) return { dow: "", date: String(dateStr || "") };
  const dow = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return { dow, date: `${m[3]}.${m[2]}` };
}

/** Разбивка на страницы по per штук (для каруселей). */
export function chunk(list, per) {
  const out = [];
  for (let i = 0; i < (list || []).length; i += per) out.push(list.slice(i, i + per));
  return out;
}

// ---- даты календаря: строки «YYYY-MM-DD», всё в UTC, без часовых поясов ----
const DAY = 86400000;
const parseDay = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || "")); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const fmtDay = ms => new Date(ms).toISOString().slice(0, 10);

/** Сдвиг даты на n дней. */
export function addDays(d, n) { return fmtDay(parseDay(d) + n * DAY); }

/** Понедельник недели, в которую попадает дата. */
export function mondayOf(d) { const t = parseDay(d); const dow = new Date(t).getUTCDay(); return fmtDay(t - ((dow + 6) % 7) * DAY); }

/** Номер недели по ISO 8601. */
export function isoWeek(d) {
  const t = parseDay(d);
  const thu = t + (3 - ((new Date(t).getUTCDay() + 6) % 7)) * DAY;
  const y = new Date(thu).getUTCFullYear();
  const jan4 = Date.UTC(y, 0, 4);
  const w1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  return Math.round((thu - w1) / (7 * DAY)) + 1;
}

/** Недели месяца «YYYY-MM» целиком, по 7 дат с понедельника (дни соседних месяцев включены). */
export function monthWeeks(ym) {
  const first = `${ym}-01`;
  const t = parseDay(first);
  const d0 = new Date(t);
  const last = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0);
  const out = [];
  for (let w = mondayOf(first); parseDay(w) <= last; w = addDays(w, 7)) out.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)));
  return out;
}

/** n недель подряд, начиная с недели, в которую попадает дата. */
export function rollingWeeks(d, n = 6) {
  const m = mondayOf(d);
  return Array.from({ length: n }, (_, k) => Array.from({ length: 7 }, (_, i) => addDays(m, k * 7 + i)));
}

/** Короткое название месяца и год для вкладки: «2026-10» → «Окт ’26». */
export function monthTab(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"][m - 1]} ’${String(y).slice(2)}`;
}

/** Следующие n месяцев «YYYY-MM», начиная с месяца даты. */
export function nextMonths(d, n = 8) {
  let [y, m] = d.slice(0, 7).split("-").map(Number);
  return Array.from({ length: n }, () => { const s = `${y}-${String(m).padStart(2, "0")}`; m++; if (m > 12) { m = 1; y++; } return s; });
}

/** «1 друг», «2 друга», «5 друзей»: forms — [одна, две-четыре, много]. */
export function ruPlural(n, forms) {
  const a = Math.abs(Number(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  return b >= 2 && b <= 4 ? forms[1] : forms[2];
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, mx ? d / mx : 0, mx];
}

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6), p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const hex = ([r, g, b]) => "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
const lumOf = ([h, s, v]) => { const [r, g, b] = hsvToRgb(h, s, v); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

/** Тёплая запасная палитра по оттенку (0–360): когда арт прочитать нельзя. */
export function huePalette(hue) {
  const h = (((Number(hue) || 0) % 360) + 360) % 360 / 360;
  const c = [[(h + 0.05) % 1, 0.62, 0.84], [h, 0.7, 0.74], [(h + 0.95) % 1, 0.78, 0.6]];
  return { c1: hex(hsvToRgb(...c[0])), c2: hex(hsvToRgb(...c[1])), c3: hex(hsvToRgb(...c[2])), base: hex(hsvToRgb(c[2][0], 0.72, 0.17)) };
}

/** Три главных цвета арта для карточки героя: от самого светлого (верх) к самому тёмному (низ) и тёмная основа.
 *  px — RGBA-пиксели уменьшенной копии (например 64×22). Серые и тёмные пиксели не считаются; оттенки берутся разными. */
export function heroPalette(px, w, h) {
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let tot = 0;
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (px[i * 4 + 3] < 200) continue;
    const [hh, s, v] = rgbToHsv(r, g, b);
    if (v < 0.14 || s < 0.14) continue;
    const wt = s ** 1.2 * v ** 0.9, bn = bins[Math.min(11, Math.floor(hh * 12))];
    bn.w += wt; bn.r += r * wt; bn.g += g * wt; bn.b += b * wt; tot += wt;
  }
  const dist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 12 - d); };
  const picks = [];
  for (const x of bins.map((b, k) => ({ b, k })).filter(x => x.b.w > 0).sort((p, q) => q.b.w - p.b.w)) {
    if (x.b.w > tot * 0.04 && picks.every(p => dist(p.k, x.k) >= 2)) picks.push(x);
    if (picks.length === 3) break;
  }
  if (!picks.length) return { c1: "#d6b9a4", c2: "#9a6a54", c3: "#5a2f28", base: "#1c0e0b" };
  const cols = picks.map(x => { const [hh, s, v] = rgbToHsv(x.b.r / x.b.w, x.b.g / x.b.w, x.b.b / x.b.w); return [hh, Math.max(s, 0.7), Math.min(0.95, Math.max(v, 0.74))]; });
  while (cols.length < 3) { const [hh, s, v] = cols[cols.length - 1]; cols.push([(hh + (cols.length === 1 ? 0.06 : 0.94)) % 1, s, Math.max(0.7, v - 0.08)]); }
  cols.sort((a, b) => lumOf(b) - lumOf(a));
  [0.92, 0.82, 0.72].forEach((t, i) => { cols[i][2] = Math.max(cols[i][2], t); });   // сверху светлее, к низу глубже, как в карточке-образце
  return { c1: hex(hsvToRgb(...cols[0])), c2: hex(hsvToRgb(...cols[1])), c3: hex(hsvToRgb(...cols[2])), base: hex(hsvToRgb(cols[2][0], 0.72, 0.17)) };
}
