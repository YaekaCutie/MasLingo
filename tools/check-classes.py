"""Compare the mas-* classes the extension uses against the ones its CSS defines.

Written after splitting the stylesheet into modules: `.mas-foot`, `.mas-line` and
`.mas-version` were used by the panel's markup but never carried across, so the
settings row stopped being a flex row and the version number sat next to the
label instead of at the right edge. Nothing failed — the panel just looked wrong.

Ids and classes share one namespace here (`#mas-line` and `.mas-line` are the
same word), which is what makes a naive text scan noisy. So the two questions are
answered from different sets:

  * "used but undefined"  -> every mas-* token in JS, minus the ones that are ids
  * "defined but unused"  -> every class in CSS, minus every token in JS

Usage:  python tools/check-classes.py
Exit code 1 when a class is used but undefined.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "extension" / "content"

# Keyframe names and custom properties: referenced by JS, owned by CSS, and not
# classes at all.
IGNORE = {
    "mas-gx", "mas-gy", "mas-drift", "mas-pulse", "mas-settle",
    "mas-status-in", "mas-status-out", "mas-loading-spin",
}

ID_PATTERNS = [
    r"""\bid\s*=\s*["'`](mas-[a-z0-9-]+)""",
    r"""getElementById\(\s*["'`](mas-[a-z0-9-]+)""",
    r"""querySelector(?:All)?\(\s*["'`][^"'`]*#(mas-[a-z0-9-]+)""",
    r"""closest\(\s*["'`][^"'`]*#(mas-[a-z0-9-]+)""",
    # Constants: `const LAYER_ID = "mas-layer"`. Without this the element is
    # reported as an undefined class, which is a false alarm that would train
    # everyone to ignore the check.
    r"""\b[A-Za-z_$][\w$]*[Ii][Dd]\s*=\s*["'`](mas-[a-z0-9-]+)""",
]


def sources() -> list[Path]:
    return list(CONTENT.glob("*.js")) + [ROOT / "extension" / "popup" / "popup.js"]


def defined_classes() -> set[str]:
    css = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((CONTENT / "styles").glob("*.css"))
    )
    # `#mas-layer` is an id rule; only `.mas-*` selectors count as classes.
    return set(re.findall(r"\.(mas-[a-z0-9-]+)", css))


def js_tokens() -> tuple[set[str], set[str]]:
    """Return (every mas-* token in JS, the subset that names an element id)."""
    used: set[str] = set()
    ids: set[str] = set()
    for path in sources():
        text = path.read_text(encoding="utf-8")
        # Strip custom properties first: `--mas-dot-ok` is a colour token and
        # would otherwise be reported as an undefined class.
        text = re.sub(r"--mas-[a-z0-9-]+", " ", text)
        for pattern in ID_PATTERNS:
            ids |= set(re.findall(pattern, text))
        # A template fragment like `mas-toast-${kind}` leaves a bare prefix.
        used |= {
            token for token in re.findall(r"\b(mas-[a-z0-9-]+)", text)
            if not token.endswith("-")
        }
    return used - IGNORE, ids - IGNORE


def main() -> int:
    defined = defined_classes()
    used, ids = js_tokens()

    missing = sorted(used - ids - defined)
    unused = sorted(defined - used)

    print(f"CSS 定义了 {len(defined)} 个类，JS 里出现 {len(used)} 个 mas-* 名字"
          f"（其中 {len(ids)} 个是 id）\n")

    if missing:
        print("用在 JS 里但 CSS 没有定义（会导致样式静默丢失）：")
        for name in missing:
            print(f"  .{name}")
    else:
        print("用在 JS 里的类都有定义 ✓")

    if unused:
        print("\nCSS 定义了但 JS 里没出现（可能是死代码）：")
        for name in unused:
            print(f"  .{name}")

    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
