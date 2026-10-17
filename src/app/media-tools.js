// «Инструменты ffmpeg» — библиотека операций поверх media_tools.rs:
// обрезка без перекодирования (lossless keyframe cut, как в LosslessCut),
// конвертация, извлечение/нормализация звука, склейка и муксинг
// нескольких файлов. Каждая операция — отдельная панель с обычной формой
// (без «сырого» поля произвольных аргументов ffmpeg), переключаемая
// вкладками внутри одной модалки. Кнопка входа — #open-media-tools в
// шапке, рядом с QC звука.
//
// Файлы выбираются не из каждой вкладки отдельным системным диалогом, а
// один раз в общий пул (см. filePool/poolBarHtml ниже) — панель пула
// видна на любой вкладке, а каждая операция берёт нужный(е) файл(ы) из
// него через <select>. Так один и тот же файл (например, для обрезки
// и следом конвертации) не нужно выбирать заново на каждой вкладке.
//
// Диалоги выбора файлов открывает Rust (pickInputFiles/pickOutputFile/
// pickOutputDir в tauri.js), а не JS-плагин: бэкенд должен САМ знать,
// какие пути пользователь разрешил трогать, иначе любая команда
// становится «прочитай/перезапиши что скажут» — см. file_scope.rs.

import {
  invoke, pickInputFiles, pickOutputFile,
  revealInFolder, openInSystemPlayer, listen,
} from "./tauri.js";
import { openSheet, toast } from "./api.js";
import { $, esc, formatTime } from "./utils.js";
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from "./media-formats.js";
import { buildRpp } from "./reaper-core.js";

const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  play: svg('<path d="M8 5.5v13l10-6.5z"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  frameBack: svg('<path d="M6 5v14M18 6l-8 6 8 6z"/>'),
  frameFwd: svg('<path d="M18 5v14M6 6l8 6-8 6z"/>'),
  loop: svg('<path d="M4 12a6 6 0 0 1 6-6h8M15 3l3 3-3 3M20 12a6 6 0 0 1-6 6H6M9 21l-3-3 3-3"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  volume: svg('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>'),
  muted: svg('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
};

const SUBTITLE_EXTENSIONS = ["srt", "ass", "ssa", "vtt", "sub"];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
const POOL_EXTENSIONS = [...MEDIA_EXTENSIONS, ...SUBTITLE_EXTENSIONS];

function baseName(path) {
  return String(path).split(/[\\/]/).pop() || path;
}
function stemOf(path) {
  return baseName(path).replace(/\.[^./\\]+$/, "");
}
function extOf(path) {
  const m = /\.([^./\\]+)$/.exec(baseName(path));
  return m ? m[1].toLowerCase() : "";
}

// ============================================================
// Общий пул файлов — раньше каждая вкладка (Обрезка/Конвертация/Аудио/
// Склейка/Муксинг) сама открывала диалог выбора файла, и один и тот же
// файл для двух операций нужно было выбирать дважды. Теперь файлы
// добавляются один раз в общий пул (панель сверху модалки, видна на
// любой вкладке), а каждая операция выбирает нужный(е) файл(ы) из него
// через <select>, не через новый системный диалог.
// ============================================================

const filePool = []; // { path, info } — info может быть null (напр. .srt — ffprobe не видит в нём медиапотока)

// mt_register_media_file — допуск файла в asset-протокол для <video src>
// (см. tauri.conf.json: security.assetProtocol) — делаем на добавление в
// пул один раз, не на каждый выбор в конкретной вкладке.
async function addFilesToPool(extensions) {
  const list = await pickInputFiles({ multiple: true, filters: [{ name: "Медиа", extensions }] });
  const indices = [];
  for (const path of list) {
    const existing = filePool.findIndex(f => f.path === path);
    if (existing !== -1) { indices.push(existing); continue; }
    let info = null;
    try {
      await invoke("mt_register_media_file", { path });
      info = await invoke("mt_probe_media", { path });
    } catch {
      // не медиаконтейнер в понимании ffprobe (например, .srt) —
      // не критично, кладём в пул без метаданных.
    }
    filePool.push({ path, info });
    indices.push(filePool.length - 1);
  }
  return indices;
}

// Убирает файл из пула и подчищает ссылки на него во всех вкладках —
// иначе за отваливающийся путь могли бы держаться пути вкладок
// (что-то откроет несуществующий файл) или список склейки/муксинга.
function removeFromPool(index) {
  const removedPath = filePool[index]?.path;
  if (removedPath == null) return;
  filePool.splice(index, 1);
  const reindex = i => (i == null ? i : i === index ? null : i > index ? i - 1 : i);

  if (convertState.path === removedPath) { convertState.path = null; convertState.info = null; convertState.poolIndex = null; }
  else convertState.poolIndex = reindex(convertState.poolIndex);

  if (audioState.path === removedPath) { audioState.path = null; audioState.info = null; audioState.poolIndex = null; }
  else audioState.poolIndex = reindex(audioState.poolIndex);

  // Вкладки, которые хранят только номер в пуле (Дубляж, Субтитры), —
  // раньше не пересчитывались вовсе, и после удаления файла «Дубляж»
  // молча указывал на СОСЕДНИЙ файл. Вкладки с путём (Кадры, Скорость)
  // сбрасываются, если удалили именно их файл, — иначе операция ушла бы
  // на файл, которого в пуле уже нет.
  dubState.videoIndex = reindex(dubState.videoIndex);
  dubState.dubIndex = reindex(dubState.dubIndex);
  subsState.videoIndex = reindex(subsState.videoIndex);
  subsState.subsIndex = reindex(subsState.subsIndex);
  if (framesState.path === removedPath) { framesState.path = null; framesState.info = null; framesState.poolIndex = null; }
  else framesState.poolIndex = reindex(framesState.poolIndex);
  if (speedState.path === removedPath) { speedState.path = null; speedState.info = null; speedState.poolIndex = null; }
  else speedState.poolIndex = reindex(speedState.poolIndex);

  concatState.paths = concatState.paths.filter(p => p !== removedPath);
  MUX_SECTIONS.forEach(section => {
    muxState[section.key] = muxState[section.key].filter(t => t.path !== removedPath);
  });
}

function poolBarHtml() {
  return `
    <div class="mt-pool-bar">
      <div class="mt-pool-chips" id="mt-pool-chips">
        ${filePool.length
          ? filePool.map((f, i) => `<span class="mt-pool-chip" title="${esc(f.path)}">${esc(baseName(f.path))}<button class="mt-pool-chip-remove" data-pool-open="${i}" title="Открыть во внешнем плеере" aria-label="Открыть во внешнем плеере">▶</button><button class="mt-pool-chip-remove" data-pool-remove="${i}" title="Убрать из пула" aria-label="Убрать из пула">${ICONS.close}</button></span>`).join("")
          : `<span class="mt-info-line">Файлов пока нет — добавьте, они станут доступны во всех вкладках.</span>`}
      </div>
      <button class="btn ghost" id="mt-pool-add">Добавить файлы</button>
    </div>`;
}

function wirePoolBar(overlay) {
  overlay.querySelector("#mt-pool-add")?.addEventListener("click", async () => {
    await addFilesToPool(POOL_EXTENSIONS);
    renderPoolBar(overlay);
    renderActivePanel(overlay);
  });
  overlay.querySelectorAll("[data-pool-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const f = filePool[Number(btn.dataset.poolOpen)];
      if (!f) return;
      try { await openInSystemPlayer(f.path); }
      catch (e) { toast(`Не удалось открыть во внешнем плеере: ${e}`, "error"); }
    });
  });
  overlay.querySelectorAll("[data-pool-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      removeFromPool(Number(btn.dataset.poolRemove));
      renderPoolBar(overlay);
      renderActivePanel(overlay);
    });
  });
}

function renderPoolBar(overlay) {
  overlay.querySelector("#mt-pool-bar-mount").innerHTML = poolBarHtml();
  wirePoolBar(overlay);
}

// selectedIndex — какой пункт пула отметить выбранным; filterFn(entry) —
// необязательный предикат, чтобы показать не весь пул (например, только
// файлы со звуковой дорожкой в панели «Аудио»).
function poolSelectHtml(selectId, selectedIndex, filterFn) {
  const options = filePool
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !filterFn || filterFn(f));
  return `
    <select id="${selectId}" class="mt-pool-select">
      <option value="">— выбрать из пула —</option>
      ${options.map(({ f, i }) => `<option value="${i}" ${i === selectedIndex ? "selected" : ""} title="${esc(f.path)}">${esc(baseName(f.path))}</option>`).join("")}
    </select>`;
}

function infoLineHtml(info) {
  const parts = [formatTime(info.duration)];
  if (info.video) {
    parts.push(`${esc(info.video.codec)}${info.video.width ? ` ${info.video.width}×${info.video.height}` : ""}${info.video.fps ? ` · ${info.video.fps.toFixed(2)} fps` : ""}`);
  }
  if (info.audio) {
    parts.push(`${esc(info.audio.codec)}${info.audio.channels ? ` · ${info.audio.channels}ch` : ""}${info.audio.sampleRate ? ` · ${Math.round(info.audio.sampleRate / 1000)} кГц` : ""}`);
  }
  return `<div class="mt-info-line">${parts.join(" · ")}</div>`;
}

// ============================================================
// Общий бегунок длинных операций.
//
// Раньше прогресс был только у конвертации, а остановить начатое было
// нельзя вовсе: единственным способом прервать сорокаминутный транскод
// оставалось закрыть приложение — и даже это оставляло ffmpeg дожёвывать
// файл в фоне. Теперь любая операция идёт через runJob: одна полоса с
// подписью текущего прохода («Сегмент 3 из 7», «Измеряю громкость») и
// кнопка «Отмена», которая доходит до самого процесса (mt_cancel).
// ============================================================

// Параллельно две операции ffmpeg запускать нечем (бэкенд держит один
// текущий процесс) — и незачем: они делят диск и процессор.
let jobRunning = false;

function jobHtml() {
  return `
    <div class="mt-job" id="mt-job" hidden>
      <div class="mt-job-head">
        <span class="mt-job-label" id="mt-job-label"></span>
        <span class="mt-job-pct" id="mt-job-pct">0%</span>
      </div>
      <div class="update-progress-track"><div class="update-progress-fill" id="mt-job-fill"></div></div>
      <button class="btn ghost mt-job-cancel" id="mt-job-cancel" type="button">Отмена</button>
    </div>`;
}

/**
 * Выполняет длинную операцию с общей полосой прогресса и отменой.
 * button — кнопка запуска (блокируется и меняет подпись на время работы).
 */
async function runJob(overlay, { button, busyLabel, run }) {
  if (jobRunning) {
    toast("Дождитесь окончания текущей операции.", "error");
    return null;
  }
  const box = overlay.querySelector("#mt-job");
  const fill = overlay.querySelector("#mt-job-fill");
  const pct = overlay.querySelector("#mt-job-pct");
  const label = overlay.querySelector("#mt-job-label");
  const cancelBtn = overlay.querySelector("#mt-job-cancel");

  const idleLabel = button ? button.textContent : "";
  jobRunning = true;
  if (button) { button.disabled = true; button.textContent = busyLabel; }
  box.hidden = false;
  fill.style.width = "0%";
  pct.textContent = "0%";
  label.textContent = busyLabel;
  cancelBtn.disabled = false;

  const onCancel = async () => {
    cancelBtn.disabled = true;
    label.textContent = "Останавливаю…";
    try { await invoke("mt_cancel"); } catch (e) { toast(String(e), "error"); cancelBtn.disabled = false; }
  };
  cancelBtn.addEventListener("click", onCancel);

  const unlisten = await listen("mediatool-progress", event => {
    const { fraction = 0, label: stage = "" } = event.payload || {};
    const percent = Math.round(fraction * 100);
    fill.style.width = `${percent}%`;
    pct.textContent = `${percent}%`;
    if (stage) label.textContent = stage;
  });

  try {
    return await run();
  } catch (e) {
    // Отмена — это не сбой: пользователь сам нажал кнопку, ругаться
    // красным тостом на собственное действие незачем.
    if (String(e).includes("отменена")) toast("Операция отменена.");
    else toast(String(e), "error");
    return null;
  } finally {
    unlisten();
    cancelBtn.removeEventListener("click", onCancel);
    box.hidden = true;
    jobRunning = false;
    if (button) { button.disabled = false; button.textContent = idleLabel; }
  }
}

// Успешный результат — с кнопкой «показать в папке», один хелпер на все
// операции вместо пяти одинаковых блоков.
function toastDone(text, path) {
  toast(text, "success", { label: "Показать в папке", onClick: () => revealInFolder(path) });
}

// ============================================================
// Конвертация / транскод — см. transcode_media в media_tools.rs.
// ============================================================

const CONVERT_PRESETS = {
  mp4_h264: { label: "MP4 (H.264/AAC) — универсальный", container: "mp4", opts: { videoCodec: "libx264", audioCodec: "aac", crf: 23 } },
  telegram: { label: "Сжать для Telegram (720p, ~2 Мбит/с)", container: "mp4", opts: { videoCodec: "libx264", audioCodec: "aac", height: 720, videoBitrate: "2M", audioBitrate: "128k" } },
  webm_vp9: { label: "WebM (VP9/Opus)", container: "webm", opts: { videoCodec: "libvpx-vp9", audioCodec: "libopus", crf: 32 } },
  prores: { label: "ProRes 422 (монтажный мастер)", container: "mov", opts: { videoCodec: "prores_ks", audioCodec: "pcm_s16le" } },
  custom: { label: "Свои параметры", container: "mp4", opts: {} },
};

// Поля «своих параметров» переживают перерисовку панели — иначе смена
// пресета или добавление файла в пул стирали уже введённые значения.
const convertState = {
  poolIndex: null, path: null, info: null, preset: "mp4_h264",
  container: null,
  custom: { videoCodec: "", audioCodec: "", width: "", height: "", videoBitrate: "", audioBitrate: "", crf: "" },
};

const CONTAINERS = ["mp4", "mkv", "mov", "webm"];

function convertContainer() {
  return convertState.container || CONVERT_PRESETS[convertState.preset].container;
}

function convertPanelHtml() {
  const picker = `<div class="mt-file-row">${poolSelectHtml("mt-convert-pick", convertState.poolIndex, f => f.info && (f.info.video || f.info.audio))}${convertState.path ? infoLineHtml(convertState.info) : ""}</div>`;
  if (!convertState.path) {
    return `
      ${picker}
      <div class="mt-empty">
        <p>Выберите файл из пула выше для перекодирования в другой контейнер/кодек/разрешение.</p>
      </div>`;
  }
  const custom = convertState.preset === "custom";
  const c = convertState.custom;
  return `
    ${picker}
    <div class="mt-form-row">
      <span>Пресет</span>
      <select id="mt-convert-preset">
        ${Object.entries(CONVERT_PRESETS).map(([k, p]) => `<option value="${k}" ${k === convertState.preset ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
    </div>
    <div id="mt-convert-custom" ${custom ? "" : "hidden"}>
      <div class="mt-form-row"><span>Видео-кодек</span>
        <select id="mt-c-vcodec">
          ${[["", "не менять"], ["libx264", "H.264"], ["libx265", "H.265"], ["libvpx-vp9", "VP9"], ["prores_ks", "ProRes"]]
            .map(([v, l]) => `<option value="${v}" ${v === c.videoCodec ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      <div class="mt-form-row"><span>Аудио-кодек</span>
        <select id="mt-c-acodec">
          ${[["", "не менять"], ["aac", "AAC"], ["libopus", "Opus"], ["libmp3lame", "MP3"], ["flac", "FLAC"], ["pcm_s16le", "PCM 16 бит"]]
            .map(([v, l]) => `<option value="${v}" ${v === c.audioCodec ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      <div class="mt-form-row"><span>Ширина / высота (px)</span>
        <input id="mt-c-width" type="number" min="1" max="16384" placeholder="авто" style="width:90px;" value="${esc(c.width)}">
        <input id="mt-c-height" type="number" min="1" max="16384" placeholder="авто" style="width:90px;" value="${esc(c.height)}">
      </div>
      <div class="mt-form-row"><span>Битрейт видео / аудио</span>
        <input id="mt-c-vbitrate" type="text" placeholder="напр. 2M" style="width:90px;" value="${esc(c.videoBitrate)}">
        <input id="mt-c-abitrate" type="text" placeholder="напр. 128k" style="width:90px;" value="${esc(c.audioBitrate)}">
      </div>
      <div class="mt-form-row"><span>CRF (качество, меньше — лучше)</span>
        <input id="mt-c-crf" type="number" min="0" max="63" placeholder="напр. 23" style="width:90px;" value="${esc(c.crf)}">
      </div>
    </div>
    <div class="mt-form-row">
      <span>Контейнер результата</span>
      <select id="mt-convert-container">
        ${CONTAINERS.map(x => `<option value="${x}" ${x === convertContainer() ? "selected" : ""}>${x}</option>`).join("")}
      </select>
    </div>
    <button class="btn primary" id="mt-convert-run">Конвертировать</button>
  `;
}

function wireConvertPanel(root) {
  const pickSel = root.querySelector("#mt-convert-pick");
  if (pickSel) pickSel.addEventListener("change", () => {
    if (pickSel.value === "") return;
    const entry = filePool[Number(pickSel.value)];
    convertState.poolIndex = Number(pickSel.value);
    convertState.path = entry.path;
    convertState.info = entry.info;
    renderActivePanel(root);
  });
  if (!convertState.path) return;

  root.querySelector("#mt-convert-preset").addEventListener("change", e => {
    convertState.preset = e.target.value;
    // Пресет задаёт свой контейнер — но только пока пользователь не
    // выбрал контейнер руками.
    convertState.container = null;
    renderActivePanel(root);
  });
  root.querySelector("#mt-convert-container").addEventListener("change", e => {
    convertState.container = e.target.value;
  });

  // Запоминаем ввод сразу, а не только в момент запуска: панель
  // перерисовывается при любых изменениях пула.
  const customFields = {
    videoCodec: "#mt-c-vcodec", audioCodec: "#mt-c-acodec",
    width: "#mt-c-width", height: "#mt-c-height",
    videoBitrate: "#mt-c-vbitrate", audioBitrate: "#mt-c-abitrate", crf: "#mt-c-crf",
  };
  Object.entries(customFields).forEach(([key, sel]) => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener("input", () => { convertState.custom[key] = el.value; });
  });

  root.querySelector("#mt-convert-run").addEventListener("click", async () => {
    const c = convertState.custom;
    const opts = convertState.preset === "custom" ? {
      videoCodec: c.videoCodec || null,
      audioCodec: c.audioCodec || null,
      width: Math.round(Number(c.width)) || null,
      height: Math.round(Number(c.height)) || null,
      videoBitrate: c.videoBitrate.trim() || null,
      audioBitrate: c.audioBitrate.trim() || null,
      // Number(...)||null съедал бы CRF 0 (визуально «без потерь») —
      // проверяем именно на пустую строку.
      crf: c.crf === "" ? null : Math.round(Number(c.crf)),
    } : CONVERT_PRESETS[convertState.preset].opts;
    const container = convertContainer();
    const outPath = await pickOutputFile(`${stemOf(convertState.path)}.${container}`, [
      { name: container.toUpperCase(), extensions: [container] },
    ]);
    if (!outPath) return;

    const btn = root.querySelector("#mt-convert-run");
    const ok = await runJob(root, {
      button: btn,
      busyLabel: "Конвертирую…",
      run: async () => { await invoke("mt_transcode_media", { path: convertState.path, outPath, opts }); return true; },
    });
    if (ok) toastDone("Конвертация завершена.", outPath);
  });
}

// ============================================================
// Аудио — извлечь/конвертировать/нормализовать, см. extract_audio.
// ============================================================

const AUDIO_CODEC_EXT = { copy: null, aac: "m4a", libmp3lame: "mp3", flac: "flac", libopus: "opus", pcm_s16le: "wav" };
const audioState = { poolIndex: null, path: null, info: null, codec: "copy", bitrate: "", normalize: false };

function audioPanelHtml() {
  // Фильтр по наличию звуковой дорожки — сразу в самом списке выбора,
  // не отдельной проверкой-тостом после пика, как было раньше.
  const picker = `<div class="mt-file-row">${poolSelectHtml("mt-audio-pick", audioState.poolIndex, f => f.info && f.info.audio)}${audioState.path ? infoLineHtml(audioState.info) : ""}</div>`;
  if (!audioState.path) {
    return `
      ${picker}
      <div class="mt-empty">
        <p>Выберите файл со звуковой дорожкой из пула выше — извлечь звук
        из видео, перевести в другой формат или нормализовать громкость
        (EBU R128 loudnorm, два прохода — динамика дубля не меняется).</p>
      </div>`;
  }
  const codecs = [
    ["copy", "Как есть (без перекодирования)"],
    ["aac", "AAC (.m4a)"],
    ["libmp3lame", "MP3"],
    ["flac", "FLAC (без потерь)"],
    ["libopus", "Opus"],
    ["pcm_s16le", "WAV PCM 16 бит"],
  ];
  return `
    ${picker}
    <div class="mt-form-row">
      <span>Кодек</span>
      <select id="mt-audio-codec">
        ${codecs.map(([v, l]) => `<option value="${v}" ${v === audioState.codec ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="mt-form-row">
      <span>Битрейт</span>
      <input id="mt-audio-bitrate" type="text" placeholder="напр. 192k (пусто — по умолчанию)" style="width:200px;" value="${esc(audioState.bitrate)}">
    </div>
    <div class="mt-form-row">
      <label><input type="checkbox" id="mt-audio-normalize" ${audioState.normalize ? "checked" : ""}> Нормализовать громкость (loudnorm, −16 LUFS)</label>
    </div>
    <button class="btn primary" id="mt-audio-run">Извлечь / конвертировать</button>
  `;
}

function wireAudioPanel(root) {
  const pickSel = root.querySelector("#mt-audio-pick");
  if (pickSel) pickSel.addEventListener("change", () => {
    if (pickSel.value === "") return;
    const entry = filePool[Number(pickSel.value)];
    audioState.poolIndex = Number(pickSel.value);
    audioState.path = entry.path;
    audioState.info = entry.info;
    renderActivePanel(root);
  });
  if (!audioState.path) return;

  const codecSel = root.querySelector("#mt-audio-codec");
  const normalizeBox = root.querySelector("#mt-audio-normalize");
  const bitrateInput = root.querySelector("#mt-audio-bitrate");

  bitrateInput.addEventListener("input", () => { audioState.bitrate = bitrateInput.value; });
  // «Как есть» и нормализация несовместимы по определению (фильтр
  // требует декодирования). Раньше интерфейс говорил «переключаю на
  // AAC», но сам ничего не переключал — подмену делал молча бэкенд, и в
  // диалоге сохранения предлагалось не то расширение.
  const reconcile = () => {
    audioState.codec = codecSel.value;
    audioState.normalize = normalizeBox.checked;
    if (audioState.normalize && audioState.codec === "copy") {
      audioState.codec = "aac";
      codecSel.value = "aac";
      toast("«Как есть» несовместимо с нормализацией — переключил на AAC.");
    }
  };
  codecSel.addEventListener("change", reconcile);
  normalizeBox.addEventListener("change", reconcile);

  root.querySelector("#mt-audio-run").addEventListener("click", async () => {
    const codec = audioState.codec;
    const bitrate = audioState.bitrate.trim() || null;
    const normalize = audioState.normalize;
    const effectiveExt = AUDIO_CODEC_EXT[codec] || extOf(audioState.path) || "m4a";
    const outPath = await pickOutputFile(`${stemOf(audioState.path)}.${effectiveExt}`, [
      { name: effectiveExt.toUpperCase(), extensions: [effectiveExt] },
    ]);
    if (!outPath) return;

    const btn = root.querySelector("#mt-audio-run");
    const ok = await runJob(root, {
      button: btn,
      busyLabel: "Обрабатываю…",
      run: async () => { await invoke("mt_extract_audio", { path: audioState.path, outPath, opts: { codec, bitrate, normalize } }); return true; },
    });
    if (ok) toastDone("Готово.", outPath);
  });
}

// ============================================================
// Склейка — см. concat_media в media_tools.rs (сам решает copy/re-encode).
// ============================================================

const concatState = { paths: [] };

function concatPanelHtml() {
  return `
    <div class="mt-form-row">
      ${poolSelectHtml("mt-concat-pick", null, f => f.info && (f.info.video || f.info.audio))}
      <button class="btn" id="mt-concat-add-picked">+ В список</button>
    </div>
    <div class="mt-concat-list" id="mt-concat-list">
      ${concatState.paths.length ? concatState.paths.map((p, i) => `
        <div class="mt-segment-row" data-i="${i}">
          <span>${i + 1}.</span>
          <span title="${esc(p)}" style="flex:1; overflow:hidden; text-overflow:ellipsis;">${esc(baseName(p))}</span>
          <button class="icon-btn" data-move-up="${i}" title="Выше" aria-label="Выше" ${i === 0 ? "disabled" : ""}>${ICONS.up}</button>
          <button class="icon-btn" data-move-down="${i}" title="Ниже" aria-label="Ниже" ${i === concatState.paths.length - 1 ? "disabled" : ""}>${ICONS.down}</button>
          <button class="icon-btn" data-remove-concat="${i}" title="Убрать" aria-label="Убрать">${ICONS.close}</button>
        </div>`).join("") : `<div class="no-assignee">Добавьте хотя бы два файла — порядок в списке и есть порядок склейки.</div>`}
    </div>
    <button class="btn primary" id="mt-concat-run" ${concatState.paths.length >= 2 ? "" : "disabled"}>Склеить</button>
  `;
}

function wireConcatPanel(root) {
  root.querySelector("#mt-concat-add-picked").addEventListener("click", () => {
    const sel = root.querySelector("#mt-concat-pick");
    if (sel.value === "") { toast("Выберите файл из пула.", "error"); return; }
    concatState.paths.push(filePool[Number(sel.value)].path);
    renderActivePanel(root);
  });
  root.querySelectorAll("[data-remove-concat]").forEach(btn => {
    btn.addEventListener("click", () => {
      concatState.paths.splice(Number(btn.dataset.removeConcat), 1);
      renderActivePanel(root);
    });
  });
  root.querySelectorAll("[data-move-up]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.moveUp);
      [concatState.paths[i - 1], concatState.paths[i]] = [concatState.paths[i], concatState.paths[i - 1]];
      renderActivePanel(root);
    });
  });
  root.querySelectorAll("[data-move-down]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.moveDown);
      [concatState.paths[i + 1], concatState.paths[i]] = [concatState.paths[i], concatState.paths[i + 1]];
      renderActivePanel(root);
    });
  });
  const runBtn = root.querySelector("#mt-concat-run");
  if (runBtn) runBtn.addEventListener("click", async () => {
    const ext = extOf(concatState.paths[0]) || "mp4";
    const outPath = await pickOutputFile(`merged.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
    if (!outPath) return;
    const mode = await runJob(root, {
      button: runBtn,
      busyLabel: "Склеиваю…",
      run: () => invoke("mt_concat_media", { paths: concatState.paths, outPath }),
    });
    if (!mode) return;
    toastDone(
      mode === "copy"
        ? "Склеено без перекодирования (файлы совпадали по кодекам)."
        : "Склеено с перекодированием (кодеки/разрешение входов отличались).",
      outPath,
    );
  });
}

// ============================================================
// Муксинг — собрать видео + несколько дублей аудио (каждый уже свой
// файл, как хранит команда) + субтитры в один контейнер с языком/именем/
// флагом "по умолчанию" на дорожку, без перекодирования. См. mux_media
// в media_tools.rs. Разметка секций — по образцу референса пользователя
// (Leo MultiTools): Видео/Аудио/Субтитры отдельными группами, у каждой
// дорожки свой язык + имя + переключатель "по умолч.".
// ============================================================

const LANGUAGE_OPTIONS = [
  { code: "und", label: "Не указан" },
  { code: "rus", label: "Русский" },
  { code: "eng", label: "Английский" },
  { code: "jpn", label: "Японский" },
  { code: "chi", label: "Китайский" },
  { code: "kor", label: "Корейский" },
  { code: "ger", label: "Немецкий" },
  { code: "fre", label: "Французский" },
  { code: "spa", label: "Испанский" },
];

const MUX_SECTIONS = [
  { kind: "video", key: "video", label: "Видео", letter: "V", extensions: VIDEO_EXTENSIONS },
  { kind: "audio", key: "audio", label: "Аудио", letter: "A", extensions: AUDIO_EXTENSIONS },
  { kind: "subtitle", key: "subtitle", label: "Субтитры", letter: "S", extensions: SUBTITLE_EXTENSIONS },
];

// Один файл — одна дорожка (без склейки нескольких файлов в одну
// дорожку, в отличие от референса, где под "V1" может быть несколько
// файлов сразу) — это покрывает реальный сценарий команды: у каждого
// дубляжа/сабов свой отдельный файл.
const muxState = { video: [], audio: [], subtitle: [] };

function muxTrackRowHtml(section, track, i) {
  return `
    <div class="mt-mux-row">
      <span class="mt-mux-label">${section.letter}${i + 1}</span>
      <span class="mt-mux-file" title="${esc(track.path)}">${esc(baseName(track.path))}</span>
      <select data-mux-lang data-section="${section.key}" data-i="${i}">
        ${LANGUAGE_OPTIONS.map(l => `<option value="${l.code}" ${l.code === track.language ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
      </select>
      <input type="text" data-mux-title data-section="${section.key}" data-i="${i}" value="${esc(track.title)}" placeholder="Имя дорожки">
      <label class="mt-mux-default-toggle"><input type="checkbox" data-mux-default data-section="${section.key}" data-i="${i}" ${track.isDefault ? "checked" : ""}> По умолч.</label>
      <button class="icon-btn" data-mux-remove data-section="${section.key}" data-i="${i}" title="Убрать" aria-label="Убрать дорожку">${ICONS.close}</button>
    </div>`;
}

function muxSectionHtml(section) {
  const tracks = muxState[section.key];
  return `
    <div class="mt-mux-section">
      <div class="mt-mux-section-head">
        <b>${esc(section.label)}</b>
        <div class="mt-mux-section-add">
          ${poolSelectHtml(`mt-mux-pick-${section.key}`, null, f => section.extensions.includes(extOf(f.path)))}
          <button class="btn ghost" data-mux-add="${section.key}">+ Добавить</button>
        </div>
      </div>
      ${tracks.length ? tracks.map((t, i) => muxTrackRowHtml(section, t, i)).join("") : `<div class="no-assignee">Пусто</div>`}
    </div>`;
}

function totalMuxTracks() {
  return muxState.video.length + muxState.audio.length + muxState.subtitle.length;
}

function muxPanelHtml() {
  return `
    ${MUX_SECTIONS.map(muxSectionHtml).join("")}
    <button class="btn primary" id="mt-mux-run" ${totalMuxTracks() ? "" : "disabled"}>Смуксить</button>
  `;
}

function wireMuxPanel(root) {
  MUX_SECTIONS.forEach(section => {
    const addBtn = root.querySelector(`[data-mux-add="${section.key}"]`);
    if (!addBtn) return;
    addBtn.addEventListener("click", () => {
      const sel = root.querySelector(`#mt-mux-pick-${section.key}`);
      if (sel.value === "") { toast("Выберите файл из пула.", "error"); return; }
      const path = filePool[Number(sel.value)].path;
      const tracks = muxState[section.key];
      tracks.push({ path, language: "und", title: stemOf(path), isDefault: tracks.length === 0 });
      renderActivePanel(root);
    });
  });

  root.querySelectorAll("[data-mux-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      muxState[btn.dataset.section].splice(Number(btn.dataset.i), 1);
      renderActivePanel(root);
    });
  });
  root.querySelectorAll("[data-mux-lang]").forEach(sel => {
    sel.addEventListener("change", () => {
      muxState[sel.dataset.section][Number(sel.dataset.i)].language = sel.value;
    });
  });
  root.querySelectorAll("[data-mux-title]").forEach(inp => {
    inp.addEventListener("input", () => {
      muxState[inp.dataset.section][Number(inp.dataset.i)].title = inp.value;
    });
  });
  // Флаг "по умолчанию" — не больше одной дорожки на раздел (видео,
  // аудио, субтитры отдельно), поэтому включение одной сбрасывает
  // остальные в том же разделе; ре-рендер нужен, чтобы их чекбоксы
  // визуально сняли отметку.
  root.querySelectorAll("[data-mux-default]").forEach(cb => {
    cb.addEventListener("change", () => {
      const section = cb.dataset.section;
      const i = Number(cb.dataset.i);
      muxState[section].forEach((t, idx) => { t.isDefault = idx === i && cb.checked; });
      renderActivePanel(root);
    });
  });

  const runBtn = root.querySelector("#mt-mux-run");
  if (!runBtn) return;
  runBtn.addEventListener("click", async () => {
    const tracks = MUX_SECTIONS.flatMap(section => muxState[section.key].map(t => ({
      path: t.path, kind: section.kind, language: t.language, title: t.title, isDefault: t.isDefault,
    })));
    if (!tracks.length) return;
    const outPath = await pickOutputFile("muxed.mkv", [{ name: "Matroska", extensions: ["mkv"] }]);
    if (!outPath) return;
    const ok = await runJob(root, {
      button: runBtn,
      busyLabel: "Муксирую…",
      run: async () => { await invoke("mt_mux_media", { tracks, outPath }); return true; },
    });
    if (ok) toastDone("Готово.", outPath);
  });
}

// ============================================================
// Дубляж — свести записанный дубль с видео. Самая частая операция
// команды, под которую до сих пор не было ни одной кнопки: приходилось
// собирать муксингом, а сдвинуть дорожку относительно картинки (дубль
// почти никогда не ложится кадр-в-кадр) было нечем вовсе.
// См. dub_audio в media_tools.rs.
// ============================================================

const DUB_MODES = [
  ["replace", "Заменить оригинальный звук"],
  ["add", "Отдельной дорожкой (обе в файле)"],
  ["mix", "Поверх приглушённого оригинала"],
];

const dubState = {
  videoIndex: null, dubIndex: null,
  offset: "0", mode: "replace", originalVolume: "0.15", codec: "aac", bitrate: "192k",
};

function dubPanelHtml() {
  const video = filePool[dubState.videoIndex];
  const dub = filePool[dubState.dubIndex];
  return `
    <div class="mt-form-row">
      <span>Видео</span>
      ${poolSelectHtml("mt-dub-video", dubState.videoIndex, f => f.info && f.info.video)}
      ${video && video.info ? infoLineHtml(video.info) : ""}
    </div>
    <div class="mt-form-row">
      <span>Дорожка дубляжа</span>
      ${poolSelectHtml("mt-dub-audio", dubState.dubIndex, f => f.info && f.info.audio)}
      ${dub && dub.info ? infoLineHtml(dub.info) : ""}
    </div>
    <div class="mt-form-row">
      <span>Что сделать</span>
      <select id="mt-dub-mode">
        ${DUB_MODES.map(([v, l]) => `<option value="${v}" ${v === dubState.mode ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
    </div>
    <div class="mt-form-row">
      <span>Сдвиг дубляжа, с</span>
      <input id="mt-dub-offset" type="number" step="0.01" style="width:100px;" value="${esc(dubState.offset)}">
      <span class="mt-info-line">плюс — дубль звучит позже картинки, минус — раньше</span>
    </div>
    <div class="mt-form-row" ${dubState.mode === "mix" ? "" : "hidden"}>
      <span>Громкость оригинала</span>
      <input id="mt-dub-origvol" type="range" min="0" max="1" step="0.05" style="width:160px;" value="${esc(dubState.originalVolume)}">
      <span class="mt-info-line" id="mt-dub-origvol-val">${Math.round(Number(dubState.originalVolume) * 100)}%</span>
    </div>
    <div class="mt-form-row">
      <span>Кодек / битрейт звука</span>
      <select id="mt-dub-codec">
        ${[["aac", "AAC"], ["libopus", "Opus"], ["flac", "FLAC"], ["pcm_s16le", "PCM 16 бит"]]
          .map(([v, l]) => `<option value="${v}" ${v === dubState.codec ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <input id="mt-dub-bitrate" type="text" style="width:90px;" placeholder="192k" value="${esc(dubState.bitrate)}">
    </div>
    <div class="mt-info-line">Картинка копируется без перекодирования — качество видео не меняется.</div>
    <button class="btn primary" id="mt-dub-run" ${video && dub ? "" : "disabled"}>Свести</button>
  `;
}

function wireDubPanel(root) {
  const bind = (sel, key) => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener("change", () => { dubState[key] = el.value === "" ? null : Number(el.value); renderActivePanel(root); });
  };
  bind("#mt-dub-video", "videoIndex");
  bind("#mt-dub-audio", "dubIndex");
  root.querySelector("#mt-dub-mode").addEventListener("change", e => {
    dubState.mode = e.target.value;
    renderActivePanel(root);
  });
  const remember = (sel, key) => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener("input", () => { dubState[key] = el.value; });
  };
  remember("#mt-dub-offset", "offset");
  remember("#mt-dub-codec", "codec");
  remember("#mt-dub-bitrate", "bitrate");
  const vol = root.querySelector("#mt-dub-origvol");
  if (vol) vol.addEventListener("input", () => {
    dubState.originalVolume = vol.value;
    root.querySelector("#mt-dub-origvol-val").textContent = `${Math.round(Number(vol.value) * 100)}%`;
  });

  const runBtn = root.querySelector("#mt-dub-run");
  runBtn.addEventListener("click", async () => {
    const video = filePool[dubState.videoIndex];
    const dub = filePool[dubState.dubIndex];
    if (!video || !dub) return;
    // mp4 не принимает PCM и капризничает с FLAC — ffmpeg падал уже на
    // записи, после долгого прохода. Такой звук сразу кладём в mkv.
    let outExt = extOf(video.path) || "mkv";
    if (["pcm_s16le", "flac"].includes(dubState.codec) && ["mp4", "m4v"].includes(outExt)) outExt = "mkv";
    const outPath = await pickOutputFile(`${stemOf(video.path)}_dub.${outExt}`, [{ name: outExt.toUpperCase(), extensions: [outExt] }]);
    if (!outPath) return;
    const ok = await runJob(root, {
      button: runBtn,
      busyLabel: "Свожу…",
      run: async () => {
        await invoke("mt_dub_audio", {
          video: video.path,
          dub: dub.path,
          outPath,
          opts: {
            offset: Number(dubState.offset) || 0,
            mode: dubState.mode,
            originalVolume: Number(dubState.originalVolume) || 0,
            audioCodec: dubState.codec,
            audioBitrate: dubState.bitrate.trim() || null,
          },
        });
        return true;
      },
    });
    if (ok) toastDone("Дубляж сведён с видео.", outPath);
  });
}

// ============================================================
// Кадры — стоп-кадр и контактный лист, плюс GIF. Референс для
// переписки («вот этот кадр») и превью серии одним изображением.
// См. extract_frames/make_gif в media_tools.rs.
// ============================================================

const framesState = {
  poolIndex: null, path: null, info: null,
  kind: "single", at: "0", count: "12", columns: "4", width: "640",
  gifStart: "0", gifDuration: "3", gifFps: "15", gifWidth: "480",
};

function framesPanelHtml() {
  const picker = `<div class="mt-file-row">${poolSelectHtml("mt-frames-pick", framesState.poolIndex, f => f.info && f.info.video)}${framesState.path ? infoLineHtml(framesState.info) : ""}</div>`;
  if (!framesState.path) {
    return `${picker}<div class="mt-empty"><p>Выберите видео из пула выше — снять кадр, собрать контактный лист или сделать GIF.</p></div>`;
  }
  const kinds = [["single", "Один кадр"], ["sheet", "Контактный лист"], ["gif", "GIF"]];
  return `
    ${picker}
    <div class="mt-form-row">
      <span>Что сделать</span>
      <select id="mt-frames-kind">
        ${kinds.map(([v, l]) => `<option value="${v}" ${v === framesState.kind ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    ${framesState.kind === "single" ? `
      <div class="mt-form-row"><span>Секунда / ширина, px</span>
        <input id="mt-frames-at" type="number" step="0.1" min="0" style="width:110px;" value="${esc(framesState.at)}">
        <input id="mt-frames-width" type="number" min="1" style="width:110px;" value="${esc(framesState.width)}" title="Ширина, px">
      </div>` : ""}
    ${framesState.kind === "sheet" ? `
      <div class="mt-form-row"><span>Кадров / колонок</span>
        <input id="mt-frames-count" type="number" min="2" max="400" style="width:90px;" value="${esc(framesState.count)}">
        <input id="mt-frames-columns" type="number" min="1" max="20" style="width:90px;" value="${esc(framesState.columns)}">
        <input id="mt-frames-width" type="number" min="1" style="width:110px;" value="${esc(framesState.width)}" title="Ширина кадра, px">
      </div>
      <div class="mt-info-line">Кадры берутся равномерно по всей длине файла.</div>` : ""}
    ${framesState.kind === "gif" ? `
      <div class="mt-form-row"><span>С какой секунды / сколько</span>
        <input id="mt-gif-start" type="number" step="0.1" min="0" style="width:100px;" value="${esc(framesState.gifStart)}">
        <input id="mt-gif-duration" type="number" step="0.1" min="0.1" max="60" style="width:100px;" value="${esc(framesState.gifDuration)}">
      </div>
      <div class="mt-form-row"><span>Кадров в секунду / ширина</span>
        <input id="mt-gif-fps" type="number" min="5" max="50" style="width:100px;" value="${esc(framesState.gifFps)}">
        <input id="mt-gif-width" type="number" min="1" style="width:100px;" value="${esc(framesState.gifWidth)}">
      </div>
      <div class="mt-info-line">Палитра подбирается под этот фрагмент отдельным проходом — без этого GIF выходит грязным на любом градиенте.</div>` : ""}
    <button class="btn primary" id="mt-frames-run">${framesState.kind === "gif" ? "Собрать GIF" : "Снять"}</button>
  `;
}

function wireFramesPanel(root) {
  const pickSel = root.querySelector("#mt-frames-pick");
  if (pickSel) pickSel.addEventListener("change", () => {
    if (pickSel.value === "") return;
    const entry = filePool[Number(pickSel.value)];
    framesState.poolIndex = Number(pickSel.value);
    framesState.path = entry.path;
    framesState.info = entry.info;
    renderActivePanel(root);
  });
  if (!framesState.path) return;
  root.querySelector("#mt-frames-kind").addEventListener("change", e => {
    framesState.kind = e.target.value;
    renderActivePanel(root);
  });
  [["#mt-frames-at", "at"], ["#mt-frames-count", "count"], ["#mt-frames-columns", "columns"],
   ["#mt-frames-width", "width"], ["#mt-gif-start", "gifStart"], ["#mt-gif-duration", "gifDuration"],
   ["#mt-gif-fps", "gifFps"], ["#mt-gif-width", "gifWidth"]].forEach(([sel, key]) => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener("input", () => { framesState[key] = el.value; });
  });

  const runBtn = root.querySelector("#mt-frames-run");
  runBtn.addEventListener("click", async () => {
    const stem = stemOf(framesState.path);
    if (framesState.kind === "gif") {
      const outPath = await pickOutputFile(`${stem}.gif`, [{ name: "GIF", extensions: ["gif"] }]);
      if (!outPath) return;
      const ok = await runJob(root, {
        button: runBtn, busyLabel: "Собираю GIF…",
        run: async () => {
          await invoke("mt_make_gif", {
            path: framesState.path, outPath,
            start: Number(framesState.gifStart) || 0,
            duration: Number(framesState.gifDuration) || 3,
            fps: Number(framesState.gifFps) || 15,
            width: Number(framesState.gifWidth) || 480,
          });
          return true;
        },
      });
      if (ok) toastDone("GIF готов.", outPath);
      return;
    }
    const single = framesState.kind === "single";
    const name = single ? `${stem}_${Math.round(Number(framesState.at) || 0)}s.png` : `${stem}_sheet.jpg`;
    const outPath = await pickOutputFile(name, [{ name: single ? "PNG" : "JPEG", extensions: [single ? "png" : "jpg"] }]);
    if (!outPath) return;
    const ok = await runJob(root, {
      button: runBtn, busyLabel: single ? "Снимаю кадр…" : "Собираю лист…",
      run: async () => {
        await invoke("mt_extract_frames", {
          path: framesState.path, outPath,
          opts: {
            at: Number(framesState.at) || 0,
            count: single ? 1 : (Number(framesState.count) || 12),
            columns: Number(framesState.columns) || 4,
            width: Number(framesState.width) || 640,
          },
        });
        return true;
      },
    });
    if (ok) toastDone(single ? "Кадр сохранён." : "Контактный лист готов.", outPath);
  });
}

// ============================================================
// Скорость — растянуть или ускорить и картинку, и звук разом.
// В дубляже это рабочий инструмент, а не эффект: японский оригинал и
// русская укладка редко совпадают по длине, и дубль подгоняют под
// картинку на несколько процентов. Тон при этом сохраняется (atempo),
// иначе голос «поедет». См. change_speed в media_tools.rs.
// ============================================================

// 1 обязателен в списке — без него у "без изменений" не было своей
// кнопки (скачок сразу с 0.95× на 1.1×), а speedState.speed по умолчанию
// был "1.05", а не "1": открыть вкладку и сразу нажать «Применить»,
// не приглядевшись к числу, молча ускоряло файл на 5% вместо того,
// чтобы ничего не менять.
const SPEED_PRESETS = [0.5, 0.9, 0.95, 1, 1.05, 1.1, 1.25, 1.5, 2];
const speedState = { poolIndex: null, path: null, info: null, speed: "1", keepPitch: true };

function speedDurationHtml() {
  const speed = Number(speedState.speed) || 1;
  const before = speedState.info ? speedState.info.duration : 0;
  return `Длительность: ${formatTime(before)} → <b>${formatTime(speed > 0 ? before / speed : before)}</b>`;
}

function speedPanelHtml() {
  const picker = `<div class="mt-file-row">${poolSelectHtml("mt-speed-pick", speedState.poolIndex, f => f.info && (f.info.video || f.info.audio))}${speedState.path ? infoLineHtml(speedState.info) : ""}</div>`;
  if (!speedState.path) {
    return `${picker}<div class="mt-empty"><p>Выберите файл из пула выше — изменить скорость и картинки, и звука разом.</p></div>`;
  }
  const speed = Number(speedState.speed) || 1;
  return `
    ${picker}
    <div class="mt-form-row">
      <span>Скорость</span>
      <input id="mt-speed-value" type="number" step="0.01" min="0.1" max="10" style="width:100px;" value="${esc(speedState.speed)}">
      <div class="mt-speed-presets">
        ${SPEED_PRESETS.map(v => `<button class="btn ghost mt-speed-preset${Math.abs(v - speed) < 1e-6 ? " active" : ""}" data-speed="${v}">${v}×</button>`).join("")}
      </div>
    </div>
    <div class="mt-form-row">
      <label><input type="checkbox" id="mt-speed-pitch" ${speedState.keepPitch ? "checked" : ""}> Сохранять высоту голоса</label>
      <span class="mt-info-line">без этого голос поедет вверх или вниз, как плёнка не той скорости</span>
    </div>
    <div class="mt-info-line" id="mt-speed-duration">${speedDurationHtml()}</div>
    <button class="btn primary" id="mt-speed-run">Применить</button>
  `;
}

function wireSpeedPanel(root) {
  const pickSel = root.querySelector("#mt-speed-pick");
  if (pickSel) pickSel.addEventListener("change", () => {
    if (pickSel.value === "") return;
    const entry = filePool[Number(pickSel.value)];
    speedState.poolIndex = Number(pickSel.value);
    speedState.path = entry.path;
    speedState.info = entry.info;
    renderActivePanel(root);
  });
  if (!speedState.path) return;

  const value = root.querySelector("#mt-speed-value");
  // Пересчитываем только строку длительности и подсветку пресета: полная
  // перерисовка на каждый символ пересоздавала само поле, и фокус из
  // него пропадал — «1.05» было не набрать, только по одной цифре.
  const syncSpeedUi = () => {
    const current = Number(speedState.speed);
    root.querySelector("#mt-speed-duration").innerHTML = speedDurationHtml();
    root.querySelectorAll("[data-speed]").forEach(b => b.classList.toggle("active", Math.abs(Number(b.dataset.speed) - current) < 1e-6));
  };
  value.addEventListener("input", () => {
    speedState.speed = value.value;
    syncSpeedUi();
  });
  root.querySelectorAll("[data-speed]").forEach(btn => {
    btn.addEventListener("click", () => {
      speedState.speed = btn.dataset.speed;
      value.value = btn.dataset.speed;
      syncSpeedUi();
    });
  });
  root.querySelector("#mt-speed-pitch").addEventListener("change", e => {
    speedState.keepPitch = e.target.checked;
  });

  const runBtn = root.querySelector("#mt-speed-run");
  runBtn.addEventListener("click", async () => {
    const speed = Number(speedState.speed);
    if (!(speed > 0)) { toast("Скорость должна быть больше нуля.", "error"); return; }
    const outPath = await pickOutputFile(`${stemOf(speedState.path)}_x${speed}.${extOf(speedState.path) || "mp4"}`);
    if (!outPath) return;
    const ok = await runJob(root, {
      button: runBtn,
      busyLabel: "Меняю скорость…",
      run: async () => {
        await invoke("mt_change_speed", {
          path: speedState.path, outPath, speed, keepPitch: speedState.keepPitch,
        });
        return true;
      },
    });
    if (ok) toastDone("Готово.", outPath);
  });
}

// ============================================================
// Субтитры — вшить в картинку или вытащить из контейнера.
// См. burn_subtitles/extract_subtitles в media_tools.rs.
// ============================================================

const subsState = { videoIndex: null, subsIndex: null, mode: "burn", fontSize: "28", track: "0" };

function subsPanelHtml() {
  const video = filePool[subsState.videoIndex];
  const burning = subsState.mode === "burn";
  return `
    <div class="mt-form-row">
      <span>Что сделать</span>
      <select id="mt-subs-mode">
        <option value="burn" ${burning ? "selected" : ""}>Вшить субтитры в картинку</option>
        <option value="extract" ${burning ? "" : "selected"}>Вытащить субтитры из файла</option>
      </select>
    </div>
    <div class="mt-form-row">
      <span>Видео</span>
      ${poolSelectHtml("mt-subs-video", subsState.videoIndex, f => f.info && f.info.video)}
      ${video && video.info ? infoLineHtml(video.info) : ""}
    </div>
    ${burning ? `
      <div class="mt-form-row">
        <span>Файл субтитров</span>
        ${poolSelectHtml("mt-subs-file", subsState.subsIndex, f => SUBTITLE_EXTENSIONS.includes(extOf(f.path)))}
      </div>
      <div class="mt-form-row">
        <span>Размер шрифта</span>
        <input id="mt-subs-font" type="number" min="8" max="96" style="width:90px;" value="${esc(subsState.fontSize)}">
        <span class="mt-info-line">действует для .srt; у .ass стиль задан внутри самого файла</span>
      </div>
      <div class="mt-info-line">Вшивание перекодирует картинку — это самая долгая операция здесь.</div>
    ` : `
      <div class="mt-form-row">
        <span>Номер дорожки</span>
        <input id="mt-subs-track" type="number" min="0" max="20" style="width:90px;" value="${esc(subsState.track)}">
        <span class="mt-info-line">0 — первая дорожка субтитров в файле</span>
      </div>
    `}
    <button class="btn primary" id="mt-subs-run" ${video ? "" : "disabled"}>${burning ? "Вшить" : "Вытащить"}</button>
  `;
}

function wireSubsPanel(root) {
  root.querySelector("#mt-subs-mode").addEventListener("change", e => {
    subsState.mode = e.target.value;
    renderActivePanel(root);
  });
  const bind = (sel, key) => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener("change", () => { subsState[key] = el.value === "" ? null : Number(el.value); renderActivePanel(root); });
  };
  bind("#mt-subs-video", "videoIndex");
  bind("#mt-subs-file", "subsIndex");
  [["#mt-subs-font", "fontSize"], ["#mt-subs-track", "track"]].forEach(([sel, key]) => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener("input", () => { subsState[key] = el.value; });
  });

  const runBtn = root.querySelector("#mt-subs-run");
  runBtn.addEventListener("click", async () => {
    const video = filePool[subsState.videoIndex];
    if (!video) return;
    const stem = stemOf(video.path);
    if (subsState.mode === "burn") {
      const subs = filePool[subsState.subsIndex];
      if (!subs) { toast("Выберите файл субтитров из пула.", "error"); return; }
      const outPath = await pickOutputFile(`${stem}_sub.mp4`, [{ name: "MP4", extensions: ["mp4"] }]);
      if (!outPath) return;
      const ok = await runJob(root, {
        button: runBtn, busyLabel: "Вшиваю…",
        run: async () => {
          await invoke("mt_burn_subtitles", {
            video: video.path, subs: subs.path, outPath,
            fontSize: Number(subsState.fontSize) || 28,
          });
          return true;
        },
      });
      if (ok) toastDone("Субтитры вшиты.", outPath);
      return;
    }
    const outPath = await pickOutputFile(`${stem}.srt`, [{ name: "SubRip", extensions: ["srt"] }]);
    if (!outPath) return;
    const ok = await runJob(root, {
      button: runBtn, busyLabel: "Извлекаю…",
      run: async () => {
        await invoke("mt_extract_subtitles", {
          path: video.path, outPath, track: Number(subsState.track) || 0,
        });
        return true;
      },
    });
    if (ok) toastDone("Субтитры извлечены.", outPath);
  });
}

// ============================================================
// Общий каркас модалки — реестр операций (переключатель вкладок).
// Добавить новую операцию позже = ещё одна запись здесь + свой
// html()/wire(), остальное не трогается.
// ============================================================

// ============================================================
// Reaper — проект .rpp из звуковых файлов пула: каждый файл — своя
// дорожка, метки — списком «минуты:секунды название» (по строке).
// Сборка текста — reaper-core.js; сам файл пишет Rust (write_text_file)
// строго по пути из диалога сохранения.
// ============================================================

const reaperState = { selected: new Set(), markers: "", sampleRate: "48000" };

function reaperPanelHtml() {
  const audio = filePool.map((f, i) => ({ f, i })).filter(({ f }) => f.info && f.info.audio);
  if (!audio.length) {
    return `<div class="mt-empty"><p>Добавьте звуковые файлы в пул выше — каждый станет дорожкой проекта Reaper.</p></div>`;
  }
  return `
    <div class="mt-form-row" style="flex-direction:column;align-items:flex-start;gap:6px;">
      ${audio.map(({ f, i }) => `<label><input type="checkbox" data-reaper-file="${i}" ${reaperState.selected.has(i) ? "checked" : ""}> ${esc(baseName(f.path))} <span class="mt-info-line">${esc(formatTime(f.info.duration))}</span></label>`).join("")}
    </div>
    <div class="mt-form-row" style="flex-direction:column;align-items:stretch;gap:6px;">
      <span>Метки <i class="mt-info-line">по строке: 1:23 вдох · 0:05.5 шум</i></span>
      <textarea id="mt-reaper-markers" class="field-textarea" rows="4" placeholder="0:05 начало&#10;1:23 вдох">${esc(reaperState.markers)}</textarea>
    </div>
    <div class="mt-form-row">
      <span>Частота</span>
      <select id="mt-reaper-rate" class="mt-pool-select" style="max-width:130px;">
        ${["44100", "48000", "96000"].map(r => `<option ${r === reaperState.sampleRate ? "selected" : ""}>${r}</option>`).join("")}
      </select>
    </div>
    <button class="btn primary" id="mt-reaper-run">Собрать проект Reaper</button>`;
}

// «1:23 текст», «0:05.5 текст», «83 текст» — время в секундах, затем название.
function parseReaperMarkers(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:(\d+):)?(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(line);
    if (!m) continue;
    const at = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2].replace(",", "."));
    out.push({ at, name: m[3].trim() });
  }
  return out;
}

function wireReaperPanel(root) {
  root.querySelectorAll("[data-reaper-file]").forEach(cb => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.reaperFile);
      if (cb.checked) reaperState.selected.add(i); else reaperState.selected.delete(i);
    });
  });
  const markers = root.querySelector("#mt-reaper-markers");
  markers?.addEventListener("input", () => { reaperState.markers = markers.value; });
  root.querySelector("#mt-reaper-rate")?.addEventListener("change", e => { reaperState.sampleRate = e.target.value; });
  root.querySelector("#mt-reaper-run")?.addEventListener("click", async () => {
    const tracks = [...reaperState.selected].map(i => filePool[i]).filter(Boolean)
      .map(f => ({ name: stemOf(f.path), path: f.path, length: f.info?.duration || 0 }));
    if (!tracks.length) { toast("Отметьте хотя бы один файл.", "error"); return; }
    const outPath = await pickOutputFile("project.rpp", [{ name: "Reaper", extensions: ["rpp"] }]);
    if (!outPath) return;
    try {
      const content = buildRpp({
        name: stemOf(outPath), sampleRate: Number(reaperState.sampleRate) || 48000,
        tracks, markers: parseReaperMarkers(reaperState.markers),
      });
      await invoke("write_text_file", { path: outPath, content });
      toastDone("Проект Reaper сохранён.", outPath);
    } catch (e) {
      toast(`Не удалось сохранить проект: ${e}`, "error");
    }
  });
}

const OPERATIONS = {
  convert: { label: "Конвертация", html: convertPanelHtml, wire: wireConvertPanel },
  audio: { label: "Аудио", html: audioPanelHtml, wire: wireAudioPanel },
  dub: { label: "Дубляж", html: dubPanelHtml, wire: wireDubPanel },
  speed: { label: "Скорость", html: speedPanelHtml, wire: wireSpeedPanel },
  frames: { label: "Кадры", html: framesPanelHtml, wire: wireFramesPanel },
  subs: { label: "Субтитры", html: subsPanelHtml, wire: wireSubsPanel },
  concat: { label: "Склейка", html: concatPanelHtml, wire: wireConcatPanel },
  mux: { label: "Муксинг", html: muxPanelHtml, wire: wireMuxPanel },
  reaper: { label: "Reaper", html: reaperPanelHtml, wire: wireReaperPanel },
};

let activeOp = "convert";

function renderActivePanel(overlay) {
  const body = overlay.querySelector("#mt-body");
  body.innerHTML = OPERATIONS[activeOp].html();
  OPERATIONS[activeOp].wire(overlay);
}

export function openMediaTools() {
  const overlay = openSheet(`
    <div class="mt-head">
      <div><span class="kd-label">Медиа</span><h2>Инструменты ffmpeg</h2></div>
      <button class="icon-btn mt-head-close" data-close title="Закрыть" aria-label="Закрыть">${ICONS.close}</button>
    </div>
    <div id="mt-pool-bar-mount"></div>
    <div class="mt-op-tabs">
      ${Object.entries(OPERATIONS).map(([key, op]) => `<button class="mt-op-tab ${key === activeOp ? "active" : ""}" data-op="${key}">${op.label}</button>`).join("")}
    </div>
    <div id="mt-body"></div>
    ${jobHtml()}
  `, "wide");
  overlay.querySelector(".sheet").classList.add("mt-sheet");

  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());

  overlay.querySelectorAll(".mt-op-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      if (jobRunning) { toast("Дождитесь окончания текущей операции.", "error"); return; }
      activeOp = btn.dataset.op;
      overlay.querySelectorAll(".mt-op-tab").forEach(b => b.classList.toggle("active", b === btn));
      renderActivePanel(overlay);
    });
  });
  renderPoolBar(overlay);
  renderActivePanel(overlay);
  return overlay;
}

$("#open-media-tools").addEventListener("click", openMediaTools);
