// Вкладка «VPN помощник» (только разработчик/владелец) — проверка своего
// VPS с X-UI (3x-ui) изнутри сети разработчика.
//
// Кто что делает:
// - сервер бота (/api/dev/vpn/overview, xui_helper.py) читает панель X-UI
//   по localhost и отдаёт цели: inbound'ы (порт, протокол, транспорт,
//   TLS/Reality, SNI), статус Xray, публичные адреса из .env. Ключи
//   клиентов и пароли сюда не приходят;
// - сетевые пробы делает Rust (vpn_probe.rs) с этого компьютера: DNS
//   (система против DoH), TCP-серии, TLS с вашим SNI и без SNI,
//   чтение ~96 КБ для поиска «заморозки» ТСПУ.
//
// Осторожность: ручной запуск не чаще раза в 2 минуты, результат живёт
// 10 минут (повторное открытие вкладки сеть не трогает), авто-проверка —
// раз в 30–60 минут со случайным сдвигом, только пока окно открыто.
// Соединений немного (≤ 2 одновременно, паузы — в Rust), портов —
// только из ваших inbound'ов, без VPN-трафика.

import { state } from "./state.js";
import { apiGet, toast } from "./api.js";
import { invoke } from "./tauri.js";
import { $, esc, relTime } from "./utils.js";
import { renderManage } from "./vpn-manage.js";

const RESULT_KEY = "project-vpn-last";
const HISTORY_KEY = "project-vpn-history";
const AUTO_KEY = "project-vpn-auto";
const MANUAL_GAP_MS = 2 * 60 * 1000;
const AUTO_MIN_MS = 30 * 60 * 1000;
const AUTO_MAX_MS = 60 * 60 * 1000;
const MAX_DOMAINS = 5;
const MAX_INBOUNDS = 8;
// Протоколы/транспорты поверх UDP — TCP-пробой их не проверить честно.
const UDP_PROTOCOLS = new Set(["hysteria", "hysteria2", "wireguard", "tuic"]);
const UDP_NETWORKS = new Set(["kcp", "quic"]);

let running = false;
let autoTimer = null;
let section = "health";
const SECTIONS = [
  ["health", "Состояние"], ["check", "Проверка сети"], ["inbounds", "Inbound'ы"],
  ["certs", "Сертификаты"], ["server", "Сервер"],
];

const readJson = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch (_) { return fallback; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* не критично */ } };
const isIp = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");
const autoOn = () => readJson(AUTO_KEY, false) === true;

const TONE = {
  ok: { label: "В порядке", colorVar: "--s-done" },
  warn: { label: "Есть вопросы", colorVar: "--s-work" },
  bad: { label: "Проблема", colorVar: "--s-stop" },
  skip: { label: "Не проверялось", colorVar: "--ink-dim" },
};
const worst = list => list.includes("bad") ? "bad" : list.includes("warn") ? "warn" : list.includes("ok") ? "ok" : "skip";

const ERR = {
  refused: "порт закрыт (сервер отказал)",
  reset: "соединение сброшено (RST)",
  timeout: "нет ответа (пакеты теряются)",
  eof: "сервер закрыл соединение",
  unreachable: "сеть недоступна",
  tls_alert: "TLS-отказ от сервера",
  tls_other: "ошибка TLS",
  other: "ошибка",
};

// ---------- сами проверки ----------

async function probe(cmd, args) {
  try { return await invoke(cmd, args); } catch (e) { return { _error: String(e) }; }
}

function pickDomains(ov) {
  const set = new Set();
  for (const h of ov.public_hosts || []) if (!isIp(h)) set.add(h.toLowerCase());
  for (const ib of ov.inbounds || []) {
    if (ib.security === "tls") for (const s of ib.snis || []) set.add(s.toLowerCase());
    if (ib.transport?.host && !isIp(ib.transport.host)) set.add(ib.transport.host.toLowerCase());
  }
  return [...set].slice(0, MAX_DOMAINS);
}

function classifyInbound(ib, tcp, tls, control, others) {
  const notes = [];
  if (!tcp || tcp._error) return { tone: "bad", notes: [tcp?._error || "TCP-проба не запустилась"] };
  if (!tcp.ok_count) {
    const errs = tcp.attempts.map(a => a.error);
    if (errs.every(e => e === "refused")) return { tone: "bad", notes: ["Порт закрыт на сервере: inbound не слушает или режет фаервол VPS."], recs: ["Проверьте, что inbound слушает этот порт и фаервол VPS (ufw/iptables) его пропускает."] };
    const otherPortsOk = others.some(t => t && t.ok_count > 0);
    return {
      tone: "bad",
      notes: [otherPortsOk
        ? `Похоже на блок порта ${ib.port}: другие порты этого сервера отвечают, а этот — ${ERR[errs[0]] || errs[0]}.`
        : `Сервер не отвечает ни на одном порту (${ERR[errs[0]] || errs[0]}) — похоже на блок по IP.`],
      recs: [otherPortsOk
        ? "Смените порт inbound'а в 3X-UI на 443, 8443, 2053 или 2083."
        : "Смените IP-адрес сервера или провайдера VPS."],
    };
  }
  let tone = tcp.ok_count < tcp.attempts.length ? "warn" : "ok";
  if (tone === "warn") notes.push(`TCP: ${tcp.ok_count} из ${tcp.attempts.length} попыток прошли.`);
  if (!tls) return { tone, notes };
  if (tls._error) return { tone: "warn", notes: [...notes, tls._error] };
  const recs = [];
  if (!tls.tls_ok) {
    const controlAnswered = control && !control._error && (control.tls_ok || ["tls_alert", "tls_other"].includes(control.error));
    const what = ERR[tls.error] || tls.error;
    if (controlAnswered) {
      notes.push(`DPI по SNI: с «${tls.sni}» — ${what}, а без SNI сервер отвечает.`);
      recs.push("Замените serverNames (Target SNI) в настройках REALITY на менее популярный или нейтральный домен.");
    } else if (["reset", "timeout", "eof"].includes(tls.error)) {
      notes.push(`TCP проходит, а TLS-хендшейк — ${what}: похоже на DPI по TLS к этому серверу.`);
      recs.push("Смените SNI/dest, а если не поможет — транспорт на gRPC, xhttp или httpupgrade.");
    } else notes.push(`TLS не установился: ${what}${tls.error_text ? ` (${tls.error_text})` : ""}.`);
    return { tone: "bad", notes, recs };
  }
  if (ib.security === "reality") {
    if (tls.cert_valid) notes.push(`Reality отвечает сертификатом ${ib.reality_dest || tls.sni} — маскировка выглядит правильно.`);
    else { tone = "warn"; notes.push(`Reality: сертификат не сходится с SNI «${tls.sni}» (${tls.cert_error || "?"}). Проверьте dest и serverNames.`); recs.push("Выберите dest/serverNames, у которого сайт отвечает по TLS 1.3 и h2."); }
  } else {
    if (tls.cert_valid === false) { tone = "bad"; notes.push(`SSL недействителен: ${tls.cert_error}.`); recs.push("Откройте вкладку «Сертификаты» и выпустите или назначите действующий сертификат."); }
    else if (tls.cert_days_left != null && tls.cert_days_left < 14) { tone = worst([tone, "warn"]); notes.push(`Сертификат истекает через ${tls.cert_days_left} дн.`); recs.push("Во вкладке «Сертификаты» включите авто-продление или продлите вручную."); }
  }
  return { tone, notes, recs };
}

function classifyFreeze(http) {
  if (!http) return null;
  const kb = Math.round(http.bytes / 1024);
  if (http.stalled && http.bytes >= 10 * 1024 && http.bytes <= 32 * 1024) return { tone: "bad", text: `Поток встал на ${kb} КБ — типичная «заморозка» ТСПУ.`, rec: "Смените транспорт inbound'а на gRPC, xhttp или httpupgrade (вместо сырого TCP/WS)." };
  if (http.stalled) return { tone: "warn", text: `Поток встал на ${kb} КБ (не похоже на ТСПУ, но ответ не дочитан).` };
  if (http.error && http.error !== "timeout") return { tone: "warn", text: `Чтение оборвалось на ${kb} КБ: ${ERR[http.error] || http.error}.` };
  if (http.bytes < 20 * 1024) return { tone: "skip", text: `Ответ всего ${kb} КБ — слишком мал, чтобы проверить порог ~16 КБ.` };
  return { tone: "ok", text: `Прочитано ${kb} КБ без остановки — заморозки нет.` };
}

export async function runVpnChecks({ auto = false } = {}) {
  if (running) return null;
  const last = readJson(RESULT_KEY, null);
  if (!auto && last && Date.now() - last.at < MANUAL_GAP_MS) {
    toast(`Проверка была только что — следующая через ${Math.ceil((MANUAL_GAP_MS - (Date.now() - last.at)) / 1000)} с.`);
    return null;
  }
  running = true;
  renderProgress("Читаю панель X-UI…");
  try {
    const ov = await apiGet("/dev/vpn/overview");
    if (!ov.configured) throw new Error(ov.reason || "X-UI не настроен на сервере.");

    const domains = pickDomains(ov);
    const dns = [];
    for (const d of domains) {
      renderProgress(`DNS: ${d}`);
      dns.push(await probe("vpn_dns", { host: d }));
    }
    const internetOk = dns.length === 0 || dns.some(r => r.doh?.some(x => !x.error));

    // Адрес сервера: явный IP из .env → публичный IP из X-UI → ответ DoH
    // (провайдерскому DNS тут не верим — его и проверяем).
    const ipFromEnv = (ov.public_hosts || []).find(isIp);
    const ipFromDoh = dns.flatMap(r => (r.doh || []).flatMap(x => x.ips || []))[0];
    const serverIp = ipFromEnv || ov.server?.public_ipv4 || ipFromDoh || dns[0]?.system?.[0] || null;

    const inbounds = (ov.inbounds || []).filter(ib => ib.enable).slice(0, MAX_INBOUNDS);
    const rows = [];
    if (serverIp) {
      for (const ib of inbounds) {
        if (UDP_PROTOCOLS.has(ib.protocol) || UDP_NETWORKS.has(ib.network)) {
          rows.push({ ib, tone: "skip", notes: ["UDP-транспорт — TCP-пробой не проверяется."] });
          continue;
        }
        renderProgress(`Порт ${ib.port} (${ib.remark || ib.protocol})`);
        const tcp = await probe("vpn_tcp", { host: serverIp, port: ib.port, count: 3 });
        let tls = null, control = null;
        if (tcp.ok_count && (ib.security === "tls" || ib.security === "reality")) {
          tls = await probe("vpn_tls", { host: serverIp, port: ib.port, sni: ib.snis?.[0] || null, httpGet: false });
          // Контроль без SNI — только когда с SNI не вышло: лишних
          // хендшейков к серверу не делаем.
          if (tls && !tls._error && !tls.tls_ok) control = await probe("vpn_tls", { host: serverIp, port: ib.port, sni: null, httpGet: false });
        }
        rows.push({ ib, tcp, tls, control });
      }
      for (const r of rows) {
        if (r.tone) continue;
        Object.assign(r, classifyInbound(r.ib, r.tcp, r.tls, r.control, rows.filter(x => x !== r).map(x => x.tcp)));
      }
    }

    // Порог ~16 КБ: одна проба за прогон. Reality отдаёт страницу
    // маскировочного сайта через ваш IP — как раз то, что режет ТСПУ.
    let freeze = null;
    const freezeTarget = rows.find(r => r.ib.security === "reality" && r.tls?.tls_ok) || rows.find(r => r.ib.security === "tls" && r.tls?.tls_ok);
    if (freezeTarget) {
      renderProgress("Проверка «заморозки» после ~16 КБ");
      const t = await probe("vpn_tls", { host: serverIp, port: freezeTarget.ib.port, sni: freezeTarget.ib.snis?.[0] || null, httpGet: true });
      freeze = { port: freezeTarget.ib.port, ...(classifyFreeze(t.http) || { tone: "skip", text: t._error || "Нет HTTP-ответа." }) };
    }

    // Стабильность: серия из 8 коннектов к первому живому порту.
    let stability = null;
    const stabTarget = rows.find(r => r.tcp?.ok_count);
    if (stabTarget) {
      renderProgress("Стабильность соединения");
      stability = await probe("vpn_tcp", { host: serverIp, port: stabTarget.ib.port, count: 8 });
    }

    // connect за ~1 мс до удалённого сервера — соединение перехватил
    // локальный VPN/прокси, пробы меряют его, а не провайдера.
    const tunnel = (stability?.median_ms ?? stabTarget?.tcp?.median_ms ?? 99) < 5;

    const result = { at: Date.now(), auto, ov, serverIp, internetOk, dns, rows, freeze, stability, tunnel };
    writeJson(RESULT_KEY, stripForStorage(result));
    pushHistory(result);
    return result;
  } catch (e) {
    toast(`VPN помощник: ${e.message}`, "error");
    return null;
  } finally {
    running = false;
    if (state.activeTab === "vpn" && section === "check") renderFromCache();
  }
}

function stripForStorage(r) {
  return JSON.parse(JSON.stringify(r));
}

function overallTone(r) {
  const tones = r.rows.map(x => x.tone);
  if (r.dns.some(d => d.mismatch)) tones.push("warn");
  if (r.freeze) tones.push(r.freeze.tone);
  if (r.stability && r.stability.ok_count < r.stability.attempts.length) tones.push("warn");
  if (!r.serverIp) tones.push("bad");
  return worst(tones);
}

function pushHistory(r) {
  const h = readJson(HISTORY_KEY, []);
  h.unshift({
    at: r.at, auto: r.auto, tone: overallTone(r),
    ok: r.rows.filter(x => x.tone === "ok").length, total: r.rows.length,
    median: r.stability?.median_ms ?? null, loss: r.stability ? r.stability.attempts.length - r.stability.ok_count : null,
  });
  writeJson(HISTORY_KEY, h.slice(0, 30));
}

// ---------- авто-проверка ----------

export function scheduleVpnAuto() {
  clearTimeout(autoTimer);
  autoTimer = null;
  if (!state.isDeveloper || !autoOn()) return;
  const delay = AUTO_MIN_MS + Math.random() * (AUTO_MAX_MS - AUTO_MIN_MS);
  autoTimer = setTimeout(async () => {
    autoTimer = null;
    if (!state.isDeveloper || !autoOn()) return; // вышли из аккаунта или выключили
    const last = readJson(RESULT_KEY, null);
    if (!last || Date.now() - last.at > AUTO_MIN_MS * 0.8) await runVpnChecks({ auto: true });
    scheduleVpnAuto();
  }, delay);
}

// ---------- отрисовка ----------

function pill(tone, text) {
  const t = TONE[tone] || TONE.skip;
  return `<span class="svc-pill" style="background:color-mix(in srgb, var(${t.colorVar}) 16%, var(--surface)); color:var(${t.colorVar});">${esc(text || t.label)}</span>`;
}
function dot(tone) {
  const v = (TONE[tone] || TONE.skip).colorVar;
  return `<span class="svc-dot" style="background:var(${v}); box-shadow:0 0 0 3px color-mix(in srgb, var(${v}) 18%, transparent);"></span>`;
}
const fmtMs = v => v == null ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)} мс`;
const fmtBytes = n => n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} ГБ` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} МБ` : `${Math.round((n || 0) / 1024)} КБ`;

function renderProgress(text) {
  const root = $("#vpn-body");
  if (!root || state.activeTab !== "vpn") return;
  const slot = root.querySelector("#vpn-progress");
  if (slot) { slot.hidden = false; slot.textContent = text; }
  const btn = root.querySelector("#vpn-run");
  if (btn) btn.disabled = true;
}

function headerHtml(r) {
  const auto = autoOn();
  const check = section === "check";
  return `
    <div class="page-header">
      <div>
        <span class="kd-label">Разработчик · X-UI на VPS</span>
        <h1>VPN помощник</h1>
      </div>
      ${check ? `<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <label class="vpn-auto" title="Раз в 30–60 минут со случайным сдвигом, пока приложение открыто">
          <input type="checkbox" id="vpn-auto" ${auto ? "checked" : ""}> Авто-проверка
        </label>
        <button class="btn" id="vpn-run" ${running ? "disabled" : ""}>Проверить сейчас</button>
      </div>` : ""}
    </div>
    <nav class="vm-nav" id="vm-nav">${SECTIONS.map(([k, l]) => `<button class="vm-tab ${k === section ? "active" : ""}" data-sec="${k}">${l}</button>`).join("")}</nav>
    ${check ? `<div class="vpn-progress" id="vpn-progress" ${running ? "" : "hidden"}>Идёт проверка…</div>
    ${r ? "" : `<div class="bcell"><div class="bento-empty">Проверок ещё не было. Нажмите «Проверить сейчас»: клиент прочитает список inbound'ов с панели и проверит их с этого компьютера.</div></div>`}` : ""}`;
}

function inboundRowHtml(x) {
  const ib = x.ib;
  const proto = [ib.protocol, ib.network, ib.security !== "none" ? ib.security : null].filter(Boolean).join(" · ");
  const sni = ib.snis?.length ? `SNI ${ib.snis[0]}` : "";
  const tlsBits = x.tls?.tls_ok ? [x.tls.version?.replace("TLSv1_", "TLS 1."), x.tls.alpn, x.tls.cert_days_left != null ? `серт. ${x.tls.cert_days_left} дн.` : null].filter(Boolean).join(" · ") : "";
  return `
    <div class="svc-row vpn-row">
      ${dot(x.tone)}
      <div class="svc-row-main">
        <div class="svc-row-name">${esc(ib.remark || `inbound ${ib.id}`)} <span class="vpn-port">:${ib.port}</span></div>
        <div class="svc-row-desc">${esc(proto)}${sni ? ` · ${esc(sni)}` : ""}${tlsBits ? ` · ${esc(tlsBits)}` : ""}</div>
        ${(x.notes || []).map(n => `<div class="vpn-note">${esc(n)}</div>`).join("")}
        ${(x.recs || []).map(n => `<div class="vpn-rec">→ ${esc(n)}</div>`).join("")}
      </div>
      ${pill(x.tone)}
      <div class="svc-row-latency">${fmtMs(x.tcp?.median_ms)}</div>
    </div>`;
}

function dnsHtml(r) {
  if (!r.dns.length) return `<div class="no-assignee">Доменов нет: Reality без своего домена или XUI_PUBLIC_HOSTS пуст.</div>`;
  return r.dns.map(d => {
    if (d._error) return `<div class="mini-row">${dot("bad")}<div><b>${esc(d._error)}</b></div></div>`;
    const tone = d.mismatch ? "warn" : d.system_error ? "bad" : "ok";
    const doh = (d.doh || []).map(x => `${esc(x.resolver)}: ${x.error ? esc(x.error) : esc(x.ips.join(", ") || "пусто")}`).join(" · ");
    return `
      <div class="mini-row" style="align-items:flex-start;">
        ${dot(tone)}
        <div style="min-width:0;">
          <div style="font-size:12px; font-weight:600;">${esc(d.host)}</div>
          <div class="vpn-sub">Система: ${d.system_error ? esc(d.system_error) : esc(d.system.join(", ") || "пусто")} · ${doh}</div>
          ${d.mismatch ? `<div class="vpn-note">Провайдерский DNS отвечает не так, как DoH, — похоже на подмену DNS.</div><div class="vpn-rec">→ Включите в клиенте шифрование DNS (DoH / DoT).</div>` : ""}
        </div>
      </div>`;
  }).join("");
}

function historyHtml() {
  const h = readJson(HISTORY_KEY, []);
  if (!h.length) return `<div class="no-assignee">Истории пока нет</div>`;
  return h.slice(0, 10).map(x => `
    <div class="mini-row">
      ${dot(x.tone)}
      <div style="min-width:0; flex:1;">
        <div style="font-size:12px;">${esc(relTime(new Date(x.at).toISOString()))}${x.auto ? " · авто" : ""}</div>
        <div class="vpn-sub">inbound'ов в порядке: ${x.ok} из ${x.total}${x.median != null ? ` · ${fmtMs(x.median)}` : ""}${x.loss ? ` · потерь ${x.loss}` : ""}</div>
      </div>
    </div>`).join("");
}

function resultHtml(r) {
  const tone = overallTone(r);
  const t = TONE[tone];
  const s = r.ov.server || {};
  const xrayTone = s.xray_state === "running" ? "ok" : s.xray_state ? "bad" : "skip";
  const st = r.stability;
  const loss = st ? st.attempts.length - st.ok_count : null;
  const stats = [
    { label: "Xray", value: s.xray_state || "—", sub: s.xray_version ? `версия ${s.xray_version}` : (s.xray_error || ""), tone: xrayTone },
    { label: "Inbound'ы", value: `${r.rows.filter(x => x.tone === "ok").length}/${r.rows.length}`, sub: "проходят проверку", tone: worst(r.rows.map(x => x.tone)) },
    { label: "Задержка", value: fmtMs(st?.median_ms), sub: st ? `джиттер ${fmtMs(st.jitter_ms)}` : "нет данных", tone: st ? (st.median_ms > 300 ? "warn" : "ok") : "skip" },
    { label: "Потери", value: loss == null ? "—" : `${loss} из ${st.attempts.length}`, sub: "TCP-серия", tone: loss == null ? "skip" : loss ? (loss > 2 ? "bad" : "warn") : "ok" },
  ];
  const statCards = stats.map((x, i) => `
    <div class="bcell kpi-cell" style="animation-delay:${i * 40}ms;">
      <h3>${esc(x.label)}</h3>
      <div class="svc-stat"><span class="big-num">${esc(String(x.value))}</span><span style="color:var(${TONE[x.tone].colorVar});">${esc(x.sub)}</span></div>
    </div>`).join("");
  const traffic = (r.ov.inbounds || []).reduce((a, ib) => a + (ib.up || 0) + (ib.down || 0), 0);
  const disabled = (r.ov.inbounds || []).filter(ib => !ib.enable);

  return `
    <section class="kd-gl svc-hero" style="--c:var(${t.colorVar});">
      <span class="svc-orb"></span>
      <div><h2>${tone === "ok" ? "Сервер доступен, блокировок не видно" : tone === "bad" ? "Найдены проблемы" : tone === "warn" ? "Работает, но есть вопросы" : "Нечего проверять"}</h2>
        <p>${esc(r.serverIp || "адрес сервера не найден")} · проверено ${esc(relTime(new Date(r.at).toISOString()))}${r.auto ? " (авто)" : ""} · трафик ${fmtBytes(traffic)}</p></div>
    </section>
    ${r.tunnel ? `<div class="bcell vpn-warn">Соединение с сервером устанавливается меньше чем за 5 мс — похоже, на этом компьютере включён VPN или прокси, и проверки идут через него. Для честной картины блокировок выключите его и проверьте снова.</div>` : ""}
    ${!r.internetOk ? `<div class="bcell vpn-warn">DoH-резолверы не ответили — возможно, пропал интернет, а не сервер заблокирован.</div>` : ""}
    ${!r.serverIp ? `<div class="bcell vpn-warn">Не удалось определить IP сервера. Укажите его в XUI_PUBLIC_HOSTS на сервере.</div>` : ""}
    <div class="an-metrics">${statCards}</div>
    <div class="svc-bottom-row">
      <div class="bcell svc-list-cell" style="animation-delay:160ms;">
        <h3>Inbound'ы X-UI</h3>
        <div class="svc-list">${r.rows.map(inboundRowHtml).join("") || `<div class="bento-empty">Включённых inbound'ов нет.</div>`}</div>
        ${disabled.length ? `<div class="vpn-sub" style="margin-top:8px;">Выключены в панели: ${disabled.map(ib => esc(`${ib.remark || ib.id}:${ib.port}`)).join(", ")}</div>` : ""}
      </div>
      <div style="display:flex; flex-direction:column; gap:14px; min-height:0;">
        <div class="bcell" style="animation-delay:200ms;">
          <h3>Домены и DNS</h3>
          <div class="mini-list">${dnsHtml(r)}</div>
        </div>
        <div class="bcell" style="animation-delay:220ms;">
          <h3>Заморозка после ~16 КБ</h3>
          <div class="mini-list">${r.freeze ? `<div class="mini-row">${dot(r.freeze.tone)}<div class="vpn-sub" style="color:inherit;">порт ${r.freeze.port}: ${esc(r.freeze.text)}${r.freeze.rec ? `<div class="vpn-rec">→ ${esc(r.freeze.rec)}</div>` : ""}</div></div>` : `<div class="no-assignee">Нет TLS-inbound'а, через который можно проверить</div>`}</div>
        </div>
        <div class="bcell" style="flex-grow:1; animation-delay:240ms;">
          <h3>История проверок</h3>
          <div class="mini-list">${historyHtml()}</div>
        </div>
      </div>
    </div>`;
}

function renderFromCache() {
  const root = $("#vpn-body");
  if (!root) return;
  const r = readJson(RESULT_KEY, null);
  root.innerHTML = headerHtml(r) + (section === "check" ? (r ? resultHtml(r) : "") : `<div id="vm-pane"></div>`);
  wire(root);
  if (section !== "check") renderManage(section, root.querySelector("#vm-pane"));
}

function wire(root) {
  root.querySelector("#vm-nav")?.addEventListener("click", e => {
    const b = e.target.closest("[data-sec]");
    if (!b || b.dataset.sec === section) return;
    section = b.dataset.sec;
    renderFromCache();
  });
  root.querySelector("#vpn-run")?.addEventListener("click", () => runVpnChecks());
  root.querySelector("#vpn-auto")?.addEventListener("change", e => {
    writeJson(AUTO_KEY, e.target.checked);
    scheduleVpnAuto();
    toast(e.target.checked ? "Авто-проверка: раз в 30–60 минут." : "Авто-проверка выключена.");
  });
}

export async function loadVpnHelper() {
  const root = $("#vpn-body");
  if (!root) return;
  if (state.isDeveloper === false) {
    root.innerHTML = `<div class="bento-empty">Раздел доступен только владельцу команды.</div>`;
    return;
  }
  // Открытие вкладки сеть не трогает: показываем последний результат,
  // новая проверка — по кнопке или по таймеру авто-проверки.
  renderFromCache();
  if (!autoTimer) scheduleVpnAuto();
}
