// «Пульс» без серий в работе: экран «Команда» вместо пустой карты. Люди (фото, роли, в сети ли, активность за 14 дней),
// лента — действия, собранные в сессии, голосование сезона. По клику на человека — боковая панель со всем, что о нём известно:
// что открывал и смотрел, откуда подключался (IP с маской — только владельцу, как в «Карте работы»), последние действия.

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDur = s => (s >= 3600 ? `${(s / 3600).toFixed(1).replace(".", ",")} ч` : s >= 60 ? `${Math.round(s / 60)} мин` : `${s} с`);
const toDate = at => new Date(String(at).replace(" ", "T") + "Z");
const ago = at => {
  if (!at) return "";
  const d = toDate(at), m = Math.round((Date.now() - d.getTime()) / 60000);
  return Number.isNaN(m) ? "" : m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
};
const words = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const hue = name => { let h = 0; for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };

// Служебные нажатия окна в ленту не попадают (как и на карте, pulse.js).
function cleanText(text) {
  const m = /^нажал в разделе «([^»]+)»: (.+)$/.exec(text);
  if (m && /^win-/.test(m[2])) return null;
  return text;
}
// Действия одного человека с паузами меньше 20 минут — одна сессия: какие разделы он прошёл и что ещё сделал.
const SESSION_GAP = 20 * 60000;
function sessions(list) {
  const out = [];
  for (const r of list) {          // от новых к старым
    const text = cleanText(String(r.text || ""));
    if (!text) continue;
    const t = toDate(r.at).getTime();
    const last = out.find(s => s.who === r.who && s.from - t < SESSION_GAP && s.from >= t);
    const s = last || { who: r.who, to: t, from: t, at: r.at, places: [], other: [], n: 0 };
    if (!last) out.push(s);
    s.from = Math.min(s.from, t); s.n++;
    const place = /«([^»]+)»/.exec(text);
    if (place && /^(был на экране|действие в разделе|нажал в разделе)/.test(text)) {
      if (s.places[0] !== place[1]) s.places.unshift(place[1]);      // хронологический порядок, без повторов подряд
    } else if (!s.other.includes(text)) s.other.unshift(text);
  }
  return out.sort((a, b) => b.to - a.to);
}

export function showTeam(wrap, data) {
  const team = data.team || { people: [] };
  const people = team.people || [];
  const byName = Object.fromEntries(people.map(p => [p.name, p]));
  const persons = (data.algo && data.algo.persons) || {};
  const owner = !!data.workmap;
  const feed = (data.workmap && data.workmap.recent) || (data.algo && data.algo.feed) || [];
  const sess = sessions(feed).slice(0, 40);
  const votes = team.votes;
  const seen = people.filter(p => p.last_at), never = people.filter(p => !p.last_at);
  const online = people.filter(p => p.online).length;
  const week = people.filter(p => p.week > 0).length;
  const votedN = people.filter(p => p.voted).length;

  const av = (name, size = "", ring = "") => {
    const p = byName[name] || {};
    const img = p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : "";
    return `<span class="tm-av ${size} ${ring}" style="--h:${hue(name)}" title="${esc(name)}">${esc((String(name).trim()[0] || "?").toUpperCase())}${img}</span>`;
  };
  const spark = days => {
    const mx = Math.max(1, ...days);
    return `<span class="tm-spark" aria-label="Активность за 14 дней">${days.map(c => `<i style="height:${c ? Math.max(14, Math.round(c / mx * 100)) : 6}%"${c ? "" : ' class="z"'}></i>`).join("")}</span>`;
  };
  const tile = p => {
    const pi = persons[p.name];
    return `<button type="button" class="tm-tile${p.online ? " on" : ""}" data-p="${esc(p.name)}">
      <span class="tm-tile-top">${av(p.name, "", p.online ? "is-on" : "")}<span class="tm-who"><b>${esc(p.name)}</b><small>${esc(p.roles.length ? p.roles.join(" · ") : "без роли")}</small></span>
        <em class="tm-state${p.online ? " is-on" : ""}">${p.online ? "в сети" : esc(ago(p.last_at))}</em></span>
      <span class="tm-tile-bot">${pi && pi.days14 && pi.days14.some(Boolean) ? spark(pi.days14) : `<span class="tm-spark-ph"></span>`}
        <span class="tm-week"><b>${p.week}</b> ${words(p.week, "действие", "действия", "действий")} за 7 дн${votes && !p.voted ? `<br><em>не голосовал</em>` : ""}</span></span>
    </button>`;
  };
  const sessHtml = s => {
    const places = s.places.slice(0, 7);
    const dur = Math.round((s.to - s.from) / 60000);
    return `<div class="tm-s">${av(s.who, "sm")}<div class="tm-s-body">
      <div class="tm-s-h"><button type="button" class="tm-link" data-p="${esc(s.who)}">${esc(s.who)}</button><small>${esc(ago(s.at))}${dur >= 2 ? ` · ${dur} мин` : ""} · ${s.n} ${words(s.n, "действие", "действия", "действий")}</small></div>
      ${places.length ? `<div class="tm-path">${places.map(x => `<span>${esc(x)}</span>`).join('<i aria-hidden="true">→</i>')}${s.places.length > places.length ? `<em>+${s.places.length - places.length}</em>` : ""}</div>` : ""}
      ${s.other.slice(0, 3).map(t => `<div class="tm-s-x">${esc(t)}</div>`).join("")}
    </div></div>`;
  };
  const voteHtml = () => {
    if (!votes) return `<p class="tm-muted">Сезона для голосования пока нет.</p>`;
    return votes.titles.map((t, i) => {
      const total = t.likes.length + t.dislikes.length, pct = total ? Math.round(t.likes.length / total * 100) : 0;
      return `<div class="tm-vote"><span class="tm-rank">${i + 1}</span><div class="tm-vote-b">
        <b title="${esc(t.name)}">${esc(t.name)}</b>
        <span class="tm-vbar"><i style="width:${total ? pct : 0}%"></i>${t.dislikes.length ? `<i class="dn" style="width:${100 - pct}%"></i>` : ""}</span>
        <span class="tm-vrow"><span class="tm-stack">${t.likes.map(n => av(n, "xs", "up")).join("")}${t.dislikes.map(n => av(n, "xs", "dn")).join("")}</span>
          <small>${total ? `<b class="up">${t.likes.length}</b> за${t.dislikes.length ? ` · <b class="dn">${t.dislikes.length}</b> против` : ""}` : "нет голосов"}</small></span>
      </div></div>`;
    }).join("");
  };

  wrap.classList.add("team-mode");
  wrap.innerHTML = `<div class="tm">
    <header class="tm-head">
      <div><small class="tm-eye">Пульс студии</small><h1>Команда</h1><p>Серий в работе сейчас нет — здесь видно, кто чем занят.</p></div>
      <div class="tm-stats">
        <div class="tm-stat"><b class="${online ? "is-on" : ""}">${online}</b><span>в сети</span></div>
        <div class="tm-stat"><b>${week}</b><span>активны за неделю</span></div>
        <div class="tm-stat"><b>${people.length}</b><span>в команде</span></div>
        ${votes ? `<div class="tm-stat wide"><b>${votedN}<small>/${people.length}</small></b><span>голосовали · ${esc(votes.season || "")}</span><i class="tm-prog"><i style="width:${Math.round(votedN / Math.max(1, people.length) * 100)}%"></i></i></div>` : ""}
      </div>
    </header>
    <div class="tm-main">
      <div class="tm-left">
        <section><h2>Люди <span>${seen.length}</span></h2>
          <div class="tm-tiles">${seen.map(tile).join("") || `<p class="tm-muted">Пока никто не заходил.</p>`}</div>
          ${never.length ? `<div class="tm-never"><span>Ещё ни разу не заходили</span><div>${never.map(p => `<button type="button" class="tm-chip" data-p="${esc(p.name)}">${av(p.name, "xs")}${esc(p.name)}</button>`).join("")}</div></div>` : ""}
        </section>
        <section><h2>Кто что делал <span>${sess.length}</span></h2>
          ${sess.length ? `<div class="tm-feed">${sess.map(sessHtml).join("")}</div>` : `<p class="tm-muted">${owner ? "Пока ничего не замечено." : "Ленту действий видит только владелец."}</p>`}
        </section>
      </div>
      <aside class="tm-right"><section><h2>Голосование ${votes && votes.season ? `<span>${esc(votes.season)}</span>` : ""}</h2>
        ${votes && votes.not_voted.length ? `<div class="tm-nv"><small>Ещё не голосовали · ${votes.not_voted.length}</small><div class="tm-stack big">${votes.not_voted.map(n => av(n, "sm")).join("")}</div></div>` : ""}
        <div class="tm-votes">${voteHtml()}</div></section></aside>
    </div>
    <div class="tm-scrim" hidden></div><aside class="tm-drawer" hidden aria-label="Сведения о человеке"></aside>
  </div>`;

  const drawer = wrap.querySelector(".tm-drawer"), scrim = wrap.querySelector(".tm-scrim");
  const close = () => { drawer.classList.remove("on"); scrim.classList.remove("on"); setTimeout(() => { if (!drawer.classList.contains("on")) { drawer.hidden = true; scrim.hidden = true; } }, 220); };
  const open = name => {
    const p = byName[name]; if (!p) return;
    const pi = persons[name] || null, net = pi && pi.net;
    const mine = sessions(feed.filter(r => r.who === name)).slice(0, 8);
    const sec = (title, body) => body ? `<h4>${title}</h4>${body}` : "";
    const rows = list => list.map(([a, b, cls = ""]) => `<div class="pd-tool"><span>${esc(a)}</span><i class="${cls}">${esc(b)}</i></div>`).join("");
    drawer.innerHTML = `<div class="tm-d-h">${av(name, "lg", p.online ? "is-on" : "")}<div><h3>${esc(name)}</h3><small>${esc(p.roles.join(" · ") || "без роли")}</small></div>
        <button type="button" class="pd-x" aria-label="Закрыть">×</button></div>
      <div class="tm-d-k"><div><b>${p.online ? "в сети" : esc(ago(p.last_at) || "—")}</b><span>последняя активность</span></div><div><b>${p.week}</b><span>действий за 7 дн</span></div><div><b>${votes ? (p.voted ? "да" : "нет") : "—"}</b><span>голосовал</span></div></div>
      <div class="pd-body">
        ${pi && pi.days14 && pi.days14.some(Boolean) ? `<h4>Активность · 14 дней</h4><div class="tm-d-spark">${spark(pi.days14)}</div>` : ""}
        ${sec("Что открывал", pi && pi.tools && pi.tools.length ? rows(pi.tools.map(t => [t.label, `${t.count} раз${t.seconds ? ` · ${fmtDur(t.seconds)}` : ""}`])) : "")}
        ${sec("Что смотрел", pi && pi.watch && pi.watch.length ? rows(pi.watch.map(w => [w.title, fmtDur(w.seconds)])) : "")}
        ${sec("Связь", net ? rows([["Откуда", `${net.ip || "—"}${net.country ? ` · ${net.country}` : ""}`], ["Сервер", net.server_ok ? `доступен${net.server_ms ? ` · ${net.server_ms} мс` : ""}` : "нет связи", net.server_ok ? "ok" : "bad"], ["DNS", `${net.dns_ok === false ? "не отвечает" : "работает"}${net.dns_provider ? ` · ${net.dns_provider}` : ""}`, net.dns_ok === false ? "bad" : "ok"]]) : "")}
        ${sec("Последние сессии", mine.length ? `<div class="tm-feed compact">${mine.map(s => sessHtml(s)).join("")}</div>` : "")}
        ${!pi && !mine.length ? `<p class="tm-muted">${owner ? (p.last_at ? "Учёт использования приложения у человека выключен." : "Человек ещё ни разу не заходил в приложение.") : "Подробности об использовании видит только владелец."}</p>` : ""}
      </div>`;
    drawer.querySelector(".pd-x").addEventListener("click", close);
    drawer.hidden = false; scrim.hidden = false;
    requestAnimationFrame(() => { drawer.classList.add("on"); scrim.classList.add("on"); });
  };
  wrap.addEventListener("click", e => {
    const b = e.target.closest("[data-p]");
    if (b && !drawer.contains(b)) open(b.dataset.p);
  });
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
}
