#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Quality gate for the plain-text rule corpus in D:\\quicklyFind\\rules-text.

Reports: leaked HTML tags, replacement characters, tiny/empty pages,
duplicate page bodies and total size. Exit code 1 if a real problem shows up.

  python tools\\qa_text.py
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import os
import re
import sys

DEFAULT_DIR = r"D:\quicklyFind\rules-text"
TAG_RE = re.compile(r"</?(?:p|br|div|span|strong|em|font|table|tr|td|h[1-6]|a|u|li|ul|img|body|html)\b[^>]*>", re.I)
SEP = "=" * 60


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=DEFAULT_DIR)
    ap.add_argument("--leak-threshold", type=int, default=3, help="HTML tag count above which a file counts as leaked")
    ap.add_argument("--min-bytes", type=int, default=400)
    args = ap.parse_args()

    pages = os.path.join(args.dir, "pages")
    if not os.path.isdir(pages):
        print(f"not found: {pages}")
        return 1

    files = [
        os.path.join(dp, fn)
        for dp, _d, fns in os.walk(pages)
        for fn in fns
        if fn.endswith(".txt")
    ]
    leak, garbled, tiny = [], [], []
    bodies = collections.Counter()
    total = 0
    for f in files:
        with open(f, encoding="utf-8", errors="replace") as fh:
            t = fh.read()
        total += os.path.getsize(f)
        n_tag = len(TAG_RE.findall(t))
        if n_tag > args.leak_threshold:
            leak.append((os.path.relpath(f, args.dir), n_tag))
        if t.count("\ufffd") > 5:
            garbled.append((os.path.relpath(f, args.dir), t.count("\ufffd")))
        if os.path.getsize(f) < args.min_bytes:
            tiny.append((os.path.relpath(f, args.dir), os.path.getsize(f)))
        bodies[hashlib.md5(t.split(SEP, 1)[-1].strip().encode()).hexdigest()] += 1

    dups = {k: v for k, v in bodies.items() if v > 1}
    print(f"files                     : {len(files):,}")
    print(f"total size                : {total/1048576:.1f} MB")
    print(f"HTML-tag leakage          : {len(leak)} file(s)")
    for p, n in leak[:10]:
        print(f"    {n:5d} tags  {p}")
    print(f"replacement chars (U+FFFD): {len(garbled)} file(s)")
    for p, n in garbled[:10]:
        print(f"    {n:5d} chars {p}")
    print(f"pages under {args.min_bytes} bytes     : {len(tiny)} file(s)")
    for p, n in tiny[:10]:
        print(f"    {n:6d} B    {p}")
    print(f"duplicate bodies          : {len(dups)} group(s), {sum(dups.values())} file(s)")

    bad = len(leak) + len(garbled)
    print("\nRESULT:", "CLEAN" if bad == 0 else f"{bad} PROBLEM FILE(S)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
