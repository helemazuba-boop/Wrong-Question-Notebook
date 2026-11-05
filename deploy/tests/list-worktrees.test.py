#!/usr/bin/env python3
"""Menu data for supabase-push.sh: per-tree Supabase migration delta.

Builds a throwaway repository with one feature worktree, so the assertions do
not depend on this machine's real worktree layout.
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEPLOY_DIR = Path(__file__).resolve().parents[1]


def git(cwd, *args, check=True):
    return subprocess.run(
        ["git", "-c", "user.email=test@example.invalid", "-c", "user.name=test", *args],
        cwd=str(cwd),
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def helper_run(helper, *args, check=True):
    return subprocess.run(
        [sys.executable, str(helper), *args],
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def fail(message):
    print("FAIL: %s" % message, file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    tmp = Path(tempfile.mkdtemp())
    try:
        main_tree = tmp / "main"
        migrations = main_tree / "web" / "supabase" / "migrations"
        (main_tree / "deploy").mkdir(parents=True)
        migrations.mkdir(parents=True)
        helper = main_tree / "deploy" / "list_worktrees.py"
        shutil.copy(DEPLOY_DIR / "list_worktrees.py", helper)
        (main_tree / "web" / "package.json").write_text("{}\n")
        (migrations / "20260101000000_base.sql").write_text("select 1;\n")
        git(main_tree, "init", "-q", "-b", "main")
        git(main_tree, "add", "-A")
        git(main_tree, "commit", "-q", "-m", "base")

        feature = tmp / "feature"
        git(main_tree, "worktree", "add", "-q", "-b", "feat", str(feature))
        (feature / "web" / "supabase" / "migrations" / "20260301000000_feature.sql").write_text(
            "select 2;\n"
        )
        git(feature, "add", "-A")
        git(feature, "commit", "-q", "-m", "feature")

        # Untracked in the main worktree, never committed anywhere.
        (migrations / "20260201000000_untracked.sql").write_text("select 3;\n")

        table = helper_run(helper, "--migrations")
        header = table.splitlines()[0]
        if "mig" not in header:
            fail("--migrations did not add the mig column: %s" % header)
        feature_line = next(
            (line for line in table.splitlines() if str(feature) in line), None
        )
        main_line = next(
            (line for line in table.splitlines() if str(main_tree) in line), None
        )
        if feature_line is None or main_line is None:
            fail("menu did not list both worktrees:\n%s" % table)
        if "+1" not in feature_line:
            fail("feature worktree did not report one extra migration: %s" % feature_line)
        if "!1" not in main_line:
            fail("main worktree did not report one untracked migration: %s" % main_line)

        number = feature_line.split()[0]
        resolved = helper_run(helper, "--resolve", number).strip()
        if resolved != str(feature):
            fail("--resolve %s returned %r" % (number, resolved))

        plain = helper_run(helper)
        if "mig" in plain.splitlines()[0]:
            fail("the default menu gained the mig column")

        detail = helper_run(helper, "--plan", str(feature), "--migrations")
        if "20260301000000_feature.sql" not in detail:
            fail("--plan did not name the extra migration:\n%s" % detail)
        if "1 extra, 1 missing, 0 untracked" not in detail:
            fail("--plan reported the wrong delta:\n%s" % detail)

        detail = helper_run(helper, "--plan", str(main_tree), "--migrations")
        if "0 extra, 0 missing, 1 untracked" not in detail:
            fail("--plan reported the wrong delta for the main tree:\n%s" % detail)
    finally:
        subprocess.run(["git", "-C", str(tmp / "main"), "worktree", "prune"], check=False)
        shutil.rmtree(tmp, ignore_errors=True)

    print("PASS: worktree menu migration columns")
    return 0


if __name__ == "__main__":
    sys.exit(main())
