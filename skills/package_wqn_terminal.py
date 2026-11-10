#!/usr/bin/env python3
"""Build a reproducible, allowlisted Skill ZIP without local state or tests."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/wqn-terminal.zip"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent / "wqn-terminal"
    files = ("SKILL.md", "scripts/wqn.py", "references/cli.md")
    contents = {}
    for name in files:
        source = root / name
        if source.is_symlink():
            raise ValueError("Package source must not be a symlink")
        data = source.read_bytes()
        if re.search(rb"wqn_(?:oa|rt|dc)_[0-9a-f]{64}|-----BEGIN [A-Z ]*PRIVATE KEY-----", data):
            raise ValueError("Credential-like content found in package source")
        contents[name] = data
    ast.parse(contents["scripts/wqn.py"], filename="wqn.py")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in contents.items():
            entry = zipfile.ZipInfo("wqn-terminal/" + name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data, compresslevel=9)
    with zipfile.ZipFile(args.output) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == ["wqn-terminal/" + name for name in files]
    print(json.dumps({"archive": str(args.output.resolve()), "files": list(contents),
                      "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                      "bytes": args.output.stat().st_size}))


if __name__ == "__main__":
    main()
