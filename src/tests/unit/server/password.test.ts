// @vitest-environment node

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/server/auth/password";

describe("password hashing", () => {
  it("hashes a strong password and verifies it round-trip", async () => {
    const hash = await hashPassword("Hunter2Hunter2");
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    await expect(verifyPassword("Hunter2Hunter2", hash)).resolves.toBe(true);
  });

  it("rejects wrong passwords", async () => {
    const hash = await hashPassword("CorrectHorseBattery1");
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("throws on too-short passwords at hash time", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/too short/i);
    await expect(hashPassword("")).rejects.toThrow();
  });

  it("verifyPassword returns false for empty inputs", async () => {
    await expect(verifyPassword("", "anything")).resolves.toBe(false);
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
  });

  it("verifyPassword swallows bcrypt errors and returns false", async () => {
    await expect(verifyPassword("anything", "not-a-bcrypt-hash")).resolves.toBe(
      false,
    );
  });

  it("two hashes of the same password differ (random salt)", async () => {
    const a = await hashPassword("SameSamePass1");
    const b = await hashPassword("SameSamePass1");
    expect(a).not.toBe(b);
    await expect(verifyPassword("SameSamePass1", a)).resolves.toBe(true);
    await expect(verifyPassword("SameSamePass1", b)).resolves.toBe(true);
  });
});
