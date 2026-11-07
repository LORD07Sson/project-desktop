// Хранилище разработчика: логины, пароли и ключи внешних сервисов.
// В приложении нет ни секретов, ни кодовой фразы: всё хранит и проверяет сервер
// (/api/dev/vault/*, доступ только настоящему владельцу). Сессия хранилища живёт
// только в памяти этого окна и закрывается через 15 минут или кнопкой.
import { apiPost, askConfirm, openSheet, toast } from "./api.js";
import { esc, relTime } from "./utils.js";
import { personName, loadPeopleNames } from "./people-names.js";

let session = "";
let sessionUntil = 0;
const CLIPBOARD_CLEAR_MS = 30_000;

const ACTIONS = {
  phrase_set: "задал кодовую фразу", phrase_changed: "сменил кодовую фразу", unlocked: "открыл хранилище",
  unlock_failed: "неверная фраза", revealed: "посмотрел", copied: "скопировал", saved: "сохранил", deleted: "удалил",
};

function isOpen() { return session && sessionUntil > Date.now(); }

function lockLocal() { session = ""; sessionUntil = 0; }

async function call(path, body = {}) {
  try {
    return await apiPost(`/dev/vault/${path}`, { ...body, session });
  } catch (e) {
    if (/закрыто/i.test(String(e.message || e))) lockLocal();
    throw e;
  }
}

export function vaultEntryHtml() {
  return `<section class="pf-card vault-entry">
    <div><b>🔐 Хранилище</b><div class="pf-quiet">логины, пароли и ключи сервисов — по кодовой фразе</div></div>
    <button class="btn ghost" data-open-vault>Открыть</button>
  </section>`;
}

export function wireVaultEntry(root) {
  root.querySelector("[data-open-vault]")?.addEventListener("click", () => openVault());
}

export async function openVault() {
  const overlay = openSheet(`<div class="vault"><div class="pf-quiet">Проверяю доступ…</div></div>`);
  overlay.querySelector(".sheet").classList.add("vault-sheet");
  const box = overlay.querySelector(".vault");
  overlay.addEventListener("sheet-dismissed", () => {});
  try {
    const st = await call("status");
    if (!st.open) lockLocal();
    if (isOpen()) return renderList(box);
    renderGate(box, st);
  } catch (e) {
    box.innerHTML = `<div class="pf-quiet">${esc(e.message || "Нет доступа.")}</div>`;
  }
}

function renderGate(box, st) {
  const setup = !st.has_phrase;
  box.innerHTML = `
    <h3>🔐 Хранилище разработчика</h3>
    <p class="pf-quiet">${setup
      ? "Задай личную кодовую фразу — минимум 12 символов. Её не хранит ни приложение, ни сервер: только хэш. Забудешь — сменить можно, только зная старую."
      : "Введи кодовую фразу. После 5 ошибок вход закроется на 15 минут, а тебе в Telegram придёт предупреждение."}</p>
    <form class="vault-gate">
      <input type="password" class="input" name="phrase" autocomplete="off" placeholder="Кодовая фраза" required minlength="${setup ? 12 : 1}">
      ${setup ? `<input type="password" class="input" name="again" autocomplete="off" placeholder="Ещё раз" required>` : ""}
      <div class="sheet-actions"><button class="btn primary" type="submit">${setup ? "Задать фразу" : "Открыть"}</button></div>
    </form>`;
  const form = box.querySelector("form");
  form.phrase.focus();
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const phrase = form.phrase.value;
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      if (setup) {
        if (phrase !== form.again.value) throw new Error("Фразы не совпадают.");
        await call("setup", { phrase });
      }
      const r = await call("unlock", { phrase });
      session = r.session;
      sessionUntil = Date.now() + r.expires_in * 1000 - 5000;
      renderList(box);
    } catch (err) {
      toast(err.message || "Не удалось", "error");
      form.phrase.value = "";
      btn.disabled = false;
      form.phrase.focus();
    }
  });
}

async function renderList(box) {
  box.innerHTML = `<div class="pf-quiet">Загружаю…</div>`;
  let items;
  try { ({ items } = await call("items")); } catch (e) { return renderGate(box, { has_phrase: true }); }
  await loadPeopleNames().catch(() => {});
  box.innerHTML = `
    <div class="vault-head">
      <h3>🔐 Хранилище</h3>
      <span class="pf-quiet" data-vault-timer></span>
      <button class="btn ghost" data-vault-log>Журнал</button>
      <button class="btn ghost" data-vault-phrase>Сменить фразу</button>
      <button class="btn ghost" data-vault-lock>Закрыть</button>
    </div>
    <div class="vault-list">${items.length ? items.map(itemHtml).join("") : `<div class="pf-quiet">Пока пусто.</div>`}</div>
    <div class="sheet-actions"><button class="btn primary" data-vault-add>Добавить</button></div>`;
  tickTimer(box);
  box.querySelector("[data-vault-lock]").addEventListener("click", async () => {
    await call("lock").catch(() => {});
    lockLocal();
    box.closest(".overlay")?.remove();
  });
  box.querySelector("[data-vault-add]").addEventListener("click", () => renderEdit(box, null));
  box.querySelector("[data-vault-log]").addEventListener("click", () => renderLog(box));
  box.querySelector("[data-vault-phrase]").addEventListener("click", () => renderPhrase(box));
  for (const row of box.querySelectorAll("[data-vault-id]")) {
    const id = Number(row.dataset.vaultId);
    const item = items.find(i => i.id === id);
    const val = row.querySelector(".vault-val");
    row.querySelector("[data-show]").addEventListener("click", async e => {
      if (val.dataset.shown) { val.textContent = "••••••••"; delete val.dataset.shown; e.target.textContent = "Показать"; return; }
      try {
        const { value } = await call("reveal", { id });
        val.textContent = value; val.dataset.shown = "1"; e.target.textContent = "Скрыть";
        setTimeout(() => { if (val.isConnected && val.dataset.shown) { val.textContent = "••••••••"; delete val.dataset.shown; e.target.textContent = "Показать"; } }, CLIPBOARD_CLEAR_MS);
      } catch (err) { toast(err.message, "error"); }
    });
    row.querySelector("[data-copy-secret]").addEventListener("click", async () => {
      try {
        const { value } = await call("reveal", { id, copy: true });
        await navigator.clipboard.writeText(value);
        toast("Скопировано, буфер очистится через 30 с", "success");
        setTimeout(async () => {
          try { if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText(""); } catch (_) { /* буфер занят другим — не трогаем */ }
        }, CLIPBOARD_CLEAR_MS);
      } catch (err) { toast(err.message, "error"); }
    });
    row.querySelector("[data-copy-login]")?.addEventListener("click", () => navigator.clipboard.writeText(item.login).then(() => toast("Логин скопирован", "success")));
    row.querySelector("[data-edit]").addEventListener("click", () => renderEdit(box, item));
    row.querySelector("[data-del]").addEventListener("click", async () => {
      if (!await askConfirm(`Удалить «${item.name}» навсегда?`)) return;
      try { await call("delete", { id }); renderList(box); } catch (err) { toast(err.message, "error"); }
    });
  }
}

function itemHtml(i) {
  return `<div class="vault-item" data-vault-id="${i.id}">
    <div class="vault-main">
      <b>${esc(i.name)}</b>
      ${i.login ? `<button class="vault-login" data-copy-login title="Копировать логин">${esc(i.login)}</button>` : ""}
      <code class="vault-val">••••••••</code>
      ${i.note ? `<details class="dev-doc"><summary>заметка</summary><div>${esc(i.note)}</div></details>` : ""}
      <span class="pf-quiet">изменил ${esc(personName(i.updated_by) || String(i.updated_by || ""))} · ${relTime(new Date(i.updated_at * 1000).toISOString())}</span>
    </div>
    <div class="vault-actions">
      <button class="btn ghost" data-show>Показать</button>
      <button class="btn ghost" data-copy-secret>Копировать</button>
      <button class="btn ghost" data-edit>Изменить</button>
      <button class="btn ghost danger" data-del>✕</button>
    </div>
  </div>`;
}

function tickTimer(box) {
  const el = box.querySelector("[data-vault-timer]");
  const step = () => {
    if (!el.isConnected) return;
    const left = Math.max(0, Math.round((sessionUntil - Date.now()) / 1000));
    if (!left) { lockLocal(); renderGate(box, { has_phrase: true }); return; }
    el.textContent = `закроется через ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    setTimeout(step, 1000);
  };
  step();
}

function renderEdit(box, item) {
  box.innerHTML = `
    <h3>${item ? "Изменить запись" : "Новая запись"}</h3>
    <form class="vault-form">
      <input class="input" name="name" placeholder="Название (например, Kitsu API)" maxlength="80" required value="${esc(item?.name || "")}">
      <input class="input" name="login" placeholder="Логин или почта (необязательно)" maxlength="200" autocomplete="off" value="${esc(item?.login || "")}">
      <textarea class="input" name="value" rows="3" autocomplete="off" placeholder="${item ? "Новое значение — оставь пустым, чтобы не менять" : "Пароль, токен или ключ"}" ${item ? "" : "required"}></textarea>
      <textarea class="input" name="note" rows="2" maxlength="1000" placeholder="Заметка: где используется, когда менять">${esc(item?.note || "")}</textarea>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-back>Назад</button>
        <button type="submit" class="btn primary">Сохранить</button>
      </div>
    </form>`;
  const form = box.querySelector("form");
  box.querySelector("[data-back]").addEventListener("click", () => renderList(box));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await call("save", { id: item?.id || 0, name: form.name.value, login: form.login.value, note: form.note.value, value: form.value.value });
      toast("Сохранено", "success");
      renderList(box);
    } catch (err) { toast(err.message, "error"); }
  });
}

function renderPhrase(box) {
  box.innerHTML = `
    <h3>Сменить кодовую фразу</h3>
    <form class="vault-form">
      <input type="password" class="input" name="current" placeholder="Текущая фраза" autocomplete="off" required>
      <input type="password" class="input" name="phrase" placeholder="Новая фраза, от 12 символов" autocomplete="off" minlength="12" required>
      <input type="password" class="input" name="again" placeholder="Новая ещё раз" autocomplete="off" required>
      <div class="sheet-actions"><button type="button" class="btn ghost" data-back>Назад</button><button type="submit" class="btn primary">Сменить</button></div>
    </form>`;
  const form = box.querySelector("form");
  box.querySelector("[data-back]").addEventListener("click", () => renderList(box));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (form.phrase.value !== form.again.value) { toast("Фразы не совпадают", "error"); return; }
    try {
      await call("setup", { current: form.current.value, phrase: form.phrase.value });
      lockLocal();
      toast("Фраза сменена, войди заново", "success");
      renderGate(box, { has_phrase: true });
    } catch (err) { toast(err.message, "error"); }
  });
}

async function renderLog(box) {
  let log;
  try { ({ log } = await call("log")); } catch (err) { toast(err.message, "error"); return; }
  box.innerHTML = `
    <h3>Журнал хранилища</h3>
    <div class="vault-log">${log.map(l => `<div class="vault-log-row${l.action === "unlock_failed" ? " bad" : ""}">
      <span>${esc(personName(l.telegram_id) || String(l.telegram_id))}</span>
      <span>${esc(ACTIONS[l.action] || l.action)}${l.item ? ` «${esc(l.item)}»` : ""}</span>
      <span class="pf-quiet">${relTime(new Date(l.ts * 1000).toISOString())}</span>
    </div>`).join("") || `<div class="pf-quiet">Пусто.</div>`}</div>
    <div class="sheet-actions"><button class="btn ghost" data-back>Назад</button></div>`;
  box.querySelector("[data-back]").addEventListener("click", () => renderList(box));
}
