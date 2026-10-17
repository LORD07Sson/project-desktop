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

const SAMPLE = "#Младшая_сестра_моего_друга_досаждает #1_сезон #4K #7";

function previewHtml(r) {
  if (!r.ok) return `<div class="bc-warn">${esc(r.error)}</div>`;
  const i = r.info;
  const facts = [i.season ? `${i.season} сезон` : "", i.episode != null ? `${i.episode} серия` : "", i.quality || ""].filter(Boolean).join(" · ");
  const match = r.title_match
    ? `Тайтл студии: <b>${esc(r.title_match.name)}</b> — ${r.title_match.taken ? `взят в работу: заведутся отчёты «${esc(r.episode_label || "")}» на каждую роль, видео станет равкой серии` : "не взят в работу: отчётов не будет, видео приложится к серии"}`
    : "Тайтл студии не найден — серия ляжет только в архив, вам придёт сообщение.";
  const autoNote = r.auto && r.auto.includes("episode") ? " Номер серии подставлен автоматически из «Следующей серии»." : "";
  const waits = r.waits_for ? ` <b>Серия ${r.waits_for} ещё не в архиве — эта серия встанет в очередь и перенесётся после неё.</b>` : "";
  const topic = r.topic.new ? "Тема тайтла будет создана заново, в ней закрепится превью с постером." : `Серия ляжет в существующую тему № ${r.topic.id}.`;
  return `
    <div style="display:grid; gap:10px;">
      <div><span class="bc-hint">Файл в архиве</span><div style="font-family:ui-monospace,Consolas,monospace; font-size:12.5px;">${esc(r.filename)}</div></div>
      <div><span class="bc-hint">Подпись под видео</span>
        <div style="border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:var(--surface-2); line-height:1.5;">${String(r.caption_html).split(String.fromCharCode(10)).join("<br>")}</div></div>
      <div class="bc-hint" style="margin:0;">Разобрано: <b>${esc(i.title)}</b>${facts ? ` · ${esc(facts)}` : ""}<br>${match}<br>${topic}${autoNote}${waits}</div>
    </div>`;
}

export async function mountArchive(root) {
  if (!root) return;
  let sampleCaption = SAMPLE;

  function paint(d) {
    const channels = (d.chats || []).filter(c => c.type === "channel");
    const groups = (d.chats || []).filter(c => c.type !== "channel");
    const target = groups.find(c => String(c.chat_id) === String(d.target));
    root.innerHTML = `
      <p class="bc-hint">Бот следит за каналом-источником: каждое новое видео он переименовывает («[DreamyVoice] Romaji Title TV (7).mp4»), оформляет
        подпись и кладёт в архивную группу — в тему этого тайтла. Тему он создаёт сам и закрепляет в ней превью с постером.
        Тайтл, сезон, качество и серия берутся из хештегов поста: <code>#Название_тайтла #1_сезон #4K #7</code>.<br>Бот видит только новые посты — историю канала Telegram ему не отдаёт. Старые серии <b>перешлите боту в личку</b> (можно пачкой, выделив много постов): он обработает их так же, уже перенесённые пропустит.</p>
      <div class="bc-chat${d.enabled ? " target" : ""}">
        ${pickerHtml("ar-source", "Откуда (канал)", channels, d.source, "Бот должен быть админом канала — тогда он видит каждый новый пост.")}
        <div style="height:10px;"></div>
        ${pickerHtml("ar-target", "Куда (архивная группа)", groups, d.target, "Группа с включёнными «Темами»; у бота права «Управлять темами», «Публиковать» и «Закреплять».")}
        ${d.target && target && target.status && target.status !== "administrator" ? `<div class="bc-warn">Бот в этой группе не админ — темы он не увидит и создать не сможет. Сделайте его админом (управление темами, публикация, закрепление).</div>` : ""}
        ${d.target && target && !target.is_forum ? `<div class="bc-warn">В этой группе не включены темы — серии пойдут в общую ленту.</div>` : ""}
        <label class="bc-feature" style="margin-top:12px;"><input type="checkbox" id="ar-enabled" ${d.enabled ? "checked" : ""}><span>Автоперенос включён</span></label>
        <div class="sheet-actions" style="justify-content:flex-start; margin-top:10px;"><button class="btn primary" id="ar-save">Сохранить</button></div>
        <p class="bc-hint" style="margin:10px 0 0;">Перенесено серий: <b>${d.done || 0}</b>. Одна и та же серия дважды не копируется; о сбоях бот пишет владельцам в личку.</p>
      </div>
      <h4 style="margin:16px 0 8px;">Следующая серия</h4>
      <p class="bc-hint">Достаточно один раз выложить серию с хештегами — бот запомнит тайтл и дальше сам ставит 2, 3, 4… (можно и прописать вручную: так запомненное не сменится на другой тайтл, и оно не забывается). Посты без хештегов (или без номера) он берёт как следующую серию этого тайтла и пишет вам, какой номер поставил.
        Подпись с явными хештегами всегда главнее, а другой тайтл в подписи этот счётчик не трогает.</p>
      <form id="ar-ctx" class="bc-chat" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <input class="field-input" id="ar-ctx-tag" placeholder="Название_тайтла (как в хештеге)" value="${esc(d.context ? d.context.title_tag : "")}" style="flex:3; min-width:200px;">
        <input class="field-input" id="ar-ctx-season" type="number" min="1" placeholder="Сезон" value="${d.context && d.context.season ? d.context.season : ""}" style="width:84px;">
        <input class="field-input" id="ar-ctx-quality" placeholder="4K" value="${esc(d.context && d.context.quality ? d.context.quality : "")}" style="width:84px;">
        <input class="field-input" id="ar-ctx-next" type="number" min="1" placeholder="Серия" value="${d.context ? d.context.next_episode : 1}" style="width:90px;" title="Номер следующей серии">
        <button class="btn primary" type="submit">Сохранить</button>
        ${d.context ? `<button class="btn" type="button" id="ar-ctx-clear">Сбросить</button>` : ""}
        <span class="bc-hint" style="flex-basis:100%; margin:0;">${d.context ? `Сейчас: <b>${esc(d.context.title_tag.split("_").join(" "))}</b>${d.context.season ? ` · ${d.context.season} сезон` : ""}${d.context.quality ? ` · ${esc(d.context.quality)}` : ""} — следующая серия <b>${d.context.next_episode}</b>.${d.context.auto ? " Запомнено ботом по последней серии; забудется, если 3 дня не будет новых. Чтобы закрепить — нажмите «Сохранить»." : ""}` : "Не задано: бот берёт тайтл и номер только из хештегов поста."}</span>
      </form>
      <h4 style="margin:16px 0 8px;">Очередь заливки <small>${d.queue ? d.queue.total : 0}</small> <button class="btn" id="ar-queue-refresh" style="margin-left:8px;">Обновить</button> <button class="btn danger" id="ar-requeue" style="margin-left:6px;" title="Все перенесённые серии зальются заново (например, чтобы получили обложку); старая копия удаляется после успешной заливки новой">Перезалить всё заново</button></h4>
      <p class="bc-hint">${d.queue && d.queue.total
        ? `В очереди <b>${d.queue.total}</b> ${d.queue.total % 10 === 1 && d.queue.total % 100 !== 11 ? "пост" : "постов"}${d.queue.eta_min ? ` — при лимите ${d.queue.limit_mbit} Мбит/с это примерно <b>${d.queue.eta_min >= 90 ? `${(d.queue.eta_min / 60).toFixed(1)} ч` : `${d.queue.eta_min} мин`}</b>` : ""}. Заливка идёт по одной, по порядку номеров постов.`
        : "Очередь пуста — бот ничего не ждёт."}</p>
      ${d.queue && d.queue.items.length ? `<div class="bc-chat" style="max-height:260px; overflow:auto; padding:6px 12px;">${d.queue.items.map(q => `
        <div style="display:flex; gap:10px; align-items:baseline; padding:5px 0; border-top:1px solid var(--line);">
          <span class="bc-hint" style="margin:0; width:58px;">пост ${q.post}</span>
          <b style="flex:1;">${esc(q.title)}</b>
          <span class="bc-hint" style="margin:0;">${q.season ? `${q.season} сезон · ` : ""}${q.episode != null ? `серия ${q.episode}` : "номер по счётчику"}${q.size_mb ? ` · ${q.size_mb} МБ` : ""}${q.active ? " · <b>заливается</b>" : ""}</span>
        </div>`).join("")}${d.queue.more ? `<div class="bc-hint" style="margin:6px 0 0;">…и ещё ${d.queue.more}</div>` : ""}</div>` : ""}
      <h4 style="margin:16px 0 8px;">Очередь по порядку <small>${(d.held || []).length}</small></h4>
      <p class="bc-hint">Серия, пришедшая раньше предыдущей (например, 2-я без 1-й), ждёт здесь и переносится сама, как только предыдущая ляжет в архив. Если предыдущей не будет, отправьте серию без ожидания.</p>
      ${(d.held || []).length ? (d.held || []).map(h => `
        <div class="bc-chat" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <div class="bc-title" style="flex:1; min-width:200px;"><b>${esc(h.title)}</b><span>${h.season} сезон · серия ${h.episode} — ждёт серию ${h.waits_for}${h.forced ? " · отправится в течение 30 секунд" : ""}</span></div>
          <button class="btn" data-hold-release="${esc(h.key)}"${h.forced ? " disabled" : ""}>Отправить без ожидания</button>
          <button class="btn" data-hold-drop="${esc(h.key)}">Убрать</button>
        </div>`).join("") : `<div class="no-assignee">Очередь пуста.</div>`}
      <h4 style="margin:16px 0 8px;">Предпросмотр</h4>
      <p class="bc-hint">Вставьте подпись поста из канала — покажу, как бот её разберёт и что получится в архиве. Ничего не отправляется.</p>
      <div class="bc-chat">
        <textarea class="field-input" id="ar-sample" rows="2" style="width:100%; resize:vertical;">${esc(sampleCaption)}</textarea>
        <div class="sheet-actions" style="justify-content:flex-start; margin-top:8px;"><button class="btn" id="ar-preview">Показать, что получится</button></div>
        <div id="ar-preview-out" style="margin-top:10px;"></div>
      </div>
      <h4 style="margin:16px 0 8px;">Темы тайтлов <small>${(d.known_topics || []).length}</small> <button class="btn" id="ar-refresh" style="margin-left:8px;">Обновить</button></h4>
      <p class="bc-hint">Создайте тему в архивной группе — она появится здесь сама (бот должен быть админом группы), и серия с похожим названием ляжет в неё.
        Для тем, созданных до подключения бота, укажите номер ниже.</p>
      ${(d.known_topics || []).length ? (d.known_topics || []).map(t => {
        const bound = (t.tags || []).length > 0;
        const raw = bound ? t.tags[0] : (t.suggest || "");
        const tag = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";  // бот хранит хештег строчными — показываем с заглавной
        return `
        <div class="bc-chat" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;" data-topic-row="${t.topic_id}">
          <label class="bc-feature" style="margin:0;" title="Включено — серии этого тайтла ложатся в эту тему"><input type="checkbox" data-topic-use="${t.topic_id}" ${bound ? "checked" : ""}><span></span></label>
          <div class="bc-title" style="flex:1; min-width:160px;">
            <b>${esc(t.name)}</b>
            <span>тема № ${t.topic_id}${bound ? " · подключена" : " · отметьте галочку, чтобы бот клал сюда серии"}</span>
          </div>
          <input class="field-input" data-topic-tag="${t.topic_id}" value="${esc(tag)}" placeholder="Название_тайтла (как в хештеге)" style="flex:1; min-width:180px;" title="Хештег тайтла — по нему бот находит тему">
          <button class="btn" data-forget-topic="${t.topic_id}" title="Убрать из списка и снять привязки (сама тема в Telegram останется)">Убрать</button>
        </div>`;
      }).join("") : `<div class="no-assignee">Тем пока нет — они появятся, когда вы создадите тему в группе (бот должен быть её админом) или придёт первая серия.</div>`}
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
    root.querySelectorAll("[data-hold-release]").forEach(b => b.addEventListener("click", () => apply("/archive/hold/release", { key: b.dataset.holdRelease }, "Серия будет отправлена.")));
    root.querySelectorAll("[data-hold-drop]").forEach(b => b.addEventListener("click", () => apply("/archive/hold/drop", { key: b.dataset.holdDrop }, "Убрано из очереди.")));
    root.querySelector("#ar-refresh")?.addEventListener("click", load);
    root.querySelector("#ar-queue-refresh")?.addEventListener("click", load);
    root.querySelector("#ar-requeue")?.addEventListener("click", async () => {
      if (!confirm("Вернуть в очередь ВСЕ перенесённые серии и залить заново? Старая копия каждой серии удаляется только после того, как новая успешно залита. Заливка идёт по одной с лимитом сети — на сотню серий уйдёт несколько часов.")) return;
      try { await apiPost("/archive/requeue", {}); toast("Серии возвращены в очередь — бот начнёт в течение 30 секунд.", "success"); setTimeout(load, 4000); }
      catch (e) { toast(e.message, "error"); }
    });
    root.querySelectorAll("[data-topic-use]").forEach(box => box.addEventListener("change", () => {
      const id = Number(box.dataset.topicUse);
      const input = root.querySelector(`[data-topic-tag="${id}"]`);
      const topic = (d.known_topics || []).find(t => t.topic_id === id);
      if (box.checked) {
        if (!input.value.trim()) { box.checked = false; toast("Впишите название тайтла как в хештеге.", "error"); return; }
        apply("/archive/topic", { title_tag: input.value, topic_id: id }, "Тема подключена.");
      } else {
        (async () => {
          try {
            let last = d;
            for (const tag of (topic ? topic.tags : [])) last = await apiPost("/archive/topic/delete", { title_tag: tag });
            paint(last);
            toast("Тема отключена.", "success");
          } catch (e) { toast(e.message, "error"); await load(); }
        })();
      }
    }));
    root.querySelectorAll("[data-forget-topic]").forEach(b => b.addEventListener("click", () => apply("/archive/topic/forget", { topic_id: Number(b.dataset.forgetTopic) }, "Тема убрана из списка.")));
    root.querySelector("#ar-ctx").addEventListener("submit", e => {
      e.preventDefault();
      apply("/archive/context", {
        title_tag: root.querySelector("#ar-ctx-tag").value,
        season: root.querySelector("#ar-ctx-season").value,
        quality: root.querySelector("#ar-ctx-quality").value,
        next_episode: root.querySelector("#ar-ctx-next").value,
      }, "Сохранено.");
    });
    root.querySelector("#ar-ctx-clear")?.addEventListener("click", () => apply("/archive/context", { clear: true }, "Сброшено."));
    const out = root.querySelector("#ar-preview-out");
    const runPreview = async () => {
      sampleCaption = root.querySelector("#ar-sample").value;
      out.innerHTML = `<div class="no-assignee">Разбираю…</div>`;
      try {
        const r = await apiPost("/archive/preview", { caption: sampleCaption });
        out.innerHTML = previewHtml(r);
        if (r.ok) {
          out.insertAdjacentHTML("beforeend", `
            <form id="ar-name" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px;">
              <input class="field-input" id="ar-name-input" value="${esc(r.file_title || "")}" style="flex:1; min-width:240px;" placeholder="Название в имени файла (ромадзи или английское)">
              <button class="btn" type="submit">Своё название для тайтла</button>
              ${["romaji", "english"].filter(k => r.name_options && r.name_options[k]).map(k => `<button class="btn" type="button" data-name-opt="${esc(r.name_options[k])}" title="Подставить в поле — потом нажмите «Своё название для тайтла»">${k === "romaji" ? "Ромадзи" : "English"}: ${esc(r.name_options[k])}</button>`).join("")}
              <span class="bc-hint" style="flex-basis:100%; margin:0;">Бот сам берёт латинское название из Shikimori/AniList («[DreamyVoice] Название TV (1)»). Если подобрал не то — впишите нужное, оно запомнится для этого тайтла. Пусто — снова автоматически.</span>
            </form>`);
          out.querySelectorAll("[data-name-opt]").forEach(btn => btn.addEventListener("click", () => {
            out.querySelector("#ar-name-input").value = `${btn.dataset.nameOpt} ${(r.file_title || "").match(/(TV|Movie|OVA|ONA|Special)$/i)?.[1] || "TV"}`;
          }));
          out.querySelector("#ar-name").addEventListener("submit", async e => {
            e.preventDefault();
            try {
              await apiPost("/archive/name", { title_tag: r.info.title_tag, name: out.querySelector("#ar-name-input").value });
              toast("Сохранено.", "success");
              runPreview();
            } catch (err) { toast(err.message, "error"); }
          });
        }
      } catch (e) { out.innerHTML = `<div class="bc-warn">${esc(e.message)}</div>`; }
    };
    root.querySelector("#ar-preview").addEventListener("click", runPreview);
    runPreview();
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
