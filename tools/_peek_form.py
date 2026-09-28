#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：起服务，把某个表单页的字段（格子 / 类型 / 当前值 / 选项）打出来。

    python tools\\_peek_form.py <card.xlsx> gear [magic basic ...]
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
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
spec = importlib.util.spec_from_file_location("cbs", r"D:\quicklyFind\tools\check_blank_state.py")
cbs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cbs)

ROOT = Path(r"D:\quicklyFind")
card = Path(sys.argv[1])
keys = sys.argv[2:] or ["gear"]
DART = cbs.dart_exe()
port = 8811

tmp = Path(tempfile.mkdtemp(prefix="quickref-form-"))
work = tmp / card.name
shutil.copy(card, work)
log = open(tmp / "server.log", "w", encoding="utf-8")
env = dict(os.environ)
env["PUB_CACHE"] = str(ROOT / ".pub-cache")
proc = subprocess.Popen([DART, "run", "bin/quickref.dart", "--workspace", str(ROOT),
                         "--card", str(work), "--no-open", "--port", str(port)],
                        cwd=str(ROOT / "dnd_quickref"), stdout=log, stderr=subprocess.STDOUT, env=env)
try:
    for _ in range(120):
        try:
            cbs.get(port, "/api/meta")
            break
        except Exception:
            time.sleep(0.5)
    for key in keys:
        page = cbs.get(port, f"/api/form?key={key}")
        print(f"\n===== {key} =====")
        for sec in page.get("sections", []):
            print(f"-- {sec['title']}")
            for f in sec.get("fields", []):
                print(f"   {f['cell']:<6} {f['kind']:<9} row={f.get('row',''):<8}"
                      f" label={f['label']:<6} value={f.get('value','')!r:<12}"
                      f" detected={f.get('detected')} options={f.get('options')}")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
