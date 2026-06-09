import { randomBytes } from "node:crypto";

/** Random alphanumeric segment, safe for human reading (no I/O/0/1 ambiguity). */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 10 chars × 32-symbol alphabet → 50 bits of entropy. Sized so that
 *  even with the visible date prefix the day's order numbers can't be
 *  enumerated by a botnet inside a useful window. */
const SUFFIX_LENGTH = 10;

export function generateOrderNumber(prefix: string): string {
  const safePrefix = prefix.replace(/[^A-Z]/gi, "").toUpperCase() || "ORD";
  const date = new Date();
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  // crypto-grade RNG (not Math.random): order numbers are how /pay/*
  // and the consent flow look orders up by; predictable suffixes turn
  // those endpoints into PII-enumeration surfaces.
  const bytes = randomBytes(SUFFIX_LENGTH);
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${safePrefix}-${yy}${mm}${dd}-${suffix}`;
}
