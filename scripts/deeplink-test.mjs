import assert from "node:assert/strict";
import { parseProjectLink, linkifyProject, reportLink } from "../src/app/deeplink-core.js";

assert.deepEqual(parseProjectLink("project://report/R-1042"), { kind: "report", id: "R-1042" });
assert.deepEqual(parseProjectLink("  project://report/abc.d_e/ "), { kind: "report", id: "abc.d_e" });
assert.equal(parseProjectLink("project://report/"), null);
assert.equal(parseProjectLink("project://report/a b"), null);
assert.equal(parseProjectLink("https://report/R-1"), null);
assert.equal(parseProjectLink("project://file/R-1"), null);
assert.equal(parseProjectLink("project://report/<x>"), null);
assert.equal(reportLink("R-7"), "project://report/R-7");
const html = linkifyProject("смотри project://report/R-7, и ещё project://report/R-8.");
assert.equal((html.match(/data-plink/g) || []).length, 2);
assert.ok(html.includes('data-plink="project://report/R-7"'));
assert.ok(!html.includes("R-7,</a>"), "запятая не входит в ссылку");
assert.equal(linkifyProject("без ссылок"), "без ссылок");
console.log("deeplink-test: ok");
