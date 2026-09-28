#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：把一张卡某个工作表里的非空格按行列打出来（只读）。

    python tools\\_peek.py <card.xlsx> <sheet> [起始行] [结束行] [起始列] [结束列]
"""
from __future__ import annotations

import importlib.util
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

spec = importlib.util.spec_from_file_location("cp", r"D:\quicklyFind\tools\card_parse.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)


def main() -> int:
    card, sheet = sys.argv[1], sys.argv[2]
    r0 = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    r1 = int(sys.argv[4]) if len(sys.argv) > 4 else 9999
    c0 = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    c1 = int(sys.argv[6]) if len(sys.argv) > 6 else 999
    grid = cp.read_workbook(card).get(sheet, {})
    print(f"# {card} :: {sheet}  (共 {len(grid)} 个非空格)")
    for (r, c) in sorted(grid):
        if not (r0 <= r <= r1 and c0 <= c <= c1):
            continue
        v = grid[(r, c)].replace("\n", "\\n")
        print(f"  {cp.col_letter(c)}{r} = {v[:110]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
