// Branch tests for the Vercel handler (no network).
//   node tests/api.test.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import handler from "../api/generate.js";

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

const req = (over = {}) => ({
  method: "POST",
  headers: {},
  body: { text: PKG_TEXT },
  socket: { remoteAddress: "1.2.3.4" },
  ...over,
});

const res = () => {
  const r = { statusCode: 200, headers: {}, body: null, ended: false };
  r.setHeader = (k, v) => {
    r.headers[k] = v;
  };
  r.status = (c) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b) => {
    r.jsonBody = b;
    r.ended = true;
    return r;
  };
  r.end = () => {
    r.ended = true;
    return r;
  };
  return r;
};

const geminiOk = () => ({
  ok: true,
  json: async () => ({
    usageMetadata: { promptTokenCount: 582, candidatesTokenCount: 657 },
    candidates: [{ content: { parts: [{ text: FIXTURE }] } }],
  }),
});

const realFetch = globalThis.fetch;
const setFetch = (fn) => {
  globalThis.fetch = fn;
};

// Env is process.env for Vercel; snapshot and restore around each block.
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "ALLOWED_ORIGINS",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
];
const clearEnv = () => ENV_KEYS.forEach((k) => delete process.env[k]);

try {
  console.log("\n[1] method + CORS");
  clearEnv();
  let r = res();
  await handler(req({ method: "OPTIONS" }), r);
  ok("OPTIONS -> 204", r.statusCode === 204);
  ok("CORS header set", r.headers["Access-Control-Allow-Methods"].includes("POST"));

  r = res();
  await handler(req({ method: "GET" }), r);
  ok("GET -> 405", r.statusCode === 405);

  console.log("\n[2] guard rails");
  clearEnv();
  r = res();
  await handler(req(), r);
  ok("missing key -> 503", r.statusCode === 503);
  ok("no internals leaked", !JSON.stringify(r.jsonBody).includes("GEMINI"));

  process.env.GEMINI_API_KEY = "k";
  r = res();
  await handler(req({ body: { text: "short" } }), r);
  ok("short package -> 400", r.statusCode === 400);

  // Noise-only package (~70 chars, no part numbers / fitment) must be rejected
  // before any Gemini call — reproduces the "Listing engine is busy" 502 from a
  // two-line supplier note with no real specs.
  const NOISE = "Instruction is not included. Professional installation is recommended.";
  r = res();
  await handler(req({ body: { text: NOISE } }), r);
  ok("noise-only ~70-char package -> 400 (not 502 busy)", r.statusCode === 400);

  r = res();
  await handler(req({ body: "not-json{" }), r);
  ok("malformed body -> 400", r.statusCode === 400);

  console.log("\n[3] quota (3/day, Vercel KV REST)");
  const kvStore = {};
  let kvWrites = 0;
  setFetch(async (url, init) => {
    if (String(url).startsWith("https://kv.test")) {
      const cmd = JSON.parse(init.body);
      if (cmd[0] === "GET") {
        return { ok: true, json: async () => ({ result: kvStore[cmd[1]] ?? null }) };
      }
      kvStore[cmd[1]] = String(cmd[2]);
      kvWrites++;
      return { ok: true, json: async () => ({ result: "OK" }) };
    }
    return geminiOk();
  });
  process.env.KV_REST_API_URL = "https://kv.test";
  process.env.KV_REST_API_TOKEN = "tok";

  kvStore["rl:" + new Date().toISOString().slice(0, 10) + ":1.2.3.4"] = "3";
  r = res();
  await handler(req(), r);
  ok("over quota -> 429", r.statusCode === 429, `got ${r.statusCode}`);
  ok("quota message mentions reset", r.jsonBody.error.includes("UTC"));

  delete kvStore["rl:" + new Date().toISOString().slice(0, 10) + ":1.2.3.4"];
  kvWrites = 0;
  r = res();
  await handler(req(), r);
  ok("under quota -> 200", r.statusCode === 200, `got ${r.statusCode}`);
  ok("counter written once", kvWrites === 1, String(kvWrites));
  ok("remaining reported", r.jsonBody.remaining === 2, JSON.stringify(r.jsonBody.remaining));

  // no KV configured -> fail open, still works
  clearEnv();
  process.env.GEMINI_API_KEY = "k";
  r = res();
  await handler(req(), r);
  ok("no KV -> fail open 200", r.statusCode === 200);
  ok("no KV -> remaining omitted", r.jsonBody.remaining === undefined);

  console.log("\n[4] origin allow-list");
  process.env.ALLOWED_ORIGINS = "ebayautoguru.com";
  r = res();
  await handler(req({ headers: { origin: "https://evil.example" } }), r);
  ok("foreign origin -> 403", r.statusCode === 403);
  r = res();
  await handler(req({ headers: { origin: "https://ebayautoguru.com" } }), r);
  ok("own origin -> 200", r.statusCode === 200);
  clearEnv();
  process.env.GEMINI_API_KEY = "k";

  console.log("\n[5] key never in URL");
  let seenUrl = "";
  let seenHeaders = null;
  setFetch(async (url, init) => {
    seenUrl = String(url);
    seenHeaders = init.headers;
    return geminiOk();
  });
  process.env.GEMINI_API_KEY = "SECRETKEY1234567890";
  await handler(req(), res());
  ok("key not in URL", !seenUrl.includes("SECRETKEY"), seenUrl);
  ok("key via header", seenHeaders["x-goog-api-key"] === "SECRETKEY1234567890");
  process.env.GEMINI_API_KEY = "k";

  console.log("\n[6] model fallback chain");
  const tried = [];
  setFetch(async (url) => {
    tried.push(String(url).split("/models/")[1].split(":")[0]);
    return { ok: false, status: 503, text: async () => "busy" };
  });
  const warn = console.warn;
  let warns = 0;
  console.warn = () => warns++;
  r = res();
  await handler(req(), r);
  console.warn = warn;
  ok("all 3 models tried", tried.length === 3, tried.join(","));
  ok("exhausted -> 502", r.statusCode === 502);
  ok("failures logged", warns === 3, String(warns));

  let n = 0;
  const tried2 = [];
  setFetch(async (url) => {
    tried2.push(String(url).split("/models/")[1].split(":")[0]);
    n++;
    return n === 1 ? { ok: false, status: 500, text: async () => "boom" } : geminiOk();
  });
  console.warn = () => {};
  r = res();
  await handler(req(), r);
  console.warn = warn;
  ok("falls through to 2nd", tried2.length === 2 && r.statusCode === 200, tried2.join(","));

  console.log("\n[7] success payload");
  setFetch(async () => geminiOk());
  r = res();
  await handler(req(), r);
  const j = r.jsonBody;
  ok("ok:true", j.ok === true);
  ok("3 titles + lengths", j.titles.length === 3 && j.titles[0].len > 0);
  ok("6 specifics", j.specifics.length === 6);
  ok("fitment/category/includes", !!j.fitment && !!j.category && j.package_includes.length === 1);
  ok("html 6 blocks", ["Fitment / Compatibility", "Specifications", "Features", "Package Includes", "Note:"].every((b) => j.html.includes(b)));
  ok("verify attached", j.verify.matched === j.verify.total, JSON.stringify(j.verify));
  ok("no-store cache", r.headers["Cache-Control"] === "no-store");

  console.log("\n[8] parity with Cloudflare build");
  const cfMod = await import("../functions/api/generate.js");
  const cfReq = new Request("https://x/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: PKG_TEXT }),
  });
  const cfRes = await cfMod.onRequestPost({ request: cfReq, env: { GEMINI_API_KEY: "k" } });
  const cfJson = await cfRes.json();
  const strip = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    delete c.seconds;
    delete c.remaining;
    return c;
  };
  ok("same titles", JSON.stringify(cfJson.titles) === JSON.stringify(j.titles));
  ok("same specifics", JSON.stringify(cfJson.specifics) === JSON.stringify(j.specifics));
  ok("same html", cfJson.html === j.html);
  ok("same verify", JSON.stringify(cfJson.verify) === JSON.stringify(j.verify));
  ok("same notes/category/fitment", JSON.stringify(strip(cfJson).category) === JSON.stringify(strip(j).category) && JSON.stringify(cfJson.notes) === JSON.stringify(j.notes) && cfJson.fitment === j.fitment);
} finally {
  globalThis.fetch = realFetch;
  clearEnv();
}

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}\n`);
