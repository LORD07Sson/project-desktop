// Режим разработчика (/api/dev/*, только для owner) — тумблер хранится
// в localStorage: это только переключение того,
// что показать (панель правки на карточке). Авторизацию на КАЖДОЕ
// действие сервер всё равно проверяет заново по OWNER_IDS
// (_require_owner) — фронту тут доверять нельзя.

import { state } from "./state.js";
import { apiGet, apiPost, askConfirm, toast } from "./api.js";
import { esc, relTime } from "./utils.js";
import { actionLabel, forgetPeopleNames } from "./people-names.js";
import { openExternal } from "./tauri.js";

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
        <div class="h">Быстрые действия</div>
        <div class="dev-actions">
          ${String(d.telegram_id) !== String(state.telegramId) ? `<button class="btn" data-dev-dm>Написать в чате</button>` : ""}
          ${d.username ? `<button class="btn" data-dev-tg>Открыть в Telegram</button><button class="btn" data-copy="@${esc(d.username)}">Скопировать @${esc(d.username)}</button>` : ""}
          <button class="btn" data-dev-json>Скопировать все данные</button>
        </div>
      </div>
      <div class="dev-bcell">
        <div class="h">Имя в команде</div>
        <input type="text" id="dev-name-input" class="field-input" maxlength="40" placeholder="Пусто — имя из Telegram">
        <button id="dev-name-save" class="dev-save-btn">Сохранить</button>
      </div>
      <div class="dev-bcell">
        <div class="h">Цель месяца</div>
        <input type="number" id="dev-goal-input" class="field-input" min="0" max="500" placeholder="0 — без цели">
        <button id="dev-goal-save" class="dev-save-btn">Сохранить</button>
      </div>
      <div class="dev-bcell wide">
        <div class="h">Положение баннера</div>
        <input type="range" id="dev-banner-input" min="0" max="100" value="${Number(d.banner_pos_y ?? 50)}" aria-label="Положение баннера по вертикали">
        <button id="dev-banner-save" class="dev-save-btn">Сохранить</button>
      </div>
      <div class="dev-bcell wide">
        <div class="h">Последние действия</div>
        <div class="dev-acts" id="dev-acts"><div class="dev-hint">загружаю…</div></div>
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

async function fillDevExtra(root, telegramId) {
  const box = root.querySelector("#dev-acts");
  if (!box) return;
  let x;
  try { x = await apiGet(`/dev/user/${telegramId}/extra`); }
  catch (e) { box.innerHTML = `<div class="dev-hint">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
  if (!box.isConnected) return;
  const goal = root.querySelector("#dev-goal-input");
  if (goal) goal.value = x.monthly_goal || 0;
  const name = root.querySelector("#dev-name-input");
  if (name) name.value = x.display_name || "";
  const evs = x.events || [];
  box.innerHTML = evs.length ? evs.map(ev => `
    <button type="button" class="dev-act" data-dev-report="${esc(ev.public_id || "")}">
      <b>${esc(actionLabel(ev.action))}</b>${ev.detail ? ` <span>· ${esc(ev.detail)}</span>` : ""}
      <small>${esc(ev.public_id || "")} ${esc(ev.title || "")} · ${esc(relTime(ev.created_at))}</small>
    </button>`).join("") : `<div class="dev-hint">Действий пока нет.</div>`;
  box.querySelectorAll("[data-dev-report]").forEach(b => b.addEventListener("click", async () => {
    const { openReportDetail } = await import("./report-detail.js");
    openReportDetail(b.dataset.devReport);
  }));
}

// Кнопка сохранения: блокировка на время запроса, тост, перерисовка профиля.
function wireSave(root, sel, send, done, onSaved) {
  const btn = root.querySelector(sel);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await send();
      toast(done);
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить: ${e.message}`, "error"); }
    finally { btn.disabled = false; }
  });
}

export function wireDevPanel(root, telegramId, onSaved, d) {
  fillDevExtra(root, telegramId);
  root.querySelector("[data-dev-dm]")?.addEventListener("click", async () => {
    const [{ openDmWith }, { switchTab }] = await Promise.all([import("./messages.js"), import("./tabs.js")]);
    openDmWith(telegramId);
    switchTab("messages");
  });
  root.querySelector("[data-dev-tg]")?.addEventListener("click", () => {
    openExternal(`https://t.me/${encodeURIComponent(d.username)}`).catch(e => toast(`Не удалось открыть Telegram: ${e}`, "error"));
  });
  root.querySelector("[data-dev-json]")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(d, null, 2)); toast("Данные скопированы."); }
    catch (_) { toast("Не удалось скопировать.", "error"); }
  });
  wireSave(root, "#dev-name-save", async () => {
    await apiPost(`/dev/user/${telegramId}/profile`, { display_name: root.querySelector("#dev-name-input").value });
    forgetPeopleNames();
  }, "Имя сохранено.", onSaved);
  wireSave(root, "#dev-goal-save", () => apiPost(`/dev/user/${telegramId}/goal`, { goal: Number(root.querySelector("#dev-goal-input").value) || 0 }), "Цель сохранена.", onSaved);
  wireSave(root, "#dev-banner-save", () => apiPost(`/dev/user/${telegramId}/profile`, { banner_pos_y: Number(root.querySelector("#dev-banner-input").value) }), "Положение сохранено.", onSaved);
  root.querySelectorAll("[data-copy]").forEach(btn => btn.addEventListener("click", async () => {
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

// Все поля записи из базы: значение копируется кликом, вся запись — кнопкой.
function rawHtml(row) {
  return `<dl class="dev-raw">${Object.entries(row).map(([k, v]) => `<dt>${esc(k)}</dt><dd><button type="button" class="dev-raw-v" data-copy="${esc(String(v ?? ""))}" title="Копировать">${v == null || v === "" ? "—" : esc(String(v))}</button></dd>`).join("")}</dl>`;
}

function wireCopy(box, row) {
  const copy = async text => {
    try { await navigator.clipboard.writeText(text); toast("Скопировано."); }
    catch (_) { toast("Не удалось скопировать.", "error"); }
  };
  box.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => { if (b.dataset.copy) copy(b.dataset.copy); }));
  box.querySelector("[data-dev-json]")?.addEventListener("click", () => copy(JSON.stringify(row, null, 2)));
}

// Вкладка «Служебное» в карточке отчёта.
export async function fillReportDevPanel(box, publicId) {
  box.innerHTML = `<div class="dev-hint">загружаю…</div>`;
  let row;
  try { row = await apiGet(`/dev/report/${encodeURIComponent(publicId)}/raw`); }
  catch (e) { box.innerHTML = `<div class="dev-hint">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
  box.innerHTML = `
    <div class="dev-actions dev-actions-top">
      <button class="btn" data-dev-json>Скопировать запись</button>
      <button class="btn" data-dev-reset title="Бот снова напомнит о сроке и просрочке">Сбросить напоминания</button>
    </div>
    ${rawHtml(row)}`;
  wireCopy(box, row);
  box.querySelector("[data-dev-reset]").addEventListener("click", async () => {
    if (!await askConfirm(`Сбросить напоминания для ${publicId}? Бот сможет снова написать исполнителям о сроке и просрочке.`, { yes: "Сбросить", danger: true })) return;
    try {
      await apiPost(`/dev/report/${encodeURIComponent(publicId)}/reset-reminders`, {});
      toast("Напоминания сброшены.");
      fillReportDevPanel(box, publicId);
    } catch (e) { toast(`Не удалось сбросить: ${e.message}`, "error"); }
  });
}

// Блок внизу страницы тайтла.
export async function appendTitleDevPanel(sheet, titleId) {
  const box = document.createElement("section");
  box.className = "tpg-dev";
  sheet.querySelector(".tp")?.appendChild(box);
  const fill = async () => {
    let row;
    try { row = await apiGet(`/dev/title/${titleId}/raw`); }
    catch (e) { box.innerHTML = `<div class="dev-hint">Не удалось загрузить служебные данные: ${esc(e.message)}</div>`; return; }
    box.innerHTML = `
      <div class="dev-head"><span class="kd-label">Служебные данные</span><span class="dev-tag">режим разработчика</span></div>
      <div class="dev-binding">
        <label>Shikimori ID<input type="number" min="1" class="field-input" id="dev-shiki" value="${esc(String(row.shiki_id ?? ""))}"></label>
        <label>AniList ID<input type="number" min="1" class="field-input" id="dev-anilist" value="${esc(String(row.anilist_id ?? ""))}"></label>
        <button class="dev-save-btn" id="dev-binding-save">Сохранить привязку</button>
        <button class="btn" data-dev-json>Скопировать запись</button>
      </div>
      ${rawHtml(row)}`;
    wireCopy(box, row);
    const save = box.querySelector("#dev-binding-save");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await apiPost(`/dev/title/${titleId}/binding`, { shiki_id: box.querySelector("#dev-shiki").value, anilist_id: box.querySelector("#dev-anilist").value });
        toast("Привязка сохранена.");
        fill();
      } catch (e) { toast(`Не удалось сохранить: ${e.message}`, "error"); save.disabled = false; }
    });
  };
  await fill();
}
