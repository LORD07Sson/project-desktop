// «Пульс студии»: живая карта студии — тайтлы, серии, исполнители, сроки и события. Рисуется на canvas внутри отдельной
// страницы (pulse.html, её открывает вкладка «Пульс» в iframe): так тяжёлая анимация не делит CSS и скрипты с остальным
// приложением. Данные приходят от приложения (postMessage, /api/pulse); нажатие «Открыть серию» уходит обратно туда же.
// Исходный дизайн и анимации — из макета «Пульс студии»; данные в нём заменены настоящими.

export function startPulse(DATA) {
  const W = 1280, H = 760, CX = 640, CY = 330;
  const $ = s => document.querySelector(s);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const c01 = v => clamp(v, 0, 1);
  const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeBack = t => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const hash = (s, i = 0) => { let h = 2166136261 ^ i; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
  const R = Math.random;
  const sleep = ms => new Promise(r => setTimeout(r, reduce ? Math.min(ms, 20) : ms));
  const now = () => performance.now();

  // ---------- данные (приходят из приложения: /api/pulse) ----------
  const PEOPLE = DATA.people.map(n => ({ n }));
  const byName = n => PEOPLE.find(p => p.n === n);
  const STAGES = DATA.stages;
  // окно шкалы: от первой серии (минус две недели) до сегодня, не короче 60 дней — иначе при малом числе серий всё сжато у края
  const minDay = Math.min(DATA.days - 1, ...DATA.titles.flatMap(t => t.eps.map(e => e.day)));
  const SHIFT = Math.max(0, Math.min(minDay - 14, DATA.days - 60));
  const TITLES = DATA.titles.map(t => ({ id: t.id, name: t.name, roles: t.roles || [], air: t.air, nextEp: t.nextEp,
    eps: t.eps.map(e => ({ ...e, day: e.day - SHIFT, who: e.who.map(byName).filter(Boolean) })) }));
  const START = new Date(new Date(`${DATA.start}T00:00:00`).getTime() + SHIFT * 86400000);
  const MONTHS_RU = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
  const MONTHS_GEN = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const AN = DATA.analytics || null;      // метрики и графики «Аналитики»: завершено, сроки, нагрузка, исполнители, динамика по дням
  const WM = DATA.workmap || null;        // таблицы алгоритма (только владелец): связь, события, сроки
  const ALGO = DATA.algo || null;   // выводы алгоритма «Карты работы» (только для владельца)
  const fmtH = h => (h == null ? "—" : h < 1 ? `${Math.max(1, Math.round(h * 60))} мин` : h < 48 ? `${Math.round(h)} ч` : `${(h / 24).toFixed(1).replace(".", ",")} дн.`);
  const fmtDur = s => (s >= 3600 ? `${(s / 3600).toFixed(1).replace(".", ",")} ч` : s >= 60 ? `${Math.round(s / 60)} мин` : `${s} с`);
  const fmtWhen = ts => new Date(ts * 1000).toLocaleString("ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const personInfo = name => (ALGO && ALGO.persons && ALGO.persons[name]) || null;
  const send = msg => { try { parent.postMessage({ source: "pulse", ...msg }, window.location.origin); } catch (_) { /* вне приложения */ } };

  // ---------- спрайты света ----------
  function sprite(size, draw) { const c = document.createElement("canvas"); c.width = c.height = size; draw(c.getContext("2d"), size); return c; }
  const glow = col => sprite(256, (g, s) => { const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); r.addColorStop(0, col); r.addColorStop(.25, col.replace(/[\d.]+\)$/, ".35)")); r.addColorStop(1, col.replace(/[\d.]+\)$/, "0)")); g.fillStyle = r; g.fillRect(0, 0, s, s); });
  const sphere = (stops, ring) => sprite(320, (g, s) => {
    const c = s / 2, r = s * .34;
    if (ring) { g.strokeStyle = "rgba(255,255,255,.22)"; g.lineWidth = s * .018; g.beginPath(); g.arc(c, c, r * 1.32, 0, 7); g.stroke(); const hr = g.createRadialGradient(c, c, r, c, c, r * 1.32); hr.addColorStop(0, "rgba(255,255,255,.10)"); hr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = hr; g.beginPath(); g.arc(c, c, r * 1.32, 0, 7); g.fill(); }
    const gr = g.createRadialGradient(c - r * .35, c - r * .4, r * .05, c, c, r);
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, r, 0, 7); g.fill();
    g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = s * .008; g.beginPath(); g.arc(c, c, r, 0, 7); g.stroke();
    const hl = g.createRadialGradient(c - r * .38, c - r * .45, 0, c - r * .38, c - r * .45, r * .45); hl.addColorStop(0, "rgba(255,255,255,.85)"); hl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = hl; g.beginPath(); g.arc(c, c, r, 0, 7); g.fill();
  });
  const SP = {
    gold: sphere([[0, "#fff4d8"], [.3, "#f3c37a"], [.7, "#b8783a"], [1, "#4a2a10"]], false),
    rose: sphere([[0, "#ffe6ee"], [.3, "#ff9ab3"], [.75, "#b83a62"], [1, "#420f22"]], true),
    violet: sphere([[0, "#f3ecff"], [.3, "#bfa6ff"], [.75, "#6a4bd0"], [1, "#1f1350"]], true),
    mint: sphere([[0, "#eafff6"], [.35, "#79f2c6"], [1, "#0e5a40"]], false),
    amber: sphere([[0, "#fff1d2"], [.4, "#ffb44e"], [1, "#6a3304"]], false),
  };
  const GL = { gold: glow("rgba(255,190,90,1)"), fire: glow("rgba(255,110,40,1)"), rose: glow("rgba(255,120,160,1)"), violet: glow("rgba(170,140,255,1)"), mint: glow("rgba(100,240,190,1)"), cyan: glow("rgba(110,220,255,1)"), white: glow("rgba(255,245,225,1)") };
  const STAR = sprite(192, (g, s) => {
    const c = s / 2;
    g.globalCompositeOperation = "lighter";
    for (const [w, a] of [[s * .5, 1], [s * .2, .6]]) {
      let gr = g.createLinearGradient(c - w, c, c + w, c); gr.addColorStop(0, "rgba(255,230,180,0)"); gr.addColorStop(.5, `rgba(255,248,230,${a})`); gr.addColorStop(1, "rgba(255,230,180,0)");
      g.fillStyle = gr; g.fillRect(c - w, c - s / 96, w * 2, s / 48);
      gr = g.createLinearGradient(c, c - w, c, c + w); gr.addColorStop(0, "rgba(255,230,180,0)"); gr.addColorStop(.5, `rgba(255,248,230,${a})`); gr.addColorStop(1, "rgba(255,230,180,0)");
      g.fillStyle = gr; g.fillRect(c - s / 96, c - w, s / 48, w * 2);
    }
    const r = g.createRadialGradient(c, c, 0, c, c, s * .18); r.addColorStop(0, "rgba(255,250,235,1)"); r.addColorStop(1, "rgba(255,200,120,0)"); g.fillStyle = r; g.fillRect(0, 0, s, s);
  });

  // ---------- холсты ----------
  const stage = $("#stage"), wrapEl = $("#wrap");
  const cNet = $("#cNet"), cFx = $("#cFx"), gN = cNet.getContext("2d"), gF = cFx.getContext("2d");
  let LLIM = 0, RLIM = 1280, RES = 1, QUAL = 1, SS = Number(new URLSearchParams(location.search).get("ss")) || 1.6, VISIBLE = true;   // QUAL: адаптивное качество (падает, если кадры тяжёлые); VISIBLE: сцена видна на экране
  // сцена 1280×760 вписывается в доступное окно целиком (по ширине и по высоте) и стоит по центру — без внутренней прокрутки
  // Интерфейс (панели, шкала, KPI) растягивается на всё окно; сама сцена 1280×760 стоит по центру и масштабируется по меньшей стороне.
  const scene = $("#scene");
  const stageScale = () => Math.min(wrapEl.clientWidth / W, wrapEl.clientHeight / H) || 1;
  function resize() {
    const cw = wrapEl.clientWidth, ch = wrapEl.clientHeight, sc = stageScale();
    stage.style.width = `${cw / sc}px`; stage.style.height = `${ch / sc}px`; stage.style.transform = `scale(${sc})`;
    // сцена живёт между шкалой слева и колонкой справа, а не под ними
    const L = cw > 1100 ? 170 : 0, R = cw > 1100 ? 400 : 0, aw = cw - L - R;
    // сцена крупная: заполняет окно по высоте (чуть обрезаясь сверху и снизу), по центру свободной области; справа может уходить под колонку
    const s2 = Math.max(.35, Math.min(cw / W, Math.max(aw / W, ch / H) * 1.04));
    scene.style.transformOrigin = "0 0";
    scene.style.transform = `scale(${s2 / sc})`;
    LLIM = (L - (L + (aw - W * s2) / 2)) / s2;
    RLIM = (cw - R - (L + (aw - W * s2) / 2)) / s2;     // правый край свободной области в координатах сцены (дальше — колонка справа)
    scene.style.left = `${(L + (aw - W * s2) / 2) / sc}px`; scene.style.top = `${(ch - H * s2) / 2 / sc}px`;
    RES = clamp((devicePixelRatio || 1) * s2 * QUAL * SS, 1, 2.8);   // SS: запас по разрешению — браузер уменьшает его при показе, края и текст получаются чёткими
    for (const c of [cNet, cFx]) { c.width = VISIBLE ? Math.round(W * RES) : 1; c.height = VISIBLE ? Math.round(H * RES) : 1; }
  }
  new ResizeObserver(resize).observe(wrapEl); resize();

  // ---------- сеть: карусель в объёме ----------
  // Тайтлы стоят на невидимом цилиндре вокруг студии и медленно вращаются:
  // ближние крупнее и ярче, дальние меньше и тусклее. Серии и дорожки — на
  // чуть большем радиусе рядом со своим тайтлом, люди — на внутреннем круге.
  const RX = 375, TILT = 26, DAYS = DATA.days - SHIFT;
  // начала месяцев внутри окна (в днях от его начала); подписи — настоящие названия месяцев
  const MONTH_START = [0], MONTH_IDX = [START.getMonth()];
  for (let d = 1; d < DAYS; d++) { const m = new Date(START.getTime() + d * 86400000); if (m.getDate() === 1) { MONTH_START.push(d); MONTH_IDX.push(m.getMonth()); } }
  const MONTHS = MONTH_IDX.map(i => MONTHS_RU[i]);
  const MON_GEN = MONTH_IDX.map(i => MONTHS_GEN[i]);
  let titleNodes = [], epNodes = [], trNodes = [], pplNodes = [], lines = [], allNodes = [], links = [], spokes = [];
  let phi = -0.35, rotSpeed = 1, rotTarget = 1;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const HUB = { px: CX, py: CY, pz: 0, pd: 1, alpha: 1 };
  function build() {
    const rnd = mulberry(11);
    titleNodes = []; epNodes = []; trNodes = []; pplNodes = []; lines = []; allNodes = []; links = [];
    const n = Math.max(1, TITLES.length);
    TITLES.forEach((t, i) => {
      const eps = t.eps;
      const tn = { kind: "title", t, i, th: i / n * Math.PI * 2, yh: (((i * .618034) % 1) - .5) * 290, eps, pct: Math.round(eps.reduce((s, e) => s + e.pct, 0) / Math.max(1, eps.length)),
        act: .25 + .75 * Math.min(1, t.eps.filter(e => e.stage < 4).length / 3), boost: 0, born: 0, alpha: 1 };
      // выход следующей серии в эфир — главный дедлайн дубляжа (если расписание известно)
      tn.air = t.air;
      tn.nextEp = t.nextEp;
      titleNodes.push(tn); allNodes.push(tn);
      tn.beam = { kind: "beam", a: HUB, b: tn, born: 0, dur: 0 };
      eps.forEach((e, k) => {
        const en = { kind: "ep", tn, e, da: (k - (eps.length - 1) / 2) * .085 + (rnd() - .5) * .03, or: 50 + rnd() * 46, oy: (rnd() - .5) * 118,
          day: clamp(e.day, 0, DAYS - 1), born: 0, alpha: 1 };
        epNodes.push(en); allNodes.push(en);
        lines.push({ kind: "teal", a: tn, b: en, born: 0, dur: 0 });
        const tc = 1 + Math.floor(rnd() * 2.2);
        for (let j = 0; j < tc; j++) {
          const tr = { kind: "track", en, da: en.da + (rnd() - .5) * .09, or: en.or + 20 + rnd() * 16, oy: en.oy + (rnd() - .5) * 44, n: 1 + Math.floor(rnd() * 30), born: 0, alpha: 1 };
          trNodes.push(tr); allNodes.push(tr);
          lines.push({ kind: "track", a: en, b: tr, born: 0, dur: 0 });
        }
      });
    });
    PEOPLE.forEach((p, i) => {
      const pn = { kind: "person", p, th: (i + .5) / PEOPLE.length * Math.PI * 2 + .25, r: 165 + rnd() * 70, yp: (rnd() - .5) * 230, born: 0, alpha: 1 };
      pplNodes.push(pn); allNodes.push(pn);
      epNodes.filter(en => en.e.who.includes(p)).slice(0, 6).forEach(en => { const l = { kind: "dash", a: pn, b: en, born: 0, dur: 0 }; lines.push(l); links.push(l); });
      lines.push({ kind: "teal", a: pn, b: titleNodes[(i * 3 + 4) % n], born: 0, dur: 0 });
    });
    spokes = Array.from({ length: 30 }, (_, i) => ({ a: i / 30 * Math.PI * 2 + rnd() * .1, l: 48 + rnd() * 60 }));
  }
  function project() {
    mouse.x = lerp(mouse.x, mouse.tx, .05); mouse.y = lerp(mouse.y, mouse.ty, .05);
    const ph = phi + mouse.x * .1;
    const P = (n, a, r, y0) => { const z = Math.cos(a); n.pz = z; n.pd = .62 + .4 * (z + 1) / 2; n.px = CX + Math.sin(a) * r + mouse.x * z * 12; n.py = y0 + z * TILT + mouse.y * z * 14; };
    for (const n of titleNodes) P(n, n.th + ph, RX, CY + n.yh);
    for (const n of epNodes) P(n, n.tn.th + n.da + ph, RX + n.or, CY + n.tn.yh + n.oy);
    for (const n of trNodes) P(n, n.en.tn.th + n.da + ph, RX + n.or, CY + n.en.tn.yh + n.oy);
    for (const n of pplNodes) P(n, n.th + ph, n.r, CY + n.yp);
  }
  const depthA = n => .3 + .7 * ((n.pz ?? 0) + 1) / 2;
  let day = DAYS - 1;
  const vis = n => n.kind === "ep" ? n.day <= day : n.kind === "track" ? n.en.day <= day : true;
  const monthOf = d => { let m = 0; for (let i = 0; i < MONTH_START.length; i++) if (d >= MONTH_START[i]) m = i; return m; };
  const late = en => !!en && en.kind === "ep" && en.e.days < 0 && vis(en);

  // режиссура вступления: у каждого элемента время рождения
  let T0 = 0;
  function scheduleIntro(t0) {
    T0 = t0;
    titleNodes.forEach((tn, i) => { tn.beam.born = 420 + i * 70; tn.beam.dur = 480; tn.born = tn.beam.born + tn.beam.dur; });
    lines.forEach(l => { if (l.kind === "teal" && l.a.kind === "title") { l.born = l.a.born + 60 + epNodes.indexOf(l.b) % 5 * 70; l.dur = 380; l.b.born = l.born + l.dur; } });
    lines.forEach(l => { if (l.kind === "track") { l.born = l.a.born + 60; l.dur = 260; l.b.born = l.born + l.dur; } });
    pplNodes.forEach((pn, i) => { pn.born = 1300 + i * 90; });
    lines.forEach(l => { if (l.kind === "dash") { l.born = Math.max(l.a.born, l.b.born) + 80; l.dur = 450; } if (l.kind === "teal" && l.a.kind === "person") { l.born = 1900; l.dur = 600; } });
    rays = Array.from({ length: 22 }, (_, i) => ({ a: i / 22 * Math.PI * 2 + R() * .2, born: 180 + R() * 520, v: .9 + R() * .9, max: 380 + R() * 420, col: R() > .45 ? "cyan" : "rose" }));
    dust = Array.from({ length: reduce ? 0 : 520 }, () => { const a = R() * 7, r = 8 + R() * 60, v = .01 + R() * .09; return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r, vx: Math.cos(a) * v + Math.sin(a) * .03, vy: Math.sin(a) * v - Math.cos(a) * .03, born: 60 + R() * 300, life: 1200 + R() * 1400, s: .5 + R() * 1.4 }; });
  }
  let rays = [], dust = [];
  function finishIntro() { T0 = now() - 60000; }

  // туманность и пыль за сетью — два слоя с разным параллаксом
  const NEB = sprite(1, () => {});
  (function paintNebula() {
    NEB.width = 1340; NEB.height = 810;
    const g = NEB.getContext("2d");
    for (const [x, y, r, c] of [[330, 260, 560, "255,106,43,.13"], [980, 520, 480, "200,40,70,.10"], [690, 380, 320, "255,180,90,.07"], [1120, 140, 380, "70,170,160,.06"], [160, 650, 360, "150,60,200,.06"]]) {
      const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(${c})`); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(0, 0, 1340, 810);
    }
    const rr = mulberry(5);
    for (let i = 0; i < 420; i++) { g.fillStyle = `rgba(255,${200 + Math.floor(rr() * 55)},${170 + Math.floor(rr() * 80)},${(.08 + rr() * .4).toFixed(2)})`; const s = .5 + rr() * 1.1; g.fillRect(rr() * 1340, rr() * 810, s, s); }
  })();
  const DUST2 = Array.from({ length: 90 }, () => ({ x: R() * W, y: R() * H, z: .3 + R() * .7, vx: (R() - .5) * .006, vy: -.004 - R() * .01, s: .6 + R() * 1.6 }));

  // ---------- камера ----------
  const cam = { x: CX, y: CY, s: 1 };
  // камера по умолчанию смотрит чуть правее студии — справа стоит блок «Внимание»
  const HOMEX = CX + 60;
  let HOMES = 1;    // домашний масштаб камеры: при малом числе тайтлов сцена крупнее, чтобы не тонуть в пустоте
  let camTok = 0;
  function tweenCam(to, dur, ease = easeIO) {
    const tok = ++camTok, from = { ...cam }, t0 = now();
    if (reduce || !dur) { Object.assign(cam, to); return Promise.resolve(); }
    return new Promise(res => {
      const step = () => { if (tok !== camTok) return res(); const k = c01((now() - t0) / dur), e = ease(k); for (const key in to) cam[key] = lerp(from[key], to[key], e); k < 1 ? requestAnimationFrame(step) : res(); };
      requestAnimationFrame(step);
    });
  }
  const toScreen = (x, y) => ({ x: W / 2 + (x - cam.x) * cam.s, y: H / 2 - 10 + (y - cam.y) * cam.s });
  const toWorld = (sx, sy) => ({ x: (sx - W / 2) / cam.s + cam.x, y: (sy - H / 2 + 10) / cam.s + cam.y });

  // ---------- спокойный режим и фильтры ----------
  // По умолчанию сцена спокойная: без вращения, искр, дорожек и номеров —
  // остаются лучи, кольца готовности, красная просрочка и редкие события.
  // «Ярко» включает всё обратно.
  let CALM = true;
  try { CALM = localStorage.getItem("pulse-bright") !== "1"; } catch (_) { /* без памяти */ }
  const ME = DATA.me;
  const FILTER = { who: "all", stage: -1 };
  const airText = d => d <= 0 ? "сегодня" : d === 1 ? "завтра" : `через ${d} дн`;
  const hasAir = tn => tn.air != null && tn.nextEp != null;
  const dueText = d => d >= 99 ? "без срока" : d < 0 ? `просрочен на ${-d} дн` : d === 0 ? "сегодня" : `через ${d} дн`;
  const epHot = en => late(en) || !!en.e.stuck || (hasAir(en.tn) && en.tn.air <= 1 && en === epNodes.filter(x => x.tn === en.tn).slice(-1)[0]);
  const epPass = en => (FILTER.who === "mine" ? en.e.who.some(p => p.n === ME) : FILTER.who === "hot" ? epHot(en) : true) && (FILTER.stage < 0 || en.e.stage === FILTER.stage);
  const filtering = () => FILTER.who !== "all" || FILTER.stage >= 0;
  function pass(n) {
    if (!filtering()) return true;
    if (n.kind === "ep") return epPass(n);
    if (n.kind === "track") return epPass(n.en);
    if (n.kind === "title") return epNodes.some(en => en.tn === n && vis(en) && epPass(en));
    if (n.kind === "person") return FILTER.who === "mine" ? n.p.n === ME : links.some(l => l.a === n && vis(l.b) && epPass(l.b));
    return true;
  }
  const personLoad = pn => { const eps = links.filter(l => l.a === pn && vis(l.b) && l.b.e.stage < 4).map(l => l.b); return { n: eps.length, late: eps.filter(late).length, titles: [...new Set(eps.map(e => e.tn.t.name))] }; };

  // ---------- окружение и живые события ----------
  let twinkles = [], pulses = [], inflow = [], waves = [], comets = [], toasts = [];
  let lastTw = 0, lastPulse = 0, nextEvent = 0, playing = false, playSpeed = 1;
  const EV_COL = { up: "255,205,120", qc: "255,95,110", done: "90,235,150" };
  // Только настоящие события из истории отчётов: по кругу, самые свежие первыми.
  let REAL_EVENTS = [];
  const prepareEvents = () => {
    REAL_EVENTS = (DATA.events || []).map(ev => {
      const tn = titleNodes.find(x => x.t.id === ev.tid);
      const en = tn && epNodes.find(x => x.tn === tn && x.e.ep === ev.ep);
      const low = String(ev.text).toLowerCase();
      return en ? { en, who: ev.who, at: ev.at, text: `${ev.who} · ${ev.text}`, kind: /завершен|готов|сдан/.test(low) ? "done" : /замечан|ошиб|удал/.test(low) ? "qc" : "up" } : null;
    }).filter(Boolean);
  };
  let evCursor = 0;
  function fireEvent(kind, target, quiet) {
    let en, text, who, at, k = kind;
    if (target) {
      en = target; who = (en.e.who[0] || PEOPLE[0] || { n: "" }).n;
      text = `${who} · серия ${en.e.ep}`.trim(); k = k || "up";
    } else {
      const pool = REAL_EVENTS.filter(x => vis(x.en));
      if (!pool.length) return;
      const ev = pool[evCursor++ % pool.length];
      en = ev.en; who = ev.who; text = ev.text; k = k || ev.kind; at = ev.at;
    }
    const l = links.find(x => x.b === en && x.a.p.n === who) || links.find(x => x.b === en);
    comets.push({ from: k === "done" || !l ? HUB : l.a, to: en, born: now(), dur: k === "done" ? 1100 : 850, col: EV_COL[k], kind: k, text, at, quiet, hit: false });
  }
  function arrive(c) {
    const en = c.to, tn = en.tn, t = now();
    pulses.push({ n: en, born: t, col: c.col });
    waves.push({ n: en, born: t, col: c.col, max: c.kind === "done" ? 110 : 46 });
    if (c.kind === "done") waves.push({ n: HUB, born: t + 120, col: "255,190,90", max: 220 });
    tn.boost = 1;
    if (!c.quiet && CALM) feedAdd(c);
    else if (!c.quiet) {
      // подписей над узлами не больше трёх, и не друг на друге
      const crowded = toasts.length >= 3 || toasts.some(o => Math.hypot(o.n.px - en.px, o.n.py - en.py) < 40);
      if (!crowded) toasts.push({ n: en, text: c.at && evAge(c.at) !== "сейчас" ? `${c.text} · ${evAge(c.at)}` : c.text, col: c.col, born: t });
      feedAdd(c);
    }
  }
  // Подпись времени — настоящая: события из истории не выдаём за происходящие прямо сейчас.
  const evAge = at => { const d = new Date(String(at).replace(" ", "T") + "Z"), m = Math.round((Date.now() - d.getTime()) / 60000); return Number.isNaN(m) ? "" : m < 2 ? "сейчас" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : m < 10080 ? `${Math.round(m / 1440)} дн назад` : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }); };
  function feedAdd(c) {
    const f = $("#feed"); if (!f) return;
    const el = document.createElement("div");
    el.className = "fd";
    el.innerHTML = `<i style="background:rgb(${c.col});box-shadow:0 0 8px rgb(${c.col})"></i><span>${esc(c.text)}</span><em>${esc(c.at ? evAge(c.at) : "перемотка")}</em>`;
    f.prepend(el);
    while (f.children.length > 3) f.lastChild.remove();
    [...f.children].forEach((x, i) => { x.style.opacity = (1 - i * .24).toFixed(2); });
  }
  function ambient(t, dt) {
    rotSpeed = lerp(rotSpeed, rotTarget, .03);
    if (!CALM) phi += dt * .000052 * rotSpeed * (playing ? 2.2 : 1);
    for (const tn of titleNodes) tn.boost = Math.max(0, tn.boost - dt / 2600);
    // перемотка сезона: день бежит, серии рождаются по своим датам
    if (playing) {
      const prev = day;
      day = Math.min(DAYS - 1, day + dt * DAYS / 9000 * playSpeed);
      const born = epNodes.filter(en => en.day > prev && en.day <= day);
      born.forEach((en, i) => fireEvent("up", en, i % 3 !== 0));
      if (Math.floor(day / 5) !== Math.floor(prev / 5)) { drawTimeline(); updateKpis(350); }
      if (day >= DAYS - 1) { playing = false; drawTimeline(); updateKpis(500); renderAttn(); $("#tlPlay") && ($("#tlPlay").textContent = "▶ Перемотка сезона"); }
    }
    if (reduce) return;
    const introT = t - T0, focusing = stage.classList.contains("focusing");
    if (introT > 2800 && !focusing && !playing && !F && t > nextEvent) { nextEvent = t + (CALM ? 6000 + R() * 4000 : 2600 + R() * 2200); fireEvent(); }
    waves = waves.filter(w => t - w.born < 1400);
    pulses = pulses.filter(p => t - p.born < 1500);
    if (CALM) { twinkles = []; inflow = []; toasts = []; return; }
    if (introT > 1600 && t - lastTw > 110 && !focusing) {
      lastTw = t;
      const pool = allNodes.filter(n => vis(n) && n.kind !== "track" && n.pz > -.3);
      const n = pool[Math.floor(R() * pool.length)];
      if (R() > .35 && n) twinkles.push({ x: n.px + (R() - .5) * 10, y: n.py + (R() - .5) * 10, born: t, life: 700 + R() * 700, s: (16 + R() * 26) * n.pd, cyan: R() > .82 });
      else { const tn = titleNodes[Math.floor(R() * titleNodes.length)], k = R(); twinkles.push({ x: lerp(CX, tn.px, k), y: lerp(CY, tn.py, k), born: t, life: 600 + R() * 600, s: 12 + R() * 18 }); }
    }
    // (раньше здесь кольца вспыхивали на случайных узлах — со стороны это выглядело как настоящая активность; убрано)
    twinkles = twinkles.filter(w => t - w.born < w.life);
    toasts = toasts.filter(w => t - w.born < 2600);
    if (!inflow.length) inflow = Array.from({ length: 36 }, () => ({ a: R() * 7, r: 60 + R() * 110, v: .03 + R() * .05 }));
    for (const p of inflow) { p.r -= p.v * dt; if (p.r < 36) { p.r = 120 + R() * 60; p.a = R() * 7; } }
    for (const d of DUST2) { d.x += d.vx * dt; d.y += d.vy * dt; if (d.y < -10) { d.y = H + 10; d.x = R() * W; } }
  }

  // ---------- рисуем сеть ----------
  let hoverTitle = -1;
  let netFadeUntil = 0;
  const netFadeLeft = () => now() < netFadeUntil;
  function drawNet(t) {
    const g = gN, it = t - T0;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cNet.width, cNet.height);
    if (stage.classList.contains("focusing") && !netFadeLeft()) return;
    // фон: туманность и пыль, слои с параллаксом
    g.setTransform(RES, 0, 0, RES, 0, 0);
    g.globalAlpha = c01(it / 900);
    g.drawImage(NEB, -30 - mouse.x * 18, -25 - mouse.y * 12);
    g.globalCompositeOperation = "lighter";
    if (!CALM) for (const d of DUST2) { g.globalAlpha = .25 + d.z * .35; g.fillStyle = "#ffcf95"; g.fillRect(d.x - mouse.x * 40 * d.z, d.y - mouse.y * 26 * d.z, d.s, d.s); }
    g.globalCompositeOperation = "source-over";

    g.setTransform(RES * cam.s, 0, 0, RES * cam.s, RES * (W / 2 - cam.x * cam.s), RES * (H / 2 - 10 - cam.y * cam.s));
    const bornK = n => c01((it - n.born) / 420);
    for (const n of allNodes) {
      const v = vis(n);
      if (v && !n.wasVis && n.wasVis !== undefined) n.popAt = t;
      n.wasVis = v;
      n.alpha = lerp(n.alpha, v && pass(n) ? 1 : .07, .12);
    }
    const pop = n => { const b = bornK(n); const p = n.popAt ? c01((t - n.popAt) / 450) : 1; return Math.min(easeBack(b), easeBack(p)); };

    // пыль и лучи вступления
    g.globalCompositeOperation = "lighter";
    for (const d of dust) {
      const k = it - d.born; if (k < 0 || k > d.life) continue;
      g.globalAlpha = Math.sin(k / d.life * Math.PI) * .9; g.fillStyle = "#ffcf85"; g.fillRect(d.x + d.vx * k, d.y + d.vy * k, d.s, d.s);
    }
    for (const r of rays) {
      const k = it - r.born; if (k < 0) continue;
      const head = Math.min(r.max, k * r.v), tail = Math.max(0, head - 150), fade = c01(1 - (k * r.v - r.max) / 300);
      if (fade <= 0) continue;
      const dx = Math.cos(r.a), dy = Math.sin(r.a), hx = CX + dx * (40 + head), hy = CY + dy * (40 + head);
      const gr = g.createLinearGradient(CX + dx * (40 + tail), CY + dy * (40 + tail), hx, hy), col = r.col === "cyan" ? "120,225,255" : "255,150,190";
      gr.addColorStop(0, `rgba(${col},0)`); gr.addColorStop(1, `rgba(${col},${.9 * fade})`);
      g.globalAlpha = 1; g.strokeStyle = gr; g.lineWidth = 2.2; g.beginPath(); g.moveTo(CX + dx * (40 + tail), CY + dy * (40 + tail)); g.lineTo(hx, hy); g.stroke();
      g.globalAlpha = .9 * fade; g.drawImage(GL[r.col === "cyan" ? "cyan" : "rose"], hx - 18, hy - 18, 36, 36); g.drawImage(GL.white, hx - 5, hy - 5, 10, 10);
    }

    // тонкие связи
    g.globalCompositeOperation = "source-over";
    for (const l of lines) {
      if (CALM && l.kind === "track") continue;
      const p = l.dur ? c01((it - l.born) / l.dur) : 1; if (p <= 0) continue;
      const A = l.a, B = l.b, al = Math.min(A.alpha, B.alpha) * Math.min(depthA(A), depthA(B));
      const ex = lerp(A.px, B.px, easeOut(p)), ey = lerp(A.py, B.py, easeOut(p));
      g.globalAlpha = al * (l.kind === "teal" ? .5 : l.kind === "dash" ? .38 : .45);
      g.strokeStyle = l.kind === "teal" ? "#6fd3c9" : l.kind === "dash" ? "#e9dccf" : "#ffb45a";
      g.lineWidth = l.kind === "teal" ? .9 : .7;
      g.setLineDash(l.kind === "teal" ? [] : [2, 3.5]);
      g.beginPath(); g.moveTo(A.px, A.py); g.lineTo(ex, ey); g.stroke();
      if (p < 1) { g.globalCompositeOperation = "lighter"; g.globalAlpha = .9; g.drawImage(GL.white, ex - 6, ey - 6, 12, 12); g.globalCompositeOperation = "source-over"; }
    }
    g.setLineDash([]);
    g.globalAlpha = .26 * c01(it / 600); g.strokeStyle = "#f1e3d2"; g.setLineDash([1.5, 3]); g.lineWidth = .7;
    for (const s of spokes) { g.beginPath(); g.moveTo(CX + Math.cos(s.a) * 38, CY + Math.sin(s.a) * 38); g.lineTo(CX + Math.cos(s.a) * (38 + s.l), CY + Math.sin(s.a) * (38 + s.l)); g.stroke(); }
    g.setLineDash([]);

    // лучи-звук: мягкий столб света + бегущая по нему звуковая волна
    const drawBeam = tn => {
      const l = tn.beam, p = c01((it - l.born) / l.dur); if (p <= 0) return;
      const e = easeOut(p), ex = lerp(CX, tn.px, e), ey = lerp(CY, tn.py, e);
      const hot = tn.eps.some((_, k) => late(epNodes.find(x => x.tn === tn && x.e === tn.eps[k])));
      const hov = (tn.i === hoverTitle ? 1.5 : 1) * (.15 + .85 * tn.alpha), dA = depthA(tn), act = Math.min(1.4, tn.act * .8 + tn.boost);
      const endCol = hot ? "255,90,90" : "255,200,120";
      g.globalCompositeOperation = "lighter";
      for (const [w, a] of [[10 + act * 14, .045], [4 + act * 5, .11]]) {
        const gr = g.createLinearGradient(CX, CY, ex, ey);
        gr.addColorStop(0, `rgba(255,150,60,${a * 1.6 * hov * dA})`); gr.addColorStop(1, `rgba(${endCol},${a * hov * dA * (hot ? 1.6 : 1)})`);
        g.globalAlpha = 1; g.strokeStyle = gr; g.lineWidth = w * tn.pd; g.lineCap = "round";
        g.beginPath(); g.moveTo(CX, CY); g.lineTo(ex, ey); g.stroke();
      }
      const dx = ex - CX, dy = ey - CY, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, amp = (CALM ? .6 + act * 3 : 1 + act * 6.5) * tn.pd * (.25 + .75 * tn.alpha);
      const gr = g.createLinearGradient(CX, CY, ex, ey); gr.addColorStop(0, `rgba(255,236,190,${.85 * dA})`); gr.addColorStop(1, `rgba(${endCol},${.9 * dA})`);
      g.strokeStyle = gr; g.lineWidth = (1 + act * .7) * tn.pd; g.globalAlpha = hov > 1 ? 1 : .9;
      g.beginPath();
      for (let i = 0; i <= 64; i++) {
        const s = i / 64, env = Math.pow(Math.sin(s * Math.PI), .8);
        const off = amp * env * (Math.sin(s * L / 7.5 - t * .011) * .7 + Math.sin(s * L / 3.1 - t * .019) * .3 * act);
        const x = CX + dx * s + nx * off, y = CY + dy * s + ny * off;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      if (p < 1) { g.globalAlpha = 1; g.drawImage(GL.gold, ex - 22, ey - 22, 44, 44); g.drawImage(GL.white, ex - 7, ey - 7, 14, 14); }
    };
    // частицы, стекающиеся в центр
    for (const p of inflow) {
      const a = c01((150 - p.r) / 90) * .8 * c01((it - 900) / 800); if (a <= 0) continue;
      const dx = Math.cos(p.a), dy = Math.sin(p.a);
      g.globalCompositeOperation = "lighter"; g.globalAlpha = a; g.strokeStyle = "#ffe2b0"; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(CX + dx * (p.r + 9), CY + dy * (p.r + 9)); g.lineTo(CX + dx * p.r, CY + dy * p.r); g.stroke();
    }

    // подписи
    const label = (txt, x, y, font, col, al, align = "left") => { g.globalAlpha = al; g.font = font; g.textAlign = align; g.lineWidth = 3; g.strokeStyle = "rgba(8,5,4,.8)"; g.strokeText(txt, x, y); g.fillStyle = col; g.fillText(txt, x, y); };
    const badge = (txt, x, y, col, al) => { g.globalAlpha = al; g.font = "700 8.5px ui-monospace, Consolas, monospace"; g.textAlign = "left"; const w = g.measureText(txt).width + 7; g.fillStyle = "rgba(14,9,7,.9)"; g.beginPath(); g.roundRect(x, y - 8, w, 11, 3); g.fill(); g.fillStyle = col; g.fillText(txt, x + 3.5, y + .5); };

    // прямоугольники подписей тайтлов — чтобы бейджи серий, имена людей и всплывашки не налезали на текст
    const tRects = titleNodes.map(n => {
      const right = n.px >= CX - 10, rr = 10 + 7, w = 190, x = right ? n.px + rr : n.px - rr - w;
      return { x, y: n.py - 18, w, h: hasAir(n) ? 52 : 40 };
    });
    const inTitle = (x, y, w = 40, h = 12) => tRects.some(r => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
    const drawNode = n => {
      const b = bornK(n); if (b <= 0) return;
      const sc = pop(n) * n.pd, dA = depthA(n), a = n.alpha * dA;
      g.globalCompositeOperation = "source-over";
      if (n.kind === "title") {
        const active = n.eps.filter((_, k) => { const en = epNodes.find(x => x.tn === n && x.e === n.eps[k]); return vis(en) && n.eps[k].stage < 4; }).length;
        const r = (10 + active * 2.3) * sc * (n.i === hoverTitle ? 1.12 : 1);
        const hot = n.eps.some((_, k) => late(epNodes.find(x => x.tn === n && x.e === n.eps[k])));
        g.globalCompositeOperation = "lighter"; g.globalAlpha = a * .55; g.drawImage(GL.rose, n.px - r * 2.6, n.py - r * 2.6, r * 5.2, r * 5.2);
        if (hot) { g.globalAlpha = a * (.35 + .25 * Math.sin(t / 260)); g.drawImage(GL.fire, n.px - r * 3.4, n.py - r * 3.4, r * 6.8, r * 6.8); }
        const fl = c01(1 - (it - n.born) / 600); if (fl > 0 && it > n.born) { g.globalAlpha = fl; g.drawImage(GL.white, n.px - r * 2.5, n.py - r * 2.5, r * 5, r * 5); }
        g.globalCompositeOperation = "source-over"; g.globalAlpha = a;
        g.drawImage(SP.rose, n.px - r * 1.47, n.py - r * 1.47, r * 2.94, r * 2.94);
        // кольцо готовности
        const rr = r + 7 * n.pd;
        g.lineWidth = 2.2 * n.pd; g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.arc(n.px, n.py, rr, 0, 7); g.stroke();
        g.strokeStyle = "#ffc46a"; g.lineCap = "round"; g.beginPath(); g.arc(n.px, n.py, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * n.pct / 100 * pop(n)); g.stroke();
        if (hot) { g.strokeStyle = `rgba(255,90,100,${.45 + .35 * Math.sin(t / 260)})`; g.lineWidth = 1.4; g.beginPath(); g.arc(n.px, n.py, rr + 5 + Math.sin(t / 260) * 1.5, 0, 7); g.stroke(); }
        const nameFont = `600 ${Math.round(11 + 3 * n.pd)}px Segoe UI, system-ui, sans-serif`;
        g.font = nameFont;
        const tw = Math.max(g.measureText(n.t.name).width, 150 * n.pd);
        let right = n.px >= CX - 10;
        if (right && n.px + rr + 8 + tw > RLIM) right = false;     // подпись не уходит под правую колонку
        const lx = n.px + (right ? rr + 8 : -rr - 8), al = c01((b - .4) / .6) * (.35 + .65 * dA);
        label(n.t.name, lx, n.py - 1, nameFont, n.i === hoverTitle ? "#ffd99a" : "#f6ece6", al * (.3 + .7 * n.alpha), right ? "left" : "right");
        const sub = `${n.pct}% готово${hot ? " · просрочка" : ""}`;
        label(sub, lx, n.py + 13, `700 ${Math.round(8 + 2 * n.pd)}px ui-monospace, Consolas, monospace`, hot ? "#ff8a8a" : "#ffc46a", al * .9 * n.alpha, right ? "left" : "right");
        if (hasAir(n)) label(`${n.nextEp} серия · эфир ${airText(n.air)}`, lx, n.py + 25, `600 ${Math.round(8 + 2 * n.pd)}px Segoe UI, system-ui, sans-serif`, n.air <= 1 ? "#ffb070" : "#a8968c", al * .85 * n.alpha, right ? "left" : "right");
        return;
      }
      if (CALM && n.kind === "track") return;
      const ld = n.kind === "person" ? personLoad(n) : null;
      const cfg = n.kind === "ep" ? [SP.violet, GL.violet, 20, 21] : n.kind === "person" ? [SP.mint, GL.mint, 12 + ld.n * 3, 10 + ld.n * 2.4] : [SP.amber, GL.gold, 8, 7];
      const [spr, gl, gs, size] = cfg;
      g.globalCompositeOperation = "lighter"; g.globalAlpha = a * .55;
      g.drawImage(gl, n.px - gs * sc, n.py - gs * sc, gs * 2 * sc, gs * 2 * sc);
      const fl = c01(1 - (it - n.born) / 600); if (fl > 0 && it > n.born) { g.globalAlpha = fl; g.drawImage(GL.white, n.px - gs * 1.3, n.py - gs * 1.3, gs * 2.6, gs * 2.6); }
      if (n.popAt && t - n.popAt < 700) { g.globalAlpha = 1 - (t - n.popAt) / 700; g.drawImage(GL.white, n.px - gs * 1.6, n.py - gs * 1.6, gs * 3.2, gs * 3.2); }
      g.globalCompositeOperation = "source-over"; g.globalAlpha = a;
      g.drawImage(spr, n.px - size * sc, n.py - size * sc, size * 2 * sc, size * 2 * sc);
      if (ld && ld.late) { g.strokeStyle = `rgba(255,90,100,${.6 * dA * n.alpha})`; g.lineWidth = 1.3; g.beginPath(); g.arc(n.px, n.py, cfg[3] * sc * .7 + 3, 0, 7); g.stroke(); }
      if (n.kind === "ep" && late(n)) { g.strokeStyle = `rgba(255,90,100,${(.5 + .4 * Math.sin(t / 220)) * dA})`; g.lineWidth = 1.3; g.beginPath(); g.arc(n.px, n.py, 11 * sc + 2 + Math.sin(t / 220), 0, 7); g.stroke(); }
      if (b > .5) {
        if (n.kind === "ep") { if (!CALM && !inTitle(n.px + 8 * n.pd, n.py - 16 * n.pd)) badge(String(n.e.ep), n.px + 8 * n.pd, n.py - 8 * n.pd, late(n) ? "#ff9a9a" : "#cdb8ff", n.alpha * b * dA); }
        else if (n.kind === "track") badge(String(n.n), n.px + 4, n.py - 5, "#ffd49a", n.alpha * b * dA);
        else if (!inTitle(n.px, n.py - 10, 90, 16)) label(`${n.p.n} · ${ld.n}`, n.px + (cfg[3] * .7 + 6) * n.pd, n.py + 4, `600 ${Math.round(9 + 2.5 * n.pd)}px Segoe UI, system-ui, sans-serif`, ld.late ? "#ffb0b0" : "#bff5de", b * (.4 + .6 * dA) * (.3 + .7 * n.alpha));
      }
    };
    const drawHub = () => {
      const hb = c01(it / 500); if (hb <= 0) return;
      const sc = easeBack(hb) * (1 + Math.sin(t / 700) * .04);
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = .7; g.drawImage(GL.fire, CX - 110 * sc, CY - 110 * sc, 220 * sc, 220 * sc);
      g.globalAlpha = .5; g.drawImage(GL.gold, CX - 60 * sc, CY - 60 * sc, 120 * sc, 120 * sc);
      g.globalCompositeOperation = "source-over";
      const rot = t / 9000;
      for (let i = 0; i < 110; i++) {
        const a = i / 110 * Math.PI * 2 + rot, r1 = 30 * sc, l = (3 + hash("hub", i) * 9) * sc;
        g.globalAlpha = .35 + hash("h2", i) * .55; g.strokeStyle = i % 3 ? "#e8b76a" : "#fff0cf"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1); g.lineTo(CX + Math.cos(a) * (r1 + l), CY + Math.sin(a) * (r1 + l)); g.stroke();
      }
      g.globalAlpha = .5; g.strokeStyle = "#ffcf85"; g.setLineDash([2, 2.5]); g.lineWidth = .8; g.beginPath(); g.arc(CX, CY, 25 * sc, 0, 7); g.stroke(); g.setLineDash([]);
      g.globalAlpha = 1; g.drawImage(SP.gold, CX - 34 * sc, CY - 34 * sc, 68 * sc, 68 * sc);
      label("Project", CX + 44, CY + 2, "800 17px Segoe UI, system-ui, sans-serif", "#fff3e4", c01((it - 300) / 500));
      label(`${titleNodes.length} тайтлов · ${epNodes.filter(vis).length} серий`, CX + 45, CY + 19, "600 10px ui-monospace, Consolas, monospace", "#c9b3a5", c01((it - 500) / 500));
    };

    // порядок по глубине: дальнее → центр → ближнее
    const order = allNodes.slice().sort((a, b) => a.pz - b.pz);
    for (const tn of titleNodes) if (tn.pz < 0) drawBeam(tn);
    for (const n of order) if (n.pz < 0) drawNode(n);
    drawHub();
    for (const tn of titleNodes) if (tn.pz >= 0) drawBeam(tn);
    for (const n of order) if (n.pz >= 0) drawNode(n);

    // события: кометы, волны, вспышки, звёзды, подписи
    g.globalCompositeOperation = "lighter";
    for (const c of comets) {
      const k = c01((t - c.born) / c.dur), e = easeIO(k);
      const A = c.from, B = c.to, mx = (A.px + B.px) / 2, my = (A.py + B.py) / 2 - Math.hypot(B.px - A.px, B.py - A.py) * .22;
      const at = s => ({ x: (1 - s) * (1 - s) * A.px + 2 * (1 - s) * s * mx + s * s * B.px, y: (1 - s) * (1 - s) * A.py + 2 * (1 - s) * s * my + s * s * B.py });
      for (let j = 0; j < 14; j++) { const s = e - j * .018; if (s <= 0) break; const p = at(s); g.globalAlpha = (1 - j / 14) * .85; g.fillStyle = `rgb(${c.col})`; g.beginPath(); g.arc(p.x, p.y, 2.4 - j * .14, 0, 7); g.fill(); }
      const p = at(e); g.globalAlpha = 1; g.drawImage(GL.white, p.x - 10, p.y - 10, 20, 20);
      const gg = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 18); gg.addColorStop(0, `rgba(${c.col},.9)`); gg.addColorStop(1, `rgba(${c.col},0)`); g.fillStyle = gg; g.beginPath(); g.arc(p.x, p.y, 18, 0, 7); g.fill();
      if (k >= 1 && !c.hit) { c.hit = true; arrive(c); }
    }
    comets = comets.filter(c => !c.hit);
    for (const w of waves) {
      const k = (t - w.born) / 1400; if (k < 0) continue;
      const e = easeOut(k);
      g.globalAlpha = (1 - k) * .9; g.strokeStyle = `rgb(${w.col})`; g.lineWidth = 2.5 * (1 - k) + .4;
      g.beginPath(); g.arc(w.n.px, w.n.py, 6 + e * w.max, 0, 7); g.stroke();
      g.globalAlpha = (1 - k) * .25; g.lineWidth = 10 * (1 - k); g.beginPath(); g.arc(w.n.px, w.n.py, 6 + e * w.max * .92, 0, 7); g.stroke();
    }
    for (const p of pulses) { const k = (t - p.born) / 1500; g.globalAlpha = (1 - k) * .9; g.strokeStyle = `rgb(${p.col})`; g.lineWidth = 1.2; g.beginPath(); g.arc(p.n.px, p.n.py, 8 + k * 30, 0, 7); g.stroke(); }
    for (const w of twinkles) {
      const k = (t - w.born) / w.life, a = Math.sin(k * Math.PI), s = w.s * (.6 + .4 * a);
      g.globalAlpha = a; g.drawImage(w.cyan ? GL.cyan : GL.gold, w.x - s * .6, w.y - s * .6, s * 1.2, s * 1.2); g.drawImage(STAR, w.x - s, w.y - s, s * 2, s * 2);
    }
    g.globalCompositeOperation = "source-over";
    for (const ts of toasts) {
      const k = (t - ts.born) / 2600, a = Math.min(c01(k / .08), c01((1 - k) / .25));
      g.font = "600 11px Segoe UI, system-ui, sans-serif";
      const tw = g.measureText(ts.text).width + 26;
      let x = ts.n.px + 14; if (x + tw > RLIM) x = ts.n.px - 14 - tw;        // не под правую колонку
      x = Math.max(LLIM + 8, Math.min(x, RLIM - tw - 8));     // и не за левый край
      let y = ts.n.py - 24 - easeOut(c01(k * 3)) * 10; if (y < 175) y = Math.max(175, ts.n.py + 44);   // не под верхнюю панель
      if (inTitle(x, y - 13, 180, 20)) y -= 54;     // не поверх названия тайтла
      g.font = "600 11px Segoe UI, system-ui, sans-serif"; g.textAlign = "left";
      const w = g.measureText(ts.text).width + 26;
      g.globalAlpha = a; g.fillStyle = "rgba(16,10,8,.92)"; g.strokeStyle = `rgba(${ts.col},.55)`; g.lineWidth = 1;
      g.beginPath(); g.roundRect(x, y - 13, w, 20, 7); g.fill(); g.stroke();
      g.fillStyle = `rgb(${ts.col})`; g.beginPath(); g.arc(x + 10, y - 3, 3, 0, 7); g.fill();
      g.fillStyle = "#f6ece6"; g.fillText(ts.text, x + 18, y + 1);
    }
    g.globalAlpha = 1;
  }

  // ---------- шкала сезона и перемотка ----------
  // Полоски слева — настоящая активность по дням (сколько серий рождалось
  // рядом с этой датой). ▶ проигрывает сезон: день бежит, серии появляются
  // в сети по своим датам, к каждой прилетает комета от исполнителя.
  const TL_TOP = 46, TL_H = 440;
  const dayY = d => TL_TOP + d / (DAYS - 1) * TL_H;
  const dateLabel = d => { const m = monthOf(d); return `${Math.floor(d - MONTH_START[m]) + 1} ${MON_GEN[m]}`; };
  let dayAct = [];
  // завершённые по дням (из «Аналитики») тоже рисуются на шкале слева
  const trendByDay = {};
  for (const t of (AN && AN.trend && AN.trend.days) || []) {
    const i = Math.round((new Date(`${t.date}T00:00:00`) - START) / 86400000);
    if (i >= 0 && i < DAYS) trendByDay[i] = t.completed || 0;
  }
  function renderTimeline() {
    dayAct = Array.from({ length: DAYS }, (_, d) => {
      let s = 0; for (const en of epNodes) { const k = Math.abs(en.day - d); if (k < 8) s += (8 - k) / 8; }
      return s * 4 + (trendByDay[d] || 0) * 10;
    });
    const tl = $("#timeline");
    tl.innerHTML = `<button type="button" class="tl-play" id="tlPlay">▶ Перемотка сезона</button><canvas id="tlc" width="120" height="1000"></canvas>` +
      MONTHS.map((m, i) => `<button type="button" class="tl-m" data-m="${i}" style="top:${dayY(MONTH_START[i] + 15)}px">${m}</button>`).join("") +
      `<div class="tl-head" id="tlHead"><i></i><span></span></div>`;
    tl.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => { stopAuto(); playing = false; setDay(Math.min(DAYS - 1, (MONTH_START[Number(b.dataset.m) + 1] ?? DAYS) - 1)); }));
    $("#tlc").addEventListener("pointerdown", e => { stopAuto(); playing = false; const r = e.currentTarget.getBoundingClientRect(); setDay(((e.clientY - r.top) / r.height * 500 - TL_TOP) / TL_H * (DAYS - 1)); });
    $("#tlPlay").addEventListener("click", () => { stopAuto(); togglePlay(1); });
    drawTimeline();
  }
  function startPlay(speed) {
    if (day >= DAYS - 2) setDay(0, false);
    playSpeed = speed; playing = true; $("#tlPlay").textContent = "❚❚ Пауза";
  }
  function togglePlay(speed) {
    if (playing) { playing = false; $("#tlPlay").textContent = "▶ Перемотка сезона"; return; }
    startPlay(speed);
  }
  function drawTimeline() {
    const c = $("#tlc"); if (!c) return;
    const g = c.getContext("2d"), max = Math.max(1, ...dayAct);
    g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, 60, 500);
    for (let d = 0; d < DAYS; d++) {
      const len = 3 + dayAct[d] / max * 42, past = d <= day;
      g.fillStyle = past ? `rgba(255,${150 + Math.round(dayAct[d] / max * 70)},80,${.45 + dayAct[d] / max * .5})` : "rgba(255,160,80,.13)";
      g.fillRect(0, dayY(d) - .8, len, 1.3);
    }
    const hy = dayY(day);
    g.fillStyle = "rgba(255,196,106,.9)"; g.fillRect(0, hy - .6, 58, 1.2);
    const head = $("#tlHead");
    head.style.top = `${hy}px`; head.querySelector("span").textContent = dateLabel(day);
    $("#timeline").querySelectorAll("[data-m]").forEach(b => b.classList.toggle("past", MONTH_START[b.dataset.m] <= day));
  }
  let kpiDay = -99;
  function setDay(d, kpi = true) {
    day = clamp(d, 0, DAYS - 1);
    drawTimeline();
    if (kpi && $("#attn")) renderAttn();
    if (kpi) { updateKpis(500); kpiDay = day; }
  }
  // лента справа: сначала то, что алгоритм уже видел (кто что делал), дальше сюда падают события сцены
  function seedFeed() {
    const f = $("#feed"); if (!f || !ALGO) return;
    for (const r of (ALGO.feed || []).slice(0, 3).reverse()) feedAdd({ col: "255,205,120", text: `${r.who} · ${r.text}`, at: r.at });
  }
  // в списке этапов — типичное время на этапе, которое посчитал алгоритм
  function labelStages() {
    if (!ALGO || !ALGO.stages) return;
    const keys = ["draft", "review", "revision", "working", "completed"];
    [...$("#fStage").options].forEach(o => {
      const st = ALGO.stages[keys[Number(o.value)]];
      if (st && st.median_h != null && st.samples >= 2 && Number(o.value) >= 0 && Number(o.value) < 4) o.textContent = `${STAGES[Number(o.value)]} · ~${fmtH(st.median_h)}`;
    });
  }
  const WL_LABEL = { draft: "Черновики", working: "В работе", review: "Озвучка", revision: "Перезапись", completed: "Завершено" };
  const WL_COLOR = { draft: "#8f8f9e", working: "#f5c542", review: "#a98bff", revision: "#ff9448", completed: "#33d17a" };
  function renderLegend() {
    const dot = (x, y) => `background:radial-gradient(circle at 35% 30%,${x},${y})`;
    const help = "Тайтл: размер — серий в работе\nКольцо — готовность\nЧеловек · число — серий на нём\nКрасное — просрочка";
    const wl = (AN && AN.workload) || [];
    const max = Math.max(1, ...wl.map(w => w.total || 0));
    $("#legend").innerHTML = `<b title="${esc(help)}">Загрузка доски <u>?</u></b>` + (wl.length
      ? wl.map(w => `<div class="wl"><span>${esc(WL_LABEL[w.key] || w.label || w.key)}</span><i style="--w:${Math.round((w.total || 0) / max * 100)}%;--c:${WL_COLOR[w.key] || "#b5a39b"}"></i><em>${w.total || 0}</em></div>`).join("")
      : `<div><i style="${dot("#ffe6ee", "#b83a62")}"></i>Тайтл: размер — серий в работе</div><div><i style="${dot("#eafff6", "#0e5a40")}"></i>Человек · число — серий на нём</div><div><i style="background:#ff5a64;box-shadow:0 0 8px #ff5a64"></i>Красное — просрочка</div>`);
  }
  const kpiVals = { done: 0, ontime: 0, over: 0, avg: 0 };
  const fmtAvg = days => (days == null ? null : days < 2 ? { v: Math.max(1, Math.round(days * 24)), u: "ч" } : { v: Math.round(days * 10) / 10, u: "д" });
  function renderKpis() {
    const m = (AN && AN.metrics) || {};
    const delta = m.completed_prior_30d ? Math.round((m.completed_30d - m.completed_prior_30d) / m.completed_prior_30d * 100) : null;
    const avg = fmtAvg(m.avg_turnaround_days);
    $("#kpis").innerHTML = `
      <div class="kpi"><span>Завершено за 30 дней</span><b><svg viewBox="0 0 12 12"><path d="M1 10 4.5 6 7 8.5 11 3"/></svg><i data-k="done">0</i>${delta != null ? `<small class="${delta >= 0 ? "up" : "dn"}">${delta >= 0 ? "+" : ""}${delta}%</small>` : ""}</b></div>
      <div class="kpi"><span>Вовремя</span><b><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5"/><path d="M6 1.5V6h4.5"/></svg><i data-k="ontime">0</i><small>%</small></b></div>
      <div class="kpi"><span>Просрочено сейчас</span><b><svg viewBox="0 0 12 12"><path d="M6 1.5 1 10.5h10L6 1.5ZM6 5v2.5"/></svg><i data-k="over">0</i></b></div>
      <div class="kpi"><span>Среднее время серии</span><b><svg viewBox="0 0 12 12"><path d="M2 5v2M4.5 3v6M7 1.5v9M9.5 4v4"/></svg><i data-k="avg">${avg ? 0 : "—"}</i>${avg ? `<small>${avg.u}</small>` : ""}</b></div>`;
    $("#kpis").querySelectorAll("i").forEach(i => { i.style.fontStyle = "normal"; });
  }
  function countTo(el, from, to, dur = 700) {
    if (!el) return;
    if (reduce) { el.textContent = to; return; }
    const t0 = now();
    const step = () => { const k = c01((now() - t0) / dur); el.textContent = Math.round(lerp(from, to, easeOut(k))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function updateKpis(dur) {
    const m = (AN && AN.metrics) || {};
    const avg = fmtAvg(m.avg_turnaround_days);
    const next = { done: m.completed_30d || 0, ontime: m.on_time_rate == null ? 0 : Math.round(m.on_time_rate), over: m.overdue_now || 0, avg: avg ? avg.v : 0 };
    for (const k in next) {
      if (next[k] !== kpiVals[k]) {
        const el = $(`#kpis [data-k="${k}"]`);
        if (k === "avg" && avg && avg.v % 1) { if (el) el.textContent = avg.v; } else countTo(el, kpiVals[k], next[k], dur);
      }
      kpiVals[k] = next[k];
    }
    const d = $("#dockIn"); d.classList.add("glow"); clearTimeout(d._t); d._t = setTimeout(() => d.classList.remove("glow"), 600);
    $("#kpis").style.setProperty("--kx", `${(monthOf(day) % 4) * 138}px`);
  }

  // ---------- сводка и поиск ----------
  function showAlerts(qv = "") {
    const word = qv.trim().toLowerCase().split(/[\s—-]+/)[0] || "";
    const hits = word.length > 1 ? epNodes.filter(en => en.tn.t.name.toLowerCase().includes(word)).slice(-2).reverse() : [];
    const box = $("#alerts");
    const had = !!box.firstChild;
    if (!hits.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="alerts" style="${had ? "animation:none" : ""}"><div class="alerts-h"><span><b>●</b>&nbsp; НАЙДЕНО</span><span>${hits.length}</span></div>
      ${hits.map(en => `<button type="button" class="al" data-hit="${en.tn.t.id}:${en.e.ep}" style="animation:none;opacity:1"><div class="al-t">${esc(en.tn.t.name)}${en.e.ep ? ` · ${en.e.ep} серия` : ""}<span>${esc(STAGES[en.e.stage])} ↗</span></div></button>`).join("")}</div>`;
    box.querySelectorAll("[data-hit]").forEach(b => b.addEventListener("click", () => { stopAuto(); const [id, ep] = b.dataset.hit.split(":"); openBy(id, Number(ep)); }));
  }
  const hideAlerts = () => { $("#alerts").innerHTML = ""; };
  const openBy = (id, ep) => { const tn = titleNodes.find(x => x.t.id === id); if (tn) focusOpen(tn, ep); };
  const q = $("#q");
  q.addEventListener("focus", () => { stopAuto(); showAlerts(q.value); });
  q.addEventListener("input", () => showAlerts(q.value));
  document.addEventListener("pointerdown", e => { if (!$("#dock").contains(e.target)) hideAlerts(); });
  $("#searchForm").addEventListener("submit", e => {
    e.preventDefault(); stopAuto();
    const s = q.value.toLowerCase(), nums = (s.match(/\d+/g) || []).map(Number);
    const tn = titleNodes.find(x => s.includes(x.t.name.toLowerCase().split(" ")[0]));
    if (tn) focusOpen(tn, (tn.eps.find(e2 => nums.includes(e2.ep)) || tn.eps[tn.eps.length - 1]).ep);
  });

  // ---------- взаимодействие с сетью ----------
  // Тащить — крутить карусель; движение мыши слегка наклоняет сцену.
  function pick(e) {
    const r = cNet.getBoundingClientRect(), sc = r.width / W;
    const w = toWorld((e.clientX - r.left) / sc, (e.clientY - r.top) / sc);
    let best = null, bd = 1e9;
    for (const n of [...titleNodes, ...epNodes, ...pplNodes]) {
      if (n.alpha < .5) continue;
      const d = Math.hypot(n.px - w.x, n.py - w.y), lim = (n.kind === "title" ? 30 : n.kind === "person" ? 16 : 14) * n.pd / Math.sqrt(cam.s);
      if (d < lim && d - n.pz * 4 < bd) { bd = d - n.pz * 4; best = n; }
    }
    return best;
  }
  let drag = null;
  cNet.addEventListener("pointerdown", e => {
    stopAuto();
    drag = { x: e.clientX, y: e.clientY, phi, moved: false, sc: cNet.getBoundingClientRect().width / W };
    cNet.setPointerCapture(e.pointerId);
  });
  cNet.addEventListener("pointermove", e => {
    const r = cNet.getBoundingClientRect();
    mouse.tx = ((e.clientX - r.left) / r.width - .5) * 2; mouse.ty = ((e.clientY - r.top) / r.height - .5) * 2;
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) + Math.abs(e.clientY - drag.y) > 4) { drag.moved = true; cNet.classList.add("drag"); }
      if (drag.moved) phi = drag.phi + dx / drag.sc * .005;
      return;
    }
    const n = pick(e);
    hoverTitle = n ? (n.kind === "title" ? n.i : n.kind === "ep" ? n.tn.i : -1) : -1;
    cNet.classList.toggle("hot", !!n && n.kind !== "person");
    if (n) showTip(n); else if (!tipPinned) hideTip();
  });
  cNet.addEventListener("pointerup", e => {
    const d = drag; drag = null; cNet.classList.remove("drag");
    if (d && !d.moved) {
      const n = pick(e);
      hideTip(true);
      if (n && n.kind === "title") { const v = epNodes.filter(x => x.tn === n && vis(x)); focusOpen(n, (v[v.length - 1] || epNodes.find(x => x.tn === n)).e.ep); }
      else if (n && n.kind === "ep") focusOpen(n.tn, n.e.ep);
      else if (!n && (cam.s > HOMES * 1.05 || Math.abs(cam.x - HOMEX) > 5)) tweenCam({ x: HOMEX, y: CY, s: HOMES }, 800);
    }
  });
  cNet.addEventListener("pointerleave", () => { hoverTitle = -1; mouse.tx = 0; mouse.ty = 0; if (!tipPinned) hideTip(); });

  // что алгоритм знает о человеке: инструменты, просмотр, связь с сервером и DNS
  function personTip(name) {
    const pi = personInfo(name);
    if (!pi) return "";
    const tools = (pi.tools || []).slice(0, 3).map(t => `${esc(t.label)} ×${t.count}`).join(", ");
    const net = pi.net;
    const netLine = net ? `<div class="${net.server_ok && net.dns_ok !== false ? "" : "bad"}">Связь<em>${net.server_ok ? "сервер ✓" : "сервер ✗"}${net.dns_ok === false ? " · DNS ✗" : ""}</em></div>
      <div>Откуда<em>${esc(net.ip || "—")}${net.country ? ` · ${esc(net.country)}` : ""}</em></div>${net.dns_provider ? `<div>DNS<em>${esc(net.dns_provider)}</em></div>` : ""}` : "";
    return `${tools ? `<div>Пользуется<em>${tools}</em></div>` : ""}${pi.watch_s ? `<div>Смотрел<em>${fmtDur(pi.watch_s)}</em></div>` : ""}${netLine}`;
  }

  // подсказка при наведении: главное о кружке без въезда в фокус
  let tipPinned = false, tipTimer = 0;
  function showTip(n, pin = false) {
    const tip = $("#tip");
    let html;
    if (n.kind === "title") {
      const eps = epNodes.filter(x => x.tn === n && vis(x)), lt = eps.filter(late).length;
      html = `<b>${esc(n.t.name)}</b><div>Готовность<em>${n.pct}%</em></div><div>Серий в работе<em>${eps.filter(x => x.e.stage < 4).length}</em></div>
        <div class="${lt ? "bad" : ""}">Просрочено<em>${lt || "нет"}</em></div>${hasAir(n) ? `<div class="${n.air <= 1 ? "soon" : ""}">${n.nextEp} серия в эфире<em>${airText(n.air)}</em></div>` : ""}<small>Нажмите — откроется последняя серия</small>`;
    } else if (n.kind === "ep") {
      const e = n.e;
      html = `<b>${esc(n.tn.t.name)}${e.ep ? ` · ${e.ep} серия` : ""}</b><div>Этап<em>${STAGES[e.stage]}</em></div>
        <div class="${e.days < 0 ? "bad" : ""}">Срок<em>${dueText(e.days)}</em></div>
        ${e.stuck ? `<div class="bad">На этапе<em>${e.stuck} дн</em></div>` : ""}
        ${e.eta ? `<div class="${e.eta.stuck ? "bad" : "soon"}">Ожидаемый выход<em>${esc(fmtWhen(e.eta.ts))}</em></div><div>Оценка<em>${e.eta.learned ? "по истории этапов" : "пока грубая"}</em></div>` : ""}<div>Делают<em>${esc(e.who.map(p => p.n).join(", "))}</em></div><div>Дорожек<em>${e.tracks}</em></div><div class="${e.qc > 2 ? "bad" : ""}">Открытых пунктов<em>${e.qc}</em></div><small>Нажмите — откроется серия</small>`;
    } else if (n.kind === "person") {
      const ld = personLoad(n);
      html = `<b>${esc(n.p.n)}</b><div>Серий в работе<em>${ld.n}</em></div><div class="${ld.late ? "bad" : ""}">Из них просрочено<em>${ld.late || "нет"}</em></div>
        ${personTip(n.p.n)}<small>${ld.titles.length ? esc(ld.titles.join(" · ")) : "Сейчас без задач — можно назначить"}</small>`;
    } else return;
    tip.innerHTML = html; tip.hidden = false;
    const p = toScreen(n.px, n.py), w = tip.offsetWidth, h = tip.offsetHeight;
    let x = p.x + 18, y = p.y - h / 2;
    if (x + w > W - 310 && p.x > W / 2) x = p.x - w - 18;
    tip.style.left = `${clamp(x, 10, W - w - 10)}px`; tip.style.top = `${clamp(y, 56, H - h - 170)}px`;
    tipPinned = pin; clearTimeout(tipTimer);
    if (pin) tipTimer = setTimeout(() => { tipPinned = false; hideTip(); }, 5000);
  }
  function hideTip(force) { if (force) tipPinned = false; if (!tipPinned) $("#tip").hidden = true; }

  // ---------- «Внимание»: что горит прямо сейчас ----------
  function attentionItems() {
    const out = [];
    for (const en of epNodes) {
      if (!vis(en)) continue;
      const nm = `${en.tn.t.name} · ${en.e.ep} серия`;
      if (en.e.stage < 4 && late(en)) out.push({ w: 0, c: "#ff6b7d", t: "Просрочено", nm, d: `срок прошёл ${-en.e.days} дн · ${STAGES[en.e.stage]}`, n: en });
      else if (en.e.stage < 4 && en.e.stuck) out.push({ w: 1, c: "#f0a063", t: "Застряло", nm, d: `${en.e.stuck} дн на этапе «${STAGES[en.e.stage]}»`, n: en });
    }
    for (const tn of titleNodes) {
      if (!hasAir(tn) || tn.air > 1) continue;
      const lastEp = epNodes.filter(x => x.tn === tn).slice(-1)[0];
      if (!lastEp || lastEp.e.stage >= 3) continue;   // серия уже на сведении/проверке — успеваем
      if (out.some(o => o.n === lastEp)) continue;   // уже в списке как просроченная
      out.push({ w: 2, c: "#ffc46a", t: `Эфир ${airText(tn.air)}`, nm: `${tn.t.name} · ${tn.nextEp} серия`, d: `а наша ${lastEp.e.ep} серия ещё на этапе «${STAGES[lastEp.e.stage]}»`, n: lastEp });
    }
    return out.sort((a, b) => a.w - b.w).slice(0, 5);
  }
  function renderAttn() {
    const items = attentionItems(), box = $("#attn");
    box.innerHTML = `<div class="attn-h"><span><b>●</b> ВНИМАНИЕ</span><span>${items.length}</span></div>` +
      (items.length ? items.map((a, i) => `<button type="button" class="at" data-at="${i}" style="--c:${a.c}"><b>${a.t}</b><span>${esc(a.nm)}</span><small>${esc(a.d)}</small><i data-open="${i}" role="button" aria-label="Открыть серию">›</i></button>`).join("")
        : `<div class="attn-empty">Ничего не горит — всё по плану.</div>`) + algoBlock();
    box.querySelectorAll("[data-at]").forEach(b => b.addEventListener("click", e => {
      stopAuto();
      const a = items[b.dataset.at];
      if (e.target.closest("[data-open]")) { hideTip(true); focusOpen(a.n.tn, a.n.e.ep); return; }
      box.querySelectorAll(".at").forEach(x => x.classList.toggle("on", x === b));
      flyTo(a.n);
    }));
  }
  // выводы алгоритма: узкое место и наблюдения («дольше всего на этапе…», «у X часто не удаётся соединиться…»)
  function algoBlock() {
    if (!ALGO) return "";
    const lines = [];
    if (ALGO.bottleneck && ALGO.bottleneck.median_h != null) lines.push(`Узкое место: «${String(ALGO.bottleneck.label).replace(/^[^\p{L}\p{N}]+/u, "")}» — обычно ${fmtH(ALGO.bottleneck.median_h)}`);
    for (const t of ALGO.insights || []) if (!/^Дольше всего серия проводит/.test(t)) lines.push(t);
    if (!lines.length) return "";
    return `<div class="algo"><div class="attn-h"><span><b>◆</b> АЛГОРИТМ</span><span>${Math.min(3, lines.length)}</span></div>${lines.slice(0, 3).map(t => `<div class="algo-i">${esc(t)}</div>`).join("")}</div>`;
  }
  // ---------- правая колонка: всё, что раньше было отдельными блоками «Аналитики» ----------
  const stageName = en => STAGES[en.e.stage];
  function renderEtaPane() {
    const rows = epNodes.filter(en => en.e.stage < 4).sort((x, y) => ((x.e.eta ? x.e.eta.h : 9e9) - (y.e.eta ? y.e.eta.h : 9e9)));
    $("#rp-eta").innerHTML = `<div class="attn-h"><span><b>●</b> СЕРИИ В РАБОТЕ</span><span>${rows.length}</span></div>` + (rows.length ? rows.map((en, i) => `
      <button type="button" class="rrow" data-eta="${i}"><b>${esc(en.tn.t.name)}${en.e.ep ? ` · ${en.e.ep}` : ""}</b>
        <span>${esc(stageName(en))}${en.e.days < 99 ? ` · ${esc(dueText(en.e.days))}` : ""}</span>
        <small class="${en.e.eta && en.e.eta.stuck ? "bad" : ""}">${en.e.eta ? `выход ≈ ${esc(fmtWhen(en.e.eta.ts))}${en.e.eta.learned ? "" : " (грубо)"}` : "срок выхода не посчитан"}</small></button>`).join("") : `<div class="attn-empty">Нет серий в работе.</div>`);
    $("#rp-eta").querySelectorAll("[data-eta]").forEach(b => b.addEventListener("click", () => { stopAuto(); flyTo(rows[Number(b.dataset.eta)]); }));
  }
  function renderTeamPane() {
    const perf = Object.fromEntries(((AN && AN.performers) || []).map(p => [p.name, p]));
    const maxDone = Math.max(1, ...Object.values(perf).map(p => p.completed || 0));
    const netBy = Object.fromEntries((((WM && WM.network) || {}).people || []).map(r => [r.who, r]));
    const rows = pplNodes.map(pn => {
      const ld = personLoad(pn), pf = perf[pn.p.n] || {}, pi = personInfo(pn.p.n), net = netBy[pn.p.n] || (pi && pi.net);
      const bad = net && (!net.server_ok || net.dns_ok === false);
      return `<div class="rrow team${ld.late ? " late" : ""}"><b>${esc(pn.p.n)}</b>
        <span>в работе ${ld.n}${ld.late ? `, просрочено ${ld.late}` : ""} · сдано за 30 дн: ${pf.completed || 0}</span>
        <i class="bar" style="--w:${Math.round((pf.completed || 0) / maxDone * 100)}%"></i>
        <small>${pi && pi.tools && pi.tools.length ? esc(pi.tools.slice(0, 2).map(t => t.label).join(", ")) : "нет данных об использовании"}${pi && pi.watch_s ? ` · смотрел ${esc(fmtDur(pi.watch_s))}` : ""}</small>
        ${net ? `<small class="${bad ? "bad" : "ok"}">${esc(net.ip || "")}${net.country ? ` · ${esc(net.country)}` : ""} · сервер ${net.server_ok ? "✓" : "✗"} · DNS ${net.dns_ok === false ? "✗" : net.dns_ok ? "✓" : "?"}${net.dns_provider ? ` ${esc(net.dns_provider)}` : ""}</small>` : ""}</div>`;
    });
    $("#rp-team").innerHTML = `<div class="attn-h"><span><b>●</b> КОМАНДА</span><span>${rows.length}</span></div>` + (rows.join("") || `<div class="attn-empty">Пока никого.</div>`);
  }
  const ago = at => {
    const d = new Date(String(at).replace(" ", "T") + "Z"), m = Math.round((Date.now() - d.getTime()) / 60000);
    return Number.isNaN(m) ? "" : m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  };
  // «нажал в разделе «Обзор»: win-maximize» → по-человечески; служебные нажатия окна не показываем
  const ACTIONS = { "nav-more": "открыл меню разделов", "btn-refresh": "обновил данные", "btn-search": "открыл поиск", "search": "открыл поиск", "notif": "открыл уведомления" };
  const humanText = text => {
    const m = /^нажал в разделе «([^»]+)»: (.+)$/.exec(text);
    if (!m) return text;
    if (/^win-/.test(m[2])) return null;
    return ACTIONS[m[2]] ? `${ACTIONS[m[2]]} · ${m[1]}` : `действие в разделе «${m[1]}»`;
  };
  function renderLogPane() {
    const rows = [];
    for (const r of ((WM && WM.recent) || (ALGO && ALGO.feed) || [])) { const text = humanText(String(r.text)); if (text) rows.push({ ...r, text }); if (rows.length >= 25) break; }
    $("#logList").innerHTML = `<div class="attn-h"><span><b>●</b> КТО ЧТО ДЕЛАЕТ</span><span>${rows.length}</span></div>` + (rows.length ? rows.map(r => `<div class="rrow log"><div class="lh"><b>${esc(r.who)}</b><small>${esc(ago(r.at))}</small></div><span>${esc(r.text)}</span></div>`).join("") : `<div class="attn-empty">Пока ничего не замечено.</div>`);
  }
  function setRightTab(name) {
    document.querySelectorAll("[data-rt]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.rt === name)));
    for (const k of ["attn", "eta", "team", "log"]) { const el = $(`#rp-${k}`); if (el) el.hidden = k !== name; }
    try { localStorage.setItem("pulse-rtab", name); } catch (_) { /* без памяти */ }
  }
  function initRightColumn() {
    renderEtaPane(); renderTeamPane(); renderLogPane();
    document.querySelectorAll("[data-rt]").forEach(b => b.addEventListener("click", () => { stopAuto(); setRightTab(b.dataset.rt); }));
    let saved = "attn";
    try { saved = localStorage.getItem("pulse-rtab") || "attn"; } catch (_) { /* без памяти */ }
    setRightTab(["attn", "eta", "team", "log"].includes(saved) ? saved : "attn");
  }
  async function flyTo(n) {
    await tweenCam({ x: n.px - 90, y: n.py, s: 1.9 }, 900);
    waves.push({ n, born: now(), col: "255,200,110", max: 60 });
    showTip(n, true);
  }

  // ---------- фокус на серии ----------
  let F = null, fTok = 0;
  const ICON = {
    tracks: '<svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>',
    people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.8c1.9.6 3.1 2.3 3.5 5.2"/></svg>',
    roles: '<svg viewBox="0 0 24 24"><path d="M12 3a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4ZM5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    qc: '<svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4M12 17v.5"/></svg>',
    log: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  };
  function fanItems(key) {
    const { tn, info } = F, t = tn.t;
    const who = info.who.map(p => p.n);
    if (key === "roles") {
      // настоящие данные: кто озвучивает персонажа и кто в оригинале; назначений не выдумываем
      if (!t.roles.length) return who.map(n => ({ n, m: "исполнитель серии", chip: ["", ""] }));
      return t.roles.map(r => { r = typeof r === "string" ? { n: r } : r; return { n: r.n, m: r.by ? r.by : r.va ? `в оригинале: ${r.va}` : "не назначен", chip: r.by ? ["ok", "ГОЛОС"] : ["", "СВОБОДЕН"] }; });
    }
    if (key === "tracks") return info.tracks_list.map(f => ({ n: f.n, m: f.m, chip: ["ok", "ДОРОЖКА"] }));
    if (key === "qc") return info.qc_list.map(c => ({ n: c.n, m: "чек-лист серии", chip: c.done ? ["ok", "СДЕЛАНО"] : ["bad", "ОТКРЫТО"] }));
    if (key === "people") return who.map(n => ({ n, m: "исполнитель серии", chip: ["", ""] }));
    return info.log.map(l => ({ n: l.n, m: l.m, chip: ["", STAGES[info.stage].toUpperCase()] }));
  }
  const cardsFor = () => [
    { k: "tracks", n: F.info.tracks, l: "Дорожки" },
    { k: "people", n: F.info.who.length, l: "Исполнители" },
    { k: "roles", n: F.tn.t.roles.length || F.info.who.length, l: "Персонажи" },
    { k: "qc", n: F.info.qc_list.length, l: "Пункты чек-листа" },
    { k: "log", n: F.info.log.length, l: "Последние события" },
  ];
  // фазы: 0 — шар в центре, 1 — шар + карточки, 2 — всё влево под веер
  const PH = [{ ox: 640, oy: 400, os: 1, cx: 760 }, { ox: 440, oy: 400, os: .86, cx: 650 }, { ox: 170, oy: 400, os: .62, cx: 320 }];
  const cardY = i => 400 + (i - 2) * 84;
  function geomAt(p) {
    const i = Math.min(1, Math.floor(clamp(p, 0, 1.999))), k = easeIO(clamp(p - i, 0, 1)), a = PH[i], b = PH[i + 1];
    return { ox: lerp(a.ox, b.ox, k), oy: lerp(a.oy, b.oy, k), os: lerp(a.os, b.os, k), cx: lerp(a.cx, b.cx, k) };
  }
  function layoutDom() {
    const G = geomAt(F.p), s = F.os * G.os;
    $("#fTitle").style.transform = `translate(${G.ox}px, ${G.oy - 122 * s - 64}px) scale(${Math.max(.55, s)})`;
    $("#fChip").style.transform = `translate(${G.ox}px, ${G.oy + 125 * s}px) scale(${Math.max(.6, s)})`;
    $("#fCards").querySelectorAll(".f-card").forEach((c, i) => { c.style.transform = `translate(${G.cx}px, ${cardY(i) - 32}px)`; });
  }
  function tweenP(to, dur) {
    const from = F.p, t0 = now(), tok = F.tok;
    return new Promise(res => {
      if (reduce) { F.p = to; layoutDom(); return res(); }
      const step = () => { if (!F || F.tok !== tok) return res(); const k = c01((now() - t0) / dur); F.p = lerp(from, to, k); layoutDom(); k < 1 ? requestAnimationFrame(step) : res(); };
      requestAnimationFrame(step);
    });
  }
  const bez = (x1, y1, x2, y2, t) => { const dx = (x2 - x1) * .55, u = 1 - t; const c1x = x1 + dx, c2x = x2 - dx; return { x: u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2, y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2 }; };
  function strokeBez(g, x1, y1, x2, y2, upto = 1) {
    g.beginPath(); g.moveTo(x1, y1);
    const N = 28; for (let i = 1; i <= N; i++) { const p = bez(x1, y1, x2, y2, i / N * upto); g.lineTo(p.x, p.y); }
    g.stroke();
  }
  const COMET = ["255,214,140", "255,250,235", "120,235,210", "255,150,180", "255,190,90"];

  function drawFx(t) {
    const g = gF;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cFx.width, cFx.height);
    if (!F) return;
    g.setTransform(RES, 0, 0, RES, 0, 0);
    const G = geomAt(F.p), ox = G.ox, oy = G.oy, s = F.os * G.os, fa = F.alpha;
    if (s <= 0 || fa <= 0) return;
    // огромная тусклая дуга и тёмный диск вокруг шара
    g.globalAlpha = fa * c01(F.p - .6) * .9;
    g.strokeStyle = "rgba(255,190,110,.10)"; g.lineWidth = 1.5; g.beginPath(); g.arc(ox, oy, 560, -1.2, 1.2); g.stroke();
    g.strokeStyle = "rgba(255,190,110,.05)"; g.lineWidth = 60; g.beginPath(); g.arc(ox, oy, 590, -1.1, 1.1); g.stroke();
    const vg = g.createRadialGradient(ox, oy, 0, ox, oy, 190 * s + 40); vg.addColorStop(0, "rgba(0,0,0,.55)"); vg.addColorStop(.75, "rgba(0,0,0,.35)"); vg.addColorStop(1, "rgba(0,0,0,0)");
    g.globalAlpha = fa; g.fillStyle = vg; g.beginPath(); g.arc(ox, oy, 190 * s + 40, 0, 7); g.fill();

    // провода к карточкам
    const cards = F.cards || [];
    cards.forEach((c, i) => {
      if (c.wire == null) return;
      const k = c01((t - c.wire) / 650);
      const x1 = ox + 105 * s, y1 = oy, x2 = G.cx, y2 = cardY(i);
      g.globalAlpha = fa * (c.k === F.sel ? .95 : .4); g.strokeStyle = c.k === F.sel ? "#ffd48a" : "#eadbd0"; g.lineWidth = c.k === F.sel ? 1.6 : 1;
      strokeBez(g, x1, y1, x2, y2, easeOut(k));
      if (k < 1) drawComet(g, x1, y1, x2, y2, easeOut(k), COMET[i % COMET.length], fa);
    });
    // веер
    if (F.fan) {
      const ci = cards.findIndex(c => c.k === F.sel), x1 = G.cx + 186, y1 = cardY(ci);
      F.fan.forEach((f, i) => {
        const k = c01((t - f.at) / 720); if (k <= 0) return;
        g.globalAlpha = fa * (i === F.item ? .95 : .5) * f.fade; g.strokeStyle = i === F.item ? "#ffd48a" : "#f2e3d6"; g.lineWidth = i === F.item ? 1.5 : .9;
        strokeBez(g, x1, y1, f.x - 4, f.y, easeOut(k));
        if (k < 1) drawComet(g, x1, y1, f.x - 4, f.y, easeOut(k), COMET[f.c], fa);
        else if (!f.shown) { f.shown = true; const el = $("#fList").children[i]; if (el) { el.style.opacity = f.fade; el.style.transform = `translate(${f.x}px, ${f.y - 15}px)`; } }
        // медленные искры по готовым линиям
        if (k >= 1 && !reduce) { const sp = ((t / 2600 + hash(F.sel, i)) % 1.6); if (sp < 1) { const p = bez(x1, y1, f.x - 4, f.y, sp); g.globalCompositeOperation = "lighter"; g.globalAlpha = fa * Math.sin(sp * Math.PI) * .9 * f.fade; g.drawImage(GL.gold, p.x - 7, p.y - 7, 14, 14); g.globalCompositeOperation = "source-over"; } }
      });
    }

    // шар серии и два «звуковых» кольца
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = fa * .55; g.drawImage(GL.violet, ox - 120 * s, oy - 120 * s, 240 * s, 240 * s);
    g.globalCompositeOperation = "source-over";
    const ring = (r0, amp, col, wdt, speed, seed) => {
      g.strokeStyle = col; g.lineWidth = wdt; g.beginPath();
      const N = 220;
      for (let i = 0; i <= N; i++) {
        const a = i / N * Math.PI * 2, tt = t / 1000 * speed;
        const n = Math.sin(a * 9 + tt * 2.1 + seed) * .5 + Math.sin(a * 23 - tt * 3.3) * .35 + Math.sin(a * 51 + tt * 5 + seed) * .25 + Math.sin(a * 3 + tt) * .4;
        const r = (r0 + Math.abs(n) * amp) * s;
        const x = ox + Math.cos(a) * r, y = oy + Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    };
    const ra = fa * c01((t - F.ringAt) / 700);
    g.globalAlpha = ra * .85; ring(92, 16, "rgba(170,140,255,.8)", 1.1, 1, 1.3);
    g.globalAlpha = ra * .5; ring(88, 9, "rgba(120,90,220,.7)", .8, 1.4, 4.1);
    g.globalAlpha = ra * .95; ring(63, 10, "rgba(110,225,205,.9)", 1.1, 1.8, 2.2);
    g.globalAlpha = fa; g.drawImage(SP.violet, ox - 78 * s, oy - 78 * s, 156 * s, 156 * s);
    g.globalAlpha = 1;
  }
  function drawComet(g, x1, y1, x2, y2, k, col, fa) {
    g.globalCompositeOperation = "lighter";
    for (let j = 0; j < 10; j++) {
      const kk = k - j * .012; if (kk <= 0) break;
      const p = bez(x1, y1, x2, y2, kk);
      g.globalAlpha = fa * (1 - j / 10) * .8; g.fillStyle = `rgb(${col})`; g.beginPath(); g.arc(p.x, p.y, 2.2 - j * .15, 0, 7); g.fill();
    }
    const p = bez(x1, y1, x2, y2, k);
    g.globalAlpha = fa; g.drawImage(GL.white, p.x - 11, p.y - 11, 22, 22);
    const gl = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16); gl.addColorStop(0, `rgba(${col},.9)`); gl.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gl; g.beginPath(); g.arc(p.x, p.y, 16, 0, 7); g.fill();
    g.globalCompositeOperation = "source-over";
  }

  async function typeText(el, text, per = 45, tok) {
    const gold = s => esc(s).replace(/(\d+)/g, "<em>$1</em>");
    for (let i = 1; i <= text.length; i++) {
      if (tok !== fTok) return;
      el.innerHTML = gold(text.slice(0, i));
      await sleep(per);
    }
  }
  function renderCards() {
    F.cards = cardsFor().map(c => ({ ...c, wire: null }));
    $("#fCards").innerHTML = F.cards.map(c => `<button type="button" class="f-card" data-card="${c.k}"><b>${ICON[c.k]}<i data-cnt="${c.n}" style="font-style:normal">0</i></b><span>${c.l}</span></button>`).join("");
    $("#fCards").querySelectorAll("[data-card]").forEach(b => b.addEventListener("click", () => { stopAuto(); selectCard(b.dataset.card); }));
  }
  function fanGeom(n) {
    const top = 92, bot = 722, cy = 405, out = [];
    for (let i = 0; i < n; i++) {
      const y = top + (bot - top) * i / Math.max(1, n - 1), th = (y - cy) / (bot - cy) * 1.2;
      out.push({ x: 560 + 100 * Math.cos(th), y, fade: clamp(1 - Math.max(0, Math.abs(th) - .72) * 1.9, .22, 1) });
    }
    return out;
  }
  function renderFan(t0) {
    const items = fanItems(F.sel), geo = fanGeom(items.length);
    F.item = F.item ?? 0;
    F.fan = geo.map((g2, i) => ({ ...g2, at: t0 + i * (reduce ? 0 : 85), c: Math.floor(hash(F.sel, i) * COMET.length), shown: false }));
    $("#fList").innerHTML = items.map((it, i) => `<button type="button" class="f-it${i === F.item ? " on" : ""}" style="transform:translate(${geo[i].x - 10}px, ${geo[i].y - 15}px)">
      <span class="n">${esc(it.n)}</span><span class="m">${it.chip[1] ? `<span class="chip ${it.chip[0]}">${esc(it.chip[1])}</span>` : ""}${esc(it.m)}</span></button>`).join("");
    const els = $("#fList").children;
    [...els].forEach((el, i) => el.addEventListener("click", () => { stopAuto(); F.item = i; [...els].forEach((x, k) => x.classList.toggle("on", k === i)); }));
  }
  function selectCard(k) {
    if (!F || !F.cards || k === F.sel) return;
    F.sel = k; F.item = 0;
    $("#fCards").querySelectorAll(".f-card").forEach(c => c.classList.toggle("sel", c.dataset.card === k));
    renderFan(now() + 100);
  }

  // Точечный график — настоящая активность по серии за 40 дней (сколько действий в день); без данных точки остаются тусклыми.
  function dotsDraw(cv, hist, prog) {
    const g = cv.getContext("2d"), w = cv.width, h = cv.height, cols = 40, rows = 9;
    g.clearRect(0, 0, w, h);
    const max = Math.max(1, ...hist), top = hist.indexOf(Math.max(...hist, 0));
    for (let c = 0; c < cols; c++) {
      if (c / cols > prog) break;
      const n = hist[c] || 0, v = n ? Math.max(1, Math.round(n / max * rows)) : 0, peak = n > 0 && c === top;
      for (let r = 0; r < rows; r++) {
        const on = r < v, x = (c + .5) * (w / cols), y = h - (r + .5) * (h / rows);
        g.fillStyle = on ? (peak ? "#ffd27a" : "rgba(244,236,232,.6)") : "rgba(120,95,85,.35)";
        g.beginPath(); g.arc(x, y, on ? 2.3 : 1.3, 0, 7); g.fill();
      }
    }
  }
  function renderPanel() {
    const { tn, ep, info } = F, d = info.days;
    const code = esc(info.public_id);
    $("#fPanel").innerHTML = `
      <div class="fp-eye"><svg viewBox="0 0 24 24"><path d="M12 3a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4ZM5 11a7 7 0 0 0 14 0M12 18v3"/></svg>${STAGES[info.stage]} · ${code}</div>
      <h2 class="fp-title" id="fpTitle"></h2>
      <div class="fp-row"><span class="st">${info.stage >= 4 ? "ГОТОВО" : "В РАБОТЕ"}</span><p>Последнее изменение<br><b>${esc(info.last || "—")}</b></p><button class="btn" type="button" id="fpOpen">Открыть серию ›</button></div>
      <div class="meter"><div class="meter-h"><span>Готовность серии</span><span class="tag">${info.stage >= 4 ? "ГОТОВО" : d < 0 ? "ПРОСРОЧЕНО" : d <= 2 ? "СРОК СКОРО" : "В СРОК"}</span></div>
        <div class="meter-b"><div class="big"><span data-cnt="${info.pct}">0</span>%</div><div class="delta"><b>${d >= 99 ? "—" : d < 0 ? `−${-d} дн` : `${d} дн`}</b><span>${d >= 99 ? "срок не задан" : d < 0 ? "просрочка" : "до срока"}</span></div><canvas id="dots" width="400" height="96"></canvas></div></div>
      <div class="fp-sum"><svg viewBox="0 0 24 24"><path d="M3 17l5-5 4 4 8-8M15 8h5v5"/></svg>Сводка по серии</div>
      <div class="fp-note"><b>${info.qc ? `Открытых пунктов чек-листа: ${info.qc}` : "Открытых пунктов нет"}</b>${info.stage >= 4 ? "Серия завершена." : d < 0 ? "Срок прошёл — стоит напомнить исполнителям или сдвинуть срок." : info.stuck ? `Серия ${info.stuck} дн на этапе «${esc(STAGES[info.stage])}» — стоит проверить.` : "Идёт по плану."}${info.eta ? `<br>Ожидаемый выход: <b>${esc(fmtWhen(info.eta.ts))}</b> (${info.eta.learned ? "оценка по истории этапов" : "пока грубая оценка"}).` : ""}</div>
      <button type="button" class="btn fp-ask" id="fpOpen2">Открыть карточку серии ›</button>`;
    $("#fpOpen")?.addEventListener("click", () => send({ type: "open-report", public_id: info.public_id }));
    $("#fpOpen2")?.addEventListener("click", () => send({ type: "open-report", public_id: info.public_id }));
  }
  async function panelIn(tok) {
    const pn = $("#fPanel"), kids = [...pn.children];
    pn.classList.add("on");
    await sleep(500); if (tok !== fTok) return;
    kids[0].classList.add("in"); kids[1].classList.add("in");
    typeText($("#fpTitle"), `${F.tn.t.name}${F.ep ? ` — ${F.ep} серия` : ""}`, 28, tok);
    await sleep(350); if (tok !== fTok) return;
    kids[2].classList.add("in");
    await sleep(200); if (tok !== fTok) return;
    kids[3].classList.add("in");
    countTo(pn.querySelector(".meter [data-cnt]"), 0, F.info.pct, 1300);
    const cv = $("#dots"), t0 = now(), hist = F.info.hist || [];
    cv.title = "Действия по серии за последние 40 дней";
    const grow = () => { if (tok !== fTok || !cv.isConnected) return; const k = c01((now() - t0) / 1300); dotsDraw(cv, hist, reduce ? 1 : k); if (k < 1) requestAnimationFrame(grow); };
    grow();
    await sleep(400); if (tok !== fTok) return;
    kids[4].classList.add("in"); kids[5].classList.add("in");
    await sleep(400); if (tok !== fTok) return;
    kids[6]?.classList.add("in");
  }

  async function focusOpen(tn, ep) {
    hideAlerts(); q.blur();
    const tok = ++fTok;
    const e = tn.eps.find(x => x.ep === ep) || tn.eps[tn.eps.length - 1];
    const en = epNodes.find(x => x.tn === tn && x.e === e);

    // 1) камера ныряет в узел серии, сеть уходит в расфокус
    netFadeUntil = now() + 1200;
    rotTarget = 0; rotSpeed = 0;
    tweenCam({ x: en.px, y: en.py + 8, s: 5.2 }, 1100, t => t * t * (3 - 2 * t));
    F = { tn, ep: e.ep, info: e, sel: "roles", item: 0, p: 0, tok, os: 0, alpha: 0, ringAt: 1e15, cards: null, fan: null };
    ["#fCards", "#fList"].forEach(s => $(s).innerHTML = "");
    $("#fTitle b").innerHTML = ""; $("#fTitle span").innerHTML = ""; $("#fChip").classList.remove("on");
    $("#fPanel").classList.remove("on"); $("#fPanel").innerHTML = "";
    await sleep(450); if (tok !== fTok) return;
    stage.classList.add("focusing");
    // 2) узел вырастает в шар серии
    const t0 = now();
    await new Promise(res => { const st = () => { if (tok !== fTok) return res(); const k = c01((now() - t0) / 800); F.os = lerp(.1, 1, easeBack(k)); F.alpha = c01(k * 1.6); layoutDom(); k < 1 ? requestAnimationFrame(st) : res(); }; reduce ? (F.os = 1, F.alpha = 1, layoutDom(), res()) : st(); });
    F.ringAt = now();
    // 3) заголовок набирается по буквам
    await typeText($("#fTitle b"), tn.t.name, 50, tok);
    await typeText($("#fTitle span"), `${e.ep ? `${e.ep} серия` : "серия"} · ${STAGES[e.stage]}`, 40, tok);
    if (tok !== fTok) return;
    $("#fChip").innerHTML = `<b>ОТКРЫТО <em>${e.qc}</em></b><i style="--p:${Math.min(100, e.qc * 25)}%"></i>`; $("#fChip").classList.add("on");
    renderCards(); layoutDom(); renderPanel();
    await sleep(150); if (tok !== fTok) return;
    // 4) кометы рождают карточки по одной, шар отъезжает влево
    tweenP(1, 1300);
    const cardEls = $("#fCards").querySelectorAll(".f-card");
    for (let i = 0; i < F.cards.length; i++) {
      F.cards[i].wire = now();
      const el = cardEls[i];
      setTimeout(() => { if (tok !== fTok) return; el.classList.add("show"); const n = el.querySelector("[data-cnt]"); countTo(n, 0, Number(n.dataset.cnt), 1000); }, reduce ? 0 : 600);
      await sleep(260); if (tok !== fTok) return;
    }
    await sleep(600); if (tok !== fTok) return;
    cardEls[2].classList.add("sel");
    await sleep(300); if (tok !== fTok) return;
    // 5) всё уезжает влево, веер рисуется сверху вниз
    await tweenP(2, 1100); if (tok !== fTok) return;
    renderFan(now());
    await sleep(reduce ? 0 : F.fan.length * 85 + 500); if (tok !== fTok) return;
    // 6) панель поворачивается и заполняется
    panelIn(tok);
  }
  async function focusClose() {
    fTok++;
    const f = F;
    $("#fDom").style.opacity = 0;
    if (f) { const t0 = now(); await new Promise(res => { const st = () => { const k = c01((now() - t0) / 450); f.alpha = 1 - k; k < 1 ? requestAnimationFrame(st) : res(); }; st(); }); }
    F = null;
    ["#fCards", "#fList"].forEach(s => $(s).innerHTML = "");
    $("#fTitle b").innerHTML = ""; $("#fTitle span").innerHTML = ""; $("#fChip").classList.remove("on"); $("#fPanel").classList.remove("on");

    stage.classList.remove("focusing");
    rotTarget = 1;
    setTimeout(() => { $("#fDom").style.opacity = ""; }, 50);
    await tweenCam({ x: HOMEX, y: CY, s: HOMES }, 1200);
  }
  $("#fBack").addEventListener("click", () => { stopAuto(); focusClose(); });
  document.querySelectorAll("[data-f]").forEach(b => b.addEventListener("click", () => {
    FILTER.who = b.dataset.f;
    document.querySelectorAll("[data-f]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#fStage").addEventListener("change", e => { FILTER.stage = Number(e.target.value); });
  function setCalm(v) {
    CALM = v;
    try { localStorage.setItem("pulse-bright", v ? "0" : "1"); } catch (_) { /* без памяти */ }
    $("#calmBtn").setAttribute("aria-pressed", String(!v));
    if (!v) rotTarget = 1;
  }
  $("#calmBtn").addEventListener("click", () => setCalm(!CALM));
  $("#zIn").addEventListener("click", () => { stopAuto(); if (!F) tweenCam({ s: clamp(cam.s * 1.3, .7, 3) }, 450); });
  $("#zOut").addEventListener("click", () => { stopAuto(); if (!F) tweenCam({ s: clamp(cam.s / 1.3, .7, 3) }, 450); });

  // ---------- главный цикл ----------
  // Экономия: сцена, скрытая в другой вкладке, не рисуется и отдаёт память холстов; в покое — 30 кадров/с;
  // если кадры дольше 26 мс — качество холста снижается (и поднимается обратно, когда стало легко).
  let last = now(), lastDraw = 0, lastAct = now(), slowN = 0, fastN = 0;
  ["pointermove", "pointerdown", "wheel", "keydown"].forEach(ev => addEventListener(ev, () => { lastAct = now(); }, { passive: true }));
  new IntersectionObserver(es => {
    const v = es[0].isIntersecting;
    if (v === VISIBLE) return;
    VISIBLE = v; resize(); if (v) last = now();
  }).observe(wrapEl);
  function frame() {
    requestAnimationFrame(frame);
    if (!VISIBLE) return;
    const t = now();
    const idle = t - lastAct > 4000 && !playing && !F && !auto && !comets.length && !toasts.length;
    if (idle && t - lastDraw < 30) return;
    const dt = Math.min(50, t - last); last = t;
    const cost = t - lastDraw; lastDraw = t;
    if (!idle) {
      if (cost > 36) { fastN = 0; if (++slowN > 90 && QUAL > .85) { QUAL = .85; slowN = 0; resize(); } }
      else { slowN = 0; if (++fastN > 600 && QUAL < 1) { QUAL = 1; fastN = 0; resize(); } }
    }
    // ошибка в одном слое не должна останавливать всю сцену
    for (const step of [() => ambient(t, dt), project, () => drawNet(t), () => drawFx(t)]) {
      try { step(); } catch (err) { if (!frame.warned) { frame.warned = true; console.error(err); } }
    }
  }
  function tweenPhi(to, dur) {
    const from = phi, t0 = now();
    return new Promise(res => {
      if (reduce) { phi = to; return res(); }
      const step = () => { const k = c01((now() - t0) / dur); phi = lerp(from, to, easeIO(k)); k < 1 ? requestAnimationFrame(step) : res(); };
      requestAnimationFrame(step);
    });
  }

  // ---------- режиссура, как в ролике ----------
  let auto = null;
  function stopAuto() { if (auto) { auto.stop = true; rotTarget = 1; } }
  // Вступление — 2–3 секунды и только при первом открытии за день;
  // «Показать вступление» проигрывает его ещё раз.
  async function run(force) {
    stopAuto();
    const tok = auto = { stop: false };
    if (F) { fTok++; F = null; ["#fCards", "#fList"].forEach(s => $(s).innerHTML = ""); $("#fTitle b").innerHTML = ""; $("#fTitle span").innerHTML = ""; $("#fChip").classList.remove("on"); $("#fPanel").classList.remove("on"); }
    stage.classList.remove("focusing");
    hideAlerts(); hideTip(true); q.value = "";
    twinkles = []; pulses = []; comets = []; waves = []; toasts = [];
    playing = false; rotSpeed = CALM ? 0 : 1; rotTarget = CALM ? 0 : 1;
    for (const k in kpiVals) kpiVals[k] = 0;
    renderKpis(); setDay(DAYS - 1, false);
    const today = new Date().toISOString().slice(0, 10);
    let seen = false;
    try { seen = localStorage.getItem("pulse-intro") === today; localStorage.setItem("pulse-intro", today); } catch (_) { /* без памяти */ }
    camTok++;
    if (reduce || (seen && !force)) {
      finishIntro(); cam.x = HOMEX; cam.y = CY; cam.s = HOMES;
      stage.classList.remove("intro");
    } else {
      stage.classList.add("intro");
      cam.x = CX; cam.y = CY; cam.s = 2.9;
      scheduleIntro(now());
      tweenCam({ x: HOMEX, s: HOMES }, 2600, t => easeIO(c01((t - .08) / .92)));
      await sleep(2300);
      stage.classList.remove("intro");
    }
    if (tok.stop) return;
    updateKpis(700);
    renderAttn();
    auto = null;
  }
  $("#replay").addEventListener("click", () => run(true));
  stage.addEventListener("pointerdown", e => { if (!e.target.closest("#replay")) stopAuto(); });

  seedFeed(); labelStages(); build(); prepareEvents(); renderTimeline(); renderLegend(); renderKpis(); initRightColumn(); setCalm(CALM);
  HOMES = titleNodes.length <= 2 ? 1.55 : titleNodes.length <= 4 ? 1.25 : 1;
  requestAnimationFrame(frame);
  run();
}
