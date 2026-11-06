// formatWhen: серверная дата (UTC) → понятное местное время. Часовой пояс фиксируем, чтобы тест не зависел от машины.
process.env.TZ = "Europe/Moscow";
import assert from "node:assert/strict";
import { formatWhen } from "../src/app/utils.js";

const now = new Date("2026-11-06T10:00:00Z");   // 13:00 по Москве
assert.equal(formatWhen("2026-11-06 07:30:00", now), "сегодня, 10:30");   // UTC → МСК +3
assert.equal(formatWhen("2026-11-06 07:30", now), "сегодня, 10:30");      // без секунд
assert.equal(formatWhen("2026-11-05 20:59:00", now), "вчера, 23:59");
assert.equal(formatWhen("2026-11-05 21:30:00", now), "сегодня, 00:30");   // уже новые сутки по Москве
assert.match(formatWhen("2026-11-03 11:59:00", now), /^3 нояб\.?, 14:59$/);
assert.match(formatWhen("2025-12-31 12:00:00", now), /^31 дек\.? 2025 г\.?, 15:00$/);
assert.equal(formatWhen("2026-11-03T11:59:00Z", now), formatWhen("2026-11-03 11:59:00", now));   // ISO с Z — то же самое
assert.equal(formatWhen("", now), "");
assert.equal(formatWhen(null, now), "");
assert.equal(formatWhen("не дата", now), "не дата");                       // мусор возвращаем как есть
console.log("when-test: ok");
