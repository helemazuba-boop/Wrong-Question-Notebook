import { readdirSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const policy = JSON.parse(
  readFileSync(
    process.argv[3] ||
      new URL("../security/codeql-exceptions.json", import.meta.url),
    "utf8",
  ),
);
if (!Array.isArray(policy.exceptions))
  throw new Error("Malformed CodeQL review policy");
for (const entry of policy.exceptions) {
  if (
    !entry.ruleId ||
    !entry.justification ||
    !entry.expires ||
    entry.expires <= new Date().toISOString().slice(0, 10)
  )
    throw new Error("Missing or expired CodeQL false-positive review");
  for (const source of [
    { path: entry.path, sha256: entry.sha256 },
    ...(entry.relatedSources || []),
  ]) {
    if (
      !source.path ||
      isAbsolute(source.path) ||
      source.path.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/.test(source.sha256)
    )
      throw new Error("Malformed CodeQL source fingerprint");
  }
}

function reviewedFalsePositive(ruleId, result) {
  const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
  if (!uri) return false;
  const path = decodeURIComponent(uri);
  return policy.exceptions.some((entry) => {
    if (entry.ruleId !== ruleId || entry.path !== path) return false;
    return [
      { path: entry.path, sha256: entry.sha256 },
      ...(entry.relatedSources || []),
    ].every(
      (source) =>
        createHash("sha256").update(readFileSync(source.path)).digest("hex") ===
        source.sha256,
    );
  });
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : entry.name.endsWith(".sarif")
        ? [join(directory, entry.name)]
        : [],
  );
}
const reports = files(process.argv[2] || "artifacts/codeql");
if (!reports.length) throw new Error("CodeQL produced no SARIF report");
let count = 0;
let blocked = 0;
for (const file of reports) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  if (!report.runs?.length) throw new Error(`Incomplete SARIF: ${file}`);
  for (const run of report.runs) {
    if (
      run.invocations?.some(
        (invocation) => invocation.executionSuccessful === false,
      )
    ) {
      throw new Error(`CodeQL analysis failed: ${file}`);
    }
    const components = [run.tool.driver, ...(run.tool.extensions || [])];
    for (const result of run.results || []) {
      count++;
      const component = result.rule?.toolComponent;
      const owner =
        component?.index !== undefined
          ? run.tool.extensions?.[component.index]
          : component?.name
            ? components.find((entry) => entry.name === component.name)
            : run.tool.driver;
      const rules = owner?.rules || [];
      const ruleId = result.rule?.id || result.ruleId;
      const rule =
        rules.find((entry) => entry.id === ruleId) ||
        rules[result.rule?.index ?? result.ruleIndex];
      if (!rule)
        throw new Error(`Missing CodeQL rule descriptor: ${result.ruleId}`);
      const severity = Number(rule.properties?.["security-severity"] || 0);
      if (
        severity >= 7 &&
        !reviewedFalsePositive(ruleId, result) &&
        !result.suppressions?.some(
          (suppression) => suppression.status === "accepted",
        )
      ) {
        blocked++;
        console.error(
          `${result.ruleId}: ${result.message.text} (${result.locations?.[0]?.physicalLocation?.artifactLocation?.uri || file})`,
        );
      }
    }
  }
}
console.log(
  `CodeQL: ${count} findings, ${blocked} unsuppressed High/Critical findings`,
);
if (blocked) process.exitCode = 1;
