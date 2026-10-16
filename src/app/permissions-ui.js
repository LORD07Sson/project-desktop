// «Права ролей» — матрица «роль × право» (только владелец). Сервер: GET/POST /api/permissions.
// Каждая галочка сохраняется сразу; права проверяет сервер на каждом запросе, клиент лишь скрывает недоступное.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

export async function mountPermissions(root) {
  if (!root) return;
  let data = null;

  const cell = (role, perm) => {
    const on = (data.grants[role.key] || []).includes(perm.key);
    return `<td><input type="checkbox" data-perm="${esc(perm.key)}" data-role="${esc(role.key)}" ${on ? "checked" : ""} aria-label="${esc(role.name)}: ${esc(perm.label)}"></td>`;
  };

  function paint() {
    const groups = [];
    for (const p of data.permissions) {
      let g = groups.find(x => x.name === p.group);
      if (!g) groups.push(g = { name: p.group, items: [] });
      g.items.push(p);
    }
    root.innerHTML = `
      <p class="bc-hint">Отметьте, что может каждая роль. Человек получает права всех своих ролей вместе. Владелец может всё всегда;
        администратор по умолчанию — всё, кроме закрытого владельцу; у остальных ролей по умолчанию прав нет.</p>
      <div class="perm-wrap"><table class="perm-table">
        <thead><tr><th>Право</th>${data.roles.map(r => `<th title="${esc(r.name)}"><span>${esc(r.name)}</span></th>`).join("")}</tr></thead>
        <tbody>
          ${groups.map(g => `
            <tr class="perm-group"><td colspan="${data.roles.length + 1}">${esc(g.name)}</td></tr>
            ${g.items.map(p => `<tr><td class="perm-name"><b>${esc(p.label)}</b><span>${esc(p.desc)}</span></td>${data.roles.map(r => cell(r, p)).join("")}</tr>`).join("")}`).join("")}
        </tbody>
      </table></div>
      <h4 style="margin:16px 0 6px;">Только владелец</h4>
      <p class="bc-hint">Эти права не выдаются ролям: ${data.owner_only.map(o => `<b>${esc(o.label)}</b>`).join(", ")}.</p>`;

    root.querySelectorAll("input[data-perm]").forEach(box => box.addEventListener("change", async () => {
      const role = box.dataset.role;
      const current = new Set(data.grants[role] || []);
      if (box.checked) current.add(box.dataset.perm); else current.delete(box.dataset.perm);
      box.disabled = true;
      try {
        data = await apiPost("/permissions", { role, permissions: [...current] });
        toast("Сохранено.", "success");
      } catch (e) {
        toast(e.message, "error");
        box.checked = !box.checked;
      }
      box.disabled = false;
    }));
  }

  root.innerHTML = `<div class="no-assignee">Загружаю…</div>`;
  try {
    data = await apiGet("/permissions");
    paint();
  } catch (e) {
    root.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}
