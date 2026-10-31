// Обрезанный текст («Безжалостная леди Ния Ли…») — полностью в подсказке при наведении.
// Раньше подсказку ставил каждый экран сам, и на «Доске», в «Тайтлах», «Календаре», «Чате» и «Релизах»
// её не было: длинное название так и оставалось недочитанным. Один делегированный обработчик на document:
// при наведении ищем у цели и пары предков обрезку (многоточие или line-clamp) и ставим title, если своего нет.
// Помеченный нами title снимаем, когда текст снова влезает (окно растянули, колонку расширили).

const MARK = "clipTitle";
const DEPTH = 3;

function clipped(el) {
  const cs = getComputedStyle(el);
  const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
  // text-overflow по умолчанию «clip» у всех — считаем обрезкой только строку в одну линию со скрытым хвостом.
  // Многоточие в паре с line-clamp (заголовок карточки «Доски») режет по высоте, а не по ширине.
  if (clamp) return el.scrollHeight > el.clientHeight + 1;
  const oneLine = cs.textOverflow === "ellipsis" || (cs.whiteSpace === "nowrap" && cs.overflowX === "hidden");
  return oneLine && el.scrollWidth > el.clientWidth + 1;
}

document.addEventListener("pointerover", e => {
  let el = e.target && e.target.nodeType === 1 ? e.target : null;
  for (let i = 0; el && i < DEPTH; i++, el = el.parentElement) {
    const own = el.hasAttribute("title") && !el.dataset[MARK];
    if (own) return; // у элемента своя подсказка — она точнее нашей
    const cut = clipped(el);
    if (cut) {
      const text = el.innerText.trim().replace(/\s+/g, " ");
      if (text) { el.title = text; el.dataset[MARK] = "1"; }
      return;
    }
    if (el.dataset[MARK]) { el.removeAttribute("title"); delete el.dataset[MARK]; }
  }
}, { passive: true });
