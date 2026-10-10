import assert from "node:assert/strict";
import { fmtPrice, priceView, filterDeals, sparkline, fmtHours, isSteamLaunchUrl, initials2, imageCandidates, hueOf, fmtNum, shortDate, deltaView, lineChart, miniLine, groupByDate, untilText, priceChart, pctText, alertText, sortWishlist, sortLibrary, saleView, badgesOf, achSummary, statLabel, friendState, xpProgress, reviewSummary, niceTicks, fmtCompact, seriesChart, pointAt, wishStatus, wishFilter, dayLabel, chunk, addDays, mondayOf, isoWeek, monthWeeks, rollingWeeks, monthTab, nextMonths } from "../src/app/games-core.js";

// цены
assert.equal(fmtPrice(null), "—");
assert.equal(fmtPrice(0), "Бесплатно");
assert.equal(fmtPrice({ final: 0, currency: "USD" }), "Бесплатно");
assert.match(fmtPrice({ final: 2880, currency: "KZT" }), /2\s?880/);
assert.match(fmtPrice({ final: 5.69, currency: "USD" }), /5,69/);
assert.equal(fmtPrice({ final: 10, currency: "???" }), "10 ???", "неизвестная валюта не роняет форматирование");

const sale = priceView({ final: 5, initial: 10, discount: 50, currency: "USD" });
assert.equal(sale.badge, "−50%");
assert.equal(sale.sale, true);
assert.ok(sale.old.includes("10"));
const full = priceView({ final: 10, initial: 10, discount: 0, currency: "USD" });
assert.equal(full.badge, "");
assert.equal(full.old, "");
assert.equal(priceView(null).now, "—");

// скидки
const items = [
  { name: "B", price: { final: 20, initial: 40, discount: 50 } },
  { name: "A", price: { final: 8, initial: 10, discount: 20 } },
  { name: "C", price: { final: 3, initial: 12, discount: 75 } },
  { name: "D", price: null },
];
assert.deepEqual(filterDeals(items).map(i => i.name), ["C", "B", "A"], "по скидке, без позиций без цены");
assert.deepEqual(filterDeals(items, { minDiscount: 50 }).map(i => i.name), ["C", "B"]);
assert.deepEqual(filterDeals(items, { mode: "price" }).map(i => i.name), ["C", "A", "B"]);
assert.deepEqual(filterDeals(items, { mode: "name" }).map(i => i.name), ["A", "B", "C"]);
assert.deepEqual(filterDeals(items, { maxPrice: 10 }).map(i => i.name), ["C", "A"]);
assert.deepEqual(filterDeals(null), []);

// график истории
assert.equal(sparkline([{ ts: 1, price: 5 }]), null, "одной точки мало");
assert.equal(sparkline(null), null);
const sp = sparkline([{ ts: 1000, price: 10 }, { ts: 2000, price: 5 }, { ts: 3000, price: 10 }], 300, 80);
assert.ok(sp.d.startsWith("M") && sp.d.includes("H") && sp.d.includes("V"));
assert.equal(sp.min, 5);
assert.equal(sp.max, 10);
assert.equal(sp.last, 10);
assert.equal(sp.count, 3);
const flat = sparkline([{ ts: 1, price: 7 }, { ts: 5, price: 7 }]);
assert.equal(flat.min, flat.max, "ровная цена не делит на ноль");
assert.ok(!flat.d.includes("NaN"));

// часы
assert.equal(fmtHours(0), "—");
assert.equal(fmtHours(0.5), "30 мин");
assert.equal(fmtHours(3.25), "3.3 ч");
assert.equal(fmtHours(42.4), "42 ч");

// безопасность адреса запуска: только steam://run/<цифры>
assert.equal(isSteamLaunchUrl("steam://run/620"), true);
for (const bad of ["steam://run/620 --evil", "steam://run/abc", "steam://store/620", "https://evil.example", "steam://run/620/-applaunch", "", null, "steam://run/12345678901"]) {
  assert.equal(isSteamLaunchUrl(bad), false, String(bad));
}

assert.equal(initials2("Иван Петров"), "ИП");
assert.equal(initials2("lord"), "L");
assert.equal(initials2(""), "?");

// запасные адреса обложек
const c = imageCandidates(4001890, "https://x/primary.jpg");
assert.equal(c[0], "https://x/primary.jpg", "основной адрес первым");
assert.ok(c.length >= 4 && new Set(c).size === c.length, "без повторов");
assert.ok(c.every(u => u.startsWith("https://")));
const legacy = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/header.jpg";
assert.equal(imageCandidates(620, legacy).filter(u => u === legacy).length, 1, "основной адрес не дублируется среди запасных");
assert.deepEqual(imageCandidates("abc", "u"), ["u"], "неверный appid — только основной");
assert.deepEqual(imageCandidates(0, ""), []);
assert.equal(hueOf("Portal"), hueOf("Portal"), "оттенок стабилен");
assert.ok(hueOf("Portal") >= 0 && hueOf("Portal") < 360);
assert.notEqual(hueOf("A"), hueOf("B"));

// чарты
assert.equal(fmtNum(936814), "936 814");
assert.equal(fmtNum(0), "0");
assert.equal(fmtNum(null), "—");
assert.equal(fmtNum("abc"), "—");
assert.deepEqual(deltaView(121, false), { text: "▲121", cls: "up" });
assert.deepEqual(deltaView(-5, false), { text: "▼5", cls: "down" });
assert.deepEqual(deltaView(0, false), { text: "=", cls: "same" });
assert.deepEqual(deltaView(null, true), { text: "NEW", cls: "new" });
assert.equal(shortDate(0), "—");
assert.match(shortDate(1792731600), /2026/);

const lc = lineChart([{ ts: 100, n: 10 }, { ts: 200, n: 30 }, { ts: 300, n: 20 }]);
assert.ok(lc.line.startsWith("M") && lc.area.endsWith("Z"));
assert.equal(lc.min, 10); assert.equal(lc.max, 30); assert.equal(lc.t0, 100); assert.equal(lc.t1, 300);
assert.equal(lineChart([{ ts: 1, n: 1 }]), null);
assert.equal(lineChart(null), null);
const flatLc = lineChart([{ ts: 1, n: 5 }, { ts: 2, n: 5 }]);
assert.ok(!flatLc.line.includes("NaN"), "ровный график не делит на ноль");
assert.equal(miniLine([1, 2]), "");
assert.ok(miniLine([1, 3, 2, 5]).startsWith("M"));
assert.ok(!miniLine([4, 4, 4]).includes("NaN"));

const DAY = 86400;
const g = groupByDate([{ date: 3 * DAY }, { date: null }, { date: 2 * DAY }, { date: 2 * DAY + 3600 }]);
assert.equal(g.length, 3, "два разных дня и «без даты»");
assert.equal(g[0].items.length, 2, "два выхода в один день — одна группа");
assert.ok(g[0].ts < g[1].ts, "по возрастанию даты");
assert.equal(g[g.length - 1].key, "unknown", "без даты — в конце");
assert.equal(groupByDate(null).length, 0);
assert.equal(untilText(0), "");
assert.equal(untilText(1000, 1000), "сегодня");
assert.equal(untilText(1000 + 86400, 1000), "завтра");
assert.equal(untilText(1000 + 5 * 86400, 1000), "через 5 дн.");

// график цены
assert.equal(priceChart([]), null);
assert.equal(priceChart(null), null);
const one = priceChart([{ ts: 1000, price: 50, discount: 0 }], 320, 90, 4, 2000);
assert.ok(one && !one.line.includes("NaN"), "одна точка рисуется ровной линией");
assert.equal(one.sales.length, 0);
assert.equal(one.min, 50); assert.equal(one.max, 50);
const pc = priceChart([{ ts: 1000, price: 100, discount: 0 }, { ts: 2000, price: 60, discount: 40 }, { ts: 3000, price: 100, discount: 0 }], 320, 90, 4, 4000);
assert.equal(pc.sales.length, 1, "один участок скидки");
assert.ok(pc.sales[0].w >= 2 && pc.sales[0].x > 0);
assert.equal(pc.min, 60); assert.equal(pc.max, 100); assert.equal(pc.t0, 1000);
assert.ok(pc.area.endsWith("Z"));
assert.deepEqual(pctText(-36), { text: "−36%", cls: "up" });
assert.deepEqual(pctText(116), { text: "+116%", cls: "down" });
assert.deepEqual(pctText(0), { text: "=", cls: "same" });
assert.deepEqual(pctText(null), { text: "", cls: "same" });

const at = alertText({ kind: "target", name: "Hades", price: { final: 1200, initial: 2400, discount: 50, currency: "KZT" } });
assert.ok(at.title.includes("Hades") && at.title.includes("цели"));
assert.match(at.body, /1\s?200/);
const as = alertText({ kind: "sale", name: "Hades", price: { final: 1200, initial: 2400, discount: 50, currency: "KZT" } });
assert.ok(as.title.includes("−50%") && /2\s?400/.test(as.body), "скидка: новая и старая цена");
assert.ok(alertText({ kind: "sale", price: null }).title.includes("Игра"), "без названия и цены не падает");

// фильтры по отзывам
const rv = [{ name: "A", price: { final: 1, initial: 2, discount: 50 }, pct: 90, reviews: 1000 }, { name: "B", price: { final: 1, initial: 2, discount: 50 }, pct: 60, reviews: 30 }, { name: "C", price: { final: 1, initial: 2, discount: 50 } }];
assert.deepEqual(filterDeals(rv, { minPct: 80 }).map(i => i.name), ["A"]);
assert.deepEqual(filterDeals(rv, { minReviews: 50 }).map(i => i.name), ["A"]);
assert.equal(filterDeals(rv).length, 3, "без порогов ничего не отсеивается");

// желаемое
const wl = [
  { name: "Далеко", price: { final: 200, discount: 0 }, target: 100, hit: false },
  { name: "Достигнута", price: { final: 50, discount: 50 }, target: 100, hit: true },
  { name: "Без цели", price: { final: 10, discount: 80 }, target: null, hit: false },
  { name: "Близко", price: { final: 110, discount: 10 }, target: 100, hit: false },
  { name: "Без цены", price: null, target: 100, hit: false },
];
assert.deepEqual(sortWishlist(wl).map(i => i.name), ["Достигнута", "Близко", "Далеко", "Без цели", "Без цены"]);
assert.equal(sortWishlist(wl, "discount")[0].name, "Без цели");
assert.equal(sortWishlist(wl, "name")[0].name, "Без цели");
assert.equal(sortWishlist(null).length, 0);

// библиотека
const lb = [{ name: "b", hours: 5 }, { name: "a", hours: 0 }, { name: "c", hours: 50 }];
assert.deepEqual(sortLibrary(lb, "hours").map(g => g.name), ["c", "b", "a"]);
assert.deepEqual(sortLibrary(lb, "name").map(g => g.name), ["a", "b", "c"]);
assert.deepEqual(sortLibrary(lb, "recent", true).map(g => g.name), ["a"]);
assert.deepEqual(sortLibrary(lb).map(g => g.name), ["b", "a", "c"], "исходный порядок не меняется");

// распродажи
const sl = { name: "Осенняя", start: "2026-11-25", end: "2026-12-02", approx: true };
assert.match(saleView(sl, Date.parse("2026-10-10T00:00:00Z")), /примерно через 46 дн/);
assert.match(saleView(sl, Date.parse("2026-11-28T00:00:00Z")), /идёт сейчас/);
assert.equal(saleView(null), "");

// метки и достижения
const bd = badgesOf({ early_access: true, family_sharing: true, cards: false, dlc: 3 }, { proton: { tier: "gold" }, deck: "verified" });
assert.deepEqual(bd.map(b => b.text), ["ProtonDB: gold", "Steam Deck: проверено", "Ранний доступ", "Семейный доступ", "DLC: 3"]);
assert.deepEqual(badgesOf({}, null), []);
assert.equal(achSummary({ done: 12, total: 40 }), "12 из 40 · 30%");
assert.equal(achSummary({ done: 0, total: 0 }), "");

// статистика, друзья, опыт
assert.equal(statLabel("TF_PLAYER_KILLS"), "Player kills");
assert.equal(statLabel("total_playtime"), "Total playtime");
assert.equal(statLabel("killsHeadshot"), "Kills headshot");
assert.equal(statLabel(""), "—");
assert.deepEqual(friendState({ game: "Dota 2", online: true }), { text: "играет в Dota 2", cls: "play" });
assert.deepEqual(friendState({ online: true }), { text: "в сети", cls: "on" });
assert.deepEqual(friendState({}), { text: "не в сети", cls: "off" });
assert.deepEqual(xpProgress({ xp: 20821, xp_base: 20400, xp_to_next: 179 }), { pct: 70, left: 179 });
assert.equal(xpProgress(null), null);
assert.equal(xpProgress({ xp: 5, xp_base: null, xp_to_next: 1 }), null);

// отзывы
assert.equal(reviewSummary(null), null);
assert.equal(reviewSummary({ total: 0 }), null);
assert.equal(reviewSummary({ positive: 77740, total: 87459 }).pct, 89);
assert.match(reviewSummary({ positive: 77740, total: 87459 }).text, /очень положительные · 89% из 87\s459/);
assert.match(reviewSummary({ positive: 2, total: 5 }).text, /мало отзывов/);
assert.match(reviewSummary({ positive: 10, total: 100 }).text, /крайне отрицательные/);

// оси и графики 2.0
assert.deepEqual(niceTicks(0, 100, 4), [0, 20, 40, 60, 80, 100]);
assert.deepEqual(niceTicks(112, 112), [112]);
assert.equal(fmtCompact(1244028), "1,2 млн");
assert.equal(fmtCompact(12500), "13 тыс.");
assert.equal(fmtCompact(758), "758");
const flatChart = seriesChart([{ ts: 1000, v: 112, d: 0 }], { step: true, now: 2000 });
assert.ok(flatChart.lo < 112 && flatChart.hi > 112, "плоская цена не прилипает к краям");
assert.ok(flatChart.pts.length === 1 && !flatChart.line.includes("NaN"));
const sc = seriesChart([{ ts: 1000, v: 100, d: 0 }, { ts: 2000, v: 60, d: 40 }, { ts: 3000, v: 100, d: 0 }], { step: true, now: 4000 });
assert.ok(sc.line.startsWith("M") && sc.line.includes(" H") && sc.line.includes(" V"), "ступени");
assert.equal(sc.zones.length, 1);
assert.ok(sc.yTicks.length >= 3 && sc.xTicks.length === 4);
assert.ok(sc.pts[1].y > sc.pts[0].y, "ниже цена — ниже на графике (y больше)");
const smooth = seriesChart([{ ts: 1, v: 5 }, { ts: 2, v: 9 }], { zeroBase: true });
assert.equal(smooth.lo, 0);
assert.ok(smooth.line.includes(" L") && !smooth.line.includes(" V"));
assert.equal(seriesChart([]), null);
assert.equal(pointAt(sc.pts, sc.pts[1].x + 1, true).ts, 2000, "ступень: последняя слева");
assert.equal(pointAt(sc.pts, sc.pts[2].x - 1, false).ts, 3000, "линия: ближайшая");
assert.equal(pointAt([], 5), null);

// желаемое: статусы и фильтры
const NOW = 1790000000;
assert.equal(wishStatus({ hit: true }, NOW).kind, "hit");
assert.equal(wishStatus({ price: { final: 100, discount: 30 } }, NOW).kind, "sale");
assert.equal(wishStatus({ price: { final: 100, discount: 0 } }, NOW).kind, "price");
assert.equal(wishStatus({ price: null, rel: NOW + 86400 * 5 }, NOW).kind, "soon");
assert.equal(wishStatus({ price: null, released: false }, NOW).kind, "soon");
assert.equal(wishStatus({ price: null, released: true }, NOW).kind, "noprice");
const wlist = [{ name: "Alpha", price: { final: 10, discount: 50 } }, { name: "Beta", price: null, rel: NOW + 99999 }, { name: "Gamma", price: null, released: true }];
assert.deepEqual(wishFilter(wlist, "sale", "", NOW).map(w => w.name), ["Alpha"]);
assert.deepEqual(wishFilter(wlist, "soon", "", NOW).map(w => w.name), ["Beta"]);
assert.deepEqual(wishFilter(wlist, "all", "gam", NOW).map(w => w.name), ["Gamma"]);
assert.equal(wishFilter(null).length, 0);

// календарь
assert.deepEqual(dayLabel("2026-10-13"), { dow: "Вт", date: "13.10" });
assert.deepEqual(dayLabel("2026-10-19"), { dow: "Пн", date: "19.10" });
assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
assert.deepEqual(chunk(null, 3), []);

// даты календаря релизов
assert.equal(addDays("2026-10-30", 3), "2026-11-02");
assert.equal(addDays("2026-03-01", -1), "2026-02-28");
assert.equal(mondayOf("2026-10-11"), "2026-10-05", "воскресенье → понедельник той же недели");
assert.equal(mondayOf("2026-10-05"), "2026-10-05");
assert.equal(isoWeek("2026-10-10"), 41);
assert.equal(isoWeek("2026-10-05"), 41);
assert.equal(isoWeek("2026-01-01"), 1);
assert.equal(isoWeek("2027-01-01"), 53, "1 января 2027 — ещё 53-я неделя 2026");
const mw = monthWeeks("2026-10");
assert.equal(mw.length, 5);
assert.deepEqual(mw[0][0], "2026-09-28");
assert.deepEqual(mw[4][6], "2026-11-01");
assert.ok(mw.every(w => w.length === 7));
const rw = rollingWeeks("2026-10-10", 3);
assert.equal(rw.length, 3);
assert.equal(rw[0][0], "2026-10-05");
assert.equal(rw[2][6], "2026-10-25");
assert.equal(monthTab("2026-10"), "Окт ’26");
assert.deepEqual(nextMonths("2026-11-15", 3), ["2026-11", "2026-12", "2027-01"]);

import { reviewTone, rowPriceHtml, rowsHtml, panelHtml, tabsHtml } from "../src/app/games-tabs.js";
assert.equal(reviewTone(90, 100), "pos");
assert.equal(reviewTone(55, 100), "mix");
assert.equal(reviewTone(20, 100), "neg");
assert.equal(reviewTone(90, 0), "none");
assert.match(rowPriceHtml({ free: true }), /Бесплатно/);
assert.equal(rowPriceHtml({ free: false, price: null }), "");
assert.match(rowPriceHtml({ price: { final: 704, initial: 880, discount: 20, currency: "INR" } }), /gm-st-disc/);
const trItems = [{ appid: 1, name: "A<b>", cap: "x", tags: ["t1", "t2"], when: "Дата выпуска: 9 окт. 2026 г.", free: true, label: "Очень положительные", pct: 90, reviews: 96, shots: ["s1", "s2"] }];
assert.ok(!rowsHtml(trItems, 0, () => "").includes("<b>A<b>"));
assert.match(panelHtml(trItems[0], u => u), /Очень положительные/);
assert.match(tabsHtml({ tab: "top", free: true, owned: false, more: false, sel: 0 }, trItems, () => "", u => u), /data-sopt="owned"/);
assert.match(tabsHtml({ tab: "new" }, [], () => "", u => u), /ничего нет/);

import { ruPlural, rgbToHsv, hsvToRgb, heroPalette, huePalette, logoHasTransparentEdge } from "../src/app/games-core.js";
import { heroButtonLabel, heroPriceHtml, heroCardHtml, heroShotsHtml, heroFriendsHtml, heroSlideHtml, heroMarkup, heroLogoUrl } from "../src/app/games-hero.js";
assert.equal(ruPlural(1, ["друг", "друга", "друзей"]), "друг");
assert.equal(ruPlural(3, ["друг", "друга", "друзей"]), "друга");
assert.equal(ruPlural(5, ["друг", "друга", "друзей"]), "друзей");
assert.equal(ruPlural(11, ["друг", "друга", "друзей"]), "друзей");
assert.equal(ruPlural(21, ["друг", "друга", "друзей"]), "друг");
const rt = hsvToRgb(...rgbToHsv(200, 90, 30));
assert.ok(Math.abs(rt[0] - 200) <= 1 && Math.abs(rt[1] - 90) <= 1 && Math.abs(rt[2] - 30) <= 1);
// арт из оранжевых, синих и красных пятен даёт три разных оттенка, от светлого к тёмному
const px = new Uint8ClampedArray(30 * 10 * 4);
const paint = (from, to, r, g, b) => { for (let i = from; i < to; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; } };
paint(0, 100, 240, 170, 40); paint(100, 200, 40, 90, 230); paint(200, 300, 190, 20, 30);
const pal = heroPalette(px, 30, 10);
for (const k of ["c1", "c2", "c3", "base"]) assert.match(pal[k], /^#[0-9a-f]{6}$/);
assert.equal(new Set([pal.c1, pal.c2, pal.c3]).size, 3);
// серый тёмный арт: запасная тёплая палитра
const gray = new Uint8ClampedArray(20 * 4).fill(40);
for (let i = 0; i < 20; i++) gray[i * 4 + 3] = 255;
assert.match(heroPalette(gray, 20, 1).c1, /^#[0-9a-f]{6}$/);
assert.match(huePalette(200).c2, /^#[0-9a-f]{6}$/);
assert.notEqual(huePalette(20).c1, huePalette(200).c1);
// разметка героя
const hh = { appid: 1332010, name: "Stray <i>", desc: "Кот & город", tags: ["Кошки", "Приключение"], hero: "https://x/h.jpg", shots: ["a.jpg", "b.jpg", "c.jpg"], os: ["windows"], price: { final: 100, initial: 200, discount: 50, currency: "INR" } };
assert.equal(heroButtonLabel(hh, true), "В вашей библиотеке");
assert.match(heroButtonLabel(hh, false), /−50%/);
assert.equal(heroButtonLabel({ ...hh, price: { final: 100, initial: 100, discount: 0 } }, false), "Подробнее");
assert.match(heroPriceHtml({ price: { final: 0, initial: 0, discount: 0 } }), /Бесплатно/);
assert.match(heroPriceHtml(hh), /gm-hx-off/);
assert.ok(!heroCardHtml(hh, false).includes("<i>"));
assert.match(heroCardHtml(hh, false), /gm-hx-os/);
assert.ok(!heroCardHtml({ ...hh, os: [] }, false).includes("gm-hx-os"));
assert.equal((heroShotsHtml(hh, u => u).match(/<button/g) || []).length, 2);
assert.equal(heroFriendsHtml({ count: 0, list: [] }, u => u), "");
assert.match(heroFriendsHtml({ count: 4, list: [{ name: "A", avatar: "a" }] }, u => u), /4 друга/);
assert.match(heroSlideHtml(hh, 0, u => u), /gm-hx-slide on/);
// первые два слайда с картинками сразу, остальные ждут (data-src), чтобы 12 слайдов не грузили 24 файла разом
assert.match(heroSlideHtml(hh, 1, u => u), /class="gm-hx-bg" src=/);
assert.match(heroSlideHtml(hh, 2, u => u), /class="gm-hx-bg" data-src=/);
assert.ok(!/class="gm-hx-bg" src=/.test(heroSlideHtml(hh, 5, u => u)));
assert.match(heroSlideHtml(hh, 5, u => u), /class="gm-hx-logo" crossorigin="anonymous" data-src=/);
// подпись места в топе продаж
assert.match(heroCardHtml({ ...hh, rank: 4 }, false), /На 4-м месте во всём мире/);
assert.ok(!heroCardHtml({ ...hh, rank: null }, false).includes("gm-hx-rank"));
// рекомендованный слайд: причина вместо места в топе
assert.match(heroCardHtml({ ...hh, rank: null, why: "Похоже на игры, в которые вы играли: Sand" }, false), /Рекомендовано вам[^]*Sand/);
assert.ok(!heroCardHtml({ ...hh, rank: null, why: "x" }, false).includes("Популярный товар"));
assert.match(heroCardHtml({ ...hh, rank: 3, why: null }, false), /Популярный товар/);
assert.ok(!heroCardHtml({ ...hh, rank: 3, why: "<b>x</b>" }, false).includes("<b>x</b>"));
assert.ok(heroLogoUrl(1332010).endsWith("/1332010/logo.png"));
const mk = heroMarkup([hh, { ...hh, appid: 2 }], u => u);
assert.equal((mk.match(/gm-hx-slide/g) || []).length, 2);
assert.equal((mk.match(/data-shero=/g) || []).length, 2);
assert.equal(heroMarkup([], u => u), "");
assert.match(heroSlideHtml(hh, 0, u => u), /crossorigin="anonymous"/);
// логотип: прозрачные края — настоящий, непрозрачная рамка — картинка с фоном
const lg = (alphaEdge, alphaMid) => { const w = 8, h = 8, a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[(y * w + x) * 4 + 3] = (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? alphaEdge : alphaMid; return a; };
assert.equal(logoHasTransparentEdge(lg(0, 255), 8, 8), true);
assert.equal(logoHasTransparentEdge(lg(40, 255), 8, 8), true);
assert.equal(logoHasTransparentEdge(lg(255, 255), 8, 8), false);
assert.equal(logoHasTransparentEdge(new Uint8ClampedArray(0), 0, 0), false);

import { sessionCompactHtml, qrSvg, isSteamQrUrl, reasonText, sessionHtml, qrSheetHtml, qrExpiredHtml } from "../src/app/steam-session-ui.js";
assert.match(qrSvg("https://s.team/q/1/123"), /^<svg[^]*viewBox/);
assert.ok(isSteamQrUrl("https://s.team/q/1/18117612414935313670"));
assert.ok(!isSteamQrUrl("https://evil.example/q/1/1"));
assert.ok(!isSteamQrUrl("https://s.team/q/1/abc"));
assert.ok(!isSteamQrUrl(null));
assert.match(reasonText("idle"), /неделю/);
assert.equal(reasonText("nothing"), "");
assert.match(sessionHtml(null), /только в приложении/);
assert.match(sessionHtml({ signed_in: false, reason: "idle" }), /data-sess-in[^]*|Вход сброшен/);
assert.ok(sessionHtml({ signed_in: false }).includes("data-sess-in"));
assert.equal(sessionCompactHtml({ signed_in: true }), "");
assert.equal(sessionCompactHtml(null), "");
assert.ok(sessionCompactHtml({ signed_in: false }).includes("data-sess-in"));
assert.ok(sessionCompactHtml({ signed_in: false, reason: "idle" }).includes("неделю"));
assert.ok(!sessionHtml({ signed_in: true, account: "a" }).includes("data-sess-test"));
assert.ok(!sessionHtml({ signed_in: false }).includes("data-sess-out"));
const inHtml = sessionHtml({ signed_in: true, account: "<b>x</b>", days_left: 6 });
assert.ok(inHtml.includes("data-sess-out") && !inHtml.includes("<b>x</b>") && inHtml.includes("осталось дней: 6"));
assert.ok(qrSheetHtml("https://s.team/q/1/5", "pending").includes("<svg"));
assert.ok(!qrSheetHtml("https://evil.example/q/1/5", "pending").includes("<svg"));
assert.match(qrSheetHtml("https://s.team/q/1/5", "scanned"), /Подтвердите вход на телефоне/);
assert.ok(qrExpiredHtml().includes("data-sess-in"));

import { storeItemToCard, cardsFrom, assetUrl, accountChips, accountPanelHtml, bannerCards, wishCategoryIndex, communityImg, equippedItems, equippedHtml } from "../src/app/steam-personal.js";
const spCard = storeItemToCard({ id: 10, name: " Game ", best_purchase_option: { final_price_in_cents: 499, original_price_in_cents: 999, discount_pct: 50, currency_code: "EUR" } });
assert.deepEqual([spCard.appid, spCard.name, spCard.price.final, spCard.price.initial, spCard.price.discount, spCard.price.currency], [10, "Game", 4.99, 9.99, 50, "EUR"]);
assert.equal(storeItemToCard({ id: 1 }), null);
assert.equal(storeItemToCard(null), null);
assert.equal(storeItemToCard({ appid: 5, name: "F", is_free: true }).label, "Бесплатно");
assert.equal(cardsFrom({ items: [{ id: 3, name: "A" }, { id: 3, name: "A" }, { id: 4 }] }, "items").length, 1);
assert.deepEqual(cardsFrom(null, "items"), []);
const ac = accountChips({ notes: { unread_count: 3, pending_friend_count: 0, pending_gift_count: 1 }, cards: 12, items: { avatar_frames: [1, 2], profile_backgrounds: [1], mini_profile_backgrounds: [1, 2] } });
assert.deepEqual(ac.alerts.map(x => x[1]), [3, 1]);
assert.deepEqual(ac.own.map(x => x[1]), [2, 3, 12]);
assert.equal(accountChips({ points: "4500" }).own[0][0], "Очков Steam");
assert.equal(accountChips({ points: "4500" }).own[0][1], 4500);
assert.equal(bannerCards({ messages: [{ message: { associated_item: { appid: 5, name: "B" } } }, { message: {} }, { message: { associated_item: { appid: 5, name: "B" } } }] }).length, 1);
assert.deepEqual(bannerCards(null), []);
const wci = wishCategoryIndex({ categories: [{ categoryid: "7", name: "Куплю", item_count: 2 }, { name: "без id" }] }, { items: [{ appid: 1, category_ids: ["7"] }, { appid: 2 }] });
assert.equal(wci.cats.length, 1);
assert.ok(wci.map.get(1).has("7") && !wci.map.has(2));
assert.ok(communityImg("items/1/a.png").endsWith("/items/1/a.png"));
assert.equal(communityImg("../x"), null);
assert.equal(communityImg("javascript:alert(1)"), null);
const eqi = equippedItems({ avatar_frame: { item_title: "Рамка <1>", image_small: "items/9/f.png" }, profile_background: {} });
assert.equal(eqi.length, 1);
assert.ok(!equippedHtml(eqi).includes("<1>") && equippedHtml(eqi).includes("Рамка"));
assert.equal(equippedHtml([]), "");
assert.ok(equippedHtml(eqi, u => `/p?u=${u}`).includes("/p?u=https://cdn.cloudflare.steamstatic.com/"));
assert.equal(accountPanelHtml({}), "");
assert.ok(accountPanelHtml({ notes: { unread_count: 2 } }).includes("Непрочитанных"));
assert.ok(accountPanelHtml({ cards: 5 }).includes("Новых уведомлений нет"));
assert.equal(assetUrl({ asset_url_format: "steam/apps/1/${FILENAME}?t=5", header: "header.jpg" }), "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1/header.jpg?t=5");
assert.equal(assetUrl({ asset_url_format: "../x/${FILENAME}", header: "h.jpg" }), null);
assert.equal(assetUrl(null), null);
assert.equal(storeItemToCard({ appid: 7, store_item: { name: "W", best_purchase_option: { final_price_in_cents: 100, original_price_in_cents: 200, discount_pct: 50 } } }, "KZT").price.currency, "KZT");

import { fmtBytes, dateTime, sizeDelta, buildHtml, lowestText } from "../src/app/games-build.js";
assert.equal(fmtBytes(72684619429).replace(/\s/g, " "), "67,7 ГиБ");
assert.equal(fmtBytes(0), "—");
assert.equal(fmtBytes(null), "—");
assert.match(fmtBytes(512), /^512 Б$/);
assert.equal(sizeDelta(2048 * 1024 * 1024, 1024 * 1024 * 1024).startsWith("+"), true);
assert.equal(sizeDelta(1, 1), "");
assert.equal(sizeDelta(null, 5), "");
assert.equal(dateTime(0), "—");
assert.match(buildHtml(null), /недоступны/);
assert.match(buildHtml({ available: false }), /недоступны/);
const bh = buildHtml({ available: true, buildid: "25812307", updated: 1791541778, size: 72684619429, download: 59224565168, change: 39694531, release: 1761816600, history: [{ buildid: "2", size: 200 * 1048576, updated: 1791541778, change: 5 }, { buildid: "1", size: 100 * 1048576, updated: 1791400000, change: 4 }] });
assert.ok(bh.includes("25812307") && bh.includes("39\u00a0694\u00a0531") || bh.includes("39 694 531"));
assert.ok(bh.includes("<table") && bh.includes("общедоступной копии данных клиента Steam"));
assert.ok(!buildHtml({ available: true, buildid: "<x>", history: [] }).includes("<x>"));
assert.equal(lowestText({ lowest: null }, () => "x"), "");
assert.equal(lowestText({ lowest: 5, lowest_discount: 50, currency: "USD" }, p => `${p.final} ${p.currency}`), "5 USD · −50%");
assert.equal(lowestText({ lowest: 5, currency: "USD" }, p => `${p.final}`), "5");

const upd = alertText({ kind: "update", name: "Obscure", info: "сборка 215286, +3,2 ГиБ", price: { final: 0 } });
assert.equal(upd.title, "Obscure: вышло обновление");
assert.equal(upd.body, "сборка 215286, +3,2 ГиБ.");
assert.equal(alertText({ kind: "update", name: "X" }).body, "Новая сборка в Steam.");

import { watchBoxHtml, notifPanelHtml, unreadCount, ALERT_ICON } from "../src/app/games-watch.js";
assert.equal(alertText({ kind: "release", name: "Игра", info: "игра вышла в Steam" }).body, "Игра вышла в Steam.");
assert.equal(unreadCount([{ ts: 5 }, { ts: 10 }, { ts: 20 }], 9), 2);
assert.equal(unreadCount(null, 0), 0);
assert.ok(watchBoxHtml(5, null, { released: true }).includes("data-w-upd") && !watchBoxHtml(5, null, { released: true }).includes("data-w-rel"));
assert.ok(watchBoxHtml(5, { updates: true, release: false }, { released: false }).includes("data-w-rel"));
assert.ok(/data-w-upd checked disabled/.test(watchBoxHtml(5, null, { inWishlist: true })));
const np = notifPanelHtml({ alerts: [{ kind: "update", appid: 3, name: "<b>X</b>", info: "сборка 1", ts: 1791500000 }], watch: [{ appid: 7, name: "Y", updates: true, release: true }] }, 0);
assert.ok(np.includes(ALERT_ICON.update) && !np.includes("<b>X</b>") && np.includes("data-watch-del=\"7\"") && np.includes("gm-nt fresh"));
assert.ok(notifPanelHtml({}, 0).includes("Пока ничего нового"));

const npc = notifPanelHtml({ alerts: [{ kind: "sale", appid: 3, name: "Z", image: "https://shared.fastly.steamstatic.com/a.jpg", price: { final: 1, initial: 2, discount: 50, currency: "USD" }, ts: 5 }], watch: [{ appid: 7, name: "Y", image: "https://shared.fastly.steamstatic.com/b.jpg", updates: true }] }, 0, u => `/p?u=${u}`);
assert.equal((npc.match(/gm-nimg/g) || []).length, 2);
assert.ok(npc.includes("/p?u=https://shared.fastly.steamstatic.com/a.jpg"));
assert.ok(!notifPanelHtml({ alerts: [{ kind: "sale", appid: 3, name: "Z", price: { final: 1, initial: 2, discount: 50, currency: "USD" }, ts: 5 }] }, 0).includes("gm-nimg"));

console.log("games-test: ok");
