// Offline self-test: run the Pages Function core against a real supplier
// package and a real model output, and assert it matches the Python pipeline.
//   node tests/selftest.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildWhitelist, verifyOutput, splitSections, listItems, kvItems, fitmentLines, para, buildHtml, buildPrompt, buildResult } from "../lib/listing.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(
  readFileSync(
    "D:/workbuddy space/cross-border-lister/scripts/sku72117963_package.json",
    "utf-8"
  )
);
const pkgText = `${PKG.title_en}\n${PKG.description_text}`;

// Real v1.3 8-section output shape (numbers all exist in the package).
const LLM = `1. Three Cassini-optimized titles
* Front Lower Control Arm Set for 2015-2020 Ford F150 Limited K643168 K643169
* 2pc Front Lower Control Arm Kit for 15-20 Ford F150 Limited Replacement 527-027
* Front Left & Right Lower Control Arms for 2015-2020 Ford F150 Limited Pair
2. Item Specifics
* Brand: Unbranded
* MPN: K643168, K643169
* Interchange Part Number: 527027, 527-027, K643168, K643169, CB86044PR, GS401206, RK643169
* Placement on Vehicle: Front, Lower, Left, Right
* Material: Iron
* Type: Control Arm
3. Fitment
* 2015-2020 Ford F-150 Limited (Front Left & Right)
4. Five bullet selling points
* Complete 2-piece front lower control arm set for a total suspension refresh.
* Premium high-strength iron build justifies the upgrade over generic replacements.
5. Description first paragraph
Upgrade your F-150's handling with this premium 2-piece front lower control arm set (K643168/K643169) for the 2015-2020 Ford F-150 Limited.
6. Package Includes
* 2x Front Lower Control Arm (Left & Right)
7. Suggested eBay category path
eBay Motors > Parts & Accessories > Suspension & Steering > Control Arms & Parts
8. Notes to Seller
* The data package lists CB86043PR and CB86044PR as interchange numbers; PR may denote a pair.
* Package category says suspension and steering system which matches the product type.`;

let pass = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label} ${extra}`);
    process.exitCode = 1;
  }
};

console.log("\n[1] parsing");
const sec = splitSections(LLM);
ok("8 sections found", Object.keys(sec).length === 8, JSON.stringify(Object.keys(sec)));
ok("3 titles", listItems(sec[1]).length === 3);
ok("6 specifics", kvItems(sec[2]).length === 6);
ok("fitment parsed", listItems(sec[3])[0].startsWith("2015-2020"));
ok("2 bullets", listItems(sec[4]).length === 2);
ok("1 package-include", listItems(sec[6]).length === 1);
ok("category path", para(sec[7]).includes("Suspension & Steering"));
ok("2 notes", listItems(sec[8]).length === 2);

console.log("\n[2] whitelist / hallucination guard");
const wl = buildWhitelist(PKG.title_en, PKG.description_text);
ok("whitelist non-empty", wl.length > 0, `got ${wl.length}`);
const ver = verifyOutput(PKG.title_en, pkgText, LLM);
ok("no false hallucination", ver.hallucinated.length === 0, JSON.stringify(ver));
ok("matched == total", ver.matched === ver.total, JSON.stringify(ver));
console.log(`       package numbers: ${wl.length} | model claimed: ${ver.total}`);

// The exact failure mode the guard exists for (AC1550100 invented by an earlier run)
const HALL = LLM.replace("RK643169", "RK643169, AC1550100");
const ver2 = verifyOutput(PKG.title_en, pkgText, HALL);
ok("invented number caught", ver2.hallucinated.includes("AC1550100"), JSON.stringify(ver2));

// Hyphen variants must not false-positive (BR3Z-9E926-A vs BR3Z9E926A)
const HYPH = LLM.replace("K643168", "K643-168");
ok("hyphen variant accepted", verifyOutput(PKG.title_en, pkgText, HYPH).hallucinated.length === 0);

// Watermark and Category ID must be scrubbed before checking
const WM = LLM + "\nAuthority ID：MXR02FXSY\nCategory ID: 179697";
ok("watermark/ID scrubbed", verifyOutput(PKG.title_en, pkgText, WM).hallucinated.length === 0);

// Noise filtering: year ranges and spec-with-unit are not part numbers
ok("year range ignored", !buildWhitelist("Ford", "fits 2015-2020 F-150").includes("2015-2020"));
ok("unit spec ignored", !buildWhitelist("Bolt", "length 35MM torque 88LB").some((n) => /35MM|88LB/.test(n)));

console.log("\n[3] html + prompt");
const r = buildResult(pkgText, LLM, "gemini-3.1-flash-lite", 8.4, "582/657");
for (const block of [
  "<h2>",
  "Fitment / Compatibility",
  "Specifications",
  "Features",
  "Package Includes",
  "Note:",
]) {
  ok(`html has ${block}`, r.html.includes(block));
}
ok("html escaped (no raw <script>)", !/<script/i.test(r.html));
ok("title length reported", r.titles[0].len === r.titles[0].text.length);
ok("category filled", r.category.includes("Suspension"));
const prompt = buildPrompt(pkgText);
ok("prompt placeholders replaced", !/\{(sku|title|desc|dims|category)\}/.test(prompt));
ok("prompt carries package", prompt.includes("DATA PACKAGE"));

// XSS: a supplier string containing markup must not break out of the HTML block
const evil = buildResult(
  "<img src=x onerror=alert(1)>\n" + pkgText,
  LLM,
  "m",
  1,
  "0/0"
);
ok("supplier markup escaped", !/<img src=x/.test(evil.html));

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}\n`);

// =====================================================================
// Real-world captured bug: SKU 30867593 (Mercedes-Benz GLC shock strut)
// Symptom: titles list empty, Item Specifics only one blank row, fitment
// rendered as one huge unsplit line. Captured by user from the live Vercel
// deployment. After this fix the parser must recover all three sections.
// =====================================================================
console.log("\n[4] real-world: GLC bunched-fitment recovery");
const GLC = `1. Three Cassini-optimized titles
1) Front Shock Strut Pair for 2016-2021 Mercedes-Benz W253 GLC300
2) 2pcs Front Shock Strut Assemblies Fit for W253 GLC 2533200330
3) Front Shocks & Struts Left Right for 2017-2021 Mercedes GLC
2. Item Specifics
* Brand: Unbranded
* MPN: Does Not Apply
* OEM Part Number: Does Not Apply
* Interchange Part Number: 2533200330, 2533200430, 2533200530, 2533200630
* Placement on Vehicle: Front, Left, Right
* Material: Iron
* Type: Shock Absorber
* Manufacturer Part Number: 2533200330
* Fitment Type: Direct Replacement
* Warranty: 1 Year
3. Fitment
2016-2020 Mercedes-Benz GLC 300 4Matic Base Front Left/Right 2018-2020 Mercedes-Benz GLC 350e 4Matic Front Left/Right 2017-2020 Mercedes-Benz GLC 43 AMG 4Matic Front Left/Right 2018-2020 Mercedes-Benz GLC 63 AMG 4Matic Front Left/Right 2018-2020 Mercedes-Benz GLC 63 S AMG 4Matic Front Left/Right
4. Five bullet selling points
* Engineered for exact compatibility with W253 chassis GLC300, GLC43, GLC63 AMG.
* Robust construction designed for rigorous performance demands.
5. Description first paragraph
Restore the precision handling and safety of your Mercedes-Benz W253 with this pair of front shock strut assemblies, engineered to replace OEM 2533200330 and 2533200430.
6. Package Includes
* 2x Front Shock Strut Assembly
7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Shocks & Struts
8. Notes to Seller
* None`;

// Use the same verify path against a minimal but real-looking package so
// the GLC OEM numbers are considered "in the package".
const glcPkg = `Front Pair Shock Absorber Strut Assembly for Mercedes-Benz W253\nInterchange: 2533200330 2533200430 2533200530 2533200630`;
const sec4 = splitSections(GLC);
ok("GLC sections: all 8 present", Object.keys(sec4).length === 8, JSON.stringify(Object.keys(sec4)));
ok("GLC titles: numbered 1) 2) 3) captured", listItems(sec4[1]).length === 3, JSON.stringify(listItems(sec4[1])));
ok("GLC titles: not over 80 chars", listItems(sec4[1]).every((t) => t.length <= 80));
ok("GLC specifics: 9 rows captured (MPN + Manufacturer Part Number merged)", kvItems(sec4[2]).length === 9, JSON.stringify(kvItems(sec4[2])));
const fits = fitmentLines(sec4[3]);
ok("GLC fitment: bunched line sliced to 5 vehicles", fits.length === 5, JSON.stringify(fits));
ok(
  "GLC fitment: every slice mentions GLC",
  fits.every((f) => /GLC/.test(f)),
  JSON.stringify(fits)
);
ok("GLC bullets: 2 captured", listItems(sec4[4]).length === 2);
ok("GLC pkg-includes: 2x Shock Strut captured", listItems(sec4[6])[0].includes("2x"));
ok("GLC category: Shocks & Struts", /Shocks\s*&\s*Struts/.test(para(sec4[7])));
ok("GLC notes: None filtered out", listItems(sec4[8]).length === 0);

// Full e2e through buildResult
const rGLC = buildResult(glcPkg, GLC, "gemini-3.1-flash-lite", 4.5, "700/450");
ok("GLC e2e: titles populated", rGLC.titles.length === 3);
ok("GLC e2e: specifics table populated", rGLC.specifics.length === 9);
ok("GLC e2e: fitment has 5 vehicles", /GLC 300|GLC 350e|GLC 43 AMG|GLC 63 AMG|GLC 63 S/.test(rGLC.fitment) && rGLC.fitment.split(/;\s*/).filter(Boolean).length === 5);
ok(
  "GLC e2e: html contains all 5 fitments",
  ["GLC 300", "GLC 350e", "GLC 43 AMG", "GLC 63 AMG", "GLC 63 S"].every((m) => rGLC.html.includes(m))
);
ok(
  "GLC e2e: html tables Warranty",
  rGLC.html.includes("Warranty")
);
ok("GLC e2e: no part-number hallucination", rGLC.verify.hallucinated.length === 0, JSON.stringify(rGLC.verify));

// Bold-label format that Gemini also produces sometimes
console.log("\n[5] bold-label section 2 fallback");
const BOLD = `2. Item Specifics
**Brand:** Unbranded
**MPN:** Does Not Apply
**Placement on Vehicle:** Front, Left, Right
**Type:** Shock Absorber`;
const secB = splitSections(BOLD);
const kvBold = kvItems(secB[2] || "");
ok("bold-label: 4 rows captured", kvBold.length === 4, JSON.stringify(kvBold));
ok("bold-label: Brand row ok", kvBold[0][0] === "Brand" && kvBold[0][1] === "Unbranded");

// ----- SKU 14459377 regression: model regurgitated the prompt instructions
// inside sections 2/3/4 (e.g. "2. Item Specifics. One attribute per line as
// '** <Label>: <value>'. Cover Brand, MPN, ..."). Parser must strip those
// echo lines and only emit real KV / fitment / titles.
console.log("\n[6] prompt-instruction echo rejection (SKU 14459377)");
const ECHO = `1. Three Cassini-optimized titles
2. Item Specifics. One attribute per line as "* <Label>: <value>". Cover Brand, MPN, OEM Part Number, Interchange Part Number, Placement on Vehicle, Material, Type, Manufacturer Part Number, Fitment Type. Include Warranty ONLY if the data package states one, otherwise write "* Warranty: Does Not Apply" (do not omit the field). Do not wrap labels in markdown bold.
* Brand: Unbranded
* MPN: Does Not Apply
* OEM Part Number: 88981548, 12472876, 15703702
* Interchange Part Number: 88981548, 12472876, 15703702
* Placement on Vehicle: Front, Right
* Material: Not specified
* Type: Door Armrest Handle
* Manufacturer Part Number: 88981548, 12472876, 15703702
* Fitment Type: Direct Replacement
* Warranty: Does Not Apply
3. Fitment. One vehicle line per "* " entry: "* <Year-Range Make Model Trim (Side)>". Every distinct fitment from the package goes on its own line — never merge into one prose sentence.
* 1999-2006 Chevy Suburban (Front Right)
* 1999-2006 Chevy Tahoe (Front Right)
* 1999-2006 Cadillac Escalade (Front Right)
* 1999-2006 Chevy Avalanche (Front Right)
* 1999-2006 GMC Yukon (Front Right)
4. Five bullet selling points (benefit-driven, premium tone, based only on the package). Each as "* <point>".
* Restore your factory interior styling with this direct-fit door armrest handle.
5. Description first paragraph (2-3 sentences, benefit-driven, no external links; naturally work in the main part number(s) and year/make/model; no keyword stuffing). Plain text, no bullet.
Black Door Armrest Handle Front Right Fit for Chevy Avalanche Suburban Tahoe Cadillac Escalade GMC Yukon 1999-2006 88981548 12472876 15703702.
6. Package Includes. One item per "* " line; if the package does not state a list, write "* None".
* 1x Door Armrest Handle
7. Suggested eBay category path on a single line as plain text.
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Interior Door Handles & Parts
8. Notes to Seller. One concern per "* " line.
* None`;
const echoPkg = `Black Door Armrest Handle Front Right Fit for Chevy Avalanche Suburban Tahoe Cadillac Escalade GMC Yukon 1999-2006\nInterchange: 88981548 12472876 15703702\nFitment: 1999-2006 Chevy Suburban Front Right 1999-2006 Chevy Tahoe Front Right 1999-2006 Cadillac Escalade Front Right 1999-2006 Chevy Avalanche Front Right 1999-2006 GMC Yukon Front Right`;
const rEcho = buildResult(echoPkg, ECHO, "gemini-3.1-flash-lite", 3.2, "600/500");
ok("Echo: titles empty (model never wrote them — better than echoing the rule)", rEcho.titles.length === 0, JSON.stringify(rEcho.titles));
ok("Echo: specs all real eBay fields, no rule text leaking", rEcho.specifics.every(([k, v]) => /^(Brand|MPN|OEM Part Number|Interchange Part Number|Placement on Vehicle|Material|Type|Manufacturer Part Number|Fitment Type|Warranty)$/.test(k)));
ok("Echo: no spec value is prompt instruction text", rEcho.specifics.every(([k, v]) => !/Cover Brand|One attribute per line/i.test(v)));
ok("Echo: 9 spec rows from a 9 distinct field source", rEcho.specifics.length === 9, JSON.stringify(rEcho.specifics));
ok("Echo: fitment has 5 vehicles from a single bunched section", rEcho.fitment.split(/;\s*/).filter(Boolean).length === 5);
ok("Echo: bullets contain real selling point (no rule echo)", rEcho.bullets.length >= 1 && !/benefit[- ]driven/i.test(rEcho.bullets[0] || ""));
ok("Echo: description is plain prose, no rule text", /Door Armrest Handle|88981548/.test(rEcho.description) && !/One attribute per line|benefit[- ]driven/i.test(rEcho.description));
ok("Echo: category path surfaces Interior Door Handles", /Interior Door Handles/.test(rEcho.category));
ok("Echo: notes is empty after stripping None-echo", rEcho.notes.length === 0);
ok("Echo: verify passes (no hallucinated numbers)", rEcho.verify.hallucinated.length === 0, JSON.stringify(rEcho.verify));
ok("Echo: html is clean of rule text", !/One attribute per line|benefit[- ]driven|Cover Brand/i.test(rEcho.html));

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
