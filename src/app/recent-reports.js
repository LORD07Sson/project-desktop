// Недавно открытые отчёты — MRU-список для командной палитры (тот же
// приём, что "Recent Files" в VS Code/Raycast): открыв карточку через
// поиск в палитре один раз, во второй заход не нужно снова набирать
// номер — она уже наверху списка с пустым запросом. История хранится
// только локально.

import { state } from "./state.js";
import { apiGet } from "./api.js";

const MAX_RECENT = 8;

function storageKey() {
  return `project_recent_reports_${state.telegramId || "anon"}`;
}

function readList() {
  try {
    const raw = localStorage.getItem(storageKey());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function writeList(list) {
  try { localStorage.setItem(storageKey(), JSON.stringify(list.slice(0, MAX_RECENT))); } catch (_) { /* не критично */ }
}

// Вызывается из report-detail.js при каждом успешном открытии карточки —
// последний открытый уходит в начало, дубликаты убираются, а не копятся.
export function recordRecentReport(publicId, title) {
  if (!publicId) return;
  const list = readList().filter(x => x.publicId !== publicId);
  list.unshift({ publicId, title: title || "" });
  writeList(list);
}

export function recentReports() {
  return readList();
}

// Отчёт удалён (или доступ к нему сняли) — из истории его убираем, иначе палитра
// так и показывала бы «мёртвые» карточки, которые не открываются.
export function forgetRecentReport(publicId) {
  writeList(readList().filter(x => x.publicId !== publicId));
}

// Проверка истории на сервере: каждый отчёт — не чаще раза в 5 минут за сеанс.
// Возвращает true, если что-то убрали. Сетевые сбои ничего не удаляют.
const checkedAt = new Map();
export async function pruneRecentReports() {
  const now = Date.now();
  const todo = readList().filter(x => !(now - (checkedAt.get(x.publicId) || 0) < 5 * 60 * 1000));
  const gone = [];
  await Promise.all(todo.map(async x => {
    try {
      await apiGet(`/report/${encodeURIComponent(x.publicId)}`);
      checkedAt.set(x.publicId, Date.now());
    } catch (e) {
      if (e.status === 404 || e.status === 403) gone.push(x.publicId);
    }
  }));
  gone.forEach(forgetRecentReport);
  return gone.length > 0;
}
