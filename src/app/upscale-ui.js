// «✨ Апскейл» на странице тайтла: нейросеть (upscale.rs: движок и модели Upscayl) увеличивает обложку, баннер или
// свою картинку (файл с диска или Ctrl+V) — «Аниме» (digital-art-4x) или «Резко» (ultrasharp-4x), ×2/×3/×4 или до
// нужной ширины; можно поставить свою ncnn-модель (.param + .bin). Обложку и баннер берём с сервера исходником (?w=0 — без серверного растягивания); при первом запуске
// движок и модель докачиваются сами. Результат — сравнение «до/после» и сохранение PNG в выбранное место.

import { invoke, listen, pickInputFile, pickInputFiles, pickOutputFile } from "./tauri.js";
import { mediaUrl, openSheet, toast, askConfirm } from "./api.js";
import { imgProxy } from "./title-page.js";
import { esc } from "./utils.js";

// Размер результата: во сколько раз или до какой ширины (px).
const SIZES = [["x2", "×2"], ["x3", "×3"], ["x4", "×4"], ["w1920", "1920 px"], ["w2560", "2560 px"], ["w3840", "4K · 3840"]];
const IMAGE_TYPES = ["png", "jpg", "jpeg", "webp", "bmp"];
const BUILTIN = [["anime", "Аниме-арт"], ["sharp", "Максимально резко"]];

export function openUpscale(d) {
  const sources = [["poster", "Обложка"], ...(d.has_banner ? [["banner", "Баннер"]] : []), ["own", "Своя картинка…"]];
  const pick = { src: "poster", model: "anime", size: "x4" };
  // input — то, что увеличиваем: blob, имя для файла и размер исходника
  let input = null, busy = false, resultUrl = "", inputUrl = "";
  const seg = (attr, items, cur) => `<div class="seg-toggle" role="group">${items.map(([v, l]) => `<button type="button" class="seg-btn${v === cur ? " active" : ""}" ${attr}="${v}">${l}</button>`).join("")}</div>`;
  const overlay = openSheet(`
    <div class="up">
      <div class="up-head"><h3>✨ Апскейл</h3><span>${esc(d.name)}</span></div>
      <div class="up-row"><b>Что увеличить</b>${seg("data-up-src", sources, pick.src)}</div>
      <div class="up-row"><b>Нейросеть</b><div class="up-models" data-up-models></div></div>
      <div class="up-row"><b>Размер <em class="up-dims" data-up-dims></em></b>${seg("data-up-size", SIZES, pick.size)}</div>
      <div class="up-stage" data-up-stage><div class="up-hint">Нейросеть дорисует детали и уберёт мыло и квадратики сжатия. Работает на видеокарте. При первом запуске скачается движок и выбранная модель — один раз: аниме ≈11 МБ, резкая ≈35 МБ.</div></div>
      <div class="up-prog" data-up-prog hidden><i></i><span></span></div>
      <div class="up-acts">
        <span class="up-tip">Свою картинку можно вставить: Ctrl+V</span>
        <button type="button" class="btn" data-close>Закрыть</button>
        <button type="button" class="btn" data-up-save hidden>Сохранить PNG…</button>
        <button type="button" class="btn primary" data-up-run>Увеличить</button>
      </div>
    </div>`, "wide");
  overlay.classList.add("up-overlay");
  const $ = sel => overlay.querySelector(sel);
  const selectSeg = (attr, value) => overlay.querySelectorAll(`[${attr}]`).forEach(x => x.classList.toggle("active", x.getAttribute(attr) === value));
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  // Нейросети: встроенные + свои (ncnn .param/.bin). Своя — ключ «custom:имя».
  let custom = [];
  const short = n => (n.length > 22 ? `${n.slice(0, 21)}…` : n);
  function renderModels() {
    const items = [...BUILTIN, ...custom.map(n => [`custom:${n}`, short(n)])];
    if (!items.some(([v]) => v === pick.model)) pick.model = "anime";
    const box = $("[data-up-models]");
    box.innerHTML = seg("data-up-model", items, pick.model)
      + `<button type="button" class="up-link" data-up-add title="Своя ncnn-модель: файлы .param и .bin (например, из github.com/upscayl/custom-models)">＋ Своя модель</button>`
      + (pick.model.startsWith("custom:") ? `<button type="button" class="up-link danger" data-up-del>Удалить</button>` : "");
    box.querySelectorAll("[data-up-model]").forEach(b => b.addEventListener("click", () => { pick.model = b.dataset.upModel; renderModels(); }));
    box.querySelector("[data-up-add]").addEventListener("click", addModel);
    box.querySelector("[data-up-del]")?.addEventListener("click", removeModel);
  }
  async function addModel() {
    const paths = await pickInputFiles({ multiple: true, filters: [{ name: "Модель ncnn (.param и .bin)", extensions: ["param", "bin"] }] });
    if (!paths.length) return;
    try {
      const before = new Set(custom);
      custom = await invoke("upscale_model_add", { paths });
      const added = custom.find(n => !before.has(n));
      if (added) pick.model = `custom:${added}`;
      renderModels();
      toast(added ? `Модель «${added}» добавлена.` : "Модель обновлена.");
    } catch (e) {
      toast(String(e), "error");
    }
  }
  async function removeModel() {
    const name = pick.model.slice("custom:".length);
    if (!await askConfirm(`Удалить свою модель «${name}»?`, { yes: "Удалить" })) return;
    try {
      custom = await invoke("upscale_model_remove", { name });
      pick.model = "anime";
      renderModels();
    } catch (e) {
      toast(String(e), "error");
    }
  }
  renderModels();
  invoke("upscale_models").then(list => { custom = list || []; renderModels(); }).catch(() => {});
  overlay.querySelectorAll("[data-up-size]").forEach(b => b.addEventListener("click", () => { pick.size = b.dataset.upSize; selectSeg("data-up-size", pick.size); showDims(); }));
  overlay.querySelectorAll("[data-up-src]").forEach(b => b.addEventListener("click", () => chooseSource(b.dataset.upSrc)));

  const target = () => {
    if (!input) return null;
    const { w, h } = input;
    if (pick.size.startsWith("w")) {
      const tw = Number(pick.size.slice(1));
      return { w: tw, h: Math.round(h * tw / w) };
    }
    const k = Number(pick.size.slice(1));
    return { w: w * k, h: h * k };
  };
  function showDims() {
    const t = target();
    $("[data-up-dims]").textContent = t ? `${input.w}×${input.h} → ${t.w}×${t.h}` : "";
  }

  // Исходник показываем сразу — видно, что именно будем увеличивать.
  async function setInput(blob, name) {
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    inputUrl = URL.createObjectURL(blob);
    const { w, h } = await size(inputUrl);
    if (!w) throw new Error("Это не картинка или формат не поддерживается.");
    input = { blob, name, w, h };
    $("[data-up-stage]").innerHTML = `<img class="up-src" src="${inputUrl}" alt="">`;
    $("[data-up-save]").hidden = true;
    $("[data-up-run]").textContent = "Увеличить";
    showDims();
  }

  async function chooseSource(src) {
    if (busy) return;
    try {
      if (src === "own") {
        const path = await pickInputFile([{ name: "Картинки", extensions: IMAGE_TYPES }]);
        if (!path) return;
        const bytes = await invoke("upscale_read", { path });
        const name = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
        await setInput(new Blob([toBytes(bytes)]), name);
      } else {
        const url = mediaUrl(`/titles/${d.id}/art/${src}`, { w: 0 }) || (src === "poster" ? imgProxy(d.poster_url) : "");
        const r = url ? await fetch(url) : null;
        if (!r || r.status !== 200) throw new Error("Не удалось получить картинку с сервера.");
        await setInput(await r.blob(), `${String(d.name || "title").slice(0, 80)} — ${src === "banner" ? "баннер" : "обложка"}`);
      }
      pick.src = src;
      selectSeg("data-up-src", src);
    } catch (e) {
      toast(String(e && e.message ? e.message : e), "error");
    }
  }

  // Ctrl+V — картинка из буфера обмена (скриншот, скопированная из браузера).
  const onPaste = e => {
    if (!overlay.isConnected || busy) return;
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    setInput(file, "картинка из буфера").then(() => { pick.src = "own"; selectSeg("data-up-src", "own"); })
      .catch(err => toast(String(err && err.message ? err.message : err), "error"));
  };
  document.addEventListener("paste", onPaste);

  const prog = $("[data-up-prog]");
  const setProg = (fraction, label) => {
    prog.hidden = false;
    prog.querySelector("i").style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    prog.querySelector("span").textContent = label;
  };
  const unlisten = listen("upscale-progress", e => { if (busy) setProg(e.payload.fraction, e.payload.label); });
  let cleaned = false;
  overlay.addEventListener("sheet-dismissed", cleanup);
  new MutationObserver((_, obs) => { if (!overlay.isConnected) { obs.disconnect(); cleanup(); } }).observe(document.body, { childList: true });
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener("paste", onPaste);
    unlisten.then(f => f());
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    if (inputUrl) URL.revokeObjectURL(inputUrl);
  }

  chooseSource("poster");

  $("[data-up-run]").addEventListener("click", async () => {
    if (busy || !input) return;
    busy = true;
    const run = $("[data-up-run]");
    run.disabled = true;
    $("[data-up-save]").hidden = true;
    setProg(0, "Готовлю картинку…");
    try {
      const bytes = new Uint8Array(await input.blob.arrayBuffer());
      const sizeArg = pick.size.startsWith("w") ? { width: Number(pick.size.slice(1)) } : { scale: Number(pick.size.slice(1)) };
      const png = await invoke("upscale_image", { bytes: Array.from(bytes), model: pick.model, ...sizeArg });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(new Blob([toBytes(png)], { type: "image/png" }));
      await showCompare(inputUrl, resultUrl);
      input.done = pick.size;
      $("[data-up-save]").hidden = false;
      prog.hidden = true;
      run.textContent = "Ещё раз";
    } catch (e) {
      prog.hidden = true;
      toast(String(e && e.message ? e.message : e), "error");
    } finally {
      busy = false;
      run.disabled = false;
    }
  });

  $("[data-up-save]").addEventListener("click", async () => {
    const suffix = (input.done || pick.size).replace(/^w(\d+)/, "$1px");
    const name = `${input.name.replace(/[\\/:*?"<>|]+/g, " ").trim()} ${suffix}.png`;
    const path = await pickOutputFile(name, [{ name: "PNG", extensions: ["png"] }]);
    if (!path) return;
    try {
      await invoke("upscale_save", { path });
      toast("Сохранено.");
    } catch (e) {
      toast(String(e), "error");
    }
  });

  // «До/после»: оригинал растянут до размера результата, результат поверх и срезан по линии. Вписанная в окно
  // картинка ×4 уменьшается обратно, и разницы почти не видно — поэтому колесо приближает (до ×8) к точке под
  // курсором, обе половины вместе; правая кнопка двигает приближенную картинку, двойной клик — обратно целиком.
  async function showCompare(before, after) {
    const [a, b] = await Promise.all([size(before), size(after)]);
    const stage = $("[data-up-stage]");
    stage.innerHTML = `
      <div class="up-cmp" style="aspect-ratio:${b.w} / ${b.h}" data-up-cmp>
        <div class="up-layer"><img src="${before}" alt=""></div><div class="up-layer up-after"><img src="${after}" alt=""></div>
        <i class="up-knob"></i><span class="up-tag l">до · ${a.w}×${a.h}</span><span class="up-tag r">после · ${b.w}×${b.h}</span>
        <span class="up-zoom" data-up-zoom>колесо — приблизить</span>
      </div>`;
    const cmp = stage.querySelector("[data-up-cmp]");
    const zoomTag = cmp.querySelector("[data-up-zoom]");
    const view = { z: 1, x: 0, y: 0 };
    const apply = () => {
      const r = cmp.getBoundingClientRect();
      // не даём увести картинку за край: при ×z сдвиг в пределах [размер·(1−z); 0]
      view.x = Math.min(0, Math.max(r.width * (1 - view.z), view.x));
      view.y = Math.min(0, Math.max(r.height * (1 - view.z), view.y));
      cmp.style.setProperty("--tf", `translate(${view.x.toFixed(1)}px, ${view.y.toFixed(1)}px) scale(${view.z.toFixed(3)})`);
      zoomTag.textContent = view.z > 1.01 ? `×${view.z.toFixed(1)} · правая кнопка — двигать, двойной клик — целиком` : "колесо — приблизить";
    };
    const cut = x => {
      const r = cmp.getBoundingClientRect();
      cmp.style.setProperty("--cut", `${Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)).toFixed(1)}%`);
    };
    cmp.addEventListener("wheel", e => {
      e.preventDefault();
      const r = cmp.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const z = Math.max(1, Math.min(8, view.z * (e.deltaY < 0 ? 1.25 : 0.8)));
      view.x = px - (px - view.x) * (z / view.z);
      view.y = py - (py - view.y) * (z / view.z);
      view.z = z;
      apply();
    }, { passive: false });
    let pan = null;
    cmp.addEventListener("contextmenu", e => e.preventDefault());
    cmp.addEventListener("pointerdown", e => {
      cmp.setPointerCapture(e.pointerId);
      if (e.button === 2 || e.button === 1) pan = { x: e.clientX - view.x, y: e.clientY - view.y };
      else cut(e.clientX);
    });
    cmp.addEventListener("pointermove", e => {
      if (pan) { view.x = e.clientX - pan.x; view.y = e.clientY - pan.y; apply(); }
      else if (e.buttons & 1 || e.pointerType === "mouse") cut(e.clientX);
    });
    cmp.addEventListener("pointerup", () => { pan = null; });
    cmp.addEventListener("dblclick", () => { view.z = 1; view.x = 0; view.y = 0; apply(); });
  }
}

// Сырой ответ команды (tauri::ipc::Response) приходит ArrayBuffer'ом только по двоичному каналу IPC; при запасном
// (postMessage, как в сборке с нашей CSP) — обычным массивом чисел. Blob из такого массива — текст «137,80,…», не PNG.
function toBytes(data) {
  return data instanceof ArrayBuffer || Array.isArray(data) ? new Uint8Array(data) : data;
}

function size(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = url;
  });
}
