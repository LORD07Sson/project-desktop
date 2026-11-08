// Nyaa/игры, вынесено из nyaa.js: слежение.
import { invoke } from "./tauri.js";
import { toast } from "./api.js";
import { state } from "./state.js";
import { notifyDesktop } from "./desktop-notify.js";
import { $, esc } from "./utils.js";
import { CATEGORIES, parseNyaaRss, magnetLink, makeMonitor, monitorTitle, diffMonitor, episodeKey, ruleText, freshForRule } from "./nyaa-core.js";
import { ICONS, client, detail, load, loading, markSent, moreBusy, nyaaRss, prefs, savePrefs, touch } from "./nyaa.js";

// ---------- слежение ----------
export const MON_CHOICES = [[10, "10 минут"], [30, "30 минут"], [60, "час"], [180, "3 часа"]];
const monEveryMs = () => (MON_CHOICES.some(c => c[0] === prefs.monEvery) ? prefs.monEvery : 30) * 60 * 1000;
let lastMonCheck = 0;
let monitorsBusy = false;

function newTotal() { return prefs.monitors.reduce((s, m) => s + (m.new || 0), 0); }

export function paintMonitorBadge() {
  const b = $("#ny-mon-n");
  if (!b) return;
  const n = newTotal();
  b.textContent = n ? String(n) : "";
}

function monitorsHtml() {
  const cats = CATEGORIES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  return `
    <div class="ny-src-head"><div><b>Слежение</b><span>Программа сама проверяет запросы и загрузчиков и сообщает о новых раздачах — и в фоне, если окно закрыто в трей (но не завершена).</span></div>
      <div><button type="button" class="btn" data-mon-check>${monitorsBusy ? "Проверяю…" : "Проверить сейчас"}</button><button type="button" class="ny-ib wide" data-close-panel title="Закрыть" aria-label="Закрыть">${ICONS.close}</button></div></div>
    <div class="ny-mon-every"><label>Проверять раз в <select id="ny-mon-every">${MON_CHOICES.map(([v, l]) => `<option value="${v}"${v === prefs.monEvery ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <div class="ny-mons">${prefs.monitors.length ? prefs.monitors.map(m => `
      <div class="ny-mon${m.new ? " has-new" : ""}">
        <label class="ny-chk"><input type="checkbox" data-mon-toggle="${esc(m.id)}" ${m.on ? "checked" : ""}></label>
        <div class="ny-mon-t"><b>${esc(monitorTitle(m))}</b><span>${m.type === "user" ? "загрузчик" : esc((CATEGORIES.find(c => c[0] === m.cat) || [0, m.cat])[1])}${m.rule ? ` · ${esc(ruleText(m.rule))}` : ""}${m.new ? ` · новых: ${m.new}` : ""}</span></div>
        <button type="button" class="btn ghost" data-mon-open="${esc(m.id)}">Открыть</button>
        <button type="button" class="ny-ib" data-mon-del="${esc(m.id)}" title="Убрать" aria-label="Убрать">${ICONS.close}</button>
      </div>`).join("") : `<div class="wt-empty">Пока ничего не отслеживается.</div>`}</div>
    <div class="ny-mon-add">
      <select id="ny-mon-type"><option value="query">Запрос</option><option value="user">Загрузчик</option></select>
      <input type="text" id="ny-mon-q" placeholder="слова запроса или имя загрузчика" spellcheck="false">
      <select id="ny-mon-cat">${cats}</select>
      <button type="button" class="btn primary" data-mon-add>Добавить</button>
    </div>
    <div class="ny-mon-rule"><b>Правило (по желанию)</b>
      <input type="text" id="ny-mon-groups" placeholder="группы по приоритету: Erai-raws, VARYG" spellcheck="false">
      <select id="ny-mon-res"><option value="">любое качество</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="2160p">2160p</option></select>
      <label><input type="checkbox" id="ny-mon-nohevc"> не HEVC</label>
      <label><input type="checkbox" id="ny-mon-auto"> сразу в торрент-клиент</label>
      <span class="ny-hint">С правилом уведомление приходит только о подходящих раздачах, по одной лучшей на серию — без дублей разных кодеков.</span></div>`;
}

export function paintMonitors() {
  const box = $("#ny-monitors");
  paintMonitorBadge();
  if (!box || box.hidden) return;
  box.innerHTML = monitorsHtml();
}

async function checkMonitor(m, quiet) {
  const xml = await nyaaRss({
    base: prefs.base, query: m.type === "query" ? m.q : "", category: m.cat, filter: "0", page: 1, user: m.type === "user" ? m.q : null,
  });
  const { fresh: raw, seen: nextSeen } = diffMonitor(parseNyaaRss(xml), m);
  m.seen = nextSeen;
  const fresh = freshForRule(raw, m);
  if (fresh.length) {
    m.new = (m.new || 0) + fresh.length;
    if (m.rule) m.got = [...new Set([...(m.got || []), ...fresh.map(episodeKey).filter(Boolean)])].slice(-300);
    if (m.rule && m.rule.auto && client && !quiet) {
      try { await invoke("tc_add", { magnets: fresh.map(magnetLink).filter(Boolean) }); markSent(fresh); fresh.forEach(i => touch(i.id)); } catch (_) { /* уведомление ниже скажет о новом */ }
    }
    if (!quiet) {
      const text = `${monitorTitle(m)}: ${fresh[0].title}${fresh.length > 1 ? ` и ещё ${fresh.length - 1}` : ""}`;
      toast(`Новое на Nyaa — ${text}`, "success");
      notifyDesktop("Новое на Nyaa", text);
    }
  }
}

export async function checkMonitors(manual = false) {
  if (monitorsBusy || !prefs.monitors.some(m => m.on)) { if (manual) toast("Нечего проверять."); return; }
  monitorsBusy = true; paintMonitors();
  let failed = 0;
  for (const m of prefs.monitors.filter(x => x.on)) {
    try { await checkMonitor(m, false); } catch (_) { failed++; }
  }
  savePrefs();
  monitorsBusy = false; paintMonitors();
  if (manual) toast(failed ? `Не удалось проверить: ${failed}` : "Проверка завершена.", failed ? "error" : "success");
}

export async function addMonitor({ type, q, cat, rule = null }) {
  const m = makeMonitor({ type, q, cat: cat || prefs.cat, rule });
  if (!m) { toast(type === "user" ? "Имя загрузчика: латинские буквы, цифры, _ - ." : "Введите слова для слежения.", "error"); return; }
  if (prefs.monitors.some(x => x.type === m.type && x.q.toLowerCase() === m.q.toLowerCase() && x.cat === m.cat)) { toast("Такое слежение уже есть."); return; }
  prefs.monitors = [...prefs.monitors, m].slice(-12);
  savePrefs(); paintMonitors();
  try { await checkMonitor(m, true); savePrefs(); toast(`Слежу: ${monitorTitle(m)}.`, "success"); }
  catch (e) { toast(`Добавлено, но проверить не удалось: ${e}`, "error"); }
  paintMonitors();
}

// Окно можно закрыть: программа остаётся в трее, страница продолжает работать, и слежение идёт в фоне.
// Раз в минуту смотрим, не прошёл ли выбранный интервал, — так смена интервала действует сразу.
function startMonitoring() {
  const tick = () => {
    if (!state.token || !state.isAdmin) return;
    if (lastMonCheck && Date.now() - lastMonCheck < monEveryMs()) return;
    lastMonCheck = Date.now();
    checkMonitors(false);
  };
  setTimeout(tick, 25_000);
  setInterval(tick, 60_000);
}
startMonitoring();

// Фоновое обновление ленты: раз в 5 минут, если страница открыта, ничего не грузится и поиск не набирается.
setInterval(() => {
  if (!$("#ny-list") || loading || moreBusy || document.hidden || detail) return;
  const q = $("#ny-q");
  if (q && document.activeElement === q) return;
  load();
}, 5 * 60 * 1000);

