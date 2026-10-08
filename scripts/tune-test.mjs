import assert from "node:assert/strict";
import { normalizeTune, tuneVars, isDefaultTune, TUNE_DEFAULT } from "../src/app/tune-core.js";

assert.deepEqual(normalizeTune({}), TUNE_DEFAULT);
assert.deepEqual(normalizeTune({ blur: -5, round: 999 }), { blur: 0, round: 180 });
assert.deepEqual(normalizeTune({ blur: "abc", round: null }), TUNE_DEFAULT);
const v = tuneVars({ blur: 10, round: 200 });
assert.equal(v["--glass-blur"], "10px");
assert.equal(v["--radius-xl"], "43px", "радиус масштабируется, но не выходит за пределы 180%");
assert.equal(tuneVars(TUNE_DEFAULT)["--radius-md"], "13px");
assert.ok(isDefaultTune({}));
assert.ok(!isDefaultTune({ blur: 12 }));
console.log("tune-test: ok");
