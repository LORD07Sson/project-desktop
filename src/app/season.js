// Сезонное оформление (Настройки → Внешний вид): поверх интерфейса — зимой снег, весной лепестки сакуры,
// летом светлячки, осенью листопад, плюс лёгкое свечение сезона по краям окна (kadr.css, :root[data-season]).
// «Авто» берёт сезон по дате. Слой не ловит клики; при выключенных анимациях и свёрнутом окне — стоит.

const KEY = "project-season";
export const SEASONS = { auto: "Авто", winter: "Зима", spring: "Весна", summer: "Лето", autumn: "Осень", off: "Выкл." };

const root = document.documentElement;
let layer = null, canvas = null, ctx = null, raf = 0, last = 0, parts = [], kind = "", sprites = null;

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
  return Math.round(area * ({ winter: 85, spring: 30, autumn: 16, summer: 26 }[kind] || 0));
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

function resize() {
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
    document.body.appendChild(layer);
    ctx = canvas.getContext("2d");
    window.addEventListener("resize", resize);
  }
  layer.hidden = false;
  if (root.dataset.motion === "off") return;   // свечение сезона остаётся, частицы стоят
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
