# PayOps testing architecture

A three-tier test suite designed for reliability, deterministic execution,
and confidence during refactors. Every tier runs against its own
environment with strict isolation guarantees — nothing in this suite
touches the development or production database.

## Layout

```
src/tests/
├── unit/             # Vitest, jsdom + node, no DB, no network
│   ├── lib/          # validation, format, permissions, api-client
│   ├── server/       # jwt, password, order-number, event bus (node env)
│   └── components/   # React Testing Library
├── integration/      # Vitest, node env, real Mongoose on mongodb-memory-server
│   ├── api/          # Next.js route handlers via NextRequest
│   └── services/     # service-layer behaviour, RBAC, audit trails
├── smoke/            # Playwright against a running Next.js server
├── factories/        # users, orders, settings, stripe events
├── fixtures/         # canonical inputs and webhook payloads
├── mocks/            # server-only stub, in-process Stripe stub
├── setup/            # vitest + playwright lifecycle hooks
└── utils/            # auth, db, api, render, next-headers helpers
```

## Commands

```bash
npm run test                    # unit + integration in one go
npm run test:unit               # fast feedback loop (jsdom + node)
npm run test:unit:watch         # interactive
npm run test:integration        # DB-backed services + API routes
npm run test:integration:watch  # interactive
npm run test:coverage           # vitest + v8 coverage report

npm run test:smoke              # Playwright (Next dev mode, fastest)
npm run test:smoke:build        # build → start → smoke (closer to prod)
npm run test:smoke:ui           # Playwright UI mode
npm run test:smoke:report       # open the last HTML report

npm run test:all                # unit + integration + smoke
```

## Environments

| File          | Used by             | Mongo URI                                  |
|---------------|---------------------|--------------------------------------------|
| `.env.local`  | `next dev`          | `mongodb://127.0.0.1:27017/payops`         |
| `.env.test`   | Vitest unit + int.  | overridden by mongodb-memory-server        |
| `.env.smoke`  | Playwright smoke    | `mongodb://127.0.0.1:27017/payops-smoke`   |
| `.env.prod`   | Production          | MongoDB Atlas                              |

Smoke tests refuse to run if `MONGODB_URI` does not contain
`payops-smoke` — a hard guard against accidentally targeting dev / prod.

## Tier 1 · Unit tests

- **Environment** — jsdom by default; server modules declare
  `// @vitest-environment node` at the top.
- **No DB**, **no network**. A global `fetch` fence throws on any
  accidental real call.
- **`server-only`** is aliased to a no-op so service modules can be
  imported from the test runner.
- **`next/headers`** is mocked through the integration setup file
  (`vi.mock`) and steered with `setNextHeaders({ cookies, headers })`.

What's covered:

- Validation schemas (login, create order, update settings, etc.)
- Formatting + currency helpers
- Permission matrix (role × permission, including inheritance)
- Error class hierarchy + `isAppError` narrowing
- JWT sign + verify, TTL parsing, secret rotation
- Password hashing + verification
- Pure service helpers (`toMinorUnits`, `generateOrderNumber`)
- Event bus audience filter
- LoginForm component (RTL + userEvent)
- `api-client` envelope handling

## Tier 2 · Integration tests

- **Environment** — node.
- **MongoDB** — `mongodb-memory-server` boots one mongod per run; each
  test file gets its own logical database namespace (`it-<uuid>`),
  collections are wiped in `afterEach`. Indexes survive between tests
  for speed.
- **Stripe** — replaced by an in-process stub (`stripe-stub.ts`) that
  records `checkout.sessions.create` calls, lets tests pre-stage
  failures, and validates webhook signatures with the same HMAC scheme
  Stripe uses.
- **Email** — SMTP is left empty so the email service degrades to
  `EMAIL_FAILED` audit rows, which tests assert against.

What's covered:

- `authenticate` — successful login, wrong password, disabled account,
  unknown email enumeration protection, JWT round-trip.
- `createOrder` — Stripe session creation, idempotency key, audit row,
  policy snapshot, Stripe failure rolls back to FAILED.
- `listOrders` — STAFF scoped to own orders, ADMIN sees all.
- `getOrderById`, `archiveOrder`, `regeneratePaymentLink`.
- `createUser` / `updateUser` / `resetUserPassword` with RBAC guards.
- Webhook processor — paid transitions, duplicate dedupe, concurrent
  delivery email-claim race, expired + failed events, lookup by
  `client_reference_id` AND fallback to `stripeSessionId`.
- `POST /api/auth/login` — 200/401/422 envelopes + session cookie set.
- `POST /api/orders` — RBAC + happy path + zod errors.
- `POST /api/webhooks/stripe` — missing / invalid / valid / duplicate
  signatures, audit rows.
- `POST /api/admin/users` — full RBAC matrix (STAFF blocked, ADMIN
  can't escalate to SUPER_ADMIN).

## Tier 3 · Smoke tests (Playwright)

Boot a real Next.js server against `payops-smoke`, then drive critical
business workflows over HTTP.

- **Global setup** — connects to Mongo, drops the smoke DB, seeds an
  admin + staff user, writes credentials to `reports/.smoke-creds.json`.
- **Global teardown** — drops the smoke DB and removes the creds file.
- **Stripe** — `PAYOPS_TEST_MODE=smoke` activates the in-process stub,
  so checkout session creation never opens a network socket.
- **Webhook signing** — tests sign synthetic events with the smoke
  webhook secret. The real `Stripe.webhooks.constructEvent` (from the
  stub) validates the signature, so we exercise the production code
  path end-to-end.

Specs:

1. `01-health-and-login.spec.ts` — `/api/health`, anonymous redirect,
   admin login UI, invalid-credentials inline error.
2. `02-order-flow.spec.ts` — admin creates order → webhook flips it to
   PAID → idempotent duplicate delivery → invalid signature rejected.
3. `03-rbac.spec.ts` — anonymous → `/admin` bounces to `/login`,
   STAFF → `/admin` bounces to `/dashboard`, STAFF → `/api/admin/users`
   returns 403 JSON, ADMIN reaches `/admin`.
4. `04-admin-operations.spec.ts` — admin creates a STAFF user via the
   API, `/api/auth/me`, no `passwordHash` in list responses, dashboard
   renders without console errors.

## Factories

Every factory exposes a pure `build…()` (for unit tests) and a
`create…()` (persists). Factories never connect to Mongo themselves —
they assume `ensureMongo()` has been called by the test setup.

```ts
const admin = await createAdmin({ email: "ada@payops.test" });
const order = await createPaidOrder({ pricing: { amount: 199.5, currency: "USD" } });
const settings = await createSettings();
```

## Mocks

- `mocks/server-only.ts` — no-op replacement aliased by Vitest.
- `mocks/stripe-stub.ts` — programmable Stripe surface. Set up by
  `integration.setup.ts`; tests retrieve it via
  `getCurrentTestStripe()`.

## Adding a new test

1. **Unit?** → `src/tests/unit/{lib,server,components}/<name>.test.ts`.
   Declare `// @vitest-environment node` if the test touches server
   modules.
2. **Integration?** → `src/tests/integration/{api,services}/<name>.test.ts`.
   `await ensureMongo()` in a `beforeEach`, then use factories +
   service / route handlers directly.
3. **Smoke?** → `src/tests/smoke/<NN>-<name>.spec.ts`. Use
   `getSmokeCreds()` + `loginAsApi(request, user)` for the fast path,
   `loginAs(page, user)` when the UI itself is what you're verifying.

## CI/CD readiness

- `CI=1 npm run test:all` exits non-zero on the first failing tier.
- Vitest + Playwright emit JUnit XML / HTML reports into `reports/`
  (gitignored).
- Smoke tests use `next start` (not `next dev`) when `PLAYWRIGHT_USE_DEV`
  is unset, so they run against the same code path the production
  deploy will.
- Coverage thresholds enforce a baseline (`statements/lines >= 50%`).
  Bump them as the suite grows.

## Performance budget

- Unit suite: < 5 s for 100+ tests on a laptop.
- Integration suite: ~6 s on a warm mongod; ~10 s cold.
- Smoke suite: depends on Next build time; under 60 s once cached.

If a unit test takes longer than 5 s the runner fails it — that's the
canary for "this belongs in the integration tier".
