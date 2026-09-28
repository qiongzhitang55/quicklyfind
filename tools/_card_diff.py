#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：逐格对比两张人物卡，看看差在哪儿（只读）。

    python tools\\_card_diff.py <a.xlsx> <b.xlsx> [工作表 ...]

默认只打有差异的格；给了工作表名就只看那几张。
"""
from __future__ import annotations

import importlib.util
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

spec = importlib.util.spec_from_file_location("cp", r"D:\quicklyFind\tools\card_parse.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)


def main() -> int:
    a, b = sys.argv[1], sys.argv[2]
    only = set(sys.argv[3:])
    ga = cp.read_workbook(a)
    gb = cp.read_workbook(b)
    print(f"A = {a}")
    print(f"B = {b}\n")
    total = 0
    for sheet in ga:
        if only and sheet not in only:
            continue
        ca, cb = ga[sheet], gb.get(sheet, {})
        diffs = sorted(set(ca) | set(cb))
        diffs = [k for k in diffs if ca.get(k) != cb.get(k)]
        if not diffs:
            continue
        total += len(diffs)
        print(f"===== {sheet}  ({len(diffs)} 处不同) =====")
        for (r, c) in diffs:
            va = (ca.get((r, c)) or "").replace("\n", "\\n")[:48]
            vb = (cb.get((r, c)) or "").replace("\n", "\\n")[:48]
            print(f"  {cp.col_letter(c)}{r}: A={va!r}  B={vb!r}")
    print(f"\n合计 {total} 处不同")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
