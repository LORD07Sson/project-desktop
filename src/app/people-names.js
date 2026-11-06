// Единые имена и понятные подписи событий. Сервер в ленте и рейтингах отдаёт @username, а карточки команды — отображаемое имя,
// поэтому один человек выглядел по-разному. Здесь события и строки приводятся к имени из /team.

import { apiGet } from "./api.js";

const ACTIONS = {
  a365_upload: "залито на Anime 365", a365_reupload: "перезалито на Anime 365", a365_enqueue: "поставлено в очередь на Anime 365",
  a365_reupload_enqueue: "поставлено на перезаливку на Anime 365", a365_cancel: "заливка на Anime 365 отменена",
  a365_bind: "тайтл привязан к Anime 365", a365_manual: "перевод добавлен на Anime 365 вручную",
  approve_request: "заявка одобрена", grant_access: "доступ выдан", revoke_access: "доступ отозван",
  permissions_set: "изменены права", role_create: "создана роль", role_delete: "удалена роль",
  delete_report: "отчёт удалён", trash_restore: "восстановлено из корзины", lockdown_on: "включена блокировка", lockdown_off: "снята блокировка",
  assemble_start: "запущена сборка финала", assemble_cancel: "сборка финала отменена", assemble_profile: "изменён профиль сборки",
  autopost_publish: "опубликован автопост", autopost_undo: "автопост отменён", local_render: "финал собран локально",
  speed_limits: "изменены лимиты скорости", logs_clean: "логи очищены", logs_settings: "изменены настройки логов",
  bot_chat_settings: "изменены настройки чатов бота", title_intro: "изменена заставка тайтла",
  report_file_send: "файл отчёта отправлен", report_torrent: "добавлен торрент отчёта",
};

// Код действия вида a365_upload → русская подпись; обычный текст не трогаем.
export function actionLabel(action) {
  const raw = String(action || "").trim();
  if (!/^[a-z0-9_]+$/.test(raw)) return raw;
  if (ACTIONS[raw]) return ACTIONS[raw];
  if (raw.startsWith("archive_") || raw.includes("archive")) return "изменены настройки архива";
  return "служебное действие";
}

let names = null;
let at = 0;

export async function loadPeopleNames() {
  if (names && Date.now() - at < 600000) return names;
  try {
    const d = await apiGet("/team");
    names = new Map((d.users || []).map(u => [String(u.telegram_id), u.name]));
    at = Date.now();
  } catch (_) { names = names || new Map(); }
  return names;
}

export const personName = (telegramId, fallback) => (names && telegramId != null && names.get(String(telegramId))) || fallback;

// Лента: имя автора и подпись действия. Возвращает те же объекты, чтобы не копировать длинные списки.
export function humanizeEvents(events) {
  for (const ev of events || []) {
    ev.actor = personName(ev.actor_telegram_id, ev.actor);
    ev.action = actionLabel(ev.action);
  }
  return events;
}
