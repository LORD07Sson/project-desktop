
const host = document.getElementById("app-backdrop");
let front = 0;
let current = "";

const safe = url => !!url && !/["'()\\\s]/.test(url);

export function setBackdrop(url, fallback) {
  const want = [url, fallback].filter(safe);
  if (!host || !want.length || want[0] === current) return;
  current = want[0];
  const tryLoad = i => {
    if (i >= want.length) return;
    const img = new Image();
    img.onload = () => {
      if (current !== want[0]) return;
      const layers = host.querySelectorAll("i");
      front ^= 1;
      layers[front].style.backgroundImage = `url("${want[i]}")`;
      layers[front].classList.add("on");
      layers[front ^ 1].classList.remove("on");
    };
    img.onerror = () => tryLoad(i + 1);
    img.src = want[i];
  };
  tryLoad(0);
}

export function clearBackdrop() {
  current = "";
  host?.querySelectorAll("i").forEach(l => { l.classList.remove("on"); l.style.backgroundImage = ""; });
}
