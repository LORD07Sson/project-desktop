// «Карта работы» (Аналитика, только владелец): алгоритм по истории смен этапов и событиям приложения рисует, кто на каких
// этапах и в каких инструментах работает, где серии стоят и когда примерно выйдут. Данные считает сервер (/analytics/work-map).
// Граф: сверху этапы серии цепочкой, ниже люди, ещё ниже инструменты; толщина линии — как часто. Красным — узкое место.

import { apiGet } from "./api.js";
import { esc } from "./utils.js";

const W = 1000;
const STAGE_COLOR = { draft: "var(--s-draft, #8a8a9a)", review: "var(--s-review, #9b7bff)", working: "var(--s-work, #e6b422)", revision: "var(--s-stop, #e07b39)", completed: "var(--s-done, #3ecf8e)" };

const fmtH = h => (h == null ? "—" : h < 1 ? `${Math.max(1, Math.round(h * 60))} мин` : h < 48 ? `${Math.round(h)} ч` : `${(h / 24).toFixed(1).replace(".", ",")} дн.`);
const fmtDur = s => (s >= 3600 ? `${(s / 3600).toFixed(1).replace(".", ",")} ч` : s >= 60 ? `${Math.round(s / 60)} мин` : `${s} с`);
const fmtEta = ts => new Date(ts * 1000).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const stripEmoji = t => String(t || "").replace(/^[^\p{L}\p{N}]+/u, "");

function spread(n, from = 90, to = W - 90) {
  if (n <= 1) return [W / 2];
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

function mapSvg(m) {
  const stages = m.stages.filter(s => s.key !== "cancelled");
  const people = m.people;
  const tools = m.tools.slice(0, 8);
  const sxs = spread(stages.length), pxs = spread(people.length), txs = spread(tools.length);
  const sx = Object.fromEntries(stages.map((s, i) => [s.key, sxs[i]]));
  const px = Object.fromEntries(people.map((p, i) => [p.id, pxs[i]]));
  const tx = Object.fromEntries(tools.map((t, i) => [t.key, txs[i]]));
  const Y = { stage: 70, person: 250, tool: 430 };
  const maxPS = Math.max(1, ...m.person_stage.map(e => e.count));
  const maxPT = Math.max(1, ...m.person_tool.map(e => e.count));
  const maxST = Math.max(1, ...m.stage_edges.map(e => e.count));
  const curve = (x1, y1, x2, y2) => { const my = (y1 + y2) / 2; return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`; };
  const personName = id => (people.find(p => p.id === id) || {}).name || "";

  const ps = m.person_stage.filter(e => px[e.person] != null && sx[e.stage] != null).map(e =>
    `<path class="wm-edge" d="${curve(px[e.person], Y.person - 22, sx[e.stage], Y.stage + 30)}" stroke-width="${(1 + 4 * e.count / maxPS).toFixed(1)}"><title>${esc(personName(e.person))} → этап: ${e.count} раз</title></path>`).join("");
  const pt = m.person_tool.filter(e => px[e.person] != null && tx[e.tool] != null).map(e =>
    `<path class="wm-edge tool" d="${curve(px[e.person], Y.person + 22, tx[e.tool], Y.tool - 26)}" stroke-width="${(1 + 4 * e.count / maxPT).toFixed(1)}"><title>${esc(personName(e.person))} · ${esc((tools.find(t => t.key === e.tool) || {}).label || e.tool)}: ${e.count} раз${e.seconds ? `, ${fmtDur(e.seconds)}` : ""}</title></path>`).join("");
  const arrows = m.stage_edges.filter(e => e.from && sx[e.from] != null && sx[e.to] != null && e.from !== e.to).map(e => {
    const x1 = sx[e.from], x2 = sx[e.to];
    const dir = x2 > x1 ? 1 : -1;
    const bend = dir > 0 ? -34 : 34;
    return `<path class="wm-flow${dir < 0 ? " back" : ""}" d="M${x1 + dir * 34},${Y.stage - 6} Q${(x1 + x2) / 2},${Y.stage + bend - 26} ${x2 - dir * 34},${Y.stage - 6}" stroke-width="${(1 + 3 * e.count / maxST).toFixed(1)}" marker-end="url(#wm-arr)"><title>${e.count} раз${e.median_h != null ? `, обычно ${fmtH(e.median_h)} на этапе` : ""}</title></path>`;
  }).join("");

  const stageNodes = stages.map(s => `
    <g class="wm-node${s.bottleneck ? " hot" : ""}" transform="translate(${sx[s.key]},${Y.stage})">
      <rect x="-62" y="-30" width="124" height="60" rx="16" style="--c:${STAGE_COLOR[s.key] || "var(--ink-dim)"}"/>
      <text class="t1" y="-5" text-anchor="middle">${esc(stripEmoji(s.label))}</text>
      <text class="t2" y="15" text-anchor="middle">${s.median_h != null && s.samples >= 2 ? `обычно ${fmtH(s.median_h)}` : "мало данных"}${s.open ? ` · ${s.open} в работе` : ""}</text>
      ${s.stuck ? `<circle cx="56" cy="-26" r="9" class="wm-badge"/><text x="56" y="-22" text-anchor="middle" class="wm-badge-t">${s.stuck}</text>` : ""}
      <title>${esc(stripEmoji(s.label))}: наблюдений ${s.samples}${s.bottleneck ? " · узкое место" : ""}</title>
    </g>`).join("");
  const personNodes = people.map(p => `
    <g class="wm-node person" transform="translate(${px[p.id]},${Y.person})"><circle r="22"/><text class="t1" y="5" text-anchor="middle">${esc((p.name || "?").charAt(0).toUpperCase())}</text>
      <text class="t2" y="40" text-anchor="middle">${esc(String(p.name).slice(0, 14))}</text><title>${esc(p.name)}</title></g>`).join("");
  const toolNodes = tools.map(t => `
    <g class="wm-node tool" transform="translate(${tx[t.key]},${Y.tool})"><rect x="-52" y="-24" width="104" height="48" rx="14"/>
      <text class="t1" y="-3" text-anchor="middle">${esc(t.label)}</text><text class="t2" y="14" text-anchor="middle">${t.uses}×${t.seconds ? ` · ${fmtDur(t.seconds)}` : ""}</text></g>`).join("");

  return `<svg class="wm-svg" viewBox="0 0 ${W} 490" role="img" aria-label="Карта работы команды">
    <defs><marker id="wm-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="wm-arrow-head"/></marker></defs>
    <text class="wm-row" x="8" y="22">ЭТАПЫ СЕРИИ</text><text class="wm-row" x="8" y="198">ЛЮДИ</text><text class="wm-row" x="8" y="374">ИНСТРУМЕНТЫ</text>
    ${ps}${pt}${arrows}${stageNodes}${personNodes}${toolNodes}
  </svg>`;
}

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
      <div class="kd-ch"><h3>Карта работы</h3><span class="kd-label">за ${m.days} дней · событий ${m.events_total}</span></div>
      <p class="ar-hint" style="margin:0 0 10px;">Алгоритм сам собирает схему по смене этапов серий и по тому, что люди делают в приложении (экраны, нажатия, скачивания, просмотр) — без текста и содержимого. Чем больше истории, тем точнее сроки.</p>
      ${empty ? `<div class="no-assignee">Данных пока мало — карта заполнится по мере работы.</div>` : mapSvg(m)}
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
