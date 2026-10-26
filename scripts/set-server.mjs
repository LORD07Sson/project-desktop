// Смена адреса сервера: npm run set-server -- https://новый.домен[:порт]
// Пишет его в server.json (оттуда берут адрес интерфейс и Rust при сборке) и заменяет старый адрес в CSP
// src-tauri/tauri.conf.json — CSP статичная, сборка Tauri берёт её из файла как есть.
import fs from "node:fs";

const next = String(process.argv[2] || "").trim().replace(/\/+$/, "");
let url;
try { url = new URL(next); } catch { url = null; }
if (!url || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
  console.error("Укажите адрес вида https://домен или https://домен:порт — без пути в конце.");
  process.exit(1);
}

const serverPath = new URL("../server.json", import.meta.url);
const confPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const server = JSON.parse(fs.readFileSync(serverPath, "utf8"));
const prev = server.origin;
if (prev === url.origin) {
  console.log(`Уже стоит ${prev} — ничего не меняю.`);
  process.exit(0);
}

const conf = fs.readFileSync(confPath, "utf8");
const count = conf.split(prev).length - 1;
if (!count) {
  console.error(`В tauri.conf.json нет старого адреса ${prev} — проверьте CSP вручную.`);
  process.exit(1);
}
fs.writeFileSync(confPath, conf.split(prev).join(url.origin));
server.origin = url.origin;
fs.writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(`Готово: ${prev} → ${url.origin} (server.json и ${count} мест в CSP). Дальше: npm test, коммит, пуш.`);
