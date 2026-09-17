/**
 * Card data must never be entered into, or stored in, PayOps.
 *
 * Every free-text field an operator fills in around a payment — the manual
 * payment method, reference and notes, and the change note — is checked
 * here, because the most likely way a card number arrives is an operator
 * reading it off a terminal slip into whichever box is in front of them.
 *
 * The earlier check only refused a value that was ENTIRELY digits once
 * spaces and dashes were removed. "card 4111111111111111", dotted groups,
 * a PAN followed by an expiry, "cvv 123" and card data typed into the notes
 * or method fields all went straight through, were stored on the order,
 * copied into the audit log and exported.
 *
 * Rules, deliberately conservative so a real terminal reference still passes:
 *   - a run of 13–19 digits, optionally grouped by single spaces, dashes or
 *     dots, anywhere in the text, that passes the Luhn check (every real card
 *     number does; most long transaction ids do not) — or that makes up the
 *     whole value, Luhn or not;
 *   - card-security-code or expiry wording next to digits ("cvv 123",
 *     "security code: 1234", "exp 12/29", "valid thru 01/2030");
 *   - a value that is nothing but 3 or 4 digits — the shape of a security
 *     code, and too short to be a terminal authorisation reference — or
 *     nothing but an expiry date;
 *   - digits separated by other punctuation ("/", "_", ",", an en dash)
 *     when grouped the way cards are printed and passing Luhn;
 *   - fullwidth digits and invisible characters are normalised first.
 *
 * Shared by client and server so the form refuses exactly what the API does.
 */

export const CARD_DATA_MESSAGE =
  "That looks like card details. Enter the terminal reference or authorisation code instead — never a card number, expiry or security code.";

const DIGIT_RUN = /\d(?:[ .-]?\d){12,18}/g;
/** Digits separated by anything that is not a letter or digit — "/", "_",
 *  ",", an en dash — which the run above does not join. */
const LOOSE_DIGIT_RUN = /\d+(?:[^\p{L}\p{N}]{1,3}\d+)+/gu;
/** Invisible characters an operator (or a paste) can slip between digits. */
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The ways card numbers are printed: fours (the last group may be short),
 *  and the 4-6-5 / 4-6-4 layouts of 15- and 14-digit cards. */
function looksLikeCardGrouping(groups: string[]): boolean {
  const lens = groups.map((g) => g.length);
  const fours =
    lens.length >= 3 &&
    lens.slice(0, -1).every((n) => n === 4) &&
    lens[lens.length - 1] >= 1 &&
    lens[lens.length - 1] <= 4;
  const amex =
    lens.length === 3 && lens[0] === 4 && lens[1] === 6 && (lens[2] === 5 || lens[2] === 4);
  return fours || amex;
}

const SECURITY_CODE =
  /\b(?:cvv2?|cvc2?|cvn|cid|csc|sec(?:urity)?\.?\s*code|card\s*code)\b\W{0,3}\d{3,4}\b/i;
const EXPIRY =
  /\b(?:exp(?:iry|ires|iration)?|valid\s*(?:thru|through|until))\b\.?\W{0,3}(?:0?[1-9]|1[0-2])\s*[/-]?\s*(?:\d{2}|\d{4})\b/i;
const BARE_SECURITY_CODE = /^\s*\d{3,4}\s*$/;
/** A value that is only an expiry date, "12/29" or "01/2030". */
const BARE_EXPIRY = /^\s*(?:0?[1-9]|1[0-2])\s*\/\s*(?:\d{2}|\d{4})\s*$/;

export function containsCardData(value: string | null | undefined): boolean {
  if (!value) return false;
  // Fullwidth digits become ASCII, and invisible characters are dropped, so
  // neither can disguise a number.
  const text = String(value).normalize("NFKC").replace(INVISIBLE, "");

  // The whole value is a card number, however it is punctuated.
  const compact = text.replace(/[^\p{L}\p{N}]/gu, "");
  if (/^\d{13,19}$/.test(compact)) return true;

  for (const match of text.matchAll(DIGIT_RUN)) {
    // A run can swallow neighbouring digits ("…4444 12/27" reads as one
    // run), so test every stretch of consecutive groups, not just the whole.
    const groups = match[0].split(/[ .-]/);
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length; j++) {
        digits += groups[j];
        if (digits.length > 19) break;
        if (digits.length >= 13 && luhnValid(digits)) return true;
      }
    }
  }

  // Other separators are only read as a card number when the groups are
  // laid out like one, so dates and reference numbers written with "/" or
  // "_" next to each other are not mistaken for cards.
  for (const match of text.matchAll(LOOSE_DIGIT_RUN)) {
    const groups = match[0].split(/[^\p{N}]+/u).filter(Boolean);
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j <= groups.length; j++) {
        const stretch = groups.slice(i, j);
        const digits = stretch.join("");
        if (digits.length > 19) break;
        if (
          digits.length >= 13 &&
          looksLikeCardGrouping(stretch) &&
          luhnValid(digits)
        ) {
          return true;
        }
      }
    }
  }

  if (SECURITY_CODE.test(text)) return true;
  if (EXPIRY.test(text)) return true;
  if (BARE_SECURITY_CODE.test(text)) return true;
  if (BARE_EXPIRY.test(text)) return true;
  return false;
}
