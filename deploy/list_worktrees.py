#!/usr/bin/env python3
"""Pick which WQN worktree web-deploy.bat should build and publish.

web-deploy.bat runs this with no arguments to render the menu, then again
with --resolve to turn the picked number into a path.

Ordering: newest activity first, where activity is
    max(HEAD committer time, mtime of the newest changed/untracked file)
so a clean tree sorts by its last commit and a tree you are editing right
now sorts to the top even when its HEAD is old.

Only worktrees that actually contain this web project are listed, judged by
web/package.json. Unlike the firmware helper the project *is* the repository
root, so there is no relative path to keep track of.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
MARKER = Path("web/package.json")
ENV_FILE = Path("web/.env.production")
NUL = chr(0)


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return result.stdout if result.returncode == 0 else ""


def repo_root() -> Path:
    out = git(PROJECT_DIR, "rev-parse", "--show-toplevel").strip()
    if not out:
        raise SystemExit("not a git repository: %s" % PROJECT_DIR)
    return Path(out)


REPO_ROOT = repo_root()


def worktree_roots():
    roots = []
    for line in git(REPO_ROOT, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            roots.append(Path(line[len("worktree "):].strip()))
    return roots


def newest_activity(root: Path):
    """(activity timestamp, is dirty) for this tree."""
    stamp = 0.0
    raw = git(root, "log", "-1", "--format=%ct").strip()
    if raw:
        stamp = float(raw)
    status = git(root, "status", "--porcelain", "-z", "-uall")
    dirty = bool(status.strip(NUL).strip())
    for entry in status.split(NUL):
        if len(entry) > 3:
            try:
                stamp = max(stamp, (root / entry[3:]).stat().st_mtime)
            except OSError:
                pass
    return stamp, dirty


def label(root: Path) -> str:
    branch = git(root, "rev-parse", "--abbrev-ref", "HEAD").strip()
    if branch and branch != "HEAD":
        return branch
    sha = git(root, "rev-parse", "--short=8", "HEAD").strip() or "?"
    return "detached@" + sha


def shorten(root: Path) -> str:
    home = str(Path.home())
    text = str(root)
    if text == home or text.startswith(home + "/"):
        return "~" + text[len(home):]
    return text


def collect():
    rows = []
    for root in worktree_roots():
        if not (root / MARKER).is_file():
            continue
        stamp, dirty = newest_activity(root)
        rows.append({"root": root, "stamp": stamp, "dirty": dirty, "label": label(root)})
    rows.sort(key=lambda row: (-row["stamp"], str(row["root"])))
    return rows


def render(rows) -> None:
    if not rows:
        raise SystemExit("no worktree contains %s" % MARKER)
    width = min(max(len(row["label"]) for row in rows), 34)
    print("  #  modified          state  %-*s  tree" % (width, "branch"))
    for index, row in enumerate(rows, start=1):
        when = datetime.fromtimestamp(row["stamp"]).strftime("%m-%d %H:%M")
        mark = "*" if row["root"].resolve() == PROJECT_DIR.resolve() else " "
        print(
            "%3d%s %s  %-5s  %-*s  %s"
            % (
                index,
                mark,
                when,
                "dirty" if row["dirty"] else "clean",
                width,
                row["label"],
                shorten(row["root"]),
            )
        )
    print("       (* = this checkout)")


def resolve(rows, picks: str) -> int:
    chosen = []
    for part in picks.replace(" ", ",").replace(chr(13), ",").split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit():
            print("invalid selection: %s" % part, file=sys.stderr)
            return 2
        number = int(part)
        if number == 0 or number > len(rows):
            print("selection out of range: %d (1-%d)" % (number, len(rows)), file=sys.stderr)
            return 2
        if number not in chosen:
            chosen.append(number)
    if not chosen:
        print("nothing selected", file=sys.stderr)
        return 2
    for number in chosen:
        print(rows[number - 1]["root"])
    return 0


def env_source():
    """A tree holding the gitignored .env.production, for injection."""
    for root in worktree_roots():
        if (root / ENV_FILE).is_file():
            return root
    return None


def plan(root: Path) -> int:
    """Describe what a release from this tree would publish."""
    if not (root / MARKER).is_file():
        print("not a WQN web tree: %s" % root, file=sys.stderr)
        return 2
    dirty = git(root, "status", "--porcelain", "-uall").splitlines()
    print("  tree:    %s" % shorten(root))
    print("  branch:  %s" % label(root))
    print("  HEAD:    %s" % (git(root, "rev-parse", "--short=12", "HEAD").strip() or "?"))
    print("  subject: %s" % git(root, "log", "-1", "--format=%s").strip())
    if dirty:
        print("  dirty:   %d path(s) -- they WILL be published" % len(dirty))
    else:
        print("  dirty:   clean")
    if (root / ENV_FILE).is_file():
        print("  env:     %s present" % ENV_FILE)
    else:
        source = env_source()
        if source:
            print("  env:     MISSING -- will be copied from %s" % shorten(source / ENV_FILE))
        else:
            print("  env:     MISSING and no tree has one -- the release will fail")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolve", metavar="N", help="print the picked tree path")
    parser.add_argument("--repo-root", action="store_true", help="print the repository root")
    parser.add_argument("--env-source", action="store_true", help="print a tree holding the env file")
    parser.add_argument("--plan", metavar="DIR", help="describe a release from this tree")
    args = parser.parse_args()
    if args.repo_root:
        print(REPO_ROOT)
        return 0
    if args.env_source:
        source = env_source()
        if not source:
            return 1
        print(source / ENV_FILE)
        return 0
    if args.plan:
        return plan(Path(args.plan))
    rows = collect()
    if args.resolve:
        return resolve(rows, args.resolve)
    render(rows)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
