// «Карта работы» (Аналитика, только владелец): алгоритм по истории смен этапов и событиям приложения рисует, кто на каких
// этапах и в каких инструментах работает, где серии стоят и когда примерно выйдут. Данные считает сервер (/analytics/work-map).
// Схема-граф теперь рисуется в «Пульсе студии» (pulse.html); здесь — то, что алгоритм заметил словами и таблицами.

import { apiGet } from "./api.js";
import { esc } from "./utils.js";

const fmtH = h => (h == null ? "—" : h < 1 ? `${Math.max(1, Math.round(h * 60))} мин` : h < 48 ? `${Math.round(h)} ч` : `${(h / 24).toFixed(1).replace(".", ",")} дн.`);
const fmtEta = ts => new Date(ts * 1000).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const stripEmoji = t => String(t || "").replace(/^[^\p{L}\p{N}]+/u, "");

const fmtAt = at => {
  const d = new Date(String(at).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  if (mins < 1440) return `${Math.round(mins / 60)} ч назад`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
};

function netHtml(net) {
  if (!net || !net.people.length) return `<div class="no-assignee">Проверок связи пока нет — они появятся, когда люди включат статистику и запустят приложение.</div>`;
  const rows = net.people.map(r => `
    <div class="wm-net${!r.server_ok || r.dns_ok === false ? " bad" : ""}">
      <b>${esc(r.who)}</b>
      <span class="wm-ip">${esc(r.ip || "—")}${r.country ? ` · ${esc(r.country)}` : ""}</span>
      <span class="wm-ok ${r.server_ok ? "ok" : "no"}">${r.server_ok ? `сервер ✓ ${r.server_ms != null ? `${r.server_ms} мс` : ""}` : `сервер ✗ ${esc(r.server_error || "")}`}</span>
      <span class="wm-ok ${r.dns_ok === false ? "no" : r.dns_ok ? "ok" : ""}">DNS ${r.dns_ok === false ? "✗" : r.dns_ok ? "✓" : "?"} ${esc(r.dns_provider || "")}</span>
      <i>${esc(fmtAt(r.at))}${r.checks > 1 ? ` · сбоев ${r.server_fail + r.dns_fail} из ${r.checks}` : ""}</i>
    </div>`).join("");
  const groups = (title, list) => list.length ? `<div class="wm-grp"><b>${title}</b>${list.map(g => `<span class="${g.fail_pct >= 30 ? "bad" : ""}">${esc(g.name)}: ${g.checks} пров., сбоев ${g.fail_pct}%</span>`).join("")}</div>` : "";
  return `<div class="wm-nets">${rows}</div>${groups("По DNS", net.by_dns)}${groups("По странам", net.by_country)}`;
}

function workMapHtml(m) {
  const recent = (m.recent || []).map(r => `<div class="wm-rec"><b>${esc(r.who)}</b><span>${esc(r.text)}</span><i>${esc(fmtAt(r.at))}</i></div>`).join("");
  const empty = !m.people.length && !m.tools.length && !m.stage_edges.length;
  const insights = m.insights.map(t => `<li>${esc(t)}</li>`).join("");
  const active = m.active.map(a => `
    <div class="wm-row-a${a.stuck ? " stuck" : ""}">
      <b>${esc(a.public_id)}</b><span class="wm-t">${esc(String(a.title || "").slice(0, 60))}</span>
      <span class="wm-s">${esc(stripEmoji(a.status_label))} · ${fmtH(a.age_h)} на этапе</span>
      <span class="wm-eta">${a.learned ? "" : "≈ "}${a.eta_h <= 0.1 ? "пора двигать дальше" : `до выхода ~${fmtH(a.eta_h)} · ${esc(fmtEta(a.eta_ts))}`}</span>
      ${a.stuck ? `<i class="wm-warn">стоит дольше обычного</i>` : ""}
    </div>`).join("");
  return `
    <div class="bcell wm-cell" style="margin-top:16px;">
      <div class="kd-ch"><h3>Что видит алгоритм</h3><span class="kd-label">за ${m.days} дней · событий ${m.events_total}</span></div>
      <p class="ar-hint" style="margin:0 0 10px;">Алгоритм сам собирает схему по смене этапов серий и по тому, что люди делают в приложении (экраны, нажатия, скачивания, просмотр) — без текста и содержимого. Чем больше истории, тем точнее сроки.</p>
      ${empty ? `<div class="no-assignee">Данных пока мало — карта заполнится по мере работы.</div>` : ""}
      ${insights ? `<ul class="wm-insights">${insights}</ul>` : ""}
      <div class="kd-ch" style="margin-top:14px;"><h3>Кто что делает</h3><span class="kd-label">последние действия</span></div>
      <div class="wm-recent">${recent || `<div class="no-assignee">Пока ничего не замечено</div>`}</div>
      <div class="kd-ch" style="margin-top:14px;"><h3>Связь команды с сервером</h3><span class="kd-label">IP наполовину скрыт · страна · DNS</span></div>
      ${netHtml(m.network)}
      <div class="kd-ch" style="margin-top:14px;"><h3>Серии в работе и ожидаемый срок</h3><span class="kd-label">по типичному времени этапов</span></div>
      <div class="wm-active">${active || `<div class="no-assignee">Нет серий в работе</div>`}</div>
    </div>`;
}

/** Рисует карту в конец контейнера; для не-владельцев сервер отвечает отказом — тогда блок не показываем. */
export async function appendWorkMap(root) {
  let m;
  try { m = await apiGet("/analytics/work-map", { days: 30 }); } catch (_) { return; }
  const host = document.createElement("div");
  host.id = "work-map";
  host.innerHTML = workMapHtml(m);
  root.querySelector("#work-map")?.remove();
  root.appendChild(host);
}
