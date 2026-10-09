// Живые элементы страницы «Релизы»: кнопка с прогрессом внутри и отменой («клейкий» пузырь),
// «Отправить участнику» (бот пишет ему в личку со ссылкой на раздачу) и навигация «жидкий металл».
import { apiGet, apiPost, apiUpload, mediaUrl, toast } from "./api.js";
import { esc } from "./utils.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- кнопка с прогрессом ----------
// Подпись меняется по буквам с размытием (≈30 мс на букву).
async function morph(el, text, stag = 26) {
  const old = [...el.querySelectorAll("span")];
  old.forEach((s, i) => setTimeout(() => s.classList.add("out"), i * stag));
  await sleep(Math.min(old.length, 12) * stag + 140);
  el.innerHTML = [...text].map(ch => `<span class="out">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
  const nu = [...el.querySelectorAll("span")];
  await sleep(16);
  nu.forEach((s, i) => setTimeout(() => s.classList.remove("out"), i * stag));
  await sleep(Math.min(nu.length, 12) * stag + 120);
}

/**
 * Запускает task() на кнопке: подпись «Отправляю…», мягкое свечение бежит по кнопке,
 * при onCancel сбоку выдавливается круглая кнопка отмены, в конце — «Готово» или ошибка.
 * Возвращает результат task() либо null при отмене/ошибке.
 */
export async function liveButton(btn, task, { busy = "Работаю", done = "Готово", onCancel = null } = {}) {
  if (!btn || btn.classList.contains("fx-run")) return null;
  const idle = btn.innerHTML;
  const idleText = btn.textContent.trim();
  const wrap = document.createElement("span");
  wrap.className = "fx-wrap";
  btn.parentNode.insertBefore(wrap, btn);
  wrap.appendChild(btn);
  const label = document.createElement("span");
  label.className = "fx-label";
  btn.innerHTML = "";
  btn.appendChild(label);
  label.innerHTML = [...idleText].map(ch => `<span>${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
  const glow = document.createElement("i");
  glow.className = "fx-glow";
  btn.appendChild(glow);
  btn.classList.add("fx-run");
  let cancelled = false;
  let x = null;
  if (onCancel) {
    x = document.createElement("button");
    x.type = "button"; x.className = "fx-x"; x.setAttribute("aria-label", "Отменить");
    x.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    x.onclick = () => { cancelled = true; try { onCancel(); } catch { /* */ } };
    wrap.appendChild(x);
    requestAnimationFrame(() => wrap.classList.add("has-x"));
  }
  await morph(label, busy);
  let res = null, failed = false;
  try { res = await task(); } catch (e) { failed = true; res = null; toast(String((e && e.message) || e), "error"); }
  wrap.classList.remove("has-x");
  if (!cancelled && !failed) {
    await morph(label, done);
    btn.classList.add("fx-ok");
    await sleep(900);
  }
  btn.classList.remove("fx-run", "fx-ok");
  btn.innerHTML = idle;
  wrap.replaceWith(btn);
  return cancelled || failed ? null : (res === undefined ? true : res);
}

// ---------- отправить участнику ----------
let team = null;
const sentTo = new Map(); // id раздачи -> [telegram_id]
let pop = null;

async function loadTeam() {
  if (team) return team;
  const r = await apiGet("/nyaa/team");
  team = (r && r.people) || [];
  return team;
}

const avatar = p => { const u = mediaUrl(`/avatar/${encodeURIComponent(p.telegram_id)}`); return u ? `<img src="${esc(u)}" alt="" loading="lazy">` : esc((p.name || "?")[0].toUpperCase()); };

export function closeShare() { if (pop) { pop.remove(); pop = null; } }

const fmtB = n => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} ГБ` : n >= 1048576 ? `${Math.round(n / 1048576)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`;
const MODES = [["link", "Ссылка"], ["torrent", ".torrent"], ["get", "Скачать ботом"]];

/** Открывает окошко «Отправить участнику» под элементом anchor. */
export async function openShare(anchor, it, cover = "") {
  closeShare();
  pop = document.createElement("div");
  pop.className = "fx-share";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Отправить участнику");
  pop.innerHTML = `<div class="fx-sh-h"><b>Отправить участнику</b><span>Бот напишет ему в личные сообщения.</span></div><div class="fx-sh-load">Загружаю команду…</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 560))}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 372))}px`;
  let people = [];
  try { people = await loadTeam(); } catch (e) { pop.querySelector(".fx-sh-load").textContent = `Не удалось получить команду: ${(e && e.message) || e}`; return; }
  if (!pop) return;
  let chosen = null, picked = null, mode = "link", tfiles = null, tsel = new Set(), tbusy = false, cancelJob = null;
  const already = () => sentTo.get(it.id) || [];
  const canSend = () => chosen && (picked || mode !== "get" || (tfiles && tsel.size && !tbusy));
  const upd = () => { const b = pop && pop.querySelector(".fx-send"); if (b) b.disabled = !canSend(); };
  const drawFiles = () => {
    const box = pop.querySelector(".fx-files");
    if (mode !== "get" || picked) { box.hidden = true; return; }
    box.hidden = false;
    if (tbusy) { box.innerHTML = `<div class="fx-none">Читаю список файлов…</div>`; return; }
    if (!tfiles) { box.innerHTML = ""; return; }
    const sum = [...tsel].reduce((a, i) => a + ((tfiles.files.find(f => f.i === i) || {}).size || 0), 0);
    box.innerHTML = `<div class="fx-fl">${tfiles.files.map(f => {
      const big = f.size > tfiles.limit;
      return `<label class="${big ? "off" : ""}"><input type="checkbox" data-fi="${f.i}" ${tsel.has(f.i) ? "checked" : ""} ${big ? "disabled" : ""}><span>${esc(f.path)}</span><em>${big ? "больше 2 ГБ" : fmtB(f.size)}</em></label>`;
    }).join("")}</div><div class="fx-sum">Выбрано: ${tsel.size} · ${fmtB(sum)}${sum > tfiles.cap ? " — слишком много, максимум 12 ГБ" : ""}</div>`;
  };
  const hints = { link: "Карточка с обложкой и кнопкой «Открыть раздачу».", torrent: "Карточка и файл .torrent.", get: "Бот сам скачает выбранные файлы на сервер и пришлёт их (до 2 ГБ каждый). Музыка и видео — файлами, без сжатия." };
  const paintMode = () => {
    pop.querySelector(".fx-modes").innerHTML = MODES.map(([k, l]) => `<button type="button" data-mode="${k}" class="${mode === k ? "on" : ""}">${l}</button>`).join("");
    pop.querySelector(".fx-mh").textContent = picked ? "Будет отправлен ваш файл." : hints[mode];
    drawFiles(); upd();
  };
  const loadFiles = async () => {
    if (tfiles || tbusy) return;
    tbusy = true; drawFiles();
    try {
      tfiles = await apiGet("/nyaa/files", { id: it.id });
      tsel = new Set(tfiles.files.filter(f => f.size <= tfiles.limit).map(f => f.i));
    } catch (e) { toast(String((e && e.message) || e), "error"); mode = "torrent"; }
    tbusy = false; if (pop) paintMode();
  };
  const draw = () => {
    const q = (pop.querySelector("input.fx-q") || {}).value || "";
    const needle = q.trim().replace(/^@/, "").toLowerCase();
    const list = people.filter(p => !needle || (p.name || "").toLowerCase().includes(needle) || (p.username || "").toLowerCase().includes(needle)).slice(0, 6);
    pop.querySelector(".fx-list").innerHTML = list.length ? list.map(p => `
      <button type="button" class="fx-p${chosen && chosen.telegram_id === p.telegram_id ? " on" : ""}" data-tid="${p.telegram_id}">
        <i class="fx-av">${avatar(p)}</i><span><b>${esc(p.name)}</b>${p.username ? `<small>@${esc(p.username)}</small>` : ""}</span>
        ${already().includes(p.telegram_id) ? `<em>отправлено</em>` : ""}
      </button>`).join("") : `<div class="fx-none">Никого не найдено.</div>`;
    upd();
    pop.querySelector(".fx-stack").innerHTML = already().map(t => people.find(p => p.telegram_id === t)).filter(Boolean)
      .map(p => `<i class="fx-av pop" title="${esc(p.name)}">${avatar(p)}</i>`).join("");
  };
  pop.innerHTML = `
    <div class="fx-sh-h"><b>Отправить участнику</b><span>Бот напишет ему в личные сообщения.</span></div>
    <label class="fx-field"><span>Кому</span><input class="fx-q" type="text" placeholder="Имя или @username" autocomplete="off" spellcheck="false"></label>
    <div class="fx-list"></div>
    <div class="fx-field"><span>Что отправить</span><div class="fx-modes"></div><small class="fx-mh"></small></div>
    <div class="fx-files" hidden></div>
    <label class="fx-field"><span>Заметка</span><input class="fx-note" type="text" maxlength="300" placeholder="Необязательно" autocomplete="off"></label>
    <div class="fx-attach"><button type="button" class="btn ghost fx-pick">Свой файл…</button><span class="fx-file"></span><input type="file" class="fx-input" hidden></div>
    <div class="fx-prog" hidden><div class="fx-pbar"><i></i></div><span></span></div>
    <div class="fx-foot"><span class="fx-stack"></span><span class="fx-sp"></span><button type="button" class="btn ghost fx-close">Закрыть</button><button type="button" class="btn primary fx-send" disabled>Отправить</button></div>`;
  paintMode(); draw();
  pop.querySelector(".fx-modes").onclick = e => { const b = e.target.closest("[data-mode]"); if (!b) return; mode = b.dataset.mode; paintMode(); if (mode === "get") loadFiles(); };
  pop.querySelector(".fx-files").onchange = e => {
    const c = e.target.closest("[data-fi]"); if (!c) return;
    const i = Number(c.dataset.fi); if (c.checked) tsel.add(i); else tsel.delete(i);
    drawFiles(); upd();
  };
  const q = pop.querySelector("input.fx-q");
  q.focus({ preventScroll: true });
  q.oninput = () => { chosen = null; draw(); };
  pop.querySelector(".fx-list").onclick = e => {
    const b = e.target.closest("[data-tid]");
    if (!b) return;
    chosen = people.find(p => p.telegram_id === Number(b.dataset.tid)) || null;
    if (chosen) q.value = chosen.name;
    draw();
  };
  pop.querySelector(".fx-close").onclick = closeShare;
  const input = pop.querySelector(".fx-input"), fileLbl = pop.querySelector(".fx-file");
  const paintFile = () => { fileLbl.innerHTML = picked ? `${esc(picked.name)} <button type="button" class="fx-unpick" aria-label="Убрать файл">×</button>` : ""; paintMode(); };
  pop.querySelector(".fx-pick").onclick = () => input.click();
  input.onchange = () => { picked = input.files[0] || null; paintFile(); };
  fileLbl.onclick = e => { if (e.target.closest(".fx-unpick")) { picked = null; input.value = ""; paintFile(); } };
  const send = pop.querySelector(".fx-send");
  const prog = pop.querySelector(".fx-prog");
  const runJob = async to => {
    const note = pop.querySelector(".fx-note").value;
    const start = await apiPost("/nyaa/share-job", { to: to.telegram_id, id: it.id, title: it.title, note, cover, files: [...tsel] });
    let cancelled = false;
    cancelJob = async () => { cancelled = true; try { await apiPost("/nyaa/share-cancel", { job: start.job }); } catch { /* */ } };
    prog.hidden = false;
    const bar = prog.querySelector("i"), txt = prog.querySelector("span");
    for (;;) {
      await sleep(1500);
      if (!pop) { await cancelJob(); return null; }
      const st = await apiGet("/nyaa/share-status", { job: start.job });
      if (st.state === "error") throw new Error(st.err || "Не удалось отправить.");
      if (st.state === "cancelled" || cancelled) return null;
      const pct = st.total ? Math.min(100, Math.round(st.done / st.total * 100)) : 0;
      bar.style.width = `${st.state === "sending" ? 100 : pct}%`;
      txt.textContent = st.state === "queued" ? "Жду очереди на сервере…"
        : st.state === "downloading" ? `Бот качает: ${fmtB(st.done)} из ${fmtB(st.total)}${st.speed ? ` · ${fmtB(st.speed)}/с` : ""}`
        : st.state === "sending" ? `Отправляю участнику: ${st.sent} из ${st.n}` : "Готово";
      if (st.state === "done") { prog.hidden = true; return true; }
    }
  };
  send.dataset.fxIdle = "Отправить";
  send.onclick = async () => {
    if (!chosen) return;
    const to = chosen, note = pop.querySelector(".fx-note").value;
    const long = mode === "get" && !picked;
    const ok = await liveButton(send, () => (picked
      ? apiUpload("/nyaa/share-file", picked, { to: to.telegram_id, title: it.title, note })
      : long ? runJob(to)
        : apiPost("/nyaa/share", { to: to.telegram_id, id: it.id, title: it.title, note, cover, torrent: mode === "torrent" })),
    { busy: long ? "Качаю" : "Отправляю", done: "Отправлено", onCancel: long ? () => { if (cancelJob) cancelJob(); } : null });
    if (prog) prog.hidden = true;
    if (ok && pop) {
      sentTo.set(it.id, [to.telegram_id, ...already().filter(t => t !== to.telegram_id)]);
      chosen = null; picked = null; input.value = ""; paintFile(); q.value = ""; pop.querySelector(".fx-note").value = "";
      draw();
      toast(`Отправлено: ${to.name}.`, "success");
    }
  };
}
document.addEventListener("keydown", e => { if (pop && e.key === "Escape") closeShare(); });
document.addEventListener("mousedown", e => { if (pop && !pop.contains(e.target) && !e.target.closest("[data-share-open]")) closeShare(); }, true);

// ---------- навигация «жидкий металл» ----------
export function installLiquidNav() {
  const nav = document.getElementById("tabstrip");
  if (!nav || nav.dataset.liquid) return;
  nav.dataset.liquid = "1";
  nav.classList.add("liquid");
  nav.addEventListener("pointermove", e => {
    const b = e.target.closest(".tab-btn, .tb-more-btn");
    nav.style.setProperty("--nx", `${e.clientX - nav.getBoundingClientRect().left}px`);
    nav.style.setProperty("--ny", `${e.clientY - nav.getBoundingClientRect().top}px`);
    if (b) { const r = b.getBoundingClientRect(); b.style.setProperty("--mx", `${e.clientX - r.left}px`); b.style.setProperty("--my", `${e.clientY - r.top}px`); }
  });
}
