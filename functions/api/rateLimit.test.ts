/**
 * The limiter is tested against a real SQL engine, not a stub.
 *
 * Its correctness lives entirely in one statement — an upsert that must count
 * atomically — and a hand-written fake would simply agree with whatever I
 * believed that statement did. `node:sqlite` runs the actual SQL.
 */
import { describe, expect, it, beforeEach } from "vitest";
/*
 * Required rather than imported: Vite's list of Node builtins predates
 * `node:sqlite`, so a static import is rewritten to a bare "sqlite" specifier
 * and fails to resolve. `createRequire` hands the lookup to Node, which has
 * had the module since v22.
 */
import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
  };
};
import { checkRateLimit, MAX_PER_WINDOW, WINDOW_MS } from "./rateLimit";

/**
 * The slice of the D1 interface this module uses, backed by real SQLite.
 * D1's shape differs from node:sqlite's, so the adapter is the translation.
 */
function makeDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE rate_limits (
    bucket TEXT PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  )`);
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound = args;
          return api;
        },
        first<T>(): Promise<T | null> {
          return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
        },
        run(): Promise<unknown> {
          stmt.run(...(bound as never[]));
          return Promise.resolve({});
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

const from = (ip: string | null): Request =>
  new Request("https://x/api/score", {
    method: "POST",
    headers: ip ? { "CF-Connecting-IP": ip } : {},
  });

describe("per-address rate limiting", () => {
  let db: D1Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("allows ordinary play", async () => {
    // A run takes minutes; nobody legitimate approaches the ceiling.
    for (let i = 0; i < 12; i++) {
      const v = await checkRateLimit(db, from("203.0.113.5"), "2026-08-03");
      expect(v.allowed, `attempt ${i + 1}`).toBe(true);
    }
  });

  it("blocks once the window ceiling is passed", async () => {
    const req = from("203.0.113.5");
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      expect((await checkRateLimit(db, req, "2026-08-03")).allowed).toBe(true);
    }
    const over = await checkRateLimit(db, req, "2026-08-03");
    expect(over.allowed).toBe(false);
    // And says when to come back, so a retry is informed rather than a guess.
    expect(over.retryAfter).toBeGreaterThan(0);
    expect(over.retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000);
  });

  it("counts each address separately, so one abuser cannot lock out a network", async () => {
    const req = from("203.0.113.5");
    for (let i = 0; i <= MAX_PER_WINDOW; i++) await checkRateLimit(db, req, "2026-08-03");
    expect((await checkRateLimit(db, req, "2026-08-03")).allowed).toBe(false);
    // A different address is unaffected.
    expect((await checkRateLimit(db, from("198.51.100.9"), "2026-08-03")).allowed).toBe(true);
  });

  it("forgets once the window rolls", async () => {
    const req = from("203.0.113.5");
    const t0 = 1_760_000_000_000;
    for (let i = 0; i <= MAX_PER_WINDOW; i++) await checkRateLimit(db, req, "2026-08-03", t0);
    expect((await checkRateLimit(db, req, "2026-08-03", t0)).allowed).toBe(false);
    // The next window is a different bucket entirely.
    const later = t0 + WINDOW_MS + 1;
    expect((await checkRateLimit(db, req, "2026-08-03", later)).allowed).toBe(true);
  });

  it("keys on the day, so a bucket cannot outlive it", async () => {
    const req = from("203.0.113.5");
    const t0 = 1_760_000_000_000;
    for (let i = 0; i <= MAX_PER_WINDOW; i++) await checkRateLimit(db, req, "2026-08-03", t0);
    expect((await checkRateLimit(db, req, "2026-08-03", t0)).allowed).toBe(false);
    expect((await checkRateLimit(db, req, "2026-08-04", t0)).allowed).toBe(true);
  });

  it("never stores the address", async () => {
    await checkRateLimit(db, from("203.0.113.5"), "2026-08-03");
    const row = await db.prepare(`SELECT bucket FROM rate_limits`).bind().first<{ bucket: string }>();
    expect(row?.bucket).toBeTruthy();
    expect(row?.bucket).not.toContain("203.0.113.5");
    expect(row?.bucket).not.toContain("113");
  });

  it("does not limit when there is no edge address to key on", async () => {
    // Local development and tests: nothing to key on, so nothing to limit.
    for (let i = 0; i < MAX_PER_WINDOW * 2; i++) {
      expect((await checkRateLimit(db, from(null), "2026-08-03")).allowed).toBe(true);
    }
  });

  it("counts a burst exactly once each, with no double-spend", async () => {
    /*
     * The upsert has to be atomic. Written as a SELECT then an UPDATE, a burst
     * arriving together would all read the same old count and all decide they
     * were under the limit - which is the classic way to build a limiter that
     * lets exactly the traffic it exists to stop straight through.
     */
    const req = from("203.0.113.5");
    const burst = Array.from({ length: MAX_PER_WINDOW + 10 }, () =>
      checkRateLimit(db, req, "2026-08-03"),
    );
    const results = await Promise.all(burst);
    expect(results.filter((r) => r.allowed)).toHaveLength(MAX_PER_WINDOW);
  });
});
