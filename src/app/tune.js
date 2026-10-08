// Применение «своей темы» (tune-core.js): значения хранятся в
// localStorage и накладываются на :root сразу при загрузке.

import { normalizeTune, tuneVars, isDefaultTune, TUNE_DEFAULT } from "./tune-core.js";

const KEY = "project-tune";

export function currentTune() {
  try { return normalizeTune(JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (_) { return { ...TUNE_DEFAULT }; }
}

export function applyTune(t) {
  const tune = normalizeTune(t);
  const root = document.documentElement.style;
  const vars = tuneVars(tune);
  if (isDefaultTune(tune)) Object.keys(vars).forEach(k => root.removeProperty(k));
  else Object.entries(vars).forEach(([k, v]) => root.setProperty(k, v));
  try { localStorage.setItem(KEY, JSON.stringify(tune)); } catch (_) { /* не запомнится */ }
  return tune;
}

applyTune(currentTune());
