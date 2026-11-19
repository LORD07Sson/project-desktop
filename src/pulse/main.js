
import { startPulse } from "./pulse.js";
import { applyTheme, installColorMap } from "./theme.js";
import { showTeam } from "./team.js";

let started = false;

function savedView() {
  try { return sessionStorage.getItem("pulse-view") || "map"; } catch (_) { return "map"; }
}
function setView(view) {
  try { sessionStorage.setItem("pulse-view", view); } catch (_) { }
  window.location.reload();
}

function showEmpty(text) {
  const wrap = document.querySelector("#wrap");
  wrap.innerHTML = `<div class="pl-empty"><b>Пульс пока пуст</b>${text}</div>`;
}

window.addEventListener("message", ev => {
  if (ev.origin !== window.location.origin || ev.source !== window.parent) return;
  const msg = ev.data;
  if (!msg || msg.source !== "app" || started) return;
  if (msg.type === "pulse-error") { started = true; applyTheme(msg.theme); showEmpty(String(msg.text || "Не удалось загрузить данные.")); return; }
  if (msg.type !== "pulse-data" || !msg.data) return;
  started = true;
  const data = msg.data;
  applyTheme(msg.theme);
  installColorMap(msg.theme);
  const month = new Date(`${data.today}T00:00:00`).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  const live = document.querySelector("#liveTxt");
  if (live) live.textContent = `${month} · с сериями: ${data.people.length}`;
  const hasTeam = !!(data.team && data.team.people && data.team.people.length);
  if (!data.titles.length || (hasTeam && savedView() === "team")) {
    if (hasTeam) showTeam(document.querySelector("#wrap"), data, { onMap: data.titles.length ? () => setView("map") : null });
    else showEmpty("Когда появятся серии в работе, здесь будет живая карта студии.");
    return;
  }
  document.querySelector("#teamBtn")?.addEventListener("click", () => setView("team"));
  if (!hasTeam) document.querySelector("#teamBtn")?.remove();
  startPulse(data);
});

window.parent.postMessage({ source: "pulse", type: "ready" }, window.location.origin);
