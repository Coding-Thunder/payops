/**
 * Seed articles for the blog.
 *
 * ── Why the content lives in the repository ──────────────────────────────
 *
 * These posts are marketing claims about what the product does, so they are
 * reviewable the same way code is: in a diff, with the rest of the copy, under
 * the same claim discipline that governs `seo-routes.ts` and the JSON-LD graph
 * (`blog-seed-claims.test.ts` enforces it). Content that only ever existed as
 * rows in a production database gets edited by whoever has console access, at
 * whatever hour, with no record of what changed.
 *
 * The database is still the runtime source of truth. `npm run seed:blog`
 * upserts these by slug and is idempotent; posts written later in the admin
 * console live only in the database and are never touched by the seed.
 *
 * ── Editorial rules these were written under ─────────────────────────────
 *
 *  1. NO INVENTED EVIDENCE. No statistics, no "studies show", no named
 *     customers, no testimonials, no revenue or time-saved figures. TraceTxn
 *     is a private beta; it has no case studies yet, and inventing one is
 *     fraud rather than marketing. Every claim below is either a statement
 *     about how the product works — checkable against the code — or reasoning
 *     the reader can follow and disagree with.
 *
 *  2. ONLY SHIPPED CAPABILITY. Client records and timelines, orders with a
 *     configurable status workflow, numbered invoices and receipts, Stripe
 *     card payments, hosted consent capture, files and links on the client,
 *     templated client email, an audit trail, and shared team workspaces with
 *     roles. Deliberately ABSENT: approvals, e-signature, sign-off, AI or
 *     "insights", forecasting, time tracking, proposals, and analytics
 *     dashboards. None of those exist.
 *
 *  3. USEFUL WITHOUT THE PRODUCT. Each article has to be worth reading by
 *     someone who never signs up. Doorway pages that restate a keyword and
 *     funnel to a CTA are what the spec rules out, and they do not rank.
 *
 *  4. WESTERN-MARKET PRIMARY. US/UK/CA/AU vocabulary, invoicing conventions
 *     and payment expectations; India is a secondary market and no article is
 *     written around India-specific practice.
 */

export interface BlogSeedPost {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  authorName: string;
  tags: string[];
  seoTitle?: string;
  seoDescription?: string;
}

export const BLOG_AUTHOR = "The TraceTxn team";

export const BLOG_SEED_POSTS: readonly BlogSeedPost[] = [
  /* ────────────────────────────────────────────────────────────────────── */
  {
    slug: "what-belongs-in-a-client-record",
    title: "What belongs in a client record (and what doesn't)",
    seoTitle: "What belongs in a client record — a practical checklist",
    excerpt:
      "Most client records are a contact card with notes bolted on. Here is what a record needs to hold before it can answer the questions you actually ask it, and what to leave out.",
    seoDescription:
      "A practical breakdown of what a client record should contain — the commitments, the money, the correspondence and the documents — and what to keep out of it.",
    authorName: BLOG_AUTHOR,
    tags: ["client-records", "operations"],
    body: `Ask most service businesses where a client's information lives and you get a list, not a place. The contract is in a shared drive. The invoices are in the accounting tool. The scope discussion is in someone's inbox. The change of address is in a Slack thread. Each of those systems is fine at its own job, and none of them can answer the question you actually ask, which is almost always some version of *what is the state of this relationship right now*.

A client record is the thing that answers that question. It is worth being precise about what has to be in it.

## The test a record has to pass

Here is a useful standard: a colleague who has never spoken to this client should be able to open the record and, within a minute, correctly answer four questions.

- What did we agree to do?
- What has been billed, and what has been paid?
- What was the last thing anyone said to them, and when?
- Is anything waiting on us?

If answering any of those requires opening a second system or asking the person who owns the account, the record is not doing its job. That is the whole bar. Everything below follows from it.

## The four things a record has to hold

### 1. The commitments

Not "the project" as a vague noun — the specific pieces of work you have agreed to deliver, each with a state. An enquiry that never became work, a job in progress and a job delivered three months ago are all part of the relationship, and a record that only shows active work makes the client look newer and quieter than they are.

The states themselves should match how your business actually talks. A studio that says *briefed → in production → with client → delivered* should not have to translate that into someone else's *lead / opportunity / closed-won*. Vocabulary mismatch is why so many teams keep a spreadsheet next to the system: the spreadsheet speaks their language.

### 2. The money

Every invoice, its number, what it was for, when it went out, and whether it has been paid. Then the payments themselves, matched to what they paid for.

The matching is the part that gets skipped and the part that matters. "This client owes us £4,000" is a much weaker fact than "invoice 0114, raised on 3 March for the second stage of the rebrand, is unpaid." The first starts an argument. The second ends one.

### 3. The correspondence

What you sent, when, and to whom. Not every casual message — the ones that carry a commitment or a request: the quote, the invoice, the reminder, the change of scope, the "we can't start until we have the assets" email.

This is the single most common gap. Client email lives in individual inboxes, which means the relationship is only fully visible to whoever happens to own the account. When they are on holiday, the record has a hole in it. When they leave, the hole is permanent.

### 4. The documents

The signed contract, the brief, the brand guidelines, the deliverables, the receipts. Attached to the client rather than filed in a folder tree that made sense to whoever created it in 2022.

The reason to attach them to the record rather than link to a drive is not tidiness. It is that a link is a claim about where a file is, and claims go stale. Folders get reorganised, permissions get tightened, people leave and their personal drive goes with them.

## What to leave out

A record gets less useful as it gets fuller, so it is worth being deliberate about what does not belong.

**Anything you would be embarrassed to have read aloud.** Internal opinions about the client, frustrations, speculation about their budget. Not because clients routinely read internal systems, but because subject access requests, disputes, acquisitions and legal discovery all have a way of surfacing exactly the note you forgot you wrote. Keep judgement in your head and facts in the record.

**Card numbers and bank details.** There is no version of a client record that should contain a full card number. Payment details belong with your payment processor, which is built to hold them and audited for it. In TraceTxn, card details are entered on Stripe's own hosted checkout and never touch our servers.

**A second copy of your accounting ledger.** The record should show what was invoiced and what was paid. It is not a general ledger and should not try to be one — you will end up reconciling two sources of truth, which is worse than having one imperfect one.

**Every message ever sent.** A record that captures all correspondence indiscriminately becomes an archive, and archives are things you search when you already know what you are looking for. The point of a record is to be readable by someone who does not.

## Why chronology beats categories

The most common structure for a client record is a set of tabs: contacts, projects, invoices, files. It is a reasonable filing system and a poor narrative. To reconstruct what happened you have to open four tabs and mentally interleave them by date.

A timeline does that interleaving for you. The quote went out on the 4th, they replied on the 6th, work started on the 11th, the first invoice went out on the 30th, it was paid on the 12th of the following month, and the scope changed on the 20th. Read top to bottom, that is the relationship. Split across tabs, it is homework.

This is why the client page in TraceTxn is built as a timeline first. Orders, invoices, receipts, payments, files, links and the emails sent about them all write to one chronological history per client, because raising an order or sending an invoice is what puts it there. Nobody has to remember to update the record — the record is a side effect of doing the work.

## The test again

Go and open the record for a client you have not spoken to in six weeks. Try to answer the four questions. Time yourself.

If it takes more than a minute, the problem is almost never that people are careless about admin. It is that the record does not have a place for the thing they would have written down.

---

*TraceTxn keeps one searchable record per client — orders, invoices, payments, files and the email you sent about them, on a single timeline. [See how client management works](/client-management).*`,
  },

  /* ────────────────────────────────────────────────────────────────────── */
  {
    slug: "chasing-an-unpaid-invoice",
    title: "How to chase an unpaid invoice without damaging the relationship",
    seoTitle: "How to chase an unpaid invoice (without souring the client)",
    excerpt:
      "Late payment is usually a process failure on the client's side, not a refusal to pay. Chasing works better when you assume that — and when you can point at a record instead of arguing from memory.",
    seoDescription:
      "A practical sequence for chasing an overdue invoice: what to send, when, to whom, and how to keep the relationship intact while you do it.",
    authorName: BLOG_AUTHOR,
    tags: ["invoicing", "cash-flow"],
    body: `An invoice goes unpaid for one of four reasons. They never received it. They received it and it is stuck somewhere in their process. They are short of cash. Or they are unhappy with the work and have not said so.

Only the last two are about you, and only one of those is a conflict. Most overdue invoices are the second case — the invoice is sitting in an inbox belonging to someone who left, or it is missing a purchase-order number, or the person who approves it has been on leave for two weeks. Chasing works much better when your first message assumes that.

## Before you chase: make the invoice hard to lose

Most of the work happens before the due date.

**Send it to the right person.** The person who briefed you is frequently not the person who pays you. In any organisation above a handful of people there is an accounts payable function, and an invoice that goes only to your day-to-day contact depends entirely on them forwarding it. Ask, at the start of the engagement, who invoices should go to and what they need on them.

**Put their reference on it.** If a client uses purchase orders, an invoice without a PO number will not be paid, and often will not be rejected either — it will simply sit. Ask for the PO before you send the first invoice, not after the first one is late.

**Number them, sequentially, and never reuse a number.** This sounds like bookkeeping pedantry until you are in a dispute and need to establish which document you are both talking about. TraceTxn numbers invoices and receipts per workspace for exactly this reason.

**Say the date, not the interval.** "Payment due within 30 days" requires the reader to work out when that is from a date they have to go and find. "Payment due by 4 April 2026" does not.

## The sequence

The aim is to be impossible to ignore and impossible to resent. That means escalating in *specificity*, not in volume or in temperature.

**Two or three days before the due date — a courtesy note.** Short, friendly, no ask beyond confirmation: the invoice is due on Thursday, here it is again, let me know if you need anything to process it. This catches the "it never arrived" and "we need a PO" cases before they become lateness, which is the cheapest possible intervention.

**The day after it is due — a factual nudge.** State what is outstanding, its number, its amount, and its date. Attach it again; never make someone go looking. No apology, no hedging, no "sorry to be a pain" — you are not being a pain, you are asking to be paid for work you have delivered.

**Seven days late — go sideways, not up.** Reply to your own thread and add accounts payable, or ask your contact directly who handles payment runs. This is the message that resolves most genuinely stuck invoices, because it moves the request from someone who cannot pay it to someone who can.

**Fourteen days late — ask a question instead of making a statement.** "Is there anything blocking this on your side?" is a better message than a fourth reminder. It is genuinely open, it costs nothing to answer, and it gives an unhappy client the opening to say so. If dissatisfaction is the real reason, you want to know now, not after two more reminders have hardened the position.

**Thirty days late — change what happens next.** Pause new work, name a specific date, and say what happens after it. Not as a threat, as information: work is paused until the account is settled, and if the invoice is unpaid by the 30th it goes to a formal recovery process. Then do it. A deadline you do not act on teaches the client that your deadlines are decorative.

## What makes the difference: pointing at a record

The reason chasing goes badly is almost always that both sides are arguing from memory and neither is confident.

"I'm pretty sure we sent that" is a weak position. "Invoice 0114 for the second stage went to accounts@ on 3 March, and I resent it on the 12th and the 21st" is not an argument at all — it is a set of facts, and facts about your own diligence are hard to be annoyed by.

This is worth designing for rather than reconstructing under pressure. Sent email recorded against the client, invoices with numbers and dates, payments matched to what they paid for. In TraceTxn, sending a templated invoice email writes to the client's timeline, so what you sent and when is a lookup rather than an inbox search.

The same record is what protects you if a payment is later disputed. When a cardholder raises a chargeback, the case is decided on evidence submitted within a deadline — what was ordered, what was agreed, what was delivered, what was sent. Assembling that from four systems under time pressure is how winnable disputes are lost.

## Tone rules that are actually about clarity

- **Never apologise for invoicing.** "Sorry to chase" invites the reading that chasing is an imposition.
- **Never make it about your cash flow.** It is true and it is not their problem; it also signals that you can be pushed.
- **Never send a reminder that does not contain the invoice.** Every extra step is a place for the request to die.
- **Always give one specific action.** "Can you confirm this is scheduled for the next payment run?" beats "please advise on status."
- **Keep the whole thread in one place.** A new email each time makes it easy for the client to lose the history, which favours whoever is less organised.

## When to stop

At some point the arithmetic changes: the time you are spending is worth more than the invoice, or the client has told you plainly they cannot pay.

Decide that in advance and write it down. A policy — thirty days, then recovery — is a business decision made calmly. A decision made in the moment, about a specific client you like, is a decision you will make badly and inconsistently.

And when it does end well, which it usually does, the last message matters: confirm receipt, thank them, and carry on as normal. A firm chase followed by a normal working relationship is what tells a client that being asked to pay on time is not a conflict. It is just how you work.

---

*TraceTxn keeps invoices, payments and the email you sent about them on one client timeline, so chasing is a lookup rather than a reconstruction. [See how client management works](/client-management).*`,
  },

  /* ────────────────────────────────────────────────────────────────────── */
  {
    slug: "client-onboarding-checklist-for-agencies",
    title: "A client onboarding checklist that prevents the usual problems",
    seoTitle: "Client onboarding checklist for agencies and freelancers",
    excerpt:
      "Almost every painful client relationship went wrong in the first two weeks. Here is what to establish before work starts, and why each item earns its place.",
    seoDescription:
      "A client onboarding checklist for agencies and freelancers: what to agree, collect and record before work starts, and the failure each step prevents.",
    authorName: BLOG_AUTHOR,
    tags: ["onboarding", "operations"],
    body: `Think back to the last client relationship that went badly. Not badly as in the work was hard — badly as in the scope kept moving, the invoice went unpaid for two months, and nobody could agree on what had been promised.

It almost certainly went wrong in the first two weeks, and it went wrong quietly. Onboarding is cheap to do properly and expensive to skip, and the reason it gets skipped is that the cost arrives months later, attached to something that looks like a different problem.

Here is a checklist. Each item exists to prevent a specific, recognisable failure.

## Before you start work

### Agree what "done" means, in writing

Not the deliverables list — the acceptance condition. "Three concepts, one round of revisions on the chosen route, final files in the agreed formats" is a definition of done. "A brand refresh" is a hope.

*Prevents:* the project that never ends because there was never a stated point at which it was finished.

### Name the decision-maker

One person who can say yes and end a round. Ask directly: who makes the final call? If the answer is a committee, ask who speaks for the committee.

*Prevents:* the fourth stakeholder appearing in week six with opinions that reopen settled decisions.

### Establish the payment terms and the payment route

Terms, deposit, invoicing schedule — and separately, the mechanics: who invoices go to, whether a purchase order is required, and when their payment runs happen. A client who pays on the 15th and the 30th is not late on the 20th; they are on schedule and you did not ask.

*Prevents:* the invoice that sits unpaid for six weeks because it needed a PO number nobody mentioned.

### Take a deposit

Whatever proportion suits the work. The amount matters less than the fact of it: a client who has paid something has made a decision internally, which is the single best predictor that the rest will be paid too.

*Prevents:* discovering in month two that the budget never actually cleared their side.

### Collect what you need to start — and say what happens if it is late

Assets, access, brand files, content, credentials. List them, with a date. And state the consequence plainly: if the assets arrive a week late, delivery moves by a week. Say it while everyone is cheerful, because saying it for the first time during the delay sounds like an excuse.

*Prevents:* the timeline slipping for reasons that were entirely the client's, and being blamed for it anyway.

### Agree where communication happens

One channel for decisions. Anything agreed elsewhere gets confirmed there. This is not bureaucracy — it is the difference between a decision you can find and a decision someone remembers differently.

*Prevents:* the scope change that was agreed verbally, in a call, by someone who has since left.

## In the first week

### Create the client record before the work, not after

Set up the client in whatever system holds your records, and make it the place the work is done from rather than a thing you update afterwards. Records that are maintained separately from the work are always out of date, because keeping them current is unpaid overhead nobody prioritises.

In TraceTxn this is deliberate: raising an order, sending an invoice, taking a payment and emailing the client all write to the same client timeline. The history is complete because it is a by-product of the work rather than an extra task.

*Prevents:* a record that is a stub with a phone number in it.

### File the contract on the client, not in a drive

Attach the signed agreement, the brief and the scope to the client record itself. A link into a shared drive is a claim about where a file lives, and folders get reorganised.

*Prevents:* the dispute where nobody can produce the signed scope.

### Send a written recap of the kick-off

Short. What we agreed, what we are waiting for, what happens next, and by when. Sent the same day, while everyone still remembers the conversation the same way.

*Prevents:* two different recollections of the same meeting hardening into two different projects.

### Set the first checkpoint before you need one

A date, in the diary, for the first review. Not because the work needs it, but because a scheduled checkpoint is a low-stakes place to raise a problem. Without one, the first difficult conversation happens when something is already wrong.

*Prevents:* silence for three weeks followed by an unpleasant surprise.

## Before the first invoice

### Send it earlier than feels natural

The first invoice tests the client's payment process. Better to discover on a deposit that their system needs a PO than on the final invoice for the whole engagement.

*Prevents:* finding out how slow they pay at the worst possible moment.

### Make sure it matches the agreed language

Line items that use the same words as the scope. An invoice that says "creative services" against a scope that promised "three concepts and one revision round" is an invoice someone has to interpret, and interpretation is where queries come from.

*Prevents:* the query that delays payment by two weeks over a wording mismatch.

### Check where it needs to go

Ask, do not assume. The person who briefed you is often not the person who pays you.

*Prevents:* an invoice sitting in a personal inbox for a month.

## What this is really doing

Every item above converts something implicit into something explicit, and does it while the relationship is still friendly. That is the whole mechanism.

Implicit understandings are not free. They are loans taken out against a future conversation, and the interest is paid at the worst moment — during a delay, a dispute, or a scope argument, when both parties are already annoyed and each has a version of events that favours them.

A written scope, a named decision-maker, a stated payment route and a client record that fills itself in are not administrative overhead. They are the reason month four is boring.

---

*TraceTxn gives each client one record — orders, invoices, payments, contracts and the email you sent about them, on one timeline. [See how client management works](/client-management).*`,
  },

  /* ────────────────────────────────────────────────────────────────────── */
  {
    slug: "client-communication-out-of-personal-inboxes",
    title: "Client communication shouldn't live in one person's inbox",
    seoTitle: "Getting client communication out of personal inboxes",
    excerpt:
      "When client email lives in individual inboxes, the relationship is only visible to one person. Here is what that costs, and what to do about it short of buying a shared inbox.",
    seoDescription:
      "Why client correspondence in personal inboxes creates single points of failure, and how to keep the record of what was sent attached to the client instead.",
    authorName: BLOG_AUTHOR,
    tags: ["client-communication", "operations"],
    body: `Here is a question worth asking about your own business: if the person who owns your largest client relationship were unreachable for two weeks, could someone else pick it up?

Not "could someone else email them" — could someone else find out what was last promised, what was sent, what is outstanding and what the client is currently annoyed about?

For most service businesses the honest answer is no, and the reason is that the record of the relationship is in one person's inbox.

## What that actually costs

**Continuity.** Holiday, illness, resignation. The person covering starts from zero, and the client can tell.

**Institutional memory.** The commitment made eighteen months ago — the discount, the exception, the "we'll throw that in" — exists in one archive that nobody else searches. When it comes up, you either honour something you cannot verify or contradict a client who is right.

**Handover.** Moving an account between people is the moment the gaps become visible. It is also when clients most often decide to review the relationship, which is not a coincidence.

**Disputes.** When a client says "you never told us that", the answer is in someone's sent folder. If they have left, it may be nowhere at all. If a card payment is disputed, the evidence you need has a deadline attached, and the deadline does not care whose inbox it is in.

**Duplicated work.** Two people email the same client about the same thing in the same week because neither could see the other's thread. Clients notice this specific failure more than almost any other, because it makes the business look disorganised in a way that is impossible to explain away.

## The usual fix, and why it only half works

The standard answer is a shared inbox: hello@, accounts@, a support tool. It fixes some of this. Anyone can see the thread, coverage is possible, nothing is locked to a person.

But a shared inbox organises by *conversation*, not by *client*. To reconstruct a relationship you search for an address and read a scattered set of threads, some of which are about invoices, some about scope, some about a call in March. You still cannot see, on one screen, that this client has an unpaid invoice from six weeks ago, a delivered order that was never acknowledged, and a message from Tuesday asking about something else entirely.

And the important commitments were often not made from the shared address anyway. They were made by the person who does the work, from their own account, because that is who the client emails.

## The thing to aim for

You do not need every message. You need the ones that carry a commitment, a request or an obligation — the quote, the order confirmation, the invoice, the reminder, the scope change — recorded against the client rather than against a person.

Concretely:

**Client-facing email should be sent from the record, not to it.** Forwarding, BCC-ing an address, or copying threads into a system afterwards all depend on someone remembering. Anything that depends on remembering has a failure rate, and the failure rate is highest exactly when things are busy.

**The record should show what was sent, to whom and when.** Not necessarily the whole conversation — the fact of the message and its content, in sequence with everything else that happened.

**It should be in the same view as the money and the work.** The reason to unify these is that questions cross them. "Have we chased this?" is a question about email that depends on an invoice. "Did we tell them about the delay?" is a question about email that depends on an order.

This is how TraceTxn is built: client email is sent from templates, from the client record, and lands on the same timeline as the orders, invoices, payments, files and links. Not because email needed reinventing, but because the *record* of what was sent belongs with the client, and a personal inbox is not a place a business can rely on.

## What to do this week, whatever you use

Even without changing tools:

- **Pick one channel for decisions** and confirm anything agreed elsewhere back into it, in writing.
- **Write the recap.** After any call that changes scope, price or timing, send a short written summary the same day. It costs three minutes and settles arguments that have not happened yet.
- **Attach commitments to the client, not the thread.** Wherever your client records live, note the exception, the discount, the promise — in the record, not only in email.
- **Audit one account.** Pick a client and try to reconstruct the last six months from your systems alone, without asking anyone. Whatever you cannot find is the gap.

## The underlying principle

Client relationships outlive the people who manage them, and businesses that are good at this treat correspondence as a business record rather than as personal communication that happens to be about work.

That is not about surveillance or formality. It is about the difference between a business that knows what it has promised and one that has to go and ask.

---

*TraceTxn records templated client email against the client, on the same timeline as their orders, invoices and payments. [See how client communication management works](/client-communication-management).*`,
  },

  /* ────────────────────────────────────────────────────────────────────── */
  {
    slug: "client-management-vs-crm",
    title: "Client management vs CRM: which does an agency actually need?",
    seoTitle: "Client management vs CRM — what an agency actually needs",
    excerpt:
      "A CRM is built to help you win clients. Most agencies and freelancers have the opposite problem: they win the work and then lose track of it. The distinction decides which tool fits.",
    seoDescription:
      "The difference between a CRM and client management software, why agencies often buy the wrong one, and how to tell which problem you actually have.",
    authorName: BLOG_AUTHOR,
    tags: ["client-management", "crm", "buying"],
    body: `A CRM and a client management system look similar from the outside. Both hold a list of companies, both have contact records, both show a history. Teams often buy one, use a fraction of it, and never quite work out why it feels like the wrong shape.

The difference is not features. It is which half of the relationship the tool is built around.

## A CRM is built around the sale

Every serious CRM is organised around a pipeline: a set of stages a prospect moves through on the way to becoming a customer. New lead, qualified, quoted, negotiating, closed. The reports are conversion rates, pipeline value, and a projection of what will close this quarter. The unit of work is the *opportunity*, and an opportunity has a natural end — it closes, won or lost.

That is a genuinely good design for a business whose hard problem is *finding and converting* customers. High volume of prospects, competitive deals, a sales team whose performance you need to see.

The tell is what happens after the deal closes. In most CRMs, a closed-won opportunity goes quiet. It has done the thing the system was designed to track. Delivery, invoicing, the second project, the awkward conversation in month four — those are somebody else's system's problem.

## Client management is built around the relationship after the sale

An agency or freelancer usually has the opposite problem. There are not four hundred prospects; there are maybe thirty relationships, most of them ongoing, and the work does not stop when the deal is agreed. It starts.

The questions that hurt are all post-sale:

- What did we agree to deliver for this client, and where is each piece?
- What has been invoiced, what has been paid, what is overdue?
- What did we last send them, and did they reply?
- If I hand this account to a colleague tomorrow, can they pick it up?

None of those are pipeline questions. A CRM can be bent into answering some of them — custom fields, a second pipeline for delivery, notes — but you are building a delivery system inside a sales tool, and the seams show. The reports still want to tell you about conversion rates you do not have a volume problem with.

Client management software is organised around the *client*, not the deal, and around a history that has no closing stage. The unit is the relationship, and it runs indefinitely.

## How to tell which problem you have

A rough test. Which of these sentences is more true of your business?

**"We could be much bigger if we converted more of the leads we get."** You have a sales problem. Buy a CRM and use it properly.

**"We win plenty of work; the trouble is keeping on top of it once we have."** You have a client management problem, and a CRM will feel like admin because it is measuring something that is not your constraint.

Most small agencies, studios and independent professionals are firmly in the second category. Work arrives by referral and reputation rather than through a pipeline. The pain is scope drift, unpaid invoices, and the fact that everything important about a client lives in one person's head.

## Where the two overlap — and where they do not

There is genuine overlap: both keep contacts, both keep a history, both want one place per client.

The divergence is in what happens next.

A CRM's next step is usually a *sales* action — log a call, set a reminder, move the stage. A client management system's next step is usually a *delivery or money* action: raise the order, send the invoice, record the payment, attach the contract, email the client and have that email land on their record.

That is why bolting one onto the other rarely settles. You end up with the commercial reality — what was agreed, billed and paid — in one system and the relationship history in another, and the questions you actually ask cross both.

## What this looks like in practice

The version we build for is a single record per client where the history assembles itself: the orders you have raised and where each one sits in a workflow you configure to match your own vocabulary; the numbered invoices and receipts those orders produce; the payments taken against them; the contracts and files attached to the client; and the templated email you sent, recorded against the client rather than sitting in an individual's sent folder.

Not because those are exotic features, but because they are what makes a record answerable rather than merely complete. Nobody has to update it, because raising an order or sending an invoice is what writes to it.

TraceTxn is not a CRM and does not try to be one. There is no pipeline, no forecast, no lead scoring. If your constraint is converting more prospects, it is the wrong tool and a CRM is the right one.

## The honest summary

Buy a CRM if your hard problem is winning work.

Buy client management if your hard problem is that you have won the work and cannot see the state of it.

And if you genuinely have both problems, be clear about which one is currently costing you more, because the tool that solves the other one will feel like paperwork until it becomes the one you need.

---

*TraceTxn gives agencies and freelancers one searchable record per client — orders, invoices, payments and correspondence in one place. [See how client management works](/client-management), or read about [client management software](/client-management-software).*`,
  },
] as const;
