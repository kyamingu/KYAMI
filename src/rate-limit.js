import { DurableObject } from "cloudflare:workers";

export const RATE_LIMIT_SHARDS = 16;
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 60_000;
export const RATE_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const CLEANUP_BATCH_SIZE = 500;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS rate_limits (
  client_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

/** SHA-256 the trusted Cloudflare client IP before it leaves the Worker. */
export async function hashClientIp(ip) {
  const value = ip || "kyami:shared-missing-client-ip:v1";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable mapping: the first digest byte maps every client to one of 16 fixed shards. */
export function shardForClientKey(clientKey) {
  if (!/^[a-f0-9]{64}$/i.test(clientKey)) throw new TypeError("Invalid client key");
  return Number.parseInt(clientKey.slice(0, 2), 16) % RATE_LIMIT_SHARDS;
}

export function shardObjectName(shard) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= RATE_LIMIT_SHARDS) {
    throw new RangeError("Invalid rate-limit shard");
  }
  return `kyami-rate-limit-v1-shard-${shard}`;
}

/** Serializes alarm reads/writes and preserves an already-earlier alarm. */
export class CleanupAlarmScheduler {
  constructor(storage) {
    this.storage = storage;
    this.lock = Promise.resolve();
  }

  #exclusive(callback) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    return previous.then(callback).finally(release);
  }

  async #ensureUnlocked(targetTime) {
    const current = await this.storage.getAlarm();
    if (current !== null && current <= targetTime) return current;
    await this.storage.setAlarm(targetTime);
    return targetTime;
  }

  #ensureAtOrBefore(targetTime) {
    return this.#exclusive(() => this.#ensureUnlocked(targetTime));
  }

  ensure(targetTime) {
    return this.#ensureAtOrBefore(targetTime);
  }

  runAlarm(callback) {
    return this.#exclusive(async () => callback((targetTime) => this.#ensureUnlocked(targetTime)));
  }
}

export class KyamiRateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(CREATE_TABLE);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS rate_limits_expires_at ON rate_limits (expires_at)",
    );
    this.alarmScheduler = new CleanupAlarmScheduler(this.ctx.storage);
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const clientKey = body?.clientKey;
    if (typeof clientKey !== "string" || !/^[a-f0-9]{64}$/.test(clientKey)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      // Re-arm only when no cleanup is scheduled. If this fails, fail the
      // limiter request closed before writing the counter or invoking AI.
      await this.alarmScheduler.ensure(Date.now() + CLEANUP_INTERVAL_MS);
      const result = this.#checkAt(clientKey, Date.now());
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      // Safe logging: never log the client key, IP, request body, or SQL error details.
      console.error("KYAMI rate limiter storage operation failed", safeStorageCode(error));
      return Response.json({ error: "rate_limiter_unavailable" }, { status: 503 });
    }
  }

  #checkAt(clientKey, now) {
    if (typeof clientKey !== "string" || !/^[a-f0-9]{64}$/.test(clientKey) ||
        !Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid rate-limit check");
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec(
        "SELECT window_started_at, request_count FROM rate_limits WHERE client_key = ?",
        clientKey,
      ).toArray()[0];
      const windowStartedAt = row && now >= row.window_started_at && now - row.window_started_at < RATE_WINDOW_MS
        ? row.window_started_at
        : Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
      const currentCount = row && windowStartedAt === row.window_started_at
        ? row.request_count
        : 0;
      const resetAt = windowStartedAt + RATE_WINDOW_MS;

      // Do not write a row for rejected requests.
      if (currentCount >= RATE_LIMIT) return { allowed: false, remaining: 0, resetAt };

      const requestCount = currentCount + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO rate_limits (client_key, window_started_at, request_count, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_key) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           request_count = excluded.request_count,
           expires_at = excluded.expires_at`,
        clientKey,
        windowStartedAt,
        requestCount,
        now + RATE_RECORD_TTL_MS,
      );
      return { allowed: true, remaining: RATE_LIMIT - requestCount, resetAt };
    });
  }

  async alarm() {
    return this.alarmScheduler.runAlarm(async (ensureAlarm) => {
      const now = Date.now();
      let deleted;
      try {
        this.ctx.storage.sql.exec(
          `DELETE FROM rate_limits WHERE rowid IN (
             SELECT rowid FROM rate_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
           )`,
          now,
          CLEANUP_BATCH_SIZE,
        );
        deleted = this.ctx.storage.sql.exec("SELECT changes() AS count").toArray()[0]?.count || 0;
      } catch (error) {
        console.error("KYAMI rate limiter cleanup failed", safeStorageCode(error));
        // A successful schedule provides the retry. If it also fails, allow
        // the exception to escape so Cloudflare retries this alarm invocation.
        try {
          await ensureAlarm(now + CLEANUP_INTERVAL_MS);
        } catch (scheduleError) {
          console.error("KYAMI rate limiter cleanup alarm could not be scheduled", safeStorageCode(scheduleError));
          throw scheduleError;
        }
        return;
      }

      // A full batch drains again soon. Otherwise keep the weekly interval.
      // The scheduler keeps a concurrent request's earlier alarm if present.
      try {
        await ensureAlarm(now + (deleted >= CLEANUP_BATCH_SIZE ? 1_000 : CLEANUP_INTERVAL_MS));
      } catch (error) {
        console.error("KYAMI rate limiter cleanup alarm could not be scheduled", safeStorageCode(error));
        throw error;
      }
    });
  }
}

function safeStorageCode(error) {
  const message = String(error?.message || "");
  if (message.includes("SQLITE_FULL")) return "SQLITE_FULL";
  if (message.includes("quota") || message.includes("limit")) return "STORAGE_QUOTA";
  return "STORAGE_ERROR";
}
