
const MARK = "clipTitle";
const DEPTH = 3;

function clipped(el) {
  const cs = getComputedStyle(el);
  const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
  if (clamp) return el.scrollHeight > el.clientHeight + 1;
  const oneLine = cs.textOverflow === "ellipsis" || (cs.whiteSpace === "nowrap" && cs.overflowX === "hidden");
  return oneLine && el.scrollWidth > el.clientWidth + 1;
}

document.addEventListener("pointerover", e => {
  let el = e.target && e.target.nodeType === 1 ? e.target : null;
  for (let i = 0; el && i < DEPTH; i++, el = el.parentElement) {
    const own = el.hasAttribute("title") && !el.dataset[MARK];
    if (own) return;
    const cut = clipped(el);
    if (cut) {
      const text = el.innerText.trim().replace(/\s+/g, " ");
      if (text) { el.title = text; el.dataset[MARK] = "1"; }
      return;
    }
    if (el.dataset[MARK]) { el.removeAttribute("title"); delete el.dataset[MARK]; }
  }
}, { passive: true });
