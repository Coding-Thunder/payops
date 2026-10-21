import { z } from "zod";

/**
 * The one definition of "a strong enough password".
 *
 * Every surface that sets a password must validate against THIS, client and
 * server, because a client gate that is weaker than the server's is not a
 * convenience — it is a trap. On /activate the client checked only
 * `length >= 10` while the route additionally required an uppercase, a
 * lowercase and a digit, so a password like "aaaaaaaaaa" sailed past the form
 * and came back a 422. That lands on a first-time user's very first
 * interaction, on the only account-creation path the private beta has, and it
 * costs more than a confusing message: the rejected submit spends one of the
 * route's rate-limit attempts and one of the Turnstile widget's bounded
 * re-arms, both of which are finite.
 *
 * Keep the messages here too. They are shown to the visitor by the client
 * resolver and returned by the server's ZodError, so a single wording means
 * the two can never contradict each other.
 */
export const strongPassword = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200)
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[0-9]/, "Include a number");

/** Every rule as a predicate, for a form that reports them one at a time. */
export function describePasswordProblems(value: string): string[] {
  const out: string[] = [];
  if (value.length < 10) out.push("Use at least 10 characters");
  if (!/[A-Z]/.test(value)) out.push("Include an uppercase letter");
  if (!/[a-z]/.test(value)) out.push("Include a lowercase letter");
  if (!/[0-9]/.test(value)) out.push("Include a number");
  return out;
}
