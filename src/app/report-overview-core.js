// Показатели карточки отчёта («Прогресс / Срок / Озвучка / Материалы») и разбор файлов.
// Чистые функции без DOM и без обращений к состоянию — права и данные приходят аргументами, чтобы всё это
// можно было проверить в Node (scripts/overview-test.mjs). Разметку из результата собирает report-detail.js.
import { AUDIO_RE } from "./media-formats.js";

export const VIDEO_NAME_RE = /\.(mkv|mp4|mov|avi|webm|m4v|ts)$/i;
const SUBS_RE = /\.(ass|ssa|srt)$/i;

export const isFinalFile = f => !!f.is_final || /_final\./i.test(f.file_name || "");
export const isVideoFile = f => f.file_type === "video" || VIDEO_NAME_RE.test(f.file_name || "");
const isAudioFile = f => AUDIO_RE.test(f.file_type || "") || AUDIO_RE.test(f.file_name || "");
const isSubsFile = f => SUBS_RE.test(f.file_name || "");

// Что лежит в файлах отчёта: флаги для этапов производства и счётчики для плашки «Материалы».
export function classifyFiles(list) {
  const files = list || [];
  const hasFinal = files.some(isFinalFile);
  return {
    total: files.length,
    audio: files.filter(isAudioFile).length,
    video: files.filter(isVideoFile).length,
    subs: files.filter(isSubsFile).length,
    hasFinal,
    hasVideo: hasFinal || files.some(isVideoFile),
    hasSubs: files.some(isSubsFile),
    hasAudio: files.some(isAudioFile),
  };
}

export function pluralFiles(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "файл";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "файла";
  return "файлов";
}

// Доля сдавших в пайплайне: этап считается сданным, когда пройден (done) или участник уже отметил сдачу.
export function pipelineCounts(pipeline) {
  const pipe = pipeline || [];
  const done = pipe.filter(s => s.done || s.submitted_at).length;
  return { done, total: pipe.length };
}

// Общий прогресс — четыре этапа поровну: видео, озвучка, финал, выпуск. Озвучка идёт долей сдавших
// (или целиком, если пайплайна нет, но звук/субтитры уже лежат), выпуск считается состоявшимся при статусе
// «Готово» (completed): отдельной отметки о посте в карточке нет.
export function overallProgress({ files, pipeline, status }) {
  const c = classifyFiles(files);
  const { done, total } = pipelineCounts(pipeline);
  const voice = total ? done / total : (c.hasAudio || c.hasSubs ? 1 : 0);
  const stages = [c.hasVideo ? 1 : 0, voice, c.hasFinal ? 1 : 0, status === "completed" ? 1 : 0];
  const sum = stages.reduce((a, b) => a + b, 0);
  return { percent: Math.round(sum / stages.length * 100), passed: stages.filter(x => x >= 1).length, total: stages.length };
}

// Срок: слово («просрочено 2 дн.», «сегодня», «через 3 дн.»), дата с временем по МСК и тон для цвета.
// Те же правила, что в списке отчётов (deadlineCellHtml), но без разметки. overdue приходит готовым:
// у отчёта бывает личная просрочка участника (isOverdue в utils.js).
export function deadlineKpi(deadline, { status = "", overdue = false, now = new Date() } = {}) {
  if (!deadline) return { label: "без срока", date: "", tone: "none" };
  const s = String(deadline);
  const dateKey = s.slice(0, 10);
  const time = s.match(/[ T](\d{2}:\d{2})/);
  const date = `${dateKey.slice(8, 10)}.${dateKey.slice(5, 7)}${time ? ` · ${time[1]} МСК` : ""}`;
  if (status === "completed") return { label: "выполнено", date, tone: "none" };
  if (status === "cancelled") return { label: "отменено", date, tone: "none" };
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = k => parts.find(p => p.type === k)?.value || "00";
  const today = Date.parse(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
  const days = Math.round((Date.parse(`${dateKey}T00:00:00Z`) - today) / 86400000);
  const dueAt = time ? Date.parse(`${dateKey}T${time[1]}:00+03:00`) : Date.parse(`${dateKey}T23:59:59+03:00`);
  const lateDays = Math.floor((now.getTime() - dueAt) / 86400000);
  if (overdue) return { label: lateDays > 0 ? `просрочено ${lateDays} дн.` : "просрочено", date, tone: "bad" };
  if (days === 0) return { label: "сегодня", date, tone: "soon" };
  if (days === 1) return { label: "завтра", date, tone: "soon" };
  return { label: `через ${days} дн.`, date, tone: days <= 3 ? "soon" : "ok" };
}

// Четыре плашки полосы показателей. nameOf(entry) — как показывать участника (имя, а не ник).
export function overviewKpis({ files, pipeline, status, deadline, overdue = false, now = new Date(), nameOf = s => s.user_name || "" }) {
  const c = classifyFiles(files);
  const { done, total } = pipelineCounts(pipeline);
  const prog = overallProgress({ files, pipeline, status });
  const due = deadlineKpi(deadline, { status, overdue, now });
  const waiting = (pipeline || []).filter(s => !(s.done || s.submitted_at)).map(nameOf).filter(Boolean);
  const voiceSub = !total ? "пайплайн не задан"
    : waiting.length ? `ждём: ${waiting.slice(0, 4).join(", ")}${waiting.length > 4 ? ` и ещё ${waiting.length - 4}` : ""}` : "все сдали";
  return [
    { key: "progress", title: "Прогресс", value: `${prog.percent}%`, sub: `${prog.passed} из ${prog.total} этапов пройдено`, bar: prog.percent, tone: "" },
    { key: "deadline", title: "Срок", value: due.label, sub: due.date || "дата не указана", bar: null, tone: due.tone },
    { key: "voice", title: "Озвучка", value: total ? `${done} из ${total}` : "—", sub: voiceSub, bar: total ? Math.round(done / total * 100) : null, tone: "" },
    { key: "files", title: "Материалы", value: `${c.total} ${pluralFiles(c.total)}`, sub: `${c.audio} аудио · ${c.subs} субтитры · ${c.video ? `${c.video} видео` : "видео нет"}${c.total - c.audio - c.subs - c.video > 0 ? ` · ${c.total - c.audio - c.subs - c.video} прочее` : ""}`, bar: null, tone: "" },
  ];
}
