#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证空白卡：只清掉了角色数据，公式/资料库/标签/媒体都没动。"""
from __future__ import annotations
import sys, io
from collections import Counter

sys.path.insert(0, r"D:\quicklyFind\tools")
import importlib.util
spec = importlib.util.spec_from_file_location("xp", r"D:\quicklyFind\tools\xlsx_patch.py")
xp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xp)

A = r"D:\quicklyFind\card\米瑞尔.xlsx"
B = r"D:\quicklyFind\card\空白卡.xlsx"
ga, na = xp.grids(A)
gb, nb = xp.grids(B)

print(f"zip 条目数: {len(na)} -> {len(nb)}  {'一致' if na == nb else '不一致!'}")

diffs = []
for sheet in ga:
    ca, cb = ga[sheet], gb.get(sheet, {})
    for k in set(ca) | set(cb):
        if ca.get(k) != cb.get(k):
            diffs.append((sheet, k, ca.get(k), cb.get(k)))

bad = [d for d in diffs if d[3] is not None]
print(f"总差异: {len(diffs)} 处")
print(f"其中变成了非空值的（应为 0）: {len(bad)}")
for d in bad[:10]:
    print("   !", d)
print("按工作表:", dict(Counter(d[0] for d in diffs)))

print("\n「主要」表保留的标签抽查:")
for r, c in [(3, 2), (4, 2), (6, 2), (13, 3), (3, 17), (30, 12), (5, 5), (6, 5)]:
    print(f"   R{r}C{c}: {ga['主要'].get((r,c))!r}  ->  {gb['主要'].get((r,c))!r}")

print("\n各工作表格数变化（内容数）:")
for s in ga:
    print(f"   {s:<12} {len(ga[s]):>6} -> {len(gb[s]):>6}   差异 {sum(1 for d in diffs if d[0]==s)}")

# 媒体与绘图是否原样
import zipfile
za, zb = zipfile.ZipFile(A), zipfile.ZipFile(B)
same = all(za.read(n) == zb.read(n) for n in na if n.startswith(("xl/media/", "xl/drawings/", "xl/styles.xml", "xl/sharedStrings.xml")))
print(f"\n媒体/绘图/样式/共享串 是否字节级原样: {'是' if same else '否!'}")
