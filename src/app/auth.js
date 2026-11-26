
import { maybeAskNda } from "./nda.js";
import { invoke } from "./tauri.js";
import oopsFallGif from "../assets/oops-fall.gif";
import oopsFrierenGif from "../assets/friren.gif";
import { state, resetSessionState } from "./state.js";
import { api, apiGet, armSessionExpiry, ensureMediaToken, API_BASE } from "./api.js";
import { $ } from "./utils.js";
import { refreshAll, clearTabDom, restoreLastTab } from "./tabs.js";
import { setTitlebarIdentity } from "./titlebar-menus.js";
import { refreshQueueBadge } from "./queue.js";
import { resetAssignmentsBaseline } from "./notifications.js";
import { resetChatNotifyBaseline } from "./chat-notify.js";
import { resetFeedBadge } from "./feed-badge.js";
import { pingPresence } from "./presence.js";
import { loadTitlebarTeam } from "./profile.js";
import { refreshInbox, resetInbox } from "./inbox.js";
import { maybeWelcome, resetTourUi } from "./tour.js";
import { refreshPermissions, startPermissionsPolling } from "./permissions-refresh.js";
import { initAppAtmos } from "./nyaa-atmos.js";

const SPLASH_MIN_MS = 700;
const splashShownAt = Date.now();
export function hideSplash() {
  const el = $("#app-splash");
  if (!el || el.dataset.hidden) return;
  el.dataset.hidden = "1";
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  // DevSkim: ignore DS172411
  setTimeout(() => import("./splash.js").then(m => m.finishSplash()), wait);
}

export function setDisplayName(name) {
  state.name = name || null;
  const el = $("#whoami");
  if (el) el.textContent = state.name || "";
  setTitlebarIdentity(state.name);
}

async function hydrateIdentity() {
  try {
    const me = await apiGet("/me");
    setDisplayName(me.display_name || me.name);
    state.isDeveloper = !!me.is_developer;
    document.documentElement.dataset.dev = state.isDeveloper ? "1" : "0";
  } catch (_) { }
}

export async function tryRestoreSession() {
  const token = await invoke("token_load");
  if (!token) { hideSplash(); return showAuth(); }
  state.token = token;
  try {
    const who = await api("GET", "/whoami");
    state.telegramId = who.telegram_id;
    await applyRole(!!who.is_admin, !!who.nyaa_access);
    await ensureMediaToken();
    showApp();
    restoreLastTab();
    hideSplash();
    hydrateIdentity();
    await refreshAll();
  } catch (e) {
    if (e.network) {
      hideSplash();
      const note = `${e.message} Пробую снова…`;
      if ($("#auth-screen").hidden) showAuth(note); else $("#auth-error").textContent = note;
      setTimeout(() => { if ($("#app-screen").hidden && state.token) tryRestoreSession(); }, 8000);
      return;
    }
    await invoke("token_clear").catch(() => {});
    resetSessionState();
    hideSplash();
    showAuth(`Сессия истекла: ${e.message}`);
  }
}

function spawnEmbers() {
  const host = document.querySelector(".aw-embers");
  if (!host || host.childElementCount) return;
  for (let i = 0; i < 22; i++) {
    const b = document.createElement("b");
    b.style.setProperty("--x", `${Math.round(Math.random() * 100)}%`);
    b.style.setProperty("--s", `${(3 + Math.random() * 5).toFixed(1)}px`);
    b.style.setProperty("--d", `${(1.8 + Math.random() * 2).toFixed(2)}s`);
    b.style.setProperty("--w", `${(0.9 + Math.random() * 2.6).toFixed(2)}s`);
    b.style.setProperty("--dx", `${Math.round(Math.random() * 40 - 20)}px`);
    host.appendChild(b);
  }
}

function replayWordmark() {
  const word = document.querySelector(".auth-word");
  if (!word) return;
  word.querySelectorAll(".aw-part i").forEach(i => { i.style.animation = "none"; void i.offsetWidth; i.style.animation = ""; });
}

export async function applyRole(isAdmin, nyaaAccess = false) {
  state.isAdmin = isAdmin;
  state.nyaaAccess = isAdmin || nyaaAccess;
  document.documentElement.dataset.role = isAdmin ? "admin" : "member";
  document.documentElement.dataset.nyaa = !isAdmin && nyaaAccess ? "1" : "0";
  await refreshPermissions();
  startPermissionsPolling();
}

let wallCount = null;
async function loadLoginWall() {
  const host = $("#auth-wall");
  if (!host) return;
  try {
    if (wallCount === null) {
      const resp = await fetch(`${API_BASE}/login-wall`);
      wallCount = (await resp.json()).count || 0;
    }
    const count = wallCount;
    if (!count) return;
    host.classList.remove("on");
    const COLS = 5;
    const order = Array.from({ length: count }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const shown = order.slice(0, Math.min(count, 40));
    let html = "";
    for (let c = 0; c < COLS; c++) {
      const ids = [];
      for (let i = c; i < shown.length; i += COLS) ids.push(shown[i]);
      if (!ids.length) continue;
      const imgs = ids.concat(ids).map(i => `<img src="${API_BASE}/login-wall/${i}" alt="" loading="lazy" decoding="async">`).join("");
      html += `<div class="aw-col" style="animation-delay:${-c * 9}s">${imgs}</div>`;
    }
    host.innerHTML = html;
    host.querySelectorAll("img").forEach(img => {
      img.addEventListener("load", () => img.classList.add("in"), { once: true });
      img.addEventListener("error", () => img.remove(), { once: true });
    });
    requestAnimationFrame(() => host.classList.add("on"));
  } catch (_) { }
}

// The sign-in logo flies out to the middle of the screen, dances and goes back (CSS auth-dance-a/b, 10 s each).
// The picture is laid out large (FLY_BOX) and shown scaled down at rest, so it stays sharp when it grows.
const FLY_BOX = 384;
function aimLogoFlight() {
  const img = document.querySelector("#auth-screen .auth-fly");
  const box = img && img.parentElement;
  if (!box || !box.offsetWidth) return;
  const r = box.getBoundingClientRect();
  const target = Math.min(FLY_BOX, Math.min(window.innerWidth, window.innerHeight) * 0.55);
  img.style.setProperty("--rest", String(r.width / FLY_BOX));
  img.style.setProperty("--big", String(target / FLY_BOX));
  img.style.setProperty("--tsz", `${target}px`);
  img.style.setProperty("--fx", `${window.innerWidth / 2 - (r.left + r.width / 2)}px`);
  img.style.setProperty("--fy", `${window.innerHeight / 2 - (r.top + r.height / 2)}px`);
  if (!img.dataset.aimed) {
    img.dataset.aimed = "1";
    window.addEventListener("resize", aimLogoFlight);
  }
}

export function showAuth(err) {
  requestAnimationFrame(aimLogoFlight);
  loadLoginWall();
  spawnEmbers();
  replayWordmark();
  $("#auth-screen").hidden = false;
  $("#app-screen").hidden = true;
  $("#titlebar-apps").hidden = true;
  resetInbox();
  $("#auth-error").textContent = err || "";
  $("#code-input").focus();
  loadCodeLength();
}

export function showApp() {
  $("#auth-screen").hidden = true;
  $("#app-screen").hidden = false;
  initAppAtmos().catch(() => { });
  $("#titlebar-apps").hidden = false;
  setDisplayName(state.name);
  pingPresence();
  loadTitlebarTeam();
  refreshQueueBadge();
  refreshInbox();
  maybeWelcome();
  maybeAskNda();
}

async function submitCode() {
  const code = $("#code-input").value.trim();
  const errEl = $("#auth-error");
  errEl.textContent = "";
  if (!/^\d{4,8}$/.test(code)) {
    errEl.textContent = "Введите код из сообщения бота.";
    return;
  }
  const btn = $("#submit-code");
  btn.disabled = true;
  try {
    const os = navigator.platform || "desktop";
    const result = await api("POST", "/desktop/pair", { code, label: `Desktop (${os})` });
    armSessionExpiry();
    state.token = result.token;
    state.telegramId = result.telegram_id;
    setDisplayName(result.name);
    await invoke("token_save", { token: result.token });
    try { const who = await api("GET", "/whoami"); await applyRole(!!who.is_admin, !!who.nyaa_access); } catch (_) { await applyRole(false); }
    await ensureMediaToken();
    showApp();
    restoreLastTab();
    await refreshAll();
  } catch (e) {
    errEl.textContent = e.message;
    showOops(e.message);
  } finally {
    btn.disabled = false;
  }
}

const OOPS_MASCOTS = [
  {
    src: oopsFrierenGif,
    title: "Упс, Фрирен крутится и мутится",
    text: "…а код не подошёл, и это печально. Для эльфа тысяча лет — миг, а для кода и пара минут — вечность. Отправьте боту /desktop ещё раз.",
  },
  {
    src: oopsFallGif,
    title: "Упс, Бочи упала и не встаёт",
    text: "Код истёк быстрее, чем её социальная батарейка. Отправьте боту /desktop — она попробует подняться. Наверное.",
  },
];
let oopsTimer = null;
let oopsLeaveTimer = null;

function showOops(message) {
  const box = $("#auth-oops");
  if (!box) return;
  const expired = /истек|устар|expired|не найден|неверн|invalid|401/i.test(message || "");
  const mascot = OOPS_MASCOTS[Math.floor(Math.random() * OOPS_MASCOTS.length)];
  $("#auth-oops-title").textContent = expired ? mascot.title : "Упс, что-то пошло не так";
  $("#auth-oops-text").textContent = expired ? mascot.text : (message || "Попробуйте ещё раз.");
  $("#auth-oops-img").src = mascot.src;
  window.clearTimeout(oopsLeaveTimer);
  box.hidden = false;
  box.classList.remove("leave", "drop");
  void box.offsetWidth;
  box.classList.add("drop");
  window.clearTimeout(oopsTimer);
  oopsTimer = window.setTimeout(hideOops, 9000);
}

function hideOops() {
  const box = $("#auth-oops");
  if (!box || box.hidden || box.classList.contains("leave")) return;
  window.clearTimeout(oopsTimer);
  box.classList.add("leave");
  oopsLeaveTimer = window.setTimeout(() => { box.hidden = true; box.classList.remove("leave", "drop"); }, 320);
}
$("#submit-code").addEventListener("click", submitCode);
$("#code-input").addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

let CODE_LEN = 6;

function layoutCodeCells(n) {
  CODE_LEN = n;
  const box = $(".code-boxes");
  const input = $("#code-input");
  box.querySelectorAll(".code-cell, .code-gap").forEach(el => el.remove());
  const half = n / 2;
  const cells = Array.from({ length: n }, () => '<span class="code-cell"></span>');
  box.insertAdjacentHTML("beforeend", [...cells.slice(0, half), '<span class="code-gap"></span>', ...cells.slice(half)].join(""));
  input.maxLength = n;
  $("#code-len-hint").textContent = `Введите ${n} цифр из ответа`;
  renderCodeCells();
}

async function loadCodeLength() {
  try {
    const info = await apiGet("/desktop/pair-info");
    const n = Number(info && info.code_length);
    if ((n === 6 || n === 8) && n !== CODE_LEN) layoutCodeCells(n);
  } catch (_) { }
}

function renderCodeCells() {
  const input = $("#code-input");
  const digits = input.value.replace(/\D/g, "").slice(0, CODE_LEN);
  if (digits !== input.value) input.value = digits;
  const cells = document.querySelectorAll(".code-cell");
  const focused = document.activeElement === input;
  cells.forEach((c, i) => {
    c.textContent = digits[i] || "";
    c.classList.toggle("filled", !!digits[i]);
    c.classList.toggle("active", focused && i === Math.min(digits.length, cells.length - 1));
  });
  return digits;
}

function caretToEnd() {
  const input = $("#code-input");
  const n = input.value.length;
  if (input.selectionStart !== n || input.selectionEnd !== n) input.setSelectionRange(n, n);
}

function codeChanged() {
  $("#auth-error").textContent = "";
  hideOops();
  const digits = renderCodeCells();
  caretToEnd();
  if (digits.length === CODE_LEN && !$("#submit-code").disabled) submitCode();
}

$("#code-input").addEventListener("input", codeChanged);
$("#code-input").addEventListener("keydown", e => {
  const input = e.currentTarget;
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    input.value = e.ctrlKey ? "" : input.value.slice(0, -1);
    codeChanged();
  } else if (e.key === "Escape") {
    e.preventDefault();
    input.value = "";
    codeChanged();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
    e.preventDefault();
  }
});
["focus", "click", "mouseup", "select"].forEach(ev => $("#code-input").addEventListener(ev, () => { renderCodeCells(); caretToEnd(); }));
$("#code-input").addEventListener("blur", renderCodeCells);
renderCodeCells();

function logout() {
  resetTourUi();
  resetSessionState();
  resetAssignmentsBaseline();
  resetChatNotifyBaseline();
  resetFeedBadge();
  clearTabDom();
  armSessionExpiry();
  $("#code-input").value = "";
  renderCodeCells();
  showAuth();
}

$("#logout-btn").addEventListener("click", async () => {
  await invoke("token_clear").catch(() => {});
  logout();
});

document.addEventListener("session-expired", async e => {
  if ($("#app-screen").hidden) return;
  await invoke("token_clear").catch(() => {});
  logout();
  $("#auth-error").textContent = `Сессия истекла (${e.detail}) — войдите заново.`;
});
