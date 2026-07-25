# TraceTxn Admin

A standalone platform super-admin console. It is a **separate Next.js app**
that connects to the **same MongoDB** as the main app and deploys as its own
DigitalOcean App Platform app (Source Directory = `/admin`).

## What it does

- **Gated sign-in**: Google (Firebase) _or_ email — either way an email
  from the server-side allow-list (`ADMIN_ALLOWLIST`) must verify a 6-digit
  **OTP** emailed to it before any page loads.
- **Dashboard**: active users, active tenants, recently-active, waitlist
  pending, trial funnel (active / ending-soon / expired), and a most-active
  users leaderboard (from the main app's `audit_logs`). Paid-vs-free and
  "beta" are shown as *not tracked yet* (no backing data in the schema).
- **Users**: paginated, searchable; enable/disable an account.
- **Waitlist**: paginated list of `quotations` where `source = "waitlist"`.
  **Grant access** provisions an Org + owner user (like the main app's
  signup) and emails a set-password link that works on the main app.

## Local dev

```bash
cd admin
cp .env.example .env.local   # fill in MONGODB_URI, JWT_SECRET, SMTP, ADMIN_ALLOWLIST, MAIN_APP_URL
npm install
npm run dev                  # http://localhost:3100
```

Without SMTP configured, the OTP and access links are printed to the server
console instead of emailed (handy for local testing).

## Deploy (DigitalOcean)

Create a **new** DO app from the same repo and set **Source Directory** to
`/admin`. Use `admin/.do/app.example.yaml` as the spec template. Key rules:

- `MONGODB_URI` + `JWT_SECRET` **must equal the main app's** (shared DB, and
  shared secret so set-password links validate on the main app).
- Keep `instance_count: 1` (the OTP rate-limiter is in-process).
- `FIREBASE_*` optional — omit to run email + OTP only.

## Security notes

- Allow-list is enforced at OTP issue, OTP verify, and on **every** protected
  request (removing an email revokes access on the next request).
- OTPs are stored hashed, single-use, TTL'd, and attempt-capped.
- Admin session is a separate httpOnly / SameSite=strict / Secure cookie.
- All admin actions are written to an `admin_audit` collection.
