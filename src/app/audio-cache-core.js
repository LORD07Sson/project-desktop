// Локальный кеш прослушанных дорожек: повторное открытие серии не качает
// файл заново, а прослушанное работает без связи с сервером. Чистая часть —
// учёт записей и выбор, что выкинуть, когда место кончилось (самые давно
// открытые уходят первыми). Само хранилище — audio-cache.js.

export const MAX_FILES = 12;
export const MAX_BYTES = 400 * 1024 * 1024;

/**
 * @param {{key:string,size:number,at:number}[]} index записи кеша
 * @param {{key:string,size:number,at:number}} entry новая запись (или обновление старой)
 * @returns {{index: object[], evict: string[]}} новый список и ключи на удаление
 */
export function addEntry(index, entry, maxFiles = MAX_FILES, maxBytes = MAX_BYTES) {
  if (entry.size > maxBytes) return { index, evict: [] };           // один файл больше всего кеша — не храним
  const rest = index.filter(e => e.key !== entry.key);
  const list = [...rest, entry].sort((a, b) => a.at - b.at);        // от старых к новым
  const evict = [];
  let total = list.reduce((s, e) => s + e.size, 0);
  while (list.length > 1 && (list.length > maxFiles || total > maxBytes)) {
    const old = list.shift();
    total -= old.size;
    evict.push(old.key);
  }
  return { index: list, evict };
}

export const cacheKey = (publicId, fileId) => `${publicId}/${fileId}`;
