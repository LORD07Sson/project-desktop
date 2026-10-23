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

const dayAt = i => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - (13 - i)); return d; };
const fmtDay = d => d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

// Столбики за 14 дней с пунктиром «среднее»; data-i — для подсказки при наведении.
function barsHtml(days) {
  const mx = Math.max(1, ...days), avg = days.reduce((a, b) => a + b, 0) / days.length;
  return `<div class="tm-bars">${days.map((c, i) => `<i data-i="${i}" class="${i === 13 ? "today" : ""}${c ? "" : " z"}" style="--v:${c ? Math.max(4, c / mx * 100) : 2}%"></i>`).join("")}
    ${avg ? `<span class="tm-avg" style="bottom:${avg / mx * 100}%"><em>ср ${Math.round(avg)}</em></span>` : ""}</div>
    <div class="tm-bars-x"><span>${fmtDay(dayAt(0))}</span><span>${fmtDay(dayAt(7))}</span><span>сегодня</span></div>`;
}

// Радар: каждая ось — раздел приложения; при наведении на ось заголовок плитки показывает её число.
function radarSvg(axes, size = 220) {
  const c = size / 2, r = size / 2 - 34, n = axes.length, mx = Math.max(1, ...axes.map(a => a.value));
  const pt = (i, k) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [c + Math.cos(a) * r * k, c + Math.sin(a) * r * k]; };
  const ring = k => axes.map((_, i) => pt(i, k).map(v => v.toFixed(1)).join(",")).join(" ");
  const poly = axes.map((a, i) => pt(i, Math.max(.06, a.value / mx)).map(v => v.toFixed(1)).join(",")).join(" ");
  return `<svg class="tm-radar" viewBox="0 0 ${size} ${size}" role="img" aria-label="Разделы приложения">
    ${[.25, .5, .75, 1].map(k => `<polygon class="g" points="${ring(k)}"/>`).join("")}
    ${axes.map((_, i) => { const [x, y] = pt(i, 1); return `<line class="g" x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join("")}
    <polygon class="shape" points="${poly}"/>
    ${axes.map((a, i) => { const [x, y] = pt(i, Math.max(.06, a.value / mx)); return `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`; }).join("")}
    ${axes.map((a, i) => { const [x, y] = pt(i, 1.2); return `<text data-ax="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${esc(a.label)}</text>`; }).join("")}
    ${axes.map((a, i) => { const [x, y] = pt(i, 1); return `<line class="hit" data-ax="${i}" x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join("")}
  </svg>`;
}
function ringSvg(part, total) {
  const r = 34, len = 2 * Math.PI * r, k = total ? part / total : 0;
  return `<svg class="tm-ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="${r}" class="bg"/><circle cx="42" cy="42" r="${r}" class="fg" style="--len:${len.toFixed(1)};--off:${(len * (1 - k)).toFixed(1)}"/></svg>`;
}
function countUp(root) {
  root.querySelectorAll("[data-count]").forEach(el => {
    const to = Number(el.dataset.count) || 0, t0 = performance.now(), dur = 700;
    const step = t => { const k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString("ru-RU"); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
const topTools = (tools, n = 6) => tools.filter(t => t.count > 0).sort((a, b) => b.count - a.count).slice(0, n).map(t => ({ label: t.label, value: t.count }));

export function showTeam(wrap, data, { onMap = null } = {}) {
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
  // Активность всей команды по дням и разделы, куда ходят чаще всего (есть только у владельца — из «Карты работы»).
  const plist = Object.values(persons);
  const teamDays = plist.length ? Array.from({ length: 14 }, (_, i) => plist.reduce((a, pi) => a + ((pi.days14 || [])[i] || 0), 0)) : null;
  const hasDays = teamDays && teamDays.some(Boolean);
  const thisWeek = hasDays ? teamDays.slice(7).reduce((a, b) => a + b, 0) : 0, lastWeek = hasDays ? teamDays.slice(0, 7).reduce((a, b) => a + b, 0) : 0;
  const delta = lastWeek ? Math.round((thisWeek - lastWeek) / lastWeek * 100) : null;
  const toolSum = {};
  for (const pi of plist) for (const t of pi.tools || []) toolSum[t.label] = (toolSum[t.label] || 0) + t.count;
  const teamAxes = topTools(Object.entries(toolSum).map(([label, count]) => ({ label, count })));
  const onlinePeople = people.filter(p => p.online);

  const av = (name, size = "", ring = "") => {
    const p = byName[name] || {};
    const img = p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : "";
    return `<span class="tm-av ${size} ${ring}" style="--h:${hue(name)}" title="${esc(name)}">${esc((String(name).trim()[0] || "?").toUpperCase())}${img}</span>`;
  };
  const spark = days => {
    const mx = Math.max(1, ...days);
    return `<span class="tm-spark" aria-label="Активность за 14 дней">${days.map(c => `<i style="height:${c ? Math.max(14, Math.round(c / mx * 100)) : 6}%"${c ? "" : ' class="z"'}></i>`).join("")}</span>`;
  };
  const tile = (p, i) => {
    const pi = persons[p.name];
    return `<button type="button" class="tm-tile tm-rise${p.online ? " on" : ""}" style="--i:${i}" data-p="${esc(p.name)}" ${filterAttrs(p)}>
      <span class="tm-tile-top">${av(p.name, "", p.online ? "is-on" : "")}<span class="tm-who"><b>${esc(p.name)}</b><small>${esc(p.roles.length ? p.roles.join(" · ") : "без роли")}</small></span>
        <em class="tm-state${p.online ? " is-on" : ""}">${p.online ? "в сети" : esc(ago(p.last_at))}</em></span>
      <span class="tm-tile-bot">${pi && pi.days14 && pi.days14.some(Boolean) ? spark(pi.days14) : `<span class="tm-spark-ph"></span>`}
        <span class="tm-week"><b>${p.week}</b> ${words(p.week, "действие", "действия", "действий")} за 7 дн${votes && !p.voted ? `<br><em>не голосовал</em>` : ""}</span></span>
    </button>`;
  };
  const filterAttrs = p => `data-on="${p.online ? 1 : 0}" data-act="${p.week > 0 ? 1 : 0}" data-nv="${votes && !p.voted ? 1 : 0}"`;
  const sessHtml = s => {
    const places = s.places.slice(0, 7);
    const dur = Math.round((s.to - s.from) / 60000);
    return `<div class="tm-s tm-rise" style="--i:${Math.min(12, sess.indexOf(s) + 4)}">${av(s.who, "sm")}<div class="tm-s-body">
      <div class="tm-s-h"><button type="button" class="tm-link" data-p="${esc(s.who)}">${esc(s.who)}</button><small>${esc(ago(s.at))}${dur >= 2 ? ` · ${dur} мин` : ""} · ${s.n} ${words(s.n, "действие", "действия", "действий")}</small></div>
      ${places.length ? `<div class="tm-path">${places.map(x => `<span>${esc(x)}</span>`).join('<i aria-hidden="true">→</i>')}${s.places.length > places.length ? `<em>+${s.places.length - places.length}</em>` : ""}</div>` : ""}
      ${s.other.slice(0, 3).map(t => `<div class="tm-s-x">${esc(t)}</div>`).join("")}
    </div></div>`;
  };
  const voteHtml = () => {
    if (!votes) return `<p class="tm-muted">Сезона для голосования пока нет.</p>`;
    return votes.titles.map((t, i) => {
      const total = t.likes.length + t.dislikes.length, pct = total ? Math.round(t.likes.length / total * 100) : 0;
      return `<div class="tm-vote tm-rise" style="--i:${Math.min(12, i + 3)}"><span class="tm-rank">${i + 1}</span><div class="tm-vote-b">
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
      <div><h1>Команда</h1><p>${onMap ? "Кто в сети, чем занят, куда ходит и как голосует." : "Серий в работе сейчас нет — здесь видно, кто чем занят."}</p></div>
      ${onMap ? `<button type="button" class="calm tm-tomap" data-tomap>← Карта студии</button>` : ""}
    </header>
    <div class="tm-bento">
      ${hasDays ? `<div class="tm-b tm-act tm-rise" style="--i:0">
        <div class="tm-b-h"><span>Активность команды</span><small>14 дней</small></div>
        <div class="tm-big"><b data-count="${thisWeek}" data-def="${thisWeek}">${thisWeek}</b>${delta != null ? `<em class="tm-delta ${delta >= 0 ? "up" : "dn"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}%</em>` : ""}</div>
        <small class="tm-big-sub" data-def="действий за 7 дней${delta != null ? " · к прошлой неделе" : ""}">действий за 7 дней${delta != null ? " · к прошлой неделе" : ""}</small>
        ${barsHtml(teamDays)}
      </div>` : `<div class="tm-b tm-rise" style="--i:0"><div class="tm-b-h"><span>Активны за неделю</span></div><div class="tm-big"><b data-count="${week}">${week}</b><small>из ${people.length}</small></div><small class="tm-big-sub">подробная активность видна владельцу</small></div>`}
      <div class="tm-b tm-live tm-rise" style="--i:1">
        <div class="tm-b-h"><span>Сейчас в сети</span>${onlinePeople.length ? `<i class="tm-pulse"></i>` : ""}</div>
        <div class="tm-big"><b data-count="${online}">${online}</b><small>из ${people.length}</small></div>
        <div class="tm-live-av">${onlinePeople.length ? onlinePeople.map(p => `<button type="button" class="tm-live-p" data-p="${esc(p.name)}">${av(p.name, "sm", "is-on")}<span>${esc(p.name)}</span></button>`).join("") : `<small class="tm-big-sub">${seen[0] ? `последним был ${esc(seen[0].name)} · ${esc(ago(seen[0].last_at))}` : "никого"}</small>`}</div>
      </div>
      ${votes ? `<div class="tm-b tm-vring tm-rise" style="--i:2">
        <div class="tm-b-h"><span>Голосование</span><small>${esc(votes.season || "")}</small></div>
        <div class="tm-vring-in">${ringSvg(votedN, people.length)}<div><b><span data-count="${votedN}">${votedN}</span><small>/${people.length}</small></b><span>проголосовали</span>
          ${votes.not_voted.length ? `<button type="button" class="tm-mini" data-filter-go="nv">${votes.not_voted.length} ещё нет →</button>` : ""}</div></div>
      </div>` : ""}
      ${teamAxes.length >= 3 ? `<div class="tm-b tm-rad tm-rise" style="--i:3">
        <div class="tm-b-h"><span>Куда ходит команда</span><small class="tm-rad-v" data-def="за 30 дней">за 30 дней</small></div>
        ${radarSvg(teamAxes)}
      </div>` : ""}
    </div>
    <div class="tm-main">
      <div class="tm-left">
        <section><div class="tm-sec-h"><h2>Люди <span>${people.length}</span></h2>
          <div class="tm-seg" role="tablist" aria-label="Кого показать"><i class="tm-seg-ind"></i>
            ${[["all", "Все", people.length], ["on", "В сети", online], ["act", "Активные", week], ...(votes ? [["nv", "Не голосовали", votes.not_voted.length]] : [])]
              .map(([k, l, n], i) => `<button type="button" role="tab" data-filter="${k}" aria-selected="${i === 0}">${l}<em>${n}</em></button>`).join("")}
          </div></div>
          <div class="tm-tiles">${seen.map(tile).join("") || `<p class="tm-muted">Пока никто не заходил.</p>`}</div>
          ${never.length ? `<div class="tm-never"><span>Ещё ни разу не заходили</span><div>${never.map(p => `<button type="button" class="tm-chip" data-p="${esc(p.name)}" ${filterAttrs(p)}>${av(p.name, "xs")}${esc(p.name)}</button>`).join("")}</div></div>` : ""}
          <p class="tm-muted tm-none" hidden>Никого под этот фильтр.</p>
        </section>
        <section><h2>Кто что делал <span>${sess.length}</span></h2>
          ${sess.length ? `<div class="tm-feed">${sess.map(sessHtml).join("")}</div>` : `<p class="tm-muted">${owner ? "Пока ничего не замечено." : "Ленту действий видит только владелец."}</p>`}
        </section>
      </div>
      <aside class="tm-right"><section><h2>Голосование ${votes && votes.season ? `<span>${esc(votes.season)}</span>` : ""}</h2>
        <div class="tm-votes">${voteHtml()}</div></section></aside>
    </div>
    <div class="tm-scrim" hidden></div><aside class="tm-drawer" hidden aria-label="Сведения о человеке"></aside>
  </div>`;

  countUp(wrap);
  wrap.querySelector("[data-tomap]")?.addEventListener("click", onMap);
  // Наведение на столбик — в заголовке плитки число и дата этого дня; ушёл — снова «за 7 дней».
  const act = wrap.querySelector(".tm-act");
  if (act) {
    const num = act.querySelector(".tm-big b"), sub = act.querySelector(".tm-big-sub");
    act.querySelectorAll(".tm-bars i").forEach(b => b.addEventListener("mouseenter", () => {
      const i = Number(b.dataset.i);
      num.textContent = teamDays[i].toLocaleString("ru-RU");
      sub.textContent = `${words(teamDays[i], "действие", "действия", "действий")} · ${i === 13 ? "сегодня" : fmtDay(dayAt(i))}`;
    }));
    act.querySelector(".tm-bars").addEventListener("mouseleave", () => { num.textContent = Number(num.dataset.def).toLocaleString("ru-RU"); sub.textContent = sub.dataset.def; });
  }
  const bindRadar = (root, axes, out) => {
    if (!root || !out) return;
    const svg = root.querySelector(".tm-radar"); if (!svg) return;
    svg.querySelectorAll("[data-ax]").forEach(el => el.addEventListener("mouseenter", () => {
      const a = axes[Number(el.dataset.ax)];
      svg.querySelectorAll("text").forEach(t => t.classList.toggle("on", t.dataset.ax === el.dataset.ax));
      out.textContent = `${a.label} · ${a.value} ${words(a.value, "раз", "раза", "раз")}`;
    }));
    svg.addEventListener("mouseleave", () => { svg.querySelectorAll("text").forEach(t => t.classList.remove("on")); out.textContent = out.dataset.def; });
  };
  bindRadar(wrap.querySelector(".tm-rad"), teamAxes, wrap.querySelector(".tm-rad-v"));

  // Переключатель «Все / В сети / Активные / Не голосовали»: подложка переезжает под выбранную кнопку.
  const seg = wrap.querySelector(".tm-seg"), ind = seg && seg.querySelector(".tm-seg-ind");
  const moveInd = btn => { if (ind && btn) { ind.style.width = `${btn.offsetWidth}px`; ind.style.transform = `translateX(${btn.offsetLeft - 4}px)`; } };
  const setFilter = key => {
    if (!seg) return;
    const btn = seg.querySelector(`[data-filter="${key}"]`);
    seg.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-selected", String(b === btn)));
    moveInd(btn);
    let shown = 0;
    wrap.querySelectorAll(".tm-tile, .tm-chip").forEach(el => {
      const ok = key === "all" || el.dataset[key === "on" ? "on" : key === "act" ? "act" : "nv"] === "1";
      el.hidden = !ok; if (ok) shown++;
    });
    const nev = wrap.querySelector(".tm-never");
    if (nev) nev.hidden = ![...nev.querySelectorAll(".tm-chip")].some(c => !c.hidden);
    wrap.querySelector(".tm-none").hidden = shown > 0;
  };
  if (seg) {
    requestAnimationFrame(() => moveInd(seg.querySelector('[aria-selected="true"]')));
    seg.addEventListener("click", e => { const b = e.target.closest("[data-filter]"); if (b) setFilter(b.dataset.filter); });
  }
  wrap.querySelectorAll("[data-filter-go]").forEach(b => b.addEventListener("click", () => {
    setFilter(b.dataset.filterGo);
    wrap.querySelector(".tm-seg").scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  const drawer = wrap.querySelector(".tm-drawer"), scrim = wrap.querySelector(".tm-scrim");
  const close = () => { drawer.classList.remove("on"); scrim.classList.remove("on"); setTimeout(() => { if (!drawer.classList.contains("on")) { drawer.hidden = true; scrim.hidden = true; } }, 220); };
  const open = name => {
    const p = byName[name]; if (!p) return;
    const pi = persons[name] || null, net = pi && pi.net;
    const mine = sessions(feed.filter(r => r.who === name)).slice(0, 8);
    const axes = topTools((pi && pi.tools) || []);
    const sec = (title, body) => body ? `<h4>${title}</h4>${body}` : "";
    const rows = list => list.map(([a, b, cls = ""]) => `<div class="pd-tool"><span>${esc(a)}</span><i class="${cls}">${esc(b)}</i></div>`).join("");
    drawer.innerHTML = `<div class="tm-d-h">${av(name, "lg", p.online ? "is-on" : "")}<div><h3>${esc(name)}</h3><small>${esc(p.roles.join(" · ") || "без роли")}</small></div>
        <button type="button" class="pd-x" aria-label="Закрыть">×</button></div>
      <div class="tm-d-k"><div><b>${p.online ? "в сети" : esc(ago(p.last_at) || "—")}</b><span>последняя активность</span></div><div><b>${p.week}</b><span>действий за 7 дн</span></div><div><b>${votes ? (p.voted ? "да" : "нет") : "—"}</b><span>голосовал</span></div></div>
      <div class="pd-body">
        ${pi && pi.days14 && pi.days14.some(Boolean) ? `<h4>Активность · 14 дней</h4><div class="tm-d-spark">${spark(pi.days14)}</div>` : ""}
        ${axes.length >= 3 ? `<h4>Куда ходит <span class="tm-rad-v" data-def="">&nbsp;</span></h4><div class="tm-d-rad">${radarSvg(axes, 260)}</div>` : ""}
        ${sec("Что открывал", pi && pi.tools && pi.tools.length ? rows(pi.tools.map(t => [t.label, `${t.count} раз${t.seconds ? ` · ${fmtDur(t.seconds)}` : ""}`])) : "")}
        ${sec("Что смотрел", pi && pi.watch && pi.watch.length ? rows(pi.watch.map(w => [w.title, fmtDur(w.seconds)])) : "")}
        ${sec("Связь", net ? rows([["Откуда", `${net.ip || "—"}${net.country ? ` · ${net.country}` : ""}`], ["Сервер", net.server_ok ? `доступен${net.server_ms ? ` · ${net.server_ms} мс` : ""}` : "нет связи", net.server_ok ? "ok" : "bad"], ["DNS", `${net.dns_ok === false ? "не отвечает" : "работает"}${net.dns_provider ? ` · ${net.dns_provider}` : ""}`, net.dns_ok === false ? "bad" : "ok"]]) : "")}
        ${sec("Последние сессии", mine.length ? `<div class="tm-feed compact">${mine.map(s => sessHtml(s)).join("")}</div>` : "")}
        ${!pi && !mine.length ? `<p class="tm-muted">${owner ? (p.last_at ? "Учёт использования приложения у человека выключен." : "Человек ещё ни разу не заходил в приложение.") : "Подробности об использовании видит только владелец."}</p>` : ""}
      </div>`;
    drawer.querySelector(".pd-x").addEventListener("click", close);
    bindRadar(drawer.querySelector(".tm-d-rad"), axes, drawer.querySelector(".tm-rad-v"));
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
