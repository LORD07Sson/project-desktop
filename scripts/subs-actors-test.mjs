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

{
  const { countDubberLines } = await import("../src/app/subs-actors-core.js");
  const sub = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,Ewaii - Секретарь,0,0,0,,а\n"
    + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,Секретарь - Ewaii,0,0,0,,б\n"
    + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,Трагик - Солдат,0,0,0,,в\n";
  const r = countDubberLines(sub, [], [{ telegram_id: 1, name: "Ren", username: "Ewaii_Ren" }, { telegram_id: 2, name: "Lissa" }], { "трагик": 2 });
  assert.deepEqual(r.people.map(p => [p.telegram_id, p.lines]), [["1", 2], ["2", 1]]);
  assert.deepEqual(r.unknown, []);
}

{
  // Unique name prefix ("Богдан" ~ "богданчик <3") and sign lines left out of the count.
  const { countDubberLines } = await import("../src/app/subs-actors-core.js");
  const sub = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,Богдан - Второстеп муж 1,0,0,0,,а\n"
    + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,НАДПИСЬ,0,0,0,,вывеска\n";
  const r = countDubberLines(sub, [], [{ telegram_id: 6, name: "богданчик <3" }, { telegram_id: 7, name: "Богдана" }].slice(0, 1));
  assert.equal(r.signs, 1);
  assert.deepEqual(r.people.map(p => [p.telegram_id, p.lines]), [["6", 1]]);
  const amb = countDubberLines(sub, [], [{ telegram_id: 6, name: "богданчик" }, { telegram_id: 7, name: "Богдана" }]);
  assert.deepEqual(amb.people, []); // two people start with "богдан" — don't guess
}

{
  // Several speakers in one line, and "все вместе".
  const { countDubberLines } = await import("../src/app/subs-actors-core.js");
  const chars = [
    { id: 1, name: "Мэбуки Ямаси", voiced_by: { telegram_id: 1 } },
    { id: 2, name: "Ясуко", voiced_by: { telegram_id: 1 } },
    { id: 3, name: "Мотико Коганэ", voiced_by: { telegram_id: 2 } },
  ];
  const team = [{ telegram_id: 1, name: "Lissa" }, { telegram_id: 2, name: "Совесть" }, { telegram_id: 3, name: "Ren" }];
  const line = a => `Dialogue: 0,0:00:01.00,0:00:02.00,Default,${a},0,0,0,,x\n`;
  const sub = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    + line("Мэбуки") + line("Мотико") + line("Ren - Рассказчик")
    + line("Мэбуки и Мотико") // two people → both get it
    + line("Мэбуки и Ясуко") // same person twice → once, not shared
    + line("Lissa; Ren - толпа (вместе)")
    + line("Мотико и Незнакомец") // one known, one not
    + line("Все вместе");
  const r = countDubberLines(sub, chars, team);
  const got = Object.fromEntries(r.people.map(p => [p.name, [p.lines, p.joint]]));
  assert.deepEqual(got, { Lissa: [5, 3], "Совесть": [4, 2], Ren: [3, 2] });
  assert.equal(r.joint, 3);
  assert.deepEqual(r.unknown, [{ actor: "Незнакомец (из «Мотико и Незнакомец»)", lines: 1 }]);
}

{
  // Speakers listed with spaces only.
  const { countDubberLines } = await import("../src/app/subs-actors-core.js");
  const sub = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,Ewaii Богдан вместе,0,0,0,,x\n"
    + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,Ewaii Незнакомец,0,0,0,,y\n";
  const r = countDubberLines(sub, [], [{ telegram_id: 1, name: "Ren", username: "Ewaii_Ren" }, { telegram_id: 2, name: "богданчик <3" }]);
  assert.deepEqual(r.people.map(p => [p.telegram_id, p.lines, p.joint]), [["1", 1, 1], ["2", 1, 1]]);
  assert.deepEqual(r.unknown, [{ actor: "Ewaii Незнакомец", lines: 1 }]);
}
