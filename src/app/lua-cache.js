// «Lua и другие» (Настройки → Автоматизация): кэш загрузок LuaTools в Telegram. Скачанное с lua.tools (lua/zip,
// DLC, Denuvo-фиксы и их манифесты) бот кладёт в архивную группу, в тему «lua и другие»; следующий участник берёт
// свежую копию оттуда. Сервер: GET/POST /api/lua-cache {enabled?, target?, ttl_days?, delete? (key), expire? (key)}.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const mb = n => (!n ? "0 КБ" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const when = ts => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export async function mountLuaCache(root) {
  let d;
  const save = async (patch, quiet) => {
    try { d = await apiPost("/lua-cache", patch); if (!quiet) toast("Сохранено", "ok"); render(); }
    catch (e) { toast(e.message, "error"); }
  };
  const load = async () => {
    try { d = await apiGet("/lua-cache"); render(); }
    catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; }
  };
  const render = () => {
    const effective = d.target || d.docs_target;
    const fallback = d.chats.find(c => String(c.chat_id) === String(d.docs_target));
    const stat = (n, label) => `<div class="ar-card" style="padding:12px 16px;"><b style="font-size:22px;">${n}</b><div class="ar-meta">${label}</div></div>`;
    root.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px;">
        ${stat(d.stats.entries, "файлов в кэше")}${stat(mb(d.stats.bytes), "объём")}${stat(d.stats.hits, "загрузок из кэша")}
      </div>
      <div class="ar-card" style="margin-top:12px;">
        <div class="ar-card-head"><h4>Кэш LuaTools в Telegram</h4>
          <label class="ar-switch"><input type="checkbox" id="lc-enabled" ${d.enabled ? "checked" : ""}><i></i></label></div>
        <p class="ar-meta">Тема в группе: «${esc(d.topic_name)}». ${effective ? "" : '<b style="color:var(--danger,#ff6b6b);">Группа не выбрана — кэш не пополняется.</b>'}</p>
        <label class="ar-meta">Группа</label>
        <select id="lc-target" class="field-input ar-select">
          <option value=""${d.target ? "" : " selected"}>Как у архива документов${fallback ? ` (${esc(fallback.title)})` : ""}</option>
          ${d.chats.map(c => `<option value="${c.chat_id}"${String(c.chat_id) === String(d.target) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""} (${c.chat_id})</option>`).join("")}
        </select>
        <label class="ar-meta" style="display:block; margin-top:10px;">Копия свежая, дней (старше — качается заново с lua.tools; если файл не изменился, в Telegram заново не заливается)</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <input id="lc-ttl" class="field-input" type="number" min="1" max="365" step="1" value="${d.ttl_days}" style="max-width:90px;">
          <button class="btn" id="lc-ttl-save">Сохранить</button>
          <button class="btn" id="lc-refresh" style="margin-left:auto;">Обновить</button>
        </div>
      </div>
      <div class="ar-card" style="margin-top:12px;">
        <div class="ar-card-head"><h4>Файлы</h4></div>
        ${d.items.length ? d.items.map(i => `
          <div class="ar-row" style="display:flex; gap:10px; align-items:center; justify-content:space-between; padding:6px 0; border-top:1px solid var(--line,rgba(127,127,127,.15));">
            <div style="min-width:0;">
              <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(i.label || i.name)}</div>
              <div class="ar-meta">${esc(i.name)} · ${mb(i.size)} · сверено ${when(i.checked_at)} · из кэша ${i.hits}× · ${i.fresh ? "свежий" : '<span style="color:var(--warn,#e0a030);">устарел</span>'}</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              ${i.fresh ? `<button class="btn" data-lc-expire="${esc(i.key)}" title="Следующая загрузка пойдёт с lua.tools">Устарел</button>` : ""}
              <button class="btn" data-lc-del="${esc(i.key)}">Удалить</button>
            </div>
          </div>`).join("") : '<p class="ar-meta">Пока пусто: файлы появятся после первых загрузок в LuaTools.</p>'}
      </div>`;
    root.querySelector("#lc-enabled").addEventListener("change", e => save({ enabled: e.target.checked }));
    root.querySelector("#lc-target").addEventListener("change", e => save({ target: e.target.value }));
    root.querySelector("#lc-ttl-save").addEventListener("click", () => save({ ttl_days: Number(root.querySelector("#lc-ttl").value) }));
    root.querySelector("#lc-refresh").addEventListener("click", load);
    root.querySelectorAll("[data-lc-del]").forEach(b => b.addEventListener("click", () => save({ delete: b.dataset.lcDel }, true)));
    root.querySelectorAll("[data-lc-expire]").forEach(b => b.addEventListener("click", () => save({ expire: b.dataset.lcExpire }, true)));
  };
  await load();
}
