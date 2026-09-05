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


# ---------- LLM 输出解析 ----------
def split_sections(text: str) -> dict:
    marks = []
    for m in re.finditer(r"(?m)^\s*([1-8])\.\s+.*$", text):
        marks.append((int(m.group(1)), m.start(), m.end()))
    secs = {}
    for i, (num, _s, e) in enumerate(marks):
        end = marks[i + 1][1] if i + 1 < len(marks) else len(text)
        secs.setdefault(num, text[e:end].strip())
    return secs


def list_items(block: str) -> list:
    items = []
    for ln in block.splitlines():
        ln = ln.strip()
        if re.match(r"[-*•]\s+", ln):
            items.append(re.sub(r"[-*•]\s+", "", ln, count=1).strip())
    return [i for i in items if i and i.upper() != "NONE"]


def kv_items(block: str) -> list:
    out = []
    for ln in block.splitlines():
        ln = ln.strip()
        if re.match(r"[-*•]\s+", ln) and ":" in ln:
            k, v = re.split(r":", re.sub(r"[-*•]\s+", "", ln, count=1), 1)
            out.append([k.strip(), v.strip()])
    return out


def para(block: str) -> str:
    lines = [l.strip() for l in block.splitlines() if l.strip()]
    lines = [re.sub(r"\*\*|[-*•]\s+", "", l, count=1 if re.match(r"\s*[-*•]", l) else 0) for l in lines]
    return " ".join(lines).strip()


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
    fitment = (list_items(fit_block) or [" ".join(fit_block.split())] or ["-"])[0]
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
