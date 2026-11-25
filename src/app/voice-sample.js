/* global FileReader */
// Voice sample on a profile: everyone attaches one short recording of their voice; subbers listen to it
// while writing the roster or casting characters. Server keeps one file per person (/api/voice-sample).
import { apiGet, apiPost, mediaUrl, toast, askConfirm, openSheet, dismissSheet } from "./api.js";

const MAX_BYTES = 10 * 1024 * 1024;
const LIST_TTL_MS = 60_000;
let listCache = null; // { at, ids: Set<string> } | pending Promise
let player = null;    // { audio, btn }

const PLAY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const STOP_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>`;
const MIC_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;

export function voiceIds(force = false) {
  if (!force && listCache && !(listCache instanceof Promise) && Date.now() - listCache.at < LIST_TTL_MS) return Promise.resolve(listCache.ids);
  if (!force && listCache instanceof Promise) return listCache;
  const p = apiGet("/voice-samples")
    .then(r => { listCache = { at: Date.now(), ids: new Set((r.ids || []).map(String)) }; return listCache.ids; })
    .catch(() => { listCache = null; return new Set(); });
  listCache = p;
  return p;
}

/** Placeholder filled by hydrateVoice(): a play button if that person has a sample. `self` adds upload controls. */
export function voiceSlotHtml(telegramId, { self = false, mini = false } = {}) {
  return `<span class="vs-slot${mini ? " mini" : ""}" data-voice-slot="${telegramId || ""}"${self ? ' data-voice-self="1"' : ""}></span>`;
}

function stopPlayer() {
  if (!player) return;
  player.audio.pause();
  player.btn.classList.remove("playing");
  player.btn.innerHTML = player.btn.dataset.mini ? PLAY_SVG : `${PLAY_SVG}Голос`;
  player = null;
}

function togglePlay(btn, telegramId) {
  const same = player && player.btn === btn;
  stopPlayer();
  if (same) return;
  const src = mediaUrl(`/voice-sample/${encodeURIComponent(telegramId)}`, { v: listCache && listCache.at || 0 });
  if (!src) { toast("Нет доступа к медиа — переподключитесь.", "error"); return; }
  const audio = new Audio(src);
  player = { audio, btn };
  btn.classList.add("playing");
  btn.innerHTML = btn.dataset.mini ? STOP_SVG : `${STOP_SVG}Стоп`;
  audio.addEventListener("ended", () => { if (player && player.audio === audio) stopPlayer(); });
  audio.play().catch(() => { if (player && player.audio === audio) stopPlayer(); toast("Не удалось воспроизвести запись.", "error"); });
}

function pickFile() {
  return new Promise(resolve => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "audio/*,.mp3,.ogg,.opus,.wav,.flac,.m4a,.webm";
    inp.addEventListener("change", () => resolve(inp.files && inp.files[0] || null), { once: true });
    inp.click();
  });
}

const toDataUrl = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

async function upload(onDone) {
  const file = await pickFile();
  if (!file) return;
  if (file.size > MAX_BYTES) { toast("Запись до 10 МБ — хватит минуты-двух голоса.", "error"); return; }
  try {
    await apiPost("/voice-sample", { audio: await toDataUrl(file) });
    toast("Запись голоса сохранена — её услышат при росписи.");
    await voiceIds(true);
    onDone();
  } catch (e) { toast(`Не удалось загрузить: ${e.message}`, "error"); }
}

async function remove(onDone) {
  if (!await askConfirm("Удалить запись голоса?")) return;
  try {
    await apiPost("/voice-sample", { audio: "" });
    await voiceIds(true);
    onDone();
  } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
}

function fillSlot(slot, ids) {
  const id = slot.dataset.voiceSlot;
  const self = slot.dataset.voiceSelf === "1";
  const mini = slot.classList.contains("mini");
  const has = !!id && ids.has(String(id));
  const refill = () => voiceIds().then(next => fillSlot(slot, next));
  if (player && slot.contains(player.btn)) stopPlayer();
  slot.innerHTML = "";
  if (has) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = mini ? "vs-play mini" : "btn vs-play";
    if (mini) b.dataset.mini = "1";
    b.title = "Послушать голос";
    b.innerHTML = mini ? PLAY_SVG : `${PLAY_SVG}Голос`;
    b.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); togglePlay(b, id); });
    b.addEventListener("keydown", e => e.stopPropagation());
    slot.append(b);
  }
  if (self) {
    const up = document.createElement("button");
    up.type = "button";
    up.className = "btn";
    up.innerHTML = `${MIC_SVG}${has ? "Заменить голос" : "Добавить голос"}`;
    up.title = "Короткая запись вашего голоса: её слушают при росписи и выборе на персонажа";
    up.addEventListener("click", () => upload(refill));
    slot.append(up);
    if (has) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.title = "Удалить запись голоса";
      del.textContent = "✕";
      del.addEventListener("click", () => remove(refill));
      slot.append(del);
    }
  }
}

/** Fill every [data-voice-slot] under root. */
export async function hydrateVoice(root) {
  const slots = [...(root || document).querySelectorAll("[data-voice-slot]")];
  if (!slots.length) return;
  const ids = await voiceIds();
  slots.forEach(s => s.isConnected && fillSlot(s, ids));
}

/** Point an existing slot at another person (e.g. after a casting select changed). */
export function retargetVoiceSlot(slot, telegramId) {
  if (!slot) return;
  slot.dataset.voiceSlot = telegramId || "";
  voiceIds().then(ids => fillSlot(slot, ids));
}

/**
 * Pick a person while listening to voices: people with a sample come first, each with ▶.
 * onPick(telegramId | "") is called with the chosen person ("" = nobody).
 */
export async function openVoicePicker({ users, selectedId = "", title = "Кого поставить", onPick }) {
  const ids = await voiceIds();
  const label = u => String(u.name || u.username || `ID ${u.telegram_id}`).trim();
  const list = [...users].sort((a, b) => (ids.has(String(b.telegram_id)) - ids.has(String(a.telegram_id)))
    || label(a).localeCompare(label(b), "ru", { sensitivity: "base" }));
  const withVoice = list.filter(u => ids.has(String(u.telegram_id))).length;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
  const overlay = openSheet(`
    <h2>${esc(title)}</h2>
    <p class="sheet-sub">${withVoice ? `Голос записали ${withVoice} из ${list.length} — нажмите ▶, чтобы послушать, и выберите человека.` : "Пока никто не записал голос в профиле — можно только выбрать по имени."}</p>
    <div class="vs-pick">
      ${list.map(u => `<div class="vs-pick-row${String(u.telegram_id) === String(selectedId) ? " on" : ""}" role="button" tabindex="0" data-pick="${u.telegram_id}">
        <span class="vs-pick-name">${esc(label(u))}${u.username && label(u) !== u.username ? ` <small>@${esc(u.username)}</small>` : ""}</span>
        ${voiceSlotHtml(u.telegram_id, { mini: true })}
      </div>`).join("")}
    </div>
    <div class="sheet-actions"><button class="btn ghost" data-pick="">Никого</button><button class="btn" data-close>Закрыть</button></div>`);
  const close = () => { stopPlayer(); dismissSheet(overlay); };
  overlay.addEventListener("sheet-dismissed", stopPlayer);
  overlay.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  overlay.querySelectorAll("[data-pick]").forEach(el => {
    const pick = () => { close(); onPick(el.dataset.pick); };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); pick(); } });
  });
  hydrateVoice(overlay);
}
