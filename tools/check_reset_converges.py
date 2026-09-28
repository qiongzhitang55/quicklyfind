#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验「初始化这张卡」会把武器 / 护甲 / 盾 / 奇物那几块收敛成基准状态。

拿一张**作者原始卡**（熟练 `O`、着装 `否`、盾牌 AC `2`）当目标，点一次「初始化」，
再回读格子：下拉应该全变 `X`、数字格应该空、`/api/card` 应该读不出东西来。

  python tools\\check_reset_converges.py [卡.xlsx]
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
spec = importlib.util.spec_from_file_location("cbs", r"D:\quicklyFind\tools\check_blank_state.py")
cbs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cbs)
spec2 = importlib.util.spec_from_file_location("cp", r"D:\quicklyFind\tools\card_parse.py")
cp = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(cp)

ROOT = Path(r"D:\quicklyFind")
DEFAULT = ROOT / "card" / "DND5.5E人物卡_悲灵v1.1.1_5(2024).xlsx"
card = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
port = 8812

checks = failures = 0


def check(name, ok, detail=""):
    global checks, failures
    checks += 1
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if not detail else '  :: ' + detail}")


tmp = Path(tempfile.mkdtemp(prefix="quickref-reset-"))
work = tmp / card.name
shutil.copy(card, work)
log = open(tmp / "server.log", "w", encoding="utf-8")
env = dict(os.environ)
env["PUB_CACHE"] = str(ROOT / ".pub-cache")
proc = subprocess.Popen([cbs.dart_exe(), "run", "bin/quickref.dart", "--workspace", str(ROOT),
                         "--card", str(work), "--no-open", "--port", str(port)],
                        cwd=str(ROOT / "dnd_quickref"), stdout=log, stderr=subprocess.STDOUT, env=env)
try:
    for _ in range(120):
        try:
            cbs.get(port, "/api/meta")
            break
        except Exception:
            time.sleep(0.5)
    print(f"目标卡   {card}")
    before = cp.read_workbook(str(work))["主要"]
    print(f"初始化前 主要!W32={before.get((32, 23))!r} AS40={before.get((40, 45))!r} "
          f"AQ40={before.get((40, 43))!r} F32={before.get((32, 6))!r}")
    r = cbs.post(port, "/api/card/reset", {})
    check("初始化返回 ok", r.get("ok") is True, json.dumps(r, ensure_ascii=False)[:120])
    g = cp.read_workbook(str(work))["主要"]
    want_x = ["F32", "F33", "F34", "F35", "F36", "W32", "W33", "W34", "W35", "W36",
              "P40", "AP40", "AS40"] + [f"P{r}" for r in range(42, 50)]
    bad = []
    import re
    for cell in want_x:
        m = re.match(r"([A-Z]+)(\d+)", cell)
        v = (g.get((int(m.group(2)), cp.col_num(m.group(1)))) or "").strip()
        if v != "X":
            bad.append(f"{cell}={v!r}")
    check("初始化后：同调 / 熟练 / 着装 / 奇物同调 全是 X", not bad, f"{bad[:6]}")
    def cellv(name: str):
        m = re.match(r"([A-Z]+)(\d+)", name)
        return g.get((int(m.group(2)), cp.col_num(m.group(1))))
    empty = {c: cellv(c) for c in ("L32", "L35", "U40", "AQ40")}
    check("初始化后：加值 / 盾牌 AC 是空的",
          all(not (v or "").strip() for v in empty.values()), f"{empty}")
    c = cbs.get(port, "/api/card")
    check("初始化后再读卡：0 字段 0 词条",
          c.get("fields") == [] and c.get("entries") == [],
          f"{len(c.get('fields', []))} 字段 / {len(c.get('entries', []))} 词条")
    form = cbs.get(port, "/api/form?key=gear")
    vals = {f["cell"]: f.get("value", "")
            for s in form.get("sections", []) for f in s.get("fields", [])
            if f.get("kind") in ("toggle", "number")}
    left = {k: v for k, v in vals.items() if k in ("W32", "W36", "AS40", "AQ40", "U40")}
    check("装备页显示的这几个格子也收敛了", left.get("W32") == "X" and left.get("AS40") == "X"
          and left.get("AQ40") == "" and left.get("U40") == "", f"{left}")
    print(f"\n{checks} 项检查，{failures} 项失败")
    sys.exit(0 if failures == 0 else 1)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
    print(f"日志: {tmp / 'server.log'}")
