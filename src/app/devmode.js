// Режим разработчика (/api/dev/*, только для owner) — тумблер хранится
// в localStorage: это только переключение того,
// что показать (панель правки на карточке). Авторизацию на КАЖДОЕ
// действие сервер всё равно проверяет заново по OWNER_IDS
// (_require_owner) — фронту тут доверять нельзя.

import { state } from "./state.js";
import { apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const DEV_MODE_KEY = "project-dev-mode";

export function isDevModeOn() {
  try { return localStorage.getItem(DEV_MODE_KEY) === "1"; } catch (_) { return false; }
}
export function setDevModeOn(on) {
  try { localStorage.setItem(DEV_MODE_KEY, on ? "1" : "0"); } catch (_) {}
}
export function devModeActive() { return !!state.isDeveloper && isDevModeOn(); }

export function devPanelHtml(d) {
  return `
    <div class="dev-head"><span class="kd-label">Служебные данные</span><span class="dev-tag">режим разработчика</span></div>
    <div class="dev-bento">
      <div class="dev-bcell wide">
        <div class="h">Идентификаторы</div>
        <div class="dev-ids">
          <button class="dev-id" data-copy="${esc(String(d.telegram_id))}" title="Копировать"><span>telegram_id</span><b>${d.telegram_id}</b></button>
          <button class="dev-id" data-copy="${d.internal_id != null ? d.internal_id : ""}" title="Копировать"><span>internal id</span><b>${d.internal_id != null ? d.internal_id : "—"}</b></button>
          <div class="dev-id static"><span>в базе с</span><b class="plain">${esc(d.created_at || "—")}</b></div>
        </div>
      </div>
      <div class="dev-bcell wide">
        <div class="h">Профиль</div>
        <div class="dev-hint">Специализации назначаются через «Роли» в карточке участника.</div>
        <input type="text" id="dev-status-input" class="field-input" maxlength="80" placeholder="Короткий статус" value="${esc(d.status_text || "")}">
        <textarea id="dev-bio-input" class="field-textarea" maxlength="300" placeholder="О себе">${esc(d.bio || "")}</textarea>
        <button id="dev-profile-save" class="dev-save-btn">Сохранить</button>
      </div>
      <div class="dev-bcell">
        <div class="h">Дата вступления</div>
        <input type="text" inputmode="numeric" maxlength="10" placeholder="дд.мм.гггг" autocomplete="off" id="dev-joined-input" class="field-input" value="${esc((d.created_at || "").slice(0, 10).split("-").reverse().join("."))}">
        <button id="dev-joined-save" class="dev-save-btn">Сохранить</button>
      </div>
      <div class="dev-bcell">
        <div class="h">Выдать награду</div>
        <div class="dev-badge-row">
          <input type="text" id="dev-badge-icon" class="field-input" placeholder="🐉" maxlength="8">
          <input type="text" id="dev-badge-label" class="field-input" placeholder="Название" maxlength="60">
        </div>
        <button id="dev-badge-grant" class="dev-save-btn">Выдать</button>
      </div>
    </div>
  `;
}

export function wireDevPanel(root, telegramId, onSaved) {
  root.querySelectorAll(".dev-id[data-copy]").forEach(btn => btn.addEventListener("click", async () => {
    const v = btn.dataset.copy;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); toast("Скопировано."); } catch (_) { toast("Не удалось скопировать.", "error"); }
  }));
  const profileBtn = root.querySelector("#dev-profile-save");
  if (profileBtn) profileBtn.addEventListener("click", async () => {
    const status_text = root.querySelector("#dev-status-input").value;
    const bio = root.querySelector("#dev-bio-input").value;
    profileBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/profile`, { status_text, bio });
      toast("Сохранено.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить: ${e.message}`, "error"); }
    finally { profileBtn.disabled = false; }
  });

  root.querySelector("#dev-joined-input")?.addEventListener("input", e => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 8);
    e.target.value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join(".");
  });
  const joinedBtn = root.querySelector("#dev-joined-save");
  if (joinedBtn) joinedBtn.addEventListener("click", async () => {
    // Поле в виде дд.мм.гггг; на сервер уходит гггг-мм-дд.
    const dm = root.querySelector("#dev-joined-input").value.trim().match(/^(\d\d)\.(\d\d)\.(\d{4})$/);
    if (!dm || +dm[2] < 1 || +dm[2] > 12 || +dm[1] < 1 || +dm[1] > 31) { toast("Укажите дату в виде дд.мм.гггг.", "error"); return; }
    const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
    joinedBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/joined`, { date });
      toast("Дата вступления обновлена.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить дату: ${e.message}`, "error"); }
    finally { joinedBtn.disabled = false; }
  });

  const badgeBtn = root.querySelector("#dev-badge-grant");
  if (badgeBtn) badgeBtn.addEventListener("click", async () => {
    const icon = root.querySelector("#dev-badge-icon").value || "🏅";
    const label = root.querySelector("#dev-badge-label").value.trim();
    if (!label) { toast("Нужно название награды.", "error"); return; }
    badgeBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/badge`, { icon, label });
      toast("Награда выдана.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось выдать награду: ${e.message}`, "error"); }
    finally { badgeBtn.disabled = false; }
  });
}
