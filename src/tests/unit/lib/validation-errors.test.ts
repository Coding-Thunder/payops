import { describe, expect, it } from "vitest";

import { ApiClientError } from "@/lib/api-client";
import {
  describeApiError,
  fieldIssuesFrom,
  humanizePath,
} from "@/lib/validation-errors";

function validationError(issues: unknown): ApiClientError {
  return new ApiClientError(422, {
    code: "VALIDATION_ERROR",
    message: "Invalid request data",
    details: { issues },
  });
}

describe("humanizePath", () => {
  it("titles a simple nested path", () => {
    expect(humanizePath("customer.email")).toBe("Customer Email");
  });

  it("renders array indices as 1-based #n", () => {
    expect(humanizePath("lineItems.0.name")).toBe("Line Items #1 Name");
    expect(humanizePath("lineItems.2.unitPrice")).toBe(
      "Line Items #3 Unit Price",
    );
  });

  it("splits camelCase and snake/kebab segments", () => {
    expect(humanizePath("scheduling.endsAt")).toBe("Scheduling Ends At");
    expect(humanizePath("some_snake_field")).toBe("Some Snake Field");
  });

  it("labels a root-level issue", () => {
    expect(humanizePath("")).toBe("This form");
  });
});

describe("fieldIssuesFrom", () => {
  it("extracts issues from a 422 VALIDATION_ERROR envelope", () => {
    const issues = fieldIssuesFrom(
      validationError([
        { path: "customer.email", message: "Invalid email", code: "invalid_string" },
        { path: "lineItems.0.quantity", message: "Too small", code: "too_small" },
      ]),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      path: "customer.email",
      label: "Customer Email",
      message: "Invalid email",
      code: "invalid_string",
    });
    expect(issues[1].label).toBe("Line Items #1 Quantity");
  });

  it("returns [] for a non-ApiClientError", () => {
    expect(fieldIssuesFrom(new Error("boom"))).toEqual([]);
    expect(fieldIssuesFrom(null)).toEqual([]);
  });

  it("returns [] when the code is not VALIDATION_ERROR", () => {
    const err = new ApiClientError(409, {
      code: "CONFLICT",
      message: "Conflict",
      details: { issues: [{ path: "x", message: "y" }] },
    });
    expect(fieldIssuesFrom(err)).toEqual([]);
  });

  it("returns [] when details.issues is missing or not an array", () => {
    expect(fieldIssuesFrom(validationError(undefined))).toEqual([]);
    expect(fieldIssuesFrom(validationError("nope"))).toEqual([]);
  });

  it("drops malformed issue entries and defaults a missing message", () => {
    const issues = fieldIssuesFrom(
      validationError([null, "bad", { path: "pricing.amount" }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: "pricing.amount",
      label: "Pricing Amount",
      message: "Invalid value",
    });
  });
});

describe("describeApiError", () => {
  it("returns a heading + issues for a 422 with field issues", () => {
    const { message, issues } = describeApiError(
      validationError([{ path: "customer.email", message: "Invalid email" }]),
      "Could not create order",
    );
    expect(message).toBe("Please fix the following:");
    expect(issues).toHaveLength(1);
    expect(issues[0].label).toBe("Customer Email");
  });

  it("returns the ApiClientError message (no issues) for a non-422", () => {
    const err = new ApiClientError(409, {
      code: "CONFLICT",
      message: "That email already exists.",
    });
    expect(describeApiError(err, "fallback")).toEqual({
      message: "That email already exists.",
      issues: [],
    });
  });

  it("falls back for a non-API error (e.g. network)", () => {
    expect(describeApiError(new Error("offline"), "Could not save item")).toEqual(
      { message: "Could not save item", issues: [] },
    );
  });
});
