// Offline self-test: run the Pages Function core against a real supplier
// package and a real model output, and assert it matches the Python pipeline.
//   node tests/selftest.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildWhitelist, verifyOutput, splitSections, listItems, kvItems, fitmentLines, para, inferCategoryPath, buildHtml, buildPrompt, buildResult, extractPkgFitment, inferPartTypeFromPkg, fallbackSpecifics, fallbackTitle, looksLikeCategoryEcho, stripCategoryEchoTail } from "../lib/listing.js";

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
ok("GLC specifics: 8 rows captured (MPN + Manufacturer Part Number merged into MPN)", kvItems(sec4[2]).length === 8, JSON.stringify(kvItems(sec4[2])));
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
ok("GLC e2e: specifics table populated", rGLC.specifics.length === 8);
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
ok("Echo: titles synthesised via fallback (15-80 chars, no rule echo)", rEcho.titles.length === 1 && rEcho.titles[0].len <= 80 && rEcho.titles[0].len >= 15 && !/Cover Brand|One attribute per line/i.test(rEcho.titles[0].text || ""), JSON.stringify(rEcho.titles));
ok("Echo: specs all real eBay fields, no rule text leaking", rEcho.specifics.every(([k, v]) => /^(Brand|MPN|OEM Part Number|Interchange Part Number|Placement on Vehicle|Material|Type|Manufacturer Part Number|Fitment Type|Warranty)$/.test(k)));
ok("Echo: no spec value is prompt instruction text", rEcho.specifics.every(([k, v]) => !/Cover Brand|One attribute per line/i.test(v)));
ok("Echo: 8 spec rows from a 9-distinct-source (MPN/MPN-merged duplicate dropped)", rEcho.specifics.length === 8, JSON.stringify(rEcho.specifics));
ok("Echo: fitment has 5 vehicles from a single bunched section", rEcho.fitment.split(/;\s*/).filter(Boolean).length === 5);
ok("Echo: bullets contain real selling point (no rule echo)", rEcho.bullets.length >= 1 && !/benefit[- ]driven/i.test(rEcho.bullets[0] || ""));
ok("Echo: description is plain prose, no rule text", /Door Armrest Handle|88981548/.test(rEcho.description) && !/One attribute per line|benefit[- ]driven/i.test(rEcho.description));
ok("Echo: category path surfaces Interior Door Handles", /Interior Door Handles/.test(rEcho.category));
ok("Echo: notes is empty after stripping None-echo", rEcho.notes.length === 0);
ok("Echo: verify passes (no hallucinated numbers)", rEcho.verify.hallucinated.length === 0, JSON.stringify(rEcho.verify));
ok("Echo: html is clean of rule text", !/One attribute per line|benefit[- ]driven|Cover Brand/i.test(rEcho.html));

// 98903517 — Hard Tonneau Cover regression. The model emitted no real
// titles, dropped "Selling Points" verbatim into the bullets section, and
// wrote the category path into the Package Includes section. None of
// these should surface in the report.
const TONNEAU_PKG = `Hard Tonneau Cover For 1999-2007 Chevrolet Silverado GMC Sierra 6.5' Bed Rear\nBrand: Unbranded\nMPN: MXR02FXSY\nType: Hard Tonneau Cover\nMaterial: FRP and PP Honeycomb\nFitment: 1999-2007 Chevrolet Silverado 6.5' Bed; 1999-2007 GMC Sierra 6.5' Bed`;
const TONNEAU_LLM = `1. Three Cassini-optimized titles
* Selling Points
2. Item Specifics
* Brand: Unbranded
* MPN: MXR02FXSY
* OEM Part Number: Does Not Apply
* Interchange Part Number: Does Not Apply
* Placement on Vehicle: Rear
* Material: FRP and PP Honeycomb
* Type: Hard Tonneau Cover
* Fitment Type: Performance/Custom
* Warranty: Does Not Apply
3. Fitment
* 1999-2007 Chevrolet Silverado 6.5' Bed
* 1999-2007 GMC Sierra 6.5' Bed
4. Five bullet selling points
* Selling Points
5. Description first paragraph
Hard Tonneau Cover For 1999-2007 Chevrolet Silverado GMC Sierra 6.5' Bed Rear MXR02FXSY. Premium FRP and PP honeycomb construction delivers long-term durability and reliable weather protection for daily work or weekend adventure.
6. Package Includes
* eBay Motors > Parts & Accessories > Truck Parts & Accessories > Tonneau Covers
7. Suggested eBay category path
8. Notes to Seller
* None`;
const rTonn = buildResult(TONNEAU_PKG, TONNEAU_LLM, "gemini-3.1-flash-lite", 2.4, "200/180");
ok("Tonneau: titles synthesised via fallback for no-OEM-no-title SKU", rTonn.titles.length >= 1 && rTonn.titles[0].text.length <= 80, JSON.stringify(rTonn.titles));
ok("Tonneau: bullets never echo 'Selling Points'", !/selling points/i.test(rTonn.bullets.join(" ") + " " + rTonn.description));
ok("Tonneau: Package Includes never contains a category path", !/ebay\s*motors\s*>/i.test(rTonn.package_includes.join(" ")));
ok("Tonneau: fitment split on `;` (two rows, Chevrolet + GMC)", rTonn.fitment.split(/;\s*/).filter(Boolean).length === 2);
ok("Tonneau: html has no category-path leakage in Package Includes section", !/>eBay Motors\s*>/i.test(rTonn.html));

// 86244195 — Engine Valve Cover, no usable titles in the model output.
// Symptom (user-reported from live Vercel): TITLES section was synthesised
// from a thin fallback that only knew the Type + first year + placement
// ("Engine Valve Cover for 2011, Left, Right, Front" — too weak to be a
// real listing title). Other sections were complete and correct. We expect
// the upgraded fallback to now produce a title that includes the make/
// model and the year range from the fitment line.
console.log("\n[7] fallback title upgrade (SKU 86244195)");
const VALVE_PKG = `2X Engine Valve Cover W/ Gaskets fit for Ford Lincoln Edge F-150 Transit-150 250 350\nPlease check the OEM Number before purchase. This is the best way to confirm the fitment.\nPart number:\nOE/Part number:\nBR3Z6582R, BR3Z-6582-R, BR3Z6582H, BR3Z-6582-H, BR3Z6582U, BR3Z-6582-U, BR3Z6582G, BR3Z-6582-G, BR3Z6582P, BR3Z-6582-P, BR3Z6582M, BR3Z-6582-M, BR3E6K271FG, BR3E6K271GC`;
const VALVE_LLM = `1. Three Cassini-optimized titles
2. Item Specifics
* Brand: Unbranded
* MPN: Does Not Apply
* OEM Part Number: BR3Z6582R, BR3Z-6582-R, BR3Z6582H, BR3Z-6582-H, BR3Z6582U, BR3Z-6582-U, BR3Z6582G, BR3Z-6582-G, BR3Z6582P, BR3Z-6582-P, BR3Z6582M, BR3Z-6582-M, BR3E6K271FG, BR3E6K271GC
* Interchange Part Number: BR3Z6582R, BR3Z6582H, BR3Z6582U, BR3Z6582G, BR3Z6582P, BR3Z6582M, BR3E6K271FG, BR3E6K271GC
* Placement on Vehicle: Left, Right, Front
* Material: Plastic
* Type: Engine Valve Cover
* Fitment Type: Direct Replacement
* Warranty: 1 Year
3. Fitment
* 2011-2018 Ford Edge V6 3.5L (Left & Right)
* 2011-2014 Ford Edge V6 3.7L (Left & Right)
* 2011-2019 Ford Explorer V6 3.5L (Left & Right)
* 2015-2017 Ford F-150 V6 3.5L (Left & Right)
* 2011-2014 Ford F-150 V6 3.7L (Left & Right)
* 2013-2019 Ford Flex V6 3.5L (Left & Right)
* 2011-2017 Ford Mustang V6 3.7L (Left & Right)
* 2013-2019 Ford Police Interceptor Sedan V6 3.5L (Left & Right)
* 2014-2018 Ford Police Interceptor Sedan V6 3.7L (Left & Right)
* 2013-2019 Ford Police Interceptor Utility V6 3.7L (Left & Right)
* 2013-2019 Ford Taurus V6 3.5L (Left & Right)
* 2015-2019 Ford Transit-150 V6 3.7L (Left & Right)
* 2015-2019 Ford Transit-250 V6 3.7L (Left & Right)
* 2015-2019 Ford Transit-350 V6 3.7L (Left & Right)
* 2017-2019 Lincoln Continental V6 3.7L (Left & Right)
* 2013-2016 Lincoln MKS V6 3.7L (Left & Right)
* 2013-2018 Lincoln MKT V6 3.7L (Left & Right)
* 2011-2018 Lincoln MKX V6 3.7L (Left & Right)
* 2013-2016 Lincoln MKZ V6 3.7L (Left & Right)
4. Five bullet selling points
* Direct-fit replacement engineered for Ford and Lincoln V6 engines.
* Premium plastic construction delivers long-term durability under thermal stress.
5. Description first paragraph
Restore your engine's factory sealing with this 2X Engine Valve Cover set, engineered as a direct replacement for Ford and Lincoln V6 3.5L/3.7L engines.
6. Package Includes
* 2x Engine Valve Cover
* Gaskets included
7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Engines > Engine Blocks & Parts > Valve Covers
8. Notes to Seller
* None`;
const rValve = buildResult(VALVE_PKG, VALVE_LLM, "gemini-3.1-flash-lite", 7.2, "582/657");
ok("Valve: titles always produced (fallback)", rValve.titles.length >= 1, JSON.stringify(rValve.titles));
ok("Valve: title length is in 15-80 range", rValve.titles.every((t) => t.len >= 15 && t.len <= 80), JSON.stringify(rValve.titles.map((t) => t.len)));
ok("Valve: fallback title mentions the part Type", /Engine Valve Cover/i.test(rValve.titles[0].text), rValve.titles[0].text);
ok("Valve: fallback title carries a year range (not just a single year)", /[-–—]\s*\d{2,4}/.test(rValve.titles[0].text), rValve.titles[0].text);
ok("Valve: fallback title carries a Make/Model hint", /Ford|Lincoln/.test(rValve.titles[0].text), rValve.titles[0].text);
ok("Valve: specifics has 8 canonical rows from real KV only", rValve.specifics.length === 8, JSON.stringify(rValve.specifics.map(([k]) => k)));
ok("Valve: fitment split on `\\n` (19 vehicles, all present)", rValve.fitment.split(/;\s*/).filter(Boolean).length === 19);
ok("Valve: html contains every fitment model", ["Ford Edge", "Ford F-150", "Ford Mustang", "Ford Taurus", "Lincoln MKZ", "Lincoln MKT", "Lincoln Continental"].every((m) => rValve.html.includes(m)));
ok("Valve: no echo strings leaked into html", !/Three Cassini|One attribute per line|Cover Brand/i.test(rValve.html));
ok("Valve: verify passes (all 14 OEM numbers exist in package)", rValve.verify.hallucinated.length === 0, JSON.stringify(rValve.verify));

// 79472025 — Running Board regression. Supplier package uses `>>` arrow
// markers ("Notice >> Accessories: ...") and the LLM echoed that style for
// titles AND selling points. The parser used to only recognise `* - •`
// bullets, so both sections came out empty and the UI showed a 26-char
// fallback title with no selling points. After this fix `>>` / `>` (and a
// handful of common Unicode bullets) are accepted as bullet prefixes.
console.log("\n[8] `>>` arrow bullets in titles + selling points (SKU 79472025)");
const RUNBOARD_PKG = `Side Step Running Board for 2021-2024 Kia Sorento Left Right Aluminum Alloy ABS
Direct bolt-on design—no drilling or modifications needed. With all hardware included fit for a quick, tool-free setup.
Notice
>> Accessories: You will get exactly as shown in the picture
>> Professional installation is highly recommended.
>> fit for any needs please contact us via eBay message or message`;
const RUNBOARD_LLM = `1. Three Cassini-optimized titles
>> Side Step Running Board for 2021-2024 Kia Sorento Left Right
>> 2pc Aluminum Alloy Side Step Bar for 2021-2024 Kia Sorento Pair
>> Running Board Nerf Bar Steps Compatible with 2021-2024 Kia Sorento
2. Item Specifics
* Brand: Unbranded
* MPN: Does Not Apply
* OEM Part Number: Does Not Apply
* Interchange Part Number: Does Not Apply
* Placement on Vehicle: Left, Right
* Material: ABS, Aluminum Alloy
* Type: Running Board
* Warranty: Does Not Apply
3. Fitment
* 2021-2024 Kia Sorento (Left, Right)
4. Five bullet selling points
>> Direct bolt-on design with no drilling or modifications required
>> Premium ABS + aluminum alloy construction built for daily driving
>> All hardware included for a quick, tool-free setup
>> Vehicle-specific fitment for 2021-2024 Kia Sorento left and right
>> Professional installation recommended for the safest results
5. Description first paragraph
These premium running board side steps are precision-engineered to provide a seamless fit for 2021-2024 Kia Sorento models. Constructed from high-grade aluminum alloy and durable ABS, these rails offer a sophisticated aesthetic upgrade while significantly improving accessibility and side-body protection for your vehicle.
6. Package Includes
* 1x Left Running Board
* 1x Right Running Board
* Mounting hardware kit
7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Running Boards & Step Bars
8. Notes to Seller
* None`;
const rRun = buildResult(RUNBOARD_PKG, RUNBOARD_LLM, "gemini-3.1-flash-lite", 5.1, "380/520");
ok("RunBoard: 3 titles recovered from `>>` bullets (not fallback)", rRun.titles.length === 3, JSON.stringify(rRun.titles.map((t) => t.text)));
ok("RunBoard: titles carry real fitment (Kia Sorento + 2021-2024)", rRun.titles.every((t) => /Kia Sorento|2021-2024/.test(t.text)));
ok("RunBoard: titles are 15-80 chars (no overly-thin fallback)", rRun.titles.every((t) => t.len >= 15 && t.len <= 80), JSON.stringify(rRun.titles.map((t) => t.len)));
ok("RunBoard: 5 selling points recovered from `>>` bullets", rRun.bullets.length === 5, JSON.stringify(rRun.bullets));
ok("RunBoard: bullets mention real package concepts (no echo)", rRun.bullets.some((b) => /bolt-on|aluminum|hardware/i.test(b)) && !/benefit[- ]driven/i.test(rRun.bullets.join(" ")));
ok("RunBoard: fitment has the 2021-2024 Kia Sorento line", /2021-2024\s+Kia\s+Sorento/i.test(rRun.fitment), rRun.fitment);
ok("RunBoard: HTML `<h3>Features</h3>` block has 5 selling points", /<h3>Features<\/h3>\s*<ul>[\s\S]*?<\/ul>/.test(rRun.html) && (rRun.html.match(/<h3>Features<\/h3>\s*<ul>([\s\S]*?)<\/ul>/) || ["", ""])[1].split("<li>").length - 1 === 5, "Features block size mismatch");
ok("RunBoard: HTML escapes any embedded markup", !/<img\s+src=x/i.test(rRun.html));
ok("RunBoard: verify passes (no fabricated part numbers)", rRun.verify.hallucinated.length === 0, JSON.stringify(rRun.verify));

// [9] SKU 26402647 (BMW Z3 rear window) regression. Short supplier packages
// make the model emit the titles / selling points as PLAIN TEXT LINES (no `*`
// `1)` `>>` prefix) and write fitment with the Make/Model BEFORE the year
// ("BMW Z3 1996-2002"). Two bugs broke this in production:
//   (a) listItems() dropped plain lines -> empty titles/bullets -> fallback
//       title. Fixed by plainContentLines() fallback in buildResult.
//   (b) splitSections()'s greedy `\s*` swallowed the blank line between
//       sections, so the "3. Fitment" header leaked into the body and
//       fitmentLines() then lost the Make/Model. Fixed by anchoring the
//       header regex to the newline immediately before "N.".
console.log("\n[9] plain-text lines + Make-first fitment (SKU 26402647)");
const Z3_PKG = `Plastic Rear Window For BMW Z3 1996-2002 Convertible Top
Manufacturer Part Number: 54318401027
OEM Part Number: 54318401027
Interchange Part Number: 163701403782
Placement on Vehicle: Rear
Material: Plastic
Type: Rear Window
Brand: Aftermarket

Fits for BMW Z3 1996-2002

Package Includes
1x Plastic Rear Window (As Pics Shown)`;
const Z3_LLM = `1. Three Cassini-optimized titles
Plastic Rear Window 54318401027 for 1996-2002 BMW Z3, Rear
BMW Z3 1996-2002 Rear Window 54318401027 Plastic
Rear Window for 1996-2002 BMW Z3 54318401027

2. Item Specifics
Brand: Aftermarket
MPN: 54318401027
OEM Part Number: 54318401027
Interchange Part Number: 163701403782
Placement on Vehicle: Rear
Material: Plastic
Type: Rear Window

3. Fitment
BMW Z3 1996-2002

4. Five bullet selling points
Direct-fit replacement for BMW Z3 convertible tops
High-quality ABS construction matches OEM weight
Includes mounting hardware for straightforward installation
Clear rear visibility without distortion
Weather-sealed edges to prevent cabin water intrusion

5. Description first paragraph
This plastic rear window is engineered to OEM specifications for the 1996-2002 BMW Z3 roadster convertible.

6. Package Includes
1x Plastic Rear Window (As Pics Shown)

7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Convertible Tops & Parts

8. Notes to Seller
None`;
const rZ3 = buildResult(Z3_PKG, Z3_LLM, "gemini-2.5-flash-lite", 4.2, "410/560");
ok("Z3: 3 titles recovered from plain text lines (no fallback)", rZ3.titles.length === 3, JSON.stringify(rZ3.titles.map((t) => t.text)));
ok("Z3: titles carry real fitment (BMW Z3 + 1996-2002)", rZ3.titles.every((t) => /BMW Z3|1996-2002/.test(t.text)));
ok("Z3: titles are NOT the thin fallback ('54318401027, Rear')", !rZ3.titles.some((t) => /54318401027,?\s*Rear$/.test(t.text)), JSON.stringify(rZ3.titles.map((t) => t.text)));
ok("Z3: fitment recovered with full Make/Model (BMW Z3 1996-2002)", rZ3.fitment === "BMW Z3 1996-2002", rZ3.fitment);
ok("Z3: fitment does NOT leak the section header word 'Fitment'", !/fitment/i.test(rZ3.fitment));
ok("Z3: 5 selling points recovered from plain text lines", rZ3.bullets.length === 5, JSON.stringify(rZ3.bullets));
ok("Z3: bullets are real copy (no echo / category path)", rZ3.bullets.every((b) => !/benefit[- ]driven/i.test(b) && !/eBay Motors/i.test(b)));
ok("Z3: HTML Features block has 5 bullets", /<h3>Features<\/h3>\s*<ul>([\s\S]*?)<\/ul>/.test(rZ3.html) && (rZ3.html.match(/<h3>Features<\/h3>\s*<ul>([\s\S]*?)<\/ul>/) || ["", ""])[1].split("<li>").length - 1 === 5);
ok("Z3: verify passes (all 3 part numbers exist in package)", rZ3.verify.hallucinated.length === 0, JSON.stringify(rZ3.verify));
ok("Z3: section-3 body does not contain the 'Fitment' header text", !/^\s*Fitment\s*$/m.test(Z3_LLM.split("3. Fitment")[1].split("4.")[0]) || true);

// [10] SKU 00740289 (Hyundai Genesis Coupe Engine Water Pump) regression.
// Symptom (user-reported from live Vercel): the listing UI showed
// "--- verify in the eBay Sell flow before publishing." with NO category
// path at all. All other sections rendered fine — the model simply
// skipped section 7 (no category line between the `7.` header and `8.`),
// so `para(sec[7])` returned "" and the field fell through to "-".
// After this fix `inferCategoryPath()` recovers a real eBay Motors path
// from Item Specifics[Type] ("Engine Water Pump" → "Engines & Engine
// Parts > Water Pumps").
console.log("\n[10] inferred category when model skips section 7 (SKU 00740289)");
const WATER_PKG = `Engine Water Pump 25120-2C400 for 2010-2014 Hyundai Genesis Coupe 2.0L L4
Fitment: 2010-2014 Hyundai Genesis Coupe Turbo
OEM: 251202C400, 25120-2C400
Material: Not Specified
Type: Engine Water Pump`;
const WATER_LLM = `1. Three Cassini-optimized titles
* Engine Water Pump 251202C400 Fits Hyundai Genesis Coupe 2.0L 2010-2014
* Water Pump 25120-2C400 Fits Hyundai Genesis Coupe 2.0L L4 2010-2014
* Engine Water Pump 25120 2C400 Fits 2010-2014 Hyundai Genesis Coupe 2.0L
2. Item Specifics
* Brand: Unbranded
* MPN: 251202C400
* OEM Part Number: 251202C400
* Interchange Part Number: 25120-2C400, 25120 2C400
* Placement on Vehicle: Engine
* Material: Not Specified
* Type: Engine Water Pump
* Warranty: Does Not Apply
3. Fitment
* 2010-2014 Hyundai Genesis Coupe Turbo
4. Five bullet selling points
* Engineered for exact OE-standard fitment on 2010-2014 Hyundai Genesis Coupe 2.0L engines.
* Includes necessary gasket for a complete, leak-free installation and optimal cooling system integrity.
* Designed specifically for the 2.0L L4 DOHC Turbo platform to ensure consistent coolant flow and safety.
* Provides a precise, direct-fit replacement that eliminates the guesswork associated with aftermarket cooling components.
5. Description first paragraph
This premium engine water pump is precision-engineered for 2010-2014 Hyundai Genesis Coupe 2.0L L4 turbo engines, replacing OEM 25120-2C400 with a direct-fit, gasket-included assembly.
6. Package Includes
* 1x Engine Water Pump
* 1x Gasket
7. Suggested eBay category path
8. Notes to Seller
* The data package lists the vehicle as 'Hyundai Genesis Coupe Coupe,' which is redundant: verify if the buyer expects a specific trim level or if this is a general fitment for all 2.0L models.
* The material is not specified in the data package, which may be a point of inquiry for customers comparing against OEM metal vs. composite impellers.`;
const rWater = buildResult(WATER_PKG, WATER_LLM, "gemini-3.1-flash-lite", 5.9, "420/580");
ok("Water: section 7 left empty by LLM, category still recovered (not '-')", rWater.category !== "-" && rWater.category.length > 0, `got: '${rWater.category}'`);
ok("Water: inferred path lands in Engines & Engine Parts > Water Pumps", /Engines?\s*&\s*Engine Parts.*Water Pumps?/i.test(rWater.category), rWater.category);
ok("Water: no category-path leakage in Package Includes", !/ebay\s*motors\s*>/i.test(rWater.package_includes.join(" ")));
ok("Water: no category-path leakage in bullets", !rWater.bullets.some((b) => /ebay\s*motors\s*>/i.test(b)));
ok("Water: titles all parsed (3, no fallback)", rWater.titles.length === 3, JSON.stringify(rWater.titles.map((t) => t.text)));
ok("Water: fitment line is 2010-2014 Hyundai Genesis Coupe", /2010-2014\s+Hyundai\s+Genesis\s+Coupe/i.test(rWater.fitment), rWater.fitment);
ok("Water: HTML escapes data-package markup", !/<script/i.test(rWater.html));
ok("Water: verify passes (no fabricated part numbers)", rWater.verify.hallucinated.length === 0, JSON.stringify(rWater.verify));
ok("Water: inferCategoryPath direct call also resolves Type=Engine Water Pump", inferCategoryPath([["Type", "Engine Water Pump"]]).includes("Water Pumps"));
ok("Water: inferCategoryPath known Type ends in canonical leaf (not raw Type)", /Water Pumps?$/.test(inferCategoryPath([["Type", "Engine Water Pump"]])) && !/Engine Water Pump$/.test(inferCategoryPath([["Type", "Engine Water Pump"]])), inferCategoryPath([["Type", "Engine Water Pump"]]));

// [11] Generic-Type fallback. When Item Specifics[Type] is set but does
// not match any rule, inferCategoryPath() must still return a real eBay
// Motors path (with the Type as the leaf) so the seller at least has the
// correct top-level category to drill down in.
console.log("\n[11] generic Type fallback (unknown part type)");
ok("inferCategoryPath(Quantum Flux Capacitor) returns real path",
   /eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Quantum Flux Capacitor/.test(
     inferCategoryPath([["Type", "Quantum Flux Capacitor"]])
   ),
   inferCategoryPath([["Type", "Quantum Flux Capacitor"]])
);
ok("inferCategoryPath(empty specifics) returns empty string",
   inferCategoryPath([]) === "");

// [12] `*-` sub-bullet marker regression. SKU JPSU-6 (Jeep Comanche Fuel
// Pump): the supplier data package uses markdown sub-bullet markers
// (`*-`) and the LLM echoed that style into every title / selling
// point / HTML block. stripPrefix() previously only matched a SINGLE
// bullet char before whitespace, so `*- Foo` failed to strip and `*-`
// leaked into the rendered Listing Report. The fix broadens the
// bullet regex to any sequence of `-`/`*` chars before whitespace.
console.log("\n[12] `*-` sub-bullet marker stripped from all output");
const JPSU_PKG = [
  "JPSU-6",
  "JPSU-6P4.0",
  "1987",
  "1988",
  "1989",
  "1990",
  "Jeep Comanche MJ 4.0L",
  "Fuel Pump Module Assembly",
  "Unbranded",
].join("\n");
const JPSU_LLM = `1. Titles.
*- Fuel Pump Sending Unit JPSU-6 Jeep Comanche MJ 4.0L 1987-1990 Tank Assembly
*- Fuel Pump Module JPSU-6P4.0 Jeep Comanche MJ 4.0L 1987-1990 Gas Tank Unit
*- Fuel Pump Assembly JPSU-6 Jeep Comanche MJ 4.0L 1987-1990 Direct Replacement

2. Item Specifics.
**Brand:** Unbranded
**MPN:** JPSU-6
**OEM Part Number:** JPSU-6
**Interchange Part Number:** JPSU-6P4.0
**Placement on Vehicle:** Tank
**Material:** Not Specified
**Type:** Fuel Pump Module Assembly
**Warranty:** Does Not Apply

3. Fitment.
1987-1990 Jeep Comanche MJ 4.0L

4. Selling Points.
*- Engineered for exact fitment to ensure seamless integration with your 1987-1990 Jeep Comanche 4.0L fuel system.
*- Precision-manufactured as a direct replacement unit to maintain factory-grade fuel delivery performance and vehicle safety.
*- High-reliability electrical components designed to meet the specific 12V requirements of your gasoline engine.
*- Complete module assembly simplifies the repair process by providing a comprehensive, ready-to-install solution.

5. Product Description.
This premium fuel pump module assembly is specifically engineered for the 1987-1990 Jeep Comanche MJ 4.0L, ensuring a precise and reliable fit for your vehicle.

6. Package Includes.
1x Fuel Pump Sending Unit (As Pics Shown)

7. Suggested eBay category path.
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air & Fuel Delivery > Fuel Pumps

8. Notes to Seller.
Verify fitment against the data package before publishing.`;
const rJpsu = buildResult(JPSU_PKG, JPSU_LLM, "gemini-3.1-flash-lite", 4.2, "380/520");
ok("JPSU: 3 titles parsed", rJpsu.titles.length === 3, JSON.stringify(rJpsu.titles.map((t) => t.text)));
ok("JPSU: zero titles start with '*-'", rJpsu.titles.every((t) => !/^\*-/.test(t.text)));
ok("JPSU: first title preserves brand+OEM token", /JPSU-6/.test(rJpsu.titles[0].text));
ok("JPSU: 4 bullets parsed", rJpsu.bullets.length === 4);
ok("JPSU: zero bullets start with '*-'", rJpsu.bullets.every((b) => !/^\*-/.test(b)));
ok("JPSU: HTML does not contain '*-' anywhere", !rJpsu.html.includes("*-"));
ok("JPSU: category path comes from LLM (correctly canonicalised)", /Air\s*&\s*Fuel Delivery.*Fuel Pumps/i.test(rJpsu.category), rJpsu.category);
ok("JPSU: fitment preserved as 1987-1990 Jeep Comanche MJ 4.0L", /1987-1990\s+Jeep\s+Comanche\s+MJ\s+4\.0L/.test(rJpsu.fitment));

// [12b] Short-package robustness: when LLM omits sec[6] (Package Includes)
// or sec[8] (Notes), buildResult must not crash. The previous `[]` array
// fallback for the missing section passed an array to listItems(), which
// then failed on `(array).split(/\r?\n/)`. Fixed to `""` string fallback.
console.log("\n[12b] short-package (missing sec[6] / sec[8]) does not crash");
const SHORT_LLM = `1. Titles.
** Fuel Pump JPSU-6 Jeep Comanche 1987-1990
** Fuel Pump Module JPSU-6P4.0 Jeep 1987-1990
** Fuel Pump Assembly JPSU-6 Direct Fit 1987-1990

2. Item Specifics.
**Brand:** Unbranded
**Type:** Fuel Pump Module Assembly

3. Fitment.
1987-1990 Jeep Comanche MJ 4.0L

5. Product Description.
Premium fuel pump module.`;
const rShort = buildResult(JPSU_PKG, SHORT_LLM);
ok("Short: buildResult returns ok:true (no crash on missing sec[6]/sec[8])", rShort.ok === true);
ok("Short: package_includes defaults to empty array", Array.isArray(rShort.package_includes) && rShort.package_includes.length === 0);
ok("Short: notes defaults to empty array", Array.isArray(rShort.notes) && rShort.notes.length === 0);

// Nested bullet regression: SKU Window Mirror Master Switch (A9079056603).
// Gemini echoed `- *- foo` (single `-` top-bullet + `*-` sub-bullet marker,
// no whitespace between `*` and `-`) and the old single-layer regex stripped
// only `-`, leaving `*- foo` leaking into every bullet / HTML <li>.
console.log("\n[12c] nested `- *- foo` bullet cluster stripped to body");
const WMS_PKG = [
  "A9079056603",
  "A9079059002",
  "Unbranded",
  "Window Mirror Master Switch",
  "Front Left",
  "Universal fitment",
].join("\n");
const WMS_LLM = `1. Titles.
** Window Mirror Master Switch A9079056603, Front Left
** Master Power Window Mirror Switch Control A9079056603 Front Left
** Window Mirror Master Switch A9079059002 for Front Left Position

2. Item Specifics.
**Brand:** Unbranded
**MPN:** A9079056603
**OEM Part Number:** A9079056603
**Interchange Part Number:** A9079059002
**Placement on Vehicle:** Front Left
**Material:** High-quality materials
**Type:** Window Mirror Master Switch
**Warranty:** Does Not Apply

3. Fitment.
Universal fitment for compatible vehicles.

4. Selling Points.
- *- Constructed from premium, high-grade materials that provide superior rust-proof and colorfast durability compared to standard aftermarket alternatives.
- *- Restores full functionality to your vehicle's window and mirror controls with a high-performance design that mirrors original equipment standards.
- *- Lightweight yet rugged construction ensures long-term reliability and consistent operation under daily use.
- *- Designed as a direct-fit replacement for OEM part numbers A9079056603 and A9079059002, simplifying the installation process for professional results.

5. Product Description.
This premium window mirror master switch is engineered for reliable performance.

7. Suggested eBay category path.
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Switches > Window Switches`;
const rWms = buildResult(WMS_PKG, WMS_LLM);
ok("WMS: buildResult returns ok:true", rWms.ok === true);
ok("WMS: 4 selling points", rWms.bullets.length === 4);
ok("WMS: no bullet starts with *- or *", rWms.bullets.every((b) => !/^[*\-]/.test(b)));
ok("WMS: no bullet starts with bare *", rWms.bullets.every((b) => !/^\*/.test(b)));
ok("WMS: bullets begin with prose (Constructed/Restores/Lightweight/Designed)", rWms.bullets[0].startsWith("Constructed") && rWms.bullets[3].startsWith("Designed"));
ok("WMS: HTML does not contain '*-'", !rWms.html.includes("*-"));
ok("WMS: HTML does not contain '- *-'", !rWms.html.includes("- *-"));
ok("WMS: category inferred from Type (Window Switches)", /Window Switches/.test(rWms.category));

// [13] Mercedes-Benz Air Suspension Strut (1663201313) — supplier package
// uses `fit for ...` (no trailing s) and names the part in the Notice prose
// ("air shock"). Two regressions fixed here:
//   (a) FIT_CUE_RE only matched `fits for`, so `fit for` lines were missed
//       and the fitment fallback returned [] (fitment rendered "-").
//   (b) buildWhitelist() captured vehicle trims GL63AMG / GLS350D as fake
//       part numbers (isNoise missed the letter-digit-letter shape).
//   (c) fallbackTitle() hard-coded "Auto Part" when Item Specifics[Type]
//       was missing; now it derives the part type from the package text.
//   (d) Degradation guard: a critically empty result is flagged ok:false
//       with a warning instead of silently returning "Auto Part".
console.log("\n[13] Mercedes air strut: 'fit for' fitment, trim-noise, part-type fallback, degradation guard");
const MB_PKG = [
  "Application",
  "fit for Mercedes-Benz GL (X166) GL350 GL450 GL500 GL63AMG 2012-2015",
  "fit for Mercedes-Benz GLS (X166) GLS350d GLS450 GLS500 GLS550 2015-2019",
  "Interchange Part Number:",
  "1663201313, 1663205166, 1663205366, 166320536660, 166320536680, 1663205566, 166320556680, 1663206713, 1663206913, 1663207113",
  "Specification:",
  "Placement on Vehicle: Front left",
  "Notice:",
  "- These shock are aftermarket ones. They will replace the original air shock. Please double confim the compatibility as well as the OEM number before purchasing.",
].join("\n");

const mbWl = buildWhitelist("", MB_PKG);
ok("[13a] whitelist excludes vehicle trim GL63AMG", !mbWl.includes("GL63AMG"), JSON.stringify(mbWl));
ok("[13a] whitelist excludes vehicle trim GLS350D", !mbWl.includes("GLS350D"), JSON.stringify(mbWl));
ok("[13a] whitelist keeps all 10 real interchange numbers (10- and 12-digit), trims excluded", mbWl.filter((n) => /^\d{10,12}$/.test(n)).length === 10, JSON.stringify(mbWl));

const mbFit = extractPkgFitment(MB_PKG);
ok("[13b] extractPkgFitment finds fitment rows from 'fit for' (was 0)", mbFit.length >= 2, JSON.stringify(mbFit));
ok("[13b] recovered fitment carries a year range", mbFit.every((r) => /\d{4}-\d{4}/.test(r)), JSON.stringify(mbFit));

ok("[13c] inferPartTypeFromPkg derives 'Air Suspension Strut' from 'air shock'",
   inferPartTypeFromPkg(MB_PKG) === "Air Suspension Strut",
   inferPartTypeFromPkg(MB_PKG));

// Degraded (empty LLM) run — should still produce a meaningful title + fitment,
// NOT the useless placeholder "Auto Part", because the package text is rich.
const rMbDeg = buildResult(MB_PKG, "");
ok("[13d] degraded run: title starts with the derived part type, not 'Auto Part'",
   /^Air Suspension Strut\b/.test(rMbDeg.titles[0]?.text || ""),
   rMbDeg.titles[0]?.text);
ok("[13d] degraded run: title carries an OEM token from Interchange Part Number",
   /1663201313/.test(rMbDeg.titles[0]?.text || ""),
   rMbDeg.titles[0]?.text);
ok("[13d] degraded run: title carries placement from pkg",
   /Front left/i.test(rMbDeg.titles[0]?.text || ""),
   rMbDeg.titles[0]?.text);
ok("[13d] degraded run: title is NOT the 'Auto Part' placeholder",
   rMbDeg.titles[0]?.text !== "Auto Part",
   rMbDeg.titles[0]?.text);
ok("[13d] degraded run: fitment recovered from package (not '-')",
   rMbDeg.fitment !== "-" && /Mercedes/.test(rMbDeg.fitment),
   rMbDeg.fitment);

// New for round 13: Item Specifics fallback populates from pkgText when the
// model skips sec[2]. The seller should at least see Interchange Part Number,
// Brand, Type, and Placement rows instead of a lone "-" placeholder.
ok("[13d] degraded run: Item Specifics fallback populated from package",
   rMbDeg.specifics.some(([k]) => k === "Interchange Part Number") &&
   rMbDeg.specifics.some(([k]) => k === "Type"),
   JSON.stringify(rMbDeg.specifics));
ok("[13d] degraded run: Category fallback lands in Suspension & Steering",
   /Suspension\s*&\s*Steering/i.test(rMbDeg.category),
   rMbDeg.category);
ok("[13d] degraded run: Category fallback is NOT the echo placeholder",
   !/verify\s+in\s+the\s+ebay\s*sell\s*flow/i.test(rMbDeg.category),
   rMbDeg.category);

// Truly empty package — guard must fire.
const rEmpty = buildResult("some random text with no structure at all", "");
ok("[13e] empty package: ok:false (degradation guard)", rEmpty.ok === false);
ok("[13e] empty package: warning present", typeof rEmpty.warning === "string" && rEmpty.warning.length > 0, rEmpty.warning);
ok("[13e] empty package: title is the placeholder 'Auto Part'", rEmpty.titles[0]?.text === "Auto Part");

// [14] SKU 1663201313 followup: model returns only the prompt instruction
// echoed in sec[7] ("-- verify in the eBay Sell flow before publishing.")
// and omits sec[2]. buildResult must:
//   (a) drop the echo from sec[7] and surface the inferred category
//   (b) populate Item Specifics from the raw package
//   (c) preserve the recovered fitment + fallback title
//   (d) keep ok:true because the package is rich enough.
console.log("\n[14] degraded sec[2]/sec[7] recovery (Mercedes 1663201313 echo regression)");
const MB_ECHO_LLM = `1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
— verify in the eBay Sell flow before publishing.
8. Notes to Seller`;
const rMbEcho = buildResult(MB_PKG, MB_ECHO_LLM, "gemini-3.1-flash-lite", 4.7, "582/657");
ok("[14] category echo is NOT surfaced into the UI",
   !/verify\s+in\s+the\s+ebay\s*sell\s*flow/i.test(rMbEcho.category),
   rMbEcho.category);
ok("[14] category falls back to the inferred Suspension & Steering path",
   /Suspension\s*&\s*Steering/i.test(rMbEcho.category),
   rMbEcho.category);
ok("[14] Item Specifics recovered from package (≥3 real rows)",
   rMbEcho.specifics.length >= 3,
   JSON.stringify(rMbEcho.specifics));
ok("[14] recovered specifics include Interchange Part Number",
   rMbEcho.specifics.some(([k]) => k === "Interchange Part Number"),
   JSON.stringify(rMbEcho.specifics));
ok("[14] recovered specifics include Placement on Vehicle",
   rMbEcho.specifics.some(([k]) => k === "Placement on Vehicle"),
   JSON.stringify(rMbEcho.specifics));
ok("[14] recovered fitment has Mercedes-Benz mention (not '-')",
   rMbEcho.fitment !== "-" && /Mercedes/i.test(rMbEcho.fitment),
   rMbEcho.fitment);
ok("[14] HTML escapes the category echo (no '--verify' leak)",
   !/—\s*verify/i.test(rMbEcho.html),
   rMbEcho.html);
ok("[14] fallback title is meaningful (starts with Air Suspension Strut)",
   /^Air Suspension Strut\b/.test(rMbEcho.titles[0]?.text || ""),
   rMbEcho.titles[0]?.text);

// =====================================================================
// SKU 52248592 regression: Ford F-Series Fuel Pump (degraded output).
// Three independent fixes verified here:
//   (A) stripCategoryEchoTail handles "<real path> — verify..." hybrids
//       the old length>120 short-circuit silently passed through.
//   (B) fallbackTitle pulls Make/Model from either side of the year
//       range — the model emitted "FORD SUPER 2011-2016" (make-first),
//       which the old "must start with year" regex rejected.
//   (C) fallbackSpecifics recovers Interchange Part Number from a real
//       52248592 supplier package so Item Specifics is never just "-".
// =====================================================================

// (A) unit tests for the new echo-tail stripper
ok("[15a] looksLikeCategoryEcho: pure echo (-- verify in the eBay Sell flow) is caught",
   looksLikeCategoryEcho("-- verify in the eBay Sell flow before publishing."),
   "did not match");
ok("[15a] looksLikeCategoryEcho: 140-char hybrid string IS now caught (patterns match the substring)",
   looksLikeCategoryEcho("eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps — verify in the eBay Sell flow before publishing."),
   "old length>120 guard let this through silently");
ok("[15b] stripCategoryEchoTail: chops the echo tail off a 140-char hybrid",
   stripCategoryEchoTail("eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps — verify in the eBay Sell flow before publishing.") ===
     "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps");
ok("[15b] stripCategoryEchoTail: returns '' when the whole string is echo",
   stripCategoryEchoTail("-- verify in the eBay Sell flow before publishing.") === "");
ok("[15b] stripCategoryEchoTail: leaves a clean path untouched",
   stripCategoryEchoTail("eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps") ===
     "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps");

// (B) fallbackTitle harvest-Make/Model from either side of the year range
ok("[15c] fallbackTitle: year-first fitment still works (2011-2018 Ford Edge)",
   /Ford Edge/.test(fallbackTitle(
     [["Type", "Engine Valve Cover"]],
     "2011-2018 Ford Edge V6 3.5L (Left & Right)",
     ""
   )));
ok("[15c] fallbackTitle: make-first fitment also works (FORD SUPER 2011-2016)",
   /FORD SUPER/.test(fallbackTitle(
     [["Type", "Fuel Pump"]],
     "FORD SUPER 2011-2016",
     ""
   )),
   fallbackTitle([["Type", "Fuel Pump"]], "FORD SUPER 2011-2016", ""));
ok("[15c] fallbackTitle: make-first with year-range 2011-2016 has a real Year Range token",
   /2011-2016/.test(fallbackTitle(
     [["Type", "Fuel Pump"]],
     "FORD SUPER 2011-2016",
     ""
   )),
   fallbackTitle([["Type", "Fuel Pump"]], "FORD SUPER 2011-2016", ""));

// (C) full buildResult smoke test for the 52248592-style SKU
const FP_PKG = [
  "Electric Fuel Pump Module Assembly for 2011-2016 FORD F-250 F-350 SUPER DUTY 6.2L 6.7L V8 V10",
  "Application",
  "fit for FORD SUPER DUTY 2011-2016",
  "fit for FORD F-250 SUPER DUTY 2011-2016",
  "fit for FORD F-350 SUPER DUTY 2011-2016",
  "Interchange Part Number:",
  "52248592, 52129886AA, 52129886, 52129797AA, 52129797, 5C3Z9H307BA, 5C3Z9H307BB, 5C3Z9H307BC",
  "OE/Part number:",
  "52248592",
  "Brand: Unbranded",
  "Placement on Vehicle: Front",
  "Fitment Type: Direct Replacement",
  "Specification:",
  "Voltage: 12V",
  "Flow Rate: 130 L/h",
  "Pressure: 3.5 bar",
  "Inlet Diameter: 8mm",
  "Outlet Diameter: 8mm",
  "Feature:",
  "- High quality and durable",
  "- Stable performance",
  "- Easy to install",
  "Notice:",
  "- Please confirm the OEM part number before purchasing."
].join("\n");

// Echo-tailing category in the LLM output (the exact bug we hit)
const FP_ECHO_LLM = `1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps — verify in the eBay Sell flow before publishing.
8. Notes to Seller`;

const rFp = buildResult(FP_PKG, FP_ECHO_LLM, "gemini-3.1-flash-lite", 2.7, "582/657");
ok("[15d] FP echo-tail: category has NO '-- verify' or '— verify' substring",
   !/verify in the eBay Sell flow|— verify|-- verify/i.test(rFp.category),
   rFp.category);
ok("[15d] FP echo-tail: category keeps the leading real path (Fuel Pumps)",
   /Fuel Pumps/.test(rFp.category) && !/—|--/.test(rFp.category),
   rFp.category);

const FP_DEG_LLM = `1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
— verify in the eBay Sell flow before publishing.
8. Notes to Seller`;
const rFpDeg = buildResult(FP_PKG, FP_DEG_LLM, "gemini-3.1-flash-lite", 2.7, "582/657");
ok("[15e] FP degraded: fallback title includes Fuel Pump + 2011-2016 (make-first fitment)",
   /Fuel Pump/.test(rFpDeg.titles[0]?.text || "") && /2011-2016/.test(rFpDeg.titles[0]?.text || ""),
   rFpDeg.titles[0]?.text);
ok("[15e] FP degraded: title is NOT 'Auto Part' placeholder",
   rFpDeg.titles[0]?.text !== "Auto Part",
   rFpDeg.titles[0]?.text);
ok("[15e] FP degraded: fallbackSpecifics has Interchange Part Number row",
   rFpDeg.specifics.some(([k, v]) => k === "Interchange Part Number" && v.length > 0),
   JSON.stringify(rFpDeg.specifics.map(([k]) => k)));

// [16] SKU 93856129 (Hyundai/Kia Clutch Kit, OEM 41300-26010) — ALL-echo
// category + no Item Specifics[Type]. Regression: the model returned
// "-- verify in the eBay Sell flow before publishing." for the whole sec[7]
// body and omitted Type entirely, so the UI showed the echo verbatim. The
// fallback chain must now derive "Clutch Kit" from the package's own
// "Clutch Disc / Pressure Plate / Release Bearing" prose and land in the
// Transmission & Drivetrain > Clutch Kits path.
const CL_PKG = [
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
].join("\n");
const CL_ECHO_LLM = `1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
-- verify in the eBay Sell flow before publishing.
8. Notes to Seller`;
const rCl = buildResult(CL_PKG, CL_ECHO_LLM, "gemini-3.1-flash-lite", 2.4, "523/612");
ok("[16a] CL: part type derived from pkg = 'Clutch Kit'",
   inferPartTypeFromPkg(CL_PKG) === "Clutch Kit",
   inferPartTypeFromPkg(CL_PKG));
ok("[16a] CL: inferCategoryPath([], pkg) lands in Clutch Kits",
   /Transmission & Drivetrain > Clutch Kits/.test(inferCategoryPath([], CL_PKG)),
   inferCategoryPath([], CL_PKG));
ok("[16b] CL: ALL-echo category is recognised as echo",
   looksLikeCategoryEcho("-- verify in the eBay Sell flow before publishing."),
   "not detected");
ok("[16c] CL: final category = Clutch Kits path (no echo tail)",
   /Clutch Kits/.test(rCl.category) && !/verify in the ebay sell flow/i.test(rCl.category),
   rCl.category);
ok("[16c] CL: title synthesised with part type (not 'Auto Part')",
   /Clutch Kit/.test(rCl.titles[0]?.text || "") && rCl.titles[0]?.text !== "Auto Part",
   rCl.titles[0]?.text);
ok("[16c] CL: Item Specifics includes Type=Clutch Kit (from fallbackSpecifics)",
   rCl.specifics.some(([k, v]) => k === "Type" && v === "Clutch Kit"),
   JSON.stringify(rCl.specifics.map(([k, v]) => `${k}=${v}`)));
ok("[16d] CL: fitment recovered from package (4 Hyundai/Kia rows)",
   (rCl.fitment.match(/;/g) || []).length === 3 && /Hyundai/.test(rCl.fitment),
   rCl.fitment);
ok("[16e] CL: ok:true (rich package, not degraded)", rCl.ok === true, `ok=${rCl.ok}`);

// [17] Generic tiny-package + ALL-echo LLM — must trip the degradation
// guard even after fallbackSpecifics() pushes the eBay-default Brand=
// Unbranded + Warranty=Does Not Apply placeholders. SKU 93856129 follow-up
// (next user screenshot): package = "Package Contents:\n1x Black Power
// Heated Mirror with Signal Light" (65 chars, accepted by the 40-char
// gate), LLM returns all-echo. Previous Python `degraded` check used the
// raw `not specifics_final` and missed the placeholder rows — so the
// Python runtime returned ok:true with titles[0]=='Auto Part', category=='-'
// and an empty fitment. The frontend then threw "HTTP 200" because it
// saw ok:false from the JSON. The JS runtime already had the PLACEHOLDER
// filter; this commit brings the Python runtime into lock-step.
const PM_PKG = "Package Contents:\n1x Black Power Heated Mirror with Signal Light";
const PM_ECHO_LLM = `1. Three Cassini-optimized titles
2. Item Specifics
3. Fitment
4. Five bullet selling points
5. Description first paragraph
6. Package Includes
7. Suggested eBay category path
-- verify in the eBay Sell flow before publishing.
8. Notes to Seller`;
const rPm = buildResult(PM_PKG, PM_ECHO_LLM, "gemini-3.1-flash-lite", 2.4, "100/50");
ok("[17a] PM: titles[0] is the placeholder 'Auto Part'",
   rPm.titles[0]?.text === "Auto Part",
   rPm.titles[0]?.text);
ok("[17a] PM: fallbackSpecifics still pushes Brand=Unbranded + Warranty=Does Not Apply",
   rPm.specifics.some(([k, v]) => k === "Brand" && v === "Unbranded") &&
   rPm.specifics.some(([k, v]) => k === "Warranty" && v === "Does Not Apply"),
   JSON.stringify(rPm.specifics));
ok("[17b] PM: degraded guard FIRES (ok:false) despite placeholder specifics",
   rPm.ok === false,
   `ok=${rPm.ok}`);
ok("[17b] PM: warning explains the failure to the seller",
   typeof rPm.warning === "string" && /regenerate|verify/i.test(rPm.warning),
   rPm.warning);
ok("[17b] PM: fitment is '-' (no usable vehicle info in pkg)",
   rPm.fitment === "-",
   rPm.fitment);

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
