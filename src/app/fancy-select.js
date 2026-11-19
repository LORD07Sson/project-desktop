
const OPEN = new WeakMap();

function labelOf(sel) {
  const o = sel.options[sel.selectedIndex];
  return o ? o.textContent : "";
}

function closeAll() {
  document.querySelectorAll(".fsel-pop").forEach(p => p.remove());
  document.querySelectorAll(".fsel.open").forEach(b => b.classList.remove("open"));
}

function openPop(sel, btn) {
  closeAll();
  const pop = document.createElement("div");
  pop.className = "fsel-pop";
  pop.setAttribute("role", "listbox");
  [...sel.options].forEach((o, i) => {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "fsel-opt" + (i === sel.selectedIndex ? " on" : "");
    it.setAttribute("role", "option");
    it.textContent = o.textContent;
    it.disabled = o.disabled;
    it.addEventListener("click", () => {
      closeAll();
      if (sel.selectedIndex === i) return;
      sel.selectedIndex = i;
      btn.querySelector(".fsel-label").textContent = labelOf(sel);
      sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    pop.appendChild(it);
  });
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.minWidth = `${r.width}px`;
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  const below = window.innerHeight - r.bottom - 8;
  if (below < Math.min(pop.offsetHeight, 240) && r.top > below) {
    pop.style.bottom = `${window.innerHeight - r.top + 6}px`;
    pop.style.maxHeight = `${r.top - 14}px`;
  } else {
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.maxHeight = `${below - 6}px`;
  }
  btn.classList.add("open");
  const cur = pop.querySelector(".on") || pop.firstElementChild;
  cur?.focus({ preventScroll: true });
  cur?.scrollIntoView({ block: "nearest" });
  pop.addEventListener("keydown", e => {
    const items = [...pop.querySelectorAll(".fsel-opt:not(:disabled)")];
    const k = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items[(k + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      n?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      closeAll();
      btn.focus();
    }
  });
}

export function enhanceSelects(root, selector = "select.board-sort") {
  root.querySelectorAll(selector).forEach(sel => {
    if (OPEN.has(sel)) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `fsel ${sel.className}`;
    btn.title = sel.title || "";
    btn.disabled = sel.disabled;
    btn.innerHTML = `<span class="fsel-label"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
    btn.querySelector(".fsel-label").textContent = labelOf(sel);
    btn.addEventListener("click", e => {
      e.stopPropagation();
      if (btn.classList.contains("open")) closeAll(); else openPop(sel, btn);
    });
    btn.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openPop(sel, btn); }
    });
    sel.classList.add("fsel-native");
    sel.after(btn);
    OPEN.set(sel, btn);
  });
}

document.addEventListener("pointerdown", e => {
  if (!e.target.closest?.(".fsel-pop, .fsel")) closeAll();
}, true);
window.addEventListener("resize", closeAll);
document.addEventListener("scroll", e => {
  if (!e.target.closest?.(".fsel-pop")) closeAll();
}, true);
