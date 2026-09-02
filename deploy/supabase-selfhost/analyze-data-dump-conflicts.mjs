#!/usr/bin/env node

import { readFileSync } from "node:fs";

function usage() {
  console.error(
    "usage: analyze-data-dump-conflicts.mjs SOURCE_DATA_SQL TARGET_COPY_STREAM KEY_CONSTRAINTS_TSV",
  );
  process.exit(2);
}

const [sourcePath, targetPath, constraintsPath] = process.argv.slice(2);
if (!sourcePath || !targetPath || !constraintsPath) usage();

function unquoteIdentifier(value) {
  return value.trim().replace(/^"|"$/g, "").replaceAll('""', '"');
}

function parseCopyHeader(line) {
  const match = line.match(
    /^COPY\s+("(?:[^"]|"")+"\."(?:[^"]|"")+")\s+\((.*)\)\s+FROM stdin;$/,
  );
  if (!match) return null;
  const relation = match[1]
    .split(".")
    .map(unquoteIdentifier)
    .join(".");
  const columns = match[2].split(/,\s*/).map(unquoteIdentifier);
  return { relation, columns };
}

function parseSource(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const tables = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseCopyHeader(lines[index]);
    if (!header) continue;
    const rows = [];
    for (index += 1; index < lines.length && lines[index] !== "\\."; index += 1) {
      rows.push(lines[index]);
    }
    if (index >= lines.length) {
      throw new Error(`unterminated COPY block: ${header.relation}`);
    }
    if (tables.has(header.relation)) {
      throw new Error(`duplicate COPY block: ${header.relation}`);
    }
    tables.set(header.relation, { columns: header.columns, rows });
  }
  return tables;
}

function parseTarget(path) {
  const tables = new Map();
  let relation = null;
  let rows = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("__WQN_TABLE_BEGIN__")) {
      if (relation !== null) throw new Error(`nested target marker at ${line}`);
      relation = line.slice("__WQN_TABLE_BEGIN__".length);
      rows = [];
      continue;
    }
    if (line.startsWith("__WQN_TABLE_END__")) {
      const ended = line.slice("__WQN_TABLE_END__".length);
      if (relation !== ended || rows === null) {
        throw new Error(`mismatched target marker: ${line}`);
      }
      tables.set(relation, { rows });
      relation = null;
      rows = null;
      continue;
    }
    if (relation !== null) rows.push(line);
  }
  if (relation !== null) throw new Error(`unterminated target block: ${relation}`);
  return tables;
}

function parseConstraints(path) {
  const byTable = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [relation, name, type, rawColumns] = line.split("\t");
    if (!relation || !name || !new Set(["p", "u"]).has(type) || !rawColumns) {
      continue;
    }
    const constraint = { name, type, columns: rawColumns.split(",") };
    const existing = byTable.get(relation) ?? [];
    existing.push(constraint);
    byTable.set(relation, existing);
  }
  return byTable;
}

function rowKey(row, positions) {
  const fields = row.split("\t");
  return positions.map((position) => fields[position]).join("\u0000");
}

function keyedRows(relation, rows, columns, keyColumns) {
  const positions = keyColumns.map((column) => {
    const position = columns.indexOf(column);
    if (position < 0) {
      throw new Error(`${relation}: dump omits key column ${column}`);
    }
    return position;
  });
  const keyed = new Map();
  for (const row of rows) {
    const key = rowKey(row, positions);
    if (keyed.has(key)) throw new Error(`${relation}: duplicate primary key in COPY data`);
    keyed.set(key, row);
  }
  return { keyed, positions };
}

const source = parseSource(sourcePath);
const target = parseTarget(targetPath);
const constraints = parseConstraints(constraintsPath);

console.log(
  [
    "relation",
    "source_rows",
    "target_rows",
    "identity_kind",
    "identity_overlap",
    "identical_by_identity",
    "changed_by_identity",
    "source_only_identity",
    "target_only_identity",
    "nonpk_unique_conflicts",
  ].join("\t"),
);

for (const relation of [...source.keys()].sort()) {
  const sourceTable = source.get(relation);
  const targetTable = target.get(relation);
  if (!targetTable) throw new Error(`target stream omits ${relation}`);
  const tableConstraints = constraints.get(relation) ?? [];
  const primary = tableConstraints.find(({ type }) => type === "p");
  const identity = primary ?? tableConstraints.find(({ type }) => type === "u");
  if (!identity) throw new Error(`no primary or unique identity found for ${relation}`);

  const sourceByPk = keyedRows(
    relation,
    sourceTable.rows,
    sourceTable.columns,
    identity.columns,
  ).keyed;
  const targetByPk = keyedRows(
    relation,
    targetTable.rows,
    sourceTable.columns,
    identity.columns,
  ).keyed;

  let overlap = 0;
  let identical = 0;
  for (const [key, sourceRow] of sourceByPk) {
    const targetRow = targetByPk.get(key);
    if (targetRow === undefined) continue;
    overlap += 1;
    if (targetRow === sourceRow) identical += 1;
  }

  const conflictingSourceKeys = new Set();
  for (const unique of tableConstraints.filter(
    ({ type, name }) => type === "u" && name !== identity.name,
  )) {
    const positions = unique.columns.map((column) => {
      const position = sourceTable.columns.indexOf(column);
      if (position < 0) throw new Error(`${relation}: dump omits unique column ${column}`);
      return position;
    });
    const targetUnique = new Map();
    for (const [primaryKey, row] of targetByPk) {
      const fields = row.split("\t");
      if (positions.some((position) => fields[position] === "\\N")) continue;
      targetUnique.set(rowKey(row, positions), primaryKey);
    }
    for (const [primaryKey, row] of sourceByPk) {
      const fields = row.split("\t");
      if (positions.some((position) => fields[position] === "\\N")) continue;
      const targetPrimaryKey = targetUnique.get(rowKey(row, positions));
      if (targetPrimaryKey !== undefined && targetPrimaryKey !== primaryKey) {
        conflictingSourceKeys.add(primaryKey);
      }
    }
  }

  console.log(
    [
      relation,
      sourceByPk.size,
      targetByPk.size,
      identity.type,
      overlap,
      identical,
      overlap - identical,
      sourceByPk.size - overlap,
      targetByPk.size - overlap,
      conflictingSourceKeys.size,
    ].join("\t"),
  );
}

for (const relation of target.keys()) {
  if (!source.has(relation)) throw new Error(`unexpected target stream table ${relation}`);
}
