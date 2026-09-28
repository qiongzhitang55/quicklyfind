#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""起一个真的服务，验一遍「卡是空的 → 项目里就什么都没有」。

这条链路上任何一处漏了，用户看到的都是「新建一张卡，里面已经有东西」——
所以不查代码、直接打接口：

  · `/api/card` 读卡 → 0 个字段、0 个词条
  · `/api/table` 法术位 → 一段都没占
  · `/api/page` 职业 / 种族 / 专长 / 魔法物品 → `existing` 全空
  · `/api/form` 基本信息 / 起源 → 可填字段全空
  · `/api/form` 装备 / 魔法物品 → 格子认出来了（不是「认不出所以不写」）
  · 往「运动」的熟练格写一个 `O` → 落在 **主要!B40**（v1.1.1 版式），
    且紧邻的「敏捷」分组标题行不会被当成技能行写坏
  · `/api/card/reset` → 再读卡，又回到全空

写测试只动临时副本，原卡只读。

  python tools\\check_blank_state.py                 # 用版本号最高的那张空白卡
  python tools\\check_blank_state.py --card <卡.xlsx>
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

spec = importlib.util.spec_from_file_location("cp", r"D:\quicklyFind\tools\card_parse.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)

ROOT = Path(r"D:\quicklyFind")
CARD_DIR = ROOT / "card"
SERVER_DIR = ROOT / "dnd_quickref"


def dart_exe() -> str:
    """dart.bat 不能直接 CreateProcess，找到真正的 dart.exe。"""
    for c in [shutil.which("dart.exe"),
              r"C:\flutter\bin\cache\dart-sdk\bin\dart.exe",
              str(Path(shutil.which("dart") or "").parent / "cache" / "dart-sdk" / "bin" / "dart.exe")
              if shutil.which("dart") else ""]:
        if c and Path(c).exists():
            return str(c)
    raise SystemExit("找不到 dart.exe（装 Flutter/Dart SDK 后再跑）")


checks = 0
failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global checks, failures
    checks += 1
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if not detail else '  :: ' + detail}")


def newest_template(card_dir: Path) -> Path:
    best, best_key = None, -1
    for f in card_dir.iterdir():
        if not f.is_file() or f.suffix.lower() != ".xlsx" or not f.name.startswith("空白卡"):
            continue
        import re
        m = re.search(r"v(\d+)\.(\d+)(?:\.(\d+))?", f.name)
        key = 0 if not m else int(m.group(1)) * 10000 + int(m.group(2)) * 100 + int(m.group(3) or 0)
        if key > best_key:
            best, best_key = f, key
    if best is None:
        raise SystemExit("card\\ 里没有空白卡")
    return best


def get(port: int, path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def post(port: int, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", default="")
    ap.add_argument("--port", type=int, default=8791)
    args = ap.parse_args()

    card = Path(args.card) if args.card else newest_template(CARD_DIR)
    print(f"空白卡   {card}")
    print(f"（写测试只动副本，原卡只读）\n")

    tmp = Path(tempfile.mkdtemp(prefix="quickref-blank-"))
    work = tmp / card.name
    shutil.copy(card, work)
    log = open(tmp / "server.log", "w", encoding="utf-8")

    env = dict(os.environ)
    env["PUB_CACHE"] = str(ROOT / ".pub-cache")
    proc = subprocess.Popen(
        [dart_exe(), "run", "bin/quickref.dart", "--workspace", str(ROOT),
         "--card", str(work), "--no-open", "--port", str(args.port)],
        cwd=str(SERVER_DIR), stdout=log, stderr=subprocess.STDOUT, env=env,
    )
    try:
        meta = None
        for _ in range(120):
            if proc.poll() is not None:
                raise SystemExit(f"服务起不来，看日志：{tmp / 'server.log'}")
            try:
                meta = get(args.port, "/api/meta")
                break
            except (urllib.error.URLError, ConnectionError, OSError):
                time.sleep(0.5)
        if meta is None:
            raise SystemExit("等服务超时")

        # ---- 服务认的模板 / 目标表
        tpl = meta.get("template", {})
        check("服务挑的模板 = 版本号最高的那份空白卡",
              Path(tpl.get("path", "")).name == card.name and tpl.get("exists"),
              f"{Path(tpl.get('path', '')).name} exists={tpl.get('exists')}")
        check("目标表 = 这份空白卡", Path(meta.get("table", "")).name == card.name,
              meta.get("table", ""))

        # ---- 读卡：空卡读出来必须是空的
        c = get(args.port, "/api/card")
        check("读卡：0 个字段", c.get("fields") == [], f"{len(c.get('fields', []))} 个")
        check("读卡：0 个词条", c.get("entries") == [], f"{len(c.get('entries', []))} 个")

        # ---- 法术位
        t = get(args.port, "/api/table")
        check("法术位认出 4 段", len(t.get("blocks", [])) == 4,
              ",".join(b.get("range", "") for b in t.get("blocks", [])))
        check("法术位一个都没占", t.get("used") == 0 and t.get("filled") == [],
              f"used={t.get('used')} total={t.get('slotsTotal')}")

        # ---- 词条页
        for key, label in [("class", "职业特性"), ("species", "种族特性"),
                           ("feat", "专长"), ("magic", "魔法物品")]:
            page = get(args.port, f"/api/page?key={key}")
            check(f"{label}页：卡里没有现成词条", page.get("existing") == [],
                  f"{len(page.get('existing', []))} 条")

        # ---- 卡片自己：该空的格子必须真的空（不靠「跟模板一样就跳过」这种口径）
        shell = cp.read_workbook(str(work))
        must_be_empty = {
            "主要": ["E3", "E4", "E6", "E9", "T6", "T7", "T8", "T9",
                     "B32", "B33", "B34", "B35", "B36", "L40", "AL40",
                     "L42", "L43", "L44", "L45", "L46", "L47", "L48", "L49", "L50",
                     # 武器 / 护甲 / 盾的加值与盾牌 AC：数字格都清空
                     "L32", "L33", "L34", "L35", "L36", "U40", "AQ40"],
            "起源": ["E5", "E8", "E9", "K8", "K9", "B12", "S11", "S13", "S14", "S15", "S17",
                     "B24", "H24", "B25", "H25", "B26", "H26", "B27", "H27", "B28", "H28",
                     "B31", "H31", "B32", "H32"],
            "法术书": [f"{col}{r}" for col in ("X", "AC", "AH", "AM") for r in range(3, 53)],
        }
        leftovers = []
        for sheet, cells in must_be_empty.items():
            for cell in cells:
                import re as _re
                m = _re.match(r"([A-Z]+)(\d+)", cell)
                v = shell.get(sheet, {}).get((int(m.group(2)), cp.col_num(m.group(1))), "")
                if (v or "").strip():
                    leftovers.append(f"{sheet}!{cell}={v[:20]}")
        check("卡上该空的格子全空（身份 / 装备 / 奇物 / 法术位 / 起源词条）",
              not leftovers, f"{len(leftovers)} 处非空 {leftovers[:6]}")

        # 武器 / 护甲 / 盾 / 奇物（装备页 + 魔法物品页）里的下拉：X/O 与 是/否 都统一成 X
        want_x = ["F32", "F33", "F34", "F35", "F36", "W32", "W33", "W34", "W35", "W36",
                  "P40", "AP40", "AS40"] + [f"P{r}" for r in range(42, 51)]
        bad_x = []
        for cell in want_x:
            m = _re.match(r"([A-Z]+)(\d+)", cell)
            v = shell.get("主要", {}).get((int(m.group(2)), cp.col_num(m.group(1))), "")
            if (v or "").strip() != "X":
                bad_x.append(f"{cell}={v!r}")
        check("装备 / 魔法物品两页的下拉（同调 / 熟练 / 着装 / 奇物同调）全是 X",
              not bad_x, f"{len(bad_x)} 个不是 X {bad_x[:6]}")

        # ---- 表单页
        def form(key: str) -> dict:
            return get(args.port, f"/api/form?key={key}")

        for key, label in [("gear", "装备"), ("magic", "魔法物品")]:
            page = form(key)
            allf = [f for s in page.get("sections", []) for f in s.get("fields", [])]
            undetected = [f["cell"] for f in allf if not f.get("detected")]
            check(f"{label}页：格子全部认得出来（没有 ⚠）", not undetected,
                  f"{len(undetected)} 个认不出 {undetected[:6]}")
            secs = [s["title"] for s in page.get("sections", [])]
            if key == "gear":
                check("装备页：按卡分成 武器 / 护甲 / 盾牌 三张表",
                      secs == ["武器", "护甲", "盾牌"], "、".join(secs))
                cells = {f["cell"]: f["label"] for f in allf}
                check("装备页：着装（AS40）只出现在盾牌那一行",
                      [f["cell"] for f in allf if f["label"] == "着装"] == ["AS40"]
                      and cells.get("AS40") == "着装", f"{cells.get('AS40')}")
                check("装备页：护甲行有 AC / 敏捷加值 / 特性，且都是只读",
                      all(any(f["cell"] == c and f["kind"] == "readonly" for f in allf)
                          for c in ("AF40", "AI40", "V40")))
            else:
                check("魔法物品页：只有 奇物 / 消耗品 两块（不再抄武器·护甲·盾）",
                      secs == ["奇物", "消耗品"], "、".join(secs))
                dup = [f["cell"] for f in allf if f["cell"] in
                       ("B32", "F32", "L40", "P40", "U40", "AF40", "AL40", "AP40", "AQ40", "AS40")]
                check("魔法物品页：没有武器 / 护甲 / 盾 的格子", not dup, f"{dup}")
            if key == "magic":
                curio_names = [f for f in allf if f.get("label") == "奇物名"]
                check("魔法物品页：奇物格数与卡里一致（v1.1.1 是 9 格，不含「消耗品」表头）",
                      len(curio_names) == 9 and all(f["cell"] != "L51" for f in curio_names),
                      f"{len(curio_names)} 格 {[f['cell'] for f in curio_names]}")
                cons = [f for f in allf if f.get("label") == "名称"]
                check("魔法物品页：消耗品 5 行（L52:L56）", len(cons) == 5,
                      f"{len(cons)} 行 {[f['cell'] for f in cons]}")

        # 数字框里的 1（等级）/ 10（六项属性初始值）是卡自己的默认值，README 里就写着
        # 「模板预填的 10 算还没动」，不算内容；文本字段则必须真的空。
        for key, label in [("basic", "基本信息"), ("origin", "起源")]:
            page = form(key)
            allf = [f for s in page.get("sections", []) for f in s.get("fields", [])]
            bad = [(f["field"], f.get("value", "")) for f in allf
                   if f.get("kind") == "text"
                   and (f.get("value") or "").strip()]
            check(f"{label}页：文本字段全是空的", not bad, f"{len(bad)} 个非空 {bad[:4]}")

        attrs = form("attrs")
        allf = [f for s in attrs.get("sections", []) for f in s.get("fields", [])]
        skills = [f for f in allf if f.get("section") == "技能" and f.get("kind") == "label"]
        attr_rows = [f for f in allf if f.get("section") == "六项属性" and f.get("kind") == "label"]
        check("属性与技能页：认出六项属性", len(attr_rows) == 6, f"{len(attr_rows)} 项")
        check("属性与技能页：认出 18 项技能", len(skills) == 18, f"{len(skills)} 项")

        # ---- 写一格：必须落在 v1.1.1 的正确格子（运动 = 主要!B40）
        move = next((f for f in allf
                     if f.get("section") == "技能" and f.get("row") == "运动"
                     and f.get("kind") == "toggle"), None)
        check("找得到「运动」的熟练格", move is not None and move.get("cell") == "B40",
              (move or {}).get("cell", "没找到"))
        if move:
            res = post(args.port, "/api/form/fill", {"key": "attrs", "values": {move["field"]: "O"}})
            written = res.get("written", [])
            check("写入落在 主要!B40", len(written) == 1 and written[0].get("cell") == "B40",
                  json.dumps(written, ensure_ascii=False))
            g = cp.read_workbook(str(work))["主要"]
            check("回读 主要!B40 = O", g.get((40, 2)) == "O", repr(g.get((40, 2))))
            check("紧邻的「敏捷」分组标题没被当成技能行写坏",
                  g.get((41, 2)) == "敏捷", repr(g.get((41, 2))))
            check("「特技」那一行（B42）没被误写", g.get((42, 2)) == "X", repr(g.get((42, 2))))

            # ---- 初始化这张卡：清回空卡
            r = post(args.port, "/api/card/reset", {})
            check("初始化这张卡：成功", r.get("ok") is True, json.dumps(r, ensure_ascii=False)[:160])
            g2 = cp.read_workbook(str(work))["主要"]
            check("初始化后 主要!B40 回到 X", g2.get((40, 2)) == "X", repr(g2.get((40, 2))))
            c2 = get(args.port, "/api/card")
            check("初始化后再读卡：又是 0 字段 0 词条",
                  c2.get("fields") == [] and c2.get("entries") == [],
                  f"{len(c2.get('fields', []))} 字段 / {len(c2.get('entries', []))} 词条")

        print(f"\n{checks} 项检查，{failures} 项失败")
        return 0 if failures == 0 else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        print(f"日志: {tmp / 'server.log'}")


if __name__ == "__main__":
    raise SystemExit(main())
