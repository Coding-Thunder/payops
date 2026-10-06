/**
 * How an editable legal text is compared and versioned.
 *
 * Shared by the deployment Settings (the car-rental terms and policy) and by
 * each organization's own per-service terms, so a version label means the
 * same thing wherever the text was edited: it moves on only when the text
 * changes, and every order keeps the label it was created under.
 */

/** Structural equality good enough for primitive fields + sorted arrays of
 *  primitives. Order-sensitive on arrays (intentional — booking-type order
 *  shouldn't matter today, but we surface re-ordering as a change anyway). */
export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim();
  }
  return false;
}

/** "v3" → "v4". A label that isn't "v1" or higher counts as "v1", so it
 *  becomes "v2". */
export function nextPolicyVersion(current: string): string {
  const match = current.match(/^v(\d+)$/i);
  const n = match ? Number(match[1]) : 0;
  return `v${(Number.isFinite(n) && n > 0 ? n : 1) + 1}`;
}
