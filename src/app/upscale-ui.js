// «✨ Апскейл» на странице тайтла: обложку или баннер увеличивает ×4 нейросеть (upscale.rs: движок и модели Upscayl) —
// «Аниме» (digital-art-4x), «Резко» (ultrasharp-4x) или «Фото» (high-fidelity-4x). Берём исходник с сервера (?w=0 — без серверного растягивания), при первом запуске движок
// докачивается сам. Результат — сравнение «до/после» ползунком и сохранение PNG в выбранное место.

import { invoke, listen, pickOutputFile } from "./tauri.js";
import { mediaUrl, openSheet, toast } from "./api.js";
import { imgProxy } from "./title-page.js";
import { esc } from "./utils.js";

export function openUpscale(d) {
  const sources = [["poster", "Обложка"], ...(d.has_banner ? [["banner", "Баннер"]] : [])];
  const pick = { src: "poster", model: "anime" };
  const seg = (attr, items, cur) => `<div class="seg-toggle" role="group">${items.map(([v, l]) => `<button type="button" class="seg-btn${v === cur ? " active" : ""}" ${attr}="${v}">${l}</button>`).join("")}</div>`;
  const overlay = openSheet(`
    <div class="up">
      <div class="up-head"><h3>✨ Апскейл ×4</h3><span>${esc(d.name)}</span></div>
      <div class="up-row"><b>Что увеличить</b>${seg("data-up-src", sources, pick.src)}</div>
      <div class="up-row"><b>Нейросеть</b>${seg("data-up-model", [["anime", "Аниме-арт"], ["sharp", "Максимально резко"], ["photo", "Фото / реализм"]], pick.model)}</div>
      <div class="up-stage" data-up-stage><div class="up-hint">Нейросеть дорисует детали и уберёт мыло и квадратики сжатия. Работает на видеокарте. При первом запуске скачается движок и выбранная модель — один раз: аниме ≈11 МБ, резкая или фото ≈35 МБ.</div></div>
      <div class="up-prog" data-up-prog hidden><i></i><span></span></div>
      <div class="up-acts">
        <button type="button" class="btn" data-close>Закрыть</button>
        <button type="button" class="btn" data-up-save hidden>Сохранить PNG…</button>
        <button type="button" class="btn primary" data-up-run>Увеличить ×4</button>
      </div>
    </div>`, "wide");
  overlay.classList.add("up-overlay");
  const $ = sel => overlay.querySelector(sel);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  for (const [attr, key] of [["data-up-src", "src"], ["data-up-model", "model"]]) {
    overlay.querySelectorAll(`[${attr}]`).forEach(b => b.addEventListener("click", () => {
      overlay.querySelectorAll(`[${attr}]`).forEach(x => x.classList.toggle("active", x === b));
      pick[key] = b.getAttribute(attr);
    }));
  }

  let busy = false, resultUrl = "", originalUrl = "";
  const prog = $("[data-up-prog]");
  const setProg = (fraction, label) => {
    prog.hidden = false;
    prog.querySelector("i").style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    prog.querySelector("span").textContent = label;
  };
  const unlisten = listen("upscale-progress", e => { if (busy) setProg(e.payload.fraction, e.payload.label); });
  overlay.addEventListener("sheet-dismissed", cleanup);
  new MutationObserver((_, obs) => { if (!overlay.isConnected) { obs.disconnect(); cleanup(); } }).observe(document.body, { childList: true });
  function cleanup() {
    unlisten.then(f => f());
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    if (originalUrl) URL.revokeObjectURL(originalUrl);
  }

  $("[data-up-run]").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const run = $("[data-up-run]");
    run.disabled = true;
    $("[data-up-save]").hidden = true;
    setProg(0, "Беру оригинал картинки…");
    try {
      const url = mediaUrl(`/titles/${d.id}/art/${pick.src}`, { w: 0 }) || (pick.src === "poster" ? imgProxy(d.poster_url) : "");
      const r = url ? await fetch(url) : null;
      if (!r || r.status !== 200) throw new Error("Не удалось получить картинку с сервера.");
      const blob = await r.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const png = await invoke("upscale_image", { bytes: Array.from(bytes), model: pick.model });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      resultUrl = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      originalUrl = URL.createObjectURL(blob);
      await showCompare(originalUrl, resultUrl);
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
    const name = `${String(d.name || "title").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80)} — ${pick.src === "banner" ? "баннер" : "обложка"} x4.png`;
    const path = await pickOutputFile(name, [{ name: "PNG", extensions: ["png"] }]);
    if (!path) return;
    try {
      await invoke("upscale_save", { path });
      toast("Сохранено.");
    } catch (e) {
      toast(String(e), "error");
    }
  });

  // «До/после»: оригинал растянут до размера результата, результат поверх и срезан по ползунку.
  async function showCompare(before, after) {
    const [a, b] = await Promise.all([size(before), size(after)]);
    const stage = $("[data-up-stage]");
    stage.innerHTML = `
      <div class="up-cmp" style="aspect-ratio:${b.w} / ${b.h}" data-up-cmp>
        <img src="${before}" alt=""><img class="up-after" src="${after}" alt="">
        <i class="up-knob"></i><span class="up-tag l">до · ${a.w}×${a.h}</span><span class="up-tag r">после · ${b.w}×${b.h}</span>
      </div>`;
    const cmp = stage.querySelector("[data-up-cmp]");
    const move = x => {
      const r = cmp.getBoundingClientRect();
      cmp.style.setProperty("--cut", `${Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)).toFixed(1)}%`);
    };
    cmp.addEventListener("pointerdown", e => { cmp.setPointerCapture(e.pointerId); move(e.clientX); });
    cmp.addEventListener("pointermove", e => { if (e.buttons || e.pointerType === "mouse") move(e.clientX); });
  }
}

function size(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = url;
  });
}
