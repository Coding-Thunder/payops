# TraceTxn — Operational Payment Infrastructure

A production-grade Next.js (App Router) monolith for managing the full
transaction lifecycle. Tenants create payable orders against per-vertical
item types, the system generates payment-gateway sessions, sends a
hashed-evidence email + hosted-consent flow, and once the gateway
confirms payment via webhook the system atomically updates the order and
records every transition into the per-order evidence chain.

> Multi-tenant SaaS. Self-serve signup; per-org Stripe credentials;
> dispute-grade evidence on every order.

## What it does

- **Universal commerce primitives** — `ItemType` (per-vertical schema) →
  `Item` (catalog row) → `Order.lineItems[]` (multi-line cart). One
  backbone for retail, services, repair, dealership, equipment, B2B,
  rentals, custom commerce.
- **Hashed evidence chain** — every transition on every order is hashed
  against the previous event. A broken chain surfaces immediately;
  exports are bank-grade PDFs.
- **Hosted consent capture** — customer signs in-browser; IP, UA,
  signed-name + timestamp recorded onto the chain.
- **Multi-gateway orchestration** — Stripe live; Razorpay + Authorize.net
  adapters scaffolded. One contract (`PaymentGateway`), one
  `VerifiedPaymentEvent` shape across providers.
- **Realtime SSE lifecycle** — operator surfaces push-update as
  webhooks fire; polling backstop on disconnect.
- **Org-isolated multi-tenant** — every read/write pins on orgId.
  Cross-tenant id-guess always returns 404.

## Stack

- **Next.js 16 (App Router) + TypeScript strict** — single repo,
  server-first
- **MongoDB + Mongoose** — connection caching, strict schemas,
  partial-unique indexes, per-org partition keys
- **Stripe + per-org credentials** — secret material AES-256-GCM
  encrypted at rest via `TRACETXN_MASTER_KEY`
- **Nodemailer (Google Workspace SMTP) + React Email** — durable
  outbox; emails recorded onto the evidence chain
- **JWT (jose) + HTTP-only cookies** — verified at the edge in
  middleware
- **Zod** — every API input is validated; route handlers throw
  `AppError`
- **shadcn/ui + Tailwind v4** — restrained, semantic-token-driven
- **TanStack Query** — minimal client cache for live surfaces
- **bcryptjs** — 12-round password hashing

## Architecture

```
src/
├── app/                    # App Router (pages, layouts, api routes)
│   ├── (marketing)/        # Public landing (composed document, regions)
│   ├── login/ signup/      # Public auth surfaces
│   ├── app/                # Authenticated operator console
│   │   ├── dashboard/      # KPI strip + dispute-anchored right rail
│   │   ├── orders/         # Order list + detail + evidence view
│   │   └── admin/          # Catalog, items, gateways, branding, etc.
│   └── api/                # All route handlers
├── components/
│   ├── marketing/          # Cover band, document chrome, regions, canvases
│   ├── ui/                 # shadcn primitives
│   ├── common/             # PageHeader, EmptyState, StatCard, etc.
│   ├── features/           # Feature-driven (orders/, items/, evidence/, …)
│   └── app-shell/          # Sidebar, topbar, telemetry strip
├── lib/
│   ├── constants/          # enums, labels, RBAC permission registry
│   ├── validation/         # Zod schemas per resource
│   ├── crypto/             # AES-256-GCM envelope (gateway credentials)
│   ├── errors.ts           # AppError hierarchy
│   ├── format.ts           # currency, dates, UTC timestamps, hash short
│   └── api-client.ts       # Typed fetch wrapper (browser)
├── server/
│   ├── auth/               # JWT, password hashing, session, RBAC
│   ├── api/                # withApi wrapper, request-context, security
│   ├── db/                 # Mongoose connection + models + org-context
│   ├── email/              # React Email templates + SMTP transporter
│   ├── payments/           # Gateway registry + per-org credential loader
│   ├── pdf/                # Server-side PDF rendering (evidence export)
│   └── services/           # Business logic (orders, items, customers,
│                              evidence, audit, settings, webhook, …)
├── types/                  # Shared DTO types
├── proxy.ts                # Edge auth + route taxonomy
scripts/
├── cleanup-by-email.ts     # Dev: remove all records tied to an email
├── cleanup-prod-data.ts    # Dev: drop operational data, preserve users
└── check-order.ts          # Dev: inspect a single order in mongosh-like format
```

### Architectural rules

- **Webhook is the only payment truth.** No success-page side effects.
- **All payment ops are idempotent.** Per-order `processedWebhookEventIds`
  guards repeated gateway deliveries.
- **No hard delete on financial data.** Orders carry a `state` of
  `ACTIVE | ARCHIVED | DISABLED`. Refunded + paid orders never delete.
- **Strict enums everywhere.** All status / role / type values are
  sourced from `src/lib/constants/enums.ts`.
- **Server validation is mandatory.** Frontend validation is UX only.
- **RBAC is server-enforced.** The `Permission` registry plus
  `requirePermission()` guards every protected route.
- **Audit log captures every meaningful action.** Append-only; not
  editable, even by admins.
- **Evidence chain is the schema.** Compliance isn't an export feature
  added later — it's the storage primitives themselves.

## Local development

Defaults assume a local mongod on `127.0.0.1:27017` (override via
`MONGODB_URI` in `.env.local`).

```bash
brew services start mongodb-community     # if not already running
cp .env.example .env.local                # fill in Stripe + JWT_SECRET
npm install
npm run dev                                # http://localhost:3000
```

Sign up at `/signup` to create the first workspace (super-admin role).
Forward Stripe webhooks to the local route while testing:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe/<orgId>
```

(`<orgId>` is your workspace's id — admin/gateways auto-registers a
unique endpoint per org when you connect Stripe.)

## Production checks

```bash
npx tsc --noEmit                          # type safety
npm run lint                              # static checks
npm run build                             # full production build
npx vitest run --no-file-parallelism      # integration + unit suites
```

## Email setup (Google Workspace SMTP)

Confirmation + payment-request emails are sent through your Google
Workspace mailbox via App Passwords — no third-party email service
required.

**One-time setup:**

1. Workspace admin (admin.google.com) → Security → "Less secure apps" →
   allow users to manage their App Passwords.
2. Sign in to the sending mailbox (e.g. `billing@yourdomain.com`).
3. https://myaccount.google.com/security → turn on **2-Step Verification**.
4. https://myaccount.google.com/apppasswords → create an App Password
   named "TraceTxn" (or "TraceTxn prod") and copy the 16-char value.
5. Paste into `SMTP_PASS` (spaces are stripped automatically).

**Limits:** ~2,000 recipients/day per sender, ~500 per single message.

**If email is misconfigured** — sends become `EMAIL_FAILED` audit rows;
order flow continues normally. Check `/app/admin/audit` for the error.

## Operational notes

- **Gateway expiry**: Stripe limits checkout-session expiry to ~24h. The
  order's `payment.expiresAt` is clamped accordingly.
- **Confirmation gate**: send is gated by
  `payment.confirmationEmailSentAt` so simultaneous webhook deliveries
  can only send it once.
- **Currency**: `pricing.amount` is in **major units** (e.g. dollars).
  Gateways receive minor units (cents) — conversion in
  `order.service:toMinorUnits` (zero-decimal currencies handled).
- **Soft delete**: Archive on the order detail page. Paid orders can
  never be archived. Disabled/archived users retain their audit history.
- **Encryption key**: `TRACETXN_MASTER_KEY` must be set in any
  environment that holds per-org gateway credentials. Generate with
  `openssl rand -base64 32`. Loss of the key locks all encrypted
  credentials.

## Pre-launch checklist

- [ ] Rotate `MONGODB_URI` credentials (Atlas user + password)
- [ ] Generate fresh `JWT_SECRET` per environment (never share dev → prod)
- [ ] Configure `TRACETXN_MASTER_KEY` in prod env
- [ ] Configure production webhook secret(s) in the Stripe dashboard
- [ ] Replace any bootstrap admin password after first login
- [ ] Generate a production Google Workspace App Password
- [ ] Set `COOKIE_SECURE="true"` and `NODE_ENV="production"` in prod
- [ ] Set `NEXT_PUBLIC_APP_URL` to the production HTTPS URL
- [ ] Configure Cloudflare Turnstile (login + quotation bot-check) — set
      both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
- [ ] Verify the at-rest backup policy on the production MongoDB cluster
- [ ] Set up Stripe Connect / per-org webhook endpoints for any tenants
      onboarding with their own Stripe account
