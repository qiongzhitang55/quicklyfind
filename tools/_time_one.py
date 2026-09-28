#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：打一条接口，量时间（默认本机 8765 上正在跑的那个）。"""
from __future__ import annotations

import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
port = sys.argv[1] if len(sys.argv) > 1 else "8765"
paths = sys.argv[2:] or ["/api/form?key=basic&refresh=1"]
for p in paths:
    t0 = time.time()
    try:
        r = urllib.request.urlopen(f"http://127.0.0.1:{port}{p}", timeout=120).read()
        print(f"{(time.time()-t0)*1000:8.0f} ms  {len(r)/1024:7.1f} KB  {p}")
    except Exception as e:
        print(f"    ERR  {p}: {e}")
