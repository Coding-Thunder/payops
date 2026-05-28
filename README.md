# TraceTxn — Operational Payment Infrastructure

A production-grade Next.js (App Router) monolith for managing the full
transaction lifecycle. Tenants create payable orders against per-vertical
item types, the system generates payment-gateway sessions, sends a
hashed-evidence email + hosted-consent flow, and once the gateway
confirms payment via webhook the system atomically updates the order and
records every transition into the per-order evidence chain.

> Multi-tenant SaaS. Self-serve signup; per-org Stripe credentials;
> dispute-grade evidence on every order.

## Stack

- **Next.js (App Router) + TypeScript strict** — single repo, server-first
- **MongoDB + Mongoose** — connection caching, strict schemas, indexes
- **Stripe Checkout** — `checkout.session.completed` is the source of truth
- **Nodemailer (Google Workspace SMTP) + React Email** — one transactional template, sent via your existing Workspace mailbox using an App Password
- **JWT (jose) + HTTP-only cookies** — verified at the edge in middleware
- **Zod** — every API input is validated; route handlers throw `AppError`
- **shadcn/ui + Tailwind v4** — clean, accessible primitives
- **TanStack Query** — minimal client cache where truly needed
- **bcryptjs** — 12-round password hashing

## Architecture

```
src/
├── app/                    # App Router (pages, layouts, api routes)
│   ├── (app)/              # Authenticated console shell
│   ├── login/              # Public login page
│   └── api/                # All route handlers (auth, orders, admin, webhooks)
├── components/
│   ├── ui/                 # shadcn primitives
│   ├── common/             # Reusable pieces (PageHeader, EmptyState, etc.)
│   ├── features/           # Feature-driven components (orders/, users/, …)
│   └── app-shell/          # Sidebar, topbar
├── lib/
│   ├── constants/          # enums, labels, RBAC permission registry
│   ├── validation/         # Zod schemas (auth, user, order, settings)
│   ├── errors.ts           # AppError hierarchy
│   ├── format.ts           # Money / date formatters
│   ├── api-client.ts       # Typed fetch wrapper (browser side)
│   └── utils.ts            # cn() helper
├── server/
│   ├── auth/               # JWT, password hashing, session, cookies, RBAC
│   ├── api/                # Route helpers (withApi, respond, request-context)
│   ├── db/                 # Mongoose connection + models
│   ├── email/              # React Email templates + Nodemailer SMTP transporter
│   ├── payments/           # Stripe client factory
│   └── services/           # Business logic (orders, users, audit, settings,
│                              email, analytics, webhook)
├── types/                  # Shared DTO types
├── middleware.ts           # Edge auth + RBAC guard
scripts/
└── seed.ts                 # Bootstrap super admin + settings doc
```

### Architectural rules

- **Webhook is the only payment truth.** No success-page side effects.
- **All payment ops are idempotent.** Per-order `processedWebhookEventIds`
  guards repeated Stripe deliveries.
- **No hard delete on financial data.** Orders carry a `state` of
  `ACTIVE | ARCHIVED | DISABLED`.
- **Strict enums everywhere.** All status / role / type values are sourced
  from `src/lib/constants/enums.ts`.
- **Server validation is mandatory.** Frontend validation is UX only.
- **RBAC is server-enforced.** The `Permission` registry plus
  `requirePermission()` guards every protected route.
- **Audit log captures every meaningful action** (login, order creation,
  payment success/failure, email send, settings update, etc.).

## Local development

```bash
npm install
npm run seed                     # creates the bootstrap super admin
npm run dev                      # http://localhost:3000
```

In another terminal, forward Stripe events to the local webhook:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Sign in at `/login` with the bootstrap admin and start creating orders.

## Production checks

```bash
npm run typecheck
npm run lint
npm run build
```

## Email setup (Google Workspace SMTP)

Confirmation emails are sent through your existing Google Workspace mailbox
using an App Password — no third-party email service required.

**One-time setup:**

1. Workspace admin (admin.google.com) → Security → "Less secure apps" →
   allow users to manage their App Passwords. (Required only if currently
   blocked at the org level.)
2. Sign in to the sending mailbox (e.g. `billing@rentalconfirmation.com`).
3. Visit https://myaccount.google.com/security and turn on
   **2-Step Verification** if it isn't already.
4. Visit https://myaccount.google.com/apppasswords, create an App Password
   named "PayOps" (or "PayOps prod" for production), and copy the 16-char
   value.
5. Paste that value into `SMTP_PASS` (spaces are stripped automatically).
   No other env vars need to change.

**Limits to keep in mind:**

- Workspace mailbox limit: ~2,000 recipients/day per sender (more than
  enough for one confirmation per paid order).
- Per-message limit: ~500 recipients.

**If email is misconfigured** — sends become `EMAIL_FAILED` audit rows;
order flow continues normally. Check `/admin/audit` for the exact error.

## Operational notes

- **Stripe webhook expiry**: Stripe limits checkout session expiry to
  ~24h. The order's `payment.expiresAt` is clamped accordingly.
- **Email deliverability**: confirmation email send is gated by
  `payment.confirmationEmailSentAt` so even simultaneous webhook deliveries
  can only send it once.
- **Currency**: `pricing.amount` is stored in **major units** (e.g. dollars).
  Stripe receives minor units (cents) - conversion lives in
  `order.service.ts:toMinorUnits`.
- **Soft delete**: Use Archive on the order detail page. Paid orders can
  never be archived. Disabled/archived users retain their audit history.
- **DigitalOcean App Platform**: target Node 20+, expose port 3000, route
  `/api/webhooks/stripe` without auth (already excluded in middleware).

## Hardening checklist before going live

- [ ] Configure the production webhook secret in the Stripe dashboard.
- [ ] Replace the bootstrap admin password after first login.
- [ ] Generate a production Google Workspace **App Password** for the
      sending mailbox (`billing@…`) and set `SMTP_PASS`. Use a separate App
      Password per environment so dev / staging / prod can be revoked
      independently. Requires 2-Step Verification on the account
      (https://myaccount.google.com/security) and Workspace admin must
      permit App Passwords (Admin Console → Security → Less secure apps).
