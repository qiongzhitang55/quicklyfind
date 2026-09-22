#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按工作表/列铺开，看清"角色数据"与"标签/公式/资料库"的分界。"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"
OUT = r"D:\quicklyFind\card\analysis"


def col_letter(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def col_num(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n


def load(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    out = {}
    for sh in wb.find(f"{NS}sheets"):
        name = sh.get("name")
        t = relmap.get(sh.get(f"{RNS}id"), "")
        p = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
        cells = {}
        for _e, el in ET.iterparse(io.BytesIO(z.read(p)), events=("end",)):
            if el.tag != f"{NS}c":
                continue
            ref = el.get("r") or ""
            tt = el.get("t")
            has_f = el.find(f"{NS}f") is not None
            ftext = ""
            if has_f:
                fe = el.find(f"{NS}f")
                ftext = (fe.text or "")[:60]
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
            r = int(re.search(r"(\d+)", ref).group(1))
            cells[(r, col_num(ref))] = {"v": val.strip(), "f": has_f, "fx": ftext}
            el.clear()
        out[name] = cells
    return out


CHAR_SHEETS = ["背景", "主要", "背包", "盟友与魔宠", "据点", "法术书", "骰娘导入", "自定义调整栏"]


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    sheets = load(CARD)

    print(f"{'工作表':<14}{'有内容':>7}{'字面量':>8}{'公式':>7}")
    print("-" * 44)
    for name, cells in sheets.items():
        lit = sum(1 for c in cells.values() if not c["f"])
        fml = sum(1 for c in cells.values() if c["f"])
        mark = " ★角色表" if name in CHAR_SHEETS else ""
        print(f"{name:<14}{len(cells):>7}{lit:>8}{fml:>7}{mark}")

    with open(os.path.join(OUT, "by_column.txt"), "w", encoding="utf-8") as fh:
        for name in CHAR_SHEETS:
            cells = sheets.get(name, {})
            if not cells:
                continue
            fh.write(f"\n{'='*100}\n### {name}（{len(cells)} 格，字面量 {sum(1 for c in cells.values() if not c['f'])}）\n")
            bycol = defaultdict(list)
            for (r, c), d in sorted(cells.items()):
                bycol[c].append((r, d))
            for c in sorted(bycol):
                items = bycol[c]
                lit = [x for x in items if not x[1]["f"]]
                fml = [x for x in items if x[1]["f"]]
                fh.write(f"\n-- 列 {col_letter(c)}({c})  字面量 {len(lit)} / 公式 {len(fml)}\n")
                if lit:
                    fh.write("   字面量: " + " | ".join(f"R{r}:{d['v'][:22]!r}" for r, d in lit[:40]) + "\n")
                if fml:
                    fh.write("   公式  : " + " | ".join(f"R{r}:{d['fx'][:34]}" for r, d in fml[:8]) + "\n")
    print(f"\n按列明细 -> {os.path.join(OUT,'by_column.txt')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
