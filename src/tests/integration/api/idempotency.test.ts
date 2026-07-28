import { beforeEach, describe, expect, it, vi } from "vitest";

import { runIdempotent } from "@/server/api/idempotency";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

describe("runIdempotent", () => {
  it("runs the action once and dedups a repeat with the same key", async () => {
    const fn = vi.fn().mockResolvedValue("sent");
    const dup = vi.fn().mockResolvedValue("deduped");

    const first = await runIdempotent("route", "key-123", fn, dup);
    expect(first).toBe("sent");
    expect(fn).toHaveBeenCalledTimes(1);

    const second = await runIdempotent("route", "key-123", fn, dup);
    expect(second).toBe("deduped");
    expect(fn).toHaveBeenCalledTimes(1); // NOT fired again
    expect(dup).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the action fails, so a genuine retry re-runs", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce("sent");
    const dup = vi.fn().mockResolvedValue("deduped");

    await expect(runIdempotent("route", "key-x", fn, dup)).rejects.toThrow(
      "smtp down",
    );
    const retry = await runIdempotent("route", "key-x", fn, dup);
    expect(retry).toBe("sent");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(dup).not.toHaveBeenCalled();
  });

  it("scopes keys by route — same key under different routes both run", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const dup = vi.fn().mockResolvedValue("dup");

    await runIdempotent("route-a", "same", fn, dup);
    await runIdempotent("route-b", "same", fn, dup);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(dup).not.toHaveBeenCalled();
  });

  it("no key → always runs (backward-compatible, no dedup)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const dup = vi.fn();

    await runIdempotent("route", null, fn, dup);
    await runIdempotent("route", null, fn, dup);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(dup).not.toHaveBeenCalled();
  });
});
