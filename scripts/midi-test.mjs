import assert from "node:assert/strict";
import { midiToCommand, DEFAULT_MAP } from "../src/app/midi-core.js";

assert.deepEqual(midiToCommand([0x90, 60, 100]), { cmd: "toggle" });
assert.equal(midiToCommand([0x90, 60, 0]), null, "note-on с нулевой силой = отпускание");
assert.equal(midiToCommand([0x80, 60, 64]), null, "note-off игнорируется");
assert.deepEqual(midiToCommand([0x91, 59, 90]), { cmd: "seek", delta: -5 }, "канал не важен");
assert.deepEqual(midiToCommand([0x93, 62, 90]), { cmd: "seek", delta: 5 });
assert.deepEqual(midiToCommand([0xb0, 7, 127]), { cmd: "volume", value: 1 });
assert.equal(midiToCommand([0xb0, 7, 0]).value, 0);
assert.equal(midiToCommand([0xb0, 1, 64]), null, "середина колеса — без движения");
assert.deepEqual(midiToCommand([0xb0, 1, 127]), { cmd: "seek", delta: 10 });
assert.deepEqual(midiToCommand([0xb0, 1, 0]), { cmd: "seek", delta: -10 });
assert.equal(midiToCommand([0xe0, 0, 0]), null);
assert.equal(midiToCommand(null), null);
assert.equal(midiToCommand([0x90]), null);
assert.equal(DEFAULT_MAP.toggleNote, 60);
console.log("midi-test: ok");
