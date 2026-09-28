#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：量一下各个接口的响应时间（起本机服务）。

    python tools\\_timing.py [card.xlsx]
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
card = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "card" / "悲灵.xlsx"
port = 8813
tmp = Path(tempfile.mkdtemp(prefix="quickref-time-"))
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
    paths = ["/api/meta", "/api/table", "/api/page?key=class", "/api/page?key=species",
             "/api/page?key=feat", "/api/page?key=magic", "/api/form?key=basic",
             "/api/form?key=attrs", "/api/form?key=origin", "/api/form?key=gear",
             "/api/form?key=magic", "/api/card"]
    for p in paths:
        t0 = time.time()
        r = urllib.request.urlopen(f"http://127.0.0.1:{port}{p}", timeout=180).read()
        dt = time.time() - t0
        print(f"{dt*1000:8.0f} ms  {len(r)/1024:7.1f} KB  {p}")
    print()
    print("再来一轮（缓存命中后）")
    for p in paths:
        t0 = time.time()
        r = urllib.request.urlopen(f"http://127.0.0.1:{port}{p}", timeout=180).read()
        print(f"{(time.time()-t0)*1000:8.0f} ms  {len(r)/1024:7.1f} KB  {p}")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
