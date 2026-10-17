// Окно «Собрать финал» в десктопе: выбор видео, субтитров, дорожек даббера (несколько), режима звука и профиля качества —
// и запуск сборки прямо отсюда, без кнопок в Telegram. Сервер: GET /api/report/{id}/assemble-options, POST …/assemble/start.
// Саму сборку ведёт бот (задание забирается за пару секунд), ход виден в карточке отчёта (startAssemblyWatch), отмена — там же.

import { apiGet, apiPost, apiUpload, openSheet, dismissSheet, toast } from "./api.js";
import { esc } from "./utils.js";
import { can } from "./state.js";

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

    sheet.innerHTML = `
      <h2>Собрать финал</h2>
      <div class="ad-body">
        ${radios("ad-video", opts.videos, "Видео")}
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
        <span class="ar-label">Качество и формат</span>
        <select class="field-input" id="ad-profile">${opts.profiles.map(p => `<option value="${p.index}">${esc(p.name)}</option>`).join("")}</select>
        <p class="ar-hint" id="ad-profile-desc"></p>
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
    profileSel.addEventListener("change", refreshDesc);
    refreshDesc();

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
    });
    sheet.querySelector("[data-close]").addEventListener("click", () => finish(false));
    const startBtns = () => sheet.querySelectorAll("#ad-start, #ad-start-post");
    const start = async (withPost) => {
      startBtns().forEach(b => { b.disabled = true; });
      try {
        await apiPost(`/report/${publicId}/assemble/start`, {
          post: withPost,
          splice: coverImage ? {
            image: coverImage.file_id,
            seconds: Number(sheet.querySelector("#ad-splice-sec").value || 4),
            position: sheet.querySelector("#ad-splice-pos") ? sheet.querySelector("#ad-splice-pos").value : "start",
          } : null,
          video: Number(sheet.querySelector('input[name="ad-video"]:checked').value),
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
        });
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
