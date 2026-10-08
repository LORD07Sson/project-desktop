// Самодиагностика: превращает сырые данные проверок в понятный список
// «что в порядке, что нет и что делать». Чистые функции — без DOM и Tauri.

export const OK = "ok", WARN = "warn", BAD = "bad";

/** Строка версии ffmpeg → «ffmpeg 6.1» или исходная строка, если формат незнаком. */
export function shortVersion(line) {
  const m = /(?:ffmpeg|ffprobe) version\s+([^\s]+)/i.exec(String(line || ""));
  return m ? m[1] : String(line || "").slice(0, 40);
}

export function checkTool(name, version) {
  return version
    ? { label: name, status: OK, detail: shortVersion(version) }
    : { label: name, status: BAD, detail: "не найден — инструменты звука и видео не заработают" };
}

export function checkServer(pingMs) {
  if (pingMs == null) return { label: "Сервер команды", status: BAD, detail: "нет связи — проверьте интернет и VPN" };
  return { label: "Сервер команды", status: pingMs > 1500 ? WARN : OK, detail: `${pingMs} мс${pingMs > 1500 ? " — медленно" : ""}` };
}

export function checkMic(devices) {
  const mics = (devices || []).filter(d => d.kind === "audioinput");
  return mics.length
    ? { label: "Микрофон", status: OK, detail: `найдено: ${mics.length}` }
    : { label: "Микрофон", status: WARN, detail: "не найден — запись из программы не получится" };
}

export function checkStorage(estimate) {
  if (!estimate || !estimate.quota) return { label: "Место для кеша", status: WARN, detail: "не удалось узнать" };
  const free = estimate.quota - (estimate.usage || 0);
  const gb = free / 1073741824;
  return { label: "Место для кеша", status: gb < 1 ? WARN : OK, detail: `свободно ≈ ${gb.toFixed(1)} ГБ` };
}

export function checkNotify(permission) {
  if (permission === "granted") return { label: "Уведомления", status: OK, detail: "разрешены" };
  if (permission === "denied") return { label: "Уведомления", status: WARN, detail: "запрещены в системе — не услышите о назначениях" };
  return { label: "Уведомления", status: WARN, detail: "ещё не разрешены" };
}

export function summarize(results) {
  const bad = results.filter(r => r.status === BAD).length;
  const warn = results.filter(r => r.status === WARN).length;
  if (bad) return `Есть проблемы: ${bad}`;
  if (warn) return `Почти всё в порядке, замечаний: ${warn}`;
  return "Всё в порядке";
}
