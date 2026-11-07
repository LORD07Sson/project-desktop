// «Атмосфера» страницы Nyaa: баннер-слайд-шоу в шапке и его палитра на всё вокруг.
//  • слайд-шоу: случайный при открытии, по кругу каждые 5 минут, точки-переключатели, пауза под курсором;
//  • палитра баннера (neon, neon2, фон, панели) — на всю страницу Nyaa и, пока она открыта, на всё приложение;
//  • параллакс шапки, тонкая полоска сверху при прокрутке, частицы в цвет баннера, каскад строк, досчёт цифр;
//  • строка при наведении светится цветом своей обложки;
//  • свои баннеры: картинка → апскейл встроенной нейросетью до 4K (и 2K из неё) → палитра подбирается сама.
//    Хранятся в IndexedDB этого компьютера (localStorage для картинок мал).
import banner1k2 from "../assets/nyaa/banner1-2k.webp";
import banner1k4 from "../assets/nyaa/banner1-4k.webp";
import banner2k2 from "../assets/nyaa/banner2-2k.webp";
import banner2k4 from "../assets/nyaa/banner2-4k.webp";
import banner3k2 from "../assets/nyaa/banner3-2k.webp";
import banner3k4 from "../assets/nyaa/banner3-4k.webp";
import banner4k2 from "../assets/nyaa/banner4-2k.webp";
import banner4k4 from "../assets/nyaa/banner4-4k.webp";
import { invoke, pickInputFile } from "./tauri.js";
import { toast, askConfirm } from "./api.js";
import { ACCENTS, currentAccent } from "./ui-prefs.js";

// neon — главный акцент, neon2 — второй, bg — фон страницы, panel/panel2 — панели
const BUILTIN = [
  { k2: banner1k2, k4: banner1k4, pos: "center 35%", neon: "#5fe3a1", neon2: "#6ec8ff", bg: "#08110f", panel: "#0f1b18", panel2: "#152622" },
  { k2: banner2k2, k4: banner2k4, pos: "center 40%", neon: "#ff2a4d", neon2: "#ff8a5c", bg: "#100608", panel: "#1a0c10", panel2: "#251217" },
  { k2: banner3k2, k4: banner3k4, pos: "center 30%", neon: "#a66bff", neon2: "#7ee0b0", bg: "#0c0913", panel: "#160f21", panel2: "#1f152e" },
  { k2: banner4k2, k4: banner4k4, pos: "center 35%", neon: "#7cc7ff", neon2: "#f2c46d", bg: "#08101a", panel: "#0e1724", panel2: "#142135" },
];
let banners = BUILTIN.slice();
const EVERY_MS = 5 * 60 * 1000;
let idx = -1;
let timer = null;
let paused = false;
// «Закрепить баннер»: слайд-шоу стоит на выбранном баннере, выбор запоминается на этом компьютере.
let pinned = false;
try { pinned = localStorage.getItem("project-nyaa-banner-pin") === "1"; } catch (_) { /* не критично */ }
let current = null;
let sparkColor = "#7cc7ff";
const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const srcOf = b => (Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1) > 2560 ? b.k4 : b.k2);
const rootEl = () => document.querySelector("#nyaa-body .ny");

// ---------- палитра ----------
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function setPalette(el, b) {
  sparkColor = b.neon;
  for (const [k, v] of [["--ny-neon", b.neon], ["--ny-neon2", b.neon2], ["--ny-bg", b.bg], ["--ny-panel", b.panel], ["--ny-panel2", b.panel2], ["--fire-rgb", hexRgb(b.neon).join(", ")]]) el.style.setProperty(k, v);
}
// Пока открыта Nyaa — акцент баннера на всём приложении (верхнее меню, общий фон, кнопки); ушли со вкладки — как было.
const APP_VARS = ["--gold-rgb", "--glow-rgb", "--fire", "--ember", "--gold", "--fire-rgb", "--ny-neon", "--ny-neon2", "--ny-bg", "--ny-panel", "--ny-panel2", "--ny-banner"];
// Насколько цвета баннера красят приложение (Настройки → Внешний вид → «Цвета баннера»):
// full — полностью баннер, half — пополам с выбранной цветовой темой, own — только своя тема.
export const ATMOS_MIX = { full: "Баннер", half: "50 / 50", own: "Своя тема" };
const MIX_KEY = "project-atmos-mix";
export function atmosMix() {
  let v = "full";
  try { v = localStorage.getItem(MIX_KEY) || "full"; } catch (_) { /* не критично */ }
  return ATMOS_MIX[v] ? v : "full";
}
export function setAtmosMix(v) {
  try { localStorage.setItem(MIX_KEY, ATMOS_MIX[v] ? v : "full"); } catch (_) { /* не запомним */ }
  syncAppAtmos();
}
/** Цветовую тему сменили в настройках — заново смешать с баннером. */
export function refreshAppAtmos() { syncAppAtmos(); }
const mixHex = (a, b, k) => "#" + hexRgb(a).map((v, i) => Math.round(v * (1 - k) + hexRgb(b)[i] * k).toString(16).padStart(2, "0")).join("");

function syncAppAtmos() {
  const de = document.documentElement;
  const mode = atmosMix();
  const on = !!current && mode !== "own";
  if (on) {
    // своя тема: акцент, второй цвет, фон, карточка — из образца выбранной палитры
    const sw = (ACCENTS[currentAccent()] || ACCENTS.original).sw;
    const k = mode === "half" ? 0.5 : 0;
    const c = { neon: mixHex(current.neon, sw[2], k), neon2: mixHex(current.neon2, sw[3], k), bg: mixHex(current.bg, sw[0], k), panel: mixHex(current.panel, sw[1], k), panel2: mixHex(current.panel2, sw[1], k) };
    de.dataset.nyAtmos = "1";
    de.style.setProperty("--fire", c.neon); de.style.setProperty("--ember", c.neon); de.style.setProperty("--gold", c.neon2);
    de.style.setProperty("--fire-rgb", hexRgb(c.neon).join(", ")); de.style.setProperty("--gold-rgb", hexRgb(c.neon2).join(", ")); de.style.setProperty("--glow-rgb", hexRgb(c.neon).join(", "));
    de.style.setProperty("--ny-neon", c.neon); de.style.setProperty("--ny-neon2", c.neon2); de.style.setProperty("--ny-bg", c.bg);
    de.style.setProperty("--ny-panel", c.panel); de.style.setProperty("--ny-panel2", c.panel2);
    de.style.setProperty("--ny-banner", `url("${current.k2}")`);   // размытый фон и шапка окна — 2K хватает, 4K только в большой шапке Nyaa
    const ny = rootEl();
    if (ny) setPalette(ny, c);
  } else if (de.dataset.nyAtmos) {
    delete de.dataset.nyAtmos;
    APP_VARS.forEach(v => de.style.removeProperty(v));
  }
}

// ---------- слайд-шоу ----------
function firstIndex() {
  let last = -1;
  try { last = Number(localStorage.getItem("project-nyaa-banner")); } catch (_) { /* не критично */ }
  if (pinned && last >= 0 && last < banners.length) return last;
  let i = Math.floor(Math.random() * banners.length);
  if (banners.length > 1 && i === last) i = (i + 1) % banners.length;
  return i;
}
function show(i, instant) {
  const root = rootEl();
  const hero = root && root.querySelector(".ny-hero");
  if (!banners.length) return;
  i = ((i % banners.length) + banners.length) % banners.length;
  const b = banners[i];
  idx = i; current = b;
  try { localStorage.setItem("project-nyaa-banner", String(i)); } catch (_) { /* не критично */ }
  if (!hero) {
    const img = new Image();
    img.onload = img.onerror = () => { syncAppAtmos(); paintStrips(); };
    img.src = srcOf(b);
    if (instant) { syncAppAtmos(); paintStrips(); }
    return;
  }
  const put = () => {
    const layer = document.createElement("div");
    layer.className = "ny-hero-bg";
    layer.style.backgroundImage = `url("${srcOf(b)}")`;
    layer.style.backgroundPosition = b.pos || "center";
    hero.prepend(layer);
    setPalette(root, b);
    syncAppAtmos();
    paintStrips();
    paintDots(root);
    const on = () => { layer.classList.add("on"); hero.querySelectorAll(".ny-hero-bg:not(:first-child)").forEach(old => setTimeout(() => old.remove(), 1600)); };
    if (instant) on(); else requestAnimationFrame(() => requestAnimationFrame(on));
  };
  if (instant) { put(); return; }
  const img = new Image();     // сначала загрузить, потом плавно сменить — без мигания пустым фоном
  img.onload = img.onerror = put;
  img.src = srcOf(b);
}
function restartTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (document.hidden || paused || pinned) return;   // окно свёрнуто, курсор на баннере или баннер закреплён
    show(idx + 1, false);
  }, EVERY_MS);
}
function paintDots(root) {
  const box = root.querySelector(".ny-dots");
  if (!box) return;
  box.innerHTML = banners.map((b, i) => `<button type="button" class="${i === idx ? "on" : ""}${b.own ? " own" : ""}" data-ny-dot="${i}" title="${b.own ? "Свой баннер — правый клик: цвета или убрать" : `Баннер ${i + 1}`}" aria-label="Баннер ${i + 1}"></button>`).join("")
    + `<button type="button" class="add" data-ny-add title="Добавить свой баннер (увеличится нейросетью до 4K)" aria-label="Добавить свой баннер">+</button>`
    + `<button type="button" class="pin${pinned ? " on" : ""}" data-ny-pin title="${pinned ? "Баннер закреплён — нажми, чтобы снова менялись" : "Закрепить этот баннер"}" aria-label="Закрепить баннер" aria-pressed="${pinned}">📌</button>`;
}

// ---------- частицы в цвет баннера ----------
function startParticles(hero) {
  if (reduced() || hero.querySelector(".ny-sparks")) return;
  const c = document.createElement("canvas");
  c.className = "ny-sparks";
  hero.append(c);
  const ctx = c.getContext("2d");
  const P = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.8, v: 0.00025 + Math.random() * 0.0006, d: Math.random() * Math.PI * 2, a: 0.25 + Math.random() * 0.6 }));
  let w = 0, h = 0;
  const fit = () => { const dpr = window.devicePixelRatio || 1; w = hero.clientWidth; h = hero.clientHeight; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  fit();
  new ResizeObserver(fit).observe(hero);
  const tick = t => {
    if (!c.isConnected) return;
    if (!document.hidden && hero.offsetParent) {
      const col = sparkColor;
      ctx.clearRect(0, 0, w, h);
      for (const p of P) {
        p.y -= p.v; p.d += 0.01;
        if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
        const x = (p.x + Math.sin(p.d) * 0.01) * w, y = p.y * h;
        const tw = 0.55 + 0.45 * Math.sin(t / 600 + p.d * 3);
        ctx.globalAlpha = p.a * tw;
        ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------- параллакс и тонкая полоска при прокрутке ----------
function wireScroll(root) {
  const panel = document.getElementById("nyaa-panel");
  if (!panel || panel.dataset.nyScroll) return;
  panel.dataset.nyScroll = "1";
  let raf = 0;
  panel.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = rootEl();
      if (!r) return;
      const y = panel.scrollTop;
      if (!reduced()) r.style.setProperty("--ny-par", `${Math.min(y, 300) * 0.18}px`);
      r.classList.toggle("ny-compact", y > 200);
    });
  }, { passive: true });
}

// ---------- свои баннеры ----------
const DB = "project-nyaa-banners";
function db() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("b", { keyPath: "id" });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function dbAll() { const d = await db(); return new Promise(res => { const r = d.transaction("b").objectStore("b").getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }); }
async function dbPut(v) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("b", "readwrite"); t.objectStore("b").put(v); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function dbDel(id) { const d = await db(); return new Promise(res => { const t = d.transaction("b", "readwrite"); t.objectStore("b").delete(id); t.oncomplete = res; t.onerror = res; }); }

const hex = (r, g, b) => "#" + [r, g, b].map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
function hsl2hex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}
// Палитра из картинки: самый «неоновый» оттенок (насыщенный и яркий) и второй, заметно другой по тону; фон и панели — тёмные того же тона.
async function paletteOf(url) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const c = document.createElement("canvas"); c.width = 96; c.height = 40;
  const x = c.getContext("2d"); x.drawImage(img, 0, 0, 96, 40);
  const px = x.getImageData(0, 0, 96, 40).data;
  const buckets = new Array(36).fill(0).map(() => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, l] = rgb2hsl(px[i], px[i + 1], px[i + 2]);
    const w = (s / 100) ** 2 * (1 - Math.abs(l - 55) / 55);
    if (w <= 0.02) continue;
    const bk = buckets[Math.floor(h / 10) % 36];
    bk.w += w; bk.r += px[i] * w; bk.g += px[i + 1] * w; bk.b += px[i + 2] * w;
  }
  const order = buckets.map((b, i) => ({ ...b, h: i * 10 + 5 })).filter(b => b.w > 0).sort((a, b) => b.w - a.w);
  const main = order[0] || { h: 205, w: 1, r: 124, g: 199, b: 255 };
  const second = order.find(b => Math.min(Math.abs(b.h - main.h), 360 - Math.abs(b.h - main.h)) > 45) || { h: (main.h + 40) % 360 };
  const h1 = main.h, h2 = second.h;
  return { neon: hsl2hex(h1, 85, 64), neon2: hsl2hex(h2, 80, 70), bg: hsl2hex(h1, 40, 5), panel: hsl2hex(h1, 35, 8.5), panel2: hsl2hex(h1, 32, 12.5) };
}
function paletteFrom(neon, neon2) {
  const [r, g, b] = hexRgb(neon);
  const [h] = rgb2hsl(r, g, b);
  return { neon, neon2, bg: hsl2hex(h, 40, 5), panel: hsl2hex(h, 35, 8.5), panel2: hsl2hex(h, 32, 12.5) };
}
async function savePal(id, pal) {
  const rec = (await dbAll()).find(o => o.id === id);
  if (!rec) return;
  await dbPut({ ...rec, pal, auto: rec.auto || rec.pal });
  await loadOwn();
}

// Цвета своего баннера: подобраны по картинке, но их можно поменять — главный и второй, остальное выводится из главного.
function openPaletteEditor(b) {
  const root = rootEl();
  const hero = root && root.querySelector(".ny-hero");
  if (!hero || !b || !b.own) return;
  hero.querySelector(".ny-paled")?.remove();
  hero.insertAdjacentHTML("beforeend", `<div class="ny-paled" role="dialog" aria-label="Цвета баннера">
    <b>Цвета баннера</b>
    <label><input type="color" data-pe="neon" value="${b.neon}"> Главный</label>
    <label><input type="color" data-pe="neon2" value="${b.neon2}"> Второй</label>
    <div class="ny-paled-acts">
      <button type="button" class="btn ghost" data-pe-auto title="Снова подобрать по картинке">Авто</button>
      <button type="button" class="btn ghost" data-pe-del>Убрать баннер</button>
      <button type="button" class="btn primary" data-pe-ok>Готово</button>
    </div></div>`);
  const box = hero.querySelector(".ny-paled");
  const id = b.id;
  const preview = () => {
    const pal = paletteFrom(box.querySelector('[data-pe="neon"]').value, box.querySelector('[data-pe="neon2"]').value);
    Object.assign(b, pal); current = b;
    setPalette(root, pal); syncAppAtmos();
  };
  box.querySelectorAll("input[type=color]").forEach(i => i.addEventListener("input", preview));
  box.querySelector("[data-pe-auto]").addEventListener("click", async () => {
    const rec = (await dbAll()).find(o => o.id === id);
    const auto = (rec && (rec.auto || rec.pal)) || paletteFrom(b.neon, b.neon2);
    box.querySelector('[data-pe="neon"]').value = auto.neon;
    box.querySelector('[data-pe="neon2"]').value = auto.neon2;
    preview();
  });
  box.querySelector("[data-pe-ok]").addEventListener("click", async () => {
    await savePal(id, paletteFrom(box.querySelector('[data-pe="neon"]').value, box.querySelector('[data-pe="neon2"]').value));
    box.remove();
    show(banners.findIndex(x => x.id === id), true);
  });
  box.querySelector("[data-pe-del]").addEventListener("click", async () => {
    if (!(await askConfirm("Убрать этот свой баннер?"))) return;
    box.remove();
    await dbDel(id);
    await loadOwn();
    show(Math.min(idx, banners.length - 1), false);
  });
}

async function scaledBlob(blob, width) {
  const bmp = await window.createImageBitmap(blob);
  const h = Math.round(bmp.height * width / bmp.width);
  const c = document.createElement("canvas"); c.width = width; c.height = h;
  c.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0, width, h);
  return new Promise(res => c.toBlob(res, "image/webp", 0.86));
}
async function loadOwn() {
  try {
    const own = await dbAll();
    banners = BUILTIN.concat(own.map(o => ({ ...o.pal, pos: "center 35%", own: true, id: o.id, k2: URL.createObjectURL(o.k2), k4: URL.createObjectURL(o.k4) })));
  } catch (_) { banners = BUILTIN.slice(); }
}
async function addOwn() {
  const path = await pickInputFile([{ name: "Картинки", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }]);
  if (!path) return;
  let bytes;
  try {
    const src = await invoke("upscale_read", { path });
    bytes = new Uint8Array(src);
  } catch (e) { toast(`Картинка не прочиталась: ${e && e.message ? e.message : e}`, "error"); return; }
  await addOwnFromBytes(bytes);
}

// Увеличить, ужать до 4K и 2K, подобрать палитру и сохранить. Отдельно от выбора файла — так её можно проверить без диалога.
export async function addOwnFromBytes(bytes) {
  toast("Баннер: увеличиваю нейросетью до 4K — это может занять до минуты…");
  try {
    const png = await invoke("upscale_image", { bytes: Array.from(bytes), model: "anime", width: 3840 });
    const big = new Blob([png instanceof ArrayBuffer ? png : new Uint8Array(png)], { type: "image/png" });
    const k4 = await scaledBlob(big, 3840);
    const k2 = await scaledBlob(big, 2560);
    const url = URL.createObjectURL(k2);
    const pal = await paletteOf(url);
    URL.revokeObjectURL(url);
    const id = `own-${Date.now()}`;
    await dbPut({ id, k2, k4, pal });
    await loadOwn();
    show(banners.findIndex(b => b.id === id), false);
    restartTimer();
    toast("Баннер добавлен — цвета подобраны по картинке, их можно поменять.", "success");
    openPaletteEditor(banners.find(b => b.id === id));
    return id;
  } catch (e) {
    toast(`Баннер не добавился: ${e && e.message ? e.message : e}`, "error");
  }
}

// ---------- точки, пауза, клики ----------
function wireHero(root) {
  const hero = root.querySelector(".ny-hero");
  if (!hero || hero.dataset.nyWired) return;
  hero.dataset.nyWired = "1";
  hero.addEventListener("mouseenter", () => { paused = true; });
  hero.addEventListener("mouseleave", () => { paused = false; });
  hero.addEventListener("click", e => {
    const dot = e.target.closest("[data-ny-dot]");
    if (dot) { show(Number(dot.dataset.nyDot), false); restartTimer(); return; }
    if (e.target.closest("[data-ny-add]")) addOwn();
    if (e.target.closest("[data-ny-pin]")) {
      pinned = !pinned;
      try { localStorage.setItem("project-nyaa-banner-pin", pinned ? "1" : "0"); } catch (_) { /* не критично */ }
      paintDots(root);
    }
  });
  hero.addEventListener("contextmenu", async e => {
    const dot = e.target.closest("[data-ny-dot]");
    const b = dot && banners[Number(dot.dataset.nyDot)];
    if (!b || !b.own) return;
    e.preventDefault();
    show(Number(dot.dataset.nyDot), true);
    openPaletteEditor(banners[Number(dot.dataset.nyDot)]);
  });
}

// Строка при наведении светится цветом своей обложки (обложки — data:URL, читаются без запросов).
const coverTint = new Map();
function wireRowTint(root) {
  if (root.dataset.nyTint) return;
  root.dataset.nyTint = "1";
  root.addEventListener("mouseover", e => {
    const row = e.target.closest(".ny-row[data-id]");
    if (!row || row.style.getPropertyValue("--row-neon")) return;
    const img = row.querySelector(".ny-kind.has-cover img");
    const key = row.querySelector(".ny-kind")?.dataset.ck || "";
    if (!img || !img.complete || !img.naturalWidth) return;
    if (!coverTint.has(key)) {
      try {
        const c = document.createElement("canvas"); c.width = 24; c.height = 36;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0, 24, 36);
        const d = x.getImageData(0, 0, 24, 36).data;
        let best = null, bw = 0;
        for (let i = 0; i < d.length; i += 4) { const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]); const w = s * (1 - Math.abs(l - 55) / 55); if (w > bw) { bw = w; best = h; } }
        coverTint.set(key, best == null ? "" : hsl2hex(best, 85, 64));
      } catch (_) { coverTint.set(key, ""); }
    }
    const col = coverTint.get(key);
    if (col) row.style.setProperty("--row-neon", col);
  });
}

// ---------- баннер в шапке окна (за вкладками и кнопками) — на всех вкладках, кроме Nyaa со своей большой шапкой ----------
function paintStrips() {
  const bar = document.getElementById("titlebar");
  if (!current || !bar) return;
  const url = `url("${current.k2}")`;
  let box = bar.querySelector(":scope > .tb-banner");
  if (!box) {
    bar.insertAdjacentHTML("afterbegin", `<div class="tb-banner" aria-hidden="true"><i></i></div>`);
    box = bar.firstElementChild;
  }
  const old = box.querySelector("i:last-child");
  if (old.dataset.src === url) return;
  const next = document.createElement("i");
  next.dataset.src = url;
  next.style.backgroundImage = url;
  next.style.backgroundPosition = current.pos || "center";
  box.appendChild(next);
  requestAnimationFrame(() => requestAnimationFrame(() => { next.classList.add("on"); setTimeout(() => box.querySelectorAll("i:not(:last-child)").forEach(x => x.remove()), 1500); }));
}

/** При запуске приложения: выбрать баннер и раскрасить всё приложение его палитрой, не дожидаясь вкладки Nyaa. */
export async function initAppAtmos() {
  // Пока идёт заставка, ничего тяжёлого: декодировать баннер и перерисовывать фон окна — после неё.
  for (let i = 0; i < 100 && document.getElementById("app-splash"); i++) await new Promise(r => setTimeout(r, 150));
  if (idx < 0) {
    const i = firstIndex();
    try { const img = new Image(); img.src = banners[i].k2; await img.decode(); } catch (_) { /* покажем как есть */ }
    if (idx < 0) show(i, true);
  }
  if (!timer) restartTimer();
  await loadOwn();
}

// ---------- для nyaa.js ----------
export async function applyBanner(root) {
  if (!root) return;
  if (!root.querySelector(".ny-dots")) root.querySelector(".ny-hero")?.insertAdjacentHTML("beforeend", `<div class="ny-dots" aria-label="Баннеры"></div>`);
  if (!root.querySelector(".ny-mini")) root.insertAdjacentHTML("afterbegin", `<div class="ny-mini" aria-hidden="true"><div><b>Nyaa</b><span>Beta</span></div></div>`);
  show(idx < 0 ? firstIndex() : Math.min(idx, banners.length - 1), true);
  wireHero(root);
  wireScroll(root);
  wireRowTint(root);
  startParticles(root.querySelector(".ny-hero"));
  if (!timer) restartTimer();
  if (!document.documentElement.dataset.nyAtmosWired) {
    document.documentElement.dataset.nyAtmosWired = "1";
    const panel = document.querySelector('.tab-panel[data-panel="nyaa"]');
    if (panel) new MutationObserver(syncAppAtmos).observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
  const before = banners.length;
  await loadOwn();
  if (banners.length !== before) paintDots(root);
}

// Каскад: первые строки списка появляются снизу вверх по очереди.
let lastSig = "";
export function cascadeRows(list) {
  if (!list || reduced()) return;
  const sig = [...list.querySelectorAll(".ny-row[data-id]")].slice(0, 12).map(r => r.dataset.id).join(",");
  if (!sig || sig === lastSig) return;
  lastSig = sig;
  let n = 0;
  list.querySelectorAll(".ny-row[data-id], .ny-day").forEach(el => {
    if (n > 28) return;
    el.style.setProperty("--ny-i", String(n++));
    el.classList.remove("ny-in"); void el.offsetWidth; el.classList.add("ny-in");
  });
}

// Цифры в шапке досчитываются от прежнего значения к новому.
const lastStats = new Map();
export function countUp(box) {
  if (!box) return;
  box.querySelectorAll(".ny-stat b").forEach((b, i) => {
    const m = b.textContent.match(/^(\d+(?:([.,])\d+)?)(.*)$/);
    if (!m) return;
    const to = parseFloat(m[1].replace(",", "."));
    if (!Number.isFinite(to)) return;
    const from = lastStats.has(i) ? lastStats.get(i) : 0;
    lastStats.set(i, to);
    if (reduced() || from === to) return;
    const sep = m[2] || "", dec = sep ? m[1].split(sep)[1].length : 0, tail = m[3], t0 = window.performance.now(), dur = 900;
    const fmt = v => { const t = v.toFixed(dec); return sep === "," ? t.replace(".", ",") : t; };
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3; b.textContent = fmt(from + (to - from) * e) + tail; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
