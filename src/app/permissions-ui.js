// «Права ролей» — выбираем роль слева, справа включаем нужные права переключателями (только владелец).
// Сервер: GET/POST /api/permissions ({role, permissions: [...]} — весь набор прав роли).
// Каждое изменение сохраняется сразу; права проверяет сервер на каждом запросе, клиент лишь скрывает недоступное.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

// Что человек с ролью увидит в программе — та же логика, что у perm-visibility.js/tabs.js и проверок сервера.
const ALWAYS = "always";
const PREVIEW = [
  ["Вкладки", [
    ["Очередь", ALWAYS], ["Чат", ALWAYS], ["Команда", ALWAYS], ["Профиль", ALWAYS],
    ["Лента", "reports.feed"], ["Доска", "reports.board"], ["Обзор", "reports.overview"], ["Список", "reports.list"],
    ["Календарь", "reports.calendar"], ["Аналитика", "reports.analytics"], ["Тайтлы", "titles.view"], ["Релизы (Nyaa)", "nyaa.view"],
  ]],
  ["В отчётах", [
    ["Открывать любые отчёты", ["reports.feed", "reports.board", "reports.overview", "reports.list", "reports.calendar", "reports.analytics", "reports.manage"]],
    ["Свои задачи и файлы к ним", ALWAYS],
    ["Создавать отчёты", "reports.create"], ["Менять статус, сроки, исполнителей", "reports.manage"],
    ["Загружать и удалять файлы", "reports.files"], ["Собирать финал", "reports.assemble"],
    ["Удалять отчёты", "reports.delete"], ["Пост в канал", "posts.manage"],
  ]],
  ["Тайтлы и команда", [
    ["Создавать тайтлы", "titles.create"], ["Править тайтлы", "titles.edit"], ["Менять состав", "titles.crew"],
    ["Брать в работу", "titles.work"], ["Удалять тайтлы", "titles.delete"], ["Заявки на доступ", "access.requests"],
    ["Роли людей", "roles.manage"], ["Профили людей", "people.view"], ["Тикеты", "tickets.manage"],
    ["Объявление", "notice.manage"], ["Дни рождения", "birthdays.manage"], ["Аварийный режим", "lockdown"],
  ]],
  ["В сообщениях", [
    ["Личные переписки и общий чат", ALWAYS], ["Создавать каналы", "chat.channels"],
    ["Закреплять в общих беседах", "chat.pin"], ["Удалять чужие сообщения", "chat.moderate"],
  ]],
];
const allows = (need, have) => need === ALWAYS || (Array.isArray(need) ? need.some(k => have.has(k)) : have.has(need));

// Права группы «Тайтлы» без «Видеть тайтлы» бессмысленны: сервер не отдаст список, и править будет нечего.
const TITLE_VIEW = "titles.view";
function withDependencies(next, changedKey, turnedOn) {
  const titleOps = ["titles.create", "titles.edit", "titles.crew", "titles.work", "titles.delete"];
  if (turnedOn && titleOps.includes(changedKey)) next.add(TITLE_VIEW);
  if (!turnedOn && changedKey === TITLE_VIEW) titleOps.forEach(k => next.delete(k));
  return next;
}

export async function mountPermissions(root) {
  if (!root) return;
  let data = null;
  let current = null;   // ключ выбранной роли
  let query = "";
  let creating = false; // открыта форма «Новая роль»
  let before = null;     // набор прав до последней правки — подсветить, что изменилось в превью
  let savedAt = 0;

  const granted = key => new Set(data.grants[key] || []);

  async function save(role, perms, okText) {
    before = granted(role);
    try {
      data = await apiPost("/permissions", { role, permissions: [...perms] });
      savedAt = Date.now();
      // Одиночная галочка — тихая отметка «сохранено» в шапке; всплывашка только для массовых действий.
      if (okText) toast(okText, "success");
    } catch (e) {
      toast(e.message, "error");
    }
    paint();
    before = null;
  }

  function previewHtml(have) {
    return `<section class="pm-preview" aria-label="Что увидит человек с этой ролью">
      <header><b>Что увидит человек с этой ролью</b><span>обновляется сразу, у людей — в течение минуты</span></header>
      ${PREVIEW.map(([title, rows]) => `
        <div class="pm-pv-group"><small>${esc(title)}</small><div class="pm-pv-chips">
          ${rows.map(([label, need]) => {
            const on = allows(need, have);
            const was = before ? allows(need, before) : on;
            return `<span class="pm-pv${on ? " on" : ""}${was !== on ? " chg" : ""}" title="${on ? "видно" : "скрыто"}">
              <svg viewBox="0 0 24 24" aria-hidden="true">${on ? '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>' : '<path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/>'}</svg>${esc(label)}</span>`;
          }).join("")}
        </div></div>`).join("")}
    </section>`;
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
          ${creating ? `
          <form class="pm-new" id="pm-new-form">
            <input class="field-input" id="pm-new-name" maxlength="40" placeholder="Название роли" autocomplete="off">
            <select class="field-input" id="pm-new-copy" title="Взять за основу права другой роли">
              <option value="">Без прав (настрою сам)</option>
              ${roles.map(r => `<option value="${esc(r.key)}">Права как у «${esc(r.name)}»</option>`).join("")}
            </select>
            <div class="pm-new-actions"><button type="submit" class="btn primary">Создать роль</button><button type="button" class="btn" id="pm-new-cancel">Отмена</button></div>
            <small>Не используйте «,» и «:». Роль потом можно выдать людям в Команда → Роли.</small>
          </form>` : `<button type="button" class="pm-role pm-add" id="pm-new-open">+ Новая роль</button>`}
        </nav>
        <div class="pm-main">
          ${role ? `
          <div class="pm-head">
            <div>
              <h3>${esc(role.name)}</h3>
              <span>${have.size} из ${total} прав включено${role.kind === "role" ? ` · людей с ролью: ${role.members || 0}` : ""}${Date.now() - savedAt < 4000 ? ` · <em class="pm-saved">сохранено ✓</em>` : ""}</span>
            </div>
            <div class="pm-tools">
              <input class="field-input" id="pm-search" placeholder="Найти право…" value="${esc(query)}">
              <select class="field-input" id="pm-copy" title="Скопировать набор прав с другой роли">
                <option value="">Скопировать с роли…</option>
                ${roles.filter(r => r.key !== role.key).map(r => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join("")}
              </select>
              <button class="btn" id="pm-all">Включить всё</button>
              <button class="btn" id="pm-none">Снять всё</button>
              ${role.kind === "role" ? `<button class="btn" id="pm-delete" title="${role.members ? `Роль назначена людям: ${role.members}` : "Удалить роль"}">Удалить роль</button>` : ""}
            </div>
          </div>
          ${previewHtml(have)}
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
      const size = next.size;
      withDependencies(next, box.dataset.pmPerm, box.checked);
      save(role.key, next, next.size !== size
        ? (box.checked ? "Вместе с ним включено «Видеть тайтлы» — без него остальные права тайтлов не работают." : "Сняты и остальные права тайтлов — без «Видеть тайтлы» они не работают.")
        : null);
    }));
    root.querySelectorAll("[data-pm-group]").forEach(b => b.addEventListener("click", () => {
      const next = granted(role.key);
      for (const p of data.permissions.filter(x => x.group === b.dataset.pmGroup)) {
        if (b.dataset.pmSet === "on") next.add(p.key); else next.delete(p.key);
      }
      save(role.key, next);
    }));
    root.querySelector("#pm-new-open")?.addEventListener("click", () => { creating = true; paint(); root.querySelector("#pm-new-name")?.focus(); });
    root.querySelector("#pm-new-cancel")?.addEventListener("click", () => { creating = false; paint(); });
    root.querySelector("#pm-new-form")?.addEventListener("submit", async e => {
      e.preventDefault();
      const name = root.querySelector("#pm-new-name").value.trim();
      if (!name) { toast("Введите название роли.", "error"); return; }
      try {
        data = await apiPost("/permissions/role", { name, copy_from: root.querySelector("#pm-new-copy").value || "" });
        creating = false;
        const made = data.roles.find(r => r.name === name);
        if (made) current = made.key;
        toast(`Роль «${name}» создана — отметьте её права.`, "success");
      } catch (err) { toast(err.message, "error"); }
      paint();
    });
    root.querySelector("#pm-delete")?.addEventListener("click", async () => {
      if (role.members) { toast(`Роль «${role.name}» назначена людям (${role.members}) — сначала снимите её в Команда → Роли.`, "error"); return; }
      if (!window.confirm(`Удалить роль «${role.name}»? Её права тоже пропадут.`)) return;
      try {
        data = await apiPost("/permissions/role/delete", { name: role.name });
        toast(`Роль «${role.name}» удалена.`, "success");
      } catch (err) { toast(err.message, "error"); }
      paint();
    });
    root.querySelector("#pm-all")?.addEventListener("click", () => confirm(`Включить роли «${role.name}» все права сразу?`) && save(role.key, data.permissions.map(p => p.key), "Все права включены."));
    root.querySelector("#pm-none")?.addEventListener("click", () => confirm(`Снять у роли «${role.name}» все права?`) && save(role.key, [], "Права сняты."));
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
