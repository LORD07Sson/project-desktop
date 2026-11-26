
import { voiceSlotHtml, hydrateVoice, retargetVoiceSlot, openVoicePicker } from "./voice-sample.js";
import { apiGet, apiPost, apiUpload, openSheet, toast, dialogSkeletonHtml, mediaUrl, askConfirm, askText } from "./api.js";
import { pickFile } from "./attachments.js";
import { pauseSuffix } from "./people.js";
import { esc } from "./utils.js";
import { enhanceSelects } from "./fancy-select.js";
import { loadWatermark, watermarkSectionHtml, wireWatermarkSection } from "./watermark-editor.js";
import { invoke, pickOutputFile } from "./tauri.js";
import { decodeSubs } from "./subs-core.js";
import { assActors, planImport, applyDubbers, countDubberLines } from "./subs-actors-core.js";

function seriesCount(n) {
  const mod10 = n % 10, mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "серия" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "серии" : "серий";
  return `${n} ${word}`;
}

function airedText(t) {
  if (t.episodes_aired == null && t.episodes_total == null) return "";
  return `вышло ${t.episodes_aired ?? 0} / ${t.episodes_total ?? "?"} эп. · `;
}

function imgProxy(url) {
  return url ? mediaUrl("/img_proxy", { url }) : "";
}

let META_ROLES_CACHE = null;
export async function loadRoles() {
  if (META_ROLES_CACHE) return META_ROLES_CACHE;
  try { META_ROLES_CACHE = (await apiGet("/meta")).roles || []; } catch (_) { META_ROLES_CACHE = []; }
  return META_ROLES_CACHE;
}

let ASSIGNABLE_CACHE = null;
export async function loadAssignable() {
  if (ASSIGNABLE_CACHE) return ASSIGNABLE_CACHE;
  try { ASSIGNABLE_CACHE = (await apiGet("/assignable-users")).users || []; } catch (_) { ASSIGNABLE_CACHE = []; }
  return ASSIGNABLE_CACHE;
}

export function clearDirectoryCache() {
  META_ROLES_CACHE = null;
  ASSIGNABLE_CACHE = null;
}

export function userOptionsHtml(users, selectedTelegramId) {
  const label = u => {
    const name = String(u.name || "").trim();
    if (!u.username) return name;
    return !name || name.toLowerCase() === String(u.username).toLowerCase() ? String(u.username) : `${name} (@${u.username})`;
  };
  const sorted = [...users].sort((a, b) => label(a).localeCompare(label(b), "ru", { sensitivity: "base" }));
  return `<option value="">— не назначен —</option>` + sorted.map(u =>
    `<option value="${u.telegram_id}" ${String(u.telegram_id) === String(selectedTelegramId) ? "selected" : ""}>${esc(label(u))}${esc(pauseSuffix(u))}</option>`
  ).join("");
}


export async function openSeasonsAdminSheet(onClose) {
  const overlay = openSheet(`<h2>Управление тайтлами</h2>${dialogSkeletonHtml(5)}`, "wide");
  const sheet = overlay.querySelector(".sheet");

  if (onClose) {
    new MutationObserver((_muts, obs) => {
      if (!overlay.isConnected) { obs.disconnect(); onClose(); }
    }).observe(document.body, { childList: true });
  }

  async function render() {
    let d;
    try {
      d = await apiGet("/seasons");
    } catch (e) {
      sheet.innerHTML = `<h2>Управление тайтлами</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const rows = (d.seasons || []).map(s => `
      <div class="mini-row" data-open-season="${s.id}" style="cursor:pointer;">
        <span class="name">${esc(s.name)}</span>
        <span class="val">${s.titles_count} тайтлов</span>
        <button class="icon-btn" data-rename-season="${s.id}" data-season-name="${esc(s.name)}" title="Переименовать">✏️</button>
        <button class="icon-btn" data-delete-season="${s.id}" title="Удалить">✕</button>
      </div>
    `).join("");
    sheet.innerHTML = `
      <h2>Управление тайтлами</h2>
      <div class="detail-section">
        <h3>Эфир-сезоны</h3>
        <div>${rows || `<div class="no-assignee">Сезонов пока нет</div>`}</div>
        <div class="add-row">
          <input id="season-new" placeholder="Название сезона, например «Лето 2026»…">
          <button class="btn" id="season-add">+</button>
        </div>
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-open-season]").forEach(row => {
      row.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-rename-season],[data-delete-season]")) return;
        openSeasonDetailAdmin(parseInt(row.dataset.openSeason, 10));
      });
    });
    sheet.querySelectorAll("[data-rename-season]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const name = await askText("Новое название сезона", btn.dataset.seasonName, { placeholder: "Например, «Лето 2026»" });
        if (!name) return;
        try {
          await apiPost(`/seasons/${btn.dataset.renameSeason}/rename`, { name });
          toast("Переименовано.");
          await render();
        } catch (e) { toast(`Не удалось переименовать: ${e.message}`, "error"); }
      });
    });
    sheet.querySelectorAll("[data-delete-season]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!await askConfirm("Удалить сезон? Это возможно только если в нём нет тайтлов.")) return;
        try {
          await apiPost(`/seasons/${btn.dataset.deleteSeason}/delete`, {});
          toast("Сезон удалён.");
          await render();
        } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
      });
    });
    sheet.querySelector("#season-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#season-new");
      const name = input.value.trim();
      if (!name) return;
      try {
        await apiPost("/seasons", { name });
        input.value = "";
        toast("Сезон создан.");
        await render();
      } catch (e) { toast(`Не удалось создать: ${e.message}`, "error"); }
    });
  }

  await render();
}


async function openSeasonDetailAdmin(seasonId) {
  const overlay = openSheet(dialogSkeletonHtml(5), "wide");
  const sheet = overlay.querySelector(".sheet");

  async function render() {
    let d;
    try {
      d = await apiGet(`/seasons/${seasonId}`);
    } catch (e) {
      sheet.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const rows = (d.titles || []).map(t => `
      <div class="mini-row" data-open-title="${t.id}" style="cursor:pointer;">
        <span class="name">${esc(t.name)}</span>
        <span class="val" title="Вышло в эфире (Shikimori) · серии, заведённые студией · состав">${airedText(t)}${t.pct != null ? `${t.pct}%` : "—"} · ${seriesCount(t.episodes_count)} у студии · ${t.crew_count} в составе</span>
      </div>
    `).join("");
    sheet.innerHTML = `
      <h2>${esc(d.name)}</h2>
      <div class="detail-section">
        <h3>Тайтлы</h3>
        <div>${rows || `<div class="no-assignee">Тайтлов пока нет</div>`}</div>
        <div class="add-row">
          <input id="title-new" placeholder="Название тайтла…">
          <button class="btn" id="title-add">+</button>
        </div>
        <div class="add-row" style="margin-top:6px;">
          <input id="title-shiki" placeholder="…или ссылка на Shikimori (shikimori.one, .io, .me — /animes/…)">
          <button class="btn" id="title-shiki-add">Добавить</button>
        </div>
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-open-title]").forEach(row => {
      row.addEventListener("click", () => openTitleAdminDetail(parseInt(row.dataset.openTitle, 10), () => render()));
    });
    sheet.querySelector("#title-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#title-new");
      const name = input.value.trim();
      if (!name) return;
      try {
        await apiPost(`/seasons/${seasonId}/titles`, { name });
        input.value = "";
        toast("Тайтл создан.");
        await render();
      } catch (e) { toast(`Не удалось создать: ${e.message}`, "error"); }
    });
    sheet.querySelector("#title-shiki-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#title-shiki");
      const raw = input.value.trim();
      if (!raw) return;
      const shikiId = parseShikimoriId(raw);
      if (!shikiId) {
        toast("Не похоже на ссылку Shikimori — вставьте адрес страницы тайтла (…/animes/59193-…) или его номер.", "error");
        return;
      }
      const btn = sheet.querySelector("#title-shiki-add");
      btn.disabled = true;
      btn.textContent = "Добавляю…";
      try {
        const res = await apiPost(`/seasons/${seasonId}/titles/from-shikimori`, { url: String(shikiId) });
        input.value = "";
        toast(`Тайтл создан: ${res.name}${res.characters_count ? ` · ${res.characters_count} персонажей` : ""}`);
        await render();
      } catch (e) {
        toast(`Не удалось добавить по ссылке: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Добавить";
      }
    });
  }

  await render();
}

export function parseShikimoriId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const bare = /^z?(\d+)(?:-[\w-]*)?$/i.exec(raw);
  if (bare) return Number(bare[1]);
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (_) {
    return null;
  }
  if (!/(^|\.)shikimori\.[a-z]+$/i.test(url.hostname)) return null;
  const m = /\/animes\/z?(\d+)/i.exec(url.pathname);
  return m ? Number(m[1]) : null;
}


export async function openTitleAdminDetail(titleId, onClose, section) {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  const sheet = overlay.querySelector(".sheet");

  if (onClose) {
    new MutationObserver((_muts, obs) => {
      if (!overlay.isConnected) { obs.disconnect(); onClose(); }
    }).observe(document.body, { childList: true });
  }

  async function render() {
    let d, roles, assignable, wm, intro;
    try {
      [d, roles, assignable] = await Promise.all([apiGet(`/titles/${titleId}`), loadRoles(), loadAssignable()]);
      wm = await loadWatermark(titleId);
      intro = await apiGet(`/titles/${titleId}/intro`).catch(() => ({ has: false, name: null }));
    } catch (e) {
      sheet.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }

    const posterSrc = imgProxy(d.poster_url);
    const posterHtml = posterSrc
      ? `<img src="${posterSrc}" alt="" style="width:80px; height:110px; object-fit:cover; border-radius:8px;">`
      : `<div style="width:80px; height:110px; border-radius:8px; background:var(--surface-2); display:flex; align-items:center; justify-content:center; font-size:28px;">🎬</div>`;

    const crewRows = (d.crew || []).map(c => `
      <div class="mini-row">
        <span class="name">${esc(c.role)}</span>
        <span class="val">${esc(c.name || "не назначен")}</span>
        <button class="icon-btn" data-crew-remove="${esc(c.role)}" title="Убрать роль">✕</button>
      </div>
    `).join("");

    const charRows = (d.characters || []).map(c => `
      <div class="mini-row" data-char="${c.id}">
        <span class="name">${esc(c.name)}${c.original_va_name ? ` <span class="meta" style="color:var(--ink-dim); font-size:11px;">(ориг. ${esc(c.original_va_name)})</span>` : ""}</span>
        <select class="field-input people-pick" data-char-voice="${c.id}" style="max-width:180px;">${userOptionsHtml(assignable, c.voiced_by ? c.voiced_by.telegram_id : null)}</select>
        ${voiceSlotHtml(c.voiced_by ? c.voiced_by.telegram_id : "", { mini: true })}
        <button class="icon-btn" data-char-listen="${c.id}" title="Выбрать, прослушав голоса">🎧</button>
        <button class="icon-btn" data-char-delete="${c.id}" title="Удалить персонажа">✕</button>
      </div>
    `).join("");

    const episodeRows = (d.episode_groups || []).map(g => `
      <div class="mini-row">
        <span class="name">${esc(g.label)}</span>
        <span class="val">${g.completed}/${g.total} готово · ${g.pct}%</span>
      </div>
    `).join("");

    sheet.innerHTML = `
      <div class="detail-head">
        <h2>${esc(d.name)}</h2>
        <button class="icon-btn" data-close style="flex:none;">✕</button>
      </div>
      <div class="detail-id">${esc(d.season_name || "")} · создан ${esc(d.created_at || "")}</div>

      <div class="detail-section" style="display:flex; gap:14px;">
        ${posterHtml}
        <div style="flex:1;">
          <div class="add-row">
            <input id="meta-search-q" placeholder="Название для поиска на Shikimori/AniList…" value="${esc(d.name)}">
            <button class="btn" id="meta-search-btn">Найти</button>
          </div>
          <div id="meta-candidates"></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Состав</h3>
        <div id="crew-list">${crewRows || `<div class="no-assignee">Состав пуст</div>`}</div>
        <div class="add-row">
          <select id="crew-role-new" class="field-input"><option value="">— роль —</option>${roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select>
          <select id="crew-user-new" class="field-input people-pick">${userOptionsHtml(assignable, null)}</select>
          <button class="btn" id="crew-add">Назначить</button>
        </div>
      </div>

      <div class="detail-section">
        <h3>Персонажи ${d.characters.length ? `(${d.characters.length})` : ""}</h3>
        <div id="char-list">${charRows || `<div class="no-assignee">Персонажей пока нет — найдите тайтл на Shikimori/AniList выше и подтвердите</div>`}</div>
        ${d.characters.length ? `<div class="add-row" style="margin-top:8px; flex-wrap:wrap;">
          <button class="btn" id="char-import-ass" title="Взять пары «персонаж — даббер» из поля Actor и назначить дабберов">⤓ Импорт актёров из .ass</button>
          <button class="btn" id="char-mark-ass" title="Проставить дабберов в поле Actor каждой реплики и сохранить копию файла">✎ Разметить .ass дабберами</button>
          <button class="btn ghost" id="char-delete-all" style="margin-left:auto;">Удалить всех персонажей</button>
        </div>` : ""}
      </div>

      <div class="detail-section">
        <h3>Серии ${d.episode_groups.length ? `(${d.episode_groups.length})` : ""}</h3>
        <div>${episodeRows || `<div class="no-assignee">Серий пока нет</div>`}</div>
        <div class="add-row">
          <input id="ep-label-new" placeholder="Номер/название серии, например «Серия 5»…">
          <input id="ep-deadline-new" type="date">
          <button class="btn" id="ep-add">Создать</button>
        </div>
      </div>

      <div class="detail-section">
        <h3>Интро</h3>
        <div class="no-assignee" style="margin-bottom:8px;">Короткое видео, которое ставится в начало финала при сборке (до 500 МБ). Одно на тайтл — новое заменяет прежнее.</div>
        <div class="add-row" style="align-items:center; gap:10px;">
          ${intro.has ? `<span class="meta">🎬 ${esc(intro.name || "интро")}</span>` : `<span class="meta">Интро не загружено — соберём без него</span>`}
          <button class="btn" id="intro-pick">${intro.has ? "Заменить интро" : "Загрузить интро"}</button>
          ${intro.has ? `<button class="btn ghost" id="intro-clear">Убрать</button>` : ""}
        </div>
      </div>

      ${watermarkSectionHtml(titleId, wm)}

      <div class="sheet-actions">
        <button class="btn danger" id="btn-delete-title" style="margin-right:auto;">Удалить тайтл</button>
        <button class="btn ghost" id="btn-rename-title">Переименовать</button>
        <button class="btn" data-close>Закрыть</button>
      </div>
    `;

    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));

    sheet.querySelector("#meta-search-btn").addEventListener("click", async () => {
      const q = sheet.querySelector("#meta-search-q").value.trim();
      if (!q) return;
      const box = sheet.querySelector("#meta-candidates");
      box.innerHTML = `<div class="no-assignee">Ищу…</div>`;
      try {
        const res = await apiPost(`/titles/${titleId}/meta/search`, { query: q });
        const candidates = res.candidates || [];
        box.innerHTML = candidates.length ? candidates.map(c => `
          <div class="mini-row">
            ${imgProxy(c.poster_url) ? `<img src="${imgProxy(c.poster_url)}" alt="" style="width:34px; height:46px; object-fit:cover; border-radius:4px;">` : ""}
            <span class="name">${esc(c.name)} <span class="meta" style="color:var(--ink-dim); font-size:11px;">(${esc(c.source)})</span></span>
            <button class="btn" data-confirm-candidate data-source="${esc(c.source)}" data-source-id="${esc(c.source_id)}" data-poster="${esc(c.poster_url || "")}">Подтвердить</button>
          </div>
        `).join("") : `<div class="no-assignee">Ничего не найдено</div>`;
        box.querySelectorAll("[data-confirm-candidate]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const { source, sourceId } = btn.dataset;
            btn.disabled = true;
            try {
              await apiPost(`/titles/${titleId}/meta/confirm`, { source, source_id: sourceId, poster_url: btn.dataset.poster || null });
              toast("Подтверждено — постер и персонажи обновлены.");
              await render();
            } catch (e) { toast(`Не удалось подтвердить: ${e.message}`, "error"); btn.disabled = false; }
          });
        });
      } catch (e) { box.innerHTML = `<div class="no-assignee">Ошибка поиска: ${esc(e.message)}</div>`; }
    });

    enhanceSelects(sheet, "select.people-pick");
    sheet.querySelectorAll("[data-crew-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await apiPost(`/titles/${titleId}/crew/remove`, { role: btn.dataset.crewRemove });
          await render();
        } catch (e) { toast(`Не удалось убрать роль: ${e.message}`, "error"); }
      });
    });
    sheet.querySelector("#crew-add").addEventListener("click", async () => {
      const role = sheet.querySelector("#crew-role-new").value;
      const rawUser = sheet.querySelector("#crew-user-new").value;
      const telegram_id = rawUser ? Number(rawUser) : null;
      if (!role) { toast("Выберите роль.", "error"); return; }
      try {
        await apiPost(`/titles/${titleId}/crew`, { role, telegram_id });
        toast("Состав обновлён.");
        await render();
      } catch (e) { toast(`Не удалось назначить: ${e.message}`, "error"); }
    });

    hydrateVoice(sheet);
    sheet.querySelectorAll("[data-char-listen]").forEach(btn => btn.addEventListener("click", () => {
      const sel = sheet.querySelector(`[data-char-voice="${btn.dataset.charListen}"]`);
      const name = btn.closest("[data-char]")?.querySelector(".name")?.childNodes[0]?.textContent?.trim() || "персонажа";
      openVoicePicker({
        users: assignable, selectedId: sel.value, title: `Кто озвучит: ${name}`,
        onPick: id => { if (sel.value !== id) { sel.value = id; sel.dispatchEvent(new window.Event("change")); } },
      });
    }));
    sheet.querySelectorAll("[data-char-voice]").forEach(sel => {
      sel.addEventListener("change", async () => {
        retargetVoiceSlot(sel.parentElement.querySelector("[data-voice-slot]"), sel.value);
        try {
          await apiPost(`/titles/${titleId}/characters/${sel.dataset.charVoice}/voice`, { telegram_id: sel.value ? Number(sel.value) : null });
          toast("Актёр озвучки обновлён.");
        } catch (e) { toast(`Не удалось назначить: ${e.message}`, "error"); }
      });
    });
    sheet.querySelectorAll("[data-char-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!await askConfirm("Удалить этого персонажа?")) return;
        try {
          await apiPost(`/titles/${titleId}/characters/delete`, { ids: [parseInt(btn.dataset.charDelete, 10)] });
          await render();
        } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
      });
    });
    sheet.querySelector("#char-import-ass")?.addEventListener("click", () => importActorsFromAss(titleId, d.characters, assignable, render));
    sheet.querySelector("#char-mark-ass")?.addEventListener("click", () => markAssWithDubbers(d.characters, assignable));
    const deleteAllBtn = sheet.querySelector("#char-delete-all");
    if (deleteAllBtn) deleteAllBtn.addEventListener("click", async () => {
      if (!await askConfirm("Удалить ВСЕХ персонажей тайтла?")) return;
      try {
        await apiPost(`/titles/${titleId}/characters/delete`, { all: true });
        await render();
      } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
    });

    sheet.querySelector("#ep-add").addEventListener("click", async () => {
      const episode_label = sheet.querySelector("#ep-label-new").value.trim();
      const deadline = sheet.querySelector("#ep-deadline-new").value || null;
      if (!episode_label) { toast("Укажите номер/название серии.", "error"); return; }
      try {
        const res = await apiPost(`/titles/${titleId}/episodes`, { episode_label, deadline });
        toast(`Создано отчётов: ${res.created.length}.`);
        await render();
      } catch (e) { toast(`Не удалось создать серию: ${e.message}`, "error"); }
    });

    wireWatermarkSection(sheet, titleId, wm, render);

    sheet.querySelector("#intro-pick").addEventListener("click", async () => {
      const file = await pickFile("video/*");
      if (!file) return;
      const btn = sheet.querySelector("#intro-pick");
      btn.disabled = true;
      btn.textContent = "Загружаю…";
      try {
        await apiUpload(`/titles/${titleId}/intro`, file, {});
        toast("Интро загружено — оно будет в начале финала.", "success");
        await render();
      } catch (e) {
        toast(`Не удалось загрузить интро: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Загрузить интро";
      }
    });
    sheet.querySelector("#intro-clear")?.addEventListener("click", async () => {
      if (!await askConfirm("Убрать интро у тайтла? Финал будет собираться без него.")) return;
      try {
        await apiPost(`/titles/${titleId}/intro/delete`, {});
        await render();
      } catch (e) { toast(`Не удалось убрать: ${e.message}`, "error"); }
    });
    sheet.querySelector("#btn-rename-title").addEventListener("click", async () => {
      const name = await askText("Новое название тайтла", d.name);
      if (!name) return;
      try {
        await apiPost(`/titles/${titleId}/rename`, { name });
        toast("Переименовано.");
        await render();
      } catch (e) { toast(`Не удалось переименовать: ${e.message}`, "error"); }
    });
    sheet.querySelector("#btn-delete-title").addEventListener("click", async () => {
      if (!await askConfirm(`Удалить тайтл «${d.name}»? Возможно только если у него нет серий.`)) return;
      try {
        await apiPost(`/titles/${titleId}/delete`, {});
        toast("Тайтл удалён.");
        overlay.remove();
      } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
    });
  }

  await render();
  if (section === "watermark") {
    const sec = sheet.querySelector("#ta-watermark");
    if (sec) {
      sec.scrollIntoView({ block: "start", behavior: "smooth" });
      sec.animate([{ boxShadow: "0 0 0 2px var(--fire)" }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1600, easing: "ease-out" });
    }
  }
}


// ---------- Actor field of .ass ↔ characters and dubbers ----------

const personName = u => String((u && (u.name || u.username)) || "").trim();

async function readAssFile() {
  const file = await pickFile(".ass,.ssa");
  if (!file) return null;
  const text = decodeSubs(await file.arrayBuffer());
  return { name: file.name, text };
}

async function importActorsFromAss(titleId, characters, users, onDone) {
  const file = await readAssFile();
  if (!file) return;
  const { total, empty, actors } = assActors(file.text);
  if (!total) { toast("В файле нет реплик .ass с полем Actor.", "error"); return; }
  if (!actors.length) { toast("В поле Actor пусто у всех реплик — импортировать нечего.", "error"); return; }
  const plan = planImport(actors, characters, users);
  const overlay = openSheet(`
    <h2>Импорт актёров из «${esc(file.name)}»</h2>
    <div class="no-assignee">Реплик: ${total} · без актёра: ${empty} · разных значений Actor: ${actors.length}</div>
    ${plan.pairs.length ? `<div class="detail-section"><h3>Назначить (${plan.pairs.length})</h3>${plan.pairs.map((p, i) => {
      const cur = p.character.voiced_by && p.character.voiced_by.telegram_id;
      const same = cur && String(cur) === String(p.user.telegram_id);
      return `<label class="mini-row" style="cursor:pointer;"><input type="checkbox" data-pair="${i}" ${same ? "" : "checked"}>
        <span class="name">${esc(p.character.name)}</span>
        <span class="val">→ ${esc(personName(p.user))}${same ? " · уже назначен" : cur ? ` · было: ${esc(p.character.voiced_by.name || "")}` : ""} · ${p.lines} реплик</span></label>`;
    }).join("")}</div>` : `<div class="no-assignee">Пар «персонаж — даббер» не найдено. Ожидается Actor вида «Персонаж (Даббер)», «Персонаж - Даббер» или «Персонаж | Даббер».</div>`}
    ${plan.unknownDubbers.length ? `<div class="detail-section"><h3>Даббер не найден в команде (${plan.unknownDubbers.length})</h3><div class="no-assignee">${plan.unknownDubbers.map(u => esc(u.actor)).join(" · ")}</div></div>` : ""}
    ${plan.unknownCharacters.length ? `<div class="detail-section"><h3>Нет такого персонажа в тайтле (${plan.unknownCharacters.length})</h3><div class="no-assignee">${plan.unknownCharacters.slice(0, 40).map(esc).join(" · ")}${plan.unknownCharacters.length > 40 ? " …" : ""}</div></div>` : ""}
    <div class="sheet-actions">
      <button class="btn" data-close>Отмена</button>
      ${plan.pairs.length ? `<button class="btn primary" id="ass-import-apply">Назначить отмеченных</button>` : ""}
    </div>`, "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
  sheet.querySelector("#ass-import-apply")?.addEventListener("click", async e => {
    const btn = e.currentTarget;
    const chosen = [...sheet.querySelectorAll("[data-pair]:checked")].map(c => plan.pairs[Number(c.dataset.pair)]);
    if (!chosen.length) { toast("Ничего не отмечено.", "error"); return; }
    btn.disabled = true;
    let ok = 0;
    for (const p of chosen) {
      try { await apiPost(`/titles/${titleId}/characters/${p.character.id}/voice`, { telegram_id: Number(p.user.telegram_id) }); ok++; }
      catch (err) { toast(`${p.character.name}: ${err.message}`, "error"); }
    }
    toast(`Назначено дабберов: ${ok} из ${chosen.length}.`, ok ? "success" : "error");
    overlay.remove();
    if (ok) await onDone();
  });
}

/** file: {name, text} or null to pick one; attach(name, text): optional "attach to report" action. */
export async function markAssWithDubbers(characters, users, file = null, attach = null) {
  file = file || await readAssFile();
  if (!file) return;
  const byTid = new Map(users.map(u => [String(u.telegram_id), u]));
  const named = characters.map(c => {
    if (!c.voiced_by) return c;
    const u = byTid.get(String(c.voiced_by.telegram_id));
    return { ...c, voiced_by: { ...c.voiced_by, name: personName(u) || c.voiced_by.name } };
  });
  let mode = "both";
  const overlay = openSheet(`<h2>Разметить «${esc(file.name)}» дабберами</h2><div id="ass-mark-body"></div>`, "wide");
  const sheet = overlay.querySelector(".sheet");
  const paint = () => {
    const r = applyDubbers(file.text, named, mode);
    sheet.querySelector("#ass-mark-body").innerHTML = `
      <div class="detail-section">
        <label class="mini-row" style="cursor:pointer;"><input type="radio" name="ass-mode" value="both" ${mode === "both" ? "checked" : ""}> <span class="name">Персонаж (Даббер)</span></label>
        <label class="mini-row" style="cursor:pointer;"><input type="radio" name="ass-mode" value="dubber" ${mode === "dubber" ? "checked" : ""}> <span class="name">Только даббер</span></label>
      </div>
      <div class="detail-section"><h3>Что получится</h3>
        <div class="mini-row"><span class="name">Реплик размечено</span><span class="val">${r.changed}</span></div>
        <div class="mini-row"><span class="name">Реплик без персонажа в Actor</span><span class="val">${r.noActor}</span></div>
        ${r.unvoiced.length ? `<div class="mini-row"><span class="name">Персонажам не назначен даббер</span><span class="val">${r.unvoiced.map(esc).join(", ")}</span></div>` : ""}
        ${r.unknownActors.length ? `<div class="mini-row"><span class="name">Нет в тайтле</span><span class="val">${r.unknownActors.slice(0, 30).map(esc).join(", ")}${r.unknownActors.length > 30 ? " …" : ""}</span></div>` : ""}
      </div>
      <div class="sheet-actions">
        <button class="btn" data-close>Отмена</button>
        <button class="btn${attach ? "" : " primary"}" id="ass-mark-save" ${r.changed ? "" : "disabled"}>Сохранить копию…</button>
        ${attach ? `<button class="btn primary" id="ass-mark-attach" ${r.changed ? "" : "disabled"}>Прикрепить к отчёту</button>` : ""}
      </div>`;
    sheet.querySelectorAll('[name="ass-mode"]').forEach(i => i.addEventListener("change", () => { mode = i.value; paint(); }));
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    sheet.querySelector("#ass-mark-save").addEventListener("click", async () => {
      const stem = file.name.replace(/\.(ass|ssa)$/i, "");
      const out = await pickOutputFile(`${stem}.dubbers.ass`, [{ name: "Субтитры", extensions: ["ass"] }]);
      if (!out) return;
      try {
        await invoke("write_text_file", { path: out, content: r.text });
        toast(`Сохранено: размечено ${r.changed} реплик.`, "success");
        overlay.remove();
      } catch (err) { toast(`Не удалось сохранить: ${err.message || err}`, "error"); }
    });
    sheet.querySelector("#ass-mark-attach")?.addEventListener("click", async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const stem = file.name.replace(/\.(ass|ssa)$/i, "");
      try {
        await attach(`${stem}.dubbers.ass`, r.text);
        toast(`Прикреплено к отчёту: размечено ${r.changed} реплик.`, "success");
        overlay.remove();
      } catch (err) { toast(`Не удалось прикрепить: ${err.message || err}`, "error"); btn.disabled = false; }
    });
  };
  paint();
}

/**
 * Window with dialogue lines per dubber, character art behind each tile.
 * file: {name, text}; post(text): optional "post to notes" action, gets a tally note ("Имя - 12, ...").
 */
export function showDubberLines(characters, users, file, post = null, aliases = {}) {
  const r = countDubberLines(file.text, characters, users, aliases);
  const counted = r.people.reduce((a, p) => a + p.lines, 0) + r.unknown.reduce((a, u) => a + u.lines, 0);
  const max = Math.max(1, ...r.people.map(p => p.lines), ...r.unknown.map(u => u.lines));
  const pct = n => counted ? Math.round(n / counted * 100) : 0;
  const tile = p => {
    const art = p.characters.find(c => c.image_url && !c.image_url.includes("/missing"));
    const cast = p.characters.map(c => `${c.name} · ${c.lines}`).join("\n");
    return `<div class="dl-tile${art ? " art" : ""}"${art ? ` style="--art:url('${esc(imgProxy(art.image_url))}')"` : ""} title="${esc(cast)}">
      <span class="avatar-bubble" data-avatar-for="${esc(p.telegram_id)}">${esc((p.name || "?").slice(0, 1).toUpperCase())}</span>
      <span class="dl-name">${esc(p.name || "без имени")}</span>
      ${p.characters.length ? `<span class="dl-cast">${esc(p.characters.slice(0, 2).map(c => c.name).join(", "))}${p.characters.length > 2 ? ` +${p.characters.length - 2}` : ""}</span>` : ""}
      <b>${p.lines}</b><small>${pct(p.lines)}%</small>
      <span class="nt-bar"><i style="width:${(p.lines / max * 100).toFixed(1)}%"></i></span>
    </div>`;
  };
  const unknownLines = r.unknown.reduce((a, u) => a + u.lines, 0);
  const note = r.people.map(p => `${String(p.name).replace(/[,;\-–—]/g, " ").trim()} - ${p.lines}`).join(", ");
  const overlay = openSheet(`<h2>Реплики · ${esc(file.name)}</h2>
    ${r.people.length ? `<div class="dl-tiles">${r.people.map(tile).join("")}</div>` : `<div class="no-assignee">Не нашли ни одного даббера. В поле Actor ожидается персонаж тайтла, «Персонаж (Даббер)» или имя даббера.</div>`}
    <div class="nt-sum">всего реплик ${r.total - r.signs}${r.signs ? ` · надписей ${r.signs} (не считаем)` : ""}${r.empty ? ` · без Actor ${r.empty}` : ""}${unknownLines ? ` · не узнали ${unknownLines}` : ""}</div>
    ${r.unknown.length ? `<details class="detail-section"><summary>Не узнали (${r.unknown.length})</summary><div class="no-assignee">${r.unknown.slice(0, 60).map(u => `«${esc(u.actor)}» — ${u.lines}`).join(", ")}${r.unknown.length > 60 ? " …" : ""}</div></details>` : ""}
    <div class="sheet-actions">
      <button class="btn" data-close>Закрыть</button>
      ${post && r.people.length >= 2 ? `<button class="btn primary" id="dl-post">Опубликовать в заметки</button>` : ""}
    </div>`, "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
  sheet.querySelector("#dl-post")?.addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await post(note); toast("Подсчёт реплик добавлен в заметки.", "success"); overlay.remove(); }
    catch (err) { toast(`Не удалось добавить заметку: ${err.message || err}`, "error"); btn.disabled = false; }
  });
  return overlay;
}
