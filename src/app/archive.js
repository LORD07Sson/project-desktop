// «Архив серий» — перенос видео из канала в архивную группу с темами (только владелец).
// Сервер: GET /api/archive (настройки, темы и чаты, где состоит бот), POST /api/archive {source?, target?, enabled?},
// POST /api/archive/topic {title_tag, topic_id}, POST /api/archive/topic/delete {title_tag}.
// Сам перенос делает бот (archive_sync.py): берёт тайтл, сезон, качество и серию из хештегов поста, заливает видео
// под новым именем и подписью, создаёт тему на каждый тайтл и закрепляет в ней превью.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const chatOption = (c, selected) =>
  `<option value="${c.chat_id}"${String(c.chat_id) === String(selected) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""} (${c.chat_id})</option>`;

function pickerHtml(id, label, chats, selected, hint) {
  const known = chats.some(c => String(c.chat_id) === String(selected));
  return `
    <label class="field-label" for="${id}">${label}</label>
    <select id="${id}" class="field-input">
      <option value=""${selected ? "" : " selected"}>— не выбрано —</option>
      ${selected && !known ? `<option value="${esc(selected)}" selected>ID ${esc(selected)} (бота нет в списке)</option>` : ""}
      ${chats.map(c => chatOption(c, selected)).join("")}
    </select>
    <p class="bc-hint" style="margin-top:4px;">${hint}</p>`;
}

export async function mountArchive(root) {
  if (!root) return;

  function paint(d) {
    const channels = (d.chats || []).filter(c => c.type === "channel");
    const groups = (d.chats || []).filter(c => c.type !== "channel");
    const target = groups.find(c => String(c.chat_id) === String(d.target));
    root.innerHTML = `
      <p class="bc-hint">Бот следит за каналом-источником: каждое новое видео он переименовывает («Название S01E07 [4K].mp4»), оформляет
        подпись и кладёт в архивную группу — в тему этого тайтла. Тему он создаёт сам и закрепляет в ней превью с постером.
        Тайтл, сезон, качество и серия берутся из хештегов поста: <code>#Название_тайтла #1_сезон #4K #7</code>.<br>Бот видит только новые посты — историю канала Telegram ему не отдаёт. Старые серии <b>перешлите боту в личку</b> (можно пачкой, выделив много постов): он обработает их так же, уже перенесённые пропустит.</p>
      <div class="bc-chat${d.enabled ? " target" : ""}">
        ${pickerHtml("ar-source", "Откуда (канал)", channels, d.source, "Бот должен быть админом канала — тогда он видит каждый новый пост.")}
        <div style="height:10px;"></div>
        ${pickerHtml("ar-target", "Куда (архивная группа)", groups, d.target, "Группа с включёнными «Темами»; у бота права «Управлять темами», «Публиковать» и «Закреплять».")}
        ${d.target && target && !target.is_forum ? `<div class="bc-warn">В этой группе не включены темы — серии пойдут в общую ленту.</div>` : ""}
        <label class="bc-feature" style="margin-top:12px;"><input type="checkbox" id="ar-enabled" ${d.enabled ? "checked" : ""}><span>Автоперенос включён</span></label>
        <div class="sheet-actions" style="justify-content:flex-start; margin-top:10px;"><button class="btn primary" id="ar-save">Сохранить</button></div>
        <p class="bc-hint" style="margin:10px 0 0;">Перенесено серий: <b>${d.done || 0}</b>. Одна и та же серия дважды не копируется; о сбоях бот пишет владельцам в личку.</p>
      </div>
      <h4 style="margin:16px 0 8px;">Темы тайтлов <small>${(d.known_topics || []).length}</small></h4>
      <p class="bc-hint">Создайте тему в архивной группе — она появится здесь сама (бот должен быть админом группы), и серия с похожим названием ляжет в неё.
        Для тем, созданных до подключения бота, укажите номер ниже.</p>
      ${(d.known_topics || []).length ? (d.known_topics || []).map(t => `
        <div class="bc-chat" style="display:flex; align-items:center; gap:10px;">
          <div class="bc-title" style="flex:1;">
            <b>${esc(t.name)}</b>
            <span>тема № ${t.topic_id} · ${(t.tags || []).length ? (t.tags || []).map(x => `#${esc(x)}`).join(" ") : "ждёт серию — привяжется по названию"}</span>
          </div>
          <button class="btn" data-forget-topic="${t.topic_id}" title="Убрать из списка и снять привязки (сама тема в Telegram останется)">Убрать</button>
        </div>`).join("") : `<div class="no-assignee">Тем пока нет — они появятся, когда вы создадите тему в группе или придёт первая серия.</div>`}
      <form id="ar-bind" class="bc-chat" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <input class="field-input" id="ar-tag" placeholder="Название_тайтла (как в хештеге)" style="flex:2; min-width:180px;">
        <input class="field-input" id="ar-topic" type="number" min="1" placeholder="№ темы" style="flex:1; min-width:90px;">
        <button class="btn" type="submit">Привязать к существующей теме</button>
      </form>`;

    const apply = async (path, body, okText) => {
      try {
        paint(await apiPost(path, body));
        if (okText) toast(okText, "success");
      } catch (e) { toast(e.message, "error"); await load(); }
    };
    root.querySelector("#ar-save").addEventListener("click", () => apply("/archive", {
      source: root.querySelector("#ar-source").value,
      target: root.querySelector("#ar-target").value,
      enabled: root.querySelector("#ar-enabled").checked,
    }, "Сохранено."));
    root.querySelectorAll("[data-forget-topic]").forEach(b => b.addEventListener("click", () => apply("/archive/topic/forget", { topic_id: Number(b.dataset.forgetTopic) }, "Тема убрана из списка.")));
    root.querySelector("#ar-bind").addEventListener("submit", e => {
      e.preventDefault();
      apply("/archive/topic", { title_tag: root.querySelector("#ar-tag").value, topic_id: root.querySelector("#ar-topic").value }, "Тема привязана.");
    });
  }

  async function load() {
    root.innerHTML = `<div class="no-assignee">Загружаю…</div>`;
    try {
      paint(await apiGet("/archive"));
    } catch (e) {
      root.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  await load();
}
