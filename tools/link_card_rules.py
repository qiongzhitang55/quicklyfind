#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把卡里的「主职业 / 子职 / 出身」对上规则库条目，生成 dnd-data/card_rules.json。

分工：卡负责「能填什么」（写表必须用卡里的名字），规则库负责「为什么」（正文）。
两边的译名不总一样——卡叫「幽域追踪者」，书里叫「幽域追猎者」；书里还会把出处写进
标题（「狂野魔法道途（TCE）」）或加职业前缀（「武僧-神龙宗」「背景-运动员」）。
所以这里按几档匹配，对不上的单独列出来，绝不硬凑。

卡换了要重跑（清单是从卡里现读的）：

    python tools/link_card_rules.py            # 写 dnd-data/card_rules.json
    python tools/link_card_rules.py --dry-run  # 只打报告
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

ROOT = Path(__file__).resolve().parent.parent
CARD = ROOT / "card" / "悲灵.xlsx"
CORPUS = ROOT / "rules-text" / "corpus.jsonl"
OUT = ROOT / "dnd-data" / "card_rules.json"

# 规则库里「这一条挂在职业树 / 背景节下」的目录标记
SUBCLASS_MARKERS = ("职业", "角色选项", "角色创作项", "子职", "角色创建", "玩家选项", "角色职业")
BACKGROUND_MARKERS = ("背景", "出身")
CLASS_MARKERS = ("角色职业", "职业", "玩家选项", "角色选项")

# 卡和书对不上、但确实是同一条的（人工确认过的）
ALIASES = {
    "subclass": {
        "幽域追踪者": "幽域追猎者",   # 卡里的写法 vs 书里的写法
        "巨灵宗主": "巨灵",
    },
    "background": {},
}


# ---------------------------------------------------------------- 卡

def col_num(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch.upper()) - 64
    return n


def col_name(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def card_sheet(name: str) -> "dict[tuple[str, int], str]":
    z = zipfile.ZipFile(CARD)
    shared = ["".join(t.text or "" for t in si.iter(NS + "t"))
              for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si")]
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    path = next(rels[sh.get(RNS + "id")] for sh in wb.find(NS + "sheets") if sh.get("name") == name)
    xml = z.read("xl/" + path.lstrip("/")).decode("utf-8")
    cells: "dict[tuple[str, int], str]" = {}
    for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', xml, re.S):
        col, row, attrs, inner = m.group(1), int(m.group(2)), m.group(3) or "", m.group(4) or ""
        v = re.search(r"<v>(.*?)</v>", inner, re.S)
        t = re.search(r't="(\w+)"', attrs)
        val = v.group(1) if v else ""
        if t and t.group(1) == "s" and val.isdigit():
            val = shared[int(val)]
        cells[(col, row)] = val.strip()
    return cells


def is_name(t: str) -> bool:
    return bool(t) and len(t) <= 24 and "\n" not in t and not re.match(r"^\d+([.,]\d+)?$", t) \
        and not t.startswith("—")


def card_classes() -> list[str]:
    """卡里竖排的职业清单（`职业` 表 AY 列，一行一个职业，含扩展职业）。"""
    cells = card_sheet("职业")
    out: list[str] = []
    for r in range(2, 21):
        t = cells.get(("AY", r), "")
        if is_name(t) and t not in out:
            out.append(t)
    return out


def card_subclasses() -> "dict[str, list[str]]":
    """卡的「职业 × 出处」矩阵：一行一个职业，右边每格是它的子职。"""
    cells = card_sheet("职业")
    classes = card_classes()
    out: "dict[str, list[str]]" = {}
    base = col_num("B")
    for i, cls in enumerate(classes):
        subs: list[str] = []
        for k in range(1, 13):
            t = cells.get((col_name(base + k), 3 + i), "")
            if is_name(t) and t not in subs:
                subs.append(t)
        if subs:
            out[cls] = subs
    return out


def card_backgrounds() -> list[str]:
    """卡里「背景」表 A 列——卡自己把 B 列非空的名字压实出来的那份完整清单。

    下拉里只放核心那十几条（应用那边管），但查正文按整份名单来：
    手输一个扩展出身，也该能查到它的正文。「自定义背景」是占位，跳过。
    """
    cells = card_sheet("背景")
    out = []
    for r in range(2, 160):
        t = cells.get(("A", r), "")
        if is_name(t) and not t.startswith("自定义背景") and t not in out:
            out.append(t)
    return out


# ---------------------------------------------------------------- 规则库

def variants(title: str) -> set[str]:
    """标题的几种写法：原样 / 去掉结尾的（出处）/ 去掉「职业-」「职业：」前缀。"""
    out = {title.strip()}
    out.add(re.sub(r"[（(][^）)]*[）)]\s*$", "", title).strip())
    for v in list(out):
        if re.match(r"^[^-－：:]{2,6}[-－：:]", v):
            out.add(re.split(r"[-－：:]", v, maxsplit=1)[1].strip())
    return {v for v in out if v}


def norm(s: str) -> str:
    return re.sub(r"[\s·・．.\-—–_（）()\[\]【】「」《》]", "", s).lower()


def load_rules() -> "dict[str, list[dict]]":
    """归一化标题 → 规则条目（同名的都留着，匹配时再挑）。"""
    index: "dict[str, list[dict]]" = {}
    with CORPUS.open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            d = json.loads(line)
            if (d.get("kind") or "") != "rules":
                continue
            page = {
                "title": d.get("title") or "",
                "book": d.get("group") or "",
                "crumbs": d.get("crumbs") or [],
                "text": d.get("text") or "",
            }
            if len(page["text"]) < 120:      # 目录页 / 占位页
                continue
            for v in variants(page["title"]):
                index.setdefault(norm(v), []).append(page)
    return index


def pick(cands: "list[dict]", cls: str, markers: tuple) -> "dict | None":
    """同名候选里挑最合适的那条：在本职业/本篇目录下的 > 玩家手册2024 > 层级浅 > 正文长。"""
    if not cands:
        return None

    def in_tree(p: dict) -> bool:
        crumbs = " › ".join(p["crumbs"])
        return any(m in crumbs for m in markers) or (bool(cls) and cls in crumbs)

    def score(p: dict) -> tuple:
        crumbs = " › ".join(p["crumbs"])
        return (
            0 if cls and cls in crumbs else 1,
            0 if p["book"] == "玩家手册2024" else 1,
            len(p["crumbs"]),
            -len(p["text"]),
            p["title"],
        )

    scored = [p for p in cands if in_tree(p)]
    return sorted(scored or cands, key=score)[0]


def link(index: "dict[str, list[dict]]", kind: str, cls: str, name: str) -> "dict | None":
    key = ALIASES.get(kind, {}).get(name, name)
    markers = {"subclass": SUBCLASS_MARKERS, "class": CLASS_MARKERS}.get(kind, BACKGROUND_MARKERS)
    hit = pick(index.get(norm(key), []), cls, markers)
    if hit is None:
        return None
    return {
        "kind": kind,
        # 「class」是这条挂在哪门职业下：子职填职业名，主职业和出身本身没有上级，留空
        "class": "" if kind == "class" else cls,
        "name": name,              # 卡里的写法，写表用它
        "title": hit["title"],     # 书里的写法
        "book": hit["book"],
        "crumbs": hit["crumbs"],
        "text": hit["text"],
        "aliased": name != key,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打报告，不写文件")
    args = ap.parse_args()

    index = load_rules()
    items, unmatched = [], []

    classes = card_classes()
    for n in classes:
        # 主职业只有名字，没有「本职业」前缀；把 cls 传成它自己，
        # 让「玩家手册2024 › 第三章：角色职业 › 战士」这条自己排在最前面
        hit = link(index, "class", n, n)
        (items.append(hit) if hit else unmatched.append({"kind": "class", "class": "", "name": n}))

    subs = card_subclasses()
    for cls, names in subs.items():
        for n in names:
            hit = link(index, "subclass", cls, n)
            (items.append(hit) if hit else unmatched.append({"kind": "subclass", "class": cls, "name": n}))

    bgs = card_backgrounds()
    for n in bgs:
        hit = link(index, "background", "", n)
        (items.append(hit) if hit else unmatched.append({"kind": "background", "class": "", "name": n}))

    for kind, label, total in (("class", "主职业", len(classes)),
                               ("subclass", "子职", sum(len(v) for v in subs.values())),
                               ("background", "出身", len(bgs))):
        got = [i for i in items if i["kind"] == kind]
        print(f"{label}：卡里 {total} 条，对上 {len(got)} 条"
              f"（靠别名 {sum(1 for i in got if i['aliased'])} 条）")
        for i in got:
            if i["aliased"]:
                print(f"     别名：卡「{i['name']}」→ 书「{i['title']}」（{i['book']}）")
        miss = [u for u in unmatched if u["kind"] == kind]
        for u in miss:
            print(f"     对不上：{u['class'] + '/' if u['class'] else ''}{u['name']}")

    if args.dry_run:
        return 0
    OUT.write_text(json.dumps({
        "note": "卡里的主职业 / 子职 / 出身 → 规则库条目；由 tools/link_card_rules.py 生成，卡换了要重跑",
        "items": items,
        "unmatched": unmatched,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写出 {OUT.relative_to(ROOT)}（{OUT.stat().st_size // 1024} KB，{len(items)} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
