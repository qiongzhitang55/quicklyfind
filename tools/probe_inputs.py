#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""找"输入格"的权威信号：dataValidation 范围、sheetProtection、单元格 protection。"""
from __future__ import annotations

import re
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"

z = zipfile.ZipFile(CARD)
rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
relmap = {r.get("Id"): r.get("Target") for r in rels}
wb = ET.fromstring(z.read("xl/workbook.xml"))

styles = ET.fromstring(z.read("xl/styles.xml"))
xfs = list(styles.find(f"{NS}cellXfs"))
protected_xf = [i for i, xf in enumerate(xfs) if xf.get("applyProtection") == "1" or xf.find(f"{NS}protection") is not None]
print(f"cellXfs 总数: {len(xfs)}，带 protection 的: {len(protected_xf)}")

print("\n" + "=" * 90)
for sh in wb.find(f"{NS}sheets"):
    name = sh.get("name")
    t = relmap.get(sh.get(f"{RNS}id"), "")
    p = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
    xml = z.read(p).decode("utf-8", "replace")

    prot = re.search(r"<sheetProtection[^>]*>", xml)
    dvs = re.findall(r"<dataValidation\b[^>]*>(.*?)</dataValidation>|<dataValidation\b[^>]*/>", xml, re.S)
    sqrefs = []
    for m in re.finditer(r"<dataValidation\b([^>]*)", xml):
        sq = re.search(r'sqref="([^"]*)"', m.group(1))
        if sq:
            sqrefs.append(sq.group(1))
    n_dv = len(re.findall(r"<dataValidation\b", xml))
    if prot or n_dv:
        print(f"\n[{name}]  保护={'是' if prot else '否'}  数据验证={n_dv} 段")
        if prot:
            print(f"     {prot.group(0)[:150]}")
        for s in sqrefs[:12]:
            print(f"     验证范围: {s[:150]}")
