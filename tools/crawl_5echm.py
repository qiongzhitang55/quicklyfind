#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mirror the whole "5E 不全书" site (https://5echm.kagangtuya.top/) into the workspace.

Features
- resumable: files already on disk are reused (and still parsed for links)
- polite: N worker threads, retries with backoff, identity encoding
- records a manifest (jsonl) + report (json) under <out>/_crawl/

Usage:
  python crawl_5echm.py --max-pages 40          # smoke test
  python crawl_5echm.py                          # full mirror
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = "https://5echm.kagangtuya.top/"
HOST = urllib.parse.urlsplit(ROOT).netloc
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 5echm-offline-mirror/1.0"

KEEP_EXT = {
    ".htm", ".html", ".css", ".js", ".json", ".xml", ".txt", ".map",
    ".gif", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp", ".bmp", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".pdf", ".zip",
}

TEXT_EXT = {".htm", ".html", ".css", ".js", ".json", ".xml", ".txt", ".svg"}

LINK_RE = re.compile(r"""(?:href|src|data-src|poster)\s*=\s*["']([^"']+)["']""", re.I)
CSS_URL_RE = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""", re.I)
QUOTED_RE = re.compile(
    r"""["']([^"'\s<>()\\]+\.(?:htm|html|css|js|json|gif|png|jpe?g|svg|ico|woff2?|ttf|otf|eot|webp|mp3|mp4|pdf))(?:\?[^"']*)?["']""",
    re.I,
)
BAD_CHARS = set('<>:"/\\|?*')

_print_lock = threading.Lock()
_file_lock = threading.Lock()


def log(msg: str, log_path: str | None = None) -> None:
    line = time.strftime("%H:%M:%S ") + msg
    with _print_lock:
        try:
            print(line, flush=True)
        except UnicodeEncodeError:
            sys.stdout.buffer.write((line + "\n").encode("utf-8", "replace"))
            sys.stdout.flush()
        if log_path:
            with _file_lock:
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")


def win_long(path: str) -> str:
    """Return a Windows extended-length path when the path may exceed MAX_PATH."""
    if os.name == "nt" and len(path) >= 240:
        p = os.path.abspath(path)
        if not p.startswith("\\\\?\\"):
            return "\\\\?\\" + p
    return path


def safe_component(name: str) -> str:
    out = "".join("_" if (c in BAD_CHARS or ord(c) < 32) else c for c in name)
    out = out.rstrip(" .")
    return out or "_"


def canon(url: str, base: str | None = None) -> str | None:
    """Return a canonical same-host https URL (no query/fragment), or None."""
    url = url.strip()
    if not url or url.startswith(("#", "mailto:", "javascript:", "data:", "tel:")):
        return None
    # WinCHM writes internal links with backslashes (href="速查\法术速查\x.html");
    # browsers resolve those as path separators, so mirror that behaviour.
    url = url.replace("\\", "/")
    if base:
        url = urllib.parse.urljoin(base, url)
    sp = urllib.parse.urlsplit(url)
    if sp.scheme not in ("http", "https") or sp.netloc != HOST:
        return None
    path = urllib.parse.unquote(sp.path or "/")
    quoted = urllib.parse.quote(path, safe="/@:+,;=!*'()~$&")
    return "https://" + HOST + quoted


def url_to_local(mirror: str, url: str) -> str:
    path = urllib.parse.urlsplit(url).path
    decoded = urllib.parse.unquote(path)
    parts = [p for p in decoded.split("/") if p not in ("", ".")]
    if not parts or decoded.endswith("/"):
        parts.append("index.html")
    parts = [safe_component(p) for p in parts]
    return os.path.join(mirror, *parts)


class Mirror:
    def __init__(self, args):
        self.args = args
        self.mirror = os.path.join(args.out, "mirror")
        self.state = os.path.join(args.out, "_crawl")
        os.makedirs(win_long(self.mirror), exist_ok=True)
        os.makedirs(win_long(self.state), exist_ok=True)
        self.log_path = os.path.join(self.state, "crawl.log")
        self.manifest_path = os.path.join(self.state, "manifest.jsonl")
        self.failed_path = os.path.join(self.state, "failed.jsonl")
        self.lock = threading.Lock()
        self.cond = threading.Condition()
        self.queue: collections.deque[str] = collections.deque()
        self.seen: set[str] = set()
        self.inflight = 0
        self.stats = collections.Counter()
        self.bytes_total = 0
        self.t0 = time.time()
        self.started = 0

    # ---------- queue ----------
    def add(self, url: str | None) -> bool:
        if not url:
            return False
        ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()
        if ext and ext not in KEEP_EXT:
            return False
        with self.cond:
            if url in self.seen:
                return False
            self.seen.add(url)
            self.queue.append(url)
            self.cond.notify()
            return True

    # ---------- fetching ----------
    def fetch(self, url: str) -> tuple[int, bytes, str]:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": UA, "Accept-Encoding": "identity", "Referer": ROOT},
        )
        last = None
        for attempt in range(self.args.retries):
            try:
                with urllib.request.urlopen(req, timeout=self.args.timeout) as resp:
                    return resp.status, resp.read(), resp.headers.get("Content-Type", "")
            except urllib.error.HTTPError as exc:
                last = exc
                if exc.code in (404, 403, 410):
                    return exc.code, b"", ""
            except Exception as exc:  # noqa: BLE001
                last = exc
            time.sleep(0.6 * (attempt + 1))
        code = getattr(last, "code", 0)
        return code, b"", ""

    # ---------- discovery ----------
    def discover(self, url: str, data: bytes, ext: str) -> int:
        try:
            text = data.decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return 0
        found = 0
        refs = LINK_RE.findall(text)
        if ext == ".css":
            refs += CSS_URL_RE.findall(text)
        if ext in (".js", ".json"):
            refs += QUOTED_RE.findall(text)
        elif ext in (".css", ".htm", ".html"):
            refs += QUOTED_RE.findall(text) if ext == ".css" else []
        for ref in refs:
            if self.add(canon(ref, url)):
                found += 1
        return found

    def store(self, url: str, path: str, data: bytes) -> None:
        target = win_long(path)
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        tmp = target + ".part"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, target)

    def record(self, rec: dict, failed: bool = False) -> None:
        with self.lock:
            self.bytes_total += rec.get("size", 0)
            with open(self.failed_path if failed else self.manifest_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # ---------- worker body ----------
    def process(self, url: str) -> None:
        path = url_to_local(self.mirror, url)
        ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()

        if os.path.exists(win_long(path)) and not self.args.force:
            with open(win_long(path), "rb") as fh:
                data = fh.read()
            status, ctype = 200, ""
        else:
            status, data, ctype = self.fetch(url)
            if status == 200 and data:
                self.store(url, path, data)
            elif status != 200:
                self.record({"url": url, "status": status, "path": path}, failed=True)
                self.stats[f"err{status}"] += 1
                return

        size = len(data)
        self.record({"url": url, "status": status, "size": size, "path": os.path.relpath(path, self.mirror).replace("\\", "/"), "type": ctype})
        self.stats["ok"] += 1
        if ext in TEXT_EXT and data:
            self.discover(url, data, ext)

        with self.lock:
            self.started += 1
            n = self.started
        if n % 100 == 0 or n <= 20:
            el = time.time() - self.t0
            log(
                f"[{n:>6}] ok={self.stats['ok']} err={sum(v for k, v in self.stats.items() if k.startswith('err'))} "
                f"queued={self.queued()} {self.bytes_total/1048576:.1f}MB {n/max(el,1e-9):.1f}/s :: "
                + urllib.parse.unquote(url[len(ROOT):])[:90],
                self.log_path,
            )

    def queued(self) -> int:
        with self.cond:
            return len(self.queue) + self.inflight

    def worker(self) -> None:
        while True:
            with self.cond:
                while not self.queue and self.inflight > 0:
                    self.cond.wait(timeout=1.0)
                if not self.queue and self.inflight == 0:
                    return
                url = self.queue.popleft()
                self.inflight += 1
            try:
                self.process(url)
            except Exception as exc:  # noqa: BLE001
                self.stats["crash"] += 1
                self.record({"url": url, "status": 0, "error": repr(exc)}, failed=True)
            finally:
                with self.cond:
                    self.inflight -= 1
                    self.cond.notify_all()

    # ---------- seeds ----------
    def seed(self) -> None:
        seeds = [
            "", "index.htm", "indexh.htm", "webhelpcontents.htm", "webhelpindex.htm",
            "webhelpbookmark.htm", "webhelpsearch.htm", "favicon.ico",
            "assets/webhelp-prepaint.js", "assets/webhelp-shell.css", "assets/webhelp-shell.js",
            "assets/webhelp-nav.css", "assets/webhelp-contents.js",
        ]
        for s in seeds:
            self.add(canon(ROOT + s))
        toc = self.args.toc
        if toc and os.path.exists(toc):
            with open(toc, encoding="utf-8") as fh:
                rows = json.load(fh)
            n = 0
            for row in rows:
                href = row.get("href", "")
                if href and href != "#" and self.add(canon(href, ROOT)):
                    n += 1
            log(f"seeded {n} topic links from {os.path.basename(toc)}", self.log_path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"D:\quicklyFind\5echm")
    ap.add_argument("--toc", default=r"D:\quicklyFind\5echm\_crawl\toc.json")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--timeout", type=float, default=45)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    m = Mirror(args)
    m.seed()
    log(f"queue start: {m.queued()} urls, workers={args.workers}, out={args.out}", m.log_path)

    if args.max_pages:
        # smoke test: process a bounded number of urls sequentially
        for _ in range(args.max_pages):
            with m.cond:
                if not m.queue:
                    break
                url = m.queue.popleft()
            m.process(url)
    else:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for _ in range(args.workers):
                pool.submit(m.worker)
        pool.shutdown(wait=True)  # noqa: F841  (executor context already waited)

    elapsed = time.time() - m.t0
    report = {
        "out": args.out,
        "urls_seen": len(m.seen),
        "processed": m.started,
        "ok": m.stats["ok"],
        "errors": {k: v for k, v in m.stats.items() if k.startswith("err") or k == "crash"},
        "bytes": m.bytes_total,
        "seconds": round(elapsed, 1),
        "finished": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with open(os.path.join(m.state, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    log(f"done: {report}", m.log_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
