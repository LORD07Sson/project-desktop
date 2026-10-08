// Сборка проекта Reaper (.rpp) из набора звуковых файлов. Чистые функции
// без DOM и Tauri — чтобы проверяться обычным node-тестом.
//
// Каждый файл — отдельная дорожка с одним элементом (item) в начале
// проекта; метки (маркеры) — по таймкодам реплик или меток пользователя.
// Формат .rpp — текст с вложенными <БЛОКАМИ>; кавычки в строках
// заменяются, чтобы не ломать разбор.

const q = s => `"${String(s).replace(/"/g, "'").replace(/[\r\n]+/g, " ")}"`;
const num = n => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0");

// Reaper принимает и прямые, и обратные слэши; в Windows-путях оставляем
// как есть, лишь экранируем кавычки.
function pathLine(path) { return `FILE ${q(path)}`; }

export function reaperMarkers(markers = []) {
  return markers
    .filter(m => Number.isFinite(m.at) && m.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((m, i) => `  MARKER ${i + 1} ${num(m.at)} ${q(m.name || `M${i + 1}`)} 0 0 1 R {00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}} 0`);
}

/**
 * @param {{ name?: string, sampleRate?: number, tracks: {name: string, path: string, length: number}[], markers?: {at:number, name?:string}[] }} p
 */
export function buildRpp({ name = "Project", sampleRate = 48000, tracks = [], markers = [] }) {
  if (!tracks.length) throw new Error("Нужен хотя бы один файл.");
  const out = [];
  out.push("<REAPER_PROJECT 0.1 \"7.0\" 0");
  out.push(`  SAMPLERATE ${sampleRate} 0 0`);
  out.push(...reaperMarkers(markers));
  tracks.forEach((t, i) => {
    const len = Number.isFinite(t.length) && t.length > 0 ? t.length : 1;
    out.push("  <TRACK");
    out.push(`    NAME ${q(t.name || `Дорожка ${i + 1}`)}`);
    out.push("    <ITEM");
    out.push("      POSITION 0");
    out.push(`      LENGTH ${num(len)}`);
    out.push(`      NAME ${q(t.name || `Дорожка ${i + 1}`)}`);
    out.push("      <SOURCE WAVE");
    out.push(`        ${pathLine(t.path)}`);
    out.push("      >");
    out.push("    >");
    out.push("  >");
  });
  out.push(">");
  return out.join("\r\n") + "\r\n";
}
