// Start-up cover. The animated intro was removed: the cover is just the app background (styles.css
// .app-splash) that stays until the first screen is drawn and its images have loaded, then fades out.

export function startSplash() {}

// Wait for the images on screen and the award-card upgrade (capped), so the app never shows half-drawn.
async function contentReady(cap = 1500) {
  const limit = Date.now() + cap;
  const pending = () => [...document.images].filter(img => {
    if (img.complete || img.closest("#app-splash")) return false;
    const r = img.getBoundingClientRect();
    return r.width && r.height && r.bottom > 0 && r.top < window.innerHeight;
  });
  // Let the first render and the award-card upgrade start before measuring.
  await new Promise(r => setTimeout(r, 120));
  while (Date.now() < limit && (pending().length || document.querySelector(".pf-badges[data-ac-wait]"))) {
    await new Promise(r => setTimeout(r, 60));
  }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

export async function finishSplash() {
  const root = document.getElementById("app-splash");
  if (!root) return;
  await contentReady();
  root.classList.add("hide");
  setTimeout(() => root.remove(), 350);
}
