import { buildResult, extractPkgFitment, splitSections, fitmentLines, buildPrompt } from './lib/listing.js';

// === 用户贴出的真实数据包 (SKU 26402647) ===
const pkg = `Plastic Rear Window Replacement for 1996-2002 BMW Z3 54318401027 163701403782
54318401027
163701403782
w/o Glue
Fitment
Fits for BMW Z3 1996-2002
Package Includes
1x Plastic Rear Window (As Pics Shown)`;

console.log('=== extractPkgFitment (reverse-scan raw pkg) ===');
console.log(JSON.stringify(extractPkgFitment(pkg)));

// Simulate a realistic LLM 8-section output for this sparse data package.
// Short package => model tends to emit plain-text titles/selling points and
// may echo the "Fits for" line or skip section 3.
const llm = `1. Three Cassini-optimized titles
Plastic Rear Window Replacement for 1996-2002 BMW Z3 54318401027
Plastic Rear Window for BMW Z3 1996-2002 54318401027
Rear Window Replacement 54318401027 for 1996-2002 BMW Z3

2. Item Specifics
Brand: Aftermarket
Manufacturer Part Number: 54318401027
Interchange Part Number: 163701403782
Placement on Vehicle: Rear
Material: Plastic
Type: Rear Window

3. Fitment
BMW Z3 1996-2002

4. Five bullet selling points
Direct-fit replacement engineered to OEM specifications for BMW Z3 convertible tops
High-clarity plastic maintains rear visibility without distortion
Pre-cut design requires no additional trimming before installation
Weather-sealed edges help prevent cabin water intrusion
Includes the rear window only; adhesive not included (w/o Glue)

5. Description first paragraph
This plastic rear window replaces the original on 1996-2002 BMW Z3 convertible models.

6. Package Includes
1x Plastic Rear Window (As Pics Shown)

7. Suggested eBay category path
eBay Motors > Parts & Accessories > Car & Truck Parts > Interior > Rear Window

8. Notes to Seller
None`;

const sec = splitSections(llm);
console.log('\n=== splitSections sec[3] (header must NOT leak) ===');
console.log(JSON.stringify(sec[3]));

console.log('\n=== fitmentLines(sec[3]) ===');
console.log(JSON.stringify(fitmentLines(sec[3])));

const r = buildResult(pkg, llm, 'gemini-2.5-flash-lite', 0, '0/0');
console.log('\n=== buildResult ===');
console.log('TITLES:');
r.titles.forEach(t => console.log(`  (${t.len}) ${t.text}`));
console.log('FITMENT:', r.fitment);
console.log('BULLETS (' + r.bullets.length + '):');
r.bullets.forEach(b => console.log('  - ' + b));
console.log('SPECIFICS OEM Part Number:', (r.specifics.find(s => /oem|manufacturer/i.test(s.k)) || {}).v);
console.log('VERIFY hallucinated:', JSON.stringify(r.verify.hallucinated));
console.log('HTML has Features block:', /<h3>Features<\/h3>/.test(r.html));
console.log('HTML <li> count:', (r.html.match(/<li>/g) || []).length);
