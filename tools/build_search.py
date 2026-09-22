#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build an offline full-text search index for the mirrored 5E 不全书.

Reads   : D:\\quicklyFind\\5echm\\mirror\\**\\*.htm(l)
Writes  : D:\\quicklyFind\\5echm\\search\\pages.js     (id -> path/title/breadcrumb)
          D:\\quicklyFind\\5echm\\search\\shard-XX.js  (id -> plain text)
          D:\\quicklyFind\\5echm\\search\\meta.js     (counts, shard list, build time)

The search UI itself lives at D:\\quicklyFind\\5echm\\搜索.html (hand written).

The index is emitted as classic <script> files on purpose: browsers block
fetch()/XHR and Workers on file:// URLs, but <script src="..."> still works,
so the app stays fully usable offline by double-clicking the html file.
"""
from __future__ import annotations

import html
import io
import json
import os
import re
import sys
import time
import urllib.parse
from html.parser import HTMLParser

ROOT = r"D:\quicklyFind\5echm"
MIRROR = os.path.join(ROOT, "mirror")
OUT = os.path.join(ROOT, "search")
TOC_HTML = os.path.join(MIRROR, "webhelpcontents.htm")
SHARD_CHARS = 350_000

SKIP_TAGS = {"script", "style", "head", "title", "noscript", "iframe", "svg"}
BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "tr", "table", "thead", "tbody",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "section", "article", "blockquote",
    "td", "th", "dt", "dd", "pre", "figure", "figcaption", "center", "font",
}


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.title: str | None = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip += 1
            if tag == "title":
                self._in_title = True
            return
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            if tag == "title":
                self._in_title = False
            self.skip = max(0, self.skip - 1)
            return
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title = (self.title or "") + data
            return
        if self.skip:
            return
        self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        raw = raw.replace("\u00a0", " ").replace("\u3000", " ")
        raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
        raw = re.sub(r" *\n *", "\n", raw)
        raw = re.sub(r"\n{2,}", "\n", raw)
        return raw.strip()


def decode(data: bytes) -> str:
    for enc in ("utf-8", "gb18030"):
        try:
            txt = data.decode(enc)
        except UnicodeDecodeError:
            continue
        if txt.count("\ufffd") <= len(txt) // 1000:
            return txt
    return data.decode("utf-8", "replace")


# ---------------------------------------------------------------- TOC mapping
class TocParser(HTMLParser):
    """Rebuild the navigation tree to get breadcrumbs for every topic."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.rows: list[tuple[int, str, str]] = []
        self._cur: dict | None = None
        self._stack: list[dict] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "div":
            cls = a.get("class", "")
            node = {"depth": self.depth, "href": "", "text": "", "cap": False}
            if "nav-node" in cls:
                self._stack.append(node)
                self._cur = node
                self.depth += 1
                return
            self._stack.append(None)
            if self._cur is not None:
                self._cur["cap"] = True
            return
        if tag == "a" and self._cur is not None and not self._cur["href"]:
            self._cur["href"] = a.get("href", "")
        if tag == "span" and self._cur is not None and a.get("id", "").startswith("l"):
            self._cur["cap"] = True

    def handle_data(self, data):
        if self._cur is not None and self._cur.get("cap") and not self._cur["text"] and data.strip():
            self._cur["text"] += data.strip()

    def handle_endtag(self, tag):
        if tag != "div" or not self._stack:
            return
        node = self._stack.pop()
        if node is not None:
            self.depth -= 1
            self.rows.append((node["depth"], node["text"], node["href"]))
            if not self._stack:
                self._cur = None
            else:
                parent = None
                for n in reversed(self._stack):
                    if n is not None:
                        parent = n
                        break
                self._cur = parent


def build_breadcrumbs() -> dict[str, dict]:
    """decoded path -> {'crumbs': [...], 'group': str, 'toc_title': str}"""
    if not os.path.exists(TOC_HTML):
        return {}
    p = TocParser()
    with open(TOC_HTML, "rb") as fh:
        p.feed(decode(fh.read()))
    rows = list(reversed(p.rows))
    stack: list[tuple[int, str]] = []
    out: dict[str, dict] = {}
    for depth, text, href in rows:
        while stack and stack[-1][0] >= depth:
            stack.pop()
        stack.append((depth, text))
        if not href or href == "#" or "://" in href:
            continue
        clean = href.split("#")[0].replace("\\", "/")
        if not clean.lower().endswith((".htm", ".html")):
            continue
        try:
            path = urllib.parse.unquote(clean)
        except Exception:  # noqa: BLE001
            continue
        if path in out:
            continue
        crumbs = [t for _, t in stack if t]
        out[path] = {"crumbs": crumbs, "group": crumbs[0] if crumbs else "", "toc_title": text}
    return out


# ---------------------------------------------------------------- main walk
def collect_pages(bread: dict[str, dict]) -> list[dict]:
    pages: list[dict] = []
    for dirpath, _dirs, files in os.walk(MIRROR):
        for fn in files:
            if not fn.lower().endswith((".htm", ".html")):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, MIRROR).replace("\\", "/")
            if rel.lower() in ("webhelpcontents.htm", "webhelpindex.htm", "webhelpbookmark.htm", "webhelpsearch.htm"):
                continue
            pages.append({"path": rel, "full": full})
    pages.sort(key=lambda p: p["path"])
    return pages


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    bread = build_breadcrumbs()
    print(f"breadcrumbs: {len(bread)}")

    pages = collect_pages(bread)
    print(f"pages found: {len(pages)}")

    records: list[dict] = []
    shards: list[list[list]] = [[]]
    shard_chars = 0
    total_chars = 0
    for i, page in enumerate(pages):
        try:
            raw = open(page["full"], "rb").read()
        except OSError as exc:
            print("skip", page["path"], exc)
            continue
        ex = TextExtractor()
        try:
            ex.feed(decode(raw))
        except Exception as exc:  # noqa: BLE001
            print("parse fail", page["path"], repr(exc)[:80])
        title = (ex.title or "").strip() or os.path.splitext(os.path.basename(page["path"]))[0]
        text = ex.text()
        meta = bread.get(page["path"], {})
        parts = page["path"].split("/")
        if len(parts) >= 3:
            fallback_group = parts[1]
        elif len(parts) == 2 and parts[0] == "topics":
            fallback_group = "顶层"
        else:
            fallback_group = parts[0]
        rec = {
            "i": len(records),
            "p": page["path"],
            "t": title,
            "g": meta.get("group") or fallback_group,
            "c": " / ".join(meta.get("crumbs", [])[:-1]) or os.path.dirname(page["path"]),
        }
        records.append(rec)
        if shard_chars + len(text) > SHARD_CHARS and shards[-1]:
            shards.append([])
            shard_chars = 0
        shards[-1].append([rec["i"], text])
        shard_chars += len(text)
        total_chars += len(text)
        if (i + 1) % 500 == 0:
            print(f"  extracted {i+1}/{len(pages)} pages, {total_chars/1048576:.1f} M chars")

    def write_js(name: str, payload: str) -> None:
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
            fh.write(payload)

    write_js("pages.js", "window.__PAGES=" + json.dumps(records, ensure_ascii=False, separators=(",", ":")) + ";")
    for n, shard in enumerate(shards):
        payload = "window.__SHARDS=window.__SHARDS||{};window.__SHARDS[%d]=%s;" % (
            n,
            json.dumps(shard, ensure_ascii=False, separators=(",", ":")),
        )
        write_js(f"shard-{n:02d}.js", payload)
    write_js(
        "meta.js",
        "window.__META=" + json.dumps(
            {
                "pages": len(records),
                "shards": len(shards),
                "chars": total_chars,
                "built": time.strftime("%Y-%m-%d %H:%M:%S"),
                "source": "https://5echm.kagangtuya.top/",
            },
            ensure_ascii=False,
        ) + ";",
    )
    print(f"records={len(records)} shards={len(shards)} chars={total_chars} in {time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
