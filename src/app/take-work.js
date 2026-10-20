// «Взять в работу»: окно поверх «Тайтлов». План с сервера
// (/titles/{id}/work-plan): расписание серий, текущий состав, настройки,
// если тайтл уже взят. Сохранение — /titles/{id}/take: состав, дедлайн
// в часах от выхода, приоритет; вышедшие серии заводятся сразу, новые —
// сервер заводит сам по мере выхода и пишет составу в Telegram.

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc } from "./utils.js";
import { imgProxy } from "./title-page.js";
import { loadUsers } from "./tabs.js";

const DEADLINES = [[24, "сутки"], [48, "2 дня"], [72, "3 дня"], [120, "5 дней"], [168, "неделя"]];
const PRIORITIES = [["normal", "Обычный"], ["high", "Высокий"], ["urgent", "Срочный"], ["low", "Низкий"]];
const DEFAULT_ROLES = ["Даббер", "Звукорежиссёр", "Роспись", "Переводчик", "Тайминг"];
const NYAA_QUALITIES = [["any", "Любое качество"], ["480p", "480p"], ["720p", "720p"], ["1080p", "1080p"], ["1440p", "1440p"], ["2160p", "2160p"]];

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function airLine(plan) {
  if (!plan.next_episode_at) return plan.status_label || "";
  const d = new Date(plan.next_episode_at);
  const wd = ["воскресеньям", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам"][d.getDay()];
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `выходит по ${wd} в ${hm} · следующая — ${plan.next_episode}-я, ${shortDate(plan.next_episode_at)}`;
}

function userOptions(selected) {
  const users = state.users || [];
  return `<option value="">— не назначен —</option>` + users.map(u =>
    `<option value="${u.telegram_id}"${String(u.telegram_id) === String(selected || "") ? " selected" : ""}>${esc(u.name)}${u.paused_until ? " (на паузе)" : ""}</option>`).join("");
}

function crewRowHtml(role, telegramId) {
  return `
    <div class="tw-crew-row" data-crew-row>
      <input class="tw-role" value="${esc(role)}" placeholder="Роль" maxlength="40" list="tw-roles" autocomplete="off">
      <select class="tw-user">${userOptions(telegramId)}</select>
      <button type="button" class="icon-btn tw-del" title="Убрать роль" data-crew-del>✕</button>
    </div>`;
}

// Серии к созданию сейчас: вышедшие и ещё не заведённые (последние max_backfill).
function backfillNumbers(plan) {
  return plan.episodes.filter(e => e.aired && !e.exists).map(e => e.n).slice(-plan.max_backfill);
}

function episodesHtml(plan) {
  if (!plan.episodes.length) return `<div class="tw-note">Расписания пока нет — серии можно будет завести вручную на «Доске».</div>`;
  return `<div class="tw-eps">${plan.episodes.map(e => {
    const cls = e.exists ? "exists" : (e.aired ? "aired" : "");
    const sub = e.exists ? "заведена" : (e.aired ? "вышла" : (e.at ? shortDate(e.at) : "—"));
    return `<div class="tw-ep ${cls}" title="${e.at ? new Date(e.at).toLocaleString("ru-RU") : ""}">${e.n}<small>${sub}</small></div>`;
  }).join("")}</div>`;
}

export async function openTakeWork(titleId, onDone) {
  const overlay = openSheet(dialogSkeletonHtml(4), "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("tw-sheet");
  let plan;
  try {
    [plan] = await Promise.all([apiGet(`/titles/${titleId}/work-plan`), state.users && state.users.length ? null : loadUsers()]);
  } catch (e) {
    sheet.innerHTML = `<h2>Взять в работу</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }

  const work = plan.work && plan.work.active ? plan.work : null;
  let nyaaCandidates = [];
  let selectedSource = null;
  // «запомненный рав»: группа и приметы выбранной раздачи; следующие серии подбираются такими же
  let pattern = work && work.nyaa_group ? { group: work.nyaa_group, tags: (work.nyaa_tags || "").split(" ").filter(Boolean), ref: work.nyaa_ref || "" } : null;
  let browseItems = [];
  const crew = plan.crew.length ? plan.crew : DEFAULT_ROLES.map(role => ({ role, telegram_id: null }));
  const hours = work ? work.deadline_hours : plan.deadline_hours_default;
  const priority = work ? work.priority : "high";
  const poster = plan.poster_url ? imgProxy(plan.poster_url) : null;
  const votes = plan.likes + plan.dislikes;
  const meta = [plan.kind_label, plan.studio, plan.episodes_total && `${plan.episodes_total} ${plural(plan.episodes_total, "серия", "серии", "серий")}`].filter(Boolean).join(" · ");

  sheet.innerHTML = `
    <div class="tw-head">
      ${poster ? `<img class="tw-poster" src="${poster}" alt="">` : `<span class="tw-poster tt-poster-ph"></span>`}
      <div class="tw-head-text">
        <span class="tw-chip${work ? " on" : ""}">${work ? "● В работе" : `👍 ${plan.likes} · 👎 ${plan.dislikes}${votes ? ` · ${Math.round(plan.likes / votes * 100)}% за` : ""}`}</span>
        <h2>${work ? "Работа над тайтлом" : "Взять в работу"}: ${esc(plan.name)}</h2>
        <p>${esc([meta, airLine(plan)].filter(Boolean).join(" · "))}</p>
      </div>
      <button class="icon-btn" data-close title="Закрыть">✕</button>
    </div>
    <div class="tw-body">
      <div class="tw-field tw-full">
        <label>Серии${plan.episodes_aired ? ` — вышло ${plan.episodes_aired}` : ""}</label>
        ${episodesHtml(plan)}
      </div>
      <div class="tw-field">
        <label>Дедлайн серии — после выхода</label>
        <div class="tw-seg" data-seg="hours">${DEADLINES.map(([h, l]) => `<button type="button" data-v="${h}" class="${h === hours ? "on" : ""}">${l}</button>`).join("")}</div>
      </div>
      <div class="tw-field">
        <label>Приоритет серий</label>
        <div class="tw-seg" data-seg="priority">${PRIORITIES.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === priority ? "on" : ""}">${l}</button>`).join("")}</div>
      </div>
      <div class="tw-field tw-full">
        <label>Состав — на каждую роль своя задача в каждой серии</label>
        <div class="tw-crew" data-crew>${crew.map(c => crewRowHtml(c.role, c.telegram_id)).join("")}</div>
        <datalist id="tw-roles">${[...new Set([...(plan.roles_suggest || []), ...DEFAULT_ROLES])].map(r => `<option value="${esc(r)}">`).join("")}</datalist>
        <div class="tw-crew-hint" data-crew-hint></div>
        <button type="button" class="btn ghost tw-add" data-crew-add>+ Роль</button>
      </div>
      <div class="tw-field tw-full tw-nyaa">
        <label class="tw-toggle">
          <input type="checkbox" data-nyaa${!work || work.nyaa_enabled ? " checked" : ""}>
          <span><b>Автоматически отправлять раздачи с Nyaa</b><small>Когда выйдет новая серия, бот пришлёт .torrent назначенным участникам. Ссылку можно выбрать и отправить вручную ниже.</small></span>
        </label>
        <div class="tw-pick">
          <button type="button" class="btn" data-nyaa-browse>📚 Выбрать раздачу в каталоге Nyaa</button>
          <div class="tw-pattern" data-pattern></div>
        </div>
        <div class="tw-nyaa-q">
          <input data-nyaa-q autocomplete="off" value="${esc((work && work.nyaa_query) || plan.nyaa_query_default || "")}" placeholder="Название или ссылка Nyaa" maxlength="240">
          <label class="tw-nyaa-episode"><span>Серия</span><input data-nyaa-episode type="number" min="1" max="9999" step="1" value="${plan.episodes_aired || plan.next_episode || 1}"></label>
          <button type="button" class="btn" data-nyaa-test>Найти варианты</button>
        </div>
        <div class="tw-nyaa-options"><label>Качество для новых серий<select data-nyaa-quality>${NYAA_QUALITIES.map(([v, label]) => `<option value="${v}"${v === ((work && work.nyaa_quality) || "1080p") ? " selected" : ""}>${label}</option>`).join("")}</select></label><small>Можно вставить ссылку на страницу раздачи или файл .torrent с nyaa.si / nyaa.land.</small></div>
        <div class="tw-nyaa-res" data-nyaa-res></div>
        <small class="tw-nyaa-send-note" data-nyaa-send-note></small>
      </div>
      <label class="tw-toggle tw-full">
        <input type="checkbox" data-backfill checked>
        <span><b>Завести уже вышедшие серии</b><small data-backfill-note></small></span>
      </label>
      <div class="tw-note tw-full">Новые серии заведутся сами в момент выхода, а состав получит сообщение в Telegram.</div>
    </div>
    <div class="tw-foot">
      ${work ? `<button class="btn ghost" data-stop>Не заводить новые серии</button>` : ""}
      <span class="tw-summary" data-summary></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn primary" data-save>${work ? "Сохранить" : "⚑ Взять в работу"}</button>
    </div>`;

  const val = { hours, priority };
  const backfill = backfillNumbers(plan);
  const summary = () => {
    const on = sheet.querySelector("[data-backfill]").checked;
    const roles = sheet.querySelectorAll("[data-crew-row]").length;
    const eps = on ? backfill.length : 0;
    sheet.querySelector("[data-backfill-note]").textContent = backfill.length
      ? `${backfill.length} ${plural(backfill.length, "серия", "серии", "серий")}: ${backfill.length > 6 ? `${backfill[0]}–${backfill[backfill.length - 1]}` : backfill.join(", ")}`
      : "все вышедшие серии уже заведены";
    sheet.querySelector("[data-summary]").textContent = eps
      ? `Сейчас: ${eps} ${plural(eps, "серия", "серии", "серий")} × ${roles} ${plural(roles, "роль", "роли", "ролей")} = ${eps * roles} ${plural(eps * roles, "задача", "задачи", "задач")}`
      : "Сейчас серии не создаются";
  };
  if (!backfill.length) sheet.querySelector("[data-backfill]").disabled = true;
  // Подсказка по составу: повторы ролей сервер молча отбрасывает, а роль без исполнителя создаст задачу «ничью»
  const crewCheck = () => {
    const rows = [...sheet.querySelectorAll("[data-crew-row]")].map(r => ({ role: r.querySelector(".tw-role").value.trim(), user: r.querySelector(".tw-user").value })).filter(r => r.role);
    const seen = new Set(), dup = [];
    rows.forEach(r => { const k = r.role.toLowerCase(); if (seen.has(k)) dup.push(r.role); seen.add(k); });
    const free = rows.filter(r => !r.user).map(r => r.role);
    const hint = sheet.querySelector("[data-crew-hint]");
    hint.innerHTML = [dup.length ? `<span class="bad">Повтор роли: ${dup.map(esc).join(", ")} — останется одна.</span>` : "", free.length ? `Без исполнителя: ${free.map(esc).join(", ")} — задачи появятся свободными, их возьмёт любой.` : ""].filter(Boolean).join("<br>");
    return { dup, free };
  };
  crewCheck();
  sheet.querySelector("[data-crew]").addEventListener("input", crewCheck);
  sheet.querySelector("[data-crew]").addEventListener("change", crewCheck);
  summary();

  sheet.querySelectorAll("[data-seg]").forEach(seg => seg.addEventListener("click", e => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    val[seg.dataset.seg] = seg.dataset.seg === "hours" ? Number(b.dataset.v) : b.dataset.v;
  }));
  const crewBox = sheet.querySelector("[data-crew]");
  crewBox.addEventListener("click", e => {
    if (!e.target.closest("[data-crew-del]")) return;
    e.target.closest("[data-crew-row]").remove();
    summary();
    crewCheck();
  });
  sheet.querySelector("[data-crew-add]").addEventListener("click", () => {
    crewBox.insertAdjacentHTML("beforeend", crewRowHtml("", null));
    crewBox.lastElementChild.querySelector(".tw-role").focus();
    summary();
  });
  sheet.querySelector("[data-backfill]").addEventListener("change", summary);
  const nyaaRes = sheet.querySelector("[data-nyaa-res]");
  const nyaaSendNote = sheet.querySelector("[data-nyaa-send-note]");
  const clearNyaaSelection = () => {
    selectedSource = null;
    nyaaSendNote.textContent = "";
    nyaaRes.querySelectorAll("[data-nyaa-pick]").forEach(b => { b.classList.remove("selected"); b.setAttribute("aria-pressed", "false"); });
  };
  const clearNyaaResults = () => { clearNyaaSelection(); nyaaCandidates = []; nyaaRes.replaceChildren(); };
  sheet.querySelector("[data-nyaa-q]").addEventListener("input", clearNyaaResults);
  sheet.querySelector("[data-nyaa-episode]").addEventListener("change", clearNyaaResults);
  nyaaRes.addEventListener("click", e => {
    const choice = e.target.closest("[data-nyaa-pick]");
    if (!choice) return;
    const index = Number(choice.dataset.nyaaPick);
    selectedSource = nyaaCandidates[index] || null;
    nyaaRes.querySelectorAll("[data-nyaa-pick]").forEach(b => { const active = b === choice; b.classList.toggle("selected", active); b.setAttribute("aria-pressed", String(active)); });
    nyaaSendNote.textContent = selectedSource ? `Раздача для серии ${sheet.querySelector("[data-nyaa-episode]").value} уйдёт назначенному составу при сохранении.` : "";
  });
  const patternBox = sheet.querySelector("[data-pattern]");
  const paintPattern = () => {
    patternBox.innerHTML = pattern
      ? `<span class="tw-pattern-on">Запомнено: <b>${esc(pattern.group || "любая группа")}</b>${pattern.tags.length ? ` · ${esc(pattern.tags.slice(0, 5).join(" · "))}` : ""}</span><small title="${esc(pattern.ref || "")}">${esc((pattern.ref || "").slice(0, 90))}</small><button type="button" class="tw-pattern-x" data-pattern-clear title="Забыть выбор">✕ забыть</button>`
      : `<small>Раздача не выбрана: следующие серии подбираются по названию и качеству.</small>`;
  };
  paintPattern();
  patternBox.addEventListener("click", e => { if (e.target.closest("[data-pattern-clear]")) { pattern = null; paintPattern(); } });
  sheet.querySelector("[data-nyaa-browse]").addEventListener("click", async e => {
    const btn = e.target.closest("button");
    btn.disabled = true;
    clearNyaaSelection();
    nyaaRes.classList.remove("bad");
    nyaaRes.textContent = "Открываю каталог Nyaa…";
    try {
      const r = await apiGet(`/titles/${titleId}/nyaa-browse`, { q: sheet.querySelector("[data-nyaa-q]").value.trim() });
      browseItems = r.items || [];
      nyaaRes.innerHTML = browseItems.length
        ? `<div class="tw-nyaa-results-head">«${esc(r.query)}» · ${browseItems.length} раздач. Выберите ту, которую брать как образец: запомню группу и формат.</div><div class="tw-nyaa-results">${browseItems.map((it, i) => `<button type="button" class="tw-nyaa-pick" data-browse-pick="${i}">
            <span class="tw-g">${esc(it.group || "—")}</span><b>${esc(it.show || it.title)}${it.episode != null ? ` · серия ${it.episode}` : ""}</b>
            <small>${esc([it.resolution, (it.tags || []).slice(0, 4).join(" "), it.size, it.seeders != null ? `${it.seeders} сидов` : ""].filter(Boolean).join(" · "))}</small></button>`).join("")}</div>`
        : `По запросу «${esc(r.query)}» ничего нет. Поправьте название в поле ниже и нажмите ещё раз.`;
      nyaaRes.classList.toggle("bad", !browseItems.length);
    } catch (err) {
      nyaaRes.textContent = `Не удалось открыть каталог: ${err.message}`;
      nyaaRes.classList.add("bad");
    } finally {
      btn.disabled = false;
    }
  });
  nyaaRes.addEventListener("click", e => {
    const pick = e.target.closest("[data-browse-pick]");
    if (!pick) return;
    const it = browseItems[Number(pick.dataset.browsePick)];
    if (!it) return;
    nyaaRes.querySelectorAll("[data-browse-pick]").forEach(b => b.classList.toggle("selected", b === pick));
    pattern = { group: it.group || "", tags: it.tags || [], ref: it.title };
    if (it.show) sheet.querySelector("[data-nyaa-q]").value = it.show;      // название — как у этой группы, а не из базы
    if (it.episode != null) sheet.querySelector("[data-nyaa-episode]").value = it.episode;
    // раздачу уже вышедшей серии отправляем составу сразу; старые серии — только запоминаем формат
    const latest = Math.max(plan.episodes_aired || 0, 1);
    if (it.episode != null && it.episode >= latest) {
      selectedSource = { url: it.url, title: it.title };
      nyaaSendNote.textContent = `Раздача серии ${it.episode} уйдёт назначенному составу при сохранении; следующие серии — такие же (${it.group || "та же раздача"}).`;
    } else {
      selectedSource = null;
      nyaaSendNote.textContent = `Запомнил формат: ${it.group || "без группы"}. Эту серию отправлять не буду, следующие подберу такими же.`;
    }
    paintPattern();
  });
  sheet.querySelector("[data-nyaa-test]").addEventListener("click", async e => {
    const btn = e.target.closest("button");
    btn.disabled = true;
    clearNyaaSelection();
    nyaaRes.textContent = "Ищу варианты на Nyaa…";
    nyaaRes.classList.remove("bad");
    try {
      const episode = Number(sheet.querySelector("[data-nyaa-episode]").value);
      if (!Number.isInteger(episode) || episode < 1 || episode > 9999) throw new Error("Укажите номер серии от 1 до 9999.");
      const r = await apiGet(`/titles/${titleId}/nyaa-test`, { q: sheet.querySelector("[data-nyaa-q]").value.trim(), ep: episode, quality: sheet.querySelector("[data-nyaa-quality]").value });
      nyaaCandidates = r.results || (r.found ? [r.found] : []);
      nyaaRes.innerHTML = nyaaCandidates.length
        ? `<div class="tw-nyaa-results-head">Серия ${r.episode} · ${nyaaCandidates.length} ${plural(nyaaCandidates.length, "вариант", "варианта", "вариантов")}</div><div class="tw-nyaa-results">${nyaaCandidates.map((x, i) => `<button type="button" class="tw-nyaa-candidate" data-nyaa-pick="${i}" aria-pressed="false"><span><b>${esc(x.title)}</b><small>${esc(x.size || "Размер не указан")} · 🌱 ${esc(x.seeders || 0)} сидов${x.trusted ? " · trusted" : ""}</small></span><i>${esc(x.resolution || "качество не указано")}</i></button>`).join("")}</div>`
        : `Для серии ${r.episode} по запросу «${esc(r.query)}» вариантов нет. Проверьте название, номер серии или ссылку Nyaa.`;
      nyaaRes.classList.toggle("bad", !nyaaCandidates.length);
    } catch (err) {
      nyaaRes.textContent = `Не удалось проверить: ${err.message}`;
      nyaaRes.classList.add("bad");
    } finally {
      btn.disabled = false;
    }
  });
  sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));

  sheet.querySelector("[data-stop]")?.addEventListener("click", async e => {
    if (!confirm("Больше не заводить новые серии этого тайтла автоматически? Уже заведённые останутся.")) return;
    e.target.disabled = true;
    try {
      await apiPost(`/titles/${titleId}/work/stop`, {});
      toast("Новые серии больше не заводятся автоматически.");
      overlay.remove();
      onDone && onDone();
    } catch (err) {
      e.target.disabled = false;
      toast(err.message, "error");
    }
  });

  sheet.querySelector("[data-save]").addEventListener("click", async e => {
    const rows = [...sheet.querySelectorAll("[data-crew-row]")].map(r => ({
      role: r.querySelector(".tw-role").value.trim(),
      telegram_id: r.querySelector(".tw-user").value || null,
    })).filter(r => r.role);
    if (!rows.length) { toast("Добавьте в состав хотя бы одну роль.", "error"); return; }
    const { dup } = crewCheck();
    if (dup.length) { toast(`Роль повторяется: ${dup.join(", ")}. Оставьте одну или переименуйте.`, "error"); return; }
    const btn = e.target.closest("button");
    btn.disabled = true;
    btn.textContent = "Сохраняю…";
    try {
      const r = await apiPost(`/titles/${titleId}/take`, {
        crew: rows,
        deadline_hours: val.hours,
        priority: val.priority,
        backfill: sheet.querySelector("[data-backfill]").checked,
        nyaa: sheet.querySelector("[data-nyaa]").checked,
        nyaa_query: sheet.querySelector("[data-nyaa-q]").value.trim(),
        nyaa_quality: sheet.querySelector("[data-nyaa-quality]").value,
        nyaa_pattern: pattern,
        manual_release: selectedSource ? { episode: Number(sheet.querySelector("[data-nyaa-episode]").value), url: selectedSource.url, title: selectedSource.title } : null,
      });
      const n = r.created_episodes.length;
      const workMessage = n
        ? `«${plan.name}» в работе: ${n} ${plural(n, "серия", "серии", "серий")}, ${r.reports} ${plural(r.reports, "задача", "задачи", "задач")}.`
        : `«${plan.name}» в работе. Новые серии заведутся сами.`;
      const releaseMessage = r.release_requested
        ? r.release_sent
          ? r.release_recipients === r.release_targets
            ? `Раздача доставлена ${r.release_recipients} участникам.`
            : `Раздача доставлена ${r.release_recipients} из ${r.release_targets}; остальным отправить не удалось.`
          : "Не удалось отправить раздачу в личные сообщения; задачи сохранены. Проверьте, что участники начали чат с ботом."
        : "";
      const releaseFailed = r.release_requested && r.release_recipients !== r.release_targets;
      toast([workMessage, releaseMessage].filter(Boolean).join(" "), releaseFailed ? "error" : undefined);
      overlay.remove();
      onDone && onDone();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = work ? "Сохранить" : "⚑ Взять в работу";
      toast(err.message, "error");
    }
  });
}
