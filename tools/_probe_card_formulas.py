#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按范围打格子的原始 XML（含公式），看清卡里那一块是怎么算的。

    python tools/_probe_card_formulas.py 主要 AW9:BD25 [卡路径]
"""
from __future__ import annotations

import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def col_num(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch.upper()) - 64
    return n


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    sheet, span = sys.argv[1], sys.argv[2]
    card = sys.argv[3] if len(sys.argv) > 3 else r"D:\quicklyFind\card\悲灵.xlsx"
    c1, c2 = span.split(":")[0], span.split(":")[1]
    lo_c, hi_c = col_num(re.match(r"[A-Z]+", c1).group()), col_num(re.match(r"[A-Z]+", c2).group())
    lo_r, hi_r = int(re.search(r"\d+", c1).group()), int(re.search(r"\d+", c2).group())

    z = zipfile.ZipFile(card)
    shared = ["".join(t.text or "" for t in si.iter(NS + "t"))
              for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si")]
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    target = next(rels[sh.get(RNS + "id")] for sh in wb.find(NS + "sheets") if sh.get("name") == sheet)
    xml = z.read("xl/" + target.lstrip("/")).decode("utf-8")

    print(f"# {card} · {sheet}!{span}")
    for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', xml, re.S):
        col, row, attrs, inner = m.group(1), int(m.group(2)), m.group(3) or "", m.group(4) or ""
        if not (lo_c <= col_num(col) <= hi_c and lo_r <= row <= hi_r):
            continue
        f = re.search(r"<f[^>]*>(.*?)</f>", inner, re.S)
        v = re.search(r"<v>(.*?)</v>", inner, re.S)
        val = v.group(1) if v else ""
        if not val:                      # 我们自己写进去的是 inlineStr
            it = re.search(r"<is>.*?<t[^>]*>(.*?)</t>", inner, re.S)
            if it:
                val = it.group(1)
        t = re.search(r't="(\w+)"', attrs)
        if t and t.group(1) == "s" and val.isdigit():
            val = shared[int(val)]
        if not f and not val:
            continue
        print(f"  {col}{row}  value={val!r}")
        if f:
            print(f"        ={f.group(1).strip()[:220]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
