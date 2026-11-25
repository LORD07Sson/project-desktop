/* global FileReader */
// Voice samples on a profile: everyone keeps their own voice ("свой голос") and, if they want, samples of roles
// they voiced (title → character). Subbers listen to them while writing the roster or casting characters.
// Server: /api/voice-samples (everyone's list), /api/voice-sample (add), /voice-sample/file/<id> (play one).
import { apiGet, apiPost, mediaUrl, toast, askConfirm, openSheet, dismissSheet } from "./api.js";
import { state } from "./state.js";

const MAX_BYTES = 10 * 1024 * 1024;
const LIST_TTL_MS = 60_000;
let cache = null;   // { at, ids: Set<string>, byUser: Map<string, sample[]> } | pending Promise
let player = null;  // { audio, btn, label }

const PLAY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const STOP_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>`;
const MIC_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

function loadSamples(force = false) {
  if (!force && cache && !(cache instanceof Promise) && Date.now() - cache.at < LIST_TTL_MS) return Promise.resolve(cache);
  if (!force && cache instanceof Promise) return cache;
  const p = apiGet("/voice-samples")
    .then(r => {
      const byUser = new Map();
      for (const s of r.samples || []) {
        const k = String(s.telegram_id);
        if (!byUser.has(k)) byUser.set(k, []);
        byUser.get(k).push(s);
      }
      cache = { at: Date.now(), ids: new Set(byUser.keys()), byUser };
      return cache;
    })
    .catch(() => { cache = null; return { at: 0, ids: new Set(), byUser: new Map() }; });
  cache = p;
  return p;
}

/** Telegram ids (as strings) of everyone with at least one sample. */
export function voiceIds(force = false) {
  return loadSamples(force).then(c => c.ids);
}

const samplesOf = (c, telegramId) => c.byUser.get(String(telegramId)) || [];
// Own voice first (no character), then newest role samples — the server sorts the same way.
const mainSample = list => list.find(s => s.character_id == null) || list[0] || null;
const sampleLabel = s => s.character_id == null ? "Свой голос" : `${s.character_name || "персонаж"}${s.title_name ? ` · ${s.title_name}` : ""}`;

/** Placeholder filled by hydrateVoice(): play buttons for that person's samples. `self` adds the manager. */
export function voiceSlotHtml(telegramId, { self = false, mini = false } = {}) {
  return `<span class="vs-slot${mini ? " mini" : ""}" data-voice-slot="${telegramId || ""}"${self ? ' data-voice-self="1"' : ""}></span>`;
}

function stopPlayer() {
  if (!player) return;
  player.audio.pause();
  player.btn.classList.remove("playing");
  player.btn.innerHTML = player.label;
  player = null;
}

function playSample(btn, sample) {
  const same = player && player.btn === btn;
  stopPlayer();
  if (same || !sample) return;
  const src = mediaUrl(`/voice-sample/file/${encodeURIComponent(sample.id)}`);
  if (!src) { toast("Нет доступа к медиа — переподключитесь.", "error"); return; }
  const audio = new Audio(src);
  player = { audio, btn, label: btn.innerHTML };
  btn.classList.add("playing");
  const icon = btn.querySelector("svg");
  if (icon) icon.outerHTML = STOP_SVG;
  audio.addEventListener("ended", () => { if (player && player.audio === audio) stopPlayer(); });
  audio.play().catch(() => { if (player && player.audio === audio) stopPlayer(); toast("Не удалось воспроизвести запись.", "error"); });
}

function playButton(sample, { mini = false, chip = false, text = "Голос" } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = chip ? "vs-chip" : mini ? "vs-play mini" : "btn vs-play";
  b.title = `Послушать: ${sampleLabel(sample)}`;
  b.innerHTML = chip ? `${PLAY_SVG}<span>${esc(sampleLabel(sample))}</span>` : mini ? PLAY_SVG : `${PLAY_SVG}${esc(text)}`;
  b.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); playSample(b, sample); });
  b.addEventListener("keydown", e => e.stopPropagation());
  return b;
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

function fillSlot(slot, c) {
  const id = slot.dataset.voiceSlot;
  const self = slot.dataset.voiceSelf === "1";
  const mini = slot.classList.contains("mini");
  const list = id ? samplesOf(c, id) : [];
  if (player && slot.contains(player.btn)) stopPlayer();
  slot.innerHTML = "";
  const main = mainSample(list);
  if (main) slot.append(playButton(main, { mini }));
  if (!mini && !self && list.length > 1) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "btn";
    more.textContent = `Все записи · ${list.length}`;
    more.addEventListener("click", () => openSamplesSheet(id));
    slot.append(more);
  }
  if (self) {
    const up = document.createElement("button");
    up.type = "button";
    up.className = "btn";
    up.innerHTML = `${MIC_SVG}${list.length ? `Мои записи · ${list.length}` : "Добавить голос"}`;
    up.title = "Свой голос и роли, которые вы озвучивали: их слушают при росписи и выборе на персонажа";
    up.addEventListener("click", () => openManager(() => loadSamples().then(next => fillSlot(slot, next))));
    slot.append(up);
  }
}

/** Fill every [data-voice-slot] under root. */
export async function hydrateVoice(root) {
  const slots = [...(root || document).querySelectorAll("[data-voice-slot]")];
  if (!slots.length) return;
  const c = await loadSamples();
  slots.forEach(s => s.isConnected && fillSlot(s, c));
}

/** Point an existing slot at another person (e.g. after a casting select changed). */
export function retargetVoiceSlot(slot, telegramId) {
  if (!slot) return;
  slot.dataset.voiceSlot = telegramId || "";
  loadSamples().then(c => fillSlot(slot, c));
}

/** Read-only list of one person's samples. */
async function openSamplesSheet(telegramId) {
  const c = await loadSamples();
  const list = samplesOf(c, telegramId);
  const overlay = openSheet(`<h2>Записи голоса</h2><div class="vs-list"></div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`);
  const box = overlay.querySelector(".vs-list");
  list.forEach(s => box.append(playButton(s, { chip: true })));
  overlay.addEventListener("sheet-dismissed", stopPlayer);
  overlay.querySelector("[data-close]").addEventListener("click", () => { stopPlayer(); dismissSheet(overlay); });
}

/** Own samples: list with play/delete and a form — own voice, or title → character. */
async function openManager(onChange) {
  let roles = null;
  const overlay = openSheet(`
    <h2>Мои записи голоса</h2>
    <p class="sheet-sub">Свой голос — как вы звучите обычно. Роль — отрывок, где вы озвучиваете персонажа: сабберы слушают их, когда решают, кого поставить.</p>
    <div class="vs-list" data-vs-mine></div>
    <div class="vs-form">
      <label class="vs-kind"><input type="radio" name="vs-kind" value="own" checked> Свой голос</label>
      <label class="vs-kind"><input type="radio" name="vs-kind" value="role"> Роль в тайтле</label>
      <div class="vs-role" hidden>
        <select class="field-input" data-vs-title><option value="">Загрузка тайтлов…</option></select>
        <select class="field-input" data-vs-char disabled><option value="">Сначала тайтл</option></select>
      </div>
      <button class="btn primary" data-vs-upload>${MIC_SVG}Выбрать файл и загрузить</button>
      <small class="vs-hint">mp3, ogg, wav, flac, m4a или webm до 10 МБ — хватит 20–60 секунд.</small>
    </div>
    <div class="sheet-actions"><button class="btn" data-close>Готово</button></div>`);
  const mine = overlay.querySelector("[data-vs-mine]");
  const titleSel = overlay.querySelector("[data-vs-title]");
  const charSel = overlay.querySelector("[data-vs-char]");
  const roleBox = overlay.querySelector(".vs-role");
  const close = () => { stopPlayer(); dismissSheet(overlay); };
  overlay.addEventListener("sheet-dismissed", stopPlayer);
  overlay.querySelector("[data-close]").addEventListener("click", close);

  const renderMine = async (force = false) => {
    const c = await loadSamples(force);
    const list = samplesOf(c, state.telegramId);
    mine.innerHTML = list.length ? "" : `<div class="vs-empty">Записей пока нет.</div>`;
    list.forEach(s => {
      const row = document.createElement("div");
      row.className = "vs-mine-row";
      row.append(playButton(s, { chip: true }));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.title = "Удалить запись";
      del.textContent = "✕";
      del.addEventListener("click", async () => {
        if (!await askConfirm(`Удалить запись «${sampleLabel(s)}»?`)) return;
        try { await apiPost(`/voice-sample/delete/${s.id}`); await renderMine(true); onChange(); } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
      });
      row.append(del);
      mine.append(row);
    });
  };
  renderMine();

  const fillChars = () => {
    const t = (roles || []).find(x => String(x.id) === titleSel.value);
    charSel.disabled = !t;
    charSel.innerHTML = t
      ? `<option value="">Персонаж…</option>${t.characters.map(ch => `<option value="${ch.id}">${esc(ch.name)}${ch.mine ? " — вы озвучиваете" : ""}</option>`).join("")}`
      : `<option value="">Сначала тайтл</option>`;
    const own = t && t.characters.find(ch => ch.mine);
    if (own) charSel.value = String(own.id);
  };
  overlay.querySelectorAll('input[name="vs-kind"]').forEach(r => r.addEventListener("change", async () => {
    const role = overlay.querySelector('input[name="vs-kind"]:checked').value === "role";
    roleBox.hidden = !role;
    if (role && !roles) {
      try { roles = (await apiGet("/voice-sample/roles")).titles || []; } catch (e) { roles = []; toast(`Не удалось загрузить тайтлы: ${e.message}`, "error"); }
      titleSel.innerHTML = roles.length
        ? `<option value="">Тайтл…</option>${roles.map(t => `<option value="${t.id}">${esc(t.name)}${t.mine ? " ★" : ""}</option>`).join("")}`
        : `<option value="">Нет тайтлов с персонажами</option>`;
      fillChars();
    }
  }));
  titleSel.addEventListener("change", fillChars);

  overlay.querySelector("[data-vs-upload]").addEventListener("click", async () => {
    const role = overlay.querySelector('input[name="vs-kind"]:checked').value === "role";
    const characterId = role ? Number(charSel.value) || null : null;
    if (role && !characterId) { toast("Выберите тайтл и персонажа.", "error"); return; }
    const file = await pickFile();
    if (!file) return;
    if (file.size > MAX_BYTES) { toast("Запись до 10 МБ — хватит минуты-двух голоса.", "error"); return; }
    try {
      await apiPost("/voice-sample", { audio: await toDataUrl(file), character_id: characterId });
      toast(role ? "Запись роли сохранена." : "Свой голос сохранён — его услышат при росписи.");
      await renderMine(true);
      onChange();
    } catch (e) { toast(`Не удалось загрузить: ${e.message}`, "error"); }
  });
}

/**
 * Pick a person while listening to voices: people with samples come first, with their own voice (▶)
 * and role samples (title · character) to compare. onPick(telegramId | "") gets the choice ("" = nobody).
 */
export async function openVoicePicker({ users, selectedId = "", title = "Кого поставить", onPick }) {
  const c = await loadSamples();
  const label = u => String(u.name || u.username || `ID ${u.telegram_id}`).trim();
  const has = u => c.ids.has(String(u.telegram_id));
  const list = [...users].sort((a, b) => (has(b) - has(a)) || label(a).localeCompare(label(b), "ru", { sensitivity: "base" }));
  const withVoice = list.filter(has).length;
  const overlay = openSheet(`
    <h2>${esc(title)}</h2>
    <p class="sheet-sub">${withVoice ? `Записи есть у ${withVoice} из ${list.length} — нажмите ▶, чтобы послушать, и выберите человека.` : "Пока никто не записал голос в профиле — можно только выбрать по имени."}</p>
    <div class="vs-pick">
      ${list.map(u => `<div class="vs-pick-row${String(u.telegram_id) === String(selectedId) ? " on" : ""}" role="button" tabindex="0" data-pick="${u.telegram_id}">
        <span class="vs-pick-name">${esc(label(u))}${u.username && label(u) !== u.username ? ` <small>@${esc(u.username)}</small>` : ""}</span>
        <span class="vs-pick-samples" data-samples-for="${u.telegram_id}"></span>
      </div>`).join("")}
    </div>
    <div class="sheet-actions"><button class="btn ghost" data-pick="">Никого</button><button class="btn" data-close>Закрыть</button></div>`);
  overlay.querySelectorAll("[data-samples-for]").forEach(box => {
    samplesOf(c, box.dataset.samplesFor).forEach(s => box.append(playButton(s, { chip: true })));
  });
  const close = () => { stopPlayer(); dismissSheet(overlay); };
  overlay.addEventListener("sheet-dismissed", stopPlayer);
  overlay.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  overlay.querySelectorAll("[data-pick]").forEach(el => {
    const pick = () => { close(); onPick(el.dataset.pick); };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); pick(); } });
  });
}

// Who may cast dubbers on characters: admins, subbers (роспись) and sound engineers — the server checks the same.
const CASTING_ROLES = new Set(["роспись", "распись", "расписчик", "расписчица", "звукарь", "звукорежиссер", "звукорежиссерка"]);
let castPromise = null;
export function canCast() {
  if (state.isAdmin) return Promise.resolve(true);
  castPromise ??= apiGet("/me")
    .then(me => (me.roles || []).some(r => CASTING_ROLES.has(String(r).trim().toLowerCase().split("ё").join("е"))))
    .catch(() => { castPromise = null; return false; });
  return castPromise;
}
