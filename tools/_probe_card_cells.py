#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在卡里按内容找格子（只读）。

    python tools/_probe_card_cells.py 主要属性 [卡路径]

把每张工作表里文本等于 / 包含这个词的格子连同它右边、下边的邻居一起打出来，
用来确认「卡里到底哪一格是干什么的」。
"""
from __future__ import annotations

import sys
import zipfile
import re
import xml.etree.ElementTree as ET

# Windows 控制台默认 GBK，中文直接 print 会炸
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def col_num(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch.upper()) - 64
    return n


def col_name(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def sheets(path: str) -> "dict[str, dict[tuple[str, int], str]]":
    z = zipfile.ZipFile(path)
    shared = ["".join(t.text or "" for t in si.iter(NS + "t"))
              for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si")]
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    out = {}
    for sh in wb.find(NS + "sheets"):
        name = sh.get("name")
        target = rels.get(sh.get(RNS + "id"), "")
        xml = z.read("xl/" + target.lstrip("/")).decode("utf-8")
        cells: "dict[tuple[str, int], str]" = {}
        for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', xml, re.S):
            col, row, attrs, inner = m.group(1), int(m.group(2)), m.group(3) or "", m.group(4) or ""
            v = re.search(r"<v>(.*?)</v>", inner, re.S)
            t = re.search(r't="(\w+)"', attrs)
            val = v.group(1) if v else ""
            if t and t.group(1) == "s" and val.isdigit():
                val = shared[int(val)]
            f = "<f>" in inner
            if val.strip() or f:
                cells[(col, row)] = ("=" + val.strip() + " [公式]") if f else val.strip()
        out[name] = cells
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    needle = sys.argv[1]
    card = sys.argv[2] if len(sys.argv) > 2 else r"D:\quicklyFind\card\悲灵.xlsx"
    print(f"# {card} 里含「{needle}」的格子")
    for sheet, cells in sheets(card).items():
        for (col, row), val in sorted(cells.items(), key=lambda kv: (kv[0][1], col_num(kv[0][0]))):
            if needle not in val:
                continue
            print(f"  {sheet}!{col}{row} = {val[:60]}")
            for dr in range(1, 5):
                for dc in range(0, 3):
                    nb = cells.get((col_name(col_num(col) + dc), row + dr))
                    if nb:
                        print(f"      -> {col_name(col_num(col) + dc)}{row + dr} = {nb[:60]}")
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
