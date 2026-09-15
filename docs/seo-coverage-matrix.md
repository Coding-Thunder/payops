# Search coverage matrix

What each public URL is for, which search intent it answers, and — as
importantly — what this site deliberately does **not** try to rank for.

Written to be checked against the tree rather than believed:
`src/tests/unit/marketing/seo-landing-pages.test.ts` and
`blog-seed-claims.test.ts` fail if a page named here stops existing, links to a
route that does not, or claims a capability the product lacks.

---

## 1. The cluster

One pillar, four spokes. Every spoke links back to the pillar and the pillar
links out to all four; the shape lives in data (`src/lib/seo-routes.ts`), not
in prose, so the sitemap, the breadcrumbs and the internal links cannot drift
apart.

| URL | Primary intent | Query shape it answers | Stage |
|---|---|---|---|
| `/client-management` | **Informational — pillar.** What client management is, how it differs from a CRM. | "what is client management", "client management meaning" | Awareness |
| `/client-management-software` | **Commercial.** Someone evaluating tools. | "client management software", "best client management software" | Consideration |
| `/agency-client-management` | **Segment.** Agency-specific framing. | "client management for agencies", "agency client management system" | Consideration |
| `/client-communication-management` | **Problem-led.** Correspondence scattered across inboxes. | "client communication management", "keep client emails in one place" | Awareness → Consideration |
| `/client-record-management` | **Method-led.** How to keep a complete record. | "client record management", "client information management" | Awareness |

## 2. Product and trust surfaces

| URL | Intent | Note |
|---|---|---|
| `/` | Brand + category | Primary positioning surface |
| `/features` | Commercial | What it does, claim-disciplined |
| `/pricing` | Transactional | **See the caveat in §6** |
| `/security` | Objection-handling | "is this safe for client data" — the objection this product must clear |
| `/reviews` | Trust / social proof | Empty by design until real reviews exist (§5) |
| `/waitlist` | **Conversion** | The ad-facing conversion during the private beta |
| `/contact` | Transactional | Enquiry form |
| `/privacy` `/terms` `/dpa` `/refunds` | Legal / trust | Indexable; their absence reads as a thin site |

## 3. Editorial (`/blog`)

Written for people doing the work, not for crawlers. Each answers a question
someone actually types, is useful without the product, and links into the
cluster once or twice — never more.

| Slug | Intent | Query shape | Cluster link |
|---|---|---|---|
| `what-belongs-in-a-client-record` | Informational | "what should a client record contain" | `/client-management` |
| `chasing-an-unpaid-invoice` | **Problem — high intent** | "how to chase an unpaid invoice", "client not paying invoice" | `/client-management` |
| `client-onboarding-checklist-for-agencies` | Informational — checklist | "client onboarding checklist", "agency onboarding process" | `/client-management` |
| `client-communication-out-of-personal-inboxes` | Problem | "shared inbox for client emails", "client email in one place" | `/client-communication-management` |
| `client-management-vs-crm` | **Commercial comparison** | "client management vs CRM", "do I need a CRM for my agency" | `/client-management`, `/client-management-software` |

`chasing-an-unpaid-invoice` is the strongest commercial-intent piece: it is a
problem people search while actively looking for a way out of it, and the
product genuinely addresses it. `client-management-vs-crm` is the strongest
comparison piece and is deliberately honest about when a CRM is the right
answer — a comparison that always concludes "buy ours" converts worse and
reads as marketing.

## 4. Competitor landscape, and the honest position

The category is crowded and mature. Naming the terrain matters more than
pretending to a rank the site does not have.

| Competitor class | Examples of the class | Where they win | Where this site can compete |
|---|---|---|---|
| Full CRMs | Established sales-pipeline tools | "CRM" head terms; enormous domain authority | Not contestable. `client-management-vs-crm` is written to catch people who *searched CRM but do not have a sales problem*. |
| Agency PSAs / project suites | Project + time + billing suites | "agency management software" | Partially. This product has no time tracking or project planning; the spokes stay on records/communication/invoicing, which is what it actually does. |
| Freelancer all-in-ones | Invoice + proposal + contract tools | "freelance invoicing" | Partially, on records and history rather than on document generation. |
| CRM-adjacent client portals | Client-portal products | "client portal" | Not currently targeted — there is no client-facing portal beyond hosted consent and payment pages. |

**Deliberately not targeted**, and why:

- **"CRM" head terms.** Losing search that the product would then disappoint.
- **"Project management", "time tracking", "proposals", "e-signature".** No such features. Ranking for them would be a doorway page.
- **"Chargeback / dispute software".** The evidence chain is real but it is one use case, not the product's identity. The site was previously mis-positioned this way; see the note at the top of `src/lib/seo.ts`.
- **Competitor brand names.** No comparison pages targeting another product's name. They rank, and they are also the fastest way to make a small brand look like it has nothing of its own to say.

## 5. Where the site refuses to claim

These are the interesting entries, because each is a place where the
conventional SEO move is available and is not taken.

| Surface | The conventional move | What this site does |
|---|---|---|
| `/reviews` | Seed testimonials; emit `aggregateRating` | Empty state, no rating markup below two real reviews (`review.service.ts`) |
| Blog | Statistics, "studies show", customer quotes | None. `blog-seed-claims.test.ts` fails the build on a percentage or an uncited claim |
| JSON-LD `featureList` | List the roadmap | Only capability a signed-in user can reach today |
| FAQ schema | Answer what people search | `FAQ_WITHHELD_FROM_SCHEMA` holds back answers the product cannot back |
| `offers` / pricing schema | Emit a price | Omitted entirely — there is no purchasable plan (§6) |

## 6. Known gaps and open risks

1. **`/pricing` advertises tiers the product cannot sell.** The product is a
   free private beta with no billing wired up; the legal copy is aligned to
   beta reality but `/pricing` is not. A visitor who searches a
   transactional query and lands there gets a promise the app cannot keep.
   *Not fixed here — it is a positioning decision, not an implementation one.*

2. **`/blog` is absent from the sitemap until a post is published.**
   Intentional: advertising an empty index invites a crawl of nothing. The
   seed script leaves posts as drafts, so **the blog does not exist publicly
   until someone publishes from `/admin/blog`**.

3. **No `/blog` tag or author pages.** Tags are stored and filterable in the
   service but have no route. Thin archive pages are a liability at this
   content volume; revisit past ~20 posts.

4. **No image assets.** Posts support cover images and none are set. The OG
   card for an article currently falls back to the site default.

5. **Reviews are unverifiable.** Anyone can submit; moderation is a human
   reading it. There is no purchase verification, and no "verified" badge is
   shown — claiming one would be the false part.

6. **Signup conversion delivery is best-effort.** `signup_completed` fires
   immediately before a hard navigation to a GTM-blocked route. The ad-facing
   conversion is `beta_application_submitted`, which does not navigate away.
   See the comment in `firebase-auth-form.tsx`.

## 7. Measurement

| Event | Fires when | Payload |
|---|---|---|
| `beta_application_submitted` | Server stored a beta application | `user_type` only |
| `review_submitted` | Server stored a pending review | `rating` only |
| `contact_submitted` | Server stored an enquiry | none |
| `signup_completed` | Session exchange succeeded, signup mode only | none |

Every event fires **after** the server's success response, never on a click —
so bot traffic, failed challenges and rejected disposable addresses do not
train Google Ads bidding. No event carries an email, a name, an identifier or
a token; see `src/lib/analytics/data-layer.ts` and its tests.

Which of these counts as a conversion, and what it is worth, is configured in
the Google Ads UI, not here.
