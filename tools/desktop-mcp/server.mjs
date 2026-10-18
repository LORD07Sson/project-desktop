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
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleLog.push(`[exception] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    }
  };
  ws.onclose = () => { ws = null; };
  await cdp("Runtime.enable");
  await cdp("Page.enable");
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
const SNAPSHOT_JS = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  document.querySelectorAll("[data-mcp-ref]").forEach(e => e.removeAttribute("data-mcp-ref"));
  const sel = 'button, a[href], input, select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [data-open], [data-tab], [onclick], summary, label';
  const items = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    el.setAttribute("data-mcp-ref", ++n);
    items.push({ ref: n, tag: el.tagName.toLowerCase(), type: el.type || undefined, text, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), disabled: el.disabled || undefined, checked: el.checked ?? undefined });
  }
  const body = (document.querySelector("main, #app, body").innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 6000);
  return { title: document.title, url: location.href, viewport: [innerWidth, innerHeight], scrollY: Math.round(scrollY), elements: items, text: body };
})()`;

async function centerOf(args) {
  const expr = args.ref != null
    ? `document.querySelector('[data-mcp-ref="${Number(args.ref)}"]')`
    : args.selector
      ? `document.querySelector(${JSON.stringify(args.selector)})`
      : `[...document.querySelectorAll("button, a, [role=button], [role=tab], summary, label, li, div, span")].filter(e => (e.innerText || "").trim() === ${JSON.stringify(args.text || "")} && e.getBoundingClientRect().width > 0).sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0]`;
  const pos = await evaluate(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!pos) throw new Error("Элемент не найден (ref/selector/text). Сначала desktop_snapshot.");
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

const TOOLS = {
  desktop_status: {
    description: "Список окон программы, доступных по отладочному порту. Если ошибка — программа запущена не через scripts/debug-launch.ps1.",
    schema: { type: "object", properties: {} },
    run: async () => JSON.stringify((await listTargets()).map((t, i) => ({ index: i, title: t.title, url: t.url })), null, 1),
  },
  desktop_screenshot: {
    description: "Скриншот окна программы (PNG). Это реальная картинка, а не догадка по коду.",
    schema: { type: "object", properties: { window: { type: "number", description: "Номер окна из desktop_status, по умолчанию 0" } } },
    run: async args => {
      await connect(args.window || 0);
      const r = await cdp("Page.captureScreenshot", { format: "png" });
      return { image: r.data };
    },
  },
  desktop_snapshot: {
    description: "Видимые интерактивные элементы с номерами ref, их координаты и текст страницы. По ref работают desktop_click и desktop_type.",
    schema: { type: "object", properties: { window: { type: "number" } } },
    run: async args => { await connect(args.window || 0); return JSON.stringify(await evaluate(SNAPSHOT_JS)); },
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
    description: "Последние сообщения консоли и необработанные ошибки программы (копятся с момента первого подключения).",
    schema: { type: "object", properties: { clear: { type: "boolean" } } },
    run: async args => { await connect(args.window || 0); const out = consoleLog.join("\n") || "(пусто)"; if (args.clear) consoleLog.length = 0; return out; },
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
      const content = out && out.image ? [{ type: "image", data: out.image, mimeType: "image/png" }] : [{ type: "text", text: String(out) }];
      return send({ jsonrpc: "2.0", id, result: { content } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message }] } });
    }
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Метод ${method} не поддерживается` } });
}

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
