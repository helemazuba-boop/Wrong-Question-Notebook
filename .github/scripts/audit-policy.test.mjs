import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAudit } from "./audit-policy.mjs";

const url = "https://github.com/advisories/GHSA-example";
const report = {
  metadata: { vulnerabilities: { high: 2 } },
  vulnerabilities: {
    parent: { severity: "high", via: ["child"] },
    child: { severity: "high", via: [{ url, severity: "high" }] },
  },
};
const exception = {
  id: "GHSA-example",
  packages: ["parent", "child"],
  severity: "high",
  expires: "2026-11-09",
  reason: "Repository-controlled dev input",
  url,
};
const now = new Date("2026-10-10T00:00:00Z");
test("known dev advisory is allowed through its transitive chain", () => {
  assert.equal(
    evaluateAudit(report, [exception], false, now).accepted.length,
    2,
  );
});
test("dev exception never exempts a production vulnerability", () => {
  assert.equal(
    evaluateAudit(report, [exception], true, now).failures.length,
    2,
  );
});
test("new advisories, packages and increased severity are blocked", () => {
  assert.equal(evaluateAudit(report, [], false, now).failures.length, 2);
  assert.equal(
    evaluateAudit(report, [{ ...exception, packages: ["child"] }], false, now)
      .failures.length,
    1,
  );
  const critical = structuredClone(report);
  critical.vulnerabilities.child.severity = "critical";
  assert.equal(
    evaluateAudit(critical, [exception], false, now).failures.length,
    1,
  );
});
test("expired exceptions are blocked", () => {
  assert.equal(
    evaluateAudit(report, [exception], false, new Date("2026-11-09")).failures
      .length,
    2,
  );
});
test("registry errors and incomplete reports fail closed", () => {
  assert.throws(() => evaluateAudit({ error: { code: "EAUDIT" } }));
  assert.throws(() => evaluateAudit({}));
});
