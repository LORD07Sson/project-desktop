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
  img.onload = () => { if (img.naturalWidth > 1) { img.style.width = `${img.naturalWidth}px`; img.style.height = `${img.naturalHeight}px`; hero.append(img); } };
  img.onerror = () => {};
  img.src = src;
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
