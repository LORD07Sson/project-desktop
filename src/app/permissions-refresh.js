// Права матрицы могут измениться независимо от входа. Перечитываем их
// при старте и при общем обновлении (F5 / кнопка «Обновить»).

import { api, toast } from "./api.js";
import { state } from "./state.js";
import { startPermVisibility } from "./perm-visibility.js";

export async function refreshPermissions() {
  try {
    const r = await api("GET", "/me/permissions");
    // Старый сервер не отдавал список — сохраняем прежнее поведение.
    state.perms = Array.isArray(r.permissions) ? new Set(r.permissions) : null;
    state.isOwner = !!r.is_owner;

    if (state.perms) {
      state.nyaaAccess = state.isAdmin || state.perms.has("nyaa.view");
      document.documentElement.dataset.nyaa = state.isAdmin ? "0" : state.nyaaAccess ? "1" : "0";
      startPermVisibility();
    }
    return true;
  } catch (_) {
    // При временном сбое оставляем последний успешно загруженный набор прав.
    return false;
  }
}

// Владелец меняет роли и матрицу прав, пока у человека открыта программа. Раньше новые права
// доходили только после перезапуска или F5: даббер не видел выданную вкладку, а снятую — видел
// до ошибки 403. Раз в минуту (и при возврате в окно) перечитываем роль и права; изменилось —
// перерисовываем видимость и уходим с вкладки, которая стала недоступна.
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
    return; // нет связи — оставляем как есть
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
  if (pollTimer) return; // applyRole зовёт это и из самого опроса — базу сравнения тогда не трогаем
  lastSig = signature();
  pollTimer = setInterval(pollPermissions, POLL_MS);
  window.addEventListener("focus", pollPermissions);
}
