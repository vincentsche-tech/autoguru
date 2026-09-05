// EbayAutoGuru — listing core (runtime-agnostic)
// Port of cross-border-lister/scripts/listing_pipeline.py + server.py
// Kept free of any I/O so it can be unit-tested locally with node.

export const MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
];

export const MAX_TEXT = 20000;

// Supplier descriptions embed an anti-theft watermark; strip it everywhere.
const WATERMARK_RE = /Authority\s*ID\s*[:：]\s*[A-Z0-9]{8,}/gi;
// Category ID occasionally echoed back by the model — not a part number.
const CATEGORY_ID_RE = /Category\s*ID\s*[:：]\s*\d+/gi;

// Part-number shapes: 72750SZ3J13 / 527-028 / 76200-T2G-A42ZC / CU2148 / K643168
const PARTNO_RE =
  /\b(?=[A-Z0-9-]{6,20}\b)(?=[A-Z0-9]*\d)[A-Z]{0,4}-?[A-Z0-9]{2,}-?[A-Z0-9]{1,5}(?:-[A-Z0-9]+)*\b/g;

// ---------- noise filter ----------
function isNoise(n) {
  if (/^(19|20)\d{2}\s*-\s*(?:(?:19|20)\d{2}|\d{2})$/.test(n)) return true; // year range
  if (/\d(DEG|MM|CM|KG|IN|LB|OHM|RPM|PSI|MPH|KM|OZ|ML|V|W)$/.test(n)) return true; // spec w/ unit
  if (/^\d{4}-T\d$/.test(n)) return true; // aluminium temper, e.g. 6061-T6
  // Common automotive model/trims that look like part numbers to a naive regex.
  // e.g. "GLC300", "GLB35", "AMG", "4MATIC" (the digit-prefixed drivetrain).
  if (/^[A-Z]{2,4}\d{1,3}$/.test(n)) return true; // GLC300, AMG63, RS6
  if (/^\d?MATIC$/i.test(n)) return true; // 4MATIC, 6MATIC
  if (/^(AMG|VTEC|HEMI|TSI|TDI|TFSI|GTDI|TRD|QUATTRO|GTLINE)$/i.test(n)) return true;
  return false;
}

// ---------- whitelist ----------
export function buildWhitelist(title, pkgText) {
  const text = `${title || ""}\n${pkgText || ""}`.toUpperCase();
  const seen = new Set();
  const found = [];
  for (const m of text.matchAll(PARTNO_RE)) {
    const n = m[0].replace(/^-+|-+$/g, "");
    if (isNoise(n)) continue;
    if (/^(19|20)\d{2}$/.test(n) || n.length < 6) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    found.push(n);
  }
  return found;
}

function extractClaimed(scrubbed) {
  const seen = new Set();
  const claimed = [];
  for (const m of scrubbed.toUpperCase().matchAll(PARTNO_RE)) {
    const n = m[0].replace(/^-+|-+$/g, "");
    if (m.index > 0 && scrubbed[m.index - 1] === "#") continue; // CSS hex colour
    if (seen.has(n)) continue;
    if (/^(19|20)\d{2}$/.test(n) || n.length < 6 || isNoise(n)) continue;
    seen.add(n);
    claimed.push(n);
  }
  return claimed;
}

/** Every number the model emitted must exist in the source package. */
export function verifyOutput(title, pkgText, llmText) {
  const canonWl = new Set(
    buildWhitelist(title, pkgText).map((n) => n.replace(/[^A-Z0-9]/g, ""))
  );
  const scrubbed = (llmText || "")
    .replace(WATERMARK_RE, "")
    .replace(CATEGORY_ID_RE, "");
  const claimed = extractClaimed(scrubbed);
  const hallucinated = claimed.filter(
    (n) => !canonWl.has(n.replace(/[^A-Z0-9]/g, ""))
  );
  return {
    total: claimed.length,
    matched: claimed.length - hallucinated.length,
    hallucinated,
  };
}

// ---------- LLM output parsing ----------
// Lines whose text matches any of these patterns are prompt instructions the
// model regurgitated instead of real data — drop them entirely.
const ECHO_PATTERNS = [
  /\bone attribute per line\b/i,
  /\bone vehicle line per\b/i,
  /\bone concern per\b/i,
  /\bone item per\b/i,
  /\bcover brand\b/i,
  /\bbenefit[- ]driven\b/i,
  /\bno keyword stuffing\b/i,
  /\boutput only sections\b/i,
  /\bdo not invent\b/i,
  /\bnever add\b/i,
  /\bdo not wrap\b/i,
  /\bdo not omit\b/i,
  /\binclude warranty only if\b/i,
  /\bsuggested ebay category path\b/i,
  /\bnotes to seller\b/i,
  /\bpackage includes\b/i,
  /\bfive bullet\b/i,
  /\bthree cassini\b/i,
  /\bdescription first paragraph\b/i,
  /\bmaximum?\s*\d+\s*chars?\b/i,
  /\btitle case\b/i,
  /\bno decorative punctuation\b/i,
];

function looksLikeEcho(ln) {
  if (ln.length < 12) return false;
  // A line that contains a literal prompt instruction phrase is echo.
  for (const re of ECHO_PATTERNS) if (re.test(ln)) return true;
  // Or a line that contains more than 8 words AND contains both quotes
  // and a colon — typical of "rule text: ..." echoes.
  if (ln.includes('"') && ln.includes(":") && ln.split(/\s+/).length > 12) {
    return true;
  }
  return false;
}

// Section header: "1. ..." or "1) ..." or "**1.** ..." or "## 1. ..."
const SECTION_HEAD = /(?:^|\n)\s*(?:[*#`]+\s*)?\(?\b([1-8])[\.\)]\s+[^\n]*?\)?[\s:]*?(?=\n|$)/g;

export function splitSections(text) {
  const src = String(text || "");
  // A section header is one of these forms:
  //   "1. Three Cassini-optimized titles"
  //   "**1.** Fitment"
  //   "## 2. Item Specifics"
  // but NEVER "1) Front Shock..." (those are numbered list items inside a
  // section) and NEVER "1. 2pcs Front..." (a sentence that begins with digits
  // is not a header). We enforce: digit + period + space + capital letter.
  const re = /(?:^|\n)\s*(?:[*#`]+)?\s*\b([1-8])\.[ \t]+(?=[A-Z])/g;
  // For each section we record the position of the \n that STARTS the
  // header line. The body of section N starts one char after the \n that
  // ends section N's header line, and ends just before the \n that starts
  // section N+1's header line — that way the body never includes the next
  // section's header text.
  const headerStart = []; // [num, position of \n before this header]
  for (const m of src.matchAll(re)) {
    const num = Number(m[1]);
    if (headerStart.find((mm) => mm[0] === num)) continue;
    // m.index is 0 if the alternative was `^`, otherwise the position of `\n`.
    headerStart.push([num, m.index]);
  }
  if (!headerStart.length) return {};
  const headerEndNewline = headerStart.map(([num, hs]) => {
    // Position of the \n at the END of this section's header line.
    const eol = src.indexOf("\n", Math.max(hs + 1, 0));
    return [num, eol === -1 ? src.length : eol];
  });
  const seen = {};
  for (let i = 0; i < headerStart.length; i++) {
    const [num] = headerStart[i];
    if (seen[num] !== undefined) continue;
    // Body starts after the header line's terminating \n.
    const bodyStart = headerEndNewline[i][1] + 1;
    // Body ends just before the next section's header \n (or end of string).
    const bodyEnd = i + 1 < headerStart.length ? headerStart[i + 1][1] : src.length;
    const body = src.slice(bodyStart, bodyEnd).trim();
    if (body) seen[num] = body;
  }
  return seen;
}

// Strip a leading bullet / numbered prefix; return null if the line doesn't
// look like a list entry at all.
function stripPrefix(ln) {
  // markdown-style bullets and dashes
  const a = ln.match(/^[-*•]\s+(.+)$/);
  if (a) return a[1].trim();
  // numbered lists: 1. 1) (1) ①
  const b = ln.match(/^\(?\d+[\.\)]\s+(.+)$/);
  if (b) return b[1].trim();
  // Option/Title N: / #N style — common when models emit prose instead of bullets
  const c = ln.match(/^(?:Option|Title|T)\s*\d+\s*[:：.]\s*(.+)$/i);
  if (c) return c[1].trim();
  return null;
}

export function listItems(block) {
  const out = [];
  for (const raw of (block || "").split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln || ln.toUpperCase() === "NONE") continue;
    const item = stripPrefix(ln);
    if (!item) continue;
    if (item.toUpperCase() === "NONE") continue;
    out.push(item);
  }
  return out;
}

// Extract labeled KV pairs from a block. STRICT: label must be one of the
// well-known eBay Motors Item Specifics fields (with light synonyms). The
// parser also drops any line that smells like a regurgitated prompt rule.
const KNOWN_FIELDS = new Map([
  ["brand", "Brand"],
  ["manufacturer part number", "MPN"],
  ["mpn", "MPN"],
  ["manufacturer part no", "MPN"],
  ["manufacturer part #", "MPN"],
  ["interchange part number", "Interchange Part Number"],
  ["interchange part numbers", "Interchange Part Number"],
  ["interchange number", "Interchange Part Number"],
  ["interchange", "Interchange Part Number"],
  ["oe/oem part number", "OEM Part Number"],
  ["oem part number", "OEM Part Number"],
  ["oem number", "OEM Part Number"],
  ["oe part number", "OEM Part Number"],
  ["oe number", "OEM Part Number"],
  ["oem", "OEM Part Number"],
  ["placement on vehicle", "Placement on Vehicle"],
  ["placement", "Placement on Vehicle"],
  ["material", "Material"],
  ["type", "Type"],
  ["fitment type", "Fitment Type"],
  ["warranty", "Warranty"],
  ["country/region of manufacture", "Country/Region of Manufacture"],
  ["country of origin", "Country/Region of Manufacture"],
  ["vintage part", "Vintage Part"],
  ["number of pieces", "Number of Pieces"],
  ["piece count", "Number of Pieces"],
  ["universal fitment", "Universal Fitment"],
  ["custom bundle", "Custom Bundle"],
  ["superseded part number", "Superseded Part Number"],
  ["color", "Color"],
  ["manufacturer warranty", "Manufacturer Warranty"],
  ["part number", "Part Number"],
  ["placement on vehicle:", "Placement on Vehicle"],
]);

function normalizeLabel(label) {
  return label
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/[*_`:]+/g, "")
    .replace(/^[\s\-–—]+|[\s\-–—]+$/g, "")
    .trim();
}

export function kvItems(block) {
  const out = [];
  const seen = new Set();
  for (const raw of (block || "").split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln) continue;
    if (looksLikeEcho(ln)) continue;
    // Strip an optional leading bullet so the label is at the start.
    const noBullet = ln.replace(/^[-*•]\s+/, "");
    const colonIdx = noBullet.search(/[:：]/);
    if (colonIdx === -1) continue;
    const stripStars = (s) => s.trim().replace(/^\*+|\*+$/g, "").trim();
    const label = stripStars(noBullet.slice(0, colonIdx));
    const value = stripStars(noBullet.slice(colonIdx + 1));
    if (!label || !value || value.toUpperCase() === "NONE") continue;
    const canonical = KNOWN_FIELDS.get(normalizeLabel(label));
    if (!canonical) continue; // not a recognised eBay field — drop
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push([canonical, value]);
  }
  return out;
}

// Split a fitment block into individual lines. Strict: each line must look
// like a real fitment — start with a year range "(19|20)YY[-–—](19|20)?YY"
// and contain at least one capitalised word. Otherwise it is treated as echo
// or noise and discarded.
const FIT_YEAR_PREFIX = /^\s*\(?(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\)?/;

export function fitmentLines(block) {
  const raw = (block || "").trim();
  if (!raw) return [];
  // First try the normal list path.
  const listed = listItems(raw).filter((l) => FIT_YEAR_PREFIX.test(l));
  if (listed.length >= 2) return listed;
  // Otherwise split on year-range boundaries and keep only the valid rows.
  const split = raw
    // (2016-2020 Make Model ...) ... (2017-2020 Make Model ...)
    .replace(/[\s\u00A0]*(?=\(?\s*(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)?\d{2})/g, "\n")
    .split(/\r?\n+/)
    .map((l) => l.replace(/^[\s:;,\-–—]+/, "").trim())
    .filter((l) => FIT_YEAR_PREFIX.test(l));
  if (split.length >= 1) return split;
  // No usable fitment line at all — return empty so the UI shows a dash
  // rather than echoing the model’s prompt instructions.
  return [];
}

// A real title must be substantive: at least 25 chars, contain a part-type
// noun or an OEM-shaped token, and not contain instruction phrases.
const TITLE_NEGATIVES = [
  /\boutput\b/i,
  /\battribute per line\b/i,
  /\bcassini-optimized\b/i,
  /\bdescription\b/i,
  /\bitem specifics\b/i,
  /\bfitment\b/i,
  /\bbullet\b/i,
  /\bwarranty\b/i,
];
const TITLE_PART_TYPE = /\b(?:arm|cover|handle|switch|sensor|pump|motor|filter|headlight|taillight|mirror|bumper|fender|hood|grille|strut|shock|spring|control|suspension|brake|wheel|hose|clamp|bracket|housing|gasket|bearing|valve|relay|fuse|coil|alternator|starter|radiator|condenser|compressor|manifold|throttle|catalyst|muffler|exhaust|axle|pulley|tensioner|damper|knuckle|spindle|caliper|rotor|drum|liner|caliper|hub|rack|pinion|gear|lever|pedal|pad|rim|spoke|tire|wheel|cap|cover|trim|molding|seal|strip|tape|bolt|screw|nut|washer|clip|pin|retainer|grommet|bushing|mount|engine|motor|transmission|drive|shaft|joint|boot|module|computer|sensor|wiring|harness|connector|switch|relay|fuse|bulb|lamp|light|gauge|cluster|speedometer|tachometer|panel|sunroof|window|door|lock|handle|hinge|trunk|lid|tailgate|hatch|spoiler|wing|deflector|guard|protector|rack|basket|cargo|trailer|hitch|coupler|ball|mount|carrier|box|tray|liner|mount|holder|stand|prop|jack|tool|kit|set|assembly|pair|left|right|front|rear|upper|lower|inner|outer|driver|passenger|side|kit|pcs|piece|piece)\b/i;
const TITLE_HAS_OEM = /\b[A-Z0-9]{2,}-[A-Z0-9]{2,}\b|\b\d{5,}\b|\b[A-Z]\d{4,}\b|\b(?:19|20)\d{2}\b/;

function isValidTitle(t) {
  const s = (t || "").trim();
  if (s.length < 25 || s.length > 80) return false;
  for (const re of TITLE_NEGATIVES) if (re.test(s)) return false;
  if (looksLikeEcho(s)) return false;
  // Must look like a real listing title — contain a part-type noun OR an
  // OEM-shaped token.
  return TITLE_PART_TYPE.test(s) || TITLE_HAS_OEM.test(s);
}

export function para(block) {
  const lines = (block || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Drop any line that looks like a regurgitated instruction.
    .filter((l) => !looksLikeEcho(l))
    .map((l) => (stripPrefix(l) || l).replace(/\*\*/g, ""));
  return lines.join(" ").trim();
}

// ---------- HTML (deterministic, never model-generated) ----------
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function buildHtml(title, fitment, bullets, desc, specs, pkgIncludes) {
  const p = [
    '<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;color:#1a1a1a;line-height:1.6">',
    `  <h2>${esc(title)}</h2>`,
  ];
  if (desc) p.push(`  <p>${esc(desc)}</p>`);
  p.push("  <h3>Fitment / Compatibility</h3>");
  p.push(`  <p>${esc(fitment || "-")}</p>`);
  if (specs && specs.length) {
    const rows = specs
      .map(
        ([k, v]) =>
          '      <tr><td style="padding:6px 10px;border-bottom:1px solid #ddd"><strong>' +
          `${esc(k)}</strong></td><td style="padding:6px 10px;border-bottom:1px solid #ddd">${esc(v)}</td></tr>`
      )
      .join("\n");
    p.push("  <h3>Specifications</h3>");
    p.push('  <table style="width:100%;border-collapse:collapse">\n' + rows + "\n  </table>");
  }
  if (bullets && bullets.length) {
    p.push("  <h3>Features</h3>");
    p.push(
      "  <ul>\n" +
        bullets.slice(0, 5).map((b) => `    <li>${esc(b)}</li>`).join("\n") +
        "\n  </ul>"
    );
  }
  if (pkgIncludes && pkgIncludes.length) {
    p.push("  <h3>Package Includes</h3>");
    p.push(
      "  <ul>\n" +
        pkgIncludes.slice(0, 6).map((i) => `    <li>${esc(i)}</li>`).join("\n") +
        "\n  </ul>"
    );
  }
  p.push(
    "  <p><em>Note: Professional installation is recommended. Please verify all part numbers against your vehicle before ordering.</em></p>"
  );
  p.push("</div>");
  return p.join("\n");
}

// ---------- prompt (mirrors PROMPT_TEMPLATE v1.3) ----------
const PROMPT_TEMPLATE = `You are a veteran eBay Motors listing specialist with 10 years of cross-border auto-parts experience. Generate an eBay Motors listing from this data package (SKU {sku}). The seller prices about 40% above generic listings: the copy must justify the premium (quality, exact fitment, safety) using ONLY facts from the package.

=== DATA PACKAGE ===
Title: {title}
Category: {category}
Package: {dims}
Description source:
{desc}

=== TASK ===
Output in this exact order. STRICT FORMAT RULES — every list entry must be on its own line, beginning with "*- "* (asterisk + space). Failure to comply breaks the parser.
1. Three Cassini-optimized titles (max 80 chars each). Each title on its own line as "* <title text>". Inside each title: Part Type + OEM/Interchange + Fitment + side/placement. The first 4 words must be the highest-traffic search terms a buyer would type (part type / brand / OEM number). Title Case, no decorative punctuation (! @ ?). Avoid unclear abbreviations.
2. Item Specifics. One attribute per line as "* <Label>: <value>". Cover Brand, MPN, OEM Part Number, Interchange Part Number, Placement on Vehicle, Material, Type, Manufacturer Part Number, Fitment Type. Include Warranty ONLY if the data package states one, otherwise write "* Warranty: Does Not Apply" (do not omit the field). Do not wrap labels in markdown bold.
3. Fitment. One vehicle line per "* " entry: "* <Year-Range Make Model Trim (Side)>". Every distinct fitment from the package goes on its own line — never merge into one prose sentence.
4. Five bullet selling points (benefit-driven, premium tone, based only on the package). Each as "* <point>".
5. Description first paragraph (2-3 sentences, benefit-driven, no external links; naturally work in the main part number(s) and year/make/model; no keyword stuffing). Plain text, no bullet.
6. Package Includes. One item per "* " line; if the package does not state a list, write "* None".
7. Suggested eBay category path on a single line as plain text (e.g. eBay Motors > Parts & Accessories > Suspension & Steering > Control Arms & Parts; no category ID; suggestion for the seller to verify).
8. Notes to Seller. One concern per "* " line. List ONLY contradictions or suspicious points found inside the data package itself (left/right vs piece count vs OEM pairing, Driver=Left mapping, fitment vs OEM generation logic, material/placement mismatch, package category vs product type mismatch, OE number missing for one side). If none, write "* None".
Do NOT invent any OEM numbers, interchange numbers or vehicle fitments not listed above. Every part number you output MUST exist verbatim in the data package. Never add "common" interchange numbers from your own knowledge.
Output ONLY sections 1-8 (no image guides, no HTML unless asked). The response must contain 8 numbered sections exactly — do not skip, rename or merge sections.
Never refer to yourself as an AI, assistant or language model; never add disclaimers, greetings or closing remarks. Output results only, like a deterministic engine.`;

export function buildPrompt(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const title = lines.length ? lines[0].slice(0, 200) : "";
  return PROMPT_TEMPLATE.replace("{sku}", () => "WEB")
    .replace("{title}", () => title)
    .replace("{category}", () => "-")
    .replace("{dims}", () => "-")
    .replace("{desc}", () => String(text || "").slice(0, 3000));
}

/** Turn raw package text + raw model output into the API response body. */
export function buildResult(pkgText, llmText, model, seconds, tokens) {
  const lines = pkgText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const title = lines.length ? lines[0].slice(0, 200) : "";

  const sec = splitSections(llmText);
  // Only keep titles that look like real eBay titles. If the model emitted
  // only echo lines we end up with 0 valid titles, which is what we want
  // — better than showing "1. Three Cassini-optimized titles" as a title.
  const rawTitles = listItems(sec[1] || "");
  const titles = rawTitles.filter(isValidTitle).slice(0, 3);
  const specifics = kvItems(sec[2] || "");
  const fitBlock = sec[3] || "";
  const fitList = fitmentLines(fitBlock);
  // If the section yielded several fits, join them as multi-line; otherwise keep it as-is.
  const fitment = fitList.length
    ? fitList.length === 1
      ? fitList[0]
      : fitList.join("; ")
    : "-";
  const bullets = listItems(sec[4] || "")
    .filter((b) => !looksLikeEcho(b))
    .slice(0, 5);
  const desc = para(sec[5] || "");
  const pkgIncludes = listItems(sec[6] || []).filter((p) => !looksLikeEcho(p));
  const category = para(sec[7] || "") || "-";
  const notes = listItems(sec[8] || []).filter((n) => !looksLikeEcho(n));

  return {
    ok: true,
    model,
    seconds: Math.round(seconds * 10) / 10,
    tokens,
    titles: titles.map((t) => ({ text: t, len: t.length })),
    specifics,
    fitment,
    bullets,
    description: desc,
    package_includes: pkgIncludes,
    category,
    html: buildHtml(title, fitment, bullets, desc, specifics, pkgIncludes),
    notes,
    verify: verifyOutput(title, pkgText, llmText),
  };
}
