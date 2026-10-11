/**
 * The FAQ shown on the landing page, and the subset that is safe to emit as
 * FAQPage JSON-LD.
 *
 * Split out of `faq.tsx` (a client component) so the schema builder can
 * import the SAME array the page renders. Google requires every FAQ in
 * structured data to be visible on the page; keeping two hand-maintained
 * copies is how that requirement quietly breaks.
 */

export interface FaqItem {
  q: string;
  a: string;
}

export const FAQS: FaqItem[] = [
  {
    q: "How do I migrate my existing client records?",
    a: "You add clients as you go — there is no bulk importer yet, and we would rather say so than imply one exists. Most teams start by creating the handful of clients they are actively working with and letting the history build from the real work. Export works today in the other direction: your customers, orders and email history can all be exported, so nothing you put in is trapped.",
  },
  {
    q: "How does Stripe connect to TraceTxn?",
    a: "You paste your own Stripe keys into your workspace settings, in test or live mode. The money moves through your Stripe account to your bank, never through us — we only hold the credential needed to raise a payment link and read back the result. Secret keys are encrypted at rest, and you can rotate or remove them at any time.",
  },
  {
    q: "Can I use TraceTxn without connecting Stripe?",
    a: "Yes. Client records, orders, invoices, files, notes and client email all work with no gateway connected — an order simply stays in its pre-payment state instead of generating a checkout link. Connect Stripe when you want to collect payment through TraceTxn rather than outside it.",
  },
  {
    q: "Can I manage partially paid or unpaid invoices?",
    a: "Unpaid is a first-class state: an order sits in pending until a payment is actually confirmed by the gateway, so what is outstanding is always visible. Split part-payments against one invoice are not modelled today — if you take a deposit and a balance, the honest way to run it right now is two orders, or a workflow stage you name yourself.",
  },
  {
    q: "Is this a CRM?",
    a: "No. A CRM manages a sales pipeline and chases leads. TraceTxn remembers delivery — the record of what actually happened after a client said yes. Plenty of teams keep both, and use TraceTxn as the memory their CRM never had.",
  },
  {
    q: "Does it replace ClickUp, Stripe, or my accounting tool?",
    a: "No, and it doesn’t try to. Keep running projects where you run them and take payments where you take them. TraceTxn is the permanent record everything feeds into, so the history survives in one place instead of scattering across all of them.",
  },
  {
    q: "How does search work?",
    a: "Search a client’s name, company, email, phone number, or an invoice ID. The matching record opens instantly with the full timeline. It’s designed to feel like Spotlight or Raycast — you type, you’re there — not a database query.",
  },
  {
    q: "Can I store contracts and files?",
    a: "Yes. Agreements, proposals, brand packs and any file attach directly to the client and land on their timeline with the date they were shared or signed — so “which version did they sign?” is never a mystery again.",
  },
  {
    q: "How is my data secured?",
    a: "Every record is scoped to your workspace and isolated from other teams. Sensitive credentials are encrypted, and the important actions on a record are written to a tamper-evident audit trail you can review.",
  },
  {
    q: "Can my team collaborate?",
    a: "Yes. Invite your team and everyone sees the same client record. When someone new joins — or takes over an account — the complete history is their handover, no knowledge-transfer meeting required.",
  },
  {
    q: "Can I export my data?",
    a: "Anytime. Export a client’s complete record — timeline, invoices, payments and files. It’s your data. There’s no lock-in and nothing is held hostage.",
  },
  {
    q: "Who is it for?",
    a: "Agencies and freelancers who juggle multiple clients over months or years — web, brand, SEO, marketing and development teams who lose time and leverage every time context goes missing.",
  },
];

/**
 * Questions withheld from JSON-LD because their answers describe capability a
 * signed-in user cannot reach today.
 *
 * Currently EMPTY. It held "Can I store contracts and files?" and "Can I
 * export my data?" while client files and links existed only as models,
 * services and REST routes with no UI. They now ship: /app/customers/[id]
 * renders dedicated Files and Links tabs (FilesPanel / LinksPanel), the
 * panels call /api/files and /api/links for list, create, update and delete,
 * and both are permission-gated. So both answers are now true and are emitted.
 *
 * Keep this list as the mechanism, not a historical note: anything the
 * visible FAQ promises but the app cannot do belongs here rather than in
 * structured data, where a mismatch is both a rich-result violation and a
 * promise to a visitor arriving from search.
 */
export const FAQ_WITHHELD_FROM_SCHEMA: readonly string[] = [];

/** The entries emitted as FAQPage JSON-LD. A subset of what the page shows. */
export const SCHEMA_FAQS: FaqItem[] = FAQS.filter(
  (f) => !FAQ_WITHHELD_FROM_SCHEMA.includes(f.q),
);
