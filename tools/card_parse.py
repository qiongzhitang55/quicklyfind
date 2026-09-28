#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read the character-sheet xlsx as cell grids and extract structured entries.

  python tools\\card_parse.py headers          # show the first rows of every sheet
  python tools\\card_parse.py dump             # write card\\grids\\<sheet>.json
  python tools\\card_parse.py spells           # extract 法术大全 -> dnd-data\\spells.json

The xlsx is never modified here; writing back is a separate, surgical step.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
DEFAULT_XLSX = r"D:\quicklyFind\card\米瑞尔.xlsx"
GRID_DIR = r"D:\quicklyFind\card\grids"
DATA_DIR = r"D:\quicklyFind\dnd-data"


def col_num(ref: str) -> int:
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n


def row_num(ref: str) -> int:
    m = re.search(r"(\d+)", ref)
    return int(m.group(1)) if m else 0


def col_letter(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def read_workbook(path: str) -> dict[str, dict[tuple[int, int], str]]:
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    wb = ET.fromstring(z.read("xl/workbook.xml"))

    grids: dict[str, dict[tuple[int, int], str]] = {}
    for sh in wb.find(f"{NS}sheets"):
        name = sh.get("name")
        target = relmap.get(sh.get(f"{RNS}id"), "")
        path_in_zip = target if target.startswith("xl/") else "xl/" + target.lstrip("/")
        if path_in_zip not in z.namelist():
            continue
        grid: dict[tuple[int, int], str] = {}
        for _ev, el in ET.iterparse(io.BytesIO(z.read(path_in_zip)), events=("end",)):
            if el.tag != f"{NS}c":
                continue
            t = el.get("t")
            v = el.find(f"{NS}v")
            is_ = el.find(f"{NS}is")
            if t == "s" and v is not None and v.text:
                val = shared[int(v.text)] if int(v.text) < len(shared) else ""
            elif t == "inlineStr" and is_ is not None:
                val = "".join(x.text or "" for x in is_.iter(f"{NS}t"))
            elif v is not None:
                val = v.text or ""
            else:
                val = ""
            val = val.strip()
            if val:
                grid[(row_num(el.get("r") or ""), col_num(el.get("r") or ""))] = val
            el.clear()
        grids[name] = grid
    return grids


def sheet_shape(grid) -> tuple[int, int]:
    if not grid:
        return 0, 0
    return max(r for r, _c in grid), max(c for _r, c in grid)


def cmd_headers(xlsx: str) -> int:
    grids = read_workbook(xlsx)
    for name, grid in grids.items():
        mr, mc = sheet_shape(grid)
        print(f"\n===== {name}  ({mr} 行 × {mc} 列, 填充 {len(grid)}) =====")
        for r in range(1, min(mr, 6) + 1):
            cells = sorted(c for rr, c in grid if rr == r)
            if not cells:
                continue
            line = " | ".join(f"{col_letter(c)}:{grid[(r, c)][:38]}" for c in cells[:26])
            print(f"  R{r}: {line}")
    return 0


def grid_source(xlsx: str) -> dict:
    with open(xlsx, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    return {
        "card": os.path.abspath(xlsx),
        "sha256": digest,
        "dumpedAt": datetime.datetime.now().isoformat(timespec="seconds"),
    }


def cmd_dump(xlsx: str, out_dir: str = GRID_DIR, force: bool = False) -> int:
    """把一张卡的每个工作表导成 `<sheet>.json`。

    `card/grids/` 是**词条抽取的基线**：`extract_equipment.py` / `extract_feats.py` /
    `extract_species_class.py` 都直接从这儿读格子，`dnd-data/` 就是照它复现出来的。
    那份基线固定来自 `card\\米瑞尔.xlsx`（老版式），换另一张卡重导会让结果对不上，
    所以这里记下出处（`_source.json`），发现要换成别的卡就直接拒绝——确实要换加 `--force`，
    或者用 `--out` 导到另一个目录去比。
    """
    src = os.path.abspath(xlsx)
    if not os.path.exists(src):
        print("xlsx not found:", src)
        return 1
    src_info = grid_source(src)
    note_path = os.path.join(out_dir, "_source.json")
    if os.path.exists(note_path) and not force:
        try:
            with open(note_path, encoding="utf-8") as fh:
                old = json.load(fh)
        except (OSError, ValueError):
            old = {}
        if old.get("sha256") and old["sha256"] != src_info["sha256"]:
            print(f"拒绝覆盖：{out_dir} 的网格来自\n"
                  f"    {old.get('card')}\n"
                  f"    sha256 {old['sha256']}\n"
                  f"现在要给的是\n"
                  f"    {src_info['card']}\n"
                  f"    sha256 {src_info['sha256']}\n"
                  "这两张卡版式不同，换掉会让 dnd-data 的复现结果对不上。\n"
                  "真要换：加 --force（原地换基线），或者用 --out 导到别处去对比。")
            return 1

    grids = read_workbook(xlsx)
    os.makedirs(out_dir, exist_ok=True)
    for name, grid in grids.items():
        mr, mc = sheet_shape(grid)
        data = {
            "sheet": name,
            "rows": mr,
            "cols": mc,
            "cells": {f"{r},{c}": v for (r, c), v in grid.items()},
        }
        with open(os.path.join(out_dir, f"{name}.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
    src_info["sheets"] = list(grids)
    with open(note_path, "w", encoding="utf-8") as fh:
        json.dump(src_info, fh, ensure_ascii=False, indent=2)
    print(f"wrote {len(grids)} grids -> {out_dir}")
    print(f"  出处已记到 {note_path}（{src_info['card']}）")
    return 0


# ------------------------------------------------------------------ spells
SPELL_CLASS_COLS = {
    15: "吟游诗人", 16: "牧师", 17: "德鲁伊", 18: "圣武士", 19: "游侠",
    20: "术士", 21: "魔契师", 22: "法师", 23: "奇械师", 24: "灵能使", 25: "药剂师",
}


def cmd_spells(xlsx: str) -> int:
    grids = read_workbook(xlsx)
    grid = grids.get("法术大全")
    if not grid:
        print("法术大全 sheet not found")
        return 1
    mr, mc = sheet_shape(grid)
    header = {c: grid.get((2, c), "") for c in range(1, mc + 1)}
    print(f"法术大全: {mr} 行 × {mc} 列")
    print("表头:", {col_letter(c): v for c, v in header.items() if v})

    spells = []
    orphans: list[tuple[int, dict[str, str]]] = []
    for r in range(3, mr + 1):
        name = grid.get((r, 1), "").strip()
        rest = {col_letter(c): grid[(r, c)] for c in range(2, mc + 1) if grid.get((r, c))}
        if not name:
            if rest:
                orphans.append((r, rest))
            continue
        classes = [cn for c, cn in SPELL_CLASS_COLS.items() if grid.get((r, c), "").strip() in ("√", "✓", "Y", "1")]
        spells.append({
            "name": name,
            "en": grid.get((r, 14), ""),
            "level": grid.get((r, 2), ""),
            "school": grid.get((r, 3), ""),
            "ritual": bool(grid.get((r, 4), "").strip()),
            "concentration": bool(grid.get((r, 5), "").strip()),
            "castTime": grid.get((r, 6), ""),
            "range": grid.get((r, 7), ""),
            "v": bool(grid.get((r, 8), "").strip()),
            "s": bool(grid.get((r, 9), "").strip()),
            "m": bool(grid.get((r, 10), "").strip()),
            "material": grid.get((r, 11), ""),
            "duration": grid.get((r, 12), ""),
            "text": grid.get((r, 13), ""),
            "classes": classes,
            "source": grid.get((r, 26), ""),
            "row": r,
        })

    print(f"\nA 列有法术名的行: {len(spells)}")
    print(f"A 列为空但有其他内容的行: {len(orphans)}")
    for r, rest in orphans[:8]:
        print(f"   R{r}: " + " | ".join(f"{k}:{v[:44]}" for k, v in list(rest.items())[:6]))

    os.makedirs(DATA_DIR, exist_ok=True)
    out = os.path.join(DATA_DIR, "spells.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(spells, fh, ensure_ascii=False, indent=1)
    print(f"\n提取法术 {len(spells)} 条 -> {out}")
    by_level: dict[str, int] = {}
    for s in spells:
        by_level[s["level"]] = by_level.get(s["level"], 0) + 1
    print("按环阶:", dict(sorted(by_level.items(), key=lambda kv: (len(kv[0]), kv[0]))))
    print("有详述的:", sum(1 for s in spells if len(s["text"]) > 20), "/", len(spells))
    print("有英文名的:", sum(1 for s in spells if s["en"]), "/", len(spells))
    print("\n样例:", json.dumps(spells[0], ensure_ascii=False)[:320])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["headers", "dump", "spells"])
    ap.add_argument("--xlsx", default=DEFAULT_XLSX)
    ap.add_argument("--out", default=GRID_DIR, help="dump 写到哪个目录（默认 card\\grids）")
    ap.add_argument("--force", action="store_true",
                    help="dump 到已有基线的目录时允许换一张卡（默认拒绝，见 cmd_dump 注释）")
    args = ap.parse_args()
    if not os.path.exists(args.xlsx):
        print("xlsx not found:", args.xlsx)
        return 1
    if args.cmd == "dump":
        return cmd_dump(args.xlsx, args.out, args.force)
    return {"headers": cmd_headers, "spells": cmd_spells}[args.cmd](args.xlsx)


if __name__ == "__main__":
    raise SystemExit(main())
