#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：列出某张表的合并单元格（只读），可限定行范围。

    python tools\\_merges.py <card.xlsx> <sheet> [起始行] [结束行]
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
r0 = int(sys.argv[3]) if len(sys.argv) > 3 else 1
r1 = int(sys.argv[4]) if len(sys.argv) > 4 else 9999

z = zipfile.ZipFile(card)
xml = z.read(xp.sheet_map(z)[sheet]).decode("utf-8")
block = re.search(r"<mergeCells.*?</mergeCells>", xml, re.S)
refs = re.findall(r'<mergeCell ref="([A-Z]+\d+:[A-Z]+\d+)"', block.group(0) if block else "")
print(f"# {card} :: {sheet}  合并区 {len(refs)} 个，下面只列 {r0}-{r1} 行")
for ref in refs:
    m = re.match(r"([A-Z]+)(\d+)", ref)
    row = int(m.group(2))
    if r0 <= row <= r1:
        print("   ", ref)
