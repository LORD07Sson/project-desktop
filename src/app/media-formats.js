
export const AUDIO_EXTENSIONS = [
  "wav", "wave", "w64", "mp3", "mp2", "flac", "m4a", "m4b", "aac", "ogg", "oga", "opus",
  "wma", "aiff", "aif", "aifc", "ac3", "eac3", "dts", "mka", "ape", "wv", "amr", "caf", "au", "tta", "weba",
];

export const VIDEO_EXTENSIONS = [
  "mp4", "mkv", "mov", "avi", "webm", "m4v", "ts", "m2ts", "mts", "mpg", "mpeg", "wmv", "flv", "3gp", "ogv",
];

export const MIME = {
  wav: "audio/wav", wave: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", m4b: "audio/mp4",
  aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", weba: "audio/webm",
};

export const AUDIO_RE = new RegExp("audio|\\.(" + AUDIO_EXTENSIONS.join("|") + ")$", "i");
