// MIDI-контроллер для плеера: любая клавиатура или пэд-контроллер
// управляет паузой, перемоткой и громкостью дорожки. Включается в
// Настройки → Поведение. Раскладка и разбор — midi-core.js; сюда
// относится только подключение к Web MIDI и рассылка команд плееру
// событием project-transport (его слушает player.js).

import { midiToCommand } from "./midi-core.js";
import { toast } from "./api.js";

const KEY = "project-midi";
let access = null;

export const midiSupported = () => typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
export function midiEnabled() {
  try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; }
}

function onMessage(ev) {
  const cmd = midiToCommand(ev.data);
  if (cmd) window.dispatchEvent(new CustomEvent("project-transport", { detail: cmd }));
}

function bindAll() {
  if (!access) return;
  access.inputs.forEach(input => { input.onmidimessage = onMessage; });
}

export async function setMidiEnabled(on) {
  if (!on) {
    try { localStorage.setItem(KEY, "0"); } catch (_) { /* не запомнится */ }
    if (access) access.inputs.forEach(input => { input.onmidimessage = null; });
    return true;
  }
  if (!midiSupported()) { toast("В этом окне MIDI недоступен.", "error"); return false; }
  try {
    access = access || await navigator.requestMIDIAccess();
    access.onstatechange = bindAll;
    bindAll();
    try { localStorage.setItem(KEY, "1"); } catch (_) { /* не запомнится */ }
    const n = access.inputs.size;
    toast(n ? `MIDI включён: устройств ${n}.` : "MIDI включён, устройств пока не видно.", "success");
    return true;
  } catch (e) {
    toast(`MIDI не включился: ${e && e.message ? e.message : e}`, "error");
    return false;
  }
}

if (midiEnabled()) setMidiEnabled(true);
