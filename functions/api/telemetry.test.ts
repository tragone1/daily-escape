/**
 * The telemetry route is an unauthenticated public endpoint that writes to our
 * logs, so it is tested as something a stranger will poke at.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { onRequestPost } from "./telemetry";

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line) => void logged.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

const post = async (body: unknown): Promise<Response> =>
  (await (onRequestPost as (c: unknown) => Promise<Response>)({
    request: new Request("https://x/api/telemetry", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  })) as Response;

describe("telemetry", () => {
  it("records a known metric", async () => {
    await post({ kind: "metric", name: "run_started", build: "abc1234", api: 1 });
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({ t: "metric", name: "run_started" });
  });

  it("drops an unknown metric rather than logging it", async () => {
    // Otherwise the endpoint is a free write channel into our own logs.
    await post({ kind: "metric", name: "not_a_metric", build: "abc1234", api: 1 });
    expect(logged).toHaveLength(0);
  });

  it("drops names that are not plain identifiers", async () => {
    for (const name of ["../../etc", "a".repeat(60), "<script>", "run started"]) {
      await post({ kind: "metric", name, build: "abc1234", api: 1 });
    }
    expect(logged).toHaveLength(0);
  });

  it("strips URLs and long tokens out of an error message", async () => {
    await post({
      kind: "error",
      name: "boot_failed",
      build: "abc1234",
      api: 1,
      detail: "failed at https://example.com/x?token=abc tok=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    });
    const entry = JSON.parse(logged[0]);
    expect(entry.detail).not.toContain("example.com");
    expect(entry.detail).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(entry.detail).toContain("[url]");
  });

  it("caps the message length", async () => {
    await post({ kind: "error", name: "uncaught", build: "abc1234", api: 1, detail: "x".repeat(5000) });
    expect(JSON.parse(logged[0]).detail.length).toBeLessThanOrEqual(300);
  });

  it("always answers 204, even for rubbish", async () => {
    for (const body of ["not json", {}, { kind: "nonsense" }, { kind: "error" }]) {
      const res = await post(body);
      expect(res.status).toBe(204);
    }
    expect(logged).toHaveLength(0);
  });

  it("does not trust a build string it did not issue", async () => {
    await post({ kind: "metric", name: "run_started", build: "<script>alert(1)</script>", api: 1 });
    expect(JSON.parse(logged[0]).build).toBe("unknown");
  });
});
