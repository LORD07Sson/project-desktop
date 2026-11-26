// Character art behind a tile; several characters → a slow crossfade slideshow.

const SLIDE_MS = 5000;
let timer = null;

/** Background layers for a tile. urls: ready-to-use image urls (already proxied), first one shown first. */
export function artSlidesHtml(urls) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return "";
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "%27").replace(/</g, "&lt;");
  startArtSlides();
  return `<span class="art-slides" aria-hidden="true">${list.map((u, i) => `<i${i ? "" : ` class="on"`} style="background-image:url('${esc(u)}')"></i>`).join("")}</span>`;
}

function step() {
  if (document.hidden) return;
  document.querySelectorAll(".art-slides").forEach(box => {
    const slides = box.children;
    if (slides.length < 2) return;
    const cur = [...slides].findIndex(s => s.classList.contains("on"));
    slides[cur < 0 ? 0 : cur].classList.remove("on");
    slides[(cur + 1) % slides.length].classList.add("on");
  });
}

function startArtSlides() {
  if (timer || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  timer = setInterval(step, SLIDE_MS);
}
