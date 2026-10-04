// Фон «Кадр»: за всем интерфейсом — размытая обложка тайтла, с которым
// сейчас работают (на «Обзоре» — самая горячая серия). Два слоя: новая
// картинка сначала грузится, потом плавно проявляется поверх старой,
// без мигания пустым фоном между ними. Выключается в Настройках →
// Внешний вид (data-backdrop="off" на <html>, см. ui-prefs.js).

const host = document.getElementById("app-backdrop");
let front = 0;
let current = "";

export function setBackdrop(url) {
  // Адрес попадает в CSS url(...) — кавычки, скобки и переводы строк
  // в нём не нужны и могли бы сломать правило, такие просто пропускаем.
  if (!host || !url || url === current || /["'()\\\s]/.test(url)) return;
  current = url;
  const img = new Image();
  img.onload = () => {
    if (url !== current) return; // пока грузилась, попросили другую
    const layers = host.querySelectorAll("i");
    front ^= 1;
    layers[front].style.backgroundImage = `url("${url}")`;
    layers[front].classList.add("on");
    layers[front ^ 1].classList.remove("on");
  };
  img.src = url;
}

// Выход из аккаунта: обложки прошлого пользователя за экраном входа
// оставаться не должны.
export function clearBackdrop() {
  current = "";
  host?.querySelectorAll("i").forEach(l => { l.classList.remove("on"); l.style.backgroundImage = ""; });
}
