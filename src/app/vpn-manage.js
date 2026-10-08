// «VPN помощник» → управление панелью X-UI: клиенты, inbound'ы,
// сертификаты, сервер (Xray, логи, бэкапы). Сервер — xui_helper.py
// (/api/dev/vpn/*, только владелец, каждое действие пишется в журнал
// разработчика). Здесь только интерфейс: разрушающие действия
// спрашивают подтверждение, долгие (выпуск сертификата) показывают
// ход, ошибки панели выводятся как есть.

import { apiGet, apiPost, openSheet, dismissSheet, toast } from "./api.js";
import { esc } from "./utils.js";

let data = null;      // /dev/vpn/manage
let busy = false;

const GB = 1024 ** 3;
const fmtBytes = n => n >= GB ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} ГБ` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(0)} МБ` : `${Math.round((n || 0) / 1024)} КБ`;

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

async function load(force = false) {
  data = await apiGet("/dev/vpn/manage", force ? { force: 1 } : undefined);
  return data;
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
`;
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
}

// ---------- вход ----------

let current = { section: "inbounds", root: null };

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
    root.innerHTML = inboundsHtml();
    wireInbounds(root);
  } catch (e) {
    root.innerHTML = `<div class="bcell vpn-warn">${esc(e.message || "Не удалось загрузить данные панели.")}</div>`;
  }
}

export function renderManage(section, root) {
  current = { section, root };
  root.innerHTML = `<div class="bento-empty">Загружаю…</div>`;
  if (section !== "inbounds") return rerender();
  load().then(rerender).catch(e => { if (root.isConnected) root.innerHTML = `<div class="bcell vpn-warn">${esc(e.message || "Панель недоступна.")}</div>`; });
}
