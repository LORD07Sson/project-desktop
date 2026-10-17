// «Архив серий» — перенос видео из канала в архивную группу с темами (только владелец).
// Сервер: GET /api/archive (настройки, темы и чаты, где состоит бот), POST /api/archive {source?, target?, enabled?, name_pref?},
// POST /api/archive/topic {title_tag, topic_id}, POST /api/archive/topic/delete {title_tag}.
// Сам перенос делает бот (archive_sync.py): берёт тайтл, сезон, качество и серию из хештегов поста, заливает видео
// под новым именем и подписью, создаёт тему на каждый тайтл и закрепляет в ней превью.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const NL = String.fromCharCode(10);

const chatOption = (c, selected) =>
  `<option value="${c.chat_id}"${String(c.chat_id) === String(selected) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""} (${c.chat_id})</option>`;

function pickerHtml(id, label, chats, selected, hint) {
  const known = chats.some(c => String(c.chat_id) === String(selected));
  return `
    <label class="ar-label" for="${id}">${label}</label>
    <select id="${id}" class="field-input ar-select">
      <option value=""${selected ? "" : " selected"}>— не выбрано —</option>
      ${selected && !known ? `<option value="${esc(selected)}" selected>ID ${esc(selected)} (бота нет в списке)</option>` : ""}
      ${chats.map(c => chatOption(c, selected)).join("")}
    </select>
    <p class="ar-hint">${hint}</p>`;
}

const SAMPLE = "#Младшая_сестра_моего_друга_досаждает #1_сезон #4K #7";

const ICON = {
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  topics: '<path d="M4 5h16v11H9l-5 4z"/>',
  next: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

function previewHtml(r) {
  if (!r.ok) return `<div class="bc-warn">${esc(r.error)}</div>`;
  const i = r.info;
  const facts = [i.season ? `${i.season} сезон` : "", i.episode != null ? `${i.episode} серия` : "", i.quality || ""].filter(Boolean).join(" · ");
  const match = r.title_match
    ? `Тайтл студии: <b>${esc(r.title_match.name)}</b> — ${r.title_match.taken ? `взят в работу: заведутся отчёты «${esc(r.episode_label || "")}» на каждую роль, видео станет равкой серии` : "не взят в работу: отчётов не будет, видео приложится к серии"}`
    : "Тайтл студии не найден — серия ляжет только в архив.";
  const autoNote = r.auto && r.auto.includes("episode") ? " Номер серии подставлен автоматически из «Следующей серии»." : "";
  const waits = r.waits_for ? ` <b>Серия ${r.waits_for} ещё не в архиве — эта серия встанет в очередь и перенесётся после неё.</b>` : "";
  const topic = r.topic.new ? "Тема тайтла будет создана заново, в ней закрепится превью с постером." : `Серия ляжет в существующую тему № ${r.topic.id}.`;
  return `
    <div class="ar-result">
      <div><span class="ar-label">Файл в архиве</span><div class="ar-mono">${esc(r.filename)}</div></div>
      <div><span class="ar-label">Подпись под видео</span>
        <div class="ar-caption">${String(r.caption_html).split(NL).join("<br>")}</div></div>
      <p class="ar-hint" style="margin:0;">Разобрано: <b>${esc(i.title)}</b>${facts ? ` · ${esc(facts)}` : ""}<br>${match}<br>${topic}${autoNote}${waits}</p>
    </div>`;
}

const plural = (n, one, many) => (n % 10 === 1 && n % 100 !== 11 ? one : many);

export async function mountArchive(root) {
  if (!root) return;
  let sampleCaption = SAMPLE;
  let tab = "settings";

  function paint(d) {
    const channels = (d.chats || []).filter(c => c.type === "channel");
    const groups = (d.chats || []).filter(c => c.type !== "channel");
    const target = groups.find(c => String(c.chat_id) === String(d.target));
    const source = channels.find(c => String(c.chat_id) === String(d.source));
    const queueTotal = d.queue ? d.queue.total : 0;
    const held = d.held || [];
    const topics = d.known_topics || [];
    const eta = d.queue && d.queue.eta_min ? (d.queue.eta_min >= 90 ? `${(d.queue.eta_min / 60).toFixed(1)} ч` : `${d.queue.eta_min} мин`) : "";

    root.innerHTML = `
    <div class="ar">
      <div class="ar-hero ${d.enabled ? "on" : ""}">
        <div class="ar-hero-top">
          <div class="ar-hero-text">
            <h3>Архив серий</h3>
            <p>${source ? esc(source.title) : "Источник не выбран"} <span class="ar-arrow">→</span> ${target ? esc(target.title) : "архив не выбран"}</p>
          </div>
          <label class="ar-switch" title="Автоперенос новых серий"><input type="checkbox" id="ar-enabled" ${d.enabled ? "checked" : ""}><i></i><span>${d.enabled ? "Включён" : "Выключен"}</span></label>
        </div>
        <div class="ar-stats">
          <div><b>${d.done || 0}</b><span>перенесено</span></div>
          <div><b>${queueTotal}</b><span>в очереди</span></div>
          <div><b>${held.length}</b><span>ждут предыдущую</span></div>
          <div><b>${topics.length}</b><span>${plural(topics.length, "тема", "тем")}</span></div>
        </div>
      </div>

      <div class="ar-tabs" role="tablist">
        <button data-ar-tab="settings">${icon("settings")}Настройки</button>
        <button data-ar-tab="queue">${icon("queue")}Очередь${queueTotal + held.length ? `<em>${queueTotal + held.length}</em>` : ""}</button>
        <button data-ar-tab="topics">${icon("topics")}Темы${topics.length ? `<em>${topics.length}</em>` : ""}</button>
        <button data-ar-tab="next">${icon("next")}Следующая серия</button>
        <button data-ar-tab="check">${icon("check")}Проверка подписи</button>
      </div>

      <section data-ar-pane="settings" hidden>
        <div class="ar-grid">
          <div class="ar-card">
            <h4>Откуда и куда</h4>
            ${pickerHtml("ar-source", "Канал-источник", channels, d.source, "Бот должен быть админом канала — тогда он видит каждый новый пост.")}
            ${pickerHtml("ar-target", "Архивная группа", groups, d.target, "Группа с включёнными «Темами»; у бота права «Управлять темами», «Публиковать» и «Закреплять».")}
            ${d.target && target && target.status && target.status !== "administrator" ? `<div class="bc-warn">Бот в этой группе не админ — темы он не увидит и создать не сможет.</div>` : ""}
            ${d.target && target && !target.is_forum ? `<div class="bc-warn">В этой группе не включены темы — серии пойдут в общую ленту.</div>` : ""}
          </div>
          <div class="ar-card">
            <h4>Название файла и темы</h4>
            <span class="ar-label">Латинское название</span>
            <div class="ar-seg" id="ar-name-pref">
              <button data-name-pref="romaji" class="${d.name_pref !== "english" ? "on" : ""}">Ромадзи<small>Kimi ni Todoke</small></button>
              <button data-name-pref="english" class="${d.name_pref === "english" ? "on" : ""}">Английское<small>Your Name</small></button>
            </div>
            <p class="ar-hint">Берётся из Shikimori и AniList автоматически; если английского нет — остаётся ромадзи. Для отдельного тайтла название можно задать вручную во вкладке «Проверка подписи».</p>
            <details class="ar-how"><summary>Как это работает</summary>
              <p class="ar-hint">Каждое новое видео бот переименовывает («[DreamyVoice] Romaji Title TV (7).mp4»), оформляет подпись и кладёт в тему тайтла. Тему он создаёт сам и закрепляет в ней превью с постером. Тайтл, сезон, качество и серия берутся из хештегов: <code>#Название_тайтла #1_сезон #4K #7</code>.<br>Историю канала Telegram боту не отдаёт: старые серии <b>перешлите боту в личку</b> (можно пачкой) — уже перенесённые он пропустит.</p>
            </details>
          </div>
        </div>
      </section>

      <section data-ar-pane="queue" hidden>
        <div class="ar-card">
          <div class="ar-card-head">
            <h4>Очередь заливки <em>${queueTotal}</em></h4>
            <div class="ar-actions">
              <button class="btn" id="ar-queue-refresh">Обновить</button>
              <button class="btn danger" id="ar-requeue" title="Все перенесённые серии зальются заново (например, чтобы получили обложку); старая копия удаляется после успешной заливки новой">Перезалить всё заново</button>
            </div>
          </div>
          <p class="ar-hint">${queueTotal
            ? `В очереди <b>${queueTotal}</b> ${plural(queueTotal, "пост", "постов")}${eta ? ` — при лимите ${d.queue.limit_mbit} Мбит/с это примерно <b>${eta}</b>` : ""}. Заливка идёт по одной: тайтл за тайтлом, серия за серией.`
            : "Очередь пуста — бот ничего не ждёт."}</p>
          ${d.queue && d.queue.items.length ? `<div class="ar-list">${d.queue.items.map(q => `
            <div class="ar-row${q.active ? " live" : ""}">
              <span class="ar-num">${q.post}</span>
              <b>${esc(q.title)}</b>
              <span class="ar-meta">${q.season ? `${q.season} сезон · ` : ""}${q.episode != null ? `серия ${q.episode}` : "номер по счётчику"}${q.size_mb ? ` · ${q.size_mb} МБ` : ""}</span>
              ${q.active ? `<span class="ar-live"><i></i>заливается</span>` : ""}
            </div>`).join("")}${d.queue.more ? `<div class="ar-more">…и ещё ${d.queue.more}</div>` : ""}</div>` : ""}
        </div>
        <div class="ar-card">
          <h4>Ждут предыдущую серию <em>${held.length}</em></h4>
          <p class="ar-hint">Серия, пришедшая раньше предыдущей (например, 2-я без 1-й), ждёт здесь и переносится сама, как только предыдущая ляжет в архив. Если предыдущей не будет, отправьте серию без ожидания.</p>
          ${held.length ? `<div class="ar-list">${held.map(h => `
            <div class="ar-row">
              <b>${esc(h.title)}</b>
              <span class="ar-meta">${h.season} сезон · серия ${h.episode} — ждёт серию ${h.waits_for}${h.forced ? " · отправится в течение 30 секунд" : ""}</span>
              <span class="ar-row-actions">
                <button class="btn" data-hold-release="${esc(h.key)}"${h.forced ? " disabled" : ""}>Отправить без ожидания</button>
                <button class="btn" data-hold-drop="${esc(h.key)}">Убрать</button>
              </span>
            </div>`).join("")}</div>` : `<div class="ar-empty">Никто не ждёт.</div>`}
        </div>
      </section>

      <section data-ar-pane="topics" hidden>
        <div class="ar-card">
          <div class="ar-card-head">
            <h4>Темы тайтлов <em>${topics.length}</em></h4>
            <div class="ar-actions">
              ${topics.length > 4 ? `<input class="field-input ar-search" id="ar-topic-search" placeholder="Найти тему…">` : ""}
              <button class="btn" id="ar-refresh">Обновить</button>
            </div>
          </div>
          <p class="ar-hint">Создайте тему в архивной группе — она появится здесь сама (бот должен быть админом группы), и серия с похожим названием ляжет в неё. Для тем, созданных до подключения бота, укажите номер ниже.</p>
          ${topics.length ? `<div class="ar-topics">${topics.map(t => {
            const bound = (t.tags || []).length > 0;
            const raw = bound ? t.tags[0] : (t.suggest || "");
            const tag = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";  // бот хранит хештег строчными — показываем с заглавной
            return `
            <div class="ar-topic${bound ? " bound" : ""}" data-topic-row="${t.topic_id}">
              <div class="ar-topic-head">
                <div><b>${esc(t.name)}</b><span class="ar-meta">тема № ${t.topic_id}</span></div>
                <label class="ar-switch sm" title="Включено — серии этого тайтла ложатся в эту тему"><input type="checkbox" data-topic-use="${t.topic_id}" ${bound ? "checked" : ""}><i></i></label>
              </div>
              <div class="ar-topic-foot">
                <input class="field-input" data-topic-tag="${t.topic_id}" value="${esc(tag)}" placeholder="Название_тайтла (как в хештеге)" title="Хештег тайтла — по нему бот находит тему">
                <button class="btn" data-forget-topic="${t.topic_id}" title="Убрать из списка и снять привязки (сама тема в Telegram останется)">Убрать</button>
              </div>
            </div>`;
          }).join("")}</div>` : `<div class="ar-empty">Тем пока нет — они появятся, когда вы создадите тему в группе или придёт первая серия.</div>`}
        </div>
        <form id="ar-bind" class="ar-card ar-inline">
          <h4>Привязать к существующей теме</h4>
          <div class="ar-fields">
            <input class="field-input" id="ar-tag" placeholder="Название_тайтла (как в хештеге)">
            <input class="field-input" id="ar-topic" type="number" min="1" placeholder="№ темы" style="max-width:120px;">
            <button class="btn primary" type="submit">Привязать</button>
          </div>
        </form>
      </section>

      <section data-ar-pane="next" hidden>
        <form id="ar-ctx" class="ar-card">
          <h4>Следующая серия</h4>
          <p class="ar-hint">Достаточно один раз выложить серию с хештегами — бот запомнит тайтл и дальше сам ставит 2, 3, 4… только для новых постов. Можно прописать вручную: тогда оно не сменится на другой тайтл и не забывается. Явные хештеги в подписи всегда главнее.</p>
          <div class="ar-fields">
            <input class="field-input" id="ar-ctx-tag" placeholder="Название_тайтла (как в хештеге)" value="${esc(d.context ? d.context.title_tag : "")}" style="flex:3; min-width:200px;">
            <input class="field-input" id="ar-ctx-season" type="number" min="1" placeholder="Сезон" value="${d.context && d.context.season ? d.context.season : ""}" style="width:90px;">
            <input class="field-input" id="ar-ctx-quality" placeholder="4K" value="${esc(d.context && d.context.quality ? d.context.quality : "")}" style="width:90px;">
            <input class="field-input" id="ar-ctx-next" type="number" min="1" placeholder="Серия" value="${d.context ? d.context.next_episode : 1}" style="width:100px;" title="Номер следующей серии">
          </div>
          <div class="ar-actions" style="justify-content:flex-start; margin-top:12px;">
            <button class="btn primary" type="submit">Сохранить</button>
            ${d.context ? `<button class="btn" type="button" id="ar-ctx-clear">Сбросить</button>` : ""}
          </div>
          <p class="ar-hint" style="margin-top:12px;">${d.context ? `Сейчас: <b>${esc(d.context.title_tag.split("_").join(" "))}</b>${d.context.season ? ` · ${d.context.season} сезон` : ""}${d.context.quality ? ` · ${esc(d.context.quality)}` : ""} — следующая серия <b>${d.context.next_episode}</b>.${d.context.auto ? " Запомнено ботом по последней серии; забудется, если 3 дня не будет новых. Чтобы закрепить — нажмите «Сохранить»." : ""}` : "Не задано: бот берёт тайтл и номер только из хештегов поста."}</p>
        </form>
      </section>

      <section data-ar-pane="check" hidden>
        <div class="ar-card">
          <h4>Проверка подписи</h4>
          <p class="ar-hint">Вставьте подпись поста из канала — покажу, как бот её разберёт и что получится в архиве. Ничего не отправляется.</p>
          <textarea class="field-input" id="ar-sample" rows="2">${esc(sampleCaption)}</textarea>
          <div class="ar-actions" style="justify-content:flex-start; margin-top:10px;"><button class="btn primary" id="ar-preview">Показать, что получится</button></div>
          <div id="ar-preview-out" style="margin-top:14px;"></div>
        </div>
      </section>
    </div>`;

    const showTab = name => {
      tab = name;
      root.querySelectorAll("[data-ar-tab]").forEach(b => b.classList.toggle("on", b.dataset.arTab === name));
      root.querySelectorAll("[data-ar-pane]").forEach(p => { p.hidden = p.dataset.arPane !== name; });
    };
    root.querySelectorAll("[data-ar-tab]").forEach(b => b.addEventListener("click", () => {
      showTab(b.dataset.arTab);
      if (b.dataset.arTab === "check" && !root.querySelector("#ar-preview-out").innerHTML) runPreview();
    }));
    showTab(tab);

    const apply = async (path, body, okText) => {
      try {
        paint(await apiPost(path, body));
        if (okText) toast(okText, "success");
      } catch (e) { toast(e.message, "error"); await load(); }
    };
    // Настройки сохраняются сразу при изменении — отдельной кнопки «Сохранить» нет.
    root.querySelector("#ar-enabled").addEventListener("change", e => apply("/archive", { enabled: e.target.checked }, e.target.checked ? "Автоперенос включён." : "Автоперенос выключен."));
    root.querySelector("#ar-source").addEventListener("change", e => apply("/archive", { source: e.target.value }, "Канал сохранён."));
    root.querySelector("#ar-target").addEventListener("change", e => apply("/archive", { target: e.target.value }, "Группа сохранена."));
    root.querySelectorAll("[data-name-pref]").forEach(b => b.addEventListener("click", () => apply("/archive", { name_pref: b.dataset.namePref }, "Сохранено — для новых серий.")));
    root.querySelectorAll("[data-hold-release]").forEach(b => b.addEventListener("click", () => apply("/archive/hold/release", { key: b.dataset.holdRelease }, "Серия будет отправлена.")));
    root.querySelectorAll("[data-hold-drop]").forEach(b => b.addEventListener("click", () => apply("/archive/hold/drop", { key: b.dataset.holdDrop }, "Убрано из очереди.")));
    root.querySelector("#ar-refresh")?.addEventListener("click", load);
    root.querySelector("#ar-queue-refresh")?.addEventListener("click", load);
    root.querySelector("#ar-requeue")?.addEventListener("click", async () => {
      if (!confirm("Вернуть в очередь ВСЕ перенесённые серии и залить заново? Старая копия каждой серии удаляется только после того, как новая успешно залита. На сотню серий уйдёт несколько часов.")) return;
      try { await apiPost("/archive/requeue", {}); toast("Серии возвращены в очередь — бот начнёт в течение 30 секунд.", "success"); setTimeout(load, 4000); }
      catch (e) { toast(e.message, "error"); }
    });
    root.querySelector("#ar-topic-search")?.addEventListener("input", e => {
      const q = e.target.value.trim().toLowerCase();
      root.querySelectorAll("[data-topic-row]").forEach(row => {
        const text = (row.textContent + " " + [...row.querySelectorAll("input[data-topic-tag]")].map(i => i.value).join(" ")).toLowerCase();
        row.style.display = !q || text.includes(q) ? "" : "none";
      });
    });
    root.querySelectorAll("[data-topic-use]").forEach(box => box.addEventListener("change", () => {
      const id = Number(box.dataset.topicUse);
      const input = root.querySelector(`[data-topic-tag="${id}"]`);
      const topic = topics.find(t => t.topic_id === id);
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
      out.innerHTML = `<div class="ar-empty">Разбираю…</div>`;
      try {
        const r = await apiPost("/archive/preview", { caption: sampleCaption });
        out.innerHTML = previewHtml(r);
        if (r.ok) {
          out.insertAdjacentHTML("beforeend", `
            <form id="ar-name" class="ar-namebox">
              <span class="ar-label">Название тайтла в имени файла</span>
              <div class="ar-fields">
                <input class="field-input" id="ar-name-input" value="${esc(r.file_title || "")}" placeholder="Название в имени файла (ромадзи или английское)">
                <button class="btn primary" type="submit">Запомнить для тайтла</button>
              </div>
              <div class="ar-chips">${["romaji", "english"].filter(k => r.name_options && r.name_options[k]).map(k => `<button class="ar-chipbtn" type="button" data-name-opt="${esc(r.name_options[k])}" title="Подставить в поле — потом нажмите «Запомнить для тайтла»">${k === "romaji" ? "Ромадзи" : "English"}: ${esc(r.name_options[k])}</button>`).join("")}</div>
              <p class="ar-hint" style="margin:0;">Если бот подобрал не то — впишите нужное, оно запомнится для этого тайтла. Пусто — снова автоматически.</p>
            </form>`);
          out.querySelectorAll("[data-name-opt]").forEach(btn => btn.addEventListener("click", () => {
            out.querySelector("#ar-name-input").value = `${btn.dataset.nameOpt} ${(r.file_title || "").match(/(TV|Movie|OVA|ONA|Special)$/i)?.[1] || "TV"}`;
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
    if (tab === "check") runPreview();
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
