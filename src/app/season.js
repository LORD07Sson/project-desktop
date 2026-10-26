// Сезонное оформление (Настройки → Внешний вид): за интерфейсом — зимой снег и новогодняя гирлянда сверху,
// весной лепестки сакуры, летом светлячки, осенью листопад, плюс свечение сезона по краям окна
// (kadr.css, :root[data-season]). Слой лежит сразу за фоном из обложки и под окном приложения — сквозь стекло
// видно, но поверх карточек не летает. «Авто» берёт сезон по дате; при выключенных анимациях и свёрнутом окне — стоит.

const KEY = "project-season";
export const SEASONS = { auto: "Авто", winter: "Зима", spring: "Весна", summer: "Лето", autumn: "Осень", off: "Выкл." };

const root = document.documentElement;
let layer = null, canvas = null, ctx = null, garland = null, raf = 0, last = 0, parts = [], kind = "", sprites = null;

export function seasonPref() {
  let v = "auto";
  try { v = localStorage.getItem(KEY) || "auto"; } catch (_) { /* приватный режим */ }
  return SEASONS[v] ? v : "auto";
}

function byDate(d = new Date()) {
  const m = d.getMonth();
  return m === 11 || m <= 1 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : "autumn";
}

export function applySeason(pref) {
  const v = SEASONS[pref] ? pref : "auto";
  try { localStorage.setItem(KEY, v); } catch (_) { /* не запомним */ }
  const season = v === "off" ? "" : v === "auto" ? byDate() : v;
  if (season) root.dataset.season = season;
  else delete root.dataset.season;
  restart();
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// Спрайты рисуем один раз во внеэкранные холсты — каждый кадр только drawImage.
function sprite(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  return c;
}

function makeSprites() {
  const flake = sprite(32, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.35, "rgba(240,248,255,.85)");
    gr.addColorStop(1, "rgba(220,235,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
  const petal = ["#ffc4d6", "#ffb0c8", "#ffd6e2", "#f79ab8"].map(col => sprite(40, (g, s) => {
    g.translate(s / 2, s / 2);
    const gr = g.createLinearGradient(0, -s * 0.4, 0, s * 0.4);
    gr.addColorStop(0, "#fff0f5");
    gr.addColorStop(1, col);
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(0, s * 0.42);
    g.bezierCurveTo(s * 0.34, s * 0.2, s * 0.3, -s * 0.3, s * 0.08, -s * 0.42);
    g.lineTo(0, -s * 0.32);   // выемка на кончике лепестка
    g.lineTo(-s * 0.08, -s * 0.42);
    g.bezierCurveTo(-s * 0.3, -s * 0.3, -s * 0.34, s * 0.2, 0, s * 0.42);
    g.fill();
  }));
  const leaf = ["#d9541e", "#e8892b", "#b8321a", "#f0b33a", "#a8461a"].map(col => sprite(48, (g, s) => {
    g.translate(s / 2, s / 2);
    g.fillStyle = col;
    g.strokeStyle = "rgba(60,20,5,.55)";
    g.lineWidth = 1;
    // Кленовый лист: пять лопастей с зубцами вокруг черешка.
    g.beginPath();
    const R = s * 0.44;
    const lobes = [-90, -38, 18, 162, 218].map(a => a * Math.PI / 180);
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const a = -Math.PI / 2 + (i / 40) * Math.PI * 2;
      let k = 0.38;
      for (const l of lobes) k = Math.max(k, Math.pow(Math.max(0, Math.cos(a - l)), 6));
      const rr = R * (0.42 + 0.58 * k) * (i % 2 ? 0.88 : 1);
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.95 - s * 0.03]);
    }
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(0, s * 0.42);
    g.lineTo(0, -s * 0.36);
    for (const l of lobes.slice(1)) { g.moveTo(0, 0); g.lineTo(Math.cos(l) * R * 0.75, Math.sin(l) * R * 0.75); }
    g.stroke();
  }));
  const fly = sprite(48, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, "rgba(255,255,220,1)");
    gr.addColorStop(0.12, "rgba(230,255,120,.95)");
    gr.addColorStop(0.4, "rgba(200,240,80,.25)");
    gr.addColorStop(1, "rgba(180,230,60,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
  return { flake, petal, leaf, fly };
}

function spawn(w, h, fresh) {
  const y0 = fresh ? rand(0, h) : rand(-60, -20);
  if (kind === "winter") {
    const z = rand(0.35, 1);   // глубина: дальние снежинки мельче, медленнее и бледнее
    return { x: rand(0, w), y: y0, z, size: 4 + z * 9, vy: 22 + z * 48, sway: rand(10, 30), ph: rand(0, 6.3), sp: rand(0.4, 1.1), a: 0.35 + z * 0.6 };
  }
  if (kind === "spring") {
    const z = rand(0.5, 1);
    return { x: rand(-100, w), y: y0, z, img: pick(sprites.petal), size: 12 + z * 12, vy: 26 + z * 30, vx: rand(12, 34), sway: rand(16, 40), ph: rand(0, 6.3), sp: rand(0.6, 1.4), rot: rand(0, 6.3), vr: rand(-1.4, 1.4), flip: rand(0, 6.3), vf: rand(1.5, 3.5), a: 0.6 + z * 0.35 };
  }
  if (kind === "autumn") {
    const z = rand(0.5, 1);
    return { x: rand(0, w), y: y0, z, img: pick(sprites.leaf), size: 18 + z * 16, vy: 30 + z * 34, sway: rand(30, 70), ph: rand(0, 6.3), sp: rand(0.5, 1.1), rot: rand(0, 6.3), vr: rand(-1.2, 1.2), flip: rand(0, 6.3), vf: rand(1, 2.4), a: 0.6 + z * 0.35 };
  }
  // Лето: светлячки не падают, а бродят и мерцают.
  return { x: rand(0, w), y: fresh ? rand(h * 0.2, h) : h + 20, size: rand(16, 30), vx: rand(-12, 12), vy: rand(-14, -4), ph: rand(0, 6.3), sp: rand(0.6, 1.6), a: 1 };
}

function density(w, h) {
  const area = (w * h) / 1e6;
  return Math.round(area * ({ winter: 50, spring: 30, autumn: 16, summer: 26 }[kind] || 0));
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (document.hidden) { last = 0; return; }
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
  last = t;
  const w = canvas.width / window.devicePixelRatio, h = canvas.height / window.devicePixelRatio;
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const light = root.dataset.theme === "light";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.ph += p.sp * dt;
    if (kind === "summer") {
      p.vx += rand(-20, 20) * dt;
      p.vy += rand(-20, 20) * dt;
      p.vx = Math.max(-18, Math.min(18, p.vx));
      p.vy = Math.max(-18, Math.min(10, p.vy));
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y < -30 || p.x < -30 || p.x > w + 30) parts[i] = spawn(w, h, false);
      ctx.globalAlpha = 0.15 + Math.max(0, Math.sin(p.ph * 1.7)) * 0.85;
      ctx.drawImage(sprites.fly, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      continue;
    }
    p.y += p.vy * dt;
    const x = p.x + (p.vx ? (p.x0 = (p.x0 || 0) + p.vx * dt) : 0) + Math.sin(p.ph) * p.sway;
    if (p.y > h + 40 || x > w + 60) { parts[i] = spawn(w, h, false); continue; }
    ctx.globalAlpha = p.a;
    if (kind === "winter") {
      if (light) ctx.filter = "brightness(.75) sepia(.3) hue-rotate(170deg)";
      ctx.drawImage(sprites.flake, x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      ctx.filter = "none";
      continue;
    }
    p.rot += p.vr * dt;
    p.flip += p.vf * dt;
    ctx.save();
    ctx.translate(x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(Math.cos(p.flip), 1);   // лист/лепесток переворачивается в полёте
    ctx.drawImage(p.img, -p.size / 2, -p.size / 2, p.size, p.size);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Новогодняя гирлянда — разноцветные «сосульки» на окнах: тонкий провод провисает дугами из-под вкладок, команды,
// поиска и «Смотреть», по нему идут микро-огоньки, вниз свисают короткие нити с огоньками. Сдержанно: не на краю
// зрения и без ярких полос — работать не мешает. Свечение — радиальный градиент (без blur: огоньков сотни),
// мерцают вразнобой.
const HANG_FROM = ["#tabstrip", "#titlebar-team", "#open-cmdk", "#open-watch"];
const LED = ["#ff4d4d", "#ffc83d", "#3ddc6e", "#4a8cff", "#ff5fc8", "#3de0e0"];
let hangObs = null;
function led(x, y, k) {
  const r = rand(0.9, 1.3);
  const c = k % LED.length;
  return `<g class="sg-led" style="--d:${(-rand(0, 3)).toFixed(2)}s;--t:${rand(3.5, 6.5).toFixed(2)}s"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(5.5 * r).toFixed(1)}" fill="url(#sg-halo-${c})"/>`
    + `<circle class="sg-core" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1.25 * r).toFixed(2)}" fill="${LED[c]}"/></g>`;
}
function drawGarland() {
  if (!garland) return;
  if (kind !== "winter") { garland.innerHTML = ""; return; }
  const w = window.innerWidth, sag = 7;
  let wire = "", leds = "", k = 0, bottom = 0;
  const arc = (x0, x1, y0) => {
    const cx = (x0 + x1) / 2, step = x1 - x0;
    wire += `M${x0.toFixed(1)} ${y0.toFixed(1)} Q${cx.toFixed(1)} ${(y0 + sag * 2).toFixed(1)} ${x1.toFixed(1)} ${y0.toFixed(1)} `;
    const m = Math.max(3, Math.round(step / 11));
    for (let j = 0; j <= m; j++) {
      const t = j / m, x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1, y = y0 + 2 * (1 - t) * t * sag * 2;
      leds += led(x, y, k++);
      // нить-«сосулька» через каждые два огонька: 1–3 огонька вниз
      if (j % 2 === 1 && j < m) {
        const len = 1 + Math.floor(rand(0, 3));
        wire += `M${x.toFixed(1)} ${y.toFixed(1)} L${x.toFixed(1)} ${(y + len * 6).toFixed(1)} `;
        for (let q = 1; q <= len; q++) leds += led(x + rand(-0.6, 0.6), y + q * 6, k++);
        bottom = Math.max(bottom, y + len * 6 + 8);
      }
    }
  };
  for (const sel of HANG_FROM) {
    const el = document.querySelector(sel);
    const r = el && el.getBoundingClientRect();
    if (!r || r.width < 30 || !el.offsetParent) continue;
    const L = r.left + 8, R = r.right - 8, y0 = r.bottom - 2;
    const n = Math.max(1, Math.round((R - L) / 210));
    for (let i = 0; i < n; i++) arc(L + i * (R - L) / n, L + (i + 1) * (R - L) / n, y0);
  }
  // Свечение каждого огонька — своего цвета.
  const halos = LED.map((col, i) => `<radialGradient id="sg-halo-${i}"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".3" stop-color="${col}" stop-opacity=".55"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`).join("");
  garland.innerHTML = wire ? `<svg width="${w}" height="${bottom.toFixed(0)}"><defs>${halos}</defs>
    <path class="sg-wire" d="${wire}"/>${leds}</svg>` : "";
}

// Аватарки команды и вкладки меняют ширину — гирлянда перевешивается следом.
function watchHangers() {
  if (hangObs || typeof ResizeObserver === "undefined") return;
  hangObs = new ResizeObserver(() => drawGarland());
  for (const sel of HANG_FROM) { const el = document.querySelector(sel); if (el) hangObs.observe(el); }
}

// Шапка Деда Мороза на логотипе (видна только зимой — kadr.css).
function putHat() {
  // Не внутрь логотипа: он обрезает всё по краям (там бегает блик) и крутится при наведении.
  const logo = document.querySelector(".titlebar-left .brand-logo");
  if (!logo || logo.parentElement.querySelector(".season-hat")) return;
  logo.insertAdjacentHTML("afterend", `<svg class="season-hat" viewBox="0 0 40 34" aria-hidden="true">
    <defs><linearGradient id="sh-red" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff3a3a"/><stop offset="1" stop-color="#a30d16"/></linearGradient>
    <linearGradient id="sh-fur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9dee6"/></linearGradient></defs>
    <path d="M5 25 C7 12 16 4 26 5 C33 6 37 11 36 17 C33 13 29 12 27 14 C25 17 30 22 32 25 Z" fill="url(#sh-red)"/>
    <rect x="2" y="22.5" width="32" height="8.5" rx="4.2" fill="url(#sh-fur)"/>
    <circle cx="36" cy="17.5" r="4.6" fill="url(#sh-fur)"/></svg>`);
}

function resize() {
  drawGarland();
  if (!canvas) return;
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * window.devicePixelRatio);
  canvas.height = Math.round(h * window.devicePixelRatio);
  const n = density(w, h);
  while (parts.length < n) parts.push(spawn(w, h, true));
  parts.length = n;
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
  parts = [];
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function restart() {
  stop();
  kind = root.dataset.season || "";
  if (!kind) { if (layer) layer.hidden = true; return; }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "season-fx";
    layer.setAttribute("aria-hidden", "true");
    canvas = document.createElement("canvas");
    layer.appendChild(canvas);
    garland = document.createElement("div");
    garland.className = "season-garland";
    layer.appendChild(garland);
    // Сразу за фоном из обложки (#app-backdrop) — под окном приложения.
    const bd = document.getElementById("app-backdrop");
    if (bd) bd.after(layer);
    else document.body.prepend(layer);
    ctx = canvas.getContext("2d");
    window.addEventListener("resize", resize);
  }
  layer.hidden = false;
  putHat();
  watchHangers();
  drawGarland();
  setTimeout(drawGarland, 1500);   // вкладки и аватарки команды дорисовываются после входа
  if (root.dataset.motion === "off") return;   // свечение и гирлянда остаются, частицы стоят
  sprites ||= makeSprites();
  resize();
  raf = requestAnimationFrame(frame);
}

// Анимации выключили/включили в настройках — частицы встают или идут снова.
new MutationObserver(restart).observe(root, { attributes: true, attributeFilter: ["data-motion"] });

(function init() {
  const go = () => applySeason(seasonPref());
  if (document.body) go();
  else document.addEventListener("DOMContentLoaded", go, { once: true });
})();
