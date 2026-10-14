// Роли и специализации участников. Один человек может совмещать несколько
// ролей; переключение сохраняет остальные назначения.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc } from "./utils.js";
import { loadAvatars } from "./profile.js";

let filterRole = null;
let query = "";

function rolesOf(person) {
  return Array.isArray(person.roles) ? person.roles : (person.role ? [person.role] : []);
}

function peopleHtml(data, targetTelegramId = null) {
  const search = query.trim().toLowerCase();
  const people = data.people
    .filter(person => targetTelegramId === null || String(person.telegram_id) === String(targetTelegramId))
    .filter(person => filterRole === null || (filterRole === "" ? rolesOf(person).length === 0 : rolesOf(person).includes(filterRole)))
    .filter(person => !search || `${person.name} ${person.username || ""} ${rolesOf(person).join(" ")}`.toLowerCase().includes(search))
    .sort((a, b) => (rolesOf(a).length ? 0 : 1) - (rolesOf(b).length ? 0 : 1) || a.name.localeCompare(b.name, "ru"));
  if (!people.length) return `<div class="no-assignee" style="padding:12px;">Никого</div>`;
  return people.map(person => {
    const active = new Set(rolesOf(person));
    return `
      <div class="rl-person">
        <span class="avatar-bubble rl-av" data-avatar-for="${person.telegram_id}">${esc(person.name.charAt(0).toUpperCase())}</span>
        <span class="rl-person-name"><b>${esc(person.name)}</b>${person.username ? `<span>@${esc(person.username)}</span>` : ""}</span>
        <div class="rl-role-checks" aria-label="Специализации ${esc(person.name)}">
          ${data.roles.map(role => `<label class="rl-role-check${active.has(role.name) ? " on" : ""}"><input type="checkbox" data-rl-person="${person.telegram_id}" data-rl-role="${esc(role.name)}"${active.has(role.name) ? " checked" : ""}><span>${esc(role.name)}</span></label>`).join("") || `<span class="rl-empty">Сначала создайте роль</span>`}
        </div>
      </div>`;
  }).join("");
}

function rolesHtml(data) {
  const noRole = data.people.filter(person => rolesOf(person).length === 0).length;
  const chip = (value, label, count) => `
    <button type="button" class="rl-role${filterRole === value ? " on" : ""}" data-rl-filter="${value === null ? "*" : esc(value)}">
      <span>${esc(label)}</span><b>${count}</b>
    </button>`;
  return chip(null, "Все люди", data.people.length)
    + data.roles.map(role => chip(role.name, role.name, role.people)).join("")
    + chip("", "Без роли", noRole);
}

export async function openRolesSheet(targetTelegramId = null) {
  query = "";
  filterRole = null;
  const overlay = openSheet(`<h2>${targetTelegramId === null ? "Роли" : "Специализации участника"}</h2>${dialogSkeletonHtml(5)}`, "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("rl-sheet");
  let data;

  function render() {
    const targeted = targetTelegramId !== null;
    sheet.innerHTML = `
      <h2>${targeted ? "Специализации участника" : "Роли команды"}</h2>
      <p class="tn-hint">Можно назначить несколько ролей одному человеку — например, «Даббер» и «Саббер».</p>
      <div class="rl-layout${targeted ? " targeted" : ""}">
        ${targeted ? "" : `<div class="rl-roles">
          <div class="rl-roles-list">${rolesHtml(data)}</div>
          <form class="rl-create" id="rl-create">
            <input id="rl-new" type="text" maxlength="40" placeholder="Новая роль" aria-label="Название новой роли">
            <button class="btn" type="submit">Создать</button>
          </form>
        </div>`}
        <div class="rl-people">
          ${targeted ? "" : `<label class="fd-search rl-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input type="search" id="rl-q" placeholder="Найти человека" value="${esc(query)}" aria-label="Найти человека">
          </label>`}
          <div class="rl-people-list" id="rl-people">${peopleHtml(data, targetTelegramId)}</div>
        </div>
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    loadAvatars(sheet);
    wirePeople();
    sheet.querySelectorAll("[data-rl-filter]").forEach(button => button.addEventListener("click", () => {
      const value = button.dataset.rlFilter;
      filterRole = value === "*" ? null : value;
      render();
    }));
    sheet.querySelector("#rl-q")?.addEventListener("input", event => {
      query = event.target.value;
      sheet.querySelector("#rl-people").innerHTML = peopleHtml(data, targetTelegramId);
      loadAvatars(sheet);
      wirePeople();
    });
    sheet.querySelector("#rl-create")?.addEventListener("submit", async event => {
      event.preventDefault();
      const name = sheet.querySelector("#rl-new").value.trim();
      if (!name) return;
      try {
        data = await apiPost("/roles", { name });
        toast(`Роль «${name}» создана.`);
        render();
      } catch (err) { toast(err.message, "error"); }
    });
  }

  function wirePeople() {
    sheet.querySelectorAll("[data-rl-person]").forEach(input => input.addEventListener("change", async () => {
      input.disabled = true;
      const personId = input.dataset.rlPerson;
      const roleName = input.dataset.rlRole;
      try {
        data = await apiPost("/roles/assign", {
          telegram_id: Number(personId),
          role: roleName,
          enabled: input.checked,
        });
        const person = data.people.find(entry => String(entry.telegram_id) === personId);
        toast(`${person ? person.name : "Участник"}: ${roleName} ${input.checked ? "добавлена" : "снята"}`);
        const scroll = sheet.querySelector("#rl-people").scrollTop;
        render();
        sheet.querySelector("#rl-people").scrollTop = scroll;
      } catch (err) {
        toast(err.message, "error");
        input.disabled = false;
        input.checked = !input.checked;
      }
    }));
  }

  try {
    data = await apiGet("/roles");
    render();
  } catch (err) {
    sheet.innerHTML = `<h2>Роли</h2><div class="no-assignee">Не удалось загрузить: ${esc(err.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  }
}
