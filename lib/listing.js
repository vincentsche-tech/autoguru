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
export function splitSections(text) {
  const marks = [];
  const re = /^[ \t]*([1-8])\.[ \t]+.*$/gm;
  for (const m of (text || "").matchAll(re)) {
    marks.push([Number(m[1]), m.index, m.index + m[0].length]);
  }
  const secs = {};
  marks.forEach(([num, _s, e], i) => {
    const end = i + 1 < marks.length ? marks[i + 1][1] : (text || "").length;
    if (secs[num] === undefined) secs[num] = text.slice(e, end).trim();
  });
  return secs;
}

export function listItems(block) {
  const out = [];
  for (const raw of (block || "").split(/\r?\n/)) {
    const ln = raw.trim();
    if (!/^[-*•]\s+/.test(ln)) continue;
    const item = ln.replace(/[-*•]\s+/, "").trim();
    if (item && item.toUpperCase() !== "NONE") out.push(item);
  }
  return out;
}

export function kvItems(block) {
  const out = [];
  for (const raw of (block || "").split(/\r?\n/)) {
    const ln = raw.trim();
    if (!/^[-*•]\s+/.test(ln) || !ln.includes(":")) continue;
    const body = ln.replace(/[-*•]\s+/, "");
    const i = body.indexOf(":");
    out.push([body.slice(0, i).trim(), body.slice(i + 1).trim()]);
  }
  return out;
}

export function para(block) {
  const lines = (block || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) =>
      /^\s*[-*•]/.test(l) ? l.replace(/[-*•]\s+/, "") : l.replace(/\*\*/g, "")
    );
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
Output in this exact order:
1. Three Cassini-optimized titles (max 80 chars each): Part Type plus OEM/Interchange plus Fitment plus side/placement. The first 4 words must be the highest-traffic search terms a buyer would type (part type / brand / OEM number). Title Case, no decorative punctuation (! @ ?). Avoid unclear abbreviations.
2. Item Specifics (Brand, MPN, OEM Part Number, Interchange Part Number, Placement on Vehicle, Material, Type, Manufacturer Part Number, Fitment Type; include Warranty ONLY if the data package states one, otherwise omit the field)
3. Fitment line parsed from Application (Year/Make/Model/Trim/Side)
4. Five bullet selling points (benefit-driven, premium tone, based only on the package)
5. Description first paragraph (2-3 sentences, benefit-driven, no external links; naturally work in the main part number(s) and year/make/model; no keyword stuffing)
6. Package Includes: list ONLY the items explicitly stated in the data package (e.g. "2x Front Lower Control Arm"). If not stated, write None.
7. Suggested eBay category path (text path only, e.g. eBay Motors > Parts & Accessories > Suspension & Steering > Control Arms & Parts; no category ID; suggestion for the seller to verify)
8. Notes to Seller: list ONLY contradictions or suspicious points found inside the data package itself (left/right vs piece count vs OEM pairing, Driver=Left mapping, fitment vs OEM generation logic, material/placement mismatch, package category vs product type mismatch, OE number missing for one side). If none, write None. Do NOT invent facts; reminders must be based on the package text only.
Do NOT invent any OEM numbers, interchange numbers or vehicle fitments not listed above. Every part number you output MUST exist verbatim in the data package. Never add "common" interchange numbers from your own knowledge.
Output ONLY sections 1-8 (no image guides, no HTML unless asked).
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
  const titles = listItems(sec[1] || "").slice(0, 3);
  const specifics = kvItems(sec[2] || "");
  const fitBlock = sec[3] || "";
  const fitList = listItems(fitBlock);
  const fitment = fitList.length
    ? fitList[0]
    : fitBlock.replace(/\s+/g, " ").trim() || "-";
  const bullets = listItems(sec[4] || "").slice(0, 5);
  const desc = para(sec[5] || "");
  const pkgIncludes = listItems(sec[6] || "");
  const category = para(sec[7] || "") || "-";
  const notes = listItems(sec[8] || "");

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
