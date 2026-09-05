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


# ---------- prompt-instruction echo detector (mirrors lib/listing.js) ----------
_ECHO_PATTERNS = [
    r"\bone attribute per line\b",
    r"\bone vehicle line per\b",
    r"\bone concern per\b",
    r"\bone item per\b",
    r"\bcover brand\b",
    r"\bbenefit[- ]driven\b",
    r"\bno keyword stuffing\b",
    r"\boutput only sections\b",
    r"\boutput results? only\b",
    r"\bdo not invent\b",
    r"\bnever add\b",
    r"\bdo not wrap\b",
    r"\bdo not omit\b",
    r"\bdo not merge\b",
    r"\binclude warranty only if\b",
    r"\bsuggested ebay category path\b",
    r"\bnotes to seller\b",
    r"\bpackage includes\b",
    r"\bfive bullet\b",
    r"\bthree cassini\b",
    r"\bdescription first paragraph\b",
    r"\bmaximum?\s*\d+\s*chars?\b",
    r"\btitle case\b",
    r"\bno decorative punctuation\b",
    # Section-name echoes (v1.3 prompt uses these as section titles).
    r"\bselling points?\b",
    r"\bitem specifics?\b",
    r"\bproduct description\b",
    r"\bfitment type\b",
    r"\blike a deterministic engine\b",
    r"\bspecifications?\b",
    # Length / format rules that the model sometimes echoes back.
    r"\bstyle each entry\b",
    r"\bsections? 1\s*[-–]\s*8\b",
]
_ECHO_RE = re.compile("|".join(_ECHO_PATTERNS), re.IGNORECASE)


def _is_category_path(s: str) -> bool:
    """Detect an eBay Motors category path leaked into a non-category field."""
    if not s:
        return False
    if re.search(r"\bebay\s*motors\s*>", s, re.IGNORECASE):
        return True
    # `>`-separated, contains "Parts & Accessories", > 30 chars.
    if ">" in s and re.search(r"parts\s*(&|and)?\s*accessories", s, re.IGNORECASE) and len(s) > 30:
        return True
    return False


def _looks_like_echo(ln: str) -> bool:
    if not ln or len(ln) < 4:
        return True
    # Reject lines that are essentially just a section header name (e.g.
    # "Selling Points", "Item Specifics").
    if len(ln.split()) <= 3:
        t = ln.lower().strip()
        if (re.fullmatch(r"selling points?", t) or
                re.fullmatch(r"item specifics?", t) or
                re.fullmatch(r"package includes?", t) or
                re.fullmatch(r"notes to seller", t) or
                re.fullmatch(r"product description", t) or
                re.fullmatch(r"suggested.*category.*path", t) or
                re.fullmatch(r"fitment", t) or
                re.fullmatch(r"description", t)):
            return True
    if _ECHO_RE.search(ln):
        return True
    if '"' in ln and ":" in ln and len(ln.split()) > 12:
        return True
    return False


# ---------- eBay Motors Item Specifics label whitelist (mirrors lib/listing.js) ----------
_KNOWN_FIELDS = {
    "brand": "Brand",
    "manufacturer part number": "MPN",
    "mpn": "MPN",
    "manufacturer part no": "MPN",
    "manufacturer part #": "MPN",
    "interchange part number": "Interchange Part Number",
    "interchange part numbers": "Interchange Part Number",
    "interchange number": "Interchange Part Number",
    "interchange": "Interchange Part Number",
    "oe/oem part number": "OEM Part Number",
    "oem part number": "OEM Part Number",
    "oem number": "OEM Part Number",
    "oe part number": "OEM Part Number",
    "oe number": "OEM Part Number",
    "oem": "OEM Part Number",
    "placement on vehicle": "Placement on Vehicle",
    "placement": "Placement on Vehicle",
    "material": "Material",
    "type": "Type",
    "fitment type": "Fitment Type",
    "warranty": "Warranty",
    "country/region of manufacture": "Country/Region of Manufacture",
    "country of origin": "Country/Region of Manufacture",
    "vintage part": "Vintage Part",
    "number of pieces": "Number of Pieces",
    "piece count": "Number of Pieces",
    "universal fitment": "Universal Fitment",
    "custom bundle": "Custom Bundle",
    "superseded part number": "Superseded Part Number",
    "color": "Color",
    "manufacturer warranty": "Manufacturer Warranty",
    "part number": "Part Number",
}


def _normalize_label(label: str) -> str:
    s = re.sub(r"\s+", " ", label)
    s = re.sub(r"[*_`:]+", "", s)
    return s.strip(" \t\n\r-–—")


def list_items(block: str) -> list:
    out = []
    for raw in block.splitlines():
        ln = raw.strip()
        if not ln or ln.upper() == "NONE":
            continue
        # Bullet, numbered, arrow, or unicode-bullet prefix. The `>>?` covers
        # the eBay 79472025 regression where the supplier package uses `>>`
        # markers and the LLM echoes that style for titles / selling points.
        m = re.match(
            r"^\s*(?:"
            r"[-*•▪▫■□▶▸►→›»]\s+"
            r"|>+\s+"
            r"|\(?\d+[).]\s+"
            r"|Option\s*\d+\s*[:：.]\s+"
            r"|Title\s*\d+\s*[:：.]\s+"
            r")(.+)$",
            ln,
        )
        if not m:
            continue
        item = m.group(1).strip()
        if len(re.sub(r"[*_`]", "", item).replace(" ", "")) < 3:
            continue
        if item.upper() == "NONE":
            continue
        out.append(item)
    return out


def kv_items(block: str) -> list:
    out = []
    seen = set()
    for raw in block.splitlines():
        ln = raw.strip()
        if not ln:
            continue
        if _looks_like_echo(ln):
            continue
        no_bullet = re.sub(r"^[-*•]\s+", "", ln)
        colon = re.search(r"[:：]", no_bullet)
        if not colon:
            continue
        label = no_bullet[: colon.start()].strip().strip("*").strip()
        value = no_bullet[colon.end():].strip().strip("*").strip()
        if not label or not value or value.upper() == "NONE":
            continue
        canonical = _KNOWN_FIELDS.get(_normalize_label(label).lower())
        if not canonical:
            continue
        if canonical in seen:
            continue
        seen.add(canonical)
        out.append([canonical, value])
    return out


def para(block: str) -> str:
    lines = []
    for ln in block.splitlines():
        ln = ln.strip()
        if not ln or _looks_like_echo(ln):
            continue
        m = re.match(r"^\s*(?:[-*•]\s+|\(?\d+[).]\s+)(.+)$", ln)
        item = m.group(1) if m else re.sub(r"\*\*", "", ln)
        lines.append(item.strip())
    return " ".join(lines).strip()


def fitment_lines(block: str) -> list:
    raw = (block or "").strip()
    if not raw:
        return []
    # 1) Cleanest path: well-bulleted lines, each starting with a year range.
    listed = [l for l in list_items(raw) if re.match(r"^\s*\(?(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\)?", l)]
    if len(listed) >= 2:
        return listed
    # 2) Split on `;` and on year-range boundaries. Each piece must itself
    #    start with a year range — otherwise it is noise and discarded.
    #    Need at least 2 rows to consider this a fitment list; otherwise fall
    #    through to the prose split.
    parts = re.split(r"[;\n]+", raw)
    parts = [re.sub(r"^[\s:;,\-–—]+", "", p).strip()
             for p in parts if re.match(r"^\s*\(?(?:19|20)\d{2}\s*[-–—]", p)]
    if len(parts) >= 2:
        return parts
    # 3) Last-resort prose split: insert \n before each new year range.
    #    The lookahead regex MUST be applied with re.split which natively
    #    matches every position; do not use string.replace which only
    #    substitutes the first zero-width match.
    chunks = re.split(
        r"(?=\(?\s*(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2}))",
        raw)
    chunks = [re.sub(r"^[\s:;,\-–—]+", "", c).strip()
              for c in chunks if re.match(r"^\s*\(?(?:19|20)\d{2}\s*[-–—]", c)]
    return chunks


def _is_valid_title(t: str) -> bool:
    s = (t or "").strip()
    if len(s) < 15 or len(s) > 80:
        return False
    if _looks_like_echo(s):
        return False
    if _is_category_path(s):
        return False
    if not re.search(r"[a-zA-Z]", s):
        return False
    if re.fullmatch(r"\d+[.)]\s*", s):
        return False
    return True


_PLACEHOLDER_RE = re.compile(r"^(?:does not apply|n/?a|none|-|—|null)$", re.IGNORECASE)


def _first_real_oem_token(csv):
    """Pick the first OEM-shaped token from a comma-separated value list.
    Filters out placeholders like 'Does Not Apply', 'N/A', '-'."""
    if not csv:
        return ""
    for tok in re.split(r"[,;|]", csv):
        t = tok.strip()
        if not t:
            continue
        if _PLACEHOLDER_RE.match(t):
            continue
        if len(t) > 16:
            continue
        if not re.search(r"[A-Z0-9]", t) or not re.search(r"\d", t):
            continue
        return t
    return ""


def fallback_title(specifics, fitment):
    """Compose a sensible fallback title when the model emitted no usable
    title. Three signals in priority:
      1. The longest fitment line (gives Year-Range + Make/Model).
      2. Item Specifics[Type] for the part-type noun.
      3. Item Specifics[Placement on Vehicle] for the placement suffix.
    Result: <Type> <with-OEM-token?> for <Year-Range Make/Model>, <Placement>."""
    spec_map = {k: v for k, v in (specifics or [])}
    type_val = (spec_map.get("Type") or "Auto Part").strip()
    place_val = (spec_map.get("Placement on Vehicle") or "").strip()
    mpn = (spec_map.get("MPN") or "").strip()

    f_lines = [l.strip() for l in re.split(r";|\n", (fitment or ""))
               if l.strip() and re.match(r"^\s*\(?(?:19|20)\d{2}", l.strip())]
    f_main = sorted(f_lines, key=len, reverse=True)[0] if f_lines else ""

    year_range = ""
    make_model = ""
    if f_main:
        y_m = re.search(r"\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\b", f_main)
        if y_m:
            year_range = y_m.group(0).replace(" ", "")
        after = f_main.split(y_m.group(0) if y_m else "", 1)[1] if y_m else f_main
        trim = after.split(" (")[0].strip()
        cap = [w for w in trim.split() if re.match(r"^[A-Z][A-Za-z0-9-]+$", w)]
        make_model = " ".join(cap[:2]).strip()

    title = type_val
    oem = _first_real_oem_token(
        spec_map.get("OEM Part Number") or spec_map.get("Interchange Part Number") or mpn
    )
    if oem:
        title += " " + oem
    if year_range or make_model:
        title += " for " + (year_range + " " if year_range else "") + make_model
        title = title.strip()
    if place_val:
        title += ", " + place_val
    if len(title) > 80:
        title = title[:80].rstrip(", \t\n")
    return title


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
    raw_titles = list_items(sec.get(1, ""))
    titles = [{"text": t, "len": len(t)} for t in raw_titles if _is_valid_title(t)][:3]
    specifics = kv_items(sec.get(2, ""))
    fit_block = sec.get(3, "")
    fit_list = fitment_lines(fit_block)
    fitment = (fit_list[0] if len(fit_list) == 1 else "; ".join(fit_list)) if fit_list else "-"
    bullets = [b for b in list_items(sec.get(4, "")) if not _looks_like_echo(b) and not _is_category_path(b)][:5]
    desc = para(sec.get(5, ""))
    pkg_includes = [p for p in list_items(sec.get(6, "")) if not _looks_like_echo(p) and not _is_category_path(p)]
    category = para(sec.get(7, "")) or "-"
    notes = [n for n in list_items(sec.get(8, "")) if not _looks_like_echo(n) and not _is_category_path(n)]
    ver = verify_output(pkg_text, title, llm_text)
    if not titles:
        synth = fallback_title(specifics, fitment)
        if synth:
            titles = [{"text": synth, "len": len(synth)}]
    return {
        "ok": True, "model": model, "seconds": round(secs, 1), "tokens": tokens,
        "titles": titles,
        "specifics": specifics,
        "fitment": fitment,
        "bullets": bullets,
        "description": desc,
        "package_includes": pkg_includes,
        "category": category,
        "html": build_html(titles[0]["text"] if titles else "", fitment, bullets, desc, specifics, pkg_includes),
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
