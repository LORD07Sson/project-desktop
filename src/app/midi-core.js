// Сопоставление MIDI-сообщений командам плеера. Чистые функции — чтобы
// проверять без браузера. Раскладка по умолчанию рассчитана на любую
// клавиатуру: до (C4, нота 60) — пауза/play, си (59) и ре (62) — назад и
// вперёд на 5 секунд, ручка громкости (CC 7) — громкость, CC 1 (колесо
// модуляции) — перемотка: влево от середины назад, вправо вперёд.

export const DEFAULT_MAP = {
  toggleNote: 60,
  backNote: 59,
  forwardNote: 62,
  volumeCc: 7,
  seekCc: 1,
};

/**
 * @param {number[]|Uint8Array} data сырое MIDI-сообщение
 * @returns {{cmd:"toggle"}|{cmd:"seek",delta:number}|{cmd:"volume",value:number}|null}
 */
export function midiToCommand(data, map = DEFAULT_MAP) {
  if (!data || data.length < 2) return null;
  const type = data[0] & 0xf0;
  const a = data[1];
  const b = data.length > 2 ? data[2] : 0;
  if (type === 0x90 && b > 0) {
    if (a === map.toggleNote) return { cmd: "toggle" };
    if (a === map.backNote) return { cmd: "seek", delta: -5 };
    if (a === map.forwardNote) return { cmd: "seek", delta: 5 };
    return null;
  }
  if (type === 0xb0) {
    if (a === map.volumeCc) return { cmd: "volume", value: Math.max(0, Math.min(1, b / 127)) };
    if (a === map.seekCc) {
      const delta = Math.round(((b - 64) / 64) * 10);
      return delta === 0 ? null : { cmd: "seek", delta };
    }
  }
  return null;
}
