#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：列出某张表的数据验证（下拉）及其范围（只读）。

    python tools\\_validations.py <card.xlsx> <sheet> [关键字]
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
needle = sys.argv[3] if len(sys.argv) > 3 else ""

z = zipfile.ZipFile(card)
xml = z.read(xp.sheet_map(z)[sheet]).decode("utf-8")
print(f"# {card} :: {sheet} 的数据验证")
for m in re.finditer(r"<dataValidation\b[^>]*>.*?</dataValidation>|<dataValidation\b[^>]*/>", xml, re.S):
    block = m.group(0)
    sq = re.search(r'sqref="([^"]*)"', block)
    f1 = re.search(r"<formula1>(.*?)</formula1>", block, re.S)
    if not sq:
        continue
    label = xp.xml_escape(sq.group(1))
    if needle and needle not in label:
        continue
    val = (f1.group(1) if f1 else "").strip()
    print(f"   {label:<28} {val[:90]}")
