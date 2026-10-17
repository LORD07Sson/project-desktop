// «Сборка финала» в Настройках — свой профиль кодирования: контейнер (расширение), кодек видео, качество (CRF или битрейт),
// пресет, разрешение, fps, звук и свои параметры ffmpeg. Сервер: GET/POST /api/assemble/profile.
// В боте профиль появляется последним в кнопке «⚙️ Качество» окна «Собрать финал».

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const HEIGHTS = [[0, "как в исходнике"], [2160, "2160p (4K)"], [1440, "1440p"], [1080, "1080p"], [720, "720p"], [480, "480p"], [360, "360p"]];
const FPS = [[0, "как в исходнике"], [24, "24"], [25, "25"], [30, "30"], [50, "50"], [60, "60"]];
const ABITRATES = [96, 128, 160, 192, 256, 320];

export async function mountAssembleSettings(root) {
  if (!root) return;
  let data = null;

  const opt = (value, label, current) => `<option value="${value}"${String(value) === String(current) ? " selected" : ""}>${esc(label)}</option>`;

  function paint() {
    const p = data.custom || data.default;
    root.innerHTML = `
    <div class="ar">
      <p class="ar-hint" style="margin:0;">Здесь задаётся «Свой профиль» для кнопки «Собрать финал». Готовые профили (ниже) работают всегда; свой появится в кнопке «⚙️ Качество» в боте последним.</p>

      <div class="ar-card">
        <h4>Готовые профили</h4>
        <div class="ar-list">
          ${data.builtin.map(b => `<div class="ar-row"><b>${esc(b.name)}</b><span class="ar-meta">${esc(b.desc)}</span></div>`).join("")}
        </div>
      </div>

      <form id="as-form" class="ar-card">
        <h4>Свой профиль ${data.custom ? `<em>сохранён</em>` : ""}</h4>
        <div class="ar-grid">
          <div>
            <span class="ar-label">Контейнер (расширение)</span>
            <div class="ar-seg" id="as-container">${data.options.containers.map(c => `<button type="button" data-v="${c}" class="${p.container === c ? "on" : ""}">.${c}<small>${c === "mp4" ? "играет в Telegram" : c === "mkv" ? "любой звук, файлом" : "Apple, файлом"}</small></button>`).join("")}</div>
            <span class="ar-label">Кодек видео</span>
            <div class="ar-seg" id="as-vcodec">${Object.keys(data.options.vcodecs).map(c => `<button type="button" data-v="${c}" class="${p.vcodec === c ? "on" : ""}">${c === "h264" ? "H.264" : "H.265"}<small>${c === "h264" ? "совместимо везде" : "меньше размер"}</small></button>`).join("")}</div>
          </div>
          <div>
            <span class="ar-label">Качество видео</span>
            <div class="ar-seg" id="as-mode">
              <button type="button" data-v="crf" class="${p.mode === "crf" ? "on" : ""}">CRF<small>постоянное качество</small></button>
              <button type="button" data-v="bitrate" class="${p.mode === "bitrate" ? "on" : ""}">Битрейт<small>кбит/с</small></button>
            </div>
            <div class="ar-fields">
              <input class="field-input" id="as-crf" type="number" min="0" max="51" value="${p.crf}" title="CRF: меньше — лучше качество и больше файл (18 — почти без потерь, 23 — обычное)" placeholder="CRF 0–51" ${p.mode === "bitrate" ? "hidden" : ""}>
              <input class="field-input" id="as-bitrate" type="number" min="100" max="100000" step="100" value="${p.bitrate}" title="Средний битрейт видео, кбит/с" placeholder="кбит/с" ${p.mode === "crf" ? "hidden" : ""}>
              <select class="field-input" id="as-preset" title="Пресет: медленнее — меньше файл при том же качестве">${data.options.presets.map(x => opt(x, `пресет ${x}`, p.preset)).join("")}</select>
            </div>
          </div>
          <div>
            <span class="ar-label">Разрешение и частота кадров</span>
            <div class="ar-fields">
              <select class="field-input" id="as-height">${HEIGHTS.map(([v, l]) => opt(v, l, p.height)).join("")}</select>
              <select class="field-input" id="as-fps">${FPS.map(([v, l]) => opt(v, `${l === "как в исходнике" ? l : l + " fps"}`, p.fps)).join("")}</select>
            </div>
          </div>
          <div>
            <span class="ar-label">Звук</span>
            <div class="ar-fields">
              <select class="field-input" id="as-acodec">
                ${opt("copy", "без перекодирования (как есть)", p.acodec)}${opt("aac", "AAC", p.acodec)}${opt("mp3", "MP3", p.acodec)}${opt("opus", "Opus (только в .mkv)", p.acodec)}
              </select>
              <select class="field-input" id="as-abitrate" title="Битрейт звука, кбит/с">${ABITRATES.map(v => opt(v, `${v} кбит/с`, p.abitrate)).join("")}</select>
            </div>
          </div>
        </div>
        <span class="ar-label">Свои параметры ffmpeg (вручную)</span>
        <input class="field-input" id="as-extra" value="${esc(p.extra || "")}" placeholder="например: -tune animation -g 120 -profile:v high">
        <p class="ar-hint">Дописываются в конец и перекрывают настройки выше. Разрешены только параметры кодирования: ${esc(data.options.extra.join(" "))}. Пути и спецсимволы запрещены.</p>
        <div class="ar-actions" style="justify-content:flex-start; margin-top:14px;">
          <button class="btn primary" type="submit">Сохранить профиль</button>
          ${data.custom ? `<button class="btn" type="button" id="as-reset">Удалить свой профиль</button>` : ""}
        </div>
        <p class="ar-hint" id="as-preview" style="margin-top:10px;"></p>
      </form>
    </div>`;

    const form = root.querySelector("#as-form");
    const read = () => ({
      container: root.querySelector("#as-container .on")?.dataset.v,
      vcodec: root.querySelector("#as-vcodec .on")?.dataset.v,
      mode: root.querySelector("#as-mode .on")?.dataset.v,
      crf: root.querySelector("#as-crf").value,
      bitrate: root.querySelector("#as-bitrate").value,
      preset: root.querySelector("#as-preset").value,
      height: Number(root.querySelector("#as-height").value),
      fps: Number(root.querySelector("#as-fps").value),
      acodec: root.querySelector("#as-acodec").value,
      abitrate: root.querySelector("#as-abitrate").value,
      extra: root.querySelector("#as-extra").value,
    });
    const refreshPreview = () => {
      const v = read();
      const parts = [v.vcodec === "h265" ? "H.265" : "H.264", v.mode === "bitrate" ? `${v.bitrate} кбит/с` : `CRF ${v.crf}`];
      if (v.height) parts.push(`${v.height}p`);
      if (v.fps) parts.push(`${v.fps} fps`);
      parts.push(v.acodec === "copy" ? "звук без потерь" : `звук ${v.acodec.toUpperCase()} ${v.abitrate}k`);
      parts.push(v.container.toUpperCase());
      if (v.extra.trim()) parts.push("+ свои параметры");
      root.querySelector("#as-preview").textContent = `Получится: ${parts.join(" · ")}`;
    };
    for (const id of ["#as-container", "#as-vcodec", "#as-mode"]) {
      root.querySelectorAll(`${id} button`).forEach(b => b.addEventListener("click", () => {
        root.querySelectorAll(`${id} button`).forEach(x => x.classList.toggle("on", x === b));
        if (id === "#as-mode") {
          root.querySelector("#as-crf").hidden = b.dataset.v !== "crf";
          root.querySelector("#as-bitrate").hidden = b.dataset.v !== "bitrate";
        }
        refreshPreview();
      }));
    }
    form.addEventListener("input", refreshPreview);
    form.addEventListener("change", refreshPreview);
    refreshPreview();

    form.addEventListener("submit", async e => {
      e.preventDefault();
      try {
        data = await apiPost("/assemble/profile", { profile: read() });
        toast("Профиль сохранён — он в кнопке «Качество» в боте.", "success");
        paint();
      } catch (err) { toast(err.message, "error"); }
    });
    root.querySelector("#as-reset")?.addEventListener("click", async () => {
      try {
        data = await apiPost("/assemble/profile", { reset: true });
        toast("Свой профиль удалён.", "success");
        paint();
      } catch (err) { toast(err.message, "error"); }
    });
  }

  root.innerHTML = `<div class="no-assignee">Загружаю…</div>`;
  try {
    data = await apiGet("/assemble/profile");
    paint();
  } catch (e) {
    root.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}
