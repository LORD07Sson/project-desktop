// «Антивирус» — проверка ПК, карантин, исключения, обновление баз. Движок — Rust (src-tauri/src/antivirus.rs).
// Базы сигнатур приходят с нашего сервера (свежие хеши вредоносных файлов обновляются раз в час, клиент берёт раз в сутки).
// Защитник Windows остаётся основной защитой системы — здесь его можно обновить и запустить, а наши проверки идут поверх.

import { invoke, listen, sendNotification, pickOutputDir } from "./tauri.js";
import { toast } from "./api.js";
import { esc } from "./utils.js";

const LS_AUTO_UPDATE = "av-auto-update";
const LS_WEEKLY = "av-weekly-scan";
const LS_LAST_UPDATE = "av-last-update";
const DAY = 24 * 3600 * 1000;

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* не критично */ } };

const SEV = { high: ["Опасно", "var(--s-stop)"], medium: ["Подозрительно", "var(--s-fix)"], low: ["Проверьте", "var(--ink-dim)"] };
const KIND_LABEL = { file: "Файл", process: "Запущенный процесс", autorun: "Автозапуск", connection: "Сеть", "defender-exclusion": "Исключение Защитника" };

const fmtDate = secs => secs ? new Date(secs * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtSize = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`;
const fmtDur = s => s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`;

// ---------- фоновые задачи при запуске приложения ----------
export function startAntivirusAuto() {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
  // Поведенческий монитор (Rust) шлёт bh-alert, пока приложение работает: серьёзное — уведомлением и тостом.
  listen("bh-alert", ev => {
    const a = ev.payload || {};
    if (a.severity === "critical" || a.severity === "high") {
      sendNotification({ title: `Антивирус: ${a.title || "подозрительное поведение"}`, body: a.detail || "" });
      toast(`Антивирус: ${a.title}. Откройте Настройки → Антивирус → Поведение.`, "error");
    }
  }).catch(() => {});
  setTimeout(async () => {
    try {
      if (lsGet(LS_AUTO_UPDATE, "1") === "1" && Date.now() - Number(lsGet(LS_LAST_UPDATE, "0")) > DAY) {
        await invoke("av_update_signatures");
        lsSet(LS_LAST_UPDATE, String(Date.now()));
      }
      if (lsGet(LS_WEEKLY, "1") === "1") {
        const st = await invoke("av_status");
        const last = st && st.last_scan && st.last_scan.finished ? st.last_scan.finished * 1000 : 0;
        if (Date.now() - last > 7 * DAY) {
          const report = await invoke("av_scan", { mode: "quick" });
          const found = (report.detections || []).length;
          if (found) {
            sendNotification({ title: "Антивирус: найдены угрозы", body: `Найдено: ${found}. Откройте Настройки → Антивирус.` });
            toast(`Антивирус: найдено ${found}. Откройте Настройки → Антивирус.`, "error");
          }
        }
      }
    } catch (_) { /* тихо: без сети или вне Tauri проверка просто не запустится */ }
  }, 60_000);
}

// ---------- экран ----------
export async function mountAntivirus(root) {
  if (!root) return;
  let tab = "results";
  let report = null;
  let busy = false;
  let unlisten = null;

  const call = (cmd, args) => invoke(cmd, args);

  async function refreshHeader() {
    const [st, def] = await Promise.all([call("av_status").catch(() => null), call("av_defender", { action: "status" }).catch(() => null)]);
    const host = root.querySelector("#av-head");
    if (!host) return;
    const last = st && st.last_scan && st.last_scan.finished ? `${fmtDate(st.last_scan.finished)} · проверено ${st.last_scan.scanned}, найдено ${st.last_scan.found}` : "ещё не проверяли";
    const defOn = def && def.AntivirusEnabled;
    host.innerHTML = `
      <div class="av-card"><span class="av-k">Базы сигнатур</span>
        <b>${st ? `v${st.version}` : "—"}</b>
        <span>${st ? `${st.hashes.toLocaleString("ru-RU")} хешей · ${st.rules} правил` : ""}<br>${st ? esc(st.updated || "") : ""}</span>
        <button class="btn" id="av-update">Обновить базы</button></div>
      <div class="av-card"><span class="av-k">Защитник Windows</span>
        <b style="color:${def ? (defOn ? "var(--s-done)" : "var(--s-stop)") : "var(--ink-dim)"}">${def ? (defOn ? "включён" : "выключен") : "нет данных"}</b>
        <span>${def ? `защита в реальном времени: ${def.RealTimeProtectionEnabled ? "да" : "нет"}` : "доступен только в Windows"}</span>
        <div style="display:flex; gap:6px; flex-wrap:wrap;"><button class="btn" id="av-def-update">Обновить</button><button class="btn" id="av-def-scan">Проверить</button></div></div>
      <div class="av-card"><span class="av-k">Последняя проверка</span><b>${st && st.last_scan ? "готово" : "—"}</b><span>${esc(last)}</span>
        <span>Карантин: ${st ? st.quarantine : 0}</span></div>`;
    root.querySelector("#av-update").addEventListener("click", updateDb);
    root.querySelector("#av-def-update").addEventListener("click", () => defender("update"));
    root.querySelector("#av-def-scan").addEventListener("click", () => defender("quickscan"));
    const q = root.querySelector('[data-av-tab="quarantine"] small');
    if (q && st) q.textContent = st.quarantine;
  }

  async function updateDb() {
    const btn = root.querySelector("#av-update");
    btn.disabled = true; btn.textContent = "Обновляю…";
    try {
      const r = await call("av_update_signatures");
      lsSet(LS_LAST_UPDATE, String(Date.now()));
      toast(r.updated ? `Базы обновлены: ${r.hashes.toLocaleString("ru-RU")} хешей.` : "Базы уже последние.", "success");
    } catch (e) { toast(String(e), "error"); }
    await refreshHeader();
  }

  async function defender(action) {
    const btn = root.querySelector(action === "update" ? "#av-def-update" : "#av-def-scan");
    btn.disabled = true; btn.textContent = action === "update" ? "Обновляю…" : "Проверяет…";
    try {
      const r = await call("av_defender", { action });
      if (action === "update") toast(r.ok ? "Базы Защитника обновлены." : `Защитник: ${r.message || "не удалось"}`, r.ok ? "success" : "error");
      else if (r && r.ok === false) toast(`Защитник: ${r.message || "не удалось"}`, "error");
      else toast(r && r.threats && (Array.isArray(r.threats) ? r.threats.length : 1) ? "Защитник сообщил об угрозах — смотрите «Безопасность Windows»." : "Защитник: угроз не найдено.", "success");
    } catch (e) { toast(String(e), "error"); }
    await refreshHeader();
  }

  function setBusy(on) {
    busy = on;
    root.querySelectorAll("[data-av-scan]").forEach(b => { b.disabled = on; });
    const stop = root.querySelector("#av-stop");
    if (stop) stop.hidden = !on;
    root.querySelector("#av-progress").hidden = !on;
  }

  async function scan(mode, paths) {
    if (busy) return;
    setBusy(true);
    report = null;
    paintBody();
    try {
      report = await call("av_scan", { mode, paths: paths || null });
      if (report.cancelled) toast("Проверка остановлена.", "success");
      else toast(report.detections.length ? `Проверка завершена: найдено ${report.detections.length}.` : "Проверка завершена: угроз не найдено.", report.detections.length ? "error" : "success");
    } catch (e) { toast(String(e), "error"); }
    setBusy(false);
    tab = "results";
    paintBody();
    refreshHeader();
  }

  function detectionRow(d, i) {
    const [sevText, sevColor] = SEV[d.severity] || SEV.low;
    const actions = [];
    if ((d.kind === "file" || d.kind === "process" || d.kind === "autorun") && d.path) actions.push(`<button class="btn danger" data-act="quarantine" data-i="${i}">В карантин</button>`);
    if (d.kind === "process" && d.pid && !d.path) actions.push(`<button class="btn danger" data-act="kill" data-i="${i}">Завершить процесс</button>`);
    if (d.kind === "connection" && d.pid) actions.push(`<button class="btn danger" data-act="kill" data-i="${i}">Завершить процесс</button>`);
    if (d.kind === "autorun" && d.extra && d.extra.value) actions.push(`<button class="btn" data-act="autorun" data-i="${i}">Убрать из автозапуска</button>`);
    if (d.kind === "defender-exclusion") actions.push(`<button class="btn danger" data-act="defex" data-i="${i}">Убрать исключение</button>`);
    actions.push(`<button class="btn" data-act="exclude" data-i="${i}">Исключить</button>`);
    return `
      <div class="bc-chat av-row" data-row="${i}">
        <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;">
          <span class="av-sev" style="--c:${sevColor}">${sevText}</span>
          <b style="flex:1; min-width:200px;">${esc(d.title)}</b>
          <span class="bc-hint" style="margin:0;">${esc(KIND_LABEL[d.kind] || d.kind)}${d.pid ? ` · PID ${d.pid}` : ""}</span>
        </div>
        <div class="bc-hint" style="margin:4px 0 0;">${esc(d.detail)}</div>
        ${d.path ? `<div class="av-path">${esc(d.path)}</div>` : ""}
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">${actions.join("")}</div>
      </div>`;
  }

  async function onAction(btn) {
    const d = report.detections[Number(btn.dataset.i)];
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === "quarantine") {
        if (!confirm(`Отправить в карантин?\n\n${d.path}\n\nЕсли файл запущен, процесс будет завершён. Из карантина файл можно восстановить.`)) { btn.disabled = false; return; }
        await call("av_quarantine", { path: d.path, pid: d.pid || null, label: (d.extra && d.extra.label) || d.title });
        toast("Файл в карантине.", "success");
      } else if (act === "kill") {
        if (!confirm(`Завершить процесс (PID ${d.pid})?`)) { btn.disabled = false; return; }
        await call("av_kill", { pid: d.pid });
        toast("Процесс завершён.", "success");
      } else if (act === "autorun") {
        await call("av_remove_autorun", { hive: d.extra.hive, value: d.extra.value });
        toast("Запись автозапуска убрана.", "success");
      } else if (act === "defex") {
        await call("av_remove_defender_exclusion", { path: d.extra.exclusion });
        toast("Исключение Защитника убрано.", "success");
      } else if (act === "exclude") {
        if (!confirm("Исключить из проверок? Этот файл больше не будет считаться угрозой.")) { btn.disabled = false; return; }
        await call("av_exclude", { path: d.path || null, sha256: d.sha256 || null });
        toast("Добавлено в исключения.", "success");
      }
      report.detections.splice(Number(btn.dataset.i), 1);
      paintBody();
      refreshHeader();
    } catch (e) { toast(String(e), "error"); btn.disabled = false; }
  }

  async function paintBody() {
    const host = root.querySelector("#av-body");
    root.querySelectorAll("[data-av-tab]").forEach(b => b.classList.toggle("on", b.dataset.avTab === tab));
    if (tab === "results") {
      if (!report) { host.innerHTML = `<div class="no-assignee">${busy ? "Идёт проверка…" : "Запустите проверку — результаты появятся здесь."}</div>`; return; }
      host.innerHTML = `
        <div class="bc-hint" style="margin:0 0 8px;">Проверено объектов: <b>${report.scanned.toLocaleString("ru-RU")}</b> за ${fmtDur(report.seconds)} · база v${report.db_version}${report.cancelled ? " · <b>остановлено</b>" : ""}</div>
        ${report.coverage ? `<details class="av-cover"><summary>Что именно проверено</summary>
          <div class="bc-hint" style="margin:6px 0;">Файлов: <b>${report.coverage.files.toLocaleString("ru-RU")}</b> · процессов: <b>${report.coverage.processes}</b> · папок: <b>${report.coverage.folders.toLocaleString("ru-RU")}</b>.
            Пропущено: файлов больше 300 МБ — ${report.coverage.skipped_large} (проверены только по имени), папок без доступа — ${report.coverage.denied_dirs}.<br>
            Типы файлов: ${report.coverage.types.map(t => `.${esc(t)}`).join(" ")}. Проверяются также запущенные процессы, сетевые соединения, автозапуск и исключения Защитника.</div>
          <div class="av-path">${report.coverage.roots.map(esc).join("<br>")}</div>
          ${report.mode === "quick" ? `<div class="bc-hint" style="margin:6px 0 0;">Быстрая проверка смотрит места, где оседают вирусы. Чтобы пройти все диски целиком, запустите «Полную проверку».</div>` : ""}
        </details>` : ""}
        ${report.detections.length ? report.detections.map(detectionRow).join("") : `<div class="av-clean">Угроз не найдено</div>`}`;
      host.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => onAction(b)));
    } else if (tab === "quarantine") {
      const items = await call("av_quarantine_list").catch(() => []);
      host.innerHTML = items.length ? `<p class="bc-hint">Файлы в карантине не запускаются. «Восстановить» вернёт файл на место, «Удалить» сотрёт навсегда.</p>` + items.map(q => `
        <div class="bc-chat av-row">
          <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;"><b style="flex:1; min-width:200px;">${esc(q.name)}</b><span class="bc-hint" style="margin:0;">${esc(q.label || "")} · ${fmtSize(q.size)} · ${fmtDate(q.at)}</span></div>
          <div class="av-path">${esc(q.original)}</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
            <button class="btn" data-q="restore" data-id="${esc(q.id)}">Восстановить</button>
            <button class="btn" data-q="restore-ex" data-id="${esc(q.id)}">Восстановить и исключить</button>
            <button class="btn danger" data-q="delete" data-id="${esc(q.id)}">Удалить навсегда</button>
          </div></div>`).join("") : `<div class="no-assignee">Карантин пуст.</div>`;
      host.querySelectorAll("[data-q]").forEach(b => b.addEventListener("click", async () => {
        const id = b.dataset.id, kind = b.dataset.q;
        try {
          if (kind === "delete") { if (!confirm("Удалить файл навсегда? Вернуть его будет нельзя.")) return; await call("av_quarantine_delete", { id }); toast("Удалено.", "success"); }
          else { if (!confirm("Вернуть файл на прежнее место? Он снова сможет запускаться.")) return; await call("av_quarantine_restore", { id, exclude: kind === "restore-ex" }); toast("Файл восстановлен.", "success"); }
          paintBody(); refreshHeader();
        } catch (e) { toast(String(e), "error"); }
      }));
    } else if (tab === "behavior") {
      const [st, alerts] = await Promise.all([call("bh_status").catch(() => null), call("bh_alerts").catch(() => [])]);
      const badge = root.querySelector('[data-av-tab="behavior"] small');
      if (badge) badge.textContent = alerts.length || "";
      host.innerHTML = `
        <div class="bc-chat">
          <label class="bc-feature"><input type="checkbox" id="bh-on" ${st && st.enabled ? "checked" : ""}><span><b>Поведенческая защита</b> — следит за запущенными программами, пока работает приложение</span></label>
          <p class="bc-hint" style="margin:6px 0 0;">Предупреждает о майнерах (долгая нагрузка у программы без подписи, соединения на порты пулов), запуске неподписанных программ из временных папок, приёмах вирусов (PowerShell -enc, certutil, mshta), вредоносных документах, новых записях автозапуска и признаках шифровальщика.
            Ничего не блокирует сама: решение — за вами. ${st && st.running ? "Сейчас работает." : "Сейчас выключена."}</p>
        </div>
        ${alerts.length ? `<div style="display:flex; justify-content:flex-end; margin:8px 0;"><button class="btn" id="bh-clear">Очистить список</button></div>` + alerts.map((a, i) => {
          const [sevText, sevColor] = a.severity === "critical" ? ["Критично", "var(--s-stop)"] : (SEV[a.severity] || SEV.low);
          return `<div class="bc-chat av-row">
            <div style="display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;"><span class="av-sev" style="--c:${sevColor}">${sevText}</span><b style="flex:1; min-width:200px;">${esc(a.title)}</b><span class="bc-hint" style="margin:0;">${fmtDate(a.at)}${a.pid ? ` · PID ${a.pid}` : ""}</span></div>
            <div class="bc-hint" style="margin:4px 0 0;">${esc(a.detail)}</div>
            ${a.path ? `<div class="av-path">${esc(a.path)}</div>` : ""}
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
              ${a.pid ? `<button class="btn danger" data-bh="kill" data-i="${i}">Завершить процесс</button>` : ""}
              ${a.path && a.rule !== "ransomware" ? `<button class="btn" data-bh="quarantine" data-i="${i}">В карантин</button>` : ""}
              ${(a.path || a.name) && a.rule !== "ransomware" ? `<button class="btn" data-bh="trust" data-i="${i}">Доверять</button>` : ""}
              <button class="btn" data-bh="dismiss" data-i="${i}">Скрыть</button>
            </div></div>`;
        }).join("") : `<div class="av-clean" style="margin-top:10px;">Подозрительного поведения не замечено</div>`}
        ${st && st.trusted && st.trusted.length ? `<h4 style="margin:16px 0 6px;">Доверенные</h4>` + st.trusted.map(t => `<div class="bc-chat av-row" style="display:flex; gap:10px; align-items:center;"><span class="av-path" style="flex:1; margin:0;">${esc(t)}</span><button class="btn" data-bh-untrust="${esc(t)}">Убрать</button></div>`).join("") : ""}`;
      host.querySelector("#bh-on").addEventListener("change", async e => { await call("bh_set_enabled", { enabled: e.target.checked }); setTimeout(paintBody, 400); });
      host.querySelector("#bh-clear")?.addEventListener("click", async () => { await call("bh_dismiss", { id: null }); paintBody(); });
      host.querySelectorAll("[data-bh-untrust]").forEach(b => b.addEventListener("click", async () => { await call("bh_untrust", { value: b.dataset.bhUntrust }); paintBody(); }));
      host.querySelectorAll("[data-bh]").forEach(b => b.addEventListener("click", async () => {
        const a = alerts[Number(b.dataset.i)];
        try {
          if (b.dataset.bh === "kill") { if (!confirm(`Завершить процесс «${a.name}» (PID ${a.pid})?`)) return; await call("av_kill", { pid: a.pid }); toast("Процесс завершён.", "success"); }
          else if (b.dataset.bh === "quarantine") { if (!confirm(`Отправить в карантин?

${a.path}`)) return; await call("av_quarantine", { path: a.path, pid: a.pid || null, label: a.title }); toast("Файл в карантине.", "success"); }
          else if (b.dataset.bh === "trust") { if (!confirm("Доверять этой программе? Поведенческая защита перестанет следить за ней.")) return; await call("bh_trust", { path: a.path || null, name: a.name || null }); toast("Добавлено в доверенные.", "success"); }
          await call("bh_dismiss", { id: a.id });
          paintBody(); refreshHeader();
        } catch (e) { toast(String(e), "error"); }
      }));
    } else {
      const ex = await call("av_exclusions").catch(() => ({ paths: [], hashes: [] }));
      const all = [...ex.paths.map(v => ["Путь", v]), ...ex.hashes.map(v => ["Хеш", v])];
      host.innerHTML = all.length ? `<p class="bc-hint">Из исключений проверка файлы не считает угрозой. Уберите запись, чтобы они снова проверялись.</p>` + all.map(([k, v]) => `
        <div class="bc-chat av-row" style="display:flex; gap:10px; align-items:center;"><span class="bc-hint" style="margin:0; width:44px;">${k}</span><span class="av-path" style="flex:1; margin:0;">${esc(v)}</span><button class="btn" data-ex="${esc(v)}">Убрать</button></div>`).join("") : `<div class="no-assignee">Исключений нет.</div>`;
      host.querySelectorAll("[data-ex]").forEach(b => b.addEventListener("click", async () => { await call("av_exclusion_remove", { value: b.dataset.ex }); paintBody(); }));
    }
  }

  root.innerHTML = `
    <p class="bc-hint">Проверка ПК: вредоносные файлы по базе хешей (обновляется с нашего сервера), майнеры и хакерские утилиты, подозрительный автозапуск и исключения Защитника Windows.
      Найденное можно отправить в карантин, удалить или исключить. Ничего не удаляется без вашего действия; системные файлы и сама программа защищены.
      Это дополнение к Защитнику Windows, а не его замена.</p>
    <div id="av-head" class="av-head"><div class="no-assignee">Загружаю…</div></div>
    <div class="av-actions">
      <button class="btn primary" data-av-scan="quick">Быстрая проверка</button>
      <button class="btn" data-av-scan="full">Полная проверка</button>
      <button class="btn" data-av-scan="custom">Проверить папку…</button>
      <button class="btn danger" id="av-stop" hidden>Остановить</button>
    </div>
    <div id="av-progress" class="av-progress" hidden><div class="av-bar"><i></i></div><div id="av-prog-text" class="bc-hint" style="margin:6px 0 0;"></div></div>
    <div class="av-tabs">
      <button class="av-tab on" data-av-tab="results">Результаты</button>
      <button class="av-tab" data-av-tab="quarantine">Карантин <small></small></button>
      <button class="av-tab" data-av-tab="behavior">Поведение <small></small></button>
      <button class="av-tab" data-av-tab="exclusions">Исключения</button>
    </div>
    <div id="av-body"></div>
    <div class="bc-chat" style="margin-top:14px;">
      <label class="bc-feature"><input type="checkbox" id="av-auto" ${lsGet(LS_AUTO_UPDATE, "1") === "1" ? "checked" : ""}><span>Обновлять базы автоматически (раз в сутки)</span></label>
      <label class="bc-feature"><input type="checkbox" id="av-weekly" ${lsGet(LS_WEEKLY, "1") === "1" ? "checked" : ""}><span>Быстрая проверка раз в неделю при запуске (скажет, только если что-то найдёт)</span></label>
    </div>`;

  root.querySelectorAll("[data-av-scan]").forEach(b => b.addEventListener("click", async () => {
    const mode = b.dataset.avScan;
    if (mode === "full" && !confirm("Полная проверка просматривает профиль пользователя и Program Files — это может занять от нескольких минут до часа. Продолжить?")) return;
    if (mode === "custom") {
      const dir = await pickOutputDir();
      if (!dir) return;
      scan("custom", [dir]);
    } else scan(mode);
  }));
  root.querySelector("#av-stop").addEventListener("click", () => { call("av_cancel"); });
  root.querySelectorAll("[data-av-tab]").forEach(b => b.addEventListener("click", () => { tab = b.dataset.avTab; paintBody(); }));
  root.querySelector("#av-auto").addEventListener("change", e => lsSet(LS_AUTO_UPDATE, e.target.checked ? "1" : "0"));
  root.querySelector("#av-weekly").addEventListener("change", e => lsSet(LS_WEEKLY, e.target.checked ? "1" : "0"));

  try {
    unlisten = await listen("av-progress", ev => {
      const p = ev.payload || {};
      const t = root.querySelector("#av-prog-text");
      if (t) t.textContent = `${p.stage || ""} · проверено ${Number(p.scanned || 0).toLocaleString("ru-RU")} · найдено ${p.found || 0}${p.current ? ` · ${p.current}` : ""}`;
    });
  } catch (_) { /* вне Tauri событий нет */ }
  new MutationObserver((_m, obs) => { if (!root.isConnected) { if (unlisten) unlisten(); obs.disconnect(); } }).observe(document.body, { childList: true, subtree: true });

  paintBody();
  refreshHeader();
}
