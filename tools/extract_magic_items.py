#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""规则书里的魔法物品 → dnd-data/magic_items.json（给「魔法物品」页做速查用）。

来源：`rules-text\\corpus.jsonl` 里「城主指南2024 › 第七章：宝藏 › 魔法物品详述」底下那些页。
那些页按「类别 / 稀有度」分，正文里一条一条列着（标题带英文名，正文头一行写着「奇物，珍稀」）。

    python tools/extract_magic_items.py            # 写出 dnd-data/magic_items.json
    python tools/extract_magic_items.py --dry-run  # 只打报告
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "rules-text" / "corpus.jsonl"
OUT = ROOT / "dnd-data" / "magic_items.json"

RARITIES = ["普通", "非普通", "珍稀", "极珍稀", "传说", "多种稀有度", "神器"]
CATEGORY_PREFIX = "魔法物品："
SUBCATS = ["着装品", "装饰品", "其他物品"]


def split_name(head: str) -> tuple[str, str]:
    """`魔豆之袋 Bag of Beans` → ('魔豆之袋', 'Bag of Beans')"""
    # 名字可能以 ASCII 打头（`X射线戒指 Ring of X-Ray Vision`），所以按「最后一个中文字 + 空格 + 英文」切
    m = re.match(r"^(.*?[\u4e00-\u9fff])\s+([A-Za-z][A-Za-z0-9'’\-\s,:]*)$", head.strip())
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m1 = re.match(r"^([^\x00-\x7f]+)\s*([A-Za-z0-9][A-Za-z0-9'’\-\s,:]*)", head)
    if m1:
        return m1.group(1).strip(), m1.group(2).strip()
    m2 = re.match(r"^([A-Za-z0-9][A-Za-z0-9'’\-\s,:]*)$", head)
    if m2:
        return head.strip(), head.strip()
    return head.strip(), ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    items: list[dict] = []
    seen_pages = 0

    with CORPUS.open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            d = json.loads(line)
            crumbs = d.get("crumbs") or []
            if "魔法物品详述" not in crumbs:
                continue
            heads = [h for h in (d.get("headings") or []) if (h.get("level") or 0) >= 6]
            if len(heads) < 2:
                continue
            seen_pages += 1

            cat = next((c[len(CATEGORY_PREFIX):] for c in crumbs if c.startswith(CATEGORY_PREFIX)), "")
            sub = next((c for c in crumbs if c in SUBCATS), "")
            title = (d.get("title") or "").strip()
            page_rarity = title if title in RARITIES else ""
            book = crumbs[0] if crumbs else ""

            lines = (d.get("text") or "").split("\n")
            head_texts = [h.get("text", "").strip() for h in heads]
            positions = []
            idx = 0
            for h in head_texts:
                found = -1
                for i in range(idx, len(lines)):
                    if lines[i].strip() == h:
                        found = i
                        break
                if found >= 0:
                    positions.append((found, h))
                    idx = found + 1

            for n, (start, head) in enumerate(positions):
                end = positions[n + 1][0] if n + 1 < len(positions) else len(lines)
                body = "\n".join(lines[start:end]).strip()
                name, en = split_name(head)
                if not name:
                    continue
                # 正文头一行通常写着「奇物，珍稀」「戒指，传说」这类
                rarity = page_rarity
                first = body.split("\n")[1].strip() if len(body.split("\n")) > 1 else ""
                m = re.search(r"[，,]\s*(" + "|".join(RARITIES) + r")", first)
                if m:
                    rarity = m.group(1)
                summary = ""
                for l in body.split("\n")[1:]:
                    t = l.strip()
                    if t and not re.match(r"^[^\x00-\x7f]{2,6}[，,]", t):
                        summary = t[:60]
                        break
                items.append({
                    "id": f"magicItem:{name}",
                    "type": "magicItem",
                    "name": name,
                    "en": en,
                    "category": " ".join(x for x in (cat, sub) if x),
                    "tags": [x for x in (rarity, book) if x],
                    "summary": summary,
                    "text": body,
                    "fields": {"类别": cat + (f" {sub}" if sub else ""), "稀有度": rarity},
                    "source": book,
                    "cardRef": {"sheet": "主要", "row": 0},
                })

    # 重名（跨书 / 跨稀有度）加后缀，id 保证唯一
    counts: dict[str, int] = {}
    for it in items:
        n = counts.get(it["id"], 0) + 1
        counts[it["id"]] = n
        if n > 1:
            it["id"] = f"{it['id']}#{n}"

    print(f"扫了 {seen_pages} 页，抽出 {len(items)} 条魔法物品")
    by_cat: dict[str, int] = {}
    for it in items:
        by_cat[it["category"]] = by_cat.get(it["category"], 0) + 1
    for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1]):
        print(f"   {k or '（没分类）'}：{v}")
    for it in items[:3]:
        print(f"   例：{it['name']} / {it['en']} / {it['fields']}")

    if args.dry_run:
        return 0
    OUT.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写出 {OUT.relative_to(ROOT)}（{OUT.stat().st_size // 1024} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
