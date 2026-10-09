// Живые элементы страницы «Релизы»: кнопка с прогрессом внутри и отменой («клейкий» пузырь),
// «Отправить участнику» (бот пишет ему в личку со ссылкой на раздачу) и навигация «жидкий металл».
import { apiGet, apiPost, mediaUrl, toast } from "./api.js";
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

/** Открывает окошко «Отправить участнику» под элементом anchor. */
export async function openShare(anchor, it) {
  closeShare();
  pop = document.createElement("div");
  pop.className = "fx-share";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Отправить участнику");
  pop.innerHTML = `<div class="fx-sh-h"><b>Отправить участнику</b><span>Бот напишет ему в личные сообщения со ссылкой на раздачу.</span></div><div class="fx-sh-load">Загружаю команду…</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 380)}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 372))}px`;
  let people = [];
  try { people = await loadTeam(); } catch (e) { pop.querySelector(".fx-sh-load").textContent = `Не удалось получить команду: ${(e && e.message) || e}`; return; }
  if (!pop) return;
  let chosen = null;
  const already = () => sentTo.get(it.id) || [];
  const draw = () => {
    const q = (pop.querySelector("input.fx-q") || {}).value || "";
    const needle = q.trim().replace(/^@/, "").toLowerCase();
    const list = people.filter(p => !needle || (p.name || "").toLowerCase().includes(needle) || (p.username || "").toLowerCase().includes(needle)).slice(0, 6);
    pop.querySelector(".fx-list").innerHTML = list.length ? list.map(p => `
      <button type="button" class="fx-p${chosen && chosen.telegram_id === p.telegram_id ? " on" : ""}" data-tid="${p.telegram_id}">
        <i class="fx-av">${avatar(p)}</i><span><b>${esc(p.name)}</b>${p.username ? `<small>@${esc(p.username)}</small>` : ""}</span>
        ${already().includes(p.telegram_id) ? `<em>отправлено</em>` : ""}
      </button>`).join("") : `<div class="fx-none">Никого не найдено.</div>`;
    pop.querySelector(".fx-send").disabled = !chosen;
    pop.querySelector(".fx-stack").innerHTML = already().map(t => people.find(p => p.telegram_id === t)).filter(Boolean)
      .map(p => `<i class="fx-av pop" title="${esc(p.name)}">${avatar(p)}</i>`).join("");
  };
  pop.innerHTML = `
    <div class="fx-sh-h"><b>Отправить участнику</b><span>Бот напишет ему в личные сообщения со ссылкой на раздачу.</span></div>
    <label class="fx-field"><span>Кому</span><input class="fx-q" type="text" placeholder="Имя или @username" autocomplete="off" spellcheck="false"></label>
    <div class="fx-list"></div>
    <label class="fx-field"><span>Заметка</span><input class="fx-note" type="text" maxlength="300" placeholder="Необязательно" autocomplete="off"></label>
    <div class="fx-foot"><span class="fx-stack"></span><span class="fx-sp"></span><button type="button" class="btn ghost fx-close">Закрыть</button><button type="button" class="btn primary fx-send" disabled>Отправить</button></div>`;
  draw();
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
  const send = pop.querySelector(".fx-send");
  send.dataset.fxIdle = "Отправить";
  send.onclick = async () => {
    if (!chosen) return;
    const to = chosen, note = pop.querySelector(".fx-note").value;
    const ok = await liveButton(send, () => apiPost("/nyaa/share", { to: to.telegram_id, id: it.id, title: it.title, note }), { busy: "Отправляю", done: "Отправлено" });
    if (ok && pop) {
      sentTo.set(it.id, [to.telegram_id, ...already().filter(t => t !== to.telegram_id)]);
      chosen = null; q.value = ""; pop.querySelector(".fx-note").value = "";
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
