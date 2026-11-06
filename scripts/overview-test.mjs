// Показатели карточки отчёта: разбор файлов, прогресс, срок и четыре плашки (report-overview-core.js).
import assert from "node:assert/strict";
import { classifyFiles, pluralFiles, pipelineCounts, overallProgress, deadlineKpi, overviewKpis } from "../src/app/report-overview-core.js";

// ---- файлы
const files = [
  { file_name: "ep05_ren.wav", file_type: "audio" },
  { file_name: "ep05_lissa.flac" },
  { file_name: "ep05.ass" },
  { file_name: "ep05_raw.mkv", file_type: "video" },
];
let c = classifyFiles(files);
assert.deepEqual([c.total, c.audio, c.subs, c.video], [4, 2, 1, 1]);
assert.ok(c.hasVideo && c.hasAudio && c.hasSubs && !c.hasFinal);
c = classifyFiles([{ file_name: "ep05_FINAL.mp4" }]);
assert.ok(c.hasFinal && c.hasVideo);                               // финал сам по себе считается видео
assert.ok(classifyFiles([{ file_name: "x.txt", is_final: true }]).hasFinal);
assert.deepEqual([classifyFiles([]).total, classifyFiles(null).hasVideo], [0, false]);

assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25].map(pluralFiles), ["файл", "файла", "файлов", "файлов", "файлов", "файл", "файла", "файлов"]);

// ---- пайплайн и прогресс
const pipe = [{ done: true }, { submitted_at: "2026-11-05 10:00:00" }, {}, {}];
assert.deepEqual(pipelineCounts(pipe), { done: 2, total: 4 });
assert.deepEqual(pipelineCounts(null), { done: 0, total: 0 });

// видео нет, озвучка 2 из 4 → (0 + .5 + 0 + 0) / 4 ≈ 13 %
let p = overallProgress({ files: [], pipeline: pipe, status: "voicing" });
assert.deepEqual(p, { percent: 13, passed: 0, total: 4 });
// видео есть, пайплайн пройден, финала нет → 2 этапа из 4
p = overallProgress({ files: [{ file_name: "a.mkv" }], pipeline: [{ done: true }], status: "voicing" });
assert.deepEqual([p.percent, p.passed], [50, 2]);
// финал собран, статус «Готово» → все четыре
p = overallProgress({ files: [{ file_name: "ep_final.mp4" }], pipeline: [{ done: true }], status: "completed" });
assert.deepEqual([p.percent, p.passed], [100, 4]);
// без пайплайна озвучка засчитана, если звук уже лежит
assert.equal(overallProgress({ files: [{ file_name: "v.wav" }], pipeline: [], status: "draft" }).percent, 25);

// ---- срок (сейчас — 2026-11-06 12:00 МСК)
const now = new Date("2026-11-06T09:00:00Z");
assert.deepEqual(deadlineKpi("", { now }), { label: "без срока", date: "", tone: "none" });
assert.deepEqual(deadlineKpi("2026-11-06", { now }), { label: "сегодня", date: "06.11", tone: "soon" });
assert.deepEqual(deadlineKpi("2026-11-07 18:00", { now }), { label: "завтра", date: "07.11 · 18:00 МСК", tone: "soon" });
assert.deepEqual(deadlineKpi("2026-11-09", { now }), { label: "через 3 дн.", date: "09.11", tone: "soon" });
assert.deepEqual(deadlineKpi("2026-11-20", { now }), { label: "через 14 дн.", date: "20.11", tone: "ok" });
assert.deepEqual(deadlineKpi("2026-11-04", { now, overdue: true }), { label: "просрочено 1 дн.", date: "04.11", tone: "bad" });
assert.equal(deadlineKpi("2026-11-06 11:00", { now, overdue: true }).label, "просрочено");   // меньше суток
assert.equal(deadlineKpi("2026-11-01", { now, status: "completed", overdue: true }).label, "выполнено");
assert.equal(deadlineKpi("2026-11-01", { now, status: "cancelled" }).tone, "none");

// ---- четыре плашки
const k = overviewKpis({
  files, status: "voicing", deadline: "2026-11-04", overdue: true, now,
  pipeline: [{ done: true, user_name: "A" }, { user_name: "Ren" }, { user_name: "Совесть" }, { user_name: "Nataly" }, { user_name: "Lissa" }, { user_name: "Juliana" }],
});
assert.deepEqual(k.map(x => x.key), ["progress", "deadline", "voice", "files"]);
assert.equal(k[1].tone, "bad");
assert.equal(k[2].value, "1 из 6");
assert.equal(k[2].sub, "ждём: Ren, Совесть, Nataly, Lissa и ещё 1");   // не больше четырёх имён
assert.equal(k[3].value, "4 файла");
assert.equal(k[3].sub, "2 аудио · 1 субтитры · 1 видео");
assert.equal(overviewKpis({ files: [], pipeline: [], status: "draft", deadline: "", now })[3].sub, "0 аудио · 0 субтитры · видео нет");
assert.equal(overviewKpis({ files: [], pipeline: [], status: "draft", deadline: "", now })[2].value, "—");
assert.equal(overviewKpis({ files: [], pipeline: [{ done: true }], status: "draft", deadline: "", now })[2].sub, "все сдали");
console.log("overview-test: ok");
