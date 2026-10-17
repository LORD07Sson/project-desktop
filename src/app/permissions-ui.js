// «Права ролей» — выбираем роль слева, справа включаем нужные права переключателями (только владелец).
// Сервер: GET/POST /api/permissions ({role, permissions: [...]} — весь набор прав роли).
// Каждое изменение сохраняется сразу; права проверяет сервер на каждом запросе, клиент лишь скрывает недоступное.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

export async function mountPermissions(root) {
  if (!root) return;
  let data = null;
  let current = null;   // ключ выбранной роли
  let query = "";

  const granted = key => new Set(data.grants[key] || []);

  async function save(role, perms, okText) {
    try {
      data = await apiPost("/permissions", { role, permissions: [...perms] });
      toast(okText || "Сохранено.", "success");
    } catch (e) {
      toast(e.message, "error");
    }
    paint();
  }

  function paint() {
    const roles = data.roles;
    if (!roles.some(r => r.key === current)) current = roles[0] ? roles[0].key : null;
    const role = roles.find(r => r.key === current);
    const total = data.permissions.length;
    const have = role ? granted(role.key) : new Set();
    const q = query.trim().toLowerCase();

    const groups = [];
    for (const p of data.permissions) {
      if (q && !(`${p.label} ${p.desc} ${p.group}`).toLowerCase().includes(q)) continue;
      let g = groups.find(x => x.name === p.group);
      if (!g) groups.push(g = { name: p.group, items: [] });
      g.items.push(p);
    }

    root.innerHTML = `
    <div class="pm">
      <p class="pm-lead">Выберите роль и отметьте, что она может. Человек получает права всех своих ролей вместе. Владелец может всё всегда; администратор по умолчанию — всё, кроме закрытого владельцу; у остальных ролей по умолчанию прав нет.</p>
      <div class="pm-layout">
        <nav class="pm-roles" aria-label="Роли">
          ${roles.map(r => {
            const n = granted(r.key).size;
            return `<button class="pm-role${r.key === current ? " on" : ""}" data-pm-role="${esc(r.key)}">
              <span class="pm-role-name">${esc(r.name)}</span>
              <span class="pm-role-count">${n} из ${total}</span>
              <i style="--w:${total ? Math.round(n / total * 100) : 0}%"></i>
            </button>`;
          }).join("")}
        </nav>
        <div class="pm-main">
          ${role ? `
          <div class="pm-head">
            <div>
              <h3>${esc(role.name)}</h3>
              <span>${have.size} из ${total} прав включено</span>
            </div>
            <div class="pm-tools">
              <input class="field-input" id="pm-search" placeholder="Найти право…" value="${esc(query)}">
              <select class="field-input" id="pm-copy" title="Скопировать набор прав с другой роли">
                <option value="">Скопировать с роли…</option>
                ${roles.filter(r => r.key !== role.key).map(r => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join("")}
              </select>
              <button class="btn" id="pm-all">Включить всё</button>
              <button class="btn" id="pm-none">Снять всё</button>
            </div>
          </div>
          ${groups.length ? groups.map(g => {
            const on = g.items.filter(p => have.has(p.key)).length;
            return `
            <section class="pm-group">
              <header>
                <b>${esc(g.name)}</b>
                <span>${on} из ${g.items.length}</span>
                <button class="pm-link" data-pm-group="${esc(g.name)}" data-pm-set="${on === g.items.length ? "off" : "on"}">${on === g.items.length ? "Снять группу" : "Включить группу"}</button>
              </header>
              ${g.items.map(p => `
              <label class="pm-item">
                <span class="pm-item-text"><b>${esc(p.label)}</b><small>${esc(p.desc)}</small></span>
                <span class="ar-switch"><input type="checkbox" data-pm-perm="${esc(p.key)}" ${have.has(p.key) ? "checked" : ""}><i></i></span>
              </label>`).join("")}
            </section>`;
          }).join("") : `<div class="ar-empty">Ничего не найдено.</div>`}
          ` : `<div class="ar-empty">Ролей нет.</div>`}
          <section class="pm-owner">
            <b>Только владелец</b>
            <span>Эти права не выдаются ролям:</span>
            <div>${data.owner_only.map(o => `<em>${esc(o.label)}</em>`).join("")}</div>
          </section>
        </div>
      </div>
    </div>`;

    root.querySelectorAll("[data-pm-role]").forEach(b => b.addEventListener("click", () => { current = b.dataset.pmRole; paint(); }));
    const search = root.querySelector("#pm-search");
    search?.addEventListener("input", e => {
      query = e.target.value;
      const pos = e.target.selectionStart;
      paint();
      const again = root.querySelector("#pm-search");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    root.querySelectorAll("input[data-pm-perm]").forEach(box => box.addEventListener("change", () => {
      const next = granted(role.key);
      if (box.checked) next.add(box.dataset.pmPerm); else next.delete(box.dataset.pmPerm);
      save(role.key, next);
    }));
    root.querySelectorAll("[data-pm-group]").forEach(b => b.addEventListener("click", () => {
      const next = granted(role.key);
      for (const p of data.permissions.filter(x => x.group === b.dataset.pmGroup)) {
        if (b.dataset.pmSet === "on") next.add(p.key); else next.delete(p.key);
      }
      save(role.key, next);
    }));
    root.querySelector("#pm-all")?.addEventListener("click", () => save(role.key, data.permissions.map(p => p.key), "Все права включены."));
    root.querySelector("#pm-none")?.addEventListener("click", () => save(role.key, [], "Права сняты."));
    root.querySelector("#pm-copy")?.addEventListener("change", e => {
      const from = roles.find(r => r.key === e.target.value);
      if (from) save(role.key, granted(from.key), `Права скопированы с роли «${from.name}».`);
    });
  }

  root.innerHTML = `<div class="no-assignee">Загружаю…</div>`;
  try {
    data = await apiGet("/permissions");
    paint();
  } catch (e) {
    root.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}
