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
// Coverage: every section header phrase used in the v1.3 prompt must be here
// so that a model which echoes the section name verbatim is filtered.
const ECHO_PATTERNS = [
  /\bone attribute per line\b/i,
  /\bone vehicle line per\b/i,
  /\bone concern per\b/i,
  /\bone item per\b/i,
  /\bcover brand\b/i,
  /\bbenefit[- ]driven\b/i,
  /\bno keyword stuffing\b/i,
  /\boutput only sections\b/i,
  /\boutput results? only\b/i,
  /\bdo not invent\b/i,
  /\bnever add\b/i,
  /\bdo not wrap\b/i,
  /\bdo not omit\b/i,
  /\bdo not merge\b/i,
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
  // Section-name echoes (v1.3 prompt uses these as section titles).
  /\bselling points?\b/i,
  /\bitem specifics?\b/i,
  /\bproduct description\b/i,
  /\bfitment type\b/i,
  /\blike a deterministic engine\b/i,
  /\bspecifications?\b/i,
  // Length / format rules that the model sometimes echoes back.
  /\bstyle each entry\b/i,
  /\bsections? 1\s*[-–]\s*8\b/i,
];

function looksLikeEcho(ln) {
  if (!ln || ln.length < 4) return true;
  // Reject lines that are essentially just a section header name (e.g. "Selling Points", "Item Specifics").
  if (ln.split(/\s+/).length <= 3) {
    const t = ln.toLowerCase().trim();
    if (
      /^selling points?$/.test(t) ||
      /^item specifics?$/.test(t) ||
      /^package includes?$/.test(t) ||
      /^notes to seller$/.test(t) ||
      /^product description$/.test(t) ||
      /^suggested.*category.*path$/.test(t) ||
      /^fitment$/.test(t) ||
      /^description$/.test(t)
    ) {
      return true;
    }
  }
  // A line that contains a literal prompt instruction phrase is echo.
  for (const re of ECHO_PATTERNS) if (re.test(ln)) return true;
  // Or a line that contains more than 8 words AND contains both quotes
  // and a colon — typical of "rule text: ..." echoes.
  if (ln.includes('"') && ln.includes(":") && ln.split(/\s+/).length > 12) {
    return true;
  }
  return false;
}

// A real eBay Motors category path (eBay Motors > Parts > ... > <sub>).
// Detected anywhere in a value so Package Includes, bullets, notes etc.
// don't accidentally display it.
function isCategoryPath(item) {
  if (!item) return false;
  return /\bebay\s*motors\s*>/i.test(item) ||
         (item.includes(">") && /parts\s*(&|and)?\s*accessories/i.test(item) && item.length > 30) ||
         (item.length > 120 && />(?=\s*[A-Z])/.test(item) && item.split(">").length >= 3);
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
  // NB: every `\s*` in this regex is intentionally `[ \t]*` (spaces/tabs
  // only, NOT newlines). A greedy `\s*` would swallow the blank line(s)
  // between sections, landing `m.index` on the newline *before* the blank
  // line and shifting every body start so the section header text itself
  // ("3. Fitment") gets included in the body. Anchoring to the newline
  // immediately before "N." keeps the header out of the body.
  const re = /(?:^|\n)[ \t]*(?:[*#`]+)?[ \t]*\b([1-8])\.[ \t]+(?=[A-Z])/g;
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
  // Bullet/marker prefix: any combination of `-` / `*` chars (covers single
  // bullets `-` / `*`, markdown sub-bullet forms `*-` / `-*` / `**-`,
  // em-dash style `--`) OR a single Unicode bullet (▪ ▫ ■ □ ▶ ▸ ► → › »).
  // The `*-` form is a regression from supplier packages (SKU JPSU-6 Fuel
  // Pump): the model echoed the supplier's sub-bullet marker verbatim and
  // the old single-char regex leaked `*-` into every title / bullet / HTML.
  const a = ln.match(/^(?:[-*]+|[•▪▫■□▶▸►→›»])\s+(.+)$/);
  if (a) return a[1].trim();
  // `>>` and `>` arrows — common in supplier "Notice" sections (eBay 79472025
  // regression: data package used `>> Accessories:` and the LLM echoed the
  // same arrow style for titles / selling points).
  const ar = ln.match(/^>>?\s+(.+)$/);
  if (ar) return ar[1].trim();
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

// Fallback used when listItems() yields nothing — some models emit section
// content as plain prose lines (no `* 1) >>` prefix) for short data packages.
// Recovers genuine content lines that aren't echoes, category paths, or lone
// header fragments. minLen/maxLen guard against junk and over-long echoes.
function plainContentLines(block, minLen, maxLen) {
  const out = [];
  for (const raw of String(block || "").split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln || ln.toUpperCase() === "NONE") continue;
    if (ln.length < minLen || ln.length > maxLen) continue;
    if (ln.split(/\s+/).length === 1 && /:$/.test(ln)) continue; // "Section:" header
    if (looksLikeEcho(ln)) continue;
    if (isCategoryPath(ln)) continue;
    out.push(ln);
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
// like a real fitment — start with a year range "(19|20)YY[-–—](19|20)?YY".
// Otherwise it is treated as echo or noise and discarded.
//
// Recognised separators between rows:
//   - newlines (clean case)
//   - "; " between years (common in the model output for a single-line
//     fitment block, e.g. "1999-2007 ... Silverado; 1999-2007 ... Sierra")
//   - the next row's year range (last-resort split so we don't swallow the
//     next row into the current one).
const FIT_YEAR_PREFIX = /^\s*\(?(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\)?/;
const FIT_YEAR_LOOKAHEAD = /(?=\(?\s*(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2}))/;

export function fitmentLines(block) {
  const raw = (block || "").trim();
  if (!raw) return [];
  // 1) Cleanest path: well-bulleted lines, each starting with a year range.
  const listed = listItems(raw).filter((l) => FIT_YEAR_PREFIX.test(l));
  if (listed.length >= 2) return listed.map((r) => enrichFitmentRow(r, raw));
  // 2) Split on `;` and on year-range boundaries. Each piece must itself
  //    start with a year range — otherwise it is noise and discarded.
  //    Need at least 2 rows to consider this a fitment list; otherwise fall
  //    through to the prose split which handles single-bunched lines like
  //    GLC's "2016-2020 ... 2017-2020 ... 2018-2020 ...".
  const parts = raw
    .split(/[;\n]+/)
    .map((l) => l.trim().replace(/^[\s:;,\-–—]+/, "").trim())
    .filter((l) => FIT_YEAR_PREFIX.test(l));
  if (parts.length >= 2) return parts.map((r) => enrichFitmentRow(r, raw));
  // 3) Last-resort prose split: insert \n before each new year range.
  // The lookahead must run with the `g` flag — otherwise String.replace
  // applies the zero-width match at the first position only and silently
  // leaves the rest of the line glued together.
  const split = raw
    .replace(new RegExp(FIT_YEAR_LOOKAHEAD.source, "g"), "\n")
    .split(/\r?\n+/)
    .map((l) => l.replace(/^[\s:;,\-–—]+/, "").trim())
    .filter((l) => FIT_YEAR_PREFIX.test(l));
  return split.map((r) => enrichFitmentRow(r, raw));
}

// A bare year range (e.g. "1996-2002") with no Make/Model attached.
const BARE_YEAR_RE =
  /^\s*\(?(?:19|20)\d{2}\s*[\u002D\u2013\u2014]\s*(?:(?:19|20)\d{2}|\d{2})\s*$/;
// Pull up to 2 capitalised Make/Model words out of the surrounding text so a
// bare "1996-2002" can be restored to "BMW Z3 1996-2002" when the data package
// wrote the Make/Model before (or after) the year range instead of in
// year-prefixed bullets.
function makeModelFrom(raw) {
  // Words that are NEVER a Make/Model — guards against section-header or
  // cue text leaking into the recovered fitment row.
  const STOP = new Set([
    "Fits", "Fitment", "For", "Compatible", "With", "Vehicle", "Application",
    "Direct", "Replacement", "Type", "Make", "Model", "Year", "Parts",
    "Accessories", "Motor", "Motors", "Car", "Truck", "Top", "Convertible",
  ]);
  const words = [];
  for (const w of String(raw).split(/[\s;,.\-–—()]+/)) {
    // {1,} (not {2,}) so 2-char model codes like "Z3"/"X5"/"E9" survive.
    if (/^[A-Z][A-Za-z0-9-]{1,}$/.test(w) && !/^\d/.test(w) && !STOP.has(w))
      words.push(w);
  }
  return words.slice(0, 2).join(" ");
}
function enrichFitmentRow(row, raw) {
  if (!BARE_YEAR_RE.test(row)) return row; // already carries Make/Model
  const mm = makeModelFrom(raw);
  return mm ? `${mm} ${row}` : row;
}

// Last-resort fitment extraction from the RAW data package — used when the
// model skipped section 3 entirely (common on short paste-in data, where the
// package's only fitment line is e.g. "Fits for BMW Z3 1996-2002" with no
// Year-Range-prefixed bullets for the LLM to parrot back). Recognised
// cues: "Fits for ...", "Compatible with/for/vehicle/car ...", "Fitment: ..."
// (we drop "Fitment Type"), "Vehicle Fitment ...", "Application: ...",
// "For vehicle ...". Returns [] when nothing usable is found.
const FIT_CUE_RE =
  /(?:^|\n)\s*(?:fits\s+for|compatible\s+(?:with|for|vehicle|car|model|truck|fitment)|(?:vehicle\s+)?fitment\s+for|fitment\s*[:：]|application\s*[:：]|for\s+vehicle)\s*[:：]?\s*([^\n]+)/gi;
const FIT_YEAR_RE = /\b((?:19|20)\d{2})\s*[\u002D\u2013\u2014]\s*((?:(?:19|20)\d{2})|\d{2})\b/;
// Pull up to 2 capitalised words around the year range as Make/Model. Used
// to recover "<YearRange> <MakeModel>" when the data package has the words
// before/after the year rather than in year-prefixed bullets.
function _makeModelAround(line, yearMatch) {
  const before = line.slice(0, yearMatch.index).trim();
  const after = line.slice(yearMatch.index + yearMatch[0].length).trim();
  const cap = (s) =>
    s.split(/\s+/).filter((w) => /^[A-Z][A-Za-z0-9-]+$/.test(w)).slice(0, 2).join(" ");
  return (cap(before) + " " + cap(after)).trim();
}
export function extractPkgFitment(pkgText) {
  if (!pkgText) return [];
  const out = [];
  const seen = new Set();
  const push = (row) => {
    const k = row.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(row);
  };
  for (const m of String(pkgText).matchAll(FIT_CUE_RE)) {
    let line = (m[1] || "").trim();
    // Skip obvious non-fitment meta ("Fitment Type: Direct Replacement")
    if (/^type\s*[:：]?/i.test(line)) continue;
    // Strip trailing colon/comma clutter
    line = line.replace(/^[\s:;,.\-–—]+/, "").replace(/[;,\s]+$/, "");
    if (!line) continue;
    // First pass: well-formed bullet/year-prefixed rows.
    const cleaned = fitmentLines(line);
    if (cleaned.length) {
      for (const r of cleaned) {
        // If the row is just "<YearRange>" with no Make/Model, try to
        // recover them from the original cue line.
        if (!/\b[A-Z][A-Za-z0-9-]+\b/.test(r)) {
          const y = line.match(FIT_YEAR_RE);
          if (y) {
            const mm = _makeModelAround(line, y);
            if (mm) {
              push(`${r} ${mm}`);
              continue;
            }
          }
        }
        push(r);
      }
      continue;
    }
    // Second pass: prose like "BMW Z3 1996-2002" — stitch year + Make/Model.
    const y = line.match(FIT_YEAR_RE);
    if (!y) continue;
    const endYear = y[2].length === 2 ? "20" + y[2] : y[2];
    const yearRange = `${y[1]}-${endYear}`;
    const mm = _makeModelAround(line, y);
    push(mm ? `${yearRange} ${mm}` : yearRange);
  }
  return out;
}

// A real title must be substantive: at least 15 chars, no instruction
// phrases, doesn't look like a category path, contains at least one letter.
// (Some SKUs have neither OEM nor part-type noun — let any sensible text
// through and let the verifier flag it via Notes to Seller instead.)
function isValidTitle(t) {
  const s = (t || "").trim();
  if (s.length < 15 || s.length > 80) return false;
  if (looksLikeEcho(s)) return false;
  if (isCategoryPath(s)) return false;
  if (!/[a-zA-Z]/.test(s)) return false;       // numbers-only junk
  if (/^\d+[.)]\s*$/.test(s)) return false;     // bare "1)" / "1."
  return true;
}

// Compose a sensible fallback title when the model emitted no usable title.
// Three signals inform the synthesis, in priority order:
//   1. The first fitment row (gives Year-Range + Make/Model).
//   2. Item Specifics[Type] for the part-type noun.
//   3. Item Specifics[Placement on Vehicle] for the placement suffix.
// We lead with the part type (Cassini weights the first 4 words heavily).
// When an OEM-shaped token is in the specs we splice it in too.
// Result: <Type> <with-OEM?> for <Year-Range Make/Model>, <Placement>.
export function fallbackTitle(specifics, fitment) {
  const specMap = new Map((specifics || []).map(([k, v]) => [k, v]));
  const type = (specMap.get("Type") || "Auto Part").trim();
  const place = (specMap.get("Placement on Vehicle") || "").trim();
  const mpn = (specMap.get("MPN") || "").trim();

  // Pick a representative fitment line — the longest usually has the most
  // vehicle info (e.g. "2011-2018 Ford Edge V6 3.5L (Left & Right)").
  const fLines = (fitment || "")
    .split(/;|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /^\s*\(?(?:19|20)\d{2}/.test(l));
  const fMain = fLines.sort((a, b) => b.length - a.length)[0] || "";

  let yearRange = "";
  let makeModel = "";
  if (fMain) {
    const y = fMain.match(/\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\d{2})\b/);
    if (y) yearRange = y[0].replace(/\s+/g, "");
    const after = fMain.split(y ? y[0] : "").slice(1).join(" ").trim();
    const trim = after.split(/\s+\(/)[0].trim();
    const words = trim.split(/\s+/);
    // Take the first 2 capitalised words — typically Make + Model.
    const cap = words.filter((w) => /^[A-Z][A-Za-z0-9-]+$/.test(w));
    makeModel = cap.slice(0, 2).join(" ").trim();
  }

  let title = type;
  // Pick a real OEM-shaped token to splice in. Two sources, in priority:
  //   OEM Part Number (more specific) > Interchange Part Number > MPN.
  // "Does Not Apply" / "N/A" are placeholders, not part numbers — exclude.
  const PLACEHOLDER = /^(?:does not apply|n\/?a|none|-|—|null)$/i;
  const isRealToken = (s) =>
    s && s.length <= 16 && !PLACEHOLDER.test(s.trim()) && /[A-Z0-9]/.test(s) && /\d/.test(s);
  const firstRealToken = (csv) => {
    if (!csv) return "";
    for (const tok of csv.split(/[,;|]/)) {
      const t = tok.trim();
      if (isRealToken(t)) return t;
    }
    return "";
  };
  const oem = firstRealToken(
    specMap.get("OEM Part Number") || specMap.get("Interchange Part Number") || mpn
  );
  if (oem) title += " " + oem;
  if (yearRange || makeModel) {
    title += " for " + (yearRange ? yearRange + " " : "") + makeModel;
    title = title.trim();
  }
  if (place) title += ", " + place;
  // Trim the placement suffix if it pushed us past 80 chars.
  if (title.length > 80) title = title.slice(0, 80).replace(/[,\s]+$/, "");
  return title;
}

// Last-resort: when section 7 is empty / lost, infer a sensible eBay Motors
// category path from Item Specifics[Type]. The model is supposed to write a
// path itself (eBay Motors > Parts & Accessories > ...), but short data
// packages occasionally cause it to skip sec[7] entirely — leaving the UI
// showing "-" with no suggestion at all. This synthesises a usable default
// so the seller at least has a starting point to verify against the eBay
// Sell flow.
//
// RULES are tried in order; the first regex match wins. We keep the table
// small and conservative — only Types that have already shipped through
// the parser at least once, so we don't risk hallucinating a category path
// the model itself wouldn't have produced.  Same table must exist in
// server.py (`_infer_category_path`) — keep them in lock-step.
const CATEGORY_RULES = [
  // Suspension & Steering
  [/\bcontrol arms?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Control Arms & Parts"],
  [/\bshock absorber(s)?\b|\bshocks? (and|&) struts?\b|\bstruts?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Shocks & Struts"],
  [/\bball joints?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Ball Joints"],
  [/\bsway bar(s)?\b|\bstabilizer bar(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Sway Bars"],
  [/\btie rod ends?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Suspension & Steering > Tie Rod Ends"],
  // Engine & drivetrain
  [/\bwater pump(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Water Pumps"],
  [/\bengine valve cover(s)?\b|\bvalve cover(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Engine Blocks & Parts > Valve Covers"],
  [/\boil pan(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Oil Pans"],
  [/\bhead gasket(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Engines & Engine Parts > Gaskets & Seals"],
  [/\bspark plug(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Ignition Systems > Spark Plugs"],
  [/\bignition coil(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Ignition Systems > Ignition Coils"],
  [/\bair filter(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Air Filters"],
  [/\bmass air flow\b|\bmaf sensor(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Mass Air Flow Meters"],
  [/\bthrottle body\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Throttle Bodies"],
  [/\bfuel pump(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Pumps"],
  [/\bfuel injector(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Air Intake > Fuel Injectors"],
  // Electrical & Lighting
  [/\balternator(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Electrical & Lighting > Alternators"],
  [/\bstarter motor(s)?\b|\bstarter(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Electrical & Lighting > Starters"],
  [/\bheadlight(s)? assembly\b|\bheadlight(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Lighting & Lamps > Headlights"],
  [/\btail light(s)?\b|\btaillight(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Lighting & Lamps > Tail Lights"],
  [/\bfog light(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Lighting & Lamps > Fog Lights"],
  // Exterior
  [/\bside mirror(s)?\b|\bdoor mirror(s)?\b|\bpower mirror(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Mirrors"],
  [/\bbumper cover(s)?\b|\bfront bumper\b|\brear bumper\b|\bbumper\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Bumpers"],
  [/\bfender(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Fenders"],
  [/\bhood(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Hoods"],
  [/\bradiator(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Radiators"],
  [/\bthermostat(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Thermostats"],
  [/\bradiator hose(s)?\b|\bhose(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Hoses"],
  [/\bradiator fan(s)?\b|\bfan clutch(es)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Fan Clutches"],
  [/\bradiator support(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Cooling System > Radiator Supports"],
  [/\bconvertible top(s)?\b|\brear window(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Convertible Tops & Parts"],
  [/\brunning board(s)?\b|\bside step(s)?\b|\bnerf bar(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Running Boards & Step Bars"],
  [/\btonneau cover(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Tonneau Covers"],
  [/\bwheel bearing(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Wheel Bearings"],
  // Interior
  [/\bdoor handle(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Door Handles"],
  [/\bdoor armrest(s)?\b|\barmrest(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Armrests"],
  [/\bwindow regulator(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Window Regulators"],
  [/\bwindow motor(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Window Motors"],
  [/\bpower window switch(es)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Window Switches"],
  [/\bsun visor(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Interior Parts & Accessories > Sun Visors"],
  // Brakes
  [/\bbrake pad(s)?\b|\bbrake rotor(s)?\b|\bbrake caliper(s)?\b|\bbrake\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Brakes & Brake Parts"],
  // Wheels
  [/\balloy wheel(s)?\b|\bwheel(s)?\b/, "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Wheels"],
];

export function inferCategoryPath(specifics) {
  const specMap = new Map((specifics || []).map(([k, v]) => [k, v]));
  const type = (specMap.get("Type") || "").trim();
  if (!type) return "";
  const t = type.toLowerCase();
  for (const [re, path] of CATEGORY_RULES) {
    if (re.test(t)) return path;
  }
  // Conservative last-resort: a real (if generic) eBay Motors path that the
  // seller can drill down in the Sell flow. Better than "-" because at
  // least it lands in the right top-level category tree.
  return `eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > ${type}`;
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
  // nothing useful, fallbackTitle() synthesises one from Type + Placement
  // + fitment year so the section is never empty.
  const rawTitles = listItems(sec[1] || "");
  // If the model wrote titles as plain (un-bulleted) lines, recover them.
  const titlePool =
    rawTitles.length > 0 ? rawTitles : plainContentLines(sec[1] || "", 15, 80);
  let titles = titlePool.filter(isValidTitle).map((t) => ({
    text: t,
    len: t.length,
  }));
  const specifics = kvItems(sec[2] || "");
  const fitBlock = sec[3] || "";
  let fitList = fitmentLines(fitBlock);
  // If the LLM skipped the fitment section entirely (common when the data
  // package is short and only carries a "Fits for ..." line), reverse-scan
  // the original pkgText for fitment cues as a last resort.
  if (fitList.length === 0) {
    fitList = extractPkgFitment(pkgText);
  }
  // If the section yielded several fits, join them as multi-line; otherwise keep it as-is.
  const fitment = fitList.length
    ? fitList.length === 1
      ? fitList[0]
      : fitList.join("; ")
    : "-";
  // Filter bullets by echo + category-path detection (the model sometimes
  // writes the category path here when it loses track of which section
  // comes next). If the model emitted plain prose lines instead of bullets,
  // fall back to plainContentLines().
  let bullets = listItems(sec[4] || "")
    .filter((b) => !looksLikeEcho(b) && !isCategoryPath(b))
    .slice(0, 5);
  if (bullets.length === 0) {
    bullets = plainContentLines(sec[4] || "", 8, 200).filter(
      (b) => !looksLikeEcho(b) && !isCategoryPath(b)
    ).slice(0, 5);
  }
  const desc = para(sec[5] || "");
  // Package Includes: drop echoes AND any line that looks like a category
  // path the model mistakenly emitted in this section.
  const pkgIncludes = listItems(sec[6] || "")
    .filter((p) => !looksLikeEcho(p) && !isCategoryPath(p));
  // Suggested eBay category path: model output wins, else infer from
  // Item Specifics[Type] (see inferCategoryPath). Without this fallback a
  // short-package SKU where the model skips sec[7] renders as "-" in the
  // UI — which gives the seller nothing to verify against.
  const category = para(sec[7] || "") || inferCategoryPath(specifics) || "-";
  const notes = listItems(sec[8] || "")
    .filter((n) => !looksLikeEcho(n) && !isCategoryPath(n));
  // Fallback title synthesis (covers SKUs that have no OEM number and the
  // model emits no usable title).
  if (titles.length === 0) {
    const synth = fallbackTitle(specifics, fitment);
    if (synth) titles = [{ text: synth, len: synth.length }];
  }

  return {
    ok: true,
    model,
    seconds: Math.round(seconds * 10) / 10,
    tokens,
    titles,
    specifics,
    fitment,
    bullets,
    description: desc,
    package_includes: pkgIncludes,
    category,
    html: buildHtml(titles[0]?.text || "", fitment, bullets, desc, specifics, pkgIncludes),
    notes,
    verify: verifyOutput(title, pkgText, llmText),
  };
}
