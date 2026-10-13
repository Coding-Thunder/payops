import "server-only";

import { connectMongo } from "@/console/server/db/mongoose";
import { Quotation, Types } from "@/console/server/db/models";
import {
  buildPageResult,
  type Pagination,
  type PageResult,
} from "@/console/server/pagination";
import {
  assertConsoleAdmin,
  getAdminEmail,
} from "@/console/server/auth/session";
import { recordAdminAction } from "@/console/server/audit";

/**
 * General enquiries — the /contact form and the legacy landing/requirements
 * leads. Read-only: this console reviews enquiries, it does not mutate them.
 *
 * ── Why this is source-aware, and why it excludes the waitlist ──────────
 *
 * Every row lives in the same `quotations` collection. `services/waitlist.ts`
 * reads `source: "waitlist"` and `services/metrics.ts` counts it, and both
 * feed beta provisioning. Those must keep meaning exactly what they meant,
 * so this service reads the COMPLEMENT — everything that is not a waitlist
 * entry — rather than widening either of them. Nothing here is added to the
 * waitlist count, and a general enquiry can never be granted beta access.
 *
 * `EXCLUDED_SOURCES` is a denylist on purpose: a source added later shows up
 * here by default, which is the safe direction for a review surface. The one
 * thing that must never leak in is the waitlist.
 */

/** Sources owned by another surface. Keep in step with `services/waitlist.ts`. */
const EXCLUDED_SOURCES = ["waitlist"] as const;

/** Only ever a 24-char hex ObjectId. Anything else is refused before Mongo. */
const OBJECT_ID = /^[a-f0-9]{24}$/i;

export const ENQUIRY_STATUSES = [
  "PENDING",
  "CONTACTED",
  "QUALIFIED",
  "ARCHIVED",
] as const;

export interface EnquiryRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  source: string;
  status: string;
  notificationStatus: string;
  createdAt: string | null;
}

export interface EnquiryDetail extends EnquiryRow {
  message: string | null;
  country: string | null;
  expectedVolume: string | null;
  notificationError: string | null;
}

export interface EnquiryFilters {
  /** Case-insensitive substring over name / email / company. */
  q?: string;
  status?: string;
  source?: string;
}

/** Shape read back from the loosely-typed console schema. */
interface LeanQuotation {
  _id: Types.ObjectId;
  fullName?: string;
  workEmail?: string;
  companyName?: string;
  country?: string;
  expectedVolume?: string;
  useCase?: string;
  status?: string;
  source?: string;
  notificationStatus?: string;
  notificationError?: string | null;
  createdAt?: Date | null;
}

function baseFilter(f: EnquiryFilters = {}): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    source: { $nin: EXCLUDED_SOURCES },
  };

  // A specific source is intersected with the exclusion, never allowed to
  // replace it — otherwise `?source=waitlist` would read the waitlist.
  if (f.source && !EXCLUDED_SOURCES.includes(f.source as "waitlist")) {
    filter.source = f.source;
  }
  if (f.status && (ENQUIRY_STATUSES as readonly string[]).includes(f.status)) {
    filter.status = f.status;
  }
  if (f.q && f.q.trim()) {
    // Escaped: a search box must not be able to inject a regex (or a
    // catastrophic one). Bounded length keeps the scan cheap.
    const safe = f.q.trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    filter.$or = [{ fullName: rx }, { workEmail: rx }, { companyName: rx }];
  }
  return filter;
}

function toRow(d: LeanQuotation): EnquiryRow {
  return {
    id: String(d._id),
    name: d.fullName ?? "",
    email: d.workEmail ?? "",
    company: d.companyName ?? null,
    source: d.source ?? "—",
    status: d.status ?? "PENDING",
    notificationStatus: d.notificationStatus ?? "—",
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  };
}

export async function listEnquiries(
  p: Pagination,
  f: EnquiryFilters = {},
): Promise<PageResult<EnquiryRow>> {
  await assertConsoleAdmin();
  await connectMongo();
  const filter = baseFilter(f);
  const [docs, total] = await Promise.all([
    Quotation.find(filter)
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean<LeanQuotation[]>(),
    Quotation.countDocuments(filter),
  ]);
  return buildPageResult(docs.map(toRow), total, p);
}

/**
 * One enquiry, including its free-text message.
 *
 * Audited: this is the only read in the console that returns a visitor's
 * written words alongside their email, so who opened it is worth recording.
 * The audit row carries the enquiry id and nothing from the enquiry itself —
 * an audit log is not a second copy of the PII it is protecting.
 */
export async function getEnquiry(id: string): Promise<EnquiryDetail | null> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!OBJECT_ID.test(id)) return null;

  const doc = await Quotation.findOne({
    _id: new Types.ObjectId(id),
    // Scoped the same way as the list, so a waitlist id cannot be opened
    // through this route by guessing it.
    source: { $nin: EXCLUDED_SOURCES },
  }).lean<LeanQuotation>();
  if (!doc) return null;

  await recordAdminAction({
    action: "enquiry.detail.view",
    actorEmail: (await getAdminEmail()) ?? "unknown",
    targetType: "quotation",
    targetId: String(doc._id),
  });

  return {
    ...toRow(doc),
    message: doc.useCase ?? null,
    country: doc.country ?? null,
    expectedVolume: doc.expectedVolume ?? null,
    notificationError: doc.notificationError ?? null,
  };
}
