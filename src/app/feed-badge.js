
import { apiGet } from "./api.js";
import { state, can } from "./state.js";

const POLL_INTERVAL_MS = 60_000;

function lastSeenKey() {
  return `project_feed_last_seen_${state.telegramId || "anon"}`;
}
function getLastSeen() {
  try { return localStorage.getItem(lastSeenKey()) || ""; } catch (_) { return ""; }
}
export function getFeedLastSeen() { return getLastSeen(); }
function setLastSeen(ts) {
  try { localStorage.setItem(lastSeenKey(), ts); } catch (_) { }
}

function renderBadge(count) {
  const btn = document.querySelector('.tab-btn[data-tab="feed"]');
  if (!btn) return;
  let badge = btn.querySelector(".tab-badge");
  if (!count) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    btn.appendChild(badge);
  }
  badge.textContent = count > 9 ? "9+" : String(count);
}

export function markFeedSeen(latestTimestamp) {
  if (latestTimestamp) setLastSeen(latestTimestamp);
  renderBadge(0);
}

export function resetFeedBadge() {
  renderBadge(0);
}

async function pollFeed() {
  if (!state.token || !can("reports.feed")) return;
  if (state.activeTab === "feed") return;
  try {
    const r = await apiGet("/feed", { offset: 0, page_size: 30 });
    const events = r.events || [];
    const lastSeen = getLastSeen();
    if (!lastSeen) {
      if (events[0]) setLastSeen(events[0].created_at);
      return;
    }
    const freshCount = events.filter(e => e.created_at > lastSeen).length;
    renderBadge(freshCount);
  } catch (_) { }
}

setInterval(pollFeed, POLL_INTERVAL_MS);
pollFeed();
