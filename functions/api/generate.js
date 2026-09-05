// EbayAutoGuru — POST /api/generate (Cloudflare Pages Function)
// Inactive on Vercel (see api/generate.js). Kept so the project can move to
// Pages later with no front-end change — both handlers share lib/listing.js.
import { MODELS, MAX_TEXT, buildPrompt, buildResult } from "../../lib/listing.js";

const DAILY_LIMIT = 3; // matches the "Free: 3 listings per day" promise on the page
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });

const clientIp = (request) =>
  request.headers.get("CF-Connecting-IP") ||
  (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
  "unknown";

/** Seconds until UTC midnight — used as the KV TTL for the daily counter. */
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
 * Daily per-IP quota. Requires a KV namespace bound as RATE_KV.
 * If the binding is missing we fail open (no limit) instead of blocking users —
 * the Gemini key itself is the real backstop.
 */
async function consumeQuota(env, ip) {
  if (!env.RATE_KV) {
    return { limited: false, used: null, remaining: null, reset: null };
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${day}:${ip}`;
  const used = Number((await env.RATE_KV.get(key)) || 0);
  if (used >= DAILY_LIMIT) {
    return { limited: true, used, remaining: 0, reset: secondsToUtcMidnight() };
  }
  const next = used + 1;
  await env.RATE_KV.put(key, String(next), {
    expirationTtl: secondsToUtcMidnight(),
  });
  return {
    limited: false,
    used: next,
    remaining: DAILY_LIMIT - next,
    reset: secondsToUtcMidnight(),
  };
}

/** Optional origin allow-list: set ALLOWED_ORIGINS in Pages env to stop endpoint theft. */
function originBlocked(request, env) {
  const allow = (env.ALLOWED_ORIGINS || "").trim();
  if (!allow) return false;
  const origin = request.headers.get("Origin");
  if (!origin) return false; // non-browser clients: quota + input caps still apply
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

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function onRequestPost({ request, env }) {
  if (originBlocked(request, env)) {
    return json({ ok: false, error: "Origin not allowed." }, 403);
  }

  const key = (env.GEMINI_API_KEY || "").trim();
  if (!key) {
    return json(
      { ok: false, error: "Service is not configured. Please try again later." },
      503
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request." }, 400);
  }

  const pkgText = String((payload && payload.text) || "").trim();
  if (pkgText.length < 40) {
    return json(
      {
        ok: false,
        error:
          "That data package looks too short — paste the whole supplier listing (title, part numbers, fitment, description).",
      },
      400
    );
  }
  const text = pkgText.slice(0, MAX_TEXT);

  const quota = await consumeQuota(env, clientIp(request));
  if (quota.limited) {
    return json(
      {
        ok: false,
        error: `You've used all ${DAILY_LIMIT} free listings for today. The quota resets at 00:00 UTC.`,
        remaining: 0,
      },
      429
    );
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
      return json(result, 200, { "Access-Control-Allow-Origin": "*" });
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      console.warn(`[generate] ${lastError}`);
    }
  }

  return json(
    {
      ok: false,
      error: "The listing engine is busy. Please try again in a moment.",
      detail: lastError.slice(0, 200),
    },
    502
  );
}
