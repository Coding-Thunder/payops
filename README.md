# PayOps — Internal Payment Operations Console

A production-grade Next.js (App Router) monolith for managing car rental
payment workflows. Employees create payable orders, the system generates
Stripe Checkout sessions, the employee shares the link with the customer
manually, and once Stripe confirms payment via webhook the system atomically
updates the order and sends a single branded confirmation email.

> Internal tool. No public sign-up. Only admin-created users can log in.

## Stack

- **Next.js (App Router) + TypeScript strict** — single repo, server-first
- **MongoDB + Mongoose** — connection caching, strict schemas, indexes
- **Stripe Checkout** — `checkout.session.completed` is the source of truth
- **Resend + React Email** — one transactional template, locale-stable
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
│   ├── env.ts              # Strictly-typed env loader
│   ├── errors.ts           # AppError hierarchy
│   ├── format.ts           # Money / date formatters
│   ├── api-client.ts       # Typed fetch wrapper (browser side)
│   └── utils.ts            # cn() helper
├── server/
│   ├── auth/               # JWT, password hashing, session, cookies, RBAC
│   ├── api/                # Route helpers (withApi, respond, request-context)
│   ├── db/                 # Mongoose connection + models
│   ├── email/              # React Email templates + Resend client
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

## Environment

Copy `.env.example` to `.env.local` and fill in:

```env
APP_URL=...
MONGODB_URI=...
JWT_SECRET=...               # 64+ random chars
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
RESEND_API_KEY=re_...
EMAIL_FROM="PayOps Rentals <no-reply@…>"

BOOTSTRAP_ADMIN_EMAIL=you@your-company.com
BOOTSTRAP_ADMIN_PASSWORD=<set-a-strong-password>
```

`src/lib/env.ts` validates env vars at boot and throws on misconfiguration.

## Local development

```bash
npm install
cp .env.example .env.local       # then edit
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

- [ ] Rotate `JWT_SECRET` to a fresh value (`openssl rand -base64 64`).
- [ ] Verify a domain in Resend and set `EMAIL_FROM` accordingly.
- [ ] Set `COOKIE_SECURE=true` in production environments.
- [ ] Configure the production webhook secret in the Stripe dashboard.
- [ ] Replace the bootstrap admin password after first login.
- [ ] Restrict `BOOTSTRAP_ADMIN_*` env vars to the deploy/seed environment.
