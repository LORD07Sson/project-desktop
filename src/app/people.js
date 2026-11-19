
import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast, askConfirm } from "./api.js";
import { esc } from "./utils.js";

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const PASS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6"/></svg>';

export function fmtDay(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d\d)-(\d\d)/);
  if (!m) return iso || "";
  return `${Number(m[3])} ${MONTHS_GEN[Number(m[2]) - 1]}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
}

export function pauseSuffix(u) {
  return u && u.paused_until ? ` · на паузе до ${fmtDay(u.paused_until)}` : "";
}

export async function fetchPerson(telegramId) {
  try {
    const p = await apiGet(`/people/${telegramId}`);
    return p && p.telegram_id && Array.isArray(p.load) ? p : null;
  } catch (_) { return null; }
}

export function wireWorkSection(root, p, onChange) {
  const pause = root.querySelector("[data-pp-pause]");
  if (pause) pause.addEventListener("click", () => openPauseDialog(p, onChange));
  const pass = root.querySelector("[data-pp-transfer]");
  if (pass) pass.addEventListener("click", () => openTransferDialog(p, onChange));
}

export function openPauseDialog(p, onChange) {
  const self = String(p.telegram_id) === String(state.telegramId);
  const min = new Date().toISOString().slice(0, 10);
  const max = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  const overlay = openSheet(`
    <h2>Пауза уведомлений${self ? "" : ` — ${esc(p.name)}`}</h2>
    <p class="tn-hint">Пока пауза стоит, бот не напоминает о сроках и не пишет о просрочке. Личные напоминания не пропадают — придут в первый день после паузы. То же, что /pause в боте.</p>
    <div class="pp-pause-form">
      <label>До какого дня (включительно)<input type="date" id="pp-until" min="${min}" max="${max}" value="${esc(p.paused_until || "")}"></label>
      <label>Пометка — необязательно<input type="text" id="pp-note" maxlength="100" placeholder="отпуск, экзамены…" value="${esc(p.pause_note || "")}"></label>
      <div class="chip-row" style="padding:0;">
        ${[3, 7, 14, 30].map(n => `<button type="button" class="qchip" data-pp-days="${n}">${n} ${plural(n, "день", "дня", "дней")}</button>`).join("")}
      </div>
    </div>
    <div class="sheet-actions">
      ${p.paused_until ? `<button class="btn" id="pp-off">Снять паузу</button>` : ""}
      <span style="flex:1"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn primary" id="pp-save">Поставить паузу</button>
    </div>`);
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("pp-sheet");
  const until = sheet.querySelector("#pp-until");
  sheet.querySelectorAll("[data-pp-days]").forEach(b => b.addEventListener("click", () => {
    until.value = new Date(Date.now() + Number(b.dataset.ppDays) * 86400000).toISOString().slice(0, 10);
  }));
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  const send = async body => {
    try {
      const r = await apiPost(`/people/${p.telegram_id}/pause`, body);
      overlay.remove();
      toast(r.paused_until ? `Пауза до ${fmtDay(r.paused_until)}.` : "Пауза снята — напоминания снова приходят.");
      if (onChange) onChange(r);
    } catch (e) { toast(e.message, "error"); }
  };
  sheet.querySelector("#pp-save").addEventListener("click", () => {
    if (!until.value) { toast("Выберите дату.", "error"); return; }
    send({ until: until.value, note: sheet.querySelector("#pp-note").value.trim() });
  });
  const off = sheet.querySelector("#pp-off");
  if (off) off.addEventListener("click", () => send({ until: null }));
}

export async function openTransferDialog(p, onChange) {
  let users = state.users && state.users.length ? state.users : null;
  if (!users) {
    try { users = (await apiGet("/assignable-users")).users || []; } catch (_) { users = []; }
  }
  const others = users.filter(u => String(u.telegram_id) !== String(p.telegram_id));
  const n = p.load.length;
  const overlay = openSheet(`
    <h2>Передать дела — ${esc(p.name)}</h2>
    <p class="tn-hint">Переедут только незакрытые серии — ${n} ${plural(n, "шт.", "шт.", "шт.")}. Завершённые остаются за прежним исполнителем: это история. Одним нажатием обратно не вернуть.</p>
    <div class="pp-transfer-list">
      ${p.load.map(r => `<div class="pp-transfer-item"><b>${esc(r.public_id)}</b> ${esc(r.title)}</div>`).join("")}
    </div>
    <label class="pp-to">Кому
      <select id="pp-to">
        <option value="">— выберите человека —</option>
        ${others.map(u => `<option value="${u.telegram_id}">${esc(u.name)}${esc(pauseSuffix(u))}</option>`).join("")}
      </select>
    </label>
    <div class="sheet-actions">
      <span style="flex:1"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn primary" id="pp-go" disabled>${PASS_ICON}Передать ${n}</button>
    </div>`);
  const sheet = overlay.querySelector(".sheet");
  const sel = sheet.querySelector("#pp-to");
  const go = sheet.querySelector("#pp-go");
  sel.addEventListener("change", () => { go.disabled = !sel.value; });
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  go.addEventListener("click", async () => {
    const to = others.find(u => String(u.telegram_id) === sel.value);
    if (!await askConfirm(`Передать ${n} незакрытых серий от ${p.name} → ${to ? to.name : ""}?`)) return;
    go.disabled = true;
    try {
      const r = await apiPost(`/people/${p.telegram_id}/transfer`, { to_telegram_id: Number(sel.value) });
      overlay.remove();
      toast(`Передано: ${r.moved}${r.merged ? `, ещё ${r.merged} уже были на ${to ? to.name : "нём"} — дубли убраны` : ""}.`);
      if (onChange) onChange(r);
    } catch (e) {
      toast(e.message, "error");
      go.disabled = false;
    }
  });
}

export async function fillPauseCard(root, telegramId) {
  const slot = root.querySelector("#pause-card");
  if (!slot) return;
  const p = await fetchPerson(telegramId);
  if (!p || !slot.isConnected) { slot.remove(); return; }
  slot.innerHTML = `
    <div class="dash-cell-head" style="margin-bottom:4px;">
      <span class="dash-cell-title">Пауза уведомлений</span>
      <span class="dash-link">${p.paused_until ? "изменить" : "поставить"}</span>
    </div>
    <div class="sub">${p.paused_until ? `до ${esc(fmtDay(p.paused_until))}${p.pause_note ? ` — ${esc(p.pause_note)}` : ""} · бот не напоминает о сроках` : "напоминания о сроках приходят — на время отпуска можно выключить"}</div>`;
  slot.classList.toggle("pp-paused", !!p.paused_until);
  slot.onclick = () => openPauseDialog(p, () => fillPauseCard(root, telegramId));
}
