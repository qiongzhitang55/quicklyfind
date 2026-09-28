#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：把 card\\ 里每张卡的几个关键格打出来（只读）。"""
from __future__ import annotations

import glob
import importlib.util
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

spec = importlib.util.spec_from_file_location("cp", r"D:\quicklyFind\tools\card_parse.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)

for path in sorted(glob.glob(r"D:\quicklyFind\card\*.xlsx")):
    g = cp.read_workbook(path)
    m = g.get("主要", {})
    o = g.get("起源", {})
    s = g.get("法术书", {})
    print(f"{os.path.basename(path):<44}"
          f" A1={m.get((1, 1), '')[:26]!r}"
          f" E3={m.get((3, 5), '')!r} E4={m.get((4, 5), '')!r}"
          f" E6={m.get((6, 5), '')!r} 起源E6={o.get((6, 5), '')!r}"
          f" 法术书X3={s.get((3, 24), '')!r}")
