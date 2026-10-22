// Заставка при запуске — по мотивам интро Reroll (разобрано покадрово, 60 к/с):
//   1. «P» проявляется из размытия, плитка цвета акцента прилетает с поворотом и встаёт на место «o»,
//      остальные буквы выпрыгивают снизу с пружинкой, по ~80 мс друг за другом, слово раздвигается.
//   2. Пока грузятся данные — три точки (проявляются слева направо, шаг 50 мс).
//   3. Готово: точки сливаются в одну, вокруг по часовой рисуется контур квадрата, он заливается цветом,
//      точка превращается в крестик логотипа, и плитка улетает на место логотипа в шапке — переход в программу.
// Цвет — акцент пользователя (--fire / --accent-grad), фон — его тема (--bg). Клик или Esc — пропустить.

const reduce = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const SPRING = "cubic-bezier(.34, 1.56, .64, 1)";
const OUT = "cubic-bezier(.22, .9, .3, 1)";
const wait = ms => new Promise(r => setTimeout(r, ms));
const play = (el, frames, opts) => el.animate(frames, { fill: "both", ...opts }).finished.catch(() => {});

let ready = null;      // промис «интро до точек доиграло»
let skipped = false;

function build(root) {
  root.innerHTML = `
    <div class="sp-stage">
      <div class="sp-word" aria-label="Project">
        <span class="sp-l" data-l>P</span><span class="sp-l" data-l>r</span><span class="sp-l sp-o" data-o></span><span class="sp-l" data-l>j</span><span class="sp-l" data-l>e</span><span class="sp-l" data-l>c</span><span class="sp-l" data-l>t</span>
      </div>
      <div class="sp-tile" data-tile><i></i></div>
      <div class="sp-dots" data-dots><i></i><i></i><i></i></div>
      <svg class="sp-mark" data-mark viewBox="0 0 48 48" aria-hidden="true">
        <defs><linearGradient id="sp-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--fire)"/><stop offset="1" style="stop-color:var(--gold, var(--fire))"/></linearGradient></defs>
        <path class="sp-fill" d="M12 1h24a11 11 0 0 1 11 11v24a11 11 0 0 1-11 11H12A11 11 0 0 1 1 36V12A11 11 0 0 1 12 1Z"/>
        <path class="sp-stroke" pathLength="100" d="M47 24v12a11 11 0 0 1-11 11H12A11 11 0 0 1 1 36V12A11 11 0 0 1 12 1h24a11 11 0 0 1 11 11Z"/>
        <circle class="sp-dot" cx="24" cy="24" r="6.5"/>
        <path class="sp-x" pathLength="10" d="M16 16 32 32M32 16 16 32"/>
      </svg>
    </div>
    <div class="app-splash-status" data-status>Загружаем данные…</div>`;
}

async function intro(root) {
  const word = root.querySelector(".sp-word");
  const letters = [...root.querySelectorAll(".sp-l")];
  const tile = root.querySelector("[data-tile]");
  const slot = root.querySelector("[data-o]");
  // ширины букв — чтобы слово раздвигалось по мере появления, как в ролике
  const widths = letters.map(el => el.getBoundingClientRect().width);
  letters.forEach(el => { el.style.width = "0px"; });
  root.classList.add("sp-run");

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

  // 1) «P» из размытия, крупнее и тусклее → резко, 220 мс
  grow(0, 1);
  play(letters[0], [
    { filter: "blur(14px)", opacity: 0, transform: "scale(1.18)" },
    { filter: "blur(0)", opacity: 1, transform: "none" },
  ], { duration: 220, easing: OUT });

  // плитка: справа-сверху, поворот −18° → 45° (ромб) → 0°, садится в слот «o» к ~560 мс
  const ws = word.getBoundingClientRect();
  const placeTile = () => {
    const s = slot.getBoundingClientRect();
    const stage = root.querySelector(".sp-stage").getBoundingClientRect();
    return { x: s.left - stage.left + s.width / 2, y: s.top - stage.top + s.height / 2 };
  };
  // Стартовая точка плитки — справа от «P» с зазором, чуть выше середины строки (как в ролике).
  const em = parseFloat(getComputedStyle(word).fontSize) || 84;
  tile.style.left = `${widths[0] + em * .62}px`;
  tile.style.top = `${ws.height / 2 - em * .12}px`;
  play(tile, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
  play(tile, [
    { transform: "translate(-50%, -50%) rotate(-18deg) scale(1.3)" },
    { transform: "translate(-50%, -50%) rotate(45deg) scale(1.15)", offset: .5 },
    { transform: "translate(-50%, -50%) rotate(0) scale(1)" },
  ], { duration: 560, easing: OUT });

  await wait(240);
  rise(1);                                     // «r»
  await wait(200);
  grow(2, 260);                                // место под «o» раздвигается
  await wait(120);
  const t = placeTile();                       // плитка доезжает до своего места
  await play(tile, [
    { left: tile.style.left, top: tile.style.top },
    { left: `${t.x}px`, top: `${t.y}px` },
  ], { duration: 220, easing: OUT });
  for (let i = 3; i < letters.length; i++) { rise(i); await wait(80); }
  await wait(420);
}

let wave = [];

// 2) слово гаснет (≈35 мс), пауза, три точки слева направо с шагом 50 мс; пока грузится — точки «дышат» волной
async function toDots(root) {
  const word = root.querySelector(".sp-word");
  const tile = root.querySelector("[data-tile]");
  const dots = [...root.querySelectorAll("[data-dots] i")];
  await Promise.all([word, tile].map(el => play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 60 })));
  await wait(30);
  await Promise.all(dots.map((d, i) => play(d, [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }], { duration: 110, delay: i * 50, easing: OUT })));
  wave = dots.map((d, i) => d.animate([{ transform: "none" }, { transform: "translateY(-6px)", offset: .3 }, { transform: "none", offset: .6 }, { transform: "none" }],
    { duration: 900, delay: 300 + i * 120, iterations: Infinity, easing: "ease-in-out" }));
}

async function outro(root) {
  const dots = [...root.querySelectorAll("[data-dots] i")];
  const box = root.querySelector("[data-dots]");
  const mark = root.querySelector("[data-mark]");
  const status = root.querySelector("[data-status]");

  status.classList.remove("on");
  wave.forEach(a => a.cancel());
  wave = [];
  await wait(200); // точки держатся ~200 мс, как в ролике

  // 3) слияние: левая перетекает в среднюю (110 мс), пауза, оставшиеся две — в одну; ряд держится по центру
  const gap = dots[1].getBoundingClientRect().left - dots[0].getBoundingClientRect().left;
  const merge = async (from, into, shift) => {
    play(box, [{ transform: `translateX(${shift[0]}px)` }, { transform: `translateX(${shift[1]}px)` }], { duration: 110, easing: "ease-in-out" });
    play(into, [{ transform: "scale(1)" }, { transform: "scale(1.22, .9)", offset: .6 }, { transform: "scale(1)" }], { duration: 180 });
    await play(from, [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${gap}px)`, opacity: 1, offset: .85 }, { transform: `translateX(${gap}px)`, opacity: 0 }], { duration: 110, easing: "ease-in" });
  };
  await merge(dots[0], dots[1], [0, -gap / 2]);
  await wait(130);
  await merge(dots[1], dots[2], [-gap / 2, -gap]);

  // точка → значок: контур по часовой от правого края (220 мс), пауза, заливка цветом, точка темнеет
  mark.style.opacity = "1";
  play(box, [{ opacity: 1 }, { opacity: 0 }], { duration: 1 });
  const stroke = mark.querySelector(".sp-stroke");
  const fill = mark.querySelector(".sp-fill");
  const dot = mark.querySelector(".sp-dot");
  const cross = mark.querySelector(".sp-x");
  await play(stroke, [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 220, easing: "cubic-bezier(.45,0,.55,1)" });
  await wait(220);
  play(fill, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
  await play(dot, [{ fill: "var(--fire)" }, { fill: "var(--bg)" }], { duration: 200 });
  // точка уступает место крестику логотипа
  play(dot, [{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 160, easing: "ease-in" });
  await play(cross, [{ strokeDashoffset: 10 }, { strokeDashoffset: 0 }], { duration: 240, delay: 80, easing: OUT });
  await wait(120);

  // 4) плитка улетает на место логотипа в шапке, фон заставки растворяется — программа уже под ним
  const logo = document.querySelector(".titlebar-left .brand-logo");
  const from = mark.getBoundingClientRect();
  const to = logo?.getBoundingClientRect();
  if (to && to.width) {
    logo.style.opacity = "0";
    // Масштаб интерфейса (Настройки → Внешний вид) — это zoom на <html>: координаты экрана делим на него,
    // иначе при 90 % плитка не долетала до логотипа.
    const z = parseFloat(document.documentElement.style.zoom || getComputedStyle(document.documentElement).zoom) || 1;
    const dx = (to.left + to.width / 2 - (from.left + from.width / 2)) / z;
    const dy = (to.top + to.height / 2 - (from.top + from.height / 2)) / z;
    const k = to.width / from.width;
    play(root, [{ backgroundColor: "var(--bg)" }, { backgroundColor: "transparent" }], { duration: 380, delay: 80, easing: "ease-out" });
    await play(mark, [{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${k})` }], { duration: 460, easing: "cubic-bezier(.65,0,.35,1)" });
    logo.style.opacity = "";
  } else {
    await play(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 });
  }
}

export function startSplash() {
  const root = document.getElementById("app-splash");
  if (!root || reduce()) { ready = Promise.resolve(); return; }
  build(root);
  const skip = () => { skipped = true; root.getAnimations({ subtree: true }).forEach(a => a.finish()); };
  root.addEventListener("click", skip);
  document.addEventListener("keydown", e => { if (e.key === "Escape") skip(); }, { once: true });
  ready = intro(root).then(() => (skipped ? null : toDots(root))).then(() => {
    if (skipped) return;
    // загрузка затянулась — через пару секунд под точками появится «Загружаем данные…»
    setTimeout(() => { if (wave.length) root.querySelector("[data-status]")?.classList.add("on"); }, 1800);
  });
}

// Вызывается, когда известно, куда вести (программа или вход): доигрываем интро и уводим заставку.
export async function finishSplash() {
  const root = document.getElementById("app-splash");
  if (!root) return;
  await (ready || Promise.resolve());
  if (!reduce() && !skipped && root.classList.contains("sp-run")) await outro(root);
  root.classList.add("hide");
  setTimeout(() => root.remove(), reduce() || skipped ? 350 : 0);
}
