import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import worker from "../src/index.js";
import { CLEANUP_INTERVAL_MS, CleanupAlarmScheduler, hashClientIp, RATE_LIMIT, shardForClientKey, shardObjectName } from "../src/rate-limit.js";

function newStub() {
  const name = `test-${crypto.randomUUID()}`;
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
}

function key(value) {
  return value.padStart(64, "0").slice(-64);
}

async function check(stub, clientKey) {
  const response = await stub.fetch("https://rate-limiter.test/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  return { status: response.status, body: await response.json() };
}

function chatRequest(ip) {
  return new Request("https://kyami-ai.aimraneoubram.workers.dev/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ messages: [{ role: "user", text: "Hi" }] }),
  });
}

describe("SQLite Durable Object rate limiter", () => {
  it("loads the class and initializes a minimal indexed SQLite table", async () => {
    const stub = newStub();
    const { status, body } = await check(stub, key("1"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ allowed: true, remaining: RATE_LIMIT - 1 });
    const schema = await runInDurableObject(stub, (instance) => ({
      table: instance.ctx.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limits'",
      ).toArray(),
      index: instance.ctx.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'rate_limits_expires_at'",
      ).toArray(),
    }));
    expect(schema.table).toHaveLength(1);
    expect(schema.index).toHaveLength(1);
  });

  it("accepts five requests, rejects the sixth without a write, then resets at the window boundary", async () => {
    const stub = newStub();
    const clientKey = key("2");
    const first = await check(stub, clientKey);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ allowed: true, remaining: 4 });
    for (let index = 1; index < RATE_LIMIT; index += 1) {
      expect((await check(stub, clientKey)).body.allowed).toBe(true);
    }
    const sixth = await check(stub, clientKey);
    expect(sixth.status).toBe(200);
    expect(sixth.body).toMatchObject({ allowed: false, remaining: 0, resetAt: first.body.resetAt });
    const storedCount = await runInDurableObject(stub, (instance) =>
      instance.ctx.storage.sql.exec(
        "SELECT request_count FROM rate_limits WHERE client_key = ?", clientKey,
      ).toArray()[0].request_count,
    );
    expect(storedCount).toBe(5);
    await runInDurableObject(stub, (instance) => instance.ctx.storage.sql.exec(
      "UPDATE rate_limits SET window_started_at = ? WHERE client_key = ?",
      Date.now() - 60_000,
      clientKey,
    ));
    expect((await check(stub, clientKey)).body).toMatchObject({ allowed: true, remaining: 4 });
  });

  it("shares persisted state across object evictions and separate Worker calls", async () => {
    const clientIp = `198.51.100.${crypto.randomUUID()}`;
    const clientKey = await hashClientIp(clientIp);
    const shard = shardForClientKey(clientKey);
    const objectId = env.RATE_LIMITER.idFromName(shardObjectName(shard));
    const workerInstanceA = env.RATE_LIMITER.get(objectId);
    const workerInstanceB = env.RATE_LIMITER.get(objectId);
    expect((await check(workerInstanceA, clientKey)).body.remaining).toBe(4);
    expect((await check(workerInstanceB, clientKey)).body.remaining).toBe(3);
    await evictDurableObject(workerInstanceA);
    expect((await check(workerInstanceB, clientKey)).body.remaining).toBe(2);
  });

  it("keeps different client keys independent and stores no raw IP", async () => {
    const stub = newStub();
    const clientIp = "203.0.113.74";
    const clientKey = await hashClientIp(clientIp);
    expect((await check(stub, clientKey)).body).toMatchObject({ allowed: true });
    expect((await check(stub, key("3"))).body).toMatchObject({ allowed: true, remaining: 4 });
    const rows = await runInDurableObject(stub, (instance) => instance.ctx.storage.sql.exec(
      "SELECT client_key FROM rate_limits ORDER BY client_key",
    ).toArray());
    expect(rows.map((row) => row.client_key)).toContain(clientKey);
    expect(JSON.stringify(rows)).not.toContain(clientIp);
  });

  it("serializes concurrent checks so no more than five are accepted", async () => {
    const stub = newStub();
    const checks = await Promise.all(Array.from({ length: 12 }, () => check(stub, key("4"))));
    expect(checks.filter((result) => result.body.allowed)).toHaveLength(5);
    expect(checks.filter((result) => !result.body.allowed)).toHaveLength(7);
  });

  it("cleans expired records in a bounded alarm batch", async () => {
    const stub = newStub();
    const sentinelKey = key("999");
    await check(stub, sentinelKey);
    await runInDurableObject(stub, (instance) => {
      instance.ctx.storage.transactionSync(() => {
        instance.ctx.storage.sql.exec("UPDATE rate_limits SET expires_at = 0 WHERE client_key = ?", sentinelKey);
        for (let index = 1; index <= 500; index += 1) {
          instance.ctx.storage.sql.exec(
            "INSERT INTO rate_limits (client_key, window_started_at, request_count, expires_at) VALUES (?, 0, 1, 0)",
            index.toString(16).padStart(64, "0"),
          );
        }
      });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const remainingAfterFirstBatch = await runInDurableObject(stub, (instance) =>
      instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM rate_limits").toArray()[0].count,
    );
    expect(remainingAfterFirstBatch).toBe(1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const remainingAfterSecondBatch = await runInDurableObject(stub, (instance) =>
      instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM rate_limits").toArray()[0].count,
    );
    expect(remainingAfterSecondBatch).toBe(0);
  });

  it("does not replace an existing alarm during normal requests", async () => {
    const stub = newStub();
    const clientKey = key("7");
    await check(stub, clientKey);
    const scheduledBefore = await runInDurableObject(stub, (instance) => instance.ctx.storage.getAlarm());
    expect(scheduledBefore).not.toBeNull();
    await check(stub, clientKey);
    const scheduledAfter = await runInDurableObject(stub, (instance) => instance.ctx.storage.getAlarm());
    expect(scheduledAfter).toBe(scheduledBefore);
  });

  it("re-arms cleanup when a later request finds no scheduled alarm", async () => {
    const stub = newStub();
    const clientKey = key("8");
    await check(stub, clientKey);
    await runInDurableObject(stub, (instance) => instance.ctx.storage.deleteAlarm());
    expect(await runInDurableObject(stub, (instance) => instance.ctx.storage.getAlarm())).toBeNull();
    expect((await check(stub, clientKey)).body.allowed).toBe(true);
    const recoveredAlarm = await runInDurableObject(stub, (instance) => instance.ctx.storage.getAlarm());
    expect(recoveredAlarm).not.toBeNull();
    expect(recoveredAlarm).toBeGreaterThan(Date.now());
  });

  it("serializes concurrent checks so they set only one missing alarm", async () => {
    let scheduledAlarm = null;
    const storage = {
      getAlarm: vi.fn(async () => scheduledAlarm),
      setAlarm: vi.fn(async (time) => { scheduledAlarm = time; }),
    };
    const scheduler = new CleanupAlarmScheduler(storage);
    const target = Date.now() + CLEANUP_INTERVAL_MS;
    await Promise.all(Array.from({ length: 20 }, () => scheduler.ensure(target)));
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(scheduledAlarm).toBe(target);
  });

  it("does not let a request overwrite an earlier alarm selected by a running cleanup", async () => {
    let scheduledAlarm = null;
    let releaseCleanup;
    let markCleanupStarted;
    const cleanupStarted = new Promise((resolve) => { markCleanupStarted = resolve; });
    const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
    const storage = {
      getAlarm: vi.fn(async () => scheduledAlarm),
      setAlarm: vi.fn(async (time) => { scheduledAlarm = time; }),
    };
    const scheduler = new CleanupAlarmScheduler(storage);
    const now = Date.now();
    const alarmRun = scheduler.runAlarm(async (ensureAlarm) => {
      markCleanupStarted();
      await cleanupGate;
      await ensureAlarm(now + 1_000);
    });
    await cleanupStarted;
    const requestCheck = scheduler.ensure(now + CLEANUP_INTERVAL_MS);
    releaseCleanup();
    await Promise.all([alarmRun, requestCheck]);
    expect(scheduledAlarm).toBe(now + 1_000);
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("fails closed on alarm scheduling errors, then recovers on a later request", async () => {
    const ip = `203.0.113.${crypto.randomUUID()}`;
    const clientKey = await hashClientIp(ip);
    const objectId = env.RATE_LIMITER.idFromName(shardObjectName(shardForClientKey(clientKey)));
    const stub = env.RATE_LIMITER.get(objectId);
    let scheduledAlarm = null;
    let failuresRemaining = 1;
    const storage = {
      getAlarm: vi.fn(async () => scheduledAlarm),
      setAlarm: vi.fn(async (time) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("simulated alarm storage failure");
        }
        scheduledAlarm = time;
      }),
    };
    await runInDurableObject(stub, (instance) => {
      instance.alarmScheduler = new CleanupAlarmScheduler(storage);
    });

    const aiRun = vi.fn(async () => ({ response: "local test response" }));
    const requestEnv = { RATE_LIMITER: env.RATE_LIMITER, AI: { run: aiRun }, ASSETS: { fetch: async () => new Response("asset") } };
    const first = await worker.fetch(chatRequest(ip), requestEnv);
    expect(first.status).toBe(503);
    expect((await first.json()).code).toBe("RATE_LIMITER_UNAVAILABLE");
    expect(aiRun).not.toHaveBeenCalled();
    const rowsAfterFailure = await runInDurableObject(stub, (instance) => instance.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM rate_limits",
    ).toArray()[0].count);
    expect(rowsAfterFailure).toBe(0);

    const recovered = await worker.fetch(chatRequest(ip), requestEnv);
    expect(recovered.status).toBe(200);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(scheduledAlarm).toBeGreaterThan(Date.now());
  });

  it("fails closed when getAlarm itself is unavailable", async () => {
    const ip = `203.0.113.${crypto.randomUUID()}`;
    const clientKey = await hashClientIp(ip);
    const objectId = env.RATE_LIMITER.idFromName(shardObjectName(shardForClientKey(clientKey)));
    const stub = env.RATE_LIMITER.get(objectId);
    const scheduler = new CleanupAlarmScheduler({
      getAlarm: vi.fn(async () => { throw new Error("simulated getAlarm failure"); }),
      setAlarm: vi.fn(async () => {}),
    });
    await runInDurableObject(stub, (instance) => { instance.alarmScheduler = scheduler; });

    const aiRun = vi.fn(async () => ({ response: "must not run" }));
    const response = await worker.fetch(chatRequest(ip), {
      RATE_LIMITER: env.RATE_LIMITER,
      AI: { run: aiRun },
      ASSETS: { fetch: async () => new Response("asset") },
    });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("RATE_LIMITER_UNAVAILABLE");
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("lets an alarm scheduling error escape for platform retry, then completes on retry", async () => {
    const stub = newStub();
    await check(stub, key("10"));
    await runInDurableObject(stub, (instance) => instance.ctx.storage.deleteAlarm());
    let scheduledAlarm = null;
    let failuresRemaining = 1;
    const storage = {
      getAlarm: vi.fn(async () => scheduledAlarm),
      setAlarm: vi.fn(async (time) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("simulated alarm scheduling failure");
        }
        scheduledAlarm = time;
      }),
    };
    await runInDurableObject(stub, (instance) => {
      instance.alarmScheduler = new CleanupAlarmScheduler(storage);
    });
    await expect(runInDurableObject(stub, (instance) => instance.alarm())).rejects.toThrow();
    expect(scheduledAlarm).toBeNull();
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect(scheduledAlarm).toBeGreaterThan(Date.now());
  });

  it("uses stable shard selection for the same hashed client", async () => {
    const clientKey = await hashClientIp("198.51.100.9");
    expect(shardForClientKey(clientKey)).toBe(shardForClientKey(clientKey));
  });

  it("measures cursor rows for accepted, rejected, and cleanup SQL statements", async () => {
    const stub = newStub();
    const clientKey = key("6");
    const measurements = await runInDurableObject(stub, (instance) => {
      const sql = instance.ctx.storage.sql;
      const select = sql.exec(
        "SELECT window_started_at, request_count FROM rate_limits WHERE client_key = ?", clientKey,
      );
      select.toArray();
      const firstWrite = sql.exec(
        `INSERT INTO rate_limits (client_key, window_started_at, request_count, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_key) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           request_count = excluded.request_count,
           expires_at = excluded.expires_at`,
        clientKey, 1_000_000, 1, 2_592_000_000,
      );
      const repeatWrite = sql.exec(
        `INSERT INTO rate_limits (client_key, window_started_at, request_count, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_key) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           request_count = excluded.request_count,
           expires_at = excluded.expires_at`,
        clientKey, 1_000_000, 2, 2_592_001_000,
      );
      const existingLookup = sql.exec(
        "SELECT window_started_at, request_count FROM rate_limits WHERE client_key = ?", clientKey,
      );
      existingLookup.toArray();
      const rejectedSelect = sql.exec(
        "SELECT window_started_at, request_count FROM rate_limits WHERE client_key = ?", clientKey,
      );
      rejectedSelect.toArray();
      const deletion = sql.exec(
        `DELETE FROM rate_limits WHERE rowid IN (
           SELECT rowid FROM rate_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        3_000_000, 500,
      );
      deletion.toArray();
      const changes = sql.exec("SELECT changes() AS count");
      changes.toArray();
      return {
        lookup: { rowsRead: select.rowsRead, rowsWritten: select.rowsWritten },
        firstInsert: { rowsRead: firstWrite.rowsRead, rowsWritten: firstWrite.rowsWritten },
        repeatedUpdate: { rowsRead: repeatWrite.rowsRead, rowsWritten: repeatWrite.rowsWritten },
        existingLookup: { rowsRead: existingLookup.rowsRead, rowsWritten: existingLookup.rowsWritten },
        rejectedLookup: { rowsRead: rejectedSelect.rowsRead, rowsWritten: rejectedSelect.rowsWritten },
        delete: { rowsRead: deletion.rowsRead, rowsWritten: deletion.rowsWritten },
        changes: { rowsRead: changes.rowsRead, rowsWritten: changes.rowsWritten },
      };
    });
    // Miniflare cursor measurements are local runtime observations. In particular,
    // Cloudflare billing docs count DELETE and index writes even though the local
    // DELETE cursor currently reports rowsWritten = 0.
    expect(measurements).toEqual({
      lookup: { rowsRead: 0, rowsWritten: 0 },
      firstInsert: { rowsRead: 0, rowsWritten: 3 },
      repeatedUpdate: { rowsRead: 1, rowsWritten: 2 },
      existingLookup: { rowsRead: 1, rowsWritten: 0 },
      rejectedLookup: { rowsRead: 1, rowsWritten: 0 },
      delete: { rowsRead: 2, rowsWritten: 0 },
      changes: { rowsRead: 0, rowsWritten: 0 },
    });
  });
});
