// Адрес сервера живёт только в server.json: проверяем, что CSP его пропускает (картинки и запросы к API) и что
// в коде не осталось другого адреса сервера, вписанного руками (например, старого после переезда).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const { origin } = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));
assert.match(origin, /^https:\/\/[^/]+$/, "server.json: origin — https://домен[:порт] без пути");

const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
for (const key of ["csp", "devCsp"]) {
  const csp = conf.app.security[key];
  for (const dir of ["img-src", "connect-src"]) {
    const rule = csp.split(";").map(s => s.trim()).find(s => s.startsWith(`${dir} `)) || "";
    assert.ok(rule.split(/\s+/).includes(origin), `${key}: ${dir} не пускает ${origin} — запустите npm run set-server -- ${origin}`);
  }
}

// Старый адрес или любой другой сервер с «/api», вписанный в код вместо server.json.
const files = [];
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|jsx|mjs|rs|html)$/.test(e.name)) files.push(p);
  }
};
walk(path.join(root, "src"));
walk(path.join(root, "src-tauri/src"));
const host = new URL(origin).hostname;
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  assert.ok(!text.includes(host), `${path.relative(root, f)}: адрес сервера вписан руками — берите его из server.json`);
}
console.log(`server-origin-test: ok (${origin})`);
