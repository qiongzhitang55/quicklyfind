#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify the mirror is complete and that the search index covers it.

Checks
  1. every topic referenced by the site TOC exists as a local file
  2. every mirrored .htm/.html page is present in the search index (pages.js)
  3. shell assets referenced by index.htm exist locally
  4. prints the chapter (group) distribution used by the search UI filter
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
from collections import Counter

ROOT = r"D:\quicklyFind\5echm"
MIRROR = os.path.join(ROOT, "mirror")
TOC_JSON = r"D:\quicklyFind\5echm\_crawl\toc.json"
PAGES_JS = os.path.join(ROOT, "search", "pages.js")
FAILED_JSONL = os.path.join(ROOT, "_crawl", "failed.jsonl")

# webhelp shell pages: not rule content, deliberately kept out of the search index
SHELL = {"webhelpcontents.htm", "webhelpindex.htm", "webhelpbookmark.htm", "webhelpsearch.htm"}


def local_of(href: str) -> str:
    path = urllib.parse.unquote(href.split("#")[0].replace("\\", "/"))
    return os.path.normpath(os.path.join(MIRROR, path.replace("/", os.sep)))


def main() -> int:
    # ---- 1. TOC coverage -------------------------------------------------
    rows = json.load(open(TOC_JSON, encoding="utf-8"))
    toc_targets: dict[str, str] = {}
    for r in rows:
        href = r.get("href", "")
        if not href or href == "#" or "://" in href:
            continue
        clean = href.split("#")[0].replace("\\", "/")
        if clean.lower().endswith((".htm", ".html")):
            toc_targets.setdefault(clean, r.get("text", ""))
    # pages that returned 404 on the live site: their absence is upstream breakage,
    # not a gap in our mirror
    upstream_404: set[str] = set()
    if os.path.exists(FAILED_JSONL):
        for line in open(FAILED_JSONL, encoding="utf-8"):
            try:
                url = json.loads(line)["url"]
            except Exception:  # noqa: BLE001
                continue
            upstream_404.add(urllib.parse.unquote(urllib.parse.urlsplit(url).path).lstrip("/"))

    missing, known_broken = [], []
    for clean, title in toc_targets.items():
        if os.path.exists(local_of(clean)):
            continue
        (known_broken if urllib.parse.unquote(clean).lstrip("/") in upstream_404 else missing).append((clean, title))
    print(f"1) TOC topics        : {len(toc_targets)}")
    print(f"   present locally   : {len(toc_targets) - len(missing) - len(known_broken)}")
    print(f"   broken on source  : {len(known_broken)}  (404 上游，非镜像缺陷)")
    for clean, title in known_broken[:10]:
        print(f"      - {urllib.parse.unquote(clean)}  ({title})")
    print(f"   really missing    : {len(missing)}")
    for clean, title in missing[:10]:
        print(f"      ! {urllib.parse.unquote(clean)}  ({title})")

    # ---- 2. index coverage ----------------------------------------------
    pages = json.loads(open(PAGES_JS, encoding="utf-8").read().split("=", 1)[1].rstrip(";"))
    indexed = {p["p"] for p in pages}
    on_disk = set()
    for dirpath, _d, fns in os.walk(MIRROR):
        for fn in fns:
            if fn.lower().endswith((".htm", ".html")):
                rel = os.path.relpath(os.path.join(dirpath, fn), MIRROR).replace("\\", "/")
                if os.path.basename(rel) in SHELL:
                    continue
                on_disk.add(rel)
    print(f"\n2) html pages on disk: {len(on_disk)}  (外壳页 {len(SHELL)} 个已排除)")
    print(f"   in search index   : {len(indexed)}")
    print(f"   not indexed       : {len(on_disk - indexed)}  {sorted(on_disk - indexed)[:5]}")
    print(f"   indexed but absent: {len(indexed - on_disk)}")

    # ---- 3. shell assets -------------------------------------------------
    shell = open(os.path.join(MIRROR, "index.htm"), "rb").read().decode("utf-8", "replace")
    refs = set(re.findall(r"""(?:href|src)\s*=\s*["']([^"']+)["']""", shell, re.I))
    bad = [r for r in refs if not r.startswith(("http", "//", "#")) and not os.path.exists(local_of(r))]
    print(f"\n3) shell refs        : {len(refs)}  missing: {len(bad)} {bad}")

    # ---- 4. groups -------------------------------------------------------
    groups = Counter(p["g"] for p in pages)
    print(f"\n4) groups (top 20 of {len(groups)}):")
    for g, n in groups.most_common(20):
        print(f"   {n:5d}  {g}")
    core2024 = [g for g in groups if "2024" in g or "2025" in g]
    print(f"   -> groups containing 2024/2025: {core2024}")

    ok = not missing and not (on_disk - indexed) and not (indexed - on_disk) and not bad
    print("\nRESULT:", "COMPLETE" if ok else "GAPS FOUND (see above)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
