import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { GET as lookup } from "@/app/api/customers/lookup/route";
import { upsertCustomerFromOrder } from "@/server/services/customer.service";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;
let session: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  headers = await mockNextHeaders();
});

afterEach(async () => {
  await headers.restore();
  if (session) {
    session.restore();
    session = null;
  }
});

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
}

async function readData<T>(
  res: Response,
): Promise<{ status: number; data: T | undefined }> {
  const { status, body } = await jsonBody<ApiEnvelope<T>>(res);
  return { status, data: body.data };
}

describe("GET /api/customers/lookup", () => {
  it("returns the saved customer for the actor's org", async () => {
    session = await mockSession(actorFor(UserRole.STAFF));
    await upsertCustomerFromOrder(session.user.orgId!, {
      name: "Casey Repeat",
      email: "casey@example.com",
      phone: "+15555550100",
    });

    const res = await lookup(
      buildRequest(
        "/api/customers/lookup?email=casey%40example.com",
        { method: "GET" },
      ),
    );
    const { status, data } = await readData<{
      customer: { name: string; phone: string } | null;
    }>(res);
    expect(status).toBe(200);
    expect(data?.customer?.name).toBe("Casey Repeat");
    expect(data?.customer?.phone).toBe("+15555550100");
  });

  it("returns null when no match exists", async () => {
    session = await mockSession(actorFor(UserRole.STAFF));
    const res = await lookup(
      buildRequest("/api/customers/lookup?email=nobody%40example.com", {
        method: "GET",
      }),
    );
    const { data } = await readData<{ customer: unknown }>(res);
    expect(data?.customer).toBeNull();
  });

  it("does not surface another org's customer", async () => {
    // Org A saves a customer.
    const orgASession = await mockSession(actorFor(UserRole.STAFF));
    await upsertCustomerFromOrder(orgASession.user.orgId!, {
      name: "A's customer",
      email: "shared@example.com",
      phone: "+15555550100",
    });
    orgASession.restore();

    // Org B looks up the same email.
    session = await mockSession(actorFor(UserRole.STAFF));
    const res = await lookup(
      buildRequest("/api/customers/lookup?email=shared%40example.com", {
        method: "GET",
      }),
    );
    const { data } = await readData<{ customer: unknown }>(res);
    expect(data?.customer).toBeNull();
  });
});
