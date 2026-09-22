#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列出 8 张角色表的非空字面量，按行铺开，便于人工判断哪些是"角色数据"。"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"
OUT = r"D:\quicklyFind\card\analysis\literals.txt"
CHAR_SHEETS = ["主要", "法术书", "背包", "背景", "盟友与魔宠", "据点", "骰娘导入", "自定义调整栏"]


def col_letter(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def cnum(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n


z = zipfile.ZipFile(CARD)
shared = []
root = ET.fromstring(z.read("xl/sharedStrings.xml"))
for si in root.findall(f"{NS}si"):
    shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
relmap = {r.get("Id"): r.get("Target") for r in rels}
wb = ET.fromstring(z.read("xl/workbook.xml"))

with open(OUT, "w", encoding="utf-8") as fh:
    for sh in wb.find(f"{NS}sheets"):
        name = sh.get("name")
        if name not in CHAR_SHEETS:
            continue
        t = relmap.get(sh.get(f"{RNS}id"), "")
        p = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
        rows = defaultdict(list)
        for _e, el in ET.iterparse(io.BytesIO(z.read(p)), events=("end",)):
            if el.tag != f"{NS}c":
                continue
            if el.find(f"{NS}f") is not None:
                el.clear(); continue
            tt = el.get("t")
            v = el.find(f"{NS}v")
            isx = el.find(f"{NS}is")
            if tt == "s" and v is not None and v.text:
                val = shared[int(v.text)] if int(v.text) < len(shared) else ""
            elif tt == "inlineStr" and isx is not None:
                val = "".join(x.text or "" for x in isx.iter(f"{NS}t"))
            elif v is not None:
                val = v.text or ""
            else:
                val = ""
            val = val.strip()
            if val:
                ref = el.get("r") or ""
                rows[int(re.search(r"(\d+)", ref).group(1))].append((cnum(ref), val, el.get("s") or "0"))
            el.clear()
        total = sum(len(v) for v in rows.values())
        fh.write(f"\n{'#'*100}\n### {name}   非空字面量 {total} 格\n{'#'*100}\n")
        for r in sorted(rows):
            cells = sorted(rows[r])
            line = "  ".join(f"{col_letter(c)}:{v[:26]}" for c, v, _ in cells)
            fh.write(f"R{r:<4} {line}\n")

print(f"写出 -> {OUT}")
import os
print(f"行数: {sum(1 for _ in open(OUT, encoding='utf-8'))}")
