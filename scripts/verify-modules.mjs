
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";
import path from "node:path";

const distDir = path.resolve(import.meta.dirname, "..", "dist");
let html;
try {
  html = readFileSync(path.join(distDir, "index.html"), "utf8");
} catch {
  console.error("dist/index.html не найден — сначала соберите: npm run build");
  process.exit(1);
}

const scriptMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
if (!scriptMatch) {
  console.error("В dist/index.html не нашёлся <script type=\"module\" src=\"...\">.");
  process.exit(1);
}
const entryPath = path.join(distDir, scriptMatch[1].replace(/^\.\//, ""));

const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("localStorage", dom.window.localStorage);
setGlobal("navigator", dom.window.navigator);
setGlobal("Image", dom.window.Image);
setGlobal("MutationObserver", dom.window.MutationObserver);
setGlobal("requestAnimationFrame", dom.window.requestAnimationFrame || (cb => setTimeout(cb, 0)));
setGlobal("fetch", async () => { throw new Error("fetch недоступен в проверке — это нормально, сеть не нужна для проверки импортов"); });

dom.window.__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
  unregisterCallback: () => {},
  convertFileSrc: p => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

await import(pathToFileURL(entryPath).href);

console.log(`OK: собранный бандл (${path.relative(distDir, entryPath)}) импортируется и выполняется без ошибок.`);
process.exit(0);
