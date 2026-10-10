import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function evaluateAudit(
  report,
  exceptions = [],
  production = false,
  now = new Date(),
) {
  if (
    report.error ||
    !report.metadata?.vulnerabilities ||
    !report.vulnerabilities
  ) {
    throw new Error("Audit returned an error or an incomplete report");
  }
  const failures = [];
  const accepted = [];
  function advisories(name, visited = new Set()) {
    if (visited.has(name)) throw new Error(`Cycle in audit report: ${name}`);
    const vulnerability = report.vulnerabilities[name];
    if (!vulnerability) throw new Error(`Missing audit dependency: ${name}`);
    return vulnerability.via.flatMap((item) =>
      typeof item === "string"
        ? advisories(item, new Set([...visited, name]))
        : [item],
    );
  }
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!["high", "critical"].includes(vulnerability.severity)) continue;
    const sources = advisories(name);
    const allowed =
      !production &&
      sources.length > 0 &&
      sources.every((source) =>
        exceptions.some(
          (exception) =>
            source.url.endsWith(`/${exception.id}`) &&
            exception.packages.includes(name) &&
            exception.severity === vulnerability.severity &&
            exception.reason &&
            exception.url === source.url &&
            /^\d{4}-\d{2}-\d{2}$/.test(exception.expires) &&
            new Date(`${exception.expires}T00:00:00Z`) > now,
        ),
      );
    (allowed ? accepted : failures).push({
      package: name,
      severity: vulnerability.severity,
      advisories: sources.map((source) => source.url),
    });
  }
  return { failures, accepted };
}

function main() {
  const directory = resolve(process.argv[2] || "web");
  const outputDirectory = resolve(process.argv[3] || "artifacts/audit");
  const exceptions = JSON.parse(
    readFileSync(new URL("../security/audit-exceptions.json", import.meta.url)),
  );
  mkdirSync(outputDirectory, { recursive: true });
  let failed = false;
  for (const production of [true, false]) {
    const name = production ? "production" : "full";
    const args = ["audit", "--json", "--registry=https://registry.npmjs.org"];
    if (production) args.push("--omit=dev");
    const result = spawnSync("npm", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status === null || result.status > 1) {
      throw new Error(
        `npm audit ${name} failed: ${result.error?.message || result.stderr}`,
      );
    }
    const report = JSON.parse(result.stdout);
    writeFileSync(
      resolve(outputDirectory, `${name}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    const policy = evaluateAudit(report, exceptions, production);
    writeFileSync(
      resolve(outputDirectory, `${name}-policy.json`),
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    console.log(
      `${directory} ${name}: ${policy.failures.length} blocked, ${policy.accepted.length} time-limited dev exceptions`,
    );
    for (const item of policy.failures)
      console.error(
        `${item.severity}: ${item.package} ${item.advisories.join(", ")}`,
      );
    failed ||= policy.failures.length > 0;
  }
  if (failed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
