
const reduce = () => typeof window.Element?.prototype.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function cell(ch) {
  const c = document.createElement("span");
  c.className = /\d/.test(ch) ? "rd-c rd-d" : "rd-c";
  const g = document.createElement("span");
  g.className = "rd-g";
  g.textContent = ch;
  c.append(g);
  return c;
}

function rollCell(c, ch) {
  const old = c.lastElementChild;
  const next = document.createElement("span");
  next.className = "rd-g";
  next.textContent = ch;
  c.append(next);
  if (reduce()) { old?.remove(); return; }
  old?.animate([{ transform: "translateY(0)" }, { transform: "translateY(-115%)" }], { duration: 115, easing: "cubic-bezier(.55,0,.9,.4)", fill: "forwards" })
    .finished.then(() => old.remove(), () => old.remove());
  next.animate([
    { transform: "translateY(115%)", offset: 0 },
    { transform: "translateY(-3%)", offset: .38 },
    { transform: "translateY(1%)", offset: .62 },
    { transform: "translateY(0)", offset: 1 },
  ], { duration: 520, delay: 50, easing: "cubic-bezier(.2,.75,.3,1)", fill: "backwards" });
}

export function rollText(el, text) {
  if (!el) return;
  const s = String(text);
  if (el.dataset.roll !== "1" || el.childElementCount !== s.length) {
    el.dataset.roll = "1";
    el.classList.add("rd");
    el.replaceChildren(...[...s].map(cell));
    el.setAttribute("aria-label", s);
    return;
  }
  [...s].forEach((ch, i) => {
    const c = el.children[i];
    if (c.lastElementChild?.textContent !== ch) rollCell(c, ch);
  });
  el.setAttribute("aria-label", s);
}
