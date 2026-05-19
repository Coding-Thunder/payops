# PayOps — Full Platform Engineering Audit

> Date: 2026-05-19 · Branch: `main` · Auditor: Claude (Opus 4.7), staff/principal lens
> Scope: production-readiness, architecture, scalability, atomicity, security, infra fit for DigitalOcean App Platform $5 tier
> Style: brutal. No vague advice. Every finding cites a file:line where possible and gives the exact fix.

The platform is **architecturally promising but not production-trustworthy**. The dispute-grade ambition (evidence chain, consent capture, audit trail) is well-modelled, but it sits on top of multi-write flows with **no transactional boundary**, **no CSRF**, **no rate limiting**, **no queueing**, **no replay** on the realtime layer, and **synchronous PDF/email rendering inside hot HTTP paths**. The "multi-gateway" abstraction is half-real — Stripe field names leak everywhere. None of this is unfixable; the fix list is below in priority order.

---

## 0. Executive summary

**Cannot ship to a real merchant on a regulated workflow today.** The top three blockers are:

1. **Atomicity gap.** `applyCheckoutPaid` and `createOrder` mutate the order, the audit log, the evidence chain, the email-claim, then send email + publish event — none in a transaction. A process crash mid-flow leaves an inconsistent paid order. ([webhook.service.ts:169-309](src/server/services/webhook.service.ts#L169-L309))
2. **CSRF wide open.** Cookie auth, `sameSite: "lax"`, JSON POST endpoints, no token, no Origin check. ([cookies.ts:19](src/server/auth/cookies.ts#L19))
3. **No rate limiting anywhere.** `/api/auth/login`, `/api/consent/:token`, `/api/orders/:id/reconcile`, every admin POST. Brute-force / spam / DoS surface is unbounded. (Confirmed by grep — zero hits for rate limit infra in `src/`.)

**Realtime, PDF, and email subsystems will OOM the $5 tier under modest load.** PDF render is sync in-process (`@react-pdf/renderer` ~200-500 MB heap per render — [render.ts:51](src/server/pdf/evidence/render.ts#L51)), every connected SSE client holds a setInterval + listener pair forever on a single shared in-process `EventEmitter` ([events/bus.ts:26-35](src/server/events/bus.ts#L26-L35)), and email render is sync inside the webhook handler ([email.service.tsx:173-189](src/server/services/email.service.tsx#L173-L189)).

**The "multi-gateway abstraction" is cosmetic.** Stripe is hardcoded in the Order schema field name (`stripeSessionId` — [order.model.ts:231](src/server/db/models/order.model.ts#L231)), in the order service (`getStripe()` and Stripe types in [order.service.ts:947-1019](src/server/services/order.service.ts#L947-L1019)), and the four "placeholder" gateways throw at runtime ([gateways/index.ts:28-55](src/server/payments/gateways/index.ts#L28-L55)). Razorpay cannot ship without a migration.

**The evidence chain is structurally sound** (append-only model, hash chain, canonical JSON, append-on-unique-index race handling, append-only Mongoose hooks). It is the most senior-engineered piece of the codebase. Its weak spots are *operational*: silent failure swallowing, full HTML in payload, no retention/sharding.

The rest of this document is structured to be actionable: each finding is **what / why it's wrong / exact fix**, grouped by severity, and a P0→P3 prioritized order at the end.

---

## 1. Critical (P0) — must fix before any production trust

### C1. No DB transactions for any multi-write flow

**Where:** [webhook.service.ts:169-309](src/server/services/webhook.service.ts#L169-L309) (applyCheckoutPaid), [order.service.ts:249-400](src/server/services/order.service.ts#L249-L400) (createOrder), [order.service.ts:437-673](src/server/services/order.service.ts#L437-L673) (initiatePayment), [consent.service.ts:326-476](src/server/services/consent.service.ts#L326-L476) (recordConsentFromToken), basically every service that touches more than one collection.

**What's wrong:** Each "transition" is 3–7 sequential writes — Order, AuditLog, OrderEvidence, sometimes PaymentConsent, plus an in-memory event publish and an outbound SMTP send. None of these are wrapped in `mongoose.startSession() / withTransaction()`. A process crash, an SMTP timeout, an OOM during PDF rendering, or even a Mongo failover mid-flow leaves you with:

- Order PAID, no PAYMENT_COMPLETED evidence event → broken hash chain (sequence gap)
- Order created but no ORDER_CREATED evidence event → chain starts from sequence 2, verifyChain reports `sequence_gap` invalid
- Order updated but audit row missing → "who did this?" is unanswerable
- Consent recorded but Order pointer not updated → status inconsistency between collections

The code papers over this with `captureEvidenceSafe` which silently swallows errors and writes an `EVIDENCE_RECORD_FAILED` audit entry ([evidence.service.ts:170-206](src/server/services/evidence.service.ts#L170-L206)) — but that only catches *exceptions*, not crashes/timeouts.

**Why it matters for THIS product:** PayOps' value proposition IS the audit chain. A single broken chain on a chargeback that goes to court invalidates ALL of the dispute defense for that order.

**Exact fix:**

1. Move all multi-write service functions into a `withTransaction` wrapper:
   ```ts
   await connectMongo();
   const session = await mongoose.startSession();
   try {
     await session.withTransaction(async () => {
       const order = await Order.findOneAndUpdate({...}, {...}, { session, ... });
       await AuditLog.create([{...}], { session });
       await OrderEvidence.create([{...}], { session });
     });
   } finally {
     await session.endSession();
   }
   ```
2. Audit, evidence, and side-effects (email send, event publish) must be split:
   - "DB-state side effects" (audit row, evidence row) → inside the transaction
   - "External-world side effects" (SMTP, event bus) → AFTER commit, with retry/queue
3. Use MongoDB replica set (Atlas free tier is replica-set-capable). The current `mongoose.connect` URI must include `?replicaSet=...` for transactions to work.
4. Test: kill the process mid-`applyCheckoutPaid` and assert that the order rolls back to PENDING, not PAID-without-evidence.

---

### C2. Webhook returns 500 on email failure → PAID order with no email, forever

**Where:** [webhook.service.ts:322-368](src/server/services/webhook.service.ts#L322-L368) (sendConfirmationOnce)

**What's wrong:** Order is flipped to PAID and the evidence + audit are written. Then `sendPaymentConfirmationEmail` throws (SMTP down). The code rolls back `confirmationEmailSentAt` and re-throws so Stripe retries. Stripe retries → handler sees `processedWebhookEventIds.includes(eventId)` → falls into duplicate path → tries email again. If SMTP is still down, throws again. After Stripe gives up (~3 days, then stops retrying), order is PAID forever with no confirmation email ever sent.

There is NO durable retry. There is NO DLQ. There is NO out-of-band "email pending" reconciliation job.

**Exact fix:**

1. Decouple email send from the webhook 200/500 path. The webhook should *commit* DB state, ack 200 to Stripe, and enqueue the email as a background job.
2. Until you have a queue: add a periodic reconciler (`scripts/cron-send-missing-emails.ts`) that finds Orders with `status=PAID && confirmationEmailSentAt=null && updatedAt < now-15min` and re-attempts. Schedule via DO scheduled trigger (or cron container).
3. Once C1 is done and you have transactions, store an outbox row: `PendingEmail { orderId, kind, attempts, nextAttemptAt }` written *inside* the transaction. A worker drains the outbox.

---

### C3. Race condition: `pay/success` page calls `reconcileOrderPayment` with no auth

**Where:** [app/pay/success/page.tsx:35-45](src/app/pay/success/page.tsx#L35-L45)

**What's wrong:** Any visitor with a valid `orderNumber` (predictable format `ORD-YYMMDD-XXXXXX`) can:
- Discover whether someone else's order exists (information disclosure)
- Force a Stripe API call (Stripe rate limit is per-account → DoS surface)
- Trigger `applyCheckoutPaid` side effects on someone else's order if Stripe says paid

The reconcile endpoint already exists at `/api/orders/[id]/reconcile` and is authenticated. The page-side call bypasses that auth entirely because the customer has no session.

**Exact fix:**

1. The success page should be ID'd by a one-time signed token, not an enumerable order number. Stripe already round-trips `session_id={CHECKOUT_SESSION_ID}` on success_url ([gateways/stripe.ts:143](src/server/payments/gateways/stripe.ts#L143)). Use that as the credential: look up the order BY `payment.stripeSessionId`, verify the session-id matches what the gateway returned, then reconcile.
2. Throttle reconcile-by-public-customer via IP + sessionId rate limit (max 1 reconcile per session per 30s).
3. Never expose `order.customer.email`, `order.customer.phone`, or any internal status enum on this page without verifying possession of the session id.

---

### C4. No CSRF protection on cookie-authenticated state-changing endpoints

**Where:** [cookies.ts:19](src/server/auth/cookies.ts#L19) (`sameSite: "lax"`) + every POST/PATCH/DELETE under `/api/` (e.g. [api/orders/route.ts:26](src/app/api/orders/route.ts#L26))

**What's wrong:** `sameSite: "lax"` allows the session cookie on **top-level navigations** (form POSTs, link clicks). An attacker on `evil.com` can serve a hidden form that POSTs JSON to `/api/orders/[id]/regenerate-link` — the browser will attach the PayOps session cookie. No CSRF token, no Origin/Referer check, no `application/json` enforcement on the server. Mitigated only by the requirement that the body be JSON — which `fetch` from a same-site iframe can do trivially.

**Exact fix:**

1. Set `sameSite: "strict"` on the session cookie. PayOps has no cross-site auth requirement.
2. Additionally check the `Origin` header on every state-changing API route. Reject requests where `Origin` is missing or not equal to `APP_URL`. Centralize this in `withApi`.
3. Reject any state-changing request where `Content-Type` is not `application/json` (blocks form-submission attacks even if cookies leak through).
4. Add a CSRF token cookie + header pair for defense-in-depth (double-submit pattern).

---

### C5. No rate limiting anywhere

**Where:** Grep confirms no rate-limit utility, middleware, or external dependency anywhere in `src/`.

**Affected:**
- `/api/auth/login` — unlimited brute force ([api/auth/login/route.ts](src/app/api/auth/login/route.ts))
- `/api/consent/[token]` POST — unauth, token-gated, but a leaked token can be spammed
- `/api/orders/[id]/reconcile` — calls Stripe directly, no throttle
- `/api/admin/evidence/search` — `$or` of 8+ regex/equality conditions; expensive
- `/api/events` — every SSE connection holds memory; an attacker opens 1000 in parallel

**Exact fix:**

1. Add an in-process token-bucket limiter for the first cut: small dependency or 80-line in-house. Key by `(routeName, ip|userId)`. Single instance → in-process is fine on $5 tier.
2. Login: 10 attempts / 15 min / IP, 20 attempts / 15 min / email. Audit-log all failures (already done — good).
3. Consent POST: 5 attempts / hour / tokenHash.
4. Reconcile: 1 / 30s / orderId.
5. SSE: cap connections per user (e.g. 5).
6. Move to a Redis token bucket when you scale past one instance.

---

### C6. JWT secret rotation requires forcing all logouts

**Where:** [jwt.ts:16-21](src/server/auth/jwt.ts#L16-L21)

**What's wrong:** `cachedKey` is a single Uint8Array. No `kid` in the JWT header. No way to introduce a new secret and verify both old + new during a rotation window. If you ever need to rotate (credential leak, compliance), every session dies.

**Exact fix:**

1. Add a `kid` header to issued tokens.
2. Support `JWT_SECRET` + optional `JWT_SECRET_OLD` env vars; `verifySession` tries new then falls back to old.
3. Rotate by deploying with both, waiting `JWT_EXPIRES_IN`, then removing old.

---

### C7. Unbounded mongo array: `payment.processedWebhookEventIds`

**Where:** [order.model.ts:242](src/server/db/models/order.model.ts#L242), and pushed-to in 8+ places in webhook.service.ts and order.service.ts

**What's wrong:** Pushed-to on every webhook delivery (including duplicates that fail the conditional update — the array is the de-dupe mechanism). Disputes, refunds, dispute funds_withdrawn, dispute_updated, dispute_closed all push to the SAME order array. A single problematic order in a dispute storm can hit hundreds of entries. Mongo doc limit is 16 MB; you'll never hit it, but you WILL hit:

- Index update cost on every push (the array is unindexed — fine — but the doc rewrite cost grows)
- Working-set bloat on `Order.findById` queries (every read pulls the full array)
- Audit log spam: every duplicate hits `WEBHOOK_DUPLICATE` row

**Exact fix:**

1. Move the dedupe key to a sibling collection: `ProcessedWebhookEvent { gatewayEventId, orderId, processedAt }` with a unique index on `gatewayEventId`. `INSERT … ON CONFLICT DO NOTHING` semantics via `findOneAndUpdate(..., { upsert: true })`.
2. Cap retention with a TTL index on `processedAt` (90 days is more than enough for Stripe retry windows).
3. Backfill / migration: drop the array field; data lives in the new collection.

---

### C8. Reconcile race vs. webhook can double-publish events and double-email (partial mitigation only)

**Where:** [order.service.ts:1316-1442](src/server/services/order.service.ts#L1316-L1442) (reconcileOrderPayment) + [webhook.service.ts:169-309](src/server/services/webhook.service.ts#L169-L309) (applyCheckoutPaid)

**What's wrong:** Reconcile synthesizes its own `eventId = reconcile_<sessionId>_<Date.now()>`. The webhook event id is `evt_...`. The two never collide in `processedWebhookEventIds`, so BOTH can pass the dedupe check and BOTH can call `applyCheckoutPaid` concurrently. The conditional `$set status: PAID` is atomic, but:

- Both calls emit a `PAYMENT_SUCCEEDED` audit row
- Both calls emit a `PAYMENT_COMPLETED` evidence event (sequence races; one wins, the other becomes "duplicate" at the unique index — fine but adds latency)
- Both call `sendConfirmationOnce`; the conditional claim ensures only one wins the email
- Both publish `ORDER_PAID` events — UI sees the toast twice

**Exact fix:**

1. Make the dedupe key gateway-agnostic: `reconcile_<sessionId>` (no timestamp). Repeat reconcile calls collapse to one.
2. Or better: when reconcile sees PAID from the gateway, look up the *expected* gateway event id (via `processedWebhookEventIds` or the new sibling collection) and use it as the dedupe key. If the webhook later arrives with the real event id, reconcile already claimed it.
3. Wrap state transitions in a row-level lock pattern: `Order.findOneAndUpdate({ _id, status: { $ne: PAID } }, ...)` — but follow up the side effects via outbox, so duplicates collapse there too.

---

### C9. PDF generation runs sync, in-process — single export OOMs the instance

**Where:** [server/pdf/evidence/render.ts:51](src/server/pdf/evidence/render.ts#L51) (`renderToBuffer`) called from [api/orders/[id]/evidence/export/route.ts](src/app/api/orders/%5Bid%5D/evidence/export/route.ts)

**What's wrong:** `@react-pdf/renderer` pulls in fontkit + a JS canvas implementation + every font you use. A 50-event evidence chain with multiple embedded email HTMLs can be 200-500 MB peak heap. On a DO App Platform Basic $5 tier (typically 512 MB RAM, sometimes 1 GB), a SINGLE admin clicking "Export PDF" will OOM the process.

When the process OOMs:
- All connected SSE clients disconnect
- All in-flight requests drop
- Mongoose connection cache resets → ~10s cold start before next request lands
- Any half-written webhook re-delivers (good — Stripe retries, but you've now also missed unrelated webhooks during the downtime window)

**Exact fix:**

1. Short-term: gate PDF export behind a feature flag and a per-user lock so only one render is in flight at a time. Return 503 if locked.
2. Move the renderer to a dedicated worker process (separate DO component, or a worker dyno) and stream the result back.
3. Better: render lazily server-side and stream to a one-time-signed S3-style URL; UI polls "ready" and downloads. The render box can be a separate $5 instance that you spin up only when an export is queued.
4. Hard cap the chain size that any single PDF can render (chunk + paginate at 100 events).

---

### C10. SSE bus is per-process; multi-instance breaks realtime entirely

**Where:** [server/events/bus.ts:26-35](src/server/events/bus.ts#L26-L35)

**What's wrong:** `globalThis.__payopsBus` is an in-process `EventEmitter`. The instant DO App Platform scales to 2 instances (or you deploy a worker), events published in instance A are invisible to SSE clients on instance B. Even on a single instance, restart/deploy kills all SSE streams (the EventSource reconnects, but no event replay — so events emitted during the cutover window are *lost forever*).

**Exact fix:**

1. Replace `EventEmitter` with Redis pub/sub (or MongoDB change streams, which you already have a Mongo dep for — but be careful of the Atlas free-tier op-log restrictions).
2. Add an event journal: `EventLog { id, type, payload, audience, at }` written *synchronously* alongside the publish. SSE clients pass `Last-Event-ID` on reconnect; server replays missed events from the journal. Cap journal with TTL (7 days).
3. Heartbeat needs to be lifecycle-aware: clear it on the `req.signal.abort` ([events/route.ts:69-69](src/app/api/events/route.ts#L69)) — currently it IS cleared, but only on abort, not on `controller.error`. The "stream already closed" guard would also benefit from clearing.

---

## 2. High priority (P1) — strong next fixes

### H1. Stripe semantics leak through the "gateway abstraction"

**Where:**
- [order.model.ts:231](src/server/db/models/order.model.ts#L231) — schema field `stripeSessionId`
- [order.service.ts:947-1019](src/server/services/order.service.ts#L947-L1019) — `regeneratePaymentLink` imports `Stripe`, calls `getStripe()` directly, builds Stripe-shaped sessions, bypasses the `PaymentGateway` interface entirely
- [webhook.service.ts:403](src/server/services/webhook.service.ts#L403) and [order.service.ts:133](src/server/services/order.service.ts#L133) — DTO mapping hardcoded to `doc.payment.stripeSessionId`
- [payment.gateway field comment](src/server/db/models/order.model.ts#L67-L77) literally acknowledges this leak

**Why it matters:** Adding Razorpay or PayPal requires either a schema migration (rename `stripeSessionId` → `gatewaySessionId`) or perpetual mental tax. The four placeholder gateways throw on use ([gateways/index.ts:28-55](src/server/payments/gateways/index.ts#L28-L55)) — useful as a sentinel during dev, but the registry has no concept of "gateway not yet enabled, surface in admin UI as coming soon, hide from runtime selection". The current `getGateway(key)` returns the throwing placeholder; the order.service guards with `gateway.enabled` but it's defensive, not impossible to mis-route.

**Exact fix:**

1. Rename the schema field: `stripeSessionId` → `gatewaySessionId`. Migration: `db.orders.updateMany({}, [{ $set: { "payment.gatewaySessionId": "$payment.stripeSessionId" }}, { $unset: "payment.stripeSessionId" }])`. Update all readers (5 files).
2. Delete `regeneratePaymentLink` and have it call `initiatePayment` with `gateway: doc.payment.gateway` and a "force fresh session" flag — DRY + gateway-agnostic.
3. `buildCheckoutSession` in [order.service.ts:686-750](src/server/services/order.service.ts#L686-L750) is dead Stripe-specific code. Delete it.
4. The placeholder gateways should be in a separate registry surface: `listKnownGateways()` returns all 5 for admin "coming soon" UIs, `getGateway(key)` only resolves enabled ones (throws on unknown). No silent placeholder-throw-at-runtime.

---

### H2. `globalThis` Mongoose cache survives HMR but also leaks between test runs

**Where:** [db/mongoose.ts:17-24](src/server/db/mongoose.ts#L17-L24)

**What's wrong:** Cache is shared across all test files unless a teardown explicitly disconnects (your `disconnectMongo()` is exported but only used in some test setups). Production-side: `maxPoolSize: 10` × N instances × M routes hitting Atlas can exhaust the connection pool. Atlas free tier caps at 500 connections.

**Exact fix:**

1. In tests, explicitly disconnect in `globalTeardown`.
2. Lower `maxPoolSize` to 5 on $5 tier (you'll never need 10 concurrent queries per process); on production reads use `lean()` + `select()` aggressively (already done in most reads — good).
3. Add `socketTimeoutMS: 45_000` to detect stuck connections.
4. Production: monitor connection count on Atlas; alert at 70% of pool ceiling.

---

### H3. Email render + send is inline in webhook handler — risks Stripe 10s timeout

**Where:** [webhook.service.ts:301](src/server/services/webhook.service.ts#L301) → [email.service.tsx:127-223](src/server/services/email.service.tsx#L127-L223)

**What's wrong:** The webhook calls `sendConfirmationOnce` → `sendPaymentConfirmationEmail` → `getBranding()` + `getActiveTemplateContent()` (2 Mongo reads) + `inlinePublicImage()` (disk read) + `render(<...>)` (React renderer ~50ms) + `sendMail()` (SMTP RTT 200ms-2s) + audit + evidence (more Mongo writes). Worst case ~3-5s on a healthy day. Under load on $5 tier (cold connection pool, contended CPU) easily 10s+. Stripe **drops webhook responses after 10s and treats them as failures**.

**Exact fix:**

1. Webhook commits DB state, returns 200, enqueues email in outbox. Worker drains.
2. Until the outbox exists: render template synchronously is unavoidable, but at minimum:
   - Cache branding for 30s in-process (admin edits don't need instant propagation)
   - Cache `getActiveTemplateContent` per template-key for 60s
   - SMTP pool is already correct (`pool: true, maxConnections: 3` — [smtp.ts:38](src/server/email/smtp.ts#L38))

---

### H4. `evidence.payload` stores full rendered HTML (~50-150 KB per email event)

**Where:** [email.service.tsx:194-221](src/server/services/email.service.tsx#L194-L221), [email.service.tsx:501-549](src/server/services/email.service.tsx#L501-L549)

**What's wrong:** Each `PAYMENT_REQUEST_EMAIL_SENT` and `CONFIRMATION_EMAIL_SENT` event embeds the full HTML + text bodies in the evidence payload. Combined with branding logo data-URIs that are inlined into the HTML, a single email evidence event is 50–200 KB. After 3 re-sends + 1 confirmation = ~500 KB per order in evidence alone. At 10k orders that's **5 GB of evidence**. MongoDB Atlas free tier is 512 MB.

**Why it's a problem:** You'll exhaust free tier at ~1000 orders. You'll exhaust the cheapest paid tier (M2, 2GB) at ~4000 orders. Document working-set inflation hits query performance well before the disk fills.

**Exact fix:**

1. Move rendered HTML/text to blob storage (S3-compatible — DO Spaces is the natural fit at $5/mo for 250 GB). Evidence event stores a content-hash + a URL.
2. Verifying integrity stays in-database (hash is enough; the body is recoverable for dispute but not loaded on every read).
3. Hash is computed BEFORE upload so verifyChain still works on the on-disk representation only — the canonical JSON includes the hash, not the body. (You'd want a slight refactor: payload includes `htmlBodySha256` and `htmlBodyRef`, both inside canonical JSON.)

**Bonus:** The HTML embeds the consent URL (which is a credential). DB dumps leak tokens. Strip the consent URL from stored HTML, or store the HTML with the consent URL masked (`<...redacted...>`).

---

### H5. `captureEvidenceSafe` swallows errors → silent gaps in chain

**Where:** [evidence.service.ts:170-206](src/server/services/evidence.service.ts#L170-L206)

**What's wrong:** Designed not to block the operational path (correct goal). But:
- A single failure leaves a **sequence gap**. `verifyChain` will report `sequence_gap` invalid for ALL future events too — the chain is permanently broken.
- The only signal is `EVIDENCE_RECORD_FAILED` audit row. No alarm, no metric, no DLQ.
- After 12 retries on append collision ([evidence.service.ts:43](src/server/services/evidence.service.ts#L43)) it throws, which `captureEvidenceSafe` then swallows.

**Exact fix:**

1. Wrap the operational primary write + evidence write in a transaction (see C1). If evidence fails, the primary write rolls back.
2. If you can't transact (e.g. cross-service): write evidence to an outbox first, primary write commits, async worker drains outbox to OrderEvidence. Worker retries until success or surfaces an alert.
3. The 12-retry exponential should have jitter; current code retries instantly in a tight loop ([evidence.service.ts:150-158](src/server/services/evidence.service.ts#L150-L158)).
4. Add a `chainIntegrityCheck` cron that runs `verifyChainFromDocs` on a sample of orders nightly and alerts on broken chains.

---

### H6. `disputeUpdated` recurses into `disputeCreated`; `disputeClosed` strips a processed event id

**Where:** [webhook.service.ts:899-1055](src/server/services/webhook.service.ts#L899-L1055)

**What's wrong:** Two ordering bugs:

- `handleDisputeUpdated` if dispute doc missing → re-enters `handleDisputeCreated`. That call pushes `event.eventId` onto the new doc. The outer update handler then thinks it has already processed this event id and returns `duplicate: true` instead of applying the update fields ([webhook.service.ts:902-905](src/server/services/webhook.service.ts#L902-L905)). The update fields are *lost*.
- `handleDisputeClosed` calls `handleDisputeCreated` if missing, then **manually strips** the event id back off the array so the subsequent close logic doesn't see itself as a duplicate ([webhook.service.ts:973-991](src/server/services/webhook.service.ts#L973-L991)). The strip-and-save is not atomic with the create — a crash between them leaves the close eventId stranded on a "created" record.

**Exact fix:**

1. Separate the "fetch-or-materialize dispute" helper from the "apply update/close" logic. Materializer creates the dispute row without applying *this* event — it sets baseline fields from the event's dispute payload but doesn't push the eventId. Then the close/update handler does its work + pushes its eventId in one atomic update.
2. Test out-of-order Stripe deliveries: created, updated, closed in every permutation. Fixture replay against `processGatewayEvent` should converge to the same final dispute state regardless of order.

---

### H7. Cookie `secure: false` by default; SameSite=lax

**Where:** [cookies.ts:21](src/server/auth/cookies.ts#L21)

**What's wrong:** `secure: COOKIE_SECURE || NODE_ENV === "production"`. If a staging env runs with `NODE_ENV=development` and `COOKIE_SECURE` unset, the session cookie is transmitted over HTTP. Combined with no HSTS header (the next.config.ts headers don't set one), MITM can steal the token.

**Exact fix:**

1. Default `secure: true`, hard error if `APP_URL` doesn't begin with `https://` and `NODE_ENV !== "test"`.
2. Add HSTS in next.config.ts headers: `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
3. Set `sameSite: "strict"` (per C4).

---

### H8. No request-body size cap

**Where:** [next.config.ts:13-17](next.config.ts#L13-L17) sets `bodySizeLimit: "1mb"` but only for `serverActions`. Route handlers have no cap.

**What's wrong:** `/api/drafts` accepts arbitrary JSON `data: Record<string, unknown>` ([order-draft.service.ts:100-118](src/server/services/order-draft.service.ts#L100-L118)) with no max-size validation. A single client can stuff 100 MB of garbage and crash the Node process during JSON.parse.

**Exact fix:**

1. Centralize body parsing in `withApi`. Read `req.text()` first, enforce a per-route byte cap, then JSON.parse.
2. For drafts specifically, cap at 64 KB. For most other endpoints 16 KB.

---

### H9. No rate-limit on evidence search → `$or` of 8+ regex scans

**Where:** [evidence.service.ts:441-504](src/server/services/evidence.service.ts#L441-L504)

**What's wrong:** Each search builds an `$or` of up to 8 equality conditions. For non-existent values, Mongo scans every sparse index in `$or`. At 100k evidence docs, a search with no matches is multiple full-collection scans.

**Exact fix:**

1. The schema indexes are sparse on each ref field individually. Use them: if `field === "auto"`, do up to 8 *parallel* indexed lookups and union the results in app code (or a single `$or` but with `hint()` to force index intersection).
2. Cap search query length and reject obvious garbage (control chars, length > 200).
3. Rate-limit to 5 searches / minute / user.

---

### H10. `Order.findById` then external API call then conditional update — Stripe call cost on every collision

**Where:** [order.service.ts:466-563](src/server/services/order.service.ts#L466-L563)

**What's wrong:** Two concurrent initiate calls both pass the in-memory guard (lines 467–482), both make the Stripe `checkout.sessions.create` API call (slow, paid round-trip), then the conditional update lets only one through. The loser then calls `gateway.expireSession` on the orphan ([order.service.ts:570](src/server/services/order.service.ts#L570)). You paid for two Stripe API calls.

**Exact fix:**

1. Optimistic lock first: `findOneAndUpdate({ _id, status: NOT_INITIATED }, { $set: { status: LINK_GENERATING }})`. The loser gets null and aborts BEFORE calling Stripe.
2. After Stripe returns, flip to LINK_GENERATED with the full session details.
3. Add a `LINK_GENERATING` to the OrderStatus enum (transient state, cleared by either success or a reaper cron after 30s timeout).

---

### H11. Realtime: `router.refresh()` debounced 350ms per event → CPU spikes under bursts

**Where:** [realtime-provider.tsx:121-132](src/components/providers/realtime-provider.tsx#L121-L132)

**What's wrong:** Every domain event triggers a server-side render of every route currently visible. RSC re-fetches data from Mongo. A burst of 10 paid orders in 30s = ~10 full RSC re-renders per connected agent. On $5 tier with 5 agents online, that's 50 RSC executions in 30s — CPU sustained.

**Exact fix:**

1. The React Query invalidation in the same handler is already doing the data refresh client-side. `router.refresh()` is mostly redundant for cached routes.
2. Drop `router.refresh()` entirely on the realtime path; rely on React Query as the single source of truth.
3. If RSC re-renders are needed for routes that don't use React Query (e.g. server-rendered dashboards), batch-debounce more aggressively (3-5s), and use `revalidateTag` on the specific resource rather than full route refresh.

---

### H12. SSE: `setInterval` heartbeat + listener-per-client → memory walks linearly

**Where:** [api/events/route.ts:32-77](src/app/api/events/route.ts#L32-L77)

**What's wrong:** Each connected SSE client adds:
- One `EventEmitter` listener on the global bus
- One `setInterval(25_000)` timer
- One open Response stream

`setMaxListeners(0)` removes the warning but the listener count grows. There's no per-user connection cap. On $5 tier, ~200 concurrent SSE = exhausted memory.

**Exact fix:**

1. Cap connections per `user.id` to 3.
2. Track total active connections; refuse 503 above 100 (or whatever the instance can hold).
3. Drop the 25s heartbeat in favor of a *single* server-wide heartbeat tick that fanouts to all active clients. (Avoid N timers.)
4. Long-term: move SSE state to a Redis stream + a dedicated SSE-relay process.

---

### H13. `force-dynamic` on every page → no static optimization

**Where:** Grep shows 22+ files with `export const dynamic = "force-dynamic"`.

**What's wrong:** Defeats Next 16's RSC caching. Every page render is a fresh Mongo read + render. On $5 tier this is the dominant cost.

**Exact fix:**

1. Public-customer pages (`/pay/success`, `/consent/[token]`) should be `dynamic = "force-dynamic"` (correct — data is per-request).
2. Admin/staff dashboards should use Next's `revalidate` + `revalidateTag` from mutating routes. Dashboard, orders list, admin pages can revalidate on-demand from the corresponding service mutation.
3. The realtime layer's `router.refresh()` becomes effective once cache is in play.

---

### H14. `Order.listOrders` regex queries are unindexed full scans

**Where:** [order.service.ts:813-829](src/server/services/order.service.ts#L813-L829)

**What's wrong:** Search across `orderNumber`, `customer.{name,email,phone}`, `vehicle.{company,type}` uses `{ $regex: q, $options: "i" }`. Case-insensitive regex *cannot* use any index (Mongo's regex index optimization requires an anchored, case-sensitive prefix). At >10k orders this is a full collection scan per search.

**Exact fix:**

1. Add a `searchTokens: [String]` field on Order: normalized lowercased tokens from name/email/phone/orderNumber. Multikey index.
2. Search becomes `{ searchTokens: { $regex: '^' + escapedQ, $options: "" } }` or use `$text` index across the existing fields.
3. Or build a real search service: when you outgrow $5 tier, point this at Meilisearch / Typesense (each ~$5/mo).

---

### H15. Webhook signature verification happens AFTER body buffering — DoS surface

**Where:** [api/webhooks/stripe/route.ts:41](src/app/api/webhooks/stripe/route.ts#L41)

**What's wrong:** `await req.text()` reads the entire body before any auth check. An attacker can flood the endpoint with megabyte bodies — even invalid signatures consume memory and CPU.

**Exact fix:**

1. Cap body length: read in chunks, error at 64 KB (Stripe events are typically <20 KB).
2. Move this to the proxy (Next 16 `proxy.ts`) — reject any `/api/webhooks/stripe` request without `stripe-signature` header before reading the body.

---

## 3. Medium priority (P2) — scaling / maintainability

### M1. Stripe-specific behavior in "gateway agnostic" places

Plenty already covered in H1. Additional smells:

- `mapStripeDisputeStatus` returns `UNDER_REVIEW` for unknown statuses ([gateways/stripe.ts:91](src/server/payments/gateways/stripe.ts#L91)). Silent degradation. Should be a dev-time hard error / prod-time loud alert + retain as "unknown" status enum value rather than synthesize one.
- `mapStripeDisputeOutcome` returns null for any non-terminal status — fine, but the type system would benefit from a discriminated union (`{ kind: "open" } | { kind: "closed", outcome: DisputeOutcome }`).
- `chargeId` is stored as a string but never indexed; if you ever need to look up a dispute by charge id it's a full scan.

### M2. `OrderStatus` default in schema is `PAYMENT_PENDING`

**Where:** [order.model.ts:352](src/server/db/models/order.model.ts#L352)

**What's wrong:** Order lifecycle now starts at `NOT_INITIATED` ([order.service.ts:271](src/server/services/order.service.ts#L271)). The schema default contradicts. If a future writer omits the field, you silently leak into PAYMENT_PENDING.

**Fix:** Change default to `NOT_INITIATED`. Same for `payment.status`.

### M3. `orderToDTO` is duplicated in [order.service.ts:96-225](src/server/services/order.service.ts#L96-L225) and [webhook.service.ts:370-497](src/server/services/webhook.service.ts#L370-L497)

The two are subtly different (consent enum fallback, dispute pointer shape). Bug surface. Extract to a single `src/server/db/models/order.dto.ts` module imported by both.

### M4. No idempotency keys on admin PATCH/POST endpoints

`/api/admin/settings`, `/api/admin/branding`, `/api/admin/users` — client retry on a 502 applies the change twice. Drafts have revision-based optimistic concurrency ([order-draft.service.ts:130-163](src/server/services/order-draft.service.ts#L130-L163)) — port that pattern to every mutation endpoint.

### M5. Settings + branding fetched per-request, no cache

Every email send, every initiate-payment, every consent build reads `Settings` and `Branding` collections. Cache in-process with a 30-60s TTL. Admin edits already broadcast events — invalidate the cache on those events.

### M6. `inlinePublicImage` cache never evicts

[inline-image.ts:35-36](src/server/email/inline-image.ts#L35-L36) — `Map` of all data URIs persists for process lifetime. A workspace with many providers + many dev rebuilds keeps the data URI for every variant of every logo ever rendered.

**Fix:** LRU with max ~50 entries; or invalidate on branding update.

### M7. Activity feed has no replay on reconnect

[realtime-provider.tsx](src/components/providers/realtime-provider.tsx) — EventSource reconnects automatically (browsers handle this), but events emitted during the disconnect window are lost. Pair with the event journal recommendation in C10.

### M8. `stripeGateway.getSessionStatus` mapping has 4 outcomes but the SessionStatus type allows 4 — easy to silently miss one. Use a discriminated mapping helper.

### M9. `force-dynamic` removes static perf, but most pages also lack proper data preloading. Move to RSC `cache()` boundaries and per-route `revalidate`.

### M10. `console.log` in [logger.ts:53-58](src/lib/logger.ts#L53-L58)

You're logging to stdout — fine for DO App Platform stdout capture. But:
- No log levels filter in production (debug is gated; info/warn/error aren't)
- No sampling; busy webhook traffic floods logs
- Multi-line stack traces broken across multiple log entries (`console.error(JSON.stringify(payload))` is single-line; the actual Error stack isn't serialized — `err: err.message` only)

**Fix:**
1. Serialize the full stack for errors: `err: { message, name, stack }`.
2. Make level configurable via env (LOG_LEVEL=info|warn|error).
3. Add a `requestId` to every log line via `AsyncLocalStorage` so traces are correlatable. Today the audit log captures `requestId` from `x-request-id`, but nothing in the platform *generates* that header — always null in practice (Confirmed: no header-generation found in `src/`).

### M11. No DOMPurify / explicit sanitization on email overrides

[email.service.tsx:368-370](src/server/services/email.service.tsx#L368-L370) — `greeting / intro / note` go into HTML rendered by `@react-email/components`. React-email's `Text`/`Heading` components do escape, but if any custom block ever uses `dangerouslySetInnerHTML` or raw `<Html>` insertion, that's stored XSS on the customer's mail client.

Audit each email template's render path; add a unit test that injects `<script>` and asserts it's escaped in both HTML output and text output.

### M12. Server-only setStripeForTesting / _clearInlineImageCache

[payments/stripe.ts:51](src/server/payments/stripe.ts#L51) and [inline-image.ts:111](src/server/email/inline-image.ts#L111) — both are exported but only used in tests. They're `server-only` so the client bundle is safe, but they sit in production server bundles and could be misused. Move test-only exports into a `__tests__` re-export module that the prod path never imports.

### M13. `eslint.config.mjs` is minimal — verify no `// eslint-disable-next-line` graveyard

Run `grep -rn "eslint-disable" src/ | wc -l` — clean up disables. (Quick scan suggests few but worth a pass.)

### M14. Mongoose schema uses `Schema.Types.Mixed` for `payload` / `metadata` / `data`

Mongoose can't optimize Mixed. Acceptable for evidence (payload is genuinely heterogeneous) but bad for audit metadata (mostly `{ orderId, orderNumber, eventId, … }`). Either type it tightly or accept that you can't index inside.

### M15. `Order.deleteMany` for paid orders is blocked at app level only

Mongo-level no constraint; a misbehaving migration can wipe paid orders. Add a Mongo-side validator: `paid` orders cannot be deleted. (Mongoose schema validators run on save, not delete — needs DB-level rule or wrap deletes in a service that asserts status.)

### M16. CSP header missing

next.config.ts headers ([next.config.ts:21-37](next.config.ts#L21-L37)) include X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Missing: `Content-Security-Policy`. Add a strict CSP for app routes; relaxed CSP for `/pay/*` and `/consent/*` (where Stripe / branding load assets).

### M17. `scripts/seed.ts` and `seed:prod` are too easy to mis-fire

`seed:prod` runs `tsx scripts/seed.ts` against whatever env is loaded. Recommend: require an explicit `--confirm=yes-wipe-prod` arg and a runtime env check (`PAYOPS_ENV=production` blocks unless flag passed).

### M18. `testcards.txt` checked in at repo root, empty

Cosmetic. Either fill or delete.

### M19. Provider snapshot pulled in [order.service.ts:265](src/server/services/order.service.ts#L265) but provider catalog mutates over time

The snapshot is frozen at creation — good for receipts. But `regeneratePaymentLink` ([order.service.ts:974](src/server/services/order.service.ts#L974)) re-uses the *snapshot* and bypasses the live catalog. Intentional and correct. Make sure new code paths don't accidentally re-resolve the provider.

### M20. `routePagination` everywhere is page+pageSize, no cursor

Acceptable today; will hurt at >100k orders. Use a `{ before, after }` cursor on `_id` for the orders list. Stable + efficient on a single composite index.

---

## 4. Low priority (P3) — code quality / polish

- **L1.** [order.service.ts:686-750](src/server/services/order.service.ts#L686-L750) `buildCheckoutSession` is dead code (only used by `regeneratePaymentLink`, which we'd delete in H1). Drop both.
- **L2.** Magic numbers: `MAX_APPEND_RETRIES = 12` ([evidence.service.ts:43](src/server/services/evidence.service.ts#L43)), `bodySizeLimit: "1mb"`, `paymentExpiryHours` default. Centralize in a `constants/limits.ts`.
- **L3.** `console.error(line)` vs `logger.error` — `console.error` is used elsewhere in components. Pick one logger.
- **L4.** No `package.json` script for `db:migrate` — current "migrations" are ad-hoc scripts in `scripts/`. Adopt a proper migration runner (umzug, migrate-mongo).
- **L5.** Stripe `appInfo: { name: "PayOps", version: "1.0.0" }` ([stripe.ts:42](src/server/payments/stripe.ts#L42)) is hardcoded. Pipe from package.json version.
- **L6.** `setStripeForTesting` and `setMaxListeners(0)` are loud test scaffolds in prod files — gate with `process.env.NODE_ENV === "test"`.
- **L7.** [order.model.ts:417-423](src/server/db/models/order.model.ts#L417-L423) pre-validate hook throws plain Error — wrap with proper Mongoose ValidationError so it surfaces cleanly to the API layer.
- **L8.** `provider.id` validated by `PROVIDER_KEY_REGEX` but `payment.gateway` validated only by enum. Use consistent validation depth.
- **L9.** `OrderEvidence` index list is large (8 sparse indexes). Each insert pays for all of them. At a single-event hot-path frequency it's fine; at dispute storm volume it's an unnecessary tax. Audit which refs are actually queried in production.
- **L10.** `realtime-provider.tsx` does `ORDER_LIFECYCLE_EVENT_TYPES.has(event.type)` but the `Set` is constructed inline elsewhere; verify it's exported and re-imported without runtime alloc.
- **L11.** `package.json` has no `engines.node` constraint. DO App Platform might run an older Node than expected.
- **L12.** `typescript: { ignoreBuildErrors: true }` in [next.config.ts:9](next.config.ts#L9) — the comment justifies it (10GB heap), but it means broken types ship to prod if CI typecheck doesn't gate deploys. Confirm `npm run typecheck` is a deploy precondition.

---

## 5. SOLID violations (per the request)

### Single Responsibility

- **`webhook.service.ts`** (1209 lines) is the biggest single-file violation. It owns: event normalization (via gateway abstraction), order-state transitions, audit writes, evidence writes, email orchestration, event publishing, and dispute/refund lifecycle. Split into:
  - `webhook.orchestrator.ts` — switch + idempotency
  - `payments.transitions.ts` — `applyCheckoutPaid`, `failOrder`, `expireOrder`
  - `disputes.service.ts` — all dispute_* handlers
  - `refunds.service.ts` — refund_* handlers
- **`order.service.ts`** (1459 lines) — owns create, list, fetch, archive, delete, initiate, regenerate, reconcile, risk-flag, customer-patch, at-risk-listing. Splitting `risk` and `reconcile` to their own modules is the cheapest win.

### Open/Closed

- **`PaymentGateway`** interface is clean ([gateway.ts:165-187](src/server/payments/gateway.ts#L165-L187)) — good O/C. But `applyCheckoutPaid` writes `payment.gateway ?? "STRIPE"` ([webhook.service.ts:778](src/server/services/webhook.service.ts#L778)) — closed over Stripe as the implicit default. Should be `getDefaultGateway().key`.
- The `PaymentEventType` union ([gateway.ts:72-82](src/server/payments/gateway.ts#L72-L82)) is hardcoded. Adding a gateway with a unique event (PayPal IPN, e.g.) requires editing this central type. Each gateway should declare its own event mappings.

### Liskov

- The four placeholder gateways throw on every method ([gateways/index.ts:28-55](src/server/payments/gateways/index.ts#L28-L55)) — that's an LSP violation: callers can't substitute one gateway for another safely. The `gateway.enabled` flag mitigates but doesn't enforce.
- **Fix:** never return a placeholder from `getGateway`. Have `listGateways` return a separate `GatewayMeta` shape for admin UI display; `getGateway` throws or returns null for un-implemented.

### Interface Segregation

- The `PaymentGateway` interface mixes hot-path (createSession, verifyWebhook) with admin-path (sandbox, label). Acceptable; small interface. But `getSessionStatus` is only used by reconcile — could be on a separate `Reconcilable` sub-interface so gateways without status APIs don't need to stub.

### Dependency Inversion

- **`order.service.ts` imports `webhook.service.applyCheckoutPaid`** ([order.service.ts:56](src/server/services/order.service.ts#L56)). Reconcile depends on webhook implementation. Both should depend on a `paymentTransitions` module.
- **`order.service.ts` imports `getStripe`** ([order.service.ts:41](src/server/services/order.service.ts#L41)) and uses it in `regeneratePaymentLink`. Bypasses the abstraction it was supposed to use.
- **`webhook.service.ts` imports `email.service.sendPaymentConfirmationEmail`** ([webhook.service.ts:32](src/server/services/webhook.service.ts#L32)). Webhook flow knows about SMTP. Should publish an `ORDER_PAID` event that an `EmailNotifier` consumer drains.

### Naming / Boundaries

- "Webhook service" handles reconcile transitions (via `applyCheckoutPaid` being called from order.service.reconcileOrderPayment). Names lie. Rename to `payment-lifecycle.service.ts`.
- "Order service" owns risk + customer + analytics-like reads. Becoming a god service.

---

## 6. Atomicity / transaction-safety summary table

| Flow | Multi-write count | Currently atomic? | Risk |
|---|---|---|---|
| `createOrder` | Order + AuditLog + OrderEvidence + Event publish | No | Order without genesis evidence |
| `initiatePayment` | Order + AuditLog + 2× OrderEvidence + Event publish + Stripe API | No | Stripe session orphaned if DB write fails after |
| `applyCheckoutPaid` (webhook) | Order + AuditLog + OrderEvidence + email-claim + email-send + Event publish | No | Paid order without confirmation email; broken chain |
| `sendPaymentRequestEmail` | PaymentConsent + Order pointer + AuditLog + OrderEvidence + SMTP send + Event publish | No | Email sent but consent record missing |
| `recordConsentFromToken` | PaymentConsent + Order pointer + AuditLog + OrderEvidence + Event publish | No | Consent claimed but order pointer stale |
| `regeneratePaymentLink` | Stripe API + Order + AuditLog + OrderEvidence + Event publish | No | Stripe session abandoned if write fails |
| `handleDisputeCreated` | Dispute + Order pointer + AuditLog + OrderEvidence + Event publish | No | Dispute record without order pointer (or vice-versa) |
| `handleRefundCreated` | Order + AuditLog + OrderEvidence + Event publish | No | Refund amount updated without evidence trace |

**Fix priority:** `applyCheckoutPaid`, `createOrder`, `recordConsentFromToken` first — these are the dispute-critical paths.

---

## 7. Security audit summary

| Vector | Status | Reference |
|---|---|---|
| Webhook signature verification | ✅ Implemented via Stripe SDK | [gateways/stripe.ts:217-225](src/server/payments/gateways/stripe.ts#L217-L225) |
| Webhook replay protection | ✅ via `processedWebhookEventIds` (with caveats — see C7) | [order.model.ts:242](src/server/db/models/order.model.ts#L242) |
| JWT signed, algorithm pinned | ✅ HS256 enforced | [jwt.ts:71](src/server/auth/jwt.ts#L71) |
| Cookie httpOnly | ✅ | [cookies.ts:18](src/server/auth/cookies.ts#L18) |
| Cookie secure | ⚠️ Conditional, defaults false | [cookies.ts:21](src/server/auth/cookies.ts#L21) |
| Cookie sameSite | ⚠️ `lax` — CSRF surface (C4) | [cookies.ts:19](src/server/auth/cookies.ts#L19) |
| CSRF protection | ❌ NONE | — |
| Rate limiting | ❌ NONE | — |
| Body size cap | ❌ Only on server actions | [next.config.ts:13](next.config.ts#L13) |
| Brute-force login protection | ❌ Audit-logged only, no lockout | [auth.service.ts](src/server/services/auth.service.ts) |
| Permission RBAC | ✅ Centralized registry | [permissions.ts](src/lib/constants/permissions.ts) |
| Path traversal (inline-image) | ✅ Normalized + bounded | [inline-image.ts:83-86](src/server/email/inline-image.ts#L83-L86) |
| Consent token tampering | ✅ HMAC, constant-time compare | [consent-token.ts:51-55](src/server/services/consent-token.ts#L51-L55) |
| Mass assignment | ✅ Service layer patches explicit fields | [order.service.ts:1226-1240](src/server/services/order.service.ts#L1226-L1240) |
| Stored XSS in email overrides | ⚠️ Depends on react-email escaping (M11) | — |
| SSRF in inline-image | ✅ Refuses remote http | [inline-image.ts:67-70](src/server/email/inline-image.ts#L67-L70) |
| Sensitive logs redaction | ✅ Centralized in logger | [logger.ts:9-21](src/lib/logger.ts#L9-L21) |
| Secrets in env | ✅ Zod-validated | [env.ts:17-31](src/lib/env.ts#L17-L31) |
| HSTS / CSP headers | ❌ Missing | [next.config.ts:21-37](next.config.ts#L21-L37) |
| Public endpoint enumeration | ❌ `pay/success` accepts orderNumber (C3) | [pay/success/page.tsx:27](src/app/pay/success/page.tsx#L27) |
| Admin route gate | ✅ in proxy.ts + service layer | [proxy.ts:83-94](src/proxy.ts#L83-L94) |

---

## 8. Performance audit for DO App Platform $5 tier

Assume: 512 MB RAM, ~1 vCPU (shared), single instance, no horizontal scale.

| Hotspot | Cost | Verdict |
|---|---|---|
| Mongoose connect (cold) | ~200ms first request | Fine if cached on globalThis (it is) |
| Order list query | ~50-200ms at 10k orders | OK; degrades to seconds at 100k without proper index for regex (H14) |
| Webhook end-to-end | 300ms - 5s (depends on email + Mongo + Stripe) | **DANGER** — over 10s Stripe times out (H3) |
| Email render + send | 200-500ms | OK but inline-blocks webhook |
| SSE per-client overhead | 1 listener + 1 timer + 1 stream | OK at ~50 clients; OOM at ~500 |
| PDF render | 200-500 MB heap peak | **OOM RISK** — single export kills instance (C9) |
| Settings/Branding fetch | ~20ms × per-render | Fine; cache for 5x improvement |
| Reconcile call (Stripe API) | 200ms-2s | Public surface (C3) |
| `router.refresh()` on SSE event | full RSC re-render | Wasteful under burst (H11) |
| Evidence chain append | 1 read + 1 write per event; retry on race | OK; verify path is linear with chain length |
| Audit log write | 1 insert | Fire-and-forget; never on hot path — good |

**Headline:** PDF + SSE + webhook-inline-email are the three biggest infra-fit risks. Two are P0 (C9, C2), one is P1 (H3).

---

## 9. Multi-gateway readiness assessment

The codebase claims to support: Stripe, Razorpay, Authorize.net, PayPal, Manual.
**Reality:** Only Stripe works. The other four throw at runtime ([gateways/index.ts:28-55](src/server/payments/gateways/index.ts#L28-L55)).

What would it take to add **Razorpay** today?

1. Implement [`./gateways/razorpay.ts`](src/server/payments/gateways/razorpay.ts) (~400 lines, mirror Stripe adapter)
2. **Rename DB field** `payment.stripeSessionId` → `payment.gatewaySessionId` (migration; updates ~10 files)
3. Delete `regeneratePaymentLink`'s direct Stripe usage ([order.service.ts:947-1019](src/server/services/order.service.ts#L947-L1019)); route through gateway abstraction
4. **Replace `getStripe()` import in order.service.ts** with generic gateway calls
5. Add webhook route `/api/webhooks/razorpay/route.ts` calling `getGateway("RAZORPAY")`
6. **Map Razorpay events** to PayOps' normalized `PaymentEventType` enum — note that Razorpay's lifecycle differs (payment-link not session-based) so `getSessionStatus` may need a different lookup primitive
7. Decide what `paymentIntentId` means for non-Stripe gateways; currently every read assumes it exists
8. Update DTO mapping to use the renamed field

Estimated work: **3-5 days** with the above blocker items. With them, more like 1-2 days.

---

## 10. Scalability projection

| Scale | First bottleneck |
|---|---|
| 10 users / 100 orders | None |
| 100 users / 1k orders | SSE memory growth (H12); list-search regex (H14) |
| 1k users / 10k orders | PDF export OOM (C9); evidence HTML storage (H4); search regex |
| 10k users / 100k orders | Mongo doc count vs Atlas free tier; transaction overhead without sharding; multi-instance breaks SSE (C10) |
| 100k orders | Audit log growth; need archival; payment.processedWebhookEventIds unbounded (C7) |

The platform plateaus at low-thousands of orders without infrastructure changes.

---

## 11. Recommended order of work

Each item is sized for one engineer. P0 items must land before any merchant goes live. P1 items must land before scaling past pilot. P2 items are scaling/maintainability. P3 are quality.

### P0 (must — pre-prod)

1. **C1**: Wrap multi-write flows in `withTransaction`. Start with `applyCheckoutPaid`, `createOrder`, `recordConsentFromToken`. *(2-3 days)*
2. **C4 + H7**: SameSite=strict, CSRF + Origin check in `withApi`, secure=true default, HSTS header. *(0.5 day)*
3. **C5**: Add in-process rate-limiter; apply to login, consent POST, reconcile, evidence search. *(1 day)*
4. **C3**: Lock `pay/success` to session-id-based auth, throttle reconcile. *(0.5 day)*
5. **C2 + H3**: Move email send + event publish AFTER webhook 200 ack via outbox table + cron-driven retry. *(1-2 days)*
6. **C9**: Gate PDF export behind a per-user lock + body cap. *(0.5 day immediate; full worker move = 2 days later)*
7. **C7**: Move `processedWebhookEventIds` to sibling collection with TTL. *(1 day + migration)*
8. **C8**: Make reconcile + webhook share dedupe key; harmonize event ids. *(0.5 day)*
9. **C10**: Add event journal + `Last-Event-ID` replay on SSE. *(1 day; Redis swap deferred to P1)*

**P0 total: ~9-12 dev-days.**

### P1 (next phase — pilot to GA)

10. **H1**: Rename `stripeSessionId` schema field, delete `buildCheckoutSession`, route everything through `PaymentGateway`. *(2 days incl. migration)*
11. **H4**: Move evidence HTML to blob storage. *(2-3 days)*
12. **H5**: Outbox-based evidence write so failures don't break the chain. *(1-2 days)*
13. **H6**: Fix dispute create/update/close ordering. *(0.5 day)*
14. **H8**: Body size cap in `withApi`. *(0.5 day)*
15. **H9**: Constrain evidence search to a single indexed field per query. *(0.5 day)*
16. **H10**: Reserve LINK_GENERATING state to avoid double-Stripe-call. *(0.5 day)*
17. **H11**: Drop `router.refresh()` on realtime path. *(0.5 day)*
18. **H12**: Cap SSE connections per user; single shared heartbeat tick. *(0.5 day)*
19. **H13**: Replace `force-dynamic` with `revalidateTag`-driven cache. *(1-2 days)*
20. **H14**: Add normalized `searchTokens` field on Order. *(1 day + backfill)*
21. **H15**: Body cap on webhook before reading. *(0.5 day)*
22. **C6**: JWT `kid` + dual-secret support. *(0.5 day)*

**P1 total: ~12-15 dev-days.**

### P2 (scaling / maintainability)

M1–M20. ~5-10 dev-days cumulative; pick the M-items that map to incidents you actually see.

### P3 (polish)

L1–L12. ~2-3 dev-days; do alongside other work.

### Multi-instance / multi-gateway prep (deferred until traffic justifies)

- Redis pub/sub for event bus
- Event journal in Redis Streams or a dedicated collection
- Worker process for PDF + email render
- Background queue (BullMQ on Redis)
- MongoDB Atlas replica-set + sharding setup for transactions at scale
- One real second gateway (Razorpay) to validate the abstraction
- APM / tracing (OpenTelemetry → Honeycomb / Grafana Cloud free tier)

---

## 12. What's actually well-done

Brutal does not mean blind. Acknowledgments:

- **Evidence chain hash design** ([crypto/hash-chain.ts](src/lib/crypto/hash-chain.ts) + [crypto/canonical.ts](src/lib/crypto/canonical.ts)): deterministic JSON, snapshot-then-chain, append-only schema hooks. This is the strongest piece of the codebase.
- **Idempotency on Stripe checkout creation** ([gateways/stripe.ts:180](src/server/payments/gateways/stripe.ts#L180)): stable idempotency key per order — text-book correct.
- **Conditional update guards** throughout: `findOneAndUpdate({ _id, status: { $ne: PAID }, processedWebhookEventIds: { $ne: eventId }})` — correct usage of Mongo atomicity primitives.
- **RBAC permission registry** ([permissions.ts](src/lib/constants/permissions.ts)): single source of truth, role inheritance, easy to audit.
- **Consent token HMAC** with constant-time compare ([consent-token.ts:51-55](src/server/services/consent-token.ts#L51-L55)).
- **Path-traversal guard** in image inliner ([inline-image.ts:83-86](src/server/email/inline-image.ts#L83-L86)).
- **Zod env validation** with helpful error formatting ([env.ts:72-76](src/lib/env.ts#L72-L76)).
- **Logger redaction** ([logger.ts:9-21](src/lib/logger.ts#L9-L21)).
- **Per-instance Mongoose connection cache** via globalThis ([mongoose.ts:17-24](src/server/db/mongoose.ts#L17-L24)).
- **SSE auth + filter pure function** ([events/bus.ts:85-100](src/server/events/bus.ts#L85-L100)) — easy to unit-test.
- **Reconcile-fallback pattern** for dropped webhooks ([order.service.ts:1316-1442](src/server/services/order.service.ts#L1316-L1442)) — exactly the right defensive design.
- **Pre-save append-only hook** on OrderEvidence ([order-evidence.model.ts:188-214](src/server/db/models/order-evidence.model.ts#L188-L214)).

The bones are right. The flesh needs the items above.

---

## 13. Closing

If you have engineering capacity for 10 days, do all of P0 + C6/H7/H10 from P1 and ship to one or two friendly merchants. If you have 4 weeks, do P0+P1 entirely and you have something defensible.

Do not ship at the current state to a real merchant on a real dispute workload. The platform's premise (audit-grade dispute defense on a $5 instance) is achievable but not achieved yet.

— end —
