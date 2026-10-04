// Фон «Кадр»: за всем интерфейсом — размытая обложка тайтла, с которым
// сейчас работают (на «Обзоре» — самая горячая серия). Два слоя: новая
// картинка сначала грузится, потом плавно проявляется поверх старой,
// без мигания пустым фоном между ними. Выключается в Настройках →
// Внешний вид (data-backdrop="off" на <html>, см. ui-prefs.js).

const host = document.getElementById("app-backdrop");
let front = 0;
let current = "";

// Адрес попадает в CSS url(...) — кавычки, скобки, обратная косая и
// пробелы в нём не нужны и могли бы сломать правило.
const safe = url => !!url && !/["'()\\\s]/.test(url);

// url — основная картинка (баннер тайтла), fallback — запасная (обложка):
// баннера у тайтла может не быть, тогда берём обложку.
export function setBackdrop(url, fallback) {
  const want = [url, fallback].filter(safe);
  if (!host || !want.length || want[0] === current) return;
  current = want[0];
  const tryLoad = i => {
    if (i >= want.length) return;
    const img = new Image();
    img.onload = () => {
      if (current !== want[0]) return; // пока грузилась, попросили другую
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

// Выход из аккаунта: обложки прошлого пользователя за экраном входа
// оставаться не должны.
export function clearBackdrop() {
  current = "";
  host?.querySelectorAll("i").forEach(l => { l.classList.remove("on"); l.style.backgroundImage = ""; });
}
