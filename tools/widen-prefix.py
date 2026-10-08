"""Give the injected CSS a prefix a host page cannot plausibly collide with.

The specification asks for either Shadow DOM or "a prefix with very high
uniqueness, for example maslingo-glass-*". This takes the prefix route: the UI is
injected into arbitrary pages, and `mas-` is short enough that a site with its own
`.mas-panel` would break the extension's styling in ways that look like our bug.

Only the CSS-facing names change — classes, element ids and custom properties.
The `MAS_*` globals stay as they are: content scripts run in an isolated world, so
they cannot collide with page script, and renaming them would churn every file for
no isolation benefit.

    python tools/widen-prefix.py            # dry run
    python tools/widen-prefix.py --apply
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = re.compile(r"\\(node_modules|\.git|\.venv|testdata|screenshots|__pycache__)\\|\.bak-")
SUFFIXES = {".js", ".mjs", ".css", ".html", ".json", ".py", ".md"}

# `mas-` followed by anything except `lingo-`, so re-running is a no-op rather
# than producing `maslingo-lingo-panel`.
PATTERN = re.compile(r"\bmas-(?!lingo-)")

# Files that describe the migration itself, excluded for the same reason as the
# project rename: rewriting the pattern would turn the rule into a no-op.
SELF = {Path(__file__).resolve()}


def targets() -> list[Path]:
    found = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in SUFFIXES:
            continue
        if SKIP.search(str(path)) or path.resolve() in SELF:
            continue
        found.append(path)
    return found


def main() -> None:
    apply = "--apply" in sys.argv
    total = 0
    files = 0
    for path in targets():
        text = path.read_text(encoding="utf-8", errors="replace")
        updated, count = PATTERN.subn("maslingo-", text)
        if not count:
            continue
        files += 1
        total += count
        print(f"  {count:>4}  {path.relative_to(ROOT)}")
        if apply:
            path.write_text(updated, encoding="utf-8")

    verb = "已改写" if apply else "将改写"
    print(f"\n{verb} {files} 个文件，{total} 处")
    if not apply:
        print("（dry run：加 --apply 才写入）")


if __name__ == "__main__":
    main()
