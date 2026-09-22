#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把人物卡初始化成空白模板。

判据：受保护的工作表里，作者必须把可编辑的格子设成 unlocked（否则你输不进去），
所以「未锁定 + 非公式 + 有内容」= 角色数据。清内容但保留样式、公式、下拉验证、
资料库工作表，并给 workbook 打开时强制重算，避免残留旧角色的计算结果。

  python tools\\blank_card.py            # 生成 card\\空白卡.xlsx
  python tools\\blank_card.py --dry-run  # 只报告，不写文件
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CARD = r"D:\quicklyFind\card\米瑞尔.xlsx"
OUT = r"D:\quicklyFind\card\空白卡.xlsx"
REPORT = r"D:\quicklyFind\card\analysis\blank_report.txt"

# 例外：这些工作表的"未锁定格"其实是模板文字，不能清
SKIP_SHEETS = {"自定义调整栏"}
# 背包里 B/F 列（第 2、6 列）是作者内嵌的物品目录，不是角色数据
KEEP_BY_COL = {"背包": {2, 6, 48, 53, 59, 64}}   # B,F,AV,BA,BG,BL


def cl(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def cn(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", default=CARD)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    z = zipfile.ZipFile(args.card)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
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

    sheet_paths = {}
    for sh in wb.find(f"{NS}sheets"):
        t = relmap.get(sh.get(f"{RNS}id"), "")
        sheet_paths[sh.get("name")] = t if t.startswith("xl/") else "xl/" + t.lstrip("/")

    new_parts = {}
    report = []
    total_cleared = 0
    for name, path in sheet_paths.items():
        xml = z.read(path).decode("utf-8")
        if "<sheetProtection" not in xml or name in SKIP_SHEETS:
            continue
        keep_cols = KEEP_BY_COL.get(name, set())

        targets = []
        for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(/>|>(.*?)</c>)', xml, re.S):
            ref_col, ref_row, attrs, closing, body = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5) or ""
            s_m = re.search(r'\bs="(\d+)"', attrs)
            if not s_m:
                continue
            s = int(s_m.group(1))
            if s >= len(unlocked) or not unlocked[s]:
                continue
            if "<f" in body or f"{NS}f" in body:
                continue
            # 取值
            t_m = re.search(r'\bt="([^"]+)"', attrs)
            tt = t_m.group(1) if t_m else None
            v_m = re.search(r"<v[^>]*>(.*?)</v>", body, re.S)
            is_m = re.search(r"<is>.*?<t[^>]*>(.*?)</t>", body, re.S)
            if tt == "s" and v_m and v_m.group(1).isdigit():
                val = shared[int(v_m.group(1))] if int(v_m.group(1)) < len(shared) else ""
            elif tt == "inlineStr" and is_m:
                val = is_m.group(1)
            elif v_m:
                val = v_m.group(1)
            else:
                val = ""
            if not val.strip():
                continue
            col = cn(ref_col)
            if col in keep_cols:
                continue
            targets.append((m.start(), m.end(), f"{ref_col}{ref_row}", attrs, val.strip()))

        if not targets:
            continue
        # 从后往前替换，保留样式属性（s/cm/vm），去掉类型与内容
        for start, end, ref, attrs, val in reversed(targets):
            keep = " ".join(re.findall(r'\b(?:s|cm|vm)="[^"]*"', attrs))
            new = f'<c r="{ref}"{(" " + keep) if keep else ""}/>'
            xml = xml[:start] + new + xml[end:]
        new_parts[path] = xml
        total_cleared += len(targets)
        report.append((name, len(targets), [t[2] + "=" + t[4][:16] for t in targets[:6]]))

    # 打开时强制重算，避免残留旧角色的公式缓存值
    wb_xml = z.read("xl/workbook.xml").decode("utf-8")
    if "<calcPr" in wb_xml:
        wb_xml2 = re.sub(r'<calcPr\b[^>]*/>', '<calcPr calcId="191029" fullCalcOnLoad="1"/>', wb_xml, count=1)
    else:
        wb_xml2 = wb_xml.replace("</workbook>", '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
    if wb_xml2 != wb_xml:
        new_parts["xl/workbook.xml"] = wb_xml2

    print(f"{'工作表':<14}{'清空格数':>9}   样例")
    print("-" * 88)
    for name, n, samples in report:
        print(f"{name:<14}{n:>9}   {' | '.join(samples)}")
    print(f"\n合计清空 {total_cleared} 格；强制重算已{'开启' if 'xl/workbook.xml' in new_parts else '未改动'}")

    with open(REPORT, "w", encoding="utf-8") as fh:
        fh.write(f"清空 {total_cleared} 格\n\n")
        for name, n, samples in report:
            fh.write(f"{name}\t{n}\t{' | '.join(samples)}\n")

    if args.dry_run:
        print("dry-run，未写出文件")
        return 0

    zout = zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED)
    for item in z.infolist():
        data = new_parts.get(item.filename, z.read(item.filename))
        zout.writestr(item, data)
    zout.close()
    z.close()
    print(f"\n写出 -> {args.out}  ({os.path.getsize(args.out)/1048576:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
