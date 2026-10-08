// Соглашение о неразглашении при первом входе. Чистая часть: ключи и
// проверка принятия — без DOM, чтобы проверять node-тестом.

export const NDA_VERSION = "1";

export const NDA_TEXT = [
  "Материалы студии — видео, звук, переводы, сценарии и планы выхода серий — не предназначены для посторонних.",
  "Я обязуюсь не публиковать, не пересылать и не показывать их третьим лицам без разрешения студии до официального выхода.",
  "Я понимаю, что действия в программе записываются в журнал, а доступ может быть закрыт в любой момент.",
  "Это соглашение действует и после окончания работы со студией.",
];

export const ndaKey = telegramId => `project-nda-v${NDA_VERSION}-${telegramId}`;

export function ndaAccepted(storage, telegramId) {
  if (!telegramId) return true; // нет пользователя — спрашивать нечего
  try { return !!storage.getItem(ndaKey(telegramId)); } catch (_) { return false; }
}

export function acceptNda(storage, telegramId, now = new Date()) {
  try { storage.setItem(ndaKey(telegramId), now.toISOString()); return true; } catch (_) { return false; }
}
