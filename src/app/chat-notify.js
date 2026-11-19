
import { state } from "./state.js";
import { apiGet } from "./api.js";
import { notifyDesktop } from "./desktop-notify.js";

const POLL_MS = 20_000;
const MAX_SINGLE = 3;

function muteKey() { return `project_chat_muted_${state.telegramId || "anon"}`; }

export function mutedChats() {
  try {
    const list = JSON.parse(localStorage.getItem(muteKey()) || "[]");
    return new Set(Array.isArray(list) ? list : []);
  } catch (_) { return new Set(); }
}

export function isChatMuted(id, channelId) {
  const muted = mutedChats();
  return muted.has(id) || (channelId != null && muted.has(`c:${channelId}`));
}

export function setChatMuted(id, on) {
  const muted = mutedChats();
  if (on) muted.add(id); else muted.delete(id);
  try { localStorage.setItem(muteKey(), JSON.stringify([...muted])); } catch (_) { }
  document.dispatchEvent(new CustomEvent("chat-mute-changed", { detail: { id, on } }));
}

let lastSeen = null;

function flatten(d) {
  const chats = (d.chats || []).map(c => ({ ...c, label: c.kind === "dm" ? `Сообщение от ${c.title}` : c.title }));
  const topics = (d.channels || []).flatMap(ch => (ch.topics || []).map(t => ({ ...t, channel_id: ch.id, label: `${ch.name} › ${t.title}` })));
  return chats.concat(topics);
}

function preview(c) {
  const l = c.last;
  const body = l.text || (l.attach ? `📎 ${l.attach.kind === "image" ? "картинка" : l.attach.name || "файл"}` : "");
  const line = c.kind === "dm" ? body : `${l.author}: ${body}`;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function updateNavBadge(all) {
  const btn = document.querySelector('.tab-btn[data-tab="messages"]');
  if (!btn) return;
  const n = all.reduce((s, c) => s + (c.unread || 0), 0);
  let b = btn.querySelector(".tab-badge");
  if (!n) { b?.remove(); return; }
  if (!b) { b = document.createElement("span"); b.className = "tab-badge"; btn.appendChild(b); }
  b.textContent = n > 99 ? "99+" : String(n);
}

async function poll() {
  if (!state.token) return;
  let d;
  try { d = await apiGet("/chats"); } catch (_) { return; }
  const all = flatten(d);
  updateNavBadge(all);
  const first = lastSeen === null;
  const prev = lastSeen || new Map();
  lastSeen = new Map(all.map(c => [c.id, c.last ? c.last.id : 0]));
  if (first) return;

  const fresh = all.filter(c => c.last && !c.last.mine && c.last.kind !== "deleted" && c.unread > 0
    && c.last.id > (prev.get(c.id) || 0));
  const shown = fresh
    .map(c => ({ c, mention: c.kind !== "dm" && c.mentions > 0 }))
    .filter(({ c, mention }) => mention || !isChatMuted(c.id, c.channel_id))
    .map(({ c, mention }) => ({ c, kind: c.kind === "dm" ? "chat" : mention ? "at" : "chatmsg" }));
  if (!shown.length) return;
  if (shown.length <= MAX_SINGLE) {
    for (const { c, kind } of shown) notifyDesktop(kind === "at" ? `@ Вас упомянули · ${c.label}` : c.label, preview(c), kind);
    return;
  }
  notifyDesktop("Project — новые сообщения", `Бесед с новыми сообщениями: ${shown.length}. ${shown[0].c.label}: ${preview(shown[0].c)}`, "chatmsg");
}

export function resetChatNotifyBaseline() { lastSeen = null; }

poll();
setInterval(poll, POLL_MS);
