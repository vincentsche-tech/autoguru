import { buildResult } from "./lib/listing.js";

// What we likely see from the user's data package
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

const scenarios = {
  // Scenario A: LLM follows prompt perfectly (bullets, single fitment)
  A: `1. Three Cassini-optimized titles
* Plastic Rear Window 54318401027 for 1996-2002 BMW Z3, Rear
* BMW Z3 1996-2002 Rear Window 54318401027 Plastic
* Rear Window for 1996-2002 BMW Z3 54318401027 Plastic

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

3. Fitment
* 1996-2002 BMW Z3

4. Five bullet selling points
* Direct-fit replacement for BMW Z3 convertible tops
* High-quality ABS construction matches OEM weight
* Includes mounting hardware for straightforward installation
* Clear rear visibility without distortion
* Weather-sealed edges to prevent cabin water intrusion

5. Description first paragraph
This plastic rear window is engineered to OEM specifications for the 1996-2002 BMW Z3 roadster convertible. The clear panel installs in the factory frame with the included gasket and hardware.

6. Package Includes
* 1x Plastic Rear Window (As Pics Shown)

7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Convertible Tops & Parts

8. Notes to Seller
* None`,

  // Scenario B: LLM truncates output (short on tokens or context), drops section 3
  B: `1. Three Cassini-optimized titles
* Plastic Rear Window 54318401027 for 1996-2002 BMW Z3, Rear
* BMW Z3 1996-2002 Rear Window 54318401027 Plastic
* Rear Window for 1996-2002 BMW Z3 54318401027 Plastic

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
* None`,

  // Scenario C: LLM skips section 3 entirely
  C: `1. Three Cassini-optimized titles
* Plastic Rear Window 54318401027 for 1996-2002 BMW Z3, Rear
* BMW Z3 1996-2002 Rear Window 54318401027 Plastic
* Rear Window for 1996-2002 BMW Z3 54318401027 Plastic

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

3. Fitment
BMW Z3 1996-2002

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
* None`,
};

console.log("=== Scenario A: prompt-perfect ===");
let r = buildResult(pkg, scenarios.A, "test", 0, "0/0");
console.log("Titles:", r.titles.map(t => `${t.text} (${t.len})`));
console.log("Fitment:", r.fitment);
console.log("Bullets:", r.bullets.length, "items");
console.log("PkgInc:", r.package_includes);

console.log("\n=== Scenario B: section 3 missing (skip) ===");
r = buildResult(pkg, scenarios.B, "test", 0, "0/0");
console.log("Titles:", r.titles.map(t => `${t.text} (${t.len})`));
console.log("Fitment:", r.fitment);
console.log("Bullets:", r.bullets.length, "items");

console.log("\n=== Scenario C: section 3 prose (no bullet) ===");
r = buildResult(pkg, scenarios.C, "test", 0, "0/0");
console.log("Titles:", r.titles.map(t => `${t.text} (${t.len})`));
console.log("Fitment:", r.fitment);
console.log("Bullets:", r.bullets.length, "items");