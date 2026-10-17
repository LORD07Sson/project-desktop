// Окно «Собрать финал» в десктопе: выбор видео, субтитров, дорожек даббера (несколько), режима звука и профиля качества —
// и запуск сборки прямо отсюда, без кнопок в Telegram. Сервер: GET /api/report/{id}/assemble-options, POST …/assemble/start.
// Саму сборку ведёт бот (задание забирается за пару секунд), ход виден в карточке отчёта (startAssemblyWatch), отмена — там же.

import { apiGet, apiPost, apiUpload, openSheet, dismissSheet, toast } from "./api.js";
import { esc } from "./utils.js";

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
    let coverMode = opts.intro ? "intro" : "auto";
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
        ${radios("ad-sub", opts.subs, "Субтитры")}
        ${opts.audios.length ? `
        <span class="ar-label">Дорожки даббера <small>— отметьте нужные, звучат вместе</small></span>
        <div class="ar-list">${opts.audios.map(a => `
          <label class="ar-row ad-pick"><input type="checkbox" data-ad-audio="${a.id}"><b>${a.archive ? "📦 " : ""}${esc(a.name)}</b>${a.archive ? `<span class="ar-meta">архив — возьму все звуковые файлы внутри</span>` : ""}</label>`).join("")}</div>
        <div class="ar-seg" id="ad-mode" hidden>
          <button type="button" data-v="replace" class="on">Заменить оригинал<small>слышна только дорожка</small></button>
          <button type="button" data-v="mix">Смешать с оригиналом<small>оба звука вместе</small></button>
        </div>` : `<p class="ar-hint" style="margin:10px 0 0;">Дорожек в отчёте нет — звук останется из видео. Загрузите WAV, MP3 или архив с дорожками в «Файлы», и они появятся здесь.</p>`}
        <span class="ar-label">Превью видео <small>— что видно в чате до запуска</small></span>
        <div class="ar-seg ad-cover-seg" id="ad-cover">
          ${opts.intro ? `<button type="button" data-v="intro" class="on">Кадр интро<small>заставка с титрами</small></button>` : ""}
          <button type="button" data-v="auto" class="${opts.intro ? "" : "on"}">Авто<small>как выберет Telegram</small></button>
          <button type="button" data-v="time">Кадр серии<small>на нужной секунде</small></button>
          <button type="button" data-v="image">Своя картинка<small>png, jpg, webp</small></button>
        </div>
        <div class="ar-fields" id="ad-cover-time" hidden>
          <input class="field-input" id="ad-cover-sec" type="number" min="0" step="1" value="30" style="max-width:140px;">
          <span class="ar-hint" style="margin:0;">секунда готового видео (в нём первым идёт интро, если оно есть)</span>
        </div>
        <div class="ar-fields" id="ad-cover-img" hidden>
          <button type="button" class="btn" id="ad-cover-pick">Выбрать картинку…</button>
          <span class="ar-hint" id="ad-cover-name" style="margin:0;">не выбрана</span>
          <img id="ad-cover-thumb" alt="" hidden style="max-height:64px; border-radius:8px;">
        </div>
        <span class="ar-label">Качество и формат</span>
        <select class="field-input" id="ad-profile">${opts.profiles.map(p => `<option value="${p.index}">${esc(p.name)}</option>`).join("")}</select>
        <p class="ar-hint" id="ad-profile-desc"></p>
        <p class="ar-hint">${opts.intro ? `Интро тайтла: ${esc(opts.intro)}.` : "Интро: нет — соберём без него."} ${opts.watermark ? `Водяной знак: ${esc(opts.watermark)}.` : "Водяной знак: нет."}
          Свой профиль качества настраивается в Настройки → Сборка финала.</p>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Отмена</button>
        <button class="btn primary" id="ad-start">▶️ Собрать</button>
      </div>`;

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

    const coverBox = sheet.querySelector("#ad-cover");
    const syncCover = () => {
      sheet.querySelector("#ad-cover-time").hidden = coverMode !== "time";
      sheet.querySelector("#ad-cover-img").hidden = coverMode !== "image";
    };
    coverBox.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      coverMode = b.dataset.v;
      coverBox.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
      syncCover();
    }));
    syncCover();
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
          img.src = URL.createObjectURL(file);
          img.hidden = false;
        } catch (e) {
          coverImage = null;
          label.textContent = "не выбрана";
          toast(`Не удалось загрузить картинку: ${e.message}`, "error");
        }
      });
      input.click();
    });

    sheet.querySelector("[data-close]").addEventListener("click", () => finish(false));
    sheet.querySelector("#ad-start").addEventListener("click", async e => {
      const btn = e.currentTarget;
      if (coverMode === "image" && !coverImage) { toast("Выберите картинку для превью или другой вариант.", "error"); return; }
      btn.disabled = true;
      try {
        await apiPost(`/report/${publicId}/assemble/start`, {
          cover: { mode: coverMode, at: coverMode === "time" ? Number(sheet.querySelector("#ad-cover-sec").value || 0) : null, image: coverImage ? coverImage.file_id : null },
          video: Number(sheet.querySelector('input[name="ad-video"]:checked').value),
          sub: Number(sheet.querySelector('input[name="ad-sub"]:checked').value),
          audios: [...sheet.querySelectorAll("[data-ad-audio]:checked")].map(c => Number(c.dataset.adAudio)),
          mode,
          profile: Number(profileSel.value),
        });
        finish(true);
      } catch (err) {
        toast(`Не удалось запустить: ${err.message}`, "error");
        btn.disabled = false;
      }
    });
  });
}
