import { clientHeaders, API_BASE, toast, openSheet, dismissSheet } from "./api.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function errorText(res) {
  try { const j = await res.json(); if (j.detail) return j.detail; } catch (_) { }
  return `HTTP ${res.status}`;
}

export function formSheet({ title, sub, fields, submit, onSubmit }) {
  return new Promise(resolve => {
    const overlay = openSheet(`
      <h3>${esc(title)}</h3>
      ${sub ? `<p class="sub">${esc(sub)}</p>` : ""}
      <form class="pr-access-form">
        ${fields.map(f => `<label class="pr-access-field"><span>${esc(f.label)}</span>
          <input name="${f.name}" type="${f.type || "text"}" class="pr-access-key" autocomplete="${f.autocomplete || "off"}" spellcheck="false"
            ${f.value ? `value="${esc(f.value)}"` : ""} ${f.optional ? "" : "required"} placeholder="${esc(f.placeholder || "")}"></label>`).join("")}
        <div class="pr-access-err" hidden></div>
        <div class="sheet-actions"><button type="button" class="btn" data-cancel>Отмена</button><button type="submit" class="btn primary">${esc(submit)}</button></div>
      </form>`);
    const form = overlay.querySelector("form");
    const err = form.querySelector(".pr-access-err");
    let done = false;
    const finish = ok => { if (done) return; done = true; dismissSheet(overlay); resolve(ok); };
    overlay.addEventListener("sheet-dismissed", () => { if (!done) { done = true; resolve(false); } });
    form.querySelector("[data-cancel]").addEventListener("click", () => finish(false));
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const btn = form.querySelector("[type=submit]");
      btn.disabled = true;
      const values = Object.fromEntries(new FormData(form));
      const problem = await onSubmit(values).catch(x => String(x?.message || x));
      btn.disabled = false;
      form.querySelectorAll("input[type=password]").forEach(i => { i.value = ""; });
      if (!problem) { finish(true); return; }
      err.hidden = false;
      err.textContent = problem;
    });
    setTimeout(() => form.querySelector("input")?.focus(), 0);
  });
}

async function post(path, body, extra = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...clientHeaders(), ...extra },
    body: JSON.stringify(body || {}),
  });
  return res.ok ? "" : errorText(res);
}

export function askCatalogLogin() {
  return formSheet({
    title: "Вход в каталог",
    sub: "Логин и пароль выдаёт владелец. Забыли пароль — попросите его сменить.",
    fields: [
      { name: "login", label: "Логин", autocomplete: "username" },
      { name: "password", label: "Пароль", type: "password", autocomplete: "current-password" },
    ],
    submit: "Войти",
    onSubmit: async v => {
      const problem = await post("/parser/access/unlock", { login: v.login, password: v.password });
      if (!problem) toast("Вход выполнен", "success");
      return problem;
    },
  });
}

export async function catalogLogout() {
  await post("/parser/access/logout");
}

export function mountOwnerAccounts(box) {
  let token = "";
  const hdr = () => ({ "X-Settings-Token": token });

  const locked = () => {
    token = "";
    box.innerHTML = `<div class="pr-set-row"><span><b>Аккаунты каталога</b><small>Логины и пароли для входа в каталог. Открывается паролем владельца.</small></span>
      <button type="button" class="btn sm" data-acc-open>Открыть</button></div>`;
  };

  async function render() {
    const res = await fetch(`${API_BASE}/parser/settings/accounts`, { headers: { ...clientHeaders(), ...hdr() } });
    if (!res.ok) { locked(); if (res.status === 403) toast("Сессия настроек истекла — введите пароль снова", "info"); return; }
    const { items } = await res.json();
    box.innerHTML = `<div class="pr-set-row"><span><b>Аккаунты каталога</b><small>Сменили пароль или удалили — человек выйдет из каталога сразу.</small></span>
        <span class="pr-set-acts"><button type="button" class="btn sm primary" data-acc-new>Создать</button><button type="button" class="btn sm" data-acc-lock>Закрыть</button></span></div>
      <div class="pr-acc-list">${items.map(a => `
        <div class="pr-acc">
          <span class="pr-acc-main"><b>${esc(a.login)}</b><small>${a.note ? `${esc(a.note)} · ` : ""}${a.sessions ? `вошли: ${a.sessions}` : "не входил"}</small></span>
          <span class="pr-set-acts">
            <button type="button" class="btn sm" data-acc-pass="${esc(a.login)}">Сменить пароль</button>
            ${a.sessions ? `<button type="button" class="btn sm" data-acc-out="${esc(a.login)}">Выкинуть</button>` : ""}
            <button type="button" class="btn sm danger" data-acc-del="${esc(a.login)}">Удалить</button>
          </span>
        </div>`).join("") || `<div class="pr-acc-empty">Аккаунтов пока нет.</div>`}</div>`;
  }

  box.onclick = async ev => {
    const el = ev.target.closest("button");
    if (!el) return;
    if (el.matches("[data-acc-open]")) {
      await formSheet({
        title: "Пароль владельца", sub: "Нужен при каждом входе в аккаунты каталога.",
        fields: [{ name: "password", label: "Пароль", type: "password" }], submit: "Открыть",
        onSubmit: async v => {
          const res = await fetch(`${API_BASE}/parser/settings/open`, {
            method: "POST", headers: { "Content-Type": "application/json", ...clientHeaders() }, body: JSON.stringify({ password: v.password }),
          });
          if (!res.ok) return errorText(res);
          token = (await res.json()).token;
          return "";
        },
      });
      if (token) render();
    } else if (el.matches("[data-acc-lock]")) {
      await post("/parser/settings/close", {}, hdr());
      locked();
    } else if (el.matches("[data-acc-new]")) {
      const ok = await formSheet({
        title: "Новый аккаунт каталога",
        fields: [
          { name: "login", label: "Логин", placeholder: "латиница, 3–32 символа" },
          { name: "password", label: "Пароль", type: "password", placeholder: "не короче 6 символов" },
          { name: "note", label: "Заметка (кому выдан)", optional: true },
        ],
        submit: "Создать",
        onSubmit: v => post("/parser/settings/accounts", v, hdr()),
      });
      if (ok) { toast("Аккаунт создан", "success"); render(); }
    } else if (el.dataset.accPass) {
      const login = el.dataset.accPass;
      const ok = await formSheet({
        title: `Новый пароль для ${login}`, sub: "Текущие входы этого аккаунта сбросятся.",
        fields: [{ name: "password", label: "Новый пароль", type: "password" }], submit: "Сменить",
        onSubmit: v => post(`/parser/settings/accounts/${encodeURIComponent(login)}/password`, v, hdr()),
      });
      if (ok) { toast("Пароль сменён", "success"); render(); }
    } else if (el.dataset.accOut) {
      const problem = await post(`/parser/settings/accounts/${encodeURIComponent(el.dataset.accOut)}/logout`, {}, hdr());
      toast(problem || "Входы сброшены", problem ? "error" : "success");
      render();
    } else if (el.dataset.accDel) {
      const login = el.dataset.accDel;
      const ok = await formSheet({
        title: `Удалить ${login}?`, sub: "Аккаунт и все его входы пропадут. Чтобы подтвердить, введите логин.",
        fields: [{ name: "confirm", label: "Логин" }], submit: "Удалить",
        onSubmit: async v => (v.confirm.trim().toLowerCase() === login
          ? post(`/parser/settings/accounts/${encodeURIComponent(login)}/delete`, {}, hdr()) : "Логин не совпадает."),
      });
      if (ok) { toast("Аккаунт удалён", "success"); render(); }
    }
  };

  locked();
  return () => { if (token) post("/parser/settings/close", {}, hdr()); token = ""; locked(); };
}
