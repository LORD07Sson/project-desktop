// Заставка при запуске — повторяет интро-ролик Reroll целиком (разобран покадрово, 60 к/с), в цветах пользователя:
//   0,00 с  сцена «кубик»: тёмный стеклянный кубик с точкой на фоне размытых «лепестков» акцента, камера плывёт
//   0,52 с  склейка → угол окна программы с доком: плитка-логотип, значок чата, ещё приложение; камера отъезжает
//   0,95 с  склейка → «P» из размытия, плитка с поворотом садится на место «o», буквы выпрыгивают снизу
//   3,20 с  слово гаснет → три точки (пока грузятся данные, «дышат» волной)
//   затем   точки сливаются в одну → контур квадрата по часовой → заливка → плитка подрастает и кувыркается
//           3D-кубиком (грани 1–6) → карточка профиля (аватар-круг, имя, подпись) → «монета» с пунктирными
//           кольцами → плитка с крестиком логотипа улетает на своё место в шапке, фон растворяется.
// Цвет — акцент пользователя (--fire / --gold / --accent-grad), фон — его тема (--bg). Клик или Esc — пропустить.

// Без Web Animations API (тесты в jsdom, старый WebView) — как при «уменьшить движение»: без интро.
const reduce = () => typeof window.Element?.prototype.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const OUT = "cubic-bezier(.22, .9, .3, 1)";
// Темп: ролик чуть медленнее оригинала — сцены успевают рассмотреть, но без затянутости.
const S = 1.2;
let skipped = false;
const wait = ms => (skipped ? Promise.resolve() : new Promise(r => setTimeout(r, ms * S)));
const play = (el, frames, opts = {}) => {
  const a = el.animate(frames, { fill: "both", ...opts, duration: (opts.duration || 0) * S, delay: (opts.delay || 0) * S });
  if (skipped) a.finish();
  return a.finished.catch(() => {});
};

let ready = null;      // промис «интро доиграло до точек»
let wave = [];
let t0 = 0;

const tile = (extra = "") => `<span class="sp-t ${extra}"><i></i><svg class="sp-tx" viewBox="0 0 24 24" aria-hidden="true"><path pathLength="10" d="M7 7l10 10M17 7 7 17"/></svg></span>`;
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const face = (n, cls) => `<div class="sp-df ${cls}">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(p => `<i${PIPS[n].includes(p) ? ' class="on"' : ""}></i>`).join("")}</div>`;
const glow = (cls = "") => `<div class="sp-glow ${cls}"><i></i><i></i><i></i><i></i></div>`;

function build(root) {
  const name = (document.getElementById("whoami")?.textContent || "").trim();
  root.innerHTML = `
    <section class="sp-scene" data-s="cube">
      <div class="sp-glow c">${[1, 2, 3].map(() => '<div class="sp-blade"><i class="f"></i><i class="s t"></i><i class="s b"></i><i class="s l"></i><i class="s r"></i></div>').join("")}</div>
      <div class="sp-shade"></div>
      <div class="sp-cube"><div class="sp-glass">
        <i class="g-body"></i><i class="g-see"></i><i class="g-left"></i><i class="g-top"></i><i class="g-bottom"></i>
        <i class="g-spec l"></i><i class="g-spec r"></i><i class="g-rim"></i><b class="g-drop"></b>
      </div></div>
    </section>
    <section class="sp-scene" data-s="dock">
      <div class="sp-win">${glow("w")}
        <div class="sp-dock"><span class="sp-ic app">${tile()}</span><span class="sp-ic chat"><svg viewBox="0 0 24 24"><path d="M12 4c5 0 9 3.1 9 7s-4 7-9 7c-1 0-2-.1-2.9-.4L5 19l1-3.4C4.2 14.3 3 12.7 3 11c0-3.9 4-7 9-7Z"/></svg></span><span class="sp-ic"></span></div>
      </div>
    </section>
    <section class="sp-scene" data-s="word">
      <div class="sp-stage">
        <div class="sp-word" aria-label="Project">
          <span class="sp-l">P</span><span class="sp-l">r</span><span class="sp-l sp-o" data-o></span><span class="sp-l">j</span><span class="sp-l">e</span><span class="sp-l">c</span><span class="sp-l">t</span>
        </div>
        <div class="sp-tile" data-tile><i></i></div>
        <div class="sp-dots" data-dots><i></i><i></i><i></i></div>
        <svg class="sp-mark" data-mark viewBox="0 0 48 48" aria-hidden="true">
          <defs><linearGradient id="sp-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--fire)"/><stop offset="1" style="stop-color:var(--gold, var(--fire))"/></linearGradient></defs>
          <path class="sp-fill" d="M12 1h24a11 11 0 0 1 11 11v24a11 11 0 0 1-11 11H12A11 11 0 0 1 1 36V12A11 11 0 0 1 12 1Z"/>
          <path class="sp-stroke" pathLength="100" d="M47 24v12a11 11 0 0 1-11 11H12A11 11 0 0 1 1 36V12A11 11 0 0 1 12 1h24a11 11 0 0 1 11 11Z"/>
          <circle class="sp-dot" cx="24" cy="24" r="6.5"/>
        </svg>
      </div>
    </section>
    <section class="sp-scene" data-s="dice">
      <div class="sp-dice"><div class="sp-d3"><div class="sp-dcore">${"<i></i>".repeat(6)}</div><div class="sp-dcore b">${"<i></i>".repeat(6)}</div>${face(1, "d1")}${face(6, "d6")}${face(3, "d3")}${face(4, "d4")}${face(2, "d2")}${face(5, "d5")}</div></div>
    </section>
    <section class="sp-scene" data-s="profile">
      <div class="sp-prof">
        <aside></aside>
        <div class="sp-banner">${glow("b")}</div>
        <div class="sp-ava">${tile()}</div>
        <div class="sp-who"><b>Project</b><small>${name ? `@${name.replace(/[<>&"]/g, "")}` : "@project"}</small><p>сделано с душой — студия озвучки</p></div>
      </div>
    </section>
    <section class="sp-scene" data-s="coin">
      <div class="sp-coin"><div class="sp-disc"><i class="r3"></i><i class="r1"></i><i class="r2"></i><i class="r4"></i></div>${tile("fly")}</div>
    </section>
    <div class="sp-flash"></div>
    <div class="app-splash-status" data-status>Загружаем данные…</div>`;
}

// Переход между сценами — «пролёт сквозь»: уходящая сцена наезжает на камеру и размывается,
// новая проявляется из лёгкого отдаления и размытия; на стыке — короткая вспышка акцента.
function cut(root, name) {
  const next = root.querySelector(`[data-s="${name}"]`);
  const prev = root.querySelector(".sp-scene.on");
  if (prev && prev !== next && !skipped) {
    play(prev, [{ transform: "scale(1)", filter: "blur(0)", opacity: 1 }, { transform: "scale(1.22)", filter: "blur(14px)", opacity: 0 }], { duration: 260, easing: "cubic-bezier(.5,0,.75,0)" })
      .then(() => { prev.classList.remove("on"); prev.getAnimations().forEach(a => a.cancel()); });
    play(next, [{ transform: "scale(.9)", filter: "blur(12px)", opacity: 0 }, { transform: "scale(1)", filter: "blur(0)", opacity: 1 }], { duration: 340, delay: 90, easing: OUT });
    const flash = root.querySelector(".sp-flash");
    if (flash) play(flash, [{ opacity: 0 }, { opacity: .55, offset: .4 }, { opacity: 0 }], { duration: 300, delay: 60 });
  } else if (prev && prev !== next) prev.classList.remove("on");
  next.classList.add("on");
  return next;
}

// Камера облетает кубик: плиты поворачиваются против часовой (~14°), кубик — от «виден верх и правый бок»
// к «виден низ и левая фаска». Кубик прозрачный: что за ним — видно сквозь стекло, как в ролике.
async function sceneCube(root) {
  const s = cut(root, "cube");
  const g = s.querySelector(".sp-glass");
  // плиты — 3D-лопасти вокруг кубика; камера облетает их по трём осям, поэтому перспектива плит меняется, как в ролике
  play(s.querySelector(".sp-glow"), [{ transform: "rotateX(var(--cx0)) rotateY(var(--cy0)) rotateZ(var(--cz0))" }, { transform: "rotateX(var(--cx1)) rotateY(var(--cy1)) rotateZ(var(--cz1))" }], { duration: 520, easing: "ease-in-out" });
  play(g, [{ transform: "perspective(900px) rotateX(-17deg) rotateY(-15deg) rotateZ(10deg)" }, { transform: "perspective(900px) rotateX(13deg) rotateY(8deg) rotateZ(-1deg)" }], { duration: 520, easing: "ease-in-out" });
  play(g.querySelector(".g-top"), [{ height: "15%" }, { height: "0%" }], { duration: 520, easing: "ease-in-out" });
  play(g.querySelector(".g-bottom"), [{ height: "3%" }, { height: "19%" }], { duration: 520, easing: "ease-in-out" });
  play(g.querySelector(".g-left"), [{ width: "3%" }, { width: "9%" }], { duration: 520, easing: "ease-in-out" });
  // пятно плиты, видное сквозь стекло, сползает вслед за поворотом камеры
  play(g.querySelector(".g-see"), [{ transform: "translate(-6%, 10%) scale(.8)", opacity: .75 }, { transform: "none", opacity: 1 }], { duration: 520, easing: "ease-in-out" });
  await wait(520);
}

async function sceneDock(root) {
  const s = cut(root, "dock");
  play(s.querySelector(".sp-win"), [{ transform: "translate(3%, -2%) scale(1.1)" }, { transform: "none" }], { duration: 430, easing: "ease-out" });
  await wait(430);
}

async function sceneWord(root) {
  const s = cut(root, "word");
  const word = s.querySelector(".sp-word");
  const letters = [...s.querySelectorAll(".sp-l")];
  const flyer = s.querySelector("[data-tile]");
  const slot = s.querySelector("[data-o]");
  const widths = letters.map(el => el.getBoundingClientRect().width);
  letters.forEach(el => { el.style.width = "0px"; });

  const grow = (i, dur) => play(letters[i], [{ width: "0px" }, { width: `${widths[i]}px` }], { duration: dur, easing: OUT });
  const rise = i => {
    grow(i, 300);
    return play(letters[i], [
      { transform: "translateY(.5em)", opacity: 0 },
      { transform: "translateY(-.07em)", opacity: 1, offset: .55 },
      { transform: "translateY(.02em)", offset: .8 },
      { transform: "none", opacity: 1 },
    ], { duration: 420, easing: "ease-out" });
  };

  // «P» из размытия, крупнее и тусклее → резко, 220 мс
  grow(0, 1);
  play(letters[0], [
    { filter: "blur(14px)", opacity: 0, transform: "scale(1.18)" },
    { filter: "blur(0)", opacity: 1, transform: "none" },
  ], { duration: 220, easing: OUT });

  // плитка справа от «P»: поворот −18° → 45° (ромб) → 0°, садится в слот «o»
  const ws = word.getBoundingClientRect();
  const em = parseFloat(getComputedStyle(word).fontSize) || 84;
  flyer.style.left = `${widths[0] + em * .62}px`;
  flyer.style.top = `${ws.height / 2 - em * .12}px`;
  play(flyer, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
  play(flyer, [
    { transform: "translate(-50%, -50%) rotate(-18deg) scale(1.3)" },
    { transform: "translate(-50%, -50%) rotate(45deg) scale(1.15)", offset: .5 },
    { transform: "translate(-50%, -50%) rotate(0) scale(1)" },
  ], { duration: 560, easing: OUT });

  await wait(240);
  rise(1);
  await wait(200);
  grow(2, 260);
  await wait(120);
  const st = s.querySelector(".sp-stage").getBoundingClientRect();
  const so = slot.getBoundingClientRect();
  await play(flyer, [
    { left: flyer.style.left, top: flyer.style.top },
    { left: `${so.left - st.left + so.width / 2}px`, top: `${so.top - st.top + so.height / 2}px` },
  ], { duration: 220, easing: OUT });
  // плитка села — дальше живёт внутри слота «o»: слово ещё растёт и сдвигается к центру, плитка едет вместе с ним
  flyer.getAnimations().forEach(a => a.cancel());
  Object.assign(flyer.style, { left: "50%", top: "50%", opacity: "1", transform: "translate(-50%, -50%)" });
  slot.style.position = "relative";
  slot.append(flyer);
  for (let i = 3; i < letters.length; i++) { rise(i); await wait(80); }
  // слово держится до отметки 3 с от начала ролика
  await wait(Math.max(380, 3000 - (Date.now() - t0) / S));
}

// слово гаснет (≈35 мс), пауза, три точки слева направо с шагом 50 мс; пока грузится — «дышат» волной
async function toDots(root) {
  const s = root.querySelector('[data-s="word"]');
  const dots = [...s.querySelectorAll("[data-dots] i")];
  await Promise.all([s.querySelector(".sp-word"), s.querySelector("[data-tile]")].map(el => play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 60 })));
  await wait(30);
  await Promise.all(dots.map((d, i) => play(d, [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }], { duration: 110, delay: i * 50, easing: OUT })));
  if (skipped) return;
  wave = dots.map((d, i) => d.animate([{ transform: "none" }, { transform: "translateY(-6px)", offset: .3 }, { transform: "none", offset: .6 }, { transform: "none" }],
    { duration: 900, delay: 300 + i * 120, iterations: Infinity, easing: "ease-in-out" }));
}

async function toTile(root) {
  const s = root.querySelector('[data-s="word"]');
  const dots = [...s.querySelectorAll("[data-dots] i")];
  const box = s.querySelector("[data-dots]");
  const mark = s.querySelector("[data-mark]");
  root.querySelector("[data-status]").classList.remove("on");
  wave.forEach(a => a.cancel());
  wave = [];
  await wait(200);

  // слияние: левая перетекает в среднюю (110 мс), пауза, две оставшиеся — в одну; ряд держится по центру
  const gap = dots[1].getBoundingClientRect().left - dots[0].getBoundingClientRect().left;
  const merge = async (from, into, shift) => {
    play(box, [{ transform: `translateX(${shift[0]}px)` }, { transform: `translateX(${shift[1]}px)` }], { duration: 110, easing: "ease-in-out" });
    play(into, [{ transform: "scale(1)" }, { transform: "scale(1.22, .9)", offset: .6 }, { transform: "scale(1)" }], { duration: 180 });
    await play(from, [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${gap}px)`, opacity: 1, offset: .85 }, { transform: `translateX(${gap}px)`, opacity: 0 }], { duration: 110, easing: "ease-in" });
  };
  await merge(dots[0], dots[1], [0, -gap / 2]);
  await wait(130);
  await merge(dots[1], dots[2], [-gap / 2, -gap]);

  // контур по часовой от правого края (220 мс), пауза 220 мс, заливка цветом и потемневшая точка (200 мс)
  mark.style.opacity = "1";
  play(box, [{ opacity: 1 }, { opacity: 0 }], { duration: 1 });
  await play(mark.querySelector(".sp-stroke"), [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 220, easing: "cubic-bezier(.45,0,.55,1)" });
  await wait(220);
  play(mark.querySelector(".sp-fill"), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
  await play(mark.querySelector(".sp-dot"), [{ fill: "var(--fire)" }, { fill: "var(--bg)" }], { duration: 200 });
  // плитка чуть подрастает перед кувырком (≈150 мс)
  await play(mark, [{ transform: "scale(1)" }, { transform: "scale(1.12)" }], { duration: 150, easing: "ease-out" });
}

async function sceneDice(root) {
  const s = cut(root, "dice");
  const d = s.querySelector(".sp-d3");
  // кувырок: грани 1 → 3 → 4/6 → 5 → снова 1, ~370 мс; затем оседает и уменьшается (≈150 мс)
  await play(d, [
    { transform: "rotateX(0) rotateY(0) rotateZ(0)" },
    { transform: "rotateX(-35deg) rotateY(-50deg) rotateZ(10deg)", offset: .25 },
    { transform: "rotateX(-160deg) rotateY(-120deg) rotateZ(25deg)", offset: .55 },
    { transform: "rotateX(-300deg) rotateY(-240deg) rotateZ(10deg)", offset: .85 },
    { transform: "rotateX(-360deg) rotateY(-360deg) rotateZ(0)" },
  ], { duration: 370, easing: "cubic-bezier(.3,.1,.3,1)" });
  await play(s.querySelector(".sp-dice"), [{ transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 150, easing: OUT });
}

async function sceneProfile(root) {
  const s = cut(root, "profile");
  play(s.querySelector(".sp-prof"), [{ transform: "translate(-1.5%, 1%) scale(1.06)" }, { transform: "none" }], { duration: 370, easing: "ease-out" });
  play(s.querySelector(".sp-banner .sp-glow"), [{ transform: "rotate(-4deg)" }, { transform: "rotate(3deg)" }], { duration: 370, easing: "linear" });
  await wait(370);
}

async function sceneCoin(root) {
  const s = cut(root, "coin");
  play(s.querySelector(".sp-coin"), [{ transform: "scale(1.1)" }, { transform: "none" }], { duration: 470, easing: "ease-out" });
  play(s.querySelector(".r1"), [{ transform: "rotate(0)" }, { transform: "rotate(40deg)" }], { duration: 470 });
  play(s.querySelector(".r2"), [{ transform: "rotate(0)" }, { transform: "rotate(-30deg)" }], { duration: 470 });
  await wait(470);
}

// плитка «монеты» → логотип: точка уступает место крестику, плитка летит в шапку, фон растворяется.
// Плитку на время полёта выносим поверх всего окна: заставка начинается под шапкой и обрезала бы её верхние углы,
// а размер и скругление ведём напрямую (не scale) — углы на любом размере остаются ровными и в конце совпадают с логотипом.
async function flyHome(root) {
  const t = root.querySelector('[data-s="coin"] .sp-t');
  const coin = root.querySelector(".sp-coin");
  play(t.querySelector("i"), [{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 160, easing: "ease-in" });
  play(t.querySelector(".sp-tx path"), [{ strokeDashoffset: 10 }, { strokeDashoffset: 0 }], { duration: 220, delay: 60, easing: OUT });
  const logo = document.querySelector(".titlebar-left .brand-logo");
  const from = t.getBoundingClientRect();
  const to = logo?.getBoundingClientRect();
  if (!to || !to.width) { await play(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }); return; }
  const z = parseFloat(document.documentElement.style.zoom || getComputedStyle(document.documentElement).zoom) || 1;
  const box = r => ({ left: `${r.left / z}px`, top: `${r.top / z}px`, width: `${r.width / z}px`, height: `${r.height / z}px` });
  const r0 = parseFloat(getComputedStyle(t).borderTopLeftRadius) || from.width / z * .28;
  const r1 = parseFloat(getComputedStyle(logo).borderTopLeftRadius) || 0;
  Object.assign(t.style, { position: "fixed", margin: "0", zIndex: "100000", pointerEvents: "none", ...box(from), borderRadius: `${r0}px` });
  document.body.append(t);
  logo.style.opacity = "0";
  play(coin.querySelector(".sp-disc"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.92)" }], { duration: 260, easing: "ease-in" });
  play(root, [{ backgroundColor: "#000" }, { backgroundColor: "transparent" }], { duration: 400, delay: 120, easing: "ease-out" });
  try {
    await play(t, [{ ...box(from), borderRadius: `${r0}px` }, { ...box(to), borderRadius: `${r1}px` }], { duration: 480, delay: 120, easing: "cubic-bezier(.65,0,.35,1)" });
    logo.style.opacity = "";
    // логотип уже на месте — плитка тает поверх него, без скачка
    await play(t, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
  } finally {
    logo.style.opacity = "";
    t.remove();
  }
}

// Окно загрузилось (страница, шрифты) и главный поток отпустило — несколько кадров подряд без задержек.
// Не дольше 2,5 с: на медленной машине лучше начать, чем держать чёрный экран.
async function settled() {
  const limit = Date.now() + 2500;
  if (document.readyState !== "complete") await new Promise(r => window.addEventListener("load", r, { once: true }));
  await Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 800))]);
  let calm = 0;
  let last = 0;
  while (calm < 6 && Date.now() < limit && !skipped) {
    const now = await new Promise(r => { requestAnimationFrame(r); setTimeout(() => r(0), 120); });
    calm = last && now && now - last < 24 ? calm + 1 : 0;
    last = now;
  }
}

export function startSplash() {
  const root = document.getElementById("app-splash");
  if (!root || reduce()) { ready = Promise.resolve(); return; }
  build(root);
  root.classList.add("sp-run");
  const skip = () => { skipped = true; root.getAnimations({ subtree: true }).forEach(a => { try { a.finish(); } catch (_) { a.cancel(); } }); };
  root.addEventListener("click", skip);
  document.addEventListener("keydown", e => { if (e.key === "Escape") skip(); }, { once: true });
  ready = (async () => {
    // пока окно только открылось, держим чёрный экран: ролик стартует, когда всё загружено и кадры идут ровно
    await settled();
    t0 = Date.now();
    await sceneCube(root);
    await sceneDock(root);
    await sceneWord(root);
    await toDots(root);
    // загрузка затянулась — через пару секунд под точками появится «Загружаем данные…»
    setTimeout(() => { if (wave.length) root.querySelector("[data-status]")?.classList.add("on"); }, 1800);
  })();
}

// Вызывается, когда известно, куда вести (программа или вход): доигрываем ролик и уводим заставку.
export async function finishSplash() {
  const root = document.getElementById("app-splash");
  if (!root) return;
  await (ready || Promise.resolve());
  if (!reduce() && !skipped && root.classList.contains("sp-run")) {
    await toTile(root);
    await sceneDice(root);
    await sceneProfile(root);
    await sceneCoin(root);
    await flyHome(root);
  }
  root.classList.add("hide");
  setTimeout(() => root.remove(), reduce() || skipped ? 350 : 0);
}
