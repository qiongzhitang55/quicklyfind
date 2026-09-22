#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extract all rule text from the mirrored 5E 不全书 into plain text.

Output (default D:\\quicklyFind\\rules-text):

  pages\\**.txt     one UTF-8 text file per source page, original folder layout kept
  corpus.jsonl      one JSON object per page: metadata + headings + body text
  manifest.tsv      path / title / group / headings / chars / kind
  README.txt        format notes and statistics

Skipped: the webhelp shell pages and the auto-generated WinCHM directory stubs
(__generated__/topic-*.htm), which carry no rule text.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import time
import urllib.parse
from html.parser import HTMLParser

DEFAULT_SRC = r"D:\quicklyFind\5echm\mirror"
DEFAULT_OUT = r"D:\quicklyFind\rules-text"
SITE = "https://5echm.kagangtuya.top/"

SKIP_TAGS = {"script", "style", "head", "title", "noscript", "iframe", "svg"}
BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "tr", "table", "thead", "tbody",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "section", "article", "blockquote",
    "td", "th", "dt", "dd", "pre", "figure", "figcaption", "center", "font",
}
HEADING_TAGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
SHELL_PAGES = {"webhelpcontents.htm", "webhelpindex.htm", "webhelpbookmark.htm", "webhelpsearch.htm"}


def win_long(path: str) -> str:
    if os.name == "nt" and len(path) >= 240:
        p = os.path.abspath(path)
        if not p.startswith("\\\\?\\"):
            return "\\\\?\\" + p
    return path


def decode(data: bytes) -> str:
    for enc in ("utf-8", "gb18030"):
        try:
            txt = data.decode(enc)
        except UnicodeDecodeError:
            continue
        if txt.count("\ufffd") <= len(txt) // 1000:
            return txt
    return data.decode("utf-8", "replace")


class DocParser(HTMLParser):
    """Pull out <title>, every <h1>-<h6> (with its id) and the body text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.title: str | None = None
        self._in_title = False
        self.headings: list[dict] = []
        self._hstack: list[dict] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in SKIP_TAGS:
            self.skip += 1
            if tag == "title":
                self._in_title = True
            return
        if tag in HEADING_TAGS:
            node = {"level": HEADING_TAGS[tag], "text": "", "id": a.get("id", "") or a.get("name", "")}
            self._hstack.append(node)
            self.parts.append("\n")
            return
        if tag == "a" and a.get("name") and not self._hstack:
            pass
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            if tag == "title":
                self._in_title = False
            self.skip = max(0, self.skip - 1)
            return
        if tag in HEADING_TAGS and self._hstack:
            node = self._hstack.pop()
            node["text"] = re.sub(r"\s+", " ", node["text"]).strip()
            if node["text"]:
                self.headings.append(node)
            self.parts.append("\n")
            return
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title = (self.title or "") + data
            return
        if self.skip:
            return
        if self._hstack:
            self._hstack[-1]["text"] += data
        self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        raw = raw.replace("\u00a0", " ").replace("\u3000", " ")
        raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
        raw = re.sub(r" *\n *", "\n", raw)
        raw = re.sub(r"\n{2,}", "\n", raw)
        return raw.strip()


def load_toc_breadcrumbs(src: str) -> dict[str, list[str]]:
    """decoded page path -> list of TOC ancestor titles (from webhelpcontents.htm)."""
    toc = os.path.join(src, "webhelpcontents.htm")
    if not os.path.exists(toc):
        return {}

    class Toc(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.depth = 0
            self.stack: list = []
            self.cur = None
            self.rows = []

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if tag == "div":
                if "nav-node" in a.get("class", ""):
                    node = {"href": "", "text": "", "cap": False, "depth": self.depth}
                    self.stack.append(node)
                    self.cur = node
                    self.depth += 1
                else:
                    self.stack.append(None)
                return
            if tag == "a" and self.cur is not None:
                href = a.get("href", "")
                if href and (not self.cur["href"] or self.cur["href"] == "#"):
                    self.cur["href"] = href
            if tag == "span" and self.cur is not None and a.get("id", "").startswith("l"):
                self.cur["cap"] = True

        def handle_data(self, data):
            if self.cur is not None and self.cur["cap"] and not self.cur["text"] and data.strip():
                self.cur["text"] += data.strip()

        def handle_endtag(self, tag):
            if tag != "div" or not self.stack:
                return
            node = self.stack.pop()
            if node is None:
                return
            self.depth -= 1
            self.rows.append(node)
            self.cur = None
            for n in reversed(self.stack):
                if n is not None:
                    self.cur = n
                    break

    p = Toc()
    with open(toc, "rb") as fh:
        p.feed(decode(fh.read()))
    rows = list(reversed(p.rows))
    crumbs: dict[str, list[str]] = {}
    stack: list[tuple[int, str]] = []
    for node in rows:
        while stack and stack[-1][0] >= node["depth"]:
            stack.pop()
        stack.append((node["depth"], node["text"]))
        href = node["href"]
        if not href or href == "#" or "://" in href:
            continue
        clean = href.split("#")[0].replace("\\", "/")
        if not clean.lower().endswith((".htm", ".html")):
            continue
        path = urllib.parse.unquote(clean)
        if path not in crumbs:
            crumbs[path] = [t for _, t in stack if t]
    return crumbs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    t0 = time.time()
    pages_dir = os.path.join(args.out, "pages")
    os.makedirs(win_long(pages_dir), exist_ok=True)
    crumbs_map = load_toc_breadcrumbs(args.src)
    print(f"toc breadcrumbs: {len(crumbs_map)}")

    targets: list[tuple[str, str]] = []
    for dirpath, _d, fns in os.walk(args.src):
        for fn in fns:
            if not fn.lower().endswith((".htm", ".html")):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), args.src).replace("\\", "/")
            if rel in SHELL_PAGES:
                continue
            targets.append((rel, os.path.join(dirpath, fn)))
    targets.sort()

    corpus = open(win_long(os.path.join(args.out, "corpus.jsonl")), "w", encoding="utf-8")
    manifest = open(win_long(os.path.join(args.out, "manifest.tsv")), "w", encoding="utf-8")
    manifest.write("path\ttitle\tgroup\tkind\theadings\tchars\n")

    n_text = n_nav = n_empty = 0
    total_chars = 0
    total_headings = 0
    heading_ids = 0
    for i, (rel, full) in enumerate(targets, 1):
        kind = "nav" if rel.startswith("__generated__/") else ("rules" if rel.startswith("topics/") else "meta")
        with open(full, "rb") as fh:
            raw = fh.read()
        dp = DocParser()
        try:
            dp.feed(decode(raw))
        except Exception as exc:  # noqa: BLE001
            print("parse issue", rel, repr(exc)[:70])
        title = (dp.title or "").strip() or os.path.splitext(os.path.basename(rel))[0]
        text = dp.text()
        crumbs = crumbs_map.get(rel, [])
        group = crumbs[0] if crumbs else (rel.split("/")[1] if rel.count("/") >= 2 else "—")
        rec = {
            "path": rel,
            "title": title,
            "group": group,
            "crumbs": crumbs,
            "kind": kind,
            "headings": dp.headings,
            "text": text,
        }
        corpus.write(json.dumps(rec, ensure_ascii=False) + "\n")
        manifest.write(f"{rel}\t{title}\t{group}\t{kind}\t{len(dp.headings)}\t{len(text)}\n")

        if kind == "nav":
            n_nav += 1
        elif not text:
            n_empty += 1
        else:
            n_text += 1
            total_chars += len(text)
            total_headings += len(dp.headings)
            heading_ids += sum(1 for h in dp.headings if h["id"])
            out_path = os.path.join(pages_dir, os.path.splitext(rel)[0] + ".txt")
            os.makedirs(win_long(os.path.dirname(out_path)), exist_ok=True)
            header = (
                f"【标题】{title}\n"
                f"【章节】{' / '.join(crumbs) if crumbs else '—'}\n"
                f"【来源】{rel}\n"
                f"【原站】{SITE}{urllib.parse.quote(rel)}\n"
                + "=" * 60 + "\n"
            )
            with open(win_long(out_path), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(header + text + "\n")

        if i % 1000 == 0:
            print(f"  {i}/{len(targets)} pages, {total_chars/1048576:.1f} M chars of rule text")
    corpus.close()
    manifest.close()

    stats = (
        f"5E 不全书 规则文本库\n"
        f"生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"来源站点：{SITE}\n"
        f"镜像页面：{len(targets)}\n"
        f"  规则正文页：{n_text}\n"
        f"  目录占位页（已跳过，未写入 pages/）：{n_nav}\n"
        f"  空页：{n_empty}\n"
        f"正文总字数：{total_chars:,}\n"
        f"标题（h1-h6）总数：{total_headings:,}，其中带 id 可深链：{heading_ids:,}\n\n"
        f"目录结构：\n"
        f"  pages/**.txt   每页一个 UTF-8 纯文本文件，保留原站目录层级\n"
        f"                 文件头三行为【标题】【章节】【来源】，其后为正文\n"
        f"  corpus.jsonl   每行一个 JSON：path/title/group/crumbs/kind/headings/text\n"
        f"  manifest.tsv   清单：path/title/group/kind/headings/chars\n\n"
        f"kind 取值：rules=topics/ 下的规则正文，meta=站点首页等外围页，nav=目录占位页\n"
    )
    with open(win_long(os.path.join(args.out, "README.txt")), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(stats)
    print(stats)
    print(f"done in {time.time()-t0:.1f}s -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
