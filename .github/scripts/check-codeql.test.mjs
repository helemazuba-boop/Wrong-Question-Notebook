import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function check(severity, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wqn-codeql-policy-"));
  try {
    const report = {
      runs: [
        {
          tool: {
            driver: {
              rules: [
                {
                  id: "test/rule",
                  properties: { "security-severity": severity },
                },
              ],
            },
          },
          results: [
            { ruleId: "test/rule", message: { text: "Finding fixture" } },
          ],
          ...extra,
        },
      ],
    };
    writeFileSync(join(directory, "test.sarif"), JSON.stringify(report));
    return spawnSync(process.execPath, [
      new URL("./check-codeql.mjs", import.meta.url).pathname,
      directory,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("High and Critical findings block the job", () => {
  assert.equal(check("7.0").status, 1);
  assert.equal(check("9.8").status, 1);
});
test("Medium findings remain visible without blocking", () =>
  assert.equal(check("6.5").status, 0));
test("failed analyses and incomplete rule descriptors are rejected", () => {
  assert.equal(
    check("5", { invocations: [{ executionSuccessful: false }] }).status,
    1,
  );
  assert.equal(check("5", { tool: { driver: { rules: [] } } }).status, 1);
});

test("CodeQL query-pack extension descriptors enforce the same threshold", () => {
  const extension = (severity) => ({
    tool: {
      driver: { rules: [] },
      extensions: [
        {
          name: "codeql/javascript-queries",
          rules: [
            { id: "test/rule", properties: { "security-severity": severity } },
          ],
        },
      ],
    },
    results: [
      {
        ruleId: "test/rule",
        rule: { id: "test/rule", index: 0, toolComponent: { index: 0 } },
        message: { text: "Extension finding" },
      },
    ],
  });
  assert.equal(check("0", extension("8.1")).status, 1);
  assert.equal(check("0", extension("6.5")).status, 0);
});
