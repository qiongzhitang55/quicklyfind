# -*- coding: utf-8 -*-
"""临时核对脚本（非交付物）：把 equipment.json 与源网格逐行对账。"""
import json
from pathlib import Path

ROOT = Path(r"D:\quicklyFind")
d = json.loads((ROOT / "dnd-data" / "equipment.json").read_text(encoding="utf-8"))
by = {}
for e in d:
    by.setdefault(e["cardRef"]["row"], []).append(e)

print("武器分组边界抽查:")
for r in (3, 21, 22, 31, 32, 60, 61, 77):
    xs = [x for x in by.get(r, []) if x["category"] == "武器"]
    print("  r%-3s %-8s %s" % (r, xs[0]["name"] if xs else "-", xs[0]["fields"].get("类型", "") if xs else ""))

print("\n重名条目:")
for e in d:
    if "#" in e["id"]:
        print("  %-24s %s %s" % (e["id"], e["category"], e["fields"].get("类型", "")))

g = json.loads((ROOT / "card" / "grids" / "装备.json").read_text(encoding="utf-8"))
cells = {}
for k, v in g["cells"].items():
    r, c = (int(x) for x in k.split(","))
    cells[(r, c)] = str(v).strip()
PH = {"", "-", "—", "0", "√", "OK"}


def gv(r, c):
    v = cells.get((r, c), "")
    return "" if v in PH else v


missing = []
for r in range(2, g["rows"] + 1):
    n = gv(r, 1)
    if n and not any(e["cardRef"]["row"] == r and e["category"] in ("冒险用品", "弹药", "法器") for e in d):
        missing.append(("A-D", r, n))
    n = gv(r, 12)
    if n and not any(e["cardRef"]["row"] == r and e["category"] == "工具" for e in d):
        missing.append(("L-Q", r, n))
    n = gv(r, 43)
    if n and not any(e["cardRef"]["row"] == r and e["category"] in ("护甲", "其它") for e in d):
        missing.append(("AQ", r, n))
    n = gv(r, 35)
    if n and gv(r, 36) and not any(e["cardRef"]["row"] == r and e["category"] == "武器" for e in d):
        missing.append(("AI", r, n))

print("\n未被收录的来源行:", missing)
print("条目总数:", len(d))
print("行号范围:", min(e["cardRef"]["row"] for e in d), "-", max(e["cardRef"]["row"] for e in d))
print("id 唯一:", len({e["id"] for e in d}) == len(d))
print("所有条目 cardRef.sheet == 装备:", all(e["cardRef"]["sheet"] == "装备" for e in d))
print("所有字段值为非空字符串:", all(isinstance(v, str) and v for e in d for v in e["fields"].values()))
