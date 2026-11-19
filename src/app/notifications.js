
import { state } from "./state.js";
import { apiGet } from "./api.js";

let knownAssigned = null;
const POLL_INTERVAL_MS = 60_000;

function seenKey() { return `project_me_seen_reports_${state.telegramId || "anon"}`; }
function getSeen() {
  try {
    const raw = localStorage.getItem(seenKey());
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch (_) { return null; }
}
function setSeen(ids) {
  try { localStorage.setItem(seenKey(), JSON.stringify([...ids])); } catch (_) { }
}

function renderMeBadge(count) {
  const btn = document.querySelector('.tab-btn[data-tab="profile"]');
  if (!btn) return;
  let badge = btn.querySelector(".tab-badge");
  if (!count) { if (badge) badge.remove(); btn.title = "Я"; return; }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    btn.appendChild(badge);
  }
  badge.textContent = count > 9 ? "9+" : String(count);
  btn.title = `Я — новых назначений: ${count}`;
}

export function markMyReportsSeen(ids) {
  const all = new Set([...(getSeen() || []), ...(ids || []), ...(knownAssigned || [])]);
  setSeen(all);
  renderMeBadge(0);
}

function updateMeBadge(ids) {
  if (state.activeTab === "profile") { markMyReportsSeen(ids); return; }
  const seen = getSeen();
  if (!seen) { setSeen(ids); renderMeBadge(0); return; }
  renderMeBadge([...ids].filter(id => !seen.has(id)).length);
}

export function resetAssignmentsBaseline() {
  knownAssigned = null;
  renderMeBadge(0);
}

async function pollAssignments() {
  if (!state.token) return;
  try {
    const r = await apiGet("/me/queue");
    const ids = new Set((r.items || []).map(x => x.public_id));
    knownAssigned = ids;
    updateMeBadge(ids);
  } catch (_) { }
}

pollAssignments();
setInterval(pollAssignments, POLL_INTERVAL_MS);
