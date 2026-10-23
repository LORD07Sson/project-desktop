// «Пульс» без серий в работе: сводка по всей команде вместо пустого экрана. Кто в сети и когда был активен, что открывал
// и делал, откуда подключался (IP с маской — только владельцу, как и в «Карте работы») и голосование сезона.

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDur = s => (s >= 3600 ? `${(s / 3600).toFixed(1).replace(".", ",")} ч` : s >= 60 ? `${Math.round(s / 60)} мин` : `${s} с`);
const ago = at => {
  if (!at) return "";
  const d = new Date(String(at).replace(" ", "T") + "Z"), m = Math.round((Date.now() - d.getTime()) / 60000);
  return Number.isNaN(m) ? "" : m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
};
// Те же правила, что у ленты на карте (pulse.js): служебные нажатия окна прячем, похожие действия подряд сворачиваем.
const ACTIONS = { "nav-more": "открыл меню разделов", "btn-refresh": "обновил данные", "btn-search": "открыл поиск", "search": "открыл поиск", "notif": "открыл уведомления" };
function humanText(text) {
  const m = /^нажал в разделе «([^»]+)»: (.+)$/.exec(text);
  if (!m) return text;
  if (/^win-/.test(m[2])) return null;
  return ACTIONS[m[2]] ? `${ACTIONS[m[2]]} · ${m[1]}` : `действие в разделе «${m[1]}»`;
}
function humanRows(list) {
  const out = [];
  for (const r of list) {
    const text = humanText(String(r.text));
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.who === r.who && last.text === text) last.n++; else out.push({ ...r, text, n: 1 });
  }
  return out;
}
const words = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

export function showTeam(wrap, data) {
  const team = data.team || { people: [] };
  const people = team.people || [];
  const persons = (data.algo && data.algo.persons) || {};
  const owner = !!data.workmap;
  const feed = humanRows((data.workmap && data.workmap.recent) || (data.algo && data.algo.feed) || []);
  const votes = team.votes;
  const online = people.filter(p => p.online).length;
  const week = people.filter(p => p.week > 0).length;
  const votedN = people.filter(p => p.voted).length;

  const kpi = (n, l, cls = "") => `<div class="tm-kpi ${cls}"><b>${n}</b><span>${l}</span></div>`;
  const personRow = (p, i) => {
    const pi = persons[p.name], net = pi && pi.net;
    return `<button type="button" class="rrow tm-p" data-i="${i}" aria-expanded="false">
      <span class="tm-ph"><b>${p.online ? `<i class="tm-dot" title="в сети"></i>` : ""}${esc(p.name)}</b><small>${p.online ? "в сети" : p.last_at ? esc(ago(p.last_at)) : "не заходил"}</small></span>
      <span>${esc(p.roles.length ? p.roles.join(", ") : "без роли")}${p.week ? ` · ${p.week} ${words(p.week, "действие", "действия", "действий")} за 7 дн` : ""}${votes ? (p.voted ? " · голосовал" : " · <em class=\"tm-warn\">не голосовал</em>") : ""}</span>
      ${pi && pi.tools && pi.tools.length ? `<small>${esc(pi.tools.slice(0, 3).map(t => t.label).join(", "))}${pi.watch_s ? ` · смотрел ${esc(fmtDur(pi.watch_s))}` : ""}</small>` : ""}
      ${net ? `<small class="${!net.server_ok || net.dns_ok === false ? "bad" : "ok"}">${esc(net.ip || "")}${net.country ? ` · ${esc(net.country)}` : ""}${net.dns_provider ? ` · DNS ${esc(net.dns_provider)}` : ""}</small>` : ""}
    </button><div class="tm-more" data-more="${i}" hidden></div>`;
  };
  const moreHtml = p => {
    const pi = persons[p.name];
    const acts = feed.filter(r => r.who === p.name).slice(0, 12);
    if (!pi && !acts.length) return `<div class="attn-empty">${owner ? "Подробностей нет: человек не включал учёт использования приложения." : "Подробности об использовании видит только владелец."}</div>`;
    const days = pi && pi.days14 && pi.days14.some(Boolean)
      ? `<h4>Активность по дням · 14 дн</h4><div class="pd-days">${(mx => pi.days14.map(c => `<i style="height:${c ? Math.max(8, Math.round(c / mx * 100)) : 3}%" title="${c}"></i>`).join(""))(Math.max(1, ...pi.days14))}</div>` : "";
    const tools = pi && pi.tools && pi.tools.length ? `<h4>Что открывал</h4>${pi.tools.map(t => `<div class="pd-tool"><span>${esc(t.label)}</span><i>${t.count} раз${t.seconds ? ` · ${esc(fmtDur(t.seconds))}` : ""}</i></div>`).join("")}` : "";
    const watch = pi && pi.watch && pi.watch.length ? `<h4>Что смотрел</h4>${pi.watch.map(w => `<div class="pd-tool"><span>${esc(w.title)}</span><i>${esc(fmtDur(w.seconds))}</i></div>`).join("")}` : "";
    const net = pi && pi.net ? `<h4>Связь</h4><div class="pd-tool"><span>Откуда</span><i>${esc(pi.net.ip || "—")}${pi.net.country ? ` · ${esc(pi.net.country)}` : ""}</i></div><div class="pd-tool"><span>Сервер</span><i class="${pi.net.server_ok ? "ok" : "bad"}">${pi.net.server_ok ? "доступен" : "нет связи"}${pi.net.server_ms ? ` · ${pi.net.server_ms} мс` : ""}</i></div><div class="pd-tool"><span>DNS</span><i class="${pi.net.dns_ok === false ? "bad" : "ok"}">${pi.net.dns_ok === false ? "не отвечает" : "работает"}${pi.net.dns_provider ? ` · ${esc(pi.net.dns_provider)}` : ""}</i></div>` : "";
    const last = acts.length ? `<h4>Последние действия</h4>${acts.map(r => `<div class="pd-tool"><span>${esc(r.text)}${r.n > 1 ? ` ×${r.n}` : ""}</span><i>${esc(ago(r.at))}</i></div>`).join("")}` : "";
    return days + tools + watch + net + last;
  };
  const voteHtml = () => {
    if (!votes) return `<div class="attn-empty">Сезона для голосования пока нет.</div>`;
    const rows = votes.titles.map(t => `<div class="rrow tm-v"><b>${esc(t.name)}</b>
      <span><em class="tm-up">👍 ${t.likes.length}</em>${t.likes.length ? ` ${esc(t.likes.join(", "))}` : ""}</span>
      ${t.dislikes.length ? `<span><em class="tm-down">👎 ${t.dislikes.length}</em> ${esc(t.dislikes.join(", "))}</span>` : ""}</div>`).join("");
    const nv = votes.not_voted.length ? `<div class="tm-nv"><div class="attn-h"><span><b>●</b> ЕЩЁ НЕ ГОЛОСОВАЛИ</span><span>${votes.not_voted.length}</span></div><div class="tm-chips">${votes.not_voted.map(n => `<span>${esc(n)}</span>`).join("")}</div></div>` : "";
    return nv + rows;
  };

  wrap.classList.add("team-mode");
  wrap.innerHTML = `<div class="tm">
    <div class="tm-head"><div><small>ПУЛЬС · КОМАНДА</small><h1>Серий в работе нет — вот что происходит в команде</h1></div>
      <div class="tm-kpis">${kpi(online, "в сети", online ? "on" : "")}${kpi(week, "активны за 7 дн")}${kpi(people.length, "в команде")}${votes ? kpi(`${votedN}/${people.length}`, `голосовали · ${esc(votes.season || "")}`) : ""}</div></div>
    <div class="tm-grid">
      <section class="tm-col"><div class="attn-h"><span><b>●</b> ЛЮДИ</span><span>${people.length}</span></div>${people.map(personRow).join("") || `<div class="attn-empty">Пока никого.</div>`}</section>
      <section class="tm-col"><div class="attn-h"><span><b>●</b> КТО ЧТО ДЕЛАЕТ</span><span>${feed.length}</span></div>${feed.length
        ? feed.slice(0, 60).map(r => `<div class="rrow log"><div class="lh"><b>${esc(r.who)}</b><small>${esc(ago(r.at))}</small></div><span>${esc(r.text)}${r.n > 1 ? ` <em class="x">×${r.n}</em>` : ""}</span></div>`).join("")
        : `<div class="attn-empty">${owner ? "Пока ничего не замечено." : "Ленту действий и сеть видит только владелец."}</div>`}</section>
      <section class="tm-col"><div class="attn-h"><span><b>●</b> ГОЛОСОВАНИЕ${votes && votes.season ? ` · ${esc(votes.season.toUpperCase())}` : ""}</span><span>${votes ? votes.titles.length : 0}</span></div>${voteHtml()}</section>
    </div></div>`;
  wrap.querySelectorAll(".tm-p").forEach(b => b.addEventListener("click", () => {
    const i = Number(b.dataset.i), box = wrap.querySelector(`[data-more="${i}"]`);
    const open = box.hidden;
    if (open && !box.innerHTML) box.innerHTML = moreHtml(people[i]);
    box.hidden = !open;
    b.setAttribute("aria-expanded", String(open));
  }));
}
