import { describe, expect, it, vi } from "vitest";
import { env as cloudflareEnv } from "cloudflare:workers";
import worker from "../src/index.js";
import { LIMITS, MODEL } from "../src/constants.js";
import { runWithTimeout } from "../src/timeout.js";
import "../api-error.js";

const ORIGIN = "https://kyami-ai.aimraneoubram.workers.dev";

function envWithAI(implementation = async () => ({ response: "Hello from KYAMI." })) {
  return {
    AI: { run: vi.fn(implementation) },
    RATE_LIMITER: cloudflareEnv.RATE_LIMITER,
    ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
  };
}

function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.origin !== undefined) headers.set("Origin", options.origin);
  if (options.ip) headers.set("CF-Connecting-IP", options.ip);
  return new Request(`${ORIGIN}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });
}

function chatRequest(messages = [{ role: "user", text: "Hi" }], options = {}) {
  return request("/api/chat", {
    method: options.method || "POST",
    origin: options.origin,
    ip: options.noIp ? undefined : (options.ip || `test-${Math.random()}`),
    headers: options.headers || { "Content-Type": "application/json" },
    body: options.body === undefined ? JSON.stringify({ messages, ...options.extra }) : options.body,
  });
}

async function jsonResponse(response) {
  return response.json();
}

describe("KYAMI Worker API", () => {
  it("serves health metadata", async () => {
    const env = envWithAI();
    delete env.RATE_LIMITER;
    const response = await worker.fetch(request("/api/health"), env);
    expect(response.status).toBe(200);
    expect(await jsonResponse(response)).toEqual({ status: "ok", provider: "Cloudflare Workers AI", model: MODEL });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("lists only the supported server-side model", async () => {
    const env = envWithAI();
    delete env.RATE_LIMITER;
    const response = await worker.fetch(request("/api/models"), env);
    expect(await jsonResponse(response)).toEqual({ models: [MODEL] });
  });

  it("returns a string error and separate code and message on API failures", async () => {
    const env = envWithAI();
    const missingBindingEnv = envWithAI();
    delete missingBindingEnv.RATE_LIMITER;
    const responses = [
      await worker.fetch(chatRequest(undefined, { body: "{}" }), env),
      await worker.fetch(chatRequest(undefined, { origin: "https://attacker.example" }), env),
      await worker.fetch(request("/api/not-found"), env),
      await worker.fetch(request("/api/chat", { method: "GET" }), env),
      await worker.fetch(chatRequest(), missingBindingEnv),
    ];
    expect(responses.map((response) => response.status)).toEqual([400, 403, 404, 405, 503]);
    for (const response of responses) {
      const body = await jsonResponse(response);
      expect(typeof body.error).toBe("string");
      expect(typeof body.code).toBe("string");
      expect(typeof body.message).toBe("string");
      expect(body.error).toBe(body.message);
    }
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(missingBindingEnv.AI.run).not.toHaveBeenCalled();
  });

  it("generates a chat response with a bounded, server-selected model", async () => {
    const env = envWithAI();
    const response = await worker.fetch(chatRequest(), env);
    expect(response.status).toBe(200);
    expect(await jsonResponse(response)).toEqual({ reply: "Hello from KYAMI.", model: MODEL });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(env.AI.run.mock.calls[0][0]).toBe(MODEL);
    expect(env.AI.run.mock.calls[0][1].max_tokens).toBe(LIMITS.maxOutputTokens);
    expect(env.AI.run.mock.calls[0][2]).toEqual({ rejectIfBusy: true });
    expect(response.headers.get("RateLimit-Limit")).toBe("5");
    expect(response.headers.get("RateLimit-Remaining")).toBe("4");
  });

  it("returns a safe INVALID_JSON error", async () => {
    const response = await worker.fetch(chatRequest(undefined, { body: "{" }), envWithAI());
    expect(response.status).toBe(400);
    expect((await jsonResponse(response)).code).toBe("INVALID_JSON");
  });

  it("rejects a missing messages field", async () => {
    const response = await worker.fetch(chatRequest(undefined, { body: "{}" }), envWithAI());
    expect(response.status).toBe(400);
    expect((await jsonResponse(response)).code).toBe("INVALID_MESSAGES");
  });

  it("rejects empty messages and empty text", async () => {
    const env = envWithAI();
    const emptyArray = await worker.fetch(chatRequest([], { ip: "empty-array" }), env);
    const emptyText = await worker.fetch(chatRequest([{ role: "user", text: "  " }], { ip: "empty-text" }), env);
    expect((await jsonResponse(emptyArray)).code).toBe("INVALID_MESSAGES");
    expect((await jsonResponse(emptyText)).code).toBe("INVALID_MESSAGES");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects unsupported message roles and invalid role ordering", async () => {
    const env = envWithAI();
    const unsupported = await worker.fetch(chatRequest([{ role: "system", text: "no" }], { ip: "bad-role" }), env);
    const repeated = await worker.fetch(chatRequest([
      { role: "user", text: "one" }, { role: "user", text: "two" },
    ], { ip: "repeated-role" }), env);
    expect((await jsonResponse(unsupported)).code).toBe("INVALID_MESSAGES");
    expect((await jsonResponse(repeated)).code).toBe("INVALID_MESSAGES");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects unsupported message fields", async () => {
    const response = await worker.fetch(chatRequest([
      { role: "user", text: "Hi", system: true },
    ], { ip: "extra-message-field" }), envWithAI());
    expect(response.status).toBe(400);
    expect((await jsonResponse(response)).code).toBe("INVALID_MESSAGES");
  });

  it("rejects unsupported model identifiers", async () => {
    const env = envWithAI();
    const response = await worker.fetch(chatRequest(undefined, {
      extra: { model: "some/other-model" }, ip: "bad-model",
    }), env);
    expect(response.status).toBe(400);
    expect((await jsonResponse(response)).code).toBe("UNSUPPORTED_MODEL");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before JSON parsing", async () => {
    const response = await worker.fetch(chatRequest(undefined, {
      body: "x",
      headers: { "Content-Type": "application/json", "Content-Length": String(LIMITS.bodyBytes + 1) },
      ip: "oversize-body",
    }), envWithAI());
    expect(response.status).toBe(413);
    expect((await jsonResponse(response)).code).toBe("REQUEST_TOO_LARGE");
  });

  it("enforces the maximum message count", async () => {
    const messages = Array.from({ length: LIMITS.messageCount + 1 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant", text: "x",
    }));
    const response = await worker.fetch(chatRequest(messages, { ip: "too-many-messages" }), envWithAI());
    expect(response.status).toBe(400);
    expect((await jsonResponse(response)).code).toBe("INVALID_MESSAGES");
  });

  it("enforces per-message and total context limits", async () => {
    const env = envWithAI();
    const longMessage = await worker.fetch(chatRequest([{ role: "user", text: "x".repeat(LIMITS.messageChars + 1) }], { ip: "long-message" }), env);
    const largeContext = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant", text: "x".repeat(8000),
    }));
    const longConversation = await worker.fetch(chatRequest(largeContext, { ip: "long-context" }), env);
    expect((await jsonResponse(longMessage)).code).toBe("INVALID_MESSAGES");
    expect(longConversation.status).toBe(413);
    expect((await jsonResponse(longConversation)).code).toBe("CONTEXT_TOO_LARGE");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("rejects invalid HTTP methods with Allow", async () => {
    const response = await worker.fetch(request("/api/chat", { method: "GET" }), envWithAI());
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
    expect((await jsonResponse(response)).code).toBe("METHOD_NOT_ALLOWED");
  });

  it("rejects unsupported content types", async () => {
    const response = await worker.fetch(chatRequest(undefined, {
      headers: { "Content-Type": "text/plain" }, ip: "bad-content-type",
    }), envWithAI());
    expect(response.status).toBe(415);
    expect((await jsonResponse(response)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("allows the production and GitHub Pages origins", async () => {
    for (const origin of [ORIGIN, "https://kyamingu.github.io"]) {
      const response = await worker.fetch(request("/api/health", { origin }), envWithAI());
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
  });

  it("rejects unexpected origins", async () => {
    const response = await worker.fetch(chatRequest(undefined, { origin: "https://attacker.example", ip: "bad-origin" }), envWithAI());
    expect(response.status).toBe(403);
    expect((await jsonResponse(response)).code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("allows requests without Origin but does not mistake that for authentication", async () => {
    const env = envWithAI();
    const response = await worker.fetch(chatRequest(undefined, { ip: "no-origin" }), env);
    expect(response.status).toBe(200);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("handles OPTIONS preflight for the route", async () => {
    const response = await worker.fetch(request("/api/chat", {
      method: "OPTIONS", origin: "https://kyamingu.github.io",
    }), envWithAI());
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
  });

  it("rejects a preflight method the route does not support", async () => {
    const response = await worker.fetch(request("/api/chat", {
      method: "OPTIONS", origin: "https://kyamingu.github.io",
      headers: { "Access-Control-Request-Method": "DELETE" },
    }), envWithAI());
    expect(response.status).toBe(405);
    expect((await jsonResponse(response)).code).toBe("PREFLIGHT_METHOD_NOT_ALLOWED");
  });

  it("returns RATE_LIMITED after the anonymous per-IP request threshold", async () => {
    const env = envWithAI();
    const ip = "worker-rate-limit-test";
    for (let i = 0; i < LIMITS.perIpRequests; i += 1) {
      expect((await worker.fetch(chatRequest(undefined, { ip }), env)).status).toBe(200);
    }
    const limited = await worker.fetch(chatRequest(undefined, { ip }), env);
    expect(limited.status).toBe(429);
    const body = await jsonResponse(limited);
    expect(body).toMatchObject({
      error: "Too many requests. Please wait before trying again.",
      code: "RATE_LIMITED",
      message: "Too many requests. Please wait before trying again.",
    });
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBe(Math.max(1, Math.ceil((Date.parse(body.resetAt) - Date.now()) / 1000)));
    expect(limited.headers.get("RateLimit-Remaining")).toBe("0");
    expect(env.AI.run).toHaveBeenCalledTimes(LIMITS.perIpRequests);
  });

  it("fails closed when the Durable Object binding is missing", async () => {
    const env = envWithAI();
    delete env.RATE_LIMITER;
    const response = await worker.fetch(chatRequest(), env);
    expect(response.status).toBe(503);
    expect(await jsonResponse(response)).toMatchObject({
      error: "KYAMI is temporarily unavailable. Please try again later.",
      code: "RATE_LIMITER_UNAVAILABLE",
      message: "KYAMI is temporarily unavailable. Please try again later.",
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("fails closed when Durable Object storage reports a Free-plan quota or availability error", async () => {
    const env = envWithAI();
    env.RATE_LIMITER = {
      idFromName: vi.fn(() => "fixed-id"),
      get: vi.fn(() => ({ fetch: vi.fn(async () => { throw new Error("SQLITE_FULL"); }) })),
    };
    const response = await worker.fetch(chatRequest(), env);
    expect(response.status).toBe(503);
    const body = await jsonResponse(response);
    expect(body.code).toBe("RATE_LIMITER_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("SQLITE_FULL");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("uses one conservative shared bucket when Cloudflare omits the client IP", async () => {
    const env = envWithAI();
    for (let index = 0; index < LIMITS.perIpRequests; index += 1) {
      const response = await worker.fetch(chatRequest(undefined, {
        noIp: true,
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${index}` },
      }), env);
      expect(response.status).toBe(200);
    }
    const limited = await worker.fetch(chatRequest(undefined, {
      noIp: true,
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.42" },
    }), env);
    expect(limited.status).toBe(429);
    expect(env.AI.run).toHaveBeenCalledTimes(LIMITS.perIpRequests);
  });

  it("caps concurrent AI calls within one Worker isolate", async () => {
    let started = 0;
    const resolvers = [];
    const env = envWithAI(() => {
      started += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const active = Array.from({ length: LIMITS.concurrentPerIsolate }, (_, index) =>
      worker.fetch(chatRequest(undefined, { ip: `parallel-${index}` }), env));
    for (let attempt = 0; started < LIMITS.concurrentPerIsolate && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(started).toBe(LIMITS.concurrentPerIsolate);
    const extra = await worker.fetch(chatRequest(undefined, { ip: "parallel-extra" }), env);
    expect(extra.status).toBe(503);
    expect((await jsonResponse(extra)).code).toBe("BUSY");
    for (const resolve of resolvers) resolve({ response: "done" });
    const responses = await Promise.all(active);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it("maps AI daily quota exhaustion to a safe response with UTC reset", async () => {
    const env = envWithAI(async () => { throw new Error("Workers AI error 3036: daily free allocation exhausted"); });
    const response = await worker.fetch(chatRequest(undefined, { ip: "ai-quota-test" }), env);
    expect(response.status).toBe(429);
    expect(await jsonResponse(response)).toMatchObject({
      code: "AI_QUOTA_EXHAUSTED", resetAt: expect.stringMatching(/T00:00:00\.000Z$/),
    });
  });

  it("maps provider capacity errors without retrying", async () => {
    const env = envWithAI(async () => { throw new Error("3040 capacity temporarily exceeded"); });
    const response = await worker.fetch(chatRequest(undefined, { ip: "ai-capacity-test" }), env);
    expect(response.status).toBe(429);
    expect((await jsonResponse(response)).code).toBe("AI_CAPACITY_LIMITED");
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("maps provider timeout errors and hides internal messages", async () => {
    const env = envWithAI(async () => { throw new Error("3007 internal inference timeout details"); });
    const response = await worker.fetch(chatRequest(undefined, { ip: "ai-timeout-test" }), env);
    expect(response.status).toBe(504);
    const body = await jsonResponse(response);
    expect(body.code).toBe("AI_TIMEOUT");
    expect(JSON.stringify(body)).not.toContain("internal inference");
  });

  it("bounds the wait for an unresolved model promise", async () => {
    await expect(runWithTimeout(new Promise(() => {}), 5)).rejects.toMatchObject({ code: "AI_TIMEOUT", status: 504 });
  });

  it("returns a safe provider error without stack details", async () => {
    const env = envWithAI(async () => { throw new Error("private provider response dump"); });
    const response = await worker.fetch(chatRequest(undefined, { ip: "ai-error-test" }), env);
    expect(response.status).toBe(503);
    const body = await jsonResponse(response);
    expect(body.code).toBe("AI_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("private provider");
  });

  it("routes non-API paths to static assets and adds security headers", async () => {
    const env = envWithAI();
    const response = await worker.fetch(request("/index.html"), env);
    expect(await response.text()).toBe("asset");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
