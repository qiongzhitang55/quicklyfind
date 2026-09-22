#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列出所有"未锁定且有内容"的格子，用于最终人工定案。"""
from __future__ import annotations
import io, re, zipfile, json
import xml.etree.ElementTree as ET
from collections import defaultdict

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"
OUT = r"D:\quicklyFind\card\analysis\unlocked_cells.txt"

z = zipfile.ZipFile(CARD)
shared = []
root = ET.fromstring(z.read("xl/sharedStrings.xml"))
for si in root.findall(f"{NS}si"):
    shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
styles = ET.fromstring(z.read("xl/styles.xml"))
unlocked = []
for xf in styles.find(f"{NS}cellXfs"):
    p = xf.find(f"{NS}protection")
    unlocked.append(p is not None and p.get("locked") == "0")
rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
relmap = {r.get("Id"): r.get("Target") for r in rels}
wb = ET.fromstring(z.read("xl/workbook.xml"))

def cl(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s
def cn(ref):
    n = 0
    for ch in ref:
        if ch.isalpha(): n = n * 26 + (ord(ch.upper()) - 64)
        else: break
    return n

with open(OUT, "w", encoding="utf-8") as fh:
    for sh in wb.find(f"{NS}sheets"):
        name = sh.get("name")
        t = relmap.get(sh.get(f"{RNS}id"), "")
        p = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
        xml = z.read(p)
        if b"<sheetProtection" not in xml:
            continue
        rows = defaultdict(list)
        for _e, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
            if el.tag != f"{NS}c": continue
            s = int(el.get("s") or 0)
            if not (s < len(unlocked) and unlocked[s]):
                el.clear(); continue
            if el.find(f"{NS}f") is not None:
                el.clear(); continue
            tt = el.get("t"); v = el.find(f"{NS}v"); isx = el.find(f"{NS}is")
            if tt == "s" and v is not None and v.text:
                val = shared[int(v.text)] if int(v.text) < len(shared) else ""
            elif tt == "inlineStr" and isx is not None:
                val = "".join(x.text or "" for x in isx.iter(f"{NS}t"))
            elif v is not None: val = v.text or ""
            else: val = ""
            val = val.strip()
            if val:
                ref = el.get("r") or ""
                rows[int(re.search(r"(\d+)", ref).group(1))].append((cn(ref), val))
            el.clear()
        n = sum(len(v) for v in rows.values())
        fh.write(f"\n{'='*96}\n### {name}   ({n} 格)\n")
        for r in sorted(rows):
            fh.write(f"R{r:<4} " + "  ".join(f"{cl(c)}:{v[:34]}" for c, v in sorted(rows[r])) + "\n")
print("写出 ->", OUT)
