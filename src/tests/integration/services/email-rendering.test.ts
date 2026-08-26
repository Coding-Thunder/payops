import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stub the one place mail leaves the app so a send can be exercised
 * end-to-end without a transport. Hoisted by Vitest, so it must not
 * close over anything defined later in the file.
 */
const sentMessages: Array<{
  subject: string;
  html: string;
  text?: string;
  attachments?: ReadonlyArray<{ fileName: string; content: Buffer }>;
}> = [];

vi.mock("@/server/email/send", () => ({
  isEmailConfigured: () => true,
  sendEmail: async (msg: {
    subject: string;
    html: string;
    text?: string;
    attachments?: ReadonlyArray<{ fileName: string; content: Buffer }>;
  }) => {
    sentMessages.push(msg);
    return { messageId: "test-message-id", transport: "resend-http", response: "ok" };
  },
  EmailNotConfiguredError: class extends Error {},
}));

import { FileVisibility, ResourceActorType, ResourceSource } from "@/lib/constants/client-resources";
import {
  OrderEvidenceEventType,
  UserRole,
} from "@/lib/constants/enums";
import { OrderEvidenceEventLabel } from "@/lib/constants/labels";
import {
  Customer,
  Order,
  OrderEvidence,
  Organization,
  User,
} from "@/server/db/models";
import { createClientFile } from "@/server/services/client-file.service";
import { createClientLink } from "@/server/services/client-link.service";
import {
  previewComposedEmail,
  sendComposedEmail,
} from "@/server/services/compose-email.service";
import {
  createCustomTemplate,
  getActiveTemplate,
} from "@/server/services/email-template.service";
import { sendCustomTemplateManually } from "@/server/services/email.service";
import { buildComposeContext } from "@/server/services/email-context.service";
import { renderTemplatePreview } from "@/server/services/template-preview.service";
import { buildOrder } from "@/tests/factories";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  sentMessages.length = 0;
});

const PDF = Buffer.from("%PDF-1.7\n proposal");

/** Markers that only ever belong to the Payment Confirmation layout.
 *  If one of these shows up in a Project Update preview, the renderer
 *  picked the wrong template — the exact bug this file guards. */
const PAYMENT_RECEIPT_MARKERS = [
  "payment confirmed",
  "amount paid",
  "payment receipt",
];

/**
 * Branding is provisioned per tenant from the Organization + its owner,
 * and every render path reads it — so a test org needs both rows before
 * a single email can be previewed. Returns the org id.
 */
let orgCounter = 0;
async function seedOrg(): Promise<string> {
  orgCounter += 1;
  const owner = await User.create({
    name: "Yogesh",
    email: `owner-${orgCounter}-${Date.now()}@studio.test`,
    passwordHash: "$2b$12$placeholder.hash.value.for.test.only.do.not.use",
    role: UserRole.SUPER_ADMIN,
  });
  const org = await Organization.create({
    slug: `studio-${orgCounter}-${Date.now().toString(36)}`.slice(0, 32),
    name: "Northwind Studio",
    ownerUserId: owner._id,
  });
  return String(org._id);
}

function ctxFor(orgId: string) {
  return {
    actor: {
      id: new Types.ObjectId().toString(),
      name: "Yogesh",
      email: "yogesh@studio.test",
      role: UserRole.SUPER_ADMIN,
    },
    orgId,
    request: null,
  };
}

async function seedClient(orgId: string) {
  const customer = await Customer.create({
    orgId: new Types.ObjectId(orgId),
    name: "Jane Smith",
    email: "jane@abc.test",
    phone: "",
    company: "ABC Company",
    country: null,
    notes: null,
    tags: [],
  });
  return String(customer._id);
}

async function seedOrder(orgId: string, customerId: string, name: string) {
  const doc = buildOrder({
    lineItems: [
      {
        itemId: null,
        itemTypeKey: "service_visit",
        name,
        description: null,
        quantity: 1,
        unitPrice: 2400,
        total: 2400,
        attributes: {},
        scheduling: null,
      },
    ],
    pricing: { amount: 2400, currency: "USD" as never },
  });
  await Order.create({
    ...doc,
    orgId: new Types.ObjectId(orgId),
    customerId: new Types.ObjectId(customerId),
  });
  return { id: String(doc._id), orderNumber: doc.orderNumber };
}

describe("template preview picks the SELECTED template", () => {
  it("renders a custom template's own copy, never the payment receipt", async () => {
    const orgId = await seedOrg();

    const html = await renderTemplatePreview({
      templateKey: "meeting-time",
      displayName: "Meeting Time",
      draft: {
        subject: "Call on {{meeting_date}}",
        body: "Hi {{client_name}},\n\nCan we talk at {{meeting_time}}?",
      },
      orgId,
    });

    expect(html).toContain("Meeting Time");
    expect(html).toContain("Can we talk at");
    const lower = html.toLowerCase();
    for (const marker of PAYMENT_RECEIPT_MARKERS) {
      expect(lower).not.toContain(marker);
    }
  });

  it("gives two different custom templates two different previews", async () => {
    const orgId = await seedOrg();
    const meeting = await renderTemplatePreview({
      templateKey: "meeting-time",
      displayName: "Meeting Time",
      draft: { subject: "Call", body: "Lets talk on Thursday." },
      orgId,
    });
    const update = await renderTemplatePreview({
      templateKey: "project-update",
      displayName: "Project Update",
      draft: { subject: "Update", body: "Design review is complete." },
      orgId,
    });

    expect(meeting).toContain("Lets talk on Thursday.");
    expect(meeting).not.toContain("Design review is complete.");
    expect(update).toContain("Design review is complete.");
    expect(update).toContain("Project Update");
  });

  it("resolves variables against sample data so no preview shows raw syntax", async () => {
    const orgId = await seedOrg();
    const html = await renderTemplatePreview({
      templateKey: "project-update",
      displayName: "Project Update",
      draft: {
        subject: "Update on {{order_name}}",
        body: "Hello {{client_name}}, {{order_name}} is on track.",
      },
      orgId,
    });

    expect(html).not.toContain("{{client_name}}");
    expect(html).not.toContain("{{order_name}}");
    expect(html).toContain("Jane Smith");
    expect(html).toContain("Website Development");
  });

  it("still renders the order layout for the automated payment emails", async () => {
    const orgId = await seedOrg();
    const confirmation = await renderTemplatePreview({
      templateKey: "payment-confirmation",
      displayName: "Payment Confirmation",
      draft: {},
      orgId,
    });
    // The transactional layout is code-owned and must stay intact.
    const lower = confirmation.toLowerCase();
    expect(PAYMENT_RECEIPT_MARKERS.every((m) => lower.includes(m))).toBe(true);
  });

  it("applies the operator's edits to an automated email's copy slots", async () => {
    const orgId = await seedOrg();
    // Previously the payment-confirmation branch discarded the draft
    // entirely, so typing in the editor changed nothing on screen.
    const html = await renderTemplatePreview({
      templateKey: "payment-confirmation",
      displayName: "Payment Confirmation",
      draft: { greeting: "G'day {{client_name}}," , intro: "Your payment landed." },
      orgId,
    });
    expect(html).toContain("Your payment landed.");
  });

  it("shows guidance rather than a blank pane for an empty new template", async () => {
    const orgId = await seedOrg();
    const html = await renderTemplatePreview({
      templateKey: "draft-template",
      displayName: "New template",
      draft: {},
      orgId,
    });
    expect(html).toContain("Write your email on the left");
  });

  it("renders a legacy template's slot copy when it has no written body", async () => {
    const orgId = await seedOrg();
    const html = await renderTemplatePreview({
      templateKey: "old-reminder",
      displayName: "Payment Reminder",
      draft: { greeting: "Hi there,", intro: "Just a nudge about the invoice." },
      orgId,
    });
    expect(html).toContain("Just a nudge about the invoice.");
  });
});

describe("composed email: the preview IS the email", () => {
  it("sends byte-identical HTML to what the preview rendered", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const order = await seedOrder(orgId, customerId, "Website Development");

    const draft = {
      customerId,
      orderId: order.id,
      subject: "Update on {{order_name}}",
      body: "Hi {{client_name}},\n\n{{project_update}}\n\nThanks,\n{{sender_name}}",
      templateKey: null,
      variables: { project_update: "Both homepage variants are ready." },
      linkIds: [],
      attachmentFileIds: [],
    };

    const preview = await previewComposedEmail(draft, ctx);
    await sendComposedEmail({ ...draft, to: "jane@abc.test" }, ctx);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].html).toBe(preview.html);
    expect(sentMessages[0].subject).toBe(preview.subject);
  });

  it("resolves client and order variables from the tenant's own records", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const order = await seedOrder(orgId, customerId, "Website Development");

    const { html, subject } = await previewComposedEmail(
      {
        customerId,
        orderId: order.id,
        subject: "Update on {{order_name}}",
        body: "Hi {{client_name}} at {{client_company}} — {{order_amount}} is on the invoice.",
        templateKey: null,
        variables: {},
        linkIds: [],
        attachmentFileIds: [],
      },
      ctx,
    );

    expect(subject).toBe("Update on Website Development");
    expect(html).toContain("Jane Smith");
    expect(html).toContain("ABC Company");
    expect(html).toContain("$2,400.00");
  });

  it("ignores browser-supplied values for variables the server owns", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);

    const { html } = await previewComposedEmail(
      {
        customerId,
        orderId: null,
        subject: "Hello",
        body: "Hi {{client_name}}.",
        templateKey: null,
        // A tampered payload trying to put someone else's name in the mail.
        variables: { client_name: "Someone Else" },
        linkIds: [],
        attachmentFileIds: [],
      },
      ctx,
    );

    expect(html).toContain("Jane Smith");
    expect(html).not.toContain("Someone Else");
  });

  it("never leaks unresolved template syntax to the recipient", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);

    // An order-flavoured template sent without an order.
    const { html } = await previewComposedEmail(
      {
        customerId,
        orderId: null,
        subject: "Hello",
        body: "Re {{order_name}} — thanks.",
        templateKey: null,
        variables: {},
        linkIds: [],
        attachmentFileIds: [],
      },
      ctx,
    );

    expect(html).not.toContain("{{order_name}}");
  });

  it("refuses an order that belongs to a different client", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const jane = await seedClient(orgId);
    const other = await Customer.create({
      orgId: new Types.ObjectId(orgId),
      name: "Bob",
      email: "bob@xyz.test",
      phone: "",
      company: null,
      country: null,
      notes: null,
      tags: [],
    });
    const bobsOrder = await seedOrder(orgId, String(other._id), "Bob's Rebrand");

    await expect(
      previewComposedEmail(
        {
          customerId: jane,
          orderId: bobsOrder.id,
          subject: "Hello",
          body: "Hi.",
          templateKey: null,
          variables: {},
          linkIds: [],
          attachmentFileIds: [],
        },
        ctx,
      ),
    ).rejects.toThrow(/different client/i);
  });

  it("carries attachments to the transport and marks them shared", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(
      {
        customerId,
        orderId: null,
        fileName: "Updated Proposal.pdf",
        declaredMimeType: "application/pdf",
        buffer: PDF,
        description: null,
        visibility: FileVisibility.INTERNAL,
        source: ResourceSource.DIRECT_UPLOAD,
        actorType: ResourceActorType.BUSINESS,
      },
      ctx,
    );

    const result = await sendComposedEmail(
      {
        to: "jane@abc.test",
        customerId,
        orderId: null,
        subject: "Proposal",
        body: "Please find the updated proposal attached.",
        templateKey: null,
        variables: {},
        linkIds: [],
        attachmentFileIds: [file.id],
      },
      ctx,
    );

    expect(result.attachmentCount).toBe(1);
    expect(sentMessages[0].attachments?.[0].fileName).toBe("Updated Proposal.pdf");
    expect(sentMessages[0].attachments?.[0].content.equals(PDF)).toBe(true);
  });

  it("records a shared link's provenance without rendering it twice", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const link = await createClientLink(
      {
        customerId,
        orderId: null,
        name: "Final Project Video",
        url: "https://drive.google.com/file/d/abc/view",
        description: null,
      },
      ctx,
    );

    const result = await sendComposedEmail(
      {
        to: "jane@abc.test",
        customerId,
        orderId: null,
        subject: "Your video",
        body: "You can view the final project video here: [Final Project Video](https://drive.google.com/file/d/abc/view)",
        templateKey: null,
        variables: {},
        linkIds: [link.id],
        attachmentFileIds: [],
      },
      ctx,
    );

    expect(result.linkCount).toBe(1);
    const html = sentMessages[0].html;
    // Inserted inline as a real anchor, and only once.
    expect(html).toContain('href="https://drive.google.com/file/d/abc/view"');
    expect(html.split("Final Project Video").length - 1).toBe(1);
  });

  it("renders operator text literally — a body is never treated as HTML", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);

    const { html } = await previewComposedEmail(
      {
        customerId,
        orderId: null,
        subject: "Hello",
        body: "<script>alert(1)</script> and <b>bold</b>",
        templateKey: null,
        variables: {},
        linkIds: [],
        attachmentFileIds: [],
      },
      ctx,
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("refuses to send an empty message", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);

    await expect(
      previewComposedEmail(
        {
          customerId,
          orderId: null,
          subject: "{{order_name}}",
          body: "Hi.",
          templateKey: null,
          variables: {},
          linkIds: [],
          attachmentFileIds: [],
        },
        ctx,
      ),
      // Subject resolves to "" with no order, which is not a subject.
    ).rejects.toThrow(/subject/i);
  });
});

describe("saved template copy survives to the wire", () => {
  it("persists the written body and renders it when the template is sent", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);

    const created = await createCustomTemplate(
      {
        displayName: "Project Update",
        description: null,
        subject: "Update on your project",
        body: "Hello there,\n\nDesign review is complete and the build starts Monday.",
        greeting: null,
        intro: null,
        note: null,
        supportHeadline: null,
        supportDescription: null,
        footerNote: null,
      },
      { actor: ctx.actor, orgId, request: null },
    );

    // Round-trips through Mongo, not just through the create call's return.
    const active = await getActiveTemplate(created.templateKey, orgId);
    expect(active?.body).toContain("Design review is complete");

    await sendCustomTemplateManually(
      { templateKey: created.templateKey, to: "jane@abc.test" },
      { actor: ctx.actor, orgId, source: null, request: null },
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].subject).toBe("Update on your project");
    expect(sentMessages[0].html).toContain("Design review is complete");
    // The operator's name for it, not a title-cased slug.
    expect(sentMessages[0].html).toContain("Project Update");
    // And it is a message, not a receipt.
    expect(sentMessages[0].html).not.toContain("Automated payment receipt");
  });

  it("lets a per-send body override the saved copy without burning a version", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const created = await createCustomTemplate(
      {
        displayName: "Project Update",
        description: null,
        subject: "Saved subject",
        body: "Saved body copy.",
        greeting: null,
        intro: null,
        note: null,
        supportHeadline: null,
        supportDescription: null,
        footerNote: null,
      },
      { actor: ctx.actor, orgId, request: null },
    );

    await sendCustomTemplateManually(
      {
        templateKey: created.templateKey,
        to: "jane@abc.test",
        overrides: { body: "One-off replacement copy." },
      },
      { actor: ctx.actor, orgId, source: null, request: null },
    );

    expect(sentMessages[0].html).toContain("One-off replacement copy.");
    expect(sentMessages[0].html).not.toContain("Saved body copy.");
    // The stored version is untouched.
    const active = await getActiveTemplate(created.templateKey, orgId);
    expect(active?.body).toBe("Saved body copy.");
    expect(active?.version).toBe(1);
  });
});

describe("compose context", () => {
  it("offers custom templates with their copy, and no automated ones", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);

    await createCustomTemplate(
      {
        displayName: "Project Update",
        description: "Weekly progress note.",
        subject: "Update on {{order_name}}",
        body: "Hello {{client_name}},",
        greeting: null,
        intro: null,
        note: null,
        supportHeadline: null,
        supportDescription: null,
        footerNote: null,
      },
      { actor: ctx.actor, orgId, request: null },
    );

    const context = await buildComposeContext({
      orgId,
      customerId,
      actorName: "Yogesh",
    });

    expect(context.templates).toHaveLength(1);
    expect(context.templates[0].displayName).toBe("Project Update");
    expect(context.templates[0].subject).toBe("Update on {{order_name}}");
    expect(context.templates[0].body).toBe("Hello {{client_name}},");
    // Payment Request / Payment Confirmation fire on workflow events;
    // offering them in a free-text composer is what caused the mismatch.
    expect(
      context.templates.some((t) => t.templateKey.startsWith("payment-")),
    ).toBe(false);
  });

  it("knows the client and their orders without being told", async () => {
    const orgId = await seedOrg();
    const customerId = await seedClient(orgId);
    await seedOrder(orgId, customerId, "Website Development");

    const context = await buildComposeContext({
      orgId,
      customerId,
      actorName: "Yogesh",
    });

    expect(context.client.email).toBe("jane@abc.test");
    expect(context.client.company).toBe("ABC Company");
    expect(context.orders[0].label).toBe("Website Development");
  });

  it("derives a template key from the name — operators never invent one", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const base = {
      description: null,
      subject: null,
      body: "Hello.",
      greeting: null,
      intro: null,
      note: null,
      supportHeadline: null,
      supportDescription: null,
      footerNote: null,
    };

    const first = await createCustomTemplate(
      { ...base, displayName: "Project Update" },
      { actor: ctx.actor, orgId, request: null },
    );
    const second = await createCustomTemplate(
      { ...base, displayName: "Project Update" },
      { actor: ctx.actor, orgId, request: null },
    );

    expect(first.templateKey).toBe("project-update");
    // A second template with the same name still gets its own key.
    expect(second.templateKey).toBe("project-update-2");
  });

  it("won't let a derived key collide with a reserved automated one", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const created = await createCustomTemplate(
      {
        displayName: "Payment Request",
        description: null,
        subject: null,
        body: "Hello.",
        greeting: null,
        intro: null,
        note: null,
        supportHeadline: null,
        supportDescription: null,
        footerNote: null,
      },
      { actor: ctx.actor, orgId, request: null },
    );
    expect(created.templateKey).not.toBe("payment-request");
    expect(created.kind).toBe("custom");
  });
});

/**
 * Regression guard for the "payment still appearing" report.
 *
 * There was exactly one evidence event type meaning "an operator emailed the
 * customer about this order" — PAYMENT_REQUEST_EMAIL_SENT, hard-labelled
 * "Payment request email sent" — and three senders reused it. The composer's
 * only gate is `if (built.orderId)`, and the order-detail page passes
 * lockedOrderId unconditionally, so sending a plain "Meeting notes" message
 * stamped the order's evidence chain, the dispute PDF and the outcome panel
 * with a payment request that never happened.
 *
 * The touchpoint itself is worth keeping — a chargeback needs to see that the
 * operator wrote to the customer — so the fix names it honestly rather than
 * dropping it.
 */
describe("a composed message is evidence, but it is not a payment request", () => {
  it("stamps CLIENT_MESSAGE_SENT, never PAYMENT_REQUEST_EMAIL_SENT", async () => {
    const orgId = await seedOrg();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const order = await seedOrder(orgId, customerId, "Brand refresh");

    await sendComposedEmail(
      {
        to: "jane@abc.test",
        customerId,
        orderId: order.id,
        subject: "Notes from today's call",
        body: "Hi Jane,\n\nRecapping what we agreed on the call.",
        templateKey: null,
        variables: {},
        linkIds: [],
        attachmentFileIds: [],
      },
      ctx,
    );

    const rows = await OrderEvidence.find({
      orderId: new Types.ObjectId(order.id),
    })
      .sort({ sequence: 1 })
      .lean();

    // The touchpoint must still exist: losing it would weaken the chain.
    const emailEvents = rows.filter(
      (r) =>
        r.eventType === OrderEvidenceEventType.CLIENT_MESSAGE_SENT ||
        r.eventType === OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT,
    );
    expect(emailEvents).toHaveLength(1);

    // ...and it must not claim a payment request happened.
    expect(emailEvents[0].eventType).toBe(
      OrderEvidenceEventType.CLIENT_MESSAGE_SENT,
    );
    expect(
      rows.map((r) => r.eventType),
    ).not.toContain(OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT);
  });

  it("labels it in words an operator and a bank can both read", () => {
    expect(
      OrderEvidenceEventLabel[OrderEvidenceEventType.CLIENT_MESSAGE_SENT],
    ).toBe("Message sent to client");
    // The payment vocabulary is untouched — the genuine payment-request send
    // still uses it.
    expect(
      OrderEvidenceEventLabel[
        OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT
      ],
    ).toBe("Payment request email sent");
  });
});
