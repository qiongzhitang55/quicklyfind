#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：在某张表里按文本找公式，打印单元格 + 公式全文（只读）。

    python tools\\_grep_formula.py <card.xlsx> <sheet> <关键字>
"""
from __future__ import annotations

import re
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("xp", r"D:\quicklyFind\tools\xlsx_patch.py")
xp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xp)

card, sheet, needle = sys.argv[1], sys.argv[2], sys.argv[3]
z = zipfile.ZipFile(card)
sheets = xp.sheet_map(z)
names = list(sheets) if sheet == "*" else [sheet]
n = 0
for name in names:
    xml = z.read(sheets[name]).decode("utf-8")
    for m in re.finditer(r'<c r="([A-Z]+\d+)"([^>]*?)>(.*?)</c>', xml, re.S):
        body = m.group(3)
        f = re.search(r"<f[^>]*>(.*?)</f>", body, re.S)
        if not f or needle not in f.group(1):
            continue
        n += 1
        print(f"[{name}] {m.group(1)}: ={f.group(1)[:200]}")
print(f"—— 共 {n} 条")
