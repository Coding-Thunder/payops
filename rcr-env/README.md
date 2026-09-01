# `rcr-env/`

Configuration for the **RCR Cruise** deployment.

## The architecture, stated plainly

RCR Cruise is a **second ORGANIZATION inside the existing `himanshu-payops`
database**, not a separate database and not a separate user system.

```
ONE MongoDB database:  himanshu-payops
ONE shared user pool   (users are never duplicated per brand)
  ├── Organization: Himanshu    (car rental, live, holds isDefault)
  └── Organization: RCR Cruise  (flights + cruises, non-default)
```

Users belong to organizations through the existing `OrganizationMember`
collection. Membership is the **authority** for every role, SUPER_ADMIN
included — a global role does not conjure access to a brand.

Tenant isolation is enforced per organization by the scope layer: orders,
providers, evidence, consent, audit, settings overrides, branding, email
identity and payment credentials are all resolved from the acting
organization. What is NOT isolated is the user account itself, which is the
point.

It is a **copy**, not a link. Nothing here is read unless you ask for it, and
editing a value here cannot affect any other deployment configured in this
repository.

```
rcr-cruise/
├── .env.payops.local        ← whatever this checkout runs by default
├── .env.payops.test         ← fixture values for the test suite
├── .env.payops.smoke
│
├── himanshu-env/            ← the car-rental deployment. Untouched.
│   └── …
│
└── rcr-env/
    ├── .env.payops.local    ← RCR Cruise's. Same variable names, own values.
    ├── .env.payops.prod
    ├── .env.example         ← tracked, valueless, the reviewable checklist
    └── README.md
```

## Selecting it

One variable, `PAYOPS_ENV_DIR`, chooses which directory the standard
filenames are read from. Unset — the default — resolves at the repository
root, which is exactly what every existing command already did.

```bash
PAYOPS_ENV_DIR=rcr-env npm run dev
PAYOPS_ENV_DIR=rcr-env npm run build
PAYOPS_ENV_DIR=rcr-env npm run seed:orgs
PAYOPS_ENV_DIR=rcr-env npm run seed:rcr-providers
```

`PAYOPS_ENV_FILE` still takes an explicit path and wins outright, which is how
you point a script at a production file deliberately:

```bash
PAYOPS_ENV_FILE=rcr-env/.env.payops.prod npm run indexes:audit
```

The application never switches on its own. A directory existing means nothing;
only the variable selects it.

## The deployment pin — read this first

`PAYOPS_ORG_SLUG` pins a deployment to exactly one organization, and it is
**required** now that the database holds two.

```bash
PAYOPS_ORG_SLUG=rcrcruise   # the RCR Cruise deployment
PAYOPS_ORG_SLUG=himanshu    # the car-rental deployment
```

It NARROWS, never widens: it is intersected with the signed-in user's own
memberships, so a user with no RCR membership is denied on the RCR
deployment rather than served. With the pin unset and several organizations
present the app refuses to resolve a tenant at all — safe, but the console
will not load, so set it.

## First-run order

The application refuses to serve pages with no organization seeded, and the
supplier catalog does not populate itself on a deployment that does not sell
car rental — so both seeds are required, in this order:

```bash
# 1. The bootstrap super admin — ONLY on a fresh database. Against the
#    shared himanshu-payops database the users already exist; do not re-seed.
PAYOPS_ENV_DIR=rcr-env SEED_APPLY=true npm run seed

# 2. The organization. SEED_ORGS_SERVICE_TYPES makes this brand sell flights
#    and cruises. The seed will NOT claim `isDefault` because Himanshu
#    already holds it — which is correct: the anchor sees unattributed
#    pre-migration history and RCR Cruise must never inherit it.
PAYOPS_ENV_DIR=rcr-env SEED_ORGS_APPLY=true npm run seed:orgs

#    Then give the operators who should reach RCR Cruise a membership.
#    Users are NOT duplicated — an existing Himanshu user simply gains a
#    second OrganizationMember row.

# 3. The airline and cruise-line suppliers. Without this the order forms
#    have an empty supplier dropdown and no order can be created.
PAYOPS_ENV_DIR=rcr-env SEED_RCR_PROVIDERS_APPLY=true npm run seed:rcr-providers

# 4. Indexes, which are NOT created automatically (autoIndex is off).
PAYOPS_ENV_DIR=rcr-env BUILD_INDEXES_APPLY=true npm run indexes:audit
```

Every one of those defaults to a **dry run**. The `*_APPLY=true` above is the
opt-in.

## What differs from the car-rental deployment

Every variable **name** is identical — the application is unchanged and reads
the same keys. What differs is which values are RCR Cruise's to set.

| Variable | Why it differs |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | **THE SAME** as Himanshu — `himanshu-payops`. Isolation is per organization, not per database. |
| `PAYOPS_ORG_SLUG` | Pins this deployment to the RCR Cruise organization. Required while two organizations share the database. |
| `APP_URL`, `NEXT_PUBLIC_APP_URL` | RCR Cruise's own domain. These build the consent, acknowledgement and gateway return URLs a customer clicks. |
| `ORG_RCRCRUISE_STRIPE_SECRET_KEY`, `ORG_RCRCRUISE_STRIPE_WEBHOOK_SECRET` | RCR Cruise's own merchant account, namespaced by slug. The un-namespaced `STRIPE_*` belong to the anchor and are unreachable from a non-default tenant — the resolver refuses rather than falling back. |
| `JWT_SECRET`, `CONSENT_TOKEN_SECRET` | **THE SAME** as Himanshu when the user pool is shared — a session minted on one deployment must verify on the other, because it is the same user. |
| `CREDENTIALS_MASTER_KEY` | **THE SAME** as Himanshu — one database means one credential vault. Per-organization isolation of secrets comes from the `(organization, provider)` namespacing inside the vault, not from separate keys. |
| `SMTP_*`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | RCR Cruise's mailbox, so SPF/DKIM align with the brand the customer expects. |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE` | Printed in customer emails and on the payment pages. |
| `APP_NAME`, `NEXT_PUBLIC_APP_NAME`, `CUSTOMER_BRAND_NAME` | Customer-visible. These are what make the emails and payment pages say **RCR Cruise**. |
| `SEED_ORGS_SLUG` | Namespaces the per-organization credential env vars (`ORG_<SLUG>_*`). |
| `SEED_ORGS_SERVICE_TYPES` | `FLIGHT,CRUISE`. This is the whole difference between this brand and the car-rental one, and it is enforced server-side on the create-order route. |

## Deliberately absent

**Every `ORG_HIMANSHU_*` variable.** They belong to the car-rental
deployment's PayPal account. Copying them here would point RCR Cruise's
PayPal payments at another merchant's account.

**All PayPal variables, for now.** PayPal is a supported provider that is not
enabled on this deployment yet. It must not be given empty placeholders: an
empty `ORG_..._PAYPAL_CLIENT_ID` reads as "configured but broken" rather than
"not enabled", and the failure it produces would be the wrong one. Enabling it
is a separate step that adds the three variables AND adds `PAYPAL` to the
organization's `payments.enabledProviders`.

## Secrets

`.gitignore` covers `.env*` at every level, so every file in this directory
except `.env.example` and this README is untracked. Verify before committing:

```bash
git check-ignore -v rcr-env/.env.payops.prod   # must print a match
git status --porcelain rcr-env/                # must list only tracked files
```

Production values belong in the hosting platform's secret store. A `.prod`
file here is a checklist of what must be set there, not a place to keep it.

## Webhooks — two merchant accounts, one deployment

A gateway signature can only be verified with the secret of the account that
produced it, and the payload must not be parsed before verification succeeds.
The tenant therefore **cannot be derived from the event** — it has to be in
the URL.

| Brand | Stripe endpoint | PayPal endpoint |
|---|---|---|
| Himanshu (anchor) | `/api/webhooks/stripe` — **unchanged, do not repoint** | `/api/webhooks/paypal` |
| RCR Cruise | `/api/webhooks/stripe/rcrcruise` | `/api/webhooks/paypal/rcrcruise` |

An unknown or unconfigured slug returns a flat `404 Unknown endpoint`, so the
endpoint cannot be used to enumerate which brands exist here.

Downstream, `findOrderForEndpoint` refuses to touch an order belonging to a
different organization even when the signature is valid — so a
correctly-signed RCR event can never settle a Himanshu booking, and vice
versa. Unattributed pre-migration orders are settleable by the **anchor's**
endpoint only.
