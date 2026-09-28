#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：跑一只 quickref.exe，看看它挑的模板 / 目标表。"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

exe = sys.argv[1]
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8795
ws = sys.argv[3] if len(sys.argv) > 3 else r"D:\quicklyFind"
proc = subprocess.Popen([exe, "--workspace", ws, "--no-open", "--port", str(port)],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meta", timeout=10) as r:
                meta = json.loads(r.read().decode("utf-8"))
            print("template =", meta["template"])
            print("table    =", meta["table"])
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/table", timeout=20) as r2:
                t = json.loads(r2.read().decode("utf-8"))
            print("card dict =", t.get("dictionaryCount"), " slots =", t.get("slotsTotal"),
                  " blocks =", [b.get("range") for b in t.get("blocks", [])])
            break
        except Exception:
            time.sleep(0.5)
    else:
        print("服务没起来")
finally:
    proc.terminate()
