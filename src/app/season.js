// Сезонное оформление (Настройки → Внешний вид): за интерфейсом — зимой снег и новогодняя гирлянда сверху,
// весной лепестки сакуры, летом светлячки, осенью листопад, на Хэллоуин (24.10–2.11) летучие мыши и гирлянда
// с тыквами, плюс свечение сезона по краям окна
// (kadr.css, :root[data-season]). Слой лежит сразу за фоном из обложки и под окном приложения — сквозь стекло
// видно, но поверх карточек не летает. «Авто» берёт сезон по дате; при выключенных анимациях и свёрнутом окне — стоит.

const KEY = "project-season";
export const SEASONS = { auto: "Авто", winter: "Зима", spring: "Весна", summer: "Лето", autumn: "Осень", halloween: "Хэллоуин", off: "Выкл." };

const root = document.documentElement;
let layer = null, canvas = null, ctx = null, raf = 0, last = 0, parts = [], kind = "", sprites = null;

export function seasonPref() {
  let v = "auto";
  try { v = localStorage.getItem(KEY) || "auto"; } catch (_) { /* приватный режим */ }
  return SEASONS[v] ? v : "auto";
}

function byDate(d = new Date()) {
  const m = d.getMonth(), day = d.getDate();
  if ((m === 9 && day >= 24) || (m === 10 && day <= 2)) return "halloween";
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
  // Летучая мышь — два кадра взмаха: крылья вверх и вниз.
  const bat = [-1, 1].map(up => sprite(64, (g, s) => {
    g.translate(s / 2, s / 2);
    g.fillStyle = "#24133a";
    g.shadowColor = "rgba(190, 110, 255, .9)";
    g.shadowBlur = 7;
    const tip = up * 14;
    g.beginPath();
    g.moveTo(0, -4);
    for (const side of [1, -1]) {
      g.lineTo(side * 6, -5);
      g.quadraticCurveTo(side * 16, -6 + tip * 0.5, side * 28, -2 + tip);
      // нижний край крыла — «фестоны» между пальцами
      g.quadraticCurveTo(side * 24, 2 + tip * 0.6, side * 20, 4 + tip * 0.4);
      g.quadraticCurveTo(side * 16, 1 + tip * 0.3, side * 12, 6 + tip * 0.2);
      g.quadraticCurveTo(side * 9, 3, side * 5, 6);
      g.lineTo(0, 7);
      if (side === 1) g.moveTo(0, -4);
    }
    g.fill();
    g.beginPath();
    g.ellipse(0, 1, 4, 6, 0, 0, Math.PI * 2);   // тельце
    g.moveTo(-3, -4); g.lineTo(-2.4, -9); g.lineTo(-0.8, -5);   // уши
    g.moveTo(3, -4); g.lineTo(2.4, -9); g.lineTo(0.8, -5);
    g.fill();
  }));
  return { flake, petal, leaf, fly, bat };
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
  if (kind === "halloween") {
    const dir = Math.random() < 0.5 ? 1 : -1;
    return { x: fresh ? rand(0, w) : dir > 0 ? -50 : w + 50, y: rand(h * 0.08, h * 0.75), size: rand(26, 46), vx: dir * rand(45, 100), sway: rand(10, 26), ph: rand(0, 6.3), sp: rand(1, 2), flap: rand(0, 6.3), a: rand(0.55, 0.85) };
  }
  // Лето: светлячки не падают, а бродят и мерцают.
  return { x: rand(0, w), y: fresh ? rand(h * 0.2, h) : h + 20, size: rand(16, 30), vx: rand(-12, 12), vy: rand(-14, -4), ph: rand(0, 6.3), sp: rand(0.6, 1.6), a: 1 };
}

function density(w, h) {
  const area = (w * h) / 1e6;
  return Math.round(area * ({ winter: 50, spring: 30, autumn: 16, summer: 26, halloween: 5 }[kind] || 0));
}

function frame(t) {
  raf = window.requestAnimationFrame(frame);
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
    if (kind === "halloween") {
      p.x += p.vx * dt;
      p.flap += dt * 14;
      if (p.x < -60 || p.x > w + 60) { parts[i] = spawn(w, h, false); continue; }
      ctx.globalAlpha = p.a;
      ctx.save();
      ctx.translate(p.x, p.y + Math.sin(p.ph) * p.sway);
      if (p.vx < 0) ctx.scale(-1, 1);
      ctx.drawImage(sprites.bat[Math.sin(p.flap) > 0 ? 0 : 1], -p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
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

// Гирлянда внутри панелей: по верхнему краю панели вкладок, поиска и «Смотреть», над надписями. Зимой — мелкие
// разноцветные огоньки, на Хэллоуин — мини-тыквы-фонарики. SVG кладём прямо в панель (кликам не мешает), поэтому
// она сидит над стеклом панели, а не размывается за ним. Свечение — радиальный градиент, мерцают вразнобой.
const HANG_IN = ["#tabstrip", "#open-cmdk", "#open-watch"];
const PALETTE = { winter: ["#ff4d4d", "#ffc83d", "#3ddc6e", "#4a8cff", "#ff5fc8", "#3de0e0"], halloween: ["#ff7a1a"] };
let hangObs = null;

function led(id, x, y, c, col) {
  return `<g class="sg-led" style="--d:${(-rand(0, 3)).toFixed(2)}s;--t:${rand(3.5, 6.5).toFixed(2)}s"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="url(#${id}-h${c})"/>`
    + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.3" fill="${col}"/></g>`;
}

// Мини-тыква-фонарик: объёмная, светится изнутри, глаза и зубастый рот горят жёлтым.
function pumpkin(id, x, y, k = 0.62) {
  return `<g class="sg-pumpkin" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k})" style="--d:${(-rand(0, 4)).toFixed(2)}s">`
    + `<circle cx="0" cy="9" r="12" fill="url(#${id}-pkh)"/><path d="M0 0 L0 3" stroke="#1a1a1a" stroke-width="1"/>`
    + `<path d="M-.4 3.4 Q.8 1.8 2.2 2.2 L1.4 4.4Z" fill="#4c7a24"/>`
    + `<ellipse cx="-3.6" cy="9.4" rx="3.6" ry="5.4" fill="url(#${id}-pk)" stroke="#a8400a" stroke-width=".5"/>`
    + `<ellipse cx="3.6" cy="9.4" rx="3.6" ry="5.4" fill="url(#${id}-pk)" stroke="#a8400a" stroke-width=".5"/>`
    + `<ellipse cx="0" cy="9.4" rx="3.4" ry="5.8" fill="url(#${id}-pk)" stroke="#a8400a" stroke-width=".5"/>`
    + `<path class="sg-face" d="M-4.2 7.6 L-2.6 5.6 L-1.2 7.6Z M1.2 7.6 L2.6 5.6 L4.2 7.6Z M-.6 9.6 L0 8.4 L.6 9.6Z M-4.4 10.8 L-3.3 12.4 L-2.2 11.4 L-1.1 13 L0 11.6 L1.1 13 L2.2 11.4 L3.3 12.4 L4.4 10.8 Q0 12 -4.4 10.8Z"/></g>`;
}

function drawGarland() {
  const pal = PALETTE[kind];
  HANG_IN.forEach((sel, n) => {
    const el = document.querySelector(sel);
    if (!el) return;
    let svg = el.querySelector(":scope > .sg-in");
    if (!pal) { if (svg) svg.remove(); return; }
    const w = el.clientWidth;
    if (w < 40) return;
    if (!svg) {
      el.insertAdjacentHTML("afterbegin", `<svg class="sg-in" aria-hidden="true"></svg>`);
      svg = el.querySelector(":scope > .sg-in");
    }
    const id = `sg${n}`, x0 = 16, x1 = w - 16, y0 = 4.5, sag = 0;   // ровная линия, мимо скруглённых углов
    const halo = kind === "halloween" ? 22 : 13;   // шаг между фонариками
    const m = Math.max(2, Math.round((x1 - x0) / halo));
    let body = "";
    for (let j = 0; j <= m; j++) {
      const t = j / m, x = x0 + (x1 - x0) * t, y = y0 + 4 * t * (1 - t) * sag;
      if (kind === "halloween") { if (j < m) body += pumpkin(id, x + (x1 - x0) / m / 2, y0 + 4 * (t + 0.5 / m) * (1 - t - 0.5 / m) * sag, el.clientHeight < 40 ? 0.46 : 0.62); }
      else { const c = j % pal.length; body += led(id, x, y, c, pal[c]); }
    }
    const defs = kind === "halloween"
      ? `<radialGradient id="${id}-pk" cx=".5" cy=".45" r=".6"><stop offset="0" stop-color="#ffc163"/><stop offset=".55" stop-color="#ff8a1f"/><stop offset="1" stop-color="#d4540a"/></radialGradient>`
        + `<radialGradient id="${id}-pkh"><stop offset="0" stop-color="#ffb347" stop-opacity=".5"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient>`
      : pal.map((col, i) => `<radialGradient id="${id}-h${i}"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".3" stop-color="${col}" stop-opacity=".5"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`).join("");
    svg.style.width = `${w}px`;   // стиль, а не атрибут: у кнопок свой размер для svg-иконок
    svg.innerHTML = `<defs>${defs}</defs><path class="sg-wire" d="M${x0} ${y0} Q${(x0 + x1) / 2} ${y0 + sag * 2} ${x1} ${y0}"/>${body}`;
  });
}

// Панели меняют ширину (вкладки, окно) — гирлянда перерисовывается следом.
function watchHangers() {
  if (hangObs || typeof ResizeObserver === "undefined") return;
  hangObs = new ResizeObserver(() => drawGarland());
  for (const sel of HANG_IN) { const el = document.querySelector(sel); if (el) hangObs.observe(el); }
}

// Шапка Деда Мороза (зимой) и шляпа ведьмы (на Хэллоуин) на логотипе — что видно, решает kadr.css.
function putHat() {
  // Не внутрь логотипа: он обрезает всё по краям (там бегает блик) и крутится при наведении.
  const logo = document.querySelector(".titlebar-left .brand-logo");
  if (!logo || logo.parentElement.querySelector(".season-hat")) return;
  logo.insertAdjacentHTML("afterend", `<svg class="season-hat" viewBox="0 0 40 34" aria-hidden="true">
    <defs><linearGradient id="sh-red" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff3a3a"/><stop offset="1" stop-color="#a30d16"/></linearGradient>
    <linearGradient id="sh-fur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9dee6"/></linearGradient></defs>
    <path d="M5 25 C7 12 16 4 26 5 C33 6 37 11 36 17 C33 13 29 12 27 14 C25 17 30 22 32 25 Z" fill="url(#sh-red)"/>
    <rect x="2" y="22.5" width="32" height="8.5" rx="4.2" fill="url(#sh-fur)"/>
    <circle cx="36" cy="17.5" r="4.6" fill="url(#sh-fur)"/></svg>
    <svg class="season-hat witch" viewBox="0 0 40 34" aria-hidden="true">
    <defs><linearGradient id="wh-cone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9b5cff"/><stop offset="1" stop-color="#4a1f8a"/></linearGradient></defs>
    <path d="M10 27 C13 19 17 11 20 5 C21.5 1.5 26 0 30 3 C27 3 25.5 5 25.5 8.5 L29.5 27 Z" fill="url(#wh-cone)" stroke="#c9a3ff" stroke-width=".7"/>
    <path d="M11.3 23 L29 23 L29.6 27 L10.5 27 Z" fill="#ff7a1a"/><rect x="18.2" y="22.6" width="4.2" height="4.6" rx=".6" fill="none" stroke="#ffd34d" stroke-width="1.1"/>
    <ellipse cx="20" cy="28" rx="19" ry="4.2" fill="#5a2aa0" stroke="#c9a3ff" stroke-width=".7"/></svg>`);
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
  window.cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
  parts = [];
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function restart() {
  stop();
  kind = root.dataset.season || "";
  if (!kind) { if (layer) layer.hidden = true; drawGarland(); return; }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "season-fx";
    layer.setAttribute("aria-hidden", "true");
    canvas = document.createElement("canvas");
    layer.appendChild(canvas);
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
  raf = window.requestAnimationFrame(frame);
}

// Анимации выключили/включили в настройках — частицы встают или идут снова.
if (typeof MutationObserver !== "undefined") new MutationObserver(restart).observe(root, { attributes: true, attributeFilter: ["data-motion"] });

(function init() {
  // Вне настоящего окна (проверка модулей в Node) — ни холста, ни кадров анимации.
  if (typeof window.requestAnimationFrame !== "function" || typeof window.cancelAnimationFrame !== "function") return;
  try { if (!document.createElement("canvas").getContext("2d")) return; } catch (_) { return; }
  const go = () => applySeason(seasonPref());
  if (document.body) go();
  else document.addEventListener("DOMContentLoaded", go, { once: true });
})();
