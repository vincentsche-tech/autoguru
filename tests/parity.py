#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cross-language parity check: lib/listing.js (JS, production) vs server.py (Python mirror).

Both runtimes must produce FULL-MATCH output for the same (pkg, llm) fixtures.
The JS side is the source of truth (Vercel/Cloudflare use lib/listing.js); the
Python mirror (server.py) is the local dev worker. Any divergence is a bug.

Run:  python tests/parity.py
"""
import json
import os
import subprocess
import sys
import importlib.util
from pathlib import Path
from urllib.request import pathname2url

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
NODE = r"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe"
LIB_JS = (ROOT / "lib" / "listing.js").as_uri()
MJS = HERE / "_parity_js.mjs"
FIX = HERE / "_parity_fixtures.json"
JS_OUT = HERE / "_parity_js_out.json"

# ----------------------------------------------------------------------------
# Fixtures (mirrored from tests/selftest.js so parity tracks the same regressions)
# ----------------------------------------------------------------------------
POL_PKG = "\n".join([
    "Front Differential Replacement for Polaris Ranger Sportsman 400 500 800 Scrambler #1332731",
    "OEM Part Number: 1332731, 1332773, 1332829, 1332971, 1333066, 1333393, 1332956, 1332478, 1333067, 1332578, 1332772, 1332567, 1332344, 1333213",
    "Fit For the Following Models",
    "Fit for 2010 - 2011 Military Ranger Crew",
    "Fit for 2010 - 2014 Ranger 400 HO",
    "Fit for 2009 - 2013 Ranger 500 / 500 Crew Midsize",
    "Fit for 2014 - 2023 Sportsman 570 EFI all models",
    "Fit for 2007 - 2013 Sportsman 500 EFI / Sportsman 500 HO",
])
POL_LLM_WEAK = """1. Three Cassini-optimized titles
* Auto Part for 2007-2013 Sportsman EFI
2. Item Specifics
* Brand: Unbranded
* Warranty: Does Not Apply
3. Fitment
* 2010-2014 Polaris Ranger 400 HO
4. Five bullet selling points
* Built for Polaris ATV front differential replacement.
5. Description first paragraph
Front differential replacement for Polaris Ranger and Sportsman models.
6. Package Includes
* 1x Front Differential
7. Suggested eBay category path
-- verify in the eBay Sell flow before publishing.
8. Notes to Seller
* None"""
POL_LLM_GOOD = """1. Three Cassini-optimized titles
* Front Differential for Polaris Ranger Sportsman 400 500 800 Scrambler #1332731
* Front Diff Replacement Polaris Ranger Sportsman 400 500 800 #1332731
* Polaris Front Differential Assembly Ranger Sportsman 400 500 800 EFI 1332731
2. Item Specifics
* Brand: Unbranded
* OEM Part Number: 1332731, 1332773, 1332829
* Type: Differential
* Warranty: Does Not Apply
3. Fitment
* 2010-2014 Polaris Ranger 400 HO
4. Five bullet selling points
* Direct-fit Polaris front differential.
5. Description first paragraph
Front differential for Polaris Ranger Sportsman.
6. Package Includes
* 1x Front Differential
7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Differentials & Parts
8. Notes to Seller
* None"""

CL_PKG = "\n".join([
    "1x Clutch Disc",
    "1x Pressure Plate",
    "1x Release Bearing",
    "Application",
    "Fit for Hyundai Accent 2012-2019",
    "Fit for Hyundai Veloster 2012-2017",
    "Fit for Kia Rio 2012-2018",
    "Fit for Kia Soul 2010-2018",
    "Interchange Part Number:",
    "41300-26010, 41100-26010, 41421-32000",
    "OEM Part Number:",
    "41300-26010",
    "Brand: Unbranded",
    "Placement on Vehicle: Front",
    "Notice:",
    "- Professional installation is highly recommended.",
])
CL_ECHO_LLM = """1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
-- verify in the eBay Sell flow before publishing.
8. Notes to Seller"""

BL_PKG = "\n".join([
    "Heater Blower Motor w/Fan fit for Ford Bronco F-150 F-250 F-350 1987-1996 F2TZ18527A",
    "Application",
    "fit for Ford Bronco 1987-1996",
    "fit for Ford F150 1987-1996",
    "fit for Ford F250 1987-1996",
    "fit for Ford F350 1987-1996",
    "Reference OE/OEM Number",
    "700146, 40136-M, BN367, BM0249C, 3010133, F2TZ18527A, FOTZ18504A",
    "Specification",
    "Color: As the picture shows",
    "Type: Standard",
    "Material: Plastic + Metal",
    "Feature",
    "1. Superior materials and durability",
    "4. Heater Blower Motor is made of high-quality material which is reliability, and durable.",
    "Package included",
    "1x Heater Blower Motor",
])
BL_ECHO_LLM = """1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
— verify in the eBay Sell flow before publishing.
8. Notes to Seller"""

PSP_PKG = """Power Steering Pump 20-282P1 for Ford F150 F250 Expedition Crown Victoria
Reference OE/OEM Number
20-282P1, F65Z3A674AA, F85Z3A674AA, F85Z3A674AARM, F85Z3A674ABRM, 20282, 20-282
Material: Iron
Type: Power Steering Pump"""
PSP_HYBRID = "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Steering & Suspension > Power Steering Pumps — verify in the eBay Sell flow before publishing."
PSP_LLM = f"""1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
{PSP_HYBRID}
8. Notes to Seller"""

FIXTURES = [
    {"name": "polaris_weak", "pkg": POL_PKG, "llm": POL_LLM_WEAK},
    {"name": "polaris_good", "pkg": POL_PKG, "llm": POL_LLM_GOOD},
    {"name": "clutch_all_echo", "pkg": CL_PKG, "llm": CL_ECHO_LLM},
    {"name": "blower_all_echo", "pkg": BL_PKG, "llm": BL_ECHO_LLM},
    {"name": "psp_hybrid", "pkg": PSP_PKG, "llm": PSP_LLM},
]

FIELDS = ["title", "category", "fitment", "type", "ok"]


def run_js():
    FIX.write_text(json.dumps(FIXTURES), encoding="utf-8")
    r = subprocess.run(
        [NODE, str(MJS), str(FIX), str(JS_OUT), LIB_JS],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print("NODE FAILED:\n" + r.stderr)
        sys.exit(2)
    return {x["name"]: x for x in json.loads(JS_OUT.read_text(encoding="utf-8"))}


def run_py():
    spec = importlib.util.spec_from_file_location("server", str(ROOT / "server.py"))
    server = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(ROOT))
    # Avoid the real HTTP server binding; we only exercise api_generate().
    spec.loader.exec_module(server)
    os.environ["GEMINI_API_KEY"] = "stub"
    state = {}

    def fake_call(model, key, prompt):
        return {
            "candidates": [{"content": {"parts": [{"text": state["llm"]}]}}],
            "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
        }

    server.gem_call = fake_call
    server.MODELS = ["stub"]
    out = {}
    for fx in FIXTURES:
        state["llm"] = fx["llm"]
        res = server.api_generate(fx["pkg"])
        typev = ""
        for k, v in (res.get("specifics") or []):
            if k == "Type":
                typev = v
        out[fx["name"]] = {
            "title": (res["titles"][0]["text"] if res.get("titles") else ""),
            "category": res.get("category", ""),
            "fitment": res.get("fitment", ""),
            "type": typev,
            "halluc": (res.get("verify") or {}).get("hallucinated", []),
            "ok": res.get("ok"),
        }
    return out


def main():
    js = run_js()
    py = run_py()
    mismatch = 0
    for fx in FIXTURES:
        n = fx["name"]
        j, p = js[n], py[n]
        for fld in FIELDS:
            if j[fld] != p[fld]:
                print(f"MISMATCH [{n}] {fld}:\n   JS={j[fld]!r}\n   PY={p[fld]!r}")
                mismatch += 1
        if j["halluc"] != p["halluc"]:
            print(f"MISMATCH [{n}] halluc:\n   JS={j['halluc']!r}\n   PY={p['halluc']!r}")
            mismatch += 1
    if mismatch:
        print(f"\nPARITY FAILED: {mismatch} field mismatch(es) across {len(FIXTURES)} fixtures")
        sys.exit(1)
    print(f"PARITY OK: {len(FIXTURES)} fixtures FULL-MATCH (JS lib/listing.js == Python server.py)")
    # Cleanup temp artifacts.
    for f in (FIX, JS_OUT):
        try:
            f.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
