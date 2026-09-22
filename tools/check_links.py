#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify that every relative link in the mirrored site resolves to a local file.

Writes D:\\quicklyFind\\5echm\\_crawl\\linkcheck.txt and prints a summary.
"""
from __future__ import annotations

import os
import posixpath
import re
import sys
import urllib.parse
from collections import Counter, defaultdict

MIRROR = r"D:\quicklyFind\5echm\mirror"
REPORT = r"D:\quicklyFind\5echm\_crawl\linkcheck.txt"
REF_RE = re.compile(r"""(?:href|src)\s*=\s*["']([^"']+)["']""", re.I)
ILLEGAL = set('<>:"|?*')


def main() -> int:
    files: set[str] = set()
    for dirpath, _d, fns in os.walk(MIRROR):
        for fn in fns:
            rel = os.path.relpath(os.path.join(dirpath, fn), MIRROR).replace("\\", "/")
            files.add(rel)

    missing: dict[str, list[str]] = defaultdict(list)
    illegal_targets: Counter = Counter()
    checked = 0
    for rel in sorted(files):
        if not rel.lower().endswith((".htm", ".html", ".css")):
            continue
        src_dir = posixpath.dirname(rel)
        try:
            txt = open(os.path.join(MIRROR, rel.replace("/", os.sep)), "rb").read().decode("utf-8", "replace")
        except OSError:
            continue
        for ref in REF_RE.findall(txt):
            if not ref or ref.startswith(("#", "http:", "https:", "mailto:", "javascript:", "data:", "tel:")):
                continue
            # split off fragment/query *before* percent-decoding, then decode:
            # the mirror stores files under their decoded (real) names, exactly
            # like a browser resolves them.
            target = urllib.parse.unquote(ref.split("#")[0].split("?")[0].replace("\\", "/")).strip()
            if not target:
                continue
            resolved = posixpath.normpath(posixpath.join(src_dir, target)) if src_dir else posixpath.normpath(target)
            if target.endswith("/"):
                resolved = posixpath.join(resolved, "index.html")
            checked += 1
            if resolved in files:
                continue
            if any(ch in ILLEGAL for ch in resolved):
                illegal_targets[resolved] += 1
            missing[resolved].append(rel)

    with open(REPORT, "w", encoding="utf-8") as fh:
        fh.write(f"links checked: {checked}\n")
        fh.write(f"unresolved targets: {len(missing)}\n")
        fh.write(f"of which contain Windows-illegal characters: {len(illegal_targets)}\n\n")
        for target, sources in sorted(missing.items(), key=lambda kv: -len(kv[1])):
            fh.write(f"{len(sources):5d}  {target}\n")
            for s in sources[:3]:
                fh.write(f"         <- {s}\n")

    print(f"links checked      : {checked}")
    print(f"unresolved targets : {len(missing)}   (see {REPORT})")
    print(f"illegal-char paths : {len(illegal_targets)}")
    for target, srcs in sorted(missing.items(), key=lambda kv: -len(kv[1]))[:15]:
        print(f"  {len(srcs):4d}x  {urllib.parse.unquote(target)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
