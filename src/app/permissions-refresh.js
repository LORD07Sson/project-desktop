// Права матрицы могут измениться независимо от входа. Перечитываем их
// при старте и при общем обновлении (F5 / кнопка «Обновить»).

import { api } from "./api.js";
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
