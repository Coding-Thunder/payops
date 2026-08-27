# `himanshu-env/`

Configuration for the **Himanshu** deployment: one organization, one brand,
Stripe enabled, PayPal retained in the architecture and switched off.

It is a **copy**, not a link. Nothing here is read unless you ask for it, and
editing a value here cannot affect the deployment configured at the repository
root.

```
payops/
├── .env.payops.local        ← the original deployment. Untouched.
├── .env.payops.prod
├── .env.payops.test
├── .env.payops.smoke
│
└── himanshu-env/
    ├── .env.payops.local    ← Himanshu's. Same variable names, own values.
    ├── .env.payops.prod
    ├── .env.payops.test
    ├── .env.payops.smoke
    ├── .env.example         ← tracked, valueless, the reviewable checklist
    └── README.md
```

## Selecting it

One variable, `PAYOPS_ENV_DIR`, chooses which directory the standard filenames
are read from. Unset — the default — resolves at the repository root, which is
exactly what every existing command already did.

```bash
# the original deployment, unchanged
npm run dev

# Himanshu
PAYOPS_ENV_DIR=himanshu-env npm run dev
PAYOPS_ENV_DIR=himanshu-env npm run build
PAYOPS_ENV_DIR=himanshu-env npm run seed:orgs
PAYOPS_ENV_DIR=himanshu-env npm test
```

`PAYOPS_ENV_FILE` still takes an explicit path and wins outright, which is how
you point a script at a production file deliberately:

```bash
PAYOPS_ENV_FILE=himanshu-env/.env.payops.prod npm run indexes:audit
```

The application never switches on its own. A directory existing means nothing;
only the variable selects it.

## What differs from the original deployment

Every variable **name** is identical — the application is unchanged and reads
the same keys. What differs is which values are Himanshu's to set.

| Variable | Why it differs |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | Separate cluster/database. Sharing one would put two customers' orders in the same collections. |
| `APP_URL`, `NEXT_PUBLIC_APP_URL` | Himanshu's own domain. These build the consent, acknowledgement and gateway return URLs a customer clicks. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Himanshu's own merchant account. Never the original customer's. |
| `JWT_SECRET` | An independent signing key; a shared one would make sessions interchangeable between deployments. |
| `CREDENTIALS_MASTER_KEY` | Envelope-encryption key. Sharing it would let one deployment open the other's sealed credentials. |
| `SMTP_*`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Himanshu's mailbox, so SPF/DKIM align with the brand the customer expects. |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE` | Printed in customer emails and on the public pages. |
| `APP_NAME`, `NEXT_PUBLIC_APP_NAME` | Copied initially; customer-visible, so replace before go-live. |
| `TURNSTILE_*` | Site/secret pair is bound to a domain. |
| `SEED_ORGS_SLUG`, `CUSTOMER_BRAND_NAME` | Already environment-driven; these are what make the seeded organization Himanshu's rather than the other customer's. |

Values marked `REPLACE_ME` are placeholders. `.env.payops.test` and
`.env.payops.smoke` carry fixture values copied verbatim so the suite runs
identically — nothing real belongs in either.

## Deliberately absent

**`ORG_TRIPRESERVATIONS_*` and `TRACETXN_MASTER_KEY`.** Six variables and one
master key that belong to the other customer's second brand and its sibling
product. They are dead configuration on this deployment, and copying them
would imply a tenant that does not exist here.

**All PayPal variables.** PayPal is a supported provider that is not enabled.
It has no deployment variables in this phase, and it must not be given empty
placeholders: an empty `PAYPAL_CLIENT_ID` reads as "configured but broken"
rather than "not enabled", and the failure it produces would be the wrong one.
The organization's `enabledProviders` is `["STRIPE"]`, the server refuses a
PayPal payment session, and `/api/webhooks/paypal` returns 503. Enabling it is
a separate phase that adds the variables, the registry entry and the webhook
handler together.

## Production

`.env.payops.prod` holds the real DigitalOcean values — same Mongo cluster as
the existing deployment, database `himanshu-payops`, host
`reservationcarrentals.rentalconfirmation.com`. Two secrets are deliberately absent and
must be supplied before the app can start:

```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

The only Stripe keys in this checkout are the existing customer's LIVE keys.
Copying them would settle Himanshu's payments into that merchant account, so
they are not reproduced. `JWT_SECRET` and `CREDENTIALS_MASTER_KEY` were
generated fresh rather than shared: a shared signing key makes a session
minted for one deployment verifiable on the other, and a shared envelope key
lets either open the other's sealed credentials.

## The organization

Resolved server-side from the seeded record — there is no cookie and no
switcher. It is created by:

```bash
PAYOPS_ENV_DIR=himanshu-env npm run seed:orgs
```

which writes one ACTIVE organization with `enabledProviders: ["STRIPE"]`. The
slug and brand come from that script and the `APP_NAME` / branding values, not
from a dedicated environment variable, so there is nothing extra to replicate
here. The application refuses to start serving pages if no organization is
seeded rather than quietly running tenant-less.

## Secrets

`.gitignore` already covers `.env*` at every level, so every file in this
directory except `.env.example` and this README is untracked. Verify before
committing:

```bash
git check-ignore -v himanshu-env/.env.payops.prod   # must print a match
git status --porcelain himanshu-env/                # must list only tracked files
```

Production values belong in the hosting platform's secret store. The `.prod`
file here is a checklist of what must be set there, not a place to keep it.
