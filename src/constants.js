export const MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const LIMITS = Object.freeze({
  bodyBytes: 256 * 1024,
  messageCount: 20,
  messageChars: 8000,
  contextChars: 30000,
  maxOutputTokens: 768,
  aiTimeoutMs: 45000,
  perIpRequests: 5,
  perIpWindowMs: 60_000,
  concurrentPerIsolate: 4,
});
