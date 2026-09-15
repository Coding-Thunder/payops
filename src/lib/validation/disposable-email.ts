/**
 * Disposable / temporary email detection.
 *
 * WHY THIS EXISTS. Every public flow that needs a reachable human — beta
 * applications, signup, review submissions — was previously defended only by
 * Turnstile and a rate limit. Neither looks at the address: a scripted signup
 * is stopped, but one person with `yopmail.com` open in a tab is not. The
 * signup route's own comment claimed rate limiting "kills disposable-email
 * abuse"; it did not, and `yopmail.com` was accepted.
 *
 * DESIGN. A denylist, not a heuristic, and deliberately so:
 *
 *   - MX lookups are not used. They are slow on a request path, fail open on
 *     timeout, and disposable providers have perfectly valid MX records — the
 *     check would reject nothing while adding a network dependency to signup.
 *   - No paid validation API. It would be a new vendor, a new secret, a new
 *     outage surface and a per-signup cost, for a problem a list solves.
 *   - Matching is on the REGISTRABLE-ISH domain plus every parent suffix, so
 *     `foo.mailinator.com` is caught by the `mailinator.com` entry. Disposable
 *     providers hand out wildcard subdomains freely; listing only the apex
 *     would be trivially bypassed.
 *
 * FALSE POSITIVES ARE THE EXPENSIVE FAILURE. Blocking a real prospect costs a
 * customer and is invisible — they simply leave. So this list contains only
 * providers whose stated purpose is throwaway addressing. It must never grow
 * to include free consumer mail (gmail, outlook, yahoo, proton, icloud …):
 * a large share of freelancers and small agencies — exactly this product's
 * market — sign up with one. `ALLOWED_SAMPLES` in the tests pins that.
 */

/**
 * Known disposable / temporary mailbox providers.
 *
 * Grouped by family, apex domains only — subdomains are handled by the suffix
 * walk in `isDisposableEmailDomain`. Add to this list; do not add heuristics.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  // Yopmail
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "cool.fr.nf",
  "jetable.fr.nf",
  // Mailinator
  "mailinator.com",
  "mailinator.net",
  "mailinator2.com",
  "notmailinator.com",
  "reallymymail.com",
  "sogetthis.com",
  "suremail.info",
  // Guerrilla Mail
  "guerrillamail.com",
  "guerrillamail.biz",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "grr.la",
  "sharklasers.com",
  "spam4.me",
  // 10 Minute Mail
  "10minutemail.com",
  "10minutemail.net",
  "10minutemail.org",
  "20minutemail.com",
  "temporaryemail.net",
  // Temp-Mail
  "temp-mail.org",
  "temp-mail.io",
  "temp-mail.ru",
  "tempmail.com",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "tmail.ws",
  "tmpmail.org",
  "tmpmail.net",
  // Disposable Mail / Maildrop family
  "disposablemail.com",
  "dispostable.com",
  "maildrop.cc",
  "mailnesia.com",
  "mailcatch.com",
  "mailnull.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "wegwerfmail.de",
  "wegwerfmail.net",
  "wegwerfmail.org",
  // Throwaway / burner services
  "throwawaymail.com",
  "throwaway.email",
  "burnermail.io",
  "getnada.com",
  "nada.email",
  "inboxkitten.com",
  "emailondeck.com",
  "fakemailgenerator.com",
  "fakeinbox.com",
  "spamgourmet.com",
  "mytemp.email",
  "moakt.com",
  "mohmal.com",
  "linshiyouxiang.net",
  "einrot.com",
  "armyspy.com",
  "cuvox.de",
  "dayrep.com",
  "fleckens.hu",
  "gustr.com",
  "jourrapide.com",
  "rhyta.com",
  "superrito.com",
  "teleworm.us",
  // Mailsac / Mailtrap-style testing inboxes used as throwaways
  "mailsac.com",
  "mailhog.example",
  "inbox.testmail.app",
  // Misc widely-used temporary providers
  "spambog.com",
  "spambox.us",
  "mailexpire.com",
  "mintemail.com",
  "anonbox.net",
  "trbvm.com",
  "byom.de",
  "discard.email",
  "discardmail.com",
  "yomail.info",
  "vomoto.com",
  "instantemailaddress.com",
  "tempinbox.com",
  "mailforspam.com",
  "harakirimail.com",
  "spamdecoy.net",
  "deadaddress.com",
  "emltmp.com",
  "luxusmail.org",
  "vpsmail.top",
]);

/**
 * Normalise an email address for comparison.
 *
 * Trims, lowercases, and returns null for anything that is not
 * `local@domain`. Deliberately conservative: this is a *matcher*, not a
 * validator — zod already enforces the address shape upstream, and a parser
 * that guessed at malformed input would create bypasses.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || trimmed.indexOf("@") === -1) return null;
  // An address may legitimately contain no second "@"; take the last one so a
  // quoted local part cannot smuggle a different domain past the check.
  const at = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain || domain.indexOf(".") === -1) return null;
  return `${local}@${domain}`;
}

/** The domain part of a normalised address, or null. */
export function emailDomain(email: string | null | undefined): string | null {
  const normalised = normalizeEmail(email);
  if (!normalised) return null;
  return normalised.slice(normalised.lastIndexOf("@") + 1);
}

/**
 * True when the domain — or any parent suffix of it — is a known disposable
 * provider.
 *
 * The suffix walk is what makes the list maintainable: one `mailinator.com`
 * entry covers `team.mailinator.com`, `x.y.mailinator.com` and every other
 * wildcard subdomain the provider hands out. It stops before the public
 * suffix, so a single-label entry could never blanket a whole TLD.
 */
export function isDisposableEmailDomain(domain: string | null | undefined): boolean {
  if (typeof domain !== "string") return false;
  const clean = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!clean || clean.indexOf(".") === -1) return false;

  const labels = clean.split(".");
  // Walk every suffix down to two labels: `a.b.mailinator.com` →
  // `a.b.mailinator.com`, `b.mailinator.com`, `mailinator.com`.
  for (let i = 0; i <= labels.length - 2; i += 1) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** True when the address belongs to a known disposable provider. */
export function isDisposableEmail(email: string | null | undefined): boolean {
  return isDisposableEmailDomain(emailDomain(email));
}

/**
 * The single user-facing message for a rejected address.
 *
 * Says what to do rather than what went wrong, and names no provider — there
 * is nothing to gain from telling an abuser which list they hit.
 */
export const DISPOSABLE_EMAIL_MESSAGE =
  "Please use a permanent work email address. Temporary or disposable addresses aren't accepted.";

/** How many providers the list covers. Exposed for the admin abuse view. */
export const DISPOSABLE_DOMAIN_COUNT = DISPOSABLE_DOMAINS.size;

/**
 * A zod refinement for any schema with an email field.
 *
 * Used so every public entry point enforces this the same way and a new form
 * cannot forget: `z.string().email().refine(...disposableEmailRefinement)`.
 */
export const disposableEmailRefinement = [
  (value: string) => !isDisposableEmail(value),
  { message: DISPOSABLE_EMAIL_MESSAGE },
] as const;
