import { buildResult } from "./lib/listing.js";

// Simulate the user's full picture: LLM emits NO valid titles, fitment missing
// → fallbackTitle MUST drive. The fitment cue must come from raw pkg text.
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

// What the LLM might actually emit for THIS data: titles get rejected by
// isValidTitle (length, echo, category, etc), fitment section skipped.
const llm = `1. Three Cassini-optimized titles
* BMW Z3 1996-2002

2. Item Specifics
* Brand: Unbranded
* MPN: 54318401027
* OEM Part Number: 54318401027
* Interchange Part Number: 163701403782
* Placement on Vehicle: Rear
* Material: Plastic
* Type: Rear Window
* Manufacturer Part Number: 54318401027
* Fitment Type: Direct Replacement
* Warranty: Does Not Apply

4. Five bullet selling points
* Direct-fit replacement for BMW Z3 convertible tops
* High-quality ABS construction matches OEM weight
* Includes mounting hardware for straightforward installation
* Clear rear visibility without distortion
* Weather-sealed edges to prevent cabin water intrusion

5. Description first paragraph
This plastic rear window is engineered to OEM specifications for the 1996-2002 BMW Z3 roadster convertible.

6. Package Includes
* 1x Plastic Rear Window (As Pics Shown)

7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Convertible Tops & Parts

8. Notes to Seller
* None`;

const r = buildResult(pkg, llm, "test", 0, "0/0");
console.log("=== User-like scenario (titles rejected, fitment skipped) ===");
console.log("Titles:", r.titles.map(t => `${t.text} (${t.len})`));
console.log("Fitment:", r.fitment);
console.log("Bullets:", r.bullets.length);
console.log("PkgInc:", r.package_includes);

// Now also test a prose-form fitment in pkg like "Compatible Vehicle: BMW Z3 1996-2002"
const pkg2 = `Rear Window BMW Z3
Manufacturer Part Number: 54318401027
OEM Part Number: 54318401027
Interchange Part Number: 163701403782

Compatible Vehicle: BMW Z3 1996-2002

Package Includes
1x Plastic Rear Window`;

const r2 = buildResult(pkg2, llm, "test", 0, "0/0");
console.log("\n=== Alt pkg: 'Compatible Vehicle:' cue ===");
console.log("Titles:", r2.titles.map(t => `${t.text} (${t.len})`));
console.log("Fitment:", r2.fitment);