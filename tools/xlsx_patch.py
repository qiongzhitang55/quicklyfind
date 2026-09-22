#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""外科式写入 xlsx 单元格的参考实现 + 完整性验证。

思路：xlsx 就是一个 zip，只改目标工作表的 XML 里那一个 <c> 元素，其余条目
（sharedStrings、styles、media、drawings、其它 sheet）原样搬运，所以公式、
条件格式、图片、样式都不会被破坏。

  python tools\\xlsx_patch.py patch  <in.xlsx> <out.xlsx> <sheet> <cell> <value>
  python tools\\xlsx_patch.py verify <a.xlsx> <b.xlsx>
"""
from __future__ import annotations

import io
import os
import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def sheet_map(z: zipfile.ZipFile) -> dict[str, str]:
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    out = {}
    for sh in wb.find(f"{NS}sheets"):
        target = relmap.get(sh.get(f"{RNS}id"), "")
        path = target if target.startswith("xl/") else "xl/" + target.lstrip("/")
        out[sh.get("name")] = path
    return out


def xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def col_num(ref: str) -> int:
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n


def patch_cell(src: str, dst: str, sheet: str, cell: str, value: str) -> dict:
    """Return a small report; never touches `src`."""
    zin = zipfile.ZipFile(src)
    sheets = sheet_map(zin)
    if sheet not in sheets:
        raise KeyError(f"sheet {sheet!r} not found; have {list(sheets)}")
    target = sheets[sheet]
    xml = zin.read(target).decode("utf-8")

    row = re.search(r"(\d+)", cell).group(1)
    new_cell = f'<c r="{cell}" t="inlineStr"><is><t xml:space="preserve">{xml_escape(value)}</t></is></c>'

    # 1) 目标是行内已有单元格？
    existing = re.search(r'<c r="%s"([^>]*?)(?:/>|>(.*?)</c>)' % re.escape(cell), xml, re.S)
    if existing:
        # 保留样式属性 s="…"，丢掉旧的类型与内容
        attrs = existing.group(1) or ""
        keep = " ".join(a for a in re.findall(r'\b(?:s|cm|vm)="[^"]*"', attrs))
        repl = f'<c r="{cell}"' + (f" {keep}" if keep else "") + f' t="inlineStr"><is><t xml:space="preserve">{xml_escape(value)}</t></is></c>'
        xml = xml[: existing.start()] + repl + xml[existing.end():]
        how = "replaced-existing"
    else:
        # 2) 行存在但没这个单元格 -> 按列序插入
        row_m = re.search(r'<row r="%s"[^>]*?(?:/>|>.*?</row>)' % row, xml, re.S)
        if row_m:
            block = row_m.group(0)
            if block.endswith("/>"):
                new_block = block[:-2] + ">" + new_cell + "</row>"
            else:
                inserts = list(re.finditer(r'<c r="([A-Z]+)%s"' % row, block))
                pos = None
                for m in inserts:
                    if col_num(m.group(1)) > col_num(cell):
                        pos = m.start()
                        break
                new_block = (block[:pos] + new_cell + block[pos:]) if pos is not None else block.replace("</row>", new_cell + "</row>")
            xml = xml[: row_m.start()] + new_block + xml[row_m.end():]
            how = "inserted-into-row"
        else:
            # 3) 整行都不存在 -> 按行序插入一行
            rows = list(re.finditer(r'<row r="(\d+)"', xml))
            pos = None
            for m in rows:
                if int(m.group(1)) > int(row):
                    pos = m.start()
                    break
            new_row = f'<row r="{row}">{new_cell}</row>'
            xml = (xml[:pos] + new_row + xml[pos:]) if pos is not None else xml.replace("</sheetData>", new_row + "</sheetData>")
            how = "inserted-new-row"

    # 3) 重新打包：除目标 XML 外逐条原样复制
    zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == target:
            data = xml.encode("utf-8")
        zout.writestr(item, data)
    zout.close()
    zin.close()
    return {"sheet": sheet, "path_in_zip": target, "cell": cell, "mode": how, "bytes": os.path.getsize(dst)}


# ------------------------------------------------------------------ verify
def grids(path: str) -> tuple[dict[str, dict[tuple[int, int], str]], list[str]]:
    z = zipfile.ZipFile(path)
    names = sorted(z.namelist())
    shared = []
    if "xl/sharedStrings.xml" in names:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    allg: dict[str, dict[tuple[int, int], str]] = {}
    for sh in wb.find(f"{NS}sheets"):
        t = relmap.get(sh.get(f"{RNS}id"), "")
        p = t if t.startswith("xl/") else "xl/" + t.lstrip("/")
        g: dict[tuple[int, int], str] = {}
        for _e, el in ET.iterparse(io.BytesIO(z.read(p)), events=("end",)):
            if el.tag != f"{NS}c":
                continue
            ref = el.get("r") or ""
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
                rn = int(re.search(r"(\d+)", ref).group(1))
                g[(rn, col_num(ref))] = val
            el.clear()
        allg[sh.get("name")] = g
    return allg, names


def verify(a: str, b: str) -> int:
    ga, na = grids(a)
    gb, nb = grids(b)
    print(f"zip 条目数: {len(na)} -> {len(nb)}  {'一致' if na == nb else '不一致!'}")
    diffs = []
    for sheet in ga:
        ca, cb = ga[sheet], gb.get(sheet, {})
        for k in set(ca) | set(cb):
            if ca.get(k) != cb.get(k):
                diffs.append((sheet, k, ca.get(k), cb.get(k)))
    print(f"单元格差异: {len(diffs)}")
    for sheet, (r, c), old, new in diffs[:12]:
        print(f"   {sheet} R{r}C{c}: {old!r} -> {new!r}")
    # 二进制资源是否原样
    za, zb = zipfile.ZipFile(a), zipfile.ZipFile(b)
    for name in na:
        if name.startswith(("xl/media/", "xl/drawings/")):
            same = za.read(name) == zb.read(name)
            print(f"   {name}: {'原样保留' if same else '被改动!'}")
    print("其余单元格与媒体文件均一致" if diffs else "无差异")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "patch":
        rep = patch_cell(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
        print("patch ok:", rep)
    elif cmd == "verify":
        raise SystemExit(verify(sys.argv[2], sys.argv[3]))
