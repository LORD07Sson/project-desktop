// Download button animation: press → a progress ring grows out of the button and fills clockwise
// from the top → the ring folds back, the arrow blurs into a green check with sparkles → back to the arrow.
const R = 15.5;
const LEN = 2 * Math.PI * R;
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12.5l3.6 3.6 7.4-8.2"/></svg>`;

export function dlButton(btn) {
  if (!btn || !btn.isConnected) return { progress() {}, done() {} };
  clearTimeout(btn._dlT);
  btn.querySelectorAll(".dlb-ring, .dlb-ok").forEach(n => n.remove());
  btn.classList.remove("dlb-ok-on", "dlb-err", "dlb-back");
  btn.insertAdjacentHTML("beforeend", `<svg class="dlb-ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="t" cx="18" cy="18" r="${R}"/><circle class="a" cx="18" cy="18" r="${R}" style="stroke-dasharray:${LEN.toFixed(2)};stroke-dashoffset:${LEN.toFixed(2)}"/></svg><span class="dlb-ok" aria-hidden="true">${CHECK}</span>`);
  const arc = btn.querySelector(".dlb-ring .a");
  btn.classList.add("dlb", "dlb-run", "dlb-indet");
  btn.setAttribute("aria-busy", "true");
  let last = 0;
  const setP = p => {
    last = Math.max(last, Math.min(1, p));
    arc.style.strokeDashoffset = (LEN * (1 - last)).toFixed(2);
  };
  return {
    progress(p) {
      if (p == null || !Number.isFinite(p)) return;
      btn.classList.remove("dlb-indet");
      setP(p);
    },
    done(ok) {
      btn.removeAttribute("aria-busy");
      btn.classList.remove("dlb-indet");
      if (!ok) {
        btn.classList.remove("dlb-run");
        btn.classList.add("dlb-err");
        btn._dlT = setTimeout(() => {
          btn.classList.remove("dlb", "dlb-err");
          btn.querySelectorAll(".dlb-ring, .dlb-ok").forEach(n => n.remove());
        }, 700);
        return;
      }
      setP(1);
      // the full ring shows for a beat, then folds and the arrow turns into the check
      btn._dlT = setTimeout(() => {
        btn.classList.remove("dlb-run");
        btn.classList.add("dlb-ok-on");
        btn._dlT = setTimeout(() => {
          btn.classList.add("dlb-back");
          btn._dlT = setTimeout(() => {
            btn.classList.remove("dlb", "dlb-ok-on", "dlb-back");
            btn.querySelectorAll(".dlb-ring, .dlb-ok").forEach(n => n.remove());
          }, 260);
        }, 1500);
      }, 220);
    },
  };
}
