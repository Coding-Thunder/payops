import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import {
  FileVisibility,
  ResourceActorType,
  ResourceSource,
} from "@/lib/constants/client-resources";
import { UserRole } from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { ClientFile, Customer, Order } from "@/server/db/models";
import {
  countClientFiles,
  createClientFile,
  deleteClientFile,
  listClientFiles,
  loadAttachments,
  markFilesEmailed,
  readClientFile,
  updateClientFile,
} from "@/server/services/client-file.service";
import {
  createClientLink,
  deleteClientLink,
  listClientLinks,
  loadLinksForEmail,
  markLinksEmailed,
  updateClientLink,
} from "@/server/services/client-link.service";
import { getClientTimeline } from "@/server/services/client-profile.service";
import { connectMongo, disconnectMongo } from "@/server/db/mongoose";
import { buildOrder } from "@/tests/factories";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Files & Links: the relationship model.
 *
 * The load-bearing property under test is "one row, two views" — a file
 * related to an order must appear in BOTH Order Files and Client Files
 * without being duplicated. Everything else here guards the boundaries
 * that make that safe: tenant isolation, the cross-client order check,
 * the upload allow-list, and the size cap that routes big files to Links.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

const PDF = Buffer.from("%PDF-1.7\n one page of proposal");
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);

function ctxFor(orgId: string) {
  return {
    actor: {
      id: new Types.ObjectId().toString(),
      name: "Yogesh",
      role: UserRole.SUPER_ADMIN,
    },
    orgId,
    request: null,
  };
}

async function seedClient(orgId: string, email = "jane@abc.test") {
  const customer = await Customer.create({
    orgId: new Types.ObjectId(orgId),
    name: "Jane Smith",
    email,
    phone: "",
    company: "ABC Company",
    country: null,
    notes: null,
    tags: [],
  });
  return String(customer._id);
}

/** `buildOrder` shapes the order body but doesn't carry the tenant or
 *  client pointers, so both are stamped here — they're exactly the two
 *  fields these tests are about. */
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
  });
  await Order.create({
    ...doc,
    orgId: new Types.ObjectId(orgId),
    customerId: new Types.ObjectId(customerId),
  });
  return { id: String(doc._id), orderNumber: doc.orderNumber };
}

function fileArgs(overrides: Partial<Parameters<typeof createClientFile>[0]> = {}) {
  return {
    customerId: "",
    orderId: null,
    fileName: "Proposal.pdf",
    declaredMimeType: "application/pdf",
    buffer: PDF,
    description: null,
    visibility: FileVisibility.INTERNAL,
    source: ResourceSource.DIRECT_UPLOAD,
    actorType: ResourceActorType.BUSINESS,
    ...overrides,
  } as Parameters<typeof createClientFile>[0];
}

describe("one file, two contextual views", () => {
  it("shows an order-related file in Order Files AND Client Files, stored once", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const website = await seedOrder(orgId, customerId, "Website Development");

    const created = await createClientFile(
      fileArgs({ customerId, orderId: website.id }),
      ctx,
    );

    const orderView = await listClientFiles({ orderId: website.id }, orgId);
    const clientView = await listClientFiles({ customerId }, orgId);

    expect(orderView.map((f) => f.id)).toEqual([created.id]);
    expect(clientView.map((f) => f.id)).toEqual([created.id]);
    // The whole point: the two views are filters, not copies.
    expect(await ClientFile.countDocuments({})).toBe(1);
    expect(orderView[0].orderNumber).toBe(website.orderNumber);
  });

  it("scopes Order Files to that order only", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const website = await seedOrder(orgId, customerId, "Website Development");
    const seo = await seedOrder(orgId, customerId, "SEO Retainer");

    await createClientFile(
      fileArgs({ customerId, orderId: website.id, fileName: "Website spec.pdf" }),
      ctx,
    );
    await createClientFile(
      fileArgs({ customerId, orderId: seo.id, fileName: "SEO audit.pdf" }),
      ctx,
    );
    await createClientFile(
      fileArgs({ customerId, fileName: "Master contract.pdf" }),
      ctx,
    );

    const websiteFiles = await listClientFiles({ orderId: website.id }, orgId);
    expect(websiteFiles.map((f) => f.fileName)).toEqual(["Website spec.pdf"]);

    // Client Files is the union — including the file tied to no order.
    const all = await listClientFiles({ customerId }, orgId);
    expect(all.map((f) => f.fileName).sort()).toEqual([
      "Master contract.pdf",
      "SEO audit.pdf",
      "Website spec.pdf",
    ]);
  });

  it("MOVES a file between order views on re-relate — it never copies", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const website = await seedOrder(orgId, customerId, "Website Development");
    const branding = await seedOrder(orgId, customerId, "Branding Project");

    const file = await createClientFile(
      fileArgs({ customerId, orderId: website.id }),
      ctx,
    );
    const moved = await updateClientFile(file.id, { orderId: branding.id }, ctx);

    expect(moved.orderNumber).toBe(branding.orderNumber);
    expect(await listClientFiles({ orderId: website.id }, orgId)).toHaveLength(0);
    expect(await listClientFiles({ orderId: branding.id }, orgId)).toHaveLength(1);
    expect(await ClientFile.countDocuments({})).toBe(1);
  });
});

describe("upload guards", () => {
  it("refuses a file over the 25 MB cap, and says to use a link instead", async () => {
    const orgId = new Types.ObjectId().toString();
    const customerId = await seedClient(orgId);
    const huge = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);

    await expect(
      createClientFile(fileArgs({ customerId, buffer: huge }), ctxFor(orgId)),
    ).rejects.toThrow(/larger than the direct upload limit[\s\S]*link/i);
  });

  it("refuses formats that belong in Links", async () => {
    const orgId = new Types.ObjectId().toString();
    const customerId = await seedClient(orgId);
    await expect(
      createClientFile(
        fileArgs({ customerId, fileName: "final-cut.mp4", buffer: PDF }),
        ctxFor(orgId),
      ),
    ).rejects.toThrow(/\.mp4 files aren't supported/i);
  });

  it("refuses a file whose bytes don't match its extension", async () => {
    const orgId = new Types.ObjectId().toString();
    const customerId = await seedClient(orgId);
    await expect(
      createClientFile(
        fileArgs({ customerId, fileName: "invoice.pdf", buffer: PNG }),
        ctxFor(orgId),
      ),
    ).rejects.toThrow(/doesn't look like a real \.pdf/i);
  });

  it("refuses an empty file", async () => {
    const orgId = new Types.ObjectId().toString();
    const customerId = await seedClient(orgId);
    await expect(
      createClientFile(
        fileArgs({ customerId, buffer: Buffer.alloc(0) }),
        ctxFor(orgId),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("stores the allow-list's canonical MIME type, not the browser's claim", async () => {
    const orgId = new Types.ObjectId().toString();
    const customerId = await seedClient(orgId);
    // A hostile client declaring text/html must not get it echoed back
    // by the download route.
    const file = await createClientFile(
      fileArgs({ customerId, declaredMimeType: "text/html" }),
      ctxFor(orgId),
    );
    expect(file.mimeType).toBe("application/pdf");
  });
});

describe("tenant + client boundaries", () => {
  it("won't file a document against another tenant's client", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    const customerA = await seedClient(orgA);

    await expect(
      createClientFile(fileArgs({ customerId: customerA }), ctxFor(orgB)),
    ).rejects.toThrow(NotFoundError);
  });

  it("won't file a document against an order belonging to a different client", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const jane = await seedClient(orgId, "jane@abc.test");
    const bob = await seedClient(orgId, "bob@xyz.test");
    const bobsOrder = await seedOrder(orgId, bob, "Bob's Rebrand");

    await expect(
      createClientFile(
        fileArgs({ customerId: jane, orderId: bobsOrder.id }),
        ctx,
      ),
    ).rejects.toThrow(/different client/i);
  });

  it("hides another tenant's files from every read path", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    const customerA = await seedClient(orgA);
    const file = await createClientFile(
      fileArgs({ customerId: customerA }),
      ctxFor(orgA),
    );

    expect(await listClientFiles({ customerId: customerA }, orgB)).toHaveLength(0);
    await expect(readClientFile(file.id, orgB)).rejects.toThrow(NotFoundError);
    await expect(
      loadAttachments([file.id], orgB, customerA),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("cross-client and cross-tenant mutation guards", () => {
  it("refuses to attach one client's file to another client's email", async () => {
    // Both clients belong to the SAME tenant, so an org-only check would
    // wave this through — and then stamp Bob's contract "sent via email"
    // on Bob's timeline while it landed in Jane's inbox.
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const jane = await seedClient(orgId, "jane@abc.test");
    const bob = await seedClient(orgId, "bob@xyz.test");
    const bobsFile = await createClientFile(
      fileArgs({ customerId: bob, fileName: "Bobs contract.pdf" }),
      ctx,
    );

    await expect(
      loadAttachments([bobsFile.id], orgId, jane),
    ).rejects.toThrow(NotFoundError);

    // Still reachable for the client it actually belongs to.
    const [ok] = await loadAttachments([bobsFile.id], orgId, bob);
    expect(ok.fileName).toBe("Bobs contract.pdf");
  });

  it("refuses to share one client's link into another client's email", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const jane = await seedClient(orgId, "jane@abc.test");
    const bob = await seedClient(orgId, "bob@xyz.test");
    const bobsLink = await createClientLink(
      {
        customerId: bob,
        orderId: null,
        name: "Bobs private folder",
        url: "https://drive.google.com/drive/folders/bob",
        description: null,
      },
      ctx,
    );

    await expect(
      loadLinksForEmail([bobsLink.id], orgId, jane),
    ).rejects.toThrow(NotFoundError);
    expect(await loadLinksForEmail([bobsLink.id], orgId, bob)).toHaveLength(1);
  });

  it("refuses cross-tenant edits and deletes of a file", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    const customerA = await seedClient(orgA);
    const file = await createClientFile(
      fileArgs({ customerId: customerA }),
      ctxFor(orgA),
    );

    await expect(
      updateClientFile(file.id, { description: "hijacked" }, ctxFor(orgB)),
    ).rejects.toThrow(NotFoundError);
    await expect(deleteClientFile(file.id, ctxFor(orgB))).rejects.toThrow(
      NotFoundError,
    );

    // Untouched for its real owner.
    const [still] = await listClientFiles({ customerId: customerA }, orgA);
    expect(still.description).toBeNull();
  });

  it("refuses cross-tenant edits and deletes of a link", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    const customerA = await seedClient(orgA);
    const link = await createClientLink(
      {
        customerId: customerA,
        orderId: null,
        name: "Deliverables",
        url: "https://drive.google.com/drive/folders/x",
        description: null,
      },
      ctxFor(orgA),
    );

    await expect(
      updateClientLink(link.id, { name: "hijacked" }, ctxFor(orgB)),
    ).rejects.toThrow(NotFoundError);
    await expect(deleteClientLink(link.id, ctxFor(orgB))).rejects.toThrow(
      NotFoundError,
    );
    expect(await listClientLinks({ customerId: customerA }, orgA)).toHaveLength(1);
  });

  it("requires a client — a file with no client has no context", async () => {
    const orgId = new Types.ObjectId().toString();
    await expect(
      createClientFile(
        fileArgs({ customerId: new Types.ObjectId().toString() }),
        ctxFor(orgId),
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("filters", () => {
  it("separates shared, internal, order-related and emailed files", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const order = await seedOrder(orgId, customerId, "Website Development");

    const internal = await createClientFile(
      fileArgs({ customerId, fileName: "Working notes.txt", buffer: Buffer.from("wip") }),
      ctx,
    );
    const shared = await createClientFile(
      fileArgs({
        customerId,
        fileName: "Contract.pdf",
        visibility: FileVisibility.SHARED,
      }),
      ctx,
    );
    const onOrder = await createClientFile(
      fileArgs({ customerId, orderId: order.id, fileName: "Spec.pdf" }),
      ctx,
    );

    const byFilter = async (filter: Parameters<typeof listClientFiles>[0]["filter"]) =>
      (await listClientFiles({ customerId, filter }, orgId)).map((f) => f.id);

    expect(await byFilter("internal")).toEqual(
      expect.arrayContaining([internal.id, onOrder.id]),
    );
    expect(await byFilter("shared")).toEqual([shared.id]);
    expect(await byFilter("order")).toEqual([onOrder.id]);
    expect(await byFilter("email")).toEqual([]);

    await markFilesEmailed([shared.id], ctx);
    expect(await byFilter("email")).toEqual([shared.id]);
  });

  it("searches by file name, case-insensitively", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    await createClientFile(fileArgs({ customerId, fileName: "Updated Proposal.pdf" }), ctx);
    await createClientFile(fileArgs({ customerId, fileName: "Contract.pdf" }), ctx);

    const hits = await listClientFiles({ customerId, q: "proposal" }, orgId);
    expect(hits.map((f) => f.fileName)).toEqual(["Updated Proposal.pdf"]);
  });

  it("treats a regex-shaped search term as literal text", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    await createClientFile(fileArgs({ customerId, fileName: "Contract.pdf" }), ctx);

    // Unescaped, `.*` would match everything.
    expect(await listClientFiles({ customerId, q: ".*" }, orgId)).toHaveLength(0);
  });
});

describe("email provenance", () => {
  it("marks attached files as shared with the client after a send", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(fileArgs({ customerId }), ctx);
    expect(file.visibility).toBe("INTERNAL");

    await markFilesEmailed([file.id], ctx);

    const [after] = await listClientFiles({ customerId }, orgId);
    // A document sitting in the client's inbox is not "internal".
    expect(after.visibility).toBe("SHARED");
    expect(after.lastEmailedAt).not.toBeNull();
    expect(after.emailSendCount).toBe(1);
  });

  it("keeps the FIRST share moment across re-sends", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(fileArgs({ customerId }), ctx);

    await markFilesEmailed([file.id], ctx);
    const first = (await listClientFiles({ customerId }, orgId))[0]
      .sharedWithClientAt;

    await markFilesEmailed([file.id], ctx);
    const second = (await listClientFiles({ customerId }, orgId))[0];

    expect(second.sharedWithClientAt).toBe(first);
    expect(second.emailSendCount).toBe(2);
  });

  it("returns attachment bytes intact for the mail transport", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(fileArgs({ customerId }), ctx);

    const [attachment] = await loadAttachments([file.id], orgId, customerId);
    expect(attachment.fileName).toBe("Proposal.pdf");
    expect(attachment.bytes.equals(PDF)).toBe(true);
  });
});

describe("durability", () => {
  it("keeps the bytes across an application restart", async () => {
    // The whole reason bytes live in GridFS rather than on disk: the
    // platform filesystem is ephemeral, so anything written to `public/`
    // is gone on the next deploy and invisible to a second instance.
    // Tear the connection down and re-dial to prove the bytes are in the
    // database, not in this process.
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(
      fileArgs({ customerId, fileName: "Contract.pdf" }),
      ctx,
    );

    await disconnectMongo();
    await connectMongo();

    const { file: reread, bytes } = await readClientFile(file.id, orgId);
    expect(reread.fileName).toBe("Contract.pdf");
    expect(bytes.equals(PDF)).toBe(true);
  });

  it("stores the bytes in the client_files GridFS bucket", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    await createClientFile(fileArgs({ customerId }), ctx);

    // Upload and download must address the SAME bucket; asserting the
    // literal collection names is what pins that down.
    const conn = await connectMongo();
    const names = (await conn.connection.db!.listCollections().toArray()).map(
      (c) => c.name,
    );
    expect(names).toContain("client_files.files");
    expect(names).toContain("client_files.chunks");

    const stored = await conn.connection.db!
      .collection("client_files.chunks")
      .countDocuments({});
    expect(stored).toBeGreaterThan(0);
  });

  it("leaves no orphaned chunks when the metadata write fails", async () => {
    // An unreachable blob is pure cost — nothing can ever point at it.
    // The failure has to land AFTER putBytes for this to mean anything,
    // so it comes from a field the service passes through unvalidated
    // (the route caps description at 1000; the model rejects past it).
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const conn = await connectMongo();

    await expect(
      createClientFile(
        fileArgs({ customerId, description: "x".repeat(2000) }),
        ctx,
      ),
    ).rejects.toThrow(/description/i);

    // Bytes were written and then rolled back, so the bucket is empty
    // AND no metadata row survives to point at anything.
    const chunks = await conn.connection.db!
      .collection("client_files.chunks")
      .countDocuments({});
    expect(chunks).toBe(0);
    expect(await ClientFile.countDocuments({})).toBe(0);
  });
});

describe("delete", () => {
  it("removes the file from every list and makes the bytes unreadable", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(fileArgs({ customerId }), ctx);

    await deleteClientFile(file.id, ctx);

    expect(await listClientFiles({ customerId }, orgId)).toHaveLength(0);
    expect(await countClientFiles(orgId, customerId)).toBe(0);
    await expect(readClientFile(file.id, orgId)).rejects.toThrow(NotFoundError);
  });

  it("keeps the Timeline record — deleting a file doesn't un-share it", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(
      fileArgs({ customerId, fileName: "requirements.pdf" }),
      ctx,
    );
    await deleteClientFile(file.id, ctx);

    const timeline = await getClientTimeline(orgId, customerId);
    expect(
      timeline.some(
        (e) => e.category === "file" && e.title.includes("requirements.pdf"),
      ),
    ).toBe(true);
  });
});

describe("links", () => {
  it("normalises the URL and derives the source from it", async () => {
    const orgId = new Types.ObjectId().toString();
    const customerId = await seedClient(orgId);
    const link = await createClientLink(
      {
        customerId,
        orderId: null,
        name: "Final Project Video",
        url: "drive.google.com/file/d/abc/view",
        description: "Final edited video shared with the client.",
      },
      ctxFor(orgId),
    );

    expect(link.url).toBe("https://drive.google.com/file/d/abc/view");
    expect(link.host).toBe("drive.google.com");
    expect(link.source).toBe("Google Drive");
  });

  it("refuses a URL that would become a dangerous href", async () => {
    const orgId = new Types.ObjectId().toString();
    const customerId = await seedClient(orgId);
    await expect(
      createClientLink(
        {
          customerId,
          orderId: null,
          name: "Nope",
          url: "javascript:alert(1)",
          description: null,
        },
        ctxFor(orgId),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("surfaces one link in both the order view and the client view", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const order = await seedOrder(orgId, customerId, "Website Development");

    const link = await createClientLink(
      {
        customerId,
        orderId: order.id,
        name: "Deliverables folder",
        url: "https://drive.google.com/drive/folders/x",
        description: null,
      },
      ctx,
    );

    expect((await listClientLinks({ orderId: order.id }, orgId)).map((l) => l.id)).toEqual([
      link.id,
    ]);
    expect((await listClientLinks({ customerId }, orgId)).map((l) => l.id)).toEqual([
      link.id,
    ]);
  });

  it("preserves the operator's chosen order when loading for an email", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const first = await createClientLink(
      { customerId, orderId: null, name: "A", url: "https://a.example.com", description: null },
      ctx,
    );
    const second = await createClientLink(
      { customerId, orderId: null, name: "B", url: "https://b.example.com", description: null },
      ctx,
    );

    const loaded = await loadLinksForEmail(
      [second.id, first.id],
      orgId,
      customerId,
    );
    expect(loaded.map((l) => l.name)).toEqual(["B", "A"]);
  });

  it("stamps shared-via-email provenance", async () => {
    const orgId = new Types.ObjectId().toString();
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

    await markLinksEmailed([link.id], ctx);

    const emailed = await listClientLinks({ customerId, filter: "email" }, orgId);
    expect(emailed.map((l) => l.id)).toEqual([link.id]);
  });

  it("re-validates the URL on edit", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const link = await createClientLink(
      { customerId, orderId: null, name: "A", url: "https://a.example.com", description: null },
      ctx,
    );

    const updated = await updateClientLink(
      link.id,
      { url: "https://www.dropbox.com/s/xyz" },
      ctx,
    );
    expect(updated.source).toBe("Dropbox");

    await expect(
      updateClientLink(link.id, { url: "not a url" }, ctx),
    ).rejects.toThrow(ValidationError);
  });
});

describe("timeline", () => {
  it("records upload, share, and email as distinct moments", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    const file = await createClientFile(
      fileArgs({ customerId, fileName: "proposal.pdf" }),
      ctx,
    );
    await markFilesEmailed([file.id], ctx);

    const timeline = await getClientTimeline(orgId, customerId);
    const fileEvents = timeline.filter((e) => e.category === "file");

    expect(fileEvents.map((e) => e.kind).sort()).toEqual([
      "file.added",
      "file.emailed",
    ]);
    expect(fileEvents.find((e) => e.kind === "file.added")!.title).toBe(
      "Yogesh uploaded proposal.pdf",
    );
    expect(fileEvents.find((e) => e.kind === "file.emailed")!.title).toBe(
      "proposal.pdf sent via email",
    );
  });

  it("does not double-report a file uploaded as already shared", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    await createClientFile(
      fileArgs({ customerId, visibility: FileVisibility.SHARED }),
      ctx,
    );

    const timeline = await getClientTimeline(orgId, customerId);
    // "Added" and "shared" happen in the same request; that's one event.
    expect(timeline.filter((e) => e.category === "file")).toHaveLength(1);
  });

  it("attributes a client-provided file to the client, naming who saved it", async () => {
    const orgId = new Types.ObjectId().toString();
    const ctx = ctxFor(orgId);
    const customerId = await seedClient(orgId);
    await createClientFile(
      fileArgs({
        customerId,
        fileName: "brand-assets.png",
        buffer: PNG,
        source: ResourceSource.CLIENT_UPLOAD,
        actorType: ResourceActorType.CLIENT,
      }),
      ctx,
    );

    const [event] = (await getClientTimeline(orgId, customerId)).filter(
      (e) => e.category === "file",
    );
    expect(event.title).toBe("Client uploaded brand-assets.png");
    expect(event.detail).toContain("saved by Yogesh");
  });

  it("records links added and shared", async () => {
    const orgId = new Types.ObjectId().toString();
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
    await markLinksEmailed([link.id], ctx);

    const events = (await getClientTimeline(orgId, customerId)).filter(
      (e) => e.category === "link",
    );
    expect(events.map((e) => e.title).sort()).toEqual([
      "Final Project Video link shared with the client via email",
      "Yogesh added a link: Final Project Video",
    ]);
  });
});
