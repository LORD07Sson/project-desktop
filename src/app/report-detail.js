// Развёрнутая карточка отчёта (шторка): чек-лист, заметки, файлы,
// серверная AI-проверка звука. Открывается из Списка/Доски/Ленты/
// профиля коллеги.

import { apiGet, apiPost, apiUpload, openSheet, dismissSheet, toast, dialogSkeletonHtml } from "./api.js";
import { AUDIO_RE } from "./media-formats.js";
import { attachHtml, wireAttachments, downloadAttachment, pickFile, pickFiles, pastedFile, renderPending, tooBig, CLIP_ICON } from "./attachments.js";
import { state, can } from "./state.js";
import { invoke, pickOutputFile, pickInputFile, revealInFolder, pinReportWindow, openExternal } from "./tauri.js";
import { esc, initials, STATUS_DOT_CLASS, STATUS_COLOR_VAR, isOverdue, parseNoteTime, secondsFromTimeInput, noteTimePrefix, formatRange } from "./utils.js";
import { runQcAnalysis, QC_EXTENSIONS } from "./qc.js";
import { changeStatusDialog, assignDialog, priorityDialog, deadlineDialog, loadReports, listNeighbors, seriesParts, priorityFlagHtml, deadlineCellHtml, posterSrc } from "./reports.js";
import { loadRoles, loadAssignable, userOptionsHtml, openTitleAdminDetail } from "./titles-admin.js";
import { setDropTarget } from "./file-drop.js";
import { recordRecentReport } from "./recent-reports.js";
import { toggleFocusMode, syncFocusButton } from "./focus-mode.js";
import { loadAvatars } from "./profile.js";
import { createPlayer, isAudioFile } from "./player.js";
import { linkifyProject } from "./deeplink-core.js";
import { titleArt } from "./title-page.js";

// Ключи "kind" — ровно те, что отдаёт серверный audio_qc.py (miniapp/audio_qc.py):
// "clip"/"noise"/"silence"/"silence_long"/"no_speech". Раньше здесь жил набор
// clipping/silence/noise/loud/quiet — ни один ключ не совпадал с реальным
// ответом сервера, находки просто не подписывались.
const QC_FINDING_LABELS_RU = { clip: "Клиппинг", noise: "Шум", silence_long: "Долгая тишина", no_speech: "Речь не найдена" };
const FILE_ICONS = { photo: "🖼", video: "🎬", audio: "🎵", voice: "🎙", document: "📄" };

// Экран хода сборки финала. Сборку ведёт бот и пишет состояние на сервер (/assemble-progress) — здесь оно опрашивается
// раз в 3 секунды: шаг, полоса, кадры, сколько прошло и осталось. Карточка встаёт под кнопкой «Собрать финал»
// и переживает перерисовку шторки (при каждом опросе, если её не стало, возвращается на место).
const assemblyWatchers = new Set();
const postWanted = new Set(); // отчёты, для которых по готовности финала надо открыть редактор поста

function startAssemblyWatch(publicId, overlay, waitForStart, botName = "", openPostWhenDone = false) {
  if (openPostWhenDone) postWanted.add(publicId);
  if (assemblyWatchers.has(publicId)) return;
  assemblyWatchers.add(publicId);
  let postOpened = false;
  const startedAt = Date.now();
  let card = null;
  let seenActive = false;
  let timer = null;

  const clock = sec => {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const num = n => Number(n).toLocaleString("ru-RU");
  const stop = () => { clearTimeout(timer); assemblyWatchers.delete(publicId); card?.remove(); };

  const paint = st => {
    const btn = overlay.querySelector("#report-assemble");
    if (!btn) return;
    if (!card) { card = document.createElement("div"); card.className = "rd-asm"; }
    if (!card.isConnected) {
      const slot = overlay.querySelector("#rd-prod-asm");
      if (slot) slot.appendChild(card); else btn.insertAdjacentElement("afterend", card);
    }
    if (!st) {
      if (card.dataset.state === "waiting") return;  // не перерисовываем, чтобы не мигала кнопка
      card.dataset.state = "waiting";
      card.innerHTML = `<b>🎬 Сборка финала</b><span class="rd-asm-step">Жду подтверждения в боте — откройте карточку и нажмите «Собрать».</span>
        ${botName ? `<button type="button" class="btn primary rd-asm-cancel" data-asm-open>📲 Открыть бота в Telegram</button>` : ""}`;
      card.querySelector("[data-asm-open]")?.addEventListener("click", () => {
        openExternal(`tg://resolve?domain=${botName}`).catch(() => openExternal(`https://t.me/${botName}`).catch(() => toast("Откройте бота в Telegram — карточка сборки ждёт в чате.", "info")));
      });
      return;
    }
    card.dataset.state = st.stage || "run";
    const pct = Math.round((st.fraction || 0) * 100);
    const lines = [];
    if (st.frame) lines.push(`Кадры: ${num(st.frame)}${st.total_frames ? ` из ≈ ${num(st.total_frames)}` : ""}`);
    const t = [];
    if (st.elapsed != null) t.push(`рендер идёт ${clock(st.elapsed)}`);
    if (st.eta != null) t.push(`осталось ≈ ${clock(st.eta)}`);
    if (st.speed) t.push(`скорость ${Number(st.speed).toFixed(1)}×`);
    if (t.length) lines.push(t.join(" · "));
    if (st.started && st.now) lines.push(`Всего с начала: ${clock(st.now - st.started)}`);
    const failed = st.stage === "error";
    card.className = `rd-asm${failed ? " bad" : st.stage === "done" ? " ok" : ""}`;
    card.innerHTML = `
      <b>${failed ? "❌ Сборка не удалась" : st.stage === "cancelled" ? "🛑 Сборка отменена" : st.stage === "done" ? "✅ Финал собран" : st.stage === "queued" ? "⏳ Сборка в очереди" : "🎬 Сборка финала"}</b>
      <span class="rd-asm-step">${esc(st.message || "")}</span>
      ${failed || st.stage === "done" || st.stage === "queued" || st.stage === "cancelled" ? "" : `<div class="rd-asm-bar"><i style="width:${pct}%"></i><em>${pct}%</em></div>`}
      ${lines.map(l => `<span class="rd-asm-meta">${esc(l)}</span>`).join("")}
      ${failed || st.stage === "done" || st.stage === "cancelled" ? "" : `<button type="button" class="btn rd-asm-cancel" data-asm-cancel>⏹ Отменить сборку</button>`}`;
    card.querySelector("[data-asm-cancel]")?.addEventListener("click", async e => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await apiPost(`/report/${publicId}/assemble-cancel`, {});
        toast("Отменяю сборку…", "info");
      } catch (err) {
        toast(`Не удалось отменить: ${err.message}`, "error");
        b.disabled = false;
      }
    });
  };

  const tick = async () => {
    if (!overlay.isConnected) { stop(); return; }
    let st = null;
    try { st = await apiGet(`/report/${publicId}/assemble-progress`); } catch (_) { /* повторим на следующем тике */ }
    if (st && st.stage && (st.active || st.stage === "done" || st.stage === "error" || st.stage === "cancelled")) {
      seenActive = true;
      paint(st);
      if (st.stage === "done") {
        toast(postWanted.has(publicId) && st.post_id ? "Финал собран — открываю редактор поста. Публикуете вы сами." : "Финал собран и прикреплён к отчёту.", "success");
        if (postWanted.has(publicId) && st.post_id && !postOpened) {
          postWanted.delete(publicId);
          postOpened = true;
          import("./channel-post.js").then(m => m.openChannelPostSheet(st.post_id));
        }
        document.dispatchEvent(new CustomEvent("report-file-uploaded", { detail: { publicId } }));
        timer = setTimeout(stop, 6000);
        return;
      }
      if (st.stage === "error") { timer = setTimeout(stop, 20000); return; }
      if (st.stage === "cancelled") { toast("Сборка отменена.", "info"); timer = setTimeout(stop, 5000); return; }
    } else if (!seenActive) {
      // Сборка ещё не началась: после нажатия кнопки ждём подтверждения в боте, при простом открытии карточки — молчим.
      if (!waitForStart || Date.now() - startedAt > 10 * 60 * 1000) { stop(); return; }
      paint(null);
    } else {
      stop();
      return;
    }
    timer = setTimeout(tick, 3000);
  };
  tick();
}

// После запуска сборки финала предлагаем сразу перейти к посту в канал (тот же конструктор, что в админ-панели).
function offerPublishPost() {
  const overlay = openSheet(`
    <h2>Опубликовать пост?</h2>
    <p class="bc-hint">Финал собирается в боте. Пока он готовится, можно подготовить пост для канала: заголовок, блоки с людьми, обложка и кнопки.</p>
    <div class="sheet-actions">
      <button class="btn" data-close>Позже</button>
      <button class="btn primary" id="offer-post-open">Открыть «Пост в канал»</button>
    </div>`);
  overlay.querySelector("[data-close]").addEventListener("click", () => dismissSheet(overlay));
  overlay.querySelector("#offer-post-open").addEventListener("click", () => {
    overlay.remove();
    import("./channel-post.js").then(m => m.openChannelPostSheet());
  });
}

export async function openReportDetail(publicId) {
  const overlay = openSheet(`
    <h2 class="skeleton-row" style="width:60%; height:22px;"></h2>
    ${dialogSkeletonHtml(5)}
  `, "wide");
  // Класс-маркер, а не просто ".sheet-wide" (её же используют admin.js,
  // profile.js, titles-admin.js) — фокус-режим (focus-mode.js) должен
  // отличать именно карточку отчёта от остальных широких модалок, чтобы
  // не прятать шапку/сайдбар под какой-нибудь другой из них.
  overlay.classList.add("report-detail-overlay");
  // Фокус-режим слушает эти два события, а не сам следит за DOM —
  // открытие/закрытие карточки уже единственное место, где меняется
  // presence ".report-detail-overlay".
  document.dispatchEvent(new CustomEvent("report-detail-opened", { detail: { publicId } }));

  // Пока эта карточка открыта — сюда падает файл, перетащенный из
  // проводника (см. file-drop.js). Снимаем цель при закрытии ЛЮБЫМ
  // способом (кнопка, фон, ✕) — наблюдаем за удалением overlay из DOM,
  // а не вешаем на каждую отдельную кнопку закрытия (тот же приём, что
  // и в titles-admin.js).
  setDropTarget(publicId);
  const onFileUploaded = e => { if (e.detail.publicId === publicId) render(); };
  document.addEventListener("report-file-uploaded", onFileUploaded);
  const onAppRefresh = () => { if (overlay.isConnected) render(); };
  document.addEventListener("app:refresh", onAppRefresh);
  // Находки QC, уехавшие в заметки, должны появиться в открытой карточке
  // сразу, а не после ручного обновления.
  document.addEventListener("report-notes-added", onFileUploaded);
  // Порядок заметок — состояние самой шторки, а не сервера: render()
  // вызывается на каждое действие, и сбрасывать выбор на каждом было бы
  // неприятно.
  let notesByTime = false;
  // Плеер дорожки переживает перерисовки карточки (см. player.js).
  let player = null;

  // Переход к соседнему отчёту выборки «Списка», не закрывая карточку
  // (как стрелки в шторке мини-аппа). Соседи считаются заново на каждый
  // переход — список могли пересортировать или отфильтровать.
  const goTo = targetId => {
    if (!targetId) return;
    overlay.remove();
    openReportDetail(targetId);
  };
  const onNavKey = e => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const overlays = document.querySelectorAll(".overlay");
    if (overlays[overlays.length - 1] !== overlay) return;
    const nb = listNeighbors(publicId);
    if (!nb) return;
    e.preventDefault();
    goTo(e.key === "ArrowLeft" ? nb.prev : nb.next);
  };
  document.addEventListener("keydown", onNavKey, true);
  let recentRecorded = false; // пишем в MRU один раз за открытие, не на каждый render()
  new MutationObserver((_muts, obs) => {
    if (!overlay.isConnected) {
      obs.disconnect();
      if (player) { player.destroy(); player = null; }
      setDropTarget(null);
      document.removeEventListener("report-file-uploaded", onFileUploaded);
      document.removeEventListener("app:refresh", onAppRefresh);
      document.removeEventListener("report-notes-added", onFileUploaded);
      document.removeEventListener("keydown", onNavKey, true);
      document.dispatchEvent(new CustomEvent("report-detail-closed", { detail: { publicId } }));
    }
  }).observe(document.body, { childList: true });

  // Вложение к следующей заметке — переживает перерисовку карточки.
  let pendingNoteFile = null;

  async function render() {
    let detail, notes, checklist, files, roles, assignable, raws;
    const canEdit = can("reports.manage");
    try {
      [detail, notes, checklist, files, roles, assignable, raws] = await Promise.all([
        apiGet(`/report/${publicId}`),
        apiGet(`/report/${publicId}/notes`),
        apiGet(`/report/${publicId}/checklist`),
        apiGet(`/report/${publicId}/files`),
        canEdit ? loadRoles().catch(() => []) : Promise.resolve([]),
        canEdit ? loadAssignable().catch(() => []) : Promise.resolve([]),
        // Старый сервер без /raws — карточка открывается и без раздела.
        apiGet(`/report/${publicId}/raws`).catch(() => ({ raws: [] })),
      ]);
    } catch (e) {
      overlay.querySelector(".sheet").innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить карточку: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    if (!recentRecorded) {
      recentRecorded = true;
      recordRecentReport(publicId, detail.title);
    }

    // Черновик цепочки пайплайна — правится локально до нажатия
    // «Сохранить», как и в мини-аппе (pipelineDraft): полный список
    // шагов уходит на /pipeline разом, PATCH одного шага сервер не
    // умеет. Сбрасывается при каждом render() (в т.ч. после сохранения
    // заметки/чек-листа отчёта) — то же поведение, что и там.
    let pipelineParallel = !!detail.pipeline_parallel;
    let pipelineDraft = (detail.pipeline || []).map(s => ({ role: s.role, telegram_id: s.telegram_id || null, name: s.user_name || null }));

    const dotClass = STATUS_DOT_CLASS[detail.status] || "draft";
    const overdue = isOverdue(detail);
    const nav = listNeighbors(publicId);

    // Заметки с тайм-кодом — это список правок по дорожке, и читать его
    // удобнее по времени, а не по времени написания.
    const timedCount = notes.notes.filter(n => parseNoteTime(n.text)).length;
    const orderedNotes = notesByTime
      ? notes.notes.slice().sort((a, b) => {
          const ta = parseNoteTime(a.text), tb = parseNoteTime(b.text);
          if (ta && tb) return ta.seconds - tb.seconds;
          if (ta) return -1;
          if (tb) return 1;
          return 0;
        })
      : notes.notes;

    const t = seriesParts(detail);
    const poster = posterSrc(detail.poster_url);
    // Баннер тайтла (AniList) — шапкой карточки; нет баннера — размытая обложка.
    const banner = titleArt(detail.title_id, "banner", 1080);
    const authorName = (detail.author && (detail.author.first_name || detail.author.username)) || "?";
    const hasPipe = detail.pipeline && detail.pipeline.length;
    const doneItems = checklist.items.filter(i => i.done).length;
    const rawFileCount = (raws.raws || []).reduce((n, r) => n + (r.files?.length || (r.present ? 1 : 0)), 0);
    const rawFileCountTail = rawFileCount % 10 === 1 && rawFileCount % 100 !== 11
      ? "файл"
      : rawFileCount % 10 >= 2 && rawFileCount % 10 <= 4 && (rawFileCount % 100 < 12 || rawFileCount % 100 > 14)
        ? "файла"
        : "файлов";
    const rawFileCountLabel = `${rawFileCount} ${rawFileCountTail}`;
    const steps = STATUS_PATH.map(([st, lbl], i) => {
      const curIdx = STATUS_PATH.findIndex(([s]) => s === detail.status);
      const cls = st === detail.status ? " cur" : curIdx > i ? " done" : "";
      return `<button class="rd-step${cls}" data-set-status="${st}" style="--c:var(${STATUS_COLOR_VAR[st]});"${canEdit ? "" : " disabled title=\"Только просмотр\""}><i></i>${lbl}</button>`;
    }).join("");
    const side = detail.status === "revision" || detail.status === "cancelled" ? detail.status : "";

    overlay.querySelector(".sheet").innerHTML = `
      <div class="rd-hero${banner ? "" : " no-ban"}">
        <div class="rd-hero-bg"${poster ? ` style="background-image:url('${esc(poster)}')"` : ""}></div>
        ${banner ? `<img class="rd-ban" src="${esc(banner)}" alt="">` : ""}
        <div class="rd-hero-in">
          <span class="rd-poster"${poster ? ` style="background-image:url('${esc(poster)}')"` : ""}>${poster ? "" : esc(initials(t.name))}</span>
          <div class="rd-titles">
            <span class="kd-kick${overdue ? " hot" : ""}"><i></i>${esc(detail.public_id)}${t.ep ? ` · ${esc(t.ep)}` : ""}</span>
            <h2>${esc(t.name)}${priorityFlagHtml(detail.priority)}</h2>
            <div class="rd-sub">${t.sub ? `${esc(t.sub)} · ` : ""}создал ${esc(authorName)} · ${esc(String(detail.created_at || "").slice(0, 16))}</div>
          </div>
          <div class="detail-head-actions">
            ${nav ? `
              <button class="icon-btn" data-nav="prev" title="Предыдущий в списке (Alt+←)" aria-label="Предыдущий отчёт" ${nav.prev ? "" : "disabled"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
              <button class="icon-btn" data-nav="next" title="Следующий в списке (Alt+→)" aria-label="Следующий отчёт" ${nav.next ? "" : "disabled"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>` : ""}
            <button class="icon-btn" data-copy-plink="${esc(detail.public_id)}" style="flex:none;" title="Копировать ссылку project://…" aria-label="Копировать ссылку на отчёт"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/></svg></button>
            <button class="icon-btn" id="btn-focus-toggle" data-focus-toggle style="flex:none;"></button>
            <button class="icon-btn" data-close style="flex:none;" title="Закрыть" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>
        </div>
        <div class="rd-steps">
          ${steps}
          <button class="rd-step-side${side === "revision" ? " on" : ""}" data-set-status="revision" style="--c:var(--s-fix);"${canEdit ? "" : " disabled title=\"Только просмотр\""}>↺ На перезапись</button>
          ${side === "cancelled" ? `<span class="rd-step-side on" style="--c:var(--s-stop);">Отменено</span>` : ""}
        </div>
      </div>

      <div class="rd-tabs">
        <button class="rd-tab on" data-rd-tab="main">Обзор</button>
        <button class="rd-tab" data-rd-tab="history">История</button>
        <button class="rd-tab" data-rd-tab="activity">Активность</button>
        ${canEdit ? `<button class="rd-tab" id="btn-qc-track" title="Проверить звук дорожки">QC дорожки</button>` : ""}
      </div>

      <div class="rd-body">
        <div class="rd-main">
          <div class="rd-panel" data-rd-panel="main">
            <div id="rd-player-host"></div>
            ${productionHtml(detail, files.files)}
            <div class="rd-sec">
              <h3>Пайплайн ${hasPipe ? `<span class="n">${detail.pipeline_parallel ? "без очереди" : `${detail.pipeline.filter(s => s.done).length} из ${detail.pipeline.length}`}</span>` : ""}
                ${canEdit ? `<button class="pf-link rd-h-act" id="pipe-edit-toggle">${hasPipe ? "изменить" : ""}</button>` : ""}</h3>
              ${hasPipe ? pipelineTimelineHtml(detail.pipeline, !!detail.pipeline_parallel) + pipelineAdvanceHtml(detail.pipeline, assignable, canEdit, !!detail.can_advance) : (canEdit ? `<button class="rd-add" id="pipe-add-open">+ Собрать пайплайн: перевод → тайминг → озвучка…</button>` : `<div class="no-assignee">Пайплайн пока не задан.</div>`)}
              ${canEdit ? `<div id="pipe-editor" hidden>
                <div id="pipeline-draft-list"></div>
                <div class="add-row">
                  <select id="pipeline-role-pick" class="field-input"><option value="">+ роль…</option>${roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select>
                  <select id="pipeline-user-pick" class="field-input">${userOptionsHtml(assignable, null)}</select>
                  <button class="btn" id="pipeline-add-step">+</button>
                </div>
                <label class="bc-feature" style="margin-top:10px;" title="Все этапы открыты сразу: даббер, звукарь, тайминг и остальные работают одновременно, никто никого не ждёт"><input type="checkbox" id="pipeline-parallel" ${pipelineParallel ? "checked" : ""}><span><b>Без очереди</b> — все этапы одновременно, не нужно ждать предыдущего</span></label>
                <div class="sheet-actions" style="margin-top:8px;">
                  <button class="btn primary" id="btn-pipeline-save">Сохранить пайплайн</button>
                  ${hasPipe ? `<button class="btn danger" id="btn-pipeline-clear">Снять</button>` : ""}
                </div>
              </div>` : ""}
            </div>

            <div class="rd-sec">
              <h3>Чек-лист ${checklist.items.length ? `<span class="n">${doneItems} из ${checklist.items.length}</span>` : ""}</h3>
              <div id="checklist-list">${checklist.items.map(item => checklistItemHtml(item, canEdit)).join("")}</div>
              ${canEdit ? `<div class="add-row">
                <input id="checklist-new" placeholder="${checklist.items.length ? "Ещё пункт…" : "+ Добавить пункт: например, «сверить имена»"}">
                <button class="btn" id="checklist-add">+</button>
              </div>` : ""}
            </div>

            <div class="rd-sec">
              <h3>Заметки ${notes.notes.length ? `<span class="n">${notes.notes.length}</span>` : ""}
                ${timedCount >= 2 ? `<button class="btn ghost notes-sort rd-h-act" id="notes-sort">${notesByTime ? "По времени добавления" : "По тайм-коду"}</button>` : ""}
              </h3>
              <div id="notes-list">${orderedNotes.map(noteHtml).join("")}</div>
              ${canEdit ? `<div class="add-row note-add-row">
                <input id="note-time" class="note-time-input" placeholder="04:12" maxlength="8" inputmode="numeric" title="Время на дорожке — необязательно">
                <textarea id="note-new" rows="2" placeholder="Правка или комментарий… (Ctrl+Enter — отправить, Ctrl+V — вставить скриншот)"></textarea>
                <button class="icon-btn note-attach" id="note-attach" title="Приложить картинку к заметке (или Ctrl+V скриншота)" aria-label="Приложить картинку к заметке">${CLIP_ICON}</button>
                <button class="btn" id="note-add">Добавить</button>
              </div><div class="note-pending" id="note-pending"></div>` : ""}
            </div>

            <div class="rd-sec rd-files">
              <h3>Файлы ${files.files.length ? `<span class="n">${files.files.length}</span>` : ""}
                <span class="rd-h-act rd-h-tools">
                  <button class="rd-add" id="report-file-add">${detail.is_sound ? "+ Сдать готовую дорожку" : "+ Добавить файл"}</button>
                  ${can("titles.edit") && detail.title_id ? `<button class="rd-add" id="report-watermark" title="Логотип, угол, прозрачность и размер — общие для всех серий тайтла">💧 Водяной знак</button>` : ""}
                </span>
              </h3>
              ${files.files.length ? `<div id="files-list">${files.files.map(file => fileHtml(file, canEdit)).join("")}</div>` : `<div class="rd-empty">Файлов пока нет — добавьте кнопкой выше или перетащите файл в окно.</div>`}
              ${detail.is_sound ? `<div class="no-assignee" style="margin:8px 0;">🎚 Сдача звукаря: загрузите итоговый файл — видео с новым звуком или готовую дорожку. Админ сразу получит уведомление «Дорожка сдана».</div>` : ""}

              ${(raws.raws || []).length ? `
              <div class="rd-subhead" title="Можно прикрепить несколько файлов в каждой категории. Их увидят участники, которым доступен этот отчёт.">Равки и субтитры <span class="n">${rawFileCountLabel}</span></div>
              ${rawKindsHtml((raws.raws || []).map(r => ({
                kind: r.kind, label: r.label,
                entries: r.files || (r.present ? [{ id: null, legacy: true, character_id: 0, name: r.name || "файл" }] : []),
              })), { canAdd: raws.can_upload, addAttr: "data-raw-add", dlAttr: "raw" })}` : ""}

              ${(raws.shared_sources && (raws.shared_sources.can_view || raws.shared_sources.can_upload)) ? `
              <div class="rd-subhead" title="Равки 480p/1080p · скачивание доступно дабберам этого тайтла и назначенному звукарю${raws.shared_sources.can_upload ? " · загрузка для роли «Роспись»" : ""}">Исходники серии${raws.shared_sources.episode ? ` · ${esc(raws.shared_sources.episode)}` : ""}</div>
              ${rawKindsHtml((raws.shared_sources.kinds || []).map(r => ({ kind: r.kind, label: r.label, entries: r.files || [] })), { canAdd: raws.shared_sources.can_upload, addAttr: "data-source-add", dlAttr: "source" })}` : ""}
            </div>
          </div>
          <div class="rd-panel" data-rd-panel="history" hidden></div>
          <div class="rd-panel" data-rd-panel="activity" hidden></div>
        </div>

        <aside class="rd-side">
          <div class="rd-summary">
            <div><b>${doneItems}/${checklist.items.length}</b><span>пунктов чек-листа</span></div>
            <div><b>${files.files.length}</b><span>файлов</span></div>
            <div><b>${notes.notes.length}</b><span>заметок</span></div>
          </div>
          <div class="rd-meta">
            <div class="rd-meta-row"><span>Исполнители / кого уведомить</span>
              ${(detail.assignees || []).map(a => `<div class="rd-person" data-assignee="${a.telegram_id}">
                <span class="avatar-bubble" data-avatar-for="${a.telegram_id}">${esc(initials(a.first_name || a.username))}</span>
                <span>${esc(a.first_name || a.username || `ID ${a.telegram_id}`)}</span>
                ${canEdit ? `<button class="icon-btn" data-unassign="${a.telegram_id}" title="Снять">✕</button>` : ""}
              </div>`).join("")}
              ${canEdit ? `<button class="rd-add" id="chip-assign">+ ${detail.assignees && detail.assignees.length ? "ещё исполнитель" : "назначить"}</button>` : ""}
            </div>
            <div class="rd-meta-row"><span>Срок</span>
              ${canEdit ? `<button class="rd-meta-btn" id="chip-deadline">${detail.deadline ? deadlineCellHtml(detail, overdue) : `<span class="ls-dl-none">без срока — поставить</span>`}</button>` : `<div class="rd-meta-btn" aria-disabled="true">${detail.deadline ? deadlineCellHtml(detail, overdue) : "без срока"}</div>`}</div>
            <div class="rd-meta-row"><span>Приоритет</span>
              ${canEdit ? `<button class="rd-meta-btn" id="chip-priority"><span class="priority-chip ${esc(detail.priority)}"><span class="dot"></span>${esc(detail.priority_label)}</span></button>` : `<div class="rd-meta-btn" aria-disabled="true"><span class="priority-chip ${esc(detail.priority)}"><span class="dot"></span>${esc(detail.priority_label)}</span></div>`}</div>
            <div class="rd-meta-row"><span>Статус</span>
              ${canEdit ? `<button class="rd-meta-btn" id="chip-status"><span class="chip status-chip" style="--chip-accent: var(${STATUS_COLOR_VAR[detail.status] || "--s-draft"})"><span class="dot ${dotClass}"></span>${esc(detail.status_label)}</span></button>` : `<div class="rd-meta-btn" aria-disabled="true"><span class="chip status-chip" style="--chip-accent: var(${STATUS_COLOR_VAR[detail.status] || "--s-draft"})"><span class="dot ${dotClass}"></span>${esc(detail.status_label)}</span></div>`}</div>
          </div>
          <div class="rd-side-foot">
            <button class="btn ghost" id="btn-pin-window">Открепить в окне</button>
            ${can("reports.delete") ? `<details class="rd-more"><summary>⋯ Ещё</summary><button class="btn danger" id="btn-delete-report">Удалить отчёт</button></details>` : ""}
          </div>
        </aside>
      </div>
    `;

    const sheet = overlay.querySelector(".sheet");
    sheet.querySelector(".rd-ban")?.addEventListener("error", e => e.currentTarget.closest(".rd-hero").classList.add("no-ban"));
    if (canEdit) sheet.querySelectorAll("[data-set-status]").forEach(b => b.addEventListener("click", async () => {
      const status = b.dataset.setStatus;
      if (status === detail.status) return;
      try {
        await apiPost(`/report/${publicId}/status`, { status, comment: "" });
        toast("Статус обновлён.", "success");
        loadReports();
        await render();
      } catch (e) { toast(`Не удалось сменить статус: ${e.message}`, "error"); }
    }));
    sheet.querySelectorAll("[data-rd-tab]").forEach(b => b.addEventListener("click", () => {
      const tab = b.dataset.rdTab;
      sheet.querySelectorAll("[data-rd-tab]").forEach(x => x.classList.toggle("on", x === b));
      sheet.querySelectorAll("[data-rd-panel]").forEach(p => { p.hidden = p.dataset.rdPanel !== tab; });
      if (tab !== "main") fillLogPanel(sheet.querySelector(`[data-rd-panel="${tab}"]`), publicId, tab);
    }));
    const pipeEditor = sheet.querySelector("#pipe-editor");
    const openPipeEditor = () => { pipeEditor.hidden = !pipeEditor.hidden; };
    if (canEdit) sheet.querySelector("#pipe-add-open")?.addEventListener("click", e => { e.currentTarget.remove(); pipeEditor.hidden = false; });
    const pipeToggle = sheet.querySelector("#pipe-edit-toggle");
    if (pipeToggle && hasPipe && canEdit) pipeToggle.addEventListener("click", openPipeEditor);
    else pipeToggle?.remove();
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    loadAvatars(sheet);
    sheet.querySelectorAll("[data-nav]").forEach(b => b.addEventListener("click", () => {
      const nb = listNeighbors(publicId);
      if (nb) goTo(b.dataset.nav === "prev" ? nb.prev : nb.next);
    }));
    syncFocusButton(sheet.querySelector("#btn-focus-toggle"));
    sheet.querySelector("#btn-focus-toggle").addEventListener("click", toggleFocusMode);
    sheet.querySelector("#btn-pin-window").addEventListener("click", async () => {
      try {
        await pinReportWindow(publicId);
      } catch (e) {
        toast(`Не удалось открыть окно: ${e}`, "error");
      }
    });
    if (canEdit) {
      sheet.querySelector("#chip-status").addEventListener("click", () => changeStatusDialog([publicId], render, detail.status));
      sheet.querySelector("#chip-assign").addEventListener("click", () => assignDialog([publicId], render));
      sheet.querySelector("#chip-priority").addEventListener("click", () => priorityDialog(publicId, render, detail.priority));
      sheet.querySelector("#chip-deadline").addEventListener("click", () => deadlineDialog(publicId, detail.deadline, render));
    }

    if (canEdit) sheet.querySelectorAll(".checklist-item").forEach(el => {
      el.addEventListener("click", async () => {
        try {
          await apiPost(`/report/${publicId}/checklist/${el.dataset.id}/toggle`, {});
          await render();
        } catch (e) { toast(`Не удалось изменить пункт: ${e.message}`, "error"); }
      });
    });
    if (canEdit) sheet.querySelectorAll("[data-checklist-del]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          await apiPost(`/report/${publicId}/checklist/${btn.dataset.checklistDel}/delete`, {});
          await render();
        } catch (e) { toast(`Не удалось удалить пункт: ${e.message}`, "error"); }
      });
    });
    if (canEdit) sheet.querySelectorAll("[data-unassign]").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await apiPost(`/report/${publicId}/unassign`, { telegram_id: Number(btn.dataset.unassign) });
          if (res.changed) { toast("Исполнитель снят."); await render(); }
          else btn.disabled = false;
        } catch (e) { toast(`Не удалось снять исполнителя: ${e.message}`, "error"); btn.disabled = false; }
      });
    });
    sheet.querySelector("#btn-delete-report")?.addEventListener("click", async () => {
      if (!confirm(`Удалить отчёт ${detail.public_id} («${detail.title}»)? Действие необратимо.`)) return;
      const btn = sheet.querySelector("#btn-delete-report");
      btn.disabled = true;
      btn.textContent = "Удаляем…";
      try {
        const res = await apiPost(`/report/${publicId}/delete`, {});
        if (res.deleted) {
          toast("Отчёт удалён.");
          overlay.remove();
          await loadReports();
          } else if (res.pending_approval) {
          toast("Запрос на удаление отправлен владельцу.");
          overlay.remove();
        } else {
          toast("Не удалось удалить.", "error");
          btn.disabled = false;
          btn.textContent = "Удалить отчёт";
        }
      } catch (e) {
        toast(`Не удалось удалить: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Удалить отчёт";
      }
    });

    function renderPipelineDraft() {
      const host = sheet.querySelector("#pipeline-draft-list");
      if (!host) return;
      host.innerHTML = pipelineDraft.length
        ? `<div class="chip-row" style="margin-bottom:8px;">${pipelineDraft.map((s, i) =>
            `<span class="chip">${i + 1}. ${esc(s.role)}${s.name ? ` — ${esc(s.name)}` : ""} <button class="icon-btn" data-remove-step="${i}" style="padding:0 2px; border:none;">✕</button></span>`
          ).join("")}</div>`
        : `<div class="no-assignee">Пока пусто — добавьте первый этап</div>`;
      host.querySelectorAll("[data-remove-step]").forEach(btn => {
        btn.addEventListener("click", () => {
          pipelineDraft.splice(parseInt(btn.dataset.removeStep, 10), 1);
          renderPipelineDraft();
        });
      });
    }
    if (canEdit) renderPipelineDraft();

    if (canEdit) sheet.querySelector("#pipeline-add-step").addEventListener("click", () => {
      const roleSel = sheet.querySelector("#pipeline-role-pick");
      const userSel = sheet.querySelector("#pipeline-user-pick");
      const role = roleSel.value;
      if (!role) { toast("Выберите роль.", "error"); return; }
      const telegram_id = userSel.value ? Number(userSel.value) : null;
      const name = telegram_id ? userSel.options[userSel.selectedIndex].textContent : null;
      pipelineDraft.push({ role, telegram_id, name });
      roleSel.value = "";
      userSel.value = "";
      renderPipelineDraft();
    });
    if (canEdit) sheet.querySelector("#btn-pipeline-save").addEventListener("click", async () => {
      try {
        await apiPost(`/report/${publicId}/pipeline`, { steps: pipelineDraft.map(s => ({ role: s.role, telegram_id: s.telegram_id })), parallel: !!sheet.querySelector("#pipeline-parallel")?.checked });
        toast(pipelineDraft.length ? "Пайплайн сохранён." : "Пайплайн снят.");
        await render();
      } catch (e) { toast(`Не удалось сохранить пайплайн: ${e.message}`, "error"); }
    });
    const clearBtn = sheet.querySelector("#btn-pipeline-clear");
    if (clearBtn && canEdit) clearBtn.addEventListener("click", async () => {
      if (!confirm("Снять пайплайн с отчёта?")) return;
      try {
        await apiPost(`/report/${publicId}/pipeline`, { steps: [] });
        toast("Пайплайн снят.");
        await render();
      } catch (e) { toast(`Не удалось снять пайплайн: ${e.message}`, "error"); }
    });
    const advanceBtn = sheet.querySelector("#btn-pipeline-advance");
    if (advanceBtn && (canEdit || detail.can_advance)) advanceBtn.addEventListener("click", async () => {
      const userSel = sheet.querySelector("#pipeline-next-user");
      advanceBtn.disabled = true;
      try {
        const nextUser = userSel && userSel.value ? Number(userSel.value) : null;
        const res = await apiPost(`/report/${publicId}/pipeline/advance`, { telegram_id: nextUser });
        if (res.advanced) { toast(`Передано: ${res.role}.`); await render(); }
        else { toast(res.detail || "Не удалось передать.", "error"); advanceBtn.disabled = false; }
      } catch (e) { toast(`Не удалось передать этап: ${e.message}`, "error"); advanceBtn.disabled = false; }
    });
    sheet.querySelector("#checklist-add")?.addEventListener("click", async () => {
      const input = sheet.querySelector("#checklist-new");
      const text = input.value.trim();
      if (!text) return;
      try {
        await apiPost(`/report/${publicId}/checklist`, { text });
        await render();
      } catch (e) { toast(`Не удалось добавить пункт: ${e.message}`, "error"); }
    });
    const notesSortBtn = sheet.querySelector("#notes-sort");
    if (notesSortBtn) notesSortBtn.addEventListener("click", async () => {
      notesByTime = !notesByTime;
      await render();
    });
    wireAttachments(sheet);
    const setNoteFile = file => {
      if (file && tooBig(file)) return;
      pendingNoteFile = file;
      const pending = sheet.querySelector("#note-pending");
      if (pending) renderPending(pending, file, () => setNoteFile(null));
    };
    if (canEdit) renderPending(sheet.querySelector("#note-pending"), pendingNoteFile, () => setNoteFile(null));
    sheet.querySelector("#note-attach")?.addEventListener("click", async () => {
      const file = await pickFile("image/*");
      if (file) setNoteFile(file);
    });
    sheet.querySelector("#note-new")?.addEventListener("paste", e => {
      const file = pastedFile(e);
      if (file) { e.preventDefault(); setNoteFile(file); }
    });
    sheet.querySelectorAll("[data-raw-dl]").forEach(btn => btn.addEventListener("click", () => {
      const path = btn.dataset.rawId
        ? `report/${publicId}/raws/files/${btn.dataset.rawId}/file`
        : btn.dataset.rawLegacy === "1"
          ? `report/${publicId}/raws/legacy/${btn.dataset.rawDl}/${btn.dataset.rawCharacter}/file`
          : `report/${publicId}/raws/${btn.dataset.rawDl}/file`;
      downloadAttachment(path, btn.dataset.rawName);
    }));
    sheet.querySelector("#report-file-add")?.addEventListener("click", async e => {
      const btn = e.currentTarget;
      const filesToAdd = await pickFiles("*/*");
      if (!filesToAdd.length) return;
      btn.disabled = true;
      let uploaded = 0;
      let failure = null;
      for (const file of filesToAdd) {
        try {
          await apiUpload(`/report/${publicId}/files/upload`, file);
          uploaded += 1;
        } catch (err) {
          failure = `${file.name}: ${err.message}`;
          break;
        }
      }
      await render();
      if (failure) toast(uploaded ? `Добавлено ${uploaded} из ${filesToAdd.length}. Не загрузился файл ${failure}` : `Не удалось загрузить: ${failure}`, "error");
      else toast(`Добавлено файлов: ${uploaded}.`, "success");
    });
    sheet.querySelector("#report-post")?.addEventListener("click", () => {
      import("./channel-post.js").then(m => m.openChannelPostSheet());
    });
    sheet.querySelector("#report-watermark")?.addEventListener("click", () => openTitleAdminDetail(detail.title_id));
    // Сборка уже идёт (запущена раньше или с другого устройства) — карточка хода появится сама.
    if (sheet.querySelector("#report-assemble")) startAssemblyWatch(publicId, overlay, false);
    sheet.querySelector("#report-nyaa")?.addEventListener("click", async () => {
      // Запрос для Nyaa: латинское название тайтла (как у релизеров) и номер серии; не вышло — просто название отчёта.
      let query = String(detail.title || "").split(/\s[—–-]\s/)[0].trim();
      const episode = (String(detail.title || "").match(/(?:Серия|серия|Episode|EP)\s*(\d+)/) || [])[1];
      try {
        if (detail.title_id) {
          const plan = await apiGet(`/titles/${detail.title_id}/work-plan`);
          if (plan && plan.nyaa_query_default) query = plan.nyaa_query_default;
        }
      } catch (_) { /* нет права на план — ищем по названию */ }
      if (episode) query = `${query} ${String(episode).padStart(2, "0")}`.trim();
      const { openNyaaForReport } = await import("./nyaa.js");
      overlay.remove();
      openNyaaForReport(publicId, query);
    });
    sheet.querySelector("#report-assemble")?.addEventListener("click", async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        // Окно выбора (видео, субтитры, дорожки, качество) — прямо в приложении; сборку ведёт бот, ход виден ниже, отменить можно там же.
        const { openAssembleDialog } = await import("./assemble-dialog.js");
        const started = await openAssembleDialog(publicId);
        if (!started) return;
        if (started.local) {
          // Сборка у себя: файлы качаются сюда, рендер идёт на видеокарте, результат уходит в отчёт — без бота.
          const { runLocalRender } = await import("./local-render.js");
          runLocalRender(publicId, started.selection, overlay, () => startAssemblyWatch(publicId, overlay, true, "", !!started.post));
          return;
        }
        toast(started === "post" ? "Сборка запущена — по готовности откроется редактор поста." : "Сборка запущена — ход виден в карточке ниже.", "success");
        startAssemblyWatch(publicId, overlay, true, "", started === "post");
      } catch (err) {
        toast(`Не удалось запустить сборку: ${err.message}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
    sheet.querySelectorAll("[data-raw-add]").forEach(btn => btn.addEventListener("click", async () => {
      const kind = btn.dataset.rawAdd;
      const filesToAdd = await pickFiles("*/*");
      if (!filesToAdd.length) return;
      btn.disabled = true;
      let uploaded = 0;
      let failure = null;
      for (const file of filesToAdd) {
        try {
          await apiUpload(`/report/${publicId}/raws/${kind}`, file);
          uploaded += 1;
        } catch (e) {
          failure = `${file.name}: ${e.message}`;
          break;
        }
      }
      await render();
      if (failure) toast(uploaded ? `Добавлено ${uploaded} из ${filesToAdd.length}. Не загрузился файл ${failure}` : `Не удалось загрузить: ${failure}`, "error");
      else toast(`Добавлено файлов: ${uploaded}.`, "success");
    }));
    sheet.querySelectorAll("[data-source-dl]").forEach(btn => btn.addEventListener("click", () => {
      downloadAttachment(`report/${publicId}/sources/files/${btn.dataset.sourceDl}/file`, btn.dataset.sourceName);
    }));
    sheet.querySelectorAll("[data-source-add]").forEach(btn => btn.addEventListener("click", async () => {
      const kind = btn.dataset.sourceAdd;
      const filesToAdd = await pickFiles("*/*");
      if (!filesToAdd.length) return;
      btn.disabled = true;
      let uploaded = 0;
      let failure = null;
      for (const file of filesToAdd) {
        try {
          await apiUpload(`/report/${publicId}/sources/${kind}`, file);
          uploaded += 1;
        } catch (e) {
          failure = `${file.name}: ${e.message}`;
          break;
        }
      }
      await render();
      if (failure) toast(uploaded ? `Добавлено ${uploaded} из ${filesToAdd.length}. Не загрузился файл ${failure}` : `Не удалось загрузить: ${failure}`, "error");
      else toast(`Добавлено файлов: ${uploaded}.`, "success");
    }));
    async function addNote() {
      const ta = sheet.querySelector("#note-new");
      const timeInput = sheet.querySelector("#note-time");
      const text = ta.value.trim();
      const file = pendingNoteFile;
      if (!text && !file) return;
      const seconds = secondsFromTimeInput(timeInput.value);
      if (seconds === null) {
        toast("Время — в формате 04:12 или 1:02:03.", "error");
        timeInput.focus();
        return;
      }
      // Время уходит префиксом в сам текст: отдельного поля под него в
      // API заметок нет, а так его увидят и бот, и мини-апп.
      const payload = timeInput.value.trim() ? noteTimePrefix(seconds) + text : text;
      try {
        if (file) await apiUpload(`/report/${publicId}/notes/attach`, file, { text: payload });
        else await apiPost(`/report/${publicId}/notes`, { text: payload });
        pendingNoteFile = null;
        await render();
      } catch (e) { toast(`Не удалось добавить заметку: ${e.message}`, "error"); }
    }
    sheet.querySelector("#note-add")?.addEventListener("click", addNote);
    // Ctrl/Cmd+Enter из самого поля — привычка из Slack/GitHub/Linear:
    // руки уже на клавиатуре после текста заметки, тянуться к кнопке
    // мышью незачем. Обычный Enter не годится — заметки часто
    // многострочные (тайм-коды правок один за другим).
    sheet.querySelector("#note-new")?.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        addNote();
      }
    });
    sheet.querySelector("#btn-qc-track")?.addEventListener("click", async () => {
      const picked = await pickInputFile([{ name: "Аудио/видео", extensions: QC_EXTENSIONS }]);
      if (!picked) return;
      await runQcAnalysis(picked, { reportId: publicId });
    });
    sheet.querySelectorAll("[data-download-file]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const fileId = btn.dataset.downloadFile;
        const savePath = await pickOutputFile(btn.dataset.fileName);
        if (!savePath) return;
        btn.disabled = true;
        try {
          await invoke("download_report_file", {
            reportId: publicId,
            fileId,
            initData: state.token || "",
            savePath,
          });
          toast("Файл сохранён.", "success", {
            label: "📂 Показать в папке",
            onClick: () => revealInFolder(savePath),
          });
        } catch (e) {
          toast(`Не удалось скачать: ${e}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
    });
    sheet.querySelectorAll("[data-delete-file]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const label = btn.dataset.fileName || "файл";
        if (!confirm(`Удалить файл «${label}» из отчёта?`)) return;
        btn.disabled = true;
        try {
          await apiPost(`/report/${publicId}/files/${btn.dataset.deleteFile}/delete`, {});
          toast("Файл удалён.");
          await render();
        } catch (e) {
          toast(`Не удалось удалить файл: ${e.message}`, "error");
          btn.disabled = false;
        }
      });
    });
    // Плеер: создаётся по первому «▶ Слушать» и дальше просто
    // переставляется в новую разметку после каждой перерисовки.
    const audioFiles = files.files.filter(isAudioFile);
    const playerHost = sheet.querySelector("#rd-player-host");
    if (player && playerHost) {
      playerHost.appendChild(player.el);
      player.setFiles(audioFiles);
      player.setNotes(notes.notes);
      player.refresh();
    }
    sheet.querySelectorAll("[data-play-file]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!player) {
          player = createPlayer({
            publicId,
            readOnly: !canEdit,
            onAddNote: async (seconds, text) => {
              await apiPost(`/report/${publicId}/notes`, { text: noteTimePrefix(seconds) + text });
              await render();
            },
            onClose: () => { player = null; },
          });
        }
        playerHost.appendChild(player.el);
        player.setFiles(audioFiles);
        player.setNotes(notes.notes);
        player.open(Number(btn.dataset.playFile));
        player.el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    if (canEdit) sheet.querySelectorAll("[data-qc-file]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const fileId = btn.dataset.qcFile;
        btn.disabled = true;
        btn.textContent = "Анализ…";
        try {
          const res = await apiPost(`/report/${publicId}/files/${fileId}/qc`, {});
          const resultEl = sheet.querySelector(`#qc-result-${fileId}`);
          // Сервер отдаёт {file_label, result: {issues, duration, error}}
          // (см. miniapp/server.py::api_qc_file) — не {findings}.
          const result = res.result || {};
          const issues = result.issues || [];
          resultEl.innerHTML = issues.length
            ? issues.map(i => `<div class="qc-finding warn"><span class="tag">${esc(QC_FINDING_LABELS_RU[i.kind] || i.kind || "?")}</span><div><div class="time">${formatRange(i.start, i.end)}</div><div>${esc(i.detail || "")}</div></div></div>`).join("")
            : `<div style="color:var(--s-done); font-size:12px;">✓ Замечаний не найдено</div>`;
          if (result.error) {
            resultEl.innerHTML += `<div style="color:var(--s-stop); font-size:12px; margin-top:6px;">${esc(result.error)}</div>`;
          }
        } catch (e) {
          toast(`AI-проверка не удалась: ${e.message}`, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "AI-проверка";
        }
      });
    });
  }

  await render();
}

function checklistItemHtml(item, editable = true) {
  return `<div class="checklist-item ${item.done ? "done" : ""}" data-id="${item.id}">
    ${editable ? `<input type="checkbox" ${item.done ? "checked" : ""} tabindex="-1">` : `<span class="rd-check-readonly" aria-label="${item.done ? "Готово" : "Не готово"}">${item.done ? "✓" : "○"}</span>`}
    <span style="flex:1;">${esc(item.text)}</span>
    ${editable ? `<button class="icon-btn" data-checklist-del="${item.id}" title="Удалить">✕</button>` : ""}
  </div>`;
}

function noteHtml(n) {
  const t = parseNoteTime(n.text);
  // Подпись «📎 имя» сервер ставит сам, когда заметка — только файл
  // (её видно в боте); здесь вместо неё показывается само вложение.
  const autoCaption = n.attach && n.text === `📎 ${n.attach.name}`;
  const body = autoCaption ? "" : (t ? t.rest : n.text);
  return `<div class="note-item${t ? " timed" : ""}">
    <div class="meta">${esc(n.author)} · ${esc(n.created_at || "")}</div>
    <div class="note-body">
      ${t ? `<span class="note-time" title="время на дорожке">${esc(t.label)}</span>` : ""}
      ${body ? `<span>${linkifyProject(esc(body))}</span>` : ""}
    </div>
    ${n.attach ? `<div class="note-att">${attachHtml(n.attach)}</div>` : ""}
  </div>`;
}

// Текущая цепочка пайплайна (только чтение) + «передать дальше», если
// есть следующий этап — отдельно от черновика-билдера ниже (тот
// пересобирает цепочку целиком, этот просто двигает текущий указатель).
function pipelineAdvanceHtml(pipeline, assignable, canEdit = true, canAdvance = false) {
  if (!pipeline || !pipeline.length) return "";
  if (!canEdit && !canAdvance) return "";
  const curIdxs = pipeline.map((s, i) => (s.current ? i : -1)).filter(i => i !== -1);
  if (!curIdxs.length) return "";
  const lastCur = curIdxs[curIdxs.length - 1];
  if (lastCur >= pipeline.length - 1) return "";
  const who = curIdxs.map(i => `<b>${esc(pipeline[i].role)}</b>${pipeline[i].user_name ? ` (${esc(pipeline[i].user_name)})` : ""}`).join(", ");
  // Исполнитель этапа (даббер) передаёт сам, без выбора человека: следующего
  // сервер находит по цепочке и составу тайтла. Выбор — только у админа.
  const picker = canEdit
    ? `<select id="pipeline-next-user" class="field-input">${userOptionsHtml(assignable, null)}</select>`
    : "";
  return `<div class="rd-pass">
      <span>Сейчас — ${who}. Дальше — <b>${esc(pipeline[lastCur + 1].role)}</b>:</span>
      ${picker}
      <button class="btn primary" id="btn-pipeline-advance">${curIdxs.length > 1 ? "Все сдали — передать дальше" : "Передать дальше"}</button>
    </div>`;
}

// Основной путь статусов («ветки» отчёта) для шапки карточки;
// «перезапись/дозапись» и «отменено» — боковые, рисуются отдельно.
const STATUS_PATH = [["draft", "Черновик"], ["review", "Озвучка"], ["working", "В работе"], ["completed", "Готово"]];

// Пайплайн шкалой этапов: кто на каком этапе, пройденное закрашено,
// линия доходит до текущего этапа.
// Одинаковые роли подряд (Даббер → Даббер → Даббер) и весь пайплайн «без очереди» — один общий этап: работают одновременно.
// Группировка та же, что на сервере (database.pipeline_stage_bounds).
function pipelineGroups(pipeline, parallel) {
  const key = role => { const k = String(role || "").trim().toLowerCase().split("ё").join("е"); return k.startsWith("даббер") ? "даббер" : k; };
  const groups = [];
  pipeline.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && (parallel || key(pipeline[last[0]].role) === key(s.role))) last.push(i);
    else groups.push([i]);
  });
  return groups;
}

function pipelineTimelineHtml(pipeline, parallel = false) {
  const groups = pipelineGroups(pipeline, parallel);
  const curGroup = groups.findIndex(g => g.some(i => pipeline[i].current));
  const at = curGroup !== -1 ? curGroup : groups.filter(g => g.every(i => pipeline[i].done)).length;
  const p = groups.length > 1 ? Math.min(at, groups.length - 1) / (groups.length - 1) : 0;
  return `<div class="rd-timeline" style="--n:${groups.length};--p:${p}">${groups.map((g, gi) => {
    const done = g.every(i => pipeline[i].done);
    const cur = g.some(i => pipeline[i].current);
    return `
    <div class="rd-tl${done ? " done" : ""}${cur ? " cur" : ""}">
      <span class="rd-tl-dot">${done ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>` : gi + 1}</span>
      ${g.map(i => `<div class="rd-tl-ent"><div class="rd-tl-t">${esc(pipeline[i].role)}</div><div class="rd-tl-p">${pipeline[i].user_name ? esc(pipeline[i].user_name) : "не выбран"}</div></div>`).join("")}
      ${g.length > 1 ? `<div class="rd-tl-par">одновременно</div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

// История и активность — прямо во вкладке карточки: первые 20 событий,
// дальше — прежняя отдельная шторка с «Показать ещё».
async function fillLogPanel(panel, publicId, kind) {
  if (panel.dataset.loaded) return;
  panel.dataset.loaded = "1";
  panel.innerHTML = dialogSkeletonHtml(4);
  let res;
  try {
    res = await apiGet(`/report/${publicId}/${kind}`, { offset: 0, page_size: 20 });
  } catch (e) {
    panel.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
    delete panel.dataset.loaded;
    return;
  }
  const evs = res.events || [];
  panel.innerHTML = `<div class="pf-acts">${evs.map(ev => `
    <div class="pf-act"><i></i><div>
      <div class="a">${kind === "history" ? esc(ev.new_status_label || "") + (ev.comment ? ` <span>· ${esc(ev.comment)}</span>` : "") : esc(ev.action || "") + (ev.detail ? ` <span>· ${esc(ev.detail)}</span>` : "")}</div>
      <div class="m">${esc(ev.actor || "")} · ${esc(String(ev.created_at || "").slice(0, 16))}</div>
    </div></div>`).join("") || `<div class="pf-quiet">Пока пусто</div>`}</div>
    ${res.has_more ? `<button class="pf-link" data-log-more style="margin-top:10px;">показать всё →</button>` : ""}`;
  panel.querySelector("[data-log-more]")?.addEventListener("click", () => openReportLogSheet(publicId, kind));
}

// Скачивание — кнопка, а не <a href>. Ссылка с target="_blank" внутри
// webview вообще ничего не открывает (окно создавать некому), а токен
// в ней уезжал в query-строку — то есть в логи сервера. Теперь файл
// тянет Rust-команда download_report_file (токен заголовком), путь
// выбирает нативный диалог сохранения.
// Тип проверяем и по file_type, и по имени: file_type у файла,
// присланного документом, приходит "document" — и mp3 внутри него
// раньше оставался без кнопки AI-проверки, потому что || до имени
// просто не доходил.
const VIDEO_NAME_RE = /\.(mkv|mp4|mov|avi|webm|m4v|ts)$/i;

// «Производство финала»: четыре шага со статусом и одной кнопкой на шаг. Кнопки сохраняют прежние id —
// их обработчики (Nyaa, сборка, добавление файла) остались как были.
function productionHtml(detail, fileList) {
  if (!can("reports.assemble") && !can("reports.files")) return "";
  const list = fileList || [];
  const hasFinal = list.some(f => /_final\./i.test(f.file_name || ""));
  const hasVideo = hasFinal || list.some(f => f.file_type === "video" || VIDEO_NAME_RE.test(f.file_name || ""));
  const hasSubs = list.some(f => /\.(ass|ssa|srt)$/i.test(f.file_name || ""));
  const hasAudio = list.some(f => AUDIO_RE.test(f.file_type || "") || AUDIO_RE.test(f.file_name || ""));
  const step = (n, title, state, label, body) => `
    <div class="rd-fs ${state}">
      <span class="rd-fs-n">${state === "done" ? "✓" : n}</span>
      <b>${title}</b>
      <small>${label}</small>
      <div class="rd-fs-act">${body}</div>
    </div>`;
  const nyaa = can("reports.files") ? `<button class="rd-add" id="report-nyaa" title="Найти раздачу на Nyaa, сервер скачает видео и прикрепит к отчёту">🌐 Видео с Nyaa</button>` : "";
  const assemble = can("reports.assemble") ? `<button class="rd-add primary" id="report-assemble">🎬 Собрать финал</button>` : "";
  const post = can("posts.manage") && hasFinal ? `<button class="rd-add" id="report-post">📣 Пост в канал</button>` : "";
  return `
  <div class="rd-sec rd-prod" id="rd-prod">
    <h3>Производство финала</h3>
    <div class="rd-flow">
      ${step(1, "Видео", hasVideo ? "done" : "todo", hasFinal ? "финал есть" : hasVideo ? "прикреплено" : "нужно", nyaa || "")}
      ${step(2, "Субтитры и звук", hasSubs || hasAudio ? "done" : "opt", [hasSubs ? "субтитры" : "", hasAudio ? "озвучка" : ""].filter(Boolean).join(" · ") || "необязательно", "")}
      ${step(3, "Сборка", hasFinal ? "done" : hasVideo ? "todo" : "wait", hasFinal ? "готово" : hasVideo ? "можно собирать" : "ждёт видео", assemble)}
      ${step(4, "Пост", hasFinal ? "todo" : "wait", hasFinal ? "можно готовить" : "после сборки", post)}
    </div>
    <div id="rd-prod-asm"></div>
  </div>`;
}

// Категории файлов одной сеткой: с файлами — списком, пустые — компактной кнопкой «+ название».
function rawKindsHtml(kinds, { canAdd, addAttr, dlAttr }) {
  const filled = kinds.filter(k => k.entries.length);
  const empty = kinds.filter(k => !k.entries.length);
  const row = (k, f) => dlAttr === "raw"
    ? `<div class="raw-row on">
        <span class="raw-name">${esc(f.name || "файл")}${f.character_name ? ` · ${esc(f.character_name)}` : (f.character_id ? ` · персонаж #${Number(f.character_id)}` : "")}</span>
        <button class="icon-btn" data-raw-dl="${esc(k.kind)}" data-raw-id="${f.id == null ? "" : esc(f.id)}" data-raw-legacy="${f.legacy || f.id == null ? "1" : "0"}" data-raw-character="${Number(f.character_id || 0)}" data-raw-name="${esc(f.name || k.kind)}" title="Скачать">⬇️</button>
      </div>`
    : `<div class="raw-row on">
        <span class="raw-name">${esc(f.name || "файл")}</span>
        <button class="icon-btn" data-source-dl="${esc(f.id)}" data-source-name="${esc(f.name || k.kind)}" title="Скачать">⬇️</button>
      </div>`;
  return `
  <div class="raw-list">${filled.map(k => `
    <section class="raw-kind">
      <div class="raw-kind-head">
        <span class="raw-label">${esc(k.label)}</span>
        <span class="raw-kind-count">${k.entries.length}</span>
        ${canAdd ? `<button class="rd-add" ${addAttr}="${esc(k.kind)}">+ Добавить файлы</button>` : ""}
      </div>
      ${k.entries.map(f => row(k, f)).join("")}
    </section>`).join("")}</div>
  ${empty.length ? `<div class="rd-chips">${empty.map(k => canAdd
    ? `<button class="rd-chip" ${addAttr}="${esc(k.kind)}" title="Добавить файлы: ${esc(k.label)}">+ ${esc(k.label)}</button>`
    : `<span class="rd-chip off">${esc(k.label)}</span>`).join("")}</div>` : ""}`;
}

function fileHtml(f, canEdit = true) {
  const audioRe = AUDIO_RE;
  const isAudio = audioRe.test(f.file_type || "") || audioRe.test(f.file_name || "");
  return `<div class="file-item">
    <div>${esc(FILE_ICONS[f.file_type] || "📎")} ${esc(f.file_name || f.file_type)} <span class="meta">${esc(f.file_size_label || "")}</span></div>
    ${isAudio ? `<button class="btn primary" style="padding:4px 10px; font-size:12px;" data-play-file="${f.id}">▶ Слушать</button>` : ""}
    ${isAudio && canEdit ? `<button class="btn" style="padding:4px 10px; font-size:12px;" data-qc-file="${f.id}">AI-проверка</button>` : ""}
    <button class="icon-btn" data-download-file="${f.id}" data-file-name="${esc(f.file_name || "")}" title="Скачать">⬇️</button>
    <button class="icon-btn" data-delete-file="${f.id}" data-file-name="${esc(f.file_name || f.file_type || "")}" title="Удалить файл" aria-label="Удалить файл">🗑</button>
    <div id="qc-result-${f.id}" style="width:100%;"></div>
  </div>`;
}

// История статуса и лента активности отчёта — тот же /history и
// /activity, что и в мини-аппе, листаются кнопкой «Показать ещё»
// (page_size=20, как там же), а не бесконечной прокруткой.
async function openReportLogSheet(publicId, kind) {
  const title = kind === "history" ? "🕓 История" : "📜 Активность";
  const overlay = openSheet(`<h2>${title}</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");

  let offset = 0;
  const pageSize = 20;
  let events = [];

  function eventLineHtml(ev) {
    if (kind === "history") {
      return `<div class="note-item">
        <div class="meta">${esc(ev.actor)} · ${esc(ev.created_at || "")}</div>
        <div>${esc(ev.new_status_label || "")}${ev.comment ? `: ${esc(ev.comment)}` : ""}</div>
      </div>`;
    }
    return `<div class="note-item">
      <div class="meta">${esc(ev.actor)} · ${esc(ev.created_at || "")}</div>
      <div>${esc(ev.action || "")}${ev.detail ? ` — ${esc(ev.detail)}` : ""}</div>
    </div>`;
  }

  async function loadMore() {
    const res = await apiGet(`/report/${publicId}/${kind}`, { offset, page_size: pageSize });
    events = events.concat(res.events || []);
    offset += (res.events || []).length;
    sheet.innerHTML = `
      <h2>${title}</h2>
      <div id="log-list">${events.map(eventLineHtml).join("") || `<div class="no-assignee">Пока пусто</div>`}</div>
      ${res.has_more ? `<div class="sheet-actions"><button class="btn" id="log-more">Показать ещё</button></div>` : ""}
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    const moreBtn = sheet.querySelector("#log-more");
    // try/catch прямо тут: раньше ошибка второй и следующих страниц
    // никем не ловилась (try ниже охватывает только первый вызов) —
    // кнопка навсегда оставалась disabled, а reject уходил в консоль.
    if (moreBtn) moreBtn.addEventListener("click", async () => {
      moreBtn.disabled = true;
      moreBtn.textContent = "Загрузка…";
      try {
        await loadMore();
      } catch (e) {
        toast(`Не удалось загрузить ещё: ${e.message}`, "error");
        moreBtn.disabled = false;
        moreBtn.textContent = "Показать ещё";
      }
    });
  }

  try {
    await loadMore();
  } catch (e) {
    sheet.innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  }
}
