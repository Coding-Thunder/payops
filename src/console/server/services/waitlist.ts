import "server-only";

import { connectMongo } from "@/console/server/db/mongoose";
import { Quotation, Types } from "@/console/server/db/models";
import {
  buildPageResult,
  type Pagination,
  type PageResult,
} from "@/console/server/pagination";

export interface WaitlistRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  useCase: string | null;
  status: string;
  granted: boolean;
  grantedAt: string | null;
  createdAt: string | null;
}

export async function listWaitlist(
  p: Pagination,
): Promise<PageResult<WaitlistRow>> {
  await connectMongo();
  const filter: Record<string, unknown> = { source: "waitlist" };
  const [docs, total] = await Promise.all([
    Quotation.find(filter)
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean<
        {
          _id: Types.ObjectId;
          fullName?: string;
          workEmail?: string;
          companyName?: string;
          useCase?: string;
          status: string;
          grantedAt?: Date | null;
          createdAt?: Date | null;
        }[]
      >(),
    Quotation.countDocuments(filter),
  ]);

  const items: WaitlistRow[] = docs.map((d) => ({
    id: String(d._id),
    name: d.fullName ?? "",
    email: d.workEmail ?? "",
    company: d.companyName ?? null,
    useCase: d.useCase ?? null,
    status: d.status,
    granted: Boolean(d.grantedAt),
    grantedAt: d.grantedAt ? new Date(d.grantedAt).toISOString() : null,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  }));

  return buildPageResult(items, total, p);
}
