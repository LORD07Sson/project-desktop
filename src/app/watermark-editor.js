// Редактор водяного знака: логотип png, положение на макете кадра 16:9, прозрачность и размер.
// Один и тот же редактор — у тайтла (/titles/{id}/watermark) и общий знак студии (titleId = 0, /titles/0/watermark):
// общий накладывается при сборке на серии без тайтла и на тайтлы без своего знака.

import { apiGet, apiPost, apiUpload, openSheet, toast, dialogSkeletonHtml, mediaUrl, askConfirm } from "./api.js";
import { pickFile } from "./attachments.js";
import { esc } from "./utils.js";

const EMPTY = { has: false, corner: "br", opacity: 60, scale: 15, x: null, y: null };

export function loadWatermark(titleId) {
  return apiGet(`/titles/${titleId}/watermark`).catch(() => ({ ...EMPTY }));
}

export function watermarkSectionHtml(titleId, wm) {
  return `
<div class="detail-section" id="ta-watermark">
  <h3>${titleId ? "Водяной знак" : "Общий водяной знак студии"}</h3>
  <div class="no-assignee" style="margin-bottom:8px;">${titleId ? "Логотип (png, лучше с прозрачным фоном) накладывается на серии тайтла при сборке финала." : "Общий логотип студии: накладывается при сборке на серии без тайтла и на тайтлы, у которых нет своего знака."}</div>
  ${titleId && !wm.has ? `<div class="no-assignee wm-studio-note" style="margin-bottom:8px;">Своего знака у тайтла нет — при сборке берётся общий знак студии. <button type="button" class="btn sm ghost" id="wm-open-studio">Общий знак студии</button></div>` : ""}
  <div class="add-row" style="align-items:center; gap:10px;">
    ${wm.has ? `<span style="background:repeating-conic-gradient(#8884 0 25%, transparent 0 50%) 50% / 14px 14px; border-radius:6px; padding:4px;"><img src="${mediaUrl(`/titles/${titleId}/watermark/image`, { v: Date.now() })}" alt="" style="max-height:48px; max-width:120px; display:block;"></span><span class="meta wm-fname" title="${esc(wm.name || "logo.png")}">${esc(wm.name || "logo.png")}</span>` : `<span class="meta">Логотип не загружен</span>`}
    <button class="btn" id="wm-pick">${wm.has ? "Заменить png" : "Загрузить png"}</button>
    ${wm.has ? `<button class="btn ghost" id="wm-trim" title="Если в png вокруг знака большой прозрачный кадр, двигать можно только весь кадр. Обрезка оставляет только рисунок — на видео он останется на том же месте и того же размера.">✂ Обрезать пустые поля</button><button class="btn ghost" id="wm-clear">Убрать</button>` : ""}
  </div>
  ${wm.has ? `<div class="wm-edit">
    <div class="wm-zoombar">
      <button type="button" class="btn ghost" id="wm-zoom-out" title="Отдалить">−</button>
      <span class="meta" id="wm-zoom-val">100%</span>
      <button type="button" class="btn ghost" id="wm-zoom-in" title="Приблизить">＋</button>
      <button type="button" class="btn ghost" id="wm-zoom-fit" title="Весь кадр">Весь кадр</button>
      <button type="button" class="btn ghost" id="wm-zoom-logo" title="Приблизить к знаку">🔍 К знаку</button>
      <button type="button" class="btn ghost" id="wm-bg" title="Сменить фон макета, чтобы знак было лучше видно">Фон: тёмный</button>
      <label class="cp-check" style="margin:0;" title="Знак слегка притягивается к краям и центру кадра"><input type="checkbox" id="wm-snap"> Прилипать к краям</label>
    </div>
    <div class="wm-view" id="wm-view">
    <div class="wm-stage" id="wm-stage" title="Перетащите знак мышью — где поставите, там он и будет в видео. Колесо мыши — приближение">
      <i class="wm-g wm-g-v1"></i><i class="wm-g wm-g-v2"></i><i class="wm-g wm-g-h1"></i><i class="wm-g wm-g-h2"></i><i class="wm-g wm-safe"></i>
      <img class="wm-logo" id="wm-logo" tabindex="0" draggable="false" src="${mediaUrl(`/titles/${titleId}/watermark/image`, { v: Date.now() })}" alt="Водяной знак">
      <span class="wm-stage-note">кадр видео 16:9</span>
    </div>
    </div>
    <div class="wm-pos-row">
      <span class="meta" id="wm-pos-label"></span>
      <span class="wm-presets">${[["tl", "↖", 0, 0], ["tr", "↗", 1, 0], ["bl", "↙", 0, 1], ["br", "↘", 1, 1], ["c", "●", .5, .5]].map(([k, label, x, y]) => `<button type="button" class="btn ghost" data-wm-preset="${x}:${y}" title="Поставить в угол или по центру">${label}</button>`).join("")}</span>
    </div>
    <div class="no-assignee">Перетащите знак мышью или кликните в нужную точку. Колесо мыши приближает (как лупа), приблизенный кадр двигается полосами прокрутки или средней кнопкой мыши. Стрелки на клавиатуре двигают знак на 1%, с Shift — на 5%.</div>
  </div>` : ""}
  <div class="add-row" style="align-items:center; gap:10px;">
    <span class="meta" style="min-width:90px;">Прозрачность</span>
    <input id="wm-opacity" type="range" min="5" max="100" step="5" value="${wm.opacity}" style="flex:1;">
    <b id="wm-opacity-val" style="min-width:44px; text-align:right;">${wm.opacity}%</b>
  </div>
  <div class="add-row" style="align-items:center; gap:10px;">
    <span class="meta" style="min-width:90px;">Размер</span>
    <input id="wm-scale" type="range" min="1" max="100" step="1" value="${wm.scale}" style="flex:1;">
    <b id="wm-scale-val" style="min-width:44px; text-align:right;">${wm.scale}%</b>
  </div>
  <div class="no-assignee">Размер — доля ширины видео. Настройки сохраняются кнопкой ниже.</div>
  <div class="add-row"><button class="btn primary" id="wm-save"${wm.has ? "" : " disabled"}>Сохранить настройки знака</button></div>
</div>`;
}

export function wireWatermarkSection(sheet, titleId, wm, rerender) {
  sheet.querySelector("#wm-open-studio")?.addEventListener("click", () => openStudioWatermark());
  // ---- водяной знак
  const CORNER_POS = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1], c: [.5, .5] };
  const startPos = wm.x != null && wm.y != null ? [wm.x, wm.y] : (CORNER_POS[wm.corner] || [1, 1]);
  let wmX = startPos[0], wmY = startPos[1];
  let wmSnap = false; // прилипание к краям и центру — по желанию, по умолчанию знак двигается свободно
  const stage = sheet.querySelector("#wm-stage");
  const logo = sheet.querySelector("#wm-logo");
  const MARGIN = 0.02; // как в сборке: поле 2% ширины со всех сторон
  const layoutLogo = () => {
    if (!stage || !logo) return;
    const sw = stage.clientWidth;
    const w = sw * Number(sheet.querySelector("#wm-scale").value) / 100;
    logo.style.width = `${w}px`;
    const h = logo.offsetHeight || w * 0.4;
    const m = sw * MARGIN;
    logo.style.left = `${m + Math.max(0, sw - w - 2 * m) * wmX}px`;
    logo.style.top = `${m + Math.max(0, stage.clientHeight - h - 2 * m) * wmY}px`;
    logo.style.opacity = String(Number(sheet.querySelector("#wm-opacity").value) / 100);
    const label = sheet.querySelector("#wm-pos-label");
    if (label) label.textContent = `Слева ${Math.round(wmX * 100)}% · сверху ${Math.round(wmY * 100)}%`;
  };
  const setPos = (x, y, snap = true) => {
    const near = v => (snap && wmSnap ? ([0, .5, 1].find(t => Math.abs(v - t) < 0.012) ?? v) : v);
    wmX = Math.max(0, Math.min(1, near(x)));
    wmY = Math.max(0, Math.min(1, near(y)));
    layoutLogo();
  };
  if (stage && logo) {
    logo.addEventListener("load", layoutLogo);
    new ResizeObserver(layoutLogo).observe(stage);
    const view = sheet.querySelector("#wm-view");
    let zoom = 1;
    const ZOOM_MIN = 1, ZOOM_MAX = 8;
    const applyZoom = (z, anchorX = 0.5, anchorY = 0.5) => {
      // anchor — точка внутри видимой области (0..1), которая остаётся на месте при изменении масштаба.
      const oldW = stage.clientWidth, oldH = stage.clientHeight;
      const ax = (view.scrollLeft + view.clientWidth * anchorX) / oldW;
      const ay = (view.scrollTop + view.clientHeight * anchorY) / oldH;
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
      stage.style.width = `${zoom * 100}%`;
      layoutLogo();
      view.scrollLeft = ax * stage.clientWidth - view.clientWidth * anchorX;
      view.scrollTop = ay * stage.clientHeight - view.clientHeight * anchorY;
      const val = sheet.querySelector("#wm-zoom-val");
      if (val) val.textContent = `${Math.round(zoom * 100)}%`;
    };
    view.addEventListener("wheel", e => {
      e.preventDefault();
      const r = view.getBoundingClientRect();
      applyZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    }, { passive: false });
    sheet.querySelector("#wm-zoom-in").addEventListener("click", () => applyZoom(zoom * 1.5));
    sheet.querySelector("#wm-zoom-out").addEventListener("click", () => applyZoom(zoom / 1.5));
    sheet.querySelector("#wm-zoom-fit").addEventListener("click", () => applyZoom(1));
    sheet.querySelector("#wm-zoom-logo").addEventListener("click", () => {
      applyZoom(5);
      // Знак — в центр видимой области.
      const cx = logo.offsetLeft + logo.offsetWidth / 2, cy = logo.offsetTop + logo.offsetHeight / 2;
      view.scrollLeft = cx - view.clientWidth / 2;
      view.scrollTop = cy - view.clientHeight / 2;
    });
    sheet.querySelector("#wm-snap").addEventListener("change", e => { wmSnap = e.target.checked; });
    const BGS = [["dark", "тёмный"], ["light", "светлый"], ["check", "шашка"], ["green", "зелёный"]];
    let bgIndex = 0;
    sheet.querySelector("#wm-bg").addEventListener("click", e => {
      bgIndex = (bgIndex + 1) % BGS.length;
      stage.dataset.bg = BGS[bgIndex][0];
      e.currentTarget.textContent = `Фон: ${BGS[bgIndex][1]}`;
    });
    // Перемещение приблизенного кадра средней кнопкой мыши.
    let pan = null;
    view.addEventListener("pointerdown", e => {
      if (e.button !== 1) return;
      pan = { x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop };
      view.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    view.addEventListener("pointermove", e => {
      if (!pan) return;
      view.scrollLeft = pan.sl - (e.clientX - pan.x);
      view.scrollTop = pan.st - (e.clientY - pan.y);
    });
    view.addEventListener("pointerup", () => { pan = null; });
    const toFraction = (clientX, clientY, grabX, grabY) => {
      const r = stage.getBoundingClientRect();
      const w = logo.offsetWidth, h = logo.offsetHeight, m = r.width * MARGIN;
      const left = clientX - r.left - grabX, top = clientY - r.top - grabY;
      return [(left - m) / Math.max(1, r.width - w - 2 * m), (top - m) / Math.max(1, r.height - h - 2 * m)];
    };
    let drag = null;
    stage.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const lr = logo.getBoundingClientRect();
      // Клик мимо знака ставит его центром в эту точку, потом его можно подвигать дальше.
      drag = e.target === logo ? { gx: e.clientX - lr.left, gy: e.clientY - lr.top } : { gx: lr.width / 2, gy: lr.height / 2 };
      stage.setPointerCapture(e.pointerId);
      const [x, y] = toFraction(e.clientX, e.clientY, drag.gx, drag.gy);
      setPos(x, y);
      e.preventDefault();
    });
    stage.addEventListener("pointermove", e => {
      if (!drag) return;
      const [x, y] = toFraction(e.clientX, e.clientY, drag.gx, drag.gy);
      setPos(x, y);
    });
    const stop = () => { drag = null; };
    stage.addEventListener("pointerup", stop);
    stage.addEventListener("pointercancel", stop);
    logo.addEventListener("keydown", e => {
      const step = e.shiftKey ? 0.05 : 0.01;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      setPos(wmX + d[0], wmY + d[1], false);
    });
    sheet.querySelectorAll("[data-wm-preset]").forEach(btn => btn.addEventListener("click", () => {
      const [x, y] = btn.dataset.wmPreset.split(":").map(Number);
      setPos(x, y, false);
    }));
    layoutLogo();
  }
  for (const [id, valId] of [["#wm-opacity", "#wm-opacity-val"], ["#wm-scale", "#wm-scale-val"]]) {
    sheet.querySelector(id).addEventListener("input", e => { sheet.querySelector(valId).textContent = `${e.target.value}%`; layoutLogo(); });
  }
  const wmFields = () => ({
    x: String(wmX), y: String(wmY),
    opacity: sheet.querySelector("#wm-opacity").value,
    scale: sheet.querySelector("#wm-scale").value,
  });

  sheet.querySelector("#wm-pick").addEventListener("click", async () => {
    const file = await pickFile("image/png");
    if (!file) return;
    try {
      const saved = await apiUpload(`/titles/${titleId}/watermark`, file, wmFields());
      toast(saved && saved.trimmed ? "Водяной знак загружен, пустые поля обрезаны — теперь знак двигается свободно." : "Водяной знак загружен.", "success");
      await rerender();
    } catch (e) { toast(`Не удалось загрузить: ${e.message}`, "error"); }
  });
  sheet.querySelector("#wm-save").addEventListener("click", async () => {
    const f = wmFields();
    try {
      await apiPost(`/titles/${titleId}/watermark/settings`, { x: Number(f.x), y: Number(f.y), opacity: Number(f.opacity), scale: Number(f.scale) });
      toast("Настройки водяного знака сохранены.", "success");
    } catch (e) { toast(`Не удалось сохранить: ${e.message}`, "error"); }
  });
  sheet.querySelector("#wm-trim")?.addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await apiPost(`/titles/${titleId}/watermark/trim`, {});
      toast(r.trimmed ? "Пустые поля обрезаны: на видео знак остался на месте и того же размера, теперь его можно двигать." : "Обрезать нечего — знак уже без пустых полей.", "success");
      await rerender();
    } catch (err) {
      toast(`Не удалось обрезать: ${err.message}`, "error");
      btn.disabled = false;
    }
  });
  sheet.querySelector("#wm-clear")?.addEventListener("click", async () => {
    if (!await askConfirm(titleId ? "Убрать водяной знак у тайтла?" : "Убрать общий водяной знак студии?")) return;
    try {
      await apiPost(`/titles/${titleId}/watermark/delete`, {});
      await rerender();
    } catch (e) { toast(`Не удалось убрать: ${e.message}`, "error"); }
  });
}

// Отдельное окно с общим знаком студии — из карточки серии без тайтла и из раздела знака у тайтла.
export async function openStudioWatermark() {
  const overlay = openSheet(dialogSkeletonHtml(4), "wide");
  const sheet = overlay.querySelector(".sheet");
  async function render() {
    const wm = await loadWatermark(0);
    sheet.innerHTML = `${watermarkSectionHtml(0, wm)}
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    wireWatermarkSection(sheet, 0, wm, render);
  }
  await render();
}
