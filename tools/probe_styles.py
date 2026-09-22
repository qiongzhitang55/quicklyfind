#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在「主要」表里按样式分组，看"输入格"和"标签格"是否能用样式区分。"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict, Counter

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"
TARGET = "主要"

z = zipfile.ZipFile(CARD)
shared = []
root = ET.fromstring(z.read("xl/sharedStrings.xml"))
for si in root.findall(f"{NS}si"):
    shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

styles = ET.fromstring(z.read("xl/styles.xml"))
fills, borders, fonts = [], [], []
for f in styles.find(f"{NS}fills"):
    pat = f.find(f"{NS}patternFill")
    rgb = ""
    if pat is not None:
        fg = pat.find(f"{NS}fgColor")
        if fg is not None:
            rgb = fg.get("rgb") or ("theme" + (fg.get("theme") or ""))
    fills.append(rgb)
for b in styles.find(f"{NS}borders"):
    borders.append(b.get("diagonal") or "")
for fo in styles.find(f"{NS}fonts"):
    fonts.append(" ".join(x.tag.split('}')[-1] for x in fo))
xfs = []
for xf in styles.find(f"{NS}cellXfs"):
    xfs.append({
        "fill": int(xf.get("fillId") or 0),
        "border": int(xf.get("borderId") or 0),
        "font": int(xf.get("fontId") or 0),
        "numFmt": xf.get("numFmtId") or "0",
        "applyFill": xf.get("applyFill"),
    })

rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
relmap = {r.get("Id"): r.get("Target") for r in rels}
wb = ET.fromstring(z.read("xl/workbook.xml"))
path = None
for sh in wb.find(f"{NS}sheets"):
    if sh.get("name") == TARGET:
        t = relmap.get(sh.get(f"{RNS}id"), "")
        path = t if t.startswith("xl/") else "xl/" + t.lstrip("/")

def cnum(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n

groups = defaultdict(list)
for _e, el in ET.iterparse(io.BytesIO(z.read(path)), events=("end",)):
    if el.tag != f"{NS}c":
        continue
    ref = el.get("r") or ""
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
        s = el.get("s") or "0"
        info = xfs[int(s)] if int(s) < len(xfs) else {"fill": -1, "border": -1, "font": -1, "numFmt": "?"}
        groups[s].append((ref, val, fills[info["fill"]] if 0 <= info["fill"] < len(fills) else "?"))
    el.clear()

print(f"「{TARGET}」字面量格子的样式分布（{sum(len(v) for v in groups.values())} 格）\n")
for s, items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    fill = items[0][2]
    sample = " | ".join(f"{r}:{v[:14]}" for r, v, _ in items[:8])
    print(f"  style {s:<5} fill={fill:<12} {len(items):>4} 格   {sample}")

# 字体信息（看输入格是不是用了不同字体/颜色）
print("\n各样式对应的字体/边框/数字格式：")
for s, items in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:12]:
    info = xfs[int(s)]
    print(f"  style {s:<5} font={info['font']:<4}({fonts[info['font']][:22] if info['font'] < len(fonts) else '?'}) "
          f"border={info['border']:<4} numFmt={info['numFmt']} fill={fills[info['fill']]}")
