// Граффити на профиле: прозрачный PNG поверх всей страницы профиля (/api/graffiti/{id}).
// Видят все, рисуют только разработчики — прямо по странице, инструменты: карандаш, фломастер, маркер, баллончик, ластик.

import { state } from "./state.js";
import { apiPost, mediaUrl, toast, askConfirm } from "./api.js";

const COLORS = ["#ffffff", "#111111", "#ff3b6b", "#ff9f1c", "#ffe14d", "#3ddc84", "#2ec5ff", "#7a5cff", "#ff5cf0"];
const TOOLS = [
  ["pencil", "Карандаш", 3],
  ["felt", "Фломастер", 7],
  ["marker", "Маркер", 22],
  ["spray", "Баллончик", 26],
  ["eraser", "Ластик", 24],
];

// Показывает сохранённое граффити поверх шапки. Возвращает слой (img) или null.
// Ближайший прокручиваемый предок профиля; по бокам его подрезаем, чтобы широкий рисунок не давал горизонтальной прокрутки.
function scrollerOf(el) {
  let sc = el.parentElement;
  while (sc && sc !== document.body && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  if (!sc || sc === document.body) return null;
  sc.style.overflowX = "clip";
  return sc;
}

export function loadGraffiti(hero, telegramId) {
  if (!hero || !telegramId) return;
  scrollerOf(hero);
  hero.querySelector(".pf-graffiti")?.remove();
  const src = mediaUrl(`/graffiti/${encodeURIComponent(telegramId)}`, { t: Date.now() });
  if (!src) return;
  const img = new Image();
  img.className = "pf-graffiti";
  img.alt = "";
  img.draggable = false;
  // Рисунок в своих пикселях и по центру профиля: колонка профиля центрирована, так штрихи остаются на месте при любой ширине окна.
  img.onload = () => {
    if (img.naturalWidth <= 1) return;
    img.style.width = `${img.naturalWidth}px`; img.style.height = `${img.naturalHeight}px`;
    hero.append(img);
    snapCycle(hero, img);
  };
  img.onerror = () => {};
  img.src = src;
}

// ===== Появление и «щелчок Таноса» =====
// При открытии профиля рисунок проявляется (будто его наносят), держится и рассыпается пылью слоями слева
// направо — до следующего открытия профиля. Пыль — DUST_LAYERS холстов: каждый непрозрачный пиксель случайно (со сдвигом
// по X) отдаётся одному слою, и слои по очереди улетают вверх-вправо, тая и размываясь.
const HOLD_MS = 7000, DUST_LAYERS = 18, DUST_MAX_PX = 1_200_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = (hero, img) => img.isConnected && !hero.classList.contains("gf-editing") && hero.querySelector(".pf-graffiti") === img;

async function snapCycle(hero, img) {
  await img.animate([
    { clipPath: "inset(0 100% 0 0)", filter: "blur(6px) brightness(1.8)", opacity: 0 },
    { clipPath: "inset(0 0 0 0)", filter: "blur(0) brightness(1)", opacity: 1 },
  ], { duration: 1400, easing: "cubic-bezier(.2,.7,.2,1)" }).finished.catch(() => {});
  await sleep(HOLD_MS);
  if (!alive(hero, img)) return;
  let dust;
  try { dust = await dustLayers(img); } catch (_) { return; } // не вышло разобрать — просто остаётся на месте
  if (alive(hero, img)) await snap(hero, img, dust);
}

// Готовит слои пыли один раз: рисунок берём файлом (иначе холст «чужой» и пиксели не прочитать),
// режем по рамке нарисованного и при необходимости уменьшаем, чтобы не держать в памяти десятки мегапикселей.
async function dustLayers(img) {
  const bmp = await fetch(img.src).then(r => r.blob()).then(b => window.createImageBitmap(b));
  const k = Math.min(1, Math.sqrt(DUST_MAX_PX / (bmp.width * bmp.height)));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const src = document.createElement("canvas"); src.width = w; src.height = h;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0, w, h); bmp.close();
  const all = sctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (all[(y * w + x) * 4 + 3]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error("empty");
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const px = sctx.getImageData(x0, y0, bw, bh).data;
  const outs = Array.from({ length: DUST_LAYERS }, () => new window.ImageData(bw, bh));
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = (y * bw + x) * 4;
    if (!px[i + 3]) continue;
    const L = Math.min(DUST_LAYERS - 1, Math.floor(DUST_LAYERS * (Math.random() * 0.55 + (x / bw) * 0.45)));
    const d = outs[L].data; d[i] = px[i]; d[i + 1] = px[i + 1]; d[i + 2] = px[i + 2]; d[i + 3] = px[i + 3];
  }
  return { k, x0, y0, bw, bh, outs };
}

async function snap(hero, img, dust) {
  const wrap = document.createElement("div");
  wrap.className = "gf-dust";
  // Рисунок сдвинут transform-ом к центру (offsetLeft этого не видит), поэтому место берём из реальных рамок.
  const ir = img.getBoundingClientRect(), hr = hero.getBoundingClientRect();
  Object.assign(wrap.style, { left: `${ir.left - hr.left - hero.clientLeft}px`, top: `${ir.top - hr.top - hero.clientTop}px`, width: `${ir.width}px`, height: `${ir.height}px` });
  const s = 1 / dust.k;
  const layers = dust.outs.map(data => {
    const c = document.createElement("canvas"); c.width = dust.bw; c.height = dust.bh;
    c.getContext("2d").putImageData(data, 0, 0);
    Object.assign(c.style, { left: `${dust.x0 * s}px`, top: `${dust.y0 * s}px`, width: `${dust.bw * s}px`, height: `${dust.bh * s}px` });
    wrap.append(c);
    return c;
  });
  hero.append(wrap);
  img.style.visibility = "hidden";
  await Promise.all(layers.map((c, i) => {
    const a = (Math.random() - 0.3) * Math.PI / 3;
    const dist = 90 + Math.random() * 140;
    return c.animate([
      { transform: "none", opacity: 1, filter: "blur(0)" },
      { transform: `translate(${Math.cos(a) * dist}px, ${-Math.abs(Math.sin(a)) * dist - 40}px) rotate(${(Math.random() - 0.5) * 30}deg)`, opacity: 0, filter: "blur(2px)" },
    ], { duration: 1500 + Math.random() * 500, delay: i * 95, easing: "cubic-bezier(.45,0,.9,.6)", fill: "forwards" }).finished.catch(() => {});
  }));
  wrap.remove();
}

export function wireGraffiti(root, telegramId) {
  const hero = root.querySelector(".pf-folio");
  loadGraffiti(hero, telegramId);
  const btn = root.querySelector("[data-graffiti-edit]");
  if (btn && state.isDeveloper) btn.addEventListener("click", () => openEditor(hero, telegramId));
}

function openEditor(hero, telegramId) {
  if (!hero || hero.querySelector(".gf-canvas")) return;
  // Холст на всю длину профиля — в 1×, иначе на длинной странице выходят десятки мегапикселей.
  const dpr = 1;
  // Ширина — всё окно прокрутки (поля слева и справа тоже), высота — весь профиль.
  const sc = scrollerOf(hero);
  const W = Math.round(sc ? sc.clientWidth : window.innerWidth), H = Math.round(hero.scrollHeight);
  const canvas = document.createElement("canvas");
  canvas.className = "gf-canvas";
  canvas.width = W; canvas.height = H;
  const stroke = document.createElement("canvas"); // текущий штрих — отдельно, чтобы полупрозрачный маркер не темнел на самопересечениях
  stroke.className = "gf-canvas gf-stroke";
  stroke.width = W; stroke.height = H;
  for (const c of [canvas, stroke]) { c.style.width = `${W}px`; c.style.height = `${H}px`; }
  const ctx = canvas.getContext("2d");
  const sctx = stroke.getContext("2d");

  // Сохранённый рисунок берём файлом (fetch → ImageBitmap), а не через <img> с сервера: картинка с чужого адреса
  // «пачкает» холст, и дальше getImageData (Очистить, Отменить, Сохранить) падает с SecurityError.
  const old = hero.querySelector(".pf-graffiti");
  if (old && old.naturalWidth > 1) {
    fetch(old.src).then(r => (r.ok ? r.blob() : Promise.reject(new Error(r.status)))).then(b => window.createImageBitmap(b))
      .then(bmp => { ctx.drawImage(bmp, Math.round((W - bmp.width) / 2), 0); bmp.close(); })
      .catch(() => toast("Не удалось загрузить сохранённое граффити — рисуете с чистого листа.", "error"));
  }
  if (old) old.style.visibility = "hidden";

  let tool = "felt", color = COLORS[2], size = 7;
  const undo = [];
  const bar = document.createElement("div");
  bar.className = "gf-bar";
  bar.innerHTML = `
    <div class="gf-group">${TOOLS.map(([id, t]) => `<button type="button" class="gf-tool${id === tool ? " on" : ""}" data-tool="${id}" data-size="${TOOLS.find(x => x[0] === id)[2]}">${t}</button>`).join("")}</div>
    <div class="gf-group">${COLORS.map(c => `<button type="button" class="gf-color${c === color ? " on" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
      <input type="color" class="gf-pick" value="${color}" title="Свой цвет"></div>
    <label class="gf-size">размер <input type="range" min="1" max="60" value="${size}"></label>
    <div class="gf-group">
      <button type="button" class="btn sm" data-gf="image">Картинка</button>
      <input type="file" accept="image/*" class="gf-file" hidden>
      <button type="button" class="btn sm" data-gf="undo">Отменить</button>
      <button type="button" class="btn sm" data-gf="clear">Очистить</button>
      <button type="button" class="btn sm" data-gf="cancel">Закрыть</button>
      <button type="button" class="btn sm primary" data-gf="save">Сохранить</button>
    </div>`;
  hero.append(canvas, stroke);
  hero.classList.add("gf-editing");
  hero.append(bar);
  const range = bar.querySelector(".gf-size input");

  bar.addEventListener("click", async e => {
    const t = e.target.closest("[data-tool]");
    if (t) {
      tool = t.dataset.tool; size = Number(t.dataset.size); range.value = String(size);
      bar.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b === t));
      return;
    }
    const c = e.target.closest("[data-color]");
    if (c) { setColor(c.dataset.color); return; }
    const a = e.target.closest("[data-gf]")?.dataset.gf;
    if (a === "undo" && undo.length) ctx.putImageData(undo.pop(), 0, 0);
    else if (a === "clear") { pushUndo(); ctx.clearRect(0, 0, W, H); }
    else if (a === "image") bar.querySelector(".gf-file").click();
    else if (a === "cancel") close(false);
    else if (a === "save") save();
  });
  bar.querySelector(".gf-pick").addEventListener("input", e => setColor(e.target.value));

  // «Картинка»: свой файл кладём поверх профиля — двигаешь мышью, размер колесом, «Вставить» впечатывает её в рисунок.
  let placing = null;
  bar.querySelector(".gf-file").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => startPlace(img, url);
    img.onerror = () => { URL.revokeObjectURL(url); toast("Не удалось открыть картинку.", "error"); };
    img.src = url;
  });
  function startPlace(img, url) {
    placing?.cancel();
    const r = stroke.getBoundingClientRect();
    let w = Math.min(520, img.naturalWidth), h = w * img.naturalHeight / img.naturalWidth;
    let x = Math.max(0, window.innerWidth / 2 - r.left - w / 2), y = Math.max(0, window.innerHeight / 2 - r.top - h / 2);
    const box = document.createElement("div");
    box.className = "gf-place";
    box.innerHTML = `<div class="gf-place-acts"><button type="button" class="btn sm primary" data-p="ok">Вставить</button><button type="button" class="btn sm" data-p="no">Отмена</button><span>тяни мышью · колесо — размер</span></div>`;
    box.prepend(img);
    hero.append(box);
    const put = () => { box.style.left = `calc(50% - ${W / 2}px + ${x}px)`; box.style.top = `${y}px`; box.style.width = `${w}px`; box.style.height = `${h}px`; };
    put();
    let drag = null;
    img.addEventListener("pointerdown", e => { e.preventDefault(); img.setPointerCapture(e.pointerId); drag = { sx: e.clientX, sy: e.clientY, x, y }; });
    img.addEventListener("pointermove", e => { if (!drag) return; x = drag.x + e.clientX - drag.sx; y = drag.y + e.clientY - drag.sy; put(); });
    img.addEventListener("pointerup", () => { drag = null; });
    box.addEventListener("wheel", e => {
      e.preventDefault();
      const k = e.deltaY < 0 ? 1.08 : 1 / 1.08, nw = Math.max(40, Math.min(W, w * k));
      x += (w - nw) / 2; y += (h - nw * h / w) / 2; h = nw * h / w; w = nw; put();
    }, { passive: false });
    const done = () => { box.remove(); URL.revokeObjectURL(url); placing = null; };
    box.querySelector('[data-p="ok"]').addEventListener("click", () => { pushUndo(); ctx.drawImage(img, x, y, w, h); done(); });
    box.querySelector('[data-p="no"]').addEventListener("click", done);
    placing = { cancel: done };
  }
  range.addEventListener("input", () => { size = Number(range.value); });
  function setColor(c) {
    color = c;
    bar.querySelectorAll("[data-color]").forEach(b => b.classList.toggle("on", b.dataset.color === c));
    bar.querySelector(".gf-pick").value = c;
  }
  function pushUndo() {
    undo.push(ctx.getImageData(0, 0, W, H));
    if (undo.length > 25) undo.shift();
  }

  let drawing = false, last = null, sprayTimer = 0;
  const pos = e => {
    const r = stroke.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  };
  const px = () => size * dpr;
  const spray = p => {
    const rad = px();
    sctx.fillStyle = color;
    for (let i = 0; i < Math.round(rad * 1.2); i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * rad;
      sctx.fillRect(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, dpr, dpr);
    }
  };
  const seg = (a, b) => {
    if (tool === "spray") {
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (px() / 3)));
      for (let i = 1; i <= n; i++) spray({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
      return;
    }
    sctx.strokeStyle = tool === "eraser" ? "#000" : color;
    sctx.lineWidth = px();
    sctx.lineCap = tool === "marker" ? "square" : "round";
    sctx.lineJoin = "round";
    if (tool === "pencil") {
      // карандаш: тонкая линия с лёгкой «зернистостью» — пара смещённых полупрозрачных проходов
      sctx.globalAlpha = 0.55;
      for (let k = 0; k < 2; k++) {
        const j = () => (Math.random() - 0.5) * dpr;
        sctx.beginPath(); sctx.moveTo(a.x + j(), a.y + j()); sctx.lineTo(b.x + j(), b.y + j()); sctx.stroke();
      }
      sctx.globalAlpha = 1;
      return;
    }
    sctx.beginPath(); sctx.moveTo(a.x, a.y); sctx.lineTo(b.x, b.y); sctx.stroke();
  };
  stroke.style.opacity = "1";
  stroke.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    stroke.setPointerCapture(e.pointerId);
    drawing = true; pushUndo();
    last = pos(e);
    stroke.style.opacity = tool === "marker" ? "0.45" : tool === "eraser" ? "0.35" : "1";
    seg(last, { x: last.x + 0.01, y: last.y });
    if (tool === "spray") sprayTimer = setInterval(() => last && spray(last), 30); // DevSkim: ignore DS172411 — функция, не строка
  });
  stroke.addEventListener("pointermove", e => {
    if (!drawing) return;
    const p = pos(e);
    seg(last, p); last = p;
  });
  const end = () => {
    if (!drawing) return;
    drawing = false; clearInterval(sprayTimer);
    ctx.save();
    if (tool === "eraser") ctx.globalCompositeOperation = "destination-out";
    else ctx.globalAlpha = tool === "marker" ? 0.45 : 1;
    ctx.drawImage(stroke, 0, 0);
    ctx.restore();
    sctx.clearRect(0, 0, W, H);
  };
  stroke.addEventListener("pointerup", end);
  stroke.addEventListener("pointercancel", end);

  async function save() {
    const px = ctx.getImageData(0, 0, W, H).data;
    let empty = true;
    for (let i = 3; i < px.length; i += 4) if (px[i]) { empty = false; break; }
    try {
      await apiPost(`/graffiti/${encodeURIComponent(telegramId)}`, { png: empty ? "" : canvas.toDataURL("image/png") });
      toast(empty ? "Граффити стёрто." : "Граффити сохранено — его видят все.");
      close(true);
    } catch (e) { toast(`Не удалось сохранить: ${e.message}`, "error"); }
  }
  async function close(saved) {
    if (!saved && undo.length && !await askConfirm("Выйти без сохранения?")) return;
    placing?.cancel();
    canvas.remove(); stroke.remove(); bar.remove();
    hero.classList.remove("gf-editing");
    if (saved) loadGraffiti(hero, telegramId);
    else if (old) old.style.visibility = "";
  }
}
