
export const MAX_FILES = 12;
export const MAX_BYTES = 400 * 1024 * 1024;

export function addEntry(index, entry, maxFiles = MAX_FILES, maxBytes = MAX_BYTES) {
  if (entry.size > maxBytes) return { index, evict: [] };
  const rest = index.filter(e => e.key !== entry.key);
  const list = [...rest, entry].sort((a, b) => a.at - b.at);
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
