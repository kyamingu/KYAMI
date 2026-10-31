import { hashClientIp, shardForClientKey, shardObjectName } from "./rate-limit.js";
import { LIMITS, MODEL } from "./constants.js";
import { runWithTimeout } from "./timeout.js";

const ALLOWED_ORIGINS = new Set([
  "https://kyami-ai.aimraneoubram.workers.dev",
  "https://kyamingu.github.io",
]);
export { KyamiRateLimiter } from "./rate-limit.js";
let inFlight = 0;

class ApiError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.resetAt = options.resetAt;
    this.remaining = options.remaining;
  }
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "style-src-attr 'unsafe-inline'",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  };
}

function json(data, status, origin, ownOrigin, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    ...securityHeaders(),
    ...extraHeaders,
  });
  if (origin && (origin === ownOrigin || ALLOWED_ORIGINS.has(origin))) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorBody(code, message, details = {}) {
  return { error: message, code, message, ...details };
}

function errorResponse(error, origin, ownOrigin) {
  const status = error instanceof ApiError ? error.status : 503;
  const code = error instanceof ApiError ? error.code : "AI_UNAVAILABLE";
  const message = error instanceof ApiError
    ? error.message
    : "KYAMI AI is temporarily unavailable. Please try again later.";
  const details = {};
  const headers = {};
  if (Number.isInteger(error?.retryAfter) && error.retryAfter > 0) {
    headers["Retry-After"] = String(error.retryAfter);
  }
  if (error?.resetAt) {
    details.resetAt = new Date(error.resetAt).toISOString();
    headers["RateLimit-Reset"] = String(Math.max(0, Math.ceil((error.resetAt - Date.now()) / 1000)));
  }
  if (Number.isInteger(error?.remaining)) {
    details.remaining = error.remaining;
    headers["RateLimit-Limit"] = String(LIMITS.perIpRequests);
    headers["RateLimit-Remaining"] = String(error.remaining);
  }
  return json(errorBody(code, message, details), status, origin, ownOrigin, headers);
}

function allowedOrigin(origin, ownOrigin) {
  return !origin || origin === ownOrigin || ALLOWED_ORIGINS.has(origin);
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJsonLimited(request) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.bodyBytes) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body is too large.");
  }
  if (!request.body) throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON.");

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > LIMITS.bodyBytes) {
        await reader.cancel();
        throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
}

function validateMessages(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }
  const allowedKeys = new Set(["messages", "model"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new ApiError(400, "INVALID_REQUEST", "Request contains unsupported fields.");
  }
  if (body.model !== undefined && body.model !== MODEL) {
    throw new ApiError(400, "UNSUPPORTED_MODEL", "The requested model is not supported.");
  }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > LIMITS.messageCount) {
    throw new ApiError(400, "INVALID_MESSAGES", `Send between 1 and ${LIMITS.messageCount} messages.`);
  }

  let totalChars = 0;
  const messages = [];
  for (const item of body.messages) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !["user", "assistant"].includes(item.role) || typeof item.text !== "string") {
      throw new ApiError(400, "INVALID_MESSAGES", "Each message must have a user or assistant role and text.");
    }
    if (Object.keys(item).some((key) => key !== "role" && key !== "text")) {
      throw new ApiError(400, "INVALID_MESSAGES", "Messages may contain only role and text fields.");
    }
    const text = item.text.trim();
    if (!text || text.length > LIMITS.messageChars) {
      throw new ApiError(400, "INVALID_MESSAGES", `Each message must contain 1 to ${LIMITS.messageChars} characters.`);
    }
    totalChars += text.length;
    if (totalChars > LIMITS.contextChars) {
      throw new ApiError(413, "CONTEXT_TOO_LARGE", `Conversation context must not exceed ${LIMITS.contextChars} characters.`);
    }
    if (messages.length === 0 && item.role !== "user") {
      throw new ApiError(400, "INVALID_MESSAGES", "Conversation must begin with a user message.");
    }
    if (messages.length > 0 && messages[messages.length - 1].role === item.role) {
      throw new ApiError(400, "INVALID_MESSAGES", "Conversation roles must alternate between user and assistant.");
    }
    messages.push({ role: item.role, content: text });
  }
  if (messages[messages.length - 1].role !== "user") {
    throw new ApiError(400, "INVALID_MESSAGES", "The final message must be from the user.");
  }
  return messages;
}

function nextUtcReset() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function providerErrorCode(error) {
  const serialized = [error?.code, error?.message, error?.cause?.code, error?.cause?.message]
    .filter((value) => value !== undefined && value !== null)
    .join(" ");
  const match = serialized.match(/\b(3036|3040|3007|3008)\b/);
  if (match) return match[1];
  if (/daily free allocation|neurons/i.test(serialized)) return "3036";
  if (/capacity temporarily exceeded|rejectifbusy/i.test(serialized)) return "3040";
  return "";
}

async function handleChat(request, env, origin, ownOrigin) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }

  if (inFlight >= LIMITS.concurrentPerIsolate) {
    throw new ApiError(503, "BUSY", "KYAMI is busy. Please try again shortly.", { retryAfter: 5 });
  }
  const body = await readJsonLimited(request);
  const messages = validateMessages(body);
  inFlight += 1;
  let aiStarted = false;
  let released = false;
  const releaseSlot = () => {
    if (!released) {
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    }
  };
  try {
    if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.idFromName !== "function" ||
        typeof env.RATE_LIMITER.get !== "function") {
      throw new ApiError(503, "RATE_LIMITER_UNAVAILABLE", "KYAMI is temporarily unavailable. Please try again later.");
    }

    let rate;
    try {
      const clientKey = await hashClientIp(request.headers.get("CF-Connecting-IP"));
      const shard = shardForClientKey(clientKey);
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(shardObjectName(shard)));
      const response = await stub.fetch("https://rate-limiter.internal/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey }),
      });
      if (!response.ok) throw new Error("Rate limiter rejected the internal check");
      rate = await response.json();
      if (typeof rate?.allowed !== "boolean" || !Number.isInteger(rate?.remaining) ||
          !Number.isFinite(rate?.resetAt)) throw new Error("Invalid rate limiter response");
    } catch {
      throw new ApiError(503, "RATE_LIMITER_UNAVAILABLE", "KYAMI is temporarily unavailable. Please try again later.");
    }
    if (!rate.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait before trying again.", {
        retryAfter: Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000)),
        resetAt: rate.resetAt,
        remaining: rate.remaining,
      });
    }

    let aiPromise;
    try {
      aiPromise = Promise.resolve(env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content: "You are KYAMI, a helpful and thoughtful AI assistant. Match the language of the user. When the user writes in Moroccan Darija, answer naturally in Moroccan Darija. Be clear, accurate, friendly, and honest.",
        },
        ...messages,
      ],
      max_tokens: LIMITS.maxOutputTokens,
      chat_template_kwargs: { enable_thinking: false },
      }, { rejectIfBusy: true }));
      aiStarted = true;
    } catch (error) {
      throw error;
    }
    aiPromise.finally(releaseSlot).catch(() => {});
    const result = await runWithTimeout(aiPromise, LIMITS.aiTimeoutMs).catch((error) => {
      if (error?.code === "AI_TIMEOUT") {
        throw new ApiError(504, "AI_TIMEOUT", "KYAMI AI took too long to respond. Please try again.");
      }
      const code = providerErrorCode(error);
      if (code === "3036") {
        const resetAt = nextUtcReset();
        throw new ApiError(429, "AI_QUOTA_EXHAUSTED", "The free AI quota is exhausted. Try again after 00:00 UTC.", {
          retryAfter: Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000)),
          resetAt,
        });
      }
      if (code === "3040") throw new ApiError(429, "AI_CAPACITY_LIMITED", "AI capacity is temporarily unavailable. Please try again shortly.", { retryAfter: 10 });
      if (code === "3007" || code === "3008") throw new ApiError(504, "AI_TIMEOUT", "KYAMI AI took too long to respond. Please try again.");
      throw error;
    });

    const reply = result?.choices?.[0]?.message?.content ?? result?.response ?? "";
    if (typeof reply !== "string" || !reply.trim()) {
      throw new ApiError(502, "EMPTY_AI_RESPONSE", "KYAMI could not generate a response. Please try again.");
    }
    return json({ reply: reply.trim(), model: MODEL }, 200, origin, ownOrigin, {
      "RateLimit-Limit": String(LIMITS.perIpRequests),
      "RateLimit-Remaining": String(rate.remaining),
      "RateLimit-Reset": String(Math.max(0, Math.ceil((rate.resetAt - Date.now()) / 1000))),
    });
  } catch (error) {
    throw error;
  } finally {
    if (!aiStarted) releaseSlot();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const ownOrigin = url.origin;

    if (!url.pathname.startsWith("/api/")) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }

    if (!allowedOrigin(origin, ownOrigin)) {
      return json(errorBody("ORIGIN_NOT_ALLOWED", "Origin not allowed."), 403, origin, ownOrigin);
    }

    const routeMethods = {
      "/api/health": "GET",
      "/api/models": "GET",
      "/api/chat": "POST",
    };
    const expectedMethod = routeMethods[url.pathname];
    if (!expectedMethod) return json(errorBody("NOT_FOUND", "API route not found."), 404, origin, ownOrigin);

    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("Access-Control-Request-Method");
      if (requestedMethod && requestedMethod.toUpperCase() !== expectedMethod) {
        const message = `Use ${expectedMethod} for this endpoint.`;
        return json(errorBody("PREFLIGHT_METHOD_NOT_ALLOWED", message), 405, origin, ownOrigin, { Allow: `${expectedMethod}, OPTIONS` });
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...securityHeaders(),
          "Access-Control-Allow-Origin": origin || ownOrigin,
          "Access-Control-Allow-Methods": `${expectedMethod}, OPTIONS`,
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
          "Vary": "Origin",
        },
      });
    }

    if (request.method !== expectedMethod) {
      const message = `Use ${expectedMethod} for this endpoint.`;
      return json(errorBody("METHOD_NOT_ALLOWED", message), 405, origin, ownOrigin, { Allow: `${expectedMethod}, OPTIONS` });
    }

    if (url.pathname === "/api/health") {
      return json({ status: "ok", provider: "Cloudflare Workers AI", model: MODEL }, 200, origin, ownOrigin);
    }
    if (url.pathname === "/api/models") {
      return json({ models: [MODEL] }, 200, origin, ownOrigin);
    }

    try {
      return await handleChat(request, env, origin, ownOrigin);
    } catch (error) {
      return errorResponse(error, origin, ownOrigin);
    }
  },
};
