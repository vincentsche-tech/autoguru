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
    # NB: every `\s*` in this regex is intentionally `[ \t]*` (spaces/tabs
    # only, NOT newlines). A greedy `\s*` would swallow the blank line(s)
    # between sections, landing m.start() on the newline *before* the blank
    # line and shifting every body start so the section header text itself
    # ("3. Fitment") gets included in the body. Mirrors lib/listing.js.
    re_sec = re.compile(r"(?:^|\n)[ \t]*(?:[*#`]+)?[ \t]*\b([1-8])\.[ \t]+(?=[A-Z])")
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
        # Bullet/marker prefix: one or more "bullet-char cluster +
        # whitespace" layers. Each layer is `[-*•…]+` (greedy: consumes
        # a run of `-`/`*`/Unicode bullet chars together — handles `*-`
        # / `-*` / `**-` as one cluster) followed by `\s+` (at least
        # one whitespace — prevents over-stripping markdown bold like
        # `**Brand:**`). Outer `(?:...)+` repeats layers, so nested
        # combos like `- *- foo` (eBay Window Mirror Master Switch
        # regression) and `* - foo` / `* * foo` all strip cleanly.
        m = re.match(
            r"^\s*(?:"
            r"(?:[-*•▪▫■□▶▸►→›»]+\s+)+"
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


def plain_content_lines(block: str, min_len: int, max_len: int) -> list:
    """Fallback when list_items() yields nothing — some models emit section
    content as plain prose lines (no `* 1) >>` prefix) for short packages.
    Recovers genuine lines that aren't echoes / category paths / lone headers.
    Mirrors plainContentLines() in lib/listing.js."""
    out = []
    for raw in block.splitlines():
        ln = raw.strip()
        if not ln or ln.upper() == "NONE":
            continue
        if len(ln) < min_len or len(ln) > max_len:
            continue
        if len(ln.split()) == 1 and ln.endswith(":"):
            continue
        if _looks_like_echo(ln) or _is_category_path(ln):
            continue
        out.append(ln)
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


# Last-resort: when section 7 is empty / lost, infer a sensible eBay Motors
# category path from Item Specifics[Type]. The model is supposed to write a
# path itself (eBay Motors > Parts & Accessories > ...), but short data
# packages occasionally cause it to skip sec[7] entirely — leaving the UI
# showing "-" with no suggestion at all. This synthesises a usable default
# so the seller at least has a starting point to verify against the eBay
# Sell flow.
#
# Same rules as lib/listing.js CATEGORY_RULES — keep them in lock-step.
_CATEGORY_RULES = [
    # Suspension & Steering
    (re.compile(r"\bcontrol arms?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Control Arms & Parts"),
    (re.compile(r"\bshock absorber(s)?\b|\bshocks? (and|&) struts?\b|\bstruts?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Shocks & Struts"),
    (re.compile(r"\bball joints?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Ball Joints"),
    (re.compile(r"\bsway bar(s)?\b|\bstabilizer bar(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Sway Bars"),
    (re.compile(r"\btie rod ends?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Tie Rod Ends"),
    (re.compile(r"\bpower\s+steering\s+pump(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Steering & Suspension > Power Steering Pumps"),
    # Engine & drivetrain
    (re.compile(r"\bwater pump(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Water Pumps"),
    (re.compile(r"\bengine valve cover(s)?\b|\bvalve cover(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Engine Blocks & Parts > Valve Covers"),
    (re.compile(r"\boil pan(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Oil Pans"),
    (re.compile(r"\bhead gasket(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Gaskets & Seals"),
    (re.compile(r"\bspark plug(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Ignition Systems > Spark Plugs"),
    (re.compile(r"\bignition coil(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Ignition Systems > Ignition Coils"),
    (re.compile(r"\bair filter(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Air Filters"),
    (re.compile(r"\bmass air flow\b|\bmaf sensor(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Mass Air Flow Meters"),
    (re.compile(r"\bthrottle body\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Throttle Bodies"),
    (re.compile(r"\bfuel pump(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps"),
    (re.compile(r"\bfuel injector(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Injectors"),
    # Transmission & Drivetrain
    (re.compile(r"\bclutch\s+kit(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Transmission & Drivetrain > Clutch Kits"),
    (re.compile(r"\bclutch\s+(?:disc|facing)\b|\bclutch\s+disc(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Transmission & Drivetrain > Clutch Discs"),
    (re.compile(r"\bpressure\s+plate(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Transmission & Drivetrain > Pressure Plates"),
    (re.compile(r"\brelease\s+bearing(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Transmission & Drivetrain > Release Bearings"),
    # Electrical & Lighting
    (re.compile(r"\balternator(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Electrical & Lighting > Alternators"),
    (re.compile(r"\bstarter motor(s)?\b|\bstarter(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Electrical & Lighting > Starters"),
    (re.compile(r"\bheadlight(s)? assembly\b|\bheadlight(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Lighting & Lamps > Headlights"),
    (re.compile(r"\btail light(s)?\b|\btaillight(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Lighting & Lamps > Tail Lights"),
    (re.compile(r"\bfog light(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Lighting & Lamps > Fog Lights"),
    # Exterior
    (re.compile(r"\bside mirror(s)?\b|\bdoor mirror(s)?\b|\bpower mirror(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Mirrors"),
    (re.compile(r"\bbumper cover(s)?\b|\bfront bumper\b|\brear bumper\b|\bbumper\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Bumpers"),
    (re.compile(r"\bfender(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Fenders"),
    (re.compile(r"\bhood(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Hoods"),
    (re.compile(r"\bradiator(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Radiators"),
    (re.compile(r"\bthermostat(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Thermostats"),
    (re.compile(r"\bradiator hose(s)?\b|\bhose(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Hoses"),
    (re.compile(r"\bradiator fan(s)?\b|\bfan clutch(es)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Fan Clutches"),
    (re.compile(r"\bradiator support(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Radiator Supports"),
    (re.compile(r"\bconvertible top(s)?\b|\brear window(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Convertible Tops & Parts"),
    (re.compile(r"\brunning board(s)?\b|\bside step(s)?\b|\bnerf bar(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Running Boards & Step Bars"),
    (re.compile(r"\btonneau cover(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Tonneau Covers"),
    (re.compile(r"\bwheel bearing(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Wheel Bearings"),
    # Interior
    (re.compile(r"\bdoor handle(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Door Handles"),
    (re.compile(r"\bdoor armrest(s)?\b|\barmrest(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Armrests"),
    (re.compile(r"\bwindow regulator(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Window Regulators"),
    (re.compile(r"\bwindow motor(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Window Motors"),
    # Heating & Cooling (blower motor was missing — SKU 33762573 regression)
    (re.compile(r"\bheater\s+blower\s+motor\b|\bblower\s+motor\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Heating & Cooling > Blower Motors"),
    (re.compile(r"\bpower window switch(es)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Window Switches"),
    (re.compile(r"\bsun visor(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Sun Visors"),
    # Brakes
    (re.compile(r"\bbrake pad(s)?\b|\bbrake rotor(s)?\b|\bbrake caliper(s)?\b|\bbrake\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Brakes & Brake Parts"),
    # Wheels
    (re.compile(r"\balloy wheel(s)?\b|\bwheel(s)?\b"), "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Wheels"),
]


def _infer_category_path(specifics, pkg_text=None):
    spec_map = {k: v for k, v in (specifics or [])}
    type_val = (spec_map.get("Type") or "").strip()
    if not type_val:
        # SKU 93856129 regression: model returned an ALL-echo category and
        # omitted Item Specifics[Type]. Derive the part type from the raw
        # package text (e.g. "Clutch Disc / Pressure Plate / Release
        # Bearing" -> "Clutch Kit") so the seller still gets a real path.
        derived = infer_part_type_from_pkg(pkg_text or "")
        if derived:
            type_val = derived
    if not type_val:
        return ""
    t = type_val.lower()
    for rx, path in _CATEGORY_RULES:
        if rx.search(t):
            return path
    # Conservative last-resort: a real (if generic) eBay Motors path that
    # the seller can drill down in the Sell flow. Better than "-" because
    # at least it lands in the right top-level category tree.
    return f"eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > {type_val}"


# Detect prompt-instruction echoes that the model regurgitates into sec[7]
# instead of writing a real category path. SKU 1663201313 regression:
# the model returned "-- verify in the eBay Sell flow before publishing."
# for the whole section body, which `para()` happily surfaced into the UI.
# Mirrors `looksLikeCategoryEcho()` in lib/listing.js.
_CATEGORY_ECHO_RE_LIST = [
    re.compile(r"^\s*[—\-+]\s*verify\b", re.I),
    re.compile(r"\bverify\s+in\s+the\s+ebay\s*sell\s*flow\b", re.I),
    re.compile(r"\b(?:seller|please)\s+verify\b", re.I),
    re.compile(r"^\s*verify\b", re.I),
    re.compile(r"\bsuggested\s+ebay\s+category\s+path\b", re.I),
    re.compile(r"^\s*e\.?g\.?\s+", re.I),
]
# Anchors for stripping an echo TAIL off a category path. SKU 52248592
# regression: the LLM emitted "<real path> — verify in the eBay Sell flow
# before publishing." (~140 chars). The length>120 short-circuit in
# _looks_like_category_echo() let it slip through, and the whole hybrid
# string was passed to the UI. These anchors let us chop the echo suffix
# and keep the leading real path.
_CATEGORY_ECHO_ANCHORS = [
    re.compile(r"[—\-+]\s*verify\b.*$", re.I),
    re.compile(r"\bverify\s+in\s+the\s+ebay\s*sell\s*flow\b.*$", re.I),
    re.compile(r"\b(?:seller|please)\s+verify\b.*$", re.I),
    re.compile(r"\bsuggested\s+ebay\s+category\s+path\b.*$", re.I),
    re.compile(r"\bverify\s+this\s+before\s+publishing\b.*$", re.I),
]


def _looks_like_category_echo(s):
    if not s:
        return False
    t = s.strip()
    if not t:
        return False
    # Length guard removed: SKU 52248592 sent a 140-char "<path> — verify..."
    # hybrid, which the old len>120 short-circuit silently passed through.
    return any(rx.search(t) for rx in _CATEGORY_ECHO_RE_LIST)


def _strip_category_echo_tail(s):
    """Trim a trailing echo suffix off a category path string. Returns ""
    when the whole string was echo. Mirrors `stripCategoryEchoTail()` in
    lib/listing.js."""
    if not s:
        return ""
    out = s.strip()
    for rx in _CATEGORY_ECHO_ANCHORS:
        m = rx.search(out)
        if m:
            out = out[:m.start()].strip()
            break
    out = re.sub(r"[\s,;:.\-—]+$", "", out).strip()
    return out


# Last-resort Item Specifics recovery from the RAW data package. Used when
# the model skipped sec[2] entirely. Mirrors `fallbackSpecifics()` in
# lib/listing.js — keep the two in lock-step.
def _fallback_specifics(pkg_text: str, fitment: str):
    out = []
    seen = set()

    def _push(k, v):
        if not k or not v:
            return
        val = str(v).strip()
        if not val or k in seen:
            return
        seen.add(k)
        out.append([k, val])

    def _take_tokens(raw):
        toks = []
        for tok in re.split(r"[,\n;|]+", raw or ""):
            t = tok.strip()
            if not t:
                continue
            if re.match(r"^(?:n/?a|none|—|-|does not apply|not specified|null)$", t, re.I):
                continue
            toks.append(t)
        return toks

    if not pkg_text:
        return out
    # Interchange Part Number
    m = re.search(r"interchange\s*(?:part\s*)?numbers?\s*[:：]\s*([^\n]+)", pkg_text, re.I)
    if m:
        toks = _take_tokens(m.group(1))
        if toks:
            _push("Interchange Part Number", ", ".join(toks))
    # OE/OEM Part Number
    m = re.search(
        r"(?:^|\n)\s*(?:OE|Part)\s*(?:/\s*Part)?\s*(?:number|no|#)\s*[:：]\s*([^\n]+)",
        pkg_text, re.I,
    ) or re.search(r"OEM\s*Part\s*Number\s*[:：]\s*([^\n]+)", pkg_text, re.I)
    if m:
        toks = _take_tokens(m.group(1))
        if toks:
            _push("OEM Part Number", ", ".join(toks))
    # Reference OE/OEM Number (common supplier header; part numbers on the same
    # line or the following line, comma-separated). SKU 33762573 regression:
    # the package used "Reference OE/OEM Number" with no "Interchange"/"OEM
    # Part Number" label, so 7 real identifiers were dropped. Feed them as
    # Interchange Part Number so the seller keeps real data.
    m = re.search(
        r"reference\s+(?:oe\/?oem|oem)\s+number\b[^\n]*\n\s*([^\n]+)", pkg_text, re.I
    ) or re.search(
        r"reference\s+(?:oe\/?oem|oem)\s+number\b\s*[:：]?\s*([^\n]+)", pkg_text, re.I
    )
    if m:
        toks = _take_tokens(m.group(1))
        if toks:
            _push("Interchange Part Number", ", ".join(toks))
    # Manufacturer Part Number
    m = re.search(r"manufacturer\s*(?:part\s*)?(?:number|no|#)\s*[:：]\s*([^\n]+)", pkg_text, re.I)
    if m:
        _push("MPN", m.group(1).strip().split(",")[0].split("\n")[0].strip())
    # Brand
    m = re.search(r"(?:^|\n)\s*brand\s*[:：]\s*([^\n]+)", pkg_text, re.I)
    if m:
        v = m.group(1).strip()
        if re.match(r"^(?:not specified|null|—|-|n/?a|none)$", v, re.I):
            _push("Brand", "Unbranded")
        else:
            _push("Brand", v)
    else:
        _push("Brand", "Unbranded")
    # Placement on Vehicle
    m = re.search(
        r"placement\s*(?:on\s*(?:the\s*)?)?(?:vehicle)?\s*[:：]\s*([^\n]+)", pkg_text, re.I,
    )
    if m:
        _push("Placement on Vehicle", m.group(1).strip())
    # Fitment Type
    m = re.search(r"fitment\s*type\s*[:：]\s*([^\n]+)", pkg_text, re.I)
    if m:
        _push("Fitment Type", m.group(1).strip())
    # Material (often in a "Specification" block, e.g. "Material: Plastic + Metal").
    m = re.search(r"material\s*[:：]\s*([^\n]+)", pkg_text, re.I)
    if m:
        _push("Material", m.group(1).strip())
    # Type from package text
    type_noun = infer_part_type_from_pkg(pkg_text)
    if type_noun:
        _push("Type", type_noun)
    # Warranty default
    _push("Warranty", "Does Not Apply")
    return out


_BARE_YEAR_RE = re.compile(
    r"^\s*\(?(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\s*$")


_STOP_MAKE_MODEL = {
    "Fits", "Fitment", "For", "Compatible", "With", "Vehicle", "Application",
    "Direct", "Replacement", "Type", "Make", "Model", "Year", "Parts",
    "Accessories", "Motor", "Motors", "Car", "Truck", "Top", "Convertible",
}


def _make_model_from(raw: str) -> str:
    """Up to 2 capitalised Make/Model words from surrounding text. Mirrors
    makeModelFrom() in lib/listing.js."""
    words = [w for w in re.split(r"[\s;,.\-–—()]+", raw)
             if re.match(r"^[A-Z][A-Za-z0-9-]{1,}$", w)
             and not w[0].isdigit()
             and w not in _STOP_MAKE_MODEL]
    return " ".join(words[:2])


def _year_then_make_model(row: str):
    """Re-order "<YearRange>\n<Make Model …>" into "<YearRange> <Make Model …>"
    so the joined fitment output is uniform. SKU 1663201313 regression: when
    the LLM wrote fitment as `2012-2015\nMercedes-Benz GL (X166):` the
    year-first prose split left the newline embedded in the row. Mirrors
    `_yearThenMakeModel()` in lib/listing.js."""
    m = re.match(
        r"^(\s*\(?(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\)?)\s*([\s\S]+)$",
        row,
    )
    if not m:
        return None
    year, rest = m.group(1), m.group(2)
    cleaned = re.sub(r"^[\s:;,\-–—]+", "", rest)
    cleaned = re.sub(r"[\s:;,\-–—]+$", "", cleaned).strip()
    if not cleaned:
        return None
    return re.sub(r"\s+", "", year) + " " + cleaned


def _enrich_fitment_row(row: str, raw: str) -> str:
    if not _BARE_YEAR_RE.match(row):
        ordered = _year_then_make_model(row)
        return ordered if ordered else row
    mm = _make_model_from(raw)
    return f"{mm} {row}".strip() if mm else row


def fitment_lines(block: str) -> list:
    raw = (block or "").strip()
    if not raw:
        return []
    # 1) Cleanest path: well-bulleted lines, each starting with a year range.
    listed = [l for l in list_items(raw) if re.match(r"^\s*\(?(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\)?", l)]
    if len(listed) >= 2:
        return [_enrich_fitment_row(r, raw) for r in listed]
    # 2) Split on `;` and on year-range boundaries. Each piece must itself
    #    start with a year range — otherwise it is noise and discarded.
    #    Need at least 2 rows to consider this a fitment list; otherwise fall
    #    through to the prose split.
    parts = re.split(r"[;\n]+", raw)
    parts = [re.sub(r"^[\s:;,\-–—]+", "", p).strip()
             for p in parts if re.match(r"^\s*\(?(?:19|20)\d{2}\s*[-–—]", p)]
    if len(parts) >= 2:
        return [_enrich_fitment_row(r, raw) for r in parts]
    # 3) Last-resort prose split: insert \n before each new year range.
    #    The lookahead regex MUST be applied with re.split which natively
    #    matches every position; do not use string.replace which only
    #    substitutes the first zero-width match.
    chunks = re.split(
        r"(?=\(?\s*(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2}))",
        raw)
    chunks = [re.sub(r"^[\s:;,\-–—]+", "", c).strip()
              for c in chunks if re.match(r"^\s*\(?(?:19|20)\d{2}\s*[-–—]", c)]
    return [_enrich_fitment_row(r, raw) for r in chunks]


_FIT_CUE_RE = re.compile(
    r"(?:^|\n)\s*(?:fits?\s+for|compatible\s+(?:with|for|vehicle|car|model|truck|fitment)|(?:vehicle\s+)?fitment\s+for|fitment\s*[:：]|application\s*[:：]|for\s+vehicle)\s*[:：]?\s*([^\n]+)",
    re.IGNORECASE,
)
_FIT_YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\s*[-–—]\s*((?:(?:19|20)\d{2})|\d{2})\b")


def extract_pkg_fitment(pkg_text: str) -> list:
    """Last-resort fitment extraction from the RAW data package. Mirrors
    extractPkgFitment() in lib/listing.js so the two runtimes stay
    byte-identical."""
    if not pkg_text:
        return []
    out = []
    seen = set()

    def _push(row):
        k = row.lower()
        if k in seen:
            return
        seen.add(k)
        out.append(row)

    for m in _FIT_CUE_RE.finditer(pkg_text):
        line = (m.group(1) or "").strip()
        # Skip obvious non-fitment meta ("Fitment Type: Direct Replacement")
        if re.match(r"^type\s*[:：]?", line, re.IGNORECASE):
            continue
        line = re.sub(r"^[\s:;,.\-–—]+", "", line)
        line = re.sub(r"[;,\s]+$", "", line)
        if not line:
            continue
        cleaned = fitment_lines(line)
        if cleaned:
            for row in cleaned:
                if not re.search(r"\b[A-Z][A-Za-z0-9-]+\b", row):
                    y = _FIT_YEAR_RE.search(line)
                    if y:
                        mm = _make_model_around(line, y)
                        if mm:
                            _push(f"{row} {mm}")
                            continue
                _push(row)
            continue
        y = _FIT_YEAR_RE.search(line)
        if not y:
            continue
        end_year = y.group(2)
        if len(end_year) == 2:
            end_year = "20" + end_year
        year_range = f"{y.group(1)}-{end_year}"
        mm = _make_model_around(line, y)
        _push(f"{year_range} {mm}".strip() if mm else year_range)
    return out


def _make_model_around(line: str, year_match) -> str:
    """Pull up to 2 capitalised words around the year range as Make/Model.
    Mirrors _makeModelAround() in lib/listing.js."""
    before = line[: year_match.start()].strip()
    after = line[year_match.end():].strip()

    def _cap(s):
        words = [w for w in re.split(r"\s+", s) if re.match(r"^[A-Z][A-Za-z0-9-]+$", w)]
        return " ".join(words[:3])

    return (_cap(before) + " " + _cap(after)).strip()


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


_PART_TYPE_KEYWORDS = [
    [re.compile(r"\bair\s+suspension\s+strut|air\s+strut|air\s+shock\b", re.I), "Air Suspension Strut"],
    [re.compile(r"\bheater\s+blower\s+motor\b|\bblower\s+motor\b|\bblower\b", re.I), "Heater Blower Motor"],
    [re.compile(r"\bstrut\b", re.I), "Strut"],
    [re.compile(r"\bshock\s+absorber|shocks?\b", re.I), "Shock Absorber"],
    [re.compile(r"\bcontrol\s+arm(s)?\b", re.I), "Control Arm"],
    [re.compile(r"\bwater\s+pump(s)?\b", re.I), "Water Pump"],
    [re.compile(r"\boil\s+pan(s)?\b", re.I), "Oil Pan"],
    [re.compile(r"\bhead\s+gasket(s)?\b", re.I), "Head Gasket"],
    [re.compile(r"\bengine\s+(?:valve\s+cover|cover)\b|\bvalve\s+cover\b", re.I), "Valve Cover"],
    [re.compile(r"\bwindow\s+regulator\b", re.I), "Window Regulator"],
    [re.compile(r"\bpower\s+window\s+switch(es)?\b", re.I), "Power Window Switch"],
    [re.compile(r"\bwindow\s+motor\b", re.I), "Window Motor"],
    [re.compile(r"\bspark\s+plug(s)?\b", re.I), "Spark Plug"],
    [re.compile(r"\bignition\s+coil(s)?\b", re.I), "Ignition Coil"],
    [re.compile(r"\bair\s+filter(s)?\b", re.I), "Air Filter"],
    [re.compile(r"\bmass\s+air\s+flow\b|\bmaf\s+sensor(s)?\b", re.I), "Mass Air Flow Sensor"],
    [re.compile(r"\bthrottle\s+body\b", re.I), "Throttle Body"],
    [re.compile(r"\bfuel\s+pump\b", re.I), "Fuel Pump"],
    [re.compile(r"\bpower\s+steering\s+pump\b", re.I), "Power Steering Pump"],
    [re.compile(r"\bfuel\s+injector(s)?\b", re.I), "Fuel Injector"],
    [re.compile(r"\bclutch\s+kit(s)?\b|\bclutch\s+disc(s)?\b|\bpressure\s+plate(s)?\b|\brelease\s+bearing(s)?\b|\bclutch\b", re.I), "Clutch Kit"],
    [re.compile(r"\balternator(s)?\b", re.I), "Alternator"],
    [re.compile(r"\bstarter\s+motor\b|\bstarter\b", re.I), "Starter"],
    [re.compile(r"\bheadlight(s)?\b", re.I), "Headlight"],
    [re.compile(r"\btaillight(s)?\b|\btail\s+light(s)?\b", re.I), "Tail Light"],
    [re.compile(r"\bfog\s+light(s)?\b", re.I), "Fog Light"],
    [re.compile(r"\bbrake\s+(?:pad|rotor|caliper)\b|\bbrake\b", re.I), "Brake Part"],
    [re.compile(r"\bradiator(s)?\b", re.I), "Radiator"],
    [re.compile(r"\bthermostat(s)?\b", re.I), "Thermostat"],
    [re.compile(r"\bradiator\s+fan(s)?\b|\bfan\s+clutch(es)?\b|\bfan\b", re.I), "Fan Clutch"],
    [re.compile(r"\bradiator\s+support(s)?\b", re.I), "Radiator Support"],
    [re.compile(r"\bconvertible\s+top(s)?\b|\brear\s+window(s)?\b", re.I), "Convertible Top"],
    [re.compile(r"\brunning\s+board(s)?\b|\bside\s+step(s)?\b|\bnerf\s+bar(s)?\b", re.I), "Running Board"],
    [re.compile(r"\btonneau\s+cover(s)?\b", re.I), "Tonneau Cover"],
    [re.compile(r"\bball\s+joint(s)?\b", re.I), "Ball Joint"],
    [re.compile(r"\bsway\s+bar\b|\bstabilizer\s+bar\b", re.I), "Sway Bar"],
    [re.compile(r"\btie\s+rod\b", re.I), "Tie Rod"],
    [re.compile(r"\bwheel\s+bearing\b", re.I), "Wheel Bearing"],
    [re.compile(r"\bwheel(s)?\b", re.I), "Wheel"],
    [re.compile(r"\bdoor\s+handle\b", re.I), "Door Handle"],
    [re.compile(r"\bdoor\s+armrest(s)?\b|\barmrest(s)?\b", re.I), "Armrest"],
    [re.compile(r"\bdoor\s+mirror\b|\bpower\s+mirror\b|\bside\s+mirror\b", re.I), "Mirror"],
    [re.compile(r"\bbumper\b", re.I), "Bumper"],
    [re.compile(r"\bfender(s)?\b", re.I), "Fender"],
    [re.compile(r"\bhood(s)?\b", re.I), "Hood"],
    [re.compile(r"\bsun\s+visor(s)?\b", re.I), "Sun Visor"],
]


def infer_part_type_from_pkg(pkg_text: str) -> str:
    """Recover a part-type noun from the raw package text when the model
    omitted Item Specifics[Type]. Mirrors inferPartTypeFromPkg() in
    lib/listing.js."""
    text = pkg_text or ""
    for re_obj, noun in _PART_TYPE_KEYWORDS:
        if re_obj.search(text):
            return noun
    return ""


def fallback_title(specifics, fitment, pkg_text=""):
    """Compose a sensible fallback title when the model emitted no usable
    title. Three signals in priority:
      1. The longest fitment line (gives Year-Range + Make/Model).
      2. Item Specifics[Type] for the part-type noun.
      3. Item Specifics[Placement on Vehicle] for the placement suffix.
    Result: <Type> <with-OEM-token?> for <Year-Range Make/Model>, <Placement>."""
    spec_map = {k: v for k, v in (specifics or [])}
    type_val = (spec_map.get("Type") or infer_part_type_from_pkg(pkg_text) or "Auto Part").strip()
    place_val = (spec_map.get("Placement on Vehicle") or "").strip()
    mpn = (spec_map.get("MPN") or "").strip()

    # SKU 52248592 regression: the model emitted "FORD SUPER 2011-2016" with
    # Make/Model BEFORE the year range. The old "must start with a year"
    # regex rejected the line; the year-side MM extraction then had
    # nothing to pull. Now any line containing a 19xx/20xx token counts,
    # and MM is harvested from whichever side of the year range carries
    # capitalised tokens.
    f_lines = [l.strip() for l in re.split(r";|\n", (fitment or ""))
               if l.strip() and re.search(r"\b(?:19|20)\d{2}\b", l.strip())]
    f_main = sorted(f_lines, key=len, reverse=True)[0] if f_lines else ""

    year_range = ""
    make_model = ""
    if f_main:
        y_m = re.search(r"\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\b", f_main)
        if y_m:
            year_range = y_m.group(0).replace(" ", "")
            idx = f_main.find(y_m.group(0))
            before = f_main[:idx].strip()
            after = f_main[idx + len(y_m.group(0)):].strip()
        else:
            before = ""
            after = f_main
        def _extract_mm(s):
            trim = s.split(" (")[0].strip()
            if not trim:
                return ""
            cap = [w for w in trim.split() if re.match(r"^[A-Z][A-Za-z0-9-]+$", w)]
            return " ".join(cap[:2]).strip()
        mm_before = _extract_mm(before)
        mm_after = _extract_mm(after)
        make_model = mm_before or mm_after

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
    # If the model wrote titles as plain (un-bulleted) lines, recover them.
    title_pool = raw_titles if raw_titles else plain_content_lines(sec.get(1, ""), 15, 80)
    titles = [{"text": t, "len": len(t)} for t in title_pool if _is_valid_title(t)][:3]
    specifics = kv_items(sec.get(2, ""))
    fit_block = sec.get(3, "")
    fit_list = fitment_lines(fit_block)
    if not fit_list:
        fit_list = extract_pkg_fitment(pkg_text)
    fitment = (fit_list[0] if len(fit_list) == 1 else "; ".join(fit_list)) if fit_list else "-"
    bullets = [b for b in list_items(sec.get(4, "")) if not _looks_like_echo(b) and not _is_category_path(b)][:5]
    if not bullets:
        bullets = [b for b in plain_content_lines(sec.get(4, ""), 8, 200)
                   if not _looks_like_echo(b) and not _is_category_path(b)][:5]
    desc = para(sec.get(5, ""))
    pkg_includes = [p for p in list_items(sec.get(6, "")) if not _looks_like_echo(p) and not _is_category_path(p)]
    # Item Specifics fallback: when the LLM skipped sec[2] entirely, recover
    # KV rows from the raw data package so the seller has Brand / MPN / Type
    # / Placement at minimum instead of a lone "-" row in the UI.
    specifics_final = specifics
    if not specifics_final:
        fb = _fallback_specifics(pkg_text, fitment)
        if fb:
            specifics_final = fb
    # Suggested eBay category path. Three-layer safety (SKU 52248592
    # regression — the LLM emitted "<real path> — verify in the eBay Sell
    # flow before publishing." which the previous length>120 short-circuit
    # in _looks_like_category_echo() silently let through):
    #   1. Try _strip_category_echo_tail() FIRST — this handles the
    #      "hybrid" case where the LLM wrote "<real path> — verify ...".
    #      SKU 20-282P1 regression (Sept 2026): the previous code used
    #      `_looks_like_category_echo` to gate stripping, but the LLM's
    #      tail ("— verify in the eBay Sell flow before publishing.")
    #      made the WHOLE string match an echo pattern, so the gate
    #      discarded the entire string and _infer_category_path() produced
    #      a slightly different leaf than the model's canonical path.
    #   2. If strip returned "" (the whole line was echo), fall through
    #      to _infer_category_path() from Item Specifics[Type].
    raw_category = para(sec.get(7, ""))
    cleaned_category = _strip_category_echo_tail(raw_category) if raw_category else ""
    category = (
        cleaned_category
        or _infer_category_path(specifics_final, pkg_text)
        or _infer_category_path(_fallback_specifics(pkg_text, fitment), pkg_text)
        or "-"
    )
    notes = [n for n in list_items(sec.get(8, "")) if not _looks_like_echo(n) and not _is_category_path(n)]
    ver = verify_output(pkg_text, title, llm_text)
    if not titles:
        synth = fallback_title(specifics_final, fitment, pkg_text)
        if synth:
            titles = [{"text": synth, "len": len(synth)}]
    # Degradation guard: if the model returned essentially nothing usable
    # (no real title AND no item specifics AND no selling points AND no
    # fitment), flag the result instead of silently returning a placeholder
    # "Auto Part" listing the seller might publish by mistake.
    #
    # Placeholder-specifics filter (mirrors lib/listing.js): _fallback_specifics
    # always pushes Brand=Unbranded + Warranty=Does Not Apply (eBay-required
    # defaults), so a naked-empty package still has 2 specifics rows and the
    # naive `not specifics_final` check would never fire. Filter those
    # placeholder values before counting real rows.
    _PLACEHOLDER_SPEC_VALUES = {"Unbranded", "Does Not Apply"}
    _real_spec_count = sum(
        1 for _, v in (specifics_final or []) if (v or "").strip() not in _PLACEHOLDER_SPEC_VALUES
    )
    degraded = (
        ((not titles) or (len(titles) == 1 and titles[0]["text"] == "Auto Part"))
        and _real_spec_count == 0
        and (not bullets)
        and fitment == "-"
    )
    result = {
        "ok": False if degraded else True, "model": model, "seconds": round(secs, 1), "tokens": tokens,
        "titles": titles,
        "specifics": specifics_final,
        "fitment": fitment,
        "bullets": bullets,
        "description": desc,
        "package_includes": pkg_includes,
        "category": category,
        "html": build_html(titles[0]["text"] if titles else "", fitment, bullets, desc, specifics_final, pkg_includes),
        "notes": notes,
        "verify": ver,
    }
    if degraded:
        result["warning"] = (
            "⚠️ Model returned too little usable content — please regenerate. "
            "Verify the source package contains a SKU / part number / vehicle fitment."
        )
    return result


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
