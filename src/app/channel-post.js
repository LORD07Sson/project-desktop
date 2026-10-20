// Пост в канал — то же, что «📢 Пост в канал» в админ-панели бота
// (admin/posts.py): заголовок, блоки («Роли дублировали», «Звукорежиссёр»…)
// с людьми из базы, фото/видео, кнопки-ссылки. Черновики общие с ботом —
// начатый там открывается здесь и наоборот. Справа — предпросмотр так,
// как пост увидят в канале. Публиковать и выбирать канал может только владелец.
//
// /api/posts, /api/posts/people, /api/posts/{id} (GET/POST {data}),
// /api/posts/{id}/media (multipart), /api/posts/{id}/media/{i},
// /api/posts/{id}/delete, /api/posts/{id}/publish, /api/posts/channel.

import { state } from "./state.js";
import { API_BASE, apiGet, apiPost, openSheet, toast, dialogSkeletonHtml, mediaUrl, ensureMediaToken } from "./api.js";
import { esc } from "./utils.js";

const SAVE_DELAY_MS = 700;
const ALLOWED = new Set(["B", "STRONG", "I", "EM", "U", "INS", "S", "STRIKE", "DEL", "CODE", "PRE", "BLOCKQUOTE", "SPAN", "TG-SPOILER", "TG-EMOJI", "A", "BR"]);
const I = {
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12l18-8-8 18-2-8-8-2Z"/></svg>',
};

// Разметка приходит с сервера (render_post), но в неё могут попасть
// теги, которые админ сам вписал в заголовок или реплику. Для
// предпросмотра оставляем только то, что понимает Telegram, а ссылки —
// только http(s) и tg.
// Раскладка кнопок: «с новой строки» у кнопки задаёт ряды вручную, иначе — по «кнопок в ряд».
function linkRows(d, links) {
  const manual = links.some(l => l.newrow), n = d.per_row || 2, rows = [];
  links.forEach((l, i) => {
    if (!rows.length || (manual ? l.newrow : rows[rows.length - 1].length >= n)) rows.push([]);
    rows[rows.length - 1].push(l);
  });
  return rows;
}

function sanitize(html) {
  const doc = new window.DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = node => {
    [...node.childNodes].forEach(ch => {
      if (ch.nodeType === 3) return;
      if (ch.nodeType !== 1 || !ALLOWED.has(ch.tagName)) {
        ch.replaceWith(document.createTextNode(ch.textContent || ""));
        return;
      }
      const href = ch.tagName === "A" ? ch.getAttribute("href") || "" : "";
      [...ch.attributes].forEach(a => ch.removeAttribute(a.name));
      if (ch.tagName === "A") {
        if (/^(https?:|tg:)/i.test(href)) { ch.setAttribute("href", href); ch.setAttribute("target", "_blank"); ch.setAttribute("rel", "noopener"); }
      }
      if (ch.tagName === "TG-SPOILER") ch.setAttribute("class", "cp-spoiler");
      walk(ch);
    });
  };
  const root = doc.body.firstChild;
  walk(root);
  return root.innerHTML.replace(/\n/g, "<br>");
}

export async function openChannelPostSheet(openId = null) {
  const overlay = openSheet(`<h2>Пост в канал</h2>${dialogSkeletonHtml(6)}`, "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("cp-sheet");

  let meta;      // /posts: список, канал, пресеты, лимиты
  let people = [];
  let post = null; // /posts/{id}
  let view = (() => { try { return localStorage.getItem("cp-view") === "pc" ? "pc" : "phone"; } catch (_) { return "phone"; } })();   // как показывать предпросмотр: телефон или компьютер
  let saveTimer = null;
  let saving = Promise.resolve();

  try {
    [meta, { people }] = await Promise.all([apiGet("/posts"), apiGet("/posts/people"), ensureMediaToken()]);
  } catch (e) {
    sheet.innerHTML = `<h2>Пост в канал</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }

  const data = () => post.data;

  // ---------- сохранение ----------
  function scheduleSave() {
    setSaveState("Сохраняю…");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, SAVE_DELAY_MS);
  }
  function flush() {
    window.clearTimeout(saveTimer);
    if (!post) return saving;
    const id = post.id;
    const body = { data: data() };
    saving = saving.then(async () => {
      try {
        const r = await apiPost(`/posts/${id}`, body);
        if (post && post.id === id) {
          // Сервер мог почистить ссылки — берём его версию, но редактор
          // не перерисовываем, чтобы не сбить курсор.
          post = { ...r, data: mergeClean(post.data, r.data) };
          renderPreview();
        }
        setSaveState("Сохранено");
      } catch (e) {
        setSaveState("Не сохранено");
        toast(`Черновик не сохранился: ${e.message}`, "error");
      }
    });
    return saving;
  }
  // Пока человек печатает, сервер отдаёт нормализованную копию; ссылки
  // в полях оставляем как ввели, а медиа — как на сервере.
  function mergeClean(local, server) {
    // Тот же объект, а не копия: обработчики полей редактора держат ссылку на data() и пишут в неё; копия после первого
    // автосохранения «отрывалась» от них, и дальнейшие правки заголовка и блоков на сервер не уходили (превью оставалось пустым).
    local.media = server.media;
    return local;
  }
  function setSaveState(t) {
    const el = sheet.querySelector("#cp-save");
    if (el) el.textContent = t;
  }

  // ---------- разметка ----------
  function draftOptions() {
    return meta.posts.map(p => `<option value="${p.id}"${post && post.id === p.id ? " selected" : ""}>${esc((p.preview || "без заголовка").split("\n")[0].slice(0, 48))}${p.published_at ? " · опубликован" : ""}</option>`).join("");
  }

  function shell() {
    sheet.innerHTML = `
      <div class="cp-head">
        <h2>Пост в канал</h2>
        <select id="cp-drafts" aria-label="Черновик"${meta.posts.length ? "" : " disabled"}>${meta.posts.length ? draftOptions() : `<option>черновиков нет</option>`}</select>
        <button type="button" class="btn" id="cp-new">${I.plus}Новый</button>
        <span class="cp-channel" id="cp-channel"></span>
        <span class="cp-save" id="cp-save"></span>
        <button type="button" class="icon-btn" data-close aria-label="Закрыть">${I.x}</button>
      </div>
      <div class="cp-layout">
        <div class="cp-editor" id="cp-editor"></div>
        <div class="cp-side">
          <div class="cp-side-title">Так увидят в канале</div>
          <div class="cp-views" role="tablist" aria-label="Устройство"><button type="button" data-cp-view="pc">Компьютер</button><button type="button" data-cp-view="phone">Телефон</button></div>
          <div class="cp-preview" id="cp-preview"></div>
          <div class="cp-pv-note" id="cp-pv-note"></div>
          <div class="cp-stats" id="cp-stats"></div>
          <div class="cp-publish" id="cp-publish"></div>
        </div>
      </div>`;
    sheet.querySelector("[data-close]").addEventListener("click", async () => { await flush(); overlay.remove(); });
    sheet.querySelector("#cp-new").addEventListener("click", async () => {
      await flush();
      try {
        post = await apiPost("/posts", {});
        meta = await apiGet("/posts");
        shell();
        renderAll();
      } catch (e) { toast(`Не удалось создать: ${e.message}`, "error"); }
    });
    sheet.querySelector("#cp-drafts").addEventListener("change", async e => {
      await flush();
      await openPost(Number(e.target.value));
    });
    sheet.querySelectorAll("[data-cp-view]").forEach(b => b.addEventListener("click", () => {
      view = b.dataset.cpView;
      try { localStorage.setItem("cp-view", view); } catch (_) { /* не запомнится */ }
      renderPreview();
    }));
    renderChannel();
  }

  function renderChannel() {
    const el = sheet.querySelector("#cp-channel");
    el.innerHTML = `Канал: <b>${meta.channel ? esc(meta.channel) : "не задан"}</b>${meta.is_owner ? ` <button type="button" class="cp-link" id="cp-chan-edit">изменить</button>` : ""}`;
    const btn = el.querySelector("#cp-chan-edit");
    if (btn) btn.addEventListener("click", () => {
      el.innerHTML = `<input id="cp-chan-in" value="${esc(meta.channel || "")}" placeholder="@канал или -100…" aria-label="Канал"><button type="button" class="btn" id="cp-chan-ok">OK</button>${meta.channel ? `<button type="button" class="btn" id="cp-chan-clear" title="Убрать канал из настроек">Убрать</button>` : ""}`;
      const inp = el.querySelector("#cp-chan-in");
      inp.focus();
      const ok = async () => {
        try {
          const r = await apiPost("/posts/channel", { channel: inp.value.trim() });
          meta.channel = r.channel;
          toast(r.channel ? `Канал: ${r.channel}` : "Канал отвязан.");
          renderChannel();
          renderPublish();
        } catch (e) { toast(e.message, "error"); }
      };
      el.querySelector("#cp-chan-ok").addEventListener("click", ok);
      el.querySelector("#cp-chan-clear")?.addEventListener("click", () => { inp.value = ""; ok(); });
      inp.addEventListener("keydown", e => { if (e.key === "Enter") ok(); if (e.key === "Escape") renderChannel(); });
    });
  }

  function peopleSelectHtml(bi) {
    const groups = {};
    people.forEach((p, i) => { (groups[p.role] = groups[p.role] || []).push([p, i]); });
    return `<select class="cp-person-pick" data-cp-pick="${bi}" aria-label="Добавить человека">
      <option value="">+ человек из базы…</option>
      ${Object.entries(groups).map(([role, list]) => `<optgroup label="${esc(role)}">${list.map(([p, i]) => `<option value="${i}">${esc(p.name)}</option>`).join("")}</optgroup>`).join("")}
    </select>`;
  }

  const styleSelect = (key, label, options, value) => `<label class="cp-style"><span>${label}</span><select data-cp-style="${key}">${options.map(([v, t]) => `<option value="${v}"${String(value) === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>`;

  function editorHtml() {
    const d = data();
    const presetsLeft = meta.presets.blocks.filter(h => !d.blocks.some(b => b.head === h));
    const linkPresets = meta.presets.links.filter(t => !d.links.some(l => l.text === t));
    return `
      <section class="cp-sec">
        <label class="cp-label" for="cp-title">Заголовок</label>
        <textarea id="cp-title" rows="2" placeholder="Например: Фрирен 2 — 7 серия в озвучке Project">${esc(d.title)}</textarea>
        <div class="cp-hint">Обычным текстом (жирным — галочка «Заголовок жирным» ниже). Внутри можно &lt;i&gt;, &lt;u&gt;, &lt;tg-spoiler&gt;, &lt;a href="…"&gt;.</div>
      </section>

      <section class="cp-sec">
        <div class="cp-label">Блоки</div>
        ${d.blocks.map((b, bi) => `
          <div class="cp-block">
            <div class="cp-block-head">
              <input class="cp-in" data-cp-head="${bi}" value="${esc(b.head)}" placeholder="Заголовок блока" list="cp-block-presets" aria-label="Заголовок блока">
              <button type="button" class="icon-btn" data-cp-bmove="${bi}:-1" title="Выше"${bi === 0 ? " disabled" : ""}>${I.up}</button>
              <button type="button" class="icon-btn" data-cp-bmove="${bi}:1" title="Ниже"${bi === d.blocks.length - 1 ? " disabled" : ""}>${I.down}</button>
              <button type="button" class="icon-btn cp-danger" data-cp-bdel="${bi}" title="Удалить блок">${I.x}</button>
            </div>
            ${b.lines.map((ln, li) => `
              <div class="cp-line">
                <input class="cp-in" data-cp-line="${bi}:${li}:name" value="${esc(ln.name)}" placeholder="Имя" aria-label="Имя">
                <input class="cp-in" data-cp-line="${bi}:${li}:note" value="${esc(ln.note)}" placeholder="Персонаж / роль" aria-label="Персонаж">
                <input class="cp-in cp-in-link" data-cp-line="${bi}:${li}:link" value="${esc(ln.link)}" placeholder="Ссылка (t.me/…)" aria-label="Ссылка">
                <button type="button" class="icon-btn cp-danger" data-cp-ldel="${bi}:${li}" title="Убрать">${I.x}</button>
              </div>`).join("")}
            <div class="cp-block-add">
              ${peopleSelectHtml(bi)}
              <button type="button" class="qchip" data-cp-manual="${bi}">+ вручную</button>
            </div>
          </div>`).join("")}
        <datalist id="cp-block-presets">${meta.presets.blocks.map(h => `<option value="${esc(h)}">`).join("")}</datalist>
        <div class="chip-row cp-presets">
          ${presetsLeft.map(h => `<button type="button" class="qchip" data-cp-addblock="${esc(h)}">+ ${esc(h)}</button>`).join("")}
          <button type="button" class="qchip" data-cp-addblock="">+ свой блок</button>
        </div>
      </section>

      <section class="cp-sec">
        <div class="cp-label">Фото и видео <span>${d.media.length} / ${meta.limits.media}</span></div>
        <div class="cp-media">
          ${d.media.map((m, i) => {
            // Фото — сама картинка, видео — кадр из него (сервер вырезает его ffmpeg-ом); нет кадра — плашка с названием.
            const src = mediaUrl(`/posts/${post.id}/media/${i}`);
            const video = m.kind === "video";
            return `<div class="cp-thumb">${src ? `<img src="${src}" alt="" ${video ? `data-cp-poster="1"` : ""}>` : ""}${video ? `<span class="cp-thumb-video${src ? " over" : ""}">${I.play}<span>${esc(m.name || "видео")}</span></span>` : ""}
              ${video ? `<button type="button" class="cp-thumb-cover" data-cp-cover="${i}" title="Выбрать обложку из кадров видео">🖼 Обложка${m.cover ? " ✓" : ""}</button>` : ""}
              <button type="button" class="cp-thumb-del" data-cp-mdel="${i}" aria-label="Убрать">${I.x}</button></div>`;
          }).join("")}
          ${d.media.length < meta.limits.media ? `<label class="cp-thumb cp-thumb-add">${I.plus}<span>Добавить</span><input type="file" id="cp-file" accept="image/*,video/*" multiple hidden></label>` : ""}
        </div>
      </section>

      <section class="cp-sec">
        <div class="cp-label">Вид и подпись</div>
        <label class="cp-check"><input type="checkbox" id="cp-inline"${d.inline ? " checked" : ""}> Люди в строку, как в постах канала: «🎙 Роли озвучивали: Имя, Имя»</label>
        <label class="cp-label cp-sub" for="cp-footer">Подпись под блоками</label>
        <textarea id="cp-footer" rows="2" placeholder="Например: Всем приятного просмотра!">${esc(d.footer || "")}</textarea>
        <label class="cp-label cp-sub" for="cp-tags">Хештеги</label>
        <input class="cp-in" id="cp-tags" value="${esc(d.tags || "")}" placeholder="#Название_тайтла #DreamyVoice">
      </section>

      <section class="cp-sec">
        <div class="cp-label">Оформление текста</div>
        <div class="cp-style-grid">
          ${styleSelect("title_style", "Заголовок", [["plain", "Обычный"], ["bold", "Жирный"], ["italic", "Курсив"], ["underline", "Подчёркнутый"], ["quote", "Цитата"], ["equote", "Цитата, сворачиваемая"]], d.title_style || (d.bold ? "bold" : "plain"))}
          ${styleSelect("head_style", "Названия блоков (🎙 Роли озвучивали:)", [["plain", "Обычные"], ["bold", "Жирные"], ["italic", "Курсив"], ["underline", "Подчёркнутые"]], d.head_style || "plain")}
          ${styleSelect("block_style", "Каждый блок", [["plain", "Без оформления"], ["quote", "В цитате"], ["equote", "В сворачиваемой цитате"]], d.block_style || "plain")}
          ${styleSelect("footer_style", "Подпись под блоками", [["plain", "Обычная"], ["italic", "Курсив"], ["quote", "Цитата"], ["equote", "Цитата, сворачиваемая"]], d.footer_style || "plain")}
          ${styleSelect("gap", "Расстояние между частями", [["2", "Пустая строка"], ["1", "Плотно"]], String(d.gap || 2))}
        </div>
      </section>

      <section class="cp-sec">
        <div class="cp-label">Публикация</div>
        ${[["silent", "Без звука (подписчики не получат уведомление)"], ["protect", "Запретить пересылку и сохранение"], ["spoiler", "Скрыть фото и видео спойлером"], ["caption_above", "Текст над фото и видео"], ["pin", "Закрепить пост после публикации"]]
          .map(([k, t]) => `<label class="cp-check"><input type="checkbox" data-cp-flag="${k}"${d[k] ? " checked" : ""}> ${t}</label>`).join("")}
      </section>

      <section class="cp-sec">
        <div class="cp-label">Кнопки под постом <span>${d.links.length} / ${meta.limits.links}</span></div>
        <label class="cp-check cp-perrow">Кнопок в ряд: <select id="cp-perrow" aria-label="Кнопок в ряд">${[1, 2, 3, 4].map(n => `<option value="${n}"${(d.per_row || 2) === n ? " selected" : ""}>${n}</option>`).join("")}</select><span class="cp-hint">меньше места на кнопку, но больше кнопок на экране; высоту Telegram не меняет</span></label>
        ${d.links.map((l, i) => `
          <div class="cp-line cp-line-link">
            <input class="cp-in" data-cp-link="${i}:text" value="${esc(l.text)}" placeholder="Текст кнопки" aria-label="Текст кнопки">
            <input class="cp-in cp-in-link" data-cp-link="${i}:url" value="${esc(l.url)}" placeholder="Ссылка" aria-label="Ссылка кнопки">
            <button type="button" class="icon-btn${l.newrow ? " cp-on" : ""}" data-cp-knr="${i}" title="Начать с новой строки (свои ряды вместо «кнопок в ряд»)"${i === 0 ? " disabled" : ""}>↵</button>
            <button type="button" class="icon-btn" data-cp-kmove="${i}:-1" title="Левее / выше"${i === 0 ? " disabled" : ""}>${I.up}</button>
            <button type="button" class="icon-btn" data-cp-kmove="${i}:1" title="Правее / ниже"${i === d.links.length - 1 ? " disabled" : ""}>${I.down}</button>
            <button type="button" class="icon-btn cp-danger" data-cp-kdel="${i}" title="Убрать">${I.x}</button>
          </div>`).join("")}
        ${d.links.length < meta.limits.links ? `<div class="chip-row cp-presets">
          ${linkPresets.map(t => `<button type="button" class="qchip" data-cp-addlink="${esc(t)}">+ ${esc(t)}</button>`).join("")}
          <button type="button" class="qchip" data-cp-addlink="">+ своя кнопка</button>
        </div>` : ""}
      </section>`;
  }

  function renderEditor() {
    const ed = sheet.querySelector("#cp-editor");
    const scroll = ed.scrollTop;
    ed.innerHTML = editorHtml();
    ed.scrollTop = scroll;
    wireEditor(ed);
  }

  function structural(fn) {
    fn(data());
    renderEditor();
    renderPreview();
    scheduleSave();
  }

  function wireEditor(ed) {
    const d = data();
    ed.querySelector("#cp-title").addEventListener("input", e => { d.title = e.target.value; scheduleSave(); });
    ed.querySelectorAll("[data-cp-head]").forEach(inp => inp.addEventListener("input", () => { d.blocks[+inp.dataset.cpHead].head = inp.value; scheduleSave(); }));
    ed.querySelectorAll("[data-cp-line]").forEach(inp => inp.addEventListener("input", () => {
      const [bi, li, field] = inp.dataset.cpLine.split(":");
      d.blocks[+bi].lines[+li][field] = inp.value;
      scheduleSave();
    }));
    ed.querySelectorAll("[data-cp-link]").forEach(inp => inp.addEventListener("input", () => {
      const [i, field] = inp.dataset.cpLink.split(":");
      d.links[+i][field] = inp.value;
      scheduleSave();
    }));
    ed.querySelectorAll("[data-cp-bdel]").forEach(b => b.addEventListener("click", () => {
      const blk = d.blocks[+b.dataset.cpBdel];
      if (blk.lines.length && !confirm(`Удалить блок «${blk.head || "без заголовка"}» вместе с людьми?`)) return;
      structural(x => x.blocks.splice(+b.dataset.cpBdel, 1));
    }));
    ed.querySelectorAll("[data-cp-bmove]").forEach(b => b.addEventListener("click", () => {
      const [i, dir] = b.dataset.cpBmove.split(":").map(Number);
      structural(x => { const [blk] = x.blocks.splice(i, 1); x.blocks.splice(i + dir, 0, blk); });
    }));
    ed.querySelectorAll("[data-cp-ldel]").forEach(b => b.addEventListener("click", () => {
      const [bi, li] = b.dataset.cpLdel.split(":").map(Number);
      structural(x => x.blocks[bi].lines.splice(li, 1));
    }));
    ed.querySelectorAll("[data-cp-pick]").forEach(sel => sel.addEventListener("change", () => {
      if (sel.value === "") return;
      const p = people[+sel.value];
      structural(x => x.blocks[+sel.dataset.cpPick].lines.push({ name: p.name, link: p.link || "", note: "" }));
    }));
    ed.querySelectorAll("[data-cp-manual]").forEach(b => b.addEventListener("click", () => {
      structural(x => x.blocks[+b.dataset.cpManual].lines.push({ name: "", link: "", note: "" }));
      const inputs = sheet.querySelectorAll(`[data-cp-line^="${b.dataset.cpManual}:"][data-cp-line$=":name"]`);
      inputs[inputs.length - 1]?.focus();
    }));
    ed.querySelectorAll("[data-cp-addblock]").forEach(b => b.addEventListener("click", () => {
      structural(x => x.blocks.push({ head: b.dataset.cpAddblock, lines: [] }));
      if (!b.dataset.cpAddblock) { const heads = sheet.querySelectorAll("[data-cp-head]"); heads[heads.length - 1]?.focus(); }
    }));
    ed.querySelectorAll("[data-cp-addlink]").forEach(b => b.addEventListener("click", () => {
      structural(x => x.links.push({ text: b.dataset.cpAddlink, url: "" }));
      const urls = sheet.querySelectorAll('[data-cp-link$=":url"]');
      const texts = sheet.querySelectorAll('[data-cp-link$=":text"]');
      (b.dataset.cpAddlink ? urls[urls.length - 1] : texts[texts.length - 1])?.focus();
    }));
    ed.querySelectorAll("[data-cp-kdel]").forEach(b => b.addEventListener("click", () => structural(x => x.links.splice(+b.dataset.cpKdel, 1))));
    ed.querySelector("#cp-inline")?.addEventListener("change", e => { d.inline = e.target.checked; scheduleSave(); });
    ed.querySelectorAll("[data-cp-style]").forEach(sel => sel.addEventListener("change", () => { const k = sel.dataset.cpStyle; d[k] = k === "gap" ? Number(sel.value) : sel.value; if (k === "title_style") d.bold = sel.value === "bold"; scheduleSave(); }));
    ed.querySelectorAll("[data-cp-flag]").forEach(cb => cb.addEventListener("change", () => { d[cb.dataset.cpFlag] = cb.checked; scheduleSave(); }));
    ed.querySelectorAll("[data-cp-knr]").forEach(b => b.addEventListener("click", () => structural(x => { const l = x.links[+b.dataset.cpKnr]; l.newrow = !l.newrow; })));
    ed.querySelectorAll("[data-cp-kmove]").forEach(b => b.addEventListener("click", () => {
      const [i, dir] = b.dataset.cpKmove.split(":").map(Number);
      structural(x => { const [l] = x.links.splice(i, 1); x.links.splice(i + dir, 0, l); });
    }));
    ed.querySelector("#cp-perrow")?.addEventListener("change", e => { d.per_row = Number(e.target.value) || 2; scheduleSave(); renderPreview(); });
    ed.querySelector("#cp-footer")?.addEventListener("input", e => { d.footer = e.target.value; scheduleSave(); });
    ed.querySelector("#cp-tags")?.addEventListener("input", e => { d.tags = e.target.value; scheduleSave(); });
    ed.querySelectorAll("[data-cp-cover]").forEach(b => b.addEventListener("click", () => openCoverPicker(+b.dataset.cpCover)));
    ed.querySelectorAll("[data-cp-mdel]").forEach(b => b.addEventListener("click", () => structural(x => x.media.splice(+b.dataset.cpMdel, 1))));
    const file = ed.querySelector("#cp-file");
    if (file) file.addEventListener("change", () => uploadFiles([...file.files]));
  }

  async function uploadFiles(files) {
    await flush();
    for (const f of files) {
      if (data().media.length >= meta.limits.media) { toast(`Больше ${meta.limits.media} файлов Telegram в альбом не возьмёт.`, "error"); break; }
      setSaveState(`Загружаю ${f.name}…`);
      const fd = new window.FormData();
      fd.append("file", f, f.name);
      try {
        const r = await fetch(`${API_BASE}/posts/${post.id}/media`, { method: "POST", headers: { "X-Init-Data": state.token || "" }, body: fd });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
        post = { ...body, data: { ...data(), media: body.data.media } };
      } catch (e) {
        toast(`${f.name}: ${e.message}`, "error");
      }
    }
    setSaveState("Сохранено");
    renderEditor();
    renderPreview();
  }

  // Выбор обложки видео: сервер вырезает кадры по всей длине ролика, человек кликает нужный; он уйдёт в cover при публикации.
  async function openCoverPicker(index) {
    await flush();
    const pid = post.id;
    const picker = openSheet(`<h2>Обложка видео</h2><p class="cp-hint">Сервер вырезает кадры из видео — выберите, какой станет превью в канале.</p>${dialogSkeletonHtml(4)}`, "wide");
    let info;
    try {
      info = await apiGet(`/posts/${pid}/media/${index}/frames`);
    } catch (e) {
      picker.remove();
      toast(`Не удалось получить кадры: ${e.message}`, "error");
      return;
    }
    const box = picker.querySelector(".sheet");
    const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    const paint = chosen => {
      box.innerHTML = `
        <h2>Обложка видео</h2>
        <p class="cp-hint">Кадры из видео (${fmt(info.duration)}). Нажмите на нужный — он станет превью в канале.${chosen == null ? " Сейчас обложка выбирается Telegram автоматически." : ""}</p>
        <div class="cp-frames">${info.frames.map(f => `
          <button type="button" class="cp-frame${f.n === chosen ? " on" : ""}" data-cp-frame="${f.n}">
            <img src="${mediaUrl(`/posts/${pid}/media/${index}/frame/${f.n}`)}" alt="">
            <span>${fmt(f.t)}</span>
          </button>`).join("")}</div>
        <div class="sheet-actions">
          <button type="button" class="btn" data-cp-frame="-1">Сбросить (автоматически)</button>
          <button type="button" class="btn primary" data-close>Готово</button>
        </div>`;
      box.querySelector("[data-close]").addEventListener("click", () => picker.remove());
      box.querySelectorAll("[data-cp-frame]").forEach(b => b.addEventListener("click", async () => {
        box.querySelectorAll("button").forEach(x => { x.disabled = true; });
        try {
          const r = await apiPost(`/posts/${pid}/media/${index}/cover`, { n: Number(b.dataset.cpFrame) });
          if (post && post.id === pid) {
            post = { ...r, data: mergeClean(post.data, r.data) };
            renderEditor();
            renderPreview();
          }
          info.chosen = Number(b.dataset.cpFrame) >= 0 ? Number(b.dataset.cpFrame) : null;
          paint(info.chosen);
        } catch (err) {
          toast(`Не удалось выбрать обложку: ${err.message}`, "error");
          paint(info.chosen);
        }
      }));
    };
    paint(info.chosen);
  }

  function renderPreview() {
    const d = data();
    const pv = sheet.querySelector("#cp-preview");
    const media = d.media.map((m, i) => m.kind === "photo"
      ? `<img src="${mediaUrl(`/posts/${post.id}/media/${i}`)}" alt="">`
      : `<span class="cp-pv-video"><img src="${mediaUrl(`/posts/${post.id}/media/${i}`)}" alt="" onerror="this.remove()">${I.play}</span>`).join("");
    const text = post.html ? sanitize(post.html) : `<span class="cp-pv-empty">Пустой пост — начните с заголовка</span>`;
    const links = d.links.filter(l => l.text);
    pv.innerHTML = `
      <div class="cp-pv-post">
        ${d.media.length ? `<div class="cp-pv-media n${Math.min(d.media.length, 4)}">${media}</div>` : ""}
        <div class="cp-pv-text">${text}</div>
        <div class="cp-pv-meta">${post.published_at ? "опубликовано" : "черновик"}</div>
      </div>
      ${links.length ? `<div class="cp-pv-buttons">${linkRows(d, links).map(r => `<div class="cp-pv-row">${r.map(l => `<span>${esc(l.text)}</span>`).join("")}</div>`).join("")}</div>` : ""}`;
    pv.dataset.view = view;
    sheet.querySelectorAll("[data-cp-view]").forEach(b => b.classList.toggle("on", b.dataset.cpView === view));
    const note = sheet.querySelector("#cp-pv-note");
    if (note) note.textContent = view === "phone" ? "Как в Telegram на телефоне: текст переносится чаще, длинные названия кнопок обрезаются." : "Как в Telegram на компьютере: кнопки шире, читаются полностью.";
    const st = sheet.querySelector("#cp-stats");
    st.innerHTML = `
      <span>${post.plain_length} симв.</span>
      ${d.media.length && !post.caption_fits ? `<span class="warn">Длиннее ${meta.limits.caption} — текст уйдёт отдельным сообщением под медиа</span>` : ""}
      ${post.too_long ? `<span class="danger">Длиннее ${meta.limits.message} — Telegram не примет</span>` : ""}`;
    renderPublish();
  }

  function renderPublish() {
    const el = sheet.querySelector("#cp-publish");
    if (!el || !post) return;
    if (!meta.is_owner) {
      el.innerHTML = `<div class="cp-hint">Публикует владелец — черновик готов, позовите его. Черновик виден и в боте.</div>`;
      return;
    }
    el.innerHTML = `
      <button type="button" class="btn primary cp-publish-btn" id="cp-go"${meta.channel && post.html ? "" : " disabled"}>${I.send}${post.published_at ? "Опубликовать ещё раз" : "Опубликовать"}${meta.channel ? ` в ${esc(meta.channel)}` : ""}</button>
      <button type="button" class="btn danger" id="cp-del">Удалить черновик</button>`;
    el.querySelector("#cp-go").addEventListener("click", async e => {
      if (!confirm(`Опубликовать пост в ${meta.channel}? Его сразу увидят подписчики.`)) return;
      e.currentTarget.disabled = true;
      await flush();
      try {
        const r = await apiPost(`/posts/${post.id}/publish`, {});
        post = { ...r, data: mergeClean(post.data, r.data) };
        toast(`Опубликовано в ${meta.channel}${r.emoji_fallback ? " (premium-эмодзи заменены обычными)" : ""}.`);
        meta = await apiGet("/posts");
        sheet.querySelector("#cp-drafts").innerHTML = draftOptions();
        renderPreview();
      } catch (err) {
        toast(err.message, "error");
        renderPublish();
      }
    });
    el.querySelector("#cp-del").addEventListener("click", async () => {
      if (!confirm("Удалить черновик? В канале уже опубликованное не тронется.")) return;
      window.clearTimeout(saveTimer);
      try {
        await apiPost(`/posts/${post.id}/delete`, {});
        meta = await apiGet("/posts");
        post = null;
        if (openId) await openPost(openId);
  else if (meta.posts.length) await openPost(meta.posts[0].id);
        else { shell(); renderEmpty(); }
      } catch (err) { toast(err.message, "error"); }
    });
  }

  function renderEmpty() {
    sheet.querySelector("#cp-editor").innerHTML = `<div class="tk-empty">Черновиков нет — нажмите «Новый».</div>`;
    sheet.querySelector("#cp-preview").innerHTML = "";
    sheet.querySelector("#cp-stats").innerHTML = "";
    sheet.querySelector("#cp-publish").innerHTML = "";
  }

  function renderAll() {
    renderEditor();
    renderPreview();
    setSaveState(post.published_at ? "опубликован" : "");
  }

  async function openPost(id) {
    try {
      post = await apiGet(`/posts/${id}`);
      shell();
      renderAll();
    } catch (e) { toast(`Не удалось открыть: ${e.message}`, "error"); }
  }

  if (meta.posts.length) await openPost(meta.posts[0].id);
  else { shell(); renderEmpty(); }
}
