// «Завод» — вкладка Автоматизации в виде производственных линий (как схема в Satisfactory): машины, конвейеры, индикаторы.
// По конвейерам бегут «ящики», пока машина работает и есть что везти; на каждой машине — кнопки Пуск/Стоп и переход в её настройки.
// Данные: GET /api/automation/overview (с блоком flow), включение — POST /api/archive | /reports-archive | /docs-archive {enabled}.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const fmtLimit = v => (v ? `${v} Мбит/с` : "без лимита");
const fmtGb = n => `${(n / 1024 ** 3).toFixed(1)} ГБ`;

// Состояние машины: off — выключена, run — работает, idle — включена, но очередь пуста, pause — пауза, err — ошибки
function led(on, paused, queue, failed) {
  if (failed) return "err";
  if (!on) return "off";
  if (paused) return "pause";
  return queue > 0 ? "run" : "idle";
}
const LED_LABEL = { off: "Выключена", run: "Работает", idle: "Ждёт работу", pause: "Пауза", err: "Есть ошибки" };

function machine(m) {
  const k = m.led || "idle";
  return `
  <div class="fc-machine" data-led="${k}">
    <div class="fc-m-head"><i class="fc-led"></i><b>${esc(m.title)}</b></div>
    <div class="fc-m-body">
      <div class="fc-count">${m.count ?? "—"}</div>
      <div class="fc-sub">${esc(m.unit || "")}</div>
    </div>
    <div class="fc-m-lines">${(m.lines || []).map(l => `<span>${esc(l)}</span>`).join("")}</div>
    <div class="fc-m-foot">
      <span class="fc-state">${LED_LABEL[k]}</span>
      ${m.toggle ? `<button type="button" class="fc-btn ${m.on ? "stop" : "go"}" data-fc-toggle="${m.toggle}" data-on="${m.on ? 1 : 0}">${m.on ? "Стоп" : "Пуск"}</button>` : ""}
      ${m.tab ? `<button type="button" class="fc-btn" data-fc-go="${m.tab}" title="Настройки машины">⚙</button>` : ""}
    </div>
  </div>`;
}

const belt = (active, load = 1) => `<div class="fc-belt${active ? " on" : ""}" style="--fc-speed:${Math.max(0.8, 3 - load * 0.4)}s"><span></span><span></span><span></span></div>`;

function line(title, sub, machines, belts) {
  return `
  <section class="fc-line">
    <header><h4>${esc(title)}</h4><span>${esc(sub)}</span></header>
    <div class="fc-row">
      ${machines.map((m, i) => machine(m) + (i < machines.length - 1 ? belt(belts[i], m.count || 1) : "")).join("")}
    </div>
  </section>`;
}

export function mountFactory(root, go) {
  let timer = null;
  let busy = false;

  const draw = d => {
    const f = d.flow || { torrents: 0, assembling: 0, local_videos: 0, topics: {} };
    const a = d.archive, r = d.reports, c = d.docs, s = d.speed;
    const backbone = Math.max(s.archive || 0, s.torrent || 0);
    const diskUsed = d.disk_free;

    const lineSeries = [
      { title: "Канал-источник", count: "TG", unit: "новые серии", lines: ["Бот ловит посты сам"], led: a.enabled ? "run" : "off", tab: "archive" },
      { title: "Очередь серий", count: a.queue, unit: "ждёт заливки", lines: [a.held ? `Ждут решения: ${a.held}` : "Порядок по сериям"], led: led(a.enabled, a.paused, a.queue, 0), tab: "archive" },
      { title: "Заливка в архив", count: a.limit || "∞", unit: a.limit ? "Мбит/с" : "без лимита", lines: [s.night_now ? "Ночной режим" : "Обычный режим"], led: led(a.enabled, a.paused, a.queue, 0), toggle: "archive", on: a.enabled, tab: "speed" },
      { title: "Архивная группа", count: f.topics.archive || 0, unit: "тем тайтлов", lines: ["Тема на каждый тайтл"], led: a.enabled ? "idle" : "off", tab: "archive" },
    ];
    const lineReports = [
      { title: "Завершённые отчёты", count: r.queue + r.done, unit: "прошли / ждут", lines: ["Фильтры по статусам"], led: r.enabled ? "run" : "off", tab: "reports" },
      { title: "Очередь переноса", count: r.queue, unit: "ждёт срока", lines: [r.paused ? "Пауза общего архива" : "По одному за раз"], led: led(r.enabled, r.paused, r.queue, r.failed), tab: "reports" },
      { title: "Карточка в тему", count: r.done, unit: "перенесено", lines: [r.failed ? `Ошибок: ${r.failed}` : "Ошибок нет"], led: led(r.enabled, r.paused, r.queue, r.failed), toggle: "reports", on: r.enabled, tab: "reports" },
      { title: "Группа отчётов", count: f.topics.reports || 0, unit: "тем тайтлов", lines: ["Заметки, авторы, файлы"], led: r.enabled ? "idle" : "off", tab: "reports" },
    ];
    const lineDocs = [
      { title: "Файлы отчётов", count: c.queue + c.done, unit: "всего", lines: ["Файлы, субтитры, звук, торренты"], led: c.enabled ? "run" : "off", tab: "docs" },
      { title: "Очередь файлов", count: c.queue, unit: "ждёт отправки", lines: [c.paused ? "На паузе" : "Пачками раз в минуту"], led: led(c.enabled, c.paused, c.queue, c.failed), tab: "docs" },
      { title: "Отправка", count: c.done, unit: "отправлено", lines: [c.failed ? `Ошибок: ${c.failed}` : "Ошибок нет", f.local_videos ? `Видео на диске: ${f.local_videos}` : "Диск чист"], led: led(c.enabled, c.paused, c.queue, c.failed), toggle: "docs", on: c.enabled, tab: "docs" },
      { title: "Группа документов", count: f.topics.docs || 0, unit: "тем тайтлов", lines: ["Тема «Документы · тайтл»"], led: c.enabled ? "idle" : "off", tab: "docs" },
    ];
    const lineProd = [
      { title: "Nyaa / торренты", count: f.torrents, unit: "качает сервер", lines: [`Лимит: ${fmtLimit(s.torrent)}`], led: f.torrents ? "run" : "idle", tab: "speed" },
      { title: "Диск сервера", count: f.local_videos, unit: "видео лежит", lines: [`Свободно ${fmtGb(diskUsed)}`], led: diskUsed < 5 * 1024 ** 3 ? "err" : f.local_videos ? "run" : "idle", tab: "logs" },
      { title: "Сборка финала", count: f.assembling, unit: "рендерится", lines: ["Очередь по одному"], led: f.assembling ? "run" : "idle" },
      { title: "Готовый финал", count: "TG", unit: "в отчёт и пост", lines: ["Черновик поста — по кнопке"], led: "idle" },
    ];

    root.innerHTML = `
    <div class="fc">
      <div class="fc-trunk">
        <div class="fc-trunk-title"><b>Магистраль канала</b><span>Хостинг режет канал выше ~50 Мбит/с</span></div>
        <div class="fc-gauge"><i style="width:${Math.min(100, backbone / 50 * 100)}%"></i><em>${backbone ? `лимиты до ${backbone} Мбит/с${s.total ? ` · общий потолок ${s.total}` : ""}` : "лимитов нет"}</em></div>
        <div class="fc-trunk-sub">${s.night_now ? "🌙 ночной режим" : "☀ обычный режим"} · Свободно на складе (диск): ${fmtGb(d.disk_free)}</div>
      </div>
      ${line("Линия 1 · Серии → архив", "Новые серии из канала ложатся в темы архивной группы", lineSeries, [a.enabled && a.queue > 0, a.enabled && !a.paused && a.queue > 0, a.enabled])}
      ${line("Линия 2 · Отчёты → архив", "Завершённые отчёты уезжают карточкой в тему своего тайтла", lineReports, [r.enabled, r.enabled && r.queue > 0 && !r.paused, r.enabled && r.done > 0])}
      ${line("Линия 3 · Документы → архив", "Файлы отчётов копируются в группу (с диска — настоящей заливкой)", lineDocs, [c.enabled, c.enabled && c.queue > 0 && !c.paused, c.enabled])}
      ${line("Линия 4 · Производство финала", "Раздача → сервер → сборка → отчёт и пост", lineProd, [f.torrents > 0, f.assembling > 0 || f.local_videos > 0, f.assembling > 0])}
      ${d.problems.length ? `<div class="fc-alarm"><b>⚠ Нужно внимание</b>${d.problems.map(p => `<button type="button" data-fc-go="${p.tab}">${esc(p.text)}</button>`).join("")}</div>` : ""}
    </div>`;

    root.querySelectorAll("[data-fc-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.fcGo)));
    root.querySelectorAll("[data-fc-toggle]").forEach(b => b.addEventListener("click", async () => {
      const path = { archive: "/archive", reports: "/reports-archive", docs: "/docs-archive" }[b.dataset.fcToggle];
      b.disabled = true;
      try {
        await apiPost(path, { enabled: b.dataset.on !== "1" });
        toast(b.dataset.on === "1" ? "Машина остановлена." : "Машина запущена.", "success");
        await refresh();
      } catch (e) { toast(`Не получилось: ${e.message}`, "error"); b.disabled = false; }
    }));
  };

  const refresh = async () => {
    if (busy || !root.isConnected) { if (!root.isConnected) clearInterval(timer); return; }
    busy = true;
    try { draw(await apiGet("/automation/overview")); }
    catch (e) { if (!root.querySelector(".fc")) root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; }
    finally { busy = false; }
  };
  root.innerHTML = `<div class="no-assignee">Запускаю линии…</div>`;
  refresh();
  timer = setInterval(refresh, 6000);
}
