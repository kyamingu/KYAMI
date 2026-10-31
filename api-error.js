globalThis.kyamiApiErrorMessage = function apiErrorMessage(data, response) {
  const legacyError = typeof data?.error === "string" ? data.error : "";
  const nestedError = data?.error && typeof data.error === "object" ? data.error : {};
  const code = typeof data?.code === "string" ? data.code : nestedError.code;
  const message = typeof data?.message === "string"
    ? data.message
    : (typeof nestedError.message === "string" ? nestedError.message : legacyError);

  if (code === "RATE_LIMITED") {
    const headerRetryAfter = Number(response?.headers?.get("Retry-After"));
    const resetAt = data?.resetAt ?? nestedError.resetAt;
    const resetRetryAfter = resetAt ? Math.ceil((Date.parse(resetAt) - Date.now()) / 1000) : 0;
    const retryAfter = Number.isFinite(headerRetryAfter) && headerRetryAfter > 0
      ? headerRetryAfter
      : resetRetryAfter;
    const wait = retryAfter > 0
      ? ` Try again in about ${retryAfter} seconds.`
      : " Please wait before trying again.";
    return `You've reached the chat limit for this minute.${wait}`;
  }

  if (code === "RATE_LIMITER_UNAVAILABLE") {
    return "Chat is temporarily unavailable. Please try again later.";
  }
  return message || legacyError;
};
