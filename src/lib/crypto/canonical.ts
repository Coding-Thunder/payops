/**
 * Deterministic JSON serialiser used for evidence-chain hashing.
 *
 * Two payloads with the same logical content must serialise to the same
 * string regardless of key insertion order or whitespace, otherwise the
 * verify path would falsely report tampering on round-trip. The
 * algorithm:
 *   - sort object keys lexicographically at every level
 *   - drop `undefined` values entirely (matches JSON.stringify) but
 *     keep `null`s, a removed field MUST change the hash
 *   - serialise Dates as their ISO string (Date.prototype.toJSON)
 *   - reject circular references with a clear error rather than
 *     letting JSON.stringify throw a generic TypeError
 *   - emit zero whitespace
 */
export function canonicalJSON(input: unknown): string {
  return JSON.stringify(canonicalise(input, new WeakSet()));
}

function canonicalise(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (seen.has(value as object)) {
    throw new Error("canonicalJSON: circular reference detected");
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => canonicalise(v, seen));
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = canonicalise(v, seen);
  }
  return out;
}
