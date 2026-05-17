/** Random alphanumeric segment, safe for human reading (no I/O/0/1 ambiguity). */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateOrderNumber(prefix: string): string {
  const safePrefix = prefix.replace(/[^A-Z]/gi, "").toUpperCase() || "ORD";
  const date = new Date();
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${safePrefix}-${yy}${mm}${dd}-${suffix}`;
}
