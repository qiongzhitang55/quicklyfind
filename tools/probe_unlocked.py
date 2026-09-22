#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用"工作表保护 + 单元格未锁定"来精确定位输入格。

在受保护的工作表里，作者必须把要你填的格子设为 unlocked，否则你根本输不进去。
所以 unlocked 就是"角色数据格"的权威定义。
"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"

z = zipfile.ZipFile(CARD)
shared = []
root = ET.fromstring(z.read("xl/sharedStrings.xml"))
for si in root.findall(f"{NS}si"):
    shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

styles = ET.fromstring(z.read("xl/styles.xml"))
unlocked = []          # style index -> is unlocked
for xf in styles.find(f"{NS}cellXfs"):
    p = xf.find(f"{NS}protection")
    if p is None:
        unlocked.append(False)          # 无 protection 元素 = 默认锁定
    else:
        unlocked.append(p.get("locked") == "0")
n_un = sum(1 for u in unlocked if u)
print(f"cellXfs: {len(unlocked)}，未锁定样式: {n_un}")

rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
relmap = {r.get("Id"): r.get("Target") for r in rels}
wb = ET.fromstring(z.read("xl/workbook.xml"))


def cnum(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n


def cl(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


print("\n" + "=" * 100)
summary = []
for sh in wb.find(f"{NS}sheets"):
    name = sh.get("name")
    t = relmap.get(sh.get(f"{RNS}id"), "")
    p = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
    xml = z.read(p)
    protected = b"<sheetProtection" in xml
    txt = xml.decode("utf-8", "replace")
    dv_ranges = [m.group(1) for m in re.finditer(r'<dataValidation\b[^>]*sqref="([^"]*)"', txt)]

    unlocked_cells = []
    formula_unlocked = 0
    for _e, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if el.tag != f"{NS}c":
            continue
        s = int(el.get("s") or 0)
        if s < len(unlocked) and unlocked[s]:
            ref = el.get("r") or ""
            has_f = el.find(f"{NS}f") is not None
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
            if has_f:
                formula_unlocked += 1
            elif val.strip():
                r = int(re.search(r"(\d+)", ref).group(1))
                unlocked_cells.append((r, cnum(ref), val.strip()))
        el.clear()

    print(f"\n[{name}] 受保护={'是' if protected else '否'}  数据验证={len(dv_ranges)}段  "
          f"未锁定且有内容的格={len(unlocked_cells)}  未锁定的公式格={formula_unlocked}")
    if dv_ranges:
        print(f"   验证范围: {' | '.join(dv_ranges[:6])}")
    byrow = defaultdict(list)
    for r, c, v in unlocked_cells:
        byrow[r].append((c, v))
    for r in sorted(byrow)[:14]:
        print("   R%-4d %s" % (r, "  ".join(f"{cl(c)}:{v[:20]}" for c, v in sorted(byrow[r]))))
    if len(byrow) > 14:
        print(f"   … 共 {len(byrow)} 行")
    summary.append({"sheet": name, "protected": protected, "unlocked_content": len(unlocked_cells),
                    "unlocked_formula": formula_unlocked, "dv": len(dv_ranges)})

import json, os
os.makedirs(r"D:\quicklyFind\card\analysis", exist_ok=True)
json.dump(summary, open(r"D:\quicklyFind\card\analysis\unlocked.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("\n汇总已写入 card\\analysis\\unlocked.json")
