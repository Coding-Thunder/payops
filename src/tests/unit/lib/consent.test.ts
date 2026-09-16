import { describe, expect, it } from "vitest";

import { hasCustomerConsent } from "@/lib/consent";
import { ConsentStatus } from "@/lib/constants/enums";

describe("hasCustomerConsent", () => {
  it("counts a hosted-page confirmation (VERIFIED)", () => {
    expect(hasCustomerConsent(ConsentStatus.VERIFIED)).toBe(true);
  });

  it("counts a recorded reply awaiting review (RECEIVED)", () => {
    expect(hasCustomerConsent(ConsentStatus.RECEIVED)).toBe(true);
  });

  it("does not count a request the customer has not answered", () => {
    expect(hasCustomerConsent(ConsentStatus.REQUESTED)).toBe(false);
    expect(hasCustomerConsent(ConsentStatus.NOT_REQUESTED)).toBe(false);
    expect(hasCustomerConsent(undefined)).toBe(false);
    expect(hasCustomerConsent(null)).toBe(false);
  });
});
