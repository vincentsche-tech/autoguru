// EbayAutoGuru — POST /api/generate (Vercel Node serverless function)
// Shares lib/listing.js with the Cloudflare Pages build, so both platforms
// emit byte-identical results. Front end calls /api/generate unchanged.
import { MODELS, MAX_TEXT, buildPrompt, buildResult } from "../lib/listing.js";

const DAILY_LIMIT = 3; // matches the "Free: 3 listings per day" promise on the page
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.headers["x-real-ip"] ||
  req.socket?.remoteAddress ||
  "unknown";

const secondsToUtcMidnight = () => {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return Math.max(60, Math.ceil((midnight - now.getTime()) / 1000));
};

/**
 * Vercel KV over its REST API — no npm dependency.
 * Returns null when KV isn't configured, and callers fail open (no quota)
 * rather than taking the tool offline over a missing binding.
 */
async function kv(env, cmd) {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.error ? null : j.result;
  } catch {
    return null;
  }
}

async function consumeQuota(env, ip) {
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) {
    return { limited: false, used: null, remaining: null };
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${day}:${ip}`;
  const used = Number((await kv(env, ["GET", key])) || 0);
  if (used >= DAILY_LIMIT) {
    return { limited: true, used, remaining: 0 };
  }
  const next = used + 1;
  await kv(env, ["SET", key, String(next), "EX", secondsToUtcMidnight()]);
  return { limited: false, used: next, remaining: DAILY_LIMIT - next };
}

function originBlocked(req, env) {
  const allow = (env.ALLOWED_ORIGINS || "").trim();
  if (!allow) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  return !allow.split(",").some((h) => origin.includes(h.trim()));
}

async function callGemini(model, key, prompt) {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key, // keeps the key out of URLs and access logs
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`${model}: HTTP ${res.status} ${detail}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const env = process.env;
  if (originBlocked(req, env)) {
    return res.status(403).json({ ok: false, error: "Origin not allowed." });
  }

  const key = (env.GEMINI_API_KEY || "").trim();
  if (!key) {
    return res
      .status(503)
      .json({ ok: false, error: "Service is not configured. Please try again later." });
  }

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const pkgText = String((body && body.text) || "").trim();
  if (pkgText.length < 80) {
    return res.status(400).json({
      ok: false,
      error:
        "That data package looks too short — paste the whole supplier listing, including part numbers (OEM / Interchange) and vehicle fitment / application list. A few lines of real specs lets the engine build a usable listing.",
    });
  }
  const text = pkgText.slice(0, MAX_TEXT);

  const quota = await consumeQuota(env, clientIp(req));
  if (quota.limited) {
    return res.status(429).json({
      ok: false,
      error: `You've used all ${DAILY_LIMIT} free listings for today. The quota resets at 00:00 UTC.`,
      remaining: 0,
    });
  }

  const prompt = buildPrompt(text);
  let lastError = "";
  for (const model of MODELS) {
    try {
      const t0 = Date.now();
      const data = await callGemini(model, key, prompt);
      const um = data.usageMetadata || {};
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      const llmText = parts.map((p) => p.text || "").join("");
      if (!llmText.trim()) throw new Error(`${model}: empty response`);
      const result = buildResult(
        text,
        llmText,
        model,
        (Date.now() - t0) / 1000,
        `${um.promptTokenCount || 0}/${um.candidatesTokenCount || 0}`
      );
      if (quota.remaining !== null) result.remaining = quota.remaining;
      return res.status(200).json(result);
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      console.warn(`[generate] ${lastError}`);
    }
  }

  return res.status(502).json({
    ok: false,
    error: "The listing engine is busy. Please try again in a moment.",
    detail: lastError.slice(0, 200),
  });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
