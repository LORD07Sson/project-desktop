// «VPN помощник» → управление панелью X-UI: клиенты, inbound'ы,
// сертификаты, сервер (Xray, логи, бэкапы). Сервер — xui_helper.py
// (/api/dev/vpn/*, только владелец, каждое действие пишется в журнал
// разработчика). Здесь только интерфейс: разрушающие действия
// спрашивают подтверждение, долгие (выпуск сертификата) показывают
// ход, ошибки панели выводятся как есть.

import { apiGet, apiPost, openSheet, dismissSheet, toast } from "./api.js";
import { esc, relTime } from "./utils.js";

let data = null;      // /dev/vpn/manage
let filter = { q: "", inbound: "" };
let busy = false;

const GB = 1024 ** 3;
const fmtBytes = n => n >= GB ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} ГБ` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(0)} МБ` : `${Math.round((n || 0) / 1024)} КБ`;
const daysLeft = ms => ms > 0 ? Math.ceil((ms - Date.now()) / 86400000) : null;
const fmtExpiry = ms => {
  const d = daysLeft(ms);
  if (d == null) return "без срока";
  return d < 0 ? `истёк ${-d} дн. назад` : d === 0 ? "истекает сегодня" : `ещё ${d} дн.`;
};
const iso = ms => new Date(ms).toISOString();

async function guarded(btn, fn) {
  if (busy) return;
  busy = true;
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message || "Ошибка", "error"); }
  finally { busy = false; if (btn) btn.disabled = false; }
}

function confirmAction(text, okLabel = "Да", danger = false) {
  return new Promise(resolve => {
    const o = openSheet(`
      <h2>Подтверждение</h2>
      <p class="vm-confirm">${esc(text)}</p>
      <div class="sheet-actions">
        <button class="btn" data-no>Отмена</button>
        <button class="btn ${danger ? "danger" : "primary"}" data-yes>${esc(okLabel)}</button>
      </div>`);
    const done = v => { dismissSheet(o); resolve(v); };
    o.querySelector("[data-no]").addEventListener("click", () => done(false));
    o.querySelector("[data-yes]").addEventListener("click", () => done(true));
    o.addEventListener("sheet-dismissed", () => resolve(false));
  });
}

async function copy(text, ok = "Скопировано.") {
  try { await navigator.clipboard.writeText(text); toast(ok); } catch (_) { toast("Не удалось скопировать.", "error"); }
}

async function load(force = false) {
  data = await apiGet("/dev/vpn/manage", force ? { force: 1 } : undefined);
  return data;
}

// ---------- клиенты ----------

function clientRow(c, i) {
  const used = (c.up || 0) + (c.down || 0);
  const pct = c.total ? Math.min(100, Math.round(used / c.total * 100)) : 0;
  const d = daysLeft(c.expiry);
  const dead = (c.total && used >= c.total) || (d != null && d < 0);
  const tone = !c.enable ? "off" : dead ? "bad" : c.online ? "ok" : "idle";
  const tag = !c.enable ? "выключен" : dead ? "исчерпан" : c.online ? "онлайн" : (c.last_online ? `был ${relTime(iso(c.last_online))}` : "не подключался");
  return `
    <div class="vm-row" data-i="${i}" style="animation-delay:${Math.min(i, 12) * 20}ms">
      <span class="vm-dot ${tone}"></span>
      <div class="vm-main">
        <div class="vm-name">${esc(c.email)} <span class="vm-chip">${esc(c.inbound)}</span></div>
        <div class="vm-sub">${esc(tag)} · ${esc(fmtExpiry(c.expiry))}${c.comment ? ` · ${esc(c.comment)}` : ""}</div>
        <div class="vm-bar${c.total ? "" : " free"}" title="${c.total ? `${pct}%` : "без лимита"}"><i style="width:${c.total ? pct : 100}%"></i></div>
      </div>
      <div class="vm-num"><b>${fmtBytes(used)}</b><span>${c.total ? `из ${fmtBytes(c.total)}` : "без лимита"}</span></div>
      <div class="vm-acts">
        <button class="icon-btn" data-act="link" title="Ссылка для подключения">Ссылка</button>
        <button class="icon-btn" data-act="edit" title="Лимит и срок">Изменить</button>
        <button class="icon-btn" data-act="toggle">${c.enable ? "Выключить" : "Включить"}</button>
        <button class="icon-btn" data-act="reset" title="Обнулить счётчик трафика">Сброс</button>
        <button class="icon-btn danger" data-act="del">Удалить</button>
      </div>
    </div>`;
}

function filteredClients() {
  const q = filter.q.trim().toLowerCase();
  return data.clients.filter(c =>
    (!filter.inbound || String(c.inbound_id) === filter.inbound) &&
    (!q || c.email.toLowerCase().includes(q) || c.comment.toLowerCase().includes(q)));
}

function clientsHtml() {
  const cl = data.clients;
  const expired = cl.filter(c => { const d = daysLeft(c.expiry); return (d != null && d < 0) || (c.total && c.up + c.down >= c.total); }).length;
  const soon = cl.filter(c => { const d = daysLeft(c.expiry); return d != null && d >= 0 && d <= 3; }).length;
  const traffic = cl.reduce((a, c) => a + c.up + c.down, 0);
  const stats = [
    ["Клиентов", cl.length, `выключено ${cl.filter(c => !c.enable).length}`],
    ["Онлайн", data.online_count, "прямо сейчас"],
    ["Скоро истекут", soon, `уже истекло ${expired}`],
    ["Трафик", fmtBytes(traffic), "за всё время"],
  ].map(([l, v, s]) => `<div class="bcell kpi-cell"><h3>${l}</h3><div class="svc-stat"><span class="big-num">${esc(String(v))}</span><span>${esc(s)}</span></div></div>`).join("");
  const list = filteredClients();
  return `
    <div class="an-metrics">${stats}</div>
    <div class="vm-toolbar">
      <input class="field-input vm-search" id="vm-q" placeholder="Поиск по имени или заметке" value="${esc(filter.q)}">
      <select class="field-input vm-sel" id="vm-ib"><option value="">Все inbound'ы</option>${data.inbounds.map(ib => `<option value="${ib.id}" ${String(ib.id) === filter.inbound ? "selected" : ""}>${esc(ib.remark || ib.id)}</option>`).join("")}</select>
      <button class="btn primary" id="vm-add">Добавить клиента</button>
    </div>
    <div class="bcell vm-list" id="vm-clients">${list.length ? list.map(clientRow).join("") : `<div class="bento-empty">${cl.length ? "По фильтру никого нет." : "Клиентов пока нет."}</div>`}</div>`;
}

function addClientSheet() {
  const ibs = data.inbounds.filter(i => i.can_add);
  if (!ibs.length) { toast("Нет inbound'ов vless/vmess/trojan для добавления.", "error"); return; }
  const o = openSheet(`
    <h2>Новый клиент</h2>
    <div class="vm-form">
      <label>Inbound<select class="field-input" id="nc-ib">${ibs.map(i => `<option value="${i.id}">${esc(i.remark || i.id)} · ${esc(i.protocol)}:${i.port}</option>`).join("")}</select></label>
      <label>Имя<input class="field-input" id="nc-email" placeholder="например, ivan" maxlength="64" autocomplete="off"></label>
      <div class="vm-two">
        <label>Лимит, ГБ<input class="field-input" id="nc-gb" type="number" min="0" step="1" placeholder="0 — без лимита"></label>
        <label>Срок, дней<input class="field-input" id="nc-days" type="number" min="0" step="1" placeholder="0 — бессрочно"></label>
      </div>
      <div class="vm-two">
        <label>Лимит устройств<input class="field-input" id="nc-ip" type="number" min="0" step="1" placeholder="0 — без лимита"></label>
        <label>Заметка<input class="field-input" id="nc-comment" maxlength="120"></label>
      </div>
    </div>
    <div class="sheet-actions"><button class="btn" data-no>Отмена</button><button class="btn primary" id="nc-save">Создать</button></div>`);
  o.querySelector("[data-no]").addEventListener("click", () => dismissSheet(o));
  o.querySelector("#nc-save").addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    const r = await apiPost("/dev/vpn/client/add", {
      inbound_id: +o.querySelector("#nc-ib").value, email: o.querySelector("#nc-email").value.trim(),
      limit_gb: o.querySelector("#nc-gb").value, expire_days: o.querySelector("#nc-days").value,
      limit_ip: o.querySelector("#nc-ip").value, comment: o.querySelector("#nc-comment").value,
    });
    dismissSheet(o);
    toast(`Клиент ${r.email} создан.`);
    await refresh(true);
    const c = data.clients.find(x => x.email === r.email && x.key === r.key);
    if (c) showLink(c);
  }));
}

function editClientSheet(c) {
  const used = c.up + c.down;
  const o = openSheet(`
    <h2>${esc(c.email)}</h2>
    <p class="vm-sub">Использовано ${esc(fmtBytes(used))}. Срок считается от сегодняшнего дня.</p>
    <div class="vm-form">
      <div class="vm-two">
        <label>Лимит, ГБ<input class="field-input" id="ec-gb" type="number" min="0" step="1" value="${c.total ? Math.round(c.total / GB * 100) / 100 : 0}"></label>
        <label>Срок, дней от сегодня<input class="field-input" id="ec-days" type="number" min="0" step="1" value="${Math.max(0, daysLeft(c.expiry) ?? 0)}"></label>
      </div>
      <div class="vm-two">
        <label>Лимит устройств<input class="field-input" id="ec-ip" type="number" min="0" step="1" value="${c.limit_ip}"></label>
        <label>Заметка<input class="field-input" id="ec-comment" maxlength="120" value="${esc(c.comment)}"></label>
      </div>
      <p class="vm-sub">0 — без лимита / бессрочно.</p>
    </div>
    <div class="sheet-actions"><button class="btn" data-no>Отмена</button><button class="btn primary" id="ec-save">Сохранить</button></div>`);
  o.querySelector("[data-no]").addEventListener("click", () => dismissSheet(o));
  o.querySelector("#ec-save").addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    await apiPost("/dev/vpn/client/update", {
      inbound_id: c.inbound_id, key: c.key, limit_gb: o.querySelector("#ec-gb").value,
      expire_days: o.querySelector("#ec-days").value, limit_ip: o.querySelector("#ec-ip").value,
      comment: o.querySelector("#ec-comment").value,
    });
    dismissSheet(o);
    toast("Сохранено.");
    await refresh(true);
  }));
}

async function showLink(c) {
  const r = await apiPost("/dev/vpn/client/link", { inbound_id: c.inbound_id, key: c.key });
  const o = openSheet(`
    <h2>Подключение: ${esc(c.email)}</h2>
    <p class="vm-sub">Ссылка для приложения-клиента (v2rayN, Hiddify, Streisand…). Не публикуйте её — по ней любой сможет пользоваться VPN.</p>
    <textarea class="field-textarea vm-link" readonly rows="4">${esc(r.link)}</textarea>
    ${r.sub ? `<p class="vm-sub">Подписка (обновляется сама):</p><textarea class="field-textarea vm-link" readonly rows="2">${esc(r.sub)}</textarea>` : ""}
    <div class="sheet-actions"><button class="btn" data-no>Закрыть</button>${r.sub ? `<button class="btn" id="lk-sub">Копировать подписку</button>` : ""}<button class="btn primary" id="lk-copy">Копировать ссылку</button></div>`);
  o.querySelector("[data-no]").addEventListener("click", () => dismissSheet(o));
  o.querySelector("#lk-copy").addEventListener("click", () => copy(r.link));
  o.querySelector("#lk-sub")?.addEventListener("click", () => copy(r.sub));
}

function wireClients(root) {
  root.querySelector("#vm-q")?.addEventListener("input", e => {
    filter.q = e.target.value;
    const box = root.querySelector("#vm-clients");
    const list = filteredClients();
    box.innerHTML = list.length ? list.map(clientRow).join("") : `<div class="bento-empty">По фильтру никого нет.</div>`;
  });
  root.querySelector("#vm-ib")?.addEventListener("change", e => { filter.inbound = e.target.value; rerender(); });
  root.querySelector("#vm-add")?.addEventListener("click", addClientSheet);
  root.querySelector("#vm-clients")?.addEventListener("click", ev => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const c = filteredClients()[+btn.closest(".vm-row").dataset.i];
    if (!c) return;
    const act = btn.dataset.act;
    if (act === "edit") return editClientSheet(c);
    guarded(btn, async () => {
      if (act === "link") return showLink(c);
      if (act === "toggle") {
        await apiPost("/dev/vpn/client/update", { inbound_id: c.inbound_id, key: c.key, enable: !c.enable });
        toast(c.enable ? "Клиент выключен." : "Клиент включён.");
      } else if (act === "reset") {
        if (!await confirmAction(`Обнулить счётчик трафика у «${c.email}»? Лимит начнёт считаться заново.`, "Обнулить")) return;
        await apiPost("/dev/vpn/client/reset", { inbound_id: c.inbound_id, email: c.email });
        toast("Трафик обнулён.");
      } else if (act === "del") {
        if (!await confirmAction(`Удалить клиента «${c.email}»? Его ссылка перестанет работать, вернуть её нельзя.`, "Удалить", true)) return;
        await apiPost("/dev/vpn/client/delete", { inbound_id: c.inbound_id, key: c.key });
        toast("Клиент удалён.");
      }
      await refresh(true);
    });
  });
}

// ---------- inbound'ы ----------

function inboundsHtml() {
  return `<div class="bcell vm-list">${data.inbounds.map((ib, i) => `
    <div class="vm-row" data-i="${i}">
      <span class="vm-dot ${ib.enable ? "ok" : "off"}"></span>
      <div class="vm-main">
        <div class="vm-name">${esc(ib.remark || `inbound ${ib.id}`)} <span class="vm-chip">${esc(ib.protocol)}:${ib.port}</span></div>
        <div class="vm-sub">клиентов ${ib.clients} · ↑ ${fmtBytes(ib.up)} · ↓ ${fmtBytes(ib.down)}</div>
      </div>
      <div class="vm-acts">
        <button class="icon-btn" data-act="toggle">${ib.enable ? "Выключить" : "Включить"}</button>
        <button class="icon-btn" data-act="reset" title="Обнулить трафик всех клиентов">Сброс трафика</button>
        <button class="icon-btn" data-act="purge" title="Удалить клиентов с исчерпанным лимитом или сроком">Убрать исчерпавших</button>
      </div>
    </div>`).join("") || `<div class="bento-empty">Inbound'ов нет.</div>`}</div>`;
}

function wireInbounds(root) {
  root.querySelector(".vm-list")?.addEventListener("click", ev => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const ib = data.inbounds[+btn.closest(".vm-row").dataset.i];
    guarded(btn, async () => {
      const act = btn.dataset.act;
      if (act === "toggle") {
        const off = ib.enable;
        if (off && !await confirmAction(`Выключить «${ib.remark}»? Все его клиенты потеряют связь, пока он выключен.`, "Выключить", true)) return;
        await apiPost("/dev/vpn/inbound/toggle", { inbound_id: ib.id, enable: !ib.enable });
        toast(off ? "Inbound выключен." : "Inbound включён.");
      } else if (act === "reset") {
        if (!await confirmAction(`Обнулить счётчики трафика у всех клиентов «${ib.remark}»?`, "Обнулить")) return;
        await apiPost("/dev/vpn/inbound/reset", { inbound_id: ib.id });
        toast("Счётчики обнулены.");
      } else if (act === "purge") {
        if (!await confirmAction(`Удалить из «${ib.remark}» всех клиентов, у кого закончился трафик или срок?`, "Удалить", true)) return;
        await apiPost("/dev/vpn/inbound/purge", { inbound_id: ib.id });
        toast("Исчерпавшие клиенты удалены.");
      }
      await refresh(true);
    });
  });
}

// ---------- сертификаты ----------

function certBadge(d) {
  if (d == null) return `<span class="vm-chip bad">не прочитан</span>`;
  const cls = d < 0 ? "bad" : d < 10 ? "warn" : "ok";
  return `<span class="vm-chip ${cls}">${d < 0 ? `истёк ${-d} дн. назад` : `${d} дн.`}</span>`;
}

async function certsHtml() {
  const st = await apiGet("/dev/vpn/certs");
  const need = st.certs.some(c => c.days_left != null && c.days_left < 10) && !st.auto_renew;
  return `
    ${st.standalone?.length ? `<div class="bcell vpn-warn">Сертификат ${esc(st.standalone.join(", "))} выпущен в режиме standalone: продлению нужен свободный порт 80, а его занимает nginx, поэтому авто-продление не срабатывает. Нажмите «Проверить и продлить сейчас» — приложение переведёт его на проверку через nginx и продлит.</div>` : ""}
    ${need ? `<div class="bcell vpn-warn">Сертификат скоро истекает, а авто-продление выключено. Нажмите «Включить авто-продление».</div>` : ""}
    <div class="bcell vm-list">
      <h3>Сертификаты на сервере</h3>
      ${st.certs.map(c => `
        <div class="vm-row">
          <span class="vm-dot ${c.days_left == null ? "off" : c.days_left < 10 ? "bad" : "ok"}"></span>
          <div class="vm-main">
            <div class="vm-name">${esc(c.domain || c.path.split("/").slice(-2, -1)[0] || "—")} ${certBadge(c.days_left)}</div>
            <div class="vm-sub">${esc(c.issuer || "")} · ${esc(c.path)}</div>
            <div class="vm-sub">${c.used_by.length ? `Используют: ${esc(c.used_by.join(", "))}` : "Никем не используется"}</div>
          </div>
          <div class="vm-acts">${c.domain ? `<button class="icon-btn" data-apply="${esc(c.domain)}">Назначить inbound'у</button>` : ""}</div>
        </div>`).join("") || `<div class="bento-empty">Сертификатов нет.</div>`}
    </div>
    <div class="bcell">
      <h3>Выпустить новый (Let's Encrypt)</h3>
      <p class="vm-sub">Домен должен указывать A-записью на этот сервер. Проверка идёт через nginx (${esc(st.webroot)}${st.webroot_ok ? "" : " — каталога нет!"}); порты 80 и 443 освобождать не нужно.</p>
      <div class="vm-toolbar">
        <input class="field-input vm-search" id="cert-domain" placeholder="vpn.example.com" autocomplete="off">
        <button class="btn primary" id="cert-issue" ${st.acme_installed ? "" : "disabled"}>Выпустить</button>
      </div>
      <div class="vm-note" id="cert-out" hidden></div>
    </div>
    <div class="bcell">
      <h3>Авто-продление</h3>
      <p class="vm-sub">${st.acme_installed ? (st.auto_renew ? "Включено: acme.sh проверяет сертификаты 4 раза в сутки и продлевает те, что подходят к концу." : "Выключено: сертификаты придётся продлевать вручную.") : "acme.sh на сервере не найден."}</p>
      <div class="vm-toolbar">
        ${st.auto_renew ? "" : `<button class="btn primary" id="cert-auto" ${st.acme_installed ? "" : "disabled"}>Включить авто-продление</button>`}
        <button class="btn" id="cert-renew" ${st.acme_installed ? "" : "disabled"}>Проверить и продлить сейчас</button>
      </div>
    </div>`;
}

function applyCertSheet(domain) {
  const ibs = data.inbounds;
  const o = openSheet(`
    <h2>Назначить сертификат</h2>
    <p class="vm-sub">${esc(domain)} будет записан в TLS-настройки выбранного inbound'а, Xray перезапустится (соединения прервутся на пару секунд).</p>
    <div class="vm-form"><label>Inbound<select class="field-input" id="ac-ib">${ibs.map(i => `<option value="${i.id}">${esc(i.remark || i.id)} · ${esc(i.protocol)}:${i.port}</option>`).join("")}</select></label></div>
    <div class="sheet-actions"><button class="btn" data-no>Отмена</button><button class="btn primary" id="ac-ok">Назначить</button></div>`);
  o.querySelector("[data-no]").addEventListener("click", () => dismissSheet(o));
  o.querySelector("#ac-ok").addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    await apiPost("/dev/vpn/certs/apply", { domain, inbound_id: +o.querySelector("#ac-ib").value });
    dismissSheet(o);
    toast("Сертификат назначен, Xray перезапущен.");
    rerender();
  }));
}

function wireCerts(root) {
  const out = root.querySelector("#cert-out");
  const show = (text, bad) => { if (!out) return; out.hidden = false; out.classList.toggle("bad", !!bad); out.textContent = text; };
  root.querySelector("#cert-issue")?.addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    const domain = root.querySelector("#cert-domain").value.trim();
    if (!domain) { toast("Введите домен.", "error"); return; }
    show("Выпускаю… это занимает до минуты.");
    try {
      const r = await apiPost("/dev/vpn/certs/issue", { domain });
      toast("Сертификат выпущен.");
      show(`Готово: ${r.cert}${r.cron_added ? "\nАвто-продление включено." : ""}\nТеперь назначьте его inbound'у кнопкой в списке.`);
      rerender();
    } catch (e) { show(e.message, true); }
  }));
  root.querySelector("#cert-auto")?.addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    await apiPost("/dev/vpn/certs/auto");
    toast("Авто-продление включено.");
    rerender();
  }));
  root.querySelector("#cert-renew")?.addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    show("Проверяю…");
    const r = await apiPost("/dev/vpn/certs/renew");
    show(r.tail || "Готово.", !r.ok);
  }));
  root.querySelectorAll("[data-apply]").forEach(b => b.addEventListener("click", () => applyCertSheet(b.dataset.apply)));
}

// ---------- сервер ----------

async function serverHtml() {
  const bk = await apiGet("/dev/vpn/backups");
  return `
    <div class="vm-grid">
      <div class="bcell">
        <h3>Xray</h3>
        <p class="vm-sub">Перезапуск прерывает все соединения на пару секунд. Нужен после правок, которые панель не применила сама.</p>
        <div class="vm-toolbar"><button class="btn" id="sv-restart">Перезапустить Xray</button><button class="btn" id="sv-geo">Обновить geo-файлы</button></div>
      </div>
      <div class="bcell">
        <h3>Бэкап базы X-UI</h3>
        <p class="vm-sub">Копия лежит на сервере в ${esc(bk.dir)} (хранятся последние 14). В ней все клиенты и настройки.</p>
        <div class="vm-toolbar"><button class="btn primary" id="sv-backup">Сделать бэкап</button></div>
        <div class="vm-sub">${bk.items.length ? bk.items.map(b => `${esc(b.name)} · ${fmtBytes(b.size)}`).join("<br>") : "Бэкапов пока нет."}</div>
      </div>
    </div>
    <div class="bcell">
      <h3>Логи</h3>
      <div class="vm-toolbar">
        <select class="field-input vm-sel" id="lg-kind"><option value="xray">Xray (подключения)</option><option value="panel">Панель X-UI</option></select>
        <select class="field-input vm-sel" id="lg-n"><option>100</option><option>300</option><option>500</option></select>
        <input class="field-input vm-search" id="lg-q" placeholder="Фильтр по тексту">
        <button class="btn" id="lg-load">Загрузить</button>
      </div>
      <pre class="vm-log" id="lg-out">Нажмите «Загрузить».</pre>
    </div>`;
}

function wireServer(root) {
  root.querySelector("#sv-restart")?.addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    if (!await confirmAction("Перезапустить Xray? Все соединения прервутся на пару секунд.", "Перезапустить", true)) return;
    await apiPost("/dev/vpn/xray/restart");
    toast("Xray перезапущен.");
  }));
  root.querySelector("#sv-geo")?.addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    await apiPost("/dev/vpn/geo/update");
    toast("Geo-файлы обновлены.");
  }));
  root.querySelector("#sv-backup")?.addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    const r = await apiPost("/dev/vpn/backups/make");
    toast(`Бэкап сохранён: ${r.name}`);
    rerender();
  }));
  let lines = [];
  const paint = () => {
    const q = root.querySelector("#lg-q").value.trim().toLowerCase();
    const shown = q ? lines.filter(l => l.toLowerCase().includes(q)) : lines;
    root.querySelector("#lg-out").textContent = shown.length ? shown.join("\n") : "Пусто.";
  };
  root.querySelector("#lg-q")?.addEventListener("input", paint);
  root.querySelector("#lg-load")?.addEventListener("click", ev => guarded(ev.currentTarget, async () => {
    const kind = root.querySelector("#lg-kind").value, n = root.querySelector("#lg-n").value;
    const r = await apiGet("/dev/vpn/logs", { kind, count: n });
    lines = r.lines;
    paint();
    const out = root.querySelector("#lg-out");
    out.scrollTop = out.scrollHeight;
  }));
}

// ---------- вход ----------

let current = { section: "clients", root: null };

async function refresh(force) {
  await load(force);
  rerender();
}

async function rerender() {
  const { section, root } = current;
  if (!root || !root.isConnected) return;
  try {
    if (section === "certs") { if (!data) await load(); root.innerHTML = await certsHtml(); wireCerts(root); return; }
    if (section === "server") { root.innerHTML = await serverHtml(); wireServer(root); return; }
    if (!data) await load();
    if (section === "inbounds") { root.innerHTML = inboundsHtml(); wireInbounds(root); }
    else { root.innerHTML = clientsHtml(); wireClients(root); }
  } catch (e) {
    root.innerHTML = `<div class="bcell vpn-warn">${esc(e.message || "Не удалось загрузить данные панели.")}</div>`;
  }
}

export function renderManage(section, root) {
  current = { section, root };
  root.innerHTML = `<div class="bento-empty">Загружаю…</div>`;
  if (section !== "clients" && section !== "inbounds") return rerender();
  load().then(rerender).catch(e => { if (root.isConnected) root.innerHTML = `<div class="bcell vpn-warn">${esc(e.message || "Панель недоступна.")}</div>`; });
}
