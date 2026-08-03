/**
 * The network paths nobody exercises before launch.
 *
 * A leaderboard is the one part of this game that can fail while everything
 * else is working, and every one of these states used to look identical to the
 * player: a button that said "Sending..." and never changed.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NetworkError, savePending, loadPending, clearPending, nameIsValid } from "./leaderboard";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a held run", () => {
  const run = { score: 41000, section: 30, distance: 26500, elapsedMs: 400_000 };

  it("comes back on the same day", () => {
    savePending(run, "2026-08-03");
    expect(loadPending("2026-08-03")?.score).toBe(41000);
  });

  it("is dropped once the day has rolled", () => {
    savePending(run, "2026-08-03");
    // Yesterday's map: there is nothing today to submit it against.
    expect(loadPending("2026-08-04")).toBeNull();
    expect(loadPending("2026-08-03")).toBeNull();
  });

  it("keeps only the best, so runs cannot be banked", () => {
    savePending(run, "2026-08-03");
    savePending({ ...run, score: 10_000 }, "2026-08-03");
    expect(loadPending("2026-08-03")?.score).toBe(41000);
    savePending({ ...run, score: 52_000 }, "2026-08-03");
    expect(loadPending("2026-08-03")?.score).toBe(52_000);
  });

  it("survives corrupted storage without trapping the player", () => {
    store.set("dailyEscape.pendingRun", "{not json");
    expect(loadPending("2026-08-03")).toBeNull();
    // And the bad value is gone, rather than failing again on every load.
    expect(store.get("dailyEscape.pendingRun")).toBe("");
  });

  it("rejects a stored run with non-finite numbers", () => {
    store.set(
      "dailyEscape.pendingRun",
      JSON.stringify({ score: null, section: 1, distance: 1, elapsedMs: 1, day: "2026-08-03" }),
    );
    expect(loadPending("2026-08-03")).toBeNull();
  });

  it("clears when asked", () => {
    savePending(run, "2026-08-03");
    clearPending();
    expect(loadPending("2026-08-03")).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => savePending(run, "2026-08-03")).not.toThrow();
    expect(loadPending("2026-08-03")).toBeNull();
  });
});

describe("name validation on the client", () => {
  it("accepts ordinary names", () => {
    for (const n of ["Tyler", "Ana-Maria", "O'Brien", "player_1", "Renée", "日本語"]) {
      expect(nameIsValid(n), n).toBe(true);
    }
  });

  it("rejects blank, too short, too long and markup", () => {
    for (const n of ["", "   ", "a", "x".repeat(19), "<script>alert(1)</script>", "a<b>c"]) {
      expect(nameIsValid(n), JSON.stringify(n)).toBe(false);
    }
  });
});

describe("error classification", () => {
  it("marks a network failure as retryable and a verdict as not", () => {
    expect(new NetworkError("offline")).toBeInstanceOf(NetworkError);
    expect(new Error("bad score")).not.toBeInstanceOf(NetworkError);
  });
});
