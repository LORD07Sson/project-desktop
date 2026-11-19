
export const PRELOAD_LEFT_SEC = 150;
export const PRELOAD_TTL_MS = 6 * 60_000;

export function pickSameVoice(translations, authors, kind) {
  const subs = kind === "sub" ? (translations || []).filter(t => t.kind === "sub") : [];
  if (subs.length) return (authors && subs.find(t => t.authors === authors)) || subs[0];
  const voices = (translations || []).filter(t => t.kind === "voice" || t.kind === "raw");
  if (!voices.length) return null;
  return (authors && voices.find(t => t.authors === authors)) || voices[0];
}

export function preloadFresh(pre, episodeId, now = Date.now()) {
  return !!pre && pre.episodeId === episodeId && now - pre.at < PRELOAD_TTL_MS && !!pre.sources;
}

export function shouldPreload({ left, duration, hasNext, alreadyFor, nextId }) {
  if (!hasNext || !duration || duration < 60) return false;
  if (alreadyFor === nextId) return false;
  return left > 0 && left <= PRELOAD_LEFT_SEC;
}

export const START_BUFFER_SEC = 30;
export const START_BUFFER_MAX_WAIT_MS = 25_000;

export function bufferedAhead(buffered, t) {
  for (let i = 0; i < (buffered ? buffered.length : 0); i++) {
    if (buffered.start(i) <= t + 0.5 && t <= buffered.end(i)) return Math.max(0, buffered.end(i) - t);
  }
  return 0;
}

export function startBufferReady({ ahead, left, suspended, waitedMs }) {
  return ahead >= START_BUFFER_SEC || (left > 0 && ahead >= left - 0.5) || suspended || waitedMs >= START_BUFFER_MAX_WAIT_MS;
}
