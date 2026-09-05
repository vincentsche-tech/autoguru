// Branch tests for the Pages Function handler (no network).
// Mocks fetch so the model fallback chain and response shape can be verified.
//   node tests/handler.test.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { onRequestPost, onRequestOptions } from "../functions/api/generate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tests", "selftest.js"), "utf-8");
const FIXTURE = src.match(/const LLM = `([\s\S]*?)`;/)[1];
const PKG = JSON.parse(
  readFileSync(
    "D:/workbuddy space/cross-border-lister/scripts/sku72117963_package.json",
    "utf-8"
  )
);
const PKG_TEXT = `${PKG.title_en}\n${PKG.description_text}`;

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

const req = (body, headers = {}) =>
  new Request("https://example.com/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const realFetch = globalThis.fetch;
const mockFetch = (impl) => {
  globalThis.fetch = impl;
};
const geminiOk = () => ({
  ok: true,
  json: async () => ({
    usageMetadata: { promptTokenCount: 582, candidatesTokenCount: 657 },
    candidates: [{ content: { parts: [{ text: FIXTURE }] } }],
  }),
});

try {
  console.log("\n[1] guard rails");
  let r = await onRequestPost({ request: req({ text: PKG_TEXT }), env: {} });
  ok("missing key -> 503", r.status === 503);
  ok("no internal detail leaked", !(await r.text()).includes("GEMINI"));

  r = await onRequestPost({
    request: req({ text: "too short" }),
    env: { GEMINI_API_KEY: "k" },
  });
  ok("short package -> 400", r.status === 400);

  r = await onRequestPost({
    request: req("not json{"),
    env: { GEMINI_API_KEY: "k" },
  });
  ok("malformed body -> 400", r.status === 400);

  console.log("\n[2] quota (3/day per IP)");
  const full = { get: async () => "3", put: async () => {} };
  r = await onRequestPost({
    request: req({ text: PKG_TEXT }),
    env: { GEMINI_API_KEY: "k", RATE_KV: full },
  });
  ok("over quota -> 429", r.status === 429, `got ${r.status}`);
  ok("quota message mentions reset", (await r.text()).includes("UTC"));

  let putCalls = 0;
  const counter = {
    get: async () => "0",
    put: async (_k, _v, opts) => {
      putCalls++;
      globalThis.__ttl = opts && opts.expirationTtl;
    },
  };
  mockFetch(async () => geminiOk());
  r = await onRequestPost({
    request: req({ text: PKG_TEXT }),
    env: { GEMINI_API_KEY: "k", RATE_KV: counter },
  });
  ok("under quota -> 200", r.status === 200, `got ${r.status}`);
  ok("counter incremented once", putCalls === 1);
  ok("TTL set to <24h", globalThis.__ttl > 0 && globalThis.__ttl <= 86400, String(globalThis.__ttl));

  console.log("\n[3] origin allow-list");
  r = await onRequestPost({
    request: req({ text: PKG_TEXT }, { Origin: "https://evil.example" }),
    env: { GEMINI_API_KEY: "k", ALLOWED_ORIGINS: "ebayautoguru.com" },
  });
  ok("foreign origin -> 403", r.status === 403);
  r = await onRequestPost({
    request: req({ text: PKG_TEXT }, { Origin: "https://ebayautoguru.com" }),
    env: { GEMINI_API_KEY: "k", ALLOWED_ORIGINS: "ebayautoguru.com" },
  });
  ok("own origin -> 200", r.status === 200, `got ${r.status}`);

  console.log("\n[4] key never leaks into the request URL");
  let seenUrl = "";
  let seenHeaders = null;
  mockFetch(async (url, init) => {
    seenUrl = String(url);
    seenHeaders = init.headers;
    return geminiOk();
  });
  await onRequestPost({
    request: req({ text: PKG_TEXT }),
    env: { GEMINI_API_KEY: "SECRETKEY1234567890" },
  });
  ok("key not in URL", !seenUrl.includes("SECRETKEY"), seenUrl);
  ok("key sent via header", seenHeaders["x-goog-api-key"] === "SECRETKEY1234567890");

  console.log("\n[5] model fallback chain");
  const tried = [];
  mockFetch(async (url) => {
    tried.push(String(url).split("/models/")[1].split(":")[0]);
    return { ok: false, status: 503, text: async () => "upstream busy" };
  });
  const warn = console.warn;
  let warns = 0;
  console.warn = () => warns++;
  r = await onRequestPost({
    request: req({ text: PKG_TEXT }),
    env: { GEMINI_API_KEY: "k" },
  });
  console.warn = warn;
  ok("all 3 models attempted", tried.length === 3, tried.join(","));
  ok("exhausted -> 502", r.status === 502);
  ok("each failure logged", warns === 3, String(warns));

  // first model fails, second succeeds
  let n = 0;
  const tried2 = [];
  mockFetch(async (url) => {
    tried2.push(String(url).split("/models/")[1].split(":")[0]);
    n++;
    return n === 1 ? { ok: false, status: 500, text: async () => "boom" } : geminiOk();
  });
  console.warn = () => {};
  r = await onRequestPost({
    request: req({ text: PKG_TEXT }),
    env: { GEMINI_API_KEY: "k" },
  });
  console.warn = warn;
  ok("falls through to 2nd model", tried2.length === 2 && r.status === 200, tried2.join(","));

  console.log("\n[6] success payload shape");
  mockFetch(async () => geminiOk());
  r = await onRequestPost({
    request: req({ text: PKG_TEXT }),
    env: { GEMINI_API_KEY: "k" },
  });
  const j = await r.json();
  ok("ok:true", j.ok === true);
  ok("3 titles with lengths", j.titles.length === 3 && j.titles[0].len > 0);
  ok("specifics parsed", j.specifics.length === 6);
  ok("fitment + category + includes", !!j.fitment && !!j.category && j.package_includes.length === 1);
  ok("html 6 blocks", ["Fitment / Compatibility", "Specifications", "Features", "Package Includes", "Note:"].every((b) => j.html.includes(b)));
  ok("verify attached", j.verify && j.verify.matched === j.verify.total, JSON.stringify(j.verify));
  ok("no model name required by UI (kept for logs only)", typeof j.model === "string");
  ok("cache disabled", (r.headers.get("Cache-Control") || "").includes("no-store"));

  console.log("\n[7] CORS preflight");
  const pre = await onRequestOptions();
  ok("OPTIONS -> 204", pre.status === 204);
  ok("allows POST", (pre.headers.get("Access-Control-Allow-Methods") || "").includes("POST"));
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
