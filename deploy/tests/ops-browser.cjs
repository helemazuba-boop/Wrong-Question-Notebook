// Read-only browser QA. Mutation plans are intercepted with synthetic fixtures.
const { createRequire } = require("node:module");
const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const requireWeb = createRequire(
  path.resolve(__dirname, "../../web/package.json"),
);
const { chromium } = requireWeb("playwright");

(async () => {
  const browserEnv = { ...process.env };
  // WSL headless Chromium may have no CJK font. Reuse the operator's installed
  // Windows fonts for screenshots without bundling or downloading font assets.
  if (fs.existsSync("/mnt/c/Windows/Fonts/msyh.ttc")) {
    const fontConfig = "/tmp/wqn-ops-fontconfig.xml";
    fs.writeFileSync(
      fontConfig,
      '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include>/etc/fonts/fonts.conf</include><dir>/mnt/c/Windows/Fonts</dir><cachedir>/tmp/wqn-ops-fontcache</cachedir></fontconfig>',
    );
    browserEnv.FONTCONFIG_FILE = fontConfig;
  }
  const browser = await chromium.launch({ headless: true, env: browserEnv });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1080 },
    });
    const errors = [];
    const applied = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.url().endsWith("/api/apply")) applied.push(r.url());
    });
    await page.route("**/api/decisions?**", async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace("/api/decisions", "/api/git"),
      });
      const report = await response.json();
      const markingFingerprint = report.omissions.find((o) =>
        o.aliases.includes("merge/agent-marking-release-20261026"),
      ).fingerprint;
      return route.fulfill({
        json: {
          [markingFingerprint]: {
            reason: "等待 marking 验收",
            time: "2026-10-27T00:00:00Z",
            branch: "feat/agent-marking-20261025",
          },
          ["9".repeat(64)]: {
            reason: "仅保留旧配置暂缓原因",
            time: "2026-10-27T01:00:00Z",
            branch: "upstream/main",
          },
        },
      });
    });
    await page.route("**/api/prs?**", (route) =>
      route.fulfill({
        json: {
          repository: "helemazuba-boop/wrong-question-notebook",
          checked_at: "2026-10-27T02:00:00Z",
          pull_requests: [
            {
              number: 92,
              headRefName: "feat/mcp-v2-foundation",
              state: "MERGED",
              mergedAt: "2026-10-15T17:37:03Z",
              headRefOid: "06fa1395c408d1d42d9be4949ee61a11f1300495",
              url: "https://github.com/helemazuba-boop/Wrong-Question-Notebook/pull/92",
              ref_checks: [
                {
                  ref: "refs/heads/feat/mcp-v2-foundation",
                  relationship: "followup",
                  followup_count: 5,
                },
              ],
            },
          ],
        },
      }),
    );
    await page.goto(process.env.WQN_OPS_TEST_URL || "http://127.0.0.1:8765", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () =>
        /^[a-f0-9]{12}$/.test(
          document.getElementById("candidate-sha").textContent,
        ),
      null,
      { timeout: 30000 },
    );
    await page.waitForFunction(
      () =>
        document.getElementById("connection").classList.contains("connected"),
      null,
      { timeout: 30000 },
    );
    assert((await page.locator("#candidate-ref option").count()) > 3);
    assert((await page.locator("#cloud-services .service").count()) >= 1);
    await page.screenshot({
      path: "/tmp/wqn-ops-overview.png",
      fullPage: true,
    });
    console.log(
      "PASS: live Git and read-only SSH state rendered without browser errors",
    );

    await page.locator("[data-view=branches]").click();
    await page.waitForFunction(() =>
      document
        .getElementById("omissions")
        .textContent.includes("等待 marking 验收"),
    );
    const reviewGroups = await page.locator("#omissions > .omission").count();
    assert(reviewGroups >= 2);
    assert.equal(
      await page.locator("#omissions .defer-row").count(),
      reviewGroups,
    );
    assert.equal(
      await page
        .locator("#omissions summary strong")
        .filter({ hasText: /^merge\/agent-marking-release-20261026$/ })
        .count(),
      1,
    );
    assert(
      !(await page.locator("#omissions").textContent()).includes("upstream/"),
    );
    assert(
      (await page.locator("#git-baselines").textContent()).includes("09bc260"),
    );
    await page.locator("#git-references > summary").click();
    assert.equal(await page.locator("#reference-list .defer-row").count(), 0);
    assert(
      (await page.locator("#reference-list").textContent()).includes(
        "仅保留旧配置暂缓原因",
      ),
    );
    await page.locator("#git-references > summary").click();
    await page.locator("#refresh-prs").click();
    await page.waitForFunction(() =>
      document
        .getElementById("omissions")
        .textContent.includes("合并时分支头 06fa139"),
    );
    assert(
      (await page.locator("#omissions").textContent()).includes(
        "之后有 5 个非合并提交",
      ),
    );
    const branch = page.locator("#omissions > .omission").filter({
      has: page.getByRole("button", { name: /bounded fallback/ }),
    });
    if (!(await branch.evaluate((node) => node.open)))
      await branch.locator("summary").click();
    await branch.getByRole("button", { name: /bounded fallback/ }).click();
    await page.locator("#detail-dialog[open]").waitFor();
    assert(
      /beda831|990ff237/.test(await page.locator("#detail-body").textContent()),
    );
    assert(
      (await page.locator("#detail-body").textContent()).includes("作者时间"),
    );
    await page.locator("#detail-dialog .dialog-close").click();
    await page.screenshot({
      path: "/tmp/wqn-ops-branches.png",
      fullPage: true,
    });
    console.log(
      "PASS: patch groups, reference scope, retained reasons, PR followups and neighboring commits render correctly",
    );

    await page.route("**/api/plan/env", (route) =>
      route.fulfill({
        json: {
          id: "a".repeat(32),
          kind: "env",
          status: "planned",
          services: ["app"],
          source: { branch: "fixture", sha: "b".repeat(40) },
          changes: [
            { service: "app", key: "WQN_OPENCODE_MODEL_ID", change: "change" },
          ],
          policy_revision: "b".repeat(40),
          policy_evidence: "image_label",
        },
      }),
    );
    await page.locator("[data-view=env]").click();
    await page.locator("#env-plan").click();
    await page.locator("#plan-dialog[open]").waitFor();
    assert(
      (await page.locator("#plan-changes").textContent()).includes(
        "WQN_OPENCODE_MODEL_ID",
      ),
    );
    assert(
      !(await page.locator("#plan-dialog").textContent()).includes(
        "fixture-password",
      ),
    );
    await page.screenshot({ path: "/tmp/wqn-ops-env-plan.png" });
    await page.locator("#cancel-plan").click();
    console.log(
      "PASS: environment plan lists names and effects without revealing values",
    );

    await page.route("**/api/history", (route) =>
      route.fulfill({
        json: {
          operations: [
            {
              id: "c".repeat(32),
              kind: "deploy",
              status: "verified",
              created_at: "2026-10-27T12:00:00Z",
              services: ["app"],
              source: { branch: "fixture-release", sha: "d".repeat(40) },
              images: {
                app: {
                  ref: "registry.example.test/wqn/app:fixture",
                  digest: "sha256:" + "e".repeat(64),
                },
              },
            },
          ],
        },
      }),
    );
    await page.route("**/api/plan/rollback", (route) =>
      route.fulfill({
        json: {
          id: "f".repeat(32),
          target_id: "c".repeat(32),
          kind: "rollback",
          status: "planned",
          services: ["app"],
          source: {},
          changes: [],
        },
      }),
    );
    await page.locator("[data-view=history]").click();
    await page.locator("#refresh-history").click();
    await page
      .getByRole("button", { name: "恢复到此状态", exact: true })
      .click();
    await page.locator("#plan-dialog[open]").waitFor();
    await page.locator("#apply-plan").click();
    await page.locator("#plan-error:not([hidden])").waitFor();
    assert.equal(applied.length, 0);
    await page.locator("#cancel-plan").click();
    console.log(
      "PASS: rollback requires compatibility review before any apply request",
    );

    await page.route("**/api/logs?**", (route) =>
      route.fulfill({
        json: {
          source: "app",
          checked_at: "2026-10-27T12:00:00Z",
          text: "normal startup\nfixture request failed\nauthorization: [redacted]\n",
        },
      }),
    );
    await page.locator("[data-view=logs]").click();
    await page.locator("#read-logs").click();
    await page.waitForFunction(() =>
      document
        .getElementById("log-output")
        .textContent.includes("fixture request failed"),
    );
    await page.locator("#log-search").fill("failed");
    assert.equal(
      (await page.locator("#log-output").textContent()).trim(),
      "fixture request failed",
    );
    console.log("PASS: log source, refresh and keyword filtering work");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("[data-view=branches]").click();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.locator("[data-view=overview]").click();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: "/tmp/wqn-ops-mobile.png", fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(applied.length, 0);
    console.log(
      "PASS: mobile layout has no horizontal overflow; no production mutations requested",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
