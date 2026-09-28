#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：列出某张表指定行区间里**带公式**的格子（只读）。

    python tools\\_formulas_in_rows.py <card.xlsx> <sheet> <起始行> <结束行> [列]
"""
from __future__ import annotations

import importlib.util
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
spec = importlib.util.spec_from_file_location("xp", r"D:\quicklyFind\tools\xlsx_patch.py")
xp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xp)

card, sheet = sys.argv[1], sys.argv[2]
r0, r1 = int(sys.argv[3]), int(sys.argv[4])
z = zipfile.ZipFile(card)
xml = z.read(xp.sheet_map(z)[sheet]).decode("utf-8")
print(f"# {card} :: {sheet} 第 {r0}-{r1} 行的公式")
for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)>(.*?)</c>', xml, re.S):
    col, row, body = m.group(1), int(m.group(2)), m.group(4)
    if row < r0 or row > r1:
        continue
    f = re.search(r"<f[^>]*>(.*?)</f>", body, re.S)
    if not f:
        continue
    print(f"   {col}{row} = {f.group(1)[:120]}")
