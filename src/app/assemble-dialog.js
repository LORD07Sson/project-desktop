// Окно «Собрать финал» в десктопе: выбор видео, субтитров, дорожек даббера (несколько), режима звука и профиля качества —
// и запуск сборки прямо отсюда, без кнопок в Telegram. Сервер: GET /api/report/{id}/assemble-options, POST …/assemble/start.
// Саму сборку ведёт бот (задание забирается за пару секунд), ход виден в карточке отчёта (startAssemblyWatch), отмена — там же.

import { apiGet, apiPost, apiUpload, openSheet, dismissSheet, toast } from "./api.js";
import { esc } from "./utils.js";
import { can } from "./state.js";
import { getLocalVideo } from "./local-video.js";
import { localRenderSupport, prepareLocalRender, describeTools } from "./local-render.js";

export async function openAssembleDialog(publicId) {
  const overlay = openSheet(`<h2>Собрать финал</h2><div class="no-assignee">Загружаю файлы отчёта…</div>`);
  const sheet = overlay.querySelector(".sheet");
  let opts;
  try {
    opts = await apiGet(`/report/${publicId}/assemble-options`);
  } catch (e) {
    sheet.innerHTML = `<h2>Собрать финал</h2><div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => dismissSheet(overlay));
    return false;
  }

  // Видео, которое качается/лежит на этом компьютере: на сервер оно не загружается, собрать можно только «у себя».
  const localVideo = getLocalVideo(publicId);
  const hasLocalVideo = !!localVideo && localVideo.state !== "lost";
  if (hasLocalVideo && opts.missing) opts.missing = opts.missing.filter(m => !/видео/i.test(m));

  return new Promise(resolve => {
    let mode = "replace";
    
    let coverImage = null;  // {file_id, name, url} после загрузки своей картинки
    const finish = started => { resolve(started); dismissSheet(overlay); };  // сначала ответ: закрытие шлёт «sheet-dismissed» → false
    overlay.addEventListener("sheet-dismissed", () => resolve(false));

    if (opts.missing && opts.missing.length) {
      sheet.innerHTML = `<h2>Собрать финал</h2><div class="bc-warn">Нельзя собрать: ${esc(opts.missing.join("; "))}.</div>
        <p class="ar-hint">Прикрепите к отчёту видео и файл субтитров (.ass, .ssa или .srt).</p>
        <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => finish(false));
      return;
    }

    const radios = (name, items, label) => `
      <span class="ar-label">${label}</span>
      <div class="ar-list">${items.map((f, i) => `
        <label class="ar-row ad-pick"><input type="radio" name="${name}" value="${f.id}" ${i === 0 ? "checked" : ""}>
          <b>${esc(f.name)}</b>${f.version ? `<span class="ar-meta">v${f.version}</span>` : ""}</label>`).join("")}</div>`;

    const localRow = () => {
      if (!hasLocalVideo) return "";
      const pct = Math.round((localVideo.progress || 0) * 100);
      const meta = localVideo.state === "downloading" ? `качается: ${pct}% — сборка подождёт` : "на этом компьютере, на сервер не загружается";
      return `<label class="ar-row ad-pick"><input type="radio" name="ad-video" value="local" checked>
          <b>💻 ${esc(localVideo.name)}</b><span class="ar-meta">${esc(meta)}</span></label>`;
    };
    const videoPicker = () => {
      if (!hasLocalVideo) return radios("ad-video", opts.videos, "Видео");
      return `<span class="ar-label">Видео</span><div class="ar-list">${localRow()}${opts.videos.map(f => `
        <label class="ar-row ad-pick"><input type="radio" name="ad-video" value="${f.id}">
          <b>${esc(f.name)}</b>${f.version ? `<span class="ar-meta">v${f.version}</span>` : ""}</label>`).join("")}</div>`;
    };

    sheet.innerHTML = `
      <h2>Собрать финал</h2>
      <div class="ad-body">
        ${videoPicker()}
        <span class="ar-label">Субтитры <small>— вшиваются в картинку, будут видны всегда</small></span>
        <div class="ar-list">
          ${opts.subs.map((f, i) => `
          <label class="ar-row ad-pick"><input type="radio" name="ad-sub" value="${f.id}" ${i === 0 ? "checked" : ""}>
            <b>${esc(f.name)}</b>${f.version ? `<span class="ar-meta">v${f.version}</span>` : ""}</label>`).join("")}
          <label class="ar-row ad-pick"><input type="radio" name="ad-sub" value="0" ${opts.subs.length ? "" : "checked"}><b>Без субтитров</b>
            <span class="ar-meta">${opts.subs.length ? "видео без субтитров" : "файла субтитров в отчёте нет — видео будет без них"}</span></label>
        </div>
        <span class="ar-label">Надпись поверх видео <small>— необязательно: можно без субтитров или вместе с ними</small></span>
        <input class="field-input" id="ad-ins-text" placeholder="например: Озвучка DreamyVoice · серия 12">
        <div class="ar-fields" id="ad-ins-opts" hidden>
          <select class="field-input" id="ad-ins-pos" style="max-width:190px;">
            <option value="bottom">Снизу по центру</option><option value="top">Сверху по центру</option><option value="center">По центру</option>
            <option value="tl">Левый верх</option><option value="tr">Правый верх</option><option value="bl">Левый низ</option><option value="br">Правый низ</option>
          </select>
          <select class="field-input" id="ad-ins-size" style="max-width:150px;"><option value="3.5">Мелкая</option><option value="5" selected>Средняя</option><option value="8">Крупная</option></select>
          <select class="field-input" id="ad-ins-dur" style="max-width:200px;">
            <option value="0">Всё видео</option><option value="5">Первые 5 секунд</option><option value="10">Первые 10 секунд</option><option value="30">Первые 30 секунд</option>
          </select>
        </div>
        <p class="ar-hint">Что будет с оригиналом: из mkv всегда убираются его встроенные субтитры, шрифты, главы и названия дорожек — остаётся одна видеодорожка и одна звуковая. Потом в картинку вшиваются выбранные вами субтитры и/или надпись (или ничего, если не выбрали). Субтитры и надписи, которые уже «выжжены» в само изображение оригинала, убрать нельзя.</p>
        ${opts.audios.length ? `
        <span class="ar-label">Дорожки даббера <small>— отметьте нужные, звучат вместе</small></span>
        <div class="ar-list">${opts.audios.map(a => `
          <label class="ar-row ad-pick"><input type="checkbox" data-ad-audio="${a.id}"><b>${a.archive ? "📦 " : ""}${esc(a.name)}</b>${a.archive ? `<span class="ar-meta">архив — возьму все звуковые файлы внутри</span>` : ""}</label>`).join("")}</div>
        <div class="ar-seg" id="ad-mode" hidden>
          <button type="button" data-v="replace" class="on">Заменить оригинал<small>слышна только дорожка</small></button>
          <button type="button" data-v="mix">Смешать с оригиналом<small>оба звука вместе</small></button>
        </div>` : `<p class="ar-hint" style="margin:10px 0 0;">Своей озвучки в отчёте нет — звук останется из видео. Чтобы заменить его, прикрепите к отчёту WAV, MP3 или архив с дорожками (раздел «Файлы») — они появятся здесь.</p>`}
        <span class="ar-label">Склейка — картинка в начале видео <small>— как карточка с титрами у студии; её кадр станет и превью в Telegram</small></span>
        <div class="ar-fields" id="ad-cover-img">
          <button type="button" class="btn" id="ad-cover-pick">Выбрать картинку…</button>
          <button type="button" class="btn ghost" id="ad-cover-clear" hidden>Убрать</button>
          <span class="ar-hint" id="ad-cover-name" style="margin:0;">не выбрана — без склейки</span>
          <img id="ad-cover-thumb" alt="" hidden style="max-height:72px; border-radius:8px;">
        </div>
        <div class="ar-fields" id="ad-splice-opts" hidden>
          <label class="ar-hint" style="margin:0; display:flex; gap:8px; align-items:center;">Показывать
            <input class="field-input" id="ad-splice-sec" type="number" min="1" max="30" step="1" value="4" style="max-width:80px;"> сек.</label>
          ${opts.intro ? `<select class="field-input" id="ad-splice-pos" style="max-width:260px;"><option value="start">В самом начале, до интро</option><option value="after_intro">После интро</option></select>` : ""}
        </div>
        <span class="ar-label">Кому отправить <small>— готовое видео всегда ложится в отчёт; сюда — кому ещё прислать в личку</small></span>
        <div class="ar-list" id="ad-recipients">
          <div class="ar-row ad-pick" style="opacity:.85;"><b>Мне</b><span class="ar-meta">всегда</span></div>
          ${(opts.people || []).map(p => `<label class="ar-row ad-pick"><input type="checkbox" data-ad-to="${p.telegram_id}"><b>${esc(p.name)}</b></label>`).join("") || `<p class="ar-hint" style="margin:6px 0 0;">Других участников нет.</p>`}
        </div>
        <span class="ar-label">Где собирать <small>— у себя быстрее: рендер на вашей видеокарте, а не на сервере</small></span>
        <div class="ar-seg" id="ad-where">
          <button type="button" class="on" data-where="server">На сервере</button>
          <button type="button" data-where="local" id="ad-where-local" disabled title="Проверяю видеокарту…">У себя (видеокарта)</button>
        </div>
        <p class="ar-hint" id="ad-where-hint"></p>
        <p class="ar-hint" id="ad-tools-status">Проверяю ffmpeg и видеокарту…</p>
        <span class="ar-label">Качество и формат</span>
        <select class="field-input" id="ad-profile">${opts.profiles.map(p => `<option value="${p.index}">${esc(p.name)}</option>`).join("")}</select>
        <p class="ar-hint" id="ad-profile-desc"></p>
        <div class="ad-est" id="ad-est"><span>Считаю примерный размер…</span></div>
        <p class="ar-hint">${opts.intro ? `Интро тайтла: ${esc(opts.intro)}.` : "Интро: нет — соберём без него."} ${opts.watermark ? `Водяной знак: ${esc(opts.watermark)}.` : "Водяной знак: нет."}
          Свой профиль качества настраивается в Настройки → Сборка финала.</p>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Отмена</button>
        ${can("posts.manage") ? `<button class="btn" id="ad-start-post" title="Соберёт видео и откроет редактор поста для канала — сразу ничего не публикуется">📣 Собрать и сделать пост</button>` : ""}
        <button class="btn primary" id="ad-start">🎬 Собрать финал</button>
      </div>`;

    sheet.querySelector("#ad-ins-text").addEventListener("input", e => { sheet.querySelector("#ad-ins-opts").hidden = !e.target.value.trim(); });
    const descEl = sheet.querySelector("#ad-profile-desc");
    const profileSel = sheet.querySelector("#ad-profile");
    const refreshDesc = () => { descEl.textContent = (opts.profiles.find(p => String(p.index) === profileSel.value) || {}).desc || ""; };
    profileSel.addEventListener("change", () => { refreshDesc(); paintEstimate(); });
    refreshDesc();

    // Примерный размер готового файла: сервер читает выбранное видео отчёта (длительность, битрейт) и считает по профилям.
    const estBox = sheet.querySelector("#ad-est");
    const fmtSize = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} ГБ` : `${Math.round(n / 1048576)} МБ`);
    const fmtDur = sec => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
    let estimate = null;
    // Время рендера: на сервере — оценка сервера (2 ядра); у себя на NVENC видеокарта кодирует примерно в 7–14 раз быстрее реального
    // времени (замер на RTX 3070: ~13×, с запасом на субтитры и логотип); без NVENC — оценка по процессору, как на сервере.
    function renderRange(e) {
      const local = typeof where === "string" && where === "local";
      if (local && localInfo.nvenc && estimate && estimate.duration > 0) {
        return { local: true, low: estimate.duration / 14, high: estimate.duration / 7 };
      }
      return e.render_low != null ? { local: false, low: e.render_low, high: e.render_high } : null;
    }
    function paintEstimate() {
      if (!estBox) return;
      if (!estimate) return;
      const e = estimate.estimates.find(x => String(x.index) === profileSel.value);
      const srcInfo = `исходник ${fmtSize(estimate.source_size)} · ${fmtDur(estimate.duration)} · ${estimate.width}×${estimate.height} · ${estimate.video_kbps} кбит/с`;
      if (!e || e.low == null) { estBox.className = "ad-est"; estBox.innerHTML = `<span>Размер для этого профиля не посчитать.</span><small>${esc(srcInfo)}</small>`; return; }
      estBox.className = `ad-est${e.over_limit ? " bad" : ""}`;
      const mins = x => (x >= 3600 ? `${(x / 3600).toFixed(1)} ч` : `${Math.max(1, Math.round(x / 60))} мин`);
      const range = renderRange(e);
      const renderTxt = range
        ? (range.local ? `Рендер у вас на видеокарте ≈ ${mins(range.low)} – ${mins(range.high)}, плюс скачивание файлов и отправка результата (зависят от интернета).`
          : `Рендер на сервере ≈ ${mins(range.low)} – ${mins(range.high)} (если нужна перекодировка: субтитры, надпись, логотип, масштаб).`)
        : "";
      estBox.innerHTML = `<b>≈ ${fmtSize(e.low)} – ${fmtSize(e.high)}</b>
        <span>${renderTxt}</span>
        <span>${e.over_limit ? "Может не поместиться в Telegram (лимит 2 ГБ) — выберите профиль полегче." : "Помещается в Telegram (лимит 2 ГБ)."}</span>
        <small>${esc(srcInfo)}. Интро и склейка добавят своё; точность ±30% для режима CRF, ±8% для заданного битрейта.</small>`;
      // подписи профилей в списке — тоже с размером
      [...profileSel.options].forEach(o => {
        const x = estimate.estimates.find(y => String(y.index) === o.value);
        const base = (opts.profiles.find(p => String(p.index) === o.value) || {}).name || o.textContent;
        const r = x ? renderRange(x) : null;
        const mid = r ? Math.max(1, Math.round((r.low + r.high) / 2 / 60)) : null;
        o.textContent = x && x.low != null ? `${base} · ≈ ${fmtSize(Math.round((x.low + x.high) / 2))}${mid ? ` · ~${mid} мин` : ""}` : base;
      });
    }
    const selVideo = () => { const c = sheet.querySelector('input[name="ad-video"]:checked'); return c ? c.value : ""; };
    async function loadEstimate() {
      const checked = sheet.querySelector('input[name="ad-video"]:checked');
      if (checked && checked.value === "local") {
        estimate = null;
        if (estBox) estBox.innerHTML = `<span>Размер и время рендера посчитаю после скачивания: видео лежит у вас на компьютере, сервер его не видит.</span>`;
        return;
      }
      if (estBox) estBox.innerHTML = `<span>Считаю примерный размер…</span>`;
      try {
        estimate = await apiGet(`/report/${publicId}/assemble-estimate`, { video: checked ? Number(checked.value) : 0 });
        paintEstimate();
      } catch (err) {
        estimate = null;
        if (estBox) estBox.innerHTML = `<span>Размер оценить не удалось: ${esc(err.message)}</span>`;
      }
    }
    sheet.querySelectorAll('input[name="ad-video"]').forEach(r => r.addEventListener("change", loadEstimate));
    loadEstimate();

    const modeBox = sheet.querySelector("#ad-mode");
    const syncMode = () => { if (modeBox) modeBox.hidden = !sheet.querySelector("[data-ad-audio]:checked"); };
    sheet.querySelectorAll("[data-ad-audio]").forEach(c => c.addEventListener("change", syncMode));
    modeBox?.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      mode = b.dataset.v;
      modeBox.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    }));

    sheet.querySelector("#ad-cover-pick").addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp";
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const label = sheet.querySelector("#ad-cover-name");
        label.textContent = "Загружаю…";
        try {
          const up = await apiUpload("/assemble/cover", file, {});
          coverImage = { file_id: up.file_id, name: up.name };
          label.textContent = up.name || file.name;
          const img = sheet.querySelector("#ad-cover-thumb");
          // Превью только для разрешённых типов картинок и только по blob-ссылке.
          const blobUrl = /^image\/(png|jpeg|webp)$/.test(file.type) ? URL.createObjectURL(file) : "";
          if (blobUrl.startsWith("blob:")) { img.src = blobUrl; img.hidden = false; } else img.hidden = true;
          sheet.querySelector("#ad-cover-clear").hidden = false;
          sheet.querySelector("#ad-splice-opts").hidden = false;
          if (typeof syncWhere === "function") syncWhere();
        } catch (e) {
          coverImage = null;
          label.textContent = "не выбрана — без склейки";
          toast(`Не удалось загрузить картинку: ${e.message}`, "error");
        }
      });
      input.click();
    });

    sheet.querySelector("#ad-cover-clear").addEventListener("click", () => {
      coverImage = null;
      sheet.querySelector("#ad-cover-name").textContent = "не выбрана — без склейки";
      sheet.querySelector("#ad-cover-thumb").hidden = true;
      sheet.querySelector("#ad-cover-clear").hidden = true;
      sheet.querySelector("#ad-splice-opts").hidden = true;
      if (typeof syncWhere === "function") syncWhere();
    });
    sheet.querySelector("[data-close]").addEventListener("click", () => finish(false));
    // «У себя»: только в приложении, где нашёлся кодировщик; интро, склейка и архивы с дорожками пока только на сервере.
    let where = "server";
    let localInfo = { ok: false, nvenc: false, pending: true };
    const whereHint = sheet.querySelector("#ad-where-hint");
    const localBtn = sheet.querySelector("#ad-where-local");
    const syncWhere = () => {
      const mustLocal = selVideo() === "local";   // видео только на этом компьютере — на сервере собрать нельзя
      const serverBtn = sheet.querySelector('#ad-where [data-where="server"]');
      localBtn.disabled = !localInfo.ok;
      serverBtn.disabled = mustLocal;
      if (mustLocal) where = "local";
      else if (where === "local" && localBtn.disabled) where = "server";
      sheet.querySelectorAll("#ad-where button").forEach(b => b.classList.toggle("on", b.dataset.where === where));
      paintEstimate();
      whereHint.textContent = localInfo.pending ? "Проверяю, можно ли собрать у себя…"
        : mustLocal && !localInfo.ok ? "Видео лежит на вашем компьютере, поэтому собрать можно только у себя, а ffmpeg или кодировщик не нашёлся. Детали — строкой ниже."
        : mustLocal ? `Видео возьмётся с этого компьютера${localVideo && localVideo.state === "downloading" ? " — когда докачается (приложение подождёт)" : ""}; на сервер оно не загружается. Рендер пойдёт на ${localInfo.nvenc ? "видеокарте NVIDIA" : "процессоре"}, готовый файл уйдёт в Telegram и в отчёт.`
        : !localInfo.ok ? "Сборка у себя недоступна: не нашёлся ffmpeg или рабочий кодировщик (нужна видеокарта NVIDIA). Детали — строкой ниже."
        : where === "local" ? `Рендер пойдёт на этом компьютере (${localInfo.nvenc ? "видеокарта NVIDIA, NVENC" : "процессор"}). Всё то же, что на сервере: интро, склейка, озвучка, надпись, логотип. Файлы скачаются с сервера, готовое видео бот отправит в Telegram и прикрепит к отчёту.`
        : "Рендер пойдёт на сервере (2 ядра процессора).";
    };
    sheet.querySelectorAll("#ad-where button").forEach(b => b.addEventListener("click", () => { if (!b.disabled) { where = b.dataset.where; syncWhere(); } }));
    sheet.querySelectorAll("[data-ad-audio]").forEach(c => c.addEventListener("change", syncWhere));
    sheet.querySelectorAll('input[name="ad-video"]').forEach(r => r.addEventListener("change", syncWhere));
    syncWhere();
    const toolsLine = sheet.querySelector("#ad-tools-status");
    const checkTools = (force = false) => {
      toolsLine.innerHTML = "Проверяю ffmpeg и видеокарту…";
      localInfo = { ok: false, nvenc: false, pending: true };
      syncWhere();
      const run = force ? prepareLocalRender(p => { toolsLine.textContent = p.label || "Скачиваю ffmpeg…"; }, true).then(st => ({ status: st, ok: !!st.ffmpeg_ok && !!(st.nvenc_h264 || st.nvenc_h265 || st.soft_h264 || st.soft_h265), nvenc: !!(st.nvenc_h264 || st.nvenc_h265) }))
        : localRenderSupport(p => { toolsLine.textContent = p.label || "Скачиваю ffmpeg…"; });
      run.then(info => {
        localInfo = info;
        localBtn.title = info.ok ? "" : "Не найден рабочий кодировщик";
        toolsLine.textContent = describeTools(info.status);
        if (!info.ok) {
          const retry = document.createElement("button");
          retry.type = "button"; retry.className = "btn"; retry.style.marginLeft = "8px"; retry.textContent = "Проверить снова";
          retry.addEventListener("click", () => checkTools(true));
          toolsLine.appendChild(retry);
        }
        syncWhere();
      });
    };
    checkTools();

    const startBtns = () => sheet.querySelectorAll("#ad-start, #ad-start-post");
    const start = async (withPost) => {
      startBtns().forEach(b => { b.disabled = true; });
      try {
        const body = {
          post: withPost,
          splice: coverImage ? {
            image: coverImage.file_id,
            seconds: Number(sheet.querySelector("#ad-splice-sec").value || 4),
            position: sheet.querySelector("#ad-splice-pos") ? sheet.querySelector("#ad-splice-pos").value : "start",
          } : null,
          video: selVideo() === "local" ? "local" : Number(selVideo()),
          sub: Number(sheet.querySelector('input[name="ad-sub"]:checked').value) || null,
          inscription: sheet.querySelector("#ad-ins-text").value.trim() ? {
            text: sheet.querySelector("#ad-ins-text").value.trim(),
            position: sheet.querySelector("#ad-ins-pos").value,
            size: Number(sheet.querySelector("#ad-ins-size").value),
            start: 0,
            duration: Number(sheet.querySelector("#ad-ins-dur").value),
          } : null,
          audios: [...sheet.querySelectorAll("[data-ad-audio]:checked")].map(c => Number(c.dataset.adAudio)),
          mode,
          profile: Number(profileSel.value),
          send_to: [...sheet.querySelectorAll("[data-ad-to]:checked")].map(c => Number(c.dataset.adTo)),
        };
        if (where === "local") { finish({ local: true, selection: body, post: withPost }); return; }
        await apiPost(`/report/${publicId}/assemble/start`, body);
        finish(withPost ? "post" : "final");
      } catch (err) {
        toast(`Не удалось запустить: ${err.message}`, "error");
        startBtns().forEach(b => { b.disabled = false; });
      }
    };
    sheet.querySelector("#ad-start").addEventListener("click", () => start(false));
    sheet.querySelector("#ad-start-post")?.addEventListener("click", () => start(true));
  });
}
