import assert from "node:assert/strict";
import { assActors, splitActor, planImport, applyDubbers, normName } from "../src/app/subs-actors-core.js";

const ass = "﻿[Script Info]\r\nTitle: t\r\n\r\n[V4+ Styles]\r\nFormat: Name, Fontname\r\nStyle: Default,Arial\r\n\r\n[Events]\r\n"
  + "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n"
  + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,Наруто (Иван),0,0,0,,Привет, мир\r\n"
  + "Dialogue: 0,0:00:03.00,0:00:04.00,Default,Саске,0,0,0,,{\\i1}Ну{\\i0}, да\r\n"
  + "Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,без актёра\r\n"
  + "Comment: 0,0:00:05.00,0:00:06.00,Default,Наруто,0,0,0,,коммент\r\n"
  + "Dialogue: 0,0:00:07.00,0:00:08.00,Default,Какаши - Пётр,0,0,0,,Йо\r\n"
  + "Dialogue: 0,0:00:09.00,0:00:10.00,Default,Прохожий,0,0,0,,эй\r\n";

const a = assActors(ass);
assert.equal(a.total, 5);
assert.equal(a.empty, 1);
assert.deepEqual(a.actors.map(x => x.actor).sort(), ["Какаши - Пётр", "Наруто (Иван)", "Прохожий", "Саске"]);

assert.deepEqual(splitActor("Наруто (Иван)"), { left: "Наруто", right: "Иван" });
assert.deepEqual(splitActor("Какаши - Пётр"), { left: "Какаши", right: "Пётр" });
assert.deepEqual(splitActor("Мэй | Аня"), { left: "Мэй", right: "Аня" });
assert.deepEqual(splitActor("Саске"), { left: "Саске", right: "" });
assert.equal(normName("  Пётр  «Ёж» "), "петр еж");

const chars = [
  { id: 1, name: "Наруто Узумаки", voiced_by: null },
  { id: 2, name: "Саске", voiced_by: { telegram_id: 20, name: "Олег" } },
  { id: 3, name: "Какаши", voiced_by: null },
];
const users = [{ telegram_id: 10, name: "Иван" }, { telegram_id: 30, name: "Пётр Смирнов", username: "petr" }];

const plan = planImport(a.actors, chars, users);
assert.deepEqual(plan.pairs.map(p => [p.character.id, p.user.telegram_id]).sort(), [[1, 10], [3, 30]]);
assert.deepEqual(plan.unknownCharacters, ["Прохожий"]);
assert.equal(plan.unknownDubbers.length, 0);
// Reversed order «Даббер (Персонаж)» still matches the character.
assert.equal(planImport([{ actor: "Иван (Наруто)", lines: 1 }], chars, users).pairs[0].character.id, 1);
// Unknown dubber is reported, not guessed.
assert.deepEqual(planImport([{ actor: "Наруто (Никто)", lines: 1 }], chars, users).unknownDubbers, [{ actor: "Наруто (Никто)", dubber: "Никто" }]);

const voiced = [
  { id: 1, name: "Наруто Узумаки", voiced_by: { name: "Иван" } },
  { id: 2, name: "Саске", voiced_by: { name: "Олег" } },
  { id: 3, name: "Какаши", voiced_by: null },
];
const r = applyDubbers(ass, voiced, "both");
assert.equal(r.changed, 2);
assert.equal(r.noActor, 1);
assert.deepEqual(r.unknownActors, ["Прохожий"]);
assert.deepEqual(r.unvoiced, ["Какаши"]);
assert.ok(r.text.startsWith("﻿[Script Info]\r\n"), "BOM and CRLF kept");
assert.ok(r.text.includes("Default,Наруто Узумаки (Иван),0,0,0,,Привет, мир\r\n"), "commas in text kept");
assert.ok(r.text.includes("Default,Саске (Олег),0,0,0,,{\\i1}Ну{\\i0}, да"));
assert.ok(r.text.includes("Comment: 0,0:00:05.00,0:00:06.00,Default,Наруто,"), "comments untouched");
const d = applyDubbers(ass, voiced, "dubber");
assert.ok(d.text.includes("Default,Иван,0,0,0,,Привет, мир"));
// Second pass is stable.
assert.equal(applyDubbers(r.text, voiced, "both").changed, 0);

console.log("subs-actors-test: ok");

{
  const { countDubberLines } = await import("../src/app/subs-actors-core.js");
  const castChars = [
    { id: 1, name: "Наруто Узумаки", image_url: "n.jpg", voiced_by: null },
    { id: 2, name: "Саске", image_url: "s.jpg", voiced_by: { telegram_id: 20, name: "Олег" } },
    { id: 3, name: "Какаши", voiced_by: { telegram_id: 30 } },
  ];
  const team = [{ telegram_id: 10, name: "Иван" }, { telegram_id: 20, name: "Олег" }, { telegram_id: 30, name: "Пётр" }];
  const r = countDubberLines(ass + "Dialogue: 0,0:00:11.00,0:00:12.00,Default,Олег,0,0,0,,сам\r\n", castChars, team);
  assert.equal(r.total, 6);
  assert.equal(r.empty, 1);
  assert.deepEqual(r.people.map(p => [p.name, p.lines]), [["Олег", 2], ["Иван", 1], ["Пётр", 1]]);
  assert.deepEqual(r.people[0].characters.map(c => [c.name, c.lines, c.image_url]), [["Саске", 1, "s.jpg"]]);
  assert.deepEqual(r.people[1].characters.map(c => c.name), ["Наруто Узумаки"]);
  assert.deepEqual(r.unknown, [{ actor: "Прохожий", lines: 1 }]);
}
