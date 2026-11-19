
export const state = {
  softReload: false,
  token: null,
  telegramId: null,
  name: null,
  mediaToken: null,
  mediaTokenExpiresAt: 0,
  reports: [],
  total: 0,
  sort: { field: "public_id", dir: "asc" },
  selected: new Set(),
  statusOptions: [
    ["draft", "Черновик"],
    ["review", "Озвучка"],
    ["revision", "Перезапись/дозапись"],
    ["working", "В работе"],
    ["completed", "Завершено"],
    ["cancelled", "Отменено"],
  ],
  users: [],
  quickFilter: null,
  activeTab: "overview",
  loadedTabs: new Set(),
  titleSeasonId: null,
  isDeveloper: null,
  isAdmin: true,
  previewRole: (() => { try { return sessionStorage.getItem("preview-role") || null; } catch (_) { return null; } })(),
  previewChoices: null,
};

export function can(key) {
  return state.perms ? state.perms.has(key) : !!state.isAdmin;
}

export function resetSessionState() {
  state.perms = null;
  state.token = null;
  state.isAdmin = true;
  state.telegramId = null;
  state.name = null;
  state.mediaToken = null;
  state.mediaTokenExpiresAt = 0;
  state.reports = [];
  state.total = 0;
  state.selected.clear();
  state.users = [];
  state.quickFilter = null;
  state.loadedTabs.clear();
  state.titleSeasonId = null;
  state.isDeveloper = null;
  delete document.documentElement.dataset.dev;
}
