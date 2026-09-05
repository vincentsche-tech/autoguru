import { buildResult } from "./lib/listing.js";

const pkg = `Plastic Rear Window For BMW Z3 1996-2002 Convertible Top
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

// The likely real-world LLM output for a SHORT package: the model emits the
// titles / selling points / fitment as PLAIN TEXT LINES (no `* 1) >>` prefix)
// and writes fitment with Make/Model BEFORE the year. This is what tripped
// 26402647 in production (11bf36d): listItems dropped plain lines, fitment
// prose split dropped the Make/Model.
const llm = `1. Three Cassini-optimized titles
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

const r = buildResult(pkg, llm, "test", 0, "0/0");
console.log("=== Scenario D: plain-text lines + Make-first fitment (26402647-like) ===");
console.log("Titles:", r.titles.map((t) => `${t.text} (${t.len})`));
console.log("Fitment:", r.fitment);
console.log("Bullets:", r.bullets);
console.log("Has fallback title?", r.titles.some((t) => t.text.includes("54318401027, Rear")));
console.log("PkgIncludes:", r.package_includes);

// Also confirm the prose-fitment Make/Model recovery on its own (sec[3]=BMW Z3 1996-2002)
const r2 = buildResult(pkg, llm.replace(/BMW Z3 1996-2002/, "1996-2002 BMW Z3"), "test", 0, "0/0");
console.log("\n=== Variant: year-first fitment ===");
console.log("Fitment:", r2.fitment);
