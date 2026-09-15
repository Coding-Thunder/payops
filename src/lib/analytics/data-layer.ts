/**
 * The dataLayer — the one way this application talks to Google Tag Manager.
 *
 * GTM is a tag injector with no code review (see `./gtm`). What it can
 * MEASURE, though, is decided here: a container tag can only fire on what the
 * page pushes, so this module is the contract between the product and every
 * conversion tag that will ever exist in that container.
 *
 * ── Three rules, and the failure each one prevents ───────────────────────
 *
 * 1. AN EVENT FIRES ONLY AFTER THE SERVER SAID YES.
 *
 *    Every push below happens in the success branch of a completed request —
 *    never on a click, a form submit, a validation pass, or a route change.
 *    The reason is not tidiness: Google Ads optimises bidding against
 *    conversions, so a conversion that fires on "user pressed the button"
 *    trains the bidder on attempts rather than outcomes. Bot traffic, failed
 *    Turnstile challenges, duplicate submissions and rejected disposable
 *    emails all press the button; none of them are conversions, and paying to
 *    acquire more of them is exactly what a click-fired tag causes.
 *
 * 2. NO EVENT CARRIES PII OR A TOKEN. Ever.
 *
 *    Not an email, not a name, not a business, not a session id, not a
 *    Turnstile token, not a reset or invite token, not a URL that might
 *    contain one. Everything pushed is a category, a count, or a boolean.
 *    Anything in the dataLayer is readable by every tag in the container and
 *    is sent wherever those tags point, which is not a decision this
 *    repository gets to review. Hashed email for enhanced conversions is
 *    deliberately NOT implemented: it would be a new disclosure obligation
 *    and a new consent question, and it is not something to add as a side
 *    effect of wiring up a tag.
 *
 * 3. AN EVENT IS A FACT, NOT AN INSTRUCTION.
 *
 *    Names describe what happened in the product (`beta_application_submitted`),
 *    not what marketing wants counted (`conversion`, `lead`). Which of these
 *    counts as a conversion, and what it is worth, is configured in the Ads
 *    UI where that decision belongs and can be changed without a deploy.
 *
 * ── Deliberately absent ──────────────────────────────────────────────────
 *
 * No `gtag()`, no `AW-` conversion id, no `send_to`, no conversion values, no
 * `user_id`, no page-view pushes. Route-level page views are GTM's own job
 * (History Change trigger); duplicating them here would double-count.
 *
 * Safe to call from anywhere: if GTM never loaded — no container id, an ad
 * blocker, or a route where CSP blocks it — the push lands in a plain array
 * nobody reads, and nothing throws.
 */

/** Events this application is allowed to push. The whole vocabulary. */
export const DATA_LAYER_EVENTS = {
  /** A beta application was accepted and stored. The primary lead event. */
  BETA_APPLICATION_SUBMITTED: "beta_application_submitted",
  /** A workspace was created and the account is live. */
  SIGNUP_COMPLETED: "signup_completed",
  /** A review was accepted into the moderation queue. */
  REVIEW_SUBMITTED: "review_submitted",
  /** A quotation/contact enquiry was accepted. */
  CONTACT_SUBMITTED: "contact_submitted",
} as const;

export type DataLayerEvent =
  (typeof DATA_LAYER_EVENTS)[keyof typeof DATA_LAYER_EVENTS];

/**
 * Parameter values a tag may receive.
 *
 * Primitives only, by type. An object or array would be a place for a whole
 * form payload to be passed by accident — `{ event, ...formState }` is one
 * careless spread away, and it would put a name and an email into the
 * container. There is no shape of allowed value that can hold a submitted
 * form.
 */
export type DataLayerValue = string | number | boolean | null;

export interface DataLayerParams {
  [key: string]: DataLayerValue;
}

/**
 * Words that must never appear IN a key name.
 *
 * Matched per word, not per key. An exact-match list looks equivalent and is
 * not: it blocks `email` and `name` while letting `businessName` and
 * `authorEmail` straight through, which are precisely the shapes a real form
 * uses. Splitting the key into words first means one entry covers every
 * compound built from it.
 *
 * Substring matching would be the other obvious fix and is worse — `id` as a
 * substring rejects `first_paid` and `width`, so a legitimate parameter gets
 * silently dropped and nobody finds out until a conversion count is wrong.
 *
 * Note what is NOT here: `user`. `user_type` is a category this app pushes
 * deliberately, and `userId` is already caught by the `id` entry.
 */
const FORBIDDEN_WORDS = new Set([
  "email",
  "mail",
  "name",
  "firstname",
  "lastname",
  "phone",
  "mobile",
  "address",
  "company",
  "business",
  "organisation",
  "organization",
  "token",
  "password",
  "secret",
  "credential",
  "id",
  "uid",
  "session",
  "cookie",
  "slug",
  "url",
  "uri",
  "href",
  "path",
  "query",
  "referrer",
  "referer",
  "ip",
]);

/**
 * Split a key into lowercase words: `authorEmail` → `author`, `email`;
 * `user_id` → `user`, `id`; `e-mail` → `e`, `mail`.
 */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/** True when a key is safe to push. Exported so the test can assert on it. */
export function isAllowedDataLayerKey(key: string): boolean {
  if (typeof key !== "string" || !key.trim()) return false;
  const words = keyWords(key);
  if (!words.length) return false;
  // The whole key, de-punctuated, also counts as a word: `e-mail` is caught
  // by its `mail` half, but `emailaddress` needs the joined form too.
  const joined = words.join("");
  return (
    !words.some((word) => FORBIDDEN_WORDS.has(word)) &&
    !FORBIDDEN_WORDS.has(joined)
  );
}

interface DataLayerWindow extends Window {
  dataLayer?: unknown[];
}

/**
 * Push one event.
 *
 * Silently drops a forbidden parameter rather than throwing: a marketing
 * event must never break a submission that has already succeeded on the
 * server, and the correct behaviour when in doubt is to send less.
 */
export function pushDataLayerEvent(
  event: DataLayerEvent,
  params: DataLayerParams = {},
): void {
  if (typeof window === "undefined") return;
  try {
    const safe: DataLayerParams = {};
    for (const [key, value] of Object.entries(params)) {
      if (!isAllowedDataLayerKey(key)) continue;
      // Primitives only. A nested object would be a payload smuggler.
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        // Cap strings: a category is a short token, and an unbounded string
        // is a place for free text to end up.
        safe[key] = typeof value === "string" ? value.slice(0, 64) : value;
      }
    }

    const w = window as DataLayerWindow;
    // Created if GTM has not loaded — the array is the interface, and the
    // container replays whatever is already in it when it does load.
    w.dataLayer = w.dataLayer ?? [];
    w.dataLayer.push({ event, ...safe });
  } catch {
    /* analytics must never break a flow that has already succeeded */
  }
}
