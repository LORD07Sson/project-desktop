import assert from "node:assert/strict";
import { ndaAccepted, acceptNda, ndaKey, NDA_TEXT } from "../src/app/nda-core.js";

const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
const st = mem();
assert.equal(ndaAccepted(st, 42), false);
assert.equal(acceptNda(st, 42, new Date("2026-10-08T10:00:00Z")), true);
assert.equal(ndaAccepted(st, 42), true);
assert.equal(ndaAccepted(st, 43), false, "у каждого пользователя своё принятие");
assert.equal(ndaAccepted(st, null), true);
assert.ok(ndaKey(42).includes("42"));
const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
assert.equal(ndaAccepted(broken, 42), false, "ошибка хранилища = не принято");
assert.equal(acceptNda(broken, 42), false);
assert.ok(NDA_TEXT.length >= 3);
console.log("nda-test: ok");
