// Предзагрузка следующей серии в плеере «Смотреть»: за пару минут до конца
// заранее получаем список озвучек и ссылки на видео следующей серии, чтобы
// переход не ждал два запроса к серверу. Чистая часть — выбор озвучки и
// проверка свежести кеша; запросы делает player-anime.js.

export const PRELOAD_LEFT_SEC = 150;      // за сколько до конца начинать
export const PRELOAD_TTL_MS = 6 * 60_000; // ссылки на видео живут недолго

/** Озвучка для следующей серии: та же команда (authors), иначе первая. */
export function pickSameVoice(translations, authors) {
  const voices = (translations || []).filter(t => t.kind === "voice" || t.kind === "raw");
  if (!voices.length) return null;
  return (authors && voices.find(t => t.authors === authors)) || voices[0];
}

/** Подходит ли кеш для серии episodeId сейчас. */
export function preloadFresh(pre, episodeId, now = Date.now()) {
  return !!pre && pre.episodeId === episodeId && now - pre.at < PRELOAD_TTL_MS && !!pre.sources;
}

/** Пора ли начинать: до конца осталось мало, но видео уже идёт и это не последняя серия. */
export function shouldPreload({ left, duration, hasNext, alreadyFor, nextId }) {
  if (!hasNext || !duration || duration < 60) return false;
  if (alreadyFor === nextId) return false;
  return left > 0 && left <= PRELOAD_LEFT_SEC;
}

// Стартовый буфер: показ начинается, когда впереди загружено 30 секунд.
export const START_BUFFER_SEC = 30;
export const START_BUFFER_MAX_WAIT_MS = 25_000; // на медленном интернете не держим дольше

/** Сколько секунд загружено впереди позиции t. buffered — как у <video>: length, start(i), end(i). */
export function bufferedAhead(buffered, t) {
  for (let i = 0; i < (buffered ? buffered.length : 0); i++) {
    if (buffered.start(i) <= t + 0.5 && t <= buffered.end(i)) return Math.max(0, buffered.end(i) - t);
  }
  return 0;
}

/** Можно ли начинать: буфер набран, файл загружен до конца, браузер сам приостановил загрузку или вышло время. */
export function startBufferReady({ ahead, left, suspended, waitedMs }) {
  return ahead >= START_BUFFER_SEC || (left > 0 && ahead >= left - 0.5) || suspended || waitedMs >= START_BUFFER_MAX_WAIT_MS;
}
