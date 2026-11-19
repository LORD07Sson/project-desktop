
import { state } from "./state.js";
import { apiPost } from "./api.js";

const PING_INTERVAL_MS = 60_000;

export async function pingPresence() {
  if (!state.token) return;
  try { await apiPost("/presence/ping", {}); } catch (_) { }
}

pingPresence();
setInterval(pingPresence, PING_INTERVAL_MS);
