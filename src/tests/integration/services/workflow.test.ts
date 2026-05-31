import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workflow } from "@/server/db/models";
import {
  addStatus,
  addTransition,
  editStatus,
  getOrCreateDefaultWorkflow,
  removeStatus,
  removeTransition,
  resolveTransition,
  setPaymentStatusMapping,
} from "@/server/services/workflow.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

describe("workflow.service", () => {
  const orgId = new Types.ObjectId().toString();
  const actor = { id: new Types.ObjectId().toString() };

  beforeEach(async () => {
    await ensureMongo();
    await Workflow.deleteMany({});
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it("lazy-seeds a default workflow on first access (6 statuses, legacy enum)", async () => {
    const wf = await getOrCreateDefaultWorkflow(orgId);

    expect(wf.statuses.map((s) => s.key)).toEqual([
      "NOT_INITIATED",
      "LINK_GENERATED",
      "PAYMENT_PENDING",
      "PAID",
      "FAILED",
      "EXPIRED",
    ]);
    expect(wf.initialStatusKey).toBe("NOT_INITIATED");
    expect(wf.paymentSuccessStatusKey).toBe("PAID");
    expect(wf.paymentFailureStatusKey).toBe("FAILED");
    expect(wf.statuses.find((s) => s.key === "PAID")?.isPaid).toBe(true);
  });

  it("returns the same workflow on repeat access (no duplicate rows)", async () => {
    const first = await getOrCreateDefaultWorkflow(orgId);
    const second = await getOrCreateDefaultWorkflow(orgId);
    expect(second.id).toBe(first.id);

    const count = await Workflow.countDocuments({});
    expect(count).toBe(1);
  });

  it("isolates workflows per tenant", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();

    const wfA = await getOrCreateDefaultWorkflow(orgA);
    const wfB = await getOrCreateDefaultWorkflow(orgB);

    expect(wfA.id).not.toBe(wfB.id);
    expect(wfA.orgId).toBe(orgA);
    expect(wfB.orgId).toBe(orgB);
  });

  describe("resolveTransition", () => {
    it("allows the legal default edge NOT_INITIATED → LINK_GENERATED", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      const result = await resolveTransition(
        orgId,
        "NOT_INITIATED",
        "LINK_GENERATED",
      );
      expect(result.allowed).toBe(true);
      expect(result.transition?.label).toBe("Generate payment link");
    });

    it("rejects an illegal edge with a human reason", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      const result = await resolveTransition(orgId, "NOT_INITIATED", "PAID");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/No transition defined/);
    });

    it("rejects same-status no-op moves", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      const result = await resolveTransition(orgId, "PAID", "PAID");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/already in status/);
    });

    it("rejects an unknown source or target status", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      const unknownSource = await resolveTransition(
        orgId,
        "PARROT",
        "PAID",
      );
      expect(unknownSource.allowed).toBe(false);
      expect(unknownSource.reason).toMatch(/Unknown source status/);

      const unknownTarget = await resolveTransition(
        orgId,
        "PAID",
        "FLAMINGO",
      );
      expect(unknownTarget.allowed).toBe(false);
      expect(unknownTarget.reason).toMatch(/Unknown target status/);
    });
  });

  describe("addStatus + addTransition", () => {
    it("admin can add a custom status and a transition into it", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      const afterAdd = await addStatus(
        orgId,
        { key: "SHIPPED", label: "Shipped", color: "#3B82F6" },
        actor,
      );
      expect(afterAdd.statuses.find((s) => s.key === "SHIPPED")).toBeDefined();

      const afterTransition = await addTransition(
        orgId,
        { fromKey: "PAID", toKey: "SHIPPED", label: "Mark shipped" },
        actor,
      );
      expect(
        afterTransition.transitions.find(
          (t) => t.fromKey === "PAID" && t.toKey === "SHIPPED",
        ),
      ).toBeDefined();

      const resolved = await resolveTransition(orgId, "PAID", "SHIPPED");
      expect(resolved.allowed).toBe(true);
    });

    it("rejects duplicate status keys", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await expect(
        addStatus(orgId, { key: "PAID", label: "Paid again" }, actor),
      ).rejects.toThrow(/already exists/);
    });

    it("rejects transitions that reference missing statuses", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await expect(
        addTransition(
          orgId,
          { fromKey: "GHOST", toKey: "PAID", label: "Spook" },
          actor,
        ),
      ).rejects.toThrow(/references missing status/);
    });
  });

  describe("setPaymentStatusMapping", () => {
    it("re-points payment-success to a different tenant-defined paid status", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await addStatus(
        orgId,
        { key: "SETTLED", label: "Settled", isTerminal: true, isPaid: true },
        actor,
      );
      const wf = await setPaymentStatusMapping(
        orgId,
        {
          paymentSuccessStatusKey: "SETTLED",
          paymentFailureStatusKey: "FAILED",
        },
        actor,
      );
      expect(wf.paymentSuccessStatusKey).toBe("SETTLED");
    });

    it("rejects mapping success to a non-paid status (dashboard rollup safety)", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      // LINK_GENERATED is not isPaid — using it as the success target
      // would silently exclude paid orders from revenue reporting.
      await expect(
        setPaymentStatusMapping(
          orgId,
          {
            paymentSuccessStatusKey: "LINK_GENERATED",
            paymentFailureStatusKey: "FAILED",
          },
          actor,
        ),
      ).rejects.toThrow(/must have isPaid=true/);
    });
  });

  describe("editStatus", () => {
    it("updates label + color without touching the key", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      const wf = await editStatus(
        orgId,
        "PAID",
        { label: "Settled", color: "#10B981" },
        actor,
      );
      const paid = wf.statuses.find((s) => s.key === "PAID");
      expect(paid?.label).toBe("Settled");
      expect(paid?.color).toBe("#10B981");
      expect(paid?.isPaid).toBe(true); // unchanged
    });

    it("refuses to clear isPaid on the current payment-success target", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await expect(
        editStatus(orgId, "PAID", { isPaid: false }, actor),
      ).rejects.toThrow(/payment-success target/);
    });
  });

  describe("removeStatus", () => {
    it("deletes a custom status with no references", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await addStatus(
        orgId,
        { key: "ON_HOLD", label: "On hold" },
        actor,
      );
      const wf = await removeStatus(orgId, "ON_HOLD", actor);
      expect(wf.statuses.find((s) => s.key === "ON_HOLD")).toBeUndefined();
    });

    it("refuses to delete the initial status", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await expect(
        removeStatus(orgId, "NOT_INITIATED", actor),
      ).rejects.toThrow(/initial status/);
    });

    it("refuses to delete the payment-success or payment-failure target", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await expect(removeStatus(orgId, "PAID", actor)).rejects.toThrow(
        /payment-success target/,
      );
      await expect(removeStatus(orgId, "FAILED", actor)).rejects.toThrow(
        /payment-failure target/,
      );
    });

    it("refuses to delete a status referenced by a transition", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      // LINK_GENERATED is the target of t_init_link AND the source of
      // t_link_pending. Should be refused.
      await expect(
        removeStatus(orgId, "LINK_GENERATED", actor),
      ).rejects.toThrow(/referenced by transition/);
    });
  });

  describe("removeTransition", () => {
    it("deletes a transition by id", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      const wf = await removeTransition(orgId, "t_init_link", actor);
      expect(wf.transitions.find((t) => t.id === "t_init_link")).toBeUndefined();
      // And from→to no longer resolves.
      const resolved = await resolveTransition(
        orgId,
        "NOT_INITIATED",
        "LINK_GENERATED",
      );
      expect(resolved.allowed).toBe(false);
    });

    it("throws NotFound for unknown id", async () => {
      await getOrCreateDefaultWorkflow(orgId);
      await expect(
        removeTransition(orgId, "t_does_not_exist", actor),
      ).rejects.toThrow(/not found/i);
    });
  });
});
