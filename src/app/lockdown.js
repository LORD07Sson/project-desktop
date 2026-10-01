// Аварийный режим («Саботаж») и корзина удалённого — десктопная часть
// серверных /api/lockdown и /api/trash (на сервере: lockdown.py и
// таблица trash). Пока режим включён, удаление, смена доступов и
// публикации заблокированы для всех, кроме владельца; сервер отвечает
// на них 423 с объяснением, а здесь — красная полоса над вкладками,
// чтобы было понятно, почему кнопки не работают.

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast } from "./api.js";
import { $, esc } from "./utils.js";

const POLL_INTERVAL_MS = 60_000;
let current = null; // ответ /api/lockdown

function render() {
  const el = $("#lockdown-banner");
  if (!el) return;
  if (!current || !current.on) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `
    <span class="ld-ic">🚨</span>
    <div class="ld-body">
      <b>Аварийный режим</b> — удаление, смена доступов и публикации временно отключены.
      <span class="ld-meta">Включил: ${esc(current.by || "?")}${current.at ? ` · ${esc(current.at)}` : ""}${current.reason ? ` · ${esc(current.reason)}` : ""}</span>
    </div>
    ${current.can_disable ? `<button type="button" class="btn ld-off" id="ld-off">Снять режим</button>` : ""}`;
  el.querySelector("#ld-off")?.addEventListener("click", disableLockdown);
}

export async function refreshLockdown() {
  if (!state.token) return;
  try {
    current = await apiGet("/lockdown");
    render();
  } catch (_) { /* старый сервер без эндпоинта или нет сети — полосы просто нет */ }
}

export function clearLockdown() {
  current = null;
  render();
}

async function disableLockdown() {
  if (!confirm("Снять аварийный режим? Удаление, доступы и публикации снова заработают у всех.")) return;
  try {
    await apiPost("/lockdown", { on: false });
    toast("Аварийный режим снят — команда получила сообщение.");
    await refreshLockdown();
  } catch (e) { toast(`Не удалось снять: ${e.message}`, "error"); }
}

// «Таблица предупреждения» из плана: что именно произойдёт — до кнопки.
const CONSEQUENCES = [
  ["⛔", "Удаление отчётов, тайтлов, сезонов, каналов и сообщений", "заблокировано"],
  ["⛔", "Выдача и отзыв доступа, одобрение заявок", "заблокировано"],
  ["⛔", "Публикация и удаление постов", "заблокировано"],
  ["✅", "Работа с отчётами: файлы, заметки, статусы", "как обычно"],
  ["📣", "Вся команда", "получит сообщение, кто и зачем включил"],
  ["👑", "Снять режим", "может только владелец"],
];

export async function openLockdownSheet() {
  await refreshLockdown();
  const on = current && current.on;
  const overlay = openSheet(on ? `
    <h2>🚨 Аварийный режим включён</h2>
    <p class="ld-hint">Включил: <b>${esc(current.by || "?")}</b>${current.at ? `, ${esc(current.at)}` : ""}.${current.reason ? `<br>Причина: ${esc(current.reason)}` : ""}</p>
    <p class="ld-hint">Удаление, смена доступов и публикации заблокированы для всех, кроме владельца.</p>
    <div class="sheet-actions">
      ${current.can_disable ? `<button class="btn" id="ld-open-trash">Корзина и кто удалял</button><span style="flex:1"></span><button class="btn primary" id="ld-disable">Снять режим</button>` : `<span style="flex:1"></span>`}
      <button class="btn" data-close>Закрыть</button>
    </div>` : `
    <h2>🚨 Аварийный режим («Саботаж»)</h2>
    <p class="ld-hint">Включайте, только если кто-то из команды злоупотребляет удалением или сливает материалы. Всё удалённое за последние 7 дней владелец может вернуть из корзины.</p>
    <table class="ld-table">${CONSEQUENCES.map(([i, what, how]) => `<tr><td>${i}</td><td>${what}</td><td>${how}</td></tr>`).join("")}</table>
    <label class="ld-reason">Причина (увидит вся команда)
      <input type="text" id="ld-reason" maxlength="300" placeholder="Например: массово удаляются отчёты">
    </label>
    <label class="ld-ack"><input type="checkbox" id="ld-ack"> Я понимаю последствия — ответственность за включение на мне, это попадёт в журнал действий</label>
    <div class="sheet-actions">
      <span style="flex:1"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn danger" id="ld-enable" disabled>Включить аварийный режим</button>
    </div>`);
  const sheet = overlay.querySelector(".sheet");
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelector("#ld-disable")?.addEventListener("click", async () => { overlay.remove(); await disableLockdown(); });
  sheet.querySelector("#ld-open-trash")?.addEventListener("click", () => { overlay.remove(); openTrashSheet(); });
  const ack = sheet.querySelector("#ld-ack");
  const enable = sheet.querySelector("#ld-enable");
  ack?.addEventListener("change", () => { enable.disabled = !ack.checked; });
  enable?.addEventListener("click", async () => {
    enable.disabled = true;
    try {
      await apiPost("/lockdown", { on: true, reason: sheet.querySelector("#ld-reason").value.trim() });
      overlay.remove();
      toast("🚨 Аварийный режим включён — команда и владелец получили сообщение.");
      await refreshLockdown();
    } catch (e) {
      toast(`Не удалось включить: ${e.message}`, "error");
      enable.disabled = false;
    }
  });
}

// ---------- Корзина (только владелец) ----------

const KIND_ICON = { report: "📋", title: "🎬", season: "📅" };

export async function openTrashSheet() {
  const overlay = openSheet(`<h2>Корзина</h2><div class="no-assignee">Загружаю…</div>`, "wide");
  const sheet = overlay.querySelector(".sheet");

  async function render() {
    let d;
    try {
      d = await apiGet("/trash");
    } catch (e) {
      sheet.innerHTML = `<h2>Корзина</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const deleters = d.deleters || [];
    const items = d.items || [];
    sheet.innerHTML = `
      <h2>Корзина <span class="ld-sub">удалённое хранится 7 дней</span></h2>
      ${deleters.length ? `<div class="detail-section"><h3>Кто удалял за сутки</h3>
        ${deleters.map(x => `<div class="mini-row"><span class="name">${esc(x.name)}</span><span class="val">${x.count}</span></div>`).join("")}</div>` : ""}
      <div class="detail-section"><h3>Удалённое</h3>
        ${items.length ? items.map(x => `
          <div class="mini-row ld-item">
            <span class="name">${KIND_ICON[x.kind] || "•"} ${esc(x.kind_label)} ${x.kind === "report" ? esc(x.ref) + " · " : ""}${esc(x.label || "")}</span>
            <span class="val">${esc(x.deleted_by)} · ${esc(x.deleted_at || "")}</span>
            <button class="btn" data-restore="${x.id}">Вернуть</button>
          </div>`).join("") : `<div class="no-assignee">Корзина пуста.</div>`}
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-restore]").forEach(btn => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await apiPost(`/trash/${btn.dataset.restore}/restore`, {});
        toast(`♻️ ${r.message}`, "success");
        await render();
      } catch (e) {
        toast(e.message, "error");
        btn.disabled = false;
      }
    }));
  }

  await render();
}

window.setInterval(refreshLockdown, POLL_INTERVAL_MS);
window.addEventListener("focus", refreshLockdown);
