import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverViaResend } from "@/server/email/resend";

afterEach(() => {
  vi.restoreAllMocks();
});

const payload = {
  from: "TraceTxn <no-reply@tracetxn.com>",
  to: "customer@example.com",
  replyTo: "support@tracetxn.com",
  subject: "Complete your payment",
  html: "<p>hello</p>",
  text: "hello",
  kind: "PAYMENT_LINK",
};

describe("deliverViaResend", () => {
  it("POSTs to the Resend API and returns the message id on success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "e-123" }), { status: 200 }),
      );

    const result = await deliverViaResend("re_test_key", payload);
    expect(result).toEqual({ id: "e-123" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toBe("customer@example.com");
    expect(body.reply_to).toBe("support@tracetxn.com");
    // A timeout signal is attached so the send can never hang the request.
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("throws a classifiable error (responseCode/response) on a non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("validation failed", { status: 422 }),
    );

    await expect(deliverViaResend("re_test_key", payload)).rejects.toMatchObject(
      { responseCode: 422 },
    );
  });
});
