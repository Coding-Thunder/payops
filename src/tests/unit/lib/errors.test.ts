import { describe, expect, it } from "vitest";

import {
  AppError,
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  PaymentError,
  UnauthorizedError,
  ValidationError,
  isAppError,
} from "@/lib/errors";

describe("AppError hierarchy", () => {
  it.each([
    [new BadRequestError(), 400, "BAD_REQUEST"],
    [new UnauthorizedError(), 401, "UNAUTHORIZED"],
    [new ForbiddenError(), 403, "FORBIDDEN"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ConflictError(), 409, "CONFLICT"],
    [new ValidationError(), 422, "VALIDATION_ERROR"],
    [new PaymentError(), 502, "PAYMENT_ERROR"],
    [new ExternalServiceError(), 502, "EXTERNAL_SERVICE_ERROR"],
  ])("%s maps to %i / %s", (err, status, code) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(status);
    expect(err.code).toBe(code);
  });

  it("isAppError narrows correctly", () => {
    expect(isAppError(new ValidationError())).toBe(true);
    expect(isAppError(new Error("regular"))).toBe(false);
    expect(isAppError({ code: "x" })).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it("ValidationError carries details", () => {
    const err = new ValidationError("bad", { field: "email" });
    expect(err.details).toEqual({ field: "email" });
  });

  it("PaymentError preserves the cause for upstream logging", () => {
    const cause = new Error("stripe blew up");
    const err = new PaymentError("payment failed", cause);
    expect(err.cause).toBe(cause);
  });
});
