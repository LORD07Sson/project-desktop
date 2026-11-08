// Nyaa/игры, вынесено из nyaa.js: торрент-клиент.
import { invoke } from "./tauri.js";
import { track } from "./telemetry.js";
import { toast } from "./api.js";
import { $, esc } from "./utils.js";
import { magnetLink, CLIENT_NAMES, CLIENT_PORTS } from "./nyaa-core.js";
import { ICONS, attachVideoToReport, client, clientDraft, markSent, paintList, reportTarget, touch } from "./nyaa.js";

// ---------- торрент-клиент ----------
export function paintClientLabel() {
  const l = $("#ny-client-lbl");
  if (l) l.textContent = client ? CLIENT_NAMES[client.kind] || "Торрент-клиент" : "Торрент-клиент";
}

function clientHtml(msg = "") {
  const c = clientDraft || client || { kind: "qbittorrent", url: "", user: "", category: "", tags: "", paused: false, has_pass: false };
  const hasPass = client && client.kind === c.kind && client.user === c.user && client.has_pass;
  return `
    <div class="ny-src-head"><div><b>Торрент-клиент</b><span>Отправка magnet в ваш клиент через его веб-интерфейс. Пароль хранится в защищённом хранилище Windows.</span></div>
      <div><button type="button" class="ny-ib wide" data-close-panel title="Закрыть" aria-label="Закрыть">${ICONS.close}</button></div></div>
    <div class="ny-f-grid">
      <label class="ny-fld"><span>Клиент</span><select data-c="kind">${Object.entries(CLIENT_NAMES).map(([k, n]) => `<option value="${k}" ${c.kind === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="ny-fld"><span>Адрес веб-интерфейса</span><input type="text" data-c="url" value="${esc(c.url)}" placeholder="http://127.0.0.1:${CLIENT_PORTS[c.kind]}" spellcheck="false"></label>
      <label class="ny-fld"><span>Логин</span><input type="text" data-c="user" value="${esc(c.user)}" spellcheck="false" autocomplete="off"></label>
      <label class="ny-fld"><span>Пароль</span><input type="password" data-c="pass" value="" placeholder="${hasPass ? "сохранён — оставьте пустым" : "пароль"}" autocomplete="new-password"></label>
      ${c.kind === "qbittorrent" ? `<label class="ny-fld"><span>Категория (необязательно)</span><input type="text" data-c="category" value="${esc(c.category)}"></label><label class="ny-fld"><span>Теги (через запятую)</span><input type="text" data-c="tags" value="${esc(c.tags)}"></label>` : ""}
      <label class="ny-chk wide-row"><input type="checkbox" data-c="paused" ${c.paused ? "checked" : ""}> Добавлять на паузе</label>
    </div>
    <div class="ny-f-presets"><button type="button" class="btn" data-client-test>Проверить</button><button type="button" class="btn primary" data-client-save>Сохранить</button>${client ? `<button type="button" class="btn ghost" data-client-clear>Забыть клиент</button>` : ""}<span class="ny-client-msg" id="ny-client-msg">${esc(msg)}</span></div>`;
}

export function readClientForm() {
  const g = k => document.querySelector(`#ny-client [data-c="${k}"]`);
  return {
    kind: g("kind").value, url: g("url").value.trim(), user: g("user").value.trim(), pass: g("pass").value,
    category: g("category") ? g("category").value.trim() : "", tags: g("tags") ? g("tags").value.trim() : "",
    paused: g("paused").checked,
  };
}

export function paintClient(msg = "") {
  const box = $("#ny-client");
  if (!box || box.hidden) return;
  box.innerHTML = clientHtml(msg);
}

export function openPanel(id) {
  ["ny-sources", "ny-client", "ny-monitors", "ny-library"].forEach(x => { const el = $(`#${x}`); if (el) el.hidden = x !== id; });
  const box = $(`#${id}`);
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Magnet в торрент-клиенте, назначенном в системе по умолчанию: настраивать Web UI не нужно.
export async function openInSystemClient(list) {
  const magnets = list.map(magnetLink).filter(Boolean).slice(0, 10);
  if (!magnets.length) { toast("У раздачи нет magnet-ссылки.", "error"); return; }
  let ok = 0;
  for (const m of magnets) {
    try { await invoke("open_magnet", { magnet: m }); ok++; }
    catch (e) { toast(String(e && e.message ? e.message : e), "error"); break; }
  }
  if (ok) { list.forEach(i => touch(i.id)); markSent(list.slice(0, ok)); paintList(); toast(`Открыто в системном клиенте: ${ok}.`, "success"); }
  if (list.length > magnets.length) toast("За один раз открывается не больше 10 раздач.");
}

export async function sendToClient(list) {
  if (!client) {
    toast("Свой клиент не настроен — открываю в системном торрент-клиенте.");
    openInSystemClient(list); return;
  }
  const magnets = list.map(magnetLink).filter(Boolean);
  if (!magnets.length) { toast("У раздачи нет magnet-ссылки.", "error"); return; }
  track("action", "nyaa.send_client", reportTarget ? reportTarget.publicId : "");
  try {
    const n = await invoke("tc_add", { magnets });
    list.forEach(i => touch(i.id));
    markSent(list); paintList();
    toast(`Отправлено в ${CLIENT_NAMES[client.kind]}: ${n}.`, "success",
      reportTarget ? { label: "Прикрепить видео к отчёту", onClick: attachVideoToReport } : null);
  } catch (e) { toast(`Не удалось отправить: ${e}`, "error"); }
}

