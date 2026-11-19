
import { state } from "./state.js";

function storageKey() {
  return `project_favorites_${state.telegramId || "anon"}`;
}

function readSet() {
  try {
    const raw = localStorage.getItem(storageKey());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (_) {
    return new Set();
  }
}

function writeSet(set) {
  try { localStorage.setItem(storageKey(), JSON.stringify([...set])); } catch (_) { }
}

export function isFavorite(publicId) {
  return readSet().has(publicId);
}

export function toggleFavorite(publicId) {
  const set = readSet();
  const on = !set.has(publicId);
  if (on) set.add(publicId); else set.delete(publicId);
  writeSet(set);
  return on;
}

export function favoriteIds() {
  return readSet();
}
