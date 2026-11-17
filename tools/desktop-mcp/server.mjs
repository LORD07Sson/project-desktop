#!/usr/bin/env node
// MCP-сервер для отладки Project Desktop «глазами»: подключается к настоящему окну программы
// через отладочный порт WebView2 (CDP) и даёт ИИ-агенту скриншоты, список элементов, клики и ввод.
// Без зависимостей: JSON-RPC по stdio + встроенный WebSocket Node 22+.
//
// Порт открывается ТОЛЬКО если программу запустили через scripts/debug-launch.ps1 (или вручную с
// переменной WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222). Слушает только 127.0.0.1.

const PORT = Number(process.env.PROJECT_DEBUG_PORT || 9222);
const HOST = "127.0.0.1";

// ---------- CDP ----------
let ws = null;
let wsTarget = null;
let nextId = 1;
const pending = new Map();
const consoleLog = [];
const CONSOLE_MAX = 300;

async function listTargets() {
  const res = await fetch(`http://${HOST}:${PORT}/json`);
  const all = await res.json();
  return all.filter(t => t.type === "page" && !String(t.url).startsWith("devtools://"));
}

async function connect(targetIndex = 0) {
  const targets = await listTargets();
  const target = targets[targetIndex];
  if (!target) throw new Error(`Нет окна №${targetIndex}. Запущена ли программа через scripts/debug-launch.ps1?`);
  if (ws && ws.readyState === 1 && wsTarget === target.id) return;
  if (ws) try { ws.close(); } catch (_) { /* уже закрыт */ }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  wsTarget = target.id;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WebSocket CDP не открылся"));
  });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map(a => a.value ?? a.description ?? "").join(" ");
      consoleLog.push(`[${msg.params.type}] ${text}`);
      if (consoleLog.length > CONSOLE_MAX) consoleLog.shift();
    } else if (msg.method === "Fetch.requestPaused") {
      onRequestPaused(msg.params).catch(e => {
        consoleLog.push(`[sandbox] ${e.message}`);
        cdp("Fetch.continueRequest", { requestId: msg.params.requestId }).catch(() => {});
      });
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleLog.push(`[exception] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      consoleLog.push(`[${e.level}] ${e.text}${e.url ? " " + e.url : ""}`);
      if (consoleLog.length > CONSOLE_MAX) consoleLog.shift();
    } else if (msg.method?.startsWith("Network.")) {
      onNetwork(msg.method, msg.params);
    }
  };
  ws.onclose = () => { ws = null; };
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Log.enable").catch(() => {});
  await cdp("Network.enable", { maxPostDataSize: 2000 }).catch(() => {});
  // Новое подключение — новый CDP-сеанс: перехват прошлого сеанса браузер уже снял.
  if (sandbox.on) await applySandbox();
}

// ---------- журнал сети ----------
// Копится с момента подключения: метод, путь, статус, время, размер, ошибка. Тело ответа — по запросу.
const netLog = new Map();
const NET_MAX = 400;
function onNetwork(method, p) {
  if (method === "Network.requestWillBeSent") {
    if (/^(data|blob|devtools):/.test(p.request.url)) return;
    netLog.set(p.requestId, { id: p.requestId, t0: p.timestamp, at: new Date().toISOString().slice(11, 19),
      method: p.request.method, url: p.request.url, type: p.type, post: p.request.postData?.slice(0, 500) });
    if (netLog.size > NET_MAX) netLog.delete(netLog.keys().next().value);
    return;
  }
  const r = netLog.get(p.requestId);
  if (!r) return;
  if (method === "Network.responseReceived") { r.status = p.response.status; r.mime = p.response.mimeType; }
  else if (method === "Network.loadingFinished") { r.ms = Math.round((p.timestamp - r.t0) * 1000); r.bytes = p.encodedDataLength; }
  else if (method === "Network.loadingFailed") { r.ms = Math.round((p.timestamp - r.t0) * 1000); r.error = p.canceled ? "canceled" : p.errorText; }
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("CDP не подключён"));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP ${method}: таймаут`)); }, 30000);
  });
}

async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// ---------- действия ----------
const SNAPSHOT_FN = `function (root, maxText) {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  document.querySelectorAll("[data-mcp-ref]").forEach(e => e.removeAttribute("data-mcp-ref"));
  const sel = 'button, a[href], input, select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [data-open], [data-tab], [onclick], summary, label';
  const scope = root ? document.querySelector(root) : document;
  if (!scope) throw new Error("root не найден: " + root);
  const items = []; let n = 0;
  for (const el of scope.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    el.setAttribute("data-mcp-ref", ++n);
    items.push({ ref: n, tag: el.tagName.toLowerCase(), type: el.type || undefined, text, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), disabled: el.disabled || undefined, checked: el.checked ?? undefined });
  }
  const textEl = root ? scope : document.querySelector("main, #app, body");
  const body = maxText === 0 ? undefined : (textEl.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, maxText ?? 6000);
  return { title: document.title, url: location.href, viewport: [innerWidth, innerHeight], scrollY: Math.round(scrollY), elements: items, text: body };
}`;

const WAIT_FN = `async function (selector, text, gone, timeout) {
  const seen = () => {
    if (selector) { const el = document.querySelector(selector); return !!(el && el.getClientRects().length); }
    return (document.body.innerText || "").includes(text);
  };
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (seen() !== !!gone) return Date.now() - t0;
    await new Promise(r => setTimeout(r, 100));
  }
  return -1;
}`;

const INSPECT_FN = `function (selector, props, all) {
  const els = all ? [...document.querySelectorAll(selector)].slice(0, 20) : [document.querySelector(selector)].filter(Boolean);
  if (!els.length) throw new Error("Не найдено: " + selector);
  const def = ["display","position","width","height","margin","padding","gap","color","background-color","font-size","font-weight","line-height","border-radius","opacity","z-index","overflow","transform"];
  return els.map(el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    const styles = {}; for (const p of (props && props.length ? props : def)) styles[p] = s.getPropertyValue(p);
    return { tag: el.tagName.toLowerCase(), id: el.id || undefined, cls: el.className?.baseVal ?? (el.className || undefined),
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.innerText || "").trim().slice(0, 120) || undefined, styles,
      overflowing: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 || undefined };
  });
}`;

const RECT_FN = `function (selector, pad) {
  const el = document.querySelector(selector);
  if (!el || !el.getClientRects().length) return null;
  el.scrollIntoView({ block: "nearest" });
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 1 };
}`;

// Значения ref/selector/text передаются в страницу КАК ДАННЫЕ (аргументы callFunctionOn), а не вставляются в текст кода.
async function callInPage(fnSource, ...args) {
  const g = await cdp("Runtime.evaluate", { expression: "globalThis" });
  const r = await cdp("Runtime.callFunctionOn", {
    objectId: g.result.objectId,
    functionDeclaration: fnSource,
    arguments: args.map(value => ({ value })),
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const CENTER_FN = `function (ref, selector, text) {
  let el = null;
  if (ref != null) el = document.querySelector('[data-mcp-ref="' + Number(ref) + '"]');
  else if (selector) el = document.querySelector(selector);
  else {
    el = [...document.querySelectorAll("button, a, [role=button], [role=tab], summary, label, li, div, span")]
      .filter(e => (e.innerText || "").trim() === text && e.getBoundingClientRect().width > 0)
      .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0] || null;
  }
  if (!el || !el.getClientRects().length) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}`;

async function centerOf(args) {
  const pos = await callInPage(CENTER_FN, args.ref ?? null, args.selector ?? null, args.text ?? "");
  if (!pos) throw new Error("Элемент не найден или скрыт (ref/selector/text). Сначала desktop_snapshot.");
  return pos;
}

async function click({ x, y }, button = "left", count = 1) {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count });
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32 };
async function press(key, modifiers = 0) {
  const code = KEYS[key];
  const base = { key: key === "Space" ? " " : key, windowsVirtualKeyCode: code || key.toUpperCase().charCodeAt(0), modifiers };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// ---------- песочница: подмена ответов API ----------
// Перехват идёт через CDP Fetch в этом же WebSocket-сеансе. Закрылся сеанс (агент отключился,
// сервер упал) — браузер сам снимает перехват, программа снова ходит на сервер как обычно.
// Пока песочница включена, НИ ОДИН изменяющий запрос (POST/PUT/PATCH/DELETE) не уходит на сервер:
// он получает выдуманный ответ {ok:true} и попадает в журнал writes.
const sandbox = { on: false, role: "as-is", perms: null, mocks: [], writes: [], bannerId: null, nextMock: 1 };
const WRITES_MAX = 100;

const BANNER_JS = role => `(() => {
  const mount = () => {
    let b = document.getElementById("ai-sandbox-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "ai-sandbox-banner";
      b.style.cssText = "position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;" +
        "padding:5px 12px;border-radius:99px;font:600 11px/1.3 system-ui,sans-serif;color:#1a1200;background:#ffc94d;box-shadow:0 4px 14px rgba(0,0,0,.35)";
      document.documentElement.append(b);
    }
    b.textContent = "Песочница ИИ: данные подменены, изменения не сохраняются" + (${JSON.stringify(role)} !== "as-is" ? " · роль: " + ${JSON.stringify(role)} : "");
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mount) : mount();
})()`;

// Роль: правим ответы, по которым программа решает, что показывать (auth.js, settings.js).
const ROLES = {
  "as-is": null,
  owner: { whoami: { is_admin: true }, perms: { is_owner: true } },
  admin: { whoami: { is_admin: true }, perms: { is_owner: false }, me: { is_developer: false } },
  member: { whoami: { is_admin: false, nyaa_access: false }, perms: { is_owner: false, permissions: [] }, me: { is_developer: false } },
};

function apiPath(url) {
  const u = new URL(url);
  if (u.hostname.endsWith(".localhost") || u.hostname === "localhost") return null;
  const i = u.pathname.indexOf("/api/");
  return i < 0 ? null : u.pathname.slice(i + 4) + u.search;
}

function corsHeaders(request) {
  const origin = request.headers?.Origin || request.headers?.origin || "*";
  return [
    { name: "Content-Type", value: "application/json; charset=utf-8" },
    { name: "Access-Control-Allow-Origin", value: origin },
    { name: "Access-Control-Allow-Credentials", value: "true" },
    { name: "Access-Control-Allow-Headers", value: "*" },
    { name: "Access-Control-Allow-Methods", value: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
  ];
}

function fulfillJson(requestId, request, data, status = 200) {
  const body = Buffer.from(typeof data === "string" ? data : JSON.stringify(data)).toString("base64");
  return cdp("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: corsHeaders(request), body });
}

function findMock(method, path) {
  // Последний добавленный — главный: так можно сузить общий мок частным.
  for (let i = sandbox.mocks.length - 1; i >= 0; i--) {
    const m = sandbox.mocks[i];
    if ((m.method === "*" || m.method === method) && m.re.test(path)) return m;
  }
  return null;
}

function roleTransform(path) {
  const r = ROLES[sandbox.role];
  if (!r) return null;
  const p = path.split("?")[0];
  const patch = p === "/whoami" ? r.whoami : p === "/me/permissions" ? r.perms : p === "/me" ? r.me : null;
  if (!patch) return null;
  // Права конкретной роли студии (например даббера из матрицы) — поверх роли «member».
  if (p === "/me/permissions" && Array.isArray(sandbox.perms)) return data => ({ ...data, ...patch, permissions: sandbox.perms });
  return data => ({ ...data, ...patch });
}

async function onRequestPaused(ev) {
  const { requestId, request } = ev;
  const path = apiPath(request.url);
  if (path == null) return cdp("Fetch.continueRequest", { requestId });
  const method = request.method;

  // Стадия ответа: настоящий ответ сервера пришёл, применяем роль и transform-моки.
  if (ev.responseStatusCode != null) {
    const raw = await cdp("Fetch.getResponseBody", { requestId });
    const text = raw.base64Encoded ? Buffer.from(raw.body, "base64").toString("utf8") : raw.body;
    let data;
    // Ошибки сервера (401, 404, 500) отдаём как есть: подмена нужна для данных, а не для текста ошибки.
    if (ev.responseStatusCode >= 400) return cdp("Fetch.continueRequest", { requestId });
    try { data = JSON.parse(text); } catch (_) { return cdp("Fetch.continueRequest", { requestId }); }
    const role = roleTransform(path);
    if (role) data = role(data);
    const m = findMock(method, path);
    if (m?.transform) data = await m.transform(data, path);
    return fulfillJson(requestId, request, data, ev.responseStatusCode);
  }

  if (method === "OPTIONS") {
    return cdp("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: corsHeaders(request) });
  }
  const m = findMock(method, path);
  if (m && m.json !== undefined) {
    m.hits++;
    return fulfillJson(requestId, request, m.json, m.status);
  }
  // Служебные POST без изменения данных (выдача медиатокена, «я в сети», замер связи) пропускаем:
  // без медиатокена в песочнице не грузились картинки.
  if (method === "POST" && /^\/(media\/token|presence\/ping|telemetry\/net)/.test(path)) {
    return cdp("Fetch.continueRequest", { requestId });
  }
  if (method !== "GET" && method !== "HEAD") {
    sandbox.writes.push({ at: new Date().toISOString().slice(11, 19), method, path, body: (request.postData || "").slice(0, 500) });
    if (sandbox.writes.length > WRITES_MAX) sandbox.writes.shift();
    return fulfillJson(requestId, request, { ok: true, sandbox: true });
  }
  if (m?.transform || roleTransform(path)) {
    if (m) m.hits++;
    return cdp("Fetch.continueRequest", { requestId, interceptResponse: true });
  }
  return cdp("Fetch.continueRequest", { requestId });
}

async function applySandbox() {
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  const js = BANNER_JS(sandbox.role);
  if (sandbox.bannerId) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: sandbox.bannerId }).catch(() => {});
  sandbox.bannerId = (await cdp("Page.addScriptToEvaluateOnNewDocument", { source: js })).identifier;
  await evaluate(js);
}

async function dropSandbox() {
  await cdp("Fetch.disable").catch(() => {});
  if (sandbox.bannerId) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: sandbox.bannerId }).catch(() => {});
  sandbox.bannerId = null;
  await evaluate(`document.getElementById("ai-sandbox-banner")?.remove()`).catch(() => {});
}

function sandboxStatus() {
  return JSON.stringify({
    on: sandbox.on, role: sandbox.role, perms: sandbox.perms,
    mocks: sandbox.mocks.map(m => ({ id: m.id, method: m.method, pattern: m.re.source, kind: m.json !== undefined ? "json" : "transform", hits: m.hits })),
    writes: sandbox.writes.slice(-20),
  }, null, 1);
}

async function reloadPage() {
  await cdp("Page.reload", { ignoreCache: false });
  await new Promise(r => setTimeout(r, 1500));
}

const TOOLS = {
  desktop_status: {
    description: "Список окон программы, доступных по отладочному порту. Если ошибка — программа запущена не через scripts/debug-launch.ps1.",
    schema: { type: "object", properties: {} },
    run: async () => JSON.stringify((await listTargets()).map((t, i) => ({ index: i, title: t.title, url: t.url })), null, 1),
  },
  desktop_screenshot: {
    description: "Скриншот окна программы. Это реальная картинка, а не догадка по коду. selector — снять только этот элемент " +
      "(pad — поля вокруг, px); scale 0.1–1 — уменьшить картинку (экономит токены); jpeg: true — JPEG вместо PNG.",
    schema: { type: "object", properties: { window: { type: "number", description: "Номер окна из desktop_status, по умолчанию 0" },
      selector: { type: "string" }, pad: { type: "number" }, scale: { type: "number" }, jpeg: { type: "boolean" } } },
    run: async args => {
      await connect(args.window || 0);
      const p = { format: args.jpeg ? "jpeg" : "png" };
      if (args.jpeg) p.quality = 80;
      if (args.selector) {
        const clip = await callInPage(RECT_FN, args.selector, args.pad ?? 8);
        if (!clip) throw new Error("Элемент не найден или скрыт: " + args.selector);
        p.clip = clip;
      }
      const s = Math.min(1, Math.max(0.1, args.scale || 1));
      if (s < 1) {
        if (!p.clip) { const [w, h] = await evaluate("[innerWidth, innerHeight]"); p.clip = { x: 0, y: 0, width: w, height: h, scale: 1 }; }
        p.clip.scale = s;
      }
      const r = await cdp("Page.captureScreenshot", p);
      return { image: r.data, mime: args.jpeg ? "image/jpeg" : "image/png" };
    },
  },
  desktop_snapshot: {
    description: "Видимые интерактивные элементы с номерами ref, их координаты и текст страницы. По ref работают desktop_click и desktop_type. " +
      "root — CSS-селектор области (только её элементы и текст); max_text — лимит текста (0 — без текста, по умолчанию 6000).",
    schema: { type: "object", properties: { window: { type: "number" }, root: { type: "string" }, max_text: { type: "number" } } },
    run: async args => { await connect(args.window || 0); return JSON.stringify(await callInPage(SNAPSHOT_FN, args.root ?? null, args.max_text ?? null)); },
  },
  desktop_wait: {
    description: "Ждать, пока появится элемент (selector) или текст (text) на странице; gone: true — ждать, пока исчезнет. " +
      "timeout в мс (по умолчанию 8000). Используй вместо пауз после кликов и загрузок.",
    schema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, gone: { type: "boolean" }, timeout: { type: "number" } } },
    run: async args => {
      await connect(args.window || 0);
      if (!args.selector && !args.text) throw new Error("Нужен selector или text");
      const ms = await callInPage(WAIT_FN, args.selector ?? null, args.text ?? "", !!args.gone, args.timeout || 8000);
      if (ms < 0) throw new Error(`Не дождался за ${args.timeout || 8000} мс`);
      return `Готово за ${ms} мс`;
    },
  },
  desktop_hover: {
    description: "Навести мышь на элемент (ref/selector/text) — показать тултипы, hover-стили, выпадающие меню.",
    schema: { type: "object", properties: { ref: { type: "number" }, selector: { type: "string" }, text: { type: "string" } } },
    run: async args => {
      await connect(args.window || 0);
      const pos = await centerOf(args);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
      return `Курсор (${Math.round(pos.x)}, ${Math.round(pos.y)})`;
    },
  },
  desktop_inspect: {
    description: "Коробка (x,y,w,h), вычисленные стили и переполнение элемента по CSS-селектору. props — свои CSS-свойства " +
      "вместо стандартного набора; all: true — все совпадения (до 20). Для замеров отступов/цветов/обрезки текста.",
    schema: { type: "object", properties: { selector: { type: "string" }, props: { type: "array", items: { type: "string" } }, all: { type: "boolean" } }, required: ["selector"] },
    run: async args => { await connect(args.window || 0); return JSON.stringify(await callInPage(INSPECT_FN, args.selector, args.props ?? null, !!args.all), null, 1); },
  },
  desktop_network: {
    description: "Журнал сетевых запросов с момента подключения: время, метод, URL, статус, длительность, размер, ошибка. " +
      "filter — подстрока/регулярка по URL; errors: true — только ошибки и статусы ≥400; limit (по умолчанию 40); " +
      "body: id запроса — вернуть тело ответа (до 20 КБ); clear: true — очистить журнал.",
    schema: { type: "object", properties: { filter: { type: "string" }, errors: { type: "boolean" }, limit: { type: "number" },
      body: { type: "string" }, clear: { type: "boolean" } } },
    run: async args => {
      await connect(args.window || 0);
      if (args.body) {
        const r = await cdp("Network.getResponseBody", { requestId: args.body });
        const text = r.base64Encoded ? `(бинарные данные, ${Math.round(r.body.length * 0.75)} байт)` : r.body;
        return text.length > 20000 ? text.slice(0, 20000) + "\n…(обрезано)" : text;
      }
      let re = null;
      if (args.filter) { try { re = new RegExp(args.filter, "i"); } catch (_) { re = null; } }
      let rows = [...netLog.values()].filter(r => !args.filter || (re ? re.test(r.url) : r.url.includes(args.filter)));
      if (args.errors) rows = rows.filter(r => r.error || r.status >= 400);
      rows = rows.slice(-(args.limit || 40)).map(({ t0, ...r }) => r);
      if (args.clear) netLog.clear();
      return rows.length ? JSON.stringify(rows, null, 1) : "(пусто)";
    },
  },
  desktop_reload: {
    description: "Перезагрузить страницу программы (hard: true — без кэша) и дождаться загрузки.",
    schema: { type: "object", properties: { hard: { type: "boolean" } } },
    run: async args => {
      await connect(args.window || 0);
      await cdp("Page.reload", { ignoreCache: !!args.hard });
      await new Promise(r => setTimeout(r, 1500));
      return "Перезагружено";
    },
  },
  desktop_click: {
    description: "Клик мышью по элементу: ref из desktop_snapshot, CSS-селектор или точный текст. double: true — двойной клик; right: true — правый.",
    schema: { type: "object", properties: { ref: { type: "number" }, selector: { type: "string" }, text: { type: "string" }, double: { type: "boolean" }, right: { type: "boolean" } } },
    run: async args => {
      await connect(args.window || 0);
      const pos = await centerOf(args);
      await click(pos, args.right ? "right" : "left", args.double ? 2 : 1);
      return `Клик (${Math.round(pos.x)}, ${Math.round(pos.y)})`;
    },
  },
  desktop_type: {
    description: "Ввод текста в поле (ref/selector) или в сфокусированный элемент. clear: true — сначала очистить поле.",
    schema: { type: "object", properties: { text: { type: "string" }, ref: { type: "number" }, selector: { type: "string" }, clear: { type: "boolean" } }, required: ["text"] },
    run: async args => {
      await connect(args.window || 0);
      if (args.ref != null || args.selector) await click(await centerOf(args));
      if (args.clear) { await press("A", 2); await press("Backspace"); }
      await cdp("Input.insertText", { text: args.text });
      return "Введено";
    },
  },
  desktop_key: {
    description: "Нажать клавишу: Enter, Escape, Tab, Backspace, ArrowDown… ctrl: true для Ctrl+клавиша.",
    schema: { type: "object", properties: { key: { type: "string" }, ctrl: { type: "boolean" } }, required: ["key"] },
    run: async args => { await connect(args.window || 0); await press(args.key, args.ctrl ? 2 : 0); return `Клавиша ${args.key}`; },
  },
  desktop_scroll: {
    description: "Прокрутка колёсиком на dy пикселей (вниз — положительное) в точке x,y (по умолчанию центр).",
    schema: { type: "object", properties: { dy: { type: "number" }, x: { type: "number" }, y: { type: "number" } }, required: ["dy"] },
    run: async args => {
      await connect(args.window || 0);
      const [w, h] = await evaluate("[innerWidth, innerHeight]");
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: args.x ?? w / 2, y: args.y ?? h / 2, deltaX: 0, deltaY: args.dy });
      return "Прокручено";
    },
  },
  desktop_eval: {
    description: "Выполнить JavaScript в странице и вернуть значение (для отладки: состояние, стили, getComputedStyle). Не для правки интерфейса — правки делаются в исходниках.",
    schema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
    run: async args => { await connect(args.window || 0); return JSON.stringify(await evaluate(args.expression)); },
  },
  desktop_console: {
    description: "Последние сообщения консоли, предупреждения браузера (CSP, сеть) и необработанные ошибки программы (копятся с момента первого подключения). " +
      "errors: true — только error/exception/warning; filter — подстрока; limit — последние N.",
    schema: { type: "object", properties: { clear: { type: "boolean" }, errors: { type: "boolean" }, filter: { type: "string" }, limit: { type: "number" } } },
    run: async args => {
      await connect(args.window || 0);
      let rows = consoleLog;
      if (args.errors) rows = rows.filter(l => /^\[(error|exception|warning|warn|assert)\]/.test(l));
      if (args.filter) rows = rows.filter(l => l.toLowerCase().includes(args.filter.toLowerCase()));
      if (args.limit) rows = rows.slice(-args.limit);
      const out = rows.join("\n") || "(пусто)";
      if (args.clear) consoleLog.length = 0;
      return out;
    },
  },
  desktop_sandbox: {
    description: "Песочница: подмена данных без похода на сервер. on: true — все изменяющие запросы (POST/PUT/PATCH/DELETE) " +
      "перестают уходить на сервер и получают {ok:true}, внизу окна плашка «Песочница ИИ». role: as-is | owner | admin | member — " +
      "смотреть программу глазами роли. reload (по умолчанию true при смене on/role) перезагружает страницу. " +
      "Без аргументов — состояние, моки и журнал перехваченных изменений (writes): так видно, какой запрос отправила бы кнопка. " +
      "Отключение агента снимает песочницу само.",
    schema: { type: "object", properties: { on: { type: "boolean" }, role: { type: "string", enum: Object.keys(ROLES) },
      perms: { type: "array", items: { type: "string" }, description: "права роли из матрицы (например у даббера), подставляются вместо списка /me/permissions" },
      reload: { type: "boolean" }, clear_writes: { type: "boolean" } } },
    run: async args => {
      await connect(args.window || 0);
      let changed = false;
      if (args.perms !== undefined && JSON.stringify(args.perms) !== JSON.stringify(sandbox.perms)) { sandbox.perms = args.perms; changed = true; }
      if (args.role && args.role !== sandbox.role) { sandbox.role = args.role; changed = true; }
      if (args.on != null && args.on !== sandbox.on) { sandbox.on = args.on; changed = true; }
      if (args.role && args.role !== "as-is" && !sandbox.on) { sandbox.on = true; changed = true; }
      if (args.clear_writes) sandbox.writes.length = 0;
      if (changed) {
        if (sandbox.on) await applySandbox();
        else { await dropSandbox(); sandbox.mocks.length = 0; sandbox.role = "as-is"; sandbox.perms = null; sandbox.writes.length = 0; }
        if (args.reload !== false) await reloadPage();
      }
      return sandboxStatus();
    },
  },
  desktop_mock: {
    description: "Подменить ответ API (включает песочницу). pattern — регулярка по пути после /api (например ^/board, ^/reports\\?). " +
      "Либо json — готовый ответ целиком, либо transform — JS-функция (data, path) => новый data (или просто её тело), " +
      "применяется к НАСТОЯЩЕМУ ответу сервера: размножить карточки, удлинить названия, сдвинуть сроки, обнулить списки. " +
      "method по умолчанию GET, \"*\" — любой. Новые моки главнее старых. reload: true — перезагрузить страницу.",
    schema: { type: "object", properties: {
      pattern: { type: "string" }, method: { type: "string" }, json: {}, transform: { type: "string" },
      status: { type: "number" }, reload: { type: "boolean" } }, required: ["pattern"] },
    run: async args => {
      await connect(args.window || 0);
      if ((args.json === undefined) === (args.transform === undefined)) throw new Error("Нужно ровно одно из: json или transform");
      const m = { id: sandbox.nextMock++, method: (args.method || "GET").toUpperCase(), re: new RegExp(args.pattern), status: args.status || 200, hits: 0 };
      if (args.json !== undefined) m.json = args.json;
      else {
        const body = args.transform.trim();
        // Принимаем и функцию целиком, и просто её тело.
        m.transform = /^(\(|async\b|function\b|[\w$]+\s*=>)/.test(body) ? new Function(`return (${body});`)() : new Function("data", "path", body);
      }
      sandbox.mocks.push(m);
      if (!sandbox.on) { sandbox.on = true; await applySandbox(); }
      if (args.reload) await reloadPage();
      return sandboxStatus();
    },
  },
  desktop_mock_clear: {
    description: "Убрать мок по id (из desktop_sandbox) или все моки, если id не указан. Песочница остаётся включённой.",
    schema: { type: "object", properties: { id: { type: "number" }, reload: { type: "boolean" } } },
    run: async args => {
      await connect(args.window || 0);
      if (args.id == null) sandbox.mocks.length = 0;
      else sandbox.mocks = sandbox.mocks.filter(m => m.id !== args.id);
      if (args.reload) await reloadPage();
      return sandboxStatus();
    },
  },
  desktop_viewport: {
    description: "Эмулировать размер окна (width×height в CSS-пикселях), чтобы проверить узкие и широкие раскладки. reset: true — вернуть настоящий размер.",
    schema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" }, reset: { type: "boolean" } } },
    run: async args => {
      await connect(args.window || 0);
      if (args.reset || !args.width) { await cdp("Emulation.clearDeviceMetricsOverride"); return "Размер сброшен"; }
      const [, h] = await evaluate("[innerWidth, innerHeight]");
      await cdp("Emulation.setDeviceMetricsOverride", { width: args.width, height: args.height || h, deviceScaleFactor: 0, mobile: false });
      return `Окно ${args.width}×${args.height || h}`;
    },
  },
  desktop_theme: {
    description: "Временно переключить тему окна (light | dark) без сохранения в настройках — чтобы проверить обе.",
    schema: { type: "object", properties: { theme: { type: "string", enum: ["light", "dark"] } }, required: ["theme"] },
    run: async args => {
      await connect(args.window || 0);
      await callInPage("function (t) { document.documentElement.dataset.theme = t; }", args.theme);
      return `Тема ${args.theme} (до перезагрузки)`;
    },
  },
};

// ---------- MCP по stdio ----------
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "project-desktop", version: "1.0.0" } } });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) } });
  }
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Нет инструмента ${params?.name}` } });
    try {
      const out = await tool.run(params.arguments || {});
      const content = out && out.image ? [{ type: "image", data: out.image, mimeType: out.mime || "image/png" }] : [{ type: "text", text: String(out) }];
      return send({ jsonrpc: "2.0", id, result: { content } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message }] } });
    }
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Метод ${method} не поддерживается` } });
}

// Агент отключился штатно — снимаем плашку песочницы (перехват браузер снимет сам вместе с сеансом).
process.stdin.on("end", async () => {
  if (sandbox.on && ws) await dropSandbox().catch(() => {});
  process.exit(0);
});

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line)).catch(e => process.stderr.write(String(e) + "\n"));
  }
});
