// Offline self-test: run the Pages Function core against a real supplier
// package and a real model output, and assert it matches the Python pipeline.
//   node tests/selftest.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildWhitelist, verifyOutput, splitSections, listItems, kvItems, para, buildHtml, buildPrompt, buildResult } from "../lib/listing.js";

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
