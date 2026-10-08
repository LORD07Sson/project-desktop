// Хранилище кеша дорожек в IndexedDB (Blob). Любая ошибка хранилища —
// просто «кеша нет»: плеер тогда качает файл как раньше.

import { addEntry } from "./audio-cache-core.js";

const DB = "project-audio-cache";
const STORE = "files";
const INDEX_KEY = "project-audio-cache-index";

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("нет IndexedDB")); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out && out.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const readIndex = () => { try { return JSON.parse(localStorage.getItem(INDEX_KEY) || "[]"); } catch (_) { return []; } };
const writeIndex = list => { try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch (_) { /* не запомнится */ } };

export async function getCached(key) {
  try {
    const db = await open();
    const blob = await run(db, "readonly", s => s.get(key));
    db.close();
    if (!blob) return null;
    const idx = readIndex().map(e => (e.key === key ? { ...e, at: Date.now() } : e));
    writeIndex(idx);
    return blob;
  } catch (_) { return null; }
}

export async function putCached(key, blob) {
  try {
    const { index, evict } = addEntry(readIndex(), { key, size: blob.size, at: Date.now() });
    if (!index.some(e => e.key === key)) return;
    const db = await open();
    await run(db, "readwrite", s => { s.put(blob, key); evict.forEach(k => s.delete(k)); });
    db.close();
    writeIndex(index);
  } catch (_) { /* не вышло — не страшно */ }
}

export async function clearCache() {
  try {
    const db = await open();
    await run(db, "readwrite", s => s.clear());
    db.close();
    writeIndex([]);
  } catch (_) { /* нечего чистить */ }
}

export function cacheSummary() {
  const idx = readIndex();
  return { files: idx.length, bytes: idx.reduce((s, e) => s + e.size, 0) };
}
