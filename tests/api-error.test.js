import { describe, expect, it } from "vitest";
import "../api-error.js";

const apiErrorMessage = globalThis.kyamiApiErrorMessage;

describe("frontend API error compatibility", () => {
  it("uses the restored string error and preserves the rate-limit countdown", () => {
    const message = "Too many requests. Please wait before trying again.";
    const result = apiErrorMessage({ error: message, code: "RATE_LIMITED", message }, {
      headers: new Headers({ "Retry-After": "12" }),
    });
    expect(result).toBe("You've reached the chat limit for this minute. Try again in about 12 seconds.");
  });

  it("handles the previous nested error format and reset-time countdown", () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const result = apiErrorMessage({
      error: { code: "RATE_LIMITED", message: "Too many requests", resetAt },
    });
    expect(result).toMatch(/^You've reached the chat limit for this minute\. Try again in about \d+ seconds\.$/);
  });

  it("handles the original error-string-only format", () => {
    expect(apiErrorMessage({ error: "Something went wrong" })).toBe("Something went wrong");
  });

  it("uses the nested human-readable message for other structured errors", () => {
    expect(apiErrorMessage({
      error: { code: "INVALID_JSON", message: "Request body must contain valid JSON." },
    })).toBe("Request body must contain valid JSON.");
  });
});
