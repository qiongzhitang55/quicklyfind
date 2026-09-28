# -*- coding: utf-8 -*-
"""
extract_species_class.py
========================
Parse the 种族 (species) and 职业 (class) worksheets of the D&D 5e Chinese
character-sheet workbook into the unified dnd-data entry format described in
dnd-data/SCHEMA.md.

Input  (read-only, never modified):
    card/grids/种族.json     204 rows x 80 cols
    card/grids/职业.json     263 rows x 102 cols
    card/grids/主要.json     (cross-check reference only)

Output:
    dnd-data/species.json          entries with type = "species"
    dnd-data/class_features.json   entries with type = "classFeature"

Re-runnable: every run reads the grid JSONs from scratch and rewrites both
output files deterministically (no randomness, no wall-clock data).

--------------------------------------------------------------------------
層1. 种族 worksheet layout  (verified against every one of the 151 species rows)
--------------------------------------------------------------------------
* Column A   : species / sub-species display name, rows 2..152.
* Column B   : "行" = block index B.  Present only on BASE species rows.
               The row's feature-name row is  F = 2 * B
               the row's description  row is  F + 1 = 2 * B + 1
               (L..Y region, i.e. grid columns 12..25.)
* Column C/D : "最小列"/"最大列" = inclusive 1-based feature column span.
               Grid column = 11 + C  ...  11 + D.
               Verified: C=1 -> grid column 12 (L).
* Sub-species rows carry no B; they inherit the nearest preceding base row's
  F and use their own C/D span.
* Rows 2..152 of the L..Y region interleave perfectly:
      even rows = feature-name rows,  odd rows = description rows.
  e.g. 阿斯莫 B=1 -> names at row 2 (L..S), descriptions at row 3 (L..S);
       龙裔  B=2 -> names at row 4 (L..P), descriptions at row 5 (L..P).
* Column E/F/G/H carry the per-species 生物种类/体型/速度 block.  IMPORTANT: the E
  list is a different list from column A (which holds species + sub-species), so
  its row numbers do NOT line up with A's.  The metadata for a species must be
  looked up by NAME in column E, never by the A-row's own row number.
* Columns AY..BE (51..57) hold the race-major sub-species list; used only as
  a cross-check for sub-species naming.

--------------------------------------------------------------------------
层2. 职业 worksheet layout  (verified against all 18 class blocks)
--------------------------------------------------------------------------
* Row 1  : publication-source abbreviations (PHB / XGE / TCE / ...).
* Row 3+ : class x source subclass matrix; col1 = class index, col2 = class
           name, col3.. = subclass names (the subclass list used here).
* Row 29 : column-number strip.
* Row 30 : class-name anchor row.  Column A2 (level), B2 (feature name) and
           C2 (description) where A2 is the anchor column.
* Row 31 : start of the class feature table; the level column sits at the
           anchor column itself, e.g. 野蛮人 anchor col 2 -> level col 2,
           name col 3, desc col 4; 吟游诗人 anchor col 5 -> 5 / 6 / 7.
* Row 31..36 : class-level  proficiency blocks (no level number; level 1).
* Base class table : ascending levels 1..20, ends at the level-20 row.
* Subclass tables  : after the level-20 row; levels restart at 3 for each
                     subclass, so a level drop to 3 starts a new subclass.
* Columns 86..88 hold a (subclass -> start row) index used to cross-check the
  subclass segmentation.
"""

import json
import os
import re
import sys

# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRID_DIR = os.path.join(ROOT, "card", "grids")
OUT_DIR = os.path.join(ROOT, "dnd-data")

SPECIES_GRID = os.path.join(GRID_DIR, "种族.json")
CLASS_GRID = os.path.join(GRID_DIR, "职业.json")

SPECIES_OUT = os.path.join(OUT_DIR, "species.json")
CLASS_OUT = os.path.join(OUT_DIR, "class_features.json")

# placeholders that must never be treated as content
JUNK = {"#VALUE!", "#N/A", "#REF!", "#NAME?", "#DIV/0!", "#NULL!", "#NUM!",
        "0", "-", "--", "—", "n/a", "N/A", "0v0?", "#VALUE", "#N/A!"}

# header sentinel for the L..Y species feature grid
SPECIES_HEADER_ROW = 1

CELL_RE = re.compile(r"^(\d+),(\d+)$")


# --------------------------------------------------------------------------
# grid access helpers
# --------------------------------------------------------------------------
class Grid(object):
    """Thin reader over one exported worksheet grid."""

    def __init__(self, path):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        self.sheet = data["sheet"]
        self.rows = data["rows"]
        self.cols = data["cols"]
        self.cells = data["cells"]

    def raw(self, row, col):
        return self.cells.get("%d,%d" % (row, col))

    def get(self, row, col):
        """Raw cell text, or '' when the cell is empty."""
        v = self.cells.get("%d,%d" % (row, col))
        return v if v is not None else ""

    def text(self, row, col):
        """Cell text with placeholders removed and surrounded whitespace trimmed."""
        v = self.get(row, col)
        v = v.replace("\r\n", "\n").replace("\r", "\n")
        v = v.strip()
        if v in JUNK:
            return ""
        return v

    def intval(self, row, col):
        v = self.text(row, col)
        return int(v) if re.fullmatch(r"\d+", v) else None


def clean(v):
    """Normalise a raw string into content-or-empty."""
    if v is None:
        return ""
    v = v.replace("\r\n", "\n").replace("\r", "\n").strip()
    return "" if v in JUNK else v


def mk_summary(text, limit=60):
    """One-line summary: first line, whitespace-collapsed, truncated."""
    if not text:
        return ""
    first = text.split("\n", 1)[0].strip()
    first = re.sub(r"\s+", " ", first)
    if len(first) > limit:
        first = first[:limit] + "…"
    return first


class IdPool(object):
    """Assigns globally-unique ids of the form ``type:name`` (``#2`` on clash)."""

    def __init__(self):
        self.seen = {}

    def make(self, type_, name):
        key = "%s:%s" % (type_, name)
        n = self.seen.get(key, 0) + 1
        self.seen[key] = n
        return key if n == 1 else "%s#%d" % (key, n)


# --------------------------------------------------------------------------
# 种族 (species)
# --------------------------------------------------------------------------
SPECIES_NAME_ROW_HEADER = 1          # header row of the L..Y grid
SPECIES_COL_BASE = 11                # grid column = SPECIES_COL_BASE + feature index
SPECIES_COL_FIRST = 12               # first grid column of the feature block (L)
SPECIES_COL_LAST = 48                # last grid column used by the block (max D is 17)
# NOTE: columns 49/50 are empty and 51+ belong to the separate sub-species
# list, so the feature block must stop at 48 to avoid mixing in that table.


def read_species_rows(sg):
    """Return the A/B/C/D table rows (2..152) as dicts."""
    out = []
    for r in range(2, 153):
        name = sg.text(r, 1)
        if not name:
            continue
        out.append({
            "row": r,
            "name": name,
            "block": sg.intval(r, 2),
            "min_col": sg.intval(r, 3),
            "max_col": sg.intval(r, 4),
        })
    return out


def build_species_index(sg):
    """Map feature-name row -> {grid col: feature name} and desc row -> {...}."""
    names = {}
    descs = {}
    for r in range(SPECIES_NAME_ROW_HEADER + 1, sg.rows + 1):
        nm = {}
        for c in range(SPECIES_COL_FIRST, SPECIES_COL_LAST + 1):
            v = sg.text(r, c)
            if v:
                nm[c] = v
        if nm:
            names[r] = nm
    # descriptions are the row after a name row; capture every candidate row
    for r in range(SPECIES_NAME_ROW_HEADER + 1, sg.rows + 1):
        ds = {}
        for c in range(SPECIES_COL_FIRST, SPECIES_COL_LAST + 1):
            v = sg.text(r, c)
            if v:
                ds[c] = v
        if ds:
            descs[r] = ds
    return names, descs


def extract_species(sg):
    """Return (entries, report)."""
    rows = read_species_rows(sg)
    names_by_row, descs_by_row = build_species_index(sg)

    # 生物种类 / 体型 / 速度 在 E..H 那一块。注意：E 列是「这三个格子自己的名单」，
    # 跟 A 列（种族 + 亚种的清单）**不是同一份**，两边的行号也不一样 —— 按 A 列的行号
    # 去读 F/G/H 会配到隔壁种族的元数据（人类就读成了地底侏儒的
    # 「你是类人生物…你也被视作侏儒」/ 小型）。所以按种族名去 E 列找行。
    meta_row = {}
    for r in range(2, 153):
        n = sg.text(r, 5)
        if n and n not in meta_row:
            meta_row[n] = r

    # nearest preceding base row (block) for every A-row
    parent_of = {}
    cur = None
    for info in rows:
        if info["block"] is not None:
            cur = info
        parent_of[info["row"]] = cur

    pool = IdPool()
    entries = []
    per_species = {}
    unparsed = []

    for info in rows:
        row = info["row"]
        name = info["name"]
        base = parent_of.get(row)
        mn, mx = info["min_col"], info["max_col"]
        if base is None or mn is None or mx is None:
            unparsed.append((row, name, "no B anchor / missing C-D"))
            continue
        if mn > mx:
            unparsed.append((row, name, "min_col > max_col"))
            continue

        block = base["block"]
        feat_row = 2 * block            # feature-name row
        desc_row = feat_row + 1         # description row
        cols = [SPECIES_COL_BASE + i for i in range(mn, mx + 1)]

        # cross-check: the name row must actually hold feature names
        fnames = names_by_row.get(feat_row, {})
        if not fnames:
            unparsed.append((row, name, "feature row %d empty" % feat_row))
            continue

        # 按种族名去 E 列找它自己的那一行（找不到的少数几个退回 A 行）
        mrow = meta_row.get(base["name"], base["row"])
        base_meta = {
            "生物种类": sg.text(mrow, 6),
            "体型": sg.text(mrow, 7),
            "速度": sg.text(mrow, 8),
        }
        is_sub = (row != base["row"])

        got = 0
        for i, c in enumerate(cols):
            fname = clean(fnames.get(c, ""))
            if not fname:
                continue
            fdesc = clean(descs_by_row.get(desc_row, {}).get(c, ""))
            if not fdesc:
                # fall back to the row just after, only if it holds no name
                alt = descs_by_row.get(desc_row + 1, {}).get(c, "")
                if alt:
                    fdesc = clean(alt)
            fields = {}
            if base_meta["生物种类"]:
                fields["生物种类"] = base_meta["生物种类"]
            if base_meta["体型"]:
                fields["体型"] = base_meta["体型"]
            if base_meta["速度"]:
                fields["速度"] = base_meta["速度"]
            fields["特性列表"] = [clean(x) for x in
                                  [names_by_row.get(feat_row, {}).get(cc, "")
                                   for cc in cols] if clean(x)]
            if is_sub:
                fields["亚种"] = name
                fields["基础种族"] = base["name"]

            tags = []
            if is_sub:
                tags.append("亚种:" + name)
                tags.append("基础种族:" + base["name"])
            else:
                tags.append("基础种族")
            for k in ("生物种类", "体型"):
                if base_meta[k]:
                    tags.append(k + ":" + base_meta[k])

            entry = {
                "id": pool.make("species", fname),
                "type": "species",
                "name": fname,
                "en": "",
                "category": name,
                "tags": tags,
                "summary": mk_summary(fdesc),
                "text": fdesc,
                "fields": fields,
                "source": "",
                "cardRef": {"sheet": sg.sheet, "row": row},
            }
            entries.append(entry)
            got += 1
        per_species[name] = got
        if got == 0:
            unparsed.append((row, name, "no feature cells in span %d-%d" % (mn, mx)))

    # de-duplicate identical (category, name, text)
    deduped = []
    seen = set()
    for e in entries:
        k = (e["category"], e["name"], e["text"])
        if k in seen:
            continue
        seen.add(k)
        deduped.append(e)

    report = {
        "species_rows": len(rows),
        "per_species": per_species,
        "unparsed": unparsed,
        "entries": deduped,
    }
    return deduped, report


# --------------------------------------------------------------------------
# 职业 (class features)
# --------------------------------------------------------------------------
CLASS_ANCHOR_ROW = 30
CLASS_FEATURE_START_ROW = 31
CLASS_FEATURE_END_ROW = 263
# class feature blocks occupy columns 2..55; column 86+ is a separate
# (subclass -> row) index table that must not be mistaken for class anchors.
CLASS_ANCHOR_COL_FIRST = 1
CLASS_ANCHOR_COL_LAST = 55


def read_subclass_matrix(cg):
    """Return (class -> [subclass names], class_index -> subclass names).

    Subclass names sit in columns 3..26.  Column 27 repeats the class name
    itself and column 29+ is the main-class filter dropdown, so both are
    excluded.  Rows 15/16 (奇械师, 灵能使) carry no name in column 2, so the
    class-index column (column 1) is used as the authoritative key.
    """
    by_class = {}
    by_index = {}
    for r in range(3, 27):
        idx = cg.intval(r, 1)
        cl = cg.text(r, 2)
        subs = []
        for c in range(3, 27):
            s = cg.text(r, c)
            if s:
                subs.append(s)
        if idx is not None:
            by_index[idx] = subs
        if cl:
            by_class[cl] = subs
    return by_class, by_index


def read_subclass_index(cg):
    """subclass name -> start row, from the (col86,col87) index."""
    out = {}
    for r in range(30, 264):
        nm = cg.text(r, 86)
        lo = cg.intval(r, 87)
        if nm and lo is not None:
            out[nm] = lo
    return out


def class_anchors(cg):
    out = []
    for c in range(CLASS_ANCHOR_COL_FIRST, CLASS_ANCHOR_COL_LAST + 1):
        v = cg.text(CLASS_ANCHOR_ROW, c)
        if v:
            out.append((c, v))
    return out


def split_class_block(rows):
    """rows: [(row, level|None, name, desc)] in sheet order.

    Returns (base_rows, [subclass_row_groups]).
    Base = ascending levels ending at the first level-20 row; the remainder is
    segmented whenever the level drops to <= 3 after a higher level.
    """
    cur = 0
    base_end = None
    for i, (r, lv, nm, ds) in enumerate(rows):
        if lv is not None and 1 <= lv <= 20 and lv >= cur:
            cur = lv
            if lv == 20:
                base_end = i
                break
    if base_end is None:
        return rows, []
    base = rows[: base_end + 1]
    rest = rows[base_end + 1:]
    groups = []
    group = []
    prev = None
    for row in rest:
        lv = row[1]
        if lv is not None and prev is not None and lv < prev and lv <= 3 and group:
            groups.append(group)
            group = []
        if lv is not None and 1 <= lv <= 20:
            prev = lv
        group.append(row)
    if group:
        groups.append(group)
    return base, groups


def extract_classes(cg):
    subs_by_class, subs_by_index = read_subclass_matrix(cg)
    pool = IdPool()
    entries = []
    per_class = {}
    warnings = []

    # class -> source: row 3..26 col1 = index, map index to source abbreviations
    source_by_index = {}
    for c in range(2, min(cg.cols, 30) + 1):
        s = cg.text(1, c)
        idx = cg.intval(2, c)
        if s and idx is not None:
            source_by_index[idx] = s

    for pos, (col, cls) in enumerate(class_anchors(cg), start=1):
        lc, nc, dc = col, col + 1, col + 2
        rows = []
        for r in range(CLASS_FEATURE_START_ROW, CLASS_FEATURE_END_ROW + 1):
            nm = cg.text(r, nc)
            if not nm:
                continue
            lv = cg.intval(r, lc)
            rows.append((r, lv, nm, cg.text(r, dc)))
        if not rows:
            warnings.append("class %s: no feature rows" % cls)
            continue

        # Class index: the class x source matrix (rows 3..26) lists classes in
        # exactly the same order as the row-30 anchors, so the anchor position
        # is the authoritative index.  Also confirm against column 2 when the
        # matrix actually names the class there.
        cls_idx = pos
        for r in range(3, 27):
            if cg.text(r, 2) == cls:
                named = cg.intval(r, 1)
                if named is not None and named != cls_idx:
                    warnings.append(
                        "class %s: anchor position %d disagrees with matrix "
                        "index %d; using matrix index" % (cls, cls_idx, named))
                    cls_idx = named
                break
        cls_source = source_by_index.get(cls_idx, "")

        base, groups = split_class_block(rows)
        subs = subs_by_class.get(cls)
        if subs is None and cls_idx is not None:
            subs = subs_by_index.get(cls_idx, [])
        subs = subs or []
        if len(groups) != len(subs):
            warnings.append(
                "class %s: %d subclass groups vs %d subclass names; "
                "subclass tagging best-effort" % (cls, len(groups), len(subs)))

        # ---- base class table ----
        # levels forward-filled; rows 31..36 (proficiency blocks) carry no level
        cur = 1
        for (r, lv, nm, ds) in base:
            if lv is not None and 1 <= lv <= 20:
                cur = lv
            fields = {"职业": cls, "等级": str(cur), "子职": ""}
            tags = ["职业:" + cls]
            if cls_source:
                tags.append("来源:" + cls_source)
            entry = {
                "id": pool.make("classFeature", nm),
                "type": "classFeature",
                "name": nm,
                "en": "",
                "category": "%s %d级" % (cls, cur),
                "tags": tags,
                "summary": mk_summary(ds),
                "text": ds,
                "fields": fields,
                "source": cls_source,
                "cardRef": {"sheet": cg.sheet, "row": r},
            }
            entries.append(entry)
        per_class.setdefault(cls, {"base": 0, "sub": 0})["base"] += len(base)

        # ---- subclass tables ----
        for gi, group in enumerate(groups):
            sub_name = subs[gi] if gi < len(subs) else ""
            cur = 3
            for (r, lv, nm, ds) in group:
                if lv is not None and 1 <= lv <= 20:
                    cur = lv
                fields = {"职业": cls, "等级": str(cur), "子职": sub_name}
                tags = ["职业:" + cls]
                if sub_name:
                    tags.append("子职:" + sub_name)
                if cls_source:
                    tags.append("来源:" + cls_source)
                entry = {
                    "id": pool.make("classFeature", nm),
                    "type": "classFeature",
                    "name": nm,
                    "en": "",
                    "category": "%s %d级" % (cls, cur),
                    "tags": tags,
                    "summary": mk_summary(ds),
                    "text": ds,
                    "fields": fields,
                    "source": cls_source,
                    "cardRef": {"sheet": cg.sheet, "row": r},
                }
                entries.append(entry)
                per_class.setdefault(cls, {"base": 0, "sub": 0})["sub"] += 1

    report = {
        "per_class": per_class,
        "warnings": warnings,
        "entries": entries,
    }
    return entries, report


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def write_json(path, entries):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(entries, fh, ensure_ascii=False, indent=1)
        fh.write("\n")


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(
        description="解析 D&D 5e 人物卡的「种族」/「职业」工作表为统一词条 JSON。")
    ap.add_argument("--species-out", default=SPECIES_OUT,
                    help="species.json output path")
    ap.add_argument("--class-out", default=CLASS_OUT,
                    help="class_features.json output path")
    ap.add_argument("--dry-run", action="store_true",
                    help="只打印报告，不写文件")
    ap.add_argument("--quiet", action="store_true", help="只打印汇总")
    args = ap.parse_args(argv)

    sg = Grid(SPECIES_GRID)
    cg = Grid(CLASS_GRID)

    species, srep = extract_species(sg)
    classes, crep = extract_classes(cg)

    if not args.dry_run:
        write_json(args.species_out, species)
        write_json(args.class_out, classes)

    # ------------------------------------------------------------------
    # report
    # ------------------------------------------------------------------
    print("=" * 72)
    print("species.json        entries: %-5d %s" % (
        len(species), "(not written)" if args.dry_run else "-> " + args.species_out))
    print("class_features.json entries: %-5d %s" % (
        len(classes), "(not written)" if args.dry_run else "-> " + args.class_out))
    print("=" * 72)

    base_species = [e for e in species if not any(t.startswith("亚种") for t in e["tags"])]
    sub_species = [e for e in species if any(t.startswith("亚种") for t in e["tags"])]
    print("\n[species] feature-name row = 2*B, description row = 2*B+1")
    print("          feature grid column = 11 + (C..D)")
    print("[species] base-race features : %d  (%d rows)"
          % (len(base_species), len({e["category"] for e in base_species})))
    print("[species] sub-race features  : %d  (%d rows)"
          % (len(sub_species), len({e["category"] for e in sub_species})))
    print("[species] TOTAL = %d" % len(species))

    if not args.quiet:
        print("\n[species] per-species entry counts:")
        for k, v in srep["per_species"].items():
            print("   %-16s %d" % (k, v))
    if srep["unparsed"]:
        print("\n[species] UNPARSED rows: %d" % len(srep["unparsed"]))
        for row, name, why in srep["unparsed"][:40]:
            print("   R%-4d %-16s %s" % (row, name, why))
    else:
        print("[species] no unparsed rows")

    print("\n[class] per-class counts (base / subclass / total):")
    tb = ts = 0
    for k, v in crep["per_class"].items():
        print("   %-8s base=%-4d sub=%-4d total=%d" % (k, v["base"], v["sub"],
                                                       v["base"] + v["sub"]))
        tb += v["base"]
        ts += v["sub"]
    print("   base total=%d  subclass total=%d  grand total=%d" % (tb, ts, tb + ts))
    print("[class] levels covered: %s"
          % sorted({int(e["fields"]["等级"]) for e in classes}))
    print("[class] distinct subclasses tagged: %d"
          % len({e["fields"]["子职"] for e in classes if e["fields"]["子职"]}))
    if crep["warnings"]:
        print("\n[class] warnings:")
        for w in crep["warnings"]:
            print("   " + w)

    # sanity checks
    print("\n[sanity] entries with empty text:")
    for tag, arr in (("species", species), ("classFeature", classes)):
        n = sum(1 for e in arr if not e["text"])
        print("   %-13s %d" % (tag, n))
    print("[sanity] empty category: %d" % sum(1 for e in species + classes
                                              if not e["category"]))
    print("[sanity] duplicate ids: %d" % (len(species) + len(classes)
                                          - len({e["id"] for e in species + classes})))
    return 0


if __name__ == "__main__":
    sys.exit(main())
