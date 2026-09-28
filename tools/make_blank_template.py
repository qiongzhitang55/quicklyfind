#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从作者发布的自动人物卡做一份「基准空白卡」。

只做减法，其余 zip 条目（公式 / 样式 / 数据验证 / 媒体 / 各资料库表）逐字节不动：

  · `主要!A1` 的署名（`DND 5.5E 人物卡<悲灵ver.>（2024）`）→ 中性的
    `DND 5.5E 人物卡（2024）`，别让新卡顶着别人的标记发出去
  · `主要!E4`（玩家）→ 空。作者发的卡里预填着「悲灵」，不清掉的话
    「新建表格」造出来的每张卡都写着别人
  · 武器 / 护甲 / 盾 / 奇物这几块（「装备」页与「魔法物品」页上的格子）：
    数字格（武器加值 `L32:L36`、护甲加值 `U40`、盾牌 AC `AQ40`）**清空**；
    所有 `X/O` 与 `是/否` 的下拉（武器同调 `F32:F36`、武器熟练 `W32:W36`、
    护甲 / 盾的同调 `P40` / `AP40`、着装 `AS40`、奇物同调 `P42:P50`）**统一写 `X`**
    ——这张卡的约定是 `X` = 没有 / 否，卡里的公式都按 `="是"` / `="O"` 判定，
    `X` 落在「没有」那一支（`主要!C23` 的 AC、`装备!S21` 的同调计数都不受影响）

作者在「更新」表里的署名与联系方式（`更新!B14` / `B18`、群号 712629131）
**保留**——那是出处，也是二次修改的授权条件。

  python tools\\make_blank_template.py <源卡.xlsx> <输出卡.xlsx>
  python tools\\make_blank_template.py <源卡.xlsx> <输出卡.xlsx> --dry-run
"""
from __future__ import annotations

import argparse
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsx_patch  # noqa: E402

NEUTRAL_TITLE = "DND 5.5E 人物卡（2024）"


def col_name(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def curio_rows(main: dict) -> list[int]:
    """「奇物」表头往下、直到下一个非空表头的那几行（两版卡格数不同）。"""
    header = None
    for (r, c), v in main.items():
        if 30 <= r <= 50 and v.strip() == "奇物":
            header = (r, c)
            break
    if header is None:
        return []
    r0, col = header
    rows = [r0 + 1]
    while rows[-1] < r0 + 11 and not (main.get((rows[-1] + 1, col)) or "").strip():
        rows.append(rows[-1] + 1)
    return rows


def build_edits(grids: dict) -> dict[str, dict[str, str]]:
    """算出「基准空白卡」要写哪几格；已经对的格子跳过，改动越小越好。"""
    main = grids.get("主要", {})
    want = {
        "A1": NEUTRAL_TITLE,
        "E4": "",                  # 玩家
    }
    for r in range(32, 37):        # 武器 5 行（两个版式的行号一样）
        want[f"F{r}"] = "X"        # 同调
        want[f"W{r}"] = "X"        # 熟练
        want[f"L{r}"] = ""         # 加值
    for cell in ("P40", "AP40", "AS40"):   # 护甲 / 盾：同调、着装
        want[cell] = "X"
    want["U40"] = ""               # 护甲加值
    want["AQ40"] = ""              # 盾牌 AC
    for r in curio_rows(main):     # 奇物：同调那一列
        want[f"P{r}"] = "X"

    edits: dict[str, dict[str, str]] = {"主要": {}}
    for cell, value in want.items():
        m = re.match(r"([A-Z]+)(\d+)", cell)
        if not m:
            continue
        now = (main.get((int(m.group(2)), xlsx_patch.col_num(m.group(1)))) or "").strip()
        if now != value:
            edits["主要"][cell] = value
    return edits


def patch_cells(src: str, dst: str, edits: dict[str, dict[str, str]]) -> dict:
    """跟 `xlsx_patch.patch_cell` 同一套外科式做法，但一次改多个格子。"""
    zin = zipfile.ZipFile(src)
    sheets = xlsx_patch.sheet_map(zin)
    changed: dict[str, int] = {}
    new_parts: dict[str, bytes] = {}
    for sheet, cells in edits.items():
        path = sheets[sheet]
        xml = zin.read(path).decode("utf-8")
        for cell, value in cells.items():
            row = re.search(r"(\d+)", cell).group(1)
            if value == "":
                # 清空：保留样式属性，把内容和类型都去掉（`<c r="E4" s="…"/>`）
                m = re.search(r'<c r="%s"([^>]*?)(?:/>|>(.*?)</c>)' % re.escape(cell), xml, re.S)
                if not m:
                    continue
                keep = " ".join(re.findall(r'\b(?:s|cm|vm)="[^"]*"', m.group(1) or ""))
                repl = f'<c r="{cell}"' + (f" {keep}" if keep else "") + "/>"
            else:
                m = re.search(r'<c r="%s"([^>]*?)(?:/>|>(.*?)</c>)' % re.escape(cell), xml, re.S)
                if m:
                    keep = " ".join(re.findall(r'\b(?:s|cm|vm)="[^"]*"', m.group(1) or ""))
                    repl = (f'<c r="{cell}"' + (f" {keep}" if keep else "")
                            + f' t="inlineStr"><is><t xml:space="preserve">'
                              f'{xlsx_patch.xml_escape(value)}</t></is></c>')
                else:
                    repl = (f'<c r="{cell}" t="inlineStr"><is><t xml:space="preserve">'
                            f'{xlsx_patch.xml_escape(value)}</t></is></c>')
            xml = xml[: m.start()] + repl + xml[m.end():]
            changed[sheet] = changed.get(sheet, 0) + 1
        new_parts[path] = xml.encode("utf-8")

    zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
    for item in zin.infolist():
        zout.writestr(item, new_parts.get(item.filename, zin.read(item.filename)))
    zout.close()
    zin.close()
    return changed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print(f"源卡   {args.src}")
    print(f"输出   {args.out}")

    ga, names_in = xlsx_patch.grids(args.src)
    edits = build_edits(ga)
    for sheet, cells in edits.items():
        for cell, value in cells.items():
            m = re.match(r"([A-Z]+)(\d+)", cell)
            col, row = xlsx_patch.col_num(m.group(1)), int(m.group(2))
            print(f"  {sheet}!{cell}: {ga.get(sheet, {}).get((row, col), '')!r} -> {value!r}")

    if args.dry_run:
        print("dry-run，未写出文件")
        return 0

    changed = patch_cells(args.src, args.out, edits)
    gb, names_out = xlsx_patch.grids(args.out)
    za, zb = zipfile.ZipFile(args.src), zipfile.ZipFile(args.out)
    print(f"\nzip 条目 {len(names_in)} -> {len(names_out)}  "
          f"{'一致' if names_in == names_out else '不一致!'}")
    bin_same = all(za.read(n) == zb.read(n) for n in names_in
                   if n.startswith(("xl/media/", "xl/drawings/", "xl/styles.xml")))
    print(f"媒体 / 绘图 / 样式 字节级原样: {'是' if bin_same else '否!'}")
    diffs = []
    for sheet in ga:
        ca, cb = ga[sheet], gb.get(sheet, {})
        for k in set(ca) | set(cb):
            if ca.get(k) != cb.get(k):
                diffs.append((sheet, k, ca.get(k), cb.get(k)))
    print(f"单元格差异 {len(diffs)} 处：")
    for sheet, (r, c), old, new in diffs:
        print(f"   {sheet}!{col_name(c)}{r}: {old!r} -> {new!r}")
    print(f"\n写出 -> {args.out}  ({os.path.getsize(args.out)/1048576:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
