#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析人物卡：哪些是"角色填的数据"，哪些是公式/标签/参考资料库。

关键判据：单元格样式里的填充色。自动卡通常用底色区分「要你填的格子」和
「公式自动算的格子」。先把每个工作表的字面量/公式占比和填充色分布打出来。
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"
OUT = r"D:\quicklyFind\card\analysis"


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
    names = z.namelist()
    shared = []
    if "xl/sharedStrings.xml" in names:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

    # styles: cellXfs -> fillId ; fills -> fgColor rgb
    styles = ET.fromstring(z.read("xl/styles.xml"))
    fills = []
    for f in styles.find(f"{NS}fills"):
        pat = f.find(f"{NS}patternFill")
        rgb = ""
        if pat is not None:
            fg = pat.find(f"{NS}fgColor")
            if fg is not None:
                rgb = fg.get("rgb") or fg.get("theme") or ""
        fills.append(rgb)
    xfs = []
    for xf in styles.find(f"{NS}cellXfs"):
        xfs.append(int(xf.get("fillId") or 0))

    def fill_of(s):
        try:
            return fills[xfs[int(s)]] if int(s) < len(xfs) else ""
        except Exception:
            return ""

    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    wb = ET.fromstring(z.read("xl/workbook.xml"))

    out = {}
    for sh in wb.find(f"{NS}sheets"):
        name = sh.get("name")
        t = relmap.get(sh.get(f"{RNS}id"), "")
        path_in_zip = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
        cells = {}
        for _e, el in ET.iterparse(io.BytesIO(z.read(path_in_zip)), events=("end",)):
            if el.tag != f"{NS}c":
                continue
            ref = el.get("r") or ""
            attrs_t = el.get("t")
            style = el.get("s") or "0"
            body = "".join(ET.tostring(ch, encoding="unicode") for ch in el)
            is_formula = "<f" in body or f"{NS}f" in body
            v = el.find(f"{NS}v")
            isx = el.find(f"{NS}is")
            if attrs_t == "s" and v is not None and v.text:
                val = shared[int(v.text)] if int(v.text) < len(shared) else ""
            elif attrs_t == "inlineStr" and isx is not None:
                val = "".join(x.text or "" for x in isx.iter(f"{NS}t"))
            elif v is not None:
                val = v.text or ""
            else:
                val = ""
            if val.strip():
                r = int(re.search(r"(\d+)", ref).group(1))
                cells[(r, col_num(ref))] = {
                    "v": val.strip(), "f": is_formula, "s": style, "fill": fill_of(style),
                }
            el.clear()
        out[name] = cells
    return out


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    sheets = load(CARD)
    report = []
    print(f"{'工作表':<14}{'填充':>6}{'字面量':>8}{'公式':>7}   主要填充色（字面量格子）")
    print("-" * 96)
    for name, cells in sheets.items():
        lit = [c for c in cells.values() if not c["f"]]
        fml = [c for c in cells.values() if c["f"]]
        from collections import Counter
        fills = Counter(c["fill"] or "(无)" for c in lit)
        top = "、".join(f"{k}×{v}" for k, v in fills.most_common(4))
        print(f"{name:<14}{len(cells):>6}{len(lit):>8}{len(fml):>7}   {top}")
        report.append({"sheet": name, "cells": len(cells), "literal": len(lit), "formula": len(fml),
                       "fills": dict(fills)})

    with open(os.path.join(OUT, "sheet_stats.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    # 看几张关键表：字面量格子的填充色 vs 标签格子的填充色
    print("\n=== 「主要」表前 30 个字面量格子的样式 ===")
    main_sheet = sheets.get("主要", {})
    lits = [(r, c, d) for (r, c), d in sorted(main_sheet.items()) if not d["f"]][:30]
    for r, c, d in lits:
        print(f"   R{r}C{c:<3} style={d['s']:<5} fill={d['fill'] or '(无)':<10} {d['v'][:40]!r}")

    print("\n=== 「法术书」X 列字面量 ===")
    for (r, c), d in sorted(sheets.get("法术书", {}).items()):
        if c == 24 and not d["f"]:
            print(f"   R{r} style={d['s']} fill={d['fill'] or '(无)'} {d['v'][:20]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
