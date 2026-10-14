// Галерея игры как в Steam: трейлеры и скриншоты в одном просмотрщике. Чистая разметка и состояние, без сети (кроме потока трейлера).
// Трейлеры Steam отдаёт только как HLS: WebView2 такой поток сам не играет, поэтому подключаем hls.js (подгружается при первом трейлере).

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Список слайдов: сначала трейлеры (главный — первым), затем скриншоты. */
export function mediaItems(d) {
  const movies = (d.movies || []).slice().sort((a, b) => Number(b.hl) - Number(a.hl));
  return [
    ...movies.map(m => ({ kind: "video", name: m.name || "Трейлер", hls: m.hls, thumb: m.thumb })),
    ...(d.shots || []).map((s, i) => ({ kind: "shot", name: `Скриншот ${i + 1}`, full: s.full, thumb: s.thumb || s.full })),
  ];
}

export function galleryHtml(d, img, { initialIndex = 0 } = {}) {
  const items = mediaItems(d);
  if (!items.length) return "";
  const n = items.length;
  const first = Math.max(0, Math.min(n - 1, initialIndex));
  const strip = items.map((it, i) => `<button type="button" class="gm-gal-th${i === first ? " on" : ""}" data-gi="${i}" title="${esc(it.name)}" aria-label="${esc(it.name)}"><img loading="lazy" src="${esc(img(it.thumb))}" alt="">${it.kind === "video" ? `<i class="gm-gal-play">▶</i>` : ""}</button>`).join("");
  return `<div class="gm-gal" data-gal tabindex="0" aria-label="Трейлеры и скриншоты">
    <div class="gm-gal-main" data-gmain></div>
    ${n > 1 ? `<button type="button" class="gm-gal-nav prev" data-gstep="-1" aria-label="Назад">‹</button><button type="button" class="gm-gal-nav next" data-gstep="1" aria-label="Вперёд">›</button>` : ""}
    <button type="button" class="gm-gal-fs" data-gfs aria-label="На весь экран" title="На весь экран">⛶</button>
    <span class="gm-gal-cnt" data-gcnt>${first + 1} / ${n}</span>
    <div class="gm-gal-strip" data-gstrip>${strip}</div>
  </div>`;
}

let hlsLib = null;

async function attachStream(video, url) {
  if (video.canPlayType("application/vnd.apple.mpegurl")) { video.src = url; return null; }
  if (!hlsLib) hlsLib = (await import("hls.js")).default;
  if (!hlsLib.isSupported()) throw new Error("hls");
  const h = new hlsLib({ enableWorker: false });                    // воркер из blob: запрещён политикой безопасности приложения
  h.loadSource(url);
  h.attachMedia(video);
  return h;
}

/** Подключает галерею внутри root: клики по миниатюрам и стрелкам, клавиши ←/→, полный экран. Возвращает функцию остановки. */
export function mountGallery(root, d, img, { initialIndex = 0 } = {}) {
  const gal = root.querySelector("[data-gal]");
  if (!gal) return () => {};
  const items = mediaItems(d);
  const main = gal.querySelector("[data-gmain]"), cnt = gal.querySelector("[data-gcnt]"), strip = gal.querySelector("[data-gstrip]");
  let cur = -1, hls = null, gen = 0;

  const stop = () => {
    gen++;
    if (hls) { try { hls.destroy(); } catch (_) { /* уже остановлен */ } hls = null; }
    const v = main.querySelector("video");
    if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) { /* нечего останавливать */ } }
  };

  const show = (i, play) => {
    if (!items.length) return;
    cur = (i + items.length) % items.length;
    stop();
    const it = items[cur];
    if (it.kind === "shot") {
      main.innerHTML = `<img class="gm-gal-img" src="${esc(img(it.full))}" alt="${esc(it.name)}">`;
    } else {
      main.innerHTML = `<button type="button" class="gm-gal-poster" data-gplay aria-label="Смотреть трейлер"><img src="${esc(img(it.thumb))}" alt=""><i>▶</i></button>`;
      if (play) startVideo();
    }
    cnt.textContent = `${cur + 1} / ${items.length}`;
    strip.querySelectorAll(".gm-gal-th").forEach((b, k) => b.classList.toggle("on", k === cur));
    const on = strip.querySelector(".gm-gal-th.on");
    // Scroll the thumbnails only. scrollIntoView also moved the surrounding game page.
    if (on) strip.scrollLeft = Math.max(0, on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2);
  };

  const startVideo = async () => {
    const it = items[cur], my = ++gen;
    main.innerHTML = `<video class="gm-gal-vid" controls playsinline preload="auto" poster="${esc(img(it.thumb))}"></video><span class="gm-gal-load"><span class="ny-spin"></span></span>`;
    const v = main.querySelector("video");
    const clear = () => { const l = main.querySelector(".gm-gal-load"); if (l) l.remove(); };
    v.addEventListener("playing", clear);
    try {
      const h = await attachStream(v, it.hls);
      if (my !== gen) { if (h) h.destroy(); return; }
      hls = h;
      await v.play().catch(() => { /* автозапуск мог быть запрещён: остаётся кнопка плеера */ });
      clear();
    } catch (_) {
      if (my !== gen) return;
      main.innerHTML = `<div class="gm-gal-err">Не удалось проиграть трейлер.<button type="button" class="btn sm" data-gweb>Открыть в Steam</button></div>`;
    }
  };

  const onClick = e => {
    const th = e.target.closest("[data-gi]");
    if (th) { show(Number(th.dataset.gi), items[Number(th.dataset.gi)].kind === "video"); return; }
    const st = e.target.closest("[data-gstep]");
    if (st) { show(cur + Number(st.dataset.gstep), false); return; }
    if (e.target.closest("[data-gplay]")) { startVideo(); return; }
    if (e.target.closest("[data-gfs]")) {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (gal.requestFullscreen) gal.requestFullscreen().catch(() => { /* полноэкранный режим недоступен */ });
      return;
    }
    if (e.target.closest(".gm-gal-img")) { show(cur + 1, false); return; }
    if (e.target.closest("[data-gweb]")) gal.dispatchEvent(new CustomEvent("gm-gal-web", { bubbles: true }));
  };
  const onKey = e => {
    if (e.target.closest && e.target.closest("input,textarea,select")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); show(cur + 1, false); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); show(cur - 1, false); }
  };
  // Leaving the overview also cancels a trailer that is still attaching its stream.
  const onPause = () => { if (items[cur]?.kind === "video") show(cur, false); };
  gal.addEventListener("click", onClick);
  gal.addEventListener("keydown", onKey);
  gal.addEventListener("gm-gal-pause", onPause);
  show(Math.max(0, Math.min(items.length - 1, initialIndex)), false);
  return () => { stop(); gal.removeEventListener("click", onClick); gal.removeEventListener("keydown", onKey); gal.removeEventListener("gm-gal-pause", onPause); };
}
