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

With --migrations the menu also compares each tree's Supabase migrations with
the main worktree, because a pushed migration cannot be rolled back the way a
published image can. supabase-push.sh renders the menu this way.
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
MIGRATIONS = Path("web/supabase/migrations")
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
    """(activity timestamp, is dirty, porcelain entries) for this tree."""
    stamp = 0.0
    raw = git(root, "log", "-1", "--format=%ct").strip()
    if raw:
        stamp = float(raw)
    status = git(root, "status", "--porcelain", "-z", "-uall")
    entries = [entry for entry in status.split(NUL) if len(entry) > 3]
    for entry in entries:
        try:
            stamp = max(stamp, (root / entry[3:]).stat().st_mtime)
        except OSError:
            pass
    return stamp, bool(entries), entries


def main_root() -> Path:
    """The main worktree: baseline for migration comparison and env lookup."""
    roots = worktree_roots()
    return roots[0] if roots else REPO_ROOT


def migration_names(root: Path):
    """Migrations present on disk, which is what `supabase db push` reads."""
    directory = root / MIGRATIONS
    if not directory.is_dir():
        return set()
    return {path.name for path in directory.glob("*.sql")}


def migration_status(root: Path, entries, baseline):
    """(migrations this tree adds, untracked migration paths) against baseline."""
    prefix = str(MIGRATIONS) + "/"
    untracked = sorted(
        entry[3:]
        for entry in entries
        if entry.startswith("??") and entry[3:].startswith(prefix)
    )
    extra = sorted(migration_names(root) - baseline)
    return extra, untracked


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
    baseline = migration_names(main_root())
    rows = []
    for root in worktree_roots():
        if not (root / MARKER).is_file():
            continue
        stamp, dirty, entries = newest_activity(root)
        extra, untracked = migration_status(root, entries, baseline)
        rows.append(
            {
                "root": root,
                "stamp": stamp,
                "dirty": dirty,
                "label": label(root),
                "extra": extra,
                "untracked": untracked,
            }
        )
    rows.sort(key=lambda row: (-row["stamp"], str(row["root"])))
    return rows


def migration_tag(row) -> str:
    tag = ""
    if row["extra"]:
        tag += "+%d" % len(row["extra"])
    if row["untracked"]:
        tag += "!%d" % len(row["untracked"])
    return tag or "-"


def render(rows, migrations: bool = False) -> None:
    if not rows:
        raise SystemExit("no worktree contains %s" % MARKER)
    width = min(max(len(row["label"]) for row in rows), 34)
    if migrations:
        print("  #  modified          state  %-6s  %-*s  tree" % ("mig", width, "branch"))
    else:
        print("  #  modified          state  %-*s  tree" % (width, "branch"))
    for index, row in enumerate(rows, start=1):
        when = datetime.fromtimestamp(row["stamp"]).strftime("%m-%d %H:%M")
        mark = "*" if row["root"].resolve() == PROJECT_DIR.resolve() else " "
        state = "dirty" if row["dirty"] else "clean"
        if migrations:
            print(
                "%3d%s %s  %-5s  %-6s  %-*s  %s"
                % (
                    index,
                    mark,
                    when,
                    state,
                    migration_tag(row),
                    width,
                    row["label"],
                    shorten(row["root"]),
                )
            )
        else:
            print(
                "%3d%s %s  %-5s  %-*s  %s"
                % (index, mark, when, state, width, row["label"], shorten(row["root"]))
            )
    print("       (* = this checkout)")
    if migrations:
        print("       (+N = migrations this tree adds vs main; !N = untracked)")


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


def plan(root: Path, migrations: bool = False) -> int:
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
    if migrations:
        print("  env:     always %s" % shorten(main_root() / ENV_FILE))
    elif (root / ENV_FILE).is_file():
        print("  env:     %s present" % ENV_FILE)
    else:
        source = env_source()
        if source:
            print("  env:     MISSING -- will be copied from %s" % shorten(source / ENV_FILE))
        else:
            print("  env:     MISSING and no tree has one -- the release will fail")
    if migrations:
        baseline = migration_names(main_root())
        here = migration_names(root)
        extra, untracked = migration_status(root, dirty, baseline)
        missing = sorted(baseline - here)
        print("  migrations: %d file(s) in %s" % (len(here), MIGRATIONS))
        print(
            "  vs main:    %d extra, %d missing, %d untracked"
            % (len(extra), len(missing), len(untracked))
        )
        for name in extra:
            print("    + %s" % name)
        for path in untracked:
            print("    ! %s" % path)
        for name in missing[:5]:
            print("    - %s" % name)
        if len(missing) > 5:
            print("    ... %d more missing" % (len(missing) - 5))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolve", metavar="N", help="print the picked tree path")
    parser.add_argument("--repo-root", action="store_true", help="print the repository root")
    parser.add_argument("--env-source", action="store_true", help="print a tree holding the env file")
    parser.add_argument("--plan", metavar="DIR", help="describe a release from this tree")
    parser.add_argument(
        "--migrations",
        action="store_true",
        help="compare Supabase migrations against the main worktree",
    )
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
        return plan(Path(args.plan), args.migrations)
    rows = collect()
    if args.resolve:
        return resolve(rows, args.resolve)
    render(rows, args.migrations)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
