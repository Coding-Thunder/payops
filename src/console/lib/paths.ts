/**
 * The single place that knows WHERE the platform console is mounted.
 *
 * The console used to be its own Next.js app served at `/`, so every link,
 * redirect and fetch inside it was written root-absolute (`/dashboard`,
 * `/api/notes`). It now lives inside the main app under `/admin`, and those
 * bare paths would resolve to main-app routes — `/api/auth/logout` would
 * clear the TENANT session, `/dashboard` would 308 to `/app/dashboard`, and
 * `redirect("/")` would land an unauthenticated operator on the marketing
 * site instead of the console login.
 *
 * Rather than bake `/admin` into ~70 call sites, every console path is built
 * from these two constants. Moving the console (say, to `/console`) is then
 * a one-line change here plus the directory rename under `src/app/`.
 *
 * Deliberately dependency-free so client components can import it.
 */

/** URL prefix of the console's page routes — `src/app/admin/`. */
export const ADMIN_BASE = "/admin";

/** URL prefix of the console's route handlers — `src/app/admin/api/`. */
export const ADMIN_API = `${ADMIN_BASE}/api`;

/**
 * Cookie `path` for the admin session.
 *
 * Scoped to the console rather than `/` so the platform JWT is not attached
 * to every tenant, marketing and customer request now that both apps share
 * one origin. `getAdminEmail()` is the only reader and is only ever called
 * from `/admin/**`. Set and clear MUST use the same value — a mismatch makes
 * sign-out write a second cookie instead of expiring the first.
 */
export const ADMIN_COOKIE_PATH = ADMIN_BASE;
