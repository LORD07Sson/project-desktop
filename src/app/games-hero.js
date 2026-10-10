// Герой главной витрины: арт игры с логотипом, карточка цвета арта, две миниатюры и точки.
// Чистая разметка без сети. Данные слайдов приходят с /games/store/home (hero), друзья — с /games/store/hero-friends.

import { priceView, ruPlural, heroPalette, huePalette } from "./games-core.js";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const heroLogoUrl = id => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${Number(id)}/logo.png`;

const WIN = `<svg class="gm-hx-os" viewBox="0 0 24 24" aria-label="Windows" fill="currentColor"><path d="M3 5.5l8-1.1v7H3zM12 4.3L21 3v8.4h-9zM3 12.6h8v7l-8-1.1zM12 12.6h9V21l-9-1.3z"/></svg>`;

/** Подпись кнопки карточки: своя библиотека, скидка или просто «Подробнее». */
export function heroButtonLabel(h, owned) {
  if (owned) return "В вашей библиотеке";
  const p = h.price;
  if (p && p.discount > 0 && p.initial > p.final) return `Со скидкой −${p.discount}%`;
  return "Подробнее";
}

/** Цена в карточке: «Бесплатно», обычная или со скидкой (значок, старая и новая цена). */
export function heroPriceHtml(h) {
  const p = h.price;
  if (!p || !(p.final > 0)) return `<b>Бесплатно</b>`;
  const v = priceView(p);
  return `${v.badge ? `<i class="gm-hx-off">${esc(v.badge)}</i>` : ""}<b>${esc(v.now)}</b>${v.old ? `<s>${esc(v.old)}</s>` : ""}`;
}

/** Внутренность карточки справа: название, описание, цена и кнопка. */
export function heroCardHtml(h, owned) {
  return `<h2>${esc(h.name)}</h2>
    <p>${esc(h.desc || "")}</p>
    <div class="gm-hx-gap"></div>
    <div class="gm-hx-price">${heroPriceHtml(h)}</div>
    <div class="gm-hx-row"><button type="button" class="gm-hx-buy" data-app="${Number(h.appid)}" data-name="${esc(h.name)}">${esc(heroButtonLabel(h, owned))}</button>${(h.os || []).includes("windows") ? WIN : ""}</div>`;
}

/** Две миниатюры скриншотов под карточкой; клик открывает страницу игры. */
export function heroShotsHtml(h, img) {
  return (h.shots || []).slice(0, 2).map(u => `<button type="button" data-app="${Number(h.appid)}" data-name="${esc(h.name)}" aria-label="${esc(h.name)}"><img loading="lazy" src="${esc(img(u))}" alt=""></button>`).join("");
}

/** Друзья, у которых есть игра: до трёх аватарок и «N друзей». Пусто, если таких нет. */
export function heroFriendsHtml(info, img) {
  if (!info || !info.count) return "";
  const avs = (info.list || []).slice(0, 3).map(f => `<i title="${esc(f.name)}"><img src="${esc(img(f.avatar))}" alt=""></i>`).join("");
  return `<span class="gm-hx-av">${avs}</span><span class="gm-hx-cnt">${info.count} ${ruPlural(info.count, ["друг", "друга", "друзей"])}</span>`;
}

/** Слайд: арт, логотип (если файла нет — просто арт) и теги-чипы сверху слева. */
export function heroSlideHtml(h, i, img) {
  const art = h.hero || h.capsule || h.image;
  return `<div class="gm-hx-slide${i === 0 ? " on" : ""}" data-app="${Number(h.appid)}" data-name="${esc(h.name)}" role="button" tabindex="0" aria-label="${esc(h.name)}">
    ${art ? `<img class="gm-hx-bg" src="${esc(img(art))}" data-id="${Number(h.appid)}" data-n="0" data-p="${esc(art)}" alt="">` : ""}
    <img class="gm-hx-logo" src="${esc(img(heroLogoUrl(h.appid)))}" alt="">
    <div class="gm-hx-chips">${(h.tags || []).slice(0, 4).map(t => `<span>${esc(t)}</span>`).join("")}</div>
  </div>`;
}

export function heroMarkup(list, img, owned = () => false) {
  if (!list || !list.length) return "";
  const first = list[0];
  return `<section class="gm-hx" id="gm-hero" aria-label="Популярное и рекомендуемое">
    <div class="gm-hx-art">${list.map((h, i) => heroSlideHtml(h, i, img)).join("")}<div class="gm-hx-meta" id="gm-hx-fr" hidden></div></div>
    <aside class="gm-hx-card" id="gm-hx-card">${heroCardHtml(first, owned(first.appid))}</aside>
    <div class="gm-hx-shots" id="gm-hx-shots">${heroShotsHtml(first, img)}</div>
    <div class="gm-hx-dots">${list.map((_, i) => `<button type="button" class="${i === 0 ? "on" : ""}" data-shero="${i}" aria-label="Игра ${i + 1}"></button>`).join("")}</div>
  </section>`;
}

const PAL_KEY = "project-games-hero-pal";
const palStore = () => { try { return JSON.parse(localStorage.getItem(PAL_KEY) || "{}"); } catch (_) { return {}; } };

/** Контроллер героя: смена слайдов, цвета карточки из арта, друзья. Зависимости передаёт магазин:
 *  img(url) — адрес картинки, owned(id) — игра в библиотеке, friends(ids) — запрос друзей, hueOf(name) — запасной оттенок,
 *  active() — витрина сейчас открыта (иначе таймер сам останавливается). */
export function createHero(d) {
  const st = { list: [], i: 0, friends: {}, pal: {}, seq: 0, timer: 0 };
  const root = () => document.getElementById("gm-hero");

  // у многих игр нет файла логотипа: тогда убираем пустую картинку, остаётся один арт
  document.addEventListener("error", e => {
    const im = e.target;
    if (im && im.tagName === "IMG" && im.classList.contains("gm-hx-logo")) im.remove();
  }, true);

  const applyPal = p => {
    const box = root();
    if (!box || !p) return;
    box.style.setProperty("--hx1", p.c1); box.style.setProperty("--hx2", p.c2); box.style.setProperty("--hx3", p.c3); box.style.setProperty("--hxb", p.base);
  };

  // Цвета карточки берём из самого арта (уменьшенная копия в canvas); не вышло — запасная палитра по оттенку названия.
  async function paletteFor(h) {
    if (st.pal[h.appid]) return st.pal[h.appid];
    const saved = palStore()[h.appid];
    if (saved) return (st.pal[h.appid] = saved);
    let p;
    try {
      const r = await fetch(d.img(h.hero || h.capsule || h.image));
      if (!r.ok) throw new Error("art");
      const bmp = await window.createImageBitmap(await r.blob());
      const c = document.createElement("canvas");
      c.width = 64; c.height = 22;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0, 64, 22);
      p = heroPalette(ctx.getImageData(0, 0, 64, 22).data, 64, 22);
      const all = palStore(), keys = Object.keys(all);
      if (keys.length > 80) delete all[keys[0]];
      all[h.appid] = p;
      try { localStorage.setItem(PAL_KEY, JSON.stringify(all)); } catch (_) { /* не критично */ }
    } catch (_) { p = huePalette(d.hueOf(h.name)); }
    return (st.pal[h.appid] = p);
  }

  function paintFriends() {
    const el = document.getElementById("gm-hx-fr"), h = st.list[st.i];
    if (!el || !h) return;
    const html = heroFriendsHtml(st.friends[h.appid], d.img);
    el.innerHTML = html;
    el.hidden = !html;
  }

  async function loadFriends() {
    if (!st.list.length) return;
    try {
      const r = await d.friends(st.list.map(x => x.appid));
      st.friends = (r && r.items) || {};
      paintFriends();
    } catch (_) { /* друзья необязательны */ }
  }

  function go(i, instant) {
    const box = root();
    if (!box || !st.list.length) return;
    const n = st.list.length, k = ((i % n) + n) % n, h = st.list[k], my = ++st.seq;
    st.i = k;
    box.querySelectorAll(".gm-hx-slide").forEach((el, j) => el.classList.toggle("on", j === k));
    box.querySelectorAll("[data-shero]").forEach((el, j) => el.classList.toggle("on", j === k));
    const card = document.getElementById("gm-hx-card"), shots = document.getElementById("gm-hx-shots");
    const apply = () => {
      if (my !== st.seq) return;
      card.innerHTML = heroCardHtml(h, d.owned(h.appid));
      shots.innerHTML = heroShotsHtml(h, d.img);
      card.classList.remove("swap"); shots.classList.remove("swap");
      paintFriends();
    };
    if (instant) apply(); else { card.classList.add("swap"); shots.classList.add("swap"); setTimeout(apply, 260); } // DevSkim: ignore DS172411 — функция, не строка
    paletteFor(h).then(p => { if (my === st.seq) applyPal(p); });
  }

  function stop() { clearInterval(st.timer); st.timer = 0; }

  function start() {
    stop();
    const box = root();
    if (!box || !st.list.length) return;
    paletteFor(st.list[st.i]).then(applyPal);
    st.list.forEach(x => paletteFor(x));                                       // заранее: смена слайда без «скачка» цвета
    loadFriends();
    if (st.list.length < 2) return;
    st.timer = setInterval(() => { // DevSkim: ignore DS172411 — функция, не строка
      if (!d.active() || !root()) { stop(); return; }
      if (box.matches(":hover")) return;
      go(st.i + 1);
    }, 8000);
  }

  return {
    html(list) { st.list = list || []; st.i = 0; st.friends = {}; return heroMarkup(st.list, d.img, d.owned); },
    go, start, stop, state: st,
  };
}
