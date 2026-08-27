#!/usr/bin/env python3
"""Convert `supabase db query --output-format json` rows to stable text."""

import csv
import io
import json
import re
import sys
from pathlib import Path


MIGRATION_VERSION = re.compile(r"[0-9]{14}")


def load_rows(input_path: str) -> list[dict[str, object]]:
    with Path(input_path).open(encoding="utf-8") as input_file:
        result = json.load(input_file)
    if not isinstance(result, dict) or not isinstance(result.get("rows"), list):
        raise ValueError("linked query JSON must contain a rows array")
    rows = result["rows"]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("every linked query row must be an object")
    return rows


def migration_rows(rows: list[dict[str, object]]) -> list[tuple[str, str | None, str | None]]:
    parsed = []
    for row in rows:
        if set(row) != {"version", "statements", "name"}:
            raise ValueError("migration query returned unexpected columns")
        version = row["version"]
        statements = row["statements"]
        name = row["name"]
        if not isinstance(version, str) or MIGRATION_VERSION.fullmatch(version) is None:
            raise ValueError("migration version must contain exactly 14 digits")
        if statements is not None and (not isinstance(statements, str) or statements == ""):
            raise ValueError("migration statements must be PostgreSQL text[] text or null")
        if name is not None and (not isinstance(name, str) or name == ""):
            raise ValueError("migration name must be non-empty text or null")
        parsed.append((version, statements, name))
    if [row[0] for row in parsed] != sorted({row[0] for row in parsed}):
        raise ValueError("migration versions must be unique and sorted")
    return parsed


def write_migration_versions(rows: list[dict[str, object]], output: io.TextIOBase) -> None:
    for version, _statements, _name in migration_rows(rows):
        output.write(f"{version}\n")


def write_migration_history_csv(rows: list[dict[str, object]], output: io.TextIOBase) -> None:
    writer = csv.writer(output, lineterminator="\n")
    writer.writerows(migration_rows(rows))


def write_auth_migration_versions(rows: list[dict[str, object]], output: io.TextIOBase) -> None:
    versions = []
    for row in rows:
        if set(row) != {"version"}:
            raise ValueError("Auth migration query returned unexpected columns")
        version = row["version"]
        if (
            not isinstance(version, str)
            or not version
            or not version.isascii()
            or not version.isdigit()
        ):
            raise ValueError("Auth migration version must be non-empty ASCII digits")
        versions.append(version)
    if not versions:
        raise ValueError("Auth migration history must not be empty")
    if versions != sorted(set(versions)):
        raise ValueError("Auth migration versions must be unique and sorted")
    for version in versions:
        output.write(f"{version}\n")


def write_row_counts_tsv(rows: list[dict[str, object]], output: io.TextIOBase) -> None:
    parsed = []
    for row in rows:
        if set(row) != {"relation", "rows"}:
            raise ValueError("row-count query returned unexpected columns")
        relation = row["relation"]
        count = row["rows"]
        if not isinstance(relation, str) or any(char in relation for char in "\t\r\n"):
            raise ValueError("row-count relation must be single-line text")
        if isinstance(count, bool) or not isinstance(count, (int, str)):
            raise ValueError("row count must be a non-negative integer")
        count_text = str(count)
        if not count_text.isascii() or not count_text.isdigit():
            raise ValueError("row count must be a non-negative integer")
        parsed.append((relation, count_text))
    if [row[0] for row in parsed] != sorted({row[0] for row in parsed}):
        raise ValueError("row-count relations must be unique and sorted")
    for relation, count in parsed:
        output.write(f"{relation}\t{count}\n")


def self_test() -> None:
    rows = [
        {
            "name": "quoted_name",
            "statements": '{"select 1","select \\"quoted, value\\"","line 1\nline 2","path \\\\ value"}',
            "version": "20260827084903",
        }
    ]
    versions = io.StringIO()
    write_migration_versions(rows, versions)
    assert versions.getvalue() == "20260827084903\n"

    history = io.StringIO()
    write_migration_history_csv(rows, history)
    assert list(csv.reader(io.StringIO(history.getvalue()))) == [
        [rows[0]["version"], rows[0]["statements"], rows[0]["name"]]
    ]
    assert history.getvalue().count("\n") > 1

    auth_versions = io.StringIO()
    write_auth_migration_versions(
        [{"version": "20260302000000"}, {"version": "20260625000000"}],
        auth_versions,
    )
    assert auth_versions.getvalue() == "20260302000000\n20260625000000\n"
    for invalid_auth_rows in (
        [],
        [{"version": "20260625000000"}, {"version": "20260302000000"}],
        [{"version": "not-a-version"}],
        [{"version": "20260625000000", "unexpected": True}],
    ):
        try:
            write_auth_migration_versions(invalid_auth_rows, io.StringIO())
        except ValueError:
            pass
        else:
            raise AssertionError("invalid Auth migration rows were accepted")

    counts = io.StringIO()
    write_row_counts_tsv(
        [
            {"rows": 2, "relation": "auth.users"},
            {"rows": "10", "relation": "public.problems"},
        ],
        counts,
    )
    assert counts.getvalue() == "auth.users\t2\npublic.problems\t10\n"


def main() -> None:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: linked-query-output.py "
            "{migration-versions|migration-history-csv|auth-migration-versions|"
            "row-counts-tsv} INPUT_JSON"
        )
    mode, input_path = sys.argv[1:]
    rows = load_rows(input_path)
    writers = {
        "migration-versions": write_migration_versions,
        "migration-history-csv": write_migration_history_csv,
        "auth-migration-versions": write_auth_migration_versions,
        "row-counts-tsv": write_row_counts_tsv,
    }
    try:
        writer = writers[mode]
    except KeyError as error:
        raise SystemExit(f"unknown output mode: {mode}") from error
    writer(rows, sys.stdout)


if __name__ == "__main__":
    main()
