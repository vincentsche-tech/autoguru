#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EbayAutoGuru 本地 worker（MVP）
- 静态站点 + POST /api/generate：Gemini Flash-Lite 生成 + OEM 白名单校验
  逻辑与 cross-border-lister/listing_pipeline.py 完全同一套（直接 import）。
- 用法（bash）:
    cd ebay-parts-tool
    GEMINI_API_KEY=xxx GEMINI_PROXY=http://127.0.0.1:10809 python server.py
  浏览器开 http://127.0.0.1:8787
- 上生产时换 Cloudflare Pages Functions 版（同 /api/generate 契约），前端零改动。
"""
import json
import os
import re
import sys
import time
import html as html_mod
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
# 静态站点在 public/（与 Cloudflare Pages 的 pages_build_output_dir 一致，
# 这样 server.py / tests / .dev.vars 不会被一并部署到 CDN）
STATIC = os.path.join(HERE, "public")
if not os.path.isdir(STATIC):
    STATIC = HERE
PIPE_DIR = os.environ.get(
    "PIPELINE_DIR",
    r"D:\workbuddy space\cross-border-lister\scripts")
sys.path.insert(0, PIPE_DIR)

from gemini_api import call as gem_call, MODELS  # noqa: E402
from listing_pipeline import (  # noqa: E402
    PROMPT_TEMPLATE, PARTNO_RE, _is_noise, WATERMARK_RE, build_whitelist)

PORT = int(os.environ.get("PORT", "8787"))
MAX_TEXT = 20000  # 资料包上限字符（防滥用第一道闸）


# ---------- prompt ----------
def build_web_prompt(text: str) -> str:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    title = lines[0][:200] if lines else ""
    return PROMPT_TEMPLATE.format(
        sku="WEB", title=title, category="-", dims="-", desc=text[:3000])


# ---------- LLM 输出解析（强化版，与 lib/listing.js 完全对齐） ----------
def split_sections(text: str) -> dict:
    src = text or ""
    # 认多种 header： "1. Three..." / "**1.** Fitment" / "## 2. Item Specifics"
    # 但绝不把 "1) Front Shock..."（节内编号列表项）或 "1. 2pcs..."（以数字开头的句子）
    # 误判成 header。约束：数字+句号+空白+大写字母。
    # 与 lib/listing.js 完全对齐：headerStart 存 header 行起始 \n 位置，
    # body 结束于下一节 header 起始 \n 之前（绝不把下一节 header 文字吃进本节）。
    re_sec = re.compile(r"(?:^|\n)\s*(?:[*#`]+)?\s*\b([1-8])\.[ \t]+(?=[A-Z])")
    header_start = []
    for m in re_sec.finditer(src):
        num = int(m.group(1))
        if any(mm[0] == num for mm in header_start):
            continue
        header_start.append([num, m.start()])
    if not header_start:
        return {}
    header_eol = []
    for num, hs in header_start:
        eol = src.find("\n", max(hs + 1, 0))
        header_eol.append([num, len(src) if eol == -1 else eol])
    seen = {}
    for i, (num, _hs) in enumerate(header_start):
        if num in seen:
            continue
        body_start = header_eol[i][1] + 1
        body_end = header_start[i + 1][1] if i + 1 < len(header_start) else len(src)
        body = src[body_start:body_end].strip()
        if body:
            seen[num] = body
    return seen


def list_items(block: str) -> list:
    out = []
    re_item = re.compile(r"^\s*(?:[-*•]|\d+[).]\s+)?\s*(.+?)\s*$")
    for raw in block.splitlines():
        ln = raw.strip()
        if not ln:
            continue
        m = re_item.match(ln)
        if not m:
            continue
        item = re.sub(r"^[-*•]\s+", "", m.group(1)).strip()
        ulen = len(re.sub(r"[*_`]", "", item).replace(" ", ""))
        if ulen < 3:  # 丢弃 "1)" / "•" / "None" 之类噪声行
            continue
        if item.upper() == "NONE":
            continue
        out.append(item)
    return out


def kv_items(block: str) -> list:
    out = []
    re_label = re.compile(r"^\s*(?:\*+\s*)?([A-Z][A-Za-z0-9 /&\-]{1,40})\s*\**\s*[:：]\s*(.+?)\s*\**\s*$")
    for raw in block.splitlines():
        ln = raw.strip()
        if not ln or ":" not in ln:
            continue
        no_bullet = re.sub(r"^[-*•]\s+", "", ln)
        m = re_label.match(no_bullet)
        if not m:
            continue
        label = m.group(1).strip()
        value = m.group(2).strip()
        if label and value and value.upper() != "NONE":
            out.append([label, value])
    return out


def para(block: str) -> str:
    lines = [l.strip() for l in block.splitlines() if l.strip()]

    def strip_prefix(l):
        if re.match(r"\s*[-*•]", l):
            return re.sub(r"^[-*•]\s+", "", l).strip()
        return re.sub(r"\*\*", "", l).strip()

    return " ".join(strip_prefix(l) for l in lines).strip()


def fitment_lines(block: str) -> list:
    raw = (block or "").strip()
    if not raw:
        return []
    listed = list_items(raw)
    if len(listed) >= 2:
        return listed
    # 单行连体型 "2016-2020 GLC300 ... 2018-2020 GLC350e ..."：按年份区间切分
    split = re.split(
        r"(?=\(?\s*(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)?\d{2})", raw)
    split = [l.strip().lstrip(":;,-–— ").strip() for l in split]
    split = [l for l in split if l]
    if len(split) >= 2:
        return split
    return [raw]


# ---------- 白名单校验（与 cmd_verify 同逻辑） ----------
def extract_claimed(scrubbed: str) -> list:
    claimed, seen = [], set()
    out_text = scrubbed.upper()
    for m in PARTNO_RE.finditer(out_text):
        n = m.group(0).strip("-")
        idx = m.start()
        if idx > 0 and scrubbed[idx - 1] == "#":  # CSS hex color
            continue
        if n in seen or re.fullmatch(r"(19|20)\d{2}", n) or len(n) < 6 or _is_noise(n):
            continue
        seen.add(n)
        claimed.append(n)
    return claimed


def verify_output(pkg_text: str, title: str, llm_text: str) -> dict:
    wl = set(build_whitelist({"title_en": title, "description_text": pkg_text}))
    canon_wl = {re.sub(r"[^A-Z0-9]", "", n) for n in wl}
    scrubbed = WATERMARK_RE.sub("", llm_text)
    scrubbed = re.sub(r"Category\s*ID\s*[:：]\s*\d+", "", scrubbed, flags=re.I)
    claimed = extract_claimed(scrubbed)
    hall = [n for n in claimed if re.sub(r"[^A-Z0-9]", "", n) not in canon_wl]
    return {"total": len(claimed), "matched": len(claimed) - len(hall),
            "hallucinated": hall}


# ---------- HTML 描述（确定性代码生成，6 段结构对齐 eBay ActiveContent 政策） ----------
def build_html(title: str, fitment: str, bullets: list, desc: str,
               specs: list, pkg_includes: list) -> str:
    esc = html_mod.escape
    parts = ['<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;color:#1a1a1a;line-height:1.6">']
    parts.append("  <h2>" + esc(title) + "</h2>")
    if desc:
        parts.append("  <p>" + esc(desc) + "</p>")
    parts.append("  <h3>Fitment / Compatibility</h3>")
    parts.append("  <p>" + esc(fitment or "-") + "</p>")
    if specs:
        rows = "\n".join(
            "      <tr><td style=\"padding:6px 10px;border-bottom:1px solid #ddd\"><strong>" + esc(k) +
            "</strong></td><td style=\"padding:6px 10px;border-bottom:1px solid #ddd\">" + esc(v) + "</td></tr>"
            for k, v in specs)
        parts.append("  <h3>Specifications</h3>")
        parts.append('  <table style="width:100%;border-collapse:collapse">\n' + rows + "\n  </table>")
    if bullets:
        lis = "\n".join("    <li>" + esc(b) + "</li>" for b in bullets[:5])
        parts.append("  <h3>Features</h3>")
        parts.append("  <ul>\n" + lis + "\n  </ul>")
    if pkg_includes:
        inc = "\n".join("    <li>" + esc(i) + "</li>" for i in pkg_includes[:6])
        parts.append("  <h3>Package Includes</h3>")
        parts.append("  <ul>\n" + inc + "\n  </ul>")
    parts.append("  <p><em>Note: Professional installation is recommended. Please verify all part numbers against your vehicle before ordering.</em></p>")
    parts.append("</div>")
    return "\n".join(parts)


# ---------- 生成主链 ----------
def api_generate(pkg_text: str) -> dict:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return {"ok": False, "error": "Server missing GEMINI_API_KEY"}
    if not pkg_text or len(pkg_text.strip()) < 40:
        return {"ok": False, "error": "Data package looks too short — paste the whole supplier listing."}
    pkg_text = pkg_text.strip()[:MAX_TEXT]

    lines = [l.strip() for l in pkg_text.splitlines() if l.strip()]
    title = lines[0][:200] if lines else ""
    prompt = build_web_prompt(pkg_text)

    llm_text, model, secs, tokens = None, None, 0.0, ""
    for m in MODELS:
        try:
            t0 = time.time()
            j = gem_call(m, key, prompt)
            um = j.get("usageMetadata", {})
            tokens = f"{um.get('promptTokenCount', 0)}/{um.get('candidatesTokenCount', 0)}"
            llm_text = "".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"])
            model, secs = m, time.time() - t0
            break
        except Exception as e:  # noqa: BLE001
            print(f"[WARN] {m}: {e}", file=sys.stderr)
            time.sleep(2)
    if llm_text is None:
        return {"ok": False, "error": "All Gemini models failed — try again in a moment."}

    sec = split_sections(llm_text)
    titles = list_items(sec.get(1, ""))[:3]
    specifics = kv_items(sec.get(2, ""))
    fit_block = sec.get(3, "")
    fit_list = fitment_lines(fit_block)
    fitment = (fit_list[0] if len(fit_list) == 1 else "; ".join(fit_list)) if fit_list else "-"
    bullets = list_items(sec.get(4, ""))[:5]
    desc = para(sec.get(5, ""))
    pkg_includes = list_items(sec.get(6, ""))
    category = para(sec.get(7, "")) or "-"
    notes = list_items(sec.get(8, ""))
    ver = verify_output(pkg_text, title, llm_text)

    return {
        "ok": True, "model": model, "seconds": round(secs, 1), "tokens": tokens,
        "titles": [{"text": t, "len": len(t)} for t in titles],
        "specifics": specifics,
        "fitment": fitment,
        "bullets": bullets,
        "description": desc,
        "package_includes": pkg_includes,
        "category": category,
        "html": build_html(title, fitment, bullets, desc, specifics, pkg_includes),
        "notes": notes,
        "verify": ver,
    }


# ---------- HTTP ----------
CT = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8", ".xml": "application/xml",
      ".txt": "text/plain; charset=utf-8", ".png": "image/png",
      ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        fp = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not fp.startswith(STATIC) or not os.path.isfile(fp):
            self._send(404, b'{"ok":false,"error":"not found"}')
            return
        ext = os.path.splitext(fp)[1].lower()
        with open(fp, "rb") as f:
            self._send(200, f.read(), CT.get(ext, "application/octet-stream"))

    def do_POST(self):
        if urlparse(self.path).path != "/api/generate":
            self._send(404, b'{"ok":false,"error":"not found"}')
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
            self._send(400, json.dumps({"ok": False, "error": "bad request"}).encode())
            return
        t0 = time.time()
        res = api_generate(str(data.get("text", "")))
        print(f"[api] generate -> ok={res.get('ok')} {time.time()-t0:.1f}s")
        self._send(200 if res.get("ok") else 502,
                   json.dumps(res, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    print(f"EbayAutoGuru dev worker -> http://127.0.0.1:{PORT}  (proxy={os.environ.get('GEMINI_PROXY') or 'off'})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
