#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把早先抽出的扁平 spells.json 规范成 dnd-data/SCHEMA.md 的统一格式。"""
from __future__ import annotations

import json
import os
import re
import sys

DATA = r"D:\quicklyFind\dnd-data"
SRC = os.path.join(DATA, "spells.json")
LEVEL_CN = {0: "戏法", 1: "一环", 2: "二环", 3: "三环", 4: "四环",
            5: "五环", 6: "六环", 7: "七环", 8: "八环", 9: "九环"}


def first_sentence(text: str, limit: int = 80) -> str:
    t = text.strip()
    if not t:
        return ""
    # 跳过「三环 塑能（术士、法师）」这类首行，取真正的描述首句
    lines = [ln.strip() for ln in t.split("\n") if ln.strip()]
    for ln in lines:
        if re.match(r"^[戏一二三四五六七八九]环\s", ln):
            continue
        if re.match(r"^(施法时间|施法距离|法术成分|持续时间|材料)[:：]", ln):
            continue
        t = ln
        break
    m = re.split(r"(?<=[。！？])", t)
    s = m[0] if m else t
    s = s.strip()
    return s if len(s) <= limit else s[:limit] + "…"


def main() -> int:
    raw = json.load(open(SRC, encoding="utf-8"))
    out = []
    seen: dict[str, int] = {}
    for i, s in enumerate(raw, 1):
        name = (s.get("name") or "").strip()
        if not name:
            continue
        lvl_raw = (s.get("level") or "").strip()
        lvl = int(lvl_raw) if lvl_raw.isdigit() else -1
        school = (s.get("school") or "").strip()
        classes = s.get("classes") or []
        source = (s.get("source") or "").strip()
        conc = bool(s.get("concentration"))
        rit = bool(s.get("ritual"))

        fields: dict[str, str] = {}
        fields["环阶"] = lvl_raw if lvl_raw else ""
        if school:
            fields["学派"] = school
        if s.get("castTime"):
            fields["施法时间"] = s["castTime"]
        if s.get("range"):
            fields["施法距离"] = s["range"]
        comps = "".join([c for c, on in (("V", s.get("v")), ("S", s.get("s")), ("M", s.get("m"))) if on])
        if comps:
            fields["法术成分"] = comps
        if s.get("material"):
            fields["材料"] = s["material"]
        if s.get("duration"):
            fields["持续时间"] = s["duration"]
        fields["专注"] = "是" if conc else "否"
        fields["仪式"] = "是" if rit else "否"
        if classes:
            fields["职业"] = "、".join(classes)

        tags = list(classes)
        if source:
            tags.append(source)
        if conc:
            tags.append("专注")
        if rit:
            tags.append("仪式")

        cat = f"{LEVEL_CN.get(lvl, lvl_raw + '环')} {school}".strip()

        count = seen.get(name, 0) + 1
        seen[name] = count
        out.append({
            "id": f"spell:{name}" + (f"#{count}" if count > 1 else ""),
            "type": "spell",
            "name": name,
            "en": s.get("en", ""),
            "category": cat,
            "tags": tags,
            "summary": first_sentence(s.get("text", "")),
            "text": s.get("text", ""),
            "fields": {k: v for k, v in fields.items() if v != ""},
            "source": source,
            "cardRef": {"sheet": "法术大全", "row": s.get("row", 0)},
        })

    with open(SRC, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)

    print(f"规范化 {len(out)} 条法术 -> {SRC}")
    print("字段示例:", json.dumps(out[0], ensure_ascii=False)[:420])
    print("缺英文名:", sum(1 for e in out if not e["en"]))
    print("缺详述:", sum(1 for e in out if not e["text"]))
    print("无职业标注:", sum(1 for e in out if "职业" not in e["fields"]))
    from collections import Counter
    print("环阶分布:", dict(Counter(e["fields"].get("环阶", "?") for e in out)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
