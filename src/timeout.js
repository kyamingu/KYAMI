export function runWithTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error("KYAMI AI took too long to respond. Please try again."),
      { code: "AI_TIMEOUT", status: 504 },
    )), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
