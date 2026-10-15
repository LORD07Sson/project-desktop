// «Новая серия» для Росписи: участник с ролью «Роспись» в составе тайтла
// сам заводит серию (название, срок) — без админа. Сервер создаёт по
// отчёту на каждую роль состава и уведомляет исполнителей.

import { apiGet, apiPost, openSheet, toast } from "./api.js";
import { esc } from "./utils.js";

// Тайтлы, где пользователь — Роспись. Старый сервер без эндпоинта → [].
export async function loadRospisTitles() {
  try {
    const res = await apiGet("/my/rospis-titles");
    return res.titles || [];
  } catch (_) {
    return [];
  }
}

export function openNewEpisodeSheet(titles, onDone) {
  const overlay = openSheet(`
    <div class="detail-head"><h2>Новая серия</h2><button class="icon-btn" data-close style="flex:none;">✕</button></div>
    <div class="detail-section">
      <div class="no-assignee" style="margin-bottom:8px;">Создастся отчёт на каждую роль состава, исполнители получат уведомление.</div>
      <div class="add-row">
        <select id="ne-title" class="field-input">${titles.map(t => `<option value="${t.id}">${esc(t.season_name ? `${t.season_name} · ` : "")}${esc(t.name)}</option>`).join("")}</select>
      </div>
      <div class="add-row">
        <input id="ne-label" placeholder="Серия, например «2 серия»…">
        <input id="ne-deadline" type="date" title="Срок">
      </div>
    </div>
    <div class="sheet-actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="ne-create">Создать</button></div>`);
  const sheet = overlay.querySelector(".sheet");
  sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
  sheet.querySelector("#ne-create").addEventListener("click", async e => {
    const btn = e.currentTarget;
    const label = sheet.querySelector("#ne-label").value.trim();
    const deadline = sheet.querySelector("#ne-deadline").value || null;
    if (!label) { toast("Укажите номер/название серии.", "error"); return; }
    btn.disabled = true;
    try {
      const res = await apiPost(`/titles/${sheet.querySelector("#ne-title").value}/episodes`, { episode_label: label, deadline });
      toast(`Серия создана, отчётов: ${res.created.length}.`, "success");
      overlay.remove();
      if (onDone) onDone();
    } catch (err) {
      toast(`Не удалось создать серию: ${err.message}`, "error");
      btn.disabled = false;
    }
  });
}
