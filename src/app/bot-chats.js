// «Чаты бота» — где состоит бот и что в каждом делает (только владелец).
// Сервер: /api/bot-chats (список; заодно уточняет названия у Telegram),
// POST /api/bot-chats/{id} {features?, mention?, mention_thread_id?},
// POST /api/bot-chats/{id}/forget. Бот сам заносит группы в список —
// здесь только включаем/выключаем функции и выбираем рабочий чат для
// упоминаний (раньше — число в config.py на сервере).

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const TYPE_LABEL = { group: "группа", supergroup: "группа", channel: "канал" };

function chatHtml(c, features) {
  const off = !c.active;
  return `
    <div class="bc-chat${off ? " off" : ""}${c.mention ? " target" : ""}" data-chat="${c.chat_id}">
      <div class="bc-head">
        <div class="bc-title">
          <b>${esc(c.title)}</b>
          <span>${esc(TYPE_LABEL[c.type] || c.type || "чат")}${c.is_forum ? " · с темами" : ""}${c.username ? ` · @${esc(c.username)}` : ""}</span>
        </div>
        ${off ? `<span class="bc-badge gone">бот удалён</span><button class="btn" data-forget="${c.chat_id}">Убрать из списка</button>` : `<span class="bc-badge">активен</span>`}
      </div>
      ${off ? "" : `
      <div class="bc-features">
        ${features.map(f => `<label class="bc-feature"><input type="checkbox" data-feature="${f.key}" ${c.features[f.key] ? "checked" : ""}><span>${esc(f.label)}</span></label>`).join("")}
      </div>
      <div class="bc-mention">
        <label class="bc-feature"><input type="radio" name="bc-mention" data-mention ${c.mention ? "checked" : ""}><span>📣 Сюда — упоминания по расписанию</span></label>
        ${c.mention && c.is_forum ? `<label class="bc-thread">тема №<input type="number" min="0" data-thread value="${c.mention_thread_id || ""}" placeholder="общая"></label>` : ""}
      </div>`}
    </div>`;
}

// Отдельный раздел Настроек («Чаты бота», только владелец) — список
// рисуется прямо в нём, без окна поверх Настроек.
export async function mountBotChats(root) {
  if (!root) return;

  function paint(d) {
    const chats = d.chats || [];
    root.innerHTML = `
      <p class="bc-hint">Группы и каналы, где состоит бот. Добавьте бота в группу и напишите там любое сообщение — она появится здесь. В новой группе всё включено.</p>
      ${chats.some(c => c.active) && !chats.some(c => c.mention && c.active) ? `<div class="bc-warn">Рабочий чат для упоминаний не выбран — рассылка по расписанию сейчас никуда не уходит.</div>` : ""}
      ${chats.length ? chats.map(c => chatHtml(c, d.features || [])).join("") : `<div class="no-assignee">Бот пока ни в одной группе.</div>`}`;

    const save = async (chatId, body) => {
      try {
        paint(await apiPost(`/bot-chats/${chatId}`, body));
        toast("Сохранено.", "success");
      } catch (e) { toast(e.message, "error"); await load(); }
    };
    root.querySelectorAll(".bc-chat").forEach(card => {
      const chatId = card.dataset.chat;
      card.querySelectorAll("[data-feature]").forEach(cb => cb.addEventListener("change", () => {
        const features = {};
        card.querySelectorAll("[data-feature]").forEach(x => { features[x.dataset.feature] = x.checked; });
        save(chatId, { features });
      }));
      card.querySelector("[data-mention]")?.addEventListener("change", () => save(chatId, { mention: true }));
      card.querySelector("[data-thread]")?.addEventListener("change", e => save(chatId, { mention_thread_id: e.target.value.trim() || 0 }));
    });
    root.querySelectorAll("[data-forget]").forEach(btn => btn.addEventListener("click", async () => {
      try { paint(await apiPost(`/bot-chats/${btn.dataset.forget}/forget`, {})); } catch (e) { toast(e.message, "error"); }
    }));
  }

  async function load() {
    root.innerHTML = `<div class="no-assignee">Загружаю…</div>`;
    try {
      paint(await apiGet("/bot-chats"));
    } catch (e) {
      root.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  await load();
}
