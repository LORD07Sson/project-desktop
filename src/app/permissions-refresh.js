
import { api, toast } from "./api.js";
import { state } from "./state.js";
import { startPermVisibility } from "./perm-visibility.js";
import { syncPreview } from "./role-preview.js";

// A failed load (server restarting, network blip) must not leave tabs that need a permission hidden until the
// minute-long poll: keep the last known list and retry soon, backing off, until the server answers.
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
let retryTimer = null;
let retryStep = 0;

function scheduleRetry() {
  if (retryTimer || !state.token) return;
  const wait = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
  retryStep++;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (state.token) await refreshPermissions();
  }, wait);
}

export async function refreshPermissions() {
  try {
    const r = await api("GET", "/me/permissions");
    state.perms = Array.isArray(r.permissions) ? new Set(r.permissions) : null;
    state.isOwner = !!r.is_owner;
    syncPreview(r.preview);

    if (state.perms) {
      state.nyaaAccess = state.isAdmin || state.perms.has("nyaa.view");
      document.documentElement.dataset.nyaa = state.isAdmin ? "0" : state.nyaaAccess ? "1" : "0";
      startPermVisibility();
    }
    retryStep = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    return true;
  } catch (_) {
    scheduleRetry();
    return false;
  }
}

const POLL_MS = 60_000;
let pollTimer = null;
let lastSig = null;
const signature = () => `${state.isAdmin ? 1 : 0}|${state.perms ? [...state.perms].sort().join(",") : "*"}`;

async function pollPermissions() {
  if (!state.token || document.hidden) return;
  try {
    const who = await api("GET", "/whoami");
    const isAdmin = !!who.is_admin;
    if (isAdmin !== !!state.isAdmin) {
      const { applyRole } = await import("./auth.js");
      await applyRole(isAdmin, !!who.nyaa_access);
    } else if (!(await refreshPermissions())) return;
  } catch (_) {
    return;
  }
  const sig = signature();
  if (lastSig !== null && sig !== lastSig) {
    const { tabAllowed, switchTab } = await import("./tabs.js");
    if (state.activeTab && !tabAllowed(state.activeTab)) switchTab("queue");
    toast("Права обновлены: владелец изменил вашу роль или доступы", "info");
  }
  lastSig = sig;
}

export function startPermissionsPolling() {
  if (pollTimer) return;
  lastSig = signature();
  pollTimer = setInterval(pollPermissions, POLL_MS);
  window.addEventListener("focus", pollPermissions);
}
