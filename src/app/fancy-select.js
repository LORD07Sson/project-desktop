
const OPEN = new WeakMap();
const SEARCH_MIN = 8;

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
  const searchable = sel.options.length > SEARCH_MIN;
  let q = null;
  if (searchable) {
    pop.classList.add("has-search");
    q = document.createElement("input");
    q.type = "search";
    q.className = "fsel-q";
    q.placeholder = "Найти…";
    q.setAttribute("aria-label", "Найти");
    q.spellcheck = false;
    q.autocomplete = "off";
    pop.appendChild(q);
  }
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
  const cur = pop.querySelector(".fsel-opt.on") || pop.querySelector(".fsel-opt");
  if (q) {
    q.focus({ preventScroll: true });
    q.addEventListener("input", () => {
      const needle = q.value.trim().toLowerCase();
      pop.querySelectorAll(".fsel-opt").forEach((it, i) => {
        it.hidden = !!needle && i > 0 && !it.textContent.toLowerCase().includes(needle);
      });
    });
  } else {
    cur?.focus({ preventScroll: true });
  }
  cur?.scrollIntoView({ block: "nearest" });
  pop.addEventListener("keydown", e => {
    const items = [...pop.querySelectorAll(".fsel-opt:not(:disabled):not([hidden])")];
    const k = items.indexOf(document.activeElement);
    if (e.key === "Enter" && document.activeElement === q) {
      e.preventDefault();
      const needle = q.value.trim();
      (needle ? items.find(it => it !== pop.querySelector(".fsel-opt")) : items[0])?.click();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = k < 0 ? items[e.key === "ArrowDown" ? 0 : items.length - 1] : items[(k + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
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
    btn.style.cssText = sel.style.cssText;
    btn.disabled = sel.disabled;
    btn.innerHTML = `<span class="fsel-label"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
    const sync = () => { btn.querySelector(".fsel-label").textContent = labelOf(sel); };
    sync();
    sel.addEventListener("change", sync);
    const proto = Object.getPrototypeOf(sel);
    const NATIVE_VALUE = Object.getOwnPropertyDescriptor(proto, "value");
    const NATIVE_INDEX = Object.getOwnPropertyDescriptor(proto, "selectedIndex");
    Object.defineProperty(sel, "value", { configurable: true, get() { return NATIVE_VALUE.get.call(this); }, set(v) { NATIVE_VALUE.set.call(this, v); sync(); } });
    Object.defineProperty(sel, "selectedIndex", { configurable: true, get() { return NATIVE_INDEX.get.call(this); }, set(v) { NATIVE_INDEX.set.call(this, v); sync(); } });
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
