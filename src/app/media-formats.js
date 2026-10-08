// Единый список форматов звука и видео. Раньше он был размножен по
// media-tools.js, qc.js, file-drop.js, player.js и report-detail.js и
// расходился (то .aac не принимался, то .opus не играл). Раскодирует всё
// это ffmpeg — и в QC, и в «Инструментах ffmpeg» — так что формат из этого
// списка можно загрузить, проверить и сконвертировать. Воспроизвести в
// плеере карточки (встроенный браузер) получится только то, что умеет
// браузер: wav, mp3, flac, aac, m4a, ogg/opus и подобное.
//
// ВАЖНО: тот же список (звук + видео + документы) продублирован в Rust —
// ALLOWED_UPLOAD_EXT в src-tauri/src/main.rs — и на сервере (_AUDIO_EXT в
// miniapp/server.py). Менять во всех местах сразу.

export const AUDIO_EXTENSIONS = [
  "wav", "wave", "w64", "mp3", "mp2", "flac", "m4a", "m4b", "aac", "ogg", "oga", "opus",
  "wma", "aiff", "aif", "aifc", "ac3", "eac3", "dts", "mka", "ape", "wv", "amr", "caf", "au", "tta", "weba",
];

export const VIDEO_EXTENSIONS = [
  "mp4", "mkv", "mov", "avi", "webm", "m4v", "ts", "m2ts", "mts", "mpg", "mpeg", "wmv", "flv", "3gp", "ogv",
];

// Что браузер реально проиграет (остальное — только QC/ffmpeg).
export const MIME = {
  wav: "audio/wav", wave: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", m4b: "audio/mp4",
  aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", weba: "audio/webm",
};

export const AUDIO_RE = new RegExp("audio|\\.(" + AUDIO_EXTENSIONS.join("|") + ")$", "i");
