// «Своя тема»: два ползунка поверх готовой темы — размытие стекла и
// скругления. Чистая часть: ограничение значений и расчёт CSS-переменных.

export const TUNE_DEFAULT = { blur: 26, round: 100 };
export const TUNE_LIMITS = { blur: [0, 48], round: [40, 180] };
const BASE_RADIUS = { "--radius-sm": 9, "--radius-md": 13, "--radius-lg": 18, "--radius-xl": 24 };

const clamp = (v, [lo, hi], fallback) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

export function normalizeTune(t = {}) {
  return {
    blur: clamp(t.blur, TUNE_LIMITS.blur, TUNE_DEFAULT.blur),
    round: clamp(t.round, TUNE_LIMITS.round, TUNE_DEFAULT.round),
  };
}

/** {имя переменной: значение} для подстановки в :root. */
export function tuneVars(t) {
  const { blur, round } = normalizeTune(t);
  const vars = { "--glass-blur": `${blur}px` };
  for (const [name, base] of Object.entries(BASE_RADIUS)) vars[name] = `${Math.round(base * round / 100)}px`;
  return vars;
}

export const isDefaultTune = t => {
  const n = normalizeTune(t);
  return n.blur === TUNE_DEFAULT.blur && n.round === TUNE_DEFAULT.round;
};
