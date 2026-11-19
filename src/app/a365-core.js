
export function kindOf(it) {
  if (it.stage === "done") return it.newer ? "newer" : "done";
  if (it.stage === "queued" || it.stage === "uploading") return "queue";
  if (it.twin) return "elsewhere";
  if (it.stage === "failed" && !(it.check && it.check.dup)) return "bad";
  if (!it.check) return it.unbound ? "unbound" : "unchecked";
  if (!it.check.ok && it.check.dup) return "elsewhere";
  if (it.unbound) return "unbound";
  return it.check.ok ? "ready" : "bad";
}

export const isOn365 = it => ["done", "newer", "elsewhere"].includes(kindOf(it));

export function summarize(items) {
  const n = { on: 0, newer: 0, ready: 0, queue: 0, bad: 0, unbound: 0, unchecked: 0 };
  for (const it of items) {
    const k = kindOf(it);
    if (k === "done" || k === "elsewhere") n.on++;
    else n[k]++;
  }
  const segments = [["on", "На 365"], ["newer", "Новая версия"], ["ready", "Можно залить"], ["queue", "В очереди"],
    ["bad", "Проблемы"], ["unbound", "Не привязано"], ["unchecked", "Не проверено"]]
    .map(([key, label]) => ({ key, label, count: n[key] }))
    .filter(s => s.count > 0);
  return { total: items.length, onSite: n.on + n.newer, segments, ...n };
}

export function checkFacts(lines) {
  return (lines || []).map(line => {
    const raw = String(line);
    const warn = raw.includes("⚠");
    const text = raw.replace(/[✅⚠️]/gu, "").trim();
    if (/^Нашей озвучки .* нет$/.test(text)) return { text: "Дубля нет", tone: "ok" };
    const season = text.match(/^Сезон: (.+?)(?: — совпадает)?$/);
    if (season) return { text: `Сезон ${season[1]}`, tone: "ok" };
    const episode = text.match(/^Серия: (.+)$/);
    if (episode) return { text: `Серия ${episode[1]}`, tone: "ok" };
    return { text, tone: warn ? "warn" : "ok" };
  }).filter(f => f.text);
}

export const sameTitle = (a, b) =>
  String(a || "").trim().toLowerCase().replace(/\s+/g, " ") === String(b || "").trim().toLowerCase().replace(/\s+/g, " ");

const GROUPS = [["ready", "Можно заливать"], ["newer", "Есть новая версия"], ["queue", "В очереди"], ["bad", "Нужно разобраться"],
  ["unchecked", "Ещё не проверено"], ["unbound", "Не привязано"], ["on", "На 365"]];

export function groupItems(items) {
  const groupOf = it => { const k = kindOf(it); return k === "done" || k === "elsewhere" ? "on" : k; };
  return GROUPS.map(([key, title]) => ({ key, title, items: items.filter(it => groupOf(it) === key) }))
    .filter(g => g.items.length);
}
