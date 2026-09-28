#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：看某张表某些格子是「公式」还是「字面值」（只读）。

    python tools\\_cells_detail.py <card.xlsx> <sheet> <cell> [cell ...]
"""
from __future__ import annotations

import re
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

spec_path = r"D:\quicklyFind\tools\xlsx_patch.py"
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("xp", spec_path)
xp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xp)

card, sheet = sys.argv[1], sys.argv[2]
cells = [c.upper() for c in sys.argv[3:]]
z = zipfile.ZipFile(card)
xml = z.read(xp.sheet_map(z)[sheet]).decode("utf-8")
print(f"# {card} :: {sheet}")
for cell in cells:
    m = re.search(r'<c r="%s"([^>]*?)(?:/>|>(.*?)</c>)' % re.escape(cell), xml, re.S)
    if not m:
        print(f"  {cell:<6} （没有这个格子）")
        continue
    body = m.group(2) or ""
    f = re.search(r"<f[^>]*>(.*?)</f>", body, re.S)
    v = re.search(r"<v[^>]*>(.*?)</v>", body, re.S)
    isx = re.search(r"<is>.*?<t[^>]*>(.*?)</t>", body, re.S)
    val = (isx.group(1) if isx else (v.group(1) if v else ""))
    print(f"  {cell:<6} {'公式 = ' + f.group(1)[:70] if f else '字面值'}"
          f"   t={re.search(r't=\"(\w+)\"', m.group(1)).group(1) if re.search(r't=\"(\w+)\"', m.group(1)) else '-'}"
          f"   值={val[:40]!r}  attrs={m.group(1).strip()!r}")
