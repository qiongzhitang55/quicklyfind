#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：列出卡里各工作表公式中对另一张表的引用（只读）。

    python tools\\_formula_refs.py <card.xlsx> <目标表> <被引用的表>
  例：python tools\\_formula_refs.py card.xlsx 装备 主要
"""
from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def sheet_map(z):
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    out = {}
    for sh in wb.find(NS + "sheets"):
        t = rels.get(sh.get(RNS + "id"), "")
        out[sh.get("name")] = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
    return out


def main() -> int:
    card, sheet, target = sys.argv[1], sys.argv[2], sys.argv[3]
    z = zipfile.ZipFile(card)
    xml = z.read(sheet_map(z)[sheet]).decode("utf-8")
    pat = re.compile(r"'?" + re.escape(target) + r"'?!(\$?[A-Z]{1,3}\$?\d{1,4})(?::(\$?[A-Z]{1,3}\$?\d{1,4}))?")
    hits = {}
    for m in re.finditer(r"<f[^>]*>(.*?)</f>", xml, re.S):
        f = m.group(1)
        for r in pat.finditer(f):
            ref = r.group(1).replace("$", "") + ((":" + r.group(2).replace("$", "")) if r.group(2) else "")
            hits.setdefault(ref, 0)
            hits[ref] += 1
    print(f"# {card} :: {sheet} 引用 {target} 的格子（{len(hits)} 个）")
    for ref in sorted(hits, key=lambda s: (int(re.search(r'\d+', s).group()), s)):
        print(f"   {target}!{ref}   ×{hits[ref]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
