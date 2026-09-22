#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""专长与据点 (feats sheet) -> dnd-data/feats.json

Re-runnable extractor for the character-sheet workbook.  Primary source is the
grid export ``card/grids/专长与据点.json`` (see tools/card_parse.py dump); the
xlsx itself is opened **read-only** and only to recover feat names that the grid
export lost (see below).  The workbook is never modified.

Sheet layout (verified against the grid + raw sheet XML):

    A         : helper formula list of the column-B names the character owns
    B / C     : 专长 | 描述   -- the real feat compendium, rows 4..215 + 225..227
    D / E     : 战斗风格 (fighting styles), rows 4..15 (+ 2 custom placeholders)
    F / G     : VLOOKUP view of the B/C table (only 2 rows populated)
    H / I     : VLOOKUP view of the D/E table -- column H holds only placeholders
                ("0") and column I only stray bastion values, so it yields no feats
    K..V      : bastion (据点) data -- deliberately NOT collected here

Name loss in the grid export
----------------------------
Every B cell is a formula such as::

    IF(主要!$BR$26="O","异种龙纹","")

Excel caches the result; when the character does not qualify the cell caches an
empty string, so the grid export contains no cell at all for that row even
though C still carries the full description.  50 such rows exist (epic boons,
dragonmarks, wild talents).  The literal name is still inside the formula, so it
is recovered from the sheet XML -- a deterministic read of the workbook, never a
guess.  The heuristic was validated against all 166 B cells that *do* have a
cached name: 0 mismatches.  Recovered rows are tagged "B列公式补名".

Usage
-----
    python tools\\extract_feats.py                 # write dnd-data\\feats.json
    python tools\\extract_feats.py --no-xlsx       # grid only (50 names lost)
    python tools\\extract_feats.py --out other.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, OrderedDict

DEFAULT_GRID = r"D:\quicklyFind\card\grids\专长与据点.json"
DEFAULT_XLSX = r"D:\quicklyFind\card\米瑞尔.xlsx"
DEFAULT_OUT = r"D:\quicklyFind\dnd-data\feats.json"

SHEET = "专长与据点"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

#: values that must never be treated as content (SCHEMA hard rule 4)
PLACEHOLDERS = {
    "", "-", "—", "–", "0", "0.0", "#VALUE!", "#N/A", "#REF!", "#NAME?",
    "#DIV/0!", "N/A", "NA", "NULL",
}

#: the four side-by-side 专长|描述 column pairs of the sheet
COLUMN_PAIRS = OrderedDict([
    ("P1", {"name_col": 2, "desc_col": 3, "first_row": 4, "last_row": 227,
            "category": "", "label": "B/C 专长总表"}),
    ("P2", {"name_col": 4, "desc_col": 5, "first_row": 4, "last_row": 17,
            "category": "战斗风格", "label": "D/E 战斗风格"}),
    ("P3", {"name_col": 6, "desc_col": 7, "first_row": 4, "last_row": 14,
            "category": "", "label": "F/G 专长速查"}),
    ("P4", {"name_col": 8, "desc_col": 9, "first_row": 4, "last_row": 24,
            "category": "", "label": "H/I 战斗风格速查"}),
])

#: leading "类别（先决：…）" header of a description cell
CATEGORY_RE = re.compile(
    r"^(起源专长|通用专长|传奇恩惠专长|龙纹专长|狂野天赋专长)"
    r"\s*(?:[（(]\s*先决[:：]?\s*(.*?)\s*[）)])?\s*$"
)
#: standalone "先决条件：…" / "先决：…" line (may sit at the top *or* the bottom)
PREREQ_RE = re.compile(r"^(先决条件|先决)\s*[:：]\s*(.+?)\s*$")

#: xlsx escapes a CR as the literal 6 chars "_x000D_"; restore it as a newline
CR_ESCAPE = "_x000D_"


# --------------------------------------------------------------------- reading
def load_grid(path: str) -> dict[tuple[int, int], str]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    grid: dict[tuple[int, int], str] = {}
    for key, val in data["cells"].items():
        r, c = key.split(",")
        grid[(int(r), int(c))] = val
    return grid


def cell(grid: dict[tuple[int, int], str], r: int, c: int) -> str:
    """Cell value, with placeholders normalised to ''."""
    raw = grid.get((r, c))
    if raw is None:
        return ""
    val = raw.strip()
    return "" if val in PLACEHOLDERS else val


def _sheet_path(z: zipfile.ZipFile, sheet: str) -> str | None:
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {x.get("Id"): x.get("Target") for x in rels}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    for sh in wb.find(f"{NS}sheets"):
        if sh.get("name") != sheet:
            continue
        target = relmap.get(sh.get(f"{RNS}id"), "")
        return target if target.startswith("xl/") else "xl/" + target.lstrip("/")
    return None


def _literal_name(formula: str | None) -> str | None:
    """Longest non-empty string literal in a formula -- the feat name."""
    if not formula:
        return None
    lits = [s.replace('""', '"') for s in re.findall(r'"((?:[^"]|"")*)"', formula)]
    lits = [s.strip() for s in lits if s.strip()]
    return max(lits, key=len) if lits else None


def read_formula_names(xlsx: str, sheet: str, name_cols: list[int]) -> dict[tuple[int, int], str]:
    """Map (row, col) -> feat name for name cells that are formula-driven."""
    out: dict[tuple[int, int], str] = {}
    if not xlsx or not os.path.exists(xlsx):
        return out
    z = zipfile.ZipFile(xlsx)
    path = _sheet_path(z, sheet)
    if not path or path not in z.namelist():
        return out
    xml = z.read(path).decode("utf-8")
    wanted = {chr(64 + c) for c in name_cols}
    for rm in re.finditer(r"<row r=\"(\d+)\"[^>]*>(.*?)</row>", xml, re.S):
        r = int(rm.group(1))
        for cm in re.finditer(r"<c r=\"([A-Z]+)(\d+)\"[^>]*?(?:/>|>(.*?)</c>)", rm.group(2), re.S):
            col, _row, inner = cm.group(1), cm.group(2), cm.group(3) or ""
            if col not in wanted:
                continue
            fm = re.search(r"<f[^>]*>(.*?)</f>", inner, re.S)
            name = _literal_name(fm.group(1) if fm else None)
            if name:
                out[(r, ord(col) - 64)] = name
    return out


# ------------------------------------------------------------------- parsing
def decode_cell_text(text: str) -> tuple[str, int]:
    """Undo the xlsx CR escape.  Returns (text, replacements)."""
    n = text.count(CR_ESCAPE)
    if not n:
        return text, 0
    return text.replace(CR_ESCAPE + "\n", "\n").replace(CR_ESCAPE, "\n"), n


def split_header(text: str) -> tuple[str, str, str]:
    """(category, prerequisite, body-start-line-index) of a description cell."""
    lines = text.split("\n")
    category = prereq = ""
    consumed = 0
    if lines:
        m = CATEGORY_RE.match(lines[0].strip())
        if m:
            category = m.group(1)
            prereq = (m.group(2) or "").strip()
            consumed = 1
    if not prereq:
        for i, line in enumerate(lines):
            m = PREREQ_RE.match(line.strip())
            if m:
                prereq = m.group(2).strip()
                if i >= consumed:
                    consumed = i + 1
                break
    return category, prereq, consumed


def make_summary(text: str, consumed: int) -> str:
    """One-line blurb taken verbatim from the top of the rules text."""
    body = [l.strip() for l in text.split("\n")[consumed:] if l.strip()]
    if not body:
        body = [l.strip() for l in text.split("\n") if l.strip()]
    if not body:
        return ""
    flat = " ".join(body)
    stop = flat.find("。")
    if 0 < stop <= 80:
        return flat[: stop + 1]
    if len(flat) <= 80:
        return flat
    return flat[:80].rstrip() + "…"


def build_entries(grid, formula_names, use_xlsx: bool):
    entries: list[dict] = []
    stats = {
        "pairs": OrderedDict(),
        "deduped": 0,
        "recovered_names": [],
        "placeholder_name_rows": [],
        "placeholder_text_rows": [],
        "cr_decoded": [],
        "skipped_rows": [],
    }
    seen: dict[tuple[str, str], dict] = {}

    for pid, spec in COLUMN_PAIRS.items():
        name_col, desc_col = spec["name_col"], spec["desc_col"]
        raw = new = 0
        for r in range(spec["first_row"], spec["last_row"] + 1):
            raw_name = grid.get((r, name_col))
            raw_desc = grid.get((r, desc_col))
            name = cell(grid, r, name_col)
            recovered = False
            if not name and use_xlsx:
                cand = formula_names.get((r, name_col))
                if cand and cand.strip() not in PLACEHOLDERS:
                    name = cand.strip()
                    recovered = True
            if not name:
                if raw_name is not None:
                    stats["placeholder_name_rows"].append((pid, r, raw_name))
                elif raw_desc is not None:
                    stats["skipped_rows"].append((pid, r, raw_desc[:40]))
                continue
            text = cell(grid, r, desc_col)
            if not text and raw_desc is not None:
                stats["placeholder_text_rows"].append((pid, r, name, raw_desc))
            text, n_cr = decode_cell_text(text)
            if n_cr:
                stats["cr_decoded"].append((pid, r, name, n_cr))
            raw += 1
            key = (name, text)
            if key in seen:
                stats["deduped"] += 1
                continue
            new += 1
            category, prereq, consumed = split_header(text)
            if not category:
                category = spec["category"]
            fields: dict[str, str] = {}
            if category:
                fields["类别"] = category
            if prereq:
                fields["先决条件"] = prereq
            tags: list[str] = []
            if category:
                tags.append(category)
                if category == "传奇恩惠专长":  # 2024 "Epic Boon" feats
                    tags.append("史诗恩泽")
            if recovered:
                tags.append("B列公式补名")
                stats["recovered_names"].append((pid, r, name))
            if not text:
                tags.append("占位条目")
            entry = {
                "id": f"feat:{name}",
                "type": "feat",
                "name": name,
                "en": "",
                "category": category,
                "tags": tags,
                "summary": make_summary(text, consumed),
                "text": text,
                "fields": fields,
                "source": "",
                "cardRef": {"sheet": SHEET, "row": r},
            }
            seen[key] = entry
            entries.append(entry)
        stats["pairs"][pid] = {"label": spec["label"], "raw": raw, "kept": new}

    # ---- column A: helper name list (the names the character actually owns)
    a_names: list[tuple[int, str]] = []
    for r in range(1, 300):
        v = cell(grid, r, 1)
        if v:
            a_names.append((r, v))
    stats["a_count"] = len(a_names)
    existing = {e["name"] for e in entries}
    a_missing = [n for _r, n in a_names if n not in existing]
    stats["a_missing"] = a_missing
    by_name = {e["name"]: e for e in entries}
    stats["a_no_text"] = [n for _r, n in a_names if not by_name[n]["text"]]
    for r, name in a_names:
        if name in existing:
            continue
        entries.append({
            "id": f"feat:{name}",
            "type": "feat",
            "name": name,
            "en": "",
            "category": "",
            "tags": ["A列名单", "占位条目"],
            "summary": "",
            "text": "",
            "fields": {},
            "source": "",
            "cardRef": {"sheet": SHEET, "row": r},
        })
        existing.add(name)

    # ---- globally unique ids: same name twice -> #2, #3 ...
    counter: Counter[str] = Counter()
    for e in entries:
        name = e["name"]
        counter[name] += 1
        if counter[name] > 1:
            e["id"] = f"feat:{name}#{counter[name]}"
    return entries, stats


# -------------------------------------------------------------------- report
def report(entries, stats, out_path: str) -> None:
    print(f"词条总数: {len(entries)}  -> {out_path}")
    print("\n各列对贡献:")
    for pid, s in stats["pairs"].items():
        print(f"  {pid} {s['label']}: 原始候选 {s['raw']} 条, 去重后新增 {s['kept']} 条, "
              f"被 (名称,正文) 去重 {s['raw'] - s['kept']} 条")
    print(f"  合计去重掉: {stats['deduped']} 条")
    print(f"\nA 列名单 {stats['a_count']} 个名字, 四组列对里完全找不到的: {stats['a_missing'] or '无'}")
    print(f"A 列名字存在但正文为空的: {stats['a_no_text'] or '无'}")
    print(f"B 列公式补名 {len(stats['recovered_names'])} 条")
    print(f"占位文本(正文为 '-'/'0' 等) {len(stats['placeholder_text_rows'])} 条: "
          f"{[(p, r, n) for p, r, n, _v in stats['placeholder_text_rows']]}")
    print(f"占位名字被跳过 {len(stats['placeholder_name_rows'])} 条: "
          f"{stats['placeholder_name_rows']}")
    print(f"有描述但名字列缺失且无法补名的行: {stats['skipped_rows'] or '无'}")
    print(f"_x000D_ 转义解码 {len(stats['cr_decoded'])} 处: "
          f"{[(p, r) for p, r, _n, _c in stats['cr_decoded']]}")
    cat = Counter(e["category"] or "(未标注)" for e in entries)
    print("\n类别分布:")
    for k, v in cat.most_common():
        print(f"  {k}: {v}")
    dup_names = {n: c for n, c in Counter(e["name"] for e in entries).items() if c > 1}
    print(f"\n重名条目 (id 加 #2): {dup_names or '无'}")
    by_text: dict[str, list[str]] = {}
    for e in entries:
        if e["text"]:
            by_text.setdefault(e["text"], []).append(e["name"])
    shared = [(t, names) for t, names in by_text.items() if len(names) > 1]
    if shared:
        print("不同名字共用同一段正文 (疑似卡内数据问题, 按原文照收):")
        for text, names in shared:
            print("   ", " / ".join(names), f"— 正文 {len(text)} 字")
    empty = [e["name"] for e in entries if not e["text"]]
    print(f"text 为空: {len(empty)} 条 -> {empty}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", default=DEFAULT_GRID)
    ap.add_argument("--xlsx", default=DEFAULT_XLSX)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--no-xlsx", action="store_true",
                    help="do not read the workbook for missing feat names")
    args = ap.parse_args()

    if not os.path.exists(args.grid):
        print("grid not found:", args.grid, file=sys.stderr)
        return 1
    grid = load_grid(args.grid)
    use_xlsx = not args.no_xlsx
    formula_names = {}
    if use_xlsx:
        cols = [spec["name_col"] for spec in COLUMN_PAIRS.values()]
        formula_names = read_formula_names(args.xlsx, SHEET, cols)
        if not formula_names:
            print("warning: no formula names read from", args.xlsx,
                  "-- falling back to grid only", file=sys.stderr)
    entries, stats = build_entries(grid, formula_names, use_xlsx)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(entries, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    report(entries, stats, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
