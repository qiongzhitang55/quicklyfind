#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Independent QA of dnd-data/feats.json against the grid AND the raw xlsx."""
import json, re, zipfile, sys
import xml.etree.ElementTree as ET

XLSX = r"D:\quicklyFind\card\米瑞尔.xlsx"
GRID = r"D:\quicklyFind\card\grids\专长与据点.json"
FEATS = r"D:\quicklyFind\dnd-data\feats.json"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

feats = json.load(open(FEATS, encoding="utf-8"))
grid = {tuple(map(int, k.split(","))): v for k, v in json.load(open(GRID, encoding="utf-8"))["cells"].items()}

# raw shared strings + formulas
z = zipfile.ZipFile(XLSX)
ss = []
for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si"):
    ss.append("".join(t.text or "" for t in si.iter(NS + "t")))
xml = z.read("xl/worksheets/sheet7.xml").decode("utf-8")
raw = {}   # (r,c) -> value (shared string resolved) ; formulas separately
form = {}
for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', xml, re.S):
    col, r, attrs, inner = m.group(1), int(m.group(2)), m.group(3), m.group(4) or ""
    t = re.search(r't="(\w+)"', attrs)
    v = re.search(r"<v>(.*?)</v>", inner, re.S)
    f = re.search(r"<f[^>]*>(.*?)</f>", inner, re.S)
    val = v.group(1) if v else ""
    if t and t.group(1) == "s" and val:
        val = ss[int(val)]
    raw[(r, ord(col) - 64)] = val
    if f:
        form[(r, ord(col) - 64)] = f.group(1)

PAIRS = [(2, 3), (4, 5), (6, 7), (8, 9)]
PLACE = {"", "-", "—", "0", "#VALUE!", "#N/A"}

errs, warns = [], []
ids = set()
for e in feats:
    for k in ("id", "type", "name", "en", "category", "tags", "summary", "text", "fields", "source", "cardRef"):
        if k not in e:
            errs.append(f"{e.get('name')}: missing key {k}")
    if e["type"] != "feat":
        errs.append(f"{e['name']}: type != feat")
    if e["id"] in ids:
        errs.append(f"duplicate id {e['id']}")
    ids.add(e["id"])
    if not e["id"].startswith("feat:"):
        errs.append(f"{e['name']}: bad id {e['id']}")
    c, r = e["cardRef"]["sheet"], e["cardRef"]["row"]
    if c != "专长与据点":
        errs.append(f"{e['name']}: bad sheet")
    if not isinstance(r, int) or r < 1:
        errs.append(f"{e['name']}: bad row {r}")
    if not e["text"]:
        continue
    # find the pair column that owns this entry and compare text with the sheet cell
    ok = False
    for nc, dc in PAIRS:
        sheet_val = raw.get((r, dc))
        name_here = grid.get((r, nc)) or ""
        if not name_here:
            # name may live only in the formula
            fm = form.get((r, nc))
            if fm:
                lits = [s.strip() for s in re.findall(r'"((?:[^"]|"")*)"', fm) if s.strip()]
                name_here = max(lits, key=len) if lits else ""
        if sheet_val is None and grid.get((r, dc)) is None:
            continue
        sheet_val = (sheet_val or grid.get((r, dc)) or "")
        decoded = sheet_val.replace("_x000D_\n", "\n").replace("_x000D_", "\n").strip()
        if name_here == e["name"] and decoded == e["text"]:
            ok = True
            break
    if not ok:
        errs.append(f"{e['name']} r{r}: text does not match any pair cell verbatim")
    for bad in ("#VALUE!", "#N/A", "_x000D_"):
        if bad in e["text"]:
            errs.append(f"{e['name']} r{r}: placeholder/escape {bad!r} leaked into text")

# coverage: every sheet row that has a description in a pair must be represented
covered = {(e["name"], e["text"]) for e in feats}
for nc, dc in PAIRS:
    for r in range(4, 228):
        dv = grid.get((r, dc))
        if not dv or dv in PLACE:
            continue
        nv = grid.get((r, nc))
        if not nv:
            fm = form.get((r, nc))
            lits = [s.strip() for s in re.findall(r'"((?:[^"]|"")*)"', fm or "") if s.strip()]
            nv = max(lits, key=len) if lits else None
        if not nv:
            warns.append(f"pair {nc}/{dc} r{r}: description without a recoverable name -> {dv[:24]!r}")
            continue
        dtext = (dv or "").replace("_x000D_\n", "\n").replace("_x000D_", "\n").strip()
        if (nv, dtext) not in covered:
            errs.append(f"pair {nc}/{dc} r{r}: name {nv!r} with description is NOT in feats.json")

print(f"entries: {len(feats)}")
print(f"unique ids: {len(ids)}")
print(f"with text: {sum(1 for e in feats if e['text'])}")
print(f"max text len: {max(len(e['text']) for e in feats)}")
print(f"by category: {json.dumps({k: sum(1 for e in feats if (e['category'] or '(none)') == k) for k in sorted({e['category'] or '(none)' for e in feats})}, ensure_ascii=False)}")
print(f"\nERRORS ({len(errs)}):")
for x in errs[:40]:
    print("  ", x)
print(f"\nWARNINGS ({len(warns)}):")
for x in warns[:40]:
    print("  ", x)
sys.exit(1 if errs else 0)
