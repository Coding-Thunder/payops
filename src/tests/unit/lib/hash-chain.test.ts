import { describe, expect, it } from "vitest";

import { canonicalJSON } from "@/lib/crypto/canonical";
import {
  computeEvidenceHash,
  GENESIS_PREVIOUS_HASH,
  sha256,
} from "@/lib/crypto/hash-chain";

describe("canonicalJSON", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJSON({ a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1}}');
  });

  it("drops undefined but keeps null", () => {
    expect(canonicalJSON({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("serialises Date as ISO string", () => {
    const out = canonicalJSON({ when: new Date("2026-01-02T03:04:05Z") });
    expect(out).toBe('{"when":"2026-01-02T03:04:05.000Z"}');
  });

  it("rejects circular references with a clear error", () => {
    interface Node {
      self?: Node;
    }
    const a: Node = {};
    a.self = a;
    expect(() => canonicalJSON(a)).toThrow(/circular reference/);
  });
});

describe("computeEvidenceHash", () => {
  it("produces a stable sha256 hash for identical inputs", () => {
    const occurredAt = new Date("2026-01-01T00:00:00Z");
    const a = computeEvidenceHash({
      previousHash: null,
      orderId: "abc",
      sequence: 1,
      eventType: "ORDER_CREATED",
      occurredAt,
      payload: { x: 1, y: 2 },
    });
    const b = computeEvidenceHash({
      previousHash: null,
      orderId: "abc",
      sequence: 1,
      eventType: "ORDER_CREATED",
      occurredAt,
      payload: { y: 2, x: 1 }, // different key order
    });
    expect(a.hash).toBe(b.hash);
    expect(a.snapshotHash).toBe(b.snapshotHash);
  });

  it("the genesis event hashes the GENESIS sentinel for previousHash", () => {
    const out = computeEvidenceHash({
      previousHash: null,
      orderId: "abc",
      sequence: 1,
      eventType: "ORDER_CREATED",
      occurredAt: new Date(0),
      payload: {},
    });
    const expectedSnapshot = sha256("{}");
    const expectedHash = sha256(
      `${GENESIS_PREVIOUS_HASH}|abc|1|ORDER_CREATED|${new Date(0).toISOString()}|${expectedSnapshot}`,
    );
    expect(out.snapshotHash).toBe(expectedSnapshot);
    expect(out.hash).toBe(expectedHash);
  });

  it("a payload change cascades into a different hash", () => {
    const occurredAt = new Date("2026-01-01T00:00:00Z");
    const a = computeEvidenceHash({
      previousHash: "00",
      orderId: "abc",
      sequence: 2,
      eventType: "ORDER_CREATED",
      occurredAt,
      payload: { x: 1 },
    });
    const b = computeEvidenceHash({
      previousHash: "00",
      orderId: "abc",
      sequence: 2,
      eventType: "ORDER_CREATED",
      occurredAt,
      payload: { x: 2 },
    });
    expect(a.hash).not.toBe(b.hash);
    expect(a.snapshotHash).not.toBe(b.snapshotHash);
  });
});
